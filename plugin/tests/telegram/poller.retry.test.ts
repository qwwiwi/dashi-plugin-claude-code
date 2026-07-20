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
import { TelegramPoller, reconnectSleepMs } from '../../src/telegram/poller.js'

const FAKE_TOKEN = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'

let stateDir: string
let paths: StatePaths
let config: AppConfig

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'agent47-channel-poller-retry-'))
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

describe('reconnectSleepMs() — exponential backoff helper (task #17)', () => {
  test('exponential growth at attempts 1..8 with rng=0 (lower jitter bound)', () => {
    const rng = (): number => 0
    expect(reconnectSleepMs(1, rng)).toBe(1_100) // 1000 + 100 min jitter
    expect(reconnectSleepMs(2, rng)).toBe(2_100)
    expect(reconnectSleepMs(3, rng)).toBe(4_100)
    expect(reconnectSleepMs(4, rng)).toBe(8_100)
    expect(reconnectSleepMs(5, rng)).toBe(16_100)
    expect(reconnectSleepMs(6, rng)).toBe(32_100)
    // attempt=7 → base 64_000, capped to 60_000 before + jitter then re-capped.
    expect(reconnectSleepMs(7, rng)).toBe(60_000)
    expect(reconnectSleepMs(8, rng)).toBe(60_000)
  })

  test('upper jitter bound saturates at the cap, never exceeds it', () => {
    const rng = (): number => 0.999
    // Within range: base + max jitter (999 rounded down)
    expect(reconnectSleepMs(1, rng)).toBe(1_000 + 999) // 1999
    expect(reconnectSleepMs(2, rng)).toBe(2_000 + 999) // 2999
    // Cap path: base reached cap, jitter added then re-capped at 60_000.
    expect(reconnectSleepMs(10, rng)).toBe(60_000)
    expect(reconnectSleepMs(100, rng)).toBe(60_000)
  })

  test('overflow safety: very large attempt values do not produce Infinity/NaN', () => {
    const rng = (): number => 0
    const v1 = reconnectSleepMs(1_000, rng)
    const v2 = reconnectSleepMs(Number.MAX_SAFE_INTEGER, rng)
    for (const v of [v1, v2]) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThan(0)
      expect(v).toBeLessThanOrEqual(60_000)
    }
  })

  test('attempt=0 or negative collapses to the base step (not zero-sleep, not NaN)', () => {
    const rng = (): number => 0
    expect(reconnectSleepMs(0, rng)).toBe(1_000 + 100)
    expect(reconnectSleepMs(-5, rng)).toBe(1_000 + 100)
  })
})

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

  test('429 without retry_after falls back to exponential reconnect backoff (task #17)', async () => {
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
    // Task #17: floodCounter=1 → reconnectSleepMs(1) = base 1000ms +
    // [100..1000)ms jitter, capped at 60_000. Was strict `=== 1000` before
    // the unification with the transient backoff path.
    const delay = sleepCalls[0]!
    expect(delay).toBeGreaterThanOrEqual(1_100)
    expect(delay).toBeLessThan(2_000)
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

  test('transient errors follow exponential reconnect 1→60s (task #17)', async () => {
    const { bot } = makeBotStub()
    const sleepCalls: number[] = []
    const transientErr = (): Error => {
      const e = new Error('ETIMEDOUT')
      ;(e as NodeJS.ErrnoException).code = 'ETIMEDOUT'
      return e
    }
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
          throw transientErr()
        },
        sleep: async (ms) => {
          sleepCalls.push(ms)
          await new Promise((r) => setTimeout(r, 0))
        },
      },
    )
    const run = poller.start()
    // Yield enough times for the loop to throw, sleep, retry, sleep, ...
    // The Promise-microtask loop without real delay produces many iterations.
    await new Promise((r) => setTimeout(r, 50))
    await poller.stop()
    await run

    expect(sleepCalls.length).toBeGreaterThanOrEqual(6)
    // Expected base sequence: 1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, ...
    // With jitter [100, 1000), each step is in [base+100, base+1000).
    const expectedBases = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000]
    for (let i = 0; i < expectedBases.length; i++) {
      const base = expectedBases[i]!
      const observed = sleepCalls[i]!
      expect(observed).toBeGreaterThanOrEqual(base + 100)
      expect(observed).toBeLessThan(base + 1_000)
    }
    // Past the 60s cap: hard-capped at exactly RECONNECT_BACKOFF_CAP_MS
    // (cap is `Math.min(base + jitter, 60_000)`; once base hits the cap,
    // adding jitter and re-capping always lands on 60_000 exactly).
    const capped = sleepCalls.slice(6)
    for (const ms of capped) {
      expect(ms).toBe(60_000)
    }
  })

  test('transient counter resets after a successful getUpdates round (task #17)', async () => {
    const { bot } = makeBotStub()
    const sleepCalls: number[] = []
    let call = 0
    const transientErr = (): Error => new Error('ECONNRESET')
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
          // Throw twice, then succeed, then throw again.
          if (call === 1 || call === 2) throw transientErr()
          if (call === 3) return []
          if (call === 4) throw transientErr()
          await new Promise((r) => setTimeout(r, 5))
          return []
        },
        sleep: async (ms) => {
          sleepCalls.push(ms)
          await new Promise((r) => setTimeout(r, 0))
        },
      },
    )
    const run = poller.start()
    await new Promise((r) => setTimeout(r, 50))
    await poller.stop()
    await run

    // We expect at least three sleeps recorded — two before success, one after.
    expect(sleepCalls.length).toBeGreaterThanOrEqual(3)
    const [d1, d2, d3] = sleepCalls
    // First failure → attempt=1, base 1000 + jitter.
    expect(d1!).toBeGreaterThanOrEqual(1_100)
    expect(d1!).toBeLessThan(2_000)
    // Second failure → attempt=2, base 2000 + jitter.
    expect(d2!).toBeGreaterThanOrEqual(2_100)
    expect(d2!).toBeLessThan(3_000)
    // After the successful round, attempt resets → first failure is back at base 1000.
    expect(d3!).toBeGreaterThanOrEqual(1_100)
    expect(d3!).toBeLessThan(2_000)
  })

  test('existing 409 fatal-after-8 still works (regression check)', async () => {
    const { bot } = makeBotStub()
    let calls = 0
    const sleepCalls: number[] = []
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
        sleep: async (ms) => {
          sleepCalls.push(ms)
        },
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
    // Task #17 regression assertion: 409 path stays LINEAR (1000*attempt,
    // cap 15s) — exponential reconnect must not apply to token-ownership
    // contention.
    expect(sleepCalls.slice(0, 7)).toEqual([1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000])
  })
})
