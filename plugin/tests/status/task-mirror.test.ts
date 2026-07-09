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

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    tmux_mirror: { enabled: false, pane_target: '', socket_name: '', poll_interval_ms: 5000, line_count: 50, hide_segments: ['boot_banner', 'inbound_warning', 'footer_hints', 'input_box'], mode: 'latest_inbound_only', max_lines: 14 },
    multichat: { enabled: false },
    ask_user_question: { enabled: false, timeout_ms: 300_000, max_preview_chars: 1000 },
    permission_gate: { enabled: false, timeout_ms: 120_000 },
    richMessages: { enabled: false, perChatOptOut: [] },
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

// Track temp dirs for cleanup (persistence tests).
const tmpDirs: string[] = []
function stateDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'task-mirror-'))
  tmpDirs.push(d)
  return d
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

function makeMirror(
  opts: { config?: AppConfig; clock?: FakeClock; api?: FakeApi; stateDir?: string } = {},
): {
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
    ...(opts.stateDir !== undefined ? { stateDir: opts.stateDir } : {}),
  })
  return { mirror, clock, api, config }
}

// Default session id used by the helpers so existing tests keep a single,
// stable session unless they explicitly pass a different one.
const SID = 'sess-A'

function todoEvent(todos: TodoItem[], sessionId: string = SID): TaskMirrorEvent {
  return { kind: 'todo_write', sessionId, todos }
}

function taskCreateEvent(
  toolUseId: string,
  subject: string,
  opts: { activeForm?: string; toolResult?: string; sessionId?: string } = {},
): TaskMirrorEvent {
  const event: Extract<TaskMirrorEvent, { kind: 'task_create' }> = {
    kind: 'task_create',
    sessionId: opts.sessionId ?? SID,
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
  sessionId: string = SID,
): TaskMirrorEvent {
  return {
    kind: 'task_update',
    sessionId,
    toolUseId: `tu-update-${taskId}`,
    input: {
      taskId,
      ...patch,
    },
  }
}

function sessionStart(sessionId: string, source?: 'startup' | 'resume' | 'clear' | 'compact'): TaskMirrorEvent {
  return { kind: 'session_start', sessionId, ...(source !== undefined ? { source } : {}) }
}

function sessionEnd(sessionId: string = SID): TaskMirrorEvent {
  return { kind: 'session_end', sessionId }
}

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

  test('session_end ships final edit with «сессия завершена» marker and evicts entry', async () => {
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

    await mirror.recordEvent('chat-1', sessionEnd())
    // Final edit contains the «сессия завершена» marker.
    const editsAfterStop = api.calls.filter((c) => c.kind === 'edit')
    const finalEdit = editsAfterStop[editsAfterStop.length - 1]
    expect(finalEdit!.text).toContain('сессия завершена')

    // A LATE straggler naming the ENDED session is DROPPED (review 2026-07-09
    // #2: the session is tombstoned — no resurrection, no new message).
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'Straggler from dead session', status: 'in_progress' },
    ]))
    await mirror._idleForTests('chat-1')
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(1)

    // An event from a NEW session gets a fresh message (msg_id 201, since 200
    // was the original send).
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'New task', status: 'in_progress' },
    ], 'sess-B'))
    await mirror._idleForTests('chat-1')
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(2)
    expect(sends[1]!.messageId).toBe(201)
  })

  test('session_end on an unchanged snapshot STILL fires a final edit (marker breaks idempotency)', async () => {
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
    await mirror.recordEvent('chat-1', sessionEnd())
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(edits.length).toBe(1)
    expect(edits[0]!.text).toContain('сессия завершена')
  })

  test('TTL does NOT expire an active same-session snapshot (orphan cleanup only)', async () => {
    // New semantics: the mirror no longer finalizes on Stop, so an idle gap is
    // normal. A same-session update after a long idle must EDIT the existing
    // message, never start a fresh thread — the warchief keeps his task list.
    const { mirror, clock, api } = makeMirror({
      config: makeConfig({ session_ttl_ms: 60_000 }),
    })
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'Step A', status: 'in_progress' },
    ]))
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(1)

    clock.advance(60_001) // long idle, but SAME session
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'Step A', status: 'completed' },
      { content: 'Step B', status: 'in_progress' },
    ]))
    await mirror._idleForTests('chat-1')
    const sends = api.calls.filter((c) => c.kind === 'send')
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(sends.length).toBe(1) // no fresh thread
    expect(edits.length).toBe(1) // same message edited in place
    expect(edits[0]!.messageId).toBe(200)
    expect(edits[0]!.text).toContain('Step B')
  })

  test('multi-chat isolation: chat A session end does not affect chat B', async () => {
    const { mirror, clock, api } = makeMirror()
    await mirror.recordEvent('chat-A', todoEvent([
      { content: 'A1', status: 'in_progress' },
    ]))
    await mirror.recordEvent('chat-B', todoEvent([
      { content: 'B1', status: 'in_progress' },
    ]))
    const sendsAfterInit = api.calls.filter((c) => c.kind === 'send')
    expect(sendsAfterInit.length).toBe(2)

    await mirror.recordEvent('chat-A', sessionEnd())
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
    await mirror.recordEvent('chat-1', sessionEnd())
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
  // Session lifecycle (namespacing) — the reset/finalize semantics
  // ─────────────────────────────────────────────────────────────────────

  test('three task_create events → canonical ids, correct order, no provisional duplicate', async () => {
    const { mirror, api, clock } = makeMirror()
    // Each PostToolUse create carries the harness id via toolResult.
    await mirror.recordEvent('chat-1', taskCreateEvent('tu-1', 'First', { toolResult: 'Task #1 created' }))
    clock.advance(3000)
    await mirror.recordEvent('chat-1', taskCreateEvent('tu-2', 'Second', { toolResult: 'Task #2 created' }))
    clock.advance(3000)
    await mirror.recordEvent('chat-1', taskCreateEvent('tu-3', 'Third', { toolResult: 'Task #3 created' }))
    await mirror._idleForTests('chat-1')
    const last = [...api.calls].reverse().find((c) => c.kind === 'edit' || c.kind === 'send')!
    expect(last.text).toContain('3 pending')
    // Order preserved and no duplicated rows.
    expect(last.text.indexOf('First')).toBeLessThan(last.text.indexOf('Second'))
    expect(last.text.indexOf('Second')).toBeLessThan(last.text.indexOf('Third'))
    expect((last.text.match(/First/g) ?? []).length).toBe(1)
  })

  test('session_start with the SAME id preserves the snapshot (compact)', async () => {
    const { mirror, api, clock } = makeMirror()
    await mirror.recordEvent('chat-1', todoEvent([{ content: 'Ongoing', status: 'in_progress' }], 'sess-A'))
    clock.advance(3000)
    // Compact fires SessionStart with the same id — must NOT reset or send anew.
    await mirror.recordEvent('chat-1', sessionStart('sess-A', 'compact'))
    await mirror.recordEvent('chat-1', todoEvent([
      { content: 'Ongoing', status: 'completed' },
      { content: 'Next', status: 'in_progress' },
    ], 'sess-A'))
    await mirror._idleForTests('chat-1')
    const sends = api.calls.filter((c) => c.kind === 'send')
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(sends.length).toBe(1) // no fresh thread on compact
    expect(edits[edits.length - 1]!.text).toContain('Next')
    // No «сессия завершена» marker — the session did not end.
    expect(api.calls.every((c) => !c.text.includes('сессия завершена'))).toBe(true)
  })

  test('session_start with a NEW id finalizes the old snapshot and starts fresh', async () => {
    const { mirror, api, clock } = makeMirror()
    await mirror.recordEvent('chat-1', todoEvent([{ content: 'Old task', status: 'in_progress' }], 'sess-A'))
    clock.advance(3000)
    await mirror.recordEvent('chat-1', sessionStart('sess-B', 'startup'))
    // Old message got a final «сессия завершена» edit.
    const finalEdit = api.calls.filter((c) => c.kind === 'edit').pop()
    expect(finalEdit!.text).toContain('сессия завершена')
    // New session's first task → a brand-new message (msg 201).
    await mirror.recordEvent('chat-1', todoEvent([{ content: 'New task', status: 'in_progress' }], 'sess-B'))
    await mirror._idleForTests('chat-1')
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(2)
    expect(sends[1]!.messageId).toBe(201)
    expect(sends[1]!.text).toContain('New task')
  })

  test('task event with a new session id resets even without a SessionStart hook', async () => {
    const { mirror, api, clock } = makeMirror()
    await mirror.recordEvent('chat-1', todoEvent([{ content: 'Alpha', status: 'in_progress' }], 'sess-A'))
    clock.advance(3000)
    // First event of a new session, SessionStart missed → still resets.
    await mirror.recordEvent('chat-1', todoEvent([{ content: 'Beta', status: 'in_progress' }], 'sess-B'))
    await mirror._idleForTests('chat-1')
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(2) // fresh message for the new session
    expect(sends[1]!.text).toContain('Beta')
    expect(sends[1]!.text).not.toContain('Alpha')
  })

  test('burst updates across a session transition do not overwrite the new session message', async () => {
    const { mirror, api, clock } = makeMirror()
    // Session A: a burst of updates, all within the throttle window (deferred).
    await mirror.recordEvent('chat-1', todoEvent([{ content: 'A step 1', status: 'in_progress' }], 'sess-A'))
    clock.advance(200)
    await mirror.recordEvent('chat-1', todoEvent([{ content: 'A step 2', status: 'in_progress' }], 'sess-A'))
    clock.advance(200)
    // Session B begins mid-burst: finalize A (its pending edit is cancelled),
    // then B sends its own message.
    await mirror.recordEvent('chat-1', sessionStart('sess-B', 'clear'))
    await mirror.recordEvent('chat-1', todoEvent([{ content: 'B step 1', status: 'in_progress' }], 'sess-B'))
    await mirror._idleForTests('chat-1')
    // Drain any stale A timer that might fire late.
    clock.advance(5000)
    await mirror._idleForTests('chat-1')

    const bMessageId = api.calls.filter((c) => c.kind === 'send').pop()!.messageId!
    // No edit to B's message may contain session A content.
    const bEdits = api.calls.filter((c) => c.kind === 'edit' && c.messageId === bMessageId)
    for (const e of bEdits) {
      expect(e.text).not.toContain('A step')
    }
    // B's message shows B's task.
    const bView = [...api.calls].reverse().find((c) => c.messageId === bMessageId)!
    expect(bView.text).toContain('B step 1')
  })

  test('persistence: a new instance with the same state dir restores the snapshot', async () => {
    const dir = stateDir()
    const api1 = makeFakeApi()
    const clock = new FakeClock()
    const first = makeMirror({ api: api1, clock, stateDir: dir })
    await first.mirror.recordEvent('chat-1', todoEvent([
      { content: 'Persisted task', status: 'in_progress' },
    ], 'sess-P'))
    await first.mirror._idleForTests('chat-1')
    const sentId = api1.calls.filter((c) => c.kind === 'send')[0]!.messageId!
    expect(sentId).toBe(200)

    // Simulate a plugin restart: brand-new mirror instance, SAME state dir.
    const api2 = makeFakeApi()
    const second = makeMirror({ api: api2, clock, stateDir: dir })
    // Advance past the throttle window (in production Date.now() is already far
    // past it; the fake clock starts at 0 so we step it explicitly).
    clock.advance(3000)
    // A same-session update must EDIT the restored message (id 200), not send anew.
    await second.mirror.recordEvent('chat-1', todoEvent([
      { content: 'Persisted task', status: 'completed' },
      { content: 'Follow-up', status: 'in_progress' },
    ], 'sess-P'))
    await second.mirror._idleForTests('chat-1')
    const sends2 = api2.calls.filter((c) => c.kind === 'send')
    const edits2 = api2.calls.filter((c) => c.kind === 'edit')
    expect(sends2.length).toBe(0) // restored — no fresh message
    expect(edits2.length).toBe(1)
    expect(edits2[0]!.messageId).toBe(200)
    expect(edits2[0]!.text).toContain('Follow-up')
  })

  test('persistence: a restart in a NEW session finalizes the restored old snapshot', async () => {
    const dir = stateDir()
    const api1 = makeFakeApi()
    const clock = new FakeClock()
    const first = makeMirror({ api: api1, clock, stateDir: dir })
    await first.mirror.recordEvent('chat-1', todoEvent([
      { content: 'Old', status: 'in_progress' },
    ], 'sess-old'))
    await first.mirror._idleForTests('chat-1')

    const api2 = makeFakeApi()
    const second = makeMirror({ api: api2, clock, stateDir: dir })
    // New session after restart → finalize the restored message, start fresh.
    await second.mirror.recordEvent('chat-1', sessionStart('sess-new', 'startup'))
    const finalEdit = api2.calls.filter((c) => c.kind === 'edit').pop()
    expect(finalEdit!.messageId).toBe(200)
    expect(finalEdit!.text).toContain('сессия завершена')
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

// ─────────────────────────────────────────────────────────────────────
// M3 reality mirror — applyReconciledView (freshness + dedup/bucket-cross)
// ─────────────────────────────────────────────────────────────────────

describe('applyReconciledView', () => {
  const rvTodos: TodoItem[] = [
    { id: '1', content: 'Alpha', status: 'in_progress' },
    { id: '2', content: 'Beta', status: 'pending' },
  ]

  test('renders the freshness header and sends once', async () => {
    const { mirror, api } = makeMirror()
    await mirror.applyReconciledView('chat-1', {
      sessionId: SID,
      todos: rvTodos,
      freshness: { kind: 'fresh', reconciledAgeMs: 5_000 },
    })
    await mirror._idleForTests('chat-1')
    expect(api.calls.filter((c) => c.kind === 'send')).toHaveLength(1)
    expect(api.calls[0]!.text).toContain('<b>Задачи</b> · <i>сверено меньше минуты назад</i>')
  })

  test('same content + same minute bucket ⇒ no follow-up edit (dedup)', async () => {
    const { mirror, api, clock } = makeMirror()
    await mirror.applyReconciledView('chat-1', {
      sessionId: SID,
      todos: rvTodos,
      freshness: { kind: 'fresh', reconciledAgeMs: 5_000 },
    })
    await mirror._idleForTests('chat-1')
    const editsAfterFirst = api.calls.filter((c) => c.kind === 'edit').length

    clock.advance(3000) // clear the throttle window
    await mirror.applyReconciledView('chat-1', {
      sessionId: SID,
      todos: rvTodos,
      freshness: { kind: 'fresh', reconciledAgeMs: 40_000 }, // still «меньше минуты»
    })
    await mirror._idleForTests('chat-1')
    expect(api.calls.filter((c) => c.kind === 'edit').length).toBe(editsAfterFirst)
  })

  test('crossing a minute bucket ⇒ one edit', async () => {
    const { mirror, api, clock } = makeMirror()
    await mirror.applyReconciledView('chat-1', {
      sessionId: SID,
      todos: rvTodos,
      freshness: { kind: 'fresh', reconciledAgeMs: 5_000 },
    })
    await mirror._idleForTests('chat-1')
    const before = api.calls.filter((c) => c.kind === 'edit').length

    clock.advance(3000)
    await mirror.applyReconciledView('chat-1', {
      sessionId: SID,
      todos: rvTodos,
      freshness: { kind: 'fresh', reconciledAgeMs: 65_000 }, // now «1 мин»
    })
    await mirror._idleForTests('chat-1')
    expect(api.calls.filter((c) => c.kind === 'edit').length).toBe(before + 1)
  })

  test('empty list before any message is NOT materialised', async () => {
    const { mirror, api } = makeMirror()
    await mirror.applyReconciledView('chat-1', {
      sessionId: SID,
      todos: [],
      freshness: { kind: 'unverified' },
    })
    await mirror._idleForTests('chat-1')
    expect(api.calls).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Review fix-loop 2026-07-09 — session epochs / tombstones (#2)
// ─────────────────────────────────────────────────────────────────────

describe('session epochs and tombstones', () => {
  test('end(s1) → start(s2): s2 is active immediately; late s1 mutation dropped', async () => {
    const { mirror, api } = makeMirror()
    await mirror.recordEvent('chat-1', sessionStart('s1', 'startup'))
    await mirror.recordEvent('chat-1', todoEvent([{ content: 'Old work', status: 'in_progress' }], 's1'))
    await mirror._idleForTests('chat-1')
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(1)

    await mirror.recordEvent('chat-1', sessionEnd('s1'))
    // s2 starts — NO tasks yet, but the session must be tracked as active NOW
    // (pre-fix nothing was stored until the first mutation).
    await mirror.recordEvent('chat-1', sessionStart('s2', 'startup'))

    // Late straggler from retired s1: dropped — no reset, no new message.
    const callsBefore = api.calls.length
    await mirror.recordEvent('chat-1', todoEvent([{ content: 'Ghost of s1', status: 'pending' }], 's1'))
    await mirror._idleForTests('chat-1')
    expect(api.calls.length).toBe(callsBefore)

    // s2's own first mutation creates a fresh message.
    await mirror.recordEvent('chat-1', todoEvent([{ content: 'New era', status: 'in_progress' }], 's2'))
    await mirror._idleForTests('chat-1')
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(2)
    expect(sends[1]!.text).toContain('New era')
  })

  test('end(s1) → resume(s1): SessionStart un-retires, s1 mutations flow again', async () => {
    const { mirror, api } = makeMirror()
    await mirror.recordEvent('chat-1', sessionStart('s1', 'startup'))
    await mirror.recordEvent('chat-1', todoEvent([{ content: 'Work', status: 'in_progress' }], 's1'))
    await mirror._idleForTests('chat-1')
    await mirror.recordEvent('chat-1', sessionEnd('s1'))

    // Resume: the SAME id starts again (claude -r).
    await mirror.recordEvent('chat-1', sessionStart('s1', 'resume'))
    await mirror.recordEvent('chat-1', todoEvent([{ content: 'Resumed work', status: 'in_progress' }], 's1'))
    await mirror._idleForTests('chat-1')
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(2) // finalize evicted the old entry → fresh message
    expect(sends[1]!.text).toContain('Resumed work')
  })

  test('late SessionEnd naming a RETIRED session does not finalize the active one', async () => {
    const { mirror, api } = makeMirror()
    await mirror.recordEvent('chat-1', sessionStart('s1', 'startup'))
    await mirror.recordEvent('chat-1', sessionStart('s2', 'startup')) // s1 retired
    await mirror.recordEvent('chat-1', todoEvent([{ content: 'Active B work', status: 'in_progress' }], 's2'))
    await mirror._idleForTests('chat-1')
    const editsBefore = api.calls.filter((c) => c.kind === 'edit').length

    // Late end from dead s1 — must NOT touch s2's mirror.
    await mirror.recordEvent('chat-1', sessionEnd('s1'))
    await mirror._idleForTests('chat-1')
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(edits.length).toBe(editsBefore) // no «сессия завершена» edit fired
  })
})

// ─────────────────────────────────────────────────────────────────────
// Review fix-loop 2026-07-09 — persistence correctness (#3)
// ─────────────────────────────────────────────────────────────────────

describe('persistence correctness', () => {
  test('#3a restart with a pending throttled edit replays it (dirty flag)', async () => {
    const dir = stateDir()
    const first = makeMirror({ stateDir: dir })
    await first.mirror.recordEvent('chat-1', todoEvent([{ content: 'Step A', status: 'in_progress' }]))
    await first.mirror._idleForTests('chat-1')
    // Second mutation INSIDE the throttle window: persisted eagerly, edit deferred.
    await first.mirror.recordEvent('chat-1', todoEvent([{ content: 'Step A', status: 'completed' }]))
    expect(first.api.calls.filter((c) => c.kind === 'edit').length).toBe(0) // still throttled

    // «Crash» before the timer fires → new process, same state dir.
    const second = makeMirror({ stateDir: dir })
    // An IDENTICAL follow-up event (pre-fix: suppressed by restored
    // lastRenderedText, remote message stale forever).
    await second.mirror.recordEvent('chat-1', todoEvent([{ content: 'Step A', status: 'completed' }]))
    second.clock.advance(3001) // FakeClock starts at 0 ⇒ let the throttle window pass
    await second.mirror._idleForTests('chat-1')
    const edits = second.api.calls.filter((c) => c.kind === 'edit')
    expect(edits.length).toBeGreaterThanOrEqual(1)
    expect(edits[edits.length - 1]!.text).toContain('1 done')
  })

  test('#3a restart after a REJECTED edit replays it', async () => {
    const dir = stateDir()
    const first = makeMirror({ stateDir: dir })
    await first.mirror.recordEvent('chat-1', todoEvent([{ content: 'Step A', status: 'in_progress' }]))
    await first.mirror._idleForTests('chat-1')
    first.clock.advance(3001) // past throttle so the edit fires immediately…
    first.api.failEditWith = new Error('500 telegram hiccup') // …and FAILS
    await first.mirror.recordEvent('chat-1', todoEvent([{ content: 'Step A', status: 'completed' }]))
    await first.mirror._idleForTests('chat-1')

    const second = makeMirror({ stateDir: dir })
    await second.mirror.recordEvent('chat-1', todoEvent([{ content: 'Step A', status: 'completed' }]))
    second.clock.advance(3001) // FakeClock starts at 0 ⇒ let the throttle window pass
    await second.mirror._idleForTests('chat-1')
    const edits = second.api.calls.filter((c) => c.kind === 'edit')
    expect(edits.length).toBeGreaterThanOrEqual(1)
    expect(edits[edits.length - 1]!.text).toContain('1 done')
  })

  test('#3b a persisted snapshot with invalid todos is quarantined, mirror continues fresh', async () => {
    const dir = stateDir()
    writeFileSync(
      join(dir, 'task-mirror-chat-1.json'),
      JSON.stringify({ messageId: 200, todos: [null] }),
    )
    const { mirror, api } = makeMirror({ stateDir: dir })
    // Pre-fix: threw at `t.id` on EVERY event — permanent wedge.
    await mirror.recordEvent('chat-1', todoEvent([{ content: 'Fresh start', status: 'in_progress' }]))
    await mirror._idleForTests('chat-1')
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(1) // fresh message; invalid snapshot ignored
    expect(sends[0]!.text).toContain('Fresh start')
  })

  test('#3c persisted lastActivityMs makes an ancient orphan drop silently after restart', async () => {
    const dir = stateDir()
    // Simulate an old install: snapshot persisted 20 minutes ago (clock=0 era).
    writeFileSync(
      join(dir, 'task-mirror-chat-1.json'),
      JSON.stringify({
        sessionId: 'old-sess',
        messageId: 200,
        todos: [{ content: 'Ancient task', status: 'in_progress' }],
        dirty: false,
        lastActivityMs: 0,
      }),
    )
    const { mirror, clock, api } = makeMirror({ stateDir: dir })
    clock.now = 20 * 60 * 1000 // 20 min later; TTL default = 10 min

    // A NEW session arrives: the restored entry is an ancient orphan — it must
    // be dropped SILENTLY (no «сессия завершена» edit on the old message).
    await mirror.recordEvent('chat-1', todoEvent([{ content: 'New life', status: 'in_progress' }], 'new-sess'))
    await mirror._idleForTests('chat-1')
    expect(api.calls.filter((c) => c.kind === 'edit').length).toBe(0)
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toContain('New life')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Review fix-loop 2026-07-09 — restart must not wipe a restored mirror (#10)
// ─────────────────────────────────────────────────────────────────────

describe('#10 empty-unverified reconciled view after restart', () => {
  test('does not edit a restored populated message down to «задач нет»', async () => {
    const dir = stateDir()
    writeFileSync(
      join(dir, 'task-mirror-chat-1.json'),
      JSON.stringify({
        sessionId: SID,
        messageId: 200,
        todos: [{ content: 'Живая задача', status: 'in_progress' }],
        dirty: false,
        lastActivityMs: 0,
      }),
    )
    const { mirror, clock, api } = makeMirror({ stateDir: dir })
    // Reconciler knows nothing yet right after restart.
    await mirror.applyReconciledView('chat-1', {
      sessionId: SID,
      todos: [],
      freshness: { kind: 'unverified' },
    })
    await mirror._idleForTests('chat-1')
    expect(api.calls).toHaveLength(0) // no «задач нет» wipe

    // Once the reconciler has real data, the message updates normally.
    await mirror.applyReconciledView('chat-1', {
      sessionId: SID,
      todos: [{ content: 'Живая задача', status: 'completed' }],
      freshness: { kind: 'fresh', reconciledAgeMs: 1_000 },
    })
    clock.advance(3001) // FakeClock starts at 0 ⇒ let the throttle window pass
    await mirror._idleForTests('chat-1')
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(edits.length).toBe(1)
    expect(edits[0]!.text).toContain('1 done')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Review fix-loop 2026-07-09 — no double «сессия завершена» (SHOULD)
// ─────────────────────────────────────────────────────────────────────

describe('ended freshness suppresses the duplicate footer', () => {
  test('finalize after an ended reconciled view says «сессия завершена» exactly once', async () => {
    const { mirror, api } = makeMirror()
    await mirror.applyReconciledView('chat-1', {
      sessionId: SID,
      todos: [{ content: 'Done work', status: 'completed' }],
      freshness: { kind: 'fresh', reconciledAgeMs: 1_000 },
    })
    await mirror._idleForTests('chat-1')
    // Reality mirror pushes the frozen ended view…
    await mirror.applyReconciledView('chat-1', {
      sessionId: SID,
      todos: [{ content: 'Done work', status: 'completed' }],
      freshness: { kind: 'ended', reconciledAtLabel: '08:05' },
    })
    await mirror._idleForTests('chat-1')
    // …then the webhook's session_end lands and finalizes.
    await mirror.recordEvent('chat-1', sessionEnd())
    await mirror._idleForTests('chat-1')
    const all = [...api.calls].reverse()
    const lastText = all.find((c) => c.kind === 'edit' || c.kind === 'send')!.text
    const occurrences = (lastText.match(/сессия завершена/g) ?? []).length
    expect(occurrences).toBe(1)
  })
})
