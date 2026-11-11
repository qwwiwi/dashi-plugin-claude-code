import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { envValue, parseEnvList, resolveDoctorConfig } from '../../../skills/doctor-dashi-plugin/scripts/doctor'

const repo = resolve(import.meta.dir, '../../..')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

for (const value of ['123456 # owner', "'123456' # owner", '"123456" # owner']) {
  test(`renderer, lifecycle and doctor agree on owner assignment ${value}`, () => {
    const home = mkdtempSync(join(tmpdir(), 'channel-env-parser-')); dirs.push(home)
    const state = join(home, 'state # private')
    const env = { ...process.env, INSTALL_AGENT: 'student', INSTALL_WORKSPACE: join(home, 'workspace'), INSTALL_STATE_DIR: state,
      INSTALL_SETTINGS: join(home, 'workspace/.claude/settings.json'), INSTALL_PLATFORM: 'Linux', INSTALL_REPO: repo,
      INSTALL_HOME: home, INSTALL_CLAUDE: '/usr/local/bin/claude', INSTALL_TMUX: '/usr/bin/tmux', INSTALL_BUN: process.execPath,
      TELEGRAM_BOT_TOKEN: '123456:TEST_private_token', TELEGRAM_OWNER_ID: '123456' }
    const render = () => Bun.spawnSync([process.execPath, join(repo, 'scripts/render-install.ts')], { env })
    expect(render().exitCode).toBe(0)
    const file = join(state, 'channel.env')
    const text = readFileSync(file, 'utf8').replace(/^TELEGRAM_ALLOWED_USER_IDS=.*$/m, `TELEGRAM_ALLOWED_USER_IDS=${value}`)
      .replace(/^TELEGRAM_ALLOWED_CHAT_IDS=.*$/m, `TELEGRAM_ALLOWED_CHAT_IDS=${value}`)
    writeFileSync(file, text)
    expect(render().exitCode).toBe(0)
    const lifecycle = Bun.spawnSync([process.execPath, join(repo, 'scripts/lifecycle-context.ts'), state])
    expect(lifecycle.exitCode).toBe(0)
    expect(lifecycle.stdout.toString().split('\n')[6]).toBe('123456')
    expect(lifecycle.stdout.toString().split('\n')[9]).toBe('123456')
    const doctor = resolveDoctorConfig(text, home, path => readFileSync(path, 'utf8'), env.INSTALL_WORKSPACE, 'shell')
    expect(doctor.check.status).toBe('pass')
    expect(doctor.config?.allowed_user_ids).toEqual([123456])
    expect(doctor.config?.allowed_chat_ids).toEqual([123456])
    expect(envValue(text, 'TELEGRAM_CONFIG_FILE')).toBe(join(state, 'config.json'))
  })
}

test('comments require whitespace and hashes inside quotes remain literal', () => {
  expect(envValue('VALUE=word#literal # comment', 'VALUE')).toBe('word#literal')
  for (const quote of ["'", '"']) {
    expect(envValue(`VALUE=${quote}word # literal${quote} # comment`, 'VALUE')).toBe('word # literal')
    expect(parseEnvList(`IDS=${quote}1,2 # literal${quote} # comment`, 'IDS')).toEqual(['1', '2 # literal'])
  }
})
