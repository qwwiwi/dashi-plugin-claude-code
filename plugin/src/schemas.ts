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

// Webhook payload for /hooks/agent
export const WebhookPayloadSchema = z.object({
  message: z.string().min(1).max(64 * 1024),
  chatId: z.union([z.number(), z.string()]).transform((v) => String(v)),
  agentId: z.string().optional(),
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
