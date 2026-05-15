import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'fs'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { getStatePaths, loadConfig, type StatePaths } from '../src/config.js'
import {
  ensureStateDirs,
  migrateLegacyAllowlist,
  readUpdateOffset,
  writeDeadLetter,
  writeUpdateOffset,
} from '../src/state/store.js'

let stateDir: string
let paths: StatePaths

const FAKE_TOKEN = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'dashi-channel-state-'))
  const env = { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_STATE_DIR: stateDir }
  const cfg = loadConfig(env)
  paths = getStatePaths(cfg, {
    TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    TELEGRAM_STATE_DIR: stateDir,
  })
  ensureStateDirs(paths)
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

describe('ensureStateDirs', () => {
  test('creates root with 0o700', () => {
    const st = statSync(paths.root)
    // On macOS mkdirSync mode is masked by umask; check at least owner has rwx
    // and group/other are zero.
    const mode = st.mode & 0o777
    expect((mode & 0o700)).toBe(0o700)
    expect((mode & 0o077)).toBe(0)
  })

  test('creates inbox, sessionIds, dead-letter dirs', () => {
    expect(existsSync(paths.inbox)).toBe(true)
    expect(existsSync(paths.sessionIds)).toBe(true)
    expect(existsSync(paths.deadLetterUpdates)).toBe(true)
    expect(existsSync(paths.deadLetterWebhook)).toBe(true)
  })
})

describe('updateOffset', () => {
  test('readUpdateOffset returns undefined when missing', () => {
    expect(readUpdateOffset(paths)).toBeUndefined()
  })

  test('writeUpdateOffset persists across read', () => {
    writeUpdateOffset(paths, 42)
    expect(readUpdateOffset(paths)).toBe(42)
    writeUpdateOffset(paths, 12345)
    expect(readUpdateOffset(paths)).toBe(12345)
  })

  test('writeUpdateOffset is atomic — no partial-write file appears if rename fails', () => {
    // Spy on fs.renameSync to throw. The store uses tmp+rename, so a failed
    // rename should leave the target absent AND clean up the tmp file.
    const spy = spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('simulated rename failure')
    })

    try {
      expect(() => writeUpdateOffset(paths, 7)).toThrow(/simulated rename failure/)
      // Target file must not exist
      expect(existsSync(paths.updateOffset)).toBe(false)
      // No stray tmp files in root
      const stray = readdirSync(paths.root).filter((f) => f.startsWith('update-offset.tmp.'))
      expect(stray).toEqual([])
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })
})

// M4: legacy access.json → allowlist.json one-shot rename at boot.
describe('migrateLegacyAllowlist', () => {
  test('renames access.json to allowlist.json when target absent', () => {
    const legacy = join(dirname(paths.allowlist), 'access.json')
    writeFileSync(legacy, JSON.stringify({ allowed: [164795011] }))
    expect(existsSync(legacy)).toBe(true)
    expect(existsSync(paths.allowlist)).toBe(false)
    const did = migrateLegacyAllowlist(paths)
    expect(did).toBe(true)
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(paths.allowlist)).toBe(true)
    expect(JSON.parse(readFileSync(paths.allowlist, 'utf8'))).toEqual({ allowed: [164795011] })
  })

  test('is a no-op when neither file exists', () => {
    expect(migrateLegacyAllowlist(paths)).toBe(false)
  })

  test('skips migration when allowlist.json already exists', () => {
    const legacy = join(dirname(paths.allowlist), 'access.json')
    writeFileSync(legacy, '"legacy"')
    writeFileSync(paths.allowlist, '"current"')
    const did = migrateLegacyAllowlist(paths)
    expect(did).toBe(false)
    // Both files left as-is — operator decides what to do with the legacy one.
    expect(JSON.parse(readFileSync(paths.allowlist, 'utf8'))).toBe('current')
  })
})

describe('writeDeadLetter', () => {
  test('writes to correct bucket and returns full path', () => {
    const filePath = writeDeadLetter(paths, 'updates', { hello: 'world' })
    expect(filePath.startsWith(paths.deadLetterUpdates)).toBe(true)
    expect(existsSync(filePath)).toBe(true)

    const webhookPath = writeDeadLetter(paths, 'webhook', { foo: 'bar' })
    expect(webhookPath.startsWith(paths.deadLetterWebhook)).toBe(true)
  })

  test('file content has wrapper with ts/bucket/value', () => {
    const filePath = writeDeadLetter(paths, 'webhook', { kind: 'test', n: 7 })
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as { ts: string; bucket: string; value: { kind: string; n: number } }
    expect(parsed.bucket).toBe('webhook')
    expect(parsed.value).toEqual({ kind: 'test', n: 7 })
    expect(typeof parsed.ts).toBe('string')
    expect(parsed.ts.length).toBeGreaterThan(10)
  })
})
