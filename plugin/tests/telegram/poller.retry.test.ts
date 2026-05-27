// T7 tests: Telegram 429 retry_after handling (bug B in TASK-7).
//
// Before the fix, GrammyError(429) fell through to the generic "transient"
// path with a linear 1s..15s backoff. That ignores Telegram's explicit
// retry_after hint and risks immediate hammering after a flood-control
// trigger. The new code routes 429 through a dedicated `flood` branch that
// sleeps retry_after * 1000 ms + 100..500ms jitter, capped at 600s.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { GrammyError } from 'grammy'
import type { Update } from 'grammy/types'

import { getStatePaths, loadConfig, type AppConfig, type StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import { ensureStateDirs } from '../../src/state/store.js'
import { TelegramPoller } from '../../src/telegram/poller.js'

const FAKE_TOKEN = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'

let stateDir: string
let paths: StatePaths
let config: AppConfig

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'dashi-channel-poller-retry-'))
  const env = { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_STATE_DIR: stateDir }
  config = loadConfig(env)
  paths = getStatePaths(config, {
    TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    TELEGRAM_STATE_DIR: stateDir,
  })
  ensureStateDirs(paths)
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

function makeBotStub(): { bot: any } {
  const bot = {
    isInited: () => true,
    botInfo: { id: config.bot_id, username: 'canary_bot', is_bot: true, first_name: 'C' },
    init: async () => undefined,
    api: { getUpdates: async () => [] as Update[] },
    handleUpdate: async () => undefined,
    stop: async () => undefined,
  }
  return { bot }
}

function flood(retryAfter: number | undefined): GrammyError {
  const params: Record<string, unknown> = {}
  if (retryAfter !== undefined) params.retry_after = retryAfter
  return new GrammyError(
    'Too Many Requests',
    {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry later',
      parameters: params as any,
    },
    'getUpdates',
    {},
  )
}

describe('TelegramPoller 429 handling (TASK-7 bug B)', () => {
  test('429 with retry_after=10 sleeps ~10s + jitter (100..500ms), then retries', async () => {
    const { bot } = makeBotStub()
    const sleepCalls: number[] = []
    let call = 0
    const poller = new TelegramPoller(
      {
        bot,
        config,
        statePaths: paths,
        log: createLogger('test'),
        onUpdate: async () => undefined,
      },
      {
        getUpdates: async () => {
          call++
          if (call === 1) throw flood(10)
          // Subsequent rounds: yield + return []. Yield prevents the test
          // loop from starving the event queue while we wait to call stop().
          await new Promise((r) => setTimeout(r, 5))
          return []
        },
        sleep: async (ms) => {
          sleepCalls.push(ms)
          // Yield a macrotask so stop()'s setTimeout has a chance to fire
          // even when getUpdates always throws — otherwise the retry loop
          // starves the event queue.
          await new Promise((r) => setTimeout(r, 0))
        },
      },
    )
    const run = poller.start()
    // Give the loop time to: 1) throw 429, 2) call sleepFn, 3) re-poll, 4) succeed.
    // Real wait is unnecessary since sleep is mocked — just yield a few ticks.
    await new Promise((r) => setTimeout(r, 30))
    await poller.stop()
    await run
    // First (and only flood) sleep recorded.
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1)
    const delay = sleepCalls[0]!
    // 10s = 10_000ms; jitter 100..500ms inclusive → expected range [10_100, 10_500).
    expect(delay).toBeGreaterThanOrEqual(10_100)
    expect(delay).toBeLessThan(10_500)
  })

  test('429 without retry_after falls back to linear backoff (no infinite/wrong sleep)', async () => {
    const { bot } = makeBotStub()
    const sleepCalls: number[] = []
    let call = 0
    const poller = new TelegramPoller(
      {
        bot,
        config,
        statePaths: paths,
        log: createLogger('test'),
        onUpdate: async () => undefined,
      },
      {
        getUpdates: async () => {
          call++
          if (call === 1) throw flood(undefined)
          await new Promise((r) => setTimeout(r, 5))
          return []
        },
        sleep: async (ms) => {
          sleepCalls.push(ms)
          // Yield a macrotask so stop()'s setTimeout has a chance to fire
          // even when getUpdates always throws — otherwise the retry loop
          // starves the event queue.
          await new Promise((r) => setTimeout(r, 0))
        },
      },
    )
    const run = poller.start()
    await new Promise((r) => setTimeout(r, 30))
    await poller.stop()
    await run
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1)
    // Fallback: floodCounter starts at 1, so 1000*1 = 1000 ms, < BACKOFF_CAP_MS.
    const delay = sleepCalls[0]!
    expect(delay).toBe(1000)
  })

  test('429 retry_after caps at 600s even if Telegram asks for more', async () => {
    const { bot } = makeBotStub()
    const sleepCalls: number[] = []
    let call = 0
    const poller = new TelegramPoller(
      {
        bot,
        config,
        statePaths: paths,
        log: createLogger('test'),
        onUpdate: async () => undefined,
      },
      {
        getUpdates: async () => {
          call++
          if (call === 1) throw flood(3600) // 1h hint — must be capped.
          await new Promise((r) => setTimeout(r, 5))
          return []
        },
        sleep: async (ms) => {
          sleepCalls.push(ms)
          // Yield a macrotask so stop()'s setTimeout has a chance to fire
          // even when getUpdates always throws — otherwise the retry loop
          // starves the event queue.
          await new Promise((r) => setTimeout(r, 0))
        },
      },
    )
    const run = poller.start()
    await new Promise((r) => setTimeout(r, 30))
    await poller.stop()
    await run
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1)
    // 600_000 ms cap.
    expect(sleepCalls[0]!).toBe(600_000)
  })

  test('429 does NOT count toward MAX_409_ATTEMPTS (additive, not a 409 substitute)', async () => {
    const { bot } = makeBotStub()
    const sleepCalls: number[] = []
    let calls = 0
    const poller = new TelegramPoller(
      {
        bot,
        config,
        statePaths: paths,
        log: createLogger('test'),
        onUpdate: async () => undefined,
      },
      {
        // Always throw 429 — would have tripped MAX_409_ATTEMPTS in old code
        // if 429 was bucketed under conflict. New code must keep polling.
        getUpdates: async () => {
          calls++
          throw flood(0)
        },
        sleep: async (ms) => {
          sleepCalls.push(ms)
          // Yield a macrotask so stop()'s setTimeout has a chance to fire
          // even when getUpdates always throws — otherwise the retry loop
          // starves the event queue.
          await new Promise((r) => setTimeout(r, 0))
        },
      },
    )
    const run = poller.start()
    // Let it loop several times.
    await new Promise((r) => setTimeout(r, 50))
    await poller.stop()
    await run
    // Many 429s observed, none escalated to PollerFatalError.
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  test('existing 409 fatal-after-8 still works (regression check)', async () => {
    const { bot } = makeBotStub()
    let calls = 0
    const poller = new TelegramPoller(
      {
        bot,
        config,
        statePaths: paths,
        log: createLogger('test'),
        onUpdate: async () => undefined,
      },
      {
        getUpdates: async () => {
          calls++
          throw new GrammyError(
            'Conflict',
            { ok: false, error_code: 409, description: 'Conflict: another consumer' },
            'getUpdates',
            {},
          )
        },
        sleep: async () => undefined,
      },
    )
    let caught: unknown
    try {
      await poller.start()
    } catch (e) {
      caught = e
    }
    expect((caught as Error).name).toBe('PollerFatalError')
    expect(calls).toBeGreaterThanOrEqual(8)
  })
})
