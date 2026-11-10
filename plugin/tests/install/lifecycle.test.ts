import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../..')
const realBun = process.execPath
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'channel lifecycle ')); dirs.push(dir)
  const repo = join(dir, 'repo'); mkdirSync(repo)
  for (const name of ['scripts', 'examples', 'plugin/scripts', 'plugin/src', 'skills/doctor-dashi-plugin/scripts']) {
    cpSync(join(root, name), join(repo, name), { recursive: true })
  }
  for (const name of ['install.sh', 'update.sh']) if (existsSync(join(root, name))) cpSync(join(root, name), join(repo, name))
  mkdirSync(join(repo, 'plugin/node_modules'), { recursive: true })
  const bin = join(dir, 'bin'); mkdirSync(bin)
  const log = join(dir, 'calls'); const head = join(dir, 'head'); writeFileSync(head, 'old-commit\n')
  function command(name: string, body: string) { writeFileSync(join(bin, name), `#!/bin/bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 }) }
  command('claude', 'echo "2.1.80 (Claude Code)"')
  command('tmux', 'if [[ "${1:-}" == "-V" ]]; then echo "tmux 3.4"; elif [[ "${1:-}" == "display-message" ]]; then echo "${TEST_SESSION:-other}"; fi')
  command('uname', 'echo "${TEST_PLATFORM:-Linux}"')
  command('launchctl', 'echo "launchctl $*" >> "$TEST_LOG"')
  command('bun', `if [[ "\${1:-}" == "--version" ]]; then echo 1.3.14
elif [[ "\${1:-}" == "install" ]]; then echo 'bun install' >> "$TEST_LOG"
elif [[ "\${1:-}" == "test" ]]; then echo 'bun test' >> "$TEST_LOG"; exit "\${TEST_FAIL_TESTS:-0}"
elif [[ "\${1:-}" == *doctor.ts ]]; then echo 'doctor summary (stub)'; echo "doctor $*" >> "$TEST_LOG"
else exec '${realBun.replace(/'/g, "'\\''")}' "$@"; fi`)
  command('git', `echo "git $*" >> "$TEST_LOG"
case "\${1:-}" in
--version) echo 'git version 2.40.0';;
status) if [[ "\${TEST_DIRTY:-}" == 1 ]]; then echo ' M user-file'; fi;;
rev-parse) cat "$TEST_HEAD";;
pull) echo new-commit > "$TEST_HEAD";;
reset) echo old-commit > "$TEST_HEAD";;
esac`)
  const state = join(dir, 'state'); const workspace = join(dir, 'workspace'); mkdirSync(workspace)
  const home = join(dir, 'home'); mkdirSync(home)
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log, TEST_HEAD: head,
    TELEGRAM_BOT_TOKEN: '123456:private_TEST_secret', TELEGRAM_OWNER_ID: '987654321',
    INSTALL_AGENT: 'student', TELEGRAM_STATE_DIR: state }
  function run(script: string, args: string[] = [], overrides: Record<string, string> = {}) {
    const p = Bun.spawnSync(['bash', join(repo, script), ...args], { cwd: repo, env: { ...env, ...overrides }, stdout: 'pipe', stderr: 'pipe' })
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
  }
  const installArgs = ['--non-interactive', '--agent', 'student', '--workspace', workspace, '--state-dir', state]
  return { dir, repo, state, home, log, head, env, run, installArgs }
}
describe('clone lifecycle scripts (no network or real services)', () => {
  test('install rejects missing and malformed owner IDs before writing', () => {
    const f = fixture()
    for (const owner of ['', 'abc', '-123', '0', '1.5', '9007199254740992']) {
      const r = f.run('install.sh', f.installArgs, { TELEGRAM_OWNER_ID: owner })
      expect(r.code).not.toBe(0); expect(r.out).toContain('owner'); expect(existsSync(f.state)).toBe(false)
    }
  })
  test('install never accepts the bot token as an argv value (--bot-token removed)', () => {
    const f = fixture(); const secret = '555555:ARGV_secret_TEST'
    for (const args of [[...f.installArgs, '--bot-token', secret], [...f.installArgs, `--bot-token=${secret}`]]) {
      const r = f.run('install.sh', args, { TELEGRAM_BOT_TOKEN: '' })
      expect(r.code).not.toBe(0); expect(r.out).not.toContain(secret); expect(existsSync(f.state)).toBe(false)
    }
    const help = f.run('install.sh', ['--help'])
    expect(help.code).toBe(0); expect(help.out).not.toContain('--bot-token')
    // The same argv token must not be consumed even when --dry-run would otherwise succeed.
    const dry = f.run('install.sh', [...f.installArgs, '--dry-run', '--bot-token', secret], { TELEGRAM_BOT_TOKEN: '' })
    expect(dry.code).not.toBe(0)
  })
  test('dry run writes nothing, logs every phase and never prints token', () => {
    const f = fixture(); const r = f.run('install.sh', [...f.installArgs, '--dry-run'])
    expect(r.code).toBe(0); expect(existsSync(f.state)).toBe(false)
    for (const phase of ['bun install', 'install-hooks', 'doctor', 'systemctl enable']) expect(r.out).toContain(phase)
    expect(r.out).not.toContain(f.env.TELEGRAM_BOT_TOKEN)
    expect(existsSync(f.log) ? readFileSync(f.log, 'utf8') : '').not.toContain('bun install')
  })
  test('prerequisite version floors and exact missing-tool hint fail without writes', () => {
    const f = fixture()
    writeFileSync(join(f.dir, 'bin/claude'), '#!/bin/bash\necho "2.0.99 (Claude Code)"\n', { mode: 0o755 })
    const old = f.run('install.sh', f.installArgs)
    expect(old.code).not.toBe(0); expect(old.out).toContain('claude update'); expect(existsSync(f.state)).toBe(false)
    writeFileSync(join(f.dir, 'bin/claude'), '#!/bin/bash\necho "2.1.80 (Claude Code)"\n', { mode: 0o755 })
    writeFileSync(join(f.dir, 'bin/bun'), '#!/bin/bash\necho 1.3.8\n', { mode: 0o755 })
    const bun = f.run('install.sh', f.installArgs)
    expect(bun.code).not.toBe(0); expect(bun.out).toContain('bun upgrade'); expect(existsSync(f.state)).toBe(false)
  })
  test('macOS dry-run --start never registers a LaunchAgent', () => {
    const f = fixture(); const r = f.run('install.sh', [...f.installArgs, '--dry-run', '--start'], { TEST_PLATFORM: 'Darwin' })
    expect(r.code).toBe(0); expect(r.out).toContain('launchctl bootstrap'); expect(existsSync(f.state)).toBe(false)
    expect(existsSync(f.log) ? readFileSync(f.log, 'utf8') : '').not.toContain('launchctl')
  })
  test('install rerun preserves config/env, backs up settings/service, hooks stay unique', () => {
    const f = fixture(); const first = f.run('install.sh', f.installArgs); expect(first.code).toBe(0)
    const configPath = join(f.state, 'config.json'); const envPath = join(f.state, 'channel.env')
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')); cfg.custom = 'preserve'; writeFileSync(configPath, JSON.stringify(cfg))
    const originalEnv = readFileSync(envPath, 'utf8'); const second = f.run('install.sh', f.installArgs)
    expect(second.code).toBe(0); expect(second.out).not.toContain(f.env.TELEGRAM_BOT_TOKEN)
    expect(JSON.parse(readFileSync(configPath, 'utf8')).custom).toBe('preserve'); expect(readFileSync(envPath, 'utf8')).toBe(originalEnv)
    expect(readdirSync(f.state).some(n => n.includes('.bak.'))).toBe(true)
    const settingsDir = join(f.dir, 'workspace/.claude')
    expect(readdirSync(settingsDir).some(n => n.startsWith('settings.json.bak.'))).toBe(true)
    const settings = JSON.parse(readFileSync(join(settingsDir, 'settings.json'), 'utf8'))
    expect(settings.hooks.Stop.filter((h: {marker:string}) => h.marker === 'dashi-channel-hook')).toHaveLength(1)
    expect(readFileSync(f.log, 'utf8')).not.toContain('launchctl bootstrap')
  })
  test('update dry run has no mutation; dirty checkout is rejected with paths', () => {
    const f = fixture(); expect(f.run('install.sh', f.installArgs).code).toBe(0)
    writeFileSync(f.log, '')
    const dry = f.run('update.sh', ['--dry-run', '--state-dir', f.state]); expect(dry.code).toBe(0)
    expect(dry.out).toContain('git pull --ff-only'); expect(readFileSync(f.log, 'utf8')).not.toContain('git pull')
    const dirty = f.run('update.sh', ['--state-dir', f.state], { TEST_DIRTY: '1' })
    expect(dirty.code).not.toBe(0); expect(dirty.out).toContain('user-file'); expect(readFileSync(f.log, 'utf8')).not.toContain('git pull')
  })
  test('update rejects metadata for a different checkout before pulling', () => {
    const f = fixture(); expect(f.run('install.sh', f.installArgs).code).toBe(0)
    const path = join(f.state, 'install.json')
    const meta = JSON.parse(readFileSync(path, 'utf8')); meta.pluginDir = '/tmp/other-clone/plugin'; writeFileSync(path, JSON.stringify(meta))
    writeFileSync(f.log, '')
    const r = f.run('update.sh', ['--state-dir', f.state])
    expect(r.code).not.toBe(0); expect(readFileSync(f.log, 'utf8')).not.toContain('git pull')
  })
  test('successful update backs up the actual service and runs latest doctor', () => {
    const f = fixture(); expect(f.run('install.sh', f.installArgs).code).toBe(0)
    const r = f.run('update.sh', ['--state-dir', f.state])
    expect(r.code).toBe(0)
    expect(readdirSync(f.state).some(n => n.startsWith('channel-student.service.bak.'))).toBe(true)
    expect(readFileSync(f.log, 'utf8')).toContain('--check-latest')
    expect(readFileSync(f.log, 'utf8')).toContain(`--mcp ${join(f.state, 'channel.mcp.json')}`)
  })
  test('failed plugin tests roll back to recorded commit without restarting', () => {
    const f = fixture(); expect(f.run('install.sh', f.installArgs).code).toBe(0); writeFileSync(f.log, '')
    const r = f.run('update.sh', ['--state-dir', f.state], { TEST_FAIL_TESTS: '1' })
    expect(r.code).not.toBe(0); expect(readFileSync(f.head, 'utf8').trim()).toBe('old-commit')
    const calls = readFileSync(f.log, 'utf8'); expect(calls).toContain('git pull --ff-only'); expect(calls).toContain('git reset --hard old-commit')
    expect(calls).not.toContain('launchctl'); expect(r.out).not.toContain(f.env.TELEGRAM_BOT_TOKEN)
  })
  test('macOS restart guard detects own tmux session, external restart runs', () => {
    const f = fixture(); expect(f.run('install.sh', f.installArgs, { TEST_PLATFORM: 'Darwin' }).code).toBe(0); writeFileSync(f.log, '')
    const own = f.run('update.sh', ['--restart', '--state-dir', f.state], { TEST_PLATFORM: 'Darwin', TMUX: '/tmp/fake,1,0', TEST_SESSION: 'channel-student' })
    expect(own.code).not.toBe(0); expect(own.out).toContain('channel-student'); expect(readFileSync(f.log, 'utf8')).not.toContain('launchctl kickstart')
    const external = f.run('update.sh', ['--restart', '--state-dir', f.state], { TEST_PLATFORM: 'Darwin', TMUX: '' })
    expect(external.code).toBe(0); expect(readFileSync(f.log, 'utf8')).toContain('launchctl kickstart -k'); expect(external.out).toContain('doctor summary')
  })
})
