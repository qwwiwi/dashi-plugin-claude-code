import { describe, expect, test } from 'bun:test'
import {
  checkAllowlist,
  checkCommsConsistency,
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
  findEnclosingClaudeMd,
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
} from './doctor.ts'

/** A settings hook entry with a runnable command (what install-hooks writes). */
const hookEntry = (marker: string) => ({ marker, hooks: [{ type: 'command', command: "bun 'scripts/post-hook.ts'" }] })

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
    expect(checkVersion('b', 'bun', '1.3.13', MIN_BUN).status).toBe('fail')
    expect(checkVersion('b', 'bun', '1.3.14', MIN_BUN).status).toBe('pass')
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
      UserPromptSubmit: [hookEntry('dashi-channel-hook')],
      PreToolUse: [{ ...hookEntry('dashi-channel-hook'), matcher: '.*' }],
      PostToolUse: [{ ...hookEntry('dashi-channel-hook'), matcher: '.*' }],
      Stop: [hookEntry('dashi-channel-hook'), hookEntry('dashi-channel-fallback-reply')],
    },
  }

  test('all five events present → pass, fallback present → pass', () => {
    const checks = checkSettingsHooks(good)
    const byId = Object.fromEntries(checks.map((c) => [c.id, c.status]))
    expect(byId['settings-no-token']).toBe('pass')
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
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

  test('no fallback hook → warn', () => {
    const noFallback = { hooks: { ...good.hooks, Stop: [hookEntry('dashi-channel-hook')] } }
    expect(checkSettingsHooks(noFallback).find((c) => c.id === 'fallback-reply-hook')?.status).toBe('warn')
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
  test('empty user allowlist → warn', () => {
    expect(checkAllowlist('TELEGRAM_ALLOWED_USER_IDS=', '42')[0]?.status).toBe('warn')
  })
  test('chat list present and chat id missing → fail', () => {
    const c = checkAllowlist('TELEGRAM_ALLOWED_USER_IDS=42\nTELEGRAM_ALLOWED_CHAT_IDS=-100123', '42', '-100999')
    expect(c.find((x) => x.id === 'allowlist-chat')?.status).toBe('fail')
  })
  test('user-only DM setup → no chat check emitted', () => {
    const c = checkAllowlist('TELEGRAM_ALLOWED_USER_IDS=42', '42')
    expect(c.find((x) => x.id === 'allowlist-chat')).toBeUndefined()
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
