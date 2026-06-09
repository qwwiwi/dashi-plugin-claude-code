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
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
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
// AskUserQuestion relay hook — pairs with the gate so questions reach Telegram.
export const ASK_MARKER = 'dashi-ask-user-question-hook'
export const LIVE_MARKER = 'Listening for channel messages from: server:dashi-channel'

/**
 * Hook profile (2026-06-09). The 5-event feeder set is only REQUIRED when a
 * hook-driven progress surface (status / progress reporter) is enabled in the
 * state config. The modern minimal profile is "mirror": the tmux terminal
 * mirror carries progress, and only the Stop delivery hook (plus the optional
 * permission gate pair) is needed. Demanding all 5 events on a mirror-profile
 * host produced 3 false WARNs on every correctly configured agent.
 */
export type HookProfile = 'hook-feeders' | 'mirror' | 'none' | 'unknown'

/** Feeder events — required only in the hook-feeders profile. */
export const FEEDER_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'] as const

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
    // doesn't false-positive on the loopback webhook URL. 0.0.0.0 and
    // 127.0.0.0/8 are exempt — they identify interfaces, not servers, and
    // masking them strips the actionable part of the webhook-bind FAIL.
    .replace(/\b(?!0\.0\.0\.0\b)(?!127\.)(\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
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
  // A relative pluginDir (e.g. `--plugin-dir plugin`) must not break the
  // upward walk: dirname('plugin') is '.', dirname('.') is '.', and the
  // parent===dir guard exits after two levels — reporting a false FAIL
  // even though <workspace>/.claude/CLAUDE.md exists (fleet doctor sweep,
  // 2026-06-09). Resolve against cwd first so the walk sees real ancestors.
  let dir = resolve(pluginDir)
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
 * Map the channel state config to the hook profile in force.
 *   - status/progress reporter enabled → 'hook-feeders' (all 5 events needed);
 *   - tmux_mirror enabled (and no hook reporter) → 'mirror' (Stop only);
 *   - config present, nothing enabled → 'none' (Stop only — final replies still ship);
 *   - config missing/unreadable → 'unknown' (conservative: demand all 5).
 */
export function selectHookProfile(stateConfig: unknown): HookProfile {
  if (stateConfig === null || typeof stateConfig !== 'object') return 'unknown'
  const cfg = stateConfig as Record<string, { enabled?: boolean } | undefined>
  if (cfg['status']?.enabled === true || cfg['progress']?.enabled === true) return 'hook-feeders'
  if (cfg['tmux_mirror']?.enabled === true) return 'mirror'
  return 'none'
}

/**
 * Verify the channel hook events required by the active profile are registered
 * with a runnable command, and that no secret ever leaked into settings.json
 * (the patcher refuses to write the webhook token; anything secret-shaped here
 * is about to be committed).
 */
export function checkSettingsHooks(settings: unknown, profile: HookProfile = 'unknown'): Check[] {
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
  const stopEntries = Array.isArray(hooks['Stop']) ? hooks['Stop'] : []
  const feederRequired = profile === 'hook-feeders' || profile === 'unknown'

  if (feederRequired) {
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
              detail: markerOnly ? `${ev} has a ${HOOK_MARKER} entry but no runnable command` : `no ${HOOK_MARKER} entry for ${ev}${profile === 'unknown' ? ' (profile unknown — pass --env so the doctor can read the state config)' : ''}`,
              fix: 'run plugin/scripts/install-hooks.sh to register status + memory hooks',
            },
      )
    }
  } else {
    // mirror / none profile: feeder hooks are NOT required — the tmux mirror
    // (or nothing) carries progress. Only the Stop delivery hook matters.
    // The fallback hook is a separate safety net and must NOT mask a missing
    // primary Stop hook (it has its own check below).
    const stopWorking = hasWorkingHook(stopEntries, HOOK_MARKER)
    const fallbackOnly = !stopWorking && hasWorkingHook(stopEntries, FALLBACK_MARKER)
    out.push({
      id: 'hook-profile',
      title: `Hook profile: ${profile} (feeder hooks not required)`,
      status: 'pass',
      detail: `state config enables no hook-driven progress surface — SessionStart/UserPromptSubmit/PostToolUse feeders are optional`,
    })
    out.push(
      stopWorking
        ? { id: 'hook-Stop', title: 'Hook registered: Stop (final-reply delivery)', status: 'pass', detail: 'a runnable Stop hook is registered' }
        : {
            id: 'hook-Stop',
            title: 'Hook registered: Stop (final-reply delivery)',
            status: 'warn',
            detail: fallbackOnly ? 'only the fallback-reply Stop hook is registered — the primary Stop delivery (read receipt) hook is missing' : 'no Stop hook — read receipts and the silent-turn fallback never fire',
            fix: 'run plugin/scripts/install-hooks.sh to register the Stop hook',
          },
    )
  }

  // DM fallback-reply (PR #47) — optional but recommended: guarantees the chief
  // gets an answer even when the agent forgets to call the reply tool.
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
export function checkPermissionGate(
  settings: unknown,
  fileExists: (p: string) => boolean = existsSync,
  /** True when the supervising unit's ExecStart carries --permission-mode bypassPermissions. */
  unitBypass: boolean | null = null,
): Check[] {
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
  if (mode === 'bypassPermissions') {
    out.push({ id: 'permission-gate-mode', title: 'Permission gate: session in bypassPermissions', status: 'pass', detail: 'permissions.defaultMode=bypassPermissions' })
  } else if (mode === undefined && unitBypass === true) {
    // The flag usually rides on the unit's ExecStart, not in settings — when
    // the supervising unit carries it, an unset defaultMode is the normal
    // layout, not a gap.
    out.push({ id: 'permission-gate-mode', title: 'Permission gate: session in bypassPermissions', status: 'pass', detail: '--permission-mode bypassPermissions on the unit ExecStart' })
  } else {
    out.push({
      id: 'permission-gate-mode',
      title: 'Permission gate: session in bypassPermissions',
      status: 'warn',
      detail: mode ? `permissions.defaultMode=${mode} (not bypassPermissions)` : 'permissions.defaultMode unset in settings — verify the session runs with --permission-mode bypassPermissions',
      fix: 'the gate only suppresses native prompts under bypassPermissions; otherwise interactive prompts still wedge the headless session',
    })
  }

  // AskUserQuestion relay must ride along with the gate: under
  // bypassPermissions a bare AskUserQuestion renders in a pane nobody watches,
  // so without the relay the session silently hangs on the first question.
  const ask = pre.find((e) => e.marker === ASK_MARKER)
  const askWorking = ask !== undefined && entryCommands(ask).some((c) => c.includes('ask-user-question-hook.ts'))
  out.push(
    askWorking
      ? { id: 'permission-gate-ask-hook', title: 'AskUserQuestion relay next to the gate', status: 'pass', detail: `${ASK_MARKER} registered on PreToolUse` }
      : {
          id: 'permission-gate-ask-hook',
          title: 'AskUserQuestion relay next to the gate',
          status: 'warn',
          detail: 'gate is on but no ask-user-question relay — a question in the pane wedges the session',
          fix: 'register the ask-user-question PreToolUse hook alongside the gate',
        },
  )

  // The policy file the gate command points at must exist. A missing file is
  // not fatal at runtime (the hook falls back to confirm-everything) but it
  // means the operator's policy — including confirm_overrides — is silently
  // not in force.
  const policyPath = extractEnvAssignment(cmds.join('\n'), 'TELEGRAM_PERMISSION_POLICY_PATH')
  if (policyPath) {
    out.push(
      fileExists(policyPath)
        ? { id: 'gate-policy-path', title: 'Permission gate: policy file exists', status: 'pass', detail: `policy at ${policyPath}` }
        : {
            id: 'gate-policy-path',
            title: 'Permission gate: policy file exists',
            status: 'warn',
            detail: `gate command points at ${policyPath} but the file does not exist — fallback confirm-everything policy is in force`,
            fix: 'create the policy file or fix TELEGRAM_PERMISSION_POLICY_PATH in the gate hook command',
          },
    )
  }
  return out
}

/**
 * Extract a KEY='value' / KEY="value" / KEY=value assignment from a shell
 * command string (the install scripts prefix hook commands with env vars).
 */
export function extractEnvAssignment(command: string, key: string): string | null {
  const m = command.match(new RegExp(`${key}=('([^']*)'|"([^"]*)"|(\\S+))`))
  if (!m) return null
  return m[2] ?? m[3] ?? m[4] ?? null
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
 * Exactly one progress surface should be enabled in the channel state config.
 * 2026-06-09 (Mac mini migration): StatusManager + ProgressReporter both
 * defaulted ON, so a fresh install with hooks rendered two hook-driven
 * «working/running» Telegram windows next to the tmux mirror — the owner saw
 * duplicate windows. Defaults are all-off now; this check catches explicit
 * double-enables so the bug cannot quietly return.
 *
 * Scope: validates <TELEGRAM_STATE_DIR>/config.json ONLY. That is the single
 * layer able to enable these surfaces — the env schema has no
 * status/progress enable switches (TELEGRAM_WEBHOOK_* set host/port only),
 * and since 2026-06-09 the schema defaults are all-off.
 */
export function checkProgressSurfaces(stateConfig: unknown): Check {
  const id = 'progress-surfaces'
  const title = 'Single progress surface (status / progress / tmux_mirror)'
  if (stateConfig === null || typeof stateConfig !== 'object') {
    return { id, title, status: 'warn', detail: 'state config.json missing or not an object — cannot verify progress surfaces', fix: 'create <TELEGRAM_STATE_DIR>/config.json or check its JSON syntax' }
  }
  const cfg = stateConfig as Record<string, { enabled?: boolean } | undefined>
  const enabled: string[] = []
  for (const key of ['status', 'progress', 'tmux_mirror'] as const) {
    if (cfg[key]?.enabled === true) enabled.push(key)
  }
  if (enabled.length > 1) {
    return { id, title, status: 'warn', detail: `${enabled.length} surfaces enabled together (${enabled.join(' + ')}) — the owner gets duplicate Telegram windows`, fix: 'keep exactly one: tmux_mirror for a terminal view, or one hook-driven reporter. Disable the rest in the state config.json' }
  }
  const detail = enabled.length === 1 ? `exactly one surface enabled (${enabled[0]})` : 'no surface explicitly enabled (defaults are all-off)'
  return { id, title, status: 'pass', detail }
}

/**
 * Pick the settings.json the doctor should inspect. Claude Code loads project
 * hooks ONLY from the session cwd's .claude/ — for a channel session that is
 * <plugin-dir>/.claude/settings.json. Defaulting to ~/.claude/settings.json
 * produced 5 false hook WARNs + a false gate SKIP on every correct setup.
 */
export function resolveSettingsPath(
  pluginDir: string,
  homeSettingsPath: string,
  fileExists: (p: string) => boolean = existsSync,
): { path: string; source: 'plugin-dir' | 'home' } {
  const pluginSettings = join(resolve(pluginDir), '.claude', 'settings.json')
  if (fileExists(pluginSettings)) return { path: pluginSettings, source: 'plugin-dir' }
  return { path: homeSettingsPath, source: 'home' }
}

export interface RuntimeCandidate {
  pid: string
  cwd: string
}

/**
 * Multi-agent aware dev-vs-runtime match: on a fleet host several plugin
 * servers run at once, and "the first pgrep PID" is usually ANOTHER agent's
 * server — comparing its CWD to our plugin dir produced a false WARN. Match
 * by CWD across all candidates instead.
 */
export function findMatchingRuntime(
  candidates: RuntimeCandidate[],
  pluginDir: string,
): { match: RuntimeCandidate | null; others: number } {
  const dir = resolve(pluginDir)
  const match = candidates.find((c) => c.cwd !== '' && sameTree(dir, c.cwd)) ?? null
  return { match, others: candidates.length - (match ? 1 : 0) }
}

export interface Listener {
  addr: string
  port: string
}

/**
 * Parse `ss -ltn` / `lsof -nP -iTCP -sTCP:LISTEN` output into address:port
 * pairs. Tolerates IPv4, bracketed IPv6, `*` wildcards and surrounding noise.
 */
export function parseListeners(text: string): Listener[] {
  const out: Listener[] = []
  for (const m of text.matchAll(/(?:^|\s)((?:\d{1,3}\.){3}\d{1,3}|\[[^\]\s]*\]|\*):(\d+)(?:\s|$)/gm)) {
    const addr = m[1]
    const port = m[2]
    if (addr !== undefined && port !== undefined) out.push({ addr, port })
  }
  return out
}

// 127.0.0.0/8, [::1], and the v4-mapped loopback form ([::ffff:127.0.0.1])
// that ss/lsof emit for dual-stack sockets — a false security FAIL on a
// legitimate loopback bind trains operators to ignore the check.
const LOOPBACK_ADDR_RE = /^(127\.|\[::1\]$|\[::ffff:127\.)/

/**
 * The plugin's hook webhook must listen on loopback ONLY. A 0.0.0.0 / public
 * bind exposes the hook surface (and historically a webhook→sudo→root chain)
 * to the network. FAIL is deliberate — this is a security boundary, not a
 * style preference.
 */
export function checkWebhookBind(port: string | null, listeners: Listener[] | null): Check {
  const id = 'webhook-bind'
  const title = 'Webhook listens on loopback only'
  if (!port) return { id, title, status: 'skip', detail: 'webhook port unknown (no env) — pass --env or run with autodetect' }
  if (listeners === null) return { id, title, status: 'skip', detail: 'no listener probe available (ss/lsof missing)' }
  const hits = listeners.filter((l) => l.port === port)
  if (hits.length === 0) {
    return { id, title, status: 'warn', detail: `nothing listens on port ${port} — the plugin server is not up (or runs on another host)`, fix: 'start the channel service, then re-run' }
  }
  const offending = hits.filter((l) => !LOOPBACK_ADDR_RE.test(l.addr))
  if (offending.length > 0) {
    return {
      id,
      title,
      status: 'fail',
      detail: `port ${port} is bound to ${offending.map((l) => l.addr).join(', ')} — the hook webhook is reachable from the network`,
      fix: 'bind the webhook to 127.0.0.1 (TELEGRAM_WEBHOOK_HOST) — a public hook surface is a remote-control primitive',
    }
  }
  return { id, title, status: 'pass', detail: `port ${port} bound to loopback only` }
}

/**
 * The channel env file carries the bot token. World-readable mode means any
 * local user can hijack the bot. Cheap stat check, big payoff.
 */
export function checkEnvFileMode(mode: number | null, path: string): Check {
  const id = 'env-file-mode'
  const title = 'Channel env file is private (token inside)'
  if (mode === null) return { id, title, status: 'skip', detail: `cannot stat ${path}` }
  const bits = mode & 0o777
  // ANY other-access fails (write is config injection on the next restart,
  // read is token theft), and group-WRITE fails too — only group-read is a
  // warn (sometimes a deliberate ops-group share).
  if (bits & 0o007) {
    return { id, title, status: 'fail', detail: `${path} is world-accessible (mode ${bits.toString(8)})`, fix: 'chmod 600 the env file — it holds the bot token and is sourced by the service' }
  }
  if (bits & 0o020) {
    return { id, title, status: 'fail', detail: `${path} is group-writable (mode ${bits.toString(8)})`, fix: 'chmod 600 — a group member can inject config the service loads on restart' }
  }
  if (bits & 0o040) {
    return { id, title, status: 'warn', detail: `${path} is group-readable (mode ${bits.toString(8)})`, fix: 'chmod 600 unless the group share is deliberate' }
  }
  return { id, title, status: 'pass', detail: `mode ${bits.toString(8)}` }
}

// Dashi-specific markers only: generic filenames like `post-hook.ts` belong
// to anybody and made an unrelated tool's hook a hard FAIL (review L2).
const CHANNEL_HOOK_MARKERS_RE = /dashi-channel-hook|dashi-permission-gate-hook|dashi-ask-user-question-hook|dashi-channel-fallback-reply/

/**
 * Channel hooks in the USER-level ~/.claude/settings.json fire in EVERY
 * session of every agent on the host and route through one agent's bot/port
 * (fleet invariant a). Previously only the --fleet mode caught this; a
 * single-agent run must too.
 */
export function checkSharedSettingsClean(homeRaw: string | null, selectedIsHome: boolean): Check {
  const id = 'shared-settings-clean'
  const title = 'User-level ~/.claude/settings.json free of channel hooks'
  if (selectedIsHome) {
    // The operator deliberately keeps hooks in the user file (single-agent
    // legacy layout). The per-event checks already validate it; flagging it
    // here would contradict them.
    return { id, title, status: 'skip', detail: 'user-level settings IS the inspected file (legacy single-agent layout)' }
  }
  if (homeRaw === null) return { id, title, status: 'pass', detail: 'no user-level settings.json' }
  return CHANNEL_HOOK_MARKERS_RE.test(homeRaw)
    ? { id, title, status: 'fail', detail: 'channel hook markers found in the user-level settings — they fire in EVERY agent session on this host', fix: 'move channel hooks into <plugin-dir>/.claude/settings.json (fleet invariant a)' }
    : { id, title, status: 'pass', detail: 'no channel hook markers in the shared file' }
}

// ---------------------------------------------------------------------------
// Permission-policy lint (P1). The gate's own zod schema rejects unknown
// confirm_overrides at runtime; the doctor adds an OPERATOR-level lint:
// even schema-valid overrides can be dangerous (lifting sudo / rm -rf), and
// a policy that flips the default tier to allow deserves a flag. Minimal
// line-based extraction — no YAML dependency, conservative on misses.
// ---------------------------------------------------------------------------

/** Built-in confirm rules that must NEVER be lifted via confirm_overrides. */
export const DANGEROUS_OVERRIDE_RULES: readonly string[] = ['sudo ', 'rm -rf ', 'rm -fr ']

/**
 * One YAML scalar item: quoted → cut at the closing quote (a `#` inside quotes
 * is data); bare → strip the ` # comment` tail. A trailing comment used to
 * corrupt the value (`"sudo " # note` ≠ 'sudo ') and silently pass the lint.
 */
function yamlScalar(raw: string): string {
  const s = raw.trim()
  const quoted = s.match(/^(["'])(.*?)\1/)
  if (quoted?.[2] !== undefined) return quoted[2]
  return s.replace(/\s+#.*$/, '').trim()
}

export interface OverridesExtract {
  rules: string[]
  /** confirm_overrides present but in a form the extractor cannot read (flow map etc.). */
  opaque: boolean
}

/** Items of `confirm_overrides: { builtin_rules: [...] }` — block or inline form. */
export function extractConfirmOverrides(policyText: string): OverridesExtract {
  const lines = policyText.split('\n')
  const rules: string[] = []
  let opaque = false
  let inOverrides = false
  let inRules = false
  let rulesIndent = 0
  for (const line of lines) {
    if (/^\s*#/.test(line)) continue
    const overrides = line.match(/^(\s*)confirm_overrides:\s*(\S.*)?$/)
    if (overrides) {
      // `confirm_overrides: { ... }` (flow form) — the line-based extractor
      // cannot read it; a silent pass would invert the lint, so mark opaque.
      if (overrides[2] !== undefined && overrides[2].trim() !== '') opaque = true
      inOverrides = overrides[2] === undefined || overrides[2].trim() === ''
      inRules = false
      continue
    }
    if (inOverrides) {
      const inline = line.match(/^\s*builtin_rules:\s*\[(.*)\]\s*(#.*)?$/)
      if (inline?.[1] !== undefined) {
        rules.push(...inline[1].split(',').map(yamlScalar).filter(Boolean))
        inOverrides = false
        continue
      }
      const block = line.match(/^(\s*)builtin_rules:\s*$/)
      if (block) {
        inRules = true
        rulesIndent = (block[1] ?? '').length
        continue
      }
      // builtin_rules with an unreadable payload on the same line.
      if (/^\s*builtin_rules:/.test(line)) {
        opaque = true
        inOverrides = false
        continue
      }
      if (inRules) {
        const item = line.match(/^(\s*)-\s*(.+?)\s*$/)
        // YAML allows list items at the key's OWN indent (`builtin_rules:` /
        // `- "sudo "` at the same column) — `>` missed them and the sudo lint
        // silently passed. A sibling key cannot match the `- ` regex, so >= is safe.
        if (item && (item[1] ?? '').length >= rulesIndent) {
          const v = yamlScalar(item[2] ?? '')
          if (v) rules.push(v)
          continue
        }
        if (line.trim() !== '') {
          inRules = false
          inOverrides = false
        }
      } else if (/^\S/.test(line)) {
        inOverrides = false
      }
    }
  }
  return { rules, opaque }
}

/** First top-level `key: value` scalar in the policy text. */
export function extractTopLevelScalar(policyText: string, key: string): string | null {
  const m = policyText.match(new RegExp(`^${key}:\\s*["']?([^"'#\\n]+?)["']?\\s*(#.*)?$`, 'm'))
  return m?.[1]?.trim() ?? null
}

export function checkPermissionPolicy(policyText: string | null, policyPath: string): Check[] {
  const out: Check[] = []
  if (policyText === null) {
    return [{ id: 'permission-policy', title: 'Permission policy lint', status: 'skip', detail: `policy file not readable at ${policyPath}` }]
  }
  if (policyText.trim() === '') {
    return [{ id: 'permission-policy', title: 'Permission policy lint', status: 'warn', detail: `${policyPath} is empty — the gate falls back to confirm-everything`, fix: 'write a policy or remove the env override' }]
  }
  const { rules: overrides, opaque } = extractConfirmOverrides(policyText)
  const dangerous = overrides.filter((o) => DANGEROUS_OVERRIDE_RULES.some((d) => o === d || o === d.trim()))
  if (dangerous.length > 0) {
    out.push({
      id: 'permission-policy-risky-override',
      title: 'confirm_overrides does not lift sudo / rm -rf',
      status: 'fail',
      detail: `confirm_overrides lifts catastrophic rule(s): ${dangerous.join(', ')} — these must always reach the owner`,
      fix: 'remove sudo / rm -rf from confirm_overrides.builtin_rules; override only narrow rules like git push',
    })
  } else if (opaque) {
    out.push({
      id: 'permission-policy-risky-override',
      title: 'confirm_overrides does not lift sudo / rm -rf',
      status: 'warn',
      detail: 'confirm_overrides is present in a form this lint cannot read (flow/one-line YAML) — review it by hand',
      fix: 'use the block form (confirm_overrides: / builtin_rules: / - "rule") so the doctor can lint it',
    })
  } else {
    out.push({ id: 'permission-policy-risky-override', title: 'confirm_overrides does not lift sudo / rm -rf', status: 'pass', detail: overrides.length > 0 ? `overrides: ${overrides.join(', ')}` : 'no confirm_overrides' })
  }
  const tier = extractTopLevelScalar(policyText, 'default_tier')
  out.push(
    tier === 'allow'
      ? { id: 'permission-policy-default-tier', title: 'Policy default tier', status: 'warn', detail: 'default_tier: allow — anything the rules miss runs without confirmation', fix: 'prefer default_tier: confirm; allow-list specific safe patterns instead' }
      : { id: 'permission-policy-default-tier', title: 'Policy default tier', status: 'pass', detail: tier ? `default_tier: ${tier}` : 'default_tier unset (gate default applies: confirm)' },
  )
  return out
}

// ---------------------------------------------------------------------------
// Multichat lint (P1). chats/policy.yaml routes per-chat sessions. Two
// invariants the plugin cannot enforce for the operator:
//   - the terminal mirror is DM-only (a mirror in a public group leaks the
//     kitchen: paths, repo names, sometimes redacted-adjacent output);
//   - every chat directory on disk has a policy entry (an orphan dir means a
//     chat is served by defaults nobody reviewed).
// ---------------------------------------------------------------------------

export interface ChatPolicy {
  id: string
  mode: string | null
  tmuxMirror: boolean | null
}

/**
 * Extract per-chat `mode:` and `tmux_mirror:` from the chats: block.
 * Hardened against two bleed bugs (review M2):
 *   - block scalars (`system_reminder: |`) — their content lines could parse
 *     as `mode:`/`tmux_mirror:` and rewrite the chat's policy;
 *   - non-numeric sibling keys (`default:` templates) — their properties were
 *     attributed to the PREVIOUS numeric chat.
 * Properties are accepted only at the exact indent of the chat's first
 * property, and only while no block scalar is open.
 */
export function extractChatPolicies(policyText: string): ChatPolicy[] {
  const lines = policyText.split('\n')
  const out: ChatPolicy[] = []
  let inChats = false
  let chatsIndent = 0
  let current: ChatPolicy | null = null
  let currentIndent = 0
  /** Indent of the current chat's first property; -1 = not seen yet. */
  let propIndent = -1
  /** When >= 0, we are inside a block scalar opened at this key indent. */
  let scalarIndent = -1
  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === '') continue
    const indent = (line.match(/^(\s*)/)?.[1] ?? '').length
    // Inside a block scalar: skip every deeper-indented content line.
    if (scalarIndent >= 0) {
      if (indent > scalarIndent) continue
      scalarIndent = -1
    }
    // Leaving the current block? The very same line may OPEN the real
    // top-level chats: block (allowlist.chats: came first in the file), so
    // fall through to the open-check instead of consuming the line.
    if (inChats && indent <= chatsIndent) {
      inChats = false
      if (current) out.push(current)
      current = null
    }
    if (!inChats) {
      const chats = line.match(/^(\s*)chats:\s*$/)
      if (chats) {
        inChats = true
        chatsIndent = (chats[1] ?? '').length
      }
      continue
    }
    const chatKey = line.match(/^(\s*)["']?(-?\d+)["']?:\s*$/)
    if (chatKey && (current === null || (chatKey[1] ?? '').length <= currentIndent)) {
      if (current) out.push(current)
      current = { id: chatKey[2] ?? '', mode: null, tmuxMirror: null }
      currentIndent = (chatKey[1] ?? '').length
      propIndent = -1
      continue
    }
    // A non-numeric sibling key at chat level (e.g. a `default:` template)
    // closes the current chat — its properties are NOT the chat's.
    if (current && indent <= currentIndent && /^\s*\S+:\s*/.test(line)) {
      out.push(current)
      current = null
      continue
    }
    if (current) {
      if (propIndent === -1) propIndent = indent
      if (indent === propIndent) {
        const mode = line.match(/^\s*mode:\s*["']?(\w+)["']?\s*(#.*)?$/)
        if (mode) current.mode = mode[1] ?? null
        const mirror = line.match(/^\s*tmux_mirror:\s*(true|false)\s*(#.*)?$/)
        if (mirror) current.tmuxMirror = mirror[1] === 'true'
      }
      // A key opening a block scalar (`reminder: |` / `note: >-`): skip its body.
      if (/:\s*[|>][+-]?\s*$/.test(line)) scalarIndent = indent
    }
  }
  if (current) out.push(current)
  return out
}

/**
 * Mirror is DM-only: a public chat with tmux_mirror=true leaks the terminal.
 * A NEGATIVE chat id is a group/channel by Telegram convention — mirror on a
 * group fails even when `mode:` is missing or misspelled (a typo must not
 * disable a security invariant); only an explicit `mode: private` is trusted.
 */
export function checkMultichatMirror(policies: ChatPolicy[]): Check {
  const id = 'multichat-dm-mirror'
  const title = 'Terminal mirror is DM-only (public chats: no mirror)'
  const leaking = policies.filter(
    (p) => p.tmuxMirror === true && (p.mode === 'public' || (p.id.startsWith('-') && p.mode !== 'private')),
  )
  if (leaking.length > 0) {
    return { id, title, status: 'fail', detail: `group/public chat(s) with tmux_mirror=true: ${leaking.map((p) => p.id).join(', ')} — the terminal (paths, repos, tool output) streams into a group`, fix: 'set tmux_mirror: false for every group/public chat' }
  }
  return { id, title, status: 'pass', detail: `${policies.length} chat polic(ies), no public mirror` }
}

/** Every chat dir on disk should have a policy entry (no unreviewed defaults). */
export function checkMultichatDirs(policyIds: string[], dirIds: string[]): Check {
  const id = 'multichat-dirs'
  const title = 'Every chat directory has a policy entry'
  const known = new Set(policyIds)
  const orphans = dirIds.filter((d) => !known.has(d))
  if (orphans.length > 0) {
    return { id, title, status: 'warn', detail: `chat dir(s) without a policy entry: ${orphans.join(', ')} — these chats run on defaults nobody reviewed`, fix: 'add the chat to chats/policy.yaml or remove the stale directory' }
  }
  return { id, title, status: 'pass', detail: `${dirIds.length} chat dir(s), all covered` }
}

/**
 * PR #32 regression guard: spawn-chat-shell must FORWARD TMUX_PANE through the
 * env -i wipe. Require an actual assignment (`TMUX_PANE=...`) outside a
 * comment — a mention in prose must not satisfy a regression guard.
 */
export function checkSpawnChatShell(scriptText: string | null): Check {
  const id = 'spawn-chat-shell-tmux-pane'
  const title = 'spawn-chat-shell forwards TMUX_PANE'
  if (scriptText === null) return { id, title, status: 'skip', detail: 'spawn-chat-shell.sh not found (multichat shells not in use)' }
  const forwards = scriptText.split('\n').some((l) => /TMUX_PANE=/.test(l.replace(/#.*$/, '')))
  return forwards
    ? { id, title, status: 'pass', detail: 'TMUX_PANE forwarding present' }
    : { id, title, status: 'fail', detail: 'no TMUX_PANE= assignment in spawn-chat-shell.sh — the per-chat inbox watcher silently dies (PR #32 regression)', fix: 'forward TMUX and TMUX_PANE through the env -i wipe' }
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
  /** WorkingDirectory= from the unit (autodetect anchor). */
  workingDirectory: string | null
  /** tmux session name from ExecStart `new-session -s <name>`. */
  sessionName: string | null
  /** ExecStart carries --permission-mode bypassPermissions. */
  bypassPermissions: boolean
}

export interface ParsedUnit {
  envPath: string | null
  sockets: string[]
  workingDirectory: string | null
  /** tmux session name from `new-session … -s <name>` (ExecStart). */
  sessionName: string | null
  /** True when any ExecStart payload carries --permission-mode bypassPermissions. */
  bypassPermissions: boolean
}

/** Parse a systemd unit: EnvironmentFile + tmux socket/session per Exec line. Pure. */
export function parseUnitFile(text: string): ParsedUnit {
  let envPath: string | null = null
  let workingDirectory: string | null = null
  let sessionName: string | null = null
  let bypassPermissions = false
  const sockets = new Set<string>()
  for (const line of text.split('\n')) {
    const env = line.match(/^\s*EnvironmentFile=-?(\S+)/)
    if (env?.[1]) envPath = env[1]
    const wd = line.match(/^\s*WorkingDirectory=(\S+)/)
    if (wd?.[1]) workingDirectory = wd[1]
    if (/^\s*ExecStart=/.test(line) && /--permission-mode\s+bypassPermissions/.test(line)) {
      bypassPermissions = true
    }
    if (/^\s*Exec(Start|StartPost|Stop|StopPost)=.*tmux/.test(line)) {
      // Only inspect tmux's OWN argv: everything before the first quote is
      // tmux args, the quoted tail is the nested payload (`'claude ... -L x'`
      // must not read as a tmux socket).
      const cmdPart = line.slice(line.indexOf('tmux'))
      const quoteIdx = cmdPart.search(/['"]/)
      const argsPart = quoteIdx === -1 ? cmdPart : cmdPart.slice(0, quoteIdx)
      const sock = argsPart.match(/\s-L\s+(\S+)/)
      sockets.add(sock?.[1] ?? '')
      const sess = argsPart.match(/\s-s\s+(\S+)/)
      if (/^\s*ExecStart=/.test(line) && sess?.[1]) sessionName = sess[1]
    }
  }
  return { envPath, sockets: [...sockets], workingDirectory, sessionName, bypassPermissions }
}

/**
 * First value of KEY=... in env-file text. Pure. Strips `export `, surrounding
 * quotes and trailing ` # comments` the same way parseEnvList does — systemd's
 * EnvironmentFile accepts `KEY="value"`, and the raw quotes broke the
 * webhook-port and state-dir lookups (false "nothing listens" / profile=unknown).
 */
export function envValue(envText: string, key: string): string | null {
  for (const line of envText.split('\n')) {
    const m = line.match(new RegExp(`^\\s*(?:export\\s+)?${key}=(.*)$`))
    if (m) {
      let v = (m[1] ?? '').trim()
      v = v.replace(/\s+#.*$/, '').trim()
      v = v.replace(/^["']|["']$/g, '')
      return v || null
    }
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

  const sharedDirty = sharedSettingsRaw != null && CHANNEL_HOOK_MARKERS_RE.test(sharedSettingsRaw)
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
    const { envPath, sockets, workingDirectory, sessionName, bypassPermissions } = parseUnitFile(text)
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
      workingDirectory,
      sessionName,
      bypassPermissions,
    })
  }
  return agents
}

/**
 * Find the fleet unit this plugin checkout belongs to: WorkingDirectory or
 * TELEGRAM_WORKSPACE_ROOT shares a tree with the plugin dir. Pure.
 */
export function matchAgentForPlugin(agents: FleetAgent[], pluginDir: string): FleetAgent | null {
  const dir = resolve(pluginDir)
  return (
    agents.find((a) => a.workingDirectory != null && sameTree(dir, a.workingDirectory)) ??
    agents.find((a) => a.workspaceRoot != null && sameTree(dir, a.workspaceRoot)) ??
    null
  )
}

interface Options {
  json: boolean
  os: OS
  pluginDir: string
  settingsPath: string
  /** True when --settings was given explicitly (never overridden by resolution). */
  settingsExplicit: boolean
  mcpPath?: string
  settingsLocalPath?: string
  envPath?: string
  userId?: string
  chatId?: string
  tmuxSession?: string
  queueJsonPath?: string
  fleet?: boolean
  fleetDir?: string
  noAutodetect?: boolean
}

function parseArgs(argv: string[]): Options | { error: string } {
  const opts: Options = {
    json: false,
    os: detectOS(),
    pluginDir: process.cwd(),
    settingsPath: join(homedir(), '.claude', 'settings.json'),
    settingsExplicit: false,
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
        // Resolve once: every downstream comparison (sameTree, .claude/
        // detection, unit matching) assumes an absolute path; a relative
        // `--plugin-dir plugin` broke two checks (fleet sweep, 2026-06-09).
        opts.pluginDir = resolve(next())
        break
      case '--settings':
        opts.settingsPath = next()
        opts.settingsExplicit = true
        break
      case '--no-autodetect':
        opts.noAutodetect = true
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
  --no-autodetect          do not infer --env/--session from systemd channel-*.service
                           units (default: infer when the unit's WorkingDirectory
                           matches --plugin-dir)
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
  const claudeMd = findEnclosingClaudeMd(opts.pluginDir)
  const workspaceDir = claudeMd ? dirname(claudeMd) : null

  // Autodetect (P0): on a systemd host, find the unit whose WorkingDirectory /
  // workspace covers this plugin dir and fill in --env/--session so the
  // default flag-less run reaches full coverage. Explicit flags always win.
  let unitAgent: FleetAgent | null = null
  if (!opts.noAutodetect && opts.os === 'linux') {
    const unitDir = opts.fleetDir ?? '/etc/systemd/system'
    const agents = scanFleet(unitDir)
    unitAgent = matchAgentForPlugin(agents, opts.pluginDir)
    if (unitAgent) {
      const inferred: string[] = []
      if (!opts.envPath && unitAgent.envPath) {
        opts.envPath = unitAgent.envPath
        inferred.push('env')
      }
      if (!opts.tmuxSession) {
        opts.tmuxSession = unitAgent.sessionName ?? `channel-${unitAgent.name}`
        inferred.push('session')
      }
      checks.push({
        id: 'autodetect',
        title: 'Autodetect: systemd unit matched to this plugin',
        status: 'pass',
        detail: `unit channel-${unitAgent.name}${inferred.length > 0 ? ` — inferred: ${inferred.join(', ')}` : ' — all inputs were explicit'}`,
      })
    } else if (agents.length > 0) {
      checks.push({
        id: 'autodetect',
        title: 'Autodetect: systemd unit matched to this plugin',
        status: 'skip',
        detail: `${agents.length} channel unit(s) found but none matches this plugin dir — pass --env/--session explicitly`,
      })
    }
  }

  // Dev-copy vs runtime-copy divergence (lessons §1). The service runs the
  // RUNTIME copy; patching a different checkout silently does nothing. On a
  // fleet host several plugin servers run at once — match by CWD across ALL
  // of them ("first pgrep PID" compared another agent's server, 2026-06-09).
  const live = probe('pgrep', ['-f', 'bun.*src/server.ts'])
  const pids = live.stdout.trim().split(/\s+/).filter(Boolean)
  if (pids.length > 0) {
    const candidates: RuntimeCandidate[] = pids.map((p) => ({ pid: p, cwd: liveCwd(p, opts.os) }))
    const { match, others } = findMatchingRuntime(candidates, opts.pluginDir)
    checks.push(
      match
        ? { id: 'dev-vs-runtime', title: 'Inspected plugin matches a running copy', status: 'pass', detail: `runtime CWD ${match.cwd} (PID ${match.pid})${others > 0 ? `; ${others} other channel server(s) on this host` : ''}` }
        : {
            id: 'dev-vs-runtime',
            title: 'Inspected plugin matches a running copy',
            status: 'warn',
            detail: `${candidates.length} channel server(s) running, none from ${opts.pluginDir} — this agent's service is down or runs another checkout`,
            fix: 'if this agent should be live, check its service; if you are patching, remember the service runs ITS copy, not this one',
          },
    )
  }

  // Settings resolution (P0): hooks load from the session cwd's .claude/ —
  // prefer <plugin-dir>/.claude/settings.json unless --settings was explicit.
  let selectedIsHome = true
  if (!opts.settingsExplicit) {
    const resolved = resolveSettingsPath(opts.pluginDir, opts.settingsPath)
    opts.settingsPath = resolved.path
    selectedIsHome = resolved.source === 'home'
    checks.push({
      id: 'settings-source',
      title: 'Settings file selected',
      status: 'pass',
      detail: resolved.source === 'plugin-dir' ? `plugin-level ${resolved.path} (session cwd layout)` : `user-level ${resolved.path} (no plugin-level settings.json found)`,
    })
  } else {
    selectedIsHome = resolve(opts.settingsPath) === resolve(join(homedir(), '.claude', 'settings.json'))
  }

  // Channel hooks in the USER-level file fire in every agent session on the
  // host (fleet invariant a) — checked always now, not only under --fleet.
  checks.push(checkSharedSettingsClean(readFileSafe(join(homedir(), '.claude', 'settings.json')), selectedIsHome))

  // No env source at all (launchd host, no matching unit, no --env): the
  // env-dependent checks below (webhook bind, env mode, allowlist, profile)
  // silently don't run — leave a breadcrumb instead of false confidence.
  if (!opts.envPath) {
    checks.push({
      id: 'env-unknown',
      title: 'Channel env located',
      status: 'skip',
      detail: 'no channel.env found (no --env, no matching systemd unit — launchd hosts are not autodetected yet) — webhook bind, env-file mode, allowlist and hook profile are NOT checked',
      fix: 'pass --env <channel.env path> to enable the env-dependent checks',
    })
  }

  // Hook profile: read the state config (env → TELEGRAM_STATE_DIR → config.json)
  // BEFORE judging hook registration, so a mirror-only setup is not punished
  // for the feeder hooks it deliberately does not have.
  const envText = opts.envPath ? readFileSafe(opts.envPath) : null
  const stateDir = envText ? envValue(envText, 'TELEGRAM_STATE_DIR') : null
  const rawStateText = stateDir ? readFileSafe(join(stateDir, 'config.json')) : null
  const stateConfig = rawStateText == null ? null : parseJsonSafe(rawStateText)
  const profile = selectHookProfile(stateConfig)

  // settings.json hooks + token leak
  const settings = parseJsonSafe(readFileSafe(opts.settingsPath))
  let gateRegistered = false
  if (settings == null) {
    checks.push({
      id: 'settings-readable',
      title: 'settings.json readable',
      status: 'warn',
      detail: `could not read/parse ${opts.settingsPath}`,
      fix: 'pass --settings <path> to the agent settings.json',
    })
  } else {
    checks.push(...checkSettingsHooks(settings, profile))
    const gateChecks = checkPermissionGate(settings, existsSync, unitAgent ? unitAgent.bypassPermissions : null)
    gateRegistered = gateChecks.some((c) => c.id === 'permission-gate' && c.status !== 'skip')
    checks.push(...gateChecks)
  }

  // Permission policy lint (P1): the file the gate actually reads — path from
  // the gate hook command, else the workspace convention.
  if (gateRegistered) {
    const gateEntry = ((settings as SettingsPermShape)?.hooks?.PreToolUse ?? []).find((e) => e.marker === GATE_MARKER)
    const gateCmd = gateEntry ? entryCommands(gateEntry).join('\n') : ''
    const policyPath =
      extractEnvAssignment(gateCmd, 'TELEGRAM_PERMISSION_POLICY_PATH') ??
      (workspaceDir ? join(workspaceDir, 'chats', 'permission-policy.yaml') : null)
    if (policyPath) {
      checks.push(...checkPermissionPolicy(readFileSafe(policyPath), policyPath))
    }
    // The unit must run bypassPermissions when the gate is the sole authority.
    if (unitAgent) {
      checks.push(
        unitAgent.bypassPermissions
          ? { id: 'unit-permission-mode', title: 'Unit runs --permission-mode bypassPermissions', status: 'pass', detail: `channel-${unitAgent.name} ExecStart carries the flag` }
          : { id: 'unit-permission-mode', title: 'Unit runs --permission-mode bypassPermissions', status: 'warn', detail: `gate is registered but channel-${unitAgent.name} ExecStart does not carry --permission-mode bypassPermissions`, fix: 'without bypassPermissions native prompts still render in the unwatched pane and wedge the session' },
      )
    }
  }

  // Multichat lint (P1): only when the workspace uses chats/policy.yaml.
  if (workspaceDir) {
    const chatsDir = join(workspaceDir, 'chats')
    const policyText = readFileSafe(join(chatsDir, 'policy.yaml'))
    if (policyText !== null) {
      const policies = extractChatPolicies(policyText)
      checks.push(checkMultichatMirror(policies))
      let dirIds: string[] = []
      try {
        dirIds = readdirSync(chatsDir).filter((d) => /^-?\d+$/.test(d))
      } catch {
        /* unreadable chats dir — dir consistency is simply not checkable */
      }
      checks.push(checkMultichatDirs(policies.map((p) => p.id), dirIds))
      checks.push(checkSpawnChatShell(readFileSafe(join(opts.pluginDir, 'scripts', 'spawn-chat-shell.sh'))))
    }
  }

  // Webhook bind (P0, security): the hook webhook must listen on loopback only.
  const webhookPort = envText ? envValue(envText, 'TELEGRAM_WEBHOOK_PORT') : null
  if (webhookPort) {
    let listenersText: string | null = null
    const ss = probe('ss', ['-ltn'])
    if (ss.code === 0 && ss.stdout) {
      listenersText = ss.stdout
    } else {
      const lsof = probe('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'])
      if (lsof.code === 0 && lsof.stdout) listenersText = lsof.stdout
    }
    checks.push(checkWebhookBind(webhookPort, listenersText == null ? null : parseListeners(listenersText)))
  }

  // Env file privacy (P0, security): the bot token lives here.
  if (opts.envPath) {
    let mode: number | null = null
    try {
      mode = statSync(opts.envPath).mode
    } catch {
      mode = null
    }
    checks.push(checkEnvFileMode(mode, opts.envPath))
  }

  // comms consistency (.mcp.json vs settings.local.json) — distinguish a missing
  // file from one present but unparseable (a malformed .mcp.json is itself a
  // bug). Defaults to the plugin-dir copies when no flags are given, so the
  // silent-after-restart landmine is caught by the flag-less run too.
  const mcpPath = opts.mcpPath ?? (existsSync(join(opts.pluginDir, '.mcp.json')) ? join(opts.pluginDir, '.mcp.json') : undefined)
  const settingsLocalPath = opts.settingsLocalPath ?? (existsSync(join(opts.pluginDir, '.claude', 'settings.local.json')) ? join(opts.pluginDir, '.claude', 'settings.local.json') : undefined)
  if (mcpPath || settingsLocalPath) {
    const mcpRaw = readFileSafe(mcpPath ?? '')
    const slRaw = readFileSafe(settingsLocalPath ?? '')
    if (mcpPath && mcpRaw !== null && parseJsonSafe(mcpRaw) === null) {
      checks.push({ id: 'comms-consistency', title: 'MCP comms servers enabled consistently', status: 'fail', detail: `${mcpPath} is present but not valid JSON`, fix: 'fix the .mcp.json syntax' })
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

  // Exactly one progress surface (duplicate-windows guard, 2026-06-09)
  if (stateDir) {
    checks.push(checkProgressSurfaces(stateConfig))
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
    // Fleet convention since the Arthas migration: channel units run their
    // tmux session on a DEDICATED socket named after the session
    // (`tmux -L channel-<agent>`), so two Type=forking/launchd units never
    // race on the default socket and env never bleeds between agents. The
    // default-socket probe misses those sessions entirely (false
    // «session not found» across the whole Mac fleet, 2026-06-09) — when it
    // fails, retry on the convention socket before declaring the session dead.
    let cap = probe('tmux', ['capture-pane', '-t', opts.tmuxSession, '-p', '-S', '-200'])
    if (cap.code !== 0) {
      // Prefer the REAL socket parsed from the matched unit (socket name and
      // session name can differ — `-L channel-arthas … -s main` gave a false
      // "session not found" when we only retried the convention socket).
      const socketNames = [...new Set([unitAgent?.sockets[0], opts.tmuxSession].filter((s): s is string => !!s))]
      for (const sock of socketNames) {
        const socketCap = probe('tmux', ['-L', sock, 'capture-pane', '-t', opts.tmuxSession, '-p', '-S', '-200'])
        if (socketCap.code === 0) {
          cap = socketCap
          break
        }
      }
    }
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
