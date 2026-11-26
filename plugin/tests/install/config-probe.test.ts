// #167: the update guard asks the runtime's own loadConfig under the installed
// launcher env (plugin/scripts/config-probe.ts). Update scenarios live in
// lifecycle.test.ts; this file pins the probe's console contract.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { ownerFixHint } from '../../scripts/config-probe.js'

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
