// status_widget config block: off by default, private chats only, clear errors.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { loadConfig } from '../src/config.js'

const FAKE_TOKEN = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'
let stateDir: string

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'dashi-channel-sw-'))
})
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

function load(block: unknown): ReturnType<typeof loadConfig> {
  const file = join(stateDir, 'config.json')
  writeFileSync(file, JSON.stringify({ status_widget: block }))
  return loadConfig({ TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_STATE_DIR: stateDir, TELEGRAM_CONFIG_FILE: file })
}

describe('status_widget config', () => {
  test('absent block: the feature is off', () => {
    const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_STATE_DIR: stateDir })
    expect(cfg.status_widget?.enabled ?? false).toBe(false)
  })

  test('defaults: disabled, interval 60 s, timeout 5000 ms', () => {
    const cfg = load({})
    expect(cfg.status_widget?.enabled).toBe(false)
    expect(cfg.status_widget?.interval_sec).toBe(60)
    expect(cfg.status_widget?.timeout_ms).toBe(5000)
  })

  test('a complete enabled block loads; a numeric chat id becomes a string', () => {
    const cfg = load({ enabled: true, chat_id: 111111111, command: ['state-cmd', '--x'] })
    expect(cfg.status_widget?.chat_id).toBe('111111111')
    expect(cfg.status_widget?.command).toEqual(['state-cmd', '--x'])
  })

  test('interval under 15 s is refused', () => {
    expect(() => load({ enabled: true, chat_id: '111111111', command: ['c'], interval_sec: 14 })).toThrow(/interval_sec/)
  })

  test('enabled without chat_id or command is refused with a clear message', () => {
    expect(() => load({ enabled: true, command: ['c'] })).toThrow(/status_widget\.chat_id/)
    expect(() => load({ enabled: true, chat_id: '111111111' })).toThrow(/status_widget\.command/)
    expect(() => load({ enabled: true, chat_id: '111111111', command: [] })).toThrow(/status_widget\.command/)
  })

  for (const bad of ['-100222222222', -5, 'abc', '1.5', 0, '']) {
    test(`chat_id ${JSON.stringify(bad)} (not a private chat) is refused at load`, () => {
      expect(() => load({ enabled: true, chat_id: bad, command: ['c'] })).toThrow(/private chat/)
    })
  }

  test('a group id is refused even when the block is disabled', () => {
    expect(() => load({ enabled: false, chat_id: '-100222222222' })).toThrow(/private chat/)
  })

  test('command must be an array of strings (no shell string)', () => {
    expect(() => load({ enabled: true, chat_id: '111111111', command: 'state-cmd --x' })).toThrow()
  })
})
