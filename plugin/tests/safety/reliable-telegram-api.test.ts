// Tests for createReliableTelegramApi — bounded retry + dead-letter +
// outbound-activity tracking (M4). A hand-rolled stub raw TelegramApi lets us
// program failures; an immediate-resolve `sleep` that RECORDS its argument
// gives deterministic retry-timing assertions with no real waits.

import { describe, expect, test } from 'bun:test'
import type {
  SendMessageOpts,
  SendRichMessageResult,
  TelegramApi,
} from '../../src/channel/tools.js'
import type { Logger } from '../../src/log.js'
import {
  classifySendError,
  createReliableTelegramApi,
  type OutboundDeadLetter,
  type ReliableOptions,
} from '../../src/safety/reliable-telegram-api.js'

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger

// ── error factories ──────────────────────────────────────────────────
function grammyError(code: number, description = 'err', retryAfter?: number): Error {
  const e = new Error(description) as Error & {
    error_code: number
    description: string
    parameters?: { retry_after?: number }
  }
  e.error_code = code
  e.description = description
  if (retryAfter !== undefined) e.parameters = { retry_after: retryAfter }
  return e
}
function networkError(): Error {
  const e = new Error('fetch failed') as Error & { name: string }
  e.name = 'HttpError'
  return e
}

// ── stub raw api ─────────────────────────────────────────────────────
interface Stub {
  api: TelegramApi
  sendMessageCalls: number
  editCalls: number
}
function makeStub(program: {
  sendMessage?: () => { message_id: number } | Error
  sendMessageSeq?: Array<{ message_id: number } | Error>
  editMessageText?: () => void | Error
  sendRichMessage?: () => SendRichMessageResult | Error
}): Stub {
  const stub: Stub = { api: null as unknown as TelegramApi, sendMessageCalls: 0, editCalls: 0 }
  const throwIf = <T>(v: T | Error): T => {
    if (v instanceof Error) throw v
    return v
  }
  stub.api = {
    async sendMessage(): Promise<{ message_id: number }> {
      const i = stub.sendMessageCalls++
      if (program.sendMessageSeq) return throwIf(program.sendMessageSeq[i] as { message_id: number } | Error)
      return throwIf(program.sendMessage?.() ?? { message_id: 1 })
    },
    async sendRichMessage(): Promise<SendRichMessageResult> {
      return throwIf(program.sendRichMessage?.() ?? { fallback: true })
    },
    async editMessageText(): Promise<void> {
      stub.editCalls++
      const r = program.editMessageText?.()
      if (r instanceof Error) throw r
    },
    async setMessageReaction(): Promise<void> {},
    async sendChatAction(): Promise<void> {},
    async sendDocument(): Promise<{ message_id: number }> {
      return { message_id: 2 }
    },
    async sendPhoto(): Promise<{ message_id: number }> {
      return { message_id: 3 }
    },
    async downloadFile() {
      return { path: '/x' }
    },
    async deleteMessage(): Promise<void> {},
    async answerGuestQuery(): Promise<void> {},
  }
  return stub
}

interface Harness {
  waits: number[]
  deadLetters: OutboundDeadLetter[]
  outbound: Array<{ chatId: string; at: number }>
  opts: ReliableOptions
}
function harness(extra: Partial<ReliableOptions> = {}): Harness {
  const h: Harness = { waits: [], deadLetters: [], outbound: [], opts: {} }
  h.opts = {
    now: () => 1000,
    sleep: (ms: number) => {
      h.waits.push(ms)
      return Promise.resolve()
    },
    deadLetter: (r) => h.deadLetters.push(r),
    recordOutbound: (chatId, at) => h.outbound.push({ chatId, at }),
    ...extra,
  }
  return h
}

const OPTS: SendMessageOpts = {}

describe('classifySendError', () => {
  test('429 → rate_limited with clamped retry_after', () => {
    expect(classifySendError(grammyError(429, 'x', 5), 30_000)).toEqual({
      kind: 'rate_limited',
      retryAfterMs: 5000,
    })
    // cap
    expect(classifySendError(grammyError(429, 'x', 999), 30_000)).toEqual({
      kind: 'rate_limited',
      retryAfterMs: 30_000,
    })
  })
  test('5xx → transient, 4xx → permanent, network → transient, plain → permanent', () => {
    expect(classifySendError(grammyError(503), 30_000).kind).toBe('transient')
    expect(classifySendError(grammyError(400, 'bad entities'), 30_000).kind).toBe('permanent')
    expect(classifySendError(grammyError(403), 30_000).kind).toBe('permanent')
    expect(classifySendError(networkError(), 30_000).kind).toBe('transient')
    expect(classifySendError(new Error('sendRichMessage returned no message_id'), 30_000).kind).toBe(
      'permanent',
    )
  })
})

describe('createReliableTelegramApi retry matrix', () => {
  test('success on first try — no retry, outbound recorded, no dead-letter', async () => {
    const stub = makeStub({ sendMessage: () => ({ message_id: 42 }) })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    const res = await api.sendMessage('100', 'hi', OPTS)
    expect(res.message_id).toBe(42)
    expect(stub.sendMessageCalls).toBe(1)
    expect(h.waits).toEqual([])
    expect(h.deadLetters).toEqual([])
    expect(h.outbound).toEqual([{ chatId: '100', at: 1000 }])
  })

  test('transient then success — retried with 1s backoff, then recorded', async () => {
    const stub = makeStub({ sendMessageSeq: [networkError(), { message_id: 7 }] })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    const res = await api.sendMessage('100', 'hi', OPTS)
    expect(res.message_id).toBe(7)
    expect(stub.sendMessageCalls).toBe(2)
    expect(h.waits).toEqual([1000])
    expect(h.deadLetters).toEqual([])
    expect(h.outbound.length).toBe(1)
  })

  test('transient exhaustion — 3 attempts, backoffs 1s/5s, dead-letter, throws, no outbound', async () => {
    const stub = makeStub({ sendMessage: () => grammyError(502) })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await expect(api.sendMessage('100', 'body', OPTS)).rejects.toThrow()
    expect(stub.sendMessageCalls).toBe(3) // 1 + 2 retries
    expect(h.waits).toEqual([1000, 5000])
    expect(h.deadLetters.length).toBe(1)
    const dl = h.deadLetters[0] as OutboundDeadLetter
    expect(dl.method).toBe('sendMessage')
    expect(dl.chat_id).toBe('100')
    expect(dl.attempts).toBe(3)
    expect(dl.error_class).toBe('transient')
    expect(dl.payload_sha256.length).toBe(16)
    expect(dl.payload_bytes).toBe(4) // "body"
    expect(h.outbound).toEqual([]) // nothing shipped
  })

  test('429 retry honours retry_after when larger than backoff', async () => {
    const stub = makeStub({ sendMessageSeq: [grammyError(429, 'slow', 9), { message_id: 1 }] })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await api.sendMessage('100', 'hi', OPTS)
    expect(h.waits).toEqual([9000]) // max(1000 backoff, 9000 retry_after)
  })

  test('non-transient 4xx — no retry, no dead-letter, throws', async () => {
    const stub = makeStub({ sendMessage: () => grammyError(400, "can't parse entities") })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await expect(api.sendMessage('100', 'hi', OPTS)).rejects.toThrow()
    expect(stub.sendMessageCalls).toBe(1)
    expect(h.waits).toEqual([])
    expect(h.deadLetters).toEqual([])
    expect(h.outbound).toEqual([])
  })
})

describe('outbound recording rules', () => {
  test('editMessageText is retried but NOT recorded as outbound', async () => {
    const stub = makeStub({ editMessageText: () => grammyError(503) })
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await expect(api.editMessageText('100', 5, 'x', {})).rejects.toThrow()
    expect(stub.editCalls).toBe(3)
    expect(h.deadLetters.length).toBe(1)
    expect(h.deadLetters[0]?.method).toBe('editMessageText')
    expect(h.outbound).toEqual([]) // edits never stamp the heartbeat clock
  })

  test('sendRichMessage fallback does NOT record; real send does', async () => {
    const fallbackStub = makeStub({ sendRichMessage: () => ({ fallback: true }) })
    const h1 = harness()
    const api1 = createReliableTelegramApi(fallbackStub.api, silentLog, h1.opts)
    const r1 = await api1.sendRichMessage('100', 'md', {})
    expect(r1).toEqual({ fallback: true })
    expect(h1.outbound).toEqual([])

    const realStub = makeStub({ sendRichMessage: () => ({ message_id: 9 }) })
    const h2 = harness()
    const api2 = createReliableTelegramApi(realStub.api, silentLog, h2.opts)
    await api2.sendRichMessage('100', 'md', {})
    expect(h2.outbound).toEqual([{ chatId: '100', at: 1000 }])
  })

  test('pass-through methods are not retried', async () => {
    let reactionCalls = 0
    const stub = makeStub({})
    stub.api.setMessageReaction = async (): Promise<void> => {
      reactionCalls++
      throw grammyError(503)
    }
    const h = harness()
    const api = createReliableTelegramApi(stub.api, silentLog, h.opts)
    await expect(api.setMessageReaction('100', 1, '👍')).rejects.toThrow()
    expect(reactionCalls).toBe(1) // no retry wrapper on reactions
    expect(h.deadLetters).toEqual([])
  })
})
