#!/usr/bin/env bun
// read-receipt-hook.ts — Claude Code Stop hook → deterministic 👀 receipt.
//
// fix/eyes-on-read (2026-05-28). The 👀 reaction used to be set the instant
// the bot RECEIVED a Telegram update (src/telegram/handlers.ts). That made
// the eyes mean "the bot saw it", not "the agent read it" — if the session
// was busy, the message queued while the eyes already showed, so the signal
// lied. This hook moves the receipt to the truthful moment: it runs on the
// Stop event (once per turn the agent completes), scans the session
// transcript for the inbound `<channel source="telegram" ...>` block(s) the
// turn actually read, and posts them to the plugin's `/hooks/react` route so
// the single bot sets 👀. Because EVERY session (the warchief DM + each
// per-chat multichat session) runs the same Stop hook against its own
// transcript, the receipt works uniformly across the DM and group chats.
//
// Hard invariants (mirrors post-hook.ts):
//   * Exit code 0 in ALL paths. A non-zero hook blocks the model; a read
//     receipt must never gate the agent.
//   * Stdout stays EMPTY. Stop-hook stdout is treated as model context.
//   * Stderr lines are short and secret-free (no token, no transcript body).
//
// Configuration (env), in priority order:
//   TELEGRAM_READ_RECEIPT_URL    full route URL, e.g. http://127.0.0.1:8089/hooks/react
//   TELEGRAM_WEBHOOK_TOKEN       bearer token for the route
//   — or, when those are absent —
//   TELEGRAM_CHANNEL_ENV_FILE    path to the plugin env file; HOST/PORT/TOKEN
//                                are read from it so per-chat sessions with a
//                                sanitised env still resolve the route.
//   TELEGRAM_STATE_DIR           dir for the dedup log (default: cwd-less → skip persist)
//   TELEGRAM_READ_RECEIPT_STATE  explicit dedup-log path (overrides STATE_DIR)

import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

// ─────────────────────────────────────────────────────────────────────
// Channel-block parsing. Tolerant of BOTH the JSON-escaped form found in a
// transcript line (`message_id=\"28045\"`) and the raw form. Only telegram
// blocks are matched — orgrimmar-inbox events carry no Telegram message_id.
// ─────────────────────────────────────────────────────────────────────

export interface ReadReceiptRef {
  readonly chat_id: string
  readonly message_id: number
}

export function refKey(ref: ReadReceiptRef): string {
  return `${ref.chat_id}:${ref.message_id}`
}

const CHANNEL_TAG_RE = /<channel\b([^>]*)>/g

/** Extract telegram (chat_id, message_id) pairs from one chunk of text. */
export function parseChannelRefs(text: string): ReadReceiptRef[] {
  const refs: ReadReceiptRef[] = []
  CHANNEL_TAG_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CHANNEL_TAG_RE.exec(text)) !== null) {
    const attrs = match[1] ?? ''
    // Only Telegram blocks get a read receipt. The inbound format carries
    // both `source="agent47-channel"` and `source="telegram"`, so a substring
    // test is enough.
    if (!/source\s*=\s*\\?"telegram\\?"/.test(attrs)) continue
    // chat_id is negative for groups/supergroups (multichat), so allow `-`.
    const chat = attrs.match(/chat_id\s*=\s*\\?"(-?\d+)\\?"/)
    const msg = attrs.match(/message_id\s*=\s*\\?"(\d+)\\?"/)
    if (!chat || !msg) continue
    const messageId = Number(msg[1])
    if (!Number.isInteger(messageId) || messageId <= 0) continue
    refs.push({ chat_id: chat[1] as string, message_id: messageId })
  }
  return refs
}

/**
 * Extract the telegram refs of the CURRENT turn's inbound message(s).
 *
 * We must NOT use a fixed line-count tail: a tool-heavy turn writes many
 * assistant/tool lines AFTER the inbound `<channel>` line, which would push
 * it out of any fixed window and the receipt would never fire (Codex HIGH).
 * Instead we walk the transcript backward and:
 *   - skip trailing lines that carry no telegram block (the turn's assistant
 *     reply + tool I/O), then
 *   - collect the CONTIGUOUS run of telegram-bearing lines (a batched
 *     multi-message turn), stopping at the first non-telegram line above it.
 *
 * This finds exactly the inbound block of the most recent turn regardless of
 * how much tool output followed it, and never replays the whole history
 * (only the latest turn). The per-session dedup log then guarantees one
 * receipt per message across repeated Stop events. Returns refs in
 * transcript (top-to-bottom) order.
 */
export function extractCurrentTurnRefs(transcript: string): ReadReceiptRef[] {
  const lines = transcript.split('\n').filter((l) => l.trim().length > 0)
  const seen = new Set<string>()
  const collected: ReadReceiptRef[] = []
  let started = false
  for (let i = lines.length - 1; i >= 0; i--) {
    const refs = parseChannelRefs(lines[i] as string)
    if (refs.length === 0) {
      if (started) break // passed above the contiguous inbound block
      continue // still in the trailing assistant/tool output
    }
    started = true
    for (const ref of refs) {
      const key = refKey(ref)
      if (seen.has(key)) continue
      seen.add(key)
      collected.push(ref)
    }
  }
  return collected.reverse()
}

// ─────────────────────────────────────────────────────────────────────
// Route config resolution.
// ─────────────────────────────────────────────────────────────────────

export interface ReactConfig {
  readonly url: string
  readonly token: string
}
export interface ReactConfigError {
  readonly kind: 'error'
  readonly reason: string
}
export type ReactConfigResult = ReactConfig | ReactConfigError

/** Minimal KEY=VALUE env-file parser (no shell expansion, strips quotes). */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * Load the plugin env file named by TELEGRAM_CHANNEL_ENV_FILE, if any.
 * Returns {} when no path is set; throws nothing — an unreadable file just
 * yields {} so the caller degrades to whatever is in the process env.
 *
 * This is the linchpin for multichat: per-chat sessions are spawned with
 * `env -i` + a strict allowlist (src/router/tmux-session-pool.ts) that wipes
 * EVERY `TELEGRAM_*` var, so the hook's process.env carries none of the
 * webhook config. The env-file PATH is injected inline in the Stop-hook
 * command string (a shell assignment prefix survives `env -i`), and the
 * secret webhook token + port are read from the file here — never from the
 * sanitised process env.
 */
export function loadChannelEnvFile(
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): Record<string, string> {
  const path = env.TELEGRAM_CHANNEL_ENV_FILE
  if (!path) return {}
  try {
    return parseEnvFile(readFile(path))
  } catch {
    return {}
  }
}

/**
 * Resolve the /hooks/react route URL + bearer token from an ALREADY-MERGED
 * env (process env overlaid on the env-file vars — see main()). Pure: no I/O.
 */
export function resolveReactConfig(
  env: Readonly<Record<string, string | undefined>>,
): ReactConfigResult {
  const token = env.TELEGRAM_WEBHOOK_TOKEN
  if (!token) return { kind: 'error', reason: 'missing TELEGRAM_WEBHOOK_TOKEN' }

  if (env.TELEGRAM_READ_RECEIPT_URL) return { url: env.TELEGRAM_READ_RECEIPT_URL, token }

  const host = env.TELEGRAM_WEBHOOK_HOST ?? '127.0.0.1'
  const port = env.TELEGRAM_WEBHOOK_PORT
  if (!port) return { kind: 'error', reason: 'missing TELEGRAM_WEBHOOK_PORT' }
  return { url: `http://${host}:${port}/hooks/react`, token }
}

// ─────────────────────────────────────────────────────────────────────
// Dedup log. One `chat_id:message_id` per line. We re-read it each run
// (Set) and append only the keys we successfully handled, capping the file
// so it can't grow unbounded over a long-lived session.
// ─────────────────────────────────────────────────────────────────────

const STATE_CAP_LINES = 5000

/** Filename-safe form of a session id (defends against odd ids in a path). */
function safeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)
  return cleaned.length > 0 ? cleaned : 'session'
}

/**
 * Per-SESSION dedup-log path. Keyed by session id so each session (the DM and
 * every per-chat multichat session) writes ONLY its own file — no shared file,
 * hence no cross-session append/trim race. An explicit
 * TELEGRAM_READ_RECEIPT_STATE overrides with a literal path (tests / single
 * writer). Base dir falls back through TELEGRAM_STATE_DIR →
 * MULTICHAT_STATE_DIR (the latter survives the per-chat `env -i` allowlist).
 */
export function resolveStatePath(
  env: Readonly<Record<string, string | undefined>>,
  sessionId?: string,
): string | undefined {
  if (env.TELEGRAM_READ_RECEIPT_STATE) return env.TELEGRAM_READ_RECEIPT_STATE
  const base = env.TELEGRAM_STATE_DIR ?? env.MULTICHAT_STATE_DIR
  if (!base) return undefined
  const file = sessionId ? `${safeSessionId(sessionId)}.log` : 'read-receipts.log'
  return join(base, 'read-receipts', file)
}

export function loadSeen(path: string, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): Set<string> {
  try {
    const content = readFile(path)
    return new Set(content.split('\n').map((l) => l.trim()).filter(Boolean))
  } catch {
    // Missing file on first run is expected.
    return new Set<string>()
  }
}

function persistSeen(path: string, existing: Set<string>, added: string[]): void {
  if (added.length === 0) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    const combined = [...existing, ...added]
    // Cap: keep the most recent entries. Re-reacting an evicted-then-seen
    // message is harmless (Telegram is idempotent for an unchanged reaction).
    if (combined.length <= STATE_CAP_LINES) {
      appendFileSync(path, added.map((k) => `${k}\n`).join(''), { mode: 0o600 })
    } else {
      // Rewrite (not append) when trimming so the file stays bounded.
      const trimmed = combined.slice(combined.length - STATE_CAP_LINES)
      writeFileSync(path, trimmed.map((k) => `${k}\n`).join(''), { mode: 0o600 })
    }
  } catch {
    /* persistence is best-effort; a re-react next turn is harmless */
  }
}

// ─────────────────────────────────────────────────────────────────────
// HTTP + stdin plumbing (mirrors post-hook.ts).
// ─────────────────────────────────────────────────────────────────────

interface BunGlobal {
  readonly stdin?: { readonly text?: () => Promise<string> }
}

async function readStdin(): Promise<string> {
  try {
    const bun = (globalThis as { Bun?: BunGlobal }).Bun
    const fn = bun?.stdin?.text
    if (typeof fn === 'function') return await fn.call(bun?.stdin)
  } catch {
    /* fall through */
  }
  return await new Promise<string>((resolve) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', () => resolve(''))
  })
}

function warn(reason: string): void {
  const safe = reason.length > 80 ? `${reason.slice(0, 77)}...` : reason
  process.stderr.write(`read-receipt-hook: ${safe}\n`)
}

const FETCH_TIMEOUT_MS = 5000

/** POST one receipt. Returns true when the route handled it (200 family). */
async function postReceipt(config: ReactConfig, ref: ReadReceiptRef): Promise<boolean> {
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ chat_id: ref.chat_id, message_id: ref.message_id }),
      // Bound the wait: the route awaits a rate-limited setMessageReaction
      // whose 429 backoff can otherwise hold the connection open for minutes,
      // and a Stop hook must not linger and delay session teardown.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    // The route returns 200 for both a successful reaction AND a terminal
    // Telegram failure (e.g. 429/400 after retries → {status:'react_failed'}):
    // both are recorded as handled so we don't retry-storm a message that
    // can't be reacted to. A 4xx/5xx (auth, route down) or a network/timeout
    // error returns false → left unrecorded so the next turn retries.
    return response.ok
  } catch {
    // AbortError (timeout) or network failure — retry on a later turn.
    return false
  }
}

async function main(): Promise<void> {
  let raw = ''
  try {
    raw = await readStdin()
  } catch {
    warn('stdin read failed')
    return
  }
  if (raw.trim().length === 0) return

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    warn('stdin not valid JSON')
    return
  }
  if (typeof parsed !== 'object' || parsed === null) return
  const fields = parsed as Record<string, unknown>
  const transcriptPath = fields.transcript_path
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return
  const sessionId = typeof fields.session_id === 'string' ? fields.session_id : undefined

  let transcript = ''
  try {
    transcript = readFileSync(transcriptPath, 'utf8')
  } catch {
    // No transcript yet (e.g. a SessionStart Stop with nothing read).
    return
  }

  const refs = extractCurrentTurnRefs(transcript)
  if (refs.length === 0) return

  // Merge the env file UNDER the process env: a per-chat session's sanitised
  // process.env carries no TELEGRAM_* (so the file supplies token/port/state),
  // while the main session's real env wins where both define a key.
  const fileVars = loadChannelEnvFile(process.env)
  const env: Record<string, string | undefined> = { ...fileVars, ...process.env }

  const config = resolveReactConfig(env)
  if ('kind' in config && config.kind === 'error') {
    warn(config.reason)
    return
  }

  const statePath = resolveStatePath(env, sessionId)
  const seen = statePath ? loadSeen(statePath) : new Set<string>()
  const fresh = refs.filter((r) => !seen.has(refKey(r)))
  if (fresh.length === 0) return

  const handled: string[] = []
  for (const ref of fresh) {
    const ok = await postReceipt(config as ReactConfig, ref)
    if (ok) handled.push(refKey(ref))
  }

  if (statePath && handled.length > 0) persistSeen(statePath, seen, handled)
}

const isMainModule = (() => {
  try {
    const arg = process.argv[1] ?? ''
    return arg.endsWith('read-receipt-hook.ts') || arg.endsWith('read-receipt-hook.js')
  } catch {
    return false
  }
})()

if (isMainModule) {
  await main().catch((err) => {
    warn(err instanceof Error ? err.message : 'unknown error')
  })
}
