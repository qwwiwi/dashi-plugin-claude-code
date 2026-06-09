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

// Multichat config — opt-in fleet of per-chat tmux sessions routed by
// the MultichatRouter. Default OFF: the entire feature is gated behind
// `multichat.enabled = true` so existing deployments keep their legacy
// single-DM behaviour without touching wiring. When enabled, the policy
// file (`chats/policy.yaml`) defines per-chat allowlists, streaming
// modes, persona files, and deny rules — see src/chats/policy-loader.ts.
//
// Path defaults:
//   policy_path  -> `{workspace_dir}/chats/policy.yaml`
//   state_dir    -> `{workspace_dir}/state/multichat`
//   workspace_dir -> $CLAUDE_WORKSPACE_DIR, else `path.resolve(cwd, '..')`
// All three are pure strings here so unit tests can assert what the
// caller passed without invoking server.ts. The resolution itself
// happens inside server.ts where `path` is already imported.
export const MultichatConfigSchema = z.object({
  enabled: z.boolean().default(false),
  policy_path: z.string().optional(),
  state_dir: z.string().optional(),
  workspace_dir: z.string().optional(),
})
export type MultichatConfig = z.infer<typeof MultichatConfigSchema>

export const AppConfigSchema = z.object({
  bot_id: z.number().int().positive().default(8507713167),
  // `dm_only` predates the multichat router. With `multichat.enabled=false`
  // (default) the legacy gate.ts behaviour is preserved: DM-only with
  // hardcoded drop in the gate. With `multichat.enabled=true` the gate
  // consults the loaded policy instead and this flag is effectively
  // ignored. Kept here for backward compatibility with existing
  // config.json files; do NOT remove without a migration pass.
  dm_only: z.boolean().default(true),
  allowed_user_ids: z.array(z.number().int().positive()).min(1).default([164795011]),
  allowed_chat_ids: z.array(z.union([z.number(), z.string()])).default([164795011]),
  workspace_root: z.string().optional(),
  // 2026-06-09 duplicate-windows fix: StatusManager and ProgressReporter
  // both defaulted ON, so a fresh install with hooks registered rendered two
  // hook-driven «working/running» Telegram windows next to the tmux mirror.
  // Exactly one progress surface should be a deliberate operator choice —
  // both hook-driven reporters are now opt-in (config.json / state config).
  status: z.object({
    enabled: z.boolean().default(false),
    interval_ms: z.number().int().positive().default(700),
    ttl_ms: z.number().int().positive().default(300_000),
    delete_on_complete: z.boolean().default(true),
    // Warchief request 2026-05-27: the bare «Печатает...» bubble is visual
    // noise on top of the TmuxMirror status card. When true, StatusManager
    // skips the initial sendMessage while state is `typing` — the bubble is
    // created lazily on the first thinking/tool/activity transition. Native
    // sendChatAction (header animation) is unaffected.
    suppress_typing_bubble: z.boolean().default(true),
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
    enabled: z.boolean().default(false),
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
    // tmux socket name (`tmux -L <name>`). Empty = default socket. Needed
    // when the channel unit runs its session on a dedicated socket (two
    // Type=forking channel units on one host race at boot on the default
    // socket) — capture-pane must address the same socket or it finds
    // nothing (Arthas migration, 2026-06-05).
    socket_name: z.string().default(''),
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
  // Multichat router (Phase 3, 2026-05-23). Default OFF. When enabled,
  // server.ts loads `chats/policy.yaml`, instantiates TmuxSessionPool +
  // MultichatRouter, and routes inbound traffic through them. Schema
  // declared above AppConfigSchema so the type can be re-exported.
  multichat: MultichatConfigSchema.default({}),
  // AskUserQuestion relay (Phase ?, 2026-05-27, PRX-1 TASK-6). Bridges
  // Claude Code's native AskUserQuestion tool requests into Telegram so
  // the warchief can answer from his phone while a session runs headless.
  //
  // Default OFF: until a smoke run on staging proves the round-trip,
  // AskUserQuestion still flows through the native Claude Code UI and
  // the relay stays dormant. Flip `enabled=true` once TASK-1..TASK-5
  // are wired and the audit JSONL is healthy.
  //
  // `allowed_user_ids` left undefined means «inherit from permission_relay
  // at runtime» — TASK-1 / TASK-3 must resolve `?? permission_relay
  // .allowed_user_ids` at the moment they need a recipient set. We
  // deliberately do NOT copy the default here: duplicating the warchief
  // id would create two sources of truth that can drift. The fallback
  // is enforced in code (see resolveAskUserQuestionAllowedUserIds below)
  // so a single change to permission_relay.allowed_user_ids propagates
  // to AskUserQuestion automatically.
  //
  // `timeout_ms` caps how long the relay waits for a Telegram answer
  // before emitting a `request_timeout` event and letting Claude fall
  // back to its native flow. 5 min matches typical warchief response
  // latency without leaving stale callbacks behind.
  //
  // `max_preview_chars` bounds the per-option preview rendered in the
  // Telegram question card. Claude's option.preview can be long; this
  // truncates per-option content before grammy formats the message.
  ask_user_question: z.object({
    enabled: z.boolean().default(false),
    timeout_ms: z.number().int().positive().default(300_000),
    allowed_user_ids: z.array(z.number().int().positive()).optional(),
    max_preview_chars: z.number().int().positive().default(1000),
  }).default({}),
  // Permission gate (2026-06-09) — the INTERACTIVE confirm relay for the
  // warchief's bypassPermissions DM session. The PreToolUse hook
  // (scripts/permission-gate-hook.ts) classifies every tool call; `confirm`
  // tier POSTs /hooks/permission/request, and this relay sends an Allow/Deny
  // keyboard to Telegram. Distinct from `permission_relay` (the headless MCP
  // `--permission-prompt-tool` path that never fires interactively).
  //
  // Default OFF: dormant until activation (flip bypassPermissions + register
  // the hook + restart channel-thrall). While off, the HTTP route answers
  // 503 and the hook's confirm tier fails closed to deny.
  //
  // `timeout_ms` caps how long the relay waits for a tap before fail-closing
  // to deny — 2 min keeps a forgotten prompt from pinning a tool call for the
  // hook's whole HTTP window.
  //
  // `allowed_user_ids` omitted → inherit permission_relay.allowed_user_ids
  // (single source of truth; see resolvePermissionGateAllowedUserIds).
  permission_gate: z.object({
    enabled: z.boolean().default(false),
    timeout_ms: z.number().int().positive().default(120_000),
    allowed_user_ids: z.array(z.number().int().positive()).optional(),
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
  // CSV of chat ids; entries may be integers (user/group/channel id, possibly
  // negative for supergroups) or @username strings. In a Telegram DM
  // `chat.id == user.id`, so a DM-only deployment typically sets this to the
  // same value as TELEGRAM_ALLOWED_USER_IDS — without this, gate.ts:
  // chat_not_allowed silently drops every inbound DM.
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().optional(),
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
  // Multichat (Phase 3, 2026-05-23). ENABLED accepts the same truthy
  // strings as TELEGRAM_MEMORY_ENABLED so the two flags share a mental
  // model. Paths are passed through verbatim — server.ts resolves
  // defaults relative to workspace_dir.
  TELEGRAM_MULTICHAT_ENABLED: z
    .string()
    .transform((v) => /^(1|true|yes|on)$/i.test(v))
    .optional(),
  TELEGRAM_MULTICHAT_POLICY_PATH: z.string().optional(),
  TELEGRAM_MULTICHAT_STATE_DIR: z.string().optional(),
  TELEGRAM_MULTICHAT_WORKSPACE_DIR: z.string().optional(),
  // AskUserQuestion relay (PRX-1 TASK-6, 2026-05-27). ENABLED follows the
  // same truthy convention as the multichat/memory flags so operators
  // memorise one mental model. ALLOWED_USER_IDS is CSV (parsed below with
  // a stricter parser than z.coerce — negative / non-integer / empty
  // entries must throw clearly, not silently coerce to NaN).
  TELEGRAM_ASK_USER_QUESTION_ENABLED: z
    .string()
    .transform((v) => /^(1|true|yes|on)$/i.test(v))
    .optional(),
  TELEGRAM_ASK_USER_QUESTION_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  TELEGRAM_ASK_USER_QUESTION_ALLOWED_USER_IDS: z.string().optional(), // CSV
  TELEGRAM_ASK_USER_QUESTION_MAX_PREVIEW_CHARS: z.coerce.number().int().positive().optional(),
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

// Chat ids are heterogeneous: groups/supergroups are negative ints, users
// are positive ints, channels can be referenced as @username strings. We
// keep @-prefixed entries as strings and require everything else to be a
// non-zero integer.
function parseCsvChatIds(csv: string): Array<number | string> {
  const ids: Array<number | string> = []
  for (const raw of csv.split(',')) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('@')) {
      ids.push(trimmed)
      continue
    }
    const n = Number(trimmed)
    if (!Number.isInteger(n) || n === 0) {
      throw new Error(`invalid chat id in CSV: ${JSON.stringify(trimmed)}`)
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
  if (parsedEnv.TELEGRAM_ALLOWED_CHAT_IDS !== undefined) {
    merged.allowed_chat_ids = parseCsvChatIds(parsedEnv.TELEGRAM_ALLOWED_CHAT_IDS)
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

  // Multichat env overrides (Phase 3, 2026-05-23). Same pattern as the
  // memory block: take an existing config.json sub-object if present,
  // layer env on top, and only emit the sub-object when something is set
  // — leaving it undefined lets Zod apply schema defaults cleanly.
  const multichat = (merged.multichat && typeof merged.multichat === 'object' ? merged.multichat : {}) as Record<string, unknown>
  if (parsedEnv.TELEGRAM_MULTICHAT_ENABLED !== undefined) multichat.enabled = parsedEnv.TELEGRAM_MULTICHAT_ENABLED
  if (parsedEnv.TELEGRAM_MULTICHAT_POLICY_PATH !== undefined) multichat.policy_path = parsedEnv.TELEGRAM_MULTICHAT_POLICY_PATH
  if (parsedEnv.TELEGRAM_MULTICHAT_STATE_DIR !== undefined) multichat.state_dir = parsedEnv.TELEGRAM_MULTICHAT_STATE_DIR
  if (parsedEnv.TELEGRAM_MULTICHAT_WORKSPACE_DIR !== undefined) multichat.workspace_dir = parsedEnv.TELEGRAM_MULTICHAT_WORKSPACE_DIR
  if (Object.keys(multichat).length > 0) merged.multichat = multichat

  // AskUserQuestion env overrides (PRX-1 TASK-6, 2026-05-27). Same layering
  // pattern as the multichat block above.
  const askUserQuestion = (merged.ask_user_question && typeof merged.ask_user_question === 'object'
    ? merged.ask_user_question
    : {}) as Record<string, unknown>
  if (parsedEnv.TELEGRAM_ASK_USER_QUESTION_ENABLED !== undefined) {
    askUserQuestion.enabled = parsedEnv.TELEGRAM_ASK_USER_QUESTION_ENABLED
  }
  if (parsedEnv.TELEGRAM_ASK_USER_QUESTION_TIMEOUT_MS !== undefined) {
    askUserQuestion.timeout_ms = parsedEnv.TELEGRAM_ASK_USER_QUESTION_TIMEOUT_MS
  }
  if (parsedEnv.TELEGRAM_ASK_USER_QUESTION_ALLOWED_USER_IDS !== undefined) {
    askUserQuestion.allowed_user_ids = parseCsvUserIds(parsedEnv.TELEGRAM_ASK_USER_QUESTION_ALLOWED_USER_IDS)
  }
  if (parsedEnv.TELEGRAM_ASK_USER_QUESTION_MAX_PREVIEW_CHARS !== undefined) {
    askUserQuestion.max_preview_chars = parsedEnv.TELEGRAM_ASK_USER_QUESTION_MAX_PREVIEW_CHARS
  }
  if (Object.keys(askUserQuestion).length > 0) merged.ask_user_question = askUserQuestion

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
  logs: {
    server: string
    telegram: string
    permissions: string
    webhook: string
    /**
     * AskUserQuestion relay audit JSONL (PRX-1 TASK-6, 2026-05-27).
     * Event types written by TASK-1: `request_created`, `request_answered`,
     * `request_timeout`, `request_unauthorized`, `request_duplicate`.
     * Path is exposed here; TASK-1 is the only writer.
     */
    ask_user_question: string
    /**
     * Permission-gate relay audit JSONL (2026-06-09). Event types:
     * `request_created`, `request_resolved`. Written by the webhook route.
     */
    permission_gate: string
  }
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
      ask_user_question: join(root, 'logs', 'ask-user-question.jsonl'),
      permission_gate: join(root, 'logs', 'permission-gate.jsonl'),
    },
  }
}

// ─────────────────────────────────────────────────────────────────────
// resolveAskUserQuestionAllowedUserIds — single source of truth for the
// AskUserQuestion recipient set. When the operator omits
// `ask_user_question.allowed_user_ids` in config.json / env, the relay
// inherits `permission_relay.allowed_user_ids`. Callers (TASK-1 state
// machine, TASK-3 HTTP routes) MUST go through this helper rather than
// reading the raw field, so a single change to permission_relay
// propagates automatically and the two lists can never drift.
//
// The optional `log` argument lets boot code emit a single line noting
// whether the fallback fired — useful in tests (spy on the logger) and
// in prod (operator sees the resolved set in server.log on startup).
// ─────────────────────────────────────────────────────────────────────

export interface AllowedUserIdsLogger {
  info: (msg: string, fields?: Record<string, unknown>) => void
}

export function resolveAskUserQuestionAllowedUserIds(
  config: AppConfig,
  log?: AllowedUserIdsLogger,
): readonly number[] {
  const explicit = config.ask_user_question.allowed_user_ids
  if (explicit !== undefined) {
    if (log) {
      log.info('ask_user_question: using explicit allowed_user_ids', {
        count: explicit.length,
        fallback: false,
      })
    }
    return explicit
  }
  const inherited = config.permission_relay.allowed_user_ids
  if (log) {
    log.info('ask_user_question: allowed_user_ids unset, inheriting from permission_relay', {
      count: inherited.length,
      fallback: true,
    })
  }
  return inherited
}

// ─────────────────────────────────────────────────────────────────────
// resolvePermissionGateAllowedUserIds — single source of truth for the
// permission-gate Allow/Deny answerer set. Same inheritance contract as
// AskUserQuestion: explicit `permission_gate.allowed_user_ids` wins,
// otherwise inherit `permission_relay.allowed_user_ids`. This set
// authorizes both who the prompt is sent to (DM chat == first id) and who
// may resolve it.
// ─────────────────────────────────────────────────────────────────────

export function resolvePermissionGateAllowedUserIds(
  config: AppConfig,
  log?: AllowedUserIdsLogger,
): readonly number[] {
  const explicit = config.permission_gate.allowed_user_ids
  if (explicit !== undefined) {
    if (log) log.info('permission_gate: using explicit allowed_user_ids', { count: explicit.length, fallback: false })
    return explicit
  }
  const inherited = config.permission_relay.allowed_user_ids
  if (log) log.info('permission_gate: allowed_user_ids unset, inheriting from permission_relay', { count: inherited.length, fallback: true })
  return inherited
}
