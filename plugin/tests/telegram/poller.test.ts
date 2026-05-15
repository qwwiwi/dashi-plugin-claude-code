// T13 tests: durable poller offset, dead-letter, and one-consumer lock.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { GrammyError } from 'grammy'
import type { Update } from 'grammy/types'

import { getStatePaths, loadConfig, type AppConfig, type StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import { ensureStateDirs, readUpdateOffset } from '../../src/state/store.js'
import { PollerFatalError, TelegramPoller, tokenLock } from '../../src/telegram/poller.js'

const FAKE_TOKEN = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'

let stateDir: string
let paths: StatePaths
let config: AppConfig

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'dashi-channel-poller-'))
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

// ─────────────────────────────────────────────────────────────────────
// Minimal stub for `Bot` — poller only touches bot.api.getUpdates,
// bot.handleUpdate, bot.init, bot.isInited, bot.botInfo. We pass a
// custom getUpdates via the overrides hook so the API call never goes
// out to the network.
// ─────────────────────────────────────────────────────────────────────

function makeBotStub(): { bot: any; calls: { handle: Update[] } } {
  const calls = { handle: [] as Update[] }
  const bot = {
    isInited: () => true,
    botInfo: { id: config.bot_id, username: 'canary_bot', is_bot: true, first_name: 'C' },
    init: async () => undefined,
    api: { getUpdates: async () => [] as Update[] },
    handleUpdate: async (u: Update) => {
      calls.handle.push(u)
    },
    stop: async () => undefined,
  }
  return { bot, calls }
}

function makeUpdate(id: number, text = 'hello'): Update {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 164795011, type: 'private', first_name: 'D' },
      from: { id: 164795011, is_bot: false, first_name: 'D' },
      text,
    },
  } as unknown as Update
}

// ─────────────────────────────────────────────────────────────────────
// tokenLock
// ─────────────────────────────────────────────────────────────────────

describe('tokenLock', () => {
  test('acquire writes pid file when none exists', () => {
    expect(existsSync(paths.pid)).toBe(false)
    const ok = tokenLock.acquire(paths)
    expect(ok).toBe(true)
    expect(existsSync(paths.pid)).toBe(true)
    const written = Number.parseInt(readFileSync(paths.pid, 'utf8').trim(), 10)
    expect(written).toBe(process.pid)
  })

  test('acquire returns false when pid file holds a live foreign process', () => {
    // Spawn a child that sleeps long enough for us to test against its pid.
    // Use process.execPath so we don't depend on `bun` being in $PATH.
    const proc = Bun.spawn({
      cmd: [process.execPath, '-e', 'await new Promise(r=>setTimeout(r,30000))'],
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    try {
      // Write the live pid into bot.pid manually.
      writeFileSync(paths.pid, String(proc.pid), { mode: 0o600 })
      // Liveness probe should detect it.
      const ok = tokenLock.acquire(paths)
      expect(ok).toBe(false)
      // File untouched — still the foreign pid.
      const after = Number.parseInt(readFileSync(paths.pid, 'utf8').trim(), 10)
      expect(after).toBe(proc.pid)
    } finally {
      proc.kill()
    }
  })

  test('acquire replaces stale pid file (process.kill returns ESRCH)', () => {
    // A pid that is almost certainly dead. 999999 is past most default
    // PID ranges on macOS/Linux test runners — process.kill will throw.
    writeFileSync(paths.pid, '999999', { mode: 0o600 })
    const ok = tokenLock.acquire(paths)
    expect(ok).toBe(true)
    const written = Number.parseInt(readFileSync(paths.pid, 'utf8').trim(), 10)
    expect(written).toBe(process.pid)
  })

  test('acquire treats own pid as not-foreign and overwrites', () => {
    writeFileSync(paths.pid, String(process.pid), { mode: 0o600 })
    const ok = tokenLock.acquire(paths)
    expect(ok).toBe(true)
  })

  test('release removes pid file when we own it', () => {
    tokenLock.acquire(paths)
    expect(existsSync(paths.pid)).toBe(true)
    tokenLock.release(paths)
    expect(existsSync(paths.pid)).toBe(false)
  })

  test('release leaves a foreign pid file alone', () => {
    writeFileSync(paths.pid, '999998', { mode: 0o600 })
    tokenLock.release(paths)
    expect(existsSync(paths.pid)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// pollOnce + offset behavior
// ─────────────────────────────────────────────────────────────────────

describe('TelegramPoller.pollOnce', () => {
  test('reads stored offset and passes it to getUpdates', async () => {
    writeFileSync(paths.updateOffset, '42', { mode: 0o600 })
    const { bot } = makeBotStub()
    let observed: { offset?: number } | undefined
    const poller = new TelegramPoller(
      {
        bot,
        config,
        statePaths: paths,
        log: createLogger('test'),
        onUpdate: async () => undefined,
      },
      {
        getUpdates: async (params) => {
          observed = { ...(params.offset !== undefined ? { offset: params.offset } : {}) }
          return []
        },
      },
    )
    const result = await poller.pollOnce()
    expect(observed?.offset).toBe(42)
    expect(result.handled).toBe(0)
    expect(result.errors).toBe(0)
    expect(result.offsetAfter).toBe(42)
  })

  test('advances offset after successful handle', async () => {
    const { bot, calls } = makeBotStub()
    const poller = new TelegramPoller(
      {
        bot,
        config,
        statePaths: paths,
        log: createLogger('test'),
        onUpdate: async (u) => {
          await bot.handleUpdate(u)
        },
      },
      {
        getUpdates: async () => [makeUpdate(100), makeUpdate(101)],
      },
    )
    const result = await poller.pollOnce()
    expect(result.handled).toBe(2)
    expect(result.errors).toBe(0)
    expect(result.offsetAfter).toBe(102)
    expect(readUpdateOffset(paths)).toBe(102)
    expect(calls.handle.map((u) => u.update_id)).toEqual([100, 101])
  })

  test('writes dead-letter when onUpdate throws and still advances offset', async () => {
    const { bot } = makeBotStub()
    const poller = new TelegramPoller(
      {
        bot,
        config,
        statePaths: paths,
        log: createLogger('test'),
        onUpdate: async (u) => {
          if (u.update_id === 201) throw new Error('boom')
        },
      },
      {
        getUpdates: async () => [makeUpdate(200), makeUpdate(201), makeUpdate(202)],
      },
    )
    const result = await poller.pollOnce()
    expect(result.handled).toBe(2)
    expect(result.errors).toBe(1)
    expect(result.offsetAfter).toBe(203)
    expect(readUpdateOffset(paths)).toBe(203)

    const dlFiles = readdirSync(paths.deadLetterUpdates)
    expect(dlFiles.length).toBe(1)
    const body = JSON.parse(readFileSync(join(paths.deadLetterUpdates, dlFiles[0]!), 'utf8'))
    expect(body.bucket).toBe('updates')
    expect(body.value.error).toMatch(/boom/)
    expect(body.value.update.update_id).toBe(201)
  })

  test('surfaces 409 to caller without crashing', async () => {
    const { bot } = makeBotStub()
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
          // Construct a GrammyError mimicking a 409 Conflict.
          throw new GrammyError(
            'Conflict: terminated by other getUpdates request',
            { ok: false, error_code: 409, description: 'Conflict: …' },
            'getUpdates',
            {},
          )
        },
      },
    )
    await expect(poller.pollOnce()).rejects.toBeInstanceOf(GrammyError)
  })

  test('poller.stop() prevents new iterations', async () => {
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
          // Wait so we have time to call stop() between iterations.
          await new Promise((r) => setTimeout(r, 50))
          return []
        },
      },
    )
    const runPromise = poller.start()
    // Let the loop spin at least once.
    await new Promise((r) => setTimeout(r, 80))
    await poller.stop()
    await runPromise
    const callsAtStop = calls
    // After stop, no new iterations should run.
    await new Promise((r) => setTimeout(r, 100))
    expect(calls).toBe(callsAtStop)
  })

  test('start() rejects when bot_id does not match config', async () => {
    const { bot } = makeBotStub()
    bot.botInfo = { ...bot.botInfo, id: 9999 }
    const poller = new TelegramPoller(
      {
        bot,
        config,
        statePaths: paths,
        log: createLogger('test'),
        onUpdate: async () => undefined,
      },
      {
        getUpdates: async () => [],
      },
    )
    await expect(poller.start()).rejects.toThrow(/bot_id mismatch/)
  })

  // M1: fatal 409 / 401 must throw, not return — server.ts shutdown wrapper
  // catches the throw and calls shutdown() so the MCP server doesn't stay
  // alive without an active Telegram consumer.
  test('start() throws PollerFatalError after MAX_409_ATTEMPTS persistent 409s', async () => {
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
            'Conflict: terminated by other getUpdates request',
            { ok: false, error_code: 409, description: 'Conflict: another consumer' },
            'getUpdates',
            {},
          )
        },
        // Zero-delay sleep — we don't want to pay 1+2+…+7s of real backoff.
        sleep: async () => undefined,
      },
    )
    let caught: unknown
    try {
      await poller.start()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PollerFatalError)
    expect((caught as PollerFatalError).kind).toBe('conflict')
    expect((caught as PollerFatalError).attempts).toBeGreaterThanOrEqual(8)
    expect(calls).toBeGreaterThanOrEqual(8)
  })

  test('start() throws PollerFatalError after MAX_401_ATTEMPTS persistent 401s', async () => {
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
            'Unauthorized',
            { ok: false, error_code: 401, description: 'Unauthorized: token revoked' },
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
    expect(caught).toBeInstanceOf(PollerFatalError)
    expect((caught as PollerFatalError).kind).toBe('unauthorized')
    expect((caught as PollerFatalError).attempts).toBeGreaterThanOrEqual(3)
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  // M2: Zod validation. Malformed updates go to dead-letter; offset advances
  // past the bad update_id (or, when missing entirely, the next poll moves on).
  test('pollOnce dead-letters an update missing update_id, advancing only valid ones', async () => {
    const { bot } = makeBotStub()
    const bad = { message: { text: 'no update_id here' } } as unknown as Update
    const good = makeUpdate(500)
    const poller = new TelegramPoller(
      {
        bot,
        config,
        statePaths: paths,
        log: createLogger('test'),
        onUpdate: async () => undefined,
      },
      {
        getUpdates: async () => [bad, good],
      },
    )
    const result = await poller.pollOnce()
    expect(result.errors).toBe(1)
    expect(result.handled).toBe(1)
    expect(result.offsetAfter).toBe(501)
    // Dead-letter contains the bad update with a clear schema error.
    const dl = readdirSync(paths.deadLetterUpdates)
    expect(dl.length).toBe(1)
    const body = JSON.parse(readFileSync(join(paths.deadLetterUpdates, dl[0]!), 'utf8'))
    expect(body.value.error).toMatch(/invalid update schema/i)
  })

  test('pollOnce dead-letters an update with non-integer update_id (offset not poisoned)', async () => {
    const { bot } = makeBotStub()
    const bad = { update_id: 'not-a-number', message: { text: 'x' } } as unknown as Update
    const poller = new TelegramPoller(
      {
        bot,
        config,
        statePaths: paths,
        log: createLogger('test'),
        onUpdate: async () => undefined,
      },
      {
        getUpdates: async () => [bad],
      },
    )
    const result = await poller.pollOnce()
    expect(result.errors).toBe(1)
    expect(result.handled).toBe(0)
    // No usable update_id → offset unchanged. Next getUpdates round moves on.
    expect(result.offsetAfter).toBeUndefined()
    const dl = readdirSync(paths.deadLetterUpdates)
    expect(dl.length).toBe(1)
  })

  test('uses no offset on first getUpdates when none persisted', async () => {
    const { bot } = makeBotStub()
    let observed: { offset?: number } = {}
    const poller = new TelegramPoller(
      {
        bot,
        config,
        statePaths: paths,
        log: createLogger('test'),
        onUpdate: async () => undefined,
      },
      {
        getUpdates: async (params) => {
          observed = { ...(params.offset !== undefined ? { offset: params.offset } : {}) }
          return []
        },
      },
    )
    await poller.pollOnce()
    expect(observed.offset).toBeUndefined()
  })
})
