// #167: the update guard asks the runtime's own loadConfig under the installed
// launcher env (plugin/scripts/config-probe.ts). Update scenarios live in
// lifecycle.test.ts; this file pins the probe's console contract.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { ownerFixHint, probeInstallation, refusal } from '../../scripts/config-probe.js'

const probe = resolve(import.meta.dir, '../../scripts/config-probe.ts')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function installation(envText: string, config: unknown): { state: string, envFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'config-probe-')); dirs.push(dir)
  const state = join(dir, 'state'); const workspace = join(dir, 'ws'); mkdirSync(state); mkdirSync(workspace)
  const envFile = join(state, 'channel.env')
  writeFileSync(envFile, envText)
  writeFileSync(join(state, 'config.json'), JSON.stringify(config))
  writeFileSync(join(state, 'install.json'), JSON.stringify({ workspace, stateDir: state, envFile }))
  return { state, envFile }
}
function run(state: string, ...extra: string[]) {
  const p = Bun.spawnSync([process.execPath, probe, '--state-dir', state, ...extra], { env: { HOME: tmpdir(), PATH: process.env.PATH ?? '' }, stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
}

describe('config-probe console contract', () => {
  const token = '123456:probe_TEST_secret'
  test('a malformed owner ID is refused without echoing the value or the token', () => {
    const { state, envFile } = installation(`TELEGRAM_BOT_TOKEN=${token}\nTELEGRAM_ALLOWED_USER_IDS=777abc\n`, {})
    for (const r of [run(state), run(state, '--json')]) {
      expect(r.code).toBe(3)
      expect(r.out).not.toContain('777abc'); expect(r.out).not.toContain(token)
    }
    expect(run(state).out).toContain(ownerFixHint(join(state, 'config.json'), envFile))
  })
  test('an accepted owner prints OK with the pinned config path and no ID', () => {
    const { state } = installation(`TELEGRAM_BOT_TOKEN=${token}\nTELEGRAM_CONFIG_FILE=/elsewhere.json\n`, { allowed_user_ids: [4815162342] })
    const r = run(state)
    expect(r.code).toBe(0); expect(r.out).toContain(join(state, 'config.json'))
    expect(r.out).not.toContain('4815162342'); expect(r.out).not.toContain(token)
  })
  test('missing install.json: the check cannot run (exit 1), nothing is guessed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-probe-')); dirs.push(dir)
    const r = run(dir)
    expect(r.code).toBe(1); expect(r.out).toContain('install.json')
  })
})

describe('privilege boundary: the launcher env is sourced only by the account that owns it', () => {
  const marker = (state: string) => join(state, 'sourced.marker')
  const sourcing = (state: string) => `TELEGRAM_BOT_TOKEN=123456:probe_TEST_secret\nTELEGRAM_ALLOWED_USER_IDS=4815162342\ntouch '${marker(state)}'\n`
  test('another account (e.g. root) never executes channel.env: refused as "account", no shell ran', () => {
    const { state, envFile } = installation('', {})
    writeFileSync(envFile, sourcing(state))
    const other = (process.geteuid?.() ?? 1000) === 0 ? 1000 : 0
    const result = probeInstallation(state, other)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('account')
    expect(result.detail).toContain(state)
    expect(existsSync(marker(state))).toBe(false)
  })
  test('the refusal names the owning uid and the command to rerun as that account', () => {
    const { state, envFile } = installation('TELEGRAM_BOT_TOKEN=123456:probe_TEST_secret\nTELEGRAM_ALLOWED_USER_IDS=4815162342\n', {})
    const own = process.geteuid?.() ?? 1000
    const result = probeInstallation(state, own === 0 ? 1000 : 0)
    if (result.ok) throw new Error('expected a refusal')
    const text = refusal(result, envFile)
    expect(text).toContain(`sudo -u '#${own}' ./update.sh`)
    expect(text).toContain('Обновление остановлено'); expect(text).toContain('Update refused')
    expect(text).not.toContain('4815162342'); expect(text).not.toContain('probe_TEST_secret')
  })
  test('the owning account still runs the launcher replay (control for the marker)', () => {
    const { state, envFile } = installation('', {})
    writeFileSync(envFile, sourcing(state))
    const result = probeInstallation(state)
    expect(result.ok).toBe(true)
    expect(existsSync(marker(state))).toBe(true)
  })
})

describe('--inner is internal: IDs never reach a console', () => {
  const env = { HOME: tmpdir(), PATH: process.env.PATH ?? '', TELEGRAM_BOT_TOKEN: '123456:probe_TEST_secret', TELEGRAM_ALLOWED_USER_IDS: '4815162342', TELEGRAM_ALLOWED_CHAT_IDS: '-1007771234' }
  for (const [name, script] of [
    ['direct invocation', 'exec "$0" "$1" --inner'],
    ['fd 3 redirected to the terminal', 'exec "$0" "$1" --inner 3>&1'],
  ] as const) {
    test(`${name}: refused with a fixed message, no owner or chat ID`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'config-probe-')); dirs.push(dir)
      const p = Bun.spawnSync(['/bin/bash', '-c', script, process.execPath, probe], { cwd: dir, env: { ...env, TELEGRAM_STATE_DIR: dir }, stdout: 'pipe', stderr: 'pipe' })
      const out = p.stdout.toString() + p.stderr.toString()
      expect(out).not.toContain('4815162342'); expect(out).not.toContain('1007771234'); expect(out).not.toContain('probe_TEST_secret')
      expect(p.exitCode).toBe(2)
      expect(out).toContain('--inner is internal')
    })
  }
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
