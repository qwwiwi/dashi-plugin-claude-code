// #167: update.sh must refuse an update that would leave the channel without an
// explicit owner. The pre-update check resolves the owner the way the runtime does.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../../src/config.js'
import { ownerFixHint, resolveOwner } from '../../../scripts/owner-check.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function stateDir(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'owner-check-')); dirs.push(dir)
  if (config !== undefined) writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
  return dir
}
const read = (path: string): string | null => { try { return readFileSync(path, 'utf8') } catch { return null } }

describe('resolveOwner agrees with loadConfig on the owner requirement', () => {
  const cases: Array<{ name: string; config: unknown; env: Record<string, string> }> = [
    { name: 'no config file, no env', config: undefined, env: {} },
    { name: 'config without allowed_user_ids', config: { allowed_chat_ids: [42] }, env: {} },
    { name: 'config with empty allowed_user_ids', config: { allowed_user_ids: [] }, env: {} },
    { name: 'config with owner', config: { allowed_user_ids: [42] }, env: {} },
    { name: 'env owner, no config', config: undefined, env: { TELEGRAM_ALLOWED_USER_IDS: '42' } },
    { name: 'empty env overrides config owner', config: { allowed_user_ids: [42] }, env: { TELEGRAM_ALLOWED_USER_IDS: '' } },
    { name: 'env of separators only', config: { allowed_user_ids: [42] }, env: { TELEGRAM_ALLOWED_USER_IDS: ' , ' } },
    { name: 'env with a non-number', config: undefined, env: { TELEGRAM_ALLOWED_USER_IDS: 'abc' } },
    { name: 'config owner as string', config: { allowed_user_ids: ['42'] }, env: {} },
    { name: 'config owner negative', config: { allowed_user_ids: [-42] }, env: {} },
    { name: 'config is not JSON object', config: [42], env: {} },
  ]
  for (const { name, config, env } of cases) {
    test(name, () => {
      const dir = stateDir(config)
      let runtimeOk = true
      try { loadConfig({ TELEGRAM_BOT_TOKEN: '1:x', TELEGRAM_STATE_DIR: dir, ...env }) } catch { runtimeOk = false }
      const result = resolveOwner({ env: { TELEGRAM_STATE_DIR: dir, ...env }, home: dir, cwd: dir, read })
      expect(result.ok).toBe(runtimeOk)
      expect(result.configPath).toBe(join(dir, 'config.json'))
    })
  }

  test('TELEGRAM_CONFIG_FILE selects the config like the runtime', () => {
    const dir = stateDir({}); const custom = join(dir, 'custom.json'); writeFileSync(custom, JSON.stringify({ allowed_user_ids: [7] }))
    const result = resolveOwner({ env: { TELEGRAM_CONFIG_FILE: custom }, home: dir, cwd: dir, read })
    expect(result).toMatchObject({ ok: true, configPath: custom })
  })

  test('the owner may come from <state>/.env, which server.ts loads for unset keys', () => {
    const dir = stateDir({}); writeFileSync(join(dir, '.env'), 'TELEGRAM_ALLOWED_USER_IDS=42\n')
    expect(resolveOwner({ env: { TELEGRAM_STATE_DIR: dir }, home: dir, cwd: dir, read }).ok).toBe(true)
    // A value already in the channel env wins over the .env file (server.ts never overrides).
    expect(resolveOwner({ env: { TELEGRAM_STATE_DIR: dir, TELEGRAM_ALLOWED_USER_IDS: '' }, home: dir, cwd: dir, read }).ok).toBe(false)
  })
})

describe('ownerFixHint', () => {
  test('names the exact config path, the key, the env variable and the env file, in Russian and English', () => {
    const hint = ownerFixHint('/srv/state/config.json', '/srv/state/channel.env')
    expect(hint).toContain('"allowed_user_ids": [<your Telegram user ID>]')
    expect(hint).toContain('/srv/state/config.json')
    expect(hint).toContain('TELEGRAM_ALLOWED_USER_IDS')
    expect(hint).toContain('/srv/state/channel.env')
    expect(hint).toContain('@userinfobot')
    expect(hint).toMatch(/[а-яё]/i)
    expect(hint).toMatch(/[a-z]/i)
  })
})
