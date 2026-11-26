// Pre-update owner check for update.sh (#167). Since #157 the runtime
// (plugin/src/config.ts loadConfig) refuses to start without an explicit owner
// allowlist; an update that leaves the owner unset would cut the agent off its
// channel at the next restart. This resolves the owner the way the runtime does
// and only reads: it never writes the ID and never prints env values.
// Dependency-free on purpose: it runs before `bun install` of the new revision.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export type OwnerResolution =
  | { ok: true; configPath: string; count: number }
  | { ok: false; configPath: string; reason: 'missing' | 'invalid' | 'unreadable' }

export interface OwnerInput {
  /** Effective channel environment (what the wrapper exports before claude starts). */
  env: Record<string, string>
  home: string
  /** Process cwd of the runtime; relative TELEGRAM_CONFIG_FILE resolves against it. */
  cwd: string
  /** Returns file text, or null when the file does not exist / cannot be read. */
  read: (path: string) => string | null
}

const PLACEHOLDER = '<your Telegram user ID>'

/** One-line fix shared with doctor's owner-id-configured FAIL (doctor keeps a copy; a test pins equality). */
export function ownerFixHint(configPath: string, envFile: string): string {
  return `Добавьте "allowed_user_ids": [${PLACEHOLDER}] в ${configPath} или задайте TELEGRAM_ALLOWED_USER_IDS=${PLACEHOLDER} в ${envFile}; числовой ID пришлёт @userinfobot в Telegram. / `
    + `Add "allowed_user_ids": [${PLACEHOLDER}] to ${configPath} or set TELEGRAM_ALLOWED_USER_IDS=${PLACEHOLDER} in ${envFile}; @userinfobot in Telegram replies with your numeric ID. `
    + 'The ID is never written automatically / ID автоматически не записывается.'
}

/** Literal KEY=value lines; `source` semantics: last assignment wins, outer quotes stripped. */
export function parseShellEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!m) continue
    let value = m[2]!.trim()
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1)
    env[m[1]!] = value
  }
  return env
}

const positiveInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v > 0

/** Mirrors server.ts (state/.env fills unset keys) and config.ts loadConfig (config path, env > file, non-empty owner list). */
export function resolveOwner(input: OwnerInput): OwnerResolution {
  const env: Record<string, string | undefined> = { ...input.env }
  const defaultRoot = join(input.home, '.claude', 'channels', 'dashi-telegram-canary')
  // server.ts prebootStateDir (truthiness) + loadEnvFile: raw KEY=value, never overrides a set key.
  const dotEnv = input.read(join(env.TELEGRAM_STATE_DIR || defaultRoot, '.env'))
  for (const line of dotEnv === null ? [] : dotEnv.split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && env[m[1]!] === undefined) env[m[1]!] = m[2]!
  }
  // config.ts loadConfig (nullish): TELEGRAM_CONFIG_FILE, else <TELEGRAM_STATE_DIR or default>/config.json.
  const configPath = resolve(input.cwd, env.TELEGRAM_CONFIG_FILE ?? join(env.TELEGRAM_STATE_DIR ?? defaultRoot, 'config.json'))
  let file: Record<string, unknown> = {}
  const text = input.read(configPath)
  if (text !== null) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, configPath, reason: 'unreadable' }
      file = parsed as Record<string, unknown>
    } catch {
      return { ok: false, configPath, reason: 'unreadable' }
    }
  }
  let owners: unknown
  if (env.TELEGRAM_ALLOWED_USER_IDS !== undefined) {
    const ids = env.TELEGRAM_ALLOWED_USER_IDS.split(',').map((v) => v.trim()).filter(Boolean).map(Number)
    if (!ids.every(positiveInt)) return { ok: false, configPath, reason: 'invalid' }
    owners = ids
  } else {
    owners = file.allowed_user_ids
  }
  if (owners === undefined || (Array.isArray(owners) && owners.length === 0)) return { ok: false, configPath, reason: 'missing' }
  if (!Array.isArray(owners) || !owners.every(positiveInt)) return { ok: false, configPath, reason: 'invalid' }
  return { ok: true, configPath, count: owners.length }
}

function readOrNull(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

const objectRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** CLI: `bun scripts/owner-check.ts <state-dir>`; exit 0 owner set, 3 refused, 1 unusable input. */
function main(argv: string[]): number {
  const stateDir = argv[0] ?? ''
  if (!isAbsolute(stateDir)) { console.error('owner-check: absolute state dir required'); return 1 }
  // install.json (written by install.sh) names the env file and the runtime cwd.
  let meta: Record<string, unknown> = {}
  const metaText = readOrNull(join(stateDir, 'install.json'))
  if (metaText !== null) {
    try {
      const parsed: unknown = JSON.parse(metaText)
      if (objectRecord(parsed)) meta = parsed
    } catch { /* invalid metadata is reported later by read_context */ }
  }
  const envFile = typeof meta.envFile === 'string' && isAbsolute(meta.envFile) ? meta.envFile : join(stateDir, 'channel.env')
  const envText = readOrNull(envFile)
  const env = envText === null ? {} : parseShellEnv(envText)
  // The installed wrapper exports TELEGRAM_CONFIG_FILE=<stateDir>/config.json after sourcing the env file.
  if (typeof meta.stateDir === 'string' && isAbsolute(meta.stateDir)) env.TELEGRAM_CONFIG_FILE = join(meta.stateDir, 'config.json')
  const cwd = typeof meta.workspace === 'string' && isAbsolute(meta.workspace) ? meta.workspace : stateDir
  const result = resolveOwner({ env, home: homedir(), cwd, read: readOrNull })
  if (result.ok) {
    console.log(`Owner ID configured (${result.count} ID(s)) in the effective config: ${result.configPath}`)
    return 0
  }
  const why = {
    missing: ['не задан Telegram ID владельца', 'the owner Telegram ID is not configured'],
    invalid: ['Telegram ID владельца задан неверно (нужны положительные целые числа)', 'the owner Telegram ID is invalid (positive integers required)'],
    unreadable: [`не читается ${result.configPath} (нужен JSON-объект)`, `${result.configPath} is unreadable (a JSON object is required)`],
  }[result.reason]
  console.error([
    `Обновление остановлено: ${why[0]}. Начиная с #157 канал без него не запускается, и после перезапуска агент потеряет связь с Telegram. Код и сервис не тронуты.`,
    `Update refused: ${why[1]}. Since #157 the channel refuses to start without it, so after a restart the agent would lose its Telegram channel. Code and service were not touched.`,
    ownerFixHint(result.configPath, envFile),
    'Затем запустите ./update.sh снова / Then rerun ./update.sh.',
  ].join('\n'))
  return 3
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
