// Read lifecycle metadata and the effective hook destination. Owner, chat,
// webhook and config path come from the runtime's own loadConfig, run by
// plugin/scripts/config-probe.ts under the installed launcher env (#167), so
// they cannot disagree with what the channel resolves at boot.
import { readFileSync, realpathSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'

import { probeInstallation } from '../plugin/scripts/config-probe.js'

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
  const probe = probeInstallation(state)
  if (!probe.ok) throw new Error('runtime config')
  const owner = String(probe.owner)
  const chat = probe.chat
  if (!/^-?\d+$/.test(chat) || !Number.isSafeInteger(Number(chat)) || Number(chat) === 0) throw new Error('chat ID')
  if (!/^[1-9]\d*$/.test(owner) || !Number.isSafeInteger(Number(owner))) throw new Error('owner ID')
  const host = probe.webhookHost
  const port = probe.webhookPort
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !/^\d+$/.test(String(port))) throw new Error('webhook address')
  const values = [meta.agent, meta.workspace, settingsOverride || meta.settings, envFile, meta.serviceFile, meta.session, owner, `http://${host === '::1' ? '[::1]' : host}:${port}/hooks/agent`, probe.configPath, chat]
  if (values.some(v => typeof v !== 'string' || !v || /[\r\n\0]/.test(v))) throw new Error('metadata')
  if (!/^[a-z][a-z0-9_-]*$/.test(meta.agent) || meta.session !== `channel-${meta.agent}`) throw new Error('agent/session')
  process.stdout.write(values.join('\n') + '\n')
} catch {
  console.error('Invalid or unreadable installation metadata/config/env; owner ID configured and valid paths are required. No env values were printed.')
  process.exit(1)
}
