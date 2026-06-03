#!/usr/bin/env bun
// fallback-reply-hook.ts — Claude Code Stop hook → DM fallback reply.
//
// feature/dm-fallback-reply-hook (2026-06-03). The warchief's Telegram DM
// (the main/launcher session) answers him through the
// `mcp__dashi-channel__reply` MCP tool — that send is what actually reaches
// his chat; the session transcript never does. If a turn ends WITHOUT having
// called reply()/edit_message(), the warchief gets silence even though the
// turn produced a final answer. This Stop hook closes that gap: on turn-end it
// reads the session transcript, and IF the turn was answering a Telegram
// message AND did not send an MCP reply this turn, it forwards the turn's
// final assistant text to the plugin's POST /hooks/fallback-reply route, which
// sends it to the warchief's Telegram via the single bot.
//
// This mirrors the multichat per-chat auto-forward (src/chats/hooks/
// stop-to-outbox.py) but for the DM, where sends go through the MCP reply tool
// instead of a per-chat outbox. The turn-walk + dedup logic is ported from
// that Python hook; the route/env-file resolution + dedup-log layout are
// reused from read-receipt-hook.ts.
//
// Suppression invariants (no duplicate to the warchief):
//   * If the turn called mcp__dashi-channel__reply OR
//     mcp__dashi-channel__edit_message → a reply already reached him → silent.
//   * If the turn has no final assistant text (pure tool / pure thinking) →
//     nothing to forward → silent.
//   * If the turn was not answering a Telegram message (no `<channel
//     source="telegram" ... chat_id="...">` in its user prompt) → silent. This
//     both scopes the fallback to Telegram-driven turns AND supplies the
//     destination chat_id WITHOUT trusting any env-provided chat.
//   * Per-session dedup → at most one forward per turn across repeated Stop
//     fires.
//
// Hard invariants (mirror read-receipt-hook.ts):
//   * Exit code 0 in ALL paths. A non-zero hook blocks the model; a fallback
//     reply must never gate the agent.
//   * Stdout stays EMPTY. Stop-hook stdout is treated as model context.
//   * Stderr lines are short and secret-free (no token, no transcript body).
//
// Configuration (env), in priority order:
//   TELEGRAM_FALLBACK_REPLY_URL    full route URL, e.g.
//                                  http://127.0.0.1:8089/hooks/fallback-reply
//   TELEGRAM_WEBHOOK_TOKEN         bearer token for the route
//   — or, when the explicit URL is absent —
//   TELEGRAM_WEBHOOK_HOST/PORT     host (default 127.0.0.1) + port → route URL
//   TELEGRAM_CHANNEL_ENV_FILE      path to the plugin env file; HOST/PORT/TOKEN
//                                  are read from it (DM session env resolution,
//                                  same linchpin as read-receipt-hook).
//   TELEGRAM_STATE_DIR             base dir for the dedup state (per-session)
//   TELEGRAM_FALLBACK_REPLY_STATE  explicit dedup-state path (overrides dir)
//   FALLBACK_REPLY_RETRY_ATTEMPTS  bounded retry on empty extraction (default 4)
//   FALLBACK_REPLY_RETRY_DELAY_MS  delay between retries (default 120ms)

import { readFileSync, writeFileSync, mkdirSync, openSync, readSync, fstatSync, closeSync } from 'fs'
import { createHash } from 'crypto'
import { dirname, join } from 'path'

// Reuse the env-file + per-session-state primitives from the read-receipt
// hook so both Stop hooks resolve the route/dedup identically. These are pure
// (no module side effects on import beyond the function defs).
import {
  loadChannelEnvFile,
  parseEnvFile,
} from './read-receipt-hook.js'

// Re-export the borrowed helpers under this module too, so tests importing
// from this hook get a single surface. (parseEnvFile is used transitively by
// loadChannelEnvFile; re-exported for symmetry with read-receipt-hook tests.)
export { loadChannelEnvFile, parseEnvFile }

// Tail window for the backward walk — matches stop-to-outbox.py. Sized so a
// whole interactive turn (incl. large tool_result blocks) almost always fits,
// keeping the current turn's user-prompt boundary inside the window. If a
// single turn exceeds this, the boundary can fall outside and the walk could
// reach a previous turn's text; dedup is the secondary guard.
const TAIL_BYTES = 1024 * 1024

// The two MCP tools that deliver a reply to the warchief's Telegram. If either
// was called this turn, the warchief already saw the answer → no fallback.
const REPLY_TOOL_NAMES = new Set<string>([
  'mcp__dashi-channel__reply',
  'mcp__dashi-channel__edit_message',
])

const FETCH_TIMEOUT_MS = 5000
const STATE_CAP_BYTES = 256 * 1024

// Telegram's sendMessage hard caps a single message at 4096 chars; the route
// schema rejects anything longer with 400. The bare sendMessage does NOT chunk
// (chunking lives only in the MCP reply tool), so a >4096-char final answer
// would 400-drop forever. FIX 5 (minimum viable): truncate to TELEGRAM_TEXT_MAX
// with a short marker so a long answer always delivers SOMETHING. Marker stays
// within the 4096 budget: body ≤ 4096 − marker length.
const TELEGRAM_TEXT_MAX = 4096
const TRUNCATION_MARKER = '\n…[обрезано]'

/** Truncate a final text to Telegram's 4096-char cap, appending a marker. */
export function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_TEXT_MAX) return text
  const room = TELEGRAM_TEXT_MAX - TRUNCATION_MARKER.length
  return text.slice(0, room) + TRUNCATION_MARKER
}

// ─────────────────────────────────────────────────────────────────────
// Transcript turn-walk. Ported from stop-to-outbox.py's
// read_last_assistant_text + _is_user_prompt: walk the CURRENT TURN backward,
// stopping at the last genuine user prompt, collecting the most recent
// assistant text and detecting whether any assistant message in the turn
// called a reply tool. We also extract the inbound Telegram chat_id from the
// turn's user prompt.
// ─────────────────────────────────────────────────────────────────────

export interface TurnResult {
  // The most recent assistant text of the current turn (joined text blocks),
  // or undefined when the turn produced none (pure tool / thinking turn).
  readonly text?: string | undefined
  // Dedup discriminator: the text-bearing assistant line's `uuid` when
  // present, else undefined (caller falls back to a text hash).
  readonly uuid?: string | undefined
  // True if ANY assistant message in this turn called a reply MCP tool.
  readonly replied: boolean
  // The inbound Telegram chat_id parsed from the turn's user prompt, or
  // undefined when the turn was not answering a Telegram message.
  readonly chatId?: string | undefined
  // The boundary user-prompt's text content (FIX 6 dedup discriminator). Used
  // to distinguish two different turns that have no `uuid` but identical
  // assistant text. Undefined when no boundary prompt text was found.
  readonly promptText?: string | undefined
}

/**
 * Extract the genuine inbound Telegram chat_id from the LEADING `<channel ...>`
 * envelope of a user-prompt's TEXT. The real inbound envelope ALWAYS leads the
 * user prompt; a `<channel ...>` tag appearing later in the body is untrusted
 * (it could be injected by a message author or echoed transcript content), so
 * we read ONLY the leading tag.
 *
 * Tolerant of both the JSON-escaped transcript form (`chat_id=\"164795011\"`)
 * and the raw form. Only telegram envelopes match (orgrimmar-inbox events carry
 * no telegram source). Returns undefined when the trimmed text does NOT start
 * with a telegram channel envelope → no trusted destination → no forward.
 *
 * FIX 7: the regex is constructed locally (no shared module-level `/g` regex
 * with a mutable `lastIndex` that could carry state across calls).
 */
export function extractLeadingTelegramChatId(promptText: string): string | undefined {
  const trimmed = promptText.trimStart()
  // Anchored at the start: only the LEADING channel tag is considered. The
  // attrs group is non-greedy up to the first `>` so it captures one tag.
  const leadingTag = /^<channel\b([^>]*)>/.exec(trimmed)
  if (!leadingTag) return undefined
  const attrs = leadingTag[1] ?? ''
  if (!/source\s*=\s*\\?"telegram\\?"/.test(attrs)) return undefined
  // chat_id is negative for groups/supergroups, so allow a leading `-`.
  const chat = /chat_id\s*=\s*\\?"(-?\d+)\\?"/.exec(attrs)
  return chat ? (chat[1] as string) : undefined
}

interface TranscriptMessage {
  readonly role?: unknown
  readonly content?: unknown
}
interface TranscriptLine {
  readonly message?: unknown
  readonly uuid?: unknown
}

/** True when a content array contains a tool_use block whose name is a reply tool. */
function contentCallsReplyTool(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b.type === 'tool_use' && typeof b.name === 'string' && REPLY_TOOL_NAMES.has(b.name)) {
      return true
    }
  }
  return false
}

/** Collect the joined text blocks of an assistant content array (empty when none). */
function assistantText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

/**
 * Extract the TEXT content of a user-prompt message. For a string content the
 * string itself is the text; for an array content we join the `{type:'text'}`
 * blocks ONLY. We deliberately do NOT serialize the whole array (FIX 2): the
 * raw JSON line can carry channel-looking substrings inside tool metadata, and
 * the leading-envelope rule must see the genuine prompt text, not that noise.
 * Returns undefined when there is no usable text content.
 */
function userPromptText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
    return parts.length > 0 ? parts.join('\n') : undefined
  }
  return undefined
}

/**
 * Classify a user-role message: genuine prompt (turn boundary) vs tool_result
 * echo (part of the current turn). Ported from stop-to-outbox.py's
 * `_is_user_prompt`: conservative — a user message is a prompt UNLESS it is
 * confidently a tool_result-only echo (or empty). A string is a prompt when
 * non-blank; a list is a prompt unless EVERY block is a tool_result.
 */
export function isUserPrompt(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  if (Array.isArray(content)) {
    if (content.length === 0) return false
    return content.some((block) => {
      if (block === null || typeof block !== 'object') return true
      return (block as Record<string, unknown>).type !== 'tool_result'
    })
  }
  return false
}

/**
 * Walk the transcript text backward over the CURRENT TURN and return a
 * TurnResult. Pure — no I/O. The transcript is the tail-read JSONL text (one
 * Claude transcript line per `\n`). We stop at the last genuine user prompt so
 * a previous (already-handled) turn is never resurfaced. Along the way we:
 *   - capture the most recent assistant TEXT of the turn (the final reply),
 *   - flag whether ANY assistant message of the turn called a reply tool,
 *   - on the boundary user prompt, extract the inbound Telegram chat_id.
 *
 * `replied` and `chatId` are determined for the WHOLE turn, so we keep walking
 * to the user-prompt boundary even after we've found the final text.
 */
export function analyzeCurrentTurn(transcript: string): TurnResult {
  const lines = transcript.split('\n').filter((l) => l.trim().length > 0)
  let text: string | undefined
  let uuid: string | undefined
  let replied = false
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj: unknown
    try {
      obj = JSON.parse(lines[i] as string)
    } catch {
      continue
    }
    if (obj === null || typeof obj !== 'object') continue
    const line = obj as TranscriptLine
    const rawMessage = line.message
    if (rawMessage === null || typeof rawMessage !== 'object') continue
    const message = rawMessage as TranscriptMessage
    const role = message.role
    const content = message.content

    if (role === 'user') {
      // tool_result echo → part of this turn, keep walking. Genuine prompt →
      // turn boundary: extract the inbound telegram chat_id from the LEADING
      // envelope of the prompt's TEXT (FIX 2) and stop. We use only the
      // prompt's text blocks — never the raw JSON line — so injected
      // `<channel ...>` substrings in tool metadata cannot redirect the send.
      if (isUserPrompt(content)) {
        const promptText = userPromptText(content)
        const chatId =
          promptText !== undefined ? extractLeadingTelegramChatId(promptText) : undefined
        return { text, uuid, replied, chatId, promptText }
      }
      continue
    }

    if (role !== 'assistant') continue
    if (contentCallsReplyTool(content)) replied = true
    if (text === undefined) {
      const t = assistantText(content)
      if (t.length > 0) {
        text = t
        const u = line.uuid
        uuid = typeof u === 'string' && u.length > 0 ? u : undefined
      }
    }
  }
  // Reached the top without a genuine user prompt: no turn boundary found, so
  // we cannot confirm a Telegram chat_id → no fallback. Still report replied
  // (harmless) but leave chatId/promptText undefined.
  return { text, uuid, replied, chatId: undefined, promptText: undefined }
}

// ─────────────────────────────────────────────────────────────────────
// Tail-read the transcript (matches stop-to-outbox.py): read at most the
// trailing TAIL_BYTES and drop the first possibly-truncated line when not
// starting at byte 0.
// ─────────────────────────────────────────────────────────────────────

export function tailReadTranscript(
  path: string,
  read: (p: string) => { text: string; truncated: boolean } = readTailDefault,
): string {
  const { text, truncated } = read(path)
  if (!truncated) return text
  const nl = text.indexOf('\n')
  return nl >= 0 ? text.slice(nl + 1) : ''
}

function readTailDefault(path: string): { text: string; truncated: boolean } {
  let fd = -1
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    if (size === 0) return { text: '', truncated: false }
    const length = Math.min(size, TAIL_BYTES)
    const start = size - length
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, start)
    return { text: buf.toString('utf8'), truncated: start > 0 }
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Route config resolution. Mirrors read-receipt-hook's resolveReactConfig,
// targeting the /hooks/fallback-reply route instead.
// ─────────────────────────────────────────────────────────────────────

export interface FallbackConfig {
  readonly url: string
  readonly token: string
}
export interface FallbackConfigError {
  readonly kind: 'error'
  readonly reason: string
}
export type FallbackConfigResult = FallbackConfig | FallbackConfigError

export function resolveFallbackConfig(
  env: Readonly<Record<string, string | undefined>>,
): FallbackConfigResult {
  const token = env.TELEGRAM_WEBHOOK_TOKEN
  if (!token) return { kind: 'error', reason: 'missing TELEGRAM_WEBHOOK_TOKEN' }

  if (env.TELEGRAM_FALLBACK_REPLY_URL) {
    return { url: env.TELEGRAM_FALLBACK_REPLY_URL, token }
  }

  const host = env.TELEGRAM_WEBHOOK_HOST ?? '127.0.0.1'
  const port = env.TELEGRAM_WEBHOOK_PORT
  if (!port) return { kind: 'error', reason: 'missing TELEGRAM_WEBHOOK_PORT' }
  return { url: `http://${host}:${port}/hooks/fallback-reply`, token }
}

// ─────────────────────────────────────────────────────────────────────
// Per-session dedup state. Same layout idea as stop-to-outbox.py's
// last-stop-outbox.json: record (session_id, transcript_path, dedupe_token);
// an identical triple short-circuits. Keyed per-session so each session writes
// only its own file (no cross-session race). dedupe_token = assistant uuid or
// text hash, so two DIFFERENT turns with identical text are NOT suppressed.
// ─────────────────────────────────────────────────────────────────────

export interface DedupState {
  readonly session_id: string
  readonly transcript_path: string
  readonly dedupe_token: string
}

function safeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)
  return cleaned.length > 0 ? cleaned : 'session'
}

/**
 * Per-session dedup-state path. Explicit TELEGRAM_FALLBACK_REPLY_STATE wins
 * (tests / single writer). Base dir falls back through TELEGRAM_STATE_DIR →
 * MULTICHAT_STATE_DIR (the DM session has the former). Returns undefined when
 * no base dir is resolvable → dedup is then in-memory only for the run.
 */
export function resolveStatePath(
  env: Readonly<Record<string, string | undefined>>,
  sessionId?: string,
): string | undefined {
  if (env.TELEGRAM_FALLBACK_REPLY_STATE) return env.TELEGRAM_FALLBACK_REPLY_STATE
  const base = env.TELEGRAM_STATE_DIR ?? env.MULTICHAT_STATE_DIR
  if (!base) return undefined
  const file = sessionId ? `${safeSessionId(sessionId)}.json` : 'fallback-reply.json'
  return join(base, 'fallback-reply', file)
}

/**
 * Per-turn dedup token. When the transcript line carries a `uuid` it uniquely
 * identifies the turn → use it alone. Without a uuid (legacy transcripts) the
 * assistant text alone is NOT a turn discriminator: two DIFFERENT turns in the
 * same session with identical assistant text would collide and the second
 * would be suppressed, losing the warchief an answer (FIX 6). So we fold the
 * boundary user-prompt's text into the hash — different prompts → different
 * tokens even when the assistant text matches.
 */
export function dedupeToken(
  uuid: string | undefined,
  text: string,
  promptText?: string | undefined,
): string {
  if (uuid) return uuid
  const material = promptText !== undefined ? `${promptText} ${text}` : text
  return createHash('sha256').update(material, 'utf8').digest('hex')
}

export function loadDedupState(
  path: string,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): DedupState | undefined {
  try {
    const parsed: unknown = JSON.parse(readFile(path))
    if (parsed === null || typeof parsed !== 'object') return undefined
    const p = parsed as Record<string, unknown>
    if (
      typeof p.session_id === 'string' &&
      typeof p.transcript_path === 'string' &&
      typeof p.dedupe_token === 'string'
    ) {
      return {
        session_id: p.session_id,
        transcript_path: p.transcript_path,
        dedupe_token: p.dedupe_token,
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** True when `prior` records the exact same turn we are about to forward. */
export function alreadyForwarded(prior: DedupState | undefined, next: DedupState): boolean {
  return (
    prior !== undefined &&
    prior.session_id === next.session_id &&
    prior.transcript_path === next.transcript_path &&
    prior.dedupe_token === next.dedupe_token
  )
}

function persistDedupState(path: string, state: DedupState): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const body = JSON.stringify(state)
    // Bound the file: a single small JSON object never approaches this, but
    // guard against an accidental append-style write elsewhere corrupting it.
    if (Buffer.byteLength(body) <= STATE_CAP_BYTES) {
      writeFileSync(path, body, { mode: 0o600 })
    }
  } catch {
    /* persistence is best-effort; a re-send next turn is a rare duplicate */
  }
}

// ─────────────────────────────────────────────────────────────────────
// Bounded int knob reader (ported from stop-to-outbox.py's _env_int).
// ─────────────────────────────────────────────────────────────────────

function envInt(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  def: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]
  if (!raw) return def
  const val = Number.parseInt(raw, 10)
  if (!Number.isFinite(val)) return def
  if (val < minimum) return def
  if (val > maximum) return maximum
  return val
}

// ─────────────────────────────────────────────────────────────────────
// HTTP + stdin plumbing (mirrors read-receipt-hook.ts).
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
  process.stderr.write(`fallback-reply-hook: ${safe}\n`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * POST one fallback reply. Returns true ONLY when the route confirms the send
 * actually reached Telegram ({status:'sent'}).
 *
 * FIX 1: the route returns HTTP 200 for BOTH a real send AND a fail-soft send
 * failure ({status:'send_failed'}). Treating any 200 as success would persist
 * dedup on a transient send failure → a repeat Stop fire for the same turn is
 * suppressed → the warchief never gets the answer. So we parse the body and
 * succeed only on `{status:'sent'}`. For `{status:'send_failed'}`, an
 * unparseable body, or any non-200 → return false (dedup NOT written → a repeat
 * Stop fire retries the send).
 */
async function postFallback(config: FallbackConfig, chatId: string, text: string): Promise<boolean> {
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ chat_id: chatId, text }),
      // Bound the wait: the route awaits a rate-limited sendMessage whose 429
      // backoff can otherwise hold the connection open, and a Stop hook must
      // not linger and delay session teardown.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return false
    let body: unknown
    try {
      body = await response.json()
    } catch {
      // Unparseable body on a 200 — cannot confirm the send → do NOT dedup.
      return false
    }
    if (body === null || typeof body !== 'object') return false
    return (body as Record<string, unknown>).status === 'sent'
  } catch {
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
  const sessionId = typeof fields.session_id === 'string' ? fields.session_id : ''

  // Merge the env file UNDER the process env (same precedence as
  // read-receipt-hook): the env-file supplies token/port when the process env
  // lacks them, while real process env wins where both define a key.
  const fileVars = loadChannelEnvFile(process.env)
  const env: Record<string, string | undefined> = { ...fileVars, ...process.env }

  // Bounded retry on empty extraction. Same race as stop-to-outbox.py: a reply
  // produced with extended thinking emits a [thinking] line first and the
  // [text] line a beat later; a Stop hook reading between them sees no text.
  // We re-read a few times before concluding the turn had no text. A genuinely
  // text-less turn (pure tool / pure thinking) just exhausts the budget. Knobs
  // are upper-clamped so an oversized value cannot hang the synchronous hook.
  const attempts = envInt(env, 'FALLBACK_REPLY_RETRY_ATTEMPTS', 4, 1, 50)
  const delayMs = envInt(env, 'FALLBACK_REPLY_RETRY_DELAY_MS', 120, 0, 2000)

  let turn: TurnResult = { replied: false }
  // FIX 3: cap the CUMULATIVE sleep at a hard 3s ceiling regardless of the
  // attempts×delay knob product (up to 50×2000 = 100s otherwise). Once the
  // budget is exhausted we stop sleeping but still run the remaining read
  // attempts back-to-back, so a transcript that lands late is still picked up
  // without hanging the synchronous Stop hook.
  const SLEEP_BUDGET_MS = 3000
  let sleptMs = 0
  for (let attempt = 0; attempt < attempts; attempt++) {
    let transcript = ''
    try {
      transcript = tailReadTranscript(transcriptPath)
    } catch {
      // FIX 4: a transient read/write race must NOT abort the whole retry
      // loop. Skip to the next attempt; only give up after all attempts are
      // exhausted with no text (bounded by the FIX 3 sleep budget).
      if (attempt < attempts - 1 && delayMs > 0 && sleptMs < SLEEP_BUDGET_MS) {
        await sleep(delayMs)
        sleptMs += delayMs
      }
      continue
    }
    turn = analyzeCurrentTurn(transcript)
    // A reply already reached the warchief this turn → never fall back.
    if (turn.replied) return
    if (turn.text !== undefined && turn.text.trim().length > 0) break
    if (attempt < attempts - 1 && delayMs > 0 && sleptMs < SLEEP_BUDGET_MS) {
      await sleep(delayMs)
      sleptMs += delayMs
    }
  }

  if (turn.replied) return
  const text = turn.text
  if (text === undefined || text.trim().length === 0) return
  // No telegram chat_id in the turn → not answering a Telegram message, OR no
  // turn boundary found. Either way we have no trusted destination → silent.
  const chatId = turn.chatId
  if (chatId === undefined) return

  const config = resolveFallbackConfig(env)
  if ('kind' in config && config.kind === 'error') {
    warn(config.reason)
    return
  }

  // FIX 6: fold the boundary prompt text into the dedup token so two different
  // turns with identical assistant text but no uuid don't collide.
  const token = dedupeToken(turn.uuid, text, turn.promptText)
  const next: DedupState = {
    session_id: sessionId,
    transcript_path: transcriptPath,
    dedupe_token: token,
  }
  const statePath = resolveStatePath(env, sessionId)
  if (statePath) {
    const prior = loadDedupState(statePath)
    if (alreadyForwarded(prior, next)) return
  }

  // FIX 5: truncate-with-marker so a >4096-char answer delivers SOMETHING
  // rather than 400-dropping at the route's schema cap.
  const outText = truncateForTelegram(text)
  const ok = await postFallback(config as FallbackConfig, chatId, outText)
  if (ok && statePath) persistDedupState(statePath, next)
}

const isMainModule = (() => {
  try {
    const arg = process.argv[1] ?? ''
    return arg.endsWith('fallback-reply-hook.ts') || arg.endsWith('fallback-reply-hook.js')
  } catch {
    return false
  }
})()

if (isMainModule) {
  await main().catch((err) => {
    warn(err instanceof Error ? err.message : 'unknown error')
  })
}
