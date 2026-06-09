// Phase 7 / T6 — install-hooks.sh + patch-claude-settings.ts.
// Drives the real shell script against a temp settings.json so the end-to-end
// flow is exercised.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'

import { applyPatch } from '../../scripts/patch-claude-settings.js'

const PLUGIN_DIR = join(import.meta.dir, '..', '..')
const INSTALL_SH = join(PLUGIN_DIR, 'scripts', 'install-hooks.sh')
const POST_HOOK = join(PLUGIN_DIR, 'scripts', 'post-hook.ts')

let tmp: string
let settings: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dashi-install-hooks-'))
  settings = join(tmp, 'settings.json')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function readJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>
}

function runInstall(extraArgs: string[] = []): { code: number; stderr: string } {
  // The install script invokes `bun` to run patch-claude-settings.ts. In some
  // test runners `~/.bun/bin` is not on PATH, so prepend it explicitly. We
  // also accept BUN_INSTALL_BIN override for CI.
  const bunBin =
    process.env.BUN_INSTALL_BIN ?? join(process.env.HOME ?? '', '.bun', 'bin')
  const pathPrefix = `${bunBin}:${process.env.PATH ?? ''}`
  const r = spawnSync(
    'bash',
    [
      INSTALL_SH,
      '--settings', settings,
      '--chat-id', '164795011',
      '--webhook-url', 'http://127.0.0.1:8089/hooks/agent',
      '--agent-id', 'dashi-channel',
      ...extraArgs,
    ],
    { encoding: 'utf8', env: { ...process.env, PATH: pathPrefix } },
  )
  return { code: r.status ?? -1, stderr: r.stderr }
}

describe('install-hooks.sh — fresh settings file', () => {
  test('creates hooks for all five events', () => {
    const r = runInstall()
    expect(r.code).toBe(0)
    const parsed = readJson()
    const flat = JSON.stringify(parsed)
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
      expect(flat).toContain(ev)
    }
    expect(flat).toContain(POST_HOOK)
    expect(flat).toContain("TELEGRAM_HOOK_CHAT_ID='164795011'")
    expect(flat).toContain("TELEGRAM_HOOK_AGENT_ID='dashi-channel'")
  })

  test('never writes TELEGRAM_WEBHOOK_TOKEN', () => {
    runInstall()
    const raw = readFileSync(settings, 'utf8')
    expect(raw).not.toContain('TELEGRAM_WEBHOOK_TOKEN')
  })

  test('matchers present on PreToolUse and PostToolUse only', () => {
    runInstall()
    const parsed = readJson() as {
      hooks?: Record<string, Array<{ matcher?: string }>>
    }
    expect(parsed.hooks?.PreToolUse?.[0]?.matcher).toBe('.*')
    expect(parsed.hooks?.PostToolUse?.[0]?.matcher).toBe('.*')
    expect(parsed.hooks?.SessionStart?.[0]?.matcher).toBeUndefined()
    expect(parsed.hooks?.Stop?.[0]?.matcher).toBeUndefined()
  })
})

describe('install-hooks.sh — URL validation (L3)', () => {
  function runWithUrl(badUrl: string): { code: number; stderr: string } {
    const bunBin =
      process.env.BUN_INSTALL_BIN ?? join(process.env.HOME ?? '', '.bun', 'bin')
    const pathPrefix = `${bunBin}:${process.env.PATH ?? ''}`
    const r = spawnSync(
      'bash',
      [
        INSTALL_SH,
        '--settings', settings,
        '--chat-id', '164795011',
        '--webhook-url', badUrl,
        '--agent-id', 'dashi-channel',
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: pathPrefix } },
    )
    return { code: r.status ?? -1, stderr: r.stderr }
  }

  test('rejects file:// scheme without writing settings', async () => {
    const r = runWithUrl('file:///etc/passwd')
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('http://')
    const { existsSync } = await import('fs')
    expect(existsSync(settings)).toBe(false)
  })

  test('rejects javascript: scheme', () => {
    const r = runWithUrl('javascript:alert(1)')
    expect(r.code).not.toBe(0)
  })

  test('accepts http:// and https:// schemes', () => {
    expect(runWithUrl('http://127.0.0.1:8089/hooks/agent').code).toBe(0)
    // Reset settings between runs (idempotent install is fine, but a fresh
    // file is clearer).
    rmSync(settings, { force: true })
    expect(runWithUrl('https://example.com/hooks/agent').code).toBe(0)
  })
})

describe('install-hooks.sh — idempotency', () => {
  test('second run does not duplicate hook entries', () => {
    runInstall()
    const firstCount = countPluginEntries(readJson())
    runInstall()
    const secondCount = countPluginEntries(readJson())
    expect(secondCount).toBe(firstCount)
  })

  test('preserves unrelated keys', () => {
    writeFileSync(
      settings,
      JSON.stringify({
        otherKey: { keep: 'me' },
        hooks: {
          PreToolUse: [
            { marker: 'someone-else', hooks: [{ type: 'command', command: 'echo unrelated' }] },
          ],
        },
      }),
    )
    runInstall()
    const parsed = readJson() as Record<string, unknown> & {
      hooks?: { PreToolUse?: Array<{ marker?: string; hooks?: Array<{ command?: string }> }> }
    }
    expect(parsed.otherKey).toEqual({ keep: 'me' })
    // Other plugin's entry must survive.
    const preToolUse = parsed.hooks?.PreToolUse ?? []
    const others = preToolUse.filter((e) => e.marker === 'someone-else')
    const ours = preToolUse.filter((e) => e.marker === 'dashi-channel-hook')
    expect(others.length).toBe(1)
    expect(ours.length).toBe(1)
    expect(others[0]!.hooks?.[0]?.command).toBe('echo unrelated')
  })
})

describe('patchSettingsFile — writeAtomic same-dir staging (regression)', () => {
  test('writes settings.json without leaving *.tmp.* orphans in dir', async () => {
    const { patchSettingsFile } = await import('../../scripts/patch-claude-settings.js')
    const target = join(tmp, 'settings.json')
    patchSettingsFile({
      settingsPath: target,
      chatId: '164795011',
      webhookUrl: 'http://127.0.0.1:8089/hooks/agent',
      helperPath: '/abs/post-hook.ts',
    })
    const entries = readFileSync(target, 'utf8')
    expect(entries).toContain('dashi-channel-hook')
    // No leftover *.tmp.* staging file (would imply rename failed silently
    // or temp lived in a different dir).
    const { readdirSync } = await import('fs')
    const dirEntries = readdirSync(tmp)
    const orphans = dirEntries.filter((n) => n.includes('.tmp.'))
    expect(orphans).toEqual([])
  })

  test('writeAtomic stages tmp file in same dir as target (cross-volume regression)', async () => {
    // Asserts the implementation invariant: even on platforms where the
    // process tmpdir lives on a different fs, the staged tmp file is
    // never created outside the target's parent directory. We can't fake
    // a cross-volume mount in a unit test, so we instead inspect the
    // module source to confirm the staging strategy. The post-fix
    // patcher derives its temp path from `dirname(settingsPath)`.
    const src = readFileSync(
      join(PLUGIN_DIR, 'scripts', 'patch-claude-settings.ts'),
      'utf8',
    )
    expect(src).toContain('dirname(path)')
    expect(src).toContain('${path}.tmp.')
    // And the obsolete tmpdir-based staging must be gone.
    expect(src).not.toContain("mkdtempSync(join(tmpdir()")
    expect(src).not.toContain("mkdtempSync(tmpdir())")
  })
})

describe('default helper path resolution (M5)', () => {
  test('module exports patchSettingsFile importable under Bun (and resolved post-hook.ts exists)', async () => {
    const mod = await import('../../scripts/patch-claude-settings.js')
    expect(typeof mod.patchSettingsFile).toBe('function')
    // The default helper resolution kicks in only when --helper is omitted
    // (CLI path). For the unit test we just verify the sibling
    // post-hook.ts file is present at the path the resolver would land on.
    expect(existsSyncWrapper(POST_HOOK)).toBe(true)
  })
})

function existsSyncWrapper(p: string): boolean {
  try {
    readFileSync(p)
    return true
  } catch {
    return false
  }
}

describe('applyPatch (pure)', () => {
  test('handles missing hooks section', () => {
    const out = applyPatch(
      {},
      {
        settingsPath: '/tmp/x',
        chatId: '1',
        webhookUrl: 'http://x',
        helperPath: '/tmp/post-hook.ts',
      },
    )
    expect((out as Record<string, unknown>).hooks).toBeDefined()
  })

  test('removes markerless legacy entries that point at post-hook.ts (regression)', () => {
    // settings.json hand-edited: marker stripped but the command still
    // points at our post-hook.ts helper. install must NOT leave both the
    // legacy entry and the new marked one (double-fire).
    const legacyCmd = `TELEGRAM_HOOK_CHAT_ID='1' bun '/old/plugin/scripts/post-hook.ts'`
    const seed: Record<string, unknown> = {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: legacyCmd }] },
        ],
        Stop: [
          { hooks: [{ type: 'command', command: legacyCmd }] },
        ],
      },
    }
    const out = applyPatch(seed, {
      settingsPath: '/tmp/x',
      chatId: '1',
      webhookUrl: 'http://x',
      helperPath: '/new/plugin/scripts/post-hook.ts',
    }) as { hooks: Record<string, Array<{ marker?: string; hooks?: Array<{ command?: string }> }>> }
    for (const ev of ['PreToolUse', 'Stop']) {
      const arr = out.hooks[ev] ?? []
      expect(arr.length).toBe(1)
      expect(arr[0]!.marker).toBe('dashi-channel-hook')
      expect(arr[0]!.hooks?.[0]?.command).toContain('/new/plugin/scripts/post-hook.ts')
      // Old legacy command must be gone.
      expect(arr.find((e) => e.hooks?.[0]?.command === legacyCmd)).toBeUndefined()
    }
  })

  test('replaces previous dashi-channel-hook entry rather than appending', () => {
    let s: Record<string, unknown> = {}
    s = applyPatch(s, {
      settingsPath: '/tmp/x',
      chatId: '1',
      webhookUrl: 'http://old',
      helperPath: '/tmp/post-hook.ts',
    })
    s = applyPatch(s, {
      settingsPath: '/tmp/x',
      chatId: '1',
      webhookUrl: 'http://new',
      helperPath: '/tmp/post-hook.ts',
    })
    const hooks = (s as { hooks?: Record<string, Array<{ marker?: string; hooks?: Array<{ command?: string }> }>> }).hooks
    const stop = hooks?.Stop ?? []
    const ours = stop.filter((e) => e.marker === 'dashi-channel-hook')
    expect(ours.length).toBe(1)
    expect(ours[0]!.hooks?.[0]?.command).toContain('http://new')
    expect(ours[0]!.hooks?.[0]?.command).not.toContain('http://old')
  })

  type GateHooks = { hooks: Record<string, Array<{ marker?: string; matcher?: string; hooks?: Array<{ command?: string }> }>> }

  test('permission gate: registers a PreToolUse gate entry FIRST, only on PreToolUse', () => {
    const out = applyPatch({}, {
      settingsPath: '/tmp/x',
      chatId: '164795011',
      webhookUrl: 'http://127.0.0.1:8093/hooks/agent',
      helperPath: '/p/scripts/post-hook.ts',
      permissionGateHelperPath: '/p/scripts/permission-gate-hook.ts',
    }) as GateHooks
    const pre = out.hooks.PreToolUse ?? []
    // Gate entry is first, notification mirror second.
    expect(pre[0]!.marker).toBe('dashi-permission-gate-hook')
    expect(pre[0]!.hooks?.[0]?.command).toContain('permission-gate-hook.ts')
    // Hands the bare origin (no /hooks/agent path) to the gate hook.
    expect(pre[0]!.hooks?.[0]?.command).toContain("TELEGRAM_WEBHOOK_URL='http://127.0.0.1:8093'")
    expect(pre[0]!.hooks?.[0]?.command).not.toContain('/hooks/agent')
    expect(pre.some((e) => e.marker === 'dashi-channel-hook')).toBe(true)
    // No gate entry leaks onto other events.
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']) {
      expect((out.hooks[ev] ?? []).some((e) => e.marker === 'dashi-permission-gate-hook')).toBe(false)
    }
  })

  test('permission gate: never writes the bearer token', () => {
    const out = applyPatch({}, {
      settingsPath: '/tmp/x',
      chatId: '164795011',
      webhookUrl: 'http://127.0.0.1:8093',
      helperPath: '/p/post-hook.ts',
      permissionGateHelperPath: '/p/permission-gate-hook.ts',
      policyPath: '/p/policy.yaml',
    }) as GateHooks
    const cmd = out.hooks.PreToolUse![0]!.hooks![0]!.command!
    expect(cmd).not.toContain('TELEGRAM_WEBHOOK_TOKEN')
    expect(cmd).toContain("TELEGRAM_PERMISSION_POLICY_PATH='/p/policy.yaml'")
  })

  test('permission gate: re-run replaces the gate entry, no duplicates', () => {
    const opts = {
      settingsPath: '/tmp/x',
      chatId: '164795011',
      webhookUrl: 'http://127.0.0.1:8093',
      helperPath: '/p/post-hook.ts',
      permissionGateHelperPath: '/p/permission-gate-hook.ts',
    }
    let s = applyPatch({}, opts) as GateHooks
    s = applyPatch(s, opts) as GateHooks
    const gate = (s.hooks.PreToolUse ?? []).filter((e) => e.marker === 'dashi-permission-gate-hook')
    expect(gate.length).toBe(1)
  })

  test('without permissionGateHelperPath, no gate entry is added (default off)', () => {
    const out = applyPatch({}, {
      settingsPath: '/tmp/x',
      chatId: '1',
      webhookUrl: 'http://x',
      helperPath: '/p/post-hook.ts',
    }) as GateHooks
    expect((out.hooks.PreToolUse ?? []).some((e) => e.marker === 'dashi-permission-gate-hook')).toBe(false)
  })
})

function countPluginEntries(parsed: Record<string, unknown>): number {
  const hooks = parsed.hooks as Record<string, Array<{ marker?: string }>> | undefined
  if (!hooks) return 0
  let total = 0
  for (const arr of Object.values(hooks)) {
    if (!Array.isArray(arr)) continue
    total += arr.filter((e) => e?.marker === 'dashi-channel-hook').length
  }
  return total
}
