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
import {
  type ChatPolicy,
  type MultichatPolicy,
} from '../../src/chats/policy-loader.js'

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

  test('socketName prepends -L to every capture-pane exec; empty omits it', async () => {
    const calls: string[][] = []
    const recordingExec: TmuxExec = async (args) => {
      calls.push([...args])
      return ok('pane content')
    }
    const withSocket = new TmuxMirror({
      api: makeStubApi().api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-arthas:0.0',
      socketName: 'channel-arthas',
      pollIntervalMs: 1000,
      lineCount: 50,
      exec: recordingExec,
    })
    await withSocket.start()
    await withSocket.onPoll()
    await withSocket.stop()
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls.filter((a) => a.includes('capture-pane'))) {
      expect(args.slice(0, 2)).toEqual(['-L', 'channel-arthas'])
    }

    calls.length = 0
    const noSocket = new TmuxMirror({
      api: makeStubApi().api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1000,
      lineCount: 50,
      exec: recordingExec,
    })
    await noSocket.start()
    await noSocket.onPoll()
    await noSocket.stop()
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) {
      expect(args[0]).toBe('capture-pane')
      expect(args).not.toContain('-L')
    }
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
  test('large pane is line-capped (default maxLines=14) then char-capped to fit Telegram body', async () => {
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
      // No maxLines override → default 14 from constructor applies and
      // capLines shrinks 50 lines → 14 with a `… +N lines` marker BEFORE
      // renderBody char-truncation has anything left to do.
    })
    await mirror.start()
    const sent = stub.ops.find((o) => o.method === 'sendMessage')
    expect(sent).toBeDefined()
    expect(sent!.text!.length).toBeLessThanOrEqual(4096)
    // Line cap marker (matches `… +N lines`). Char-cap `[truncated]`
    // header is only emitted when the body STILL exceeds 4096 after the
    // line cap — with the default cap that path is unreachable here.
    expect(sent!.text).toMatch(/… \+\d+ lines/)
    // Tail of the original blob survives.
    expect(sent!.text).toContain('49:')
    await mirror.stop()
  })

  test('maxLines=0 disables the line cap; renderBody char truncation kicks in instead', async () => {
    const stub = makeStubApi()
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
      maxLines: 0,
    })
    await mirror.start()
    const sent = stub.ops.find((o) => o.method === 'sendMessage')
    expect(sent).toBeDefined()
    expect(sent!.text!.length).toBeLessThanOrEqual(4096)
    expect(sent!.text).toContain('truncated')
    await mirror.stop()
  })
})

describe('TmuxMirror — latest_inbound_only (default)', () => {
  test('default mode pivots on the last `← <channel>:` preview and drops earlier history', async () => {
    const stub = makeStubApi()
    const pane = [
      '● Old turn from yesterday',
      '← dashi-channel: stale-voice-1',
      '● Reply to stale voice 1',
      '← dashi-channel: latest-voice',
      '● Live agent activity after the warchief\'s last message',
    ].join('\n')
    const exec = makeExec([ok(pane)])
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
    // Pre-pivot content must not leak into the iPhone view.
    expect(sent!.text).not.toContain('Old turn from yesterday')
    expect(sent!.text).not.toContain('stale-voice-1')
    expect(sent!.text).not.toContain('latest-voice')
    // Tail survives.
    expect(sent!.text).toContain('Live agent activity')
    await mirror.stop()
  })

  test('explicit mode=full_pane preserves the entire pane (legacy behaviour)', async () => {
    const stub = makeStubApi()
    const pane = [
      '● Old turn',
      '← dashi-channel: preview',
      '● New turn',
    ].join('\n')
    const exec = makeExec([ok(pane)])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1000,
      lineCount: 50,
      exec,
      mode: 'full_pane',
    })
    await mirror.start()
    const sent = stub.ops.find((o) => o.method === 'sendMessage')
    expect(sent).toBeDefined()
    expect(sent!.text).toContain('Old turn')
    expect(sent!.text).toContain('preview')
    expect(sent!.text).toContain('New turn')
    await mirror.stop()
  })

  test('fresh session with no preview line falls back to full_pane and stays visible', async () => {
    const stub = makeStubApi()
    const pane = '● First turn of a fresh session, nothing inbound yet'
    const exec = makeExec([ok(pane)])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1000,
      lineCount: 50,
      exec,
      // default mode = latest_inbound_only
    })
    await mirror.start()
    const sent = stub.ops.find((o) => o.method === 'sendMessage')
    expect(sent).toBeDefined()
    expect(sent!.text).toContain('First turn')
    expect(sent!.text).not.toContain('no visible output')
    await mirror.stop()
  })

  test('input box (── + ❯ + ──) and Tip footer are hidden by default', async () => {
    const stub = makeStubApi()
    const pane = [
      '● Live agent line',
      '────────────────────────────────────────',
      '❯                                       ',
      '────────────────────────────────────────',
      'Tip: Use /btw to ask a quick side question',
    ].join('\n')
    const exec = makeExec([ok(pane)])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1000,
      lineCount: 50,
      exec,
      mode: 'full_pane', // disable pivot so we test ONLY the hide list
    })
    await mirror.start()
    const sent = stub.ops.find((o) => o.method === 'sendMessage')
    expect(sent).toBeDefined()
    expect(sent!.text).toContain('Live agent line')
    expect(sent!.text).not.toContain('────')
    expect(sent!.text).not.toContain('❯')
    expect(sent!.text).not.toContain('Tip: Use /btw')
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

describe('TmuxMirror — bump (re-anchor after inbound)', () => {
  test('bump deletes the current message and immediately sends a new one', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('first'), ok('first'), ok('first')])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1_000_000, // effectively disabled — drive manually
      lineCount: 50,
      exec,
    })
    await mirror.start()
    const initialMessageId = mirror.status().messageId
    expect(initialMessageId).toBeDefined()
    expect(stub.ops.filter((o) => o.method === 'sendMessage').length).toBe(1)
    expect(stub.ops.filter((o) => o.method === 'deleteMessage').length).toBe(0)

    await mirror.bump()

    // The bump sequence must produce: deleteMessage of the old id, then
    // a fresh sendMessage. Edits are NOT acceptable — the warchief asked
    // for a NEW message at the bottom of the chat, not an in-place edit.
    expect(stub.ops.filter((o) => o.method === 'deleteMessage').length).toBe(1)
    expect(stub.ops.filter((o) => o.method === 'sendMessage').length).toBe(2)
    // The mirror is now tracking a different (fresh) message_id.
    const newMessageId = mirror.status().messageId
    expect(newMessageId).toBeDefined()
    expect(newMessageId).not.toBe(initialMessageId)
    // And the delete operation targeted the old id.
    const del = stub.ops.find((o) => o.method === 'deleteMessage')
    expect(del?.messageId).toBe(initialMessageId)
    await mirror.stop()
  })

  test('bump on a disabled mirror is a no-op', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('first')])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1_000_000,
      lineCount: 50,
      exec,
    })
    // Never started.
    await mirror.bump()
    expect(stub.ops.length).toBe(0)
    expect(mirror.status().enabled).toBe(false)
  })

  test('bump swallows deleteMessage errors and still resends', async () => {
    const stub = makeStubApi()
    const ops = stub.ops
    const exec = makeExec([ok('first'), ok('first')])
    // Wrap deleteMessage to throw once.
    const baseApi = stub.api
    let deletesAttempted = 0
    const flakyApi: typeof baseApi = {
      ...baseApi,
      async deleteMessage(chatId, messageId) {
        deletesAttempted += 1
        ops.push({ method: 'deleteMessage', chatId, messageId })
        throw new Error('telegram delete 400')
      },
    }
    const mirror = new TmuxMirror({
      api: flakyApi,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1_000_000,
      lineCount: 50,
      exec,
    })
    await mirror.start()
    await mirror.bump()
    // Even though delete threw, we must still have sent the new message.
    expect(deletesAttempted).toBe(1)
    expect(ops.filter((o) => o.method === 'sendMessage').length).toBe(2)
    await mirror.stop()
  })
})

describe('TmuxMirror — bump debounce + safety', () => {
  test('rapid double-bump within debounce window collapses to one delete+send', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('first'), ok('first'), ok('first')])
    let t = 1_000_000
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1_000_000,
      lineCount: 50,
      exec,
      now: () => t,
    })
    await mirror.start() // initial send
    t += 10 // 10ms later — still within 1500ms debounce window
    await mirror.bump()
    t += 50
    await mirror.bump() // should be skipped
    t += 50
    await mirror.bump() // should be skipped
    // Only one delete+send pair beyond initial send.
    expect(stub.ops.filter((o) => o.method === 'deleteMessage').length).toBe(1)
    expect(stub.ops.filter((o) => o.method === 'sendMessage').length).toBe(2)
    await mirror.stop()
  })

  test('bump after the debounce window passes goes through', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('first'), ok('first'), ok('first')])
    let t = 1_000_000
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1_000_000,
      lineCount: 50,
      exec,
      now: () => t,
    })
    await mirror.start()
    t += 10
    await mirror.bump() // 1st bump goes through
    t += 5000 // well past the 1500ms debounce window
    await mirror.bump() // 2nd bump also goes through
    expect(stub.ops.filter((o) => o.method === 'deleteMessage').length).toBe(2)
    expect(stub.ops.filter((o) => o.method === 'sendMessage').length).toBe(3)
    await mirror.stop()
  })

  test('bump on a stopped mirror after start (race with stop) does not resurrect', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('first')])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1_000_000,
      lineCount: 50,
      exec,
    })
    await mirror.start()
    await mirror.stop()
    stub.reset()
    // After stop, bump must do nothing — neither delete (no messageId)
    // nor send (enabled=false).
    await mirror.bump()
    expect(stub.ops.length).toBe(0)
  })
})

describe('TmuxMirror — segment filter integration', () => {
  test('boot banner is hidden from the rendered body by default', async () => {
    const stub = makeStubApi()
    const pane = [
      '╭─── Claude Code v2.1.144 ─────────────────────────────────────────────────────╮',
      '│                 Welcome back Dashi!                │ Tips for getting        │',
      '│       grenkalove@gmail.com\'s Organization          │ /release-notes for more │',
      '╰──────────────────────────────────────────────────────────────────────────────╯',
      '',
      '> live conversation content',
    ].join('\n')
    const exec = makeExec([ok(pane)])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1_000_000,
      lineCount: 50,
      exec,
    })
    await mirror.start()
    const sent = stub.ops.find((o) => o.method === 'sendMessage')
    expect(sent).toBeDefined()
    expect(sent?.text).not.toContain('Claude Code v2.1.144')
    expect(sent?.text).not.toContain('Welcome back Dashi')
    expect(sent?.text).not.toContain('grenkalove@gmail.com')
    expect(sent?.text).toContain('live conversation content')
    await mirror.stop()
  })

  test('pane that collapses to empty after filter renders «(no visible output)»', async () => {
    // Idle pane that only contains banner + footer (no live content):
    // the filter strips everything, but the mirror must still render
    // a valid Telegram body — Telegram rejects `<pre></pre>` with
    // empty inner text as 400 «message text is empty».
    const stub = makeStubApi()
    const pane = [
      '╭─── Claude Code v2.1.144 ──╮',
      '│  Welcome back            │',
      '╰───────────────────────────╯',
      '',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
    ].join('\n')
    const exec = makeExec([ok(pane)])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1_000_000,
      lineCount: 50,
      exec,
    })
    await mirror.start()
    const sent = stub.ops.find((o) => o.method === 'sendMessage')
    expect(sent).toBeDefined()
    expect(sent?.text).toContain('(no visible output)')
    expect(sent?.text).not.toContain('Claude Code v2.1.144')
    expect(sent?.text).not.toContain('bypass permissions')
    await mirror.stop()
  })

  test('explicit empty hideSegments disables filtering (raw pane)', async () => {
    const stub = makeStubApi()
    const pane = [
      '╭─── Claude Code v2.1.144 ───╮',
      '│       Welcome back        │',
      '╰────────────────────────────╯',
      '> hello',
    ].join('\n')
    const exec = makeExec([ok(pane)])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: '100',
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1_000_000,
      lineCount: 50,
      exec,
      hideSegments: [],
    })
    await mirror.start()
    const sent = stub.ops.find((o) => o.method === 'sendMessage')
    expect(sent?.text).toContain('Claude Code v2.1.144')
    expect(sent?.text).toContain('Welcome back')
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

// ─────────────────────────────────────────────────────────────────────
// Multichat policy gate (Codex review fix 2026-05-27, TASK-2 /
// HIGH #9). The mirror must consult `shouldMirrorTmuxForChat(policy,
// chatId)` per public entry point — pre-fix a single boolean was
// computed at construction time from the warchief's chat id, leaking
// pane content into chats absent from policy (fail-open) or making
// the wrong chat the source of truth for the wrong instance.
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

describe('TmuxMirror — multichat policy isolation', () => {
  const WARCHIEF = '164795011'
  const PUBLIC_GROUP = '-1003784643974'
  const UNLISTED = '999'

  test('chat with tmux_mirror=true sends the initial pane message', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('warchief pane')])
    const policy = makePolicy({
      [WARCHIEF]: makeChatPolicy({ tmux_mirror: true }),
    })
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: WARCHIEF,
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1_000_000,
      lineCount: 50,
      exec,
      policy,
    })
    await mirror.start()
    expect(stub.ops.filter((o) => o.method === 'sendMessage').length).toBe(1)
    expect(mirror.status().enabled).toBe(true)
    await mirror.stop()
  })

  test('chat with tmux_mirror=false is a complete no-op (fail-closed for public groups)', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('public pane should never appear')])
    const policy = makePolicy({
      [WARCHIEF]: makeChatPolicy({ tmux_mirror: true }),
      [PUBLIC_GROUP]: makeChatPolicy({
        tmux_mirror: false,
        mode: 'public',
        streaming: 'off',
      }),
    })
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: PUBLIC_GROUP,
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1_000_000,
      lineCount: 50,
      exec,
      policy,
    })

    await mirror.start()
    await mirror.onPoll()
    await mirror.bump()
    await mirror.stop()

    expect(stub.ops.length).toBe(0)
    expect(mirror.status().enabled).toBe(false)
    expect(mirror.status().messageId).toBeUndefined()
  })

  test('chat absent from policy is fail-CLOSED (no traffic)', async () => {
    // Regression for HIGH #9: pre-fix `shouldEnableMirror()` returned
    // `true` for a missing chat entry (fail-OPEN). The new helper is
    // fail-closed — verify a chat that nobody declared in policy
    // receives zero pane content.
    const stub = makeStubApi()
    const exec = makeExec([ok('leak canary should not appear')])
    const policy = makePolicy({
      [WARCHIEF]: makeChatPolicy({ tmux_mirror: true }),
    })
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: UNLISTED,
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1_000_000,
      lineCount: 50,
      exec,
      policy,
    })
    await mirror.start()
    expect(stub.ops.length).toBe(0)
    await mirror.stop()
    expect(stub.ops.length).toBe(0)
  })

  test('null policy preserves legacy single-DM behaviour (mirror runs)', async () => {
    const stub = makeStubApi()
    const exec = makeExec([ok('legacy DM pane')])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: WARCHIEF,
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1_000_000,
      lineCount: 50,
      exec,
      policy: null,
    })
    await mirror.start()
    expect(stub.ops.filter((o) => o.method === 'sendMessage').length).toBe(1)
    await mirror.stop()
  })

  test('omitting policy in opts defaults to null (legacy behaviour)', async () => {
    // Construction without `policy` must NOT silently deny — existing
    // single-DM deployments rely on the legacy default of "mirror
    // always runs when enabled".
    const stub = makeStubApi()
    const exec = makeExec([ok('legacy default')])
    const mirror = new TmuxMirror({
      api: stub.api,
      log: stubLog,
      chatId: WARCHIEF,
      paneTarget: 'channel-thrall:0.0',
      pollIntervalMs: 1_000_000,
      lineCount: 50,
      exec,
      // `policy` deliberately omitted.
    })
    await mirror.start()
    expect(stub.ops.filter((o) => o.method === 'sendMessage').length).toBe(1)
    await mirror.stop()
  })
})

describe('TmuxMirror — terminal glyph sanitization (no emoji in the mirror)', () => {
  // Claude Code's pane uses ⏺ (U+23FA) as a tool bullet and ⚠ (U+26A0) for
  // warnings. iOS Telegram renders both with EMOJI presentation, which
  // violates the owner's no-emoji style. The mirror must replace them with
  // text-presentation equivalents before sending (2026-06-09, Mac mini
  // migration smoke).
  test('emoji-presentation glyphs are replaced with text-safe equivalents', async () => {
    const stub = makeStubApi()
    const pane = '⏺ Bash(ls -la)\n⚠ 1 setup issue: MCP\n❯ ok'
    const exec = makeExec([ok(pane)])
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
    expect(sent?.text).not.toContain('⏺')
    expect(sent?.text).not.toContain('⚠')
    // replacements keep the line readable
    expect(sent?.text).toContain('● Bash(ls -la)')
    expect(sent?.text).toContain('(!) 1 setup issue: MCP')
    // emoji variation selectors never reach Telegram
    expect(sent?.text).not.toContain('️')
    await mirror.stop()
  })
})
