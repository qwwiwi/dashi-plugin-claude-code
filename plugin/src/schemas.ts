// Zod schemas for Telegram channel plugin.
// Wire-level and tool-arg shapes that are validated at boundaries.

import { z } from 'zod'

// Bot identity (from getMe)
export const BotIdentitySchema = z.object({
  id: z.number().int().positive(),
  username: z.string(),
  is_bot: z.literal(true),
})
export type BotIdentity = z.infer<typeof BotIdentitySchema>

// Tool args - reply
export const ReplyArgsSchema = z.object({
  chat_id: z.string().min(1),
  text: z.string().min(1),
  reply_to: z.string().optional(),
  files: z.array(z.string()).optional(),
  // Default 'html' — markdown (**bold**, headings, tables, ```code```) is
  // converted to Telegram's HTML subset via markdownToTelegramHtml. Plain
  // text without markdown markers passes through unchanged. Pass 'text'
  // explicitly only when the caller needs a literal `<` / `>` / `&` in
  // the body (rare). Inspired by openclaw/extensions/telegram (MIT).
  format: z.enum(['text', 'markdownv2', 'html']).default('html'),
})
export type ReplyArgs = z.infer<typeof ReplyArgsSchema>

// Tool args - react
export const ReactArgsSchema = z.object({
  chat_id: z.string().min(1),
  message_id: z.string().min(1),
  emoji: z.string().min(1),
})
export type ReactArgs = z.infer<typeof ReactArgsSchema>

// Webhook route body - POST /hooks/react (read-receipt hook → plugin).
// The read-receipt Stop hook posts here once per inbound message it has
// actually read in a turn, so `👀` deterministically means "the agent read
// this through the plugin" rather than "the bot received it". message_id is
// coerced from a numeric string because hook payloads carry it as text.
// emoji defaults to 👀 so the common read-receipt call body is just
// {chat_id, message_id}.
export const ReactRouteRequestSchema = z.object({
  chat_id: z.string().min(1),
  message_id: z.coerce.number().int().positive(),
  emoji: z.string().min(1).default('👀'),
})
export type ReactRouteRequest = z.infer<typeof ReactRouteRequestSchema>

// Webhook route body - POST /hooks/fallback-reply (DM fallback Stop hook →
// plugin). 2026-06-03. The warchief's DM session normally replies through the
// `mcp__dashi-channel__reply` MCP tool. When a turn ends WITHOUT having sent
// such a reply, the fallback-reply Stop hook posts the turn's final assistant
// text here so it still reaches his Telegram. chat_id is a numeric string
// (matching the inbound `<channel ... chat_id="...">`), groups are negative.
// text is bounded at Telegram's 4096-char sendMessage cap.
export const FallbackReplyRouteRequestSchema = z.object({
  chat_id: z.string().regex(/^-?\d+$/),
  text: z.string().min(1).max(4096),
})
export type FallbackReplyRouteRequest = z.infer<typeof FallbackReplyRouteRequestSchema>

// Tool args - download_attachment. chat_id is required so the tool can
// gate the download through the chat allowlist — without it, Claude could
// be tricked into fetching an arbitrary file_id (e.g. one leaked into a
// prompt) that never originated from an allowlisted chat.
export const DownloadAttachmentArgsSchema = z.object({
  chat_id: z.string().min(1),
  file_id: z.string().min(1),
})
export type DownloadAttachmentArgs = z.infer<typeof DownloadAttachmentArgsSchema>

// Tool args - edit_message
export const EditMessageArgsSchema = z.object({
  chat_id: z.string().min(1),
  message_id: z.string().min(1),
  text: z.string().min(1),
  format: z.enum(['text', 'markdownv2']).optional(),
})
export type EditMessageArgs = z.infer<typeof EditMessageArgsSchema>

// Tool args - status (T11 wires this).
//   state: which status label to render next.
//   tool_name: required when state='tool', renders as `🔧 <name>`.
//   reason: optional context for stopped/error.
//   chat_id: which active status to update. If absent we fail with a clear
//     error — the agent must pass it from the inbound <channel> meta.
export const StatusArgsSchema = z.object({
  chat_id: z.string().min(1),
  state: z.enum(['typing', 'thinking', 'tool', 'stopped', 'error']),
  tool_name: z.string().min(1).optional(),
  reason: z.string().optional(),
})
export type StatusArgs = z.infer<typeof StatusArgsSchema>

// Webhook payload for /hooks/agent — message variant.
// Today's `/hooks/agent` callers post `{ message, chatId, agentId? }` and the
// server forwards content as a channel notification (gateway.py:3531-3589 path).
export const WebhookMessagePayloadSchema = z.object({
  message: z.string().min(1).max(64 * 1024),
  chatId: z.union([z.number(), z.string()]).transform((v) => String(v)),
  agentId: z.string().optional(),
})
export type WebhookMessagePayload = z.infer<typeof WebhookMessagePayloadSchema>

// Common fields every Claude Code hook payload carries. Claude doesn't know
// which Telegram chat to update, so the plugin requires `chatId` as part of
// the same envelope — same gate as the message variant.
const ClaudeHookCommonShape = {
  chatId: z.union([z.number(), z.string()]).transform((v) => String(v)),
  agentId: z.string().optional(),
  session_id: z.string().min(1),
  transcript_path: z.string().min(1),
  cwd: z.string().min(1),
  permission_mode: z.string().optional(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
} as const

// Tool input is an opaque record per Claude hook spec; renderer reads explicit
// keys only and never embeds the raw object. `passthrough` keeps unknown
// fields from Claude (Bash `description`, `run_in_background`, etc.) usable
// downstream without forcing schema churn on every Claude version bump.
const ToolInputSchema = z.record(z.unknown())

// TodoWrite tool_input shape. Used by TaskMirror to render Claude's
// in-progress / pending / completed milestone list as a rolling Telegram
// thread. The wire `ClaudePostToolUseSchema.tool_input` stays as the
// permissive `ToolInputSchema` (opaque record) so we don't reject unknown
// TodoWrite shape variants at the webhook boundary — instead, the mapper
// in `src/hooks/claude-events.ts` calls `TodoWriteInputSchema.safeParse`
// on `tool_input` when `tool_name === 'TodoWrite'` and degrades gracefully
// when parsing fails.
//
// `.passthrough()` is mandatory on both schemas so the Claude Code harness
// can add fields (e.g. metadata, scheduling hints) without breaking parsing.
export const TodoItemSchema = z
  .object({
    id: z.string().optional(),
    content: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed']),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    activeForm: z.string().optional(),
  })
  .passthrough()
export type TodoItem = z.infer<typeof TodoItemSchema>

export const TodoWriteInputSchema = z
  .object({
    todos: z.array(TodoItemSchema),
  })
  .passthrough()
export type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>

// Newer Claude Code harness uses TaskCreate/TaskUpdate/TaskList instead of a
// single TodoWrite tool. The shapes below capture only the fields TaskMirror
// renders; passthrough preserves the rest (metadata, owner, etc.) without
// fragilising the parse on harness version bumps. `taskId` on TaskUpdate is
// always a string in the harness output but we coerce defensively so a
// numeric id from a future version still parses.
export const TaskCreateInputSchema = z
  .object({
    subject: z.string().min(1),
    description: z.string().optional(),
    activeForm: z.string().optional(),
  })
  .passthrough()
export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>

export const TaskUpdateInputSchema = z
  .object({
    taskId: z.union([z.string(), z.number()]).transform((v) => String(v)),
    status: z
      .enum(['pending', 'in_progress', 'completed', 'deleted'])
      .optional(),
    subject: z.string().optional(),
    description: z.string().optional(),
    activeForm: z.string().optional(),
  })
  .passthrough()
export type TaskUpdateInput = z.infer<typeof TaskUpdateInputSchema>

export const ClaudePreToolUseSchema = z
  .object({
    ...ClaudeHookCommonShape,
    hook_event_name: z.literal('PreToolUse'),
    tool_name: z.string().min(1),
    tool_use_id: z.string().min(1),
    tool_input: ToolInputSchema,
  })
  .passthrough()

export const ClaudePostToolUseSchema = z
  .object({
    ...ClaudeHookCommonShape,
    hook_event_name: z.literal('PostToolUse'),
    tool_name: z.string().min(1),
    tool_use_id: z.string().min(1),
    tool_input: ToolInputSchema,
    tool_result: z.unknown().optional(),
  })
  .passthrough()

export const ClaudeStopSchema = z
  .object({
    ...ClaudeHookCommonShape,
    hook_event_name: z.literal('Stop'),
    effort: z.unknown().optional(),
  })
  .passthrough()

export const ClaudeUserPromptSubmitSchema = z
  .object({
    ...ClaudeHookCommonShape,
    hook_event_name: z.literal('UserPromptSubmit'),
    // We require prompt to validate Claude's contract but the renderer must
    // never display it (private to the user → leaking into Telegram would
    // double-broadcast the question that triggered the agent).
    prompt: z.string(),
  })
  .passthrough()

export const ClaudeSessionStartSchema = z
  .object({
    ...ClaudeHookCommonShape,
    hook_event_name: z.literal('SessionStart'),
    source: z.enum(['startup', 'resume', 'clear', 'compact']).optional(),
    model: z.string().optional(),
  })
  .passthrough()

export const ClaudeHookPayloadSchema = z.discriminatedUnion('hook_event_name', [
  ClaudePreToolUseSchema,
  ClaudePostToolUseSchema,
  ClaudeStopSchema,
  ClaudeUserPromptSubmitSchema,
  ClaudeSessionStartSchema,
])
export type ClaudeHookPayload = z.infer<typeof ClaudeHookPayloadSchema>

// Unified webhook payload. Transform tags the variant so `server.ts` can
// branch without re-sniffing fields.
//
// Discriminator: presence of `hook_event_name` selects the Claude hook
// schema; everything else falls through to message. We pre-check at the
// schema boundary instead of relying on `z.union` evaluation order — the
// message schema has very permissive optional fields, so a payload like
// `{ message, chatId, hook_event_name }` would otherwise match message
// first and silently drop the hook fields (review §3).
export const WebhookPayloadSchema = z.preprocess(
  (raw) => raw,
  z.unknown(),
).transform((value, ctx) => {
  // Empty / non-object payloads fall through to message validation so the
  // existing "missing required" 400 path still fires with a helpful summary.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    const parsed = WebhookMessagePayloadSchema.safeParse(value)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue(issue)
      return z.NEVER
    }
    return { kind: 'message' as const, ...parsed.data }
  }
  const obj = value as Record<string, unknown>
  if (typeof obj.hook_event_name === 'string') {
    const parsed = ClaudeHookPayloadSchema.safeParse(obj)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue(issue)
      return z.NEVER
    }
    return { kind: 'claude_hook' as const, ...parsed.data }
  }
  const parsed = WebhookMessagePayloadSchema.safeParse(obj)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue(issue)
    return z.NEVER
  }
  return { kind: 'message' as const, ...parsed.data }
})
export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>

// Telegram Update — minimal runtime guard before dispatch.
// PLAN.md:580 requires runtime validation + dead-letter on validation
// failure so a malformed update can't crash the dispatcher loop or get
// looped over forever. We assert only the fields downstream actually
// reads from (`update_id` required, one of message/edited_message/
// callback_query present). `.passthrough()` lets unknown fields ride
// through so future Telegram additions don't trip validation.
export const TelegramUpdateSchema = z
  .object({
    update_id: z.number().int(),
    message: z.unknown().optional(),
    edited_message: z.unknown().optional(),
    channel_post: z.unknown().optional(),
    edited_channel_post: z.unknown().optional(),
    callback_query: z.unknown().optional(),
  })
  .passthrough()
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>

// Permission notification (incoming from Claude Code)
export const PermissionRequestParamsSchema = z.object({
  request_id: z.string().regex(/^[a-km-z]{5}$/i),
  tool_name: z.string(),
  description: z.string(),
  input_preview: z.string().max(200),
})
export type PermissionRequestParams = z.infer<typeof PermissionRequestParamsSchema>

// ─────────────────────────────────────────────────────────────────────
// AskUserQuestion HTTP relay (PRX-1 TASK-3, 2026-05-27).
//
// Shapes mirror the Claude Code AskUserQuestion tool_input plus the
// transport-only fields the hook wrapper adds (session_id, tool_use_id,
// transcript_path, timeout_ms). Constraints below are intentionally
// strict so a malformed `/request` payload returns a clean 400 instead
// of being silently coerced into a degenerate prompt that wastes the
// warchief's attention.
//
// Caps come from CC docs (1..4 questions, 2..4 options/question) and
// the body-limit budget reserved for AskUserQuestion (~64 KB). Total
// JSON payload size is enforced separately at the HTTP layer (the
// generic 256 KB cap; the per-route 64 KB check lives in server.ts so
// we can short-circuit before paying Zod's parse cost on giant blobs).
// ─────────────────────────────────────────────────────────────────────

export const AskUserQuestionOptionSchema = z.object({
  label: z.string().min(1).max(200),
  description: z.string().min(1).max(1000),
  // Preview is optional per CC's AskUserQuestion contract — when absent
  // TASK-2 renders only label + description. Cap mirrors the upper
  // bound on `max_preview_chars` we'd realistically configure in
  // ask_user_question.max_preview_chars (1000 default → 8000 hard cap).
  preview: z.string().max(8000).optional(),
})
export type AskUserQuestionOption = z.infer<typeof AskUserQuestionOptionSchema>

export const AskUserQuestionItemSchema = z.object({
  question: z.string().min(1).max(2000),
  header: z.string().min(1).max(200),
  multiSelect: z.boolean(),
  options: z.array(AskUserQuestionOptionSchema).min(2).max(4),
})
export type AskUserQuestionItem = z.infer<typeof AskUserQuestionItemSchema>

export const AskUserQuestionRequestSchema = z.object({
  session_id: z.string().min(1).max(200),
  tool_use_id: z.string().min(1).max(200),
  transcript_path: z.string().max(2048).optional(),
  // Optional override; server clamps against config.ask_user_question.timeout_ms.
  timeout_ms: z.number().int().positive().max(60 * 60 * 1000).optional(),
  questions: z.array(AskUserQuestionItemSchema).min(1).max(4),
})
export type AskUserQuestionRequest = z.infer<typeof AskUserQuestionRequestSchema>

// Short-id regex shared with the permission relay — keeps audit grep
// patterns uniform. `SHORT_ID_RE` itself lives in channel/short-id.ts;
// we duplicate it here as a Zod-side guard so the schema fails fast.
const SHORT_ID_PATTERN = /^[a-km-z]{5}$/

// Index caps mirror AskUserQuestionRequestSchema: questions.min(1).max(4)
// and options.min(2).max(4). Indices are 0-based ⇒ max valid index = 3.
// A wider cap (the original .max(10)) would accept indices that can only
// ever index out of range, wasting a relay round-trip and polluting the
// audit log with rejected callbacks (Codex webhook #5).
export const AskUserQuestionAnswerSchema = z.object({
  request_id: z.string().regex(SHORT_ID_PATTERN, 'must be a 5-letter short id'),
  action: z.enum(['choose', 'toggle', 'done', 'other']),
  question_index: z.number().int().min(0).max(3).optional(),
  selected_option_index: z.number().int().min(0).max(3).optional(),
  selected_label: z.string().min(1).max(2000).optional(),
  user_id: z.number().int().positive(),
  // Coerce numeric chat ids (Telegram returns numbers for callback
  // `chat.id`) to string before length-check so callers can post
  // either form. Matches the WebhookMessagePayloadSchema convention.
  chat_id: z.union([z.number(), z.string()])
    .transform((v) => String(v))
    .refine((v) => v.length <= 64, { message: 'chat_id too long' })
    .optional(),
})
export type AskUserQuestionAnswer = z.infer<typeof AskUserQuestionAnswerSchema>
