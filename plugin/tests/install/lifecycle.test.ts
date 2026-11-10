import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  const log = join(dir, 'calls'); const envlog = join(dir, 'envlog'); const leaklog = join(dir, 'leaklog'); writeFileSync(leaklog, ''); const head = join(dir, 'head'); writeFileSync(head, 'old-commit\n')
  const leakProbe = 'env | grep -vE "^(TEST_SECRET)=" | grep -F -- "${TEST_SECRET:-__no_secret__}" | cut -d= -f1 | sed "s/^/$(basename "$0") leaks /" >> "$TEST_LEAKLOG" || true'
  function command(name: string, body: string) { writeFileSync(join(bin, name), `#!/bin/bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 }) }
  writeFileSync(join(bin, 'dirname'), `#!/bin/bash\n${leakProbe}\nexec /usr/bin/dirname "$@"\n`, { mode: 0o755 })
  command('claude', leakProbe + '\necho "claude token=${TELEGRAM_BOT_TOKEN:+SET}" >> "$TEST_ENVLOG"; echo "2.1.80 (Claude Code)"')
  command('tmux', 'if [[ "${1:-}" == "-V" ]]; then echo "tmux 3.4"; elif [[ "${1:-}" == "display-message" ]]; then echo "${TEST_SESSION:-other}"; fi')
  command('uname', 'echo "${TEST_PLATFORM:-Linux}"')
  command('launchctl', 'echo "launchctl $*" >> "$TEST_LOG"')
  command('bun', `if [[ "\${1:-}" == "--version" ]]; then echo 1.3.14
elif [[ "\${1:-}" == "install" ]]; then ${leakProbe}; echo 'bun install' >> "$TEST_LOG"; echo "bun-install token=\${TELEGRAM_BOT_TOKEN:+SET}" >> "$TEST_ENVLOG"
elif [[ "\${1:-}" == "test" ]]; then echo 'bun test' >> "$TEST_LOG"; { echo 'bun-test begin'; env | grep '^TELEGRAM_' | cut -d= -f1 || true; echo 'bun-test end'; } >> "$TEST_ENVLOG"; exit "\${TEST_FAIL_TESTS:-0}"
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
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log, TEST_ENVLOG: envlog, TEST_LEAKLOG: leaklog, TEST_SECRET: '123456:private_TEST_secret', TEST_HEAD: head,
    TELEGRAM_BOT_TOKEN: '123456:private_TEST_secret', TELEGRAM_OWNER_ID: '987654321',
    INSTALL_AGENT: 'student', TELEGRAM_STATE_DIR: state }
  function run(script: string, args: string[] = [], overrides: Record<string, string> = {}) {
    const p = Bun.spawnSync(['bash', join(repo, script), ...args], { cwd: repo, env: { ...env, ...overrides }, stdout: 'pipe', stderr: 'pipe' })
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
  }
  const installArgs = ['--non-interactive', '--agent', 'student', '--workspace', workspace, '--state-dir', state]
  return { dir, repo, bin, state, home, log, envlog, leaklog, head, env, run, installArgs }
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

const envLines = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '').split('\n').filter(Boolean)
describe('token handling (N3, N8)', () => {
  test('N8: a user-exported bot token never reaches claude or bun install, only the renderer', () => {
    const f = fixture(); const r = f.run('install.sh', f.installArgs)
    expect(r.code).toBe(0)
    const lines = envLines(f.envlog)
    expect(lines).toContain('claude token='); expect(lines).toContain('bun-install token=')
    expect(lines.filter(l => l.includes('token=SET'))).toEqual([])
    // The renderer still received it (via its own call env): it is in the private file.
    expect(readFileSync(join(f.state, 'channel.env'), 'utf8')).toContain(f.env.TELEGRAM_BOT_TOKEN)
  })
  test('N8: the same holds on update (token in the environment is dropped before any tool runs)', () => {
    const f = fixture(); expect(f.run('install.sh', f.installArgs).code).toBe(0); writeFileSync(f.envlog, '')
    expect(f.run('update.sh', ['--state-dir', f.state]).code).toBe(0)
    const lines = envLines(f.envlog)
    expect(lines).toContain('claude token=')
    expect(lines.filter(l => l.includes('token=SET'))).toEqual([])
  })
  test('N3: a rerun with an existing channel.env needs no token', () => {
    const f = fixture(); expect(f.run('install.sh', f.installArgs).code).toBe(0)
    const before = readFileSync(join(f.state, 'channel.env'), 'utf8')
    const r = f.run('install.sh', f.installArgs, { TELEGRAM_BOT_TOKEN: '' })
    expect(r.code).toBe(0); expect(r.out).not.toContain('Bot token required')
    expect(r.out).not.toContain('NOT applied')
    expect(readFileSync(join(f.state, 'channel.env'), 'utf8')).toBe(before)
  })
  test('N3: a token supplied on a rerun is warned about as NOT applied, with the rotation path', () => {
    const f = fixture(); expect(f.run('install.sh', f.installArgs).code).toBe(0)
    const before = readFileSync(join(f.state, 'channel.env'), 'utf8'); const fresh = '777777:FRESH_secret_TEST'
    const r = f.run('install.sh', f.installArgs, { TELEGRAM_BOT_TOKEN: fresh })
    expect(r.code).toBe(0); expect(r.out).toContain('NOT applied'); expect(r.out).toContain(join(f.state, 'channel.env'))
    expect(r.out).not.toContain(fresh); expect(r.out).not.toContain(f.env.TELEGRAM_BOT_TOKEN)
    expect(readFileSync(join(f.state, 'channel.env'), 'utf8')).toBe(before)
  })
  test('N3: a first install still requires a valid token', () => {
    const f = fixture(); const r = f.run('install.sh', f.installArgs, { TELEGRAM_BOT_TOKEN: '' })
    expect(r.code).not.toBe(0); expect(r.out).toContain('Bot token required'); expect(existsSync(f.state)).toBe(false)
  })
})

describe('update hygiene (N5, U1)', () => {
  test('N5: update backs up only files it can change, never channel.env', () => {
    const f = fixture(); expect(f.run('install.sh', f.installArgs).code).toBe(0)
    expect(f.run('update.sh', ['--state-dir', f.state]).code).toBe(0)
    const names = readdirSync(f.state)
    expect(names.filter(n => n.startsWith('channel.env.bak'))).toEqual([])
    expect(names.some(n => n.startsWith('channel-student.service.bak.'))).toBe(true)
    for (const n of names) if (n.includes('.bak.')) expect(readFileSync(join(f.state, n), 'utf8')).not.toContain(f.env.TELEGRAM_BOT_TOKEN)
  })
  test('N5: any backup of channel.env is created mode 600 even if the source was looser', () => {
    const f = fixture(); const dir = join(f.dir, 'b'); mkdirSync(dir)
    const target = join(dir, 'channel.env'); writeFileSync(target, 'TELEGRAM_BOT_TOKEN=1:x\n', { mode: 0o644 })
    const p = Bun.spawnSync(['bash', '-c', 'source "$1"; backup "$2"', 'x', join(f.repo, 'scripts/lifecycle-common.sh'), target], { stdout: 'pipe', stderr: 'pipe' })
    expect(p.exitCode).toBe(0)
    const backups = readdirSync(dir).filter(n => n.startsWith('channel.env.bak.')); expect(backups).toHaveLength(1)
    expect(statSync(join(dir, backups[0]!)).mode & 0o777).toBe(0o600)
  })
  test('U1: bun test runs with every TELEGRAM_* variable cleared', () => {
    const f = fixture(); expect(f.run('install.sh', f.installArgs).code).toBe(0); writeFileSync(f.envlog, '')
    const r = f.run('update.sh', ['--state-dir', f.state], { TELEGRAM_WEBHOOK_URL: 'https://example.invalid/hook', TELEGRAM_EXTRA_PROBE: '1' })
    expect(r.code).toBe(0)
    const lines = envLines(f.envlog); const begin = lines.indexOf('bun-test begin'); const end = lines.indexOf('bun-test end')
    expect(begin).toBeGreaterThanOrEqual(0); expect(lines.slice(begin + 1, end)).toEqual([])
  })
})

describe('update refuses a dirty checkout and rollback never touches user files (U2, real git)', () => {
  const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  function gitIn(cwd: string, ...args: string[]): string {
    const p = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, ...identity }, stdout: 'pipe', stderr: 'pipe' })
    if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
    return p.stdout.toString().trim()
  }
  function realGit() {
    const f = fixture(); rmSync(join(f.bin, 'git'))
    writeFileSync(join(f.repo, '.gitignore'), 'plugin/node_modules\nlocal-ignored.txt\n')
    gitIn(f.repo, 'init', '-q', '-b', 'main'); gitIn(f.repo, 'add', '-A'); gitIn(f.repo, 'commit', '-q', '-m', 'base')
    const origin = join(f.dir, 'origin.git'); gitIn(f.dir, 'init', '-q', '--bare', '-b', 'main', origin)
    gitIn(f.repo, 'remote', 'add', 'origin', origin); gitIn(f.repo, 'push', '-q', '-u', 'origin', 'main')
    const base = gitIn(f.repo, 'rev-parse', 'HEAD')
    const run = (script: string, args: string[], over: Record<string, string> = {}) => f.run(script, args, { ...identity, ...over })
    expect(run('install.sh', f.installArgs).code).toBe(0)
    return { ...f, run, base, origin }
  }
  function publishUpstream(f: ReturnType<typeof realGit>): string {
    const other = join(f.dir, 'other'); gitIn(f.dir, 'clone', '-q', f.origin, other)
    writeFileSync(join(other, 'upstream.txt'), 'new\n'); gitIn(other, 'add', '-A'); gitIn(other, 'commit', '-q', '-m', 'upstream'); gitIn(other, 'push', '-q', 'origin', 'main')
    return gitIn(other, 'rev-parse', 'HEAD')
  }
  test('tracked edits and untracked files both stop the update before any pull; nothing is touched', () => {
    const f = realGit(); publishUpstream(f)
    const tracked = join(f.repo, 'examples/config.example.json'); const edited = readFileSync(tracked, 'utf8') + '\n'
    writeFileSync(tracked, edited)
    const a = f.run('update.sh', ['--state-dir', f.state])
    expect(a.code).not.toBe(0); expect(a.out).toContain('examples/config.example.json')
    expect(readFileSync(tracked, 'utf8')).toBe(edited); expect(gitIn(f.repo, 'rev-parse', 'HEAD')).toBe(f.base)
    gitIn(f.repo, 'checkout', '-q', '--', 'examples/config.example.json')
    const mine = join(f.repo, 'my-notes.txt'); writeFileSync(mine, 'keep me\n')
    const b = f.run('update.sh', ['--state-dir', f.state])
    expect(b.code).not.toBe(0); expect(b.out).toContain('my-notes.txt')
    expect(readFileSync(mine, 'utf8')).toBe('keep me\n'); expect(gitIn(f.repo, 'rev-parse', 'HEAD')).toBe(f.base)
  })
  test('failed validation resets tracked files to the recorded commit and leaves ignored user files alone', () => {
    const f = realGit(); const upstream = publishUpstream(f)
    const ignored = join(f.repo, 'local-ignored.txt'); writeFileSync(ignored, 'private\n')
    const r = f.run('update.sh', ['--state-dir', f.state], { TEST_FAIL_TESTS: '1' })
    expect(r.code).not.toBe(0); expect(r.out).toContain('Restoring recorded commit')
    expect(gitIn(f.repo, 'rev-parse', 'HEAD')).toBe(f.base); expect(gitIn(f.repo, 'rev-parse', 'HEAD')).not.toBe(upstream)
    expect(existsSync(join(f.repo, 'upstream.txt'))).toBe(false)
    expect(readFileSync(ignored, 'utf8')).toBe('private\n')
  })
  test('help documents the clean-tree guard and what rollback touches', () => {
    const f = fixture(); const r = f.run('update.sh', ['--help'])
    expect(r.code).toBe(0); expect(r.out).toContain('untracked'); expect(r.out).toContain('git reset --hard')
  })
})

describe('N8: the bot token never reaches a child process under any variable name', () => {
  const leaks = (f: ReturnType<typeof fixture>) => readFileSync(f.leaklog, 'utf8').split('\n').filter(Boolean)
  test('N8: an inherited exported TOKEN does not carry the bot token into claude or bun install', () => {
    const f = fixture(); const r = f.run('install.sh', f.installArgs, { TOKEN: 'caller-exported-placeholder' })
    expect(r.code).toBe(0); expect(leaks(f)).toEqual([])
  })
  test('N8: install runs no external command (dirname) with the token in its environment', () => {
    const f = fixture(); expect(f.run('install.sh', ['--help']).code).toBe(0)
    expect(leaks(f)).toEqual([])
  })
  test('N8: update runs no external command (dirname, claude, bun) with the token in its environment', () => {
    const f = fixture(); expect(f.run('install.sh', f.installArgs).code).toBe(0); writeFileSync(f.leaklog, '')
    expect(f.run('update.sh', ['--state-dir', f.state], { TOKEN: 'caller-exported-placeholder' }).code).toBe(0)
    expect(leaks(f)).toEqual([])
  })
})
