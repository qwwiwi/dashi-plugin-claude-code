// Persisted status card record: EMPTY / TRACKED / UNCERTAIN state machine
// storage. Corrupt or unreadable state is reported, never read as empty.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getStatePaths, loadConfig, type StatePaths } from '../src/config.js'
import * as store from '../src/state/store.js'

const FAKE_TOKEN = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'
let stateDir: string
let paths: StatePaths

interface Api {
  ensureStateDirs: (p: StatePaths) => void
  readStatusWidgetRecord: (p: StatePaths) => { kind: string; record?: unknown; error?: string }
  writeStatusWidgetRecord: (p: StatePaths, r: unknown) => void
  clearStatusWidgetRecord: (p: StatePaths) => void
}
const api = store as unknown as Api

const FILE = (): string => join(paths.root, 'status-widget.json')

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'dashi-channel-swrec-'))
  const env = { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_ALLOWED_USER_IDS: '164795011', TELEGRAM_STATE_DIR: stateDir }
  paths = getStatePaths(loadConfig(env), env)
  api.ensureStateDirs(paths)
})
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

const TRACKED = { version: 1, chatId: '111111111', messageId: 321, pending: null }
const PENDING = { version: 1, chatId: '111111111', messageId: 321, pending: { attemptId: 'a-1', startedAt: 1_800_000_000_000 } }

describe('status widget record state', () => {
  test('a missing file is EMPTY', () => {
    expect(api.readStatusWidgetRecord(paths)).toEqual({ kind: 'empty' })
  })

  test('write then read round-trips TRACKED and UNCERTAIN; 0600; no tmp strays', () => {
    api.writeStatusWidgetRecord(paths, TRACKED)
    expect(api.readStatusWidgetRecord(paths)).toEqual({ kind: 'record', record: TRACKED })
    api.writeStatusWidgetRecord(paths, PENDING)
    expect(api.readStatusWidgetRecord(paths)).toEqual({ kind: 'record', record: PENDING })
    expect(statSync(FILE()).mode & 0o077).toBe(0)
    expect(readdirSync(paths.root).filter((f) => f.includes('.tmp'))).toEqual([])
  })

  test('a legacy record (chat id + message id only) loads as TRACKED', () => {
    writeFileSync(FILE(), JSON.stringify({ chatId: '111111111', messageId: 321 }))
    expect(api.readStatusWidgetRecord(paths)).toEqual({ kind: 'record', record: TRACKED })
  })

  test('an empty record (no message, no pending) round-trips', () => {
    const empty = { version: 1, chatId: '111111111', messageId: null, pending: null }
    api.writeStatusWidgetRecord(paths, empty)
    expect(api.readStatusWidgetRecord(paths)).toEqual({ kind: 'record', record: empty })
  })

  const junk = [
    '',
    'not json',
    '[]',
    'null',
    '{"chatId":1,"messageId":"x"}',
    '{"chatId":"1","messageId":-4}',
    '{"chatId":"1"}',
    '{"version":1,"chatId":"1","messageId":5,"pending":{"attemptId":"","startedAt":1}}',
    '{"version":1,"chatId":"1","messageId":5,"pending":{"attemptId":"a","startedAt":"x"}}',
    '{"version":2,"chatId":"1","messageId":5,"pending":null}',
  ]
  for (const text of junk) {
    test(`corrupt content (${JSON.stringify(text).slice(0, 40)}) is unreadable, never empty, never throws`, () => {
      writeFileSync(FILE(), text)
      const res = api.readStatusWidgetRecord(paths)
      expect(res.kind).toBe('unreadable')
    })
  }

  test('a path that cannot be read as a file is unreadable', () => {
    mkdirSync(FILE())
    expect(api.readStatusWidgetRecord(paths).kind).toBe('unreadable')
  })

  test('a failing write throws and leaves the previous file intact', () => {
    api.writeStatusWidgetRecord(paths, TRACKED)
    const before = readFileSync(FILE(), 'utf8')
    const broken = { ...paths, root: join(paths.root, 'no', 'such', 'dir') }
    expect(() => api.writeStatusWidgetRecord(broken, PENDING)).toThrow()
    expect(readFileSync(FILE(), 'utf8')).toBe(before)
  })

  test('clear is idempotent for a missing file and throws for a real failure', () => {
    api.clearStatusWidgetRecord(paths)
    api.writeStatusWidgetRecord(paths, TRACKED)
    api.clearStatusWidgetRecord(paths)
    expect(api.readStatusWidgetRecord(paths)).toEqual({ kind: 'empty' })
    mkdirSync(FILE())
    expect(() => api.clearStatusWidgetRecord(paths)).toThrow()
  })
})
