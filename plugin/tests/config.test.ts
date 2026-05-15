import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadConfig, redactToken } from '../src/config.js'

let stateDir: string

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'dashi-channel-config-'))
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

const FAKE_TOKEN = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    TELEGRAM_STATE_DIR: stateDir,
    ...overrides,
  }
}

describe('loadConfig', () => {
  test('loads default config when no file and no env overrides except token', () => {
    const cfg = loadConfig(env())
    expect(cfg.bot_id).toBe(8507713167)
    expect(cfg.allowed_user_ids).toEqual([164795011])
    expect(cfg.dm_only).toBe(true)
    expect(cfg.status.interval_ms).toBe(700)
    expect(cfg.album.flush_ms).toBe(2000)
    expect(cfg.voice.provider).toBe('groq')
    expect(cfg.webhook.enabled).toBe(false)
    expect(cfg.permission_relay.bash_only_proof).toBe(true)
  })

  test('parses CSV TELEGRAM_ALLOWED_USER_IDS into number array', () => {
    const cfg = loadConfig(env({ TELEGRAM_ALLOWED_USER_IDS: '111, 222 ,333' }))
    expect(cfg.allowed_user_ids).toEqual([111, 222, 333])
  })

  test('env overrides win over config.json', () => {
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      bot_id: 11111,
      allowed_user_ids: [999],
      status: { interval_ms: 100 },
      album: { flush_ms: 500 },
    }))
    const cfg = loadConfig(env({
      TELEGRAM_EXPECTED_BOT_ID: '22222',
      TELEGRAM_ALLOWED_USER_IDS: '888',
      TELEGRAM_STATUS_INTERVAL_MS: '900',
      TELEGRAM_ALBUM_FLUSH_MS: '1500',
    }))
    expect(cfg.bot_id).toBe(22222)
    expect(cfg.allowed_user_ids).toEqual([888])
    expect(cfg.status.interval_ms).toBe(900)
    expect(cfg.album.flush_ms).toBe(1500)
  })

  test('rejects config with empty allowed_user_ids array', () => {
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      allowed_user_ids: [],
    }))
    expect(() => loadConfig(env())).toThrow(/allowed_user_ids|too_small|at least 1/i)
  })

  test('coerces string PORT env to number', () => {
    const cfg = loadConfig(env({ TELEGRAM_WEBHOOK_PORT: '9090', TELEGRAM_WEBHOOK_HOST: '0.0.0.0' }))
    expect(cfg.webhook.port).toBe(9090)
    expect(typeof cfg.webhook.port).toBe('number')
    expect(cfg.webhook.host).toBe('0.0.0.0')
  })

  test('redactToken replaces bot token shapes', () => {
    const msg = `error connecting with TELEGRAM_BOT_TOKEN=${FAKE_TOKEN} oops`
    const out = redactToken(msg)
    expect(out).not.toContain(FAKE_TOKEN)
    expect(out).toContain('<redacted>')
  })

  test('loadConfig throws Zod error without leaking token value', () => {
    // Use a config file that fails validation (negative port) to force a Zod throw
    // after env parsing has already accepted the token.
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      webhook: { port: -5 },
    }))
    let caught: unknown
    try {
      loadConfig(env())
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
    const message = caught instanceof Error ? caught.message : String(caught)
    expect(message).not.toContain(FAKE_TOKEN)
  })

  test('loadConfig reads config.json values when no env override', () => {
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      bot_id: 77777777,
      allowed_user_ids: [42, 43],
      workspace_root: '/tmp/ws',
    }))
    const cfg = loadConfig(env())
    expect(cfg.bot_id).toBe(77777777)
    expect(cfg.allowed_user_ids).toEqual([42, 43])
    expect(cfg.workspace_root).toBe('/tmp/ws')
  })
})
