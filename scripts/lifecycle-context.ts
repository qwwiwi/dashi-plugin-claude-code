// Read lifecycle metadata and the effective hook destination without executing env files.
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'
import { parseLiteralEnv } from './env-parser'
const state = process.argv[2] ?? ''
const settingsOverride = process.argv[3] ?? ''
try {
  const meta = JSON.parse(readFileSync(join(state, 'install.json'), 'utf8'))
  if (realpathSync(meta.pluginDir) !== realpathSync(resolve(import.meta.dir, '../plugin'))) {
    console.error('Installation metadata belongs to a different checkout; run update.sh from the installed repository')
    process.exit(1)
  }
  const envFile = meta.envFile
  if (typeof envFile !== 'string' || !isAbsolute(envFile)) throw new Error('env path')
  const env = Object.fromEntries(parseLiteralEnv(readFileSync(envFile, 'utf8'), true))
  const configPath = resolve(meta.workspace, env.TELEGRAM_CONFIG_FILE || join(env.TELEGRAM_STATE_DIR || state, 'config.json'))
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}
  const owner = env.TELEGRAM_ALLOWED_USER_IDS !== undefined ? env.TELEGRAM_ALLOWED_USER_IDS.split(',')[0]?.trim() ?? '' : String(config.allowed_user_ids?.[0] ?? '')
  const chat = env.TELEGRAM_ALLOWED_CHAT_IDS !== undefined ? env.TELEGRAM_ALLOWED_CHAT_IDS.split(',')[0]?.trim() ?? '' : String(config.allowed_chat_ids?.[0] ?? owner)
  if (!/^-?\d+$/.test(chat) || !Number.isSafeInteger(Number(chat)) || Number(chat) === 0) throw new Error('chat ID')
  if (!/^[1-9]\d*$/.test(owner) || !Number.isSafeInteger(Number(owner)) || Number(owner) === 0) throw new Error('owner ID')
  const host = env.TELEGRAM_WEBHOOK_HOST || config.webhook?.host || '127.0.0.1'
  const port = env.TELEGRAM_WEBHOOK_PORT || config.webhook?.port || 8089
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !/^\d+$/.test(String(port))) throw new Error('webhook address')
  const values = [meta.agent, meta.workspace, settingsOverride || meta.settings, envFile, meta.serviceFile, meta.session, owner, `http://${host === '::1' ? '[::1]' : host}:${port}/hooks/agent`, configPath, chat, meta.serviceKind ?? (meta.serviceFile.startsWith(join(process.env.HOME ?? '', '.config/systemd/user') + '/') ? 'user' : 'system')]
  if (values.some(v => typeof v !== 'string' || !v || /[\r\n\0]/.test(v))) throw new Error('metadata')
  if (!/^[a-z][a-z0-9_-]*$/.test(meta.agent) || meta.session !== `channel-${meta.agent}`) throw new Error('agent/session')
  process.stdout.write(values.join('\n') + '\n')
} catch {
  console.error('Invalid or unreadable installation metadata/config/env; owner ID configured and valid paths are required. No env values were printed.')
  process.exit(1)
}
