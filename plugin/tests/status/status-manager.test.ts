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
      // Keep legacy behaviour (eager «Печатает...» bubble) so the existing
      // suite covers the non-suppressed path. Dedicated tests below opt in
      // by passing { suppress_typing_bubble: true } via overrides.
      suppress_typing_bubble: false,
      ...overrides,
    },
    album: { flush_ms: 2000 },
    voice: { provider: 'groq', language: 'ru', model: 'whisper-large-v3-turbo' },
    webhook: { enabled: false, host: '127.0.0.1', port: 0 },
    permission_relay: { enabled: true, allowed_user_ids: [164795011], bash_only_proof: true },
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
  kind: 'send' | 'edit' | 'delete' | 'chat_action'
  chatId: string
  messageId?: number
  text?: string
  opts?: unknown
  action?: string
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
    sendChatAction: async (chatId: string, action: string) => {
      state.calls.push({ kind: 'chat_action', chatId, action })
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
    // `sendChatAction` is also called immediately, so filter to the
    // message-send subset before asserting length.
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(1)
    const sent = api.calls.find((c) => c.kind === 'send')!
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

  test('start finalises previous active status before opening a new one', async () => {
    // M3 fix: only one active status per chat. Calling start() twice in a
    // row must edit the prior message to a terminal label ("Остановлено:
    // superseded") before sending the new typing message, otherwise the
    // album path leaks stale pulsing status messages.
    const { mgr, api } = makeManager()
    const firstHandle = await mgr.start('164795011', undefined)
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(1)
    await mgr.start('164795011', undefined)
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(edits.length).toBeGreaterThanOrEqual(1)
    // The cancel-edit targets the FIRST message id and ends with "superseded".
    const cancelEdit = edits.find((e) => e.messageId === firstHandle.messageId)
    expect(cancelEdit).toBeDefined()
    expect(cancelEdit!.text).toContain('Остановлено')
    expect(cancelEdit!.text).toContain('superseded')
    // Two distinct send calls — one per start().
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(2)
  })

  test('start cancel-edit on the previous status survives a "message not modified" error', async () => {
    const { mgr, api } = makeManager()
    await mgr.start('164795011', undefined)
    // Force the cancel-edit on the previous status to fail with the
    // benign "not modified" error — start() must still complete.
    api.failEditWith = new Error('Bad Request: message is not modified')
    await mgr.start('164795011', undefined)
    expect(mgr.isActive('164795011')).toBe(true)
  })

  test('start fires a `typing` sendChatAction immediately and re-pulses on 4 s timer', async () => {
    // The Telegram-native typing indicator (header animation) expires after
    // ~5 s. StatusManager pulses it on a 4 s timer, with one immediate call
    // on start() so the user sees the indicator without a 4 s delay.
    const { mgr, clock, api } = makeManager()
    await mgr.start('164795011', undefined)
    const actions = api.calls.filter((c) => c.kind === 'chat_action')
    expect(actions.length).toBe(1)
    expect(actions[0]!.action).toBe('typing')
    expect(actions[0]!.chatId).toBe('164795011')

    // Advance just under the pulse window — no new action yet.
    clock.advance(3999)
    expect(api.calls.filter((c) => c.kind === 'chat_action').length).toBe(1)

    // Cross the boundary — second pulse fires.
    clock.advance(1)
    expect(api.calls.filter((c) => c.kind === 'chat_action').length).toBe(2)

    // After complete() the pulse must stop — no further calls even after
    // multiple windows.
    await mgr.complete('164795011')
    clock.advance(20_000)
    expect(api.calls.filter((c) => c.kind === 'chat_action').length).toBe(2)
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

// ─────────────────────────────────────────────────────────────────────
// Phase 7 / T3: recordActivityByChatId — Claude hook integration.
// ─────────────────────────────────────────────────────────────────────

describe('StatusManager.recordActivityByChatId', () => {
  test('PreToolUse on existing status renders activity block edit', async () => {
    const { mgr, api } = makeManager()
    await mgr.start('164795011', undefined)
    await mgr.recordActivityByChatId('164795011', {
      kind: 'tool_start',
      toolName: 'Bash',
      toolInput: { command: 'bun test' },
      toolUseId: 'u1',
    })
    const edits = api.calls.filter((c) => c.kind === 'edit')
    const last = edits[edits.length - 1]!
    expect(last.text).toContain('<pre>')
    expect(last.text).toContain('working --')
    // Humanized line: Bash non-curl/git/read → `running: <code>cmd</code>`
    expect(last.text).toContain('running: <code>bun test</code>')
  })

  test('SessionStart with no active status opens one without reply_to', async () => {
    const { mgr, api } = makeManager()
    await mgr.recordActivityByChatId('164795011', { kind: 'session_start' })
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(1)
    expect(sends[0]!.chatId).toBe('164795011')
    const opts = sends[0]!.opts as { reply_to_message_id?: number }
    expect(opts.reply_to_message_id).toBeUndefined()
    expect(mgr.isActive('164795011')).toBe(true)
  })

  test('Stop calls complete() and stops timers', async () => {
    const { mgr, api } = makeManager()
    await mgr.start('164795011', undefined)
    await mgr.recordActivityByChatId('164795011', { kind: 'session_stop' })
    expect(mgr.isActive('164795011')).toBe(false)
    // delete_on_complete=true by default → expect one delete call.
    const deletes = api.calls.filter((c) => c.kind === 'delete')
    expect(deletes.length).toBe(1)
  })

  test('Agent PreToolUse renders immediately even within throttle window', async () => {
    const { mgr, api, clock } = makeManager()
    await mgr.start('164795011', undefined)
    // First non-Agent record sets lastToolRenderAt.
    await mgr.recordActivityByChatId('164795011', {
      kind: 'tool_start',
      toolName: 'Bash',
      toolInput: { command: 'echo hi' },
      toolUseId: 'u1',
    })
    const beforeAgent = api.calls.filter((c) => c.kind === 'edit').length
    // Within 5 s — non-Agent would NOT trigger an edit. Agent must.
    clock.advance(100)
    await mgr.recordActivityByChatId('164795011', {
      kind: 'tool_start',
      toolName: 'Agent',
      toolInput: { subagent_type: 'researcher' },
      toolUseId: 'u2',
    })
    const afterAgent = api.calls.filter((c) => c.kind === 'edit').length
    expect(afterAgent).toBeGreaterThan(beforeAgent)
    const last = api.calls.filter((c) => c.kind === 'edit').pop()!
    // Humanized Agent line uses SUBAGENT_LABELS map for `researcher`.
    expect(last.text).toContain('<b>searching and verifying sources</b>')
  })

  test('Non-Agent PreToolUse within 5s is recorded but not re-rendered', async () => {
    // Use a very long interval_ms so the dot-animation ticker doesn't add
    // noise edits between our two record calls.
    const config = makeConfig({ interval_ms: 100_000_000 })
    const { mgr, api, clock } = makeManager({ config })
    await mgr.start('164795011', undefined)
    // First non-Agent renders immediately (sentinel → past threshold).
    await mgr.recordActivityByChatId('164795011', {
      kind: 'tool_start',
      toolName: 'Bash',
      toolInput: { command: 'one' },
      toolUseId: 'u1',
    })
    const editsAfterFirst = api.calls.filter((c) => c.kind === 'edit').length
    // Second one within 5 s — throttled, no new edit.
    clock.advance(2000)
    await mgr.recordActivityByChatId('164795011', {
      kind: 'tool_start',
      toolName: 'Bash',
      toolInput: { command: 'two' },
      toolUseId: 'u2',
    })
    expect(api.calls.filter((c) => c.kind === 'edit').length).toBe(editsAfterFirst)
    // PostToolUse (reasoning flip) flushes the buffer — must include `two`.
    await mgr.recordActivityByChatId('164795011', {
      kind: 'tool_end',
      toolName: 'Bash',
      toolInput: { command: 'two' },
      toolUseId: 'u2',
    })
    const lastEdit = api.calls.filter((c) => c.kind === 'edit').pop()!
    // Humanized: Bash non-curl/git/read → `running: <code>two</code>`
    expect(lastEdit.text).toContain('running: <code>two</code>')
    expect(lastEdit.text).toContain('reasoning...')
  })

  test('UserPromptSubmit flips phase to reasoning and renders', async () => {
    const { mgr, api } = makeManager()
    await mgr.start('164795011', undefined)
    await mgr.recordActivityByChatId('164795011', {
      kind: 'tool_start',
      toolName: 'Bash',
      toolInput: { command: 'ls /' },
      toolUseId: 'u1',
    })
    await mgr.recordActivityByChatId('164795011', { kind: 'reasoning' })
    const last = api.calls.filter((c) => c.kind === 'edit').pop()!
    expect(last.text).toContain('reasoning...')
  })

  test('mid-render does not leak raw prompt text through ActivityEvent', async () => {
    const { mgr, api } = makeManager()
    // session_start with no prior status → opens. Then a reasoning event
    // shouldn't carry any user prompt body because the mapping drops it.
    await mgr.recordActivityByChatId('164795011', { kind: 'session_start' })
    await mgr.recordActivityByChatId('164795011', { kind: 'reasoning' })
    const everything = api.calls.map((c) => c.text ?? '').join('\n')
    expect(everything).not.toContain('prompt')
    expect(everything).toContain('working --')
  })

  test('Buffer enforces ACTIVITY_MAX_BUFFER (10) — older shifted out', async () => {
    const { mgr, api, clock } = makeManager()
    await mgr.start('164795011', undefined)
    // Push 12 Agent calls — Agent always renders, so we exercise the path
    // where the buffer caps and the renderer still shows +N earlier.
    for (let i = 0; i < 12; i++) {
      await mgr.recordActivityByChatId('164795011', {
        kind: 'tool_start',
        toolName: 'Agent',
        toolInput: { subagent_type: `subagent-${i}` },
        toolUseId: `u${i}`,
      })
      clock.advance(1)
    }
    const last = api.calls.filter((c) => c.kind === 'edit').pop()!
    // 12 pushed, buffer capped at 10 → 0 and 1 evicted, 2..11 retained.
    // Use unique trailing suffix to avoid substring overlap with -10/-11.
    expect(last.text).not.toMatch(/subagent-0[^0-9]/)
    expect(last.text).not.toMatch(/subagent-1[^0-9]/)
    expect(last.text).toContain('subagent-11')
    expect(last.text).toContain('subagent-10')
    // Renderer window is 5 → "+N earlier" line appears (10 retained, 5 shown).
    expect(last.text).toContain('earlier')
  })

  test('Visibility failure during lazy-open is swallowed', async () => {
    const { mgr, api } = makeManager()
    api.failEditWith = new Error('sendMessage simulated fail')
    // Force sendMessage to throw by overriding the api's send method.
    const origSend = api.api.sendMessage
    api.api.sendMessage = async () => {
      throw new Error('telegram down')
    }
    // Must not throw.
    await mgr.recordActivityByChatId('164795011', { kind: 'session_start' })
    // No active status created → no further calls succeed silently.
    expect(mgr.isActive('164795011')).toBe(false)
    api.api.sendMessage = origSend
  })

  test('Agent tool_result is masked at store time (regression §7)', async () => {
    // The activity buffer must never hold an unmasked secret-shaped string.
    // Pre-fix: raw tool_result lived in `activityCalls[idx].detail` until
    // render. Verify by triggering tool_end with a long token in toolResult
    // and inspecting the subsequent edit text — the masked summary must
    // appear in the very next render (proving the buffer already held it).
    const { mgr, clock, api } = makeManager()
    await mgr.start('164795011', undefined)

    // Pair: PreToolUse with toolUseId → PostToolUse with same id.
    await mgr.recordActivityByChatId('164795011', {
      kind: 'tool_start',
      toolName: 'Agent',
      toolInput: { subagent_type: 'researcher' },
      toolUseId: 'agent-1',
    })

    const longToken = `abcd${'x'.repeat(20)}wxyz` // matches generic-long rule
    clock.advance(100)
    const editsBefore = api.calls.filter((c) => c.kind === 'edit').length
    await mgr.recordActivityByChatId('164795011', {
      kind: 'tool_end',
      toolName: 'Agent',
      toolInput: { subagent_type: 'researcher' },
      toolUseId: 'agent-1',
      toolResult: longToken,
    })
    const editsAfter = api.calls.filter((c) => c.kind === 'edit')
    expect(editsAfter.length).toBeGreaterThan(editsBefore)
    const lastEdit = editsAfter[editsAfter.length - 1]!
    // Token must not appear anywhere in the rendered text; the masked
    // form (abcd***wxyz) confirms maskSecrets ran before store.
    expect(lastEdit.text).not.toContain(longToken)
    expect(lastEdit.text).toContain('abcd***wxyz')
  })

  test('Non-Agent throttle + buffer overflow interaction (coverage gap §3)', async () => {
    // Fire 12 Bash calls in quick succession. First non-Agent always renders
    // (sentinel `Number.NEGATIVE_INFINITY`); subsequent calls within the
    // 5 s throttle are buffered without an extra edit. Buffer cap is 10 →
    // calls 0 and 1 evict; render window is 5 → on the eventual flush the
    // edit shows the most recent 5 + a `+5 earlier` summary (10 buffered − 5
    // shown). Flush via a `reasoning` event since it always renders.
    const config = makeConfig({ interval_ms: 100_000_000 })
    const { mgr, api, clock } = makeManager({ config })
    await mgr.start('164795011', undefined)

    const editsAtStart = api.calls.filter((c) => c.kind === 'edit').length
    for (let i = 0; i < 12; i++) {
      await mgr.recordActivityByChatId('164795011', {
        kind: 'tool_start',
        toolName: 'Bash',
        toolInput: { command: `cmd-${i.toString().padStart(2, '0')}` },
        toolUseId: `u${i}`,
      })
      // Stay well within the 5 s throttle window so only the first renders.
      clock.advance(100)
    }
    // Only the first Bash should have triggered an edit (sentinel render);
    // remaining 11 were throttled.
    const editsAfterTools = api.calls.filter((c) => c.kind === 'edit').length
    expect(editsAfterTools - editsAtStart).toBe(1)

    // Flush via reasoning event → always renders.
    await mgr.recordActivityByChatId('164795011', { kind: 'reasoning' })
    const last = api.calls.filter((c) => c.kind === 'edit').pop()!
    // Buffer kept the last 10 (cmd-02..cmd-11). Renderer window is 5 →
    // show cmd-07..cmd-11 + a `+5 earlier` line (10 buffered − 5 shown).
    expect(last.text).toContain('+5 earlier')
    expect(last.text).toContain('cmd-11')
    expect(last.text).toContain('cmd-07')
    // cmd-00 and cmd-01 evicted; cmd-02..cmd-06 in the +5 collapse.
    expect(last.text).not.toContain('cmd-00')
    expect(last.text).not.toContain('cmd-01')
    expect(last.text).not.toContain('cmd-06')
  })
})

describe('StatusManager.suppress_typing_bubble', () => {
  // Warchief request 2026-05-27: the «Печатает...» bubble is visual noise
  // on top of TmuxMirror. When suppress_typing_bubble=true (production
  // default), the bubble must NOT exist until state advances past typing.
  // Native sendChatAction (header animation) and TTL guard still run.

  test('skips initial sendMessage while state is typing', async () => {
    const { mgr, api } = makeManager({
      config: makeConfig({ suppress_typing_bubble: true }),
    })
    const handle = await mgr.start('164795011', undefined)
    expect(handle.messageId).toBe(0)
    // No send for the bubble. sendChatAction still fires immediately so the
    // Telegram header animation is unchanged.
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(0)
    expect(api.calls.filter((c) => c.kind === 'chat_action').length).toBe(1)
    expect(mgr.isActive('164795011')).toBe(true)
  })

  test('does not edit while state stays in typing across ticks', async () => {
    const { mgr, api, clock } = makeManager({
      config: makeConfig({ suppress_typing_bubble: true }),
    })
    await mgr.start('164795011', undefined)
    clock.advance(5000)
    expect(api.calls.filter((c) => c.kind === 'edit').length).toBe(0)
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(0)
  })

  test('lazy-creates bubble on first non-typing update', async () => {
    const { mgr, api } = makeManager({
      config: makeConfig({ suppress_typing_bubble: true }),
    })
    await mgr.start('164795011', 4242)
    await mgr.updateByChatId('164795011', { kind: 'tool', toolName: 'Bash' })
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toContain('Bash')
    // Lazy create preserves the original reply target captured at start.
    const opts = sends[0]!.opts as { reply_to_message_id?: number }
    expect(opts.reply_to_message_id).toBe(4242)
  })

  test('lazy-creates bubble on first activity event', async () => {
    const { mgr, api } = makeManager({
      config: makeConfig({ suppress_typing_bubble: true }),
    })
    await mgr.start('164795011', undefined)
    await mgr.recordActivityByChatId('164795011', { kind: 'reasoning' })
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(1)
    // First render is the activity block, not «Печатает...».
    expect(sends[0]!.text).not.toContain('Печатает')
  })

  test('cancel on a pure-typing session is a quiet no-op (no edit, no leak)', async () => {
    const { mgr, api } = makeManager({
      config: makeConfig({ suppress_typing_bubble: true }),
    })
    await mgr.start('164795011', undefined)
    await mgr.cancel('164795011', 'user stop')
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(0)
    expect(api.calls.filter((c) => c.kind === 'edit').length).toBe(0)
    expect(mgr.isActive('164795011')).toBe(false)
  })

  test('complete on a pure-typing session does not call deleteMessage', async () => {
    const { mgr, api } = makeManager({
      config: makeConfig({ suppress_typing_bubble: true }),
    })
    await mgr.start('164795011', undefined)
    await mgr.complete('164795011')
    expect(api.calls.filter((c) => c.kind === 'delete').length).toBe(0)
    expect(mgr.isActive('164795011')).toBe(false)
  })

  test('TTL on a pure-typing session expires silently without «Остановлено» bubble', async () => {
    const { mgr, api, clock, config } = makeManager({
      config: makeConfig({ suppress_typing_bubble: true }),
    })
    await mgr.start('164795011', undefined)
    clock.advance(config.status.ttl_ms + 1)
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(0)
    expect(api.calls.filter((c) => c.kind === 'edit').length).toBe(0)
    expect(mgr.isActive('164795011')).toBe(false)
  })

  test('chat_action still pulses on the 4s timer while bubble is suppressed', async () => {
    const { mgr, api, clock } = makeManager({
      config: makeConfig({ suppress_typing_bubble: true }),
    })
    await mgr.start('164795011', undefined)
    expect(api.calls.filter((c) => c.kind === 'chat_action').length).toBe(1)
    clock.advance(4000)
    expect(api.calls.filter((c) => c.kind === 'chat_action').length).toBe(2)
    clock.advance(4000)
    expect(api.calls.filter((c) => c.kind === 'chat_action').length).toBe(3)
  })

  test('subsequent edits after lazy-create go through editMessageText', async () => {
    const { mgr, api } = makeManager({
      config: makeConfig({ suppress_typing_bubble: true }),
    })
    await mgr.start('164795011', undefined)
    await mgr.updateByChatId('164795011', { kind: 'thinking' })
    await mgr.updateByChatId('164795011', { kind: 'tool', toolName: 'Read' })
    // First non-typing transition sends; second edits the same message.
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(1)
    expect(api.calls.filter((c) => c.kind === 'edit').length).toBeGreaterThanOrEqual(1)
    const lastEdit = api.calls.filter((c) => c.kind === 'edit').pop()!
    expect(lastEdit.text).toContain('Read')
  })
})
