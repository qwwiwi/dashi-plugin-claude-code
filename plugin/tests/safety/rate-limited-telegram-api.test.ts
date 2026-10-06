// Tests for createRateLimitedTelegramApi — the wrapper that enforces
// per-chat FIFO ordering, a per-chat token bucket, a global token bucket,
// and 429 retry-after backoff on every outbound API call.
//
// The wrapper is transport-agnostic; we feed it a hand-rolled stub
// TelegramApi that records every call and can be programmed to throw
// grammY-shaped 429 errors. A fake clock + fake sleep give deterministic
// tests with no real wall-clock waits.

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
  createFileFloodWaitStore,
  createJsonlRateLimitEventSink,
  createRateLimitedTelegramApi,
  TelegramFloodWaitError,
  type FloodWaitRecord,
  type FloodWaitStore,
  type RateLimitEvent,
  type RateLimitOptions,
} from '../../src/safety/rate-limited-telegram-api.js'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

interface SentCall {
  method:
    | 'sendMessage'
    | 'editMessageText'
    | 'setMessageReaction'
    | 'sendChatAction'
    | 'sendDocument'
    | 'sendPhoto'
    | 'deleteMessage'
    | 'downloadFile'
    | 'answerGuestQuery'
    | 'sendRichMessage'
    | 'editRichMessage'
  chatId?: string
  messageId?: number
  text?: string
  emoji?: string
  action?: ChatAction
  filePath?: string
  fileId?: string
  opts?: SendMessageOpts | EditOpts | SendDocumentOpts
  ts: number
}

class FakeClock {
  // ms since start of test. Tests advance by calling `tick(ms)`.
  private t = 0
  now = (): number => this.t
  // Pending sleep resolvers, keyed by absolute wake time.
  private pending: Array<{ wakeAt: number; resolve: () => void }> = []
  sleep = (ms: number): Promise<void> => {
    if (ms <= 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.pending.push({ wakeAt: this.t + ms, resolve })
    })
  }
  async tick(ms: number): Promise<void> {
    this.t += ms
    // Resolve any sleeps whose wake time has passed. Resolve in order so
    // FIFO ordering is preserved.
    const due = this.pending
      .filter((p) => p.wakeAt <= this.t)
      .sort((a, b) => a.wakeAt - b.wakeAt)
    this.pending = this.pending.filter((p) => p.wakeAt > this.t)
    for (const p of due) p.resolve()
    // Yield to event loop so resolved promises propagate.
    await flushMicrotasks()
  }
}

// Drain microtask queue so awaiting code can advance.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

// Build a grammY-shaped 429 error.
function make429Error(retryAfter: number | undefined): Error {
  const err = new Error('Too Many Requests') as Error & {
    error_code: number
    parameters: { retry_after?: number }
  }
  err.error_code = 429
  err.parameters = retryAfter !== undefined ? { retry_after: retryAfter } : {}
  return err
}

interface StubApi {
  api: TelegramApi
  calls: SentCall[]
  // Programmed errors per method/chat. When an error is set, the next
  // matching call throws it and the entry is consumed.
  queueError(method: SentCall['method'], err: Error): void
  // Times the method was entered, counting attempts that threw. `calls`
  // only records successes, so this is what proves a retry did (or did
  // not) happen.
  attempts(method: SentCall['method']): number
}

function makeStubApi(clock: FakeClock): StubApi {
  const calls: SentCall[] = []
  const errorQueue: Map<SentCall['method'], Error[]> = new Map()
  const attemptCount: Map<SentCall['method'], number> = new Map()
  const maybeThrow = (method: SentCall['method']): void => {
    attemptCount.set(method, (attemptCount.get(method) ?? 0) + 1)
    const list = errorQueue.get(method)
    if (list && list.length > 0) {
      const err = list.shift()
      if (err) throw err
    }
  }
  const api: TelegramApi = {
    async sendMessage(chatId, text, opts) {
      maybeThrow('sendMessage')
      calls.push({ method: 'sendMessage', chatId, text, opts, ts: clock.now() })
      return { message_id: calls.length }
    },
    async sendRichMessage(chatId, _rawMarkdown, _opts) {
      // Pass-through stub; the rich path's own coverage lives in
      // tests/safety/rich-path.test.ts. Routes through the same enqueue here.
      maybeThrow('sendRichMessage')
      calls.push({ method: 'sendRichMessage', chatId, ts: clock.now() })
      return { message_id: calls.length }
    },
    async editRichMessage(chatId, messageId) {
      maybeThrow('editRichMessage')
      calls.push({ method: 'editRichMessage', chatId, messageId, ts: clock.now() })
      return { fallback: true } as const
    },
    async editMessageText(chatId, messageId, text, opts) {
      maybeThrow('editMessageText')
      calls.push({ method: 'editMessageText', chatId, messageId, text, opts, ts: clock.now() })
    },
    async setMessageReaction(chatId, messageId, emoji) {
      maybeThrow('setMessageReaction')
      calls.push({ method: 'setMessageReaction', chatId, messageId, emoji, ts: clock.now() })
    },
    async sendChatAction(chatId, action) {
      maybeThrow('sendChatAction')
      calls.push({ method: 'sendChatAction', chatId, action, ts: clock.now() })
    },
    async sendDocument(chatId, filePath, opts) {
      maybeThrow('sendDocument')
      calls.push({ method: 'sendDocument', chatId, filePath, opts, ts: clock.now() })
      return { message_id: calls.length }
    },
    async sendPhoto(chatId, filePath, opts) {
      maybeThrow('sendPhoto')
      calls.push({ method: 'sendPhoto', chatId, filePath, opts, ts: clock.now() })
      return { message_id: calls.length }
    },
    async downloadFile(fileId, _destDir) {
      maybeThrow('downloadFile')
      calls.push({ method: 'downloadFile', fileId, ts: clock.now() })
      return { path: '/tmp/x', size: 0 } satisfies DownloadResult
    },
    async deleteMessage(chatId, messageId) {
      maybeThrow('deleteMessage')
      calls.push({ method: 'deleteMessage', chatId, messageId, ts: clock.now() })
    },
    async answerGuestQuery(_guestQueryId, text, _opts) {
      maybeThrow('answerGuestQuery')
      calls.push({ method: 'answerGuestQuery', text, ts: clock.now() })
    },
  }
  return {
    api,
    calls,
    queueError(method, err) {
      const list = errorQueue.get(method) ?? []
      list.push(err)
      errorQueue.set(method, list)
    },
    attempts(method) {
      return attemptCount.get(method) ?? 0
    },
  }
}

const stubLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

function defaultOpts(clock: FakeClock): RateLimitOptions {
  return {
    perChatRefillPerSec: 1,
    perChatBurstCapacity: 3,
    globalRefillPerSec: 25,
    globalBurstCapacity: 25,
    maxRetries: 3,
    jitterMaxMs: 0, // deterministic
    now: clock.now,
    sleep: clock.sleep,
  }
}

describe('createRateLimitedTelegramApi — per-chat token bucket', () => {
  test('single send passes through immediately', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    const result = await api.sendMessage('100', 'hi', {})
    expect(result.message_id).toBe(1)
    expect(stub.calls.length).toBe(1)
    expect(stub.calls[0]?.ts).toBe(0)
  })

  test('first 3 sends to same chat consume burst capacity without waiting', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    await Promise.all([
      api.sendMessage('100', 'a', {}),
      api.sendMessage('100', 'b', {}),
      api.sendMessage('100', 'c', {}),
    ])
    expect(stub.calls.map((c) => c.text)).toEqual(['a', 'b', 'c'])
    expect(stub.calls.every((c) => c.ts === 0)).toBe(true)
  })

  test('4th send to same chat waits for refill (1s)', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    // Drain the burst.
    await api.sendMessage('100', 'a', {})
    await api.sendMessage('100', 'b', {})
    await api.sendMessage('100', 'c', {})
    expect(stub.calls.length).toBe(3)
    // Fourth send must wait ~1000ms for refill.
    const p = api.sendMessage('100', 'd', {})
    await flushMicrotasks()
    expect(stub.calls.length).toBe(3) // still queued
    await clock.tick(999)
    expect(stub.calls.length).toBe(3)
    await clock.tick(1)
    await p
    expect(stub.calls.length).toBe(4)
    expect(stub.calls[3]?.text).toBe('d')
  })

  test('sends to different chats run in parallel up to global cap', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    // 5 different chats — global cap is 25, per-chat each gets a fresh
    // bucket, so all 5 should fire at t=0.
    await Promise.all([
      api.sendMessage('100', 'a', {}),
      api.sendMessage('200', 'b', {}),
      api.sendMessage('300', 'c', {}),
      api.sendMessage('400', 'd', {}),
      api.sendMessage('500', 'e', {}),
    ])
    expect(stub.calls.length).toBe(5)
    expect(stub.calls.every((c) => c.ts === 0)).toBe(true)
  })

  test('FIFO order preserved within a single chat under concurrency', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    // Fire 5 sends concurrently — first 3 burst through, 4th waits 1s, 5th waits 2s.
    const p = Promise.all([
      api.sendMessage('100', '1', {}),
      api.sendMessage('100', '2', {}),
      api.sendMessage('100', '3', {}),
      api.sendMessage('100', '4', {}),
      api.sendMessage('100', '5', {}),
    ])
    await flushMicrotasks()
    expect(stub.calls.length).toBe(3)
    await clock.tick(1000)
    expect(stub.calls.length).toBe(4)
    await clock.tick(1000)
    await p
    expect(stub.calls.length).toBe(5)
    expect(stub.calls.map((c) => c.text)).toEqual(['1', '2', '3', '4', '5'])
  })
})

describe('createRateLimitedTelegramApi — global token bucket', () => {
  test('global cap caps parallel sends across chats', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const opts = defaultOpts(clock)
    opts.globalBurstCapacity = 2
    opts.globalRefillPerSec = 1
    const api = createRateLimitedTelegramApi(stub.api, stubLog, opts)
    // 3 different chats, each chat has fresh per-chat bucket. Global cap=2
    // means only 2 fire at t=0; the third waits 1s for global refill.
    const p = Promise.all([
      api.sendMessage('100', 'a', {}),
      api.sendMessage('200', 'b', {}),
      api.sendMessage('300', 'c', {}),
    ])
    await flushMicrotasks()
    expect(stub.calls.length).toBe(2)
    await clock.tick(1000)
    await p
    expect(stub.calls.length).toBe(3)
  })

  test('answerGuestQuery bypasses the send bucket but retries on 429', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const opts = defaultOpts(clock)
    opts.perChatBurstCapacity = 1
    const api = createRateLimitedTelegramApi(stub.api, stubLog, opts)
    // Exhaust the per-chat bucket — guest answers must not care (no chat).
    await api.sendMessage('100', 'a', {})
    stub.queueError('answerGuestQuery', make429Error(1))
    const p = api.answerGuestQuery('gq', 'ответ', {})
    await flushMicrotasks()
    // Bucket bypass: the first attempt went out immediately (and got the 429)
    // while the per-chat bucket for '100' is still empty.
    expect(stub.attempts('answerGuestQuery')).toBe(1)
    // retry_after is honoured: no second attempt before the full second.
    await clock.tick(999)
    expect(stub.attempts('answerGuestQuery')).toBe(1)
    await clock.tick(1)
    await p
    expect(stub.attempts('answerGuestQuery')).toBe(2)
    expect(stub.calls.filter((c) => c.method === 'answerGuestQuery').length).toBe(1)
  })

  // hermes static review of 7eb81c8: a rich send is one outbound bubble and
  // must share the per-chat FIFO + bucket with plain sends; a rich edit
  // targets an existing message and must NOT wait on that bucket.
  test('rich send shares the per-chat FIFO and bucket; rich edit skips the bucket', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const opts = defaultOpts(clock)
    opts.perChatBurstCapacity = 1
    const api = createRateLimitedTelegramApi(stub.api, stubLog, opts)
    const p = Promise.all([
      api.sendMessage('100', '1', {}),
      api.sendRichMessage('100', '**2**', {}),
      api.sendMessage('100', '3', {}),
    ])
    await flushMicrotasks()
    expect(stub.calls.map((c) => c.method)).toEqual(['sendMessage'])
    // Bucket empty, yet the rich edit goes straight through.
    await api.editRichMessage('100', 1, '**e**')
    expect(stub.calls.map((c) => c.method)).toEqual(['sendMessage', 'editRichMessage'])
    await clock.tick(1000)
    expect(stub.calls.map((c) => c.method)).toEqual(['sendMessage', 'editRichMessage', 'sendRichMessage'])
    await clock.tick(1000)
    await p
    expect(stub.calls.map((c) => c.method)).toEqual([
      'sendMessage',
      'editRichMessage',
      'sendRichMessage',
      'sendMessage',
    ])
  })

  // Opus merge review #7: a flood-wait earned by a rich send/edit must be
  // journalled under the rich method, not as a plain sendMessage /
  // editMessageText — otherwise the journal this branch added points at the
  // wrong caller. Both still share the send breaker: a rich ban suppresses
  // plain sends and vice versa.
  test('rich send and rich edit are journalled under their own method names', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const events: RateLimitEvent[] = []
    const api = createRateLimitedTelegramApi(stub.api, stubLog, {
      ...defaultOpts(clock),
      onRateLimitEvent: (e) => events.push(e),
    })
    stub.queueError('sendRichMessage', make429Error(30_710))
    const rich = await api.sendRichMessage('100', '**x**', {}).catch((e: unknown) => e)
    expect(rich).toBeInstanceOf(TelegramFloodWaitError)
    expect((rich as TelegramFloodWaitError).message).toContain('flood-wait on sendRichMessage')
    // Shared send breaker: a plain edit is now suppressed too.
    const edit = await api.editMessageText('100', 1, 'y', {}).catch((e: unknown) => e)
    expect(edit).toBeInstanceOf(TelegramFloodWaitError)
    expect(stub.attempts('editMessageText')).toBe(0)
    await clock.tick(30_711 * 1000)
    stub.queueError('editRichMessage', make429Error(30_710))
    const richEdit = await api.editRichMessage('100', 1, '**z**').catch((e: unknown) => e)
    expect(richEdit).toBeInstanceOf(TelegramFloodWaitError)
    expect(events.filter((e) => e.kind === 'flood_wait').map((e) => e.method)).toEqual([
      'sendRichMessage',
      'editRichMessage',
    ])
  })

  // hermes static review of 9bb38f4: the HUD pin/unpin adapters in server.ts
  // are `withFloodGuard('pinChatMessage' | 'unpinChatMessage', () => bot.api.*)`.
  // This pins down what that guard does for them: zero calls inside an open
  // send window, a normal call once the window has passed, and their own
  // long 429 opening the send breaker for everything else.
  test('withFloodGuard for pin/unpin: silent inside the send window, live after it, own 429 opens the breaker', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const events: RateLimitEvent[] = []
    const api = createRateLimitedTelegramApi(stub.api, stubLog, {
      ...defaultOpts(clock),
      onRateLimitEvent: (e) => events.push(e),
    })
    let pinCalls = 0
    const pin = () =>
      api.withFloodGuard('pinChatMessage', async () => {
        pinCalls += 1
      })
    // 1. A plain send earns a 30 710 s ban → send window open.
    stub.queueError('sendMessage', make429Error(30_710))
    await api.sendMessage('100', 'x', {}).catch(() => {})
    // 2. Pin inside the window: fails fast, never reaches the API.
    const inside = await pin().catch((e: unknown) => e)
    expect(inside).toBeInstanceOf(TelegramFloodWaitError)
    expect(pinCalls).toBe(0)
    // 3. Window passed: the very same adapter call goes through.
    await clock.tick(30_711 * 1000)
    await pin()
    expect(pinCalls).toBe(1)
    // 4. Unpin earns its own long 429: journalled under its name, send
    //    breaker open again → a plain send is suppressed with zero attempts.
    let unpinCalls = 0
    const unpinErr = await api
      .withFloodGuard('unpinChatMessage', async () => {
        unpinCalls += 1
        throw make429Error(30_710)
      })
      .catch((e: unknown) => e)
    expect(unpinErr).toBeInstanceOf(TelegramFloodWaitError)
    expect(unpinCalls).toBe(1)
    const send = await api.sendMessage('100', 'y', {}).catch((e: unknown) => e)
    expect(send).toBeInstanceOf(TelegramFloodWaitError)
    expect(stub.attempts('sendMessage')).toBe(1)
    expect(events.filter((e) => e.kind === 'flood_wait').map((e) => e.method)).toEqual([
      'sendMessage',
      'unpinChatMessage',
    ])
  })
})

describe('createRateLimitedTelegramApi — 429 retry-after', () => {
  test('429 with retry_after triggers single backoff and retries', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    stub.queueError('sendMessage', make429Error(2))
    const p = api.sendMessage('100', 'hi', {})
    await flushMicrotasks()
    // First call threw 429 — no recorded call yet (error path skips push).
    expect(stub.calls.length).toBe(0)
    // Advance < retry_after — still waiting.
    await clock.tick(1999)
    expect(stub.calls.length).toBe(0)
    await clock.tick(1)
    const r = await p
    expect(stub.calls.length).toBe(1)
    expect(r.message_id).toBe(1)
  })

  test('429 without retry_after falls back to 1s', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    stub.queueError('sendMessage', make429Error(undefined))
    const p = api.sendMessage('100', 'hi', {})
    await flushMicrotasks()
    await clock.tick(999)
    expect(stub.calls.length).toBe(0)
    await clock.tick(1)
    await p
    expect(stub.calls.length).toBe(1)
  })

  test('two consecutive 429s succeed on the third attempt', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    stub.queueError('sendMessage', make429Error(1))
    stub.queueError('sendMessage', make429Error(2))
    const p = api.sendMessage('100', 'hi', {})
    await flushMicrotasks()
    await clock.tick(1000) // first retry-after
    await flushMicrotasks()
    await clock.tick(2000) // second retry-after
    await p
    expect(stub.calls.length).toBe(1)
  })

  test('after maxRetries 429s, error propagates', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const opts = defaultOpts(clock)
    opts.maxRetries = 2
    const api = createRateLimitedTelegramApi(stub.api, stubLog, opts)
    stub.queueError('sendMessage', make429Error(1))
    stub.queueError('sendMessage', make429Error(1))
    const p = api.sendMessage('100', 'hi', {}).catch((e: unknown) => e)
    await flushMicrotasks()
    await clock.tick(1000)
    await flushMicrotasks()
    const result = await p
    expect(result).toBeInstanceOf(Error)
    expect((result as { error_code?: number }).error_code).toBe(429)
    expect(stub.calls.length).toBe(0)
  })

  test('non-429 errors propagate immediately without retry', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    const err = new Error('boom') as Error & { error_code?: number }
    err.error_code = 400
    stub.queueError('sendMessage', err)
    await expect(api.sendMessage('100', 'hi', {})).rejects.toMatchObject({ message: 'boom' })
    expect(stub.calls.length).toBe(0)
  })

  test('429 on editMessageText also retries (lighter bucket)', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    stub.queueError('editMessageText', make429Error(1))
    const p = api.editMessageText('100', 42, 'edited', {})
    await flushMicrotasks()
    await clock.tick(1000)
    await p
    expect(stub.calls.length).toBe(1)
  })
})

describe('createRateLimitedTelegramApi — retry_after clamp & edge values', () => {
  test('retry_after of exactly 60s still retries', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    stub.queueError('sendMessage', make429Error(60))
    const p = api.sendMessage('100', 'hi', {})
    await flushMicrotasks()
    await clock.tick(60_000)
    await p
    expect(stub.calls.length).toBe(1)
  })

  test('retry_after over 60s is a flood-wait: fails fast, never retries', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    stub.queueError('sendMessage', make429Error(30_710))
    const result = await api.sendMessage('100', 'hi', {}).catch((e: unknown) => e)
    // Rejected immediately — no sleep, no second request. Retrying inside a
    // flood-wait window re-arms the ban, which is the bug this guards.
    expect(result).toBeInstanceOf(TelegramFloodWaitError)
    expect(stub.calls.length).toBe(0)
    expect(stub.attempts('sendMessage')).toBe(1)
  })

  test('flood-wait error carries the true window and stays 429-shaped', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    const original = make429Error(30_710)
    stub.queueError('sendMessage', original)
    const result = (await api
      .sendMessage('100', 'hi', {})
      .catch((e: unknown) => e)) as TelegramFloodWaitError
    // Unclamped seconds, so the caller can schedule a resend...
    expect(result.retryAfterS).toBe(30_710)
    expect(result.windowOpensAtMs).toBe(clock.now() + 30_710_000)
    // ...and downstream `error_code === 429` checks keep working.
    expect(result.error_code).toBe(429)
    expect(result.cause).toBe(original)
  })

  test('breaker: after a flood-wait, later sends are rejected without hitting the API', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    stub.queueError('sendMessage', make429Error(30_710))
    const first = await api.sendMessage('100', 'first', {}).catch((e: unknown) => e)
    expect(first).toBeInstanceOf(TelegramFloodWaitError)
    expect(stub.attempts('sendMessage')).toBe(1)

    const second = await api.sendMessage('100', 'second', {}).catch((e: unknown) => e)
    expect(second).toBeInstanceOf(TelegramFloodWaitError)
    // The whole point: the API was never touched again, so nothing re-armed
    // the ban. Without this, each attempt bought another full window.
    expect(stub.attempts('sendMessage')).toBe(1)
    expect(stub.calls.length).toBe(0)
  })

  test('breaker reports the REMAINING window, not the original grant', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    const openedAt = clock.now()
    stub.queueError('sendMessage', make429Error(30_710))
    await api.sendMessage('100', 'first', {}).catch((e: unknown) => e)

    await clock.tick(10_000_000) // ~2h46m into the window
    const later = (await api
      .sendMessage('100', 'second', {})
      .catch((e: unknown) => e)) as TelegramFloodWaitError
    expect(later.retryAfterS).toBe(30_710 - 10_000)
    expect(later.windowOpensAtMs).toBe(openedAt + 30_710_000)
  })

  test('breaker closes once the window expires and sending resumes', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    stub.queueError('sendMessage', make429Error(30_710))
    await api.sendMessage('100', 'first', {}).catch((e: unknown) => e)

    await clock.tick(30_710_000)
    const resumed = await api.sendMessage('100', 'second', {})
    expect(resumed.message_id).toBe(1)
    expect(stub.calls.map((c) => c.text)).toEqual(['second'])
    expect(stub.attempts('sendMessage')).toBe(2)
  })

  test('breaker never shortens a window a later, smaller 429 would imply', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    stub.queueError('sendMessage', make429Error(30_710))
    await api.sendMessage('100', 'first', {}).catch((e: unknown) => e)
    const longWindow = clock.now() + 30_710_000

    // Window elapses; a fresh, much shorter flood-wait arrives.
    await clock.tick(30_710_000)
    stub.queueError('sendMessage', make429Error(120))
    const second = (await api
      .sendMessage('100', 'second', {})
      .catch((e: unknown) => e)) as TelegramFloodWaitError
    expect(second.windowOpensAtMs).toBe(clock.now() + 120_000)
    expect(second.windowOpensAtMs).toBeGreaterThan(longWindow)
  })

  test('retry_after = 0 is treated as 1s fallback', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    stub.queueError('sendMessage', make429Error(0))
    const p = api.sendMessage('100', 'hi', {})
    await flushMicrotasks()
    await clock.tick(1000)
    await p
    expect(stub.calls.length).toBe(1)
  })

  test('FIFO: second send waits for first retry to finish, then runs in order', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    // First call gets a 429 (retry_after=1), then succeeds.
    stub.queueError('sendMessage', make429Error(1))
    const p = Promise.all([
      api.sendMessage('100', 'first', {}),
      api.sendMessage('100', 'second', {}),
    ])
    await flushMicrotasks()
    // First call threw 429; second is still waiting on the chat tail.
    expect(stub.calls.length).toBe(0)
    await clock.tick(1000)
    await p
    expect(stub.calls.map((c) => c.text)).toEqual(['first', 'second'])
  })
})

describe('createRateLimitedTelegramApi — pass-through methods', () => {
  test('downloadFile is not rate-limited', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    // 10 parallel downloads should all fire at t=0.
    await Promise.all(
      Array.from({ length: 10 }, () => api.downloadFile('f', '/tmp')),
    )
    expect(stub.calls.length).toBe(10)
    expect(stub.calls.every((c) => c.ts === 0)).toBe(true)
  })

  test('editMessageText does not consume the per-chat send bucket', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const opts = defaultOpts(clock)
    opts.perChatBurstCapacity = 1
    const api = createRateLimitedTelegramApi(stub.api, stubLog, opts)
    // Use up the per-chat send bucket.
    await api.sendMessage('100', 'a', {})
    // Now do many edits — they must not be throttled by the send bucket.
    await Promise.all(
      Array.from({ length: 5 }, () => api.editMessageText('100', 42, 'edit', {})),
    )
    expect(stub.calls.filter((c) => c.method === 'editMessageText').length).toBe(5)
  })

  test('setMessageReaction is not gated by send bucket', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const opts = defaultOpts(clock)
    opts.perChatBurstCapacity = 1
    const api = createRateLimitedTelegramApi(stub.api, stubLog, opts)
    await api.sendMessage('100', 'a', {})
    await Promise.all(
      Array.from({ length: 5 }, () => api.setMessageReaction('100', 42, 'eyes')),
    )
    expect(stub.calls.filter((c) => c.method === 'setMessageReaction').length).toBe(5)
  })

  test('sendDocument and sendPhoto share the per-chat send bucket', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const opts = defaultOpts(clock)
    opts.perChatBurstCapacity = 2
    const api = createRateLimitedTelegramApi(stub.api, stubLog, opts)
    // Fire send + document + photo — third must wait since burst=2.
    const p = Promise.all([
      api.sendMessage('100', 'a', {}),
      api.sendDocument('100', '/tmp/d.pdf', {}),
      api.sendPhoto('100', '/tmp/p.jpg', {}),
    ])
    await flushMicrotasks()
    expect(stub.calls.length).toBe(2)
    await clock.tick(1000)
    await p
    expect(stub.calls.length).toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Flood-wait persistence, 429 journal, withFloodGuard (2026-09-18).
// Louis's bot: a restart inside a 56483 s window forgot the ban and the
// first reply re-armed it. These pin the fix.
// ─────────────────────────────────────────────────────────────────────

function memoryStore(initial: FloodWaitRecord | null = null): FloodWaitStore & {
  saved: FloodWaitRecord[]
  // Set to true to make save() report failure (disk full); the record is
  // still recorded in `attempts` so tests can count retries.
  failing: boolean
  attempts: FloodWaitRecord[]
} {
  const saved: FloodWaitRecord[] = []
  const attempts: FloodWaitRecord[] = []
  let current = initial
  const store = {
    saved,
    attempts,
    failing: false,
    load: () => current,
    save: (r: FloodWaitRecord): boolean => {
      attempts.push(r)
      if (store.failing) return false
      current = r
      saved.push(r)
      return true
    },
  }
  return store
}

describe('createRateLimitedTelegramApi — flood-wait survives restart', () => {
  test('a saved window still in the future is restored: first send suppressed, API untouched', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const store = memoryStore({
      until_ms: clock.now() + 50_000_000,
      method: 'sendMessage',
      retry_after_s: 56_483,
      seen_at: '2026-09-18T00:00:00.000Z',
    })
    const events: RateLimitEvent[] = []
    const api = createRateLimitedTelegramApi(stub.api, stubLog, {
      ...defaultOpts(clock),
      floodWaitStore: store,
      onRateLimitEvent: (e) => events.push(e),
    })
    const result = await api.sendMessage('100', 'after restart', {}).catch((e: unknown) => e)
    expect(result).toBeInstanceOf(TelegramFloodWaitError)
    expect((result as TelegramFloodWaitError).retryAfterS).toBe(50_000)
    expect(stub.attempts('sendMessage')).toBe(0)
    expect(events.map((e) => e.kind)).toEqual(['restored', 'suppressed'])
    expect(events[0]).toMatchObject({ kind: 'restored', method: 'sendMessage', retry_after_s: 50_000 })
  })

  test('an expired saved window is ignored and sending works', async () => {
    const clock = new FakeClock()
    clock.now = () => 100_000
    const stub = makeStubApi(clock)
    const store = memoryStore({ until_ms: 99_000, method: 'sendMessage', retry_after_s: 10, seen_at: '' })
    const api = createRateLimitedTelegramApi(stub.api, stubLog, { ...defaultOpts(clock), floodWaitStore: store })
    const sent = await api.sendMessage('100', 'ok', {})
    expect(sent.message_id).toBe(1)
    expect(store.saved.length).toBe(0)
  })

  test('a new flood-wait is saved with the method that earned it', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const store = memoryStore()
    const api = createRateLimitedTelegramApi(stub.api, stubLog, { ...defaultOpts(clock), floodWaitStore: store })
    stub.queueError('sendDocument', make429Error(30_710))
    await api.sendDocument('100', '/tmp/x.pdf', {}).catch(() => {})
    expect(store.saved.length).toBe(1)
    expect(store.saved[0]).toMatchObject({
      until_ms: clock.now() + 30_710_000,
      method: 'sendDocument',
      retry_after_s: 30_710,
    })
  })

  test('a fresh flood-wait after the old window expired is saved as a new record', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const store = memoryStore()
    const api = createRateLimitedTelegramApi(stub.api, stubLog, { ...defaultOpts(clock), floodWaitStore: store })
    stub.queueError('sendMessage', make429Error(30_710))
    await api.sendMessage('100', 'a', {}).catch(() => {})
    await clock.tick(30_710_000)
    stub.queueError('sendMessage', make429Error(120))
    await api.sendMessage('100', 'b', {}).catch(() => {})
    // Second window (120 s after expiry) IS longer than the expired one in
    // absolute terms, so it is saved — two records total, last one wins.
    expect(store.saved.length).toBe(2)
    expect(store.saved[1]?.retry_after_s).toBe(120)
  })

  test('a throwing event sink never breaks a send', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, {
      ...defaultOpts(clock),
      onRateLimitEvent: () => {
        throw new Error('sink broken')
      },
    })
    stub.queueError('sendMessage', make429Error(2))
    const p = api.sendMessage('100', 'hi', {})
    await flushMicrotasks()
    await clock.tick(2000)
    expect((await p).message_id).toBe(1)
  })
})

describe('createRateLimitedTelegramApi — 429 journal carries the method', () => {
  test('burst retry, flood-wait and suppression each emit one event with the real method and chat', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const events: RateLimitEvent[] = []
    const api = createRateLimitedTelegramApi(stub.api, stubLog, {
      ...defaultOpts(clock),
      onRateLimitEvent: (e) => events.push(e),
    })
    stub.queueError('sendPhoto', make429Error(3))
    const p = api.sendPhoto('7', '/tmp/a.jpg', {})
    await flushMicrotasks()
    await clock.tick(3000)
    await p
    stub.queueError('editMessageText', make429Error(30_710))
    await api.editMessageText('7', 1, 'x', {}).catch(() => {})
    await api.sendChatAction('8', 'typing').catch(() => {})
    expect(events).toEqual([
      { kind: 'burst_retry', method: 'sendPhoto', chat_id: '7', retry_after_s: 3, attempt: 1, wait_ms: 3000 },
      {
        kind: 'flood_wait',
        method: 'editMessageText',
        chat_id: '7',
        retry_after_s: 30_710,
        attempt: 1,
        window_opens_at: new Date(3000 + 30_710_000).toISOString(),
      },
      {
        kind: 'suppressed',
        method: 'sendChatAction',
        chat_id: '8',
        retry_after_s: 30_710,
        window_opens_at: new Date(3000 + 30_710_000).toISOString(),
        count: 1,
      },
    ])
  })
})

describe('createRateLimitedTelegramApi — withFloodGuard for calls outside TelegramApi', () => {
  test('runs the op and retries a burst 429 like any other method', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const events: RateLimitEvent[] = []
    const api = createRateLimitedTelegramApi(stub.api, stubLog, {
      ...defaultOpts(clock),
      onRateLimitEvent: (e) => events.push(e),
    })
    let n = 0
    const p = api.withFloodGuard('setMyCommands', async () => {
      n += 1
      if (n === 1) throw make429Error(5)
      return true
    })
    await flushMicrotasks()
    await clock.tick(5000)
    expect(await p).toBe(true)
    expect(n).toBe(2)
    expect(events[0]).toMatchObject({ kind: 'burst_retry', method: 'setMyCommands' })
    expect(events[0]).not.toHaveProperty('chat_id', expect.anything())
  })

  test('is suppressed inside a flood-wait without touching the API (the startup setMyCommands case)', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, {
      ...defaultOpts(clock),
      floodWaitStore: memoryStore({ until_ms: 10_000_000, method: 'sendMessage', retry_after_s: 10_000, seen_at: '' }),
    })
    let n = 0
    const result = await api
      .withFloodGuard('setMyCommands', async () => {
        n += 1
      })
      .catch((e: unknown) => e)
    expect(result).toBeInstanceOf(TelegramFloodWaitError)
    expect(n).toBe(0)
  })

  test('a flood-wait earned by withFloodGuard opens the breaker for ordinary sends too', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    await api.withFloodGuard('setMyCommands', async () => { throw make429Error(30_710) }).catch(() => {})
    const later = await api.sendMessage('100', 'x', {}).catch((e: unknown) => e)
    expect(later).toBeInstanceOf(TelegramFloodWaitError)
    expect(stub.attempts('sendMessage')).toBe(0)
  })
})

describe('createRateLimitedTelegramApi — hermes pre-merge checks (2026-09-18)', () => {
  test('guard runs again after a burst sleep: a window opened meanwhile stops the retry before it hits the API', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    // Chat A: burst 429, sleeps 5 s before retrying.
    stub.queueError('sendMessage', make429Error(5))
    const a = api.sendMessage('A', 'a', {}).catch((e: unknown) => e)
    await flushMicrotasks()
    expect(stub.attempts('sendMessage')).toBe(1)
    // Chat B, during A's sleep: flood-wait opens the breaker.
    stub.queueError('sendMessage', make429Error(30_710))
    await api.sendMessage('B', 'b', {}).catch(() => {})
    expect(stub.attempts('sendMessage')).toBe(2)
    // A wakes up: must NOT call the API again.
    await clock.tick(5000)
    const result = await a
    expect(result).toBeInstanceOf(TelegramFloodWaitError)
    expect(stub.attempts('sendMessage')).toBe(2)
  })

  test('queued sends behind a flood-wait are suppressed one by one without any API call', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    stub.queueError('sendMessage', make429Error(30_710))
    const results = await Promise.all(
      ['1', '2', '3'].map((t) => api.sendMessage('100', t, {}).catch((e: unknown) => e)),
    )
    expect(results.every((r) => r instanceof TelegramFloodWaitError)).toBe(true)
    expect(stub.attempts('sendMessage')).toBe(1)
  })

  test('a store whose load() throws does not stop the channel from starting and sending', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, {
      ...defaultOpts(clock),
      floodWaitStore: {
        load: () => {
          throw new Error('disk on fire')
        },
        save: () => true,
      },
    })
    expect((await api.sendMessage('100', 'ok', {})).message_id).toBe(1)
  })

  test('a store whose save() throws does not change the flood-wait outcome, and the window stays in memory', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, {
      ...defaultOpts(clock),
      floodWaitStore: {
        load: () => null,
        save: () => {
          throw new Error('EROFS')
        },
      },
    })
    stub.queueError('sendMessage', make429Error(30_710))
    const first = await api.sendMessage('100', 'a', {}).catch((e: unknown) => e)
    expect(first).toBeInstanceOf(TelegramFloodWaitError)
    const second = await api.sendMessage('100', 'b', {}).catch((e: unknown) => e)
    expect(second).toBeInstanceOf(TelegramFloodWaitError)
    expect(stub.attempts('sendMessage')).toBe(1)
  })

  test('a failed save is retried on later 429 events, at most once per 30 s, until it lands', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const store = memoryStore()
    store.failing = true
    const api = createRateLimitedTelegramApi(stub.api, stubLog, { ...defaultOpts(clock), floodWaitStore: store })
    stub.queueError('sendMessage', make429Error(30_710))
    await api.sendMessage('100', 'a', {}).catch(() => {})
    expect(store.attempts.length).toBe(1)
    expect(store.saved.length).toBe(0)
    // Immediate suppressed calls do not hammer the disk.
    await api.sendMessage('100', 'b', {}).catch(() => {})
    await api.sendMessage('100', 'c', {}).catch(() => {})
    expect(store.attempts.length).toBe(1)
    // 30 s later: one more attempt, still failing.
    await clock.tick(30_000)
    await api.sendMessage('100', 'd', {}).catch(() => {})
    expect(store.attempts.length).toBe(2)
    expect(store.saved.length).toBe(0)
    // Disk back: the next window passes and the ORIGINAL record lands.
    store.failing = false
    await clock.tick(30_000)
    await api.sendMessage('100', 'e', {}).catch(() => {})
    expect(store.saved.length).toBe(1)
    expect(store.saved[0]).toMatchObject({ until_ms: 30_710_000, method: 'sendMessage', retry_after_s: 30_710 })
    // Once persisted, nothing more is written.
    await clock.tick(30_000)
    await api.sendMessage('100', 'f', {}).catch(() => {})
    expect(store.attempts.length).toBe(3)
  })

  test('a restored window is not re-saved; a longer one seen later is', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const store = memoryStore({ until_ms: 1_000_000, method: 'sendMessage', retry_after_s: 1000, seen_at: '' })
    const api = createRateLimitedTelegramApi(stub.api, stubLog, { ...defaultOpts(clock), floodWaitStore: store })
    await api.sendMessage('100', 'a', {}).catch(() => {})
    expect(store.attempts.length).toBe(0)
    await clock.tick(1_000_000)
    stub.queueError('sendMessage', make429Error(5000))
    await api.sendMessage('100', 'b', {}).catch(() => {})
    expect(store.saved.length).toBe(1)
    expect(store.saved[0]?.until_ms).toBe(1_000_000 + 5_000_000)
  })

  test('suppressed calls are coalesced: one event per method per 30 s carrying the count', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const events: RateLimitEvent[] = []
    const api = createRateLimitedTelegramApi(stub.api, stubLog, {
      ...defaultOpts(clock),
      onRateLimitEvent: (e) => events.push(e),
    })
    stub.queueError('sendMessage', make429Error(30_710))
    await api.sendMessage('100', 'a', {}).catch(() => {})
    // Different chats: the per-chat bucket (burst 3) must not be what stops them.
    for (let i = 0; i < 5; i += 1) await api.sendMessage(`c${i}`, 'x', {}).catch(() => {})
    await api.sendChatAction('100', 'typing').catch(() => {})
    let suppressed = events.filter((e) => e.kind === 'suppressed')
    // First suppressed of each method reported at once, the other 4 sends counted.
    expect(suppressed.map((e) => [e.method, (e as { count: number }).count])).toEqual([
      ['sendMessage', 1],
      ['sendChatAction', 1],
    ])
    await clock.tick(30_000)
    await api.sendMessage('c9', 'y', {}).catch(() => {})
    suppressed = events.filter((e) => e.kind === 'suppressed')
    expect(suppressed.length).toBe(3)
    expect(suppressed[2]).toMatchObject({ kind: 'suppressed', method: 'sendMessage', count: 5 })
  })

  test('downloadFile (getFile) retries a burst 429 and has its own breaker for a long one', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    stub.queueError('downloadFile', make429Error(2))
    const p = api.downloadFile('f', '/tmp')
    await flushMicrotasks()
    await clock.tick(2000)
    expect((await p).path).toBe('/tmp/x')
    expect(stub.attempts('downloadFile')).toBe(2)
    stub.queueError('downloadFile', make429Error(30_710))
    await api.downloadFile('f', '/tmp').catch(() => {})
    const later = await api.downloadFile('f', '/tmp').catch((e: unknown) => e)
    expect(later).toBeInstanceOf(TelegramFloodWaitError)
    expect(stub.attempts('downloadFile')).toBe(3)
  })

  // Richard's review of 4d9ba13: a ban on SENDING must not make the agent
  // deaf to the owner's voice notes and photos for the whole window.
  test('downloadFile still reaches the API while a send flood-wait is open', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const store = memoryStore()
    const api = createRateLimitedTelegramApi(stub.api, stubLog, { ...defaultOpts(clock), floodWaitStore: store })
    stub.queueError('sendMessage', make429Error(5000))
    await api.sendMessage('100', 'a', {}).catch(() => {})
    const send = await api.sendMessage('100', 'b', {}).catch((e: unknown) => e)
    expect(send).toBeInstanceOf(TelegramFloodWaitError)
    const dl = await api.downloadFile('voice', '/tmp')
    expect(dl.path).toBe('/tmp/x')
    expect(stub.attempts('downloadFile')).toBe(1)
    // The same holds for the photo path (withFloodGuard('getFile')).
    let n = 0
    await api.withFloodGuard('getFile', async () => {
      n += 1
    })
    expect(n).toBe(1)
    // And after a restart inside the send window, downloads still work.
    const stub2 = makeStubApi(clock)
    const api2 = createRateLimitedTelegramApi(stub2.api, stubLog, { ...defaultOpts(clock), floodWaitStore: store })
    expect((await api2.downloadFile('voice', '/tmp')).path).toBe('/tmp/x')
    const send2 = await api2.sendMessage('100', 'c', {}).catch((e: unknown) => e)
    expect(send2).toBeInstanceOf(TelegramFloodWaitError)
  })

  test('a long 429 on getFile does not block sends and is not persisted', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const store = memoryStore()
    const events: RateLimitEvent[] = []
    const api = createRateLimitedTelegramApi(stub.api, stubLog, {
      ...defaultOpts(clock),
      floodWaitStore: store,
      onRateLimitEvent: (e) => events.push(e),
    })
    stub.queueError('downloadFile', make429Error(30_710))
    await api.downloadFile('f', '/tmp').catch(() => {})
    expect((await api.sendMessage('100', 'z', {})).message_id).toBe(1)
    expect(store.attempts.length).toBe(0)
    // withFloodGuard for a non-getFile method uses the send breaker: untouched.
    let n = 0
    await api.withFloodGuard('setMyCommands', async () => {
      n += 1
    })
    expect(n).toBe(1)
    // The getFile ban itself is journaled with its method.
    expect(events.map((e) => [e.kind, e.method])).toEqual([['flood_wait', 'getFile']])
    const dl = await api.downloadFile('f', '/tmp').catch((e: unknown) => e)
    expect(dl).toBeInstanceOf(TelegramFloodWaitError)
  })

  test('default clock is epoch milliseconds, so a persisted window compares across restarts', () => {
    const stub = makeStubApi(new FakeClock())
    const store = memoryStore({ until_ms: Date.now() + 60_000, method: 'sendMessage', retry_after_s: 60, seen_at: '' })
    const events: RateLimitEvent[] = []
    createRateLimitedTelegramApi(stub.api, stubLog, { floodWaitStore: store, onRateLimitEvent: (e) => events.push(e) })
    expect(events[0]?.kind).toBe('restored')
    expect((events[0] as { retry_after_s: number }).retry_after_s).toBeLessThanOrEqual(60)
  })
})

describe('createRateLimitedTelegramApi — hermes static review of 4d9ba13', () => {
  test('two in-flight requests returning different long 429s within 30 s: the longer window is saved at once and restored', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const store = memoryStore()
    const api = createRateLimitedTelegramApi(stub.api, stubLog, { ...defaultOpts(clock), floodWaitStore: store })
    stub.queueError('sendMessage', make429Error(30_710))
    stub.queueError('sendMessage', make429Error(56_483))
    await Promise.all([
      api.sendMessage('A', 'a', {}).catch(() => {}),
      api.sendMessage('B', 'b', {}).catch(() => {}),
    ])
    expect(stub.attempts('sendMessage')).toBe(2)
    expect(store.saved.map((r) => r.until_ms)).toEqual([30_710_000, 56_483_000])
    // "Restart": a fresh wrapper on the same store restores the LONGER window.
    const events: RateLimitEvent[] = []
    createRateLimitedTelegramApi(makeStubApi(clock).api, stubLog, {
      ...defaultOpts(clock),
      floodWaitStore: store,
      onRateLimitEvent: (e) => events.push(e),
    })
    expect(events[0]).toMatchObject({ kind: 'restored', retry_after_s: 56_483 })
  })

  test('a failed save lands on the retry timer even when no further request ever comes', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const store = memoryStore()
    store.failing = true
    const api = createRateLimitedTelegramApi(stub.api, stubLog, { ...defaultOpts(clock), floodWaitStore: store })
    stub.queueError('sendMessage', make429Error(30_710))
    await api.sendMessage('100', 'a', {}).catch(() => {})
    expect(store.attempts.length).toBe(1)
    store.failing = false
    // No calls at all — only time passes.
    await clock.tick(30_000)
    expect(store.saved.length).toBe(1)
    expect(store.saved[0]).toMatchObject({ until_ms: 30_710_000, method: 'sendMessage' })
    // Nothing further is scheduled once persisted.
    await clock.tick(60_000)
    expect(store.attempts.length).toBe(2)
  })

  test('a longer window learned while a failed save is pending replaces it and is written immediately', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const store = memoryStore()
    // First save fails (disk hiccup), every later one succeeds.
    const attempts: number[] = []
    const flaky: FloodWaitStore = {
      load: () => null,
      save: (r) => {
        attempts.push(r.until_ms)
        return attempts.length === 1 ? false : store.save(r)
      },
    }
    const api = createRateLimitedTelegramApi(stub.api, stubLog, { ...defaultOpts(clock), floodWaitStore: flaky })
    // Two in-flight ops; the first fails to persist, the second is longer.
    stub.queueError('sendMessage', make429Error(30_710))
    stub.queueError('sendMessage', make429Error(56_483))
    await Promise.all([
      api.sendMessage('A', 'a', {}).catch(() => {}),
      api.sendMessage('B', 'b', {}).catch(() => {}),
    ])
    expect(attempts).toEqual([30_710_000, 56_483_000])
    expect(store.saved.map((r) => r.until_ms)).toEqual([56_483_000])
  })

  test('the suppressed tail is flushed when the breaker closes, with chat_id only for a single-chat aggregate', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const events: RateLimitEvent[] = []
    const api = createRateLimitedTelegramApi(stub.api, stubLog, {
      ...defaultOpts(clock),
      onRateLimitEvent: (e) => events.push(e),
    })
    stub.queueError('sendMessage', make429Error(100))
    await api.sendMessage('A', 'a', {}).catch(() => {})
    // First suppressed reported at once (chat X), two more counted from X and Y.
    await api.sendMessage('X', '1', {}).catch(() => {})
    await api.sendMessage('X', '2', {}).catch(() => {})
    await api.sendMessage('Y', '3', {}).catch(() => {})
    // Same chat only, other method.
    await api.sendChatAction('Z', 'typing').catch(() => {})
    await api.sendChatAction('Z', 'typing').catch(() => {})
    expect(events.filter((e) => e.kind === 'suppressed')).toEqual([
      { kind: 'suppressed', method: 'sendMessage', chat_id: 'X', retry_after_s: 100, window_opens_at: new Date(100_000).toISOString(), count: 1 },
      { kind: 'suppressed', method: 'sendChatAction', chat_id: 'Z', retry_after_s: 100, window_opens_at: new Date(100_000).toISOString(), count: 1 },
    ])
    // Window expires; the next call passes and flushes the tail first.
    await clock.tick(100_000)
    const sent = await api.sendMessage('A', 'after', {})
    expect(sent.message_id).toBe(1)
    const tail = events.filter((e) => e.kind === 'suppressed').slice(2)
    expect(tail).toEqual([
      { kind: 'suppressed', method: 'sendMessage', retry_after_s: 0, window_opens_at: new Date(100_000).toISOString(), count: 2 },
      { kind: 'suppressed', method: 'sendChatAction', chat_id: 'Z', retry_after_s: 0, window_opens_at: new Date(100_000).toISOString(), count: 1 },
    ])
    // Nothing left over for a later window.
    stub.queueError('sendMessage', make429Error(100))
    await api.sendMessage('A', 'b', {}).catch(() => {})
    await api.sendMessage('X', 'c', {}).catch(() => {})
    const last = events[events.length - 1]
    expect(last).toMatchObject({ kind: 'suppressed', method: 'sendMessage', chat_id: 'X', count: 1 })
  })

  test('an aggregate is closed when the window is extended by an in-flight response, so counts do not cross windows', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const events: RateLimitEvent[] = []
    const api = createRateLimitedTelegramApi(stub.api, stubLog, {
      ...defaultOpts(clock),
      onRateLimitEvent: (e) => events.push(e),
    })
    // In-flight op started before any window exists.
    let reject!: (e: unknown) => void
    const inflight = api
      .withFloodGuard('setMyCommands', () => new Promise<void>((_, r) => { reject = r }))
      .catch(() => {})
    await flushMicrotasks()
    stub.queueError('sendMessage', make429Error(100))
    await api.sendMessage('A', 'a', {}).catch(() => {})
    await api.sendMessage('X', '1', {}).catch(() => {}) // reported
    await api.sendMessage('X', '2', {}).catch(() => {}) // counted
    // The in-flight op now returns a longer window.
    reject(make429Error(500))
    await inflight
    // Next suppressed call: old aggregate (count 1, old window) flushed, new one started.
    await api.sendMessage('X', '3', {}).catch(() => {})
    const suppressed = events.filter((e) => e.kind === 'suppressed')
    expect(suppressed).toEqual([
      { kind: 'suppressed', method: 'sendMessage', chat_id: 'X', retry_after_s: 100, window_opens_at: new Date(100_000).toISOString(), count: 1 },
      { kind: 'suppressed', method: 'sendMessage', chat_id: 'X', retry_after_s: 100, window_opens_at: new Date(100_000).toISOString(), count: 1 },
      { kind: 'suppressed', method: 'sendMessage', chat_id: 'X', retry_after_s: 500, window_opens_at: new Date(500_000).toISOString(), count: 1 },
    ])
  })
})

describe('createRateLimitedTelegramApi — independent review of 4d9ba13/5ee41fe (Opus)', () => {
  test('retry timer is never lost: a second failed save while a timer is pending, then throttle, still lands', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const store = memoryStore()
    store.failing = true
    const api = createRateLimitedTelegramApi(stub.api, stubLog, { ...defaultOpts(clock), floodWaitStore: store })
    // An op in flight BEFORE any window exists (so the breaker lets it out).
    let reject!: (e: unknown) => void
    const inflight = api
      .withFloodGuard('setMyCommands', () => new Promise<void>((_, r) => { reject = r }))
      .catch(() => {})
    await flushMicrotasks()
    // t=0: window A, save fails → timer @30 s.
    stub.queueError('sendMessage', make429Error(30_710))
    await api.sendMessage('A', 'a', {}).catch(() => {})
    expect(store.attempts.length).toBe(1)
    // t=29 s: the in-flight op returns a longer 429; its save fails too;
    // scheduleRetry is a no-op because a timer is already pending.
    await clock.tick(29_000)
    reject(make429Error(56_483))
    await inflight
    expect(store.attempts.map((r) => r.until_ms)).toEqual([30_710_000, 29_000 + 56_483_000])
    // t=30 s: timer fires, throttled (1 s since last attempt) → must reschedule.
    store.failing = false
    await clock.tick(1_000)
    expect(store.saved.length).toBe(0)
    // Ten minutes of silence, healthy disk, no calls: the LONGER record lands.
    await clock.tick(600_000)
    expect(store.saved.map((r) => r.until_ms)).toEqual([29_000 + 56_483_000])
  })

  test('a TelegramFloodWaitError thrown by a nested guarded op propagates unchanged, without a 1 s burst retry', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    stub.queueError('downloadFile', make429Error(30_710))
    await api.downloadFile('f', '/tmp').catch(() => {})
    let outerCalls = 0
    const result = await api
      .withFloodGuard('setMyCommands', async () => {
        outerCalls += 1
        return api.downloadFile('f', '/tmp')
      })
      .catch((e: unknown) => e)
    expect(result).toBeInstanceOf(TelegramFloodWaitError)
    expect(outerCalls).toBe(1)
    // The send breaker was not opened by the inner download ban.
    expect((await api.sendMessage('100', 'ok', {})).message_id).toBe(1)
  })
})

describe('createFileFloodWaitStore / createJsonlRateLimitEventSink — real files', () => {
  test('save then load round-trips; missing and corrupt files read as null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'floodwait-'))
    const path = join(dir, 'nested', 'flood-wait.json')
    const store = createFileFloodWaitStore(path, stubLog)
    expect(store.load()).toBeNull()
    const rec: FloodWaitRecord = { until_ms: 123_456, method: 'sendMessage', retry_after_s: 60, seen_at: 't' }
    store.save(rec)
    expect(existsSync(path)).toBe(true)
    expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false)
    expect(store.load()).toEqual(rec)
    writeFileSync(path, '{not json')
    expect(store.load()).toBeNull()
    writeFileSync(path, JSON.stringify({ until_ms: 'soon' }))
    expect(store.load()).toBeNull()
  })

  test('save reports success, stamps bot_id, and a record from another bot is ignored on load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'floodwait-'))
    const path = join(dir, 'flood-wait.json')
    const mine = createFileFloodWaitStore(path, stubLog, { botId: '111' })
    expect(mine.save({ until_ms: 5, method: 'sendMessage', retry_after_s: 1, seen_at: 't' })).toBe(true)
    expect(mine.load()).toMatchObject({ until_ms: 5, bot_id: '111' })
    const other = createFileFloodWaitStore(path, stubLog, { botId: '222' })
    expect(other.load()).toBeNull()
    // No bot id configured: the record is accepted whoever wrote it.
    expect(createFileFloodWaitStore(path, stubLog).load()).toMatchObject({ until_ms: 5 })
  })

  test('save returns false instead of throwing when the path cannot be written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'floodwait-'))
    const blocker = join(dir, 'not-a-dir')
    writeFileSync(blocker, 'x')
    const store = createFileFloodWaitStore(join(blocker, 'flood-wait.json'), stubLog)
    expect(store.save({ until_ms: 5, method: 'sendMessage', retry_after_s: 1, seen_at: 't' })).toBe(false)
  })

  test('sink appends one JSON line per event with ts first and creates the directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg429-'))
    const path = join(dir, 'logs', 'telegram-429.jsonl')
    const sink = createJsonlRateLimitEventSink(path, stubLog)
    sink({ kind: 'suppressed', method: 'sendMessage', chat_id: '1', retry_after_s: 5, window_opens_at: 'w', count: 1 })
    sink({ kind: 'burst_retry', method: 'sendPhoto', retry_after_s: 2, attempt: 1, wait_ms: 2000 })
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines.length).toBe(2)
    const first = JSON.parse(lines[0] as string) as Record<string, unknown>
    expect(Object.keys(first)[0]).toBe('ts')
    expect(first).toMatchObject({ kind: 'suppressed', method: 'sendMessage', chat_id: '1' })
    expect(JSON.parse(lines[1] as string)).toMatchObject({ kind: 'burst_retry', method: 'sendPhoto' })
  })

  test('a failing rotation does not blind the journal: the event is still appended', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg429-'))
    const path = join(dir, 'telegram-429.jsonl')
    writeFileSync(path, 'x'.repeat(5 * 1024 * 1024))
    // `.1` is a non-empty directory, so rename onto it fails.
    mkdirSync(`${path}.1`)
    writeFileSync(join(`${path}.1`, 'keep'), 'y')
    const warned: string[] = []
    const sink = createJsonlRateLimitEventSink(path, { ...stubLog, warn: (m) => warned.push(m) })
    sink({ kind: 'restored', method: 'sendMessage', retry_after_s: 1, window_opens_at: 'w' })
    const content = readFileSync(path, 'utf8')
    expect(content.endsWith('"window_opens_at":"w"}\n')).toBe(true)
    expect(warned).toEqual(['telegram 429 log rotation failed'])
  })

  test('sink rotates the journal once to .1 past 5 MB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg429-'))
    const path = join(dir, 'telegram-429.jsonl')
    writeFileSync(path, 'x'.repeat(5 * 1024 * 1024))
    const sink = createJsonlRateLimitEventSink(path, stubLog)
    sink({ kind: 'restored', method: 'sendMessage', retry_after_s: 1, window_opens_at: 'w' })
    expect(existsSync(`${path}.1`)).toBe(true)
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ kind: 'restored' })
  })
})
