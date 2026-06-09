#!/usr/bin/env bun
/**
 * doctor-dashi-plugin — migration & health diagnostic.
 *
 * Helps an agent move from the legacy telegram-gateway (per-message `claude -p`
 * spawn) to the dashi-plugin-claude-code channel (one live session) without
 * repeating the mistakes we already paid for.
 *
 * Standalone by design: it imports nothing from the plugin's `src/` so it keeps
 * working even when the plugin checkout is broken — diagnosing a broken checkout
 * is one of its jobs. All probes are read-only; the doctor never restarts a
 * service, never writes config, never touches a token. Output is redacted.
 *
 * Run:  bun skills/doctor-dashi-plugin/scripts/doctor.ts [--json] [options]
 * Exit: 0 = no FAIL, 1 = at least one FAIL, 2 = usage error.
 */
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { homedir, platform } from 'os'

export type Status = 'pass' | 'warn' | 'fail' | 'skip'

export interface Check {
  id: string
  title: string
  status: Status
  detail: string
  /** One-line remediation pointer shown when status is warn/fail. */
  fix?: string
}

export type OS = 'linux' | 'macos' | 'other'

/** Required floors. Below these, migration is unsupported. */
export const MIN_CLAUDE = [2, 1, 0] as const
// 1.3.9 is the lowest Bun verified in production (Thrall VPS fleet: live
// channel + 1266 plugin tests green). The previous 1.3.14 floor was the
// authoring machine's version, not a real requirement, and failed working
// hosts for no reason.
export const MIN_BUN = [1, 3, 9] as const

/** The five hook events install-hooks.sh must register. */
export const REQUIRED_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
] as const

export const HOOK_MARKER = 'dashi-channel-hook'
export const FALLBACK_MARKER = 'dashi-channel-fallback-reply'
// Permission-gate PreToolUse hook marker (2026-06-09). Written by
// patch-claude-settings.ts when --permission-gate-helper is given.
export const GATE_MARKER = 'dashi-permission-gate-hook'
export const LIVE_MARKER = 'Listening for channel messages from: server:dashi-channel'

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export function detectOS(p: string = platform()): OS {
  if (p === 'linux') return 'linux'
  if (p === 'darwin') return 'macos'
  return 'other'
}

/**
 * Mask anything that looks like a secret. We are often run in a public group
 * where the transcript is shown to students, so leaking a token is a real
 * incident, not a cosmetic one.
 */
/** Env/JSON keys whose value must never reach the output, whatever its shape. */
const SECRET_WORDS = 'TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|BEARER'
// Quoted value (handles spaces, commas, escapes, JSON `"KEY":"v"`): mask to the
// closing quote. Bare value: mask to the next whitespace/comma/quote/brace.
const SECRET_QUOTED = new RegExp(`("?[A-Za-z0-9_]*(?:${SECRET_WORDS})[A-Za-z0-9_]*"?\\s*[=:]\\s*)(["'])[\\s\\S]*?\\2`, 'gi')
const SECRET_BARE = new RegExp(`([A-Za-z0-9_]*(?:${SECRET_WORDS})[A-Za-z0-9_]*\\s*[=:]\\s*)([^\\s"',}]+)`, 'gi')

/**
 * Secret-class masking only — the rules that detect ACTUAL credentials.
 * Used both by `redact` (display) and by the settings leak CHECK, which
 * must not fire on privacy-only maskings like IP addresses: install-hooks
 * legitimately writes `http://127.0.0.1:<port>/hooks/agent` into every
 * hook command, and flagging that as a leak failed every correct setup.
 */
export function redactSecretsStrict(input: string): string {
  return input
    // Known secret assignments — mask the value regardless of its shape, so an
    // unusual or quoted token still does not leak. Quoted form first.
    .replace(SECRET_QUOTED, '$1$2<redacted>$2')
    .replace(SECRET_BARE, '$1<redacted>')
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, '<bot-token>')
    .replace(/\bgsk_[A-Za-z0-9]{20,}\b/g, '<groq-key>')
    .replace(/\bsk-[A-Za-z0-9-]{20,}\b/g, '<api-key>')
    .replace(/[Bb]earer\s+[A-Za-z0-9._-]{10,}/g, 'Bearer <redacted>')
}

export function redact(input: string): string {
  return redactSecretsStrict(input)
    // Privacy-only masking (NOT a secret): server IPs in output shown to
    // public groups. Kept out of redactSecretsStrict so the leak check
    // doesn't false-positive on the loopback webhook URL.
    .replace(/\b(\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
}

/** Redact every string field of a check — the single boundary for safe output. */
export function redactCheck(c: Check): Check {
  return {
    id: redact(c.id),
    title: redact(c.title),
    status: c.status,
    detail: redact(c.detail),
    ...(c.fix !== undefined ? { fix: redact(c.fix) } : {}),
  }
}

/**
 * Path-boundary aware "same tree" test — `/srv/agent/plugin` and
 * `/srv/agent/plugin-old` are NOT the same tree, which a bare startsWith would
 * get wrong.
 */
export function sameTree(a: string, b: string): boolean {
  const na = a.replace(/\/+$/, '') + '/'
  const nb = b.replace(/\/+$/, '') + '/'
  return na.startsWith(nb) || nb.startsWith(na)
}

export function parseSemver(v: string): [number, number, number] | null {
  const m = v.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!m) return null
  return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

/** Returns negative if a<b, 0 if equal, positive if a>b. */
export function cmpSemver(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

export function checkVersion(
  id: string,
  title: string,
  rawOutput: string,
  min: readonly [number, number, number],
): Check {
  const parsed = parseSemver(rawOutput)
  if (!parsed) {
    return {
      id,
      title,
      status: 'fail',
      detail: `could not parse version from: ${redact(rawOutput.trim().slice(0, 80))}`,
      fix: 'install/upgrade the tool, then re-run the doctor',
    }
  }
  const ok = cmpSemver(parsed, min) >= 0
  const got = parsed.join('.')
  const want = min.join('.')
  return ok
    ? { id, title, status: 'pass', detail: `${got} (>= ${want})` }
    : {
        id,
        title,
        status: 'fail',
        detail: `${got} is below the required ${want}`,
        fix: `upgrade to >= ${want}`,
      }
}

/**
 * Walk up from the plugin directory looking for the workspace CLAUDE.md.
 * The plugin MUST live inside `<workspace>/.claude/...` so Claude Code's
 * upward CWD search picks up the agent's project CLAUDE.md. Placing it in
 * ~/projects or /opt is the single most common first-run failure (identity
 * drift — the bot answers as "default Claude").
 */
export function findEnclosingClaudeMd(
  pluginDir: string,
  fileExists: (p: string) => boolean = existsSync,
): string | null {
  let dir = pluginDir
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'CLAUDE.md')
    if (fileExists(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export function checkWorkspacePlacement(
  pluginDir: string,
  fileExists: (p: string) => boolean = existsSync,
): Check {
  const claudeMd = findEnclosingClaudeMd(pluginDir, fileExists)
  if (!claudeMd) {
    return {
      id: 'workspace-placement',
      title: 'Plugin inside an agent workspace (CLAUDE.md reachable)',
      status: 'fail',
      detail: `no CLAUDE.md found walking up from ${pluginDir}`,
      fix: 'move the plugin under <workspace>/.claude/dashi-plugin-claude-code/plugin so CLAUDE.md is reachable, else the agent loses its identity',
    }
  }
  const insideDotClaude = pluginDir.includes(`${join('.claude')}/`) || pluginDir.includes('/.claude/')
  if (!insideDotClaude) {
    return {
      id: 'workspace-placement',
      title: 'Plugin inside an agent workspace (CLAUDE.md reachable)',
      status: 'warn',
      detail: `CLAUDE.md found at ${claudeMd} but plugin is not under a .claude/ directory`,
      fix: 'conventionally the plugin lives at <workspace>/.claude/dashi-plugin-claude-code/plugin',
    }
  }
  return {
    id: 'workspace-placement',
    title: 'Plugin inside an agent workspace (CLAUDE.md reachable)',
    status: 'pass',
    detail: `CLAUDE.md reachable at ${claudeMd}`,
  }
}

interface SettingsHookEntry {
  marker?: string
  hooks?: Array<{ command?: string }>
  command?: string
}
interface SettingsShape {
  hooks?: Record<string, SettingsHookEntry[]>
}

/** Collect every command string reachable from a settings hook entry. */
function entryCommands(entry: SettingsHookEntry): string[] {
  const cmds: string[] = []
  if (typeof entry.command === 'string') cmds.push(entry.command)
  for (const h of entry.hooks ?? []) {
    if (typeof h.command === 'string') cmds.push(h.command)
  }
  return cmds
}

/**
 * True only when an entry both carries the marker AND has a runnable command —
 * a marker on an entry with no command would pass a substring test but never
 * actually fire the hook.
 */
function hasWorkingHook(entries: SettingsHookEntry[], marker: string): boolean {
  return entries.some((e) => e.marker === marker && entryCommands(e).some((c) => c.length > 0))
}

/**
 * Verify the five channel hook events are registered with a runnable command,
 * and that no secret ever leaked into settings.json (the patcher refuses to
 * write the webhook token; anything secret-shaped here is about to be committed).
 */
export function checkSettingsHooks(settings: unknown): Check[] {
  const out: Check[] = []
  const raw = JSON.stringify(settings ?? {})
  // Shape-based leak detection: if SECRET-class redaction changes the
  // serialized settings, something secret-shaped is present (a token value, a
  // bearer literal, a known secret-key assignment) regardless of the key name.
  // Strict variant on purpose: full redact() also masks IPs, and the loopback
  // webhook URL that install-hooks writes would false-positive every setup.
  const leaked = /TELEGRAM_WEBHOOK_TOKEN/.test(raw) || redactSecretsStrict(raw) !== raw
  out.push(
    leaked
      ? {
          id: 'settings-no-token',
          title: 'No secret leaked into settings.json',
          status: 'fail',
          detail: 'a secret-shaped value is present in settings.json',
          fix: 'remove it — tokens belong in runtime env only, never in settings.json (it gets committed)',
        }
      : {
          id: 'settings-no-token',
          title: 'No secret leaked into settings.json',
          status: 'pass',
          detail: 'no secret leaked into settings',
        },
  )

  const hooks = (settings as SettingsShape)?.hooks ?? {}
  for (const ev of REQUIRED_HOOK_EVENTS) {
    const entries = Array.isArray(hooks[ev]) ? hooks[ev] : []
    const working = hasWorkingHook(entries, HOOK_MARKER)
    const markerOnly = !working && JSON.stringify(entries).includes(HOOK_MARKER)
    out.push(
      working
        ? { id: `hook-${ev}`, title: `Hook registered: ${ev}`, status: 'pass', detail: `marker ${HOOK_MARKER} with a runnable command` }
        : {
            id: `hook-${ev}`,
            title: `Hook registered: ${ev}`,
            status: 'warn',
            detail: markerOnly ? `${ev} has a ${HOOK_MARKER} entry but no runnable command` : `no ${HOOK_MARKER} entry for ${ev}`,
            fix: 'run plugin/scripts/install-hooks.sh to register status + memory hooks',
          },
    )
  }

  // DM fallback-reply (PR #47) — optional but recommended: guarantees the chief
  // gets an answer even when the agent forgets to call the reply tool.
  const stopEntries = Array.isArray(hooks['Stop']) ? hooks['Stop'] : []
  out.push(
    hasWorkingHook(stopEntries, FALLBACK_MARKER)
      ? { id: 'fallback-reply-hook', title: 'DM fallback-reply Stop-hook (PR #47)', status: 'pass', detail: 'silent-turn fallback is registered' }
      : {
          id: 'fallback-reply-hook',
          title: 'DM fallback-reply Stop-hook (PR #47)',
          status: 'warn',
          detail: 'no fallback-reply Stop-hook — a forgotten reply will be silently lost in DMs',
          fix: 'register the fallback-reply Stop-hook so a silent turn still reaches the chief',
        },
  )
  return out
}

interface SettingsPermShape {
  permissions?: { defaultMode?: string }
  hooks?: Record<string, SettingsHookEntry[]>
}

/**
 * Permission gate (2026-06-09) — the interactive Allow/Deny confirm hook for a
 * bypassPermissions DM session. Optional: when no gate hook is registered the
 * checks are skipped (the feature is off). When it IS registered we verify:
 *   - the PreToolUse entry has a runnable command pointing at the gate helper;
 *   - no bearer token leaked into the command (defence-in-depth over the global
 *     leak check);
 *   - the session is (or claims to be) in bypassPermissions — the gate is the
 *     SOLE authority only in that mode; otherwise native prompts still wedge.
 */
export function checkPermissionGate(settings: unknown): Check[] {
  const s = (settings as SettingsPermShape) ?? {}
  const pre = Array.isArray(s.hooks?.PreToolUse) ? s.hooks!.PreToolUse! : []
  const gate = pre.find((e) => e.marker === GATE_MARKER)
  if (!gate) {
    return [{
      id: 'permission-gate',
      title: 'Permission gate (interactive Allow/Deny)',
      status: 'skip',
      detail: 'no permission-gate PreToolUse hook — interactive confirm is off (optional)',
    }]
  }
  const out: Check[] = []
  const cmds = entryCommands(gate)
  const runnable = cmds.some((c) => c.length > 0)
  const pointsAtHelper = cmds.some((c) => c.includes('permission-gate-hook.ts'))
  out.push(
    runnable && pointsAtHelper
      ? { id: 'permission-gate', title: 'Permission gate (interactive Allow/Deny)', status: 'pass', detail: `${GATE_MARKER} registered on PreToolUse` }
      : {
          id: 'permission-gate',
          title: 'Permission gate (interactive Allow/Deny)',
          status: 'warn',
          detail: runnable ? `${GATE_MARKER} entry does not point at permission-gate-hook.ts` : `${GATE_MARKER} entry has no runnable command`,
          fix: 'run plugin/scripts/install-hooks.sh --permission-gate to (re)register the gate hook',
        },
  )
  // Bearer-token leak in the gate command (the patcher refuses to write it).
  if (cmds.some((c) => c.includes('TELEGRAM_WEBHOOK_TOKEN'))) {
    out.push({
      id: 'permission-gate-token',
      title: 'Permission gate: no bearer token in the hook command',
      status: 'fail',
      detail: 'TELEGRAM_WEBHOOK_TOKEN is hard-coded in the gate hook command',
      fix: 'remove it — the gate hook reads the token from the agent runtime env, never from settings.json',
    })
  }
  // bypassPermissions advisory — the gate is the SOLE permission authority only
  // when the session runs --permission-mode bypassPermissions. We can read an
  // explicit settings.permissions.defaultMode but the flag is usually on the
  // CLI/systemd ExecStart, so a non-match is unverified, not a hard fail.
  const mode = s.permissions?.defaultMode
  out.push(
    mode === 'bypassPermissions'
      ? { id: 'permission-gate-mode', title: 'Permission gate: session in bypassPermissions', status: 'pass', detail: 'permissions.defaultMode=bypassPermissions' }
      : {
          id: 'permission-gate-mode',
          title: 'Permission gate: session in bypassPermissions',
          status: 'warn',
          detail: mode ? `permissions.defaultMode=${mode} (not bypassPermissions)` : 'permissions.defaultMode unset in settings — verify the session runs with --permission-mode bypassPermissions',
          fix: 'the gate only suppresses native prompts under bypassPermissions; otherwise interactive prompts still wedge the headless session',
        },
  )
  return out
}

interface McpShape {
  mcpServers?: Record<string, unknown>
}
interface SettingsLocalShape {
  enableAllProjectMcpServers?: boolean
  enabledMcpjsonServers?: string[]
}

/**
 * The landmine from 2026-06-02: with enableAllProjectMcpServers=false, every
 * server declared in .mcp.json must be listed explicitly in
 * enabledMcpjsonServers, or it is silently dropped on the NEXT restart — the
 * live session survives, so the breakage is latent and shows up hours later as
 * "the agent went silent".
 */
export function checkCommsConsistency(mcp: unknown, settingsLocal: unknown): Check {
  const servers = Object.keys((mcp as McpShape)?.mcpServers ?? {})
  const sl = (settingsLocal as SettingsLocalShape) ?? {}
  if (servers.length === 0) {
    return {
      id: 'comms-consistency',
      title: 'MCP comms servers enabled consistently',
      status: 'skip',
      detail: 'no .mcp.json servers declared',
    }
  }
  if (sl.enableAllProjectMcpServers === true) {
    return {
      id: 'comms-consistency',
      title: 'MCP comms servers enabled consistently',
      status: 'pass',
      detail: `enableAllProjectMcpServers=true covers all ${servers.length} server(s)`,
    }
  }
  if (sl.enabledMcpjsonServers !== undefined && !Array.isArray(sl.enabledMcpjsonServers)) {
    return {
      id: 'comms-consistency',
      title: 'MCP comms servers enabled consistently',
      status: 'fail',
      detail: 'enabledMcpjsonServers is not an array — settings.local.json is malformed',
      fix: 'make enabledMcpjsonServers a JSON array of server names',
    }
  }
  const enabled = new Set(Array.isArray(sl.enabledMcpjsonServers) ? sl.enabledMcpjsonServers : [])
  const missing = servers.filter((s) => !enabled.has(s))
  if (missing.length > 0) {
    return {
      id: 'comms-consistency',
      title: 'MCP comms servers enabled consistently',
      status: 'fail',
      detail: `dropped on next restart: ${missing.join(', ')}`,
      fix: 'add every .mcp.json server to enabledMcpjsonServers (or set enableAllProjectMcpServers=true) — a missing comms server goes silent after the next restart',
    }
  }
  return {
    id: 'comms-consistency',
    title: 'MCP comms servers enabled consistently',
    status: 'pass',
    detail: `all ${servers.length} server(s) explicitly enabled`,
  }
}

/**
 * Read a CSV env var value, tolerating `export ` prefixes, surrounding quotes,
 * and trailing `# comments` — all of which appear in real channel.env files and
 * would otherwise corrupt the parse (e.g. `=42 # me` → id "42 # me").
 */
export function parseEnvList(envText: string, key: string): string[] | null {
  const m = envText.match(new RegExp(`^(?:export\\s+)?${key}=(.*)$`, 'm'))
  if (!m) return null
  let v = (m[1] ?? '').trim()
  v = v.replace(/\s+#.*$/, '').trim() // strip inline comment
  v = v.replace(/^["']|["']$/g, '') // strip surrounding quotes
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function allowlistCheck(id: string, title: string, key: string, ids: string[] | null, wanted?: string): Check {
  if (ids === null || ids.length === 0) {
    return { id, title, status: 'warn', detail: `${key} empty — the code default applies`, fix: `set ${key} to your numeric id (ask @userinfobot)` }
  }
  if (!wanted) {
    return { id, title, status: 'pass', detail: `${key} set (${ids.length} id(s)); pass the id to verify membership` }
  }
  return ids.includes(wanted)
    ? { id, title, status: 'pass', detail: `${wanted} is in ${key}` }
    : { id, title, status: 'fail', detail: `${wanted} is NOT in ${key} — your messages are silently dropped`, fix: `add ${wanted} to ${key}` }
}

/**
 * The runtime gate requires BOTH user and chat membership (in a DM chat.id ==
 * user.id, but a drifted config can allow a user without the matching chat and
 * silently drop). So we verify both lists. Symptom of a miss: queue pending=0
 * but no reply and no error.
 */
export function checkAllowlist(envText: string, userId?: string, chatId?: string): Check[] {
  const out: Check[] = [
    allowlistCheck('allowlist-user', 'Telegram user allowlist', 'TELEGRAM_ALLOWED_USER_IDS', parseEnvList(envText, 'TELEGRAM_ALLOWED_USER_IDS'), userId),
  ]
  const chats = parseEnvList(envText, 'TELEGRAM_ALLOWED_CHAT_IDS')
  // A DM uses chat.id == user.id; only flag the chat list when it exists or a
  // chat id was provided to verify, to avoid noise on a user-only DM setup.
  if (chats !== null || chatId) {
    out.push(allowlistCheck('allowlist-chat', 'Telegram chat allowlist', 'TELEGRAM_ALLOWED_CHAT_IDS', chats, chatId))
  }
  return out
}

/**
 * Interpret a getUpdates response. A 409 means a second consumer holds the same
 * bot token — the most common migration landmine. Do NOT theorise about a
 * Claude version regression; hunt the second process.
 */
export function classifyQueue(getUpdatesJson: unknown, justMessaged = false): Check {
  const r = getUpdatesJson as { ok?: boolean; error_code?: number; result?: unknown[] }
  if (r?.error_code === 409) {
    return {
      id: 'telegram-queue',
      title: 'Telegram getUpdates has a single consumer',
      status: 'fail',
      detail: '409 Conflict — a second process holds the same bot token',
      fix: 'stop the channel, wait 45s, curl getUpdates again. If 409 persists, the second consumer is external (old gateway / debug session / a PM2 app with a leaked token). Find and stop it.',
    }
  }
  if (r?.ok !== true) {
    return {
      id: 'telegram-queue',
      title: 'Telegram getUpdates has a single consumer',
      status: 'warn',
      detail: 'getUpdates did not return ok=true',
      fix: 'check the bot token and network',
    }
  }
  const pending = Array.isArray(r.result) ? r.result.length : 0
  if (justMessaged && pending > 0) {
    return {
      id: 'telegram-queue',
      title: 'Telegram getUpdates has a single consumer',
      status: 'warn',
      detail: `pending=${pending} after you messaged — the poller is not draining updates`,
      fix: 'the polling loop is stuck; check the channel is running and past the welcome prompt',
    }
  }
  return {
    id: 'telegram-queue',
    title: 'Telegram getUpdates has a single consumer',
    status: 'pass',
    detail: `ok, pending=${pending}`,
  }
}

/** The two first-run prompts that block the channel until answered. */
const WELCOME_PROMPT_RE =
  /Do you trust the files|dangerously-load-development-channels is for local|external CLAUDE\.md file imports|❯\s*1\.\s*Yes/i

/**
 * A stuck welcome prompt is detected POSITIVELY — by the prompt text — not by
 * the absence of the startup marker. On a busy session the one-time
 * "Listening…" line scrolls out of the capture window, so marker-absence alone
 * is not evidence of a hang (that was a false-positive in review).
 */
export function detectWelcomeHang(tmuxCapture: string): boolean {
  return WELCOME_PROMPT_RE.test(tmuxCapture)
}

/** True when we can positively confirm the channel is listening. */
export function detectListening(tmuxCapture: string): boolean {
  return tmuxCapture.includes(LIVE_MARKER)
}

export function detectAuthExpired(tmuxCapture: string): boolean {
  // Line-anchored so the words appearing inside a quoted error, a memory note,
  // or this skill's own prose scrolling through the pane do not trip a scary
  // "re-login" FAIL on an already-authenticated session.
  return /^.*(?:API Error: 401|Invalid authentication credentials)/m.test(tmuxCapture) || /^\s*(?:Please run )?\/login\b/im.test(tmuxCapture)
}

export function detectCrashLoop(serviceStatus: string): boolean {
  return (
    /no server running on/.test(serviceStatus) ||
    (/activating \(auto-restart\)/.test(serviceStatus) && /status=0\/SUCCESS/.test(serviceStatus))
  )
}

export function worstStatus(checks: Check[]): Status {
  if (checks.some((c) => c.status === 'fail')) return 'fail'
  if (checks.some((c) => c.status === 'warn')) return 'warn'
  if (checks.some((c) => c.status === 'pass')) return 'pass'
  return 'skip'
}

const ICON: Record<Status, string> = { pass: 'OK  ', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' }

export function renderReport(checks: Check[]): string {
  const lines: string[] = []
  for (const c of checks) {
    lines.push(`[${ICON[c.status]}] ${c.title}`)
    if (c.detail) lines.push(`        ${redact(c.detail)}`)
    if (c.fix && (c.status === 'warn' || c.status === 'fail')) {
      lines.push(`        fix: ${redact(c.fix)}`)
    }
  }
  const fails = checks.filter((c) => c.status === 'fail').length
  const warns = checks.filter((c) => c.status === 'warn').length
  lines.push('')
  lines.push(`Summary: ${checks.length} checks, ${fails} FAIL, ${warns} WARN`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Impure probes (not unit-tested; thin wrappers over the system)
// ---------------------------------------------------------------------------

interface ProbeResult {
  code: number
  stdout: string
  stderr: string
}

function probe(cmd: string, args: string[], timeoutMs = 8000): ProbeResult {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs })
    return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  } catch {
    return { code: -1, stdout: '', stderr: '' }
  }
}

function readFileSafe(p: string): string | null {
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  } catch {
    return null
  }
}

/** Working directory of a live PID — cross-platform (no `pwdx`, absent on macOS). */
function liveCwd(pid: string, os: OS): string {
  if (os === 'linux') {
    const r = probe('readlink', ['-f', `/proc/${pid}/cwd`])
    if (r.stdout.trim()) return r.stdout.trim()
  }
  // lsof exists on both macOS and Linux. `-Fn` prints an `n<path>` field line.
  const r = probe('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'])
  const line = r.stdout.split('\n').find((l) => l.startsWith('n'))
  return line ? line.slice(1).trim() : ''
}

function parseJsonSafe(text: string | null): unknown {
  if (text == null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Fleet (multi-agent) checks — README section 14. N agents on one host under
// one subscription is only safe when the five isolation invariants hold:
// per-workspace hooks, distinct webhook ports, distinct bot tokens, dedicated
// tmux sockets, webhook.enabled per state config. `--fleet` discovers every
// channel-*.service unit and verifies the invariants ACROSS agents — the
// single-agent checks above cannot see cross-agent collisions.
// ---------------------------------------------------------------------------

export interface FleetAgent {
  name: string
  unitPath: string
  /** Distinct tmux socket names used by the unit's Exec lines ('' = default socket). */
  sockets: string[]
  envPath: string | null
  envReadable: boolean
  port: string | null
  /** sha256 hex digest of the bot token — never the token itself. */
  tokenDigest: string | null
  stateDir: string | null
  workspaceRoot: string | null
  /** true/false from <state-dir>/config.json; null = config missing/unreadable. */
  webhookEnabled: boolean | null
  /** Webhook ports referenced by hook commands in the agent's workspace settings. */
  hookPorts: string[]
  /** Path of the workspace settings.json actually found; null = could not locate/read. */
  settingsPath: string | null
}

/** Parse a systemd unit: EnvironmentFile + tmux socket per Exec line. Pure. */
export function parseUnitFile(text: string): { envPath: string | null; sockets: string[] } {
  let envPath: string | null = null
  const sockets = new Set<string>()
  for (const line of text.split('\n')) {
    const env = line.match(/^\s*EnvironmentFile=-?(\S+)/)
    if (env?.[1]) envPath = env[1]
    if (/^\s*Exec(Start|StartPost|Stop|StopPost)=.*tmux/.test(line)) {
      // Only inspect tmux's OWN argv: everything before the first quote is
      // tmux args, the quoted tail is the nested payload (`'claude ... -L x'`
      // must not read as a tmux socket).
      const cmdPart = line.slice(line.indexOf('tmux'))
      const quoteIdx = cmdPart.search(/['"]/)
      const argsPart = quoteIdx === -1 ? cmdPart : cmdPart.slice(0, quoteIdx)
      const sock = argsPart.match(/\s-L\s+(\S+)/)
      sockets.add(sock?.[1] ?? '')
    }
  }
  return { envPath, sockets: [...sockets] }
}

/** First value of KEY=... in env-file text. Pure. */
export function envValue(envText: string, key: string): string | null {
  for (const line of envText.split('\n')) {
    const m = line.match(new RegExp(`^\\s*${key}=(.*)$`))
    if (m) return (m[1] ?? '').trim() || null
  }
  return null
}

/** Webhook ports referenced by hook commands in a serialized settings.json. Pure. */
export function hookPortsInSettings(settingsRaw: string | null): string[] {
  if (!settingsRaw) return []
  const ports = new Set<string>()
  // Any localhost spelling counts — 127.0.0.1, localhost, 0.0.0.0, [::1].
  for (const m of settingsRaw.matchAll(/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):(\d+)\/hooks\/agent/g)) {
    const p = m[1]
    if (p !== undefined) ports.add(p)
  }
  return [...ports]
}

/** Cross-agent invariant checks. Pure — agents prepared by scanFleet. */
export function checkFleet(agents: FleetAgent[], sharedSettingsRaw: string | null): Check[] {
  const out: Check[] = []
  const names = agents.map((a) => a.name).join(', ')
  out.push(
    agents.length > 0
      ? { id: 'fleet-size', title: 'Fleet discovery', status: 'pass', detail: `${agents.length} channel unit(s): ${names}` }
      : { id: 'fleet-size', title: 'Fleet discovery', status: 'fail', detail: 'no channel-*.service units found', fix: 'pass --fleet-dir <dir with channel-*.service files>' },
  )
  if (agents.length === 0) return out

  const unreadable = agents.filter((a) => !a.envReadable).map((a) => a.name)
  if (unreadable.length > 0) {
    out.push({
      id: 'fleet-env-readable',
      title: 'Fleet env files readable',
      status: 'warn',
      detail: `cannot read channel.env for: ${unreadable.join(', ')} — port/token checks are partial`,
      fix: 'run the doctor as a user that can read the env files',
    })
  }

  // A readable env that lacks PORT or TOKEN makes the uniqueness checks below
  // silently skip that agent — surface it instead of reporting a hollow PASS.
  const missingKeys = agents
    .filter((a) => a.envReadable)
    .map((a) => {
      const miss = [a.port == null ? 'TELEGRAM_WEBHOOK_PORT' : null, a.tokenDigest == null ? 'TELEGRAM_BOT_TOKEN' : null].filter(Boolean)
      return miss.length > 0 ? `${a.name} (${miss.join(', ')})` : null
    })
    .filter((x): x is string => x != null)
  if (missingKeys.length > 0) {
    out.push({
      id: 'fleet-env-keys',
      title: 'Fleet env files carry PORT and TOKEN',
      status: 'warn',
      detail: `missing keys: ${missingKeys.join('; ')} — these agents are excluded from the uniqueness checks`,
      fix: 'set TELEGRAM_WEBHOOK_PORT and TELEGRAM_BOT_TOKEN in each channel.env',
    })
  }

  const dupBy = (label: string, key: (a: FleetAgent) => string | null): string[] => {
    const seen = new Map<string, string[]>()
    for (const a of agents) {
      const v = key(a)
      if (v == null) continue
      seen.set(v, [...(seen.get(v) ?? []), a.name])
    }
    return [...seen.values()].filter((group) => group.length > 1).map((group) => `${group.join(' & ')} share a ${label}`)
  }

  const portDupes = dupBy('webhook port', (a) => a.port)
  out.push(
    portDupes.length === 0
      ? { id: 'fleet-ports-unique', title: 'Webhook ports unique across agents', status: 'pass', detail: agents.map((a) => `${a.name}:${a.port ?? '?'}`).join(', ') }
      : { id: 'fleet-ports-unique', title: 'Webhook ports unique across agents', status: 'fail', detail: portDupes.join('; '), fix: 'give every agent its own TELEGRAM_WEBHOOK_PORT (invariant b)' },
  )

  const tokenDupes = dupBy('bot token', (a) => a.tokenDigest)
  out.push(
    tokenDupes.length === 0
      ? { id: 'fleet-tokens-unique', title: 'Bot tokens unique across agents', status: 'pass', detail: 'all token digests differ' }
      : { id: 'fleet-tokens-unique', title: 'Bot tokens unique across agents', status: 'fail', detail: tokenDupes.join('; '), fix: 'one token = one getUpdates consumer; a shared token means 409 Conflict (invariant c)' },
  )

  // Sockets: a unit whose Exec lines disagree is broken on its own; across
  // units, any duplicate socket (including two on the default '') races at boot.
  const inconsistent = agents.filter((a) => a.sockets.length > 1).map((a) => a.name)
  const socketOf = (a: FleetAgent): string | null => (a.sockets.length === 1 ? (a.sockets[0] ?? null) : null)
  const socketDupes = dupBy('tmux socket', (a) => socketOf(a) === '' ? '<default>' : socketOf(a))
  const onDefault = agents.filter((a) => socketOf(a) === '').map((a) => a.name)
  if (inconsistent.length > 0) {
    out.push({ id: 'fleet-sockets', title: 'Dedicated tmux socket per unit', status: 'fail', detail: `Exec lines disagree on -L inside: ${inconsistent.join(', ')}`, fix: 'use the same tmux -L <socket> in ExecStart, ExecStartPost AND ExecStop' })
  } else if (socketDupes.length > 0) {
    out.push({ id: 'fleet-sockets', title: 'Dedicated tmux socket per unit', status: 'fail', detail: socketDupes.join('; '), fix: 'two Type=forking units on one socket race at boot — give each unit tmux -L channel-<agent> (invariant d)' })
  } else if (onDefault.length === 1 && agents.length > 1) {
    out.push({ id: 'fleet-sockets', title: 'Dedicated tmux socket per unit', status: 'warn', detail: `${onDefault[0]} runs on the default socket (no -L)`, fix: 'works while unique, but a future unit without -L will race it — prefer a dedicated socket' })
  } else {
    out.push({ id: 'fleet-sockets', title: 'Dedicated tmux socket per unit', status: 'pass', detail: agents.map((a) => `${a.name}:${socketOf(a) === '' ? '<default>' : socketOf(a)}`).join(', ') })
  }

  const sharedDirty = sharedSettingsRaw != null && /dashi-channel-hook|post-hook\.ts|read-receipt-hook\.ts|fallback-reply-hook\.ts/.test(sharedSettingsRaw)
  out.push(
    sharedDirty
      ? { id: 'fleet-shared-settings', title: 'Shared ~/.claude/settings.json free of channel hooks', status: 'fail', detail: 'channel hooks found in the user-level settings — they fire in EVERY agent session and route through one agent\'s bot/port', fix: 'move channel hooks into each agent\'s <workspace>/.claude/settings.json (invariant a)' }
      : { id: 'fleet-shared-settings', title: 'Shared ~/.claude/settings.json free of channel hooks', status: 'pass', detail: 'no channel hook markers in the shared file' },
  )

  for (const [id, label, key, fix] of [
    ['fleet-state-dirs-unique', 'State dirs unique across agents', (a: FleetAgent) => a.stateDir, 'give every agent its own TELEGRAM_STATE_DIR'],
    ['fleet-workspaces-unique', 'Workspace roots unique across agents', (a: FleetAgent) => a.workspaceRoot, 'give every agent its own TELEGRAM_WORKSPACE_ROOT (identity isolation)'],
  ] as const) {
    const dupes = dupBy(label.toLowerCase(), key)
    out.push(
      dupes.length === 0
        ? { id, title: label, status: 'pass', detail: 'no collisions' }
        : { id, title: label, status: 'fail', detail: dupes.join('; '), fix },
    )
  }

  const webhookOff = agents.filter((a) => a.webhookEnabled !== true).map((a) => `${a.name} (${a.webhookEnabled === false ? 'enabled=false' : 'state config missing'})`)
  out.push(
    webhookOff.length === 0
      ? { id: 'fleet-webhook-enabled', title: 'webhook.enabled=true in every state config', status: 'pass', detail: 'all agents have a live webhook endpoint' }
      : { id: 'fleet-webhook-enabled', title: 'webhook.enabled=true in every state config', status: 'warn', detail: webhookOff.join('; '), fix: 'env only sets host/port — write {"webhook":{"enabled":true,...}} to <state-dir>/config.json (invariant e)' },
  )

  // ANY foreign port is a failure even when the own port is also present —
  // a stale last-install-wins hook next to a correct one still double-routes.
  const foreign = agents
    .filter((a) => a.port != null)
    .map((a) => ({ a, alien: a.hookPorts.filter((p) => p !== a.port) }))
    .filter(({ alien }) => alien.length > 0)
    .map(({ a, alien }) => `${a.name} hooks point at foreign port(s) ${alien.join(',')} (own webhook: ${a.port})`)
  // Hooks we could not inspect are an unverified state, not a pass.
  const unverified = agents
    .filter((a) => a.envReadable && a.settingsPath == null)
    .map((a) => a.name)
  if (foreign.length > 0) {
    out.push({ id: 'fleet-hook-ports', title: 'Each agent\'s hooks point at its own port', status: 'fail', detail: foreign.join('; '), fix: 're-run install-hooks.sh with --settings <that agent\'s settings.json> and the agent\'s own --webhook-url, and remove stale hook blocks' })
  } else if (unverified.length > 0) {
    out.push({ id: 'fleet-hook-ports', title: 'Each agent\'s hooks point at its own port', status: 'warn', detail: `workspace settings not found for: ${unverified.join(', ')} — hook routing unverified`, fix: 'expected at <TELEGRAM_WORKSPACE_ROOT>/settings.json or <root>/.claude/settings.json' })
  } else {
    out.push({ id: 'fleet-hook-ports', title: 'Each agent\'s hooks point at its own port', status: 'pass', detail: 'no foreign-port hooks' })
  }

  return out
}

/** Discover channel-*.service units and build FleetAgents. IO wrapper around the pure parsers. */
export function scanFleet(unitDir: string): FleetAgent[] {
  let entries: string[] = []
  try {
    entries = readdirSync(unitDir).filter((f) => /^channel-.+\.service$/.test(f))
  } catch {
    return []
  }
  const agents: FleetAgent[] = []
  for (const f of entries.sort()) {
    const unitPath = join(unitDir, f)
    const text = readFileSafe(unitPath)
    if (text == null) continue
    const name = f.replace(/^channel-/, '').replace(/\.service$/, '')
    const { envPath, sockets } = parseUnitFile(text)
    // Not every channel-*.service is a channel: helper units (webhook
    // listeners, sync timers) share the prefix but never run tmux. A channel
    // unit always supervises a tmux session — skip anything that doesn't.
    if (sockets.length === 0) continue
    const envText = envPath ? readFileSafe(envPath) : null
    const token = envText ? envValue(envText, 'TELEGRAM_BOT_TOKEN') : null
    const stateDir = envText ? envValue(envText, 'TELEGRAM_STATE_DIR') : null
    const workspaceRoot = envText ? envValue(envText, 'TELEGRAM_WORKSPACE_ROOT') : null
    let webhookEnabled: boolean | null = null
    if (stateDir) {
      const stateConfig = parseJsonSafe(readFileSafe(join(stateDir, 'config.json'))) as { webhook?: { enabled?: boolean } } | null
      webhookEnabled = stateConfig?.webhook?.enabled === true ? true : stateConfig ? false : null
    }
    // Workspace settings: both layouts exist in the wild — the workspace root
    // IS the .claude dir (settings.json directly inside), or the root contains
    // a .claude/ subdir.
    let hookPorts: string[] = []
    let settingsPath: string | null = null
    if (workspaceRoot) {
      for (const cand of [join(workspaceRoot, 'settings.json'), join(workspaceRoot, '.claude', 'settings.json')]) {
        const raw = readFileSafe(cand)
        if (raw != null) {
          hookPorts = hookPortsInSettings(raw)
          settingsPath = cand
          break
        }
      }
    }
    agents.push({
      name,
      unitPath,
      sockets,
      envPath,
      envReadable: envText != null,
      port: envText ? envValue(envText, 'TELEGRAM_WEBHOOK_PORT') : null,
      tokenDigest: token ? createHash('sha256').update(token).digest('hex') : null,
      stateDir,
      workspaceRoot,
      webhookEnabled,
      hookPorts,
      settingsPath,
    })
  }
  return agents
}

interface Options {
  json: boolean
  os: OS
  pluginDir: string
  settingsPath: string
  mcpPath?: string
  settingsLocalPath?: string
  envPath?: string
  userId?: string
  chatId?: string
  tmuxSession?: string
  queueJsonPath?: string
  fleet?: boolean
  fleetDir?: string
}

function parseArgs(argv: string[]): Options | { error: string } {
  const opts: Options = {
    json: false,
    os: detectOS(),
    pluginDir: process.cwd(),
    settingsPath: join(homedir(), '.claude', 'settings.json'),
  }
  let err = ''
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    // Consume the next token as a flag value. A following token that itself
    // looks like a flag means the value was omitted (e.g. `--user --json`).
    const next = (): string => {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) {
        err = `missing value for ${a}`
        return ''
      }
      i++
      return v
    }
    switch (a) {
      case '--json':
        opts.json = true
        break
      case '--plugin-dir':
        opts.pluginDir = next()
        break
      case '--settings':
        opts.settingsPath = next()
        break
      case '--mcp':
        opts.mcpPath = next()
        break
      case '--settings-local':
        opts.settingsLocalPath = next()
        break
      case '--env':
        opts.envPath = next()
        break
      case '--user':
        opts.userId = next()
        break
      case '--chat':
        opts.chatId = next()
        break
      case '--session':
        opts.tmuxSession = next()
        break
      case '--queue-json':
        opts.queueJsonPath = next()
        break
      case '--fleet':
        opts.fleet = true
        break
      case '--fleet-dir':
        opts.fleetDir = next()
        break
      case '--help':
      case '-h':
        return { error: 'help' }
      default:
        return { error: `unknown argument: ${a}` }
    }
    if (err) return { error: err }
  }
  return opts
}

const USAGE = `doctor-dashi-plugin — migrate from the legacy gateway to the channel plugin safely.

Usage:
  bun skills/doctor-dashi-plugin/scripts/doctor.ts [options]

Options:
  --plugin-dir <path>      plugin directory (default: cwd)
  --settings <path>        ~/.claude/settings.json to inspect
  --mcp <path>             project .mcp.json
  --settings-local <path>  project .claude/settings.local.json
  --env <path>             channel.env to inspect (allowlists)
  --user <id>              your numeric Telegram user id
  --chat <id>              a Telegram chat id to verify (group id is -100...)
  --session <name>         tmux channel session (e.g. channel-myagent)
  --queue-json <path>      a saved getUpdates JSON response to classify (409 / drain)
  --fleet                  multi-agent mode: discover channel-*.service units and
                           verify the five isolation invariants ACROSS agents
                           (README section 14)
  --fleet-dir <path>       where to look for unit files (default: /etc/systemd/system)
  --json                   machine-readable output
  -h, --help               this help

Read-only: never restarts a service, never writes config, never prints a secret.
Exit 0 = no FAIL, 1 = at least one FAIL, 2 = usage error.`

function gatherChecks(opts: Options): Check[] {
  const checks: Check[] = []

  // Pre-flight: toolchain
  const claude = probe('claude', ['--version'])
  checks.push(
    claude.code === 0 || claude.stdout
      ? checkVersion('claude-version', 'Claude Code >= 2.1', claude.stdout || claude.stderr, MIN_CLAUDE)
      : {
          id: 'claude-version',
          title: 'Claude Code >= 2.1',
          status: 'fail',
          detail: 'claude CLI not found on PATH',
          fix: 'install Claude Code and log in with Anthropic Max',
        },
  )
  const bun = probe(process.execPath.endsWith('bun') ? process.execPath : 'bun', ['--version'])
  checks.push(
    bun.stdout
      ? checkVersion('bun-version', 'Bun >= 1.3.9', bun.stdout, MIN_BUN)
      : { id: 'bun-version', title: 'Bun >= 1.3.9', status: 'fail', detail: 'bun not found', fix: 'install bun' },
  )
  const tmux = probe('tmux', ['-V'])
  checks.push(
    tmux.stdout
      ? { id: 'tmux', title: 'tmux installed (TTY supervisor)', status: 'pass', detail: tmux.stdout.trim() }
      : { id: 'tmux', title: 'tmux installed (TTY supervisor)', status: 'fail', detail: 'tmux not found', fix: 'install tmux — the channel runs claude inside a tmux session' },
  )

  // Workspace placement (identity)
  checks.push(checkWorkspacePlacement(opts.pluginDir))

  // Dev-copy vs runtime-copy divergence (lessons §1). The service runs the
  // RUNTIME copy; patching a different checkout silently does nothing. Read-only
  // probe: find the live server's CWD and compare to the inspected plugin dir.
  const live = probe('pgrep', ['-f', 'bun.*src/server.ts'])
  const pid = live.stdout.trim().split(/\s+/).filter(Boolean)[0]
  if (pid) {
    const cwd = liveCwd(pid, opts.os)
    if (cwd) {
      checks.push(
        sameTree(opts.pluginDir, cwd)
          ? { id: 'dev-vs-runtime', title: 'Inspected plugin matches the running copy', status: 'pass', detail: `runtime CWD ${cwd}` }
          : {
              id: 'dev-vs-runtime',
              title: 'Inspected plugin matches the running copy',
              status: 'warn',
              detail: `running copy CWD ${cwd} differs from --plugin-dir ${opts.pluginDir}`,
              fix: 'patch the RUNTIME copy (the one the service runs), not just the dev/git checkout',
            },
      )
    }
  }

  // settings.json hooks + token leak
  const settings = parseJsonSafe(readFileSafe(opts.settingsPath))
  if (settings == null) {
    checks.push({
      id: 'settings-readable',
      title: 'settings.json readable',
      status: 'warn',
      detail: `could not read/parse ${opts.settingsPath}`,
      fix: 'pass --settings <path> to the agent settings.json',
    })
  } else {
    checks.push(...checkSettingsHooks(settings))
    checks.push(...checkPermissionGate(settings))
  }

  // comms consistency (.mcp.json vs settings.local.json) — distinguish a missing
  // file from one present but unparseable (a malformed .mcp.json is itself a bug).
  if (opts.mcpPath || opts.settingsLocalPath) {
    const mcpRaw = readFileSafe(opts.mcpPath ?? '')
    const slRaw = readFileSafe(opts.settingsLocalPath ?? '')
    if (opts.mcpPath && mcpRaw !== null && parseJsonSafe(mcpRaw) === null) {
      checks.push({ id: 'comms-consistency', title: 'MCP comms servers enabled consistently', status: 'fail', detail: `${opts.mcpPath} is present but not valid JSON`, fix: 'fix the .mcp.json syntax' })
    } else {
      checks.push(checkCommsConsistency(parseJsonSafe(mcpRaw), parseJsonSafe(slRaw)))
    }
  }

  // allowlists (user AND chat)
  if (opts.envPath) {
    const env = readFileSafe(opts.envPath)
    if (env == null) {
      checks.push({ id: 'allowlist-user', title: 'Telegram user allowlist', status: 'warn', detail: `could not read ${opts.envPath}` })
    } else {
      checks.push(...checkAllowlist(env, opts.userId, opts.chatId))
    }
  }

  // Telegram queue (409 / drain) from a saved getUpdates response
  if (opts.queueJsonPath) {
    const raw = readFileSafe(opts.queueJsonPath)
    const parsed = parseJsonSafe(raw)
    if (parsed == null) {
      checks.push({ id: 'telegram-queue', title: 'Telegram getUpdates has a single consumer', status: 'warn', detail: `could not read/parse ${opts.queueJsonPath}` })
    } else {
      checks.push(classifyQueue(parsed))
    }
  }

  // Fleet (multi-agent) invariants — cross-agent collisions invisible to the
  // single-agent checks above. The shared-settings probe always reads the
  // USER-level file (the one that fires in every session), regardless of
  // where --settings points.
  if (opts.fleet) {
    const agents = scanFleet(opts.fleetDir ?? '/etc/systemd/system')
    checks.push(...checkFleet(agents, readFileSafe(join(homedir(), '.claude', 'settings.json'))))
  }

  // live session state (crash loop / auth / welcome hang / listening)
  if (opts.tmuxSession) {
    const cap = probe('tmux', ['capture-pane', '-t', opts.tmuxSession, '-p', '-S', '-200'])
    const text = `${cap.stdout}\n${cap.stderr}`
    if (cap.code !== 0 || detectCrashLoop(text)) {
      checks.push({ id: 'live-session', title: `Channel session ${opts.tmuxSession} alive`, status: 'fail', detail: detectCrashLoop(text) ? 'tmux server gone — crash loop (claude exits, supervisor relaunches)' : 'tmux session not found', fix: 'stop the service, run claude by hand with a TTY to read the real error, fix it, then start' })
    } else if (detectAuthExpired(cap.stdout)) {
      checks.push({ id: 'auth', title: 'Claude Code authenticated', status: 'fail', detail: 'session shows a /login or 401 prompt', fix: 'attach the tmux session and run /login under Anthropic Max' })
    } else if (detectWelcomeHang(cap.stdout)) {
      checks.push({ id: 'welcome-hang', title: 'Channel past the welcome prompts', status: 'fail', detail: 'a welcome prompt is on screen — the channel has not started', fix: 'attach the tmux session and press Enter through the welcome prompts' })
    } else if (detectListening(cap.stdout)) {
      checks.push({ id: 'live-session', title: `Channel session ${opts.tmuxSession} listening`, status: 'pass', detail: 'live marker present' })
    } else {
      checks.push({ id: 'live-session', title: `Channel session ${opts.tmuxSession} listening`, status: 'warn', detail: 'no welcome prompt and no live marker in view — the marker may have scrolled out', fix: 'send the bot a test message; expect the reaction flow 👀 → ⚙️ → ✅' })
    }
  }

  return checks
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2))
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      process.stdout.write(USAGE + '\n')
      process.exit(0)
    }
    process.stderr.write(`${parsed.error}\n\n${USAGE}\n`)
    process.exit(2)
  }
  const checks = gatherChecks(parsed)
  // Redact at the single output boundary so BOTH the text and JSON paths are safe.
  const safe = checks.map(redactCheck)
  if (parsed.json) {
    process.stdout.write(JSON.stringify({ os: parsed.os, summary: worstStatus(safe), checks: safe }, null, 2) + '\n')
  } else {
    process.stdout.write(renderReport(safe) + '\n')
  }
  process.exit(checks.some((c) => c.status === 'fail') ? 1 : 0)
}

if (import.meta.main) main()
