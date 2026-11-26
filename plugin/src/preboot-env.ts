// Preboot env resolution shared by server.ts and scripts/config-probe.ts.
// Plugin-spawned servers don't get an env block — the token may live in
// ${STATE_DIR}/.env. Real env wins over file values. The update guard runs the
// same code, so its verdict cannot drift from what the server does at boot.

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * State root used to find `.env` BEFORE loadConfig() can run. Matches the
 * default in config.ts (intentional duplicate). L6: homedir() for parity with
 * config.ts (handles unset $HOME on macOS/Linux + Windows USERPROFILE fallback).
 * A relative value resolves against the process cwd, as the server does.
 */
export function prebootStateDir(env: NodeJS.ProcessEnv): string {
  if (env.TELEGRAM_STATE_DIR) return env.TELEGRAM_STATE_DIR
  return join(homedir(), '.claude', 'channels', 'dashi-telegram-canary')
}

/** `${prebootStateDir}/.env`, the file loadEnvFile reads at boot. */
export function prebootEnvFile(env: NodeJS.ProcessEnv): string {
  return `${prebootStateDir(env)}/.env`
}

/** Raw KEY=value lines; fills only keys that are still unset. Missing file is a no-op. */
export function loadEnvFile(envFile: string, env: NodeJS.ProcessEnv): void {
  let raw: string
  try {
    raw = readFileSync(envFile, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (!m) continue
    const key = m[1]
    const value = m[2]
    if (key === undefined || value === undefined) continue
    if (env[key] === undefined) env[key] = value
  }
}
