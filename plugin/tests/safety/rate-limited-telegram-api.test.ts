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
  createRateLimitedTelegramApi,
  type RateLimitOptions,
} from '../../src/safety/rate-limited-telegram-api.js'

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
}

function makeStubApi(clock: FakeClock): StubApi {
  const calls: SentCall[] = []
  const errorQueue: Map<SentCall['method'], Error[]> = new Map()
  const maybeThrow = (method: SentCall['method']): void => {
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
    async sendRichMessage(_chatId, _rawMarkdown, _opts) {
      // Pass-through stub; the rich path's own coverage lives in
      // tests/safety/rich-path.test.ts. Routes through the same enqueue here.
      maybeThrow('sendMessage')
      return { message_id: calls.length + 1 }
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
  }
  return {
    api,
    calls,
    queueError(method, err) {
      const list = errorQueue.get(method) ?? []
      list.push(err)
      errorQueue.set(method, list)
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
  test('retry_after over 60s is clamped to 60s', async () => {
    const clock = new FakeClock()
    const stub = makeStubApi(clock)
    const api = createRateLimitedTelegramApi(stub.api, stubLog, defaultOpts(clock))
    stub.queueError('sendMessage', make429Error(300))
    const p = api.sendMessage('100', 'hi', {})
    await flushMicrotasks()
    // Even though Telegram said 300s, we should retry after 60s.
    await clock.tick(60_000)
    await p
    expect(stub.calls.length).toBe(1)
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
