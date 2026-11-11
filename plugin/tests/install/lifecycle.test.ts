import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
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
  command('getent', `[[ "$1" == passwd && "$2" == '${userInfo().username}' ]] || exit 2; printf '%s:x:%s:%s::%s:/bin/bash\\n' '${userInfo().username}' "\${TEST_TARGET_UID:-${userInfo().uid}}" '${userInfo().gid}' "$TEST_TARGET_HOME"`)
  command('runuser', 'echo "runuser $1 $2 $3" >> "$TEST_LOG"; shift 3; export TEST_AS_USER=1; exec "$@"')
  command('id', 'if [[ "${1:-}" == -u ]]; then echo "${TEST_UID:-1000}"; elif [[ "${1:-}" == -gn ]]; then echo staff; else echo student; fi')
  command('systemctl', 'echo "systemctl $*" >> "$TEST_LOG"; if [[ "$*" == "--user show-environment" && "${TEST_NO_USER_BUS:-0}" == 1 ]]; then exit 1; fi')
  command('loginctl', 'echo "${TEST_LINGER:-yes}"')
  command('sudo', 'echo "sudo $*" >> "$TEST_LOG"; exit 95')
  command('install', 'echo "install $*" >> "$TEST_LOG"; if [[ "${!#}" == /etc/systemd/system/* ]]; then args=("$@"); /usr/bin/install -m 644 "${args[$#-2]}" "$TEST_SYSTEM_UNIT"; else exec /usr/bin/install "$@"; fi')
  command('launchctl', 'echo "launchctl $*" >> "$TEST_LOG"')
  command('bun', `if [[ \"\${TEST_UID:-1000}\" == 0 && \"\${TEST_AS_USER:-0}\" != 1 ]]; then echo 'Bun attempted as root' >&2; exit 96; fi\nif [[ "\${1:-}" == "--version" ]]; then echo 1.3.14
elif [[ "\${1:-}" == "install" ]]; then echo 'bun install' >> "$TEST_LOG"
elif [[ "\${1:-}" == "test" ]]; then
  echo "bun $*" >> "$TEST_LOG"
  phase=before; [[ "$(cat "$TEST_HEAD")" != new-commit ]] || phase=after
  [[ "$#" == 1 ]] || phase=rerun
  if [[ "\${TEST_RUNNER_FAIL_PHASE:-}" == "$phase" ]]; then echo 'test runner failed to start' >&2; exit 127; fi
  failures="\${TEST_BASELINE_FAILURES:-}"
  if [[ "$phase" != before ]]; then
    failures="\${TEST_AFTER_FAILURES-\${TEST_BASELINE_FAILURES:-}}"
    [[ "\${TEST_FAIL_TESTS:-0}" != 1 ]] || failures='new regression'
  fi
  if [[ "$phase" == rerun ]]; then failures="\${TEST_RERUN_FAILURES-$failures}"; fi
  echo 'bun test v1.3.14'
  echo 'tests/mock.test.ts:'
  count=0
  while IFS= read -r name; do
    if [[ -n "$name" ]]; then echo "(fail) $name [1.00ms]"; count=$((count + 1)); fi
  done <<< "$failures"
  if [[ "\${TEST_RUNNER_TRUNCATE_PHASE:-}" == "$phase" ]]; then exit 1; fi
  echo ' 1 pass'; echo " $count fail"; echo "Ran $((count + 1)) tests across 1 file. [2.00ms]"
  [[ "$count" == 0 ]] || exit 1
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
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log, TEST_HEAD: head, TEST_SYSTEM_UNIT: join(dir, 'system-unit.service'),
    TELEGRAM_BOT_TOKEN: '123456:private_TEST_secret', TELEGRAM_OWNER_ID: '987654321',
    INSTALL_AGENT: 'student', TELEGRAM_STATE_DIR: state, TEST_TARGET_HOME: home }
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
  test('dry run writes nothing, logs every phase and never prints token', () => {
    const f = fixture(); const r = f.run('install.sh', [...f.installArgs, '--dry-run'])
    expect(r.code).toBe(0); expect(existsSync(f.state)).toBe(false)
    for (const phase of ['bun install', 'install-hooks', 'doctor', 'systemctl --user enable']) expect(r.out).toContain(phase)
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
    expect(readdirSync(join(f.home, '.config/systemd/user')).some(n => n.startsWith('channel-student.service.bak.'))).toBe(true)
    expect(readFileSync(f.log, 'utf8')).toContain('--check-latest')
    expect(readFileSync(f.log, 'utf8')).toContain(`--mcp ${join(f.state, 'channel.mcp.json')}`)
  })
  test('update completes with existing baseline failures and no new failures', () => {
    const f = fixture(); expect(f.run('install.sh', f.installArgs).code).toBe(0); writeFileSync(f.log, '')
    const failures = 'widget > fixture one\nwidget > fixture two\nsentinel > fixture one\nsentinel > fixture two'
    const r = f.run('update.sh', ['--state-dir', f.state], { TEST_BASELINE_FAILURES: failures })
    expect(r.code).toBe(0); expect(readFileSync(f.head, 'utf8').trim()).toBe('new-commit')
    expect(r.out).toContain('Baseline failures: 4'); expect(r.out).toContain('After-update failures: 4')
    expect(r.out).toContain('New failures: 0'); expect(r.out).toContain('Update validated')
    const calls = readFileSync(f.log, 'utf8')
    expect(calls.indexOf('bun test')).toBeLessThan(calls.indexOf('git pull --ff-only'))
    expect(calls.match(/bun test/g)).toHaveLength(2); expect(calls).not.toContain('git reset')
  })
  test('one new failure rolls back even when the total failure count is unchanged', () => {
    const f = fixture(); expect(f.run('install.sh', f.installArgs).code).toBe(0); writeFileSync(f.log, '')
    const r = f.run('update.sh', ['--state-dir', f.state], {
      TEST_BASELINE_FAILURES: 'old failure\nfixed failure', TEST_AFTER_FAILURES: 'old failure\nnew regression',
    })
    expect(r.code).not.toBe(0); expect(readFileSync(f.head, 'utf8').trim()).toBe('old-commit')
    expect(r.out).toContain('Baseline failures: 2'); expect(r.out).toContain('After-update failures: 2')
    expect(r.out).toContain('New failures: 1'); expect(r.out).toContain('tests/mock.test.ts > new regression')
    expect(readFileSync(f.log, 'utf8')).toContain('git reset --hard old-commit')
    expect(readFileSync(f.log, 'utf8')).not.toContain('--check-latest')
  })
  test('new failure passes on re-run and update completes after retrying only its file once', () => {
    const f = fixture(); expect(f.run('install.sh', f.installArgs).code).toBe(0); writeFileSync(f.log, '')
    const r = f.run('update.sh', ['--state-dir', f.state], {
      TEST_BASELINE_FAILURES: 'old failure', TEST_AFTER_FAILURES: 'old failure\nflaky one\nflaky two',
      TEST_RERUN_FAILURES: 'old failure',
    })
    expect(r.code).toBe(0); expect(readFileSync(f.head, 'utf8').trim()).toBe('new-commit')
    expect(r.out).toContain('tests/mock.test.ts > flaky one: flaky, passed on re-run')
    expect(r.out).toContain('tests/mock.test.ts > flaky two: flaky, passed on re-run')
    expect(r.out).toContain('Confirmed new failures: 0'); expect(r.out).toContain('Update validated')
    const calls = readFileSync(f.log, 'utf8')
    expect(calls.split('\n').filter(line => line.startsWith('bun test'))).toEqual([
      'bun test', 'bun test', 'bun test ./tests/mock.test.ts',
    ])
    expect(calls).not.toContain('git reset')
  })
  test('new failure fails again on re-run and rolls back while listing flaky and confirmed failures', () => {
    const f = fixture(); expect(f.run('install.sh', f.installArgs).code).toBe(0); writeFileSync(f.log, '')
    const r = f.run('update.sh', ['--state-dir', f.state], {
      TEST_AFTER_FAILURES: 'flaky failure\nnew regression', TEST_RERUN_FAILURES: 'new regression',
    })
    expect(r.code).not.toBe(0); expect(readFileSync(f.head, 'utf8').trim()).toBe('old-commit')
    expect(r.out).toContain('tests/mock.test.ts > flaky failure: flaky, passed on re-run')
    expect(r.out).toContain('Confirmed new failures: 1\n  tests/mock.test.ts > new regression')
    const calls = readFileSync(f.log, 'utf8')
    expect(calls.match(/bun test/g)).toHaveLength(3)
    expect(calls).toContain('git reset --hard old-commit'); expect(calls).not.toContain('--check-latest')
  })
  test('broken re-run runner or incomplete re-run report rolls back', () => {
    for (const broken of [{ TEST_RUNNER_FAIL_PHASE: 'rerun' }, { TEST_RUNNER_TRUNCATE_PHASE: 'rerun' }]) {
      const f = fixture(); expect(f.run('install.sh', f.installArgs).code).toBe(0); writeFileSync(f.log, '')
      const r = f.run('update.sh', ['--state-dir', f.state], { TEST_AFTER_FAILURES: 'new regression', ...broken })
      expect(r.code).not.toBe(0); expect(readFileSync(f.head, 'utf8').trim()).toBe('old-commit')
      expect(r.out).toContain('Cannot establish test failures')
      const calls = readFileSync(f.log, 'utf8')
      expect(calls.match(/bun test/g)).toHaveLength(3)
      expect(calls).toContain('git reset --hard old-commit'); expect(calls).not.toContain('--check-latest')
    }
  })
  test('baseline runner startup failure stops before pulling; after-update startup failure rolls back', () => {
    for (const phase of ['before', 'after']) {
      const f = fixture(); expect(f.run('install.sh', f.installArgs).code).toBe(0); writeFileSync(f.log, '')
      const r = f.run('update.sh', ['--state-dir', f.state], { TEST_RUNNER_FAIL_PHASE: phase })
      expect(r.code).not.toBe(0); expect(readFileSync(f.head, 'utf8').trim()).toBe('old-commit')
      const calls = readFileSync(f.log, 'utf8')
      if (phase === 'before') { expect(calls).not.toContain('git pull'); expect(calls).not.toContain('git reset') }
      else expect(calls).toContain('git reset --hard old-commit')
    }
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


describe('Linux service registration', () => {
  test('normal user installs and enables a user unit and --start runs it', () => {
    const f = fixture()
    const r = f.run('install.sh', [...f.installArgs, '--start'])
    expect(r.code).toBe(0)
    const service = join(f.home, '.config/systemd/user/channel-student.service')
    expect(existsSync(service)).toBe(true)
    const unit = readFileSync(service, 'utf8')
    expect(unit).not.toMatch(/^(?:User|Group)=/m)
    expect(unit).toContain('WantedBy=default.target')
    expect(JSON.parse(readFileSync(join(f.state, 'install.json'), 'utf8')).serviceFile).toBe(service)
    const calls = readFileSync(f.log, 'utf8')
    expect(calls).toContain('systemctl --user daemon-reload\nsystemctl --user enable channel-student.service\nsystemctl --user start channel-student.service')
    expect(calls).not.toMatch(/^sudo /m)
    expect(r.out).not.toContain('start the service externally')
  })

  test('root --run-as installs a non-root system unit and delegates user file creation', () => {
    const f = fixture()
    const r = f.run('install.sh', [...f.installArgs, '--start', '--run-as', userInfo().username], { TEST_UID: '0' })
    expect(r.code).toBe(0)
    expect(existsSync(f.env.TEST_SYSTEM_UNIT)).toBe(true)
    expect(readFileSync(f.env.TEST_SYSTEM_UNIT, 'utf8')).toContain('WantedBy=multi-user.target')
    expect(readFileSync(f.env.TEST_SYSTEM_UNIT, 'utf8')).toContain(`User=${userInfo().username}`)
    expect(readFileSync(f.env.TEST_SYSTEM_UNIT, 'utf8')).toContain('Group=staff')
    expect(readFileSync(f.env.TEST_SYSTEM_UNIT, 'utf8')).toContain(`HOME=${f.home}`)
    expect(statSync(join(f.state, 'channel.env')).mode & 0o777).toBe(0o600)
    for (const path of [f.state, join(f.dir, 'workspace/.claude'), join(f.dir, 'workspace/.claude/settings.json'), ...readdirSync(f.state).map(name => join(f.state, name))]) {
      expect(statSync(path).uid).toBe(userInfo().uid)
    }
    expect(readFileSync(f.log, 'utf8')).toContain(`runuser -u ${userInfo().username} --`)
    expect(JSON.parse(readFileSync(join(f.state, 'install.json'), 'utf8')).serviceFile).toBe('/etc/systemd/system/channel-student.service')
    const calls = readFileSync(f.log, 'utf8')
    expect(calls).toContain('systemctl daemon-reload\nsystemctl enable channel-student.service\nsystemctl start channel-student.service')
    expect(calls).toContain('/etc/systemd/system/channel-student.service')
    expect(calls).not.toContain('systemctl --user')
    expect(calls).not.toMatch(/^sudo /m)
  })

  test('without --start only enables; missing linger prints the single human step and logout warning', () => {
    const f = fixture()
    const r = f.run('install.sh', f.installArgs, { TEST_LINGER: 'no' })
    expect(r.code).toBe(0)
    expect(readFileSync(f.log, 'utf8')).toContain('systemctl --user enable channel-student.service')
    expect(readFileSync(f.log, 'utf8')).not.toContain('systemctl --user start')
    expect(r.out).toContain('sudo loginctl enable-linger student')
    expect(r.out).toContain('will not survive logout')
    expect(r.out.match(/sudo loginctl enable-linger/g)).toHaveLength(1)
    expect(readFileSync(f.log, 'utf8')).not.toMatch(/^sudo /m)
  })

  test('no user bus prints manual commands and exits with an explicit non-success summary', () => {
    const f = fixture()
    const r = f.run('install.sh', [...f.installArgs, '--start'], { TEST_NO_USER_BUS: '1' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('no user bus')
    expect(r.out).toContain('systemctl --user daemon-reload')
    expect(r.out).toContain('systemctl --user enable channel-student.service')
    expect(r.out).toContain('systemctl --user start channel-student.service')
    expect(r.out).toContain('INSTALL INCOMPLETE: service was not registered or started')
    const calls = readFileSync(f.log, 'utf8')
    expect(calls).not.toContain('systemctl --user enable')
    expect(calls).not.toMatch(/^sudo /m)
  })

  test('dry-run prints root and user registration/start plans without invoking service commands or copying units', () => {
    for (const uid of ['0', '1000']) {
      const f = fixture()
      const r = f.run('install.sh', [...f.installArgs, '--dry-run', '--start', ...(uid === '0' ? ['--run-as', userInfo().username] : [])], { TEST_UID: uid })
      expect(r.code).toBe(0)
      expect(r.out).toContain(uid === '0' ? '/etc/systemd/system/channel-student.service' : '.config/systemd/user/channel-student.service')
      expect(r.out).toContain(uid === '0' ? 'systemctl start channel-student.service' : 'systemctl --user start channel-student.service')
      expect(existsSync(f.state)).toBe(false)
      expect(existsSync(f.env.TEST_SYSTEM_UNIT)).toBe(false)
      expect(readFileSync(f.log, 'utf8')).not.toMatch(/^(systemctl|install|sudo) /m)
    }
  })

  test('update --restart targets the recorded user unit and hints both unit kinds correctly', () => {
    const f = fixture()
    expect(f.run('install.sh', f.installArgs).code).toBe(0)
    writeFileSync(f.log, '')
    const user = f.run('update.sh', ['--restart', '--state-dir', f.state])
    expect(user.code).toBe(0)
    expect(readFileSync(f.log, 'utf8')).toContain('systemctl --user restart channel-student.service')
    expect(user.out).toContain('systemctl --user restart channel-student.service')
    expect(user.out).not.toContain('sudo systemctl')
    const path = join(f.state, 'install.json')
    const meta = JSON.parse(readFileSync(path, 'utf8'))
    meta.serviceFile = '/etc/systemd/system/channel-student.service'
    meta.serviceKind = 'system'
    writeFileSync(path, JSON.stringify(meta))
    writeFileSync(f.log, '')
    const system = f.run('update.sh', ['--restart', '--state-dir', f.state])
    expect(system.code).toBe(0)
    expect(system.out).toContain('sudo systemctl restart channel-student.service')
    expect(readFileSync(f.log, 'utf8')).not.toMatch(/^(sudo|systemctl) /m)
    writeFileSync(f.log, '')
    const root = f.run('update.sh', ['--restart', '--state-dir', f.state], { TEST_UID: '0' })
    expect(root.code).not.toBe(0)
    expect(root.out).toContain('service user')
    expect(readFileSync(f.log, 'utf8')).not.toMatch(/git |bun |systemctl /)
  })
})

for (const platform of ['Linux', 'Darwin']) {
  test(`root ${platform} without --run-as refuses before writes and suggests both normal-user routes`, () => {
    const f = fixture()
    const r = f.run('install.sh', f.installArgs, { TEST_UID: '0', TEST_PLATFORM: platform, SUDO_USER: userInfo().username })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('normal user'); expect(r.out).toContain('create'); expect(r.out).toContain('re-run')
    expect(r.out).toContain(`--run-as ${userInfo().username}`)
    expect(existsSync(f.state)).toBe(false)
    expect(existsSync(f.log)).toBe(false)
  })
}
test('macOS root refuses even with --run-as', () => {
  const f = fixture(); const r = f.run('install.sh', [...f.installArgs, '--run-as', userInfo().username], { TEST_UID: '0', TEST_PLATFORM: 'Darwin' })
  expect(r.code).not.toBe(0); expect(r.out).toContain('normal user'); expect(existsSync(f.state)).toBe(false)
})
for (const [user, overrides] of [['root', {}], ['unknown', {}], [userInfo().username, { TEST_TARGET_UID: '0' }]] as const) {
  test(`root rejects invalid service account ${user} ${JSON.stringify(overrides)} without writes`, () => {
    const f = fixture(); const r = f.run('install.sh', [...f.installArgs, '--run-as', user], { TEST_UID: '0', ...overrides })
    expect(r.code).not.toBe(0); expect(r.out).toMatch(/non-root|unknown|Unknown/)
    expect(existsSync(f.state)).toBe(false); expect(existsSync(f.log)).toBe(false)
  })
}
test('root --run-as defaults are resolved from getent home instead of root HOME', () => {
  const f = fixture()
  const r = f.run('install.sh', ['--non-interactive', '--agent', 'student', '--run-as', userInfo().username], { TEST_UID: '0', TELEGRAM_STATE_DIR: '', TELEGRAM_WORKSPACE_ROOT: '', HOME: '/root' })
  expect(r.code).toBe(0)
  const state = join(f.home, '.claude/channels/student')
  const meta = JSON.parse(readFileSync(join(state, 'install.json'), 'utf8'))
  expect(meta.workspace).toBe(join(f.home, 'workspace/student'))
  expect(meta.settings).toBe(join(f.home, 'workspace/student/.claude/settings.json'))
  expect(readFileSync(join(state, 'channel-wrapper.sh'), 'utf8')).toContain(f.home)
})
for (const location of ['repo', 'workspace']) {
  for (const mode of [0o500, 0o300]) {
    test(`root --run-as refuses ${location} without ${mode === 0o500 ? 'write' : 'read'} access before writes and prints exact chown hint`, () => {
      const f = fixture(); const path = location === 'repo' ? f.repo : join(f.dir, 'workspace')
      chmodSync(path, mode)
      try {
        const r = f.run('install.sh', [...f.installArgs, '--run-as', userInfo().username], { TEST_UID: '0' })
        expect(r.code).not.toBe(0); expect(r.out).toContain('readable/writable')
        expect(r.out).toContain(`chown -R ${userInfo().username}:staff ${path.replaceAll(' ', '\\ ')}`)
        expect(existsSync(f.state)).toBe(false)
        const calls = readFileSync(f.log, 'utf8'); expect(calls).not.toContain('bun install'); expect(calls).not.toMatch(/^chown /m)
      } finally { chmodSync(path, 0o700) }
    })
  }
}
test('non-root cannot select another service user', () => {
  const f = fixture(); const r = f.run('install.sh', [...f.installArgs, '--run-as', 'root'])
  expect(r.code).not.toBe(0); expect(existsSync(f.state)).toBe(false)
})

test('root resolves Claude executable as the service user rather than from root PATH', () => {
  const f = fixture()
  const userClaude = join(f.dir, 'user-claude')
  writeFileSync(userClaude, '#!/bin/bash\necho "2.1.80 (Claude Code)"\n', { mode: 0o755 })
  writeFileSync(join(f.dir, 'bin/runuser'), `#!/bin/bash
shift 3
export TEST_AS_USER=1
if [[ "$*" == *'command -v claude'* ]]; then printf '%s\\n' '${userClaude}'; exit 0; fi
exec "$@"
`, { mode: 0o755 })
  const r = f.run('install.sh', [...f.installArgs, '--run-as', userInfo().username], { TEST_UID: '0' })
  expect(r.code).toBe(0)
  expect(readFileSync(join(f.state, 'channel-wrapper.sh'), 'utf8')).toContain(userClaude)
})

test('root --run-as accepts a writable checkout with immutable readable Git objects', () => {
  const f = fixture()
  const objects = join(f.repo, '.git/objects/ab'); mkdirSync(objects, { recursive: true })
  const object = join(objects, 'object'); writeFileSync(object, 'git object', { mode: 0o444 })
  const r = f.run('install.sh', [...f.installArgs, '--run-as', userInfo().username], { TEST_UID: '0' })
  expect(r.code).toBe(0)
  expect(statSync(object).mode & 0o777).toBe(0o444)
  expect(existsSync(join(f.state, 'channel.env'))).toBe(true)
})

test('service-user update backs up a system unit into state without writing its protected system directory', () => {
  const f = fixture(); expect(f.run('install.sh', [...f.installArgs, '--run-as', userInfo().username], { TEST_UID: '0' }).code).toBe(0)
  const system = join(f.dir, 'systemd/system'); mkdirSync(system, { recursive: true })
  const unit = join(system, 'channel-student.service'); cpSync(f.env.TEST_SYSTEM_UNIT, unit)
  const metadata = join(f.state, 'install.json')
  const meta = JSON.parse(readFileSync(metadata, 'utf8')); meta.serviceFile = unit; writeFileSync(metadata, JSON.stringify(meta))
  chmodSync(system, 0o555)
  try {
    const r = f.run('update.sh', ['--state-dir', f.state])
    expect(r.code).toBe(0)
    expect(readdirSync(system)).toEqual(['channel-student.service'])
    const saved = readdirSync(f.state).find(name => name.startsWith('channel-student.service.bak.'))
    expect(saved).toBeDefined()
    expect(readFileSync(join(f.state, saved!), 'utf8')).toBe(readFileSync(unit, 'utf8'))
  } finally { chmodSync(system, 0o700) }
}, 15000)

test('missing workspace ownership hint names the requested directory, not a shared ancestor', () => {
  const f = fixture(); const parent = join(f.dir, 'protected'); mkdirSync(parent)
  const workspace = join(parent, 'new-workspace')
  chmodSync(parent, 0o500)
  try {
    const r = f.run('install.sh', [...f.installArgs, '--workspace', workspace, '--run-as', userInfo().username], { TEST_UID: '0' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`chown -R ${userInfo().username}:staff ${workspace.replaceAll(' ', '\\ ')}`)
    expect(r.out).not.toContain(`chown -R ${userInfo().username}:staff ${parent.replaceAll(' ', '\\ ')}\n`)
    expect(existsSync(workspace)).toBe(false)
  } finally { chmodSync(parent, 0o700) }
})
