// MCP tool surface for the Telegram channel.
//
// 5 tools: reply, react, download_attachment, edit_message, status.
// Status is currently a stub (returns not_implemented) — T11 will wire it.
//
// All tool args are validated through Zod schemas; we never reach into
// `req.params.arguments` with `as Record<string, unknown>` casts. If a
// schema rejects, we surface the Zod error as a tool error (isError: true)
// rather than throwing through the MCP layer.

import { Buffer } from 'buffer'
import { join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import type { Bot } from 'grammy'
import { InputFile } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { z } from 'zod'

import type { AppConfig, StatePaths } from '../config.js'
import type { Logger } from '../log.js'
import type { MultichatPolicy } from '../chats/policy-loader.js'
import type { StatusManager, StatusState } from '../status/status-manager.js'
import {
  DownloadAttachmentArgsSchema,
  EditMessageArgsSchema,
  ReactArgsSchema,
  ReplyArgsSchema,
  StatusArgsSchema,
} from '../schemas.js'
import { assertAllowedChat } from '../telegram/gate.js'
import {
  isTelegramHtmlParseError,
  markdownToTelegramHtml,
} from '../format/html.js'
import { splitMessage } from '../format/chunk.js'
import { assertSendableFile, isPhotoExtension } from '../security/paths.js'
import {
  buildRichMessagePayload,
  contentFitsRichLimits,
} from '../format/rich.js'
import type { RichLatch } from '../safety/rich-latch.js'

// ─────────────────────────────────────────────────────────────────────
// MCP request/response types we touch. We narrow rather than import deep
// SDK types because the SDK exports them only as generic Zod-inferred shapes
// and we want minimal coupling.
// ─────────────────────────────────────────────────────────────────────

export interface CallToolRequest {
  params: {
    name: string
    arguments?: unknown
  }
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface ToolContent {
  type: 'text'
  text: string
}

export interface CallToolResult {
  content: ToolContent[]
  isError?: boolean
}

// ─────────────────────────────────────────────────────────────────────
// Telegram API surface that tools consume. Defined as an interface so
// tests can stub without touching network.
// ─────────────────────────────────────────────────────────────────────

// Minimal shape we accept for an inline keyboard. Matches grammY's
// InlineKeyboard but kept structural so tests can stub without grammy.
export interface InlineKeyboardLike {
  inline_keyboard: { text: string; callback_data?: string }[][]
}

export interface SendMessageOpts {
  reply_to_message_id?: number
  parse_mode?: 'MarkdownV2' | 'HTML'
  reply_markup?: InlineKeyboardLike
}

export interface EditOpts {
  parse_mode?: 'MarkdownV2' | 'HTML'
  // PRX-1 TASK-2 (2026-05-27): inline keyboard mutation on edit. Needed by
  // the AskUserQuestion relay to re-render the multi-select question card
  // when a toggle button is pressed (text changes — `[ ]` → `[x]` — AND
  // the keyboard itself updates). Optional and additive: existing callers
  // (commands/oob, channel/tools edit_message) pass no reply_markup and
  // Telegram leaves the existing keyboard untouched.
  reply_markup?: InlineKeyboardLike
}

export interface SendDocumentOpts {
  reply_to_message_id?: number
  caption?: string
}

// Options for the rich-message send. Threading only for M1; M3/M4 extend.
export interface SendRichMessageOpts {
  reply_to_message_id?: number
}

// Result of a rich send. Either Telegram accepted it (we got a message_id)
// or the layered wrapper decided to fall back to the HTML path. `fallback`
// is the signal the reply tool reads to decide whether to also run the HTML
// chunk path — exactly one of the two ships, so a message is never lost or
// duplicated.
export type SendRichMessageResult = { message_id: number } | { fallback: true }

export interface DownloadResult {
  path: string
  mime?: string
  size?: number
}

export type ChatAction =
  | 'typing'
  | 'upload_photo'
  | 'record_video'
  | 'upload_video'
  | 'record_voice'
  | 'upload_voice'
  | 'upload_document'
  | 'choose_sticker'
  | 'find_location'
  | 'record_video_note'
  | 'upload_video_note'

export interface TelegramApi {
  sendMessage(chatId: string, text: string, opts: SendMessageOpts): Promise<{ message_id: number }>
  // Telegram Bot API 10.1 Rich Messages: ship RAW markdown that Telegram
  // renders server-side (tables/math/headings/task-lists/<details>/footnotes,
  // up to 32768 bytes). The result is either a message_id (sent) or
  // { fallback: true } (caller must use the HTML path instead). Implemented
  // via grammY's raw escape hatch; redaction runs in the safe wrapper BEFORE
  // the raw send — never call this from outside the layered chain.
  sendRichMessage(
    chatId: string,
    rawMarkdown: string,
    opts: SendRichMessageOpts,
  ): Promise<SendRichMessageResult>
  editMessageText(chatId: string, messageId: number, text: string, opts: EditOpts): Promise<void>
  setMessageReaction(chatId: string, messageId: number, emoji: string): Promise<void>
  sendChatAction(chatId: string, action: ChatAction): Promise<void>
  sendDocument(chatId: string, filePath: string, opts: SendDocumentOpts): Promise<{ message_id: number }>
  sendPhoto(chatId: string, filePath: string, opts: SendDocumentOpts): Promise<{ message_id: number }>
  downloadFile(fileId: string, destDir: string): Promise<DownloadResult>
  deleteMessage(chatId: string, messageId: number): Promise<void>
}

// grammY ^1.21.0 has no typed `sendRichMessage` on its RawApi (the method is
// newer than the bundled types). We reach it through the raw escape hatch
// `bot.api.raw`, narrowed to a typed function rather than `any`: the body is
// the RichMessageBody buildRichMessagePayload produces, and the response is
// the small shape we read message_id from (defensively — Telegram nests it
// under `result`, grammY usually unwraps to the top level).
interface RawSendRichResponse {
  message_id?: number
  result?: { message_id?: number }
}
type RawSendRichMessageFn = (
  body: Record<string, unknown>,
) => Promise<RawSendRichResponse>

// Thin wrapper around grammY bot.api. Keeps the rest of the system free of
// grammy-specific quirks (reply_parameters vs reply_to_message_id, etc).
export function createTelegramApi(bot: Bot, token: string): TelegramApi {
  return {
    async sendMessage(chatId, text, opts) {
      const other: Record<string, unknown> = {}
      if (opts.reply_to_message_id !== undefined) {
        other.reply_parameters = { message_id: opts.reply_to_message_id }
      }
      if (opts.parse_mode !== undefined) {
        other.parse_mode = opts.parse_mode
      }
      if (opts.reply_markup !== undefined) {
        other.reply_markup = opts.reply_markup
      }
      const sent = await bot.api.sendMessage(chatId, text, other)
      return { message_id: sent.message_id }
    },
    async sendRichMessage(chatId, rawMarkdown, opts) {
      // Build the raw-api body (chat_id + markdown + reply_parameters) and
      // dispatch through grammY's untyped raw escape hatch. The safe wrapper
      // already redacted `rawMarkdown`; this layer only transports it.
      const body = buildRichMessagePayload(rawMarkdown, {
        chat_id: chatId,
        ...(opts.reply_to_message_id !== undefined
          ? { reply_to_message_id: opts.reply_to_message_id }
          : {}),
      })
      // `bot.api.raw` is typed to known methods only; cast through unknown to
      // a typed function for the (still-untyped-in-grammY) sendRichMessage.
      const rawApi = bot.api.raw as unknown as Record<string, unknown>
      const sendRich = rawApi.sendRichMessage as RawSendRichMessageFn
      const res = await sendRich(body as unknown as Record<string, unknown>)
      // Parse message_id defensively: top-level (grammY-unwrapped) first,
      // then nested under `result` (raw Bot API envelope).
      const messageId = res.message_id ?? res.result?.message_id
      if (typeof messageId !== 'number') {
        throw new Error('sendRichMessage returned no message_id')
      }
      return { message_id: messageId }
    },
    async editMessageText(chatId, messageId, text, opts) {
      const other: Record<string, unknown> = {}
      if (opts.parse_mode !== undefined) other.parse_mode = opts.parse_mode
      if (opts.reply_markup !== undefined) other.reply_markup = opts.reply_markup
      await bot.api.editMessageText(chatId, messageId, text, other)
    },
    async setMessageReaction(chatId, messageId, emoji) {
      await bot.api.setMessageReaction(chatId, messageId, [
        { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
      ])
    },
    async sendChatAction(chatId, action) {
      await bot.api.sendChatAction(chatId, action)
    },
    async sendDocument(chatId, filePath, opts) {
      const other: Record<string, unknown> = {}
      if (opts.reply_to_message_id !== undefined) {
        other.reply_parameters = { message_id: opts.reply_to_message_id }
      }
      if (opts.caption !== undefined) other.caption = opts.caption
      const sent = await bot.api.sendDocument(chatId, new InputFile(filePath), other)
      return { message_id: sent.message_id }
    },
    async sendPhoto(chatId, filePath, opts) {
      const other: Record<string, unknown> = {}
      if (opts.reply_to_message_id !== undefined) {
        other.reply_parameters = { message_id: opts.reply_to_message_id }
      }
      if (opts.caption !== undefined) other.caption = opts.caption
      const sent = await bot.api.sendPhoto(chatId, new InputFile(filePath), other)
      return { message_id: sent.message_id }
    },
    async deleteMessage(chatId, messageId) {
      await bot.api.deleteMessage(chatId, messageId)
    },
    async downloadFile(fileId, destDir) {
      const file = await bot.api.getFile(fileId)
      if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop() ?? 'bin' : 'bin'
      const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
      const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
      const path = join(destDir, `${Date.now()}-${uniqueId}.${ext}`)
      mkdirSync(destDir, { recursive: true })
      writeFileSync(path, buf)
      return { path, size: buf.length }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────
// Tool definitions. Order is stable — Claude Code surfaces tools in
// listing order, and tests pin the order to catch accidental swaps.
// ─────────────────────────────────────────────────────────────────────

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'reply',
    description:
      'Reply on Telegram. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or documents.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        text: { type: 'string' },
        reply_to: {
          type: 'string',
          description: 'Message ID to thread under. Use message_id from the inbound <channel> block.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Absolute file paths to attach. Images send as photos (inline preview); other types as documents. Max 50MB each.',
        },
        format: {
          type: 'string',
          enum: ['text', 'markdownv2', 'html'],
          default: 'html',
          description:
            "Rendering mode. Default: 'html' — markdown (**bold**, *italic*, `code`, ```fenced```, [text](url), tables, # headings) is auto-converted to Telegram's HTML subset and auto-chunked at 4000 chars. Plain `<`, `>`, `&` in regular text are safe — they get auto-escaped before sending. On parse error the chunk re-sends as plain text so the reply still ships. Use 'text' only to bypass markdown conversion entirely (e.g. sending pre-built Telegram entity strings verbatim). 'markdownv2' passes raw — caller escapes per Telegram rules.",
        },
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'react',
    description:
      'Add an emoji reaction to a Telegram message. Telegram only accepts a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc) — non-whitelisted emoji will be rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        emoji: { type: 'string' },
      },
      required: ['chat_id', 'message_id', 'emoji'],
    },
  },
  {
    name: 'download_attachment',
    description:
      'Download a file attachment from a Telegram message to the local inbox. Use when the inbound <channel> meta shows attachment_file_id. Pass chat_id from the SAME inbound <channel> block so the tool can verify the file came from an allowlisted chat. Returns the local file path ready to Read. Telegram caps bot downloads at 20MB.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The chat_id from inbound meta' },
        file_id: { type: 'string', description: 'The attachment_file_id from inbound meta' },
      },
      required: ['chat_id', 'file_id'],
    },
  },
  {
    name: 'edit_message',
    description:
      "Edit a message the bot previously sent. Useful for interim progress updates. Edits don't trigger push notifications — send a new reply when a long task completes so the user's device pings.",
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        text: { type: 'string' },
        format: {
          type: 'string',
          enum: ['text', 'markdownv2'],
          description:
            "Rendering mode. 'markdownv2' enables Telegram formatting (bold, italic, code, links). Caller must escape special chars per MarkdownV2 rules. Default: 'text' (plain, no escaping needed).",
        },
      },
      required: ['chat_id', 'message_id', 'text'],
    },
  },
  {
    name: 'status',
    description:
      'Update or cancel the transient status line for an in-flight reply. Pass chat_id from the inbound <channel> meta. state controls the label: typing→"Печатает...", thinking→"Думает...", tool→"🔧 <tool_name>", stopped/error→short reason. Call this when you switch from thinking to running a tool, or when work is interrupted. The status message auto-deletes when the final reply ships.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        state: {
          type: 'string',
          enum: ['typing', 'thinking', 'tool', 'stopped', 'error'],
        },
        tool_name: {
          type: 'string',
          description: 'Required when state="tool". Renders as 🔧 <tool_name>.',
        },
        reason: {
          type: 'string',
          description: 'Optional short context for stopped/error states.',
        },
      },
      required: ['chat_id', 'state'],
    },
  },
]

export function listTools(): ToolDefinition[] {
  // Return a shallow copy so callers cannot mutate our canonical list.
  return TOOL_DEFINITIONS.map(t => ({ ...t }))
}

// ─────────────────────────────────────────────────────────────────────
// Tool dispatch
// ─────────────────────────────────────────────────────────────────────

export interface ToolDeps {
  config: AppConfig
  statePaths: StatePaths
  telegramApi: TelegramApi
  log: Logger
  statusManager: StatusManager
  // H4 fix (2026-05-23): when multichat is enabled, the policy is the
  // authoritative outbound allowlist. Omitted in legacy DM-only mode.
  policy?: MultichatPolicy
  // M1 rich messages (2026-06-14): session-scoped capability latch shared
  // with the safe-telegram-api wrapper. The reply handler reads
  // `sendDisabled` to skip rich attempts cheaply once a capability error has
  // latched it off. Optional so existing test fixtures that omit it keep the
  // legacy HTML-only behaviour (rich is then never attempted).
  richLatch?: RichLatch
}

// DM detection: a Telegram DM chat.id equals the user's id and is positive.
// Groups/supergroups/channels are negative. M1 ships rich messages to DMs
// only (groups are M4). Non-numeric / NaN ids fail closed (not a DM).
export function isDmChat(chatId: string): boolean {
  const n = Number(chatId)
  return Number.isFinite(n) && n > 0
}

function toolError(name: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `${name} failed: ${message}` }],
    isError: true,
  }
}

function zodErrorMessage(err: z.ZodError): string {
  return err.errors.map(e => `${e.path.join('.') || '<root>'}: ${e.message}`).join('; ')
}

export async function callTool(req: CallToolRequest, deps: ToolDeps): Promise<CallToolResult> {
  const { telegramApi, log, config, statePaths, statusManager } = deps
  const name = req.params.name
  const rawArgs: unknown = req.params.arguments ?? {}

  try {
    switch (name) {
      case 'reply': {
        const parsed = ReplyArgsSchema.safeParse(rawArgs)
        if (!parsed.success) return toolError(name, zodErrorMessage(parsed.error))
        const args = parsed.data
        try {
          assertAllowedChat(args.chat_id, config, deps.policy)
        } catch (err) {
          return toolError(name, err instanceof Error ? err.message : String(err))
        }
        const files = args.files ?? []

        // Resolve every attachment through the workspace gate up front, so a
        // file rejection never leaves a half-sent reply (text already shipped,
        // attachment then refused). Canonical paths come back from the gate
        // and we use those for sendDocument/sendPhoto below.
        const canonicalFiles: string[] = []
        for (const f of files) {
          try {
            canonicalFiles.push(assertSendableFile({ filePath: f, config }))
          } catch (err) {
            return toolError(name, err instanceof Error ? err.message : String(err))
          }
        }

        const replyToId = args.reply_to !== undefined ? Number(args.reply_to) : undefined

        const sentIds: number[] = []

        // ── M1 Rich Messages (Bot API 10.1) ─────────────────────────────
        // Attempt a single RAW-markdown rich send when ALL conditions hold.
        // On success we push the id and SKIP the HTML/text+chunk path. On a
        // transparent `{ fallback: true }` we fall through to the existing
        // HTML path UNCHANGED — exactly one path ships, so the reply is
        // never lost or duplicated. A `transient` error re-throws from the
        // safe wrapper (caught by the outer try) so we never silently
        // swallow then resend.
        const richLatch = deps.richLatch
        const richEligible =
          config.richMessages.enabled &&
          args.format !== 'text' &&
          args.format !== 'markdownv2' &&
          richLatch !== undefined &&
          !richLatch.sendDisabled &&
          !config.richMessages.perChatOptOut.includes(args.chat_id) &&
          files.length === 0 &&
          contentFitsRichLimits(args.text) &&
          isDmChat(args.chat_id)

        let richSent = false
        if (richEligible) {
          const richOpts: SendRichMessageOpts = {}
          if (replyToId !== undefined) richOpts.reply_to_message_id = replyToId
          const res = await telegramApi.sendRichMessage(args.chat_id, args.text, richOpts)
          if ('message_id' in res) {
            sentIds.push(res.message_id)
            richSent = true
          }
          // else res.fallback === true → fall through to the HTML path below.
        }

        if (richSent) {
          // Rich shipped the whole body — nothing else to send for text.
          // (Attachments are impossible here: richEligible required
          // files.length === 0.)
        } else if (args.format === 'html' || args.format === 'rich') {
          // HTML path (also the fallback for 'rich'): when rich was skipped
          // (disabled / non-DM / oversize / opted-out / has files) or fell
          // back transparently, render markdown → validated Telegram HTML.
          // Convert markdown → Telegram HTML, then chunk at 4000 chars so we
          // never exceed Telegram's 4096 sendMessage cap. reply_to applies
          // only to the first chunk so a long answer doesn't quote-spam the
          // user's original message N times.
          const rendered = markdownToTelegramHtml(args.text)
          const chunks = splitMessage(rendered)
          for (let i = 0; i < chunks.length; i++) {
            const chunkOpts: SendMessageOpts = { parse_mode: 'HTML' }
            if (i === 0 && replyToId !== undefined) chunkOpts.reply_to_message_id = replyToId
            const chunk = chunks[i] as string
            try {
              const out = await telegramApi.sendMessage(args.chat_id, chunk, chunkOpts)
              sentIds.push(out.message_id)
            } catch (err) {
              if (isTelegramHtmlParseError(err)) {
                // Telegram rejected our HTML. Retry the SAME chunk as plain
                // text so the user still sees the answer body — better a
                // missing <b> than a missing reply. Mirror gateway.py:500-510.
                log.warn('telegram HTML parse failed, retrying as plain text', {
                  chunk_index: i,
                  error: err instanceof Error ? err.message : String(err),
                })
                const plainOpts: SendMessageOpts = {}
                if (i === 0 && replyToId !== undefined) plainOpts.reply_to_message_id = replyToId
                const out = await telegramApi.sendMessage(args.chat_id, chunk, plainOpts)
                sentIds.push(out.message_id)
              } else {
                throw err
              }
            }
          }
        } else {
          // text / markdownv2 — also chunk at 4000 chars so a 9000-char reply
          // does not trip Telegram's 4096 sendMessage cap. reply_to threads
          // only the first chunk so a long answer doesn't quote-spam.
          // chunk.ts' tag-balancing is HTML-specific; for text/markdownv2 we
          // still rely on the same paragraph/line/hard-cut preference order
          // (the tag-balance path is a no-op when no <pre>/<code> tags).
          const chunks = splitMessage(args.text)
          for (let i = 0; i < chunks.length; i++) {
            const chunkOpts: SendMessageOpts = {}
            if (i === 0 && replyToId !== undefined) chunkOpts.reply_to_message_id = replyToId
            if (args.format === 'markdownv2') chunkOpts.parse_mode = 'MarkdownV2'
            const chunk = chunks[i] as string
            const sent = await telegramApi.sendMessage(args.chat_id, chunk, chunkOpts)
            sentIds.push(sent.message_id)
          }
        }

        // Attachments. We send the canonical (realpath-resolved) path so a
        // symlink or relative path inside the workspace becomes the absolute
        // file ultimately handed to grammY's InputFile.
        for (const canonical of canonicalFiles) {
          const opts: SendDocumentOpts = {}
          if (args.reply_to !== undefined) opts.reply_to_message_id = Number(args.reply_to)
          const out = isPhotoExtension(canonical)
            ? await telegramApi.sendPhoto(args.chat_id, canonical, opts)
            : await telegramApi.sendDocument(args.chat_id, canonical, opts)
          sentIds.push(out.message_id)
        }

        // Real answer shipped — clear the transient status. complete() is
        // idempotent (no-op when no status is active), so this is safe even
        // when the agent never opened a status.
        try {
          await statusManager.complete(args.chat_id)
        } catch (err) {
          log.warn('status complete after reply failed (ignored)', {
            chat_id: args.chat_id,
            error: err instanceof Error ? err.message : String(err),
          })
        }

        const result =
          sentIds.length === 1
            ? `sent (id: ${sentIds[0]})`
            : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
        return { content: [{ type: 'text', text: result }] }
      }

      case 'react': {
        const parsed = ReactArgsSchema.safeParse(rawArgs)
        if (!parsed.success) return toolError(name, zodErrorMessage(parsed.error))
        const args = parsed.data
        try {
          assertAllowedChat(args.chat_id, config, deps.policy)
        } catch (err) {
          return toolError(name, err instanceof Error ? err.message : String(err))
        }
        await telegramApi.setMessageReaction(args.chat_id, Number(args.message_id), args.emoji)
        return { content: [{ type: 'text', text: 'reacted' }] }
      }

      case 'download_attachment': {
        const parsed = DownloadAttachmentArgsSchema.safeParse(rawArgs)
        if (!parsed.success) return toolError(name, zodErrorMessage(parsed.error))
        const args = parsed.data
        try {
          assertAllowedChat(args.chat_id, config, deps.policy)
        } catch (err) {
          return toolError(name, err instanceof Error ? err.message : String(err))
        }
        const out = await telegramApi.downloadFile(args.file_id, statePaths.inbox)
        return { content: [{ type: 'text', text: out.path }] }
      }

      case 'edit_message': {
        const parsed = EditMessageArgsSchema.safeParse(rawArgs)
        if (!parsed.success) return toolError(name, zodErrorMessage(parsed.error))
        const args = parsed.data
        try {
          assertAllowedChat(args.chat_id, config, deps.policy)
        } catch (err) {
          return toolError(name, err instanceof Error ? err.message : String(err))
        }
        const opts: EditOpts = {}
        if (args.format === 'markdownv2') opts.parse_mode = 'MarkdownV2'
        await telegramApi.editMessageText(args.chat_id, Number(args.message_id), args.text, opts)
        return { content: [{ type: 'text', text: `edited (id: ${args.message_id})` }] }
      }

      case 'status': {
        const parsed = StatusArgsSchema.safeParse(rawArgs)
        if (!parsed.success) return toolError(name, zodErrorMessage(parsed.error))
        const args = parsed.data
        try {
          assertAllowedChat(args.chat_id, config, deps.policy)
        } catch (err) {
          return toolError(name, err instanceof Error ? err.message : String(err))
        }
        // No active status → silently no-op. The agent may try to set a
        // status before /start has fired (e.g. webhook-driven flow) — we
        // don't want to error out the tool call. Same logic as gateway.py
        // which just no-ops when status_msg_id is None.
        const active = statusManager.isActive(args.chat_id)
        if (!active) {
          return { content: [{ type: 'text', text: 'status no-op (no active session)' }] }
        }

        // stopped/error → cancel (edits to terminal label, stops timers).
        if (args.state === 'stopped' || args.state === 'error') {
          const reason = args.reason ?? args.state
          await statusManager.cancel(args.chat_id, reason)
          return { content: [{ type: 'text', text: 'status canceled' }] }
        }

        // tool requires tool_name — surface a clear Zod-style error rather
        // than silently rendering an empty 🔧 tag.
        if (args.state === 'tool' && (args.tool_name === undefined || args.tool_name.length === 0)) {
          return toolError(name, 'state="tool" requires tool_name')
        }

        // Build a fresh handle synthetically — update() validates message_id
        // against the live entry, so we have to read it back from the
        // manager. We expose this by re-invoking start without an active
        // session if the agent passes typing/thinking and there is none.
        // Since we checked isActive above, the entry exists; reach into the
        // manager via a thin helper. Cleaner: add a public update-by-chat
        // method. We do that here:
        const state: StatusState =
          args.state === 'tool'
            ? { kind: 'tool', toolName: args.tool_name! }
            : args.state === 'typing'
              ? { kind: 'typing' }
              : { kind: 'thinking' }
        await statusManager.updateByChatId(args.chat_id, state)
        return { content: [{ type: 'text', text: 'status updated' }] }
      }

      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error('tool call failed', { tool: name, error: msg })
    return toolError(name, msg)
  }
}
