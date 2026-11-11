#!/usr/bin/env bun
// Render installation artifacts without starting a process or invoking a service.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { parseLiteralEnv } from './env-parser'

function required(key: string): string {
  const value = process.env[key]
  if (!value || /[\r\n\0]/.test(value)) throw new Error(`Missing or invalid ${key}`)
  return value
}
function absolute(key: string): string {
  const value = required(key)
  if (!isAbsolute(value)) throw new Error(`${key} must be absolute`)
  return value
}
function shell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
function xml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') }
function systemd(value: string): string { return value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"') }
function envLiteral(value: string): string {
  // A literal valid both when sourced by Bash and read by doctor's dotenv parser.
  if (value.includes("'")) throw new Error('Environment paths cannot contain a single quote')
  return `'${value}'`
}
function assignments(text: string): Map<string, string> { return parseLiteralEnv(text, true) }
function render(template: string, values: Record<string, string>): string {
  let result = template
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`'<${key}>'`, () => value).replaceAll(`<${key}>`, () => value)
  }
  return result
}

try {
  const agent = required('INSTALL_AGENT')
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(agent)) throw new Error('Invalid agent name')
  const ownerText = required('TELEGRAM_OWNER_ID')
  const owner = Number(ownerText)
  if (!/^[1-9]\d*$/.test(ownerText) || !Number.isSafeInteger(owner)) throw new Error('TELEGRAM_OWNER_ID must be a positive numeric Telegram user ID')
  const workspace = absolute('INSTALL_WORKSPACE')
  const stateDir = absolute('INSTALL_STATE_DIR')
  const settings = absolute('INSTALL_SETTINGS')
  const repo = absolute('INSTALL_REPO')
  const home = absolute('INSTALL_HOME')
  const claude = absolute('INSTALL_CLAUDE')
  const tmux = absolute('INSTALL_TMUX')
  const bun = absolute('INSTALL_BUN')
  const platform = required('INSTALL_PLATFORM')
  if (platform !== 'Linux' && platform !== 'Darwin') throw new Error('Unsupported INSTALL_PLATFORM')
  const path = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'
  if (/[\r\n\0]/.test(path)) throw new Error('Invalid PATH')
  const pluginDir = join(repo, 'plugin')
  const envFile = join(stateDir, 'channel.env')
  const configFile = join(stateDir, 'config.json')
  const wrapper = join(stateDir, 'channel-wrapper.sh')
  const mcp = join(stateDir, 'channel.mcp.json')
  const session = `channel-${agent}`
  const service = platform === 'Linux' ? `${session}.service` : `com.dashi-plugin.${session}`
  const serviceFile = platform === 'Linux' ? join(stateDir, service) : join(home, 'Library/LaunchAgents', `${service}.plist`)
  const serviceKind = platform === 'Linux' ? process.env.INSTALL_SERVICE_KIND ?? 'system' : 'launchd'
  if (platform === 'Linux' && !['system', 'user'].includes(serviceKind)) throw new Error('Invalid INSTALL_SERVICE_KIND')
  const installedServiceFile = platform === 'Linux' && process.env.INSTALL_SERVICE_FILE ? absolute('INSTALL_SERVICE_FILE') : serviceFile
  // Read and validate every existing owner source before creating or replacing files.
  let config: Record<string, any> = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : JSON.parse(readFileSync(join(repo, 'examples/config.example.json'), 'utf8'))
  if (!existsSync(configFile)) config = { ...config, allowed_user_ids: [owner], allowed_chat_ids: [owner], owner_chat_ids: [owner], permission_relay: { allowed_user_ids: [owner] }, memory: { ...config.memory, workspace_path: workspace, agent_label: agent } }
  const existingEnv = existsSync(envFile) ? readFileSync(envFile, 'utf8') : null
  const env = existingEnv === null ? new Map<string, string>() : assignments(existingEnv)
  for (const [key, expected] of Object.entries({ TELEGRAM_CONFIG_FILE: configFile, TELEGRAM_STATE_DIR: stateDir, TELEGRAM_WORKSPACE_ROOT: workspace, AGENT_ID: agent })) {
    if (env.has(key) && env.get(key) !== expected) throw new Error(`Existing ${key} conflicts with requested installation; review channel.env before retrying`)
  }
  if (existingEnv !== null) {
    for (const key of ['TELEGRAM_STATE_DIR', 'TELEGRAM_WORKSPACE_ROOT', 'AGENT_ID']) {
      if (!env.has(key)) throw new Error(`Existing ${key} is missing; configure it in channel.env for this installation before retrying`)
    }
  }
  const effectiveUsers = env.has('TELEGRAM_ALLOWED_USER_IDS') ? env.get('TELEGRAM_ALLOWED_USER_IDS')!.split(',').map(Number) : config.allowed_user_ids
  const effectiveChats = env.has('TELEGRAM_ALLOWED_CHAT_IDS') ? env.get('TELEGRAM_ALLOWED_CHAT_IDS')!.split(',').map(Number) : config.allowed_chat_ids ?? effectiveUsers
  if (!Array.isArray(effectiveUsers) || !effectiveUsers.includes(owner) || !Array.isArray(effectiveChats) || !effectiveChats.includes(owner) || !(config.permission_relay?.allowed_user_ids ?? effectiveUsers).includes(owner)) throw new Error('Existing owner configuration does not allow TELEGRAM_OWNER_ID; review config.json and channel.env before retrying')
  const token = existingEnv === null ? required('TELEGRAM_BOT_TOKEN') : env.get('TELEGRAM_BOT_TOKEN') ?? ''
  if (!/^[1-9]\d*:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid or missing TELEGRAM_BOT_TOKEN; set it in the private channel.env')
  const template = (name: string) => readFileSync(join(repo, 'examples', name), 'utf8')
  // Render all content before mutations, including validation of dotenv-compatible paths.
  let envText = template('channel.env.example')
  const envValues: Record<string, string> = { TELEGRAM_BOT_TOKEN: token, TELEGRAM_EXPECTED_BOT_ID: token.split(':')[0]!, TELEGRAM_ALLOWED_USER_IDS: ownerText, TELEGRAM_ALLOWED_CHAT_IDS: ownerText,
    TELEGRAM_WORKSPACE_ROOT: envLiteral(workspace), AGENT_ID: agent, TELEGRAM_STATE_DIR: envLiteral(stateDir), TELEGRAM_MEMORY_WORKSPACE: envLiteral(workspace), TELEGRAM_MEMORY_AGENT_LABEL: agent }
  for (const [key, value] of Object.entries(envValues)) envText = envText.replace(new RegExp(`^${key}=.*$`, 'm'), () => `${key}=${value}`)
  envText += `\nTELEGRAM_CONFIG_FILE=${envLiteral(configFile)}\n`
  const claudeCommand = [claude, '--settings', settings, '--mcp-config', mcp, '--permission-mode', 'bypassPermissions', '--dangerously-load-development-channels', 'server:dashi-channel'].map(shell).join(' ')
  // An already-running tmux server retains an older environment. Load the
  // private file inside the actual pane, without passing secrets in argv.
  const paneScript = `export HOME=${shell(home)} PATH=${shell(path)}; set -a; source ${shell(envFile)}; set +a; export TELEGRAM_CONFIG_FILE=${shell(configFile)}; exec ${claudeCommand}`
  const command = ['/bin/bash', '-c', paneScript].map(shell).join(' ')
  const wrapperText = render(template('launchd-wrapper.sh.example'), { 'env-file-shell': shell(envFile), 'session-shell': shell(session), 'tmux-shell': shell(tmux), 'workspace-shell': shell(workspace), 'claude-command-shell': shell(command) })
  const values = { agent, 'service-user': userInfo().username, 'plugin-dir': pluginDir, home, path, wrapper, 'state-dir': stateDir }
  const escaped = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, platform === 'Linux' ? systemd(value) : xml(value)]))
  if (platform === 'Linux') {
    // WorkingDirectory is a literal path, unlike the quoted ExecStart argv.
    if (/[\\\x00-\x1f\x7f]/.test(pluginDir)) throw new Error('systemd WorkingDirectory cannot contain backslashes or control characters; choose another checkout path')
    escaped['plugin-dir'] = pluginDir.replaceAll('%', '%%')
    escaped.wrapper = `"${escaped.wrapper!.replaceAll('$', () => '$$')}"`
  }
  let serviceText = render(template(platform === 'Linux' ? 'systemd-unit.service.example' : 'launchd-plist.example.plist'), escaped)
  if (serviceKind === 'user') serviceText = serviceText.replace(/^User=.*\n/m, '').replace('WantedBy=multi-user.target', 'WantedBy=default.target')
  const stamp = `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`
  function write(file: string, content: string, mode = 0o600): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    if (existsSync(file)) {
      if (!lstatSync(file).isFile()) throw new Error(`Refusing to replace non-regular file: ${file}`)
      const backup = `${file}.bak.${stamp}`
      copyFileSync(file, backup)
      chmodSync(backup, mode)
      console.log(`Backed up ${file}`)
    }
    writeFileSync(file, content, { mode })
    chmodSync(file, mode)
    console.log(`Rendered ${file}`)
  }
  mkdirSync(workspace, { recursive: true })
  if (!existsSync(configFile)) write(configFile, JSON.stringify(config, null, 2) + '\n')
  if (existingEnv === null) write(envFile, envText)
  else chmodSync(envFile, 0o600)
  write(mcp, JSON.stringify({ mcpServers: { 'dashi-channel': { command: bun, args: [join(pluginDir, 'src/server.ts')] } } }, null, 2) + '\n')
  write(wrapper, wrapperText, 0o700)
  write(serviceFile, serviceText, 0o644)
  write(join(stateDir, 'install.json'), JSON.stringify({ agent, workspace, stateDir, settings, platform, service, serviceFile: installedServiceFile, serviceKind, session, envFile, pluginDir }, null, 2) + '\n')
} catch (error) {
  // Validation never interpolates environment values or parser contents.
  console.error(`Install rendering failed: ${error instanceof SyntaxError ? 'Invalid existing config.json' : error instanceof Error ? error.message : 'unknown error'}`)
  process.exit(1)
}
