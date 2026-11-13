import { afterEach, expect, test } from 'bun:test'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const roots: string[] = []
const repo = resolve(import.meta.dir, '../../..')
const token = '123456789:TEST_private_token'
function fixture(platform = 'Linux') {
  const root = mkdtempSync(join(tmpdir(), 'channel-render-'))
  roots.push(root)
  const state = join(root, 'state with spaces')
  const env = { ...process.env, INSTALL_AGENT: 'student', INSTALL_WORKSPACE: join(root, 'workspace'), INSTALL_STATE_DIR: state,
    INSTALL_SETTINGS: join(root, 'workspace/.claude/settings.json'), INSTALL_PLATFORM: platform, INSTALL_REPO: repo,
    INSTALL_HOME: root, INSTALL_CLAUDE: '/usr/local/bin/claude', INSTALL_TMUX: '/usr/bin/tmux', INSTALL_BUN: process.execPath,
    TELEGRAM_BOT_TOKEN: token, TELEGRAM_OWNER_ID: '123456' }
  const run = () => Bun.spawnSync([process.execPath, join(repo, 'scripts/render-install.ts')], { env })
  return { root, state, env, run }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

test('renders a private owner config and a supervised Linux service without secret leaks', () => {
  const f = fixture()
  const result = f.run()
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString() + result.stderr.toString()).not.toContain(token)
  const config = JSON.parse(readFileSync(join(f.state, 'config.json'), 'utf8'))
  expect(config.allowed_user_ids).toEqual([123456])
  expect(config.allowed_chat_ids).toEqual([123456])
  expect(config.permission_relay.allowed_user_ids).toEqual([123456])
  expect(statSync(join(f.state, 'channel.env')).mode & 0o777).toBe(0o600)
  expect(readFileSync(join(f.state, 'channel.env'), 'utf8')).toContain(token)
  const wrapper = readFileSync(join(f.state, 'channel-wrapper.sh'), 'utf8')
  expect(wrapper).toContain('--mcp-config')
  expect(wrapper).toContain('--settings')
  expect(wrapper).toContain(f.env.INSTALL_WORKSPACE)
  const unit = readFileSync(join(f.state, 'channel-student.service'), 'utf8')
  expect(unit).toContain('Type=simple')
  expect(unit).toContain('Restart=on-failure')
  expect(unit).toContain('WantedBy=multi-user.target')
  expect(unit).not.toContain('Type=forking')
  for (const file of ['config.json', 'install.json', 'channel-wrapper.sh', 'channel.mcp.json', 'channel-student.service']) {
    expect(readFileSync(join(f.state, file), 'utf8')).not.toContain(token)
  }
  const mcp = JSON.parse(readFileSync(join(f.state, 'channel.mcp.json'), 'utf8'))
  expect(mcp.mcpServers['dashi-channel'].args).toEqual([join(repo, 'plugin/src/server.ts')])
})

test('preserves config/env on rerun and backs up each replaced service artifact', () => {
  const f = fixture()
  expect(f.run().exitCode).toBe(0)
  const configFile = join(f.state, 'config.json')
  const custom = JSON.parse(readFileSync(configFile, 'utf8'))
  custom.custom = 'preserve this'
  writeFileSync(configFile, JSON.stringify(custom))
  const envFile = join(f.state, 'channel.env')
  const env = readFileSync(envFile, 'utf8') + '\n# preserve comments\n'
  writeFileSync(envFile, env)
  chmodSync(envFile, 0o600)
  f.env.TELEGRAM_BOT_TOKEN = '987654:DIFFERENT'
  expect(f.run().exitCode).toBe(0)
  expect(readFileSync(configFile, 'utf8')).toBe(JSON.stringify(custom))
  expect(readFileSync(envFile, 'utf8')).toBe(env)
  for (const name of ['channel-wrapper.sh', 'channel.mcp.json', 'channel-student.service', 'install.json']) {
    expect(readdirSync(f.state).some(file => file.startsWith(name + '.bak.'))).toBe(true)
  }
})

test('rejects a missing/invalid owner before writing', () => {
  for (const owner of ['', 'abc', '0', '-12', '9007199254740993']) {
    const f = fixture()
    f.env.TELEGRAM_OWNER_ID = owner
    expect(f.run().exitCode).not.toBe(0)
    expect(existsSync(f.state)).toBe(false)
  }
})

test('refuses owner mismatch in preserved configuration before replacing artifacts', () => {
  const f = fixture()
  expect(f.run().exitCode).toBe(0)
  f.env.TELEGRAM_OWNER_ID = '999'
  expect(f.run().exitCode).not.toBe(0)
  expect(readdirSync(f.state).some(file => file.includes('.bak.'))).toBe(false)
})

test('launchd boots on login and restarts only unsuccessful wrapper exits', () => {
  const f = fixture('Darwin')
  expect(f.run().exitCode).toBe(0)
  const plist = readFileSync(join(f.root, 'Library/LaunchAgents/com.dashi-plugin.channel-student.plist'), 'utf8')
  expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
  expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/)
  expect(plist).not.toContain(token)
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await Bun.sleep(20)
  }
  throw new Error('Supervisor did not reach the expected state')
}

for (const mode of ['session loss', 'operator stop'] as const) {
  test(`foreground wrapper reports ${mode} to its supervisor`, async () => {
    const f = fixture()
    const alive = join(f.root, 'alive')
    const fakeTmux = join(f.root, 'tmux')
    const argsLog = join(f.root, 'args.json')
    writeFileSync(fakeTmux, `#!/bin/bash\nset -euo pipefail\ncase "$1" in\n has-session) test -f '${alive}' ;;\n new-session) printf '%s\\n' "$@" > '${argsLog}'; touch '${alive}' ;;\n kill-session) rm -f '${alive}' ;;\n send-keys) printf '%s\\n' "$@" >> '${argsLog}' ;;\nesac\n`, { mode: 0o700 })
    f.env.INSTALL_TMUX = fakeTmux
    expect(f.run().exitCode).toBe(0)
    const child = Bun.spawn(['/bin/bash', join(f.state, 'channel-wrapper.sh')], { stdout: 'pipe', stderr: 'pipe' })
    try {
      await waitFor(() => existsSync(alive))
      const args = readFileSync(argsLog, 'utf8')
      expect(args).toContain(f.env.INSTALL_WORKSPACE)
      expect(args).toContain('--mcp-config')
      expect(args).toContain('--settings')
      if (mode === 'session loss') rmSync(alive)
      else child.kill('SIGTERM')
      expect(await child.exited).toBe(mode === 'session loss' ? 1 : 0)
      expect(existsSync(alive)).toBe(false)
      expect(await new Response(child.stdout).text() + await new Response(child.stderr).text()).not.toContain(token)
    } finally {
      child.kill('SIGKILL')
    }
  })
}

test('Claude receives private env even when a preexisting tmux server clears client env', async () => {
  const f = fixture()
  const observed = join(f.root, 'observed-owner')
  const fakeClaude = join(f.root, 'claude')
  writeFileSync(fakeClaude, `#!/bin/bash\nprintf '%s' "\${TELEGRAM_ALLOWED_USER_IDS:-absent}" > '${observed}'\n`, { mode: 0o700 })
  const fakeTmux = join(f.root, 'tmux')
  const alive = join(f.root, 'alive')
  writeFileSync(fakeTmux, `#!/bin/bash\ncase "$1" in\n has-session) test -f '${alive}' ;;\n new-session) touch '${alive}' ;;\n kill-session) rm -f '${alive}' ;;\n send-keys) if [ "$4" = -l ]; then /usr/bin/env -i PATH=/usr/bin:/bin /bin/bash -c "$5"; fi ;;\nesac\n`, { mode: 0o700 })
  f.env.INSTALL_TMUX = fakeTmux
  f.env.INSTALL_CLAUDE = fakeClaude
  expect(f.run().exitCode).toBe(0)
  const child = Bun.spawn(['/bin/bash', join(f.state, 'channel-wrapper.sh')], { stdout: 'ignore', stderr: 'ignore' })
  try {
    await waitFor(() => existsSync(observed))
    expect(readFileSync(observed, 'utf8')).toBe('123456')
  } finally {
    child.kill('SIGTERM')
    await child.exited
  }
})

test('refuses preserved env pointing to a different effective config, state, workspace or agent', () => {
  const f = fixture()
  expect(f.run().exitCode).toBe(0)
  const file = join(f.state, 'channel.env')
  const original = readFileSync(file, 'utf8')
  for (const [key, value] of Object.entries({ TELEGRAM_CONFIG_FILE: '/tmp/foreign/config.json', TELEGRAM_STATE_DIR: '/tmp/foreign/state', TELEGRAM_WORKSPACE_ROOT: '/tmp/foreign/workspace', AGENT_ID: 'foreign' })) {
    writeFileSync(file, original.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`))
    expect(f.run().exitCode).not.toBe(0)
    expect(readdirSync(f.state).some(name => name.includes('.bak.'))).toBe(false)
  }
})

test('preserved env cannot silently fall back to a different runtime state or workspace', () => {
  for (const key of ['TELEGRAM_STATE_DIR', 'TELEGRAM_WORKSPACE_ROOT', 'AGENT_ID']) {
    const f = fixture(); expect(f.run().exitCode).toBe(0)
    const file = join(f.state, 'channel.env')
    writeFileSync(file, readFileSync(file, 'utf8').replace(new RegExp(`^${key}=.*\\n`, 'm'), ''))
    const result = f.run()
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain(key)
    expect(readdirSync(f.state).some(n => n.includes('.bak.'))).toBe(false)
  }
})

test('paths with literal shell metacharacters survive rendering, doctor, and a second run', () => {
  const f = fixture()
  f.env.INSTALL_STATE_DIR = join(f.root, 'state # $literal `literal`')
  f.env.INSTALL_WORKSPACE = join(f.root, 'workspace # $literal `literal`')
  expect(f.run().exitCode).toBe(0)
  const probe = Bun.spawnSync([process.execPath, '-e', `
    import { resolveDoctorConfig } from ${JSON.stringify(join(repo, 'skills/doctor-dashi-plugin/scripts/doctor.ts'))};
    import { readFileSync } from 'node:fs';
    const result = resolveDoctorConfig(readFileSync(${JSON.stringify(join(f.env.INSTALL_STATE_DIR, 'channel.env'))}, 'utf8'), ${JSON.stringify(f.root)}, path => readFileSync(path, 'utf8'), ${JSON.stringify(f.env.INSTALL_WORKSPACE)}, 'shell');
    console.log(JSON.stringify({ status: result.check.status, owner: result.config?.allowed_user_ids }));
  `])
  expect(probe.exitCode).toBe(0)
  const effective = JSON.parse(probe.stdout.toString())
  expect(effective.status).toBe('pass')
  expect(effective.owner).toEqual([123456])
  const again = f.run()
  expect(again.exitCode).toBe(0)
  expect(again.stdout.toString() + again.stderr.toString()).not.toContain(token)
})

// H1: systemd does not unquote WorkingDirectory=; a quoted value is "not absolute" and fatal.
const hasAnalyze = Bun.spawnSync(['sh', '-c', 'command -v systemd-analyze']).exitCode === 0
function verifyUnit(unitPath: string) {
  const p = Bun.spawnSync(['systemd-analyze', 'verify', unitPath], { env: { ...process.env, SYSTEMD_LOG_LEVEL: 'info' } })
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
}
test.skipIf(!hasAnalyze)('rendered Linux unit passes systemd-analyze verify, including a plugin dir with spaces and % \\', () => {
  for (const dirName of ['plain-repo', 'repo with spaces', 'repo%100\\x']) {
    const f = fixture()
    const fakeRepo = join(f.root, dirName)
    mkdirSync(join(fakeRepo, 'plugin'), { recursive: true })
    cpSync(join(repo, 'examples'), join(fakeRepo, 'examples'), { recursive: true })
    f.env.INSTALL_REPO = fakeRepo
    const result = f.run()
    expect(result.stderr.toString()).toBe('')
    expect(result.exitCode).toBe(0)
    const unitPath = join(f.state, 'channel-student.service')
    const unit = readFileSync(unitPath, 'utf8')
    const verdict = verifyUnit(unitPath)
    expect(verdict.out).not.toContain('not absolute')
    expect(verdict.out).not.toContain('fatal error')
    expect(verdict.code).toBe(0)
    expect(unit).not.toMatch(/^WorkingDirectory="/m)
  }
})

// N1: the wrapper must not source the env file itself. A real multiplexer server copies the client's
// environment into its global environment on first start, which would publish the bot token to every
// later session. The recording stub stands in for that server: whatever it sees at new-session is
// what the real one would store (a real-server check needs a host multiplexer, which jobs cannot start).
test('wrapper hands the multiplexer a token-free environment at new-session', async () => {
  const f = fixture()
  const seen = join(f.root, 'seen-token')
  const alive = join(f.root, 'alive')
  const fakeTmux = join(f.root, 'tmux')
  writeFileSync(fakeTmux, `#!/bin/bash\ncase "$1" in\n has-session) test -f '${alive}' ;;\n new-session) printf '%s|%s' "\${TELEGRAM_BOT_TOKEN:-absent}" "\${TELEGRAM_ALLOWED_USER_IDS:-absent}" > '${seen}'; touch '${alive}' ;;\n kill-session) rm -f '${alive}' ;;\n send-keys) : ;;\nesac\n`, { mode: 0o700 })
  f.env.INSTALL_TMUX = fakeTmux
  expect(f.run().exitCode).toBe(0)
  const clean = { ...process.env }; delete clean.TELEGRAM_BOT_TOKEN; delete clean.TELEGRAM_ALLOWED_USER_IDS
  const child = Bun.spawn(['/bin/bash', join(f.state, 'channel-wrapper.sh')], { stdout: 'ignore', stderr: 'ignore', env: clean })
  try {
    await waitFor(() => existsSync(seen))
    expect(readFileSync(seen, 'utf8')).toBe('absent|absent')
  } finally {
    child.kill('SIGTERM')
    await child.exited
  }
})

test('wrapper still refuses to start when the private env file is missing', () => {
  const f = fixture()
  expect(f.run().exitCode).toBe(0)
  rmSync(join(f.state, 'channel.env'))
  const p = Bun.spawnSync(['/bin/bash', join(f.state, 'channel-wrapper.sh')], { stdout: 'pipe', stderr: 'pipe' })
  expect(p.exitCode).toBe(78)
  expect(p.stderr.toString()).toContain('Missing private channel environment')
})

// U3: WorkingDirectory= is not unquoted and has no backslash escapes; only % is a specifier there.
test('WorkingDirectory= escapes only % and keeps backslashes literal', () => {
  const f = fixture()
  const fakeRepo = join(f.root, 'repo%1\\x y')
  mkdirSync(join(fakeRepo, 'plugin'), { recursive: true })
  cpSync(join(repo, 'examples'), join(fakeRepo, 'examples'), { recursive: true })
  f.env.INSTALL_REPO = fakeRepo
  expect(f.run().exitCode).toBe(0)
  const unit = readFileSync(join(f.state, 'channel-student.service'), 'utf8')
  const line = unit.split('\n').find(l => l.startsWith('WorkingDirectory='))
  expect(line).toBe(`WorkingDirectory=${join(fakeRepo, 'plugin').replaceAll('%', '%%')}`)
})

// The wrapper may type its own start command into the shell it has just created; after that the only
// automatic key is Enter from confirm-startup-screen.sh, and only on the dev-channels screen.
for (const screen of ['dev-channels', 'trust-folder'] as const) {
  test(`wrapper confirms by pane content, never blindly: ${screen} screen`, async () => {
    const f = fixture()
    const alive = join(f.root, 'alive')
    const keys = join(f.root, 'keys.log')
    const pane = join(f.root, 'pane.txt')
    const text = screen === 'dev-channels'
      ? 'WARNING: Loading development channels\n\n ❯ 1. I am using this for local development\n   2. Exit\n\n Enter to confirm · Esc to cancel\n'
      : 'Do you trust the files in this folder?\n\n ❯ 1. Yes, proceed\n   2. No, exit\n\n Enter to confirm · Esc to cancel\n'
    writeFileSync(pane, text)
    const fakeTmux = join(f.root, 'tmux')
    writeFileSync(fakeTmux, `#!/bin/bash\ncase "$1" in\n has-session) test -f '${alive}' ;;\n new-session) touch '${alive}' ;;\n kill-session) rm -f '${alive}' ;;\n capture-pane) if grep -qx Enter '${keys}' 2>/dev/null; then echo 'Listening for channel messages'; else cat '${pane}'; fi ;;\n send-keys) shift; printf '%s\\n' "\${!#}" >> '${keys}' ;;\nesac\n`, { mode: 0o700 })
    f.env.INSTALL_TMUX = fakeTmux
    expect(f.run().exitCode).toBe(0)
    const child = Bun.spawn(['/bin/bash', join(f.state, 'channel-wrapper.sh')], { stdout: 'ignore', stderr: 'ignore',
      env: { ...process.env, STARTUP_CONFIRM_INTERVAL: '0.05', STARTUP_CONFIRM_PRESS_PAUSE: '0.05', STARTUP_CONFIRM_TIMEOUT: '1' } })
    try {
      await waitFor(() => existsSync(keys) && readFileSync(keys, 'utf8').includes('C-m'))
      if (screen === 'dev-channels') await waitFor(() => readFileSync(keys, 'utf8').split('\n').includes('Enter'))
      await Bun.sleep(1500)
      const sent = readFileSync(keys, 'utf8').trim().split('\n')
      // First the start command typed into the fresh shell, then at most the one matched Enter.
      expect(sent[0]).toStartWith('exec ')
      expect(sent[1]).toBe('C-m')
      expect(sent.slice(2)).toEqual(screen === 'dev-channels' ? ['Enter'] : [])
    } finally {
      child.kill('SIGTERM')
      await child.exited
    }
  })
}
