import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  PERMISSION_REPLY_RE,
  createPendingMap,
  createPermissionRelayHooks,
  handlePermissionCallback,
  isPermissionApprover,
  parsePermissionCallback,
  parsePermissionTextReply,
  type CallbackQueryLike,
  type PendingPermission,
  type PermissionNotifier,
} from '../../src/channel/permissions.js'
import type { AppConfig, StatePaths } from '../../src/config.js'
import type { Logger } from '../../src/log.js'

function silentLog(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
}

function mkStatePaths(): StatePaths {
  const root = mkdtempSync(join(tmpdir(), 'perm-test-'))
  return {
    root,
    env: join(root, '.env'),
    config: join(root, 'config.json'),
    allowlist: join(root, 'allowlist.json'),
    pid: join(root, 'bot.pid'),
    lock: join(root, 'bot.lock'),
    updateOffset: join(root, 'update-offset'),
    inbox: join(root, 'inbox'),
    sessionIds: join(root, 'session-ids'),
    deadLetterUpdates: join(root, 'dead-letter', 'updates'),
    deadLetterWebhook: join(root, 'dead-letter', 'webhook'),
    logs: {
      server: join(root, 'logs', 'server.log'),
      telegram: join(root, 'logs', 'telegram.log'),
      permissions: join(root, 'logs', 'permissions.jsonl'),
      webhook: join(root, 'logs', 'webhook.log'),
    },
  }
}

function mkConfig(allowedIds: number[] = [164795011]): AppConfig {
  return {
    bot_id: 8507713167,
    dm_only: true,
    allowed_user_ids: [164795011],
    allowed_chat_ids: [164795011],
    status: { enabled: true, interval_ms: 700, ttl_ms: 300_000, delete_on_complete: true, suppress_typing_bubble: false },
    album: { flush_ms: 2000 },
    voice: { provider: 'groq', language: 'ru', model: 'whisper-large-v3-turbo' },
    webhook: { enabled: false, host: '127.0.0.1', port: 0 },
    permission_relay: { enabled: true, allowed_user_ids: allowedIds, bash_only_proof: true },
    commands: { help: true, status: true, stop: true, reset: true, new: true },
    memory: {
      enabled: false,
      source_tag: 'tg',
      max_hot_bytes: 20480,
      trim_keep_lines: 600,
      buffer_ttl_ms: 5 * 60 * 1000,
      buffer_max_entries: 100,
    },
    progress: {
      enabled: true,
      edit_throttle_ms: 3000,
      recent_buffer: 10,
      session_ttl_ms: 600000,
    },
    task_mirror: {
      enabled: true,
      edit_throttle_ms: 3000,
      session_ttl_ms: 600000,
      collapse_completed_after: 5,
    },
    watcher: {
      enabled: true,
      debounce_ms: 10_000,
      busy_threshold_ms: 30_000,
    },
  }
}

describe('PERMISSION_REPLY_RE', () => {
  test('matches "yes abcde" case insensitive', () => {
    expect(PERMISSION_REPLY_RE.exec('yes abcde')).not.toBeNull()
    expect(PERMISSION_REPLY_RE.exec('YES ABCDE')).not.toBeNull()
    expect(PERMISSION_REPLY_RE.exec('YeS aBcDe')).not.toBeNull()
    expect(PERMISSION_REPLY_RE.exec('y abcde')).not.toBeNull()
    expect(PERMISSION_REPLY_RE.exec('no abcde')).not.toBeNull()
    expect(PERMISSION_REPLY_RE.exec('n abcde')).not.toBeNull()
  })

  test('rejects bare "yes" without code', () => {
    expect(PERMISSION_REPLY_RE.exec('yes')).toBeNull()
    expect(PERMISSION_REPLY_RE.exec('no')).toBeNull()
    expect(PERMISSION_REPLY_RE.exec('y')).toBeNull()
  })

  test('rejects IDs containing l (visually ambiguous)', () => {
    expect(PERMISSION_REPLY_RE.exec('yes abcdl')).toBeNull()
    expect(PERMISSION_REPLY_RE.exec('yes lllll')).toBeNull()
    expect(PERMISSION_REPLY_RE.exec('yes alpha')).toBeNull() // contains l
  })

  test('rejects prefix/suffix chatter', () => {
    expect(PERMISSION_REPLY_RE.exec('please yes abcde')).toBeNull()
    expect(PERMISSION_REPLY_RE.exec('yes abcde please')).toBeNull()
  })
})

describe('parsePermissionCallback', () => {
  test('handles perm:allow:abcde', () => {
    const out = parsePermissionCallback('perm:allow:abcde')
    expect(out).toEqual({ behavior: 'allow', requestId: 'abcde' })
  })

  test('handles perm:deny:abcde and perm:more:xyzab', () => {
    expect(parsePermissionCallback('perm:deny:abcde')).toEqual({
      behavior: 'deny',
      requestId: 'abcde',
    })
    expect(parsePermissionCallback('perm:more:xyzab')).toEqual({
      behavior: 'more',
      requestId: 'xyzab',
    })
  })

  test('returns null on malformed data', () => {
    expect(parsePermissionCallback('garbage')).toBeNull()
    expect(parsePermissionCallback('perm:allow')).toBeNull()
    expect(parsePermissionCallback('perm:invalid:abcde')).toBeNull()
    expect(parsePermissionCallback('perm:allow:abcdl')).toBeNull() // l disallowed
    expect(parsePermissionCallback('perm:allow:abc')).toBeNull() // too short
  })
})

describe('createPendingMap', () => {
  test('returns an empty Map<string, PendingPermission>', () => {
    const map = createPendingMap()
    expect(map.size).toBe(0)
    map.set('abcde', { toolName: 'Bash', description: 'run', inputPreview: '{}' })
    expect(map.get('abcde')?.toolName).toBe('Bash')
  })
})

describe('parsePermissionTextReply', () => {
  test('parses "yes abcde" as allow', () => {
    expect(parsePermissionTextReply('yes abcde')).toEqual({ behavior: 'allow', requestId: 'abcde' })
    expect(parsePermissionTextReply('y abcde')).toEqual({ behavior: 'allow', requestId: 'abcde' })
    expect(parsePermissionTextReply('YES ABCDE')).toEqual({ behavior: 'allow', requestId: 'abcde' })
  })

  test('parses "no abcde" as deny', () => {
    expect(parsePermissionTextReply('no abcde')).toEqual({ behavior: 'deny', requestId: 'abcde' })
    expect(parsePermissionTextReply('n abcde')).toEqual({ behavior: 'deny', requestId: 'abcde' })
  })

  test('rejects bare yes/no without code', () => {
    expect(parsePermissionTextReply('yes')).toBeNull()
    expect(parsePermissionTextReply('no')).toBeNull()
    expect(parsePermissionTextReply('y')).toBeNull()
  })

  test('rejects IDs containing l (visually ambiguous)', () => {
    expect(parsePermissionTextReply('yes abcdl')).toBeNull()
    expect(parsePermissionTextReply('yes alpha')).toBeNull()
  })

  test('rejects prefix/suffix chatter', () => {
    expect(parsePermissionTextReply('please yes abcde')).toBeNull()
    expect(parsePermissionTextReply('yes abcde please')).toBeNull()
  })
})

describe('isPermissionApprover', () => {
  test('matches user_id from config', () => {
    const cfg = mkConfig([164795011, 99])
    expect(isPermissionApprover(164795011, cfg)).toBe(true)
    expect(isPermissionApprover('164795011', cfg)).toBe(true)
    expect(isPermissionApprover(99, cfg)).toBe(true)
  })

  test('rejects non-approver', () => {
    const cfg = mkConfig([164795011])
    expect(isPermissionApprover(42, cfg)).toBe(false)
    expect(isPermissionApprover('42', cfg)).toBe(false)
    expect(isPermissionApprover('not-a-number', cfg)).toBe(false)
  })
})

describe('createPermissionRelayHooks', () => {
  function mkNotifier(): {
    notifier: PermissionNotifier
    sent: { request_id: string; behavior: 'allow' | 'deny' }[]
  } {
    const sent: { request_id: string; behavior: 'allow' | 'deny' }[] = []
    const notifier: PermissionNotifier = {
      async notification(n) {
        sent.push(n.params)
      },
    }
    return { notifier, sent }
  }

  test('emitVerdict sends mcp notification with request_id+behavior', async () => {
    const { notifier, sent } = mkNotifier()
    const pending = createPendingMap()
    pending.set('abcde', { toolName: 'Bash', description: 'd', inputPreview: '{}' })
    const paths = mkStatePaths()
    const hooks = createPermissionRelayHooks(notifier, pending, silentLog(), paths)

    await hooks.emitVerdict({ behavior: 'allow', requestId: 'abcde' })
    expect(sent).toEqual([{ request_id: 'abcde', behavior: 'allow' }])

    // jsonl audit appended
    expect(existsSync(paths.logs.permissions)).toBe(true)
    const lines = readFileSync(paths.logs.permissions, 'utf8').trim().split('\n')
    expect(lines.length).toBe(1)
    const parsed: unknown = JSON.parse(lines[0]!)
    expect((parsed as { request_id: string }).request_id).toBe('abcde')
    expect((parsed as { behavior: string }).behavior).toBe('allow')
  })

  test('isPending + consumePending lifecycle', () => {
    const { notifier } = mkNotifier()
    const pending = createPendingMap()
    pending.set('abcde', { toolName: 'Bash', description: 'd', inputPreview: '{}' })
    const hooks = createPermissionRelayHooks(notifier, pending, silentLog(), mkStatePaths())

    expect(hooks.isPending('abcde')).toBe(true)
    expect(hooks.isPending('zzzzz')).toBe(false)
    const consumed = hooks.consumePending('abcde')
    expect(consumed?.toolName).toBe('Bash')
    expect(hooks.isPending('abcde')).toBe(false)
    expect(hooks.consumePending('abcde')).toBeUndefined()
  })

  test('emitVerdict survives notifier failures', async () => {
    const failing: PermissionNotifier = {
      async notification() {
        throw new Error('transport closed')
      },
    }
    const pending = createPendingMap()
    const paths = mkStatePaths()
    const hooks = createPermissionRelayHooks(failing, pending, silentLog(), paths)
    await hooks.emitVerdict({ behavior: 'deny', requestId: 'abcde' })
    // Audit still written even though notification threw.
    expect(existsSync(paths.logs.permissions)).toBe(true)
  })
})

describe('handlePermissionCallback', () => {
  interface StubCalls {
    answerCallbackQuery: Array<{ text?: string } | undefined>
    editMessageText: Array<{ text: string; opts?: { reply_markup?: unknown } }>
  }

  function mkCtx(
    data: string | undefined,
    fromId: number,
    messageText: string | null = '🔐 Permission: Bash',
  ): { ctx: CallbackQueryLike; calls: StubCalls } {
    const calls: StubCalls = { answerCallbackQuery: [], editMessageText: [] }
    const cbq: { data?: string; message?: { text?: string } } = {}
    if (data !== undefined) cbq.data = data
    if (messageText !== null) cbq.message = { text: messageText }
    const ctx: CallbackQueryLike = {
      callbackQuery: cbq,
      from: { id: fromId },
      async answerCallbackQuery(arg) {
        calls.answerCallbackQuery.push(arg)
      },
      async editMessageText(text, opts) {
        const entry: { text: string; opts?: { reply_markup?: unknown } } = { text }
        if (opts) entry.opts = opts
        calls.editMessageText.push(entry)
      },
    }
    return { ctx, calls }
  }

  function mkDeps(
    config: AppConfig,
    pending: Map<string, PendingPermission>,
  ): { deps: Parameters<typeof handlePermissionCallback>[1]; emitted: Array<{ behavior: 'allow' | 'deny'; requestId: string }> } {
    const emitted: Array<{ behavior: 'allow' | 'deny'; requestId: string }> = []
    const deps = {
      config,
      pending,
      log: silentLog(),
      hooks: {
        isPending: (id: string) => pending.has(id),
        consumePending: (id: string) => {
          const v = pending.get(id)
          pending.delete(id)
          return v
        },
        emitVerdict: async (d: { behavior: 'allow' | 'deny'; requestId: string }) => {
          emitted.push(d)
        },
      },
    }
    return { deps, emitted }
  }

  test('unknown callback data is silently ignored (no auth error)', async () => {
    const cfg = mkConfig([164795011])
    const { ctx, calls } = mkCtx('garbage:payload', 164795011)
    const { deps, emitted } = mkDeps(cfg, createPendingMap())
    await handlePermissionCallback(ctx, deps)
    expect(calls.answerCallbackQuery).toEqual([undefined])
    expect(calls.editMessageText).toEqual([])
    expect(emitted).toEqual([])
  })

  test('non-approver press answered "Not authorized."', async () => {
    const cfg = mkConfig([164795011])
    const pending = createPendingMap()
    pending.set('abcde', { toolName: 'Bash', description: 'd', inputPreview: '{}' })
    const { ctx, calls } = mkCtx('perm:allow:abcde', 9999)
    const { deps, emitted } = mkDeps(cfg, pending)
    await handlePermissionCallback(ctx, deps)
    expect(calls.answerCallbackQuery).toEqual([{ text: 'Not authorized.' }])
    expect(calls.editMessageText).toEqual([])
    expect(emitted).toEqual([])
    // pending stays — non-approver couldn't consume.
    expect(pending.has('abcde')).toBe(true)
  })

  test('approver "allow" press emits verdict and edits message', async () => {
    const cfg = mkConfig([164795011])
    const pending = createPendingMap()
    pending.set('abcde', { toolName: 'Bash', description: 'd', inputPreview: '{}' })
    const { ctx, calls } = mkCtx('perm:allow:abcde', 164795011)
    const { deps, emitted } = mkDeps(cfg, pending)
    await handlePermissionCallback(ctx, deps)
    expect(emitted).toEqual([{ behavior: 'allow', requestId: 'abcde' }])
    expect(calls.answerCallbackQuery).toEqual([{ text: '✅ Allowed' }])
    expect(calls.editMessageText.length).toBe(1)
    expect(calls.editMessageText[0]!.text).toContain('✅ Allowed')
    expect(pending.has('abcde')).toBe(false)
  })

  test('approver "deny" press emits deny and edits message', async () => {
    const cfg = mkConfig([164795011])
    const pending = createPendingMap()
    pending.set('abcde', { toolName: 'Bash', description: 'd', inputPreview: '{}' })
    const { ctx, calls } = mkCtx('perm:deny:abcde', 164795011)
    const { deps, emitted } = mkDeps(cfg, pending)
    await handlePermissionCallback(ctx, deps)
    expect(emitted).toEqual([{ behavior: 'deny', requestId: 'abcde' }])
    expect(calls.answerCallbackQuery).toEqual([{ text: '❌ Denied' }])
    expect(calls.editMessageText[0]!.text).toContain('❌ Denied')
  })

  test('"more" press expands details with Allow/Deny keyboard', async () => {
    const cfg = mkConfig([164795011])
    const pending = createPendingMap()
    pending.set('abcde', {
      toolName: 'Bash',
      description: 'run ls',
      inputPreview: '{"cmd":"ls"}',
    })
    const { ctx, calls } = mkCtx('perm:more:abcde', 164795011)
    const { deps, emitted } = mkDeps(cfg, pending)
    await handlePermissionCallback(ctx, deps)
    expect(emitted).toEqual([])
    // Still pending — "more" doesn't consume.
    expect(pending.has('abcde')).toBe(true)
    expect(calls.editMessageText.length).toBe(1)
    const edit = calls.editMessageText[0]!
    expect(edit.text).toContain('tool_name: Bash')
    expect(edit.text).toContain('description: run ls')
    expect(edit.text).toContain('"cmd": "ls"')
    expect(edit.opts?.reply_markup).toBeDefined()
  })

  test('"more" press without pending answers "Details no longer available."', async () => {
    const cfg = mkConfig([164795011])
    const { ctx, calls } = mkCtx('perm:more:abcde', 164795011)
    const { deps, emitted } = mkDeps(cfg, createPendingMap())
    await handlePermissionCallback(ctx, deps)
    expect(calls.answerCallbackQuery).toEqual([{ text: 'Details no longer available.' }])
    expect(emitted).toEqual([])
  })
})
