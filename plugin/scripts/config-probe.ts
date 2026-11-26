#!/usr/bin/env bun
// Owner/config guard for update.sh, lifecycle context and doctor (#167).
// Since #157 the runtime refuses to start without an explicit owner. Instead of
// re-implementing env and config resolution, this asks the runtime itself:
//
//   outer (--state-dir): reads install.json and starts /bin/bash the way the
//     installed pane script does (cwd = launch workspace, service env = HOME and
//     PATH only, `set -a; source <channel.env>; set +a`, then the wrapper's
//     `export TELEGRAM_CONFIG_FILE=<state>/config.json`). Shell semantics
//     (unset, comments, quoting, relative paths) are therefore bash's own.
//   inner (--inner): runs inside that shell, applies server.ts's preboot
//     <state>/.env loader and calls the real loadConfig.
//
// Privilege boundary: channel.env is shell and the workspace is the cwd of a bun
// process, so both are code of the account that owns them. The probe replays
// the launcher only when its effective uid owns the state dir, install.json,
// the env file and the workspace; any other account (root included) is refused
// before bash starts. It never switches users itself.
//
// Inner hands its JSON line (it carries the owner and chat IDs) to the outer
// process over fd 3, an already unlinked private temp file whose device:inode
// the outer names in argv; on any other fd 3 `--inner` refuses and prints nothing. The console gets OK or a reason with
// paths and fix hints, never IDs, env values or secrets. Read-only: unlike
// server.ts it never chmods the .env file.
import { spawnSync } from 'node:child_process'
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { configFilePath, loadConfig } from '../src/config.js'
import { loadEnvFile, prebootEnvFile } from '../src/preboot-env.js'

export type ProbeReason = 'missing' | 'invalid' | 'unreadable' | 'token' | 'probe' | 'account'

export type ProbeResult =
  | { ok: true, configPath: string, owner: number, chat: string, webhookHost: string, webhookPort: number }
  | { ok: false, configPath: string | null, reason: ProbeReason, detail: string }

export interface InstallMeta {
  workspace: string
  stateDir: string
  envFile: string
}

const PLACEHOLDER = '<your Telegram user ID>'

/** One-line fix shared with doctor's owner-id-configured FAIL (doctor keeps a copy; a test pins equality). */
export function ownerFixHint(configPath: string, envFile: string): string {
  return `Добавьте "allowed_user_ids": [${PLACEHOLDER}] в ${configPath} или задайте TELEGRAM_ALLOWED_USER_IDS=${PLACEHOLDER} в ${envFile}; числовой ID пришлёт @userinfobot в Telegram. / `
    + `Add "allowed_user_ids": [${PLACEHOLDER}] to ${configPath} or set TELEGRAM_ALLOWED_USER_IDS=${PLACEHOLDER} in ${envFile}; @userinfobot in Telegram replies with your numeric ID. `
    + 'The ID is never written automatically / ID автоматически не записывается.'
}

const objectRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const absolutePath = (v: unknown): v is string => typeof v === 'string' && isAbsolute(v) && !/[\r\n\0]/.test(v)

/** install.json fields the launcher is rendered from (scripts/render-install.ts). */
export function readInstallMeta(stateDir: string): InstallMeta | null {
  try {
    const meta: unknown = JSON.parse(readFileSync(join(stateDir, 'install.json'), 'utf8'))
    if (!objectRecord(meta) || !absolutePath(meta.workspace) || !absolutePath(meta.stateDir) || !absolutePath(meta.envFile)) return null
    return { workspace: meta.workspace, stateDir: meta.stateDir, envFile: meta.envFile }
  } catch {
    return null
  }
}

/** Inner mode: the process env is the launcher env, cwd is the launch workspace. */
export function probeRuntime(env: NodeJS.ProcessEnv): ProbeResult {
  // server.ts boot order: preboot <state>/.env fills unset keys, token check, loadConfig.
  loadEnvFile(prebootEnvFile(env), env)
  const configPath = resolve(configFilePath({ TELEGRAM_STATE_DIR: env.TELEGRAM_STATE_DIR, TELEGRAM_CONFIG_FILE: env.TELEGRAM_CONFIG_FILE }))
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, configPath, reason: 'token', detail: 'TELEGRAM_BOT_TOKEN is not set' }
  try {
    const config = loadConfig(env)
    const owner = config.allowed_user_ids[0]
    if (owner === undefined) return { ok: false, configPath, reason: 'missing', detail: 'owner ID not configured' }
    return {
      ok: true, configPath, owner,
      chat: String(config.allowed_chat_ids[0] ?? owner),
      webhookHost: config.webhook.host || '127.0.0.1',
      webhookPort: config.webhook.port || 8089,
    }
  } catch (error: unknown) {
    // Raw messages can carry the rejected value (e.g. a malformed ID): keep only the class.
    const message = error instanceof Error ? error.message : ''
    if (message.startsWith('owner ID not configured')) return { ok: false, configPath, reason: 'missing', detail: 'owner ID not configured' }
    if (message.startsWith('failed to read config')) return { ok: false, configPath, reason: 'unreadable', detail: 'config file cannot be read as a JSON object' }
    if (message.startsWith('invalid env')) return { ok: false, configPath, reason: 'invalid', detail: 'invalid env' }
    return { ok: false, configPath, reason: 'invalid', detail: 'invalid config' }
  }
}

// Positional values are copied and cleared before sourcing: the pane script
// sources the env file with no positional parameters.
const LAUNCH_SCRIPT = '__probe_env=$1 __probe_config=$2 __probe_bun=$3 __probe_self=$4 __probe_channel=$5; set --; '
  + 'set -a; source "$__probe_env"; set +a; export TELEGRAM_CONFIG_FILE="$__probe_config"; '
  + 'exec "$__probe_bun" "$__probe_self" --inner "$__probe_channel"'

/** fd on which the inner process returns its result (never stdout: the line carries IDs). */
const RESULT_FD = 3

/**
 * Everything the launcher replay executes or trusts must belong to the invoking
 * account. Returns the refusal, or null when `euid` owns all of it.
 */
function launchOwnership(stateDir: string, meta: InstallMeta, euid: number): Extract<ProbeResult, { ok: false }> | null {
  const configPath = join(meta.stateDir, 'config.json')
  for (const path of [stateDir, join(stateDir, 'install.json'), meta.stateDir, meta.envFile, meta.workspace]) {
    let uid: number
    try {
      uid = statSync(path).uid
    } catch {
      return { ok: false, configPath, reason: 'probe', detail: `${path} is missing or cannot be inspected` }
    }
    if (uid !== euid) return { ok: false, configPath, reason: 'account', detail: `${path} belongs to uid ${uid}, the check runs as uid ${euid}` }
  }
  return null
}

/** Private result channel: a 0600 file in a 0700 temp dir, unlinked before the child starts. */
function openResultChannel(): number {
  const dir = mkdtempSync(join(tmpdir(), 'config-probe-'))
  try {
    return openSync(join(dir, 'result'), 'wx+', 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function readResultChannel(fd: number): string {
  const size = fstatSync(fd).size
  if (size <= 0 || size > 65_536) return ''
  const buffer = Buffer.alloc(size)
  return buffer.subarray(0, readSync(fd, buffer, 0, size, 0)).toString('utf8')
}

/** device:inode of an open file: how the outer process names its channel to the inner one. */
function channelIdentity(fd: number): string {
  const stat = fstatSync(fd, { bigint: true })
  return `${stat.dev}:${stat.ino}`
}

/**
 * True only for the outer probe's channel: an unlinked regular file whose identity
 * matches argv. A terminal, a pipe or a capture file a caller put on fd 3 never matches.
 */
function resultChannelInherited(expected: string | undefined): boolean {
  try {
    const stat = fstatSync(RESULT_FD)
    return expected !== undefined && stat.isFile() && stat.nlink === 0 && channelIdentity(RESULT_FD) === expected
  } catch {
    return false
  }
}

function parseResult(text: string): ProbeResult | null {
  const line = text.trim().split('\n').pop() ?? ''
  try {
    const value: unknown = JSON.parse(line)
    if (!objectRecord(value) || typeof value.ok !== 'boolean') return null
    return value as ProbeResult
  } catch {
    return null
  }
}

/**
 * Outer mode: run the inner probe under the env the installed launcher builds.
 * `euid` is the account the check runs as (a parameter only so tests can stand in for root).
 */
export function probeInstallation(stateDir: string, euid: number | undefined = process.geteuid?.()): ProbeResult {
  const meta = readInstallMeta(stateDir)
  if (meta === null) return { ok: false, configPath: null, reason: 'probe', detail: `${join(stateDir, 'install.json')} is missing or invalid` }
  const configFile = join(meta.stateDir, 'config.json')
  // No uid on this platform (not Linux/macOS): nothing to compare, the lifecycle scripts refuse it anyway.
  const foreign = euid === undefined ? null : launchOwnership(stateDir, meta, euid)
  if (foreign !== null) return foreign
  let result: ProbeResult | null = null
  let channel: number | null = null
  try {
    channel = openResultChannel()
    const child = spawnSync('/bin/bash', ['-c', LAUNCH_SCRIPT, 'config-probe', meta.envFile, configFile, process.execPath, import.meta.path, channelIdentity(channel)], {
      cwd: meta.workspace,
      // A systemd unit / LaunchAgent gives the wrapper HOME and PATH only.
      env: { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '/usr/bin:/bin' },
      // The child's stdout and stderr may echo env values: they are never read.
      stdio: ['ignore', 'ignore', 'ignore', channel],
      timeout: 60_000,
    })
    if (child.error === undefined) result = parseResult(readResultChannel(channel))
  } catch {
    result = null
  } finally {
    if (channel !== null) closeSync(channel)
  }
  if (result === null) {
    return { ok: false, configPath: configFile, reason: 'probe', detail: `the runtime config check could not run in ${meta.workspace} (missing workspace or plugin dependencies: run bun install in the plugin directory)` }
  }
  return result
}

/** Console text for a refusal: paths and fix hints only. */
export function refusal(result: Extract<ProbeResult, { ok: false }>, envFile: string): string {
  const path = result.configPath ?? '<state>/config.json'
  const why: Record<ProbeReason, [string, string]> = {
    missing: ['не задан Telegram ID владельца', 'the owner Telegram ID is not configured'],
    invalid: [`рантайм отклонил настройки (${result.detail}; нужны положительные целые ID)`, `the runtime rejected the configuration (${result.detail}; owner IDs must be positive integers)`],
    unreadable: [`не читается ${path} (нужен JSON-объект)`, `${path} is unreadable (a JSON object is required)`],
    token: [`не задан TELEGRAM_BOT_TOKEN в ${envFile}`, `TELEGRAM_BOT_TOKEN is not set in ${envFile}`],
    probe: [`проверка настроек не запустилась: ${result.detail}`, `the configuration check could not run: ${result.detail}`],
    account: ['', ''],
  }
  if (result.reason === 'account') {
    const owner = /belongs to uid (\d+)/.exec(result.detail)?.[1] ?? '<uid>'
    return [
      `Обновление остановлено: установка принадлежит другой учётной записи (${result.detail}). Проверка исполняет ${envFile} как шелл, поэтому работает только от владельца установки и никогда от root за другого пользователя. Канал не перезапущен.`,
      `Update refused: the installation belongs to another account (${result.detail}). The check executes ${envFile} as shell, so it runs only as the installation's owner and never as root on another user's behalf. The channel was not restarted.`,
      `Запустите обновление от учётной записи сервиса: sudo -u '#${owner}' ./update.sh, перезапуск сделайте отдельной командой. / Run the update as the service account: sudo -u '#${owner}' ./update.sh, then restart with a separate command.`,
    ].join('\n')
  }
  const [ru, en] = why[result.reason]
  const lines = [
    `Обновление остановлено: ${ru}. Начиная с #157 канал без явного владельца не запускается, и после перезапуска агент потеряет связь с Telegram. Канал не перезапущен.`,
    `Update refused: ${en}. Since #157 the channel refuses to start without an explicit owner, so after a restart the agent would lose its Telegram channel. The channel was not restarted.`,
  ]
  if (result.reason === 'missing' || result.reason === 'invalid') lines.push(ownerFixHint(path, envFile))
  lines.push('Затем запустите ./update.sh снова / Then rerun ./update.sh.')
  return lines.join('\n')
}

const couldNotRun = (reason: ProbeReason): boolean => reason === 'probe' || reason === 'account'

/**
 * CLI. `--inner`: internal, JSON on fd 3 for the outer process only (exit 2 without that fd).
 * `--state-dir <abs> [--json]`: exit 0 the runtime accepts, 3 refused, 1 check could not run.
 * `--json` prints {ok, reason, configPath} without IDs (doctor).
 */
function main(argv: string[]): number {
  if (argv[0] === '--inner') {
    if (!resultChannelInherited(argv[1])) {
      console.error('config-probe: --inner is internal; run config-probe.ts --state-dir <absolute path>')
      return 2
    }
    writeSync(RESULT_FD, JSON.stringify(probeRuntime(process.env)) + '\n')
    return 0
  }
  const stateDir = argv[0] === '--state-dir' ? argv[1] ?? '' : ''
  if (!isAbsolute(stateDir)) { console.error('config-probe: --state-dir <absolute path> required'); return 1 }
  const result = probeInstallation(stateDir)
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(result.ok ? { ok: true, configPath: result.configPath } : { ok: false, reason: result.reason, detail: result.detail, configPath: result.configPath }) + '\n')
    return result.ok ? 0 : couldNotRun(result.reason) ? 1 : 3
  }
  if (result.ok) {
    console.log(`Owner ID configured: the runtime accepts the effective config ${result.configPath}`)
    return 0
  }
  const envFile = readInstallMeta(stateDir)?.envFile ?? join(stateDir, 'channel.env')
  console.error(refusal(result, envFile))
  return couldNotRun(result.reason) ? 1 : 3
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
