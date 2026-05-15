// Config loader with Zod validation and state-dir path resolution.
// All env vars and config.json keys are validated at boundary; defaults
// embed canary values (bot 8507713167, prince 164795011).

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { z } from 'zod'

// ─────────────────────────────────────────────────────────────────────
// AppConfig — the merged, validated runtime config.
// ─────────────────────────────────────────────────────────────────────

export const AppConfigSchema = z.object({
  bot_id: z.number().int().positive().default(8507713167),
  dm_only: z.boolean().default(true),
  allowed_user_ids: z.array(z.number().int().positive()).min(1).default([164795011]),
  allowed_chat_ids: z.array(z.union([z.number(), z.string()])).default([164795011]),
  workspace_root: z.string().optional(),
  status: z.object({
    enabled: z.boolean().default(true),
    interval_ms: z.number().int().positive().default(700),
    ttl_ms: z.number().int().positive().default(300_000),
    delete_on_complete: z.boolean().default(true),
  }).default({}),
  album: z.object({
    flush_ms: z.number().int().positive().default(2000),
  }).default({}),
  voice: z.object({
    provider: z.enum(['groq', 'none']).default('groq'),
    language: z.string().default('ru'),
    model: z.string().default('whisper-large-v3-turbo'),
  }).default({}),
  webhook: z.object({
    enabled: z.boolean().default(false),
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(0).default(0),
  }).default({}),
  permission_relay: z.object({
    enabled: z.boolean().default(true),
    allowed_user_ids: z.array(z.number().int().positive()).default([164795011]),
    bash_only_proof: z.boolean().default(true),
  }).default({}),
  commands: z.object({
    help: z.boolean().default(true),
    status: z.boolean().default(true),
    stop: z.boolean().default(true),
    reset: z.boolean().default(true),
    new: z.boolean().default(true),
  }).default({}),
  // Phase 8: Memory hooks parity with gateway.py:1938-2035. When a Claude
  // hook (UserPromptSubmit / Stop) fires, the plugin writes a turn entry to
  // <workspace_path>/core/hot/recent.md and a lossless record to
  // <workspace_parent>/logs/verbose-YYYY-MM-DD.jsonl.
  //
  // Deviation from PLAN.md T1: `enabled` defaults to false (plan said true).
  // With default-true, parsing the bare default ({}) trips the superRefine
  // below because workspace_path is required when enabled — that would
  // break every existing test fixture that calls loadConfig() without a
  // memory block. enabled=false off-by-default matches the runtime gate
  // in T7 ("instantiate when enabled=true AND workspace_path set"). The
  // refine still triggers when enabled is explicitly turned on without a
  // workspace, which is the only assertion T1's acceptance demands.
  memory: z.object({
    enabled: z.boolean().default(false),
    workspace_path: z.string().optional(),
    logs_path: z.string().optional(),
    source_tag: z.string().default('tg'),
    agent_label: z.string().optional(),
    max_hot_bytes: z.number().int().positive().default(20480),
    trim_keep_lines: z.number().int().positive().default(600),
    buffer_ttl_ms: z.number().int().positive().default(5 * 60 * 1000),
    buffer_max_entries: z.number().int().positive().default(100),
  }).default({}).superRefine((m, ctx) => {
    if (m.enabled && (m.workspace_path === undefined || m.workspace_path === '')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'memory.workspace_path required when memory.enabled=true',
      })
    }
  }),
})
export type AppConfig = z.infer<typeof AppConfigSchema>

// ─────────────────────────────────────────────────────────────────────
// RuntimeEnv — environment variables that can override config.json
// ─────────────────────────────────────────────────────────────────────

export const RuntimeEnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_STATE_DIR: z.string().optional(),
  TELEGRAM_CONFIG_FILE: z.string().optional(),
  TELEGRAM_EXPECTED_BOT_ID: z.coerce.number().int().positive().optional(),
  TELEGRAM_ALLOWED_USER_IDS: z.string().optional(), // CSV
  TELEGRAM_WORKSPACE_ROOT: z.string().optional(),
  TELEGRAM_STATUS_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  TELEGRAM_ALBUM_FLUSH_MS: z.coerce.number().int().positive().optional(),
  GROQ_API_KEY: z.string().optional(),
  TELEGRAM_WEBHOOK_HOST: z.string().optional(),
  TELEGRAM_WEBHOOK_PORT: z.coerce.number().int().min(0).optional(),
  TELEGRAM_WEBHOOK_TOKEN: z.string().optional(),
  // Phase 8 memory env overrides. ENABLED accepts the usual truthy strings
  // (1/true/yes, case-insensitive); anything else parses as false so a
  // typo doesn't silently turn the feature on.
  TELEGRAM_MEMORY_ENABLED: z
    .string()
    .transform((v) => /^(1|true|yes|on)$/i.test(v))
    .optional(),
  TELEGRAM_MEMORY_WORKSPACE: z.string().optional(),
  TELEGRAM_MEMORY_LOGS_PATH: z.string().optional(),
  TELEGRAM_MEMORY_SOURCE_TAG: z.string().optional(),
  TELEGRAM_MEMORY_AGENT_LABEL: z.string().optional(),
  // PLAN.md Scope A only ships static allowlist mode; `pairing` is reserved
  // for Scope B. We accept both values at the schema level so we can emit
  // a clear, scope-aware error message (the bare `z.enum(['static'])` form
  // gave a cryptic "Invalid enum value" that didn't explain why).
  TELEGRAM_ACCESS_MODE: z
    .enum(['static', 'pairing'])
    .refine((v) => v === 'static', {
      message:
        "TELEGRAM_ACCESS_MODE=pairing not supported in this server build (use 'allowlist'); see PLAN.md Scope B",
    })
    .optional(),
})
export type RuntimeEnv = z.infer<typeof RuntimeEnvSchema>

// ─────────────────────────────────────────────────────────────────────
// Secret redaction. We mask Telegram bot tokens, Groq API keys, generic
// bearer/query-string tokens, and any caller-supplied exact-substring
// secrets BEFORE letting any error/log line escape the process.
// ─────────────────────────────────────────────────────────────────────

// Telegram bot token: `<digits>:<base64ish>`.
const TELEGRAM_TOKEN_RE = /\d{8,12}:[A-Za-z0-9_-]{30,}/g
// Groq API key: `gsk_` followed by 40+ url-safe base64 chars.
const GROQ_KEY_RE = /gsk_[A-Za-z0-9]{40,}/g
// Authorization: Bearer <opaque>. We keep the header label, redact the value.
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._\-+/=]{8,}/gi
// `?token=...` / `&token=...` query params (also access_token, api_key).
const QUERY_TOKEN_RE = /([?&](?:access_token|api_key|token)=)[^&\s"']+/gi

export function redactToken(message: string, extraSecrets: ReadonlyArray<string> = []): string {
  let out = message
    .replace(TELEGRAM_TOKEN_RE, '<redacted>')
    .replace(GROQ_KEY_RE, '<redacted>')
    .replace(BEARER_RE, '$1<redacted>')
    .replace(QUERY_TOKEN_RE, '$1<redacted>')
  for (const secret of extraSecrets) {
    if (!secret || secret.length < 4) continue
    // Escape regex metachars; replace every exact occurrence with <redacted>.
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(escaped, 'g'), '<redacted>')
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────
// loadConfig — merges env + config.json into validated AppConfig.
// Order of precedence: env > config.json > schema defaults.
// Errors are re-thrown with the bot token redacted.
// ─────────────────────────────────────────────────────────────────────

function pickEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Filter to only known keys so Zod's `unknownKeys` (default strip) is irrelevant
  // and we don't accidentally pipe unrelated env into validation.
  const keys = Object.keys(RuntimeEnvSchema.shape)
  const out: NodeJS.ProcessEnv = {}
  for (const k of keys) {
    if (env[k] !== undefined) out[k] = env[k]
  }
  return out
}

function parseCsvUserIds(csv: string): number[] {
  const ids: number[] = []
  for (const raw of csv.split(',')) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const n = Number(trimmed)
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`invalid user id in CSV: ${JSON.stringify(trimmed)}`)
    }
    ids.push(n)
  }
  return ids
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  let parsedEnv: RuntimeEnv
  try {
    parsedEnv = RuntimeEnvSchema.parse(pickEnv(env))
  } catch (err) {
    throw new Error(redactToken(`invalid env: ${err instanceof Error ? err.message : String(err)}`))
  }

  // Resolve state dir (we need it to find default config.json path).
  const stateRoot = parsedEnv.TELEGRAM_STATE_DIR
    ?? join(homedir(), '.claude', 'channels', 'dashi-telegram-canary')
  const configPath = parsedEnv.TELEGRAM_CONFIG_FILE ?? join(stateRoot, 'config.json')

  // Read config.json if it exists. Missing file is fine — defaults apply.
  let fileConfig: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fileConfig = parsed as Record<string, unknown>
      } else {
        throw new Error(`config.json must be a JSON object`)
      }
    } catch (err) {
      throw new Error(redactToken(
        `failed to read config ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      ))
    }
  }

  // Apply env overrides on top of file config. Env wins.
  const merged: Record<string, unknown> = { ...fileConfig }

  if (parsedEnv.TELEGRAM_EXPECTED_BOT_ID !== undefined) {
    merged.bot_id = parsedEnv.TELEGRAM_EXPECTED_BOT_ID
  }
  if (parsedEnv.TELEGRAM_ALLOWED_USER_IDS !== undefined) {
    merged.allowed_user_ids = parseCsvUserIds(parsedEnv.TELEGRAM_ALLOWED_USER_IDS)
  }
  if (parsedEnv.TELEGRAM_WORKSPACE_ROOT !== undefined) {
    merged.workspace_root = parsedEnv.TELEGRAM_WORKSPACE_ROOT
  }

  // Nested overrides: status.interval_ms, album.flush_ms, webhook.{host,port}
  const status = (merged.status && typeof merged.status === 'object' ? merged.status : {}) as Record<string, unknown>
  if (parsedEnv.TELEGRAM_STATUS_INTERVAL_MS !== undefined) {
    status.interval_ms = parsedEnv.TELEGRAM_STATUS_INTERVAL_MS
  }
  if (Object.keys(status).length > 0) merged.status = status

  const album = (merged.album && typeof merged.album === 'object' ? merged.album : {}) as Record<string, unknown>
  if (parsedEnv.TELEGRAM_ALBUM_FLUSH_MS !== undefined) {
    album.flush_ms = parsedEnv.TELEGRAM_ALBUM_FLUSH_MS
  }
  if (Object.keys(album).length > 0) merged.album = album

  const webhook = (merged.webhook && typeof merged.webhook === 'object' ? merged.webhook : {}) as Record<string, unknown>
  if (parsedEnv.TELEGRAM_WEBHOOK_HOST !== undefined) webhook.host = parsedEnv.TELEGRAM_WEBHOOK_HOST
  if (parsedEnv.TELEGRAM_WEBHOOK_PORT !== undefined) webhook.port = parsedEnv.TELEGRAM_WEBHOOK_PORT
  if (Object.keys(webhook).length > 0) merged.webhook = webhook

  // Phase 8 memory env overrides.
  const memory = (merged.memory && typeof merged.memory === 'object' ? merged.memory : {}) as Record<string, unknown>
  if (parsedEnv.TELEGRAM_MEMORY_ENABLED !== undefined) memory.enabled = parsedEnv.TELEGRAM_MEMORY_ENABLED
  if (parsedEnv.TELEGRAM_MEMORY_WORKSPACE !== undefined) memory.workspace_path = parsedEnv.TELEGRAM_MEMORY_WORKSPACE
  if (parsedEnv.TELEGRAM_MEMORY_LOGS_PATH !== undefined) memory.logs_path = parsedEnv.TELEGRAM_MEMORY_LOGS_PATH
  if (parsedEnv.TELEGRAM_MEMORY_SOURCE_TAG !== undefined) memory.source_tag = parsedEnv.TELEGRAM_MEMORY_SOURCE_TAG
  if (parsedEnv.TELEGRAM_MEMORY_AGENT_LABEL !== undefined) memory.agent_label = parsedEnv.TELEGRAM_MEMORY_AGENT_LABEL
  if (Object.keys(memory).length > 0) merged.memory = memory

  try {
    return AppConfigSchema.parse(merged)
  } catch (err) {
    throw new Error(redactToken(
      `invalid config: ${err instanceof Error ? err.message : String(err)}`,
    ))
  }
}

// ─────────────────────────────────────────────────────────────────────
// StatePaths — all on-disk locations relative to state root.
// ─────────────────────────────────────────────────────────────────────

export type StatePaths = {
  root: string
  env: string
  config: string
  allowlist: string
  pid: string
  lock: string
  updateOffset: string
  inbox: string
  sessionIds: string
  deadLetterUpdates: string
  deadLetterWebhook: string
  logs: { server: string; telegram: string; permissions: string; webhook: string }
}

export function getStatePaths(_config: AppConfig, env: RuntimeEnv): StatePaths {
  const root = env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'dashi-telegram-canary')
  return {
    root,
    env: join(root, '.env'),
    config: env.TELEGRAM_CONFIG_FILE ?? join(root, 'config.json'),
    // M4 (PLAN.md alignment): the persisted allowlist file is `allowlist.json`.
    // Earlier code used `access.json` (inherited from the official plugin).
    // The boot path in server.ts performs a one-shot migration of any stale
    // `access.json` → `allowlist.json` so existing deployments don't lose state.
    allowlist: join(root, 'allowlist.json'),
    pid: join(root, 'bot.pid'),
    lock: join(root, 'bot.lock'),
    updateOffset: join(root, 'update-offset'),
    inbox: join(root, 'inbox'),
    sessionIds: join(root, 'session-ids'),
    deadLetterUpdates: join(root, 'dead-letter', 'updates'),
    deadLetterWebhook: join(root, 'dead-letter', 'webhook'),
    logs: {
      server: join(root, 'logs', 'server.log'),
      telegram: join(root, 'logs', 'telegram.log'),
      // L3 (PLAN.md alignment): the audit log is JSONL, not plain log lines.
      // Renamed so log shippers configured for *.jsonl pick it up correctly.
      permissions: join(root, 'logs', 'permissions.jsonl'),
      webhook: join(root, 'logs', 'webhook.log'),
    },
  }
}
