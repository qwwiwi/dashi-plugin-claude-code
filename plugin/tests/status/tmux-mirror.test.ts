// Tests for TmuxMirror — the rolling Telegram message that polls
// `tmux capture-pane` and re-renders the last N lines into one
// chat message. We exercise the lifecycle (start / stop), the hash-dedup
// skip, the recreate-on-404 path, ANSI strip + redaction, length cap, and
// tmux-unavailable behaviour.
//
// The mirror is wall-clock + child-process driven, so the test injects
// fake `exec` and `now` seams to keep tests deterministic and fast.

import { describe, expect, test } from 'bun:test'
import type {
  ChatAction,
  DownloadResult,
  EditOpts,
  SendDocumentOpts,
  SendMessageOpts,
  TelegramApi,
} from '../../src/channel/tools.js'
import type { Logger } from '../../src/log.js'
import {
  TmuxMirror,
  type TmuxExec,
  type TmuxExecResult,
} from '../../src/status/tmux-mirror.js'

interface SentOp {
  method: 'sendMessage' | 'editMessageText' | 'deleteMessage'
  chatId: string
  messageId?: number
  text?: string
}

function makeStubApi(initialMessageId = 100): {
  api: TelegramApi
  ops: SentOp[]
  queueEditError(err: { error_code: number; description?: string }): void
  reset(): void
} {
  const ops: SentOp[] = []
  let nextMessageId = initialMessageId
  let editErrorQueue: Array<{ error_code: number; description?: string }> = []
  const api: TelegramApi = {
    async sendMessage(chatId, text, _opts: SendMessageOpts) {
      ops.push({ method: 'sendMessage', chatId, text })
      const id = nextMessageId++
      return { message_id: id }
    },
    async editMessageText(chatId, messageId, text, _opts: EditOpts) {
      if (editErrorQueue.length > 0) {
        const err = editErrorQueue.shift()
        if (err) {
          const e = new Error(`telegram error ${err.error_code}`) as Error & {
            error_code: number
            description?: string
          }
          e.error_code = err.error_code
          if (err.description !== undefined) e.description = err.description
          throw e
        }
      }
      ops.push({ method: 'editMessageText', chatId, messageId, text })
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
    queueEditError(err) {
      editErrorQueue.push(err)
    },
    reset() {
      ops.length = 0
      editErrorQueue = []
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

function fail(stderr: string, exitCode = 1): TmuxExecResult {
  return { stdout: '', stderr, exitCode }
}

describe('TmuxMirror — lifecycle', () => {
  test('start sends initial message; subsequent identical poll is skipped', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('hello world'), ok('hello world'), ok('hello world')])
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
    await mirror.onPoll()
    await mirror.onPoll()
    const sends = stub.ops.filter((o) => o.method === 'sendMessage')
    const edits = stub.ops.filter((o) => o.method === 'editMessageText')
    expect(sends.length).toBe(1)
    expect(edits.length).toBe(0) // identical content, no edits
    expect(mirror.status().enabled).toBe(true)
    await mirror.stop()
  })

  test('changed pane content triggers editMessageText', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('one'), ok('two'), ok('three')])
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
    await mirror.onPoll()
    await mirror.onPoll()
    expect(stub.ops.filter((o) => o.method === 'sendMessage').length).toBe(1)
    expect(stub.ops.filter((o) => o.method === 'editMessageText').length).toBe(2)
    await mirror.stop()
  })

  test('stop deletes the rolling message and clears messageId', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('hello')])
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
    await mirror.stop()
    const deletes = stub.ops.filter((o) => o.method === 'deleteMessage')
    expect(deletes.length).toBe(1)
    expect(mirror.status().messageId).toBeUndefined()
    expect(mirror.status().enabled).toBe(false)
  })

  test('start is idempotent — second start does not double-send', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('hello'), ok('hello')])
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
    await mirror.start()
    expect(stub.ops.filter((o) => o.method === 'sendMessage').length).toBe(1)
    await mirror.stop()
  })
})

describe('TmuxMirror — recreate on Telegram 400 (message not found)', () => {
  test('edit returning "message to edit not found" clears messageId and next poll resends', async () => {
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
    stub.queueEditError({
      error_code: 400,
      description: 'Bad Request: message to edit not found',
    })
    await mirror.onPoll() // tries edit, gets 400, clears messageId
    await mirror.onPoll() // sends fresh message
    const sends = stub.ops.filter((o) => o.method === 'sendMessage')
    expect(sends.length).toBe(2)
    await mirror.stop()
  })

  test('edit returning unrelated 4xx (e.g. 403 Forbidden) does NOT trigger resend', async () => {
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
    stub.queueEditError({
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    })
    await mirror.onPoll() // tries edit, gets 403, logs warn — must NOT clear messageId
    await mirror.onPoll() // tries edit again with same messageId — no resend
    const sends = stub.ops.filter((o) => o.method === 'sendMessage')
    // Only the initial send from start(). No recreate on permanent failure.
    expect(sends.length).toBe(1)
    await mirror.stop()
  })
})

describe('TmuxMirror — ANSI strip & secret redaction', () => {
  test('ANSI escape sequences are stripped before rendering', async () => {
    const stub = makeStubApi()
    const ansi = '\x1b[31mERROR\x1b[0m okay'
    const exec = makeExec([ok(ansi)])
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
    const sent = stub.ops.find((o) => o.method === 'sendMessage')
    expect(sent).toBeDefined()
    expect(sent?.text).not.toContain('\x1b[')
    expect(sent?.text).toContain('ERROR okay')
    await mirror.stop()
  })

  test('redactor is applied to pane content before send', async () => {
    const stub = makeStubApi()
    const redactor = (s: string): string => s.replace(/SECRET-[A-Z0-9]+/g, '[REDACTED]')
    const exec = makeExec([ok('token: SECRET-ABC123 visible')])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1000,
      lineCount: 50,
      exec,
      redact: redactor,
    })
    await mirror.start()
    const sent = stub.ops.find((o) => o.method === 'sendMessage')
    expect(sent?.text).toContain('[REDACTED]')
    expect(sent?.text).not.toContain('SECRET-ABC123')
    await mirror.stop()
  })
})

describe('TmuxMirror — tmux unavailable', () => {
  test('failed tmux exec renders error state and keeps polling', async () => {
    const stub = makeStubApi()
    const exec = makeExec([
      fail("can't find session: channel-thrall", 1),
      ok('alive now'),
    ])
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
    // First poll surfaced an error state.
    const first = stub.ops.find((o) => o.method === 'sendMessage')
    expect(first?.text).toContain('tmux')
    // Next poll succeeds — mirror should self-heal and edit to the new content.
    await mirror.onPoll()
    const editsAfter = stub.ops.filter((o) => o.method === 'editMessageText')
    expect(editsAfter.length).toBeGreaterThan(0)
    expect(mirror.status().enabled).toBe(true) // still enabled
    await mirror.stop()
  })
})

describe('TmuxMirror — length cap', () => {
  test('large pane is truncated to fit Telegram body cap', async () => {
    const stub = makeStubApi()
    // Generate 5000 chars of text (over 4096 cap).
    const bigLine = 'X'.repeat(120)
    const blob = Array.from({ length: 50 }, (_, i) => `${i}: ${bigLine}`).join('\n')
    const exec = makeExec([ok(blob)])
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
    const sent = stub.ops.find((o) => o.method === 'sendMessage')
    expect(sent).toBeDefined()
    expect(sent!.text!.length).toBeLessThanOrEqual(4096)
    // Truncation must keep the END (newest output) and mark the head.
    expect(sent!.text).toContain('truncated')
    await mirror.stop()
  })
})

describe('TmuxMirror — concurrency', () => {
  test('overlapping polls do not double-edit', async () => {
    const stub = makeStubApi()
    let resolveFirst!: (v: TmuxExecResult) => void
    const exec: TmuxExec = (() => {
      let call = 0
      return async () => {
        call += 1
        if (call === 1) return ok('first')
        if (call === 2) {
          // Block until releaseExec is called.
          return await new Promise<TmuxExecResult>((r) => {
            resolveFirst = r
          })
        }
        return ok('third')
      }
    })()
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
    // Fire two onPolls concurrently — the second must skip while the first runs.
    const p1 = mirror.onPoll()
    const p2 = mirror.onPoll()
    // Release the first poll's tmux exec.
    resolveFirst(ok('second'))
    await Promise.all([p1, p2])
    // We expect exactly one edit (from p1's content); p2 should have been
    // skipped (in-flight guard).
    expect(stub.ops.filter((o) => o.method === 'editMessageText').length).toBe(1)
    await mirror.stop()
  })
})

describe('TmuxMirror — stop()-during-poll race', () => {
  test('stop() while first onPoll() is in flight does not leave a ghost message', async () => {
    const stub = makeStubApi()
    let resolveExec!: (v: TmuxExecResult) => void
    const slowExec: TmuxExec = () =>
      new Promise<TmuxExecResult>((r) => {
        resolveExec = r
      })
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1000,
      lineCount: 50,
      exec: slowExec,
    })
    // start() is awaiting onPoll → exec → hanging on slowExec.
    const startPromise = mirror.start()
    // Now stop() while exec hasn't resolved yet.
    const stopPromise = mirror.stop()
    // Release the exec → onPoll proceeds, but enabled is now false.
    resolveExec(ok('would have been published'))
    await startPromise
    await stopPromise
    // No send and no orphan messageId.
    expect(stub.ops.filter((o) => o.method === 'sendMessage').length).toBe(0)
    expect(mirror.status().messageId).toBeUndefined()
    expect(mirror.status().enabled).toBe(false)
  })

  test('redact callback throw renders error state, mirror keeps polling', async () => {
    const stub = makeStubApi()
    const throwingRedactor = (): string => {
      throw new Error('redactor exploded')
    }
    const exec = makeExec([ok('secret pane'), ok('still alive')])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1000,
      lineCount: 50,
      exec,
      redact: throwingRedactor,
    })
    await mirror.start()
    // First send must be the error-state body, NOT the raw pane text.
    const sent = stub.ops.find((o) => o.method === 'sendMessage')
    expect(sent?.text).toContain('redactor failed')
    expect(sent?.text).not.toContain('secret pane')
    expect(mirror.status().lastError).toContain('redactor exploded')
    await mirror.stop()
  })
})

describe('TmuxMirror — status accessor', () => {
  test('status reflects last poll outcome', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('hello')])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1000,
      lineCount: 50,
      exec,
      now: () => 1000,
    })
    await mirror.start()
    const s = mirror.status()
    expect(s.enabled).toBe(true)
    expect(s.messageId).toBeDefined()
    expect(s.lastPollAt).toBe(1000)
    expect(s.lastError).toBeUndefined()
    await mirror.stop()
  })
})
