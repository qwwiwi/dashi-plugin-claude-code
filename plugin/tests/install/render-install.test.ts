import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
    writeFileSync(fakeTmux, `#!/bin/bash\nset -euo pipefail\ncase "$1" in\n has-session) test -f '${alive}' ;;\n new-session) printf '%s\\n' "$@" > '${argsLog}'; touch '${alive}' ;;\n kill-session) rm -f '${alive}' ;;\n send-keys) : ;;\nesac\n`, { mode: 0o700 })
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
  writeFileSync(fakeTmux, `#!/bin/bash\ncase "$1" in\n has-session) test -f '${alive}' ;;\n new-session) /usr/bin/env -i PATH=/usr/bin:/bin /bin/bash -c "\${!#}"; touch '${alive}' ;;\n kill-session) rm -f '${alive}' ;;\n send-keys) : ;;\nesac\n`, { mode: 0o700 })
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


test('systemd WorkingDirectory is unquoted, preserves spaces and escapes specifiers; ExecStart stays quoted', () => {
  const f = fixture()
  const checkout = join(f.root, 'checkout with spaces %h')
  symlinkSync(repo, checkout, 'dir')
  f.env.INSTALL_REPO = checkout
  expect(f.run().exitCode).toBe(0)
  const unit = readFileSync(join(f.state, 'channel-student.service'), 'utf8')
  expect(unit.split('\n').find(line => line.startsWith('WorkingDirectory='))).toBe(`WorkingDirectory=${checkout.replaceAll('%', '%%')}/plugin`)
  expect(unit).toContain(`ExecStart="${f.state}/channel-wrapper.sh"`)
})

for (const suffix of ['back\\slash', 'control\tcharacter']) {
  test(`rejects unsupported systemd directory characters before writing: ${JSON.stringify(suffix)}`, () => {
    const f = fixture()
    const checkout = join(f.root, suffix)
    symlinkSync(repo, checkout, 'dir')
    f.env.INSTALL_REPO = checkout
    const result = f.run()
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('systemd WorkingDirectory')
    expect(existsSync(f.state)).toBe(false)
  })
}

for (const platform of ['Linux', 'Darwin']) {
  test(`renderer refuses direct root ${platform} invocation before creating artifacts`, () => {
    const f = fixture(platform)
    const result = Bun.spawnSync([process.execPath, '-e', `
      process.getuid = () => 0;
      await import(${JSON.stringify(join(repo, 'scripts/render-install.ts'))});
    `], { env: f.env })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('normal user')
    expect(existsSync(f.state)).toBe(false)
  })
}
