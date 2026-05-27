// StatusManager race-condition + permanent-edit-error tests (codex
// review 2026-05-27, TASK-3, HIGH #3 / #4 / #5).
//
// Pre-fix issues:
//   * `start(chatId)` could race with itself — two concurrent calls
//     both passed the `entries.has` check, both fired sendMessage,
//     and one became orphaned (HIGH #3).
//   * `ensureBubble()` could race — multiple non-typing events while
//     bubbleSuppressed=true each fired sendMessage. Last writer wins
//     `messageId`; earlier messages were never tracked (HIGH #4).
//   * Permanent Telegram edit failures retried forever — the rolling
//     timer kept hammering the same dead message_id until TTL (HIGH
//     #5). Forbidden / parse / message-gone all surfaced as a plain
//     `warn` log without state mutation.
//
// Coverage strategy:
//   * Concurrency: a `gatedFakeApi` lets the test hold a sendMessage
//     promise open while a second start/ensureBubble call races into
//     the same chat. We assert the second call awaits the first
//     instead of forking its own network round-trip.
//   * Generations: drive the FakeClock to fire a tick that was armed
//     against the previous lifecycle's `generation`. The mutation
//     must NOT touch the new entry.
//   * Edit errors: queue Telegram-shaped errors with `error_code` +
//     `description` on the fake api. Assert state transitions (drop
//     messageId once on message_gone, disable on 403, downgrade
//     parse_mode on 400 parse, no-op on 429 with retry_after).

import { describe, expect, test } from 'bun:test'

import {
  StatusManager,
  shouldStream,
  type TelegramApiForStatus,
} from '../../src/status/status-manager.js'
import type {
  ChatPolicy,
  MultichatPolicy,
} from '../../src/chats/policy-loader.js'
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
      // Default: bubble suppressed off so concurrency tests can see
      // the initial send happen. Lazy-bubble race tests opt in.
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
    tmux_mirror: {
      enabled: false,
      pane_target: '',
      poll_interval_ms: 5000,
      line_count: 50,
      hide_segments: ['boot_banner', 'inbound_warning', 'footer_hints', 'input_box'],
      mode: 'latest_inbound_only',
      max_lines: 14,
    },
    multichat: {
      enabled: false,
      policy_path: '',
      state_dir: '',
      workspace_dir: '',
    },
  } as unknown as AppConfig
}

// ─────────────────────────────────────────────────────────────────────
// Fake clock — same shape as status-manager.test.ts
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

// Telegram-shaped error: matches grammY's GrammyError on the wire.
// We don't import GrammyError to keep the test light-weight; the
// classifier accepts plain objects with error_code + description.
class TelegramError extends Error {
  error_code: number
  description: string
  parameters?: { retry_after?: number }
  constructor(code: number, description: string, params?: { retry_after?: number }) {
    super(`telegram ${code}: ${description}`)
    this.error_code = code
    this.description = description
    if (params) this.parameters = params
  }
}

interface ApiCall {
  kind: 'send' | 'edit' | 'delete' | 'chat_action'
  chatId: string
  messageId?: number
  text?: string
  opts?: unknown
}

interface FakeApi {
  api: TelegramApiForStatus
  calls: ApiCall[]
  nextMessageId: number
  // Queue of errors to throw on the next editMessageText call(s).
  editErrors: Array<Error>
  // Queue of errors to throw on the next sendMessage call(s).
  sendErrors: Array<Error>
  // When true, sendMessage waits on `gateRelease` before resolving.
  // Tests use this to provoke the concurrent-send race.
  gateSend?: { release: () => void; promise: Promise<void> }
}

function makeFakeApi(): FakeApi {
  const state: FakeApi = {
    calls: [],
    nextMessageId: 100,
    editErrors: [],
    sendErrors: [],
    api: undefined as unknown as TelegramApiForStatus,
  }
  state.api = {
    sendMessage: async (chatId: string, text: string, opts: unknown) => {
      // Hold the call open until the gate is released. Tests release
      // the gate only after they've issued the second concurrent call.
      if (state.gateSend) {
        await state.gateSend.promise
      }
      const id = state.nextMessageId++
      // Record the attempt before throwing so tests can count attempts.
      state.calls.push({ kind: 'send', chatId, messageId: id, text, opts })
      if (state.sendErrors.length > 0) {
        const err = state.sendErrors.shift()
        if (err) throw err
      }
      return { message_id: id }
    },
    editMessageText: async (chatId: string, messageId: number, text: string, opts: unknown) => {
      // Record the attempt first so tests can count attempts even when
      // the API throws. The error queue still controls success/failure.
      state.calls.push({ kind: 'edit', chatId, messageId, text, opts })
      if (state.editErrors.length > 0) {
        const err = state.editErrors.shift()
        if (err) throw err
      }
    },
    deleteMessage: async (chatId: string, messageId: number) => {
      state.calls.push({ kind: 'delete', chatId, messageId })
    },
    sendChatAction: async (chatId: string, action: string) => {
      state.calls.push({ kind: 'chat_action', chatId, opts: action })
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

const CHAT = '164795011'

// ─────────────────────────────────────────────────────────────────────
// Bug 1 — per-chat lifecycle serialization (HIGH #3)
// ─────────────────────────────────────────────────────────────────────

describe('StatusManager — concurrent start() (HIGH #3)', () => {
  test('two concurrent starts only fire ONE initial sendMessage', async () => {
    // Pre-fix: both calls passed `entries.has(chatId)` check and both
    // fired sendMessage. The lifecycle FIFO must serialize them so the
    // second call sees the first's state and supersedes it (one
    // sendMessage for it, plus an "Остановлено: superseded" edit on
    // the first).
    const { mgr, api } = makeManager()

    // Hold the first sendMessage open until both callers are airborne.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    api.gateSend = { release, promise: gate }

    const p1 = mgr.start(CHAT, undefined)
    const p2 = mgr.start(CHAT, undefined)
    // Release the gate so both calls can complete.
    release()
    delete api.gateSend // drain
    const [h1, h2] = await Promise.all([p1, p2])

    expect(h1.messageId).not.toBe(h2.messageId)
    // Exactly two sends: first start's bubble + second start's bubble.
    // Pre-fix saw three because both starts raced into the first slot.
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(2)
    // First start's bubble is superseded — there is exactly one edit
    // pointing at h1's messageId carrying the "superseded" reason.
    const supersededEdits = api.calls.filter(
      (c) => c.kind === 'edit' && c.messageId === h1.messageId,
    )
    expect(supersededEdits.length).toBe(1)
    expect(supersededEdits[0]!.text).toContain('superseded')
    // Second start's entry is the live one.
    expect(mgr.isActive(CHAT)).toBe(true)
  })

  test('stale timer (generation mismatch) does not edit the new entry', async () => {
    // Arm a tick against generation=1, then cancel+restart the chat
    // (generation bumps). Advancing the clock fires the old tick — it
    // must compare entry.generation !== captured and bail without an
    // editMessageText.
    const { mgr, clock, api } = makeManager()
    await mgr.start(CHAT, undefined)

    // Cancel before the tick fires. Cancel does synchronous bookkeeping
    // (generation++, entries.delete, stopTimers) so the queued tick
    // callback is already invalidated.
    await mgr.cancel(CHAT, 'user')

    // Re-open the chat — fresh generation.
    await mgr.start(CHAT, undefined)
    const sendsBefore = api.calls.filter((c) => c.kind === 'send').length
    const editsBefore = api.calls.filter((c) => c.kind === 'edit').length

    // Advance past the original interval — the OLD tick is dead (cancel
    // cleared its handle). The NEW tick fires from the second start;
    // that one belongs to the live entry and is fine. We assert the
    // dead tick caused no spurious edit on the new entry.
    clock.advance(700)
    await Promise.resolve()
    await Promise.resolve()

    const editsAfter = api.calls.filter((c) => c.kind === 'edit').length
    // At most ONE new edit may appear (the new entry's own tick). The
    // dead-generation tick would have added a second.
    expect(editsAfter - editsBefore).toBeLessThanOrEqual(1)
    // No second new send for the dead lifecycle either.
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(sendsBefore)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Bug 2 — idempotent ensureBubble (HIGH #4)
// ─────────────────────────────────────────────────────────────────────

describe('StatusManager — concurrent lazy-bubble (HIGH #4)', () => {
  test('two concurrent non-typing updates only fire ONE sendMessage', async () => {
    // Suppress the typing bubble so ensureBubble is the path that
    // creates the Telegram message. Two near-simultaneous updates
    // (e.g. two PreToolUse hooks within the same event-loop turn) used
    // to each call sendMessage; one became orphaned.
    const { mgr, api } = makeManager({
      config: makeConfig({ suppress_typing_bubble: true }),
    })
    await mgr.start(CHAT, undefined)

    let release: () => void = () => {}
    api.gateSend = {
      release,
      promise: new Promise<void>((r) => {
        release = r
      }),
    }
    api.gateSend.release = release

    // Fire two non-typing updates concurrently.
    const u1 = mgr.updateByChatId(CHAT, { kind: 'tool', toolName: 'Bash' })
    const u2 = mgr.updateByChatId(CHAT, { kind: 'tool', toolName: 'Read' })
    release()
    delete api.gateSend
    await Promise.all([u1, u2])

    // Exactly one bubble sent — concurrent calls coalesced via the
    // bubbleCreationPromise.
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(1)
    expect(mgr.isActive(CHAT)).toBe(true)
  })

  test('failed bubble creation can retry on the next event', async () => {
    // ensureBubble caches the in-flight promise but clears it on
    // success OR failure so a future event can retry. Pre-fix this
    // behaviour didn't exist (no promise at all). Verify by failing
    // the first send and then succeeding the second.
    const { mgr, api } = makeManager({
      config: makeConfig({ suppress_typing_bubble: true }),
    })
    await mgr.start(CHAT, undefined)

    api.sendErrors = [new Error('telegram transient')]
    await mgr.updateByChatId(CHAT, { kind: 'tool', toolName: 'Bash' })
    // First send attempt fired but threw → no bubble created
    // (bubbleSuppressed still true, no messageId captured).
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(1)

    // Next event succeeds → second send attempt. The
    // bubbleCreationPromise was cleared on the prior failure so we
    // are allowed to retry.
    await mgr.updateByChatId(CHAT, { kind: 'tool', toolName: 'Read' })
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Bug 3 — Telegram edit-error classification (HIGH #5)
// ─────────────────────────────────────────────────────────────────────

describe('StatusManager — edit-error classification (HIGH #5)', () => {
  test('"message to edit not found" triggers recreate ONCE; second occurrence does not loop', async () => {
    const { mgr, api } = makeManager()
    const h = await mgr.start(CHAT, undefined)
    const initialSends = api.calls.filter((c) => c.kind === 'send').length

    // First edit fails with message-gone. The classifier should drop
    // messageId, set messageGoneRecoveryDone, and recreate via
    // ensureBubble. ensureBubble's `state.kind === 'typing'` short-
    // circuit means the recreate fires only when we advance to a non-
    // typing state — so trigger by moving to `thinking` after the gone
    // error queues.
    api.editErrors = [
      new TelegramError(400, 'Bad Request: message to edit not found'),
    ]
    await mgr.update(h, { kind: 'thinking' })
    const sendsAfterFirstGone = api.calls.filter((c) => c.kind === 'send').length
    // One recreate-via-ensureBubble fired.
    expect(sendsAfterFirstGone - initialSends).toBe(1)

    // Now provoke a SECOND message-gone. The recovery flag is set;
    // ensureBubble must NOT issue a second recreate (recovery_done=true).
    api.editErrors = [
      new TelegramError(400, 'Bad Request: message to edit not found'),
    ]
    await mgr.updateByChatId(CHAT, { kind: 'tool', toolName: 'Edit' })
    const sendsAfterSecondGone = api.calls.filter((c) => c.kind === 'send').length
    // Sends did NOT increase (recreate-once invariant). Entry's
    // messageId stays at 0; further timer ticks bail in editSafely.
    expect(sendsAfterSecondGone).toBe(sendsAfterFirstGone)
  })

  test('403 Forbidden disables the entry; no further edits or sends', async () => {
    const { mgr, api, clock } = makeManager()
    const h = await mgr.start(CHAT, undefined)
    const callsBefore = api.calls.length

    api.editErrors = [
      new TelegramError(403, 'Forbidden: bot was blocked by the user'),
    ]
    await mgr.update(h, { kind: 'thinking' })
    expect(mgr.isActive(CHAT)).toBe(true) // entry still tracked
    // Pre-disable edit + post-disable timer ticks: ZERO edits added.
    // The disabling edit itself counts (it succeeded reaching Telegram
    // and was rejected, so one `kind: 'edit'` call is recorded).
    const editsRightAfter = api.calls.filter((c) => c.kind === 'edit').length

    // Advance time well past the interval. With pre-fix code, every
    // tick would have re-fired editMessageText. Post-fix: zero new I/O.
    clock.advance(5000)
    await Promise.resolve()
    await Promise.resolve()

    const editsLater = api.calls.filter((c) => c.kind === 'edit').length
    expect(editsLater).toBe(editsRightAfter)
    // chat_action calls also stop — pulseChatAction bails on disabled.
    const actionsCount = api.calls.filter((c) => c.kind === 'chat_action').length
    clock.advance(5000)
    await Promise.resolve()
    expect(api.calls.filter((c) => c.kind === 'chat_action').length).toBe(actionsCount)
    // (no point asserting callsBefore beyond the snapshot we already
    // captured — used only as a scratch reference)
    expect(callsBefore).toBeGreaterThan(0)
  })

  test('400 parse error downgrades parse_mode and retries once', async () => {
    const { mgr, api } = makeManager()
    const h = await mgr.start(CHAT, undefined)

    // First edit on `thinking` is the only one that should land. The
    // initial send is parse_mode: HTML. We queue a parse error for
    // that edit; the classifier downgrades parse_mode and retries the
    // same text once. Verify the retry happened by counting calls.
    api.editErrors = [
      new TelegramError(400, "Bad Request: can't parse entities: oh no"),
    ]
    await mgr.update(h, { kind: 'thinking' })

    const edits = api.calls.filter((c) => c.kind === 'edit')
    // Two edit attempts: the failing one + the retry without parse_mode.
    expect(edits.length).toBe(2)
    // Retry has no parse_mode.
    const retry = edits[1]!.opts as { parse_mode?: string }
    expect(retry.parse_mode).toBeUndefined()
  })

  test('429 Too Many Requests after retry exhaustion drops this tick (no state mutation)', async () => {
    const { mgr, api, clock } = makeManager()
    const h = await mgr.start(CHAT, undefined)
    const editsBefore = api.calls.filter((c) => c.kind === 'edit').length

    api.editErrors = [
      new TelegramError(429, 'Too Many Requests', { retry_after: 5 }),
    ]
    await mgr.update(h, { kind: 'thinking' })
    // One attempt fired; no retry inside StatusManager (the rate-limit
    // wrapper handles 429 transparently when present, and the
    // status-manager classifier just drops this tick).
    const editsAfter = api.calls.filter((c) => c.kind === 'edit').length
    expect(editsAfter - editsBefore).toBe(1)
    // Entry not disabled — 429 is transient.
    expect(mgr.isActive(CHAT)).toBe(true)
    // Next interval tick fires a fresh edit (lastText was NOT synced
    // because the edit didn't succeed).
    clock.advance(700)
    await Promise.resolve()
    await Promise.resolve()
    const editsAfterTick = api.calls.filter((c) => c.kind === 'edit').length
    expect(editsAfterTick).toBeGreaterThan(editsAfter)
  })

  test('benign "message is not modified" syncs lastText cache', async () => {
    const { mgr, api } = makeManager()
    const h = await mgr.start(CHAT, undefined)
    api.editErrors = [
      new Error('Bad Request: message is not modified'),
    ]
    // Should not throw; lastText is updated so repeated identical
    // edits short-circuit before the network call (existing behaviour).
    await mgr.update(h, { kind: 'thinking' })
    expect(mgr.isActive(CHAT)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// FIX-C bug #1 (codex status #2) — ensureBubble vs complete()/cancel()
// race. Pre-fix: with `suppress_typing_bubble: true` (production
// default), ensureBubble runs OUTSIDE the lifecycle lock. complete()
// fires while ensureBubble is mid-await on sendMessage, reads
// bubbleSuppressed=true (flip happens AFTER the await), and bails. The
// in-flight send then resolves and leaves an untracked ghost message in
// the chat. Post-fix: complete()/cancel() await the in-flight
// bubbleCreationPromise before reading bubbleSuppressed; if the bubble
// was created during the await, the message is deleted (complete) or
// edited to «Остановлено» (cancel) like any other live bubble.
// ─────────────────────────────────────────────────────────────────────

describe('StatusManager — FIX-C bug #1 (ensureBubble vs complete/cancel race)', () => {
  test('complete() awaits in-flight ensureBubble and deletes the created message — no ghost', async () => {
    const { mgr, api } = makeManager({
      config: makeConfig({ suppress_typing_bubble: true }),
    })
    await mgr.start(CHAT, undefined)
    // The start() sentinel send is no-op under suppress_typing_bubble,
    // so no actual send happened yet.
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(0)

    // Gate the next sendMessage so we can observe the race window:
    // ensureBubble awaits the gate; complete() fires while bubble
    // creation is in-flight.
    let release: () => void = () => {}
    api.gateSend = {
      release,
      promise: new Promise<void>((r) => {
        release = r
      }),
    }
    api.gateSend.release = release

    // Kick off the non-typing update; ensureBubble is now awaiting sendMessage.
    const pending = mgr.updateByChatId(CHAT, { kind: 'tool', toolName: 'Bash' })

    // Fire complete() while the bubble is mid-flight. Pre-fix: this
    // bailed because bubbleSuppressed was still true. Post-fix: it
    // must wait for the bubbleCreationPromise to resolve, see the
    // real messageId, and delete it.
    const completePromise = mgr.complete(CHAT)

    // Release the gate; both the in-flight ensureBubble and the
    // queued complete-after-await should now make progress.
    release()
    delete api.gateSend

    await Promise.all([pending, completePromise])

    // Exactly one send fired (the ensureBubble create) and exactly
    // one delete on that same message_id — no ghost left behind.
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(1)
    const createdId = sends[0]!.messageId
    expect(createdId).not.toBeUndefined()
    const deletes = api.calls.filter(
      (c) => c.kind === 'delete' && c.messageId === createdId,
    )
    expect(deletes.length).toBe(1)
    // Entry was removed from the map.
    expect(mgr.isActive(CHAT)).toBe(false)
  })

  test('cancel() awaits in-flight ensureBubble and edits «Остановлено» on the created message', async () => {
    const { mgr, api } = makeManager({
      config: makeConfig({ suppress_typing_bubble: true }),
    })
    await mgr.start(CHAT, undefined)
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(0)

    let release: () => void = () => {}
    api.gateSend = {
      release,
      promise: new Promise<void>((r) => {
        release = r
      }),
    }
    api.gateSend.release = release

    const pending = mgr.updateByChatId(CHAT, { kind: 'tool', toolName: 'Bash' })
    const cancelPromise = mgr.cancel(CHAT, 'user')
    release()
    delete api.gateSend

    await Promise.all([pending, cancelPromise])

    // One send (bubble created), one edit («Остановлено: user») on
    // the SAME message id. Pre-fix the edit never happened — cancel
    // bailed on bubbleSuppressed=true and the ghost stayed in the
    // chat as «🔧 Bash».
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(1)
    const createdId = sends[0]!.messageId
    const cancelEdits = api.calls.filter(
      (c) =>
        c.kind === 'edit' &&
        c.messageId === createdId &&
        typeof c.text === 'string' &&
        c.text.includes('Остановлено'),
    )
    expect(cancelEdits.length).toBe(1)
    expect(mgr.isActive(CHAT)).toBe(false)
  })

  test('complete() during in-flight FAILED ensureBubble leaves no ghost (no message ever sent)', async () => {
    // Variant of the race where the in-flight sendMessage rejects.
    // bubbleSuppressed stays true; complete() awaits, sees the
    // suppressed flag is still set after the await, and exits without
    // attempting a delete (there is nothing to delete).
    const { mgr, api } = makeManager({
      config: makeConfig({ suppress_typing_bubble: true }),
    })
    await mgr.start(CHAT, undefined)

    let release: () => void = () => {}
    api.gateSend = {
      release,
      promise: new Promise<void>((r) => {
        release = r
      }),
    }
    api.gateSend.release = release
    // Queue an error for the in-flight send.
    api.sendErrors = [new Error('telegram transient — send failed')]

    const pending = mgr.updateByChatId(CHAT, { kind: 'tool', toolName: 'Bash' })
    const completePromise = mgr.complete(CHAT)
    release()
    delete api.gateSend

    await Promise.all([pending, completePromise])

    // The send attempt was recorded (failed), no delete, no edit,
    // entry clean.
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(1)
    expect(api.calls.filter((c) => c.kind === 'delete').length).toBe(0)
    expect(mgr.isActive(CHAT)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// FIX-C bug #2 (codex status #1) — update(handle, …) no longer drops
// silently after a lazy bubble is created.
//
// Pre-fix: update() used `entry.handle.messageId !== handle.messageId`
// as the staleness check. start() with suppress_typing_bubble=true
// returned a handle with messageId=0. On the first non-typing update
// ensureBubble flipped entry.handle.messageId to the real Telegram
// id — but the caller still held the original `0`-handle. Every
// subsequent update() failed the messageId comparison and returned
// silently, freezing the status.
//
// Post-fix: the staleness check is generation-based, captured at
// start(). The lazy-bubble flip never touches generation, so callers
// keep their original handle for the entire lifecycle.
// ─────────────────────────────────────────────────────────────────────

describe('StatusManager — FIX-C bug #2 (handle stays valid after lazy bubble)', () => {
  test('subsequent update() calls land after lazy-bubble creation', async () => {
    const { mgr, api } = makeManager({
      config: makeConfig({ suppress_typing_bubble: true }),
    })
    const h = await mgr.start(CHAT, undefined)
    // start() returned a sentinel-shaped handle: messageId=0 because
    // the bubble is suppressed until the first non-typing event.
    expect(h.messageId).toBe(0)
    expect(h.generation).toBe(1)

    // First non-typing update triggers ensureBubble; entry.handle.messageId
    // becomes the real Telegram id. The CALLER's handle stays `0`.
    await mgr.update(h, { kind: 'tool', toolName: 'Bash' })
    const sends = api.calls.filter((c) => c.kind === 'send')
    expect(sends.length).toBe(1)
    const realId = sends[0]!.messageId!
    expect(realId).not.toBe(0)

    // Pre-fix: this second update() failed the messageId comparison
    // (entry.handle.messageId !== h.messageId — real id !== 0) and
    // silently dropped, leaving the bubble frozen at «🔧 Bash».
    // Post-fix: generation matches (1 === 1), the edit lands.
    await mgr.update(h, { kind: 'tool', toolName: 'Read' })
    const editsForReal = api.calls.filter(
      (c) => c.kind === 'edit' && c.messageId === realId,
    )
    expect(editsForReal.length).toBe(1)
    expect(editsForReal[0]!.text).toContain('Read')

    // Third update keeps landing too.
    await mgr.update(h, { kind: 'thinking' })
    const editsAfterThird = api.calls.filter(
      (c) => c.kind === 'edit' && c.messageId === realId,
    )
    expect(editsAfterThird.length).toBe(2)
  })

  test('handle held across complete() is rejected while no entry exists', async () => {
    // Verify the negative direction: after complete() drops the entry,
    // the held handle no longer matches any live state. update()
    // returns at the first `entries.get` check (no entry), so no edit
    // lands.
    //
    // NOTE: the counter is per-entry, so after a brand-new start() on
    // the same chatId the fresh entry's generation resets to 1. A
    // stale handle from the PREVIOUS lifecycle with generation==1
    // would coincidentally still match — that's a design limitation
    // of the per-entry counter that callers are expected to mitigate
    // by re-acquiring a handle after each start/cancel/complete. The
    // staleness guard covers the primary use case (lazy-bubble inside
    // a single lifecycle); cross-lifecycle confusion is rare and the
    // entries.delete check in complete/cancel is the first line of
    // defence.
    const { mgr, api } = makeManager({
      config: makeConfig({ suppress_typing_bubble: false }),
    })
    const h1 = await mgr.start(CHAT, undefined)
    expect(h1.generation).toBe(1)
    await mgr.complete(CHAT)

    expect(mgr.isActive(CHAT)).toBe(false)
    const editsBefore = api.calls.filter((c) => c.kind === 'edit').length
    await mgr.update(h1, { kind: 'thinking' })
    const editsAfter = api.calls.filter((c) => c.kind === 'edit').length
    // h1 is rejected because the entry was deleted by complete().
    expect(editsAfter).toBe(editsBefore)
  })
})

// ─────────────────────────────────────────────────────────────────────
// FIX-C bug #4 (codex status #4) — `shouldStream` legacy export must
// delegate to the fail-CLOSED primitive `shouldStreamForChat`.
//
// Pre-fix: the deprecated `shouldStream(chatId, policy)` symbol kept
// its own fail-OPEN body: `policy?.chats[chatId] === undefined → true`.
// Any caller still wired to it would re-introduce the CRITICAL #1 /
// HIGH #9 leak (warchief streaming bleeds into public groups that
// were never declared in policy.yaml).
//
// Post-fix: the symbol exists but its body forwards to
// shouldStreamForChat, so unknown chats are denied.
// ─────────────────────────────────────────────────────────────────────

function makeChatPolicy(overrides: Partial<ChatPolicy> = {}): ChatPolicy {
  return {
    mode: 'private',
    streaming: 'progress',
    tmux_mirror: true,
    edit_message_progress: true,
    delivery: 'streamed',
    persona_file: 'persona.md',
    handoff_file: 'handoff.md',
    system_reminder: '',
    idle_ttl_ms: 1_800_000,
    max_queue_depth: 1,
    ...overrides,
  }
}

function makeFullPolicy(chats: Record<string, ChatPolicy>): MultichatPolicy {
  return {
    version: 1,
    allowlist: { chats: Object.keys(chats), users: [] },
    mention_allowlist: [],
    chats,
  }
}

describe('StatusManager — FIX-C bug #4 (shouldStream legacy export is fail-CLOSED)', () => {
  test('chat absent from policy.chats returns false (regression for HIGH #9)', () => {
    const policy = makeFullPolicy({
      '164795011': makeChatPolicy({ streaming: 'progress' }),
    })
    // Pre-fix this returned `true` (fail-OPEN) for any chat not in
    // policy.chats. Post-fix it must be false.
    expect(shouldStream('-1003784643974', policy)).toBe(false)
    expect(shouldStream('999', policy)).toBe(false)
  })

  test('chat present with streaming:"off" returns false', () => {
    const policy = makeFullPolicy({
      '-1003784643974': makeChatPolicy({ streaming: 'off', mode: 'public' }),
    })
    expect(shouldStream('-1003784643974', policy)).toBe(false)
  })

  test('chat present with streaming:"progress" returns true', () => {
    const policy = makeFullPolicy({
      '164795011': makeChatPolicy({ streaming: 'progress' }),
    })
    expect(shouldStream('164795011', policy)).toBe(true)
  })

  test('omitted policy (legacy single-DM) returns true', () => {
    // The legacy DM-only deployments pass no policy at all; the shim
    // must preserve the historical "every chat streams" behaviour.
    expect(shouldStream('164795011')).toBe(true)
    expect(shouldStream('-1003784643974')).toBe(true)
  })

  test('invalid chat id shape throws via the underlying assertValidChatId guard', () => {
    // The fail-closed primitive runs `assertValidChatId(chatId)`
    // first; the shim inherits that hard-fail. Pre-fix the shim
    // accepted any string silently.
    const policy = makeFullPolicy({
      '164795011': makeChatPolicy({ streaming: 'progress' }),
    })
    expect(() => shouldStream('abc', policy)).toThrow(TypeError)
    expect(() => shouldStream('../etc/passwd', policy)).toThrow(TypeError)
  })
})
