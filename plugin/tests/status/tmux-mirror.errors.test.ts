// TmuxMirror permanent-error classification tests (codex review
// 2026-05-27, TASK-3, HIGH #5).
//
// Pre-fix the mirror only handled 400 + "message to edit not found"
// (recreate next poll) and treated every other failure as a transient
// warn-and-keep-trying. That left edit storms on 403/401 (bot blocked)
// and on 400 parse errors (broken HTML in the pane).
//
// Post-fix the mirror runs every send/edit error through
// `classifyEditError`. Permanent failures (forbidden / parse) flip an
// internal `disabled` flag so the poll loop becomes a no-op; transient
// failures fall through to the next poll; 429 logs and drops.

import { describe, expect, spyOn, test } from 'bun:test'

import type {
  ChatAction,
  DownloadResult,
  EditOpts,
  SendDocumentOpts,
  SendMessageOpts,
  TelegramApi,
} from '../../src/channel/tools.js'
import type {
  ChatPolicy,
  MultichatPolicy,
} from '../../src/chats/policy-loader.js'
import type { Logger } from '../../src/log.js'
import {
  TmuxMirror,
  type TmuxExec,
  type TmuxExecResult,
} from '../../src/status/tmux-mirror.js'

// Telegram-shaped error mirroring grammY's GrammyError on the wire.
// The classifier accepts plain objects with error_code + description.
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

interface SentOp {
  method: 'sendMessage' | 'editMessageText' | 'deleteMessage'
  chatId: string
  messageId?: number
  text?: string
}

function makeStubApi(): {
  api: TelegramApi
  ops: SentOp[]
  queueSendError(err: Error): void
  queueEditError(err: Error): void
} {
  const ops: SentOp[] = []
  let nextMessageId = 100
  const sendErrorQueue: Error[] = []
  const editErrorQueue: Error[] = []
  const api: TelegramApi = {
    async sendMessage(chatId, text, _opts: SendMessageOpts) {
      // Record the attempt regardless of failure so tests can count
      // how many times the mirror reached Telegram.
      ops.push({ method: 'sendMessage', chatId, text })
      if (sendErrorQueue.length > 0) {
        const err = sendErrorQueue.shift()!
        throw err
      }
      const id = nextMessageId++
      return { message_id: id }
    },
    async editMessageText(chatId, messageId, text, _opts: EditOpts) {
      ops.push({ method: 'editMessageText', chatId, messageId, text })
      if (editErrorQueue.length > 0) {
        const err = editErrorQueue.shift()!
        throw err
      }
    },
    async deleteMessage(chatId, messageId) {
      ops.push({ method: 'deleteMessage', chatId, messageId })
    },
    async setMessageReaction() {},
    async sendChatAction(_chatId, _action: ChatAction) {},
    async sendDocument(_chatId, _filePath, _opts: SendDocumentOpts) {
      return { message_id: 0 }
    },
    async sendPhoto(_chatId, _filePath, _opts: SendDocumentOpts) {
      return { message_id: 0 }
    },
    async downloadFile(_id, _dir): Promise<DownloadResult> {
      return { path: '/tmp/x', size: 0 }
    },
  }
  return {
    api,
    ops,
    queueSendError(err) {
      sendErrorQueue.push(err)
    },
    queueEditError(err) {
      editErrorQueue.push(err)
    },
  }
}

const stubLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

function makeExec(scenarios: TmuxExecResult[]): TmuxExec {
  let i = 0
  return async () => {
    const r = scenarios[Math.min(i, scenarios.length - 1)] ?? { stdout: '', stderr: '', exitCode: 0 }
    i += 1
    return r
  }
}

function ok(stdout: string): TmuxExecResult {
  return { stdout, stderr: '', exitCode: 0 }
}

// ─────────────────────────────────────────────────────────────────────
// Send failures — first call before any messageId is captured
// ─────────────────────────────────────────────────────────────────────

describe('TmuxMirror — send error classification', () => {
  test('send returning 403 Forbidden disables the mirror', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('hello'), ok('world')])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1000,
      lineCount: 50,
      exec,
    })
    stub.queueSendError(
      new TelegramError(403, 'Forbidden: bot was blocked by the user'),
    )
    await mirror.start()
    // status() now exposes `disabled` as a separate signal.
    expect(mirror.status().disabled).toBe(true)
    expect(mirror.status().lastError).toContain('forbidden')

    // Subsequent polls must be a no-op — no new sendMessage attempts.
    const sendsBefore = stub.ops.filter((o) => o.method === 'sendMessage').length
    await mirror.onPoll()
    await mirror.onPoll()
    const sendsAfter = stub.ops.filter((o) => o.method === 'sendMessage').length
    expect(sendsAfter).toBe(sendsBefore)
    await mirror.stop()
  })

  test('send returning 400 parse error disables the mirror', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('boom <unclosed-tag')])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1000,
      lineCount: 50,
      exec,
    })
    stub.queueSendError(
      new TelegramError(400, "Bad Request: can't parse entities: oh no"),
    )
    await mirror.start()
    expect(mirror.status().disabled).toBe(true)
    expect(mirror.status().lastError).toContain('parse')

    // Polling stays inert.
    const sendsBefore = stub.ops.filter((o) => o.method === 'sendMessage').length
    await mirror.onPoll()
    expect(stub.ops.filter((o) => o.method === 'sendMessage').length).toBe(sendsBefore)
    await mirror.stop()
  })

  test('send returning 429 with retry_after logs and drops; mirror NOT disabled', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('first'), ok('second')])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1000,
      lineCount: 50,
      exec,
    })
    stub.queueSendError(
      new TelegramError(429, 'Too Many Requests: flood control', {
        retry_after: 5,
      }),
    )
    await mirror.start()
    // Not disabled — 429 is transient. Next poll can retry.
    expect(mirror.status().disabled).toBeUndefined()
    expect(mirror.status().lastError).toContain('flood')

    // Second poll succeeds and lands a messageId.
    await mirror.onPoll()
    expect(mirror.status().messageId).toBeDefined()
    expect(mirror.status().disabled).toBeUndefined()
    await mirror.stop()
  })
})

// ─────────────────────────────────────────────────────────────────────
// Edit failures — after the initial send succeeded
// ─────────────────────────────────────────────────────────────────────

describe('TmuxMirror — edit error classification', () => {
  test('edit returning 400 parse error disables the mirror', async () => {
    const stub = makeStubApi()
    // Two distinct payloads so the second poll's edit actually fires
    // (the hash-dedup path would otherwise skip).
    const exec = makeExec([ok('first'), ok('second')])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1000,
      lineCount: 50,
      exec,
    })
    await mirror.start()
    stub.queueEditError(
      new TelegramError(400, "Bad Request: can't find end of the entity"),
    )
    await mirror.onPoll() // edit throws parse error
    expect(mirror.status().disabled).toBe(true)
    expect(mirror.status().lastError).toContain('parse')

    // Further polls do nothing.
    const editsBefore = stub.ops.filter((o) => o.method === 'editMessageText').length
    await mirror.onPoll()
    expect(stub.ops.filter((o) => o.method === 'editMessageText').length).toBe(editsBefore)
    await mirror.stop()
  })

  test('edit returning 401 Unauthorized disables the mirror', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('first'), ok('second')])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1000,
      lineCount: 50,
      exec,
    })
    await mirror.start()
    stub.queueEditError(new TelegramError(401, 'Unauthorized'))
    await mirror.onPoll()
    expect(mirror.status().disabled).toBe(true)
    await mirror.stop()
  })

  test('edit returning 429 with retry_after logs and drops; mirror not disabled', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('first'), ok('second'), ok('third')])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1000,
      lineCount: 50,
      exec,
    })
    await mirror.start()
    stub.queueEditError(
      new TelegramError(429, 'Too Many Requests: flood', { retry_after: 5 }),
    )
    await mirror.onPoll()
    expect(mirror.status().disabled).toBeUndefined()
    expect(mirror.status().lastError).toContain('flood')

    // messageId preserved → next poll attempts an edit (not a send).
    await mirror.onPoll()
    const sends = stub.ops.filter((o) => o.method === 'sendMessage')
    // Only the initial send from start().
    expect(sends.length).toBe(1)
    await mirror.stop()
  })

  test('edit returning "message can\'t be edited" classifies as message_gone', async () => {
    // Telegram returns this when a message is too old (>48h) or sent
    // by a different bot/user. Treat identically to "message not
    // found" — drop messageId so the next poll resends.
    const stub = makeStubApi()
    const exec = makeExec([ok('first'), ok('second'), ok('third')])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1000,
      lineCount: 50,
      exec,
    })
    await mirror.start()
    stub.queueEditError(
      new TelegramError(400, "Bad Request: message can't be edited"),
    )
    await mirror.onPoll() // edit fails with message_gone → drop messageId
    await mirror.onPoll() // resend
    const sends = stub.ops.filter((o) => o.method === 'sendMessage')
    expect(sends.length).toBe(2) // initial start + recreate
    await mirror.stop()
  })

  test('edit returning "message is not modified" is benign (no state change)', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('first'), ok('second')])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1000,
      lineCount: 50,
      exec,
    })
    await mirror.start()
    const messageIdBefore = mirror.status().messageId
    stub.queueEditError(
      new TelegramError(400, 'Bad Request: message is not modified'),
    )
    await mirror.onPoll()
    expect(mirror.status().disabled).toBeUndefined()
    expect(mirror.status().messageId).toBe(messageIdBefore!)
    await mirror.stop()
  })
})

// ─────────────────────────────────────────────────────────────────────
// FIX-C bug #3 (codex status #3) — stop() must always be cleanup,
// never gated by the policy check.
//
// Pre-fix: stop() began with an `if (!this.isMirrorAllowed()) return`.
// If the chat was REVOKED from policy mid-life (warchief edits
// policy.yaml while the mirror is running), stop() exited without
// disarming the interval OR deleting the rolling message — a ghost
// mirror message stayed in the chat forever, and the host process
// held an orphan interval until SIGTERM.
//
// Post-fix: stop() is unconditional cleanup. The policy gate stays on
// start/onPoll/bump (entry points that perform Telegram writes); stop
// always disarms the timer and best-effort deletes the message.
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

function makePolicy(chats: Record<string, ChatPolicy>): MultichatPolicy {
  return {
    version: 1,
    allowlist: { chats: Object.keys(chats), users: [] },
    mention_allowlist: [],
    chats,
  }
}

describe('TmuxMirror — FIX-C bug #3 (stop() after policy revocation)', () => {
  test('stop() after the chat is removed from policy still disarms the timer and deletes the message', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('initial pane'), ok('updated pane')])
    const policy = makePolicy({
      '164795011': makeChatPolicy({ tmux_mirror: true }),
    })
    // Spy on clearInterval BEFORE constructing the mirror so we capture
    // the disarm call inside stop(). The mirror uses setInterval
    // directly (no test seam), so we observe behaviour through the
    // global timer surface.
    const clearSpy = spyOn(globalThis, 'clearInterval')
    try {
      const mirror = new TmuxMirror({
        api: stub.api,
        log: stubLog,
        chatId: '164795011',
        paneTarget: 'channel-thrall:0.0',
        pollIntervalMs: 1_000_000, // long — interval never fires within the test window
        lineCount: 50,
        exec,
        policy,
      })
      await mirror.start()
      // Mirror is live: messageId captured, interval armed.
      expect(mirror.status().messageId).toBeDefined()
      const messageId = mirror.status().messageId!

      // Revoke the policy entry mid-life (warchief edits policy.yaml).
      // The policy reference is shared by-ref with the mirror, so the
      // next isMirrorAllowed() call sees the chat as absent.
      delete (policy.chats as Record<string, ChatPolicy>)['164795011']

      const clearCallsBefore = clearSpy.mock.calls.length
      await mirror.stop()
      const clearCallsAfter = clearSpy.mock.calls.length

      // Pre-fix: stop() bailed on `if (!isMirrorAllowed()) return`,
      // so neither clearInterval nor deleteMessage fired.
      // Post-fix: both fire unconditionally.
      expect(clearCallsAfter).toBeGreaterThan(clearCallsBefore)
      const deletes = stub.ops.filter(
        (o) => o.method === 'deleteMessage' && o.messageId === messageId,
      )
      expect(deletes.length).toBe(1)
      expect(mirror.status().enabled).toBe(false)
      expect(mirror.status().messageId).toBeUndefined()
    } finally {
      clearSpy.mockRestore()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// FIX-C bug #5 (codex status #6) — disabled=true must also disarm
// the polling interval.
//
// Pre-fix: when a permanent Telegram error (403/parse) flipped
// `this.disabled = true`, the interval kept firing. onPoll() bailed
// early on the disabled check so no Telegram writes hit the wire, but
// the timer callback still woke up every pollIntervalMs until stop()
// ran — wasted CPU, allocations, and an event-loop tick the host
// could never reclaim.
//
// Post-fix: both handleSendError and handleEditError call
// disarmTimer() the moment they set `disabled=true`, so the interval
// is cleared the same tick the disable happens.
// ─────────────────────────────────────────────────────────────────────

describe('TmuxMirror — FIX-C bug #5 (disabled=true disarms the polling timer)', () => {
  test('403 on send during initial start: interval is never armed, mirror disabled', async () => {
    // Pre-fix bug #5 had two flavours:
    //   (a) interval already armed → disable hits, timer keeps firing
    //       until stop() runs. Covered by the edit-time test below.
    //   (b) initial start fails with a permanent error → disable
    //       happens BEFORE setInterval is reached; pre-fix the
    //       arming code didn't check `disabled` and armed the
    //       interval anyway.
    // This test covers (b). We verify the interval never got armed
    // by inspecting the private `timer` field after start().
    const stub = makeStubApi()
    const exec = makeExec([ok('hello')])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1_000_000,
      lineCount: 50,
      exec,
    })
    stub.queueSendError(
      new TelegramError(403, 'Forbidden: bot was blocked by the user'),
    )
    await mirror.start()
    expect(mirror.status().disabled).toBe(true)
    // Private field probe — the start arming guard added in FIX-C
    // bug #5 keeps `timer` null when `disabled` flipped during the
    // synchronous first poll. Without the guard, setInterval would
    // have armed and the host process would hold an orphan timer.
    const privateTimer = (
      mirror as unknown as { timer: ReturnType<typeof setInterval> | null }
    ).timer
    expect(privateTimer).toBeNull()
    await mirror.stop()
  })

  test('parse error on edit disarms the interval immediately on disable', async () => {
    const stub = makeStubApi()
    // Two distinct payloads so the edit (post-initial-send) fires
    // against the second poll, where the parse error is queued.
    const exec = makeExec([ok('first'), ok('second')])
    const clearSpy = spyOn(globalThis, 'clearInterval')
    try {
      const mirror = new TmuxMirror({
        api: stub.api,
        log: stubLog,
        chatId: '100',
        paneTarget: 'channel-thrall:0.0',
        pollIntervalMs: 1_000_000,
        lineCount: 50,
        exec,
      })
      await mirror.start() // initial send succeeds → interval armed
      expect(mirror.status().disabled).toBeUndefined()

      const clearCallsBefore = clearSpy.mock.calls.length
      stub.queueEditError(
        new TelegramError(400, "Bad Request: can't parse entities: oh no"),
      )
      await mirror.onPoll() // edit throws parse error → disabled + disarm
      const clearCallsAfter = clearSpy.mock.calls.length

      expect(mirror.status().disabled).toBe(true)
      // clearInterval must have been called from inside the parse
      // branch of handleEditError, before stop() runs.
      expect(clearCallsAfter).toBeGreaterThan(clearCallsBefore)

      await mirror.stop()
    } finally {
      clearSpy.mockRestore()
    }
  })
})
