// StatusManager × flood gate (PR #144 fix-loop 1).
//
// Codex saw one real request during an active retry_after=600: the
// lifecycle edits (cancel / TTL «Остановлено», supersede) were not marked
// `background`, so they bypassed the rate-limited layer's closed flood gate.
// These tests run StatusManager on top of the REAL rate-limited layer and
// assert that, once a 429 closed the gate, cancel / TTL / supersede make
// zero calls to the raw Telegram API.

import { describe, expect, test } from 'bun:test'

import type { TelegramApi } from '../../src/channel/tools.js'
import { AppConfigSchema, type AppConfig } from '../../src/config.js'
import type { Logger } from '../../src/log.js'
import { createRateLimitedTelegramApi } from '../../src/safety/rate-limited-telegram-api.js'
import { StatusManager } from '../../src/status/status-manager.js'

const silentLog: Logger = { debug() {}, info() {}, warn() {}, error() {} }

const CHAT = '164795011'
const RETRY_AFTER_S = 600

function makeConfig(ttlMs: number): AppConfig {
  return AppConfigSchema.parse({
    bot_id: 8507713167,
    allowed_user_ids: [164795011],
    allowed_chat_ids: [164795011],
    status: {
      enabled: true,
      interval_ms: 700,
      ttl_ms: ttlMs,
      delete_on_complete: true,
      suppress_typing_bubble: false,
    },
  })
}

interface FakeTimer {
  deadline: number
  cb: () => void
  fired: boolean
}

class FakeClock {
  now = 0
  timers: FakeTimer[] = []
  setTimer = (cb: () => void, ms: number): NodeJS.Timeout => {
    const t: FakeTimer = { deadline: this.now + ms, cb, fired: false }
    this.timers.push(t)
    return t as unknown as NodeJS.Timeout
  }
  clearTimer = (handle: NodeJS.Timeout): void => {
    ;(handle as unknown as FakeTimer).fired = true
  }
  async advance(ms: number): Promise<void> {
    const deadline = this.now + ms
    for (;;) {
      const due = this.timers
        .filter((t) => !t.fired && t.deadline <= deadline)
        .sort((a, b) => a.deadline - b.deadline)[0]
      if (!due) break
      this.now = due.deadline
      due.fired = true
      due.cb()
      await flush()
    }
    this.now = deadline
    await flush()
  }
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

function make429(): Error {
  const err = new Error('Too Many Requests') as Error & {
    error_code: number
    parameters: { retry_after: number }
  }
  err.error_code = 429
  err.parameters = { retry_after: RETRY_AFTER_S }
  return err
}

// Raw Telegram stub: counts EVERY call that reaches the wire.
function makeRaw(): { api: TelegramApi; calls: string[]; failNextEdit(): void } {
  const calls: string[] = []
  let failEdit = false
  let nextId = 100
  const api: TelegramApi = {
    async sendMessage() {
      calls.push('sendMessage')
      return { message_id: nextId++ }
    },
    async sendRichMessage() {
      return { fallback: true as const }
    },
    async editRichMessage() {
      return { fallback: true } as const
    },
    async editMessageText() {
      calls.push('editMessageText')
      if (failEdit) {
        failEdit = false
        throw make429()
      }
    },
    async setMessageReaction() {
      calls.push('setMessageReaction')
    },
    async sendChatAction() {
      calls.push('sendChatAction')
    },
    async sendDocument() {
      return { message_id: 0 }
    },
    async sendPhoto() {
      return { message_id: 0 }
    },
    async downloadFile() {
      return { path: '/tmp/x', size: 0 }
    },
    async deleteMessage() {
      calls.push('deleteMessage')
    },
    async answerGuestQuery() {},
  }
  return { api, calls, failNextEdit: () => (failEdit = true) }
}

// Start a status, then let the first tick edit hit a 429 → gate closed.
async function setupFloodedManager(ttlMs = 300_000): Promise<{
  mgr: StatusManager
  clock: FakeClock
  raw: ReturnType<typeof makeRaw>
}> {
  const clock = new FakeClock()
  const raw = makeRaw()
  const api = createRateLimitedTelegramApi(raw.api, silentLog, {
    now: () => clock.now,
    sleep: async () => {},
    jitterMaxMs: 0,
  })
  const mgr = new StatusManager({
    telegramApi: api,
    config: makeConfig(ttlMs),
    log: silentLog,
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  await mgr.start(CHAT, undefined)
  expect(raw.calls).toContain('sendMessage')
  raw.failNextEdit()
  await clock.advance(700)
  // The tick edit reached the wire once and got the 429.
  expect(raw.calls.filter((c) => c === 'editMessageText').length).toBe(1)
  return { mgr, clock, raw }
}

describe('StatusManager — lifecycle edits respect the closed flood gate', () => {
  test('cancel during retry_after makes 0 API calls', async () => {
    const { mgr, clock, raw } = await setupFloodedManager()
    const before = raw.calls.length
    await clock.advance(10_000)
    await mgr.cancel(CHAT, 'user')
    await flush()
    expect(raw.calls.length).toBe(before)
  })

  test('TTL expiry during retry_after makes 0 API calls', async () => {
    const { clock, raw } = await setupFloodedManager(30_000)
    const before = raw.calls.length
    // Past the TTL (30s) but well inside retry_after (600s). Ticks, chat
    // action pulses and the TTL «Остановлено» edit must all stay local.
    await clock.advance(60_000)
    expect(raw.calls.length).toBe(before)
  })

  test('supersede (start over an active status) during retry_after makes 0 API calls', async () => {
    const { mgr, clock, raw } = await setupFloodedManager()
    const before = raw.calls.length
    await clock.advance(10_000)
    // The new bubble send is skipped by the gate → start() rejects with the
    // gate's local 429 (callers treat status as best-effort).
    await mgr.start(CHAT, undefined).catch(() => undefined)
    await flush()
    expect(raw.calls.length).toBe(before)
  })

  test('after retry_after the status surface talks to Telegram again', async () => {
    // TTL well past retry_after so the entry is still alive when the gate opens.
    const { mgr, clock, raw } = await setupFloodedManager(3_600_000)
    await clock.advance(RETRY_AFTER_S * 1000)
    const before = raw.calls.length
    await mgr.cancel(CHAT, 'user')
    await flush()
    expect(raw.calls.slice(before)).toEqual(['editMessageText'])
  })
})
