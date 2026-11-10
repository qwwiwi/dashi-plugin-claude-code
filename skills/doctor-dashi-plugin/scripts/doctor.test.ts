import { describe, expect, test } from 'bun:test'
import { dirname, join, resolve } from 'path'
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { applyPatch } from '../../../plugin/scripts/patch-claude-settings.ts'
import {
  checkMirror,
  resolveDoctorConfig,
  checkAllowlist,
  pluginVersionReport,
  versionCheck,
  checkProgressSurfaces,
  findEnclosingClaudeMd,
  checkFleet,
  envValue,
  hookPortsInSettings,
  parseUnitFile,
  type FleetAgent,
  checkCommsConsistency,
  checkPermissionGate,
  checkSettingsHooks,
  checkVersion,
  checkWorkspacePlacement,
  classifyQueue,
  cmpSemver,
  detectAuthExpired,
  detectCrashLoop,
  detectListening,
  detectOS,
  detectWelcomeHang,
  MIN_BUN,
  MIN_CLAUDE,
  parseEnvList,
  parseSemver,
  redact,
  redactCheck,
  renderReport,
  sameTree,
  worstStatus,
  type Check,
  // 2026-06-09 deep checks (multi-agent / multichat / gate / bind / hygiene)
  selectHookProfile,
  resolveSettingsPath,
  resolveEffectivePluginDir,
  findMatchingRuntime,
  extractEnvAssignment,
  parseListeners,
  checkWebhookBind,
  checkEnvFileMode,
  checkSharedSettingsClean,
  extractConfirmOverrides,
  extractTopLevelScalar,
  checkPermissionPolicy,
  extractChatPolicies,
  checkMultichatMirror,
  checkMultichatDirs,
  checkSpawnChatShell,
  matchAgentForPlugin,
  // 2026-06-10 permission-gate hardening (incident lock + safe liveness probe)
  checkPermissionEndpoint,
} from './doctor.ts'

/** A settings hook entry with a runnable command (what install-hooks writes). */
const hookEntry = (marker: string) => ({ marker, hooks: [{ type: 'command', command: "bun 'scripts/post-hook.ts'" }] })
/** A fileExists stub that reports everything present (gate hardening tests don't probe disk). */
const existsSync0 = (_p: string): boolean => true

describe('detectOS', () => {
  test('maps node platform strings', () => {
    expect(detectOS('linux')).toBe('linux')
    expect(detectOS('darwin')).toBe('macos')
    expect(detectOS('win32')).toBe('other')
  })
})

describe('redact — no secret survives the report', () => {
  test('masks a telegram bot token (bare and in an assignment)', () => {
    expect(redact('saw 8338508613:AAH1234567890abcdefghijklmnopqrstuvw here')).toContain('<bot-token>')
    const assigned = redact('TELEGRAM_BOT_TOKEN=8338508613:AAH1234567890abcdefghijklmnopqrstuvw')
    expect(assigned).not.toContain('AAH1234567890')
  })
  test('masks groq, openai, bearer and ip', () => {
    expect(redact('gsk_abcdefghijklmnopqrstuvwxyz0123')).toContain('<groq-key>')
    expect(redact('sk-proj-abcdefghijklmnopqrst')).toContain('<api-key>')
    expect(redact('Authorization: Bearer abcdef.ghijk-lmnop')).toContain('Bearer <redacted>')
    expect(redact('listening on 100.104.191.127')).toContain('<ip>')
  })
  test('masks quoted secret values with spaces/commas/newlines (review P1)', () => {
    expect(redact('PASSWORD="abc def"')).not.toContain('abc def')
    expect(redact('PASSWORD="abc,def"')).not.toContain('abc,def')
    expect(redact('"MY_SECRET":"abc def"')).not.toContain('abc def')
    expect(redact('PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END-----"')).not.toContain('MIIabc')
  })
  test('leaves ordinary text untouched', () => {
    expect(redact('the channel is listening')).toBe('the channel is listening')
  })
})

describe('sameTree — path boundary aware', () => {
  test('identical and nested trees match', () => {
    expect(sameTree('/srv/agent/plugin', '/srv/agent/plugin')).toBe(true)
    expect(sameTree('/srv/agent/plugin/sub', '/srv/agent/plugin')).toBe(true)
    expect(sameTree('/srv/agent/plugin/', '/srv/agent/plugin')).toBe(true)
  })
  test('sibling paths do NOT match (review P2)', () => {
    expect(sameTree('/srv/agent/plugin', '/srv/agent/plugin-old')).toBe(false)
  })
})

describe('semver', () => {
  test('parses x.y.z and x.y', () => {
    expect(parseSemver('2.1.161')).toEqual([2, 1, 161])
    expect(parseSemver('bun 1.3.14')).toEqual([1, 3, 14])
    expect(parseSemver('no version here')).toBeNull()
  })
  test('compares', () => {
    expect(cmpSemver([2, 1, 0], [2, 1, 0])).toBe(0)
    expect(cmpSemver([2, 0, 9], [2, 1, 0])).toBeLessThan(0)
    expect(cmpSemver([2, 1, 5], [2, 1, 0])).toBeGreaterThan(0)
  })
  test('checkVersion passes at and above the floor, fails below', () => {
    expect(checkVersion('c', 'claude', '2.1.0', MIN_CLAUDE).status).toBe('pass')
    expect(checkVersion('c', 'claude', '2.5.3', MIN_CLAUDE).status).toBe('pass')
    expect(checkVersion('c', 'claude', '2.0.9', MIN_CLAUDE).status).toBe('fail')
    expect(checkVersion('b', 'bun', '1.3.8', MIN_BUN).status).toBe('fail')
    expect(checkVersion('b', 'bun', '1.3.9', MIN_BUN).status).toBe('pass')
  })
  test('checkVersion fails on unparseable output without leaking it raw', () => {
    const c = checkVersion('c', 'claude', 'command not found: claude', MIN_CLAUDE)
    expect(c.status).toBe('fail')
  })
})

describe('findEnclosingClaudeMd / workspace placement', () => {
  const fs = (present: string[]) => (p: string) => present.includes(p)

  test('finds CLAUDE.md walking up', () => {
    const present = ['/home/u/.claude-lab/a/.claude/CLAUDE.md']
    const found = findEnclosingClaudeMd('/home/u/.claude-lab/a/.claude/dashi-plugin-claude-code/plugin', fs(present))
    expect(found).toBe('/home/u/.claude-lab/a/.claude/CLAUDE.md')
  })
  test('passes when plugin is under .claude with CLAUDE.md', () => {
    const present = ['/home/u/.claude-lab/a/.claude/CLAUDE.md']
    const c = checkWorkspacePlacement('/home/u/.claude-lab/a/.claude/dashi-plugin-claude-code/plugin', fs(present))
    expect(c.status).toBe('pass')
  })
  test('fails when no CLAUDE.md anywhere above (identity drift)', () => {
    const c = checkWorkspacePlacement('/home/u/projects/dashi-plugin-claude-code/plugin', fs([]))
    expect(c.status).toBe('fail')
    expect(c.fix).toContain('identity')
  })
  test('warns when CLAUDE.md exists but plugin is outside .claude', () => {
    const present = ['/home/u/projects/CLAUDE.md']
    const c = checkWorkspacePlacement('/home/u/projects/dashi-plugin-claude-code/plugin', fs(present))
    expect(c.status).toBe('warn')
  })
})

describe('checkSettingsHooks', () => {
  const good = {
    hooks: {
      SessionStart: [hookEntry('dashi-channel-hook')],
      UserPromptSubmit: [hookEntry('dashi-channel-hook'), { ...hookEntry('dashi-channel-reminder-hook'), hooks: [{ command: 'bun channel-reminder.ts' }] }],
      SessionEnd: [hookEntry('dashi-channel-hook')],
      PostToolUse: [{ ...hookEntry('dashi-channel-hook'), matcher: 'TaskCreate|TaskUpdate|TodoWrite' }],
      Stop: [hookEntry('dashi-channel-hook'), hookEntry('dashi-channel-fallback-reply')],
    },
  }

  test('all five events present → pass, fallback present → pass', () => {
    const checks = checkSettingsHooks(good)
    const byId = Object.fromEntries(checks.map((c) => [c.id, c.status]))
    expect(byId['settings-no-token']).toBe('pass')
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'SessionEnd', 'PostToolUse', 'Stop']) {
      expect(byId[`hook-${ev}`]).toBe('pass')
    }
    expect(byId['fallback-reply-hook']).toBe('pass')
  })

  test('missing event → warn for that event only', () => {
    const partial = { hooks: { ...good.hooks, PostToolUse: [] } }
    const post = checkSettingsHooks(partial).find((c) => c.id === 'hook-PostToolUse')
    expect(post?.status).toBe('warn')
  })

  test('marker present but NO command → warn (hook would never fire)', () => {
    const markerOnly = { hooks: { ...good.hooks, Stop: [{ marker: 'dashi-channel-hook' }, hookEntry('dashi-channel-fallback-reply')] } }
    const stop = checkSettingsHooks(markerOnly).find((c) => c.id === 'hook-Stop')
    expect(stop?.status).toBe('warn')
    expect(stop?.detail).toContain('no runnable command')
  })

  test('webhook token in settings → FAIL', () => {
    const leaked = { hooks: good.hooks, env: { TELEGRAM_WEBHOOK_TOKEN: 'secret' } }
    expect(checkSettingsHooks(leaked).find((c) => c.id === 'settings-no-token')?.status).toBe('fail')
  })

  test('secret-shaped value under a DIFFERENT key → FAIL (shape detection)', () => {
    const leaked = { hooks: good.hooks, custom: { MY_API_KEY: 'gsk_abcdefghijklmnopqrstuvwxyz0123' } }
    expect(checkSettingsHooks(leaked).find((c) => c.id === 'settings-no-token')?.status).toBe('fail')
  })

  test('canonical install-hooks command with loopback webhook URL → PASS (no IP false positive)', () => {
    // install-hooks.sh writes exactly this shape into every correct setup;
    // the leak check must not flag the 127.0.0.1 webhook URL as a secret.
    const canonical = {
      hooks: {
        ...good.hooks,
        Stop: [
          {
            marker: 'dashi-channel-hook',
            hooks: [
              {
                type: 'command',
                command:
                  "TELEGRAM_HOOK_CHAT_ID='164795011' TELEGRAM_HOOK_AGENT_ID='arthas' TELEGRAM_WEBHOOK_URL='http://127.0.0.1:8103/hooks/agent' bun '/srv/agent/.claude/jarvis-channel/plugin/scripts/post-hook.ts'",
              },
            ],
          },
          hookEntry('dashi-channel-fallback-reply'),
        ],
      },
    }
    expect(checkSettingsHooks(canonical).find((c) => c.id === 'settings-no-token')?.status).toBe('pass')
  })

  test('bot token in a hook command → still FAIL with strict secret rules', () => {
    const leaked = {
      hooks: {
        ...good.hooks,
        Stop: [
          {
            marker: 'dashi-channel-hook',
            hooks: [
              {
                type: 'command',
                command: "TELEGRAM_BOT_TOKEN='8338508613:AAH1234567890abcdefghijklmnopqrstuvw' bun 'scripts/post-hook.ts'",
              },
            ],
          },
        ],
      },
    }
    expect(checkSettingsHooks(leaked).find((c) => c.id === 'settings-no-token')?.status).toBe('fail')
  })

  test('no fallback hook → warn', () => {
    const noFallback = { hooks: { ...good.hooks, Stop: [hookEntry('dashi-channel-hook')] } }
    expect(checkSettingsHooks(noFallback).find((c) => c.id === 'fallback-reply-hook')?.status).toBe('warn')
  })
})

describe('checkPermissionGate', () => {
  const gateEntry = {
    marker: 'dashi-permission-gate-hook',
    matcher: '.*',
    hooks: [{ type: 'command', command: "CHAT_ID='164795011' TELEGRAM_WEBHOOK_URL='http://127.0.0.1:8093' bun '/p/scripts/permission-gate-hook.ts'" }],
  }

  test('no gate hook → skip (optional feature off)', () => {
    const checks = checkPermissionGate({ hooks: { PreToolUse: [hookEntry('dashi-channel-hook')] } })
    expect(checks).toHaveLength(1)
    expect(checks[0]!.status).toBe('skip')
  })

  test('gate registered + bypassPermissions → pass on both', () => {
    const checks = checkPermissionGate({
      permissions: { defaultMode: 'bypassPermissions' },
      hooks: { PreToolUse: [gateEntry, hookEntry('dashi-channel-hook')] },
    })
    const byId = Object.fromEntries(checks.map((c) => [c.id, c.status]))
    expect(byId['permission-gate']).toBe('pass')
    expect(byId['permission-gate-mode']).toBe('pass')
  })

  test('gate registered but mode not bypassPermissions → warn (native prompts wedge)', () => {
    const checks = checkPermissionGate({ hooks: { PreToolUse: [gateEntry] } })
    expect(checks.find((c) => c.id === 'permission-gate-mode')?.status).toBe('warn')
  })

  test('bearer token in the gate command → FAIL', () => {
    const leaked = {
      hooks: { PreToolUse: [{
        marker: 'dashi-permission-gate-hook',
        matcher: '.*',
        hooks: [{ type: 'command', command: "TELEGRAM_WEBHOOK_TOKEN='abc' bun '/p/scripts/permission-gate-hook.ts'" }],
      }] },
    }
    expect(checkPermissionGate(leaked).find((c) => c.id === 'permission-gate-token')?.status).toBe('fail')
  })

  test('gate marker present but command does not point at the helper → warn', () => {
    const bogus = {
      hooks: { PreToolUse: [{
        marker: 'dashi-permission-gate-hook',
        matcher: '.*',
        hooks: [{ type: 'command', command: "bun '/p/scripts/post-hook.ts'" }],
      }] },
    }
    expect(checkPermissionGate(bogus).find((c) => c.id === 'permission-gate')?.status).toBe('warn')
  })
})

describe('checkCommsConsistency — the latent silent-channel landmine', () => {
  test('enableAllProjectMcpServers=true covers everything', () => {
    const mcp = { mcpServers: { 'dashi-channel': {}, 'dashi-gbrain-swarm': {} } }
    const sl = { enableAllProjectMcpServers: true }
    expect(checkCommsConsistency(mcp, sl).status).toBe('pass')
  })
  test('false + missing server → FAIL (dropped on next restart)', () => {
    const mcp = { mcpServers: { 'dashi-channel': {}, 'dashi-gbrain-swarm': {} } }
    const sl = { enableAllProjectMcpServers: false, enabledMcpjsonServers: ['dashi-gbrain-swarm'] }
    const c = checkCommsConsistency(mcp, sl)
    expect(c.status).toBe('fail')
    expect(c.detail).toContain('dashi-channel')
  })
  test('false + all listed → pass', () => {
    const mcp = { mcpServers: { 'dashi-channel': {} } }
    const sl = { enableAllProjectMcpServers: false, enabledMcpjsonServers: ['dashi-channel'] }
    expect(checkCommsConsistency(mcp, sl).status).toBe('pass')
  })
  test('no servers declared → skip', () => {
    expect(checkCommsConsistency({ mcpServers: {} }, {}).status).toBe('skip')
  })
  test('malformed enabledMcpjsonServers (object, not array) → fail, no crash', () => {
    const mcp = { mcpServers: { 'dashi-channel': {} } }
    const sl = { enableAllProjectMcpServers: false, enabledMcpjsonServers: { 'dashi-channel': true } }
    expect(checkCommsConsistency(mcp, sl).status).toBe('fail')
  })
})

describe('parseEnvList — tolerates real .env noise', () => {
  test('plain CSV', () => {
    expect(parseEnvList('TELEGRAM_ALLOWED_USER_IDS=1,2,3', 'TELEGRAM_ALLOWED_USER_IDS')).toEqual(['1', '2', '3'])
  })
  test('strips inline comment, quotes, and export prefix', () => {
    expect(parseEnvList('TELEGRAM_ALLOWED_USER_IDS=42 # me', 'TELEGRAM_ALLOWED_USER_IDS')).toEqual(['42'])
    expect(parseEnvList('TELEGRAM_ALLOWED_USER_IDS="1,2"', 'TELEGRAM_ALLOWED_USER_IDS')).toEqual(['1', '2'])
    expect(parseEnvList('export TELEGRAM_ALLOWED_USER_IDS=7', 'TELEGRAM_ALLOWED_USER_IDS')).toEqual(['7'])
  })
  test('missing key → null, empty value → []', () => {
    expect(parseEnvList('OTHER=1', 'TELEGRAM_ALLOWED_USER_IDS')).toBeNull()
    expect(parseEnvList('TELEGRAM_ALLOWED_USER_IDS=', 'TELEGRAM_ALLOWED_USER_IDS')).toEqual([])
  })
})

describe('checkAllowlist (user AND chat)', () => {
  test('user present → pass', () => {
    const c = checkAllowlist('TELEGRAM_ALLOWED_USER_IDS=164795011,42', '42')
    expect(c.find((x) => x.id === 'allowlist-user')?.status).toBe('pass')
  })
  test('user absent → fail with inline-comment value still parsed', () => {
    const c = checkAllowlist('TELEGRAM_ALLOWED_USER_IDS=164795011 # chief', '42')
    const user = c.find((x) => x.id === 'allowlist-user')
    expect(user?.status).toBe('fail')
    expect(user?.detail).toContain('silently dropped')
  })
  test('empty user allowlist with known user → fail', () => {
    expect(checkAllowlist('TELEGRAM_ALLOWED_USER_IDS=', '42')[0]?.status).toBe('fail')
  })
  test('chat list present and chat id missing → fail', () => {
    const c = checkAllowlist('TELEGRAM_ALLOWED_USER_IDS=42\nTELEGRAM_ALLOWED_CHAT_IDS=-100123', '42', '-100999')
    expect(c.find((x) => x.id === 'allowlist-chat')?.status).toBe('fail')
  })
  test('user-only DM setup still requires chat coverage', () => {
    const c = checkAllowlist('TELEGRAM_ALLOWED_USER_IDS=42', '42')
    expect(c.find((x) => x.id === 'allowlist-chat')?.status).toBe('warn')
  })
})

describe('classifyQueue', () => {
  test('409 → fail with hunt-the-second-consumer guidance', () => {
    const c = classifyQueue({ ok: false, error_code: 409 })
    expect(c.status).toBe('fail')
    expect(c.fix).toContain('second consumer')
  })
  test('ok with no pending → pass', () => {
    expect(classifyQueue({ ok: true, result: [] }).status).toBe('pass')
  })
  test('ok but pending after messaging → warn (poller stuck)', () => {
    expect(classifyQueue({ ok: true, result: [{}, {}] }, true).status).toBe('warn')
  })
})

describe('live-session signal detectors', () => {
  test('welcome hang detected POSITIVELY by prompt text', () => {
    expect(detectWelcomeHang('Do you trust the files in this folder?')).toBe(true)
    expect(detectWelcomeHang('--dangerously-load-development-channels is for local development only')).toBe(true)
  })
  test('busy session with scrolled-out marker is NOT a hang (was the false-positive)', () => {
    const busy = Array.from({ length: 80 }, (_, i) => `turn line ${i}`).join('\n')
    expect(detectWelcomeHang(busy)).toBe(false)
  })
  test('detectListening confirms the live marker', () => {
    expect(detectListening('Listening for channel messages from: server:dashi-channel')).toBe(true)
    expect(detectListening('turn line 5')).toBe(false)
  })
  test('auth expired only on line-anchored login/401', () => {
    expect(detectAuthExpired('Please run /login')).toBe(true)
    expect(detectAuthExpired('API Error: 401')).toBe(true)
    expect(detectAuthExpired('all good')).toBe(false)
  })
  test('auth NOT tripped by login words inside prose (was a false-positive)', () => {
    expect(detectAuthExpired('the docs say: if you see please run /login then reauth')).toBe(false)
  })
  test('crash loop on no-server / auto-restart success', () => {
    expect(detectCrashLoop('no server running on /tmp/tmux-1000/default')).toBe(true)
    expect(detectCrashLoop('activating (auto-restart) (Result: exit-code) status=0/SUCCESS')).toBe(true)
    expect(detectCrashLoop('active (running)')).toBe(false)
  })
})

describe('report aggregation', () => {
  const checks: Check[] = [
    { id: 'a', title: 'A', status: 'pass', detail: 'ok' },
    { id: 'b', title: 'B', status: 'warn', detail: 'meh', fix: 'do x' },
    { id: 'c', title: 'C', status: 'fail', detail: 'token 8338508613:AAH1234567890abcdefghijklmnopqrstuvw', fix: 'redact me' },
  ]
  test('worstStatus picks the most severe', () => {
    expect(worstStatus(checks)).toBe('fail')
    expect(worstStatus([{ id: 'x', title: 'x', status: 'pass', detail: '' }])).toBe('pass')
    expect(worstStatus([])).toBe('skip')
  })
  test('renderReport redacts secrets and counts fails/warns', () => {
    const r = renderReport(checks)
    expect(r).not.toContain('AAH1234567890')
    expect(r).toContain('1 FAIL')
    expect(r).toContain('1 WARN')
  })
  test('redactCheck scrubs detail and fix (the --json output path)', () => {
    const c = redactCheck({ id: 'x', title: 'token 100.104.191.127', status: 'fail', detail: 'leak 8338508613:AAH1234567890abcdefghijklmnopqrstuvw', fix: 'GROQ_API_KEY=gsk_abcdefghijklmnopqrstuvwxyz0123' })
    const json = JSON.stringify(c)
    expect(json).not.toContain('AAH1234567890')
    expect(json).not.toContain('gsk_abcdefghijklmnopqrstuvwxyz0123')
    expect(json).not.toContain('100.104.191.127')
  })
  test('redact masks secret-key assignments regardless of value shape', () => {
    expect(redact('TELEGRAM_WEBHOOK_TOKEN=super-secret-xyz')).not.toContain('super-secret-xyz')
    expect(redact('"MY_SECRET":"whatever-123"')).not.toContain('whatever-123')
  })
})

describe('fleet (multi-agent) checks', () => {
  const agent = (over: Partial<FleetAgent>): FleetAgent => ({
    name: 'a',
    unitPath: '/etc/systemd/system/channel-a.service',
    sockets: ['channel-a'],
    envPath: '/etc/dashi-plugin/a/channel.env',
    envReadable: true,
    port: '8089',
    tokenDigest: 'digest-a',
    stateDir: '/var/lib/dashi-channel/a',
    workspaceRoot: '/srv/agents/a',
    webhookEnabled: true,
    hookPorts: ['8089'],
    settingsPath: '/srv/agents/a/settings.json',
    workingDirectory: '/srv/agents/a/.claude/jc/plugin',
    sessionName: 'channel-a',
    bypassPermissions: false,
    gateEnabled: null,
    gateHookRegistered: false,
    ...over,
  })
  const byId = (checks: Check[]): Record<string, Check> => Object.fromEntries(checks.map((c) => [c.id, c]))

  test('parseUnitFile extracts EnvironmentFile and per-Exec-line sockets', () => {
    const unit = [
      '[Service]',
      'EnvironmentFile=/etc/dashi-plugin/arthas/channel.env',
      "ExecStart=/usr/bin/tmux -L channel-arthas new-session -d -s channel-arthas 'claude ...'",
      'ExecStartPost=/usr/local/bin/confirm.sh',
      'ExecStop=/usr/bin/tmux -L channel-arthas kill-session -t channel-arthas',
    ].join('\n')
    const parsed = parseUnitFile(unit)
    expect(parsed.envPath).toBe('/etc/dashi-plugin/arthas/channel.env')
    expect(parsed.sockets).toEqual(['channel-arthas'])
  })

  test('parseUnitFile: default socket registers as empty string; mixed sockets both appear', () => {
    const unit = [
      'ExecStart=/usr/bin/tmux new-session -d -s channel-thrall claude',
      'ExecStop=/usr/bin/tmux -L other kill-session -t channel-thrall',
    ].join('\n')
    const parsed = parseUnitFile(unit)
    expect(parsed.sockets.sort()).toEqual(['', 'other'])
  })

  test('envValue picks the first assignment and trims', () => {
    expect(envValue('A=1\nTELEGRAM_WEBHOOK_PORT=8103\n', 'TELEGRAM_WEBHOOK_PORT')).toBe('8103')
    expect(envValue('TELEGRAM_WEBHOOK_PORT=\n', 'TELEGRAM_WEBHOOK_PORT')).toBeNull()
  })

  test('hookPortsInSettings finds webhook ports in hook commands', () => {
    const raw = JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "X bun 'http://127.0.0.1:8103/hooks/agent'".replace('X', "TELEGRAM_WEBHOOK_URL='http://127.0.0.1:8103/hooks/agent'") }] }] } })
    expect(hookPortsInSettings(raw)).toEqual(['8103'])
    expect(hookPortsInSettings(null)).toEqual([])
  })

  test('healthy two-agent fleet passes everything', () => {
    const checks = byId(checkFleet([
      agent({ name: 'thrall', sockets: [''], port: '8093', tokenDigest: 'd1', stateDir: '/s/1', workspaceRoot: '/w/1', hookPorts: ['8093'] }),
      agent({ name: 'arthas', sockets: ['channel-arthas'], port: '8103', tokenDigest: 'd2', stateDir: '/s/2', workspaceRoot: '/w/2', hookPorts: ['8103'] }),
    ], '{"hooks":{}}'))
    expect(checks['fleet-size']?.status).toBe('pass')
    expect(checks['fleet-ports-unique']?.status).toBe('pass')
    expect(checks['fleet-tokens-unique']?.status).toBe('pass')
    // exactly one agent on the default socket = warn (recommendation), not fail
    expect(checks['fleet-sockets']?.status).toBe('warn')
    expect(checks['fleet-shared-settings']?.status).toBe('pass')
    expect(checks['fleet-webhook-enabled']?.status).toBe('pass')
    expect(checks['fleet-hook-ports']?.status).toBe('pass')
  })

  test('duplicate port / token / socket fail with agent names', () => {
    const checks = byId(checkFleet([
      agent({ name: 'a', port: '8089', tokenDigest: 'same', sockets: ['s1'] }),
      agent({ name: 'b', port: '8089', tokenDigest: 'same', sockets: ['s1'], stateDir: '/s/b', workspaceRoot: '/w/b' }),
    ], null))
    expect(checks['fleet-ports-unique']?.status).toBe('fail')
    expect(checks['fleet-ports-unique']?.detail).toContain('a & b')
    expect(checks['fleet-tokens-unique']?.status).toBe('fail')
    expect(checks['fleet-sockets']?.status).toBe('fail')
  })

  test('two agents both on the default socket = fail, not warn', () => {
    const checks = byId(checkFleet([
      agent({ name: 'a', sockets: [''] }),
      agent({ name: 'b', sockets: [''], port: '8090', tokenDigest: 'd2', stateDir: '/s/b', workspaceRoot: '/w/b' }),
    ], null))
    expect(checks['fleet-sockets']?.status).toBe('fail')
  })

  test('inconsistent -L inside one unit = fail', () => {
    const checks = byId(checkFleet([agent({ sockets: ['x', 'y'] })], null))
    expect(checks['fleet-sockets']?.status).toBe('fail')
    expect(checks['fleet-sockets']?.detail).toContain('disagree')
  })

  test('channel hooks in the shared settings = fail', () => {
    const shared = JSON.stringify({ hooks: { Stop: [{ marker: 'dashi-channel-hook', hooks: [{ command: 'bun post-hook.ts' }] }] } })
    const checks = byId(checkFleet([agent({})], shared))
    expect(checks['fleet-shared-settings']?.status).toBe('fail')
  })

  test('webhook disabled or state config missing = warn with reason', () => {
    const checks = byId(checkFleet([
      agent({ name: 'off', webhookEnabled: false }),
      agent({ name: 'missing', webhookEnabled: null, port: '8090', tokenDigest: 'd2', stateDir: '/s/2', workspaceRoot: '/w/2' }),
    ], null))
    expect(checks['fleet-webhook-enabled']?.status).toBe('warn')
    expect(checks['fleet-webhook-enabled']?.detail).toContain('off (enabled=false)')
    expect(checks['fleet-webhook-enabled']?.detail).toContain('missing (state config missing)')
  })

  test('hooks pointing at a foreign port = fail (the last-install-wins disaster)', () => {
    const checks = byId(checkFleet([agent({ name: 'arthas', port: '8103', hookPorts: ['8093'] })], null))
    expect(checks['fleet-hook-ports']?.status).toBe('fail')
    expect(checks['fleet-hook-ports']?.detail).toContain('8093')
  })

  test('unreadable env degrades to warn, not crash', () => {
    const checks = byId(checkFleet([
      agent({}),
      agent({ name: 'locked', envReadable: false, port: null, tokenDigest: null, stateDir: null, workspaceRoot: null, webhookEnabled: null, hookPorts: [], settingsPath: null, sockets: ['s2'] }),
    ], null))
    expect(checks['fleet-env-readable']?.status).toBe('warn')
    expect(checks['fleet-env-readable']?.detail).toContain('locked')
  })

  test('empty fleet fails discovery', () => {
    const checks = byId(checkFleet([], null))
    expect(checks['fleet-size']?.status).toBe('fail')
  })

  test('token digests never expose the token in any rendered output', () => {
    const checks = checkFleet([agent({ tokenDigest: 'a'.repeat(64) })], null)
    const text = renderReport(checks)
    expect(text).not.toContain('a'.repeat(64))
  })
})

describe('fleet discovery filter', () => {
  test('units without tmux Exec lines are not channels', () => {
    const helper = parseUnitFile('ExecStart=/usr/bin/python3 /srv/listener.py\nEnvironmentFile=/etc/x.env')
    expect(helper.sockets).toEqual([])
  })
})

describe('fleet checks — review fixes (Codex HOLD round)', () => {
  const agent = (over: Partial<FleetAgent>): FleetAgent => ({
    name: 'a',
    unitPath: '/etc/systemd/system/channel-a.service',
    sockets: ['channel-a'],
    envPath: '/etc/dashi-plugin/a/channel.env',
    envReadable: true,
    port: '8089',
    tokenDigest: 'digest-a',
    stateDir: '/var/lib/dashi-channel/a',
    workspaceRoot: '/srv/agents/a',
    webhookEnabled: true,
    hookPorts: ['8089'],
    settingsPath: '/srv/agents/a/settings.json',
    workingDirectory: '/srv/agents/a/.claude/jc/plugin',
    sessionName: 'channel-a',
    bypassPermissions: false,
    gateEnabled: null,
    gateHookRegistered: false,
    ...over,
  })
  const byId = (checks: Check[]): Record<string, Check> => Object.fromEntries(checks.map((c) => [c.id, c]))

  test('readable env missing PORT/TOKEN surfaces as warn, not hollow pass', () => {
    const checks = byId(checkFleet([agent({ name: 'bare', port: null, tokenDigest: null })], null))
    expect(checks['fleet-env-keys']?.status).toBe('warn')
    expect(checks['fleet-env-keys']?.detail).toContain('bare')
    expect(checks['fleet-env-keys']?.detail).toContain('TELEGRAM_WEBHOOK_PORT')
  })

  test('foreign port NEXT TO the own port still fails (stale last-install hook)', () => {
    const checks = byId(checkFleet([agent({ name: 'arthas', port: '8103', hookPorts: ['8103', '8093'] })], null))
    expect(checks['fleet-hook-ports']?.status).toBe('fail')
    expect(checks['fleet-hook-ports']?.detail).toContain('8093')
    expect(checks['fleet-hook-ports']?.detail).not.toContain('8103,')
  })

  test('workspace settings not found = warn (unverified), not pass', () => {
    const checks = byId(checkFleet([agent({ settingsPath: null, hookPorts: [] })], null))
    expect(checks['fleet-hook-ports']?.status).toBe('warn')
    expect(checks['fleet-hook-ports']?.detail).toContain('unverified')
  })

  test('hookPortsInSettings catches localhost spellings', () => {
    expect(hookPortsInSettings('x http://localhost:8089/hooks/agent y')).toEqual(['8089'])
    expect(hookPortsInSettings('x http://0.0.0.0:8090/hooks/agent y')).toEqual(['8090'])
    expect(hookPortsInSettings('x http://[::1]:8091/hooks/agent y')).toEqual(['8091'])
  })

  test('-L inside the quoted nested command is NOT a tmux socket', () => {
    const unit = "ExecStart=/usr/bin/tmux new-session -d -s s 'claude -L sneaky --flag'"
    expect(parseUnitFile(unit).sockets).toEqual([''])
  })

  test('-L in tmux argv before the quoted payload IS the socket', () => {
    const unit = "ExecStart=/usr/bin/tmux -L real new-session -d -s s 'claude -L sneaky'"
    expect(parseUnitFile(unit).sockets).toEqual(['real'])
  })
})

describe('checkProgressSurfaces — exactly one activity surface', () => {
  test('two hook-driven reporters enabled together is a warn', () => {
    const c = checkProgressSurfaces({ status: { enabled: true }, progress: { enabled: true } })
    expect(c.status).toBe('warn')
    expect(c.detail).toContain('status')
    expect(c.detail).toContain('progress')
  })
  test('reporter enabled next to the tmux mirror is a warn', () => {
    const c = checkProgressSurfaces({ progress: { enabled: true }, tmux_mirror: { enabled: true } })
    expect(c.status).toBe('warn')
  })
  test('tmux mirror alone passes', () => {
    const c = checkProgressSurfaces({ tmux_mirror: { enabled: true, pane_target: 'channel-x:0.0' } })
    expect(c.status).toBe('pass')
  })
  test('empty config passes (defaults are all-off since 2026-06-09)', () => {
    const c = checkProgressSurfaces({})
    expect(c.status).toBe('pass')
  })
  test('unreadable config is a warn, not a crash', () => {
    const c = checkProgressSurfaces('not an object')
    expect(c.status).toBe('warn')
  })
})

describe('findEnclosingClaudeMd — relative plugin dir', () => {
  test('relative path is resolved against cwd before walking up', () => {
    const cwd = process.cwd()
    const found = new Set([join(dirname(dirname(cwd)), 'CLAUDE.md')])
    const fe = (p: string) => found.has(p)
    // grandparent of cwd holds CLAUDE.md: cwd/plugin -> cwd -> parent -> grandparent
    expect(findEnclosingClaudeMd('plugin', fe)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2026-06-09 deep checks — multi-agent, hook profiles, gate, bind, multichat
// ---------------------------------------------------------------------------

describe('selectHookProfile', () => {
  test('status or progress reporter enabled → hook-feeders', () => {
    expect(selectHookProfile({ status: { enabled: true } })).toBe('hook-feeders')
    expect(selectHookProfile({ progress: { enabled: true }, tmux_mirror: { enabled: true } })).toBe('hook-feeders')
  })
  test('mirror only → mirror', () => {
    expect(selectHookProfile({ tmux_mirror: { enabled: true } })).toBe('mirror')
  })
  test('config present, nothing enabled → none', () => {
    expect(selectHookProfile({})).toBe('none')
  })
  test('missing config → unknown (conservative)', () => {
    expect(selectHookProfile(null)).toBe('unknown')
    expect(selectHookProfile('garbage')).toBe('unknown')
  })
})

describe('checkSettingsHooks — profile aware', () => {
  const stopOnly = {
    hooks: { Stop: [hookEntry('dashi-channel-hook')] },
  }
  test('mirror profile: Stop-only settings still warn about missing lifecycle/task hooks', () => {
    const checks = checkSettingsHooks(stopOnly, 'mirror')
    const feederWarns = checks.filter((c) => c.id.startsWith('hook-') && c.status === 'warn' && c.id !== 'hook-Stop')
    expect(feederWarns).toHaveLength(4)
    expect(checks.find((c) => c.id === 'hook-SessionEnd')?.status).toBe('warn')
    expect(checks.find((c) => c.id === 'hook-Stop')?.status).toBe('pass')
  })
  test('mirror profile: missing Stop hook still warns', () => {
    const checks = checkSettingsHooks({ hooks: {} }, 'mirror')
    expect(checks.find((c) => c.id === 'hook-Stop')?.status).toBe('warn')
  })
  test('hook-feeders profile keeps demanding all five events', () => {
    const checks = checkSettingsHooks(stopOnly, 'hook-feeders')
    const warns = checks.filter((c) => c.status === 'warn' && /^hook-/.test(c.id))
    expect(warns.length).toBeGreaterThanOrEqual(4) // 4 missing feeder events
  })
  test('unknown profile behaves conservatively (like hook-feeders) and hints at --env', () => {
    const checks = checkSettingsHooks(stopOnly, 'unknown')
    const warn = checks.find((c) => c.id === 'hook-SessionStart')
    expect(warn?.status).toBe('warn')
    expect(warn?.detail).toContain('profile unknown')
  })
  test('default profile is unknown (backward compatible)', () => {
    const checks = checkSettingsHooks(stopOnly)
    expect(checks.some((c) => c.id === 'hook-SessionStart')).toBe(true)
  })
})

describe('resolveSettingsPath — session cwd layout first', () => {
  test('prefers <plugin-dir>/.claude/settings.json when present', () => {
    const r = resolveSettingsPath('/srv/agent/.claude/jc/plugin', '/home/u/.claude/settings.json', (p) => p === '/srv/agent/.claude/jc/plugin/.claude/settings.json')
    expect(r.source).toBe('plugin-dir')
    expect(r.path).toBe('/srv/agent/.claude/jc/plugin/.claude/settings.json')
  })
  test('falls back to the user-level file', () => {
    const r = resolveSettingsPath('/srv/agent/plugin', '/home/u/.claude/settings.json', () => false)
    expect(r.source).toBe('home')
    expect(r.path).toBe('/home/u/.claude/settings.json')
  })
})

describe('findMatchingRuntime — fleet host, match by CWD not by first PID', () => {
  test('first candidate foreign, second matches → pass with others counted', () => {
    const r = findMatchingRuntime(
      [
        { pid: '100', cwd: '/srv/arthas/.claude/jc/plugin' },
        { pid: '200', cwd: '/srv/thrall/.claude/jc/plugin' },
      ],
      '/srv/thrall/.claude/jc/plugin',
    )
    expect(r.match?.pid).toBe('200')
    expect(r.others).toBe(1)
  })
  test('no candidate matches → null match', () => {
    const r = findMatchingRuntime([{ pid: '100', cwd: '/srv/other/plugin' }], '/srv/thrall/plugin')
    expect(r.match).toBeNull()
    expect(r.others).toBe(1)
  })
  test('empty cwd (unreadable /proc) never matches', () => {
    const r = findMatchingRuntime([{ pid: '100', cwd: '' }], '/srv/thrall/plugin')
    expect(r.match).toBeNull()
  })
})

describe('extractEnvAssignment', () => {
  test('single-quoted, double-quoted and bare values', () => {
    expect(extractEnvAssignment("FOO='/a b/c.yaml' bun x.ts", 'FOO')).toBe('/a b/c.yaml')
    expect(extractEnvAssignment('FOO="/a/c.yaml" bun x.ts', 'FOO')).toBe('/a/c.yaml')
    expect(extractEnvAssignment('FOO=/a/c.yaml bun x.ts', 'FOO')).toBe('/a/c.yaml')
  })
  test('missing key → null', () => {
    expect(extractEnvAssignment('BAR=1 bun x.ts', 'FOO')).toBeNull()
  })
})

describe('checkPermissionGate — ask relay, policy path, unit bypass', () => {
  const gateCmd = "TELEGRAM_PERMISSION_POLICY_PATH='/ws/chats/permission-policy.yaml' bun '/p/scripts/permission-gate-hook.ts'"
  const gate = { marker: 'dashi-permission-gate-hook', hooks: [{ type: 'command', command: gateCmd }] }
  const ask = { marker: 'dashi-ask-user-question-hook', hooks: [{ type: 'command', command: "bun '/p/scripts/ask-user-question-hook.ts'" }] }
  test('gate + ask + existing policy + unit bypass → all pass', () => {
    const checks = checkPermissionGate({ hooks: { PreToolUse: [gate, ask] } }, (p) => p === '/ws/chats/permission-policy.yaml', true)
    expect(checks.find((c) => c.id === 'permission-gate')?.status).toBe('pass')
    expect(checks.find((c) => c.id === 'permission-gate-ask-hook')?.status).toBe('pass')
    expect(checks.find((c) => c.id === 'gate-policy-path')?.status).toBe('pass')
    expect(checks.find((c) => c.id === 'permission-gate-mode')?.status).toBe('pass')
  })
  test('gate without the ask relay → warn (question wedges the session)', () => {
    const checks = checkPermissionGate({ hooks: { PreToolUse: [gate] } }, () => true, true)
    expect(checks.find((c) => c.id === 'permission-gate-ask-hook')?.status).toBe('warn')
  })
  test('policy path missing on disk → warn (fallback policy in force)', () => {
    const checks = checkPermissionGate({ hooks: { PreToolUse: [gate, ask] } }, () => false, true)
    expect(checks.find((c) => c.id === 'gate-policy-path')?.status).toBe('warn')
  })
  test('mode unset and no unit knowledge → warn stays (old behavior)', () => {
    const checks = checkPermissionGate({ hooks: { PreToolUse: [gate, ask] } }, () => true, null)
    expect(checks.find((c) => c.id === 'permission-gate-mode')?.status).toBe('warn')
  })
})

describe('parseListeners / checkWebhookBind — loopback or nothing', () => {
  const ss = [
    'State  Recv-Q Send-Q Local Address:Port Peer Address:Port',
    'LISTEN 0      512        127.0.0.1:8093      0.0.0.0:*',
    'LISTEN 0      2048         0.0.0.0:8091      0.0.0.0:*',
    'LISTEN 0      512            [::1]:8103         [::]:*',
    'LISTEN 0      128                *:9000            *:*',
  ].join('\n')
  test('parses IPv4, bracketed IPv6 and wildcard listeners', () => {
    const l = parseListeners(ss)
    expect(l).toContainEqual({ addr: '127.0.0.1', port: '8093' })
    expect(l).toContainEqual({ addr: '0.0.0.0', port: '8091' })
    expect(l).toContainEqual({ addr: '[::1]', port: '8103' })
    expect(l).toContainEqual({ addr: '*', port: '9000' })
  })
  test('loopback bind passes', () => {
    expect(checkWebhookBind('8093', parseListeners(ss)).status).toBe('pass')
  })
  test('0.0.0.0 bind FAILS (network-reachable hook surface)', () => {
    const c = checkWebhookBind('8091', parseListeners(ss))
    expect(c.status).toBe('fail')
    expect(c.detail).toContain('0.0.0.0')
  })
  test('IPv6 loopback passes, wildcard fails', () => {
    expect(checkWebhookBind('8103', parseListeners(ss)).status).toBe('pass')
    expect(checkWebhookBind('9000', parseListeners(ss)).status).toBe('fail')
  })
  test('port not listening → warn; unknown port → skip; no probe → skip', () => {
    expect(checkWebhookBind('1234', parseListeners(ss)).status).toBe('warn')
    expect(checkWebhookBind(null, parseListeners(ss)).status).toBe('skip')
    expect(checkWebhookBind('8093', null).status).toBe('skip')
  })
})

describe('checkEnvFileMode — the token file must be private', () => {
  test('600 passes, 640 warns, 644 fails, unreadable skips', () => {
    expect(checkEnvFileMode(0o100600, '/e').status).toBe('pass')
    expect(checkEnvFileMode(0o100640, '/e').status).toBe('warn')
    expect(checkEnvFileMode(0o100644, '/e').status).toBe('fail')
    expect(checkEnvFileMode(null, '/e').status).toBe('skip')
  })
})

describe('checkSharedSettingsClean — invariant a outside --fleet', () => {
  test('channel markers in the user-level file → FAIL', () => {
    const c = checkSharedSettingsClean('{"hooks":{"Stop":[{"marker":"dashi-channel-hook"}]}}', false)
    expect(c.status).toBe('fail')
  })
  test('clean user-level file → pass; missing file → pass', () => {
    expect(checkSharedSettingsClean('{"theme":"dark"}', false).status).toBe('pass')
    expect(checkSharedSettingsClean(null, false).status).toBe('pass')
  })
  test('user-level file IS the inspected file → skip (legacy layout)', () => {
    expect(checkSharedSettingsClean('{"hooks":{"Stop":[{"marker":"dashi-channel-hook"}]}}', true).status).toBe('skip')
  })
})

describe('permission policy lint', () => {
  test('block-form confirm_overrides extracted', () => {
    const y = ['version: 1', 'confirm_overrides:', '  builtin_rules:', '    - "git push"', '    - sudo ', 'scopes: {}'].join('\n')
    expect(extractConfirmOverrides(y)).toEqual({ rules: ['git push', 'sudo'], opaque: false })
  })
  test('inline-form confirm_overrides extracted', () => {
    const y = 'confirm_overrides:\n  builtin_rules: ["git push", "rm -rf "]\n'
    expect(extractConfirmOverrides(y)).toEqual({ rules: ['git push', 'rm -rf '], opaque: false })
  })
  test('list items at the SAME indent as builtin_rules are read (review H1)', () => {
    const y = 'confirm_overrides:\n  builtin_rules:\n  - "sudo "\n'
    expect(extractConfirmOverrides(y).rules).toEqual(['sudo '])
  })
  test('trailing comment after an item does not corrupt the value (review H2)', () => {
    const y = 'confirm_overrides:\n  builtin_rules:\n    - "sudo " # owner-approved?\n    - git push # narrow\n'
    expect(extractConfirmOverrides(y).rules).toEqual(['sudo ', 'git push'])
  })
  test('inline list with a trailing comment still parses (review M1)', () => {
    const y = 'confirm_overrides:\n  builtin_rules: ["sudo "] # note\n'
    expect(extractConfirmOverrides(y).rules).toEqual(['sudo '])
  })
  test('flow-form confirm_overrides is OPAQUE → lint warns instead of passing (review M1)', () => {
    const y = 'confirm_overrides: { builtin_rules: ["sudo "] }\n'
    expect(extractConfirmOverrides(y).opaque).toBe(true)
    const c = checkPermissionPolicy(y, '/p').find((x) => x.id === 'permission-policy-risky-override')
    expect(c?.status).toBe('warn')
  })
  test('lifting sudo / rm -rf → WARN (ultra-autonomy, deliberate); lifting only git push → pass', () => {
    // 2026-06-10: warchief ultra-autonomy order downgraded this from FAIL to
    // WARN — sudo/rm-rf are overridable BUILTIN_CONFIRM rules (not hard-deny),
    // so lifting them is an eyes-open owner choice, still surfaced as a WARN.
    const bad = 'confirm_overrides:\n  builtin_rules:\n    - "sudo "\n'
    const badCheck = checkPermissionPolicy(bad, '/p').find((c) => c.id === 'permission-policy-risky-override')
    expect(badCheck?.status).toBe('warn')
    expect(badCheck?.detail).toContain('sudo ')
    const ok = 'confirm_overrides:\n  builtin_rules:\n    - "git push"\n'
    expect(checkPermissionPolicy(ok, '/p').find((c) => c.id === 'permission-policy-risky-override')?.status).toBe('pass')
  })
  test('lifting pipe-interpreter / git-exec-surface → WARN (opt-in detectors, owner decision 2026-10-17)', () => {
    for (const name of ['pipe-interpreter', 'git-exec-surface']) {
      const y = `confirm_overrides:\n  builtin_rules:\n    - "${name}"\n`
      const c = checkPermissionPolicy(y, '/p').find((x) => x.id === 'permission-policy-risky-override')
      expect(c?.status).toBe('warn')
      expect(c?.detail).toContain(name)
      expect(c?.detail).toContain('ALLOWLISTED SIMPLE commands only')
      expect(c?.detail).toContain('force push')
    }
    // Lifting only sudo does not print the detector note.
    const s = checkPermissionPolicy('confirm_overrides:\n  builtin_rules:\n    - "sudo "\n', '/p').find((x) => x.id === 'permission-policy-risky-override')
    expect(s?.detail).not.toContain('ALLOWLISTED SIMPLE commands only')
  })
  test('default_tier allow → warn; confirm → pass; unset → pass', () => {
    expect(checkPermissionPolicy('default_tier: allow\n', '/p').find((c) => c.id === 'permission-policy-default-tier')?.status).toBe('warn')
    expect(checkPermissionPolicy('default_tier: confirm\n', '/p').find((c) => c.id === 'permission-policy-default-tier')?.status).toBe('pass')
    expect(checkPermissionPolicy('version: 1\n', '/p').find((c) => c.id === 'permission-policy-default-tier')?.status).toBe('pass')
  })
  test('empty policy file → warn; unreadable → skip', () => {
    expect(checkPermissionPolicy('  \n', '/p')[0]?.status).toBe('warn')
    expect(checkPermissionPolicy(null, '/p')[0]?.status).toBe('skip')
  })
  test('extractTopLevelScalar ignores indented and commented keys', () => {
    expect(extractTopLevelScalar('  default_tier: allow\n', 'default_tier')).toBeNull()
    expect(extractTopLevelScalar('default_tier: confirm # note\n', 'default_tier')).toBe('confirm')
  })
})

describe('multichat lint', () => {
  const policy = [
    'version: 1',
    'allowlist:',
    '  chats:',
    '    - "164795011"',
    'chats:',
    '  "164795011":',
    '    mode: private',
    '    tmux_mirror: true',
    '  "-1003784643974":',
    '    mode: public',
    '    tmux_mirror: false',
  ].join('\n')
  test('extractChatPolicies reads mode and tmux_mirror per chat', () => {
    const p = extractChatPolicies(policy)
    expect(p).toHaveLength(2)
    expect(p[0]).toEqual({ id: '164795011', mode: 'private', tmuxMirror: true })
    expect(p[1]).toEqual({ id: '-1003784643974', mode: 'public', tmuxMirror: false })
  })
  test('DM mirror + public no-mirror → pass', () => {
    expect(checkMultichatMirror(extractChatPolicies(policy)).status).toBe('pass')
  })
  test('public chat with tmux_mirror=true → FAIL (kitchen leaks into a group)', () => {
    const bad = policy.replace('    mode: public\n    tmux_mirror: false', '    mode: public\n    tmux_mirror: true')
    const c = checkMultichatMirror(extractChatPolicies(bad))
    expect(c.status).toBe('fail')
    expect(c.detail).toContain('-1003784643974')
  })
  test('chat dir without a policy entry → warn', () => {
    const c = checkMultichatDirs(['164795011'], ['164795011', '-2000'])
    expect(c.status).toBe('warn')
    expect(c.detail).toContain('-2000')
  })
  test('all dirs covered → pass', () => {
    expect(checkMultichatDirs(['164795011', '-2000'], ['164795011']).status).toBe('pass')
  })
  test('spawn-chat-shell: TMUX_PANE forwarded → pass, absent → FAIL, missing file → skip', () => {
    expect(checkSpawnChatShell('env -i TMUX_PANE="${TMUX_PANE:-}" bash').status).toBe('pass')
    expect(checkSpawnChatShell('env -i bash').status).toBe('fail')
    expect(checkSpawnChatShell(null).status).toBe('skip')
  })
})

describe('parseUnitFile — autodetect fields', () => {
  const unit = [
    '[Service]',
    'EnvironmentFile=/srv/thrall/private/channel.env',
    'WorkingDirectory=/srv/thrall/.claude/jc/plugin',
    `ExecStart=/usr/bin/tmux -L channel-thrall new-session -d -s channel-thrall 'claude --model fable --permission-mode bypassPermissions server:dashi-channel'`,
    `ExecStop=/usr/bin/tmux -L channel-thrall kill-session -t channel-thrall`,
  ].join('\n')
  test('reads WorkingDirectory, session name and bypassPermissions', () => {
    const p = parseUnitFile(unit)
    expect(p.workingDirectory).toBe('/srv/thrall/.claude/jc/plugin')
    expect(p.sessionName).toBe('channel-thrall')
    expect(p.bypassPermissions).toBe(true)
    expect(p.sockets).toEqual(['channel-thrall'])
  })
  test('no bypass flag → false; no -s → null session', () => {
    const p = parseUnitFile("ExecStart=/usr/bin/tmux new-session -d 'claude server:x'")
    expect(p.bypassPermissions).toBe(false)
    expect(p.sessionName).toBeNull()
  })
  test('session name is read from tmux argv, not from the quoted payload', () => {
    const p = parseUnitFile(`ExecStart=/usr/bin/tmux new-session -d -s real 'claude -s fake server:x'`)
    expect(p.sessionName).toBe('real')
  })
})

describe('matchAgentForPlugin', () => {
  const agent = (name: string, wd: string | null, ws: string | null): FleetAgent => ({
    name,
    unitPath: `/etc/systemd/system/channel-${name}.service`,
    sockets: [`channel-${name}`],
    envPath: null,
    envReadable: false,
    port: null,
    tokenDigest: null,
    stateDir: null,
    workspaceRoot: ws,
    webhookEnabled: null,
    hookPorts: [],
    settingsPath: null,
    workingDirectory: wd,
    sessionName: `channel-${name}`,
    bypassPermissions: false,
    gateEnabled: null,
    gateHookRegistered: false,
  })
  test('matches by WorkingDirectory first', () => {
    const a = matchAgentForPlugin([agent('arthas', '/srv/a/plugin', null), agent('thrall', '/srv/t/plugin', null)], '/srv/t/plugin')
    expect(a?.name).toBe('thrall')
  })
  test('falls back to workspace root containment', () => {
    const a = matchAgentForPlugin([agent('thrall', null, '/srv/t/.claude')], '/srv/t/.claude/jc/plugin')
    expect(a?.name).toBe('thrall')
  })
  test('no match → null (no cross-agent false positive)', () => {
    expect(matchAgentForPlugin([agent('arthas', '/srv/a/plugin', '/srv/a/.claude')], '/srv/t/plugin')).toBeNull()
  })
})

describe('resolveEffectivePluginDir — autodetect adopts the unit WorkingDirectory (2026-06-10 self-FP)', () => {
  // Running doctor from the repo root (cwd != the plugin/ the session runs in)
  // resolved settings to user-level and false-FAILed the gate. When autodetect
  // matched a unit whose WorkingDirectory is the real plugin checkout, trust it.
  const hasDotClaude = (p: string) => p === join('/srv/t/jc/plugin', '.claude')
  test('non-explicit + unit WorkingDirectory with .claude/ → adopt the unit dir', () => {
    expect(resolveEffectivePluginDir('/srv/t/jc', false, '/srv/t/jc/plugin', hasDotClaude)).toBe('/srv/t/jc/plugin')
  })
  test('explicit --plugin-dir is never overridden', () => {
    expect(resolveEffectivePluginDir('/srv/t/jc', true, '/srv/t/jc/plugin', hasDotClaude)).toBe('/srv/t/jc')
  })
  test('unit dir without a .claude/ is not adopted (not a real checkout)', () => {
    expect(resolveEffectivePluginDir('/srv/t/jc', false, '/srv/t/other', hasDotClaude)).toBe('/srv/t/jc')
  })
  test('no unit WorkingDirectory → keep the cwd plugin dir', () => {
    expect(resolveEffectivePluginDir('/srv/t/jc', false, null, hasDotClaude)).toBe('/srv/t/jc')
  })
})

// ---------------------------------------------------------------------------
// Review-round fixes (Codex + Fable double review, 2026-06-09)
// ---------------------------------------------------------------------------

describe('review fixes — bind, env mode, mirror, stop hook, envValue, redact', () => {
  test('[::ffff:127.0.0.1] v4-mapped loopback PASSES webhook-bind (review M4)', () => {
    expect(checkWebhookBind('8093', [{ addr: '[::ffff:127.0.0.1]', port: '8093' }]).status).toBe('pass')
  })
  test('env mode: other-write/other-exec FAIL, group-write FAIL (Codex High)', () => {
    expect(checkEnvFileMode(0o100602, '/e').status).toBe('fail') // other-write
    expect(checkEnvFileMode(0o100601, '/e').status).toBe('fail') // other-exec
    expect(checkEnvFileMode(0o100620, '/e').status).toBe('fail') // group-write
    expect(checkEnvFileMode(0o100640, '/e').status).toBe('warn') // group-read only
    expect(checkEnvFileMode(0o100600, '/e').status).toBe('pass')
  })
  test('group chat (negative id) with mirror and NO explicit private mode → FAIL (Codex M)', () => {
    expect(checkMultichatMirror([{ id: '-100123', mode: null, tmuxMirror: true }]).status).toBe('fail')
    expect(checkMultichatMirror([{ id: '-100123', mode: 'privte', tmuxMirror: true }]).status).toBe('fail') // typo ≠ private
    expect(checkMultichatMirror([{ id: '164795011', mode: null, tmuxMirror: true }]).status).toBe('pass') // positive id = DM
  })
  test('mirror profile: fallback-only Stop does NOT satisfy the primary Stop hook (Codex M)', () => {
    const fallbackOnly = { hooks: { Stop: [hookEntry('dashi-channel-fallback-reply')] } }
    const c = checkSettingsHooks(fallbackOnly, 'mirror').find((x) => x.id === 'hook-Stop')
    expect(c?.status).toBe('warn')
    expect(c?.detail).toContain('fallback')
  })
  test('envValue strips quotes, export and trailing comments (review M3)', () => {
    expect(envValue('TELEGRAM_WEBHOOK_PORT="8093"', 'TELEGRAM_WEBHOOK_PORT')).toBe('8093')
    expect(envValue("export TELEGRAM_STATE_DIR='/srv/state' # note", 'TELEGRAM_STATE_DIR')).toBe('/srv/state')
  })
  test('redact keeps 0.0.0.0 and 127.0.0.1 visible (interface literals, review L3)', () => {
    expect(redact('port 8091 bound to 0.0.0.0')).toContain('0.0.0.0')
    expect(redact('bound to 127.0.0.1')).toContain('127.0.0.1')
    expect(redact('server at 100.104.191.127')).toContain('<ip>')
  })
  test('shared-settings markers: generic post-hook.ts alone no longer FAILS (review L2)', () => {
    expect(checkSharedSettingsClean('{"hooks":{"Stop":[{"command":"bun my-post-hook.ts"}]}}', false).status).toBe('pass')
    expect(checkSharedSettingsClean('{"hooks":{"Stop":[{"marker":"dashi-channel-fallback-reply"}]}}', false).status).toBe('fail')
  })
  test('spawn-chat-shell: TMUX_PANE only in a comment does NOT pass (Codex M)', () => {
    expect(checkSpawnChatShell('# we forward TMUX_PANE here\nenv -i bash').status).toBe('fail')
    expect(checkSpawnChatShell('env -i TMUX_PANE="${TMUX_PANE:-}" bash').status).toBe('pass')
  })
})

describe('extractChatPolicies — bleed hardening (review M2)', () => {
  test('block scalar content cannot rewrite the chat policy', () => {
    const y = [
      'chats:',
      '  "-100200":',
      '    mode: public',
      '    tmux_mirror: false',
      '    system_reminder: |',
      '      mode: private',
      '      tmux_mirror: true',
    ].join('\n')
    expect(extractChatPolicies(y)).toEqual([{ id: '-100200', mode: 'public', tmuxMirror: false }])
  })
  test('non-numeric sibling key (default template) closes the chat — no attribution bleed', () => {
    const y = [
      'chats:',
      '  "-100200":',
      '    mode: public',
      '    tmux_mirror: false',
      '  default:',
      '    mode: private',
      '    tmux_mirror: true',
    ].join('\n')
    expect(extractChatPolicies(y)).toEqual([{ id: '-100200', mode: 'public', tmuxMirror: false }])
  })
  test('deeper-nested mode under a sub-map is ignored (exact property indent only)', () => {
    const y = ['chats:', '  "-100200":', '    delivery: final_only', '    sub:', '      mode: private', '    tmux_mirror: false'].join('\n')
    const p = extractChatPolicies(y)
    expect(p[0]?.mode).toBeNull()
    expect(p[0]?.tmuxMirror).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Permission-gate HARDENING (2026-06-10). The gate is the SOLE confirm path
// under bypassPermissions; the Silvana incident shipped a bypass session with
// NO gate hook and the doctor only SKIPPED. These tests lock the class of
// failure so it can never ship undetected again.
// ---------------------------------------------------------------------------

describe('checkPermissionGate — incident lock (no gate under bypass = FAIL, not skip)', () => {
  const settingsNoGate = { hooks: { PreToolUse: [hookEntry('dashi-channel-hook')] } }

  test('no gate hook BUT unit runs bypassPermissions → FAIL (the Silvana incident)', () => {
    const checks = checkPermissionGate(settingsNoGate, existsSync0, /*unitBypass*/ true)
    const gate = checks.find((c) => c.id === 'permission-gate')
    expect(gate?.status).toBe('fail')
    expect(gate?.detail.toLowerCase()).toContain('bypass')
  })

  test('no gate hook BUT permission_gate.enabled=true in state config → FAIL', () => {
    const checks = checkPermissionGate(settingsNoGate, existsSync0, /*unitBypass*/ null, /*gateEnabled*/ true)
    expect(checks.find((c) => c.id === 'permission-gate')?.status).toBe('fail')
  })

  test('no gate hook, no bypass, gate disabled → skip (negative control, feature genuinely off)', () => {
    const checks = checkPermissionGate(settingsNoGate, existsSync0, /*unitBypass*/ false, /*gateEnabled*/ false)
    expect(checks).toHaveLength(1)
    expect(checks[0]!.status).toBe('skip')
  })

  test('no gate hook, host unknown (unitBypass=null, gateEnabled=null) → skip (do not over-fail)', () => {
    const checks = checkPermissionGate(settingsNoGate, existsSync0, /*unitBypass*/ null, /*gateEnabled*/ null)
    expect(checks.find((c) => c.id === 'permission-gate')?.status).toBe('skip')
  })
})

describe('checkPermissionGate — config↔hook mismatch (fails closed to DENY)', () => {
  const gate = { marker: 'dashi-permission-gate-hook', hooks: [{ type: 'command', command: "bun '/p/scripts/permission-gate-hook.ts'" }] }
  const ask = { marker: 'dashi-ask-user-question-hook', hooks: [{ type: 'command', command: "bun '/p/scripts/ask-user-question-hook.ts'" }] }

  test('gate hook present but permission_gate.enabled=false → config-match FAIL (503 = DENY)', () => {
    const checks = checkPermissionGate({ hooks: { PreToolUse: [gate, ask] } }, existsSync0, true, /*gateEnabled*/ false)
    const m = checks.find((c) => c.id === 'permission-gate-config-match')
    expect(m?.status).toBe('fail')
    expect(m?.detail).toContain('503')
  })

  test('gate hook present and permission_gate.enabled=true → config-match pass', () => {
    const checks = checkPermissionGate({ hooks: { PreToolUse: [gate, ask] } }, existsSync0, true, /*gateEnabled*/ true)
    expect(checks.find((c) => c.id === 'permission-gate-config-match')?.status).toBe('pass')
  })

  test('gate hook present, gateEnabled unknown (null) → config-match warn', () => {
    const checks = checkPermissionGate({ hooks: { PreToolUse: [gate, ask] } }, existsSync0, true, /*gateEnabled*/ null)
    expect(checks.find((c) => c.id === 'permission-gate-config-match')?.status).toBe('warn')
  })

  test('ask hook present but ask_user_question.enabled=false → ask-config-match FAIL', () => {
    const checks = checkPermissionGate({ hooks: { PreToolUse: [gate, ask] } }, existsSync0, true, true, /*askEnabled*/ false)
    expect(checks.find((c) => c.id === 'permission-gate-ask-config-match')?.status).toBe('fail')
  })

  test('ask enabled + bypass but NO ask hook → ask-config-match FAIL (question wedges the pane)', () => {
    const checks = checkPermissionGate({ hooks: { PreToolUse: [gate] } }, existsSync0, true, true, /*askEnabled*/ true)
    expect(checks.find((c) => c.id === 'permission-gate-ask-config-match')?.status).toBe('fail')
  })

  test('ask enabled + ask hook present → ask-config-match pass', () => {
    const checks = checkPermissionGate({ hooks: { PreToolUse: [gate, ask] } }, existsSync0, true, true, /*askEnabled*/ true)
    expect(checks.find((c) => c.id === 'permission-gate-ask-config-match')?.status).toBe('pass')
  })
})

describe('checkPermissionEndpoint — SAFE liveness probe (never POSTs the real route)', () => {
  const listening = [{ addr: '127.0.0.1', port: '8093' }]
  const ok = (_url: string) => ({ code: 200 })
  const refused = (_url: string) => null
  const unhealthy = (_url: string) => ({ code: 503 })

  test('gate not required → skip', () => {
    const c = checkPermissionEndpoint(false, '8093', listening, ok)
    expect(c.status).toBe('skip')
  })

  test('gate required + nothing listening on the port → FAIL', () => {
    const c = checkPermissionEndpoint(true, '8093', [], ok)
    expect(c.status).toBe('fail')
  })

  test('gate required + listener up + /health 200 → pass', () => {
    const c = checkPermissionEndpoint(true, '8093', listening, ok)
    expect(c.status).toBe('pass')
  })

  test('gate required + listener up + /health 503 → warn (up but unhealthy)', () => {
    const c = checkPermissionEndpoint(true, '8093', listening, unhealthy)
    expect(c.status).toBe('warn')
  })

  test('gate required + listener up + probe refused/error → warn', () => {
    const c = checkPermissionEndpoint(true, '8093', listening, refused)
    expect(c.status).toBe('warn')
  })

  test('gate required + socket up but no probe function → warn', () => {
    const c = checkPermissionEndpoint(true, '8093', listening, null)
    expect(c.status).toBe('warn')
  })

  test('gate required but listeners unknown (null) → skip (no probe available)', () => {
    const c = checkPermissionEndpoint(true, '8093', null, ok)
    expect(c.status).toBe('skip')
  })

  test('gate required but port unknown → skip', () => {
    const c = checkPermissionEndpoint(true, null, listening, ok)
    expect(c.status).toBe('skip')
  })
})

describe('fleet — Arthas-style bypass unit is detected as bypassPermissions:true', () => {
  for (const flag of ['--dangerously-skip-permissions', '--permission-mode=bypassPermissions', '--permission-mode bypassPermissions']) {
    test(`missing gate fails for launch flag ${flag}`, () => {
      const unit = parseUnitFile(`ExecStart=/usr/bin/tmux new-session -d 'claude ${flag}'`)
      const checks = checkPermissionGate({}, existsSync0, unit.bypassPermissions, false)
      expect(checks.find((c) => c.id === 'permission-gate')?.status).toBe('fail')
    })
  }

  test('an Arthas-style ExecStart yields bypassPermissions:true', () => {
    const unit = [
      '[Service]',
      'EnvironmentFile=/srv/arthas/private/channel.env',
      'WorkingDirectory=/srv/arthas/.claude/jc/plugin',
      `ExecStart=/usr/bin/tmux -L channel-arthas new-session -d -s channel-arthas 'claude --model sonnet --permission-mode bypassPermissions server:dashi-channel'`,
    ].join('\n')
    expect(parseUnitFile(unit).bypassPermissions).toBe(true)
  })
})

describe('checkFleet — every bypass agent has the gate enabled + hook registered', () => {
  const base = (name: string): FleetAgent => ({
    name,
    unitPath: `/etc/systemd/system/channel-${name}.service`,
    sockets: [`channel-${name}`],
    envPath: `/srv/${name}/channel.env`,
    envReadable: true,
    port: name === 'thrall' ? '8093' : '8103',
    tokenDigest: `digest-${name}`,
    stateDir: `/srv/${name}/state`,
    workspaceRoot: `/srv/${name}/ws`,
    webhookEnabled: true,
    hookPorts: [],
    settingsPath: `/srv/${name}/ws/.claude/settings.json`,
    workingDirectory: `/srv/${name}/.claude/jc/plugin`,
    sessionName: `channel-${name}`,
    bypassPermissions: true,
    gateEnabled: true,
    gateHookRegistered: true,
  })

  test('all bypass agents gate-enabled + hook-registered → fleet-gate pass', () => {
    const checks = checkFleet([base('thrall'), base('arthas')], null)
    expect(checks.find((c) => c.id === 'fleet-gate')?.status).toBe('pass')
  })

  test('a bypass agent missing the gate hook → fleet-gate FAIL (the Silvana incident, fleet-wide)', () => {
    const bad = { ...base('silvana'), gateHookRegistered: false }
    const checks = checkFleet([base('thrall'), bad], null)
    const fg = checks.find((c) => c.id === 'fleet-gate')
    expect(fg?.status).toBe('fail')
    expect(fg?.detail).toContain('silvana')
  })

  test('a bypass agent with gate hook but permission_gate.enabled=false → fleet-gate FAIL', () => {
    const bad = { ...base('silvana'), gateEnabled: false }
    const checks = checkFleet([base('thrall'), bad], null)
    expect(checks.find((c) => c.id === 'fleet-gate')?.status).toBe('fail')
  })

  test('non-bypass agents are exempt from the gate requirement', () => {
    const nonBypass = { ...base('garrosh'), bypassPermissions: false, gateEnabled: false, gateHookRegistered: false }
    const checks = checkFleet([base('thrall'), nonBypass], null)
    expect(checks.find((c) => c.id === 'fleet-gate')?.status).toBe('pass')
  })

  test('a bypass agent with gate hook but UNREADABLE config (gateEnabled=null) → fleet-gate WARN, not PASS (Codex review 2026-06-10)', () => {
    // Emitting PASS here would claim "enabled=true" for an agent whose config
    // we never read — against the incident-lock goal.
    const unknown = { ...base('silvana'), gateEnabled: null }
    const checks = checkFleet([base('thrall'), unknown], null)
    const fg = checks.find((c) => c.id === 'fleet-gate')
    expect(fg?.status).toBe('warn')
    expect(fg?.detail).toContain('silvana')
    expect(fg?.detail).toContain('unverified')
  })

  test('a known FAIL outranks an unverified config (fail beats warn)', () => {
    const unknown = { ...base('silvana'), gateEnabled: null }
    const missing = { ...base('kaelthas'), gateHookRegistered: false }
    const checks = checkFleet([base('thrall'), unknown, missing], null)
    expect(checks.find((c) => c.id === 'fleet-gate')?.status).toBe('fail')
  })
})


describe('plugin version provenance', () => {
  const files = (manifest: string | null = '1.4.2', pkg: string | null = manifest) =>
    (p: string): string | null => {
      const v = p === '/installed/.claude-plugin/plugin.json' ? manifest : p === '/installed/plugin/package.json' ? pkg : null
      return v === null ? null : JSON.stringify({ version: v })
    }
  test('uses the selected installed root, and never contacts upstream without opt-in', async () => {
    const r = await pluginVersionReport('/installed/plugin', false, files(), async () => { throw new Error('must not fetch') })
    expect(r.installed).toBe('1.4.2')
    expect(r.latest).toBe('UNKNOWN')
    expect(r.verdict).toBe('unknown')
    expect(versionCheck(r).detail).toContain('INSTALLED: 1.4.2')
    expect(versionCheck(r).fix).toContain('github.com/qwwiwi')
  })
  test('semantic comparison reports outdated and up to date with source and time', async () => {
    const r = await pluginVersionReport('/installed/plugin', true, files('1.9.0'), async () => ({ version: '1.10.0' }))
    expect(r.verdict).toBe('outdated')
    expect(r.source).toContain('raw.githubusercontent.com')
    expect(r.checkedAt).toMatch(/^\d{4}-/)
    expect((await pluginVersionReport('/installed/plugin', true, files(), async () => ({ version: '1.4.2' }))).verdict).toBe('up to date')
  })
  test('mismatch, missing manifest, malformed latest, failure and newer local version never claim current', async () => {
    const mismatch = await pluginVersionReport('/installed/plugin', true, files('1.4.2', '1.4.1'), async () => ({ version: '1.4.2' }))
    expect(versionCheck(mismatch).status).toBe('warn')
    expect(mismatch.verdict).toBe('unknown')
    expect((await pluginVersionReport(null, true, files(), async () => ({ version: '1.4.2' }))).installed).toBe('UNKNOWN')
    expect((await pluginVersionReport('/installed/plugin', true, files(null), async () => ({ version: '1.4.2' }))).verdict).toBe('unknown')
    for (const fetcher of [async () => ({ version: 'not a version' }), async () => { throw new Error('network unavailable') }]) {
      const r = await pluginVersionReport('/installed/plugin', true, files(), fetcher)
      expect(r.latest).toBe('UNKNOWN')
      expect(r.verdict).toBe('unknown')
    }
    expect((await pluginVersionReport('/installed/plugin', true, files('2.0.0'), async () => ({ version: '1.4.2' }))).verdict).toBe('unknown')
  })
})

// Settings-only bypass must never skip a missing security gate.
describe('checkPermissionGate — settings bypass regression', () => {
  test('missing gate fails when bypass is declared only in settings', () => {
    const checks = checkPermissionGate({ permissions: { defaultMode: 'bypassPermissions' } }, existsSync0, null, false)
    expect(checks.find((c) => c.id === 'permission-gate')?.status).toBe('fail')
  })
  test('launch bypass remains effective with another settings default', () => {
    const settings = { permissions: { defaultMode: 'default' }, hooks: { PreToolUse: [
      { marker: 'dashi-permission-gate-hook', hooks: [{ command: 'bun permission-gate-hook.ts' }] },
    ] } }
    expect(checkPermissionGate(settings, existsSync0, true, true).find((c) => c.id === 'permission-gate-mode')?.status).toBe('pass')
  })
})

describe('resolveDoctorConfig — runtime precedence', () => {
  const home = '/home/student'
  const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }
  for (const env of [
    'TELEGRAM_ASK_USER_QUESTION_ENABLED="on"',
    "TELEGRAM_ASK_USER_QUESTION_ENABLED='on'",
    'TELEGRAM_ALLOWED_CHAT_IDS=42 # private',
    'export TELEGRAM_ALLOWED_USER_IDS=42',
    ' TELEGRAM_ALLOWED_USER_IDS=42',
    'TELEGRAM_ALLOWED_USER_IDS=42 ',
    'TELEGRAM_CONFIG_FILE="/custom.json"',
    'TELEGRAM_STATE_DIR="/state"',
  ]) {
    test(`env loader syntax difference has incomplete coverage: ${env}`, () => {
      const result = resolveDoctorConfig(env, home, () => '{}')
      expect(result.check.status).toBe('warn')
      expect(result.config).toBeNull()
      expect(result.check.detail).toContain('incomplete coverage')
      expect(result.check.detail).toContain('env syntax')
    })
  }
  test('ordinary env assignments and standalone comments retain coverage', () => {
    const result = resolveDoctorConfig('# comment\n\nTELEGRAM_ALLOWED_USER_IDS=42\nTELEGRAM_ALLOWED_CHAT_IDS=42\n', home, missing)
    expect(result.check.status).toBe('pass')
    expect(result.config?.allowed_chat_ids).toEqual([42])
  })
  test('explicit config wins over state-dir and env overrides file', () => {
    const result = resolveDoctorConfig('TELEGRAM_CONFIG_FILE=/custom.json\nTELEGRAM_STATE_DIR=/state\nTELEGRAM_ALLOWED_USER_IDS=42\nTELEGRAM_WEBHOOK_PORT=9999\nTELEGRAM_ASK_USER_QUESTION_ENABLED=on', home,
      (path) => path === '/custom.json' ? JSON.stringify({ allowed_user_ids: [7], webhook: { enabled: true, port: 88 } }) : missing())
    expect(result.configPath).toBe('/custom.json')
    expect(result.config?.allowed_user_ids).toEqual([42])
    expect(result.config?.webhook).toMatchObject({ enabled: true, host: '127.0.0.1', port: 9999 })
    expect(result.config?.ask_user_question).toMatchObject({ enabled: true })
    expect(result.check.detail).toContain('TELEGRAM_CONFIG_FILE')
    expect(result.check.detail).toContain('TELEGRAM_WEBHOOK_PORT')
  })
  test('default state root and absent file apply runtime defaults', () => {
    const result = resolveDoctorConfig('', home, missing)
    expect(result.configPath).toBe('/home/student/.claude/channels/dashi-telegram-canary/config.json')
    expect(result.config?.allowed_user_ids).toEqual([164795011])
    expect(result.config?.task_mirror).toMatchObject({ enabled: true })
    expect(result.config?.tmux_mirror).toMatchObject({ enabled: false })
    expect(result.check.detail).toContain('defaults')
  })
  test('state-dir config is used when explicit config is absent', () => {
    const result = resolveDoctorConfig('TELEGRAM_STATE_DIR=/state', home, (path) => {
      expect(path).toBe('/state/config.json')
      return '{"permission_gate":{"enabled":true}}'
    })
    expect(result.config?.permission_gate).toMatchObject({ enabled: true })
  })
  for (const raw of ['[]', 'null', '{', '{"permission_gate":{"enabled":"false"}}']) {
    test(`invalid config has incomplete coverage: ${raw}`, () => {
      const result = resolveDoctorConfig('', home, () => raw)
      expect(result.config).toBeNull()
      expect(result.check.status).toBe('warn')
      expect(result.check.detail).toContain('incomplete coverage')
    })
  }
  test('unreadable file must not pass or reveal exception text', () => {
    const result = resolveDoctorConfig('', home, () => { throw new Error('private content') })
    expect(result.config).toBeNull()
    expect(result.check.status).toBe('warn')
    expect(result.check.detail).not.toContain('private content')
  })
  test('unknown env source does not claim defaults are effective', () => {
    expect(resolveDoctorConfig(null, home, missing).check.status).toBe('warn')
    expect(resolveDoctorConfig(null, home, missing).config).toBeNull()
  })
  test('empty env allowlist overrides file rather than falling back', () => {
    const result = resolveDoctorConfig('TELEGRAM_ALLOWED_CHAT_IDS=', home, () => '{"allowed_chat_ids":[42]}')
    expect(result.config?.allowed_chat_ids).toEqual([])
  })
  test('invalid env port or user list cannot give effective config PASS', () => {
    for (const env of ['TELEGRAM_WEBHOOK_PORT=bad', 'TELEGRAM_ALLOWED_USER_IDS=-42']) {
      expect(resolveDoctorConfig(env, home, missing).check.status).toBe('warn')
    }
  })
})

describe('current installer hook contract', () => {
  const installed = applyPatch({ hooks: { Stop: [{ marker: 'dashi-channel-fallback-reply', hooks: [{ type: 'command', command: 'bun fallback-reply.ts' }] }] } }, { settingsPath: '/settings.json', chatId: '42', webhookUrl: 'http://127.0.0.1:8089/hooks/agent', helperPath: '/post-hook.ts', reminderHelperPath: '/channel-reminder.ts' })
  test('canonical current install passes without removed PreToolUse feeder', () => {
    const checks = checkSettingsHooks(installed, 'mirror')
    expect(checks.filter((c) => c.status === 'warn' || c.status === 'fail')).toEqual([])
    expect(checks.some((c) => c.id === 'hook-PreToolUse')).toBe(false)
  })
  test('missing SessionEnd is detected even in mirror profile', () => {
    expect(checkSettingsHooks({ ...installed, hooks: { ...installed.hooks, SessionEnd: [] } }, 'mirror').find((c) => c.id === 'hook-SessionEnd')?.status).toBe('warn')
  })
  test('unscoped task feeder warns', () => {
    const broad = { hooks: { ...installed.hooks, PostToolUse: [{ ...hookEntry('dashi-channel-hook'), matcher: '.*' }] } }
    expect(checkSettingsHooks(broad).find((c) => c.id === 'hook-PostToolUse')?.status).toBe('warn')
  })
  test('reminder needs its own marker and helper command', () => {
    for (const entry of [hookEntry('dashi-channel-hook'), hookEntry('dashi-channel-reminder-hook')]) {
      const broken = { hooks: { ...installed.hooks, UserPromptSubmit: [entry] } }
      expect(checkSettingsHooks(broken).find((c) => c.id === 'channel-reminder-hook')?.status).toBe('warn')
    }
  })
})

describe('Mirror diagnostics', () => {
  const installed = applyPatch({}, { settingsPath: '/s', chatId: '42', webhookUrl: 'http://127.0.0.1:8089/hooks/agent', helperPath: '/post-hook.ts', reminderHelperPath: '/channel-reminder.ts' })
  const config = { allowed_chat_ids: [42], tmux_mirror: { enabled: true }, task_mirror: { enabled: true }, hud: { enabled: true }, multichat: { enabled: false } }
  test('configured target DM and complete hooks describe expected Telegram view', () => {
    const checks = checkMirror(config, installed, '42')
    expect(checks.find((c) => c.id === 'mirror-hooks')?.detail).toContain('yes')
    const terminal = checks.find((c) => c.id === 'mirror-terminal')
    expect(terminal?.status).toBe('pass')
    expect(terminal?.detail).toContain('tmux_mirror.enabled=true')
    expect(terminal?.detail).toContain('/mirror on')
    const text = renderReport(checks)
    expect(text).toContain('Mirror')
    expect(text).toContain('pinned')
    expect(text).toContain('delivery unverified')
  })
  test('mirror off gives config prerequisite, not just on command', () => {
    const check = checkMirror({ ...config, tmux_mirror: { enabled: false } }, installed, '42').find((c) => c.id === 'mirror-terminal')
    expect(check?.status).toBe('warn')
    expect(check?.fix).toContain('tmux_mirror.enabled=true')
    expect(check?.fix).toContain('external operator')
  })
  test('another allowed DM is not the runtime mirror target', () => {
    const check = checkMirror({ ...config, allowed_chat_ids: [7, 42] }, installed, '42').find((c) => c.id === 'mirror-terminal')
    expect(check?.status).toBe('warn')
    expect(check?.detail).toContain('allowed_chat_ids[0]')
  })
  test('group mirror is not reported enabled for a private chat', () => {
    expect(checkMirror({ ...config, allowed_chat_ids: [-100] }, installed, '-100').find((c) => c.id === 'mirror-terminal')?.status).toBe('warn')
  })
  test('multichat policy unverified must not claim enabled for DM', () => {
    expect(checkMirror({ ...config, multichat: { enabled: true } }, installed, '42').find((c) => c.id === 'mirror-terminal')?.status).toBe('warn')
  })
  test('missing config and hooks are visibly incomplete', () => {
    const checks = checkMirror(null, null, '42')
    expect(checks.find((c) => c.id === 'mirror-hooks')?.status).toBe('warn')
    expect(checks.find((c) => c.id === 'mirror-terminal')?.status).toBe('warn')
  })
})

describe('DM allowlist inference', () => {
  test('user without --chat must be in chat allowlist too', () => {
    const checks = checkAllowlist('TELEGRAM_ALLOWED_USER_IDS=42\nTELEGRAM_ALLOWED_CHAT_IDS=7', '42')
    expect(checks.find((c) => c.id === 'allowlist-chat')?.status).toBe('fail')
  })
  test('matching DM passes', () => {
    expect(checkAllowlist('TELEGRAM_ALLOWED_USER_IDS=42\nTELEGRAM_ALLOWED_CHAT_IDS=42', '42').every((c) => c.status === 'pass')).toBe(true)
  })
  test('explicit group chat overrides inferred DM id', () => {
    expect(checkAllowlist('TELEGRAM_ALLOWED_USER_IDS=42\nTELEGRAM_ALLOWED_CHAT_IDS=-100', '42', '-100').every((c) => c.status === 'pass')).toBe(true)
  })
})

describe('documented diagnostic invocation', () => {
  const skillDir = resolve(import.meta.dir, '..')
  const repoDir = resolve(skillDir, '../..')
  test('skill resolves doctor from its own absolute directory and works outside checkout', () => {
    const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
    expect(skill).toContain('doctor_skill_dir="/absolute/path/to/skills/doctor-dashi-plugin"')
    const command = skill.match(/bun "\$doctor_skill_dir\/scripts\/doctor.ts"/)
    expect(command).not.toBeNull()
    const result = spawnSync(process.execPath, [join(skillDir, 'scripts/doctor.ts'), '--help'], { cwd: '/tmp', encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--check-latest')
  })
  test('README doctor command resolves after cd plugin', () => {
    const readme = readFileSync(join(repoDir, 'README.ru.md'), 'utf8')
    const script = readme.match(/bun ([^\s]+doctor\.ts) --plugin-dir "\$PWD"/)?.[1]
    expect(script).toBeDefined()
    expect(existsSync(resolve(repoDir, 'plugin', script ?? 'missing'))).toBe(true)
  })
})

describe('config paths belong to runtime CWD', () => {
  test('relative explicit file resolves from plugin runtime, not diagnostic CWD', () => {
    const result = resolveDoctorConfig('TELEGRAM_CONFIG_FILE=state/custom.json', '/home/student', (path) => {
      expect(path).toBe('/runtime/plugin/state/custom.json')
      return '{}'
    }, '/runtime/plugin')
    expect(result.configPath).toBe('/runtime/plugin/state/custom.json')
    expect(result.check.status).toBe('pass')
  })
  test('relative state root resolves from plugin runtime', () => {
    const result = resolveDoctorConfig('TELEGRAM_STATE_DIR=../state', '/home/student', (path) => {
      expect(path).toBe('/runtime/state/config.json')
      return '{}'
    }, '/runtime/plugin')
    expect(result.stateDir).toBe('/runtime/state')
    expect(result.check.status).toBe('pass')
  })
  test('valid env flag overrides invalid file flag before validation, like runtime', () => {
    const result = resolveDoctorConfig('TELEGRAM_ASK_USER_QUESTION_ENABLED=off', '/home/student', () => '{"ask_user_question":{"enabled":"wrong"}}')
    expect(result.config?.ask_user_question).toMatchObject({ enabled: false })
    expect(result.check.status).toBe('pass')
  })
})

describe('effective config access edge cases', () => {
  for (const { chats, status } of [
    { chats: ['42,43'], status: 'fail' },
    { chats: [' 42 '], status: 'fail' },
    { chats: [42], status: 'pass' },
    { chats: ['42'], status: 'pass' },
    { chats: [], status: 'fail' },
  ]) {
    test(`CLI compares original chat elements for DM: ${JSON.stringify(chats)}`, () => {
      const fixture = mkdtempSync(join(tmpdir(), 'doctor-allowlist-'))
      try {
        writeFileSync(join(fixture, 'config.json'), JSON.stringify({ allowed_user_ids: [42], allowed_chat_ids: chats }))
        writeFileSync(join(fixture, 'channel.env'), 'TELEGRAM_CONFIG_FILE=config.json')
        writeFileSync(join(fixture, 'settings.json'), '{}')
        const result = spawnSync(process.execPath, [join(import.meta.dir, 'doctor.ts'),
          '--json', '--no-autodetect', '--plugin-dir', fixture,
          '--env', join(fixture, 'channel.env'), '--settings', join(fixture, 'settings.json'), '--user', '42',
        ], { encoding: 'utf8', env: { ...process.env, HOME: fixture, PATH: fixture } })
        const report = JSON.parse(result.stdout) as { checks: Check[] }
        expect(report.checks.find((c) => c.id === 'config-source')?.status).toBe('pass')
        expect(report.checks.find((c) => c.id === 'allowlist-user')?.status).toBe('pass')
        expect(report.checks.find((c) => c.id === 'allowlist-chat')?.status).toBe(status)
      } finally {
        rmSync(fixture, { recursive: true, force: true })
      }
    })
  }

  test('explicit empty chat allowlist blocks known DM rather than using defaults', () => {
    const check = checkAllowlist('TELEGRAM_ALLOWED_USER_IDS=42\nTELEGRAM_ALLOWED_CHAT_IDS=', '42').find((c) => c.id === 'allowlist-chat')
    expect(check?.status).toBe('fail')
    expect(check?.detail).not.toContain('default applies')
  })
  test('duplicate assignments are ambiguous without knowing the env loader', () => {
    const result = resolveDoctorConfig('TELEGRAM_ALLOWED_USER_IDS=42\nTELEGRAM_ALLOWED_CHAT_IDS=42\nTELEGRAM_ALLOWED_CHAT_IDS=7', '/home/student', () => '{}')
    expect(result.check.status).toBe('warn')
    expect(result.config).toBeNull()
    expect(result.check.detail).toContain('duplicate env assignments')
  })
  test('duplicate explicit config paths cannot silently select the wrong security config', () => {
    const result = resolveDoctorConfig('TELEGRAM_CONFIG_FILE=/a\nTELEGRAM_CONFIG_FILE=/b', '/home/student', () => '{}')
    expect(result.config).toBeNull()
    expect(result.check.detail).toContain('duplicate env assignments')
  })
})
