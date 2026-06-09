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
import { dirname, resolve as pathResolve } from 'path'
import { fileURLToPath } from 'url'

const MARKER = 'dashi-channel-hook'
// Permission-gate PreToolUse hook (2026-06-09). Distinct marker so it
// installs/updates alongside the notification-mirror hook without either
// clobbering the other. Only added when --permission-gate-helper is given.
const GATE_MARKER = 'dashi-permission-gate-hook'
// Substring of the dashi helper script path used to identify *markerless*
// legacy entries — re-running install over a settings file that was
// hand-edited (no marker but pointing at our post-hook.ts) used to leave
// the legacy entry in place + append the marked one, firing the hook
// twice (review §6).
const HELPER_PATH_FINGERPRINT = 'post-hook.ts'
const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
] as const

type HookEvent = (typeof HOOK_EVENTS)[number]

const MATCHER_BY_EVENT: Partial<Record<HookEvent, string>> = {
  PreToolUse: '.*',
  PostToolUse: '.*',
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
    const next = buildEntryFor(event, opts)
    const existing = hooks[event] ?? []
    // Drop anything that's clearly ours: notification marker, legacy
    // markerless notification entry, OR the gate marker (re-added below for
    // PreToolUse). Unrelated entries survive untouched.
    const filtered = existing.filter(
      (e) => !e || (e.marker !== MARKER && e.marker !== GATE_MARKER && !isLegacyDashiEntry(e)),
    )
    const rebuilt = [...filtered, next]
    // The gate hook lives on PreToolUse only, and is registered FIRST so its
    // deny verdict is evaluated before the notification mirror runs.
    if (event === 'PreToolUse' && withGate) {
      rebuilt.unshift(buildGateEntry(opts))
    }
    hooks[event] = rebuilt
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
  }
  if (!settingsPath || !chatId || !webhookUrl) {
    process.stderr.write(
      'Usage: patch-claude-settings.ts --settings PATH --chat-id ID --webhook-url URL [--agent-id ID] [--helper PATH]\n',
    )
    process.exit(2)
  }
  if (!helperPath) {
    // Default to sibling post-hook.ts. `import.meta.dir` is a Bun extension;
    // resolve via `fileURLToPath(import.meta.url)` so the script also works
    // when invoked under plain Node (review M5).
    const scriptDir = dirname(fileURLToPath(import.meta.url))
    helperPath = pathResolve(scriptDir, 'post-hook.ts')
  }
  const opts: PatchOptions = {
    settingsPath,
    chatId,
    webhookUrl,
    helperPath,
    ...(agentId ? { agentId } : {}),
    ...(permissionGateHelperPath ? { permissionGateHelperPath } : {}),
    ...(policyPath ? { policyPath } : {}),
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

export function patchSettingsFile(opts: PatchOptions): void {
  const settings = readSettings(opts.settingsPath)
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
