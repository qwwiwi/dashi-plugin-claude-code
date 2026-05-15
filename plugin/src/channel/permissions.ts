// Permission relay between Claude Code's permission_request notifications and
// Telegram. Handles:
//  - inbound `notifications/claude/channel/permission_request` → Telegram message
//    with inline keyboard (Allow / Deny / See more)
//  - callback parsing for those buttons (wired in registerPermissionCallback)
//  - text-reply regex for "yes abcde" / "no abcde" style permission replies
//  - outbound `notifications/claude/channel/permission` verdicts back to CC
//
// T12 deliverable extends the T3 scaffold with full inbound flow:
// PermissionRelayHooks bundle isPending / consumePending / emitVerdict so
// callers (handlers.ts text path, server.ts callback path) share one map +
// jsonl audit log.

import { z } from 'zod'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InlineKeyboard } from 'grammy'
import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

import type { AppConfig, StatePaths } from '../config.js'
import type { Logger } from '../log.js'
import { PermissionRequestParamsSchema } from '../schemas.js'
import type { InlineKeyboardLike, TelegramApi } from './tools.js'

// 5 lowercase letters a-z minus 'l'. Case-insensitive for phone autocorrect.
// Strict: no bare yes/no (conversational), no prefix/suffix chatter.
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// `perm:<behavior>:<request_id>` — same callback data shape as official server.
const CALLBACK_RE = /^perm:(allow|deny|more):([a-km-z]{5})$/

export interface PendingPermission {
  toolName: string
  description: string
  inputPreview: string
}

export interface PermissionDeps {
  config: AppConfig
  telegramApi: TelegramApi
  log: Logger
}

export function createPendingMap(): Map<string, PendingPermission> {
  return new Map<string, PendingPermission>()
}

export interface ParsedCallback {
  behavior: 'allow' | 'deny' | 'more'
  requestId: string
}

export function parsePermissionCallback(data: string): ParsedCallback | null {
  const m = CALLBACK_RE.exec(data)
  if (!m) return null
  const behavior = m[1] as 'allow' | 'deny' | 'more'
  const requestId = m[2] ?? ''
  if (!requestId) return null
  return { behavior, requestId }
}

// Schema for the inbound notification from Claude Code. Wrapped to match
// the Server.setNotificationHandler signature.
const PermissionRequestNotificationSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: PermissionRequestParamsSchema,
})

export function registerPermissionRelay(
  server: Server,
  deps: PermissionDeps,
  pending: Map<string, PendingPermission>,
): void {
  const { config, telegramApi, log } = deps

  server.setNotificationHandler(PermissionRequestNotificationSchema, async ({ params }) => {
    const { request_id, tool_name, description, input_preview } = params
    pending.set(request_id, {
      toolName: tool_name,
      description,
      inputPreview: input_preview,
    })

    if (!config.permission_relay.enabled) {
      log.debug('permission_relay disabled, dropping request', { request_id, tool_name })
      return
    }

    const text = `🔐 Permission: ${tool_name}`
    const keyboard = new InlineKeyboard()
      .text('See more', `perm:more:${request_id}`)
      .text('✅ Allow', `perm:allow:${request_id}`)
      .text('❌ Deny', `perm:deny:${request_id}`)

    log.info('permission_request received', {
      request_id,
      tool_name,
      recipients: config.permission_relay.allowed_user_ids.length,
    })

    // grammY's InlineKeyboard is structurally `{ inline_keyboard: [...] }` once
    // serialized through bot.api — we pass it as a structural InlineKeyboardLike.
    const replyMarkup: InlineKeyboardLike = {
      inline_keyboard: keyboard.inline_keyboard.map(row =>
        row.map(btn => {
          const out: { text: string; callback_data?: string } = { text: btn.text }
          if ('callback_data' in btn && typeof btn.callback_data === 'string') {
            out.callback_data = btn.callback_data
          }
          return out
        }),
      ),
    }

    for (const userId of config.permission_relay.allowed_user_ids) {
      const chatId = String(userId)
      try {
        await telegramApi.sendMessage(chatId, text, { reply_markup: replyMarkup })
      } catch (err) {
        log.error('permission_request send failed', {
          chat_id: chatId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  })
}

// ─────────────────────────────────────────────────────────────────────
// T12 — text-reply parsing + approver gate + verdict hooks
// ─────────────────────────────────────────────────────────────────────

export type PermissionDecision = {
  behavior: 'allow' | 'deny'
  requestId: string
}

// Parse "yes abcde" / "no abcde" style replies. Returns null on no match.
// Behaviors: y/yes → 'allow', n/no → 'deny'. ID is lowercased to match the
// canonical form used by Claude Code (5 letters from a-km-z).
export function parsePermissionTextReply(text: string): PermissionDecision | null {
  const m = PERMISSION_REPLY_RE.exec(text)
  if (!m) return null
  const word = (m[1] ?? '').toLowerCase()
  const requestId = (m[2] ?? '').toLowerCase()
  if (!requestId) return null
  const behavior: 'allow' | 'deny' = word.startsWith('y') ? 'allow' : 'deny'
  return { behavior, requestId }
}

// Is this Telegram user authorized to answer permission prompts? Compared by
// numeric value so config (numbers) matches ctx.from.id (number) regardless
// of accidental string passing from the caller.
export function isPermissionApprover(
  userId: string | number,
  config: AppConfig,
): boolean {
  const asNum = typeof userId === 'number' ? userId : Number(userId)
  if (!Number.isFinite(asNum)) return false
  return config.permission_relay.allowed_user_ids.includes(asNum)
}

// Server-side notification surface used by hooks. Kept narrow so tests stub
// without pulling the full MCP SDK Server.
export interface PermissionNotifier {
  notification(notification: {
    method: 'notifications/claude/channel/permission'
    params: { request_id: string; behavior: 'allow' | 'deny' }
  }): Promise<void>
}

export interface PermissionRelayHooks {
  isPending(requestId: string): boolean
  consumePending(requestId: string): PendingPermission | undefined
  emitVerdict(decision: PermissionDecision): Promise<void>
}

// Build the verdict-side hooks bound to a pending map + logger + audit path.
// `server` is structurally a PermissionNotifier — Server from the SDK has the
// matching .notification() method so production code passes it directly.
export function createPermissionRelayHooks(
  server: PermissionNotifier,
  pending: Map<string, PendingPermission>,
  log: Logger,
  statePaths: StatePaths,
): PermissionRelayHooks {
  const auditPath = statePaths.logs.permissions
  return {
    isPending(requestId: string): boolean {
      return pending.has(requestId)
    },
    consumePending(requestId: string): PendingPermission | undefined {
      const existing = pending.get(requestId)
      if (existing === undefined) return undefined
      pending.delete(requestId)
      return existing
    },
    async emitVerdict(decision: PermissionDecision): Promise<void> {
      try {
        await server.notification({
          method: 'notifications/claude/channel/permission',
          params: {
            request_id: decision.requestId,
            behavior: decision.behavior,
          },
        })
      } catch (err) {
        log.error('permission verdict notification failed', {
          request_id: decision.requestId,
          behavior: decision.behavior,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      // Audit jsonl — append-only, best-effort. Failures must not break the
      // verdict path; CC has already been notified.
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        request_id: decision.requestId,
        behavior: decision.behavior,
      }) + '\n'
      try {
        mkdirSync(dirname(auditPath), { recursive: true, mode: 0o700 })
        appendFileSync(auditPath, line, { mode: 0o600 })
      } catch (err) {
        log.warn('permission audit write failed', {
          path: auditPath,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────
// Telegram callback handler — wires `bot.on('callback_query:data', ...)`.
// Mirrors refs/telegram-official/server.ts:729-786. Kept here so the full
// permission lifecycle (notify → keyboard → callback verdict) lives in one
// module and server.ts stays a composition root.
// ─────────────────────────────────────────────────────────────────────

// Subset of grammY's callback_query context the handler reads. Structural so
// tests can stub without grammY.
export interface CallbackQueryLike {
  callbackQuery: {
    data?: string
    message?: { text?: string } | undefined
  }
  from: { id: number }
  answerCallbackQuery(arg?: { text?: string }): Promise<void>
  editMessageText(text: string, opts?: { reply_markup?: InlineKeyboardLike }): Promise<void>
}

export async function handlePermissionCallback(
  ctx: CallbackQueryLike,
  deps: { config: AppConfig; hooks: PermissionRelayHooks; pending: Map<string, PendingPermission>; log: Logger },
): Promise<void> {
  const { config, hooks, pending, log } = deps
  const data = ctx.callbackQuery.data ?? ''
  const parsed = parsePermissionCallback(data)
  if (!parsed) {
    // Unknown payload — silently ack so Telegram clears the spinner.
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
  if (!isPermissionApprover(ctx.from.id, config)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  const { behavior, requestId } = parsed

  if (behavior === 'more') {
    const details = pending.get(requestId)
    if (!details) {
      await ctx.answerCallbackQuery({ text: 'Details no longer available.' }).catch(() => {})
      return
    }
    let prettyInput: string
    try {
      prettyInput = JSON.stringify(JSON.parse(details.inputPreview), null, 2)
    } catch {
      prettyInput = details.inputPreview
    }
    const expanded =
      `🔐 Permission: ${details.toolName}\n\n` +
      `tool_name: ${details.toolName}\n` +
      `description: ${details.description}\n` +
      `input_preview:\n${prettyInput}`
    const keyboard = new InlineKeyboard()
      .text('✅ Allow', `perm:allow:${requestId}`)
      .text('❌ Deny', `perm:deny:${requestId}`)
    const replyMarkup: InlineKeyboardLike = {
      inline_keyboard: keyboard.inline_keyboard.map(row =>
        row.map(btn => {
          const out: { text: string; callback_data?: string } = { text: btn.text }
          if ('callback_data' in btn && typeof btn.callback_data === 'string') {
            out.callback_data = btn.callback_data
          }
          return out
        }),
      ),
    }
    await ctx.editMessageText(expanded, { reply_markup: replyMarkup }).catch((err: unknown) => {
      log.warn('permission "more" edit failed', {
        request_id: requestId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }

  // allow / deny — consume pending, emit verdict, update message.
  hooks.consumePending(requestId)
  await hooks.emitVerdict({ behavior, requestId })
  const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  const original = ctx.callbackQuery.message
  const baseText = original && typeof original.text === 'string' ? original.text : null
  if (baseText !== null) {
    await ctx.editMessageText(`${baseText}\n\n${label}`).catch((err: unknown) => {
      log.warn('permission verdict edit failed', {
        request_id: requestId,
        behavior,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }
}

// Bot.on signature subset — matches grammY's `bot.on('callback_query:data', cb)`
// closely enough that production wiring is a single call.
export interface CallbackQueryBot {
  on(
    event: 'callback_query:data',
    handler: (ctx: CallbackQueryLike) => Promise<void>,
  ): void
}

export function registerPermissionCallback(
  bot: CallbackQueryBot,
  deps: { config: AppConfig; hooks: PermissionRelayHooks; pending: Map<string, PendingPermission>; log: Logger },
): void {
  bot.on('callback_query:data', async (ctx: CallbackQueryLike) => {
    try {
      await handlePermissionCallback(ctx, deps)
    } catch (err) {
      deps.log.error('callback_query handler threw', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
}
