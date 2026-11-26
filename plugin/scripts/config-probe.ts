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
// Inner writes one JSON line to the outer process only. The console gets OK or
// a reason with paths and fix hints, never IDs, env values or secrets. Read-only:
// unlike server.ts it never chmods the .env file.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { configFilePath, loadConfig } from '../src/config.js'
import { loadEnvFile, prebootEnvFile } from '../src/preboot-env.js'

export type ProbeReason = 'missing' | 'invalid' | 'unreadable' | 'token' | 'probe'

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
const LAUNCH_SCRIPT = '__probe_env=$1 __probe_config=$2 __probe_bun=$3 __probe_self=$4; set --; '
  + 'set -a; source "$__probe_env"; set +a; export TELEGRAM_CONFIG_FILE="$__probe_config"; '
  + 'exec "$__probe_bun" "$__probe_self" --inner'

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

/** Outer mode: run the inner probe under the env the installed launcher builds. */
export function probeInstallation(stateDir: string): ProbeResult {
  const meta = readInstallMeta(stateDir)
  if (meta === null) return { ok: false, configPath: null, reason: 'probe', detail: `${join(stateDir, 'install.json')} is missing or invalid` }
  const configFile = join(meta.stateDir, 'config.json')
  const child = spawnSync('/bin/bash', ['-c', LAUNCH_SCRIPT, 'config-probe', meta.envFile, configFile, process.execPath, import.meta.path], {
    cwd: meta.workspace,
    // A systemd unit / LaunchAgent gives the wrapper HOME and PATH only.
    env: { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '/usr/bin:/bin' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  })
  const result = child.error === undefined ? parseResult(child.stdout) : null
  if (result === null) {
    return { ok: false, configPath: configFile, reason: 'probe', detail: `the runtime config check could not run in ${meta.workspace} (missing workspace or plugin dependencies: run bun install in the plugin directory)` }
  }
  return result
}

function refusal(result: Extract<ProbeResult, { ok: false }>, envFile: string): string {
  const path = result.configPath ?? '<state>/config.json'
  const why: Record<ProbeReason, [string, string]> = {
    missing: ['не задан Telegram ID владельца', 'the owner Telegram ID is not configured'],
    invalid: [`рантайм отклонил настройки (${result.detail}; нужны положительные целые ID)`, `the runtime rejected the configuration (${result.detail}; owner IDs must be positive integers)`],
    unreadable: [`не читается ${path} (нужен JSON-объект)`, `${path} is unreadable (a JSON object is required)`],
    token: [`не задан TELEGRAM_BOT_TOKEN в ${envFile}`, `TELEGRAM_BOT_TOKEN is not set in ${envFile}`],
    probe: [`проверка настроек не запустилась: ${result.detail}`, `the configuration check could not run: ${result.detail}`],
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

/**
 * CLI. `--inner`: JSON for the outer process only.
 * `--state-dir <abs> [--json]`: exit 0 the runtime accepts, 3 refused, 1 check could not run.
 * `--json` prints {ok, reason, configPath} without IDs (doctor).
 */
function main(argv: string[]): number {
  if (argv[0] === '--inner') {
    process.stdout.write(JSON.stringify(probeRuntime(process.env)) + '\n')
    return 0
  }
  const stateDir = argv[0] === '--state-dir' ? argv[1] ?? '' : ''
  if (!isAbsolute(stateDir)) { console.error('config-probe: --state-dir <absolute path> required'); return 1 }
  const result = probeInstallation(stateDir)
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(result.ok ? { ok: true, configPath: result.configPath } : { ok: false, reason: result.reason, detail: result.detail, configPath: result.configPath }) + '\n')
    return result.ok ? 0 : result.reason === 'probe' ? 1 : 3
  }
  if (result.ok) {
    console.log(`Owner ID configured: the runtime accepts the effective config ${result.configPath}`)
    return 0
  }
  const envFile = readInstallMeta(stateDir)?.envFile ?? join(stateDir, 'channel.env')
  console.error(refusal(result, envFile))
  return result.reason === 'probe' ? 1 : 3
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
