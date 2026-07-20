#!/usr/bin/env bun
// ask-user-question-hook.ts — PreToolUse hook that intercepts the built-in
// `AskUserQuestion` tool and routes the prompt through the agent47-channel
// plugin so the warchief can answer from Telegram instead of an in-terminal
// menu.
//
// Wire shape (per phase2 PLAN.md):
//
//   stdin (Claude Code PreToolUse envelope):
//     {
//       "hook_event_name": "PreToolUse",
//       "session_id": "...",
//       "tool_name": "AskUserQuestion",
//       "tool_use_id": "toolu_...",
//       "transcript_path": "/abs/path.jsonl",
//       "tool_input": { "questions": [...] }
//     }
//
//   POST http://127.0.0.1:8093/hooks/ask-user-question/request
//     { session_id, tool_use_id, transcript_path, timeout_ms, questions }
//     Authorization: Bearer $TELEGRAM_WEBHOOK_TOKEN
//
//   Plugin replies with one of:
//     { "status": "answered", "updatedInput": { questions, answers } }
//     { "status": "pass_through" }
//     { "status": "timeout" }
//
// Hard invariants:
//   * Exit code 0 in every path. Claude Code reads the permission decision
//     from STDOUT JSON; a non-zero exit would short-circuit that channel and
//     hard-block the tool with no recoverable signal to the operator.
//   * For tool_name !== "AskUserQuestion" → stdout empty so other matchers
//     keep working. Same for `pass_through` and unreachable endpoint
//     (graceful fallback to Claude's native in-terminal UI).
//   * For `answered` → emit `permissionDecision: "allow"` + `updatedInput`.
//   * For `timeout` or HTTP error from a *running* plugin → emit
//     `permissionDecision: "deny"` with a human-readable reason so the
//     agent's transcript shows why the call was blocked.
//   * Bearer token NEVER written to stdout/stderr — same redaction rules as
//     post-hook.ts.
//
// Config (env, populated by install-hooks.sh into the hook command):
//   TELEGRAM_WEBHOOK_URL    e.g. http://127.0.0.1:8093/hooks/ask-user-question/request
//   TELEGRAM_WEBHOOK_TOKEN  bearer token configured on the plugin
//   ASK_USER_QUESTION_TIMEOUT_MS  optional override; default 300000 (5 min)

export interface AskHookEnvelope {
  readonly hook_event_name: 'PreToolUse'
  readonly session_id: string
  readonly tool_name: string
  readonly tool_use_id: string
  readonly transcript_path?: string
  readonly tool_input: { readonly questions?: unknown }
}

export interface AskHookRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly httpTimeoutMs: number
}

export interface AskBuildError {
  readonly kind: 'error'
  readonly reason: string
}

export interface AskBuildSkip {
  readonly kind: 'skip'
  readonly reason: string
}

export type AskBuildResult = AskHookRequest | AskBuildError | AskBuildSkip

export interface BuildAskRequestInput {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly hook: Record<string, unknown>
}

// Default 5-minute config wait + 5s margin so the wrapper never resolves
// before the plugin has had a chance to emit `timeout`. install-hooks.sh
// must set the matching `timeout` field in settings.json a few seconds
// higher again (we recommend 310s) so Claude Code itself doesn't kill the
// hook process while it's still long-polling.
const DEFAULT_CONFIG_TIMEOUT_MS = 300_000
const HTTP_MARGIN_MS = 5_000

// FIX-T1 F1 (PRX-1 Phase 5, 2026-05-27): loopback-only egress guard.
//
// The hook posts the warchief's prompt + bearer token to TELEGRAM_WEBHOOK_URL.
// If TELEGRAM_WEBHOOK_URL is misconfigured (typo, accidental remote host,
// envvar overridden by a shell profile) the bearer and prompt would
// exfiltrate to an arbitrary endpoint. Enforce:
//   - http:// scheme (TLS would imply a non-loopback CA path)
//   - hostname in LOOPBACK_HOSTS (127.0.0.1 / localhost / [::1] / ::1)
//   - port in PORT_HARD_WHITELIST OR matching env TELEGRAM_WEBHOOK_PORT
//
// A failed validation returns false so main() exits 0 with empty stdout
// (graceful no-op — Claude Code falls back to the native menu). We warn
// to stderr with the redacted reason but never echo the bearer.
const LOOPBACK_HOSTS = new Set<string>([
  '127.0.0.1',
  'localhost',
  '[::1]',
  '::1',
])
// Default + canonical alternates. Keep this list tight; adding a port here
// means any compromised TELEGRAM_WEBHOOK_URL can hit it on loopback. The
// operator's currently-configured port (TELEGRAM_WEBHOOK_PORT env, default
// 8093) is always added at runtime.
const PORT_HARD_WHITELIST = new Set<number>([8089, 8093, 8094])
const DEFAULT_WEBHOOK_PORT = 8093

export interface LoopbackValidation {
  readonly ok: boolean
  /** Present when ok=false; safe to log (no bearer / no full URL). */
  readonly reason?: string
}

/**
 * Pure predicate exported for tests. Pass the URL string + env so the test
 * suite can lock the contract without spinning up child processes.
 *
 * Rules (all must hold for ok=true):
 *   - URL parses
 *   - protocol === 'http:'
 *   - hostname is a loopback host
 *   - port is either in the hard whitelist OR matches env override
 *
 * grammY's URL parser strips brackets around IPv6 hostnames, so we also
 * accept the bare `::1` form. Empty port (e.g. `http://127.0.0.1/...`)
 * is rejected — explicit ports avoid ambiguity with reverse-proxy setups.
 */
export function validateLoopbackUrl(
  url: string,
  env: Readonly<Record<string, string | undefined>>,
): LoopbackValidation {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'TELEGRAM_WEBHOOK_URL not parseable' }
  }
  if (parsed.protocol !== 'http:') {
    return { ok: false, reason: `non-http scheme ${parsed.protocol}` }
  }
  // URL.hostname strips brackets from IPv6 literals; restore them so the
  // `[::1]` form in our allowlist matches `new URL('http://[::1]:8093')`.
  const host = parsed.hostname
  if (!LOOPBACK_HOSTS.has(host)) {
    return { ok: false, reason: 'host not loopback' }
  }
  const portStr = parsed.port
  if (portStr === '') {
    return { ok: false, reason: 'port missing (loopback URL must specify port)' }
  }
  const port = Number.parseInt(portStr, 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { ok: false, reason: 'port not a valid number' }
  }
  const envPortRaw = env.TELEGRAM_WEBHOOK_PORT
  const envPort = envPortRaw !== undefined
    ? Number.parseInt(envPortRaw, 10)
    : DEFAULT_WEBHOOK_PORT
  const allowedPorts = new Set<number>(PORT_HARD_WHITELIST)
  if (Number.isFinite(envPort) && envPort > 0 && envPort <= 65535) {
    allowedPorts.add(envPort)
  }
  if (!allowedPorts.has(port)) {
    return { ok: false, reason: 'port not in allowlist' }
  }
  return { ok: true }
}

/**
 * Pure builder. Returns one of:
 *   - `AskHookRequest`  → caller should POST and inspect the response.
 *   - `AskBuildSkip`    → caller should exit 0 with empty stdout (no-op,
 *                         pass control to the next matcher / native UI).
 *   - `AskBuildError`   → caller should warn to stderr and exit 0 empty
 *                         (graceful fallback; treat like skip).
 *
 * Skip-vs-error split exists so tests can distinguish "intentional no-op"
 * (wrong tool, missing fields) from "misconfigured operator env" (no URL).
 */
export function buildAskRequest(input: BuildAskRequestInput): AskBuildResult {
  const url = input.env.TELEGRAM_WEBHOOK_URL
  const token = input.env.TELEGRAM_WEBHOOK_TOKEN

  if (!url) return { kind: 'error', reason: 'missing TELEGRAM_WEBHOOK_URL' }
  if (!token) return { kind: 'error', reason: 'missing TELEGRAM_WEBHOOK_TOKEN' }

  if (typeof input.hook.hook_event_name !== 'string') {
    return { kind: 'skip', reason: 'envelope missing hook_event_name' }
  }
  if (input.hook.hook_event_name !== 'PreToolUse') {
    return { kind: 'skip', reason: 'not a PreToolUse event' }
  }
  if (input.hook.tool_name !== 'AskUserQuestion') {
    // Other matchers (Bash, etc.) handle this — leave stdout empty. Note we
    // intentionally check this BEFORE the loopback gate so the non-Ask hook
    // path stays silent for every other tool (loopback warn would otherwise
    // spam stderr on every Bash call when the env is misconfigured).
    return { kind: 'skip', reason: 'tool_name is not AskUserQuestion' }
  }

  // FIX-T1 F1 (PRX-1 Phase 5): refuse to ship bearer + prompt off-loopback.
  // Misconfigured TELEGRAM_WEBHOOK_URL (typo, profile override) must not
  // exfiltrate the token. Returning `error` keeps the exit-0/empty-stdout
  // graceful-fallback contract while ensuring the reason hits stderr via
  // main()'s `warn(built.reason)`. `reason` is generic — never includes the
  // URL itself, only the failure class.
  const loopback = validateLoopbackUrl(url, input.env)
  if (!loopback.ok) {
    return {
      kind: 'error',
      reason: `loopback gate rejected webhook url: ${loopback.reason ?? 'invalid'}`,
    }
  }

  const toolUseId = input.hook.tool_use_id
  const sessionId = input.hook.session_id
  if (typeof toolUseId !== 'string' || typeof sessionId !== 'string') {
    return { kind: 'skip', reason: 'envelope missing session_id or tool_use_id' }
  }

  const toolInput = input.hook.tool_input
  if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) {
    return { kind: 'skip', reason: 'envelope missing tool_input object' }
  }
  const questions = (toolInput as { questions?: unknown }).questions
  if (!Array.isArray(questions) || questions.length === 0) {
    return { kind: 'skip', reason: 'tool_input.questions empty or not an array' }
  }

  const transcriptPath = typeof input.hook.transcript_path === 'string'
    ? input.hook.transcript_path
    : ''

  const rawTimeout = input.env.ASK_USER_QUESTION_TIMEOUT_MS
  const configTimeoutMs = parseTimeoutMs(rawTimeout) ?? DEFAULT_CONFIG_TIMEOUT_MS

  const body = JSON.stringify({
    session_id: sessionId,
    tool_use_id: toolUseId,
    transcript_path: transcriptPath,
    timeout_ms: configTimeoutMs,
    questions,
  })

  return {
    url,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body,
    // The wrapper's HTTP-level wait MUST exceed the plugin-side wait by a
    // safety margin so we observe the `timeout` response rather than racing
    // against fetch's own AbortController. Claude Code's own hook `timeout`
    // (set in settings.json) must in turn exceed *this* by another margin.
    httpTimeoutMs: configTimeoutMs + HTTP_MARGIN_MS,
  }
}

function parseTimeoutMs(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

// ─────────────────────────────────────────────────────────────────────────
// Response → stdout JSON mapping.
//
// Claude Code's PreToolUse hook protocol: stdout is parsed as JSON and the
// `hookSpecificOutput.permissionDecision` field controls allow/deny.
// Anything else (empty stdout, malformed JSON) falls through to the next
// matcher or the native tool implementation.
// ─────────────────────────────────────────────────────────────────────────

export interface PluginResponse {
  readonly status?: unknown
  readonly updatedInput?: unknown
}

export type HookDecision =
  | { kind: 'allow'; updatedInput: unknown }
  | { kind: 'deny'; reason: string }
  | { kind: 'passthrough' }

export function decisionFromPluginResponse(response: PluginResponse): HookDecision {
  if (response.status === 'answered') {
    if (
      response.updatedInput &&
      typeof response.updatedInput === 'object' &&
      !Array.isArray(response.updatedInput)
    ) {
      return { kind: 'allow', updatedInput: response.updatedInput }
    }
    // Plugin reported answered but didn't include the input — treat as
    // misbehaving plugin, deny with explicit reason rather than silently
    // letting the tool run on unverified input.
    return {
      kind: 'deny',
      reason: 'AskUserQuestion relay returned answered without updatedInput',
    }
  }
  if (response.status === 'pass_through') {
    return { kind: 'passthrough' }
  }
  if (response.status === 'timeout') {
    return {
      kind: 'deny',
      reason: 'AskUserQuestion timed out waiting for Telegram response',
    }
  }
  // Unknown status — be conservative: deny with the unrecognised status
  // surfaced for ops debugging (status string is plugin-controlled, not
  // user input, so it's safe to echo).
  const statusStr = typeof response.status === 'string' ? response.status : 'unknown'
  return {
    kind: 'deny',
    reason: `AskUserQuestion relay returned unexpected status '${statusStr}'`,
  }
}

export function renderDecision(decision: HookDecision): string {
  if (decision.kind === 'passthrough') return ''
  if (decision.kind === 'allow') {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: decision.updatedInput,
      },
    })
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.reason,
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────
// stdin + main wiring (only runs when executed directly).
// ─────────────────────────────────────────────────────────────────────────

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
  const safe = reason.length > 120 ? `${reason.slice(0, 117)}...` : reason
  process.stderr.write(`ask-user-question-hook: ${safe}\n`)
}

function emit(stdout: string): void {
  if (stdout.length === 0) return
  process.stdout.write(stdout)
}

/**
 * Identify "endpoint unreachable" (plugin not running) failures so we can
 * fall back to the native UI silently. Mid-flight failures (connection
 * accepted then dropped, AbortController fired, DNS glitch, etc.) MUST
 * NOT match here — by the time we observe one, the plugin has likely
 * already sent a Telegram prompt, and falling back to the native UI
 * would prompt the warchief twice.
 *
 * FIX-T2 F1 (PRX-1 Phase 5, 2026-05-27) — narrow detection to true
 * connection-refused errors only. The pre-fix path also matched generic
 * `'Failed to fetch'` / `'Unable to connect'` substrings, which Node-undici
 * raises for a wide range of post-connect errors (TLS handshake failure,
 * mid-stream socket reset, etc.) and which Bun raises for any TypeError
 * thrown inside its fetch impl. Both runtimes set the canonical Node
 * error code on `err.cause.code` for ECONNREFUSED, so we inspect THAT
 * structured field instead of fishing for substrings in the message.
 *
 * Why only ECONNREFUSED qualifies as "silent fallback":
 *   - ECONNREFUSED = the TCP SYN itself was rejected (no listener on
 *     port). The plugin is not running, so we know no Telegram message
 *     has been sent. Safe to fall through to the native UI.
 *   - Any other error means the connection was at least accepted; the
 *     plugin may have started processing (and sent a TG prompt) before
 *     the wire broke. We MUST deny so the tool doesn't run unverified
 *     while the warchief is staring at a stale keyboard.
 */
export function isConnectionRefused(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  // Node-undici populates err.cause.code for socket-level failures.
  // ECONNREFUSED is the canonical Node code for "no listener".
  const cause = (err as { cause?: unknown }).cause
  if (cause !== null && typeof cause === 'object') {
    const code = (cause as { code?: unknown }).code
    if (code === 'ECONNREFUSED') return true
  }
  // Bun's fetch surfaces the same condition via err.code === 'ConnectionRefused'
  // (string), not ECONNREFUSED. Node also exposes ECONNREFUSED directly on
  // err.code in some paths. Accept both literals — they map 1:1 to the
  // same TCP-SYN-rejected state.
  const directCode = (err as { code?: unknown }).code
  if (directCode === 'ECONNREFUSED' || directCode === 'ConnectionRefused') return true
  // Final fallback — some Bun fetch paths set err.name = 'ConnectionRefused'
  // without populating .code. Treat as the same signal.
  const name = (err as { name?: unknown }).name
  if (typeof name === 'string' && name === 'ConnectionRefused') return true
  return false
}

async function postWithTimeout(req: AskHookRequest): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), req.httpTimeoutMs)
  try {
    return await fetch(req.url, {
      method: 'POST',
      headers: { ...req.headers },
      body: req.body,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
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
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warn('stdin payload not an object')
    return
  }

  const built = buildAskRequest({
    env: process.env,
    hook: parsed as Record<string, unknown>,
  })

  if ('kind' in built) {
    if (built.kind === 'error') warn(built.reason)
    // skip and error both → exit 0 with empty stdout (no-op / fallback).
    return
  }

  let response: Response
  try {
    response = await postWithTimeout(built)
  } catch (err) {
    if (isConnectionRefused(err)) {
      // Plugin not running — silent fallback to Claude's native UI.
      // (Operator's deny-list will still kick in if AskUserQuestion is
      // listed; that's a separate, deliberate config.)
      return
    }
    // Mid-flight failure: connection accepted then dropped, AbortController
    // fired due to httpTimeoutMs, DNS failure, etc. Per Codex plan TASK-4
    // we deny here — TG message may have already been sent, so silently
    // falling back to the native UI would prompt twice.
    const msg = err instanceof Error ? err.message : String(err)
    const redacted = msg.replace(/Bearer\s+\S+/gi, 'Bearer ***')
    warn(`relay request failed: ${redacted}`)
    emit(
      renderDecision({
        kind: 'deny',
        reason: 'AskUserQuestion plugin HTTP relay crashed; aborting tool call',
      }),
    )
    return
  }

  if (!response.ok) {
    warn(`relay responded ${response.status}`)
    emit(
      renderDecision({
        kind: 'deny',
        reason: `AskUserQuestion relay returned HTTP ${response.status}`,
      }),
    )
    return
  }

  let payload: PluginResponse
  try {
    payload = (await response.json()) as PluginResponse
  } catch {
    warn('relay response not valid JSON')
    emit(
      renderDecision({
        kind: 'deny',
        reason: 'AskUserQuestion relay returned malformed response',
      }),
    )
    return
  }

  emit(renderDecision(decisionFromPluginResponse(payload)))
}

const isMainModule = (() => {
  try {
    const arg = process.argv[1] ?? ''
    return arg.endsWith('ask-user-question-hook.ts') ||
      arg.endsWith('ask-user-question-hook.js')
  } catch {
    return false
  }
})()

if (isMainModule) {
  await main().catch((err) => {
    warn(err instanceof Error ? err.message : 'unknown error')
  })
}
