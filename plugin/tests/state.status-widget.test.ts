// Persistent record of the tracked status card (chat id + message id).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getStatePaths, loadConfig, type StatePaths } from '../src/config.js'
import {
  clearStatusWidgetCard,
  ensureStateDirs,
  readStatusWidgetCard,
  writeStatusWidgetCard,
} from '../src/state/store.js'

const FAKE_TOKEN = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'
let stateDir: string
let paths: StatePaths

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'dashi-channel-swstate-'))
  const env = { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_STATE_DIR: stateDir }
  paths = getStatePaths(loadConfig(env), env)
  ensureStateDirs(paths)
})
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

describe('status widget card state', () => {
  test('nothing stored reads as undefined', () => {
    expect(readStatusWidgetCard(paths)).toBeUndefined()
  })

  test('write then read round-trips, file is 0600, no tmp strays', () => {
    writeStatusWidgetCard(paths, { chatId: '111111111', messageId: 321 })
    expect(readStatusWidgetCard(paths)).toEqual({ chatId: '111111111', messageId: 321 })
    const mode = statSync(join(paths.root, 'status-widget.json')).mode & 0o777
    expect(mode & 0o077).toBe(0)
    expect(readdirSync(paths.root).filter((f) => f.includes('.tmp'))).toEqual([])
  })

  test('clear removes it (and is idempotent)', () => {
    writeStatusWidgetCard(paths, { chatId: '111111111', messageId: 321 })
    clearStatusWidgetCard(paths)
    clearStatusWidgetCard(paths)
    expect(readStatusWidgetCard(paths)).toBeUndefined()
  })

  for (const junk of ['', 'not json', '[]', '{"chatId":1,"messageId":"x"}', '{"chatId":"1","messageId":-4}', '{"chatId":"1"}']) {
    test(`a corrupt file (${JSON.stringify(junk).slice(0, 30)}) reads as undefined, never throws`, () => {
      writeFileSync(join(paths.root, 'status-widget.json'), junk)
      expect(readStatusWidgetCard(paths)).toBeUndefined()
    })
  }
})
