// StatusManager tests — fake timers, no real network/sleeps.

import { describe, expect, test } from 'bun:test'

import {
  StatusManager,
  type TelegramApiForStatus,
} from '../../src/status/status-manager.js'
import type { AppConfig } from '../../src/config.js'
import { createLogger } from '../../src/log.js'

const silentLog = createLogger('test', {
  stream: { write: () => true } as unknown as NodeJS.WritableStream,
})

function makeConfig(overrides: Partial<AppConfig['status']> = {}): AppConfig {
  return {
    bot_id: 8507713167,
    dm_only: true,
    allowed_user_ids: [164795011],
    allowed_chat_ids: [164795011],
    status: {
      enabled: true,
      interval_ms: 700,
      ttl_ms: 300_000,
      delete_on_complete: true,
      ...overrides,
    },
    album: { flush_ms: 2000 },
    voice: { provider: 'groq', language: 'ru', model: 'whisper-large-v3-turbo' },
    webhook: { enabled: false, host: '127.0.0.1', port: 0 },
    permission_relay: { enabled: true, allowed_user_ids: [164795011], bash_only_proof: true },
    commands: { help: true, status: true, stop: true, reset: true, new: true },
  }
}

// ─────────────────────────────────────────────────────────────────────
// Fake timer harness. Tests advance time by calling fake.advance(ms);
// any callback whose deadline lies within the advance window fires. We
// don't model recurring intervals because StatusManager re-arms via
// setTimer (one-shot) inside its tick callback, mirroring how the
// production code works without setInterval.
// ─────────────────────────────────────────────────────────────────────

interface FakeTimer {
  id: number
  deadline: number
  cb: () => void
  fired: boolean
}

class FakeClock {
  now = 0
  next = 1
  timers: FakeTimer[] = []
  setTimer = (cb: () => void, ms: number): NodeJS.Timeout => {
    const t: FakeTimer = { id: this.next++, deadline: this.now + ms, cb, fired: false }
    this.timers.push(t)
    return t as unknown as NodeJS.Timeout
  }
  clearTimer = (handle: NodeJS.Timeout): void => {
    const t = handle as unknown as FakeTimer
    t.fired = true // mark canceled
  }
  advance(ms: number): void {
    const deadline = this.now + ms
    // Fire timers in deadline order; new timers scheduled during a tick
    // can themselves fire in the same advance window.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const due = this.timers
        .filter((t) => !t.fired && t.deadline <= deadline)
        .sort((a, b) => a.deadline - b.deadline)[0]
      if (!due) break
      this.now = due.deadline
      due.fired = true
      due.cb()
    }
    this.now = deadline
  }
}

interface ApiCall {
  kind: 'send' | 'edit' | 'delete'
  chatId: string
  messageId?: number
  text?: string
  opts?: unknown
}

interface FakeApi {
  api: TelegramApiForStatus
  calls: ApiCall[]
  nextMessageId: number
  failEditWith?: Error
  failDeleteWith?: Error
}

function makeFakeApi(): FakeApi {
  const state: FakeApi = {
    calls: [],
    nextMessageId: 100,
    api: undefined as unknown as TelegramApiForStatus,
  }
  state.api = {
    sendMessage: async (chatId: string, text: string, opts: unknown) => {
      const id = state.nextMessageId++
      state.calls.push({ kind: 'send', chatId, messageId: id, text, opts })
      return { message_id: id }
    },
    editMessageText: async (chatId: string, messageId: number, text: string, opts: unknown) => {
      state.calls.push({ kind: 'edit', chatId, messageId, text, opts })
      if (state.failEditWith) throw state.failEditWith
    },
    deleteMessage: async (chatId: string, messageId: number) => {
      state.calls.push({ kind: 'delete', chatId, messageId })
      if (state.failDeleteWith) throw state.failDeleteWith
    },
  }
  return state
}

function makeManager(opts: { config?: AppConfig; clock?: FakeClock; api?: FakeApi } = {}) {
  const clock = opts.clock ?? new FakeClock()
  const api = opts.api ?? makeFakeApi()
  const config = opts.config ?? makeConfig()
  const mgr = new StatusManager({
    telegramApi: api.api,
    config,
    log: silentLog,
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  return { mgr, clock, api, config }
}

describe('StatusManager.start', () => {
  test('sends initial typing message via sendMessage', async () => {
    const { mgr, api } = makeManager()
    const handle = await mgr.start('164795011', undefined)
    expect(handle.chatId).toBe('164795011')
    expect(handle.messageId).toBe(100)
    expect(api.calls.length).toBe(1)
    const sent = api.calls[0]!
    expect(sent.kind).toBe('send')
    expect(sent.chatId).toBe('164795011')
    expect(sent.text).toContain('Печатает')
    const opts = sent.opts as { parse_mode?: string; reply_to_message_id?: number }
    expect(opts.parse_mode).toBe('HTML')
    expect(opts.reply_to_message_id).toBeUndefined()
  })

  test('passes reply_to_message_id when supplied', async () => {
    const { mgr, api } = makeManager()
    await mgr.start('164795011', 4242)
    const opts = api.calls[0]!.opts as { reply_to_message_id?: number }
    expect(opts.reply_to_message_id).toBe(4242)
  })

  test('isActive flips true after start, false after complete', async () => {
    const { mgr } = makeManager()
    expect(mgr.isActive('164795011')).toBe(false)
    await mgr.start('164795011', undefined)
    expect(mgr.isActive('164795011')).toBe(true)
    await mgr.complete('164795011')
    expect(mgr.isActive('164795011')).toBe(false)
  })

  test('start replaces previous active status for same chat (no extra edit)', async () => {
    const { mgr, api } = makeManager()
    await mgr.start('164795011', undefined)
    expect(api.calls.length).toBe(1)
    // Second start: previous timers cancel silently, new message goes out.
    await mgr.start('164795011', undefined)
    // 1 original send + 1 new send. No "canceled" edit between them.
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(2)
    expect(api.calls.filter((c) => c.kind === 'edit').length).toBe(0)
  })
})

describe('StatusManager.update', () => {
  test('edits existing message with new state text', async () => {
    const { mgr, api } = makeManager()
    const handle = await mgr.start('164795011', undefined)
    await mgr.update(handle, { kind: 'thinking' })
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(edits.length).toBe(1)
    expect(edits[0]!.messageId).toBe(handle.messageId)
    expect(edits[0]!.text).toContain('Думает')
  })

  test('update with tool state renders 🔧 + tool name (HTML-escaped)', async () => {
    const { mgr, api } = makeManager()
    const handle = await mgr.start('164795011', undefined)
    await mgr.update(handle, { kind: 'tool', toolName: 'Bash<test>' })
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(edits.length).toBe(1)
    expect(edits[0]!.text).toContain('🔧')
    expect(edits[0]!.text).toContain('Bash&lt;test&gt;')
  })

  test('update swallows "message is not modified" silently', async () => {
    const { mgr, api } = makeManager()
    api.failEditWith = new Error('Bad Request: message is not modified')
    const handle = await mgr.start('164795011', undefined)
    // Should not throw despite the API error.
    await mgr.update(handle, { kind: 'thinking' })
    // One send + one (failed-but-swallowed) edit.
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(1)
    expect(api.calls.filter((c) => c.kind === 'edit').length).toBe(1)
  })

  test('update with stale handle is a no-op', async () => {
    const { mgr, api } = makeManager()
    const handle = await mgr.start('164795011', undefined)
    await mgr.complete('164795011')
    const editsBefore = api.calls.filter((c) => c.kind === 'edit').length
    await mgr.update(handle, { kind: 'thinking' })
    const editsAfter = api.calls.filter((c) => c.kind === 'edit').length
    expect(editsAfter).toBe(editsBefore)
  })
})

describe('StatusManager.complete', () => {
  test('clears handle and (default) deletes status message', async () => {
    const { mgr, api } = makeManager()
    await mgr.start('164795011', undefined)
    await mgr.complete('164795011')
    expect(mgr.isActive('164795011')).toBe(false)
    expect(api.calls.filter((c) => c.kind === 'delete').length).toBe(1)
  })

  test('skips delete when delete_on_complete=false', async () => {
    const config = makeConfig({ delete_on_complete: false })
    const { mgr, api } = makeManager({ config })
    await mgr.start('164795011', undefined)
    await mgr.complete('164795011')
    expect(api.calls.filter((c) => c.kind === 'delete').length).toBe(0)
  })

  test('complete on unknown chat is a no-op', async () => {
    const { mgr, api } = makeManager()
    await mgr.complete('999')
    expect(api.calls.length).toBe(0)
  })

  test('complete swallows delete errors', async () => {
    const { mgr, api } = makeManager()
    api.failDeleteWith = new Error('Bad Request: message to delete not found')
    await mgr.start('164795011', undefined)
    await mgr.complete('164795011') // must not throw
    expect(mgr.isActive('164795011')).toBe(false)
  })
})

describe('StatusManager.cancel', () => {
  test('edits to "Остановлено: <reason>" and stops timers', async () => {
    const { mgr, api, clock } = makeManager()
    await mgr.start('164795011', undefined)
    await mgr.cancel('164795011', 'user stop')
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(edits.length).toBeGreaterThanOrEqual(1)
    expect(edits[edits.length - 1]!.text).toContain('Остановлено')
    expect(edits[edits.length - 1]!.text).toContain('user stop')

    // Verify timers are dead: advancing time past the interval emits no
    // further edits.
    const before = api.calls.length
    clock.advance(5000)
    expect(api.calls.length).toBe(before)
    expect(mgr.isActive('164795011')).toBe(false)
  })

  test('cancel on unknown chat is a no-op', async () => {
    const { mgr, api } = makeManager()
    await mgr.cancel('999', 'nope')
    expect(api.calls.length).toBe(0)
  })
})

describe('StatusManager interval ticker', () => {
  test('advancing time triggers periodic edits (dot animation)', async () => {
    const { mgr, api, clock } = makeManager()
    await mgr.start('164795011', undefined)
    // Two ticks visible to network: tick 1 → "Печатает.." (2 dots), tick 2 →
    // "Печатает..." (3 dots). Tick 3 would cycle back to "Печатает." which
    // matches lastText (the initial text) and is intentionally skipped to
    // avoid a "message is not modified" round-trip. Drain microtasks to let
    // each editSafely settle before inspecting.
    clock.advance(700)
    await Promise.resolve(); await Promise.resolve()
    clock.advance(700)
    await Promise.resolve(); await Promise.resolve()
    clock.advance(700)
    await Promise.resolve(); await Promise.resolve()
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(edits.length).toBeGreaterThanOrEqual(2)
    // Each edit text should still contain "Печатает".
    for (const e of edits) {
      expect(e.text).toContain('Печатает')
    }
    // First two edits cycle 2→3 dots.
    expect(edits[0]!.text).toContain('Печатает..')
    expect(edits[1]!.text).toContain('Печатает...')
  })

  test('tick stops after complete', async () => {
    const { mgr, api, clock } = makeManager()
    await mgr.start('164795011', undefined)
    clock.advance(700) // one tick edit
    const editsBefore = api.calls.filter((c) => c.kind === 'edit').length
    await mgr.complete('164795011')
    clock.advance(5000)
    const editsAfter = api.calls.filter((c) => c.kind === 'edit').length
    expect(editsAfter).toBe(editsBefore)
  })
})

describe('StatusManager TTL guard', () => {
  test('auto-cancels after ttl_ms with reason="ttl"', async () => {
    const config = makeConfig({ ttl_ms: 5000 })
    const { mgr, api, clock } = makeManager({ config })
    await mgr.start('164795011', undefined)
    expect(mgr.isActive('164795011')).toBe(true)
    clock.advance(5000)
    // The TTL fires cancel(), which is async. Drain microtasks.
    await Promise.resolve()
    await Promise.resolve()
    expect(mgr.isActive('164795011')).toBe(false)
    const edits = api.calls.filter((c) => c.kind === 'edit')
    // Last edit must be the "Остановлено: ttl" finalization. (Interval
    // ticks may also have fired before TTL — we only check the final one.)
    expect(edits[edits.length - 1]!.text).toContain('Остановлено')
    expect(edits[edits.length - 1]!.text).toContain('ttl')
  })

  test('complete before TTL prevents auto-cancel firing', async () => {
    const config = makeConfig({ ttl_ms: 5000, interval_ms: 100_000 })
    const { mgr, api, clock } = makeManager({ config })
    await mgr.start('164795011', undefined)
    await mgr.complete('164795011')
    const editsBefore = api.calls.filter((c) => c.kind === 'edit').length
    clock.advance(10_000)
    await Promise.resolve()
    const editsAfter = api.calls.filter((c) => c.kind === 'edit').length
    // No "Остановлено: ttl" edit should appear after complete.
    expect(editsAfter).toBe(editsBefore)
  })
})

describe('StatusManager updateByChatId (for status MCP tool)', () => {
  test('re-targets active status by chat id without external handle', async () => {
    const { mgr, api } = makeManager()
    await mgr.start('164795011', undefined)
    await mgr.updateByChatId('164795011', { kind: 'tool', toolName: 'Read' })
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(edits[edits.length - 1]!.text).toContain('🔧')
    expect(edits[edits.length - 1]!.text).toContain('Read')
  })

  test('updateByChatId on unknown chat is a no-op', async () => {
    const { mgr, api } = makeManager()
    await mgr.updateByChatId('999', { kind: 'typing' })
    expect(api.calls.length).toBe(0)
  })
})

describe('StatusManager.activeChatIds', () => {
  test('returns the list of active chats (used by shutdown)', async () => {
    const { mgr } = makeManager()
    expect(mgr.activeChatIds()).toEqual([])
    await mgr.start('164795011', undefined)
    await mgr.start('200', undefined)
    const ids = mgr.activeChatIds().sort()
    expect(ids).toEqual(['164795011', '200'])
  })
})
