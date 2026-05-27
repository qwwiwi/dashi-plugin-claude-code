// ProgressReporter tests (Phase 9 / 2026-05-18) — persistent activity
// thread shown to the warchief in Telegram. Patterned on
// status-manager.test.ts: FakeClock + FakeApi, no real network, no real
// timers.
//
// Behaviour under test:
//   1. First tool_start sends a new message (no edit yet).
//   2. Rapid subsequent events within edit_throttle_ms collapse into one
//      edit with the latest rendered text.
//   3. Once the throttle window has elapsed, new events edit immediately.
//   4. Per-chat state is isolated (chat A edits do not touch chat B).
//   5. session_stop is idempotent (second stop is no-op).
//   6. Disabled mode is a hard no-op (no Telegram calls, no pending timer).
//   7. Telegram failures are swallowed and logged; recordEvent never throws.
//
// Race / lifecycle additions (Phase 5 fix-loop iter 1, from dual review):
//   8. Events arriving while initial sendMessage is in-flight collapse
//      into a single follow-up edit with the FRESHEST text.
//   9. session_stop while sendMessage is in-flight does not emit an
//      orphan edit; the entry is evicted cleanly.
//  10. Cross-session TTL — an idle entry older than session_ttl_ms is
//      evicted; the next event starts a fresh thread (new sendMessage,
//      not an edit on the prior message).
//  11. Long tool input does not blow Telegram's 4096-char limit.
//  12. Bearer-token-shaped secrets in Bash commands never reach Telegram.
//  13. editMessageText failure is swallowed; next event retries.

import { describe, expect, test } from 'bun:test'

import {
  ProgressReporter,
  type TelegramApiForProgress,
} from '../../src/status/progress-reporter.js'
import type { AppConfig } from '../../src/config.js'
import type { ActivityStatusEvent } from '../../src/hooks/claude-events.js'
import { createLogger } from '../../src/log.js'

const silentLog = createLogger('test', {
  stream: { write: () => true } as unknown as NodeJS.WritableStream,
})

function makeConfig(overrides: Partial<AppConfig['progress']> = {}): AppConfig {
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
      suppress_typing_bubble: false,
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
      session_ttl_ms: 10 * 60 * 1000,
      ...overrides,
    },
    task_mirror: {
      enabled: true,
      edit_throttle_ms: 3000,
      session_ttl_ms: 10 * 60 * 1000,
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
// Fake clock
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
// Fake Telegram API — captures every call. Supports deferred resolution
// of sendMessage / editMessageText so tests can simulate in-flight ops.
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
  // When set, sendMessage returns a promise that resolves only after
  // `releaseSend()` is called. Used to test in-flight overlap.
  deferSend: boolean
  releaseSend?: () => void
  // Same idea for edits.
  deferEdit: boolean
  releaseEdit?: () => void
}

function makeFakeApi(): FakeApi {
  const state: FakeApi = {
    calls: [],
    nextMessageId: 100,
    api: undefined as unknown as TelegramApiForProgress,
    deferSend: false,
    deferEdit: false,
  }
  state.api = {
    sendMessage: async (chatId: string, text: string, _opts: unknown) => {
      if (state.deferSend) {
        await new Promise<void>((resolve) => {
          state.releaseSend = resolve
        })
      }
      if (state.failSendWith) throw state.failSendWith
      const id = state.nextMessageId++
      state.calls.push({ kind: 'send', chatId, messageId: id, text })
      return { message_id: id }
    },
    editMessageText: async (chatId: string, messageId: number, text: string, _opts: unknown) => {
      if (state.deferEdit) {
        await new Promise<void>((resolve) => {
          state.releaseEdit = resolve
        })
      }
      state.calls.push({ kind: 'edit', chatId, messageId, text })
      if (state.failEditWith) throw state.failEditWith
    },
  }
  return state
}

function makeReporter(opts: { config?: AppConfig; clock?: FakeClock; api?: FakeApi } = {}): {
  reporter: ProgressReporter
  clock: FakeClock
  api: FakeApi
  config: AppConfig
} {
  const clock = opts.clock ?? new FakeClock()
  const api = opts.api ?? makeFakeApi()
  const config = opts.config ?? makeConfig()
  const reporter = new ProgressReporter({
    telegramApi: api.api,
    config,
    log: silentLog,
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  return { reporter, clock, api, config }
}

function bashStart(toolUseId = 'tool-1', command = 'echo hi'): ActivityStatusEvent {
  return {
    kind: 'tool_start',
    toolName: 'Bash',
    toolInput: { command },
    toolUseId,
  }
}

// Editing is on the kept-tools list (Read is skipped by the noise filter
// added 2026-05-20); these tests rely on the second tool_start actually
// landing in `entry.calls`, so we use Edit as the "second tool" stand-in.
function readStart(toolUseId = 'tool-2', file_path = '/abs/path/foo.ts'): ActivityStatusEvent {
  return {
    kind: 'tool_start',
    toolName: 'Edit',
    toolInput: { file_path },
    toolUseId,
  }
}

const STOP: ActivityStatusEvent = { kind: 'session_stop' }

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('ProgressReporter', () => {
  test('first tool_start sends a new Telegram message (no edits yet)', async () => {
    const { reporter, api } = makeReporter()
    await reporter.recordEvent('164795011', bashStart())
    const sends = api.calls.filter((c) => c.kind === 'send')
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(sends.length).toBe(1)
    expect(edits.length).toBe(0)
    expect(sends[0]!.chatId).toBe('164795011')
    expect(sends[0]!.text).toContain('running')
  })

  test('rapid subsequent events within throttle window collapse into one edit', async () => {
    const { reporter, clock, api } = makeReporter()
    await reporter.recordEvent('164995011', bashStart('t1'))
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(1)

    clock.advance(500)
    await reporter.recordEvent('164995011', readStart('t2'))
    clock.advance(500)
    await reporter.recordEvent('164995011', readStart('t3', '/abs/path/bar.ts'))

    expect(api.calls.filter((c) => c.kind === 'edit').length).toBe(0)

    clock.advance(1999)
    expect(api.calls.filter((c) => c.kind === 'edit').length).toBe(0)

    clock.advance(1)
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(edits.length).toBe(1)
    expect(edits[0]!.messageId).toBe(100)
    expect(edits[0]!.text).toContain('bar.ts')
  })

  test('event after throttle window elapsed edits immediately', async () => {
    const { reporter, clock, api } = makeReporter()
    await reporter.recordEvent('164995011', bashStart('t1'))
    clock.advance(3000)
    await reporter.recordEvent('164995011', readStart('t2'))
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(edits.length).toBe(1)
    expect(edits[0]!.text).toContain('foo.ts')
  })

  test('per-chat state is isolated (chat A edit does not touch chat B)', async () => {
    const { reporter, clock, api } = makeReporter()
    await reporter.recordEvent('chat-A', bashStart('a1'))
    await reporter.recordEvent('chat-B', bashStart('b1'))
    const sendsAfter = api.calls.filter((c) => c.kind === 'send')
    expect(sendsAfter.length).toBe(2)
    expect(sendsAfter[0]!.chatId).toBe('chat-A')
    expect(sendsAfter[0]!.messageId).toBe(100)
    expect(sendsAfter[1]!.chatId).toBe('chat-B')
    expect(sendsAfter[1]!.messageId).toBe(101)

    clock.advance(3001)
    await reporter.recordEvent('chat-A', readStart('a2'))
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(edits.length).toBe(1)
    expect(edits[0]!.chatId).toBe('chat-A')
    expect(edits[0]!.messageId).toBe(100)
  })

  test('session_stop is idempotent (second stop is a no-op)', async () => {
    const { reporter, clock, api } = makeReporter()
    await reporter.recordEvent('164995011', bashStart('t1'))
    clock.advance(3000)
    await reporter.recordEvent('164995011', STOP)
    const editsAfterFirstStop = api.calls.filter((c) => c.kind === 'edit').length
    expect(editsAfterFirstStop).toBeGreaterThanOrEqual(1)

    await reporter.recordEvent('164995011', STOP)
    const sendsTotal = api.calls.filter((c) => c.kind === 'send').length
    const editsTotal = api.calls.filter((c) => c.kind === 'edit').length
    expect(sendsTotal).toBe(1)
    expect(editsTotal).toBe(editsAfterFirstStop)

    clock.advance(60_000)
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(1)
    expect(api.calls.filter((c) => c.kind === 'edit').length).toBe(editsTotal)
  })

  test('disabled progress is a hard no-op', async () => {
    const { reporter, clock, api } = makeReporter({
      config: makeConfig({ enabled: false }),
    })
    await reporter.recordEvent('164995011', bashStart('t1'))
    await reporter.recordEvent('164995011', readStart('t2'))
    await reporter.recordEvent('164995011', STOP)
    clock.advance(60_000)
    expect(api.calls.length).toBe(0)
  })

  test('telegram sendMessage failure is swallowed; subsequent event can retry', async () => {
    const api = makeFakeApi()
    api.failSendWith = new Error('telegram down')
    const { reporter, clock } = makeReporter({ api })

    await reporter.recordEvent('164995011', bashStart('t1'))
    expect(api.calls.length).toBe(0)

    delete api.failSendWith
    clock.advance(10)
    await reporter.recordEvent('164995011', readStart('t2'))
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(1)
    expect(sends[0]!.chatId).toBe('164995011')
  })

  // ───────────────────────────────────────────────────────────────────
  // Race / lifecycle additions (Phase 5 fix-loop iter 1)
  // ───────────────────────────────────────────────────────────────────

  test('events arriving while initial send is in-flight collapse to ONE follow-up edit with the freshest text', async () => {
    const api = makeFakeApi()
    api.deferSend = true
    const { reporter, clock } = makeReporter({ api })

    // Kick off the first send; do NOT await — keep it in flight.
    void reporter.recordEvent('164995011', bashStart('t1', 'echo first'))
    // Two more events arrive while send is in flight. Each updates
    // desiredText.
    await reporter.recordEvent('164995011', bashStart('t2', 'echo second'))
    await reporter.recordEvent('164995011', bashStart('t3', 'echo third'))

    // No Telegram calls observed yet (send is parked).
    expect(api.calls.length).toBe(0)

    // Release the parked sendMessage. Expect the SEND lands and then
    // one follow-up EDIT carrying the freshest tool ('third').
    api.releaseSend!()
    // Drain the first executeFlush + its finally chain so the deferred
    // follow-up timer is fully armed before we advance the clock. Doing
    // `await firstSend` alone is not sufficient: firstSend resolves at
    // sync exit of recordEvent #1 (before the executeFlush continuation
    // had a chance to set up the follow-up timer).
    await reporter._idleForTests('164995011')
    // Throttle window: lastEditAtMs was set to clock.now (0) when the
    // initial send resolved. The follow-up edit sits on a 3000ms timer
    // — advance past it.
    clock.advance(3000)
    await reporter._idleForTests('164995011')

    const sends = api.calls.filter((c) => c.kind === 'send')
    const edits = api.calls.filter((c) => c.kind === 'edit')
    // Collapsing rule: regardless of how many in-flight events arrived,
    // we issue exactly one send and one follow-up edit (not one edit
    // per intermediate event).
    expect(sends.length).toBe(1)
    expect(edits.length).toBe(1)
    // The follow-up edit carries the LATEST snapshot, which includes
    // the third tool. (The activity buffer is cumulative — earlier
    // tools stay visible up to recent_buffer; the test guards that the
    // newest event made it into the published view.)
    expect(edits[0]!.text).toContain('third')
  })

  test('session_stop while initial send is in-flight does not produce an orphan edit', async () => {
    const api = makeFakeApi()
    api.deferSend = true
    const { reporter, clock } = makeReporter({ api })

    const inFlight = reporter.recordEvent('164995011', bashStart('t1'))
    // Stop arrives before the parked send resolves.
    const stopPromise = reporter.recordEvent('164995011', STOP)
    // Release the send.
    api.releaseSend!()
    await Promise.all([inFlight, stopPromise])
    // Drain any residual microtasks from the executeFlush finally chain.
    await reporter._idleForTests('164995011')
    clock.advance(60_000)
    await reporter._idleForTests('164995011')

    // Exactly one send (the original) and zero edits — no orphan
    // intermediate edits, and no final "done" edit because the
    // executeFlush observed entry.stopped and skipped state mutations.
    const sends = api.calls.filter((c) => c.kind === 'send')
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(sends.length).toBe(1)
    expect(edits.length).toBe(0)
  })

  test('idle entry older than session_ttl_ms is evicted; next event starts a fresh thread', async () => {
    const { reporter, clock, api } = makeReporter({
      config: makeConfig({ session_ttl_ms: 60_000 }), // 60s TTL for the test
    })
    await reporter.recordEvent('164995011', bashStart('t1'))
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(1)
    // Move past TTL with no activity.
    clock.advance(60_001)
    // New event after TTL — must start a fresh sendMessage, not edit the prior.
    await reporter.recordEvent('164995011', bashStart('t2'))
    const sends = api.calls.filter((c) => c.kind === 'send')
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(sends.length).toBe(2)
    expect(sends[1]!.messageId).toBe(101)
    expect(edits.length).toBe(0)
  })

  test('long Bash command stays under Telegram 4096-char limit', async () => {
    const { reporter, api } = makeReporter()
    const huge = 'echo ' + 'X'.repeat(5000)
    await reporter.recordEvent('164995011', bashStart('t1', huge))
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(1)
    // 4096 is Telegram's editMessageText/sendMessage cap.
    expect(sends[0]!.text.length).toBeLessThanOrEqual(4096)
  })

  test('bearer-token-shaped secret in Bash command is masked before reaching Telegram', async () => {
    const { reporter, api } = makeReporter()
    // 40-char token shape that maskSecrets generic-long-token rule must
    // catch. Pattern: a long [A-Za-z0-9_-] run wrapped by 4-char anchors.
    const token = 'abcd' + 'X'.repeat(32) + 'wxyz'
    await reporter.recordEvent('164995011', bashStart('t1', `curl -H "Authorization: Bearer ${token}"`))
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).not.toContain(token)
    // Masked form keeps first 4 / last 4 chars of the token only — the
    // 32-X middle must be gone.
    expect(sends[0]!.text).not.toContain('XXXXXXXX')
  })

  // ───────────────────────────────────────────────────────────────────
  // Public read API for the watcher (PR-A3 prerequisite).
  // ───────────────────────────────────────────────────────────────────

  test('isBusy returns false for an unknown chat', () => {
    const { reporter } = makeReporter()
    expect(reporter.isBusy('unknown-chat', 30_000)).toBe(false)
  })

  test('isBusy returns true within thresholdMs after a tool_start', async () => {
    const { reporter, clock } = makeReporter()
    await reporter.recordEvent('chat-busy', bashStart('t1'))
    // At t+10ms with a 30s threshold we must still be busy.
    clock.advance(10)
    expect(reporter.isBusy('chat-busy', 30_000)).toBe(true)
  })

  test('isBusy returns false after thresholdMs with no further activity', async () => {
    const { reporter, clock } = makeReporter()
    await reporter.recordEvent('chat-cooling', bashStart('t1'))
    // At t+30_001ms with a 30s threshold we must look idle.
    clock.advance(30_001)
    expect(reporter.isBusy('chat-cooling', 30_000)).toBe(false)
  })

  test('isBusy uses strict < for boundary: elapsed === threshold is NOT busy', async () => {
    const { reporter, clock } = makeReporter()
    await reporter.recordEvent('chat-edge', bashStart('t1'))
    clock.advance(30_000)
    expect(reporter.isBusy('chat-edge', 30_000)).toBe(false)
    // One tick under the boundary — still busy.
    const { reporter: r2, clock: c2 } = makeReporter()
    await r2.recordEvent('chat-edge2', bashStart('t1'))
    c2.advance(29_999)
    expect(r2.isBusy('chat-edge2', 30_000)).toBe(true)
  })

  test('isBusy returns false after session_stop even within the threshold', async () => {
    const { reporter, clock } = makeReporter()
    await reporter.recordEvent('chat-stopping', bashStart('t1'))
    clock.advance(100)
    await reporter.recordEvent('chat-stopping', STOP)
    // Entry is fully evicted on stop — same observable outcome as a
    // never-seen chat.
    expect(reporter.isBusy('chat-stopping', 30_000)).toBe(false)
  })

  test('isBusy with tight threshold marks a recent chat as idle', async () => {
    const { reporter, clock } = makeReporter()
    await reporter.recordEvent('chat-tight', bashStart('t1'))
    clock.advance(100)
    // 50ms threshold; we are at t+100, so the chat is past the override.
    expect(reporter.isBusy('chat-tight', 50)).toBe(false)
    // 30s threshold still considers it busy.
    expect(reporter.isBusy('chat-tight', 30_000)).toBe(true)
  })

  test('getActiveToolName returns the most recent tool', async () => {
    const { reporter } = makeReporter()
    await reporter.recordEvent('chat-tools', bashStart('t1'))
    await reporter.recordEvent('chat-tools', readStart('t2'))
    expect(reporter.getActiveToolName('chat-tools')).toBe('Edit')
  })

  test('getActiveToolName returns undefined when no entry exists', () => {
    const { reporter } = makeReporter()
    expect(reporter.getActiveToolName('nobody')).toBeUndefined()
  })

  test('getActiveToolName stays populated after a matching tool_end (semantic pin)', async () => {
    // Documented intentional behaviour: tool_end does NOT clear the active
    // tool. The brief idle gap between tool_end and the next tool_start
    // would otherwise cause false-negative auto-replies (watcher sees
    // «not busy» even though Claude is in the middle of a multi-step chain).
    const { reporter } = makeReporter()
    await reporter.recordEvent('chat-x', bashStart('t1'))
    expect(reporter.getActiveToolName('chat-x')).toBe('Bash')
    await reporter.recordEvent('chat-x', {
      kind: 'tool_end',
      toolName: 'Bash',
      toolInput: { command: 'echo hi' },
      toolUseId: 't1',
    })
    // After tool_end, the name is unchanged — calls window is render-only
    // for non-start events.
    expect(reporter.getActiveToolName('chat-x')).toBe('Bash')
  })

  test('editMessageText failure is swallowed; next event still produces a successful edit', async () => {
    const api = makeFakeApi()
    const { reporter, clock } = makeReporter({ api })
    await reporter.recordEvent('164995011', bashStart('t1'))
    // First edit attempt rejects.
    api.failEditWith = new Error('telegram down')
    clock.advance(3000)
    await reporter.recordEvent('164995011', readStart('t2'))
    await reporter._idleForTests('164995011')
    // Edit recorded (api pushed) but threw afterwards — call counted.
    const firstEditCount = api.calls.filter((c) => c.kind === 'edit').length
    expect(firstEditCount).toBe(1)
    // Recover. Next event must succeed (we never get stuck due to a single failure).
    delete api.failEditWith
    clock.advance(3000)
    await reporter.recordEvent('164995011', readStart('t3', '/abs/path/baz.ts'))
    await reporter._idleForTests('164995011')
    const edits = api.calls.filter((c) => c.kind === 'edit')
    expect(edits.length).toBeGreaterThanOrEqual(2)
    expect(edits[edits.length - 1]!.text).toContain('baz.ts')
  })
})
