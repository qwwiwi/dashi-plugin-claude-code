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
  // ProgressReporter (2026-05-18) — persistent Telegram thread that shows
  // tool-by-tool activity in real time. StatusManager owns the transient
  // status bubble; ProgressReporter owns a separate, persistent thread
  // edited via editMessageText. Two surfaces, two concerns. Disable here
  // to fall back to silent-then-final UX.
  //
  // session_ttl_ms guards against stuck entries when a `session_stop`
  // hook is lost (Claude crash, dropped webhook). After this idle period
  // the next event for the chat starts a fresh progress thread instead
  // of editing into the old (now stale) message.
  //
  // recent_buffer aligned with StatusManager.ACTIVITY_MAX_BUFFER (10)
  // so the two surfaces report the same "+N earlier" tail count.
  progress: z.object({
    enabled: z.boolean().default(true),
    edit_throttle_ms: z.number().int().nonnegative().default(3000),
    recent_buffer: z.number().int().positive().default(10),
    session_ttl_ms: z.number().int().positive().default(10 * 60 * 1000),
  }).default({}),
  // TaskMirror (PR-A2, 2026-05-20) — third rolling Telegram message per chat,
  // showing Claude's TodoWrite milestones (in-progress / pending / completed).
  // Coexists with StatusManager bubble and ProgressReporter activity thread —
  // never shares state. Single-slot queue + throttle + TTL exactly mirror
  // ProgressReporter so behaviour stays predictable.
  //
  // collapse_completed_after: keep last N completed items in the rendered
  // list, older ones collapse to «+M завершено ранее» — the warchief wants
  // to see the active milestone, not a wall of done items.
  task_mirror: z.object({
    enabled: z.boolean().default(true),
    edit_throttle_ms: z.number().int().nonnegative().default(3000),
    session_ttl_ms: z.number().int().positive().default(10 * 60 * 1000),
    collapse_completed_after: z.number().int().nonnegative().default(5),
  }).default({}),
  // InboundWatcher (PR-A3, 2026-05-20) — auto-reply «Тралл занят» when the
  // warchief sends plain text while a Claude session is mid-tool. Debounced
  // per chat (debounce_ms = 10s by default) so a burst of messages doesn't
  // bury the conversation in auto-acks. Busy threshold is the ProgressReporter
  // lastActivityMs window — anything more recent than busy_threshold_ms
  // counts as «still working».
  //
  // The watcher NEVER replaces the channel notification — it auto-replies
  // AND lets the original message flow to Claude through the normal path.
  watcher: z.object({
    enabled: z.boolean().default(true),
    debounce_ms: z.number().int().nonnegative().default(10_000),
    busy_threshold_ms: z.number().int().positive().default(30_000),
  }).default({}),
  // TmuxMirror (2026-05-20) — read-only view of the agent's terminal pane
  // mirrored into one rolling Telegram message via editMessageText. Pulls
  // `tmux capture-pane` on a timer, dedups by hash, and self-heals when
  // the message is deleted (re-sends on next poll).
  //
  // Default-OFF: pane content can include unexpected secrets, and the
  // warchief should opt in explicitly. Enable via config.json or env.
  // pane_target follows the `session:window.pane` syntax — empty string
  // means «use the session in $TMUX env at startup».
  tmux_mirror: z.object({
    enabled: z.boolean().default(false),
    pane_target: z.string().default(''),
    poll_interval_ms: z.number().int().min(500).default(5000),
    line_count: z.number().int().min(5).max(500).default(50),
    // Segments to drop from the rendered mirror. Default hides the boot
    // banner (Claude Code splash + email + path), the inbound-injection
    // warning, the footer hints (bypass-perms, auto-update, focus-events,
    // /btw Tip line) AND the input box (the bordered prompt area —
    // ── separators + ❯/> cursor). `inbound_preview` stays visible by
    // default because `latest_inbound_only` mode anchors on it; hiding
    // it would silently turn the mode into a no-op (filter applies mode
    // BEFORE hide, but only `latest_inbound_only` survives that order —
    // see tmux-pane-filter.filterPane). Pass an empty list to mirror
    // raw pane content. Validated against the SegmentType enum to keep
    // typos out of production — bad values fail config load loud.
    hide_segments: z
      .array(
        z.enum([
          'boot_banner',
          'inbound_warning',
          'channel_status',
          'conversation',
          'footer_hints',
          'input_box',
          'inbound_preview',
        ]),
      )
      .default(['boot_banner', 'inbound_warning', 'footer_hints', 'input_box']),
    // Anchor mode for the rolling mirror. `latest_inbound_only` (default,
    // 2026-05-22) drops every pane segment up to and including the last
    // `← <channel>: …` preview Claude Code emitted — only what the agent
    // is doing AFTER the warchief's most recent message remains. Falls
    // back to `full_pane` automatically when no preview exists in the
    // current capture (fresh session). Set to `full_pane` to mirror the
    // whole pane (pre-2026-05-22 behaviour).
    mode: z.enum(['full_pane', 'latest_inbound_only']).default('latest_inbound_only'),
    // Max lines kept in the rendered mirror, post-filter. Default 14 —
    // empirically that fits one iPhone-screen worth of Telegram <pre>
    // content (the warchief asked for ≤70% screen height on 2026-05-22).
    // Truncation removes from the TOP (oldest), preserving the live
    // tail, and prepends a `… +N lines` marker that counts toward the
    // cap. Set to 0 to disable (uncapped, only the 4096-char body cap
    // in renderBody still applies). Codex review 2026-05-22 [medium]
    // tightened the allowed range to `0` or `4..100` — values 1..3
    // render only the marker plus 0..2 lines, which is degenerate and
    // not useful in production.
    max_lines: z
      .number()
      .int()
      .refine((n) => n === 0 || (n >= 4 && n <= 100), {
        message: 'max_lines must be 0 (disabled) or an integer in 4..100',
      })
      .default(14),
  }).default({}),
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
// Secret redaction. Thin wrapper over the unified `redactSecrets` (see
// src/safety/redact.ts). Kept here for back-compat with src/log.ts and
// src/server.ts — those still import `redactToken` by name. Anything
// new should import `redactSecrets` directly.
// ─────────────────────────────────────────────────────────────────────

import { redactSecrets } from './safety/redact.js'

export function redactToken(message: string, extraSecrets: ReadonlyArray<string> = []): string {
  return redactSecrets(message, extraSecrets)
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
