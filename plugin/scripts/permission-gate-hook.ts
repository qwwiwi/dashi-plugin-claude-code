#!/usr/bin/env bun
// permission-gate-hook.ts — PreToolUse hook for the owner's main DM session.
//
// The session runs under `--permission-mode bypassPermissions`, so Claude
// Code never renders an interactive Allow/Deny prompt in the tmux pane (the
// owner is on Telegram and could not answer it). This hook is therefore the
// ONLY permission gate. For every tool call it:
//
//   1. classifies the call against the policy (src/security/permission-policy)
//      into allow / deny / confirm;
//   2. allow   → emits permissionDecision "allow" (runs silently);
//   3. deny    → emits permissionDecision "deny" + reason (blocked hard);
//   4. confirm → POSTs to the plugin's /hooks/permission/request, sends the
//      owner an Allow/Deny keyboard in Telegram, and waits (bounded). The
//      owner's tap maps back to allow/deny. Timeout / plugin-down / error →
//      DENY (fail-closed — there is no terminal UI to fall back to).
//
// Hard invariants (mirror ask-user-question-hook.ts):
//   * The decision travels via stdout JSON. Exit code is 0 on normal paths;
//     failClosed() additionally sets exit 2 (a second deny signal Claude Code
//     honors even if the stdout JSON is unparseable).
//   * Bearer token never written to stdout/stderr.
//   * Off-loopback webhook URL → refuse to ship the token; fail-closed deny
//     for confirm-tier calls (we cannot get a verdict safely).
//
// Env (populated by install-hooks.sh into the hook command):
//   TELEGRAM_WEBHOOK_URL    base, e.g. http://127.0.0.1:8093  (we append the path)
//   TELEGRAM_WEBHOOK_TOKEN  bearer token configured on the plugin
//   TELEGRAM_WEBHOOK_PORT   loopback port allowlist hint (default 8093)
//   TELEGRAM_PERMISSION_POLICY_PATH  policy.yaml path (default: workspace/chats/permission-policy.yaml)
//   CLAUDE_WORKSPACE_DIR    workspace root (for the default policy path)
//   CHAT_ID                 scope id for per-scope policy (default "main")
//   PERMISSION_CONFIRM_TIMEOUT_MS  owner-tap wait, default 120000

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load as parseYaml, JSON_SCHEMA } from 'js-yaml'

import {
  classifyToolCall,
  PermissionPolicySchema,
  type PermissionPolicy,
  type PermissionVerdict,
} from '../src/security/permission-policy.js'
import { validateLoopbackUrl, isConnectionRefused } from './ask-user-question-hook.js'

const DEFAULT_CONFIRM_TIMEOUT_MS = 120_000
const HTTP_MARGIN_MS = 5_000
// Fail-safe (not fail-open): when no operator policy is loadable we fall back
// to confirm-every-mutating-tool. The built-in hard-deny still applies, so
// secrets/destructive calls stay blocked even with this minimal policy.
const FALLBACK_POLICY: PermissionPolicy = { default_tier: 'confirm' }

// ── stdout rendering (PreToolUse contract) ──────────────────────────────

export function renderAllow(): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
  })
}

export function renderDeny(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })
}

// ── policy loading ──────────────────────────────────────────────────────

export function resolvePolicyPath(env: Readonly<Record<string, string | undefined>>): string {
  const explicit = env.TELEGRAM_PERMISSION_POLICY_PATH
  if (explicit && explicit.length > 0) return explicit
  const ws = env.CLAUDE_WORKSPACE_DIR && env.CLAUDE_WORKSPACE_DIR.length > 0
    ? env.CLAUDE_WORKSPACE_DIR
    : join(env.HOME ?? '', '.claude-lab/thrall/.claude')
  return join(ws, 'chats', 'permission-policy.yaml')
}

export function loadPolicy(path: string): { policy: PermissionPolicy; warning?: string } {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { policy: FALLBACK_POLICY, warning: `policy file unreadable (${path}); confirm-everything fallback` }
  }
  let parsed: unknown
  try {
    parsed = parseYaml(raw, { schema: JSON_SCHEMA })
  } catch (err) {
    return {
      policy: FALLBACK_POLICY,
      warning: `policy YAML parse failed: ${err instanceof Error ? err.message : 'unknown'}; fallback`,
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { policy: FALLBACK_POLICY, warning: 'policy not an object; fallback' }
  }
  // Strict schema validation (Codex high): an unknown/misspelled key or a
  // wrong-typed rule list discards the whole file rather than silently
  // applying a partial policy that could widen the allow surface.
  const result = PermissionPolicySchema.safeParse(parsed)
  if (!result.success) {
    const summary = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')
      .slice(0, 200)
    return { policy: FALLBACK_POLICY, warning: `policy schema invalid (${summary}); confirm-everything fallback` }
  }
  return { policy: result.data as PermissionPolicy }
}

// ── confirm-tier request building ───────────────────────────────────────

export interface ConfirmRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly httpTimeoutMs: number
}

export interface BuildSkip {
  readonly kind: 'deny'
  readonly reason: string
}

/** Short, safe preview of what the owner is being asked to approve. */
export function previewToolCall(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    return toolInput.command.slice(0, 400)
  }
  const fp = toolInput.file_path ?? toolInput.notebook_path
  if (typeof fp === 'string') return fp.slice(0, 400)
  return ''
}

export function buildConfirmRequest(args: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly sessionId: string
  readonly toolUseId: string
  readonly toolName: string
  readonly preview: string
  readonly reason: string
}): ConfirmRequest | BuildSkip {
  const { env } = args
  const base = env.TELEGRAM_WEBHOOK_URL
  const token = env.TELEGRAM_WEBHOOK_TOKEN
  if (!base) return { kind: 'deny', reason: 'permission confirm unavailable: TELEGRAM_WEBHOOK_URL unset' }
  if (!token) return { kind: 'deny', reason: 'permission confirm unavailable: TELEGRAM_WEBHOOK_TOKEN unset' }

  // The base may be a bare origin (http://127.0.0.1:8093) or already include
  // a path; normalize to the permission route. Validate loopback on the
  // origin so a misconfigured URL can't exfiltrate the bearer.
  let origin: string
  try {
    const u = new URL(base)
    origin = `${u.protocol}//${u.host}`
  } catch {
    return { kind: 'deny', reason: 'permission confirm unavailable: webhook URL not parseable' }
  }
  const loopback = validateLoopbackUrl(origin, env)
  if (!loopback.ok) {
    return { kind: 'deny', reason: `permission confirm unavailable: ${loopback.reason ?? 'loopback gate'}` }
  }
  const url = `${origin}/hooks/permission/request`

  const timeoutMs = parsePositiveInt(env.PERMISSION_CONFIRM_TIMEOUT_MS) ?? DEFAULT_CONFIRM_TIMEOUT_MS
  const body = JSON.stringify({
    session_id: args.sessionId,
    tool_use_id: args.toolUseId,
    tool_name: args.toolName,
    preview: args.preview,
    reason: args.reason,
    timeout_ms: timeoutMs,
  })
  return {
    url,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body,
    httpTimeoutMs: timeoutMs + HTTP_MARGIN_MS,
  }
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

// ── confirm response mapping ────────────────────────────────────────────

export interface PluginVerdict {
  readonly status?: unknown
  readonly reason?: unknown
}

export type ConfirmDecision = { kind: 'allow' } | { kind: 'deny'; reason: string }

export function mapConfirmResponse(payload: PluginVerdict): ConfirmDecision {
  const reason = typeof payload.reason === 'string' ? payload.reason : ''
  switch (payload.status) {
    case 'allow':
      return { kind: 'allow' }
    case 'deny':
      return { kind: 'deny', reason: reason || 'owner denied via Telegram' }
    case 'timeout':
      return { kind: 'deny', reason: 'permission confirm timed out (no Telegram answer); fail-closed' }
    default: {
      const s = typeof payload.status === 'string' ? payload.status : 'unknown'
      return { kind: 'deny', reason: `permission relay returned unexpected status '${s}'; fail-closed` }
    }
  }
}

// ── local decision (pure, testable) ─────────────────────────────────────

export interface LocalDecision {
  readonly action: 'emit' | 'confirm'
  /** for action=emit */
  readonly stdout?: string
  /** for action=confirm */
  readonly verdict?: PermissionVerdict
}

/**
 * Decide locally from the envelope + policy. Returns either a final stdout
 * string (allow/deny/passthrough) or a signal to run the confirm flow.
 * Passthrough (empty stdout) only for non-PreToolUse events.
 */
export function decideLocal(args: {
  readonly envelope: Record<string, unknown>
  readonly policy: PermissionPolicy
  readonly scope: string
}): LocalDecision {
  const { envelope, policy, scope } = args
  const event = envelope.hook_event_name
  // This hook is installed for PreToolUse ONLY (install-hooks wires the gate
  // marker exclusively on PreToolUse; the notification mirror is a separate
  // hook). So ANY envelope whose event is not exactly "PreToolUse" — missing,
  // non-string, or a spoofed/mislabeled value like "PostToolUse" — is either
  // malformed or a misconfiguration, and under bypassPermissions must fail
  // closed to deny rather than passthrough (Codex round-2 Critical). A deny on
  // a genuine non-PreToolUse event (if ever misconfigured) is harmless — those
  // events have no permission decision to honor.
  if (event !== 'PreToolUse') {
    return { action: 'emit', stdout: renderDeny('non-PreToolUse or malformed hook envelope; fail-closed') }
  }
  const verdict = classifyToolCall({
    toolName: envelope.tool_name,
    toolInput: envelope.tool_input,
    policy,
    scope,
  })
  if (verdict.tier === 'allow') return { action: 'emit', stdout: renderAllow() }
  if (verdict.tier === 'deny') return { action: 'emit', stdout: renderDeny(verdict.reason) }
  return { action: 'confirm', verdict }
}

// ── runtime wiring ──────────────────────────────────────────────────────

function warn(reason: string): void {
  const safe = reason.length > 160 ? `${reason.slice(0, 157)}...` : reason
  process.stderr.write(`permission-gate-hook: ${safe.replace(/Bearer\s+\S+/gi, 'Bearer ***')}\n`)
}

function emit(stdout: string): void {
  if (stdout.length > 0) process.stdout.write(stdout)
}

async function readStdin(): Promise<string> {
  try {
    const bun = (globalThis as { Bun?: { stdin?: { text?: () => Promise<string> } } }).Bun
    const fn = bun?.stdin?.text
    if (typeof fn === 'function') return await fn.call(bun?.stdin)
  } catch {
    /* fall through */
  }
  return await new Promise<string>((resolve) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (c: Buffer) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', () => resolve(''))
  })
}

async function postConfirm(req: ConfirmRequest): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), req.httpTimeoutMs)
  try {
    return await fetch(req.url, { method: 'POST', headers: { ...req.headers }, body: req.body, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function runConfirm(req: ConfirmRequest): Promise<ConfirmDecision> {
  let response: Response
  try {
    response = await postConfirm(req)
  } catch (err) {
    if (isConnectionRefused(err)) {
      // Plugin not running. Under bypassPermissions there is no native prompt
      // to fall back to, so a risky call must be denied — never run unconfirmed.
      return { kind: 'deny', reason: 'permission relay unreachable (plugin down); fail-closed' }
    }
    return { kind: 'deny', reason: 'permission relay request failed; fail-closed' }
  }
  if (!response.ok) {
    return { kind: 'deny', reason: `permission relay returned HTTP ${response.status}; fail-closed` }
  }
  let payload: PluginVerdict
  try {
    payload = (await response.json()) as PluginVerdict
  } catch {
    return { kind: 'deny', reason: 'permission relay returned malformed response; fail-closed' }
  }
  return mapConfirmResponse(payload)
}

// Fail-closed exit (Codex Critical #1, 2026-06-09): under bypassPermissions
// there is no native prompt, so emitting NOTHING means the tool RUNS. Every
// path where we cannot positively classify a PreToolUse call must emit an
// explicit deny instead of returning silently. The hook is registered for
// PreToolUse only, so an unreadable/unparseable envelope is a PreToolUse we
// failed to inspect — deny it.
function failClosed(reason: string): void {
  warn(reason)
  emit(renderDeny(reason))
  // Belt-and-suspenders (Codex Critical #1): also signal deny via exit code 2.
  // Claude Code treats a PreToolUse hook exiting 2 as a block even if it can't
  // parse the stdout JSON — so a partial-write / encoding mishap on the deny
  // JSON still fails closed. Set exitCode (not process.exit) so any in-flight
  // stdout flush completes first.
  process.exitCode = 2
}

async function main(): Promise<void> {
  const raw = await readStdin()
  if (raw.trim().length === 0) {
    failClosed('empty stdin (no tool envelope); fail-closed')
    return
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(raw)
  } catch {
    failClosed('stdin not valid JSON; fail-closed')
    return
  }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    failClosed('stdin payload not an object; fail-closed')
    return
  }
  const env = process.env
  const { policy, warning } = loadPolicy(resolvePolicyPath(env))
  if (warning) warn(warning)
  const scope = env.CHAT_ID && env.CHAT_ID.length > 0 ? env.CHAT_ID : 'main'

  const local = decideLocal({ envelope: envelope as Record<string, unknown>, policy, scope })
  if (local.action === 'emit') {
    emit(local.stdout ?? '')
    return
  }

  // confirm tier
  const e = envelope as Record<string, unknown>
  const sessionId = typeof e.session_id === 'string' ? e.session_id : ''
  const toolUseId = typeof e.tool_use_id === 'string' ? e.tool_use_id : ''
  const toolName = typeof e.tool_name === 'string' ? e.tool_name : ''
  const ti = e.tool_input !== null && typeof e.tool_input === 'object' && !Array.isArray(e.tool_input)
    ? (e.tool_input as Record<string, unknown>)
    : {}
  const preview = previewToolCall(toolName, ti)
  const reason = local.verdict?.reason ?? 'risky operation'

  const built = buildConfirmRequest({ env, sessionId, toolUseId, toolName, preview, reason })
  if ('kind' in built) {
    warn(built.reason)
    emit(renderDeny(built.reason))
    return
  }
  const decision = await runConfirm(built)
  if (decision.kind === 'allow') {
    emit(renderAllow())
  } else {
    emit(renderDeny(decision.reason))
  }
}

const isMainModule = (() => {
  try {
    const arg = process.argv[1] ?? ''
    return arg.endsWith('permission-gate-hook.ts') || arg.endsWith('permission-gate-hook.js')
  } catch {
    return false
  }
})()

if (isMainModule) {
  // Top-level fail-closed: any unexpected throw emits a deny rather than
  // exiting silently (which under bypassPermissions would run the tool).
  await main().catch((err) => failClosed(err instanceof Error ? err.message : 'unknown error; fail-closed'))
}
