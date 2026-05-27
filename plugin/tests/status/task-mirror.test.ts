// TaskMirror tests (PR-A2 / 2026-05-20) — third rolling Telegram message
// per chat, showing Claude's TodoWrite milestone list. Patterned on
// tests/status/progress-reporter.test.ts: FakeClock + FakeApi, no real
// network or timers.
//
// Behaviour under test:
//   1. First TodoWrite event sends a new Telegram message.
//   2. Second event with a different snapshot edits the existing message.
//   3. Same snapshot replayed (idempotency) is a no-op.
//   4. Throttle: rapid events collapse to a single deferred edit.
//   5. session_stop: posts a final edit, evicts entry. Next event starts fresh.
//   6. TTL eviction: idle entry past session_ttl_ms → fresh thread.
//   7. Multi-chat isolation.
//   8. Malformed tool_input is handled upstream — TaskMirror sees only valid
//      events.
//   9. Empty todos array renders «задач нет».
//  10. collapse_completed_after: «+M завершено ранее» tail.
//  11. Long todo lines stay under Telegram's 4096-char cap.

import { describe, expect, test } from 'bun:test'

import {
  TaskMirror,
  renderTodoList,
} from '../../src/status/task-mirror.js'
import type { TelegramApiForProgress } from '../../src/status/telegram-api.js'
import type { AppConfig } from '../../src/config.js'
import type { TaskMirrorEvent } from '../../src/hooks/claude-events.js'
import type { TodoItem } from '../../src/schemas.js'
import { createLogger } from '../../src/log.js'

const silentLog = createLogger('test', {
  stream: { write: () => true } as unknown as NodeJS.WritableStream,
})

function makeConfig(overrides: Partial<AppConfig['task_mirror']> = {}): AppConfig {
  return {
    bot_id: 8507713167,
    dm_only: true,
    allowed_user_ids: [164795011],
    allowed_chat_ids: [164795011],
    status: { enabled: true, interval_ms: 700, ttl_ms: 300_000, delete_on_complete: true, suppress_typing_bubble: false },
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
      session_ttl_ms: 10 * 60 * 1000,
    },
    task_mirror: {
      enabled: true,
      edit_throttle_ms: 3000,
      session_ttl_ms: 10 * 60 * 1000,
      collapse_completed_after: 5,
      ...overrides,
    },
    watcher: {
      enabled: true,
      debounce_ms: 10_000,
      busy_threshold_ms: 30_000,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────
// Fake clock (copy of the helper from progress-reporter.test.ts)
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
    t.fired = true
  }
  advance(ms: number): void {
    const deadline = this.now + ms
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

// ─────────────────────────────────────────────────────────────────────
// Fake Telegram API
// ─────────────────────────────────────────────────────────────────────

interface ApiCall {
  kind: 'send' | 'edit'
  chatId: string
  messageId?: number
  text: string
}

interface FakeApi {
  api: TelegramApiForProgress
  calls: ApiCall[]
  nextMessageId: number
  failSendWith?: Error
  failEditWith?: Error
}

function makeFakeApi(): FakeApi {
  const state: FakeApi = {
    calls: [],
    nextMessageId: 200,
    api: undefined as unknown as TelegramApiForProgress,
  }
  state.api = {
    sendMessage: async (chatId: string, text: string, _opts: unknown) => {
      if (state.failSendWith) throw state.failSendWith
      const id = state.nextMessageId++
      state.calls.push({ kind: 'send', chatId, messageId: id, text })
      return { message_id: id }
    },
    editMessageText: async (chatId: string, messageId: number, text: string, _opts: unknown) => {
      state.calls.push({ kind: 'edit', chatId, messageId, text })
      if (state.failEditWith) throw state.failEditWith
    },
  }
  return state
}

function makeMirror(opts: { config?: AppConfig; clock?: FakeClock; api?: FakeApi } = {}): {
  mirror: TaskMirror
  clock: FakeClock
  api: FakeApi
  config: AppConfig
} {
  const clock = opts.clock ?? new FakeClock()
  const api = opts.api ?? makeFakeApi()
  const config = opts.config ?? makeConfig()
  const mirror = new TaskMirror({
    telegramApi: api.api,
    config,
    log: silentLog,
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  return { mirror, clock, api, config }
}

function todoEvent(todos: TodoItem[]): TaskMirrorEvent {
  return { kind: 'todo_write', todos }
}

function taskCreateEvent(
  toolUseId: string,
  subject: string,
  opts: { activeForm?: string; toolResult?: string } = {},
): TaskMirrorEvent {
  const event: Extract<TaskMirrorEvent, { kind: 'task_create' }> = {
    kind: 'task_create',
    toolUseId,
    input: {
      subject,
      ...(opts.activeForm !== undefined ? { activeForm: opts.activeForm } : {}),
    },
  }
  return opts.toolResult !== undefined
    ? { ...event, toolResult: opts.toolResult }
    : event
}

function taskUpdateEvent(
  taskId: string,
  patch: Partial<{
    status: 'pending' | 'in_progress' | 'completed' | 'deleted'
    subject: string
    activeForm: string
  }>,
): TaskMirrorEvent {
  return {
    kind: 'task_update',
    toolUseId: `tu-update-${taskId}`,
    input: {
      taskId,
      ...patch,
    },
  }
}

const STOP: TaskMirrorEvent = { kind: 'todo_session_stop' }

// ─────────────────────────────────────────────────────────────────────
// Tests — recordEvent / lifecycle
// ─────────────────────────────────────────────────────────────────────

describe('TaskMirror', () => {
  test('first TodoWrite event sends a new Telegram message', async () => {
    const { mirror, api } = makeMirror()
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'Implement feature X', status: 'in_progress' },
      { content: 'Tests', status: 'pending' },
    ]))
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(1)
    expect(sends[0]!.chatId).toBe('chat-1')
    expect(sends[0]!.text).toContain('Задачи')
    expect(sends[0]!.text).toContain('Implement feature X')
    expect(sends[0]!.text).toContain('Tests')
  })

  test('second event with a different snapshot edits the existing message', async () => {
    const { mirror, clock, api } = makeMirror()
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'Step A', status: 'in_progress' },
    ]))
    clock.advance(3000)
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'Step A', status: 'completed' },
      { content: 'Step B', status: 'in_progress' },
    ]))
    await mirror._idleForTests('chat-1')
    const sends = api.calls.filter((c) => c.kind === 'send')
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(sends.length).toBe(1)
    expect(edits.length).toBe(1)
    expect(edits[0]!.text).toContain('Step B')
  })

  test('same snapshot replayed is a no-op (idempotency)', async () => {
    const { mirror, clock, api } = makeMirror()
    const todos: TodoItem[] = [
      { content: 'Build', status: 'in_progress' },
      { content: 'Ship', status: 'pending' },
    ]
    await mirror.recordEvent('chat-1', todoEvent(todos))
    clock.advance(3000)
    // Same shape, fresh array — TaskMirror compares the rendered text, so
    // structural equality of content is what matters.
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'Build', status: 'in_progress' },
      { content: 'Ship', status: 'pending' },
    ]))
    await mirror._idleForTests('chat-1')
    const sends = api.calls.filter((c) => c.kind === 'send')
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(sends.length).toBe(1)
    expect(edits.length).toBe(0)
  })

  test('rapid events within throttle window collapse into a single deferred edit', async () => {
    const { mirror, clock, api } = makeMirror()
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'Step A', status: 'in_progress' },
    ]))
    // Within throttle: 3 fast events. None should fire an immediate edit.
    clock.advance(500)
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'Step A', status: 'completed' },
      { content: 'Step B', status: 'in_progress' },
    ]))
    clock.advance(500)
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'Step A', status: 'completed' },
      { content: 'Step B', status: 'completed' },
      { content: 'Step C', status: 'in_progress' },
    ]))
    expect(api.calls.filter((c) => c.kind === 'edit').length).toBe(0)

    // Past throttle — single coalesced edit lands with the freshest snapshot.
    clock.advance(2001)
    await mirror._idleForTests('chat-1')
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(edits.length).toBe(1)
    expect(edits[0]!.text).toContain('Step C')
  })

  test('session_stop ships final edit with «сессия завершена» marker and evicts entry', async () => {
    const { mirror, clock, api } = makeMirror()
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'Step A', status: 'in_progress' },
    ]))
    clock.advance(3000)
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'Step A', status: 'completed' },
    ]))
    await mirror._idleForTests('chat-1')
    const editsBeforeStop = api.calls.filter((c) => c.kind === 'edit').length
    expect(editsBeforeStop).toBeGreaterThanOrEqual(1)

    await mirror.recordEvent('chat-1', STOP)
    // Final edit contains the «сессия завершена» marker.
    const editsAfterStop = api.calls.filter((c) => c.kind === 'edit')
    const finalEdit = editsAfterStop[editsAfterStop.length - 1]
    expect(finalEdit!.text).toContain('сессия завершена')

    // Subsequent event after stop: must send a NEW message (msg_id 201, since
    // 200 was the original send).
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'New task', status: 'in_progress' },
    ]))
    await mirror._idleForTests('chat-1')
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(2)
    expect(sends[1]!.messageId).toBe(201)
  })

  test('session_stop on an unchanged snapshot STILL fires a final edit (marker breaks idempotency)', async () => {
    const { mirror, clock, api } = makeMirror()
    // One TodoWrite — establishes the message.
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'Solo task', status: 'in_progress' },
    ]))
    clock.advance(3000)
    await mirror._idleForTests('chat-1')
    // No intermediate edits — snapshot has not changed.
    expect(api.calls.filter((c) => c.kind === 'edit').length).toBe(0)

    // STOP: even though the snapshot is byte-for-byte the same as the initial
    // send, the marker guarantees the final text differs, so an edit fires.
    await mirror.recordEvent('chat-1', STOP)
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(edits.length).toBe(1)
    expect(edits[0]!.text).toContain('сессия завершена')
  })

  test('TTL eviction: idle entry past session_ttl_ms starts a fresh thread', async () => {
    const { mirror, clock, api } = makeMirror({
      config: makeConfig({ session_ttl_ms: 60_000 }),
    })
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'Step A', status: 'in_progress' },
    ]))
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(1)

    clock.advance(60_001)
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'Step B', status: 'in_progress' },
    ]))
    const sends = api.calls.filter((c) => c.kind === 'send')
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(sends.length).toBe(2)
    expect(sends[1]!.messageId).toBe(201)
    expect(edits.length).toBe(0)
  })

  test('multi-chat isolation: chat A stop does not affect chat B', async () => {
    const { mirror, clock, api } = makeMirror()
    await mirror.recordEvent('chat-A', todoEvent([
      { content: 'A1', status: 'in_progress' },
    ]))
    await mirror.recordEvent('chat-B', todoEvent([
      { content: 'B1', status: 'in_progress' },
    ]))
    const sendsAfterInit = api.calls.filter((c) => c.kind === 'send')
    expect(sendsAfterInit.length).toBe(2)

    await mirror.recordEvent('chat-A', STOP)
    clock.advance(3001)
    // Chat B still owns its message.
    await mirror.recordEvent('chat-B', todoEvent([
      { content: 'B1', status: 'completed' },
      { content: 'B2', status: 'in_progress' },
    ]))
    await mirror._idleForTests('chat-B')
    const editsB = api.calls.filter((c) => c.kind === 'edit' && c.chatId === 'chat-B')
    expect(editsB.length).toBeGreaterThanOrEqual(1)
    expect(editsB[editsB.length - 1]!.text).toContain('B2')
  })

  test('disabled config is a hard no-op', async () => {
    const { mirror, api } = makeMirror({
      config: makeConfig({ enabled: false }),
    })
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'X', status: 'in_progress' },
    ]))
    await mirror.recordEvent('chat-1', STOP)
    expect(api.calls.length).toBe(0)
  })

  test('sendMessage failure is swallowed; next event retries', async () => {
    const api = makeFakeApi()
    api.failSendWith = new Error('telegram down')
    const { mirror, clock } = makeMirror({ api })

    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'X', status: 'in_progress' },
    ]))
    expect(api.calls.length).toBe(0)

    delete api.failSendWith
    clock.advance(10)
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'Y', status: 'in_progress' },
    ]))
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(1)
  })

  // ─────────────────────────────────────────────────────────────────────
  // TaskCreate / TaskUpdate (incremental events, newer Claude Code harness)
  // ─────────────────────────────────────────────────────────────────────

  test('task_create: PreToolUse adds a pending task to the snapshot', async () => {
    const { mirror, api } = makeMirror()
    await mirror.recordEvent('chat-1', taskCreateEvent('tu-1', 'Implement X'))
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toContain('Implement X')
    expect(sends[0]!.text).toContain('1 pending')
  })

  test('task_update: status change moves the item from pending to in_progress', async () => {
    const { mirror, api, clock } = makeMirror()
    await mirror.recordEvent('chat-1', taskCreateEvent('tu-1', 'Build feature'))
    clock.advance(10)
    // PostToolUse of TaskCreate carries the harness-assigned id via toolResult.
    await mirror.recordEvent(
      'chat-1',
      taskCreateEvent('tu-1', 'Build feature', { toolResult: 'Task #7 created successfully' }),
    )
    clock.advance(5000)
    await mirror.recordEvent('chat-1', taskUpdateEvent('7', { status: 'in_progress' }))
    await mirror._idleForTests('chat-1')
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(edits.length).toBeGreaterThanOrEqual(1)
    expect(edits[edits.length - 1]!.text).toContain('Build feature')
    expect(edits[edits.length - 1]!.text).toContain('1 in progress')
  })

  test('task_update: completing the task moves it to the completed bucket', async () => {
    const { mirror, api, clock } = makeMirror()
    await mirror.recordEvent(
      'chat-1',
      taskCreateEvent('tu-1', 'Ship it', { toolResult: 'Task #3 created' }),
    )
    clock.advance(5000)
    await mirror.recordEvent('chat-1', taskUpdateEvent('3', { status: 'completed' }))
    await mirror._idleForTests('chat-1')
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(edits[edits.length - 1]!.text).toContain('1 done')
    expect(edits[edits.length - 1]!.text).toContain('Ship it')
  })

  test('task_update: status=deleted removes the entry entirely', async () => {
    const { mirror, api, clock } = makeMirror()
    await mirror.recordEvent(
      'chat-1',
      taskCreateEvent('tu-1', 'Maybe', { toolResult: 'Task #9 created' }),
    )
    clock.advance(5000)
    await mirror.recordEvent('chat-1', taskUpdateEvent('9', { status: 'deleted' }))
    await mirror._idleForTests('chat-1')
    const edits = api.calls.filter((c) => c.kind === 'edit')
    const finalText = edits[edits.length - 1]?.text ?? ''
    expect(finalText).not.toContain('Maybe')
    expect(finalText).toContain('задач нет')
  })

  test('todo_write after task_create wipes the incremental Map (no double-counting)', async () => {
    const { mirror, api, clock } = makeMirror()
    await mirror.recordEvent('chat-1', taskCreateEvent('tu-1', 'Stale via Task*'))
    clock.advance(5000)
    await mirror.recordEvent('chat-1', todoEvent([{ content: 'Fresh via TodoWrite', status: 'in_progress' }]))
    await mirror._idleForTests('chat-1')
    const edits = api.calls.filter((c) => c.kind === 'edit')
    const finalText = edits[edits.length - 1]?.text ?? ''
    expect(finalText).toContain('Fresh via TodoWrite')
    expect(finalText).not.toContain('Stale via Task*')
  })

  test('task_update: missing TaskCreate synthesises placeholder so the list stays consistent', async () => {
    const { mirror, api } = makeMirror()
    // TaskUpdate arrives without preceding TaskCreate (webhook drop scenario).
    await mirror.recordEvent('chat-1', taskUpdateEvent('42', { status: 'in_progress', subject: 'Recovered' }))
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toContain('Recovered')
    expect(sends[0]!.text).toContain('1 in progress')
  })

  // ─────────────────────────────────────────────────────────────────────
  // Renderer tests
  // ─────────────────────────────────────────────────────────────────────

  test('renderTodoList: empty list renders «задач нет»', () => {
    const text = renderTodoList([], 5)
    expect(text).toContain('Задачи')
    expect(text).toContain('задач нет')
  })

  test('renderTodoList: collapse_completed_after=2 with 5 completed + 1 in_progress shows tail', () => {
    const todos: TodoItem[] = [
      { content: 'In flight', status: 'in_progress' },
      { content: 'Done 1', status: 'completed' },
      { content: 'Done 2', status: 'completed' },
      { content: 'Done 3', status: 'completed' },
      { content: 'Done 4', status: 'completed' },
      { content: 'Done 5', status: 'completed' },
    ]
    const text = renderTodoList(todos, 2)
    // Last two completed remain, three are collapsed.
    expect(text).toContain('In flight')
    expect(text).toContain('Done 4')
    expect(text).toContain('Done 5')
    expect(text).toContain('+3 завершено ранее')
    expect(text).not.toContain('Done 1')
    expect(text).not.toContain('Done 2')
    expect(text).not.toContain('Done 3')
  })

  test('renderTodoList: escapes HTML in content', () => {
    const todos: TodoItem[] = [
      { content: 'Read <script>alert(1)</script>', status: 'in_progress' },
    ]
    const text = renderTodoList(todos, 5)
    expect(text).not.toContain('<script>')
    expect(text).toContain('&lt;script&gt;')
  })

  test('renderTodoList: in_progress prefers activeForm when present', () => {
    const todos: TodoItem[] = [
      { content: 'Read file', activeForm: 'Reading file', status: 'in_progress' },
    ]
    const text = renderTodoList(todos, 5)
    expect(text).toContain('Reading file')
  })

  test('renderTodoList: counts header reports done/in_progress/pending', () => {
    const todos: TodoItem[] = [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'in_progress' },
      { content: 'd', status: 'pending' },
      { content: 'e', status: 'pending' },
      { content: 'f', status: 'pending' },
    ]
    const text = renderTodoList(todos, 5)
    expect(text).toContain('2 done / 1 in progress / 3 pending')
  })

  test('renderTodoList: 100 long todos respect the 3500-char budget', () => {
    const todos: TodoItem[] = []
    for (let i = 0; i < 100; i++) {
      todos.push({
        content: `Task #${i}: ${'x'.repeat(200)}`,
        status: i < 5 ? 'completed' : 'pending',
      })
    }
    const text = renderTodoList(todos, 5)
    expect(text.length).toBeLessThanOrEqual(3500)
    // Must contain at least the header and SOME indication of truncation.
    expect(text).toContain('Задачи')
    // No malformed HTML — angle brackets balance via our explicit emission
    // of <b>/<i> only; nothing else should appear.
    const opens = (text.match(/<(b|i)>/g) ?? []).length
    const closes = (text.match(/<\/(b|i)>/g) ?? []).length
    expect(opens).toBe(closes)
  })
})
