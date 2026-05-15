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
  format: z.enum(['text', 'markdownv2', 'html']).optional(),
})
export type ReplyArgs = z.infer<typeof ReplyArgsSchema>

// Tool args - react
export const ReactArgsSchema = z.object({
  chat_id: z.string().min(1),
  message_id: z.string().min(1),
  emoji: z.string().min(1),
})
export type ReactArgs = z.infer<typeof ReactArgsSchema>

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
