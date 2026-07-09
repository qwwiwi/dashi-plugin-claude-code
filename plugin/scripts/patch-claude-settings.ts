#!/usr/bin/env bun
// Idempotently patch a Claude Code per-agent settings.json with the five
// hook entries that route to plugin/scripts/post-hook.ts.
//
// Hard invariants:
//   * Never write the bearer token. The hook command pulls
//     TELEGRAM_WEBHOOK_TOKEN from the agent's process env at runtime.
//   * Preserve unrelated keys and existing hook entries.
//   * Stable marker — `hooks[event][].marker = "dashi-channel-hook"` — lets
//     re-runs replace the previous entry instead of duplicating.
//   * Atomic write through a temp file in the same dir so a partial write
//     cannot corrupt settings.json.
//
// CLI:
//   bun scripts/patch-claude-settings.ts \
//     --settings /path/to/settings.json \
//     --chat-id 164795011 \
//     --webhook-url http://127.0.0.1:8089/hooks/agent \
//     [--agent-id dashi-channel] \
//     [--helper /abs/path/to/post-hook.ts]

import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve as pathResolve } from 'path'
import { fileURLToPath } from 'url'

const MARKER = 'dashi-channel-hook'
// Permission-gate PreToolUse hook (2026-06-09). Distinct marker so it
// installs/updates alongside the notification-mirror hook without either
// clobbering the other. Only added when --permission-gate-helper is given.
const GATE_MARKER = 'dashi-permission-gate-hook'
// Channel-reminder UserPromptSubmit hook (2026-06-12). Distinct marker so it
// installs/updates alongside the notification-mirror hook. Re-injects the
// Telegram-bridge reply discipline on every turn (the MCP server states it
// only once at session start; agents forget over a long session). On-by-
// default: parseArgs defaults --reminder-helper to the sibling script, so a
// plain install wires it without an opt-in flag.
const REMINDER_MARKER = 'dashi-channel-reminder-hook'
// Substring of the dashi helper script path used to identify *markerless*
// legacy entries — re-running install over a settings file that was
// hand-edited (no marker but pointing at our post-hook.ts) used to leave
// the legacy entry in place + append the marked one, firing the hook
// twice (review §6).
const HELPER_PATH_FINGERPRINT = 'post-hook.ts'

// All hook events we TOUCH — we filter our own (marker / legacy / gate) entries
// out of each and rebuild. PreToolUse is iterated so the permission-gate hook
// still installs there, even though it no longer carries a notification feeder.
const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'SessionEnd',
  'Stop',
] as const

type HookEvent = (typeof HOOK_EVENTS)[number]

// NARROW canonical notification-feeder set (2026-07-09). The feeder spawns a
// `bun` process + HTTP POST for every event it fires on; a `.*` PreToolUse /
// PostToolUse feeder therefore paid that cost on EVERY tool call — far too much
// on a 7.8 GB VPS, and the status/progress surfaces that once consumed the
// per-tool stream are disabled. The surfaces still in use (pinned context HUD +
// task mirror) need only: session lifecycle (SessionStart / SessionEnd),
// per-turn context refresh (UserPromptSubmit / Stop), and the task tools
// (PostToolUse scoped to TaskCreate|TaskUpdate|TodoWrite).
const FEEDER_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'SessionEnd',
  'Stop',
])

// Claude Code hook matchers accept `|`-separated EXACT tool names. Scoping the
// PostToolUse feeder to the three task tools is what keeps the feeder off the
// hot path (Bash/Read/Edit/… no longer fire it).
const MATCHER_BY_EVENT: Partial<Record<HookEvent, string>> = {
  PostToolUse: 'TaskCreate|TaskUpdate|TodoWrite',
}

export interface PatchOptions {
  readonly settingsPath: string
  readonly chatId: string
  readonly webhookUrl: string
  readonly agentId?: string
  readonly helperPath: string
  /** When set, also register the permission-gate PreToolUse hook pointing at
   *  this helper (scripts/permission-gate-hook.ts). */
  readonly permissionGateHelperPath?: string
  /** Optional explicit policy path for the gate hook (TELEGRAM_PERMISSION_POLICY_PATH). */
  readonly policyPath?: string
  /** When set, register the channel-reminder UserPromptSubmit hook pointing at
   *  this helper (scripts/channel-reminder.ts). Defaulted by the CLI. */
  readonly reminderHelperPath?: string
}

interface HookEntry {
  marker?: string
  matcher?: string
  hooks: Array<{ type: 'command'; command: string }>
  [k: string]: unknown
}

interface SettingsShape {
  hooks?: Partial<Record<HookEvent, HookEntry[] | undefined>>
  [k: string]: unknown
}

function buildCommand(opts: PatchOptions): string {
  // Single-quote env exports — the host shell (zsh/bash) keeps them literal
  // so a token-shaped chat id can't trigger expansion.
  const envParts: string[] = [
    `TELEGRAM_HOOK_CHAT_ID='${opts.chatId.replace(/'/g, "'\\''")}'`,
  ]
  if (opts.agentId) {
    envParts.push(
      `TELEGRAM_HOOK_AGENT_ID='${opts.agentId.replace(/'/g, "'\\''")}'`,
    )
  }
  envParts.push(
    `TELEGRAM_WEBHOOK_URL='${opts.webhookUrl.replace(/'/g, "'\\''")}'`,
  )
  return `${envParts.join(' ')} bun '${opts.helperPath.replace(/'/g, "'\\''")}'`
}

function buildEntryFor(event: HookEvent, opts: PatchOptions): HookEntry {
  const entry: HookEntry = {
    marker: MARKER,
    hooks: [{ type: 'command', command: buildCommand(opts) }],
  }
  const matcher = MATCHER_BY_EVENT[event]
  if (matcher !== undefined) entry.matcher = matcher
  return entry
}

function sq(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`
}

// Origin (scheme://host:port) of the webhook URL — the gate hook appends its
// own /hooks/permission/request path, so we hand it the bare origin.
function webhookOrigin(webhookUrl: string): string {
  try {
    const u = new URL(webhookUrl)
    return `${u.protocol}//${u.host}`
  } catch {
    return webhookUrl
  }
}

// PreToolUse command for the permission-gate hook. The bearer token is NOT
// written here — the gate hook reads TELEGRAM_WEBHOOK_TOKEN from the agent's
// runtime env, same invariant as the notification hook.
function buildGateCommand(opts: PatchOptions): string {
  const helper = opts.permissionGateHelperPath!
  const envParts: string[] = [
    `CHAT_ID=${sq(opts.chatId)}`,
    `TELEGRAM_WEBHOOK_URL=${sq(webhookOrigin(opts.webhookUrl))}`,
  ]
  if (opts.policyPath) envParts.push(`TELEGRAM_PERMISSION_POLICY_PATH=${sq(opts.policyPath)}`)
  return `${envParts.join(' ')} bun ${sq(helper)}`
}

function buildGateEntry(opts: PatchOptions): HookEntry {
  return {
    marker: GATE_MARKER,
    matcher: '.*',
    hooks: [{ type: 'command', command: buildGateCommand(opts) }],
  }
}

// UserPromptSubmit command for the channel-reminder hook. The hook reads
// CHAT_ID from env to pick the DM vs group reminder. No token, no webhook —
// it emits additionalContext to stdout and never makes a network call.
function buildReminderCommand(opts: PatchOptions): string {
  return `CHAT_ID=${sq(opts.chatId)} bun ${sq(opts.reminderHelperPath!)}`
}

function buildReminderEntry(opts: PatchOptions): HookEntry {
  return {
    marker: REMINDER_MARKER,
    hooks: [{ type: 'command', command: buildReminderCommand(opts) }],
  }
}

// True if an entry's command string points at our helper script, even if
// the marker was hand-stripped or never present. Survives different
// absolute prefixes (e.g. user moved the plugin between dirs) by matching
// the trailing `post-hook.ts` filename inside the command string.
function isLegacyDashiEntry(entry: HookEntry | undefined): boolean {
  if (!entry || !Array.isArray(entry.hooks)) return false
  for (const h of entry.hooks) {
    if (h && typeof h.command === 'string' && h.command.includes(HELPER_PATH_FINGERPRINT)) {
      return true
    }
  }
  return false
}

/** Pure patcher — exposed for unit tests. */
export function applyPatch(settings: SettingsShape, opts: PatchOptions): SettingsShape {
  const hooks: NonNullable<SettingsShape['hooks']> = { ...(settings.hooks ?? {}) }
  const withGate = opts.permissionGateHelperPath !== undefined
  for (const event of HOOK_EVENTS) {
    const existing = hooks[event] ?? []
    // Drop anything that's clearly ours: notification marker, legacy
    // markerless notification entry, OR the gate marker (re-added below for
    // PreToolUse). Unrelated entries survive untouched. This also STRIPS a
    // previously-installed `.*` PreToolUse/PostToolUse feeder (same MARKER), so
    // re-running the patch migrates an old wide install to the narrow set.
    const filtered = existing.filter(
      (e) =>
        !e ||
        (e.marker !== MARKER &&
          e.marker !== GATE_MARKER &&
          e.marker !== REMINDER_MARKER &&
          !isLegacyDashiEntry(e)),
    )
    const rebuilt = [...filtered]
    // The notification feeder is added ONLY for the narrow FEEDER_EVENTS set.
    // PreToolUse is iterated (for the gate below) but no longer gets a feeder.
    if (FEEDER_EVENTS.has(event)) {
      rebuilt.push(buildEntryFor(event, opts))
    }
    // The gate hook lives on PreToolUse only, and is registered FIRST so its
    // deny verdict is evaluated before any later hook runs.
    if (event === 'PreToolUse' && withGate) {
      rebuilt.unshift(buildGateEntry(opts))
    }
    // The channel-reminder hook lives on UserPromptSubmit only. Appended after
    // the mirror entry — both run; the mirror emits no stdout, the reminder
    // emits additionalContext, so order is immaterial.
    if (event === 'UserPromptSubmit' && opts.reminderHelperPath !== undefined) {
      rebuilt.push(buildReminderEntry(opts))
    }
    // Don't leave an empty array behind (e.g. PreToolUse with no gate): drop
    // the key so the patched settings stay clean.
    if (rebuilt.length > 0) {
      hooks[event] = rebuilt
    } else {
      delete hooks[event]
    }
  }
  return { ...settings, hooks }
}

function parseArgs(argv: ReadonlyArray<string>): PatchOptions {
  let settingsPath = ''
  let chatId = ''
  let webhookUrl = ''
  let agentId: string | undefined
  let helperPath = ''
  let permissionGateHelperPath: string | undefined
  let policyPath: string | undefined
  let reminderHelperPath: string | undefined
  let noReminder = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === '--settings' && next) { settingsPath = next; i++; continue }
    if (a === '--chat-id' && next) { chatId = next; i++; continue }
    if (a === '--webhook-url' && next) { webhookUrl = next; i++; continue }
    if (a === '--agent-id' && next) { agentId = next; i++; continue }
    if (a === '--helper' && next) { helperPath = next; i++; continue }
    if (a === '--permission-gate-helper' && next) { permissionGateHelperPath = next; i++; continue }
    if (a === '--policy-path' && next) { policyPath = next; i++; continue }
    if (a === '--reminder-helper' && next) { reminderHelperPath = next; i++; continue }
    if (a === '--no-reminder') { noReminder = true; continue }
  }
  if (!settingsPath || !chatId || !webhookUrl) {
    process.stderr.write(
      'Usage: patch-claude-settings.ts --settings PATH --chat-id ID --webhook-url URL [--agent-id ID] [--helper PATH]\n',
    )
    process.exit(2)
  }
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  if (!helperPath) {
    // Default to sibling post-hook.ts. `import.meta.dir` is a Bun extension;
    // resolve via `fileURLToPath(import.meta.url)` so the script also works
    // when invoked under plain Node (review M5).
    helperPath = pathResolve(scriptDir, 'post-hook.ts')
  }
  // Channel reminder is on by default (sibling channel-reminder.ts) unless
  // explicitly disabled with --no-reminder. This keeps the durable invariant
  // in plugin/CLAUDE.md ("a hook re-states this every turn") true on every
  // agent without a manual settings.json edit.
  if (!noReminder && !reminderHelperPath) {
    reminderHelperPath = pathResolve(scriptDir, 'channel-reminder.ts')
  }
  const opts: PatchOptions = {
    settingsPath,
    chatId,
    webhookUrl,
    helperPath,
    ...(agentId ? { agentId } : {}),
    ...(permissionGateHelperPath ? { permissionGateHelperPath } : {}),
    ...(policyPath ? { policyPath } : {}),
    ...(reminderHelperPath ? { reminderHelperPath } : {}),
  }
  return opts
}

function readSettings(path: string): SettingsShape {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8')
  if (raw.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('settings.json must be a JSON object')
    }
    return parsed as SettingsShape
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`failed to parse ${path}: ${msg}`)
  }
}

function writeAtomic(path: string, contents: string): void {
  // Stage the temp file in the SAME directory as the target so the final
  // rename is guaranteed same-filesystem and therefore atomic. Using
  // os.tmpdir() failed on Linux setups where /tmp is a separate fs
  // (tmpfs / different mount) — renameSync surfaced as EXDEV (review §5).
  const dir = dirname(path)
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  void dir
  writeFileSync(tmp, contents, { mode: 0o600 })
  try {
    renameSync(tmp, path)
  } catch (err) {
    // Best-effort cleanup of the staged file so a failed rename doesn't
    // leave a `*.tmp.<pid>.<ts>` orphan next to settings.json.
    try { unlinkSync(tmp) } catch { /* ignore */ }
    throw err
  }
}

// ─── wide-feeder narrowing warning (review 2026-07-09 SHOULD-fix) ──────
// Re-running the patch over an OLD wide install (a `.*` PreToolUse/PostToolUse
// dashi feeder) silently narrows the feeder set. That is correct for the
// current surfaces, but a fleet install whose plugin config still enables the
// per-tool consumers (status / progress reporters) would silently lose their
// event stream. Detect the narrowing + the enabled consumers and WARN loudly.

/** True when the pre-patch settings carry one of OUR feeders on a wide surface. */
export function hasWideDashiFeeder(settings: SettingsShape): boolean {
  const hooks = settings.hooks ?? {}
  const isOurs = (e: HookEntry | undefined): boolean =>
    e !== undefined && (e.marker === MARKER || isLegacyDashiEntry(e))
  for (const e of hooks.PreToolUse ?? []) {
    if (isOurs(e)) return true // PreToolUse feeder no longer installed at all
  }
  for (const e of hooks.PostToolUse ?? []) {
    if (isOurs(e) && (e.matcher === undefined || e.matcher === '.*' || e.matcher === '')) {
      return true // unscoped PostToolUse feeder — fired on every tool
    }
  }
  return false
}

// Best-effort read of the PLUGIN config (not the Claude settings being
// patched) to see whether the per-tool consumers are enabled. Mirrors the
// loadConfig path resolution: TELEGRAM_CONFIG_FILE, else
// <TELEGRAM_STATE_DIR|~/.claude/channels/dashi-telegram-canary>/config.json.
// Both status.enabled and progress.enabled default to FALSE in the schema, so
// only an explicit `true` in config.json counts.
function pluginConsumersEnabled(env: NodeJS.ProcessEnv): boolean {
  try {
    const stateRoot =
      env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'dashi-telegram-canary')
    const configPath = env.TELEGRAM_CONFIG_FILE ?? join(stateRoot, 'config.json')
    if (!existsSync(configPath)) return false
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
      status?: { enabled?: unknown }
      progress?: { enabled?: unknown }
    }
    return parsed.status?.enabled === true || parsed.progress?.enabled === true
  } catch {
    return false
  }
}

function warnIfNarrowing(settings: SettingsShape, env: NodeJS.ProcessEnv): void {
  if (!hasWideDashiFeeder(settings)) return
  if (!pluginConsumersEnabled(env)) return
  process.stderr.write(
    'WARNING: narrowing the dashi-channel hook feeders (dropping the wide ' +
      'PreToolUse/PostToolUse `.*` feeder) while the plugin config has ' +
      'status.enabled/progress.enabled=true — those surfaces consume the ' +
      'per-tool event stream and will stop updating per tool call. Disable ' +
      'them in config.json or keep a wide feeder manually.\n',
  )
}

export function patchSettingsFile(opts: PatchOptions): void {
  const settings = readSettings(opts.settingsPath)
  warnIfNarrowing(settings, process.env)
  const patched = applyPatch(settings, opts)
  const out = `${JSON.stringify(patched, null, 2)}\n`
  if (out.includes('TELEGRAM_WEBHOOK_TOKEN=')) {
    // Defence: nothing in our patch path writes the bearer token; if a
    // future change attempts to, fail loud.
    throw new Error('refusing to write TELEGRAM_WEBHOOK_TOKEN to settings.json')
  }
  writeAtomic(opts.settingsPath, out)
}

const isMainModule = (() => {
  const arg = process.argv[1] ?? ''
  return arg.endsWith('patch-claude-settings.ts') || arg.endsWith('patch-claude-settings.js')
})()

if (isMainModule) {
  const opts = parseArgs(process.argv.slice(2))
  patchSettingsFile(opts)
}
