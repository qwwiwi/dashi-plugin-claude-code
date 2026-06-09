// Permission-gate Telegram UX — renders the Allow/Deny card for one pending
// confirm and dispatches the warchief's tap back into the relay.
//
// Callback data uses the `pgate:` prefix (NOT `perm:`, which the headless MCP
// permission relay in channel/permissions.ts owns) so the two flows never
// collide in the shared bot.on('callback_query:data') dispatcher.
//
//   pgate:allow:<requestId>
//   pgate:deny:<requestId>
//
// Auth: only an allowed user id (permission_gate.allowed_user_ids, inheriting
// permission_relay) may resolve a request. A tap from anyone else is rejected
// with an answerCallbackQuery toast and changes nothing — fail-closed.

import type { AppConfig } from '../config.js'
import type { Logger } from '../log.js'
import type { TelegramApi, InlineKeyboardLike } from '../channel/tools.js'
import type { PermissionGateRelay } from '../channel/permission-gate-relay.js'
import { resolvePermissionGateAllowedUserIds } from '../config.js'
import { isShortId } from '../channel/short-id.js'

const CALLBACK_RE = /^pgate:(allow|deny):([a-km-z]{5})$/

export interface PgateCallbackPayload {
  behavior: 'allow' | 'deny'
  requestId: string
}

export function parsePgateCallback(data: string): PgateCallbackPayload | null {
  const m = CALLBACK_RE.exec(data)
  if (!m) return null
  return { behavior: m[1] as 'allow' | 'deny', requestId: m[2]! }
}

// Structural subset of grammY's callback_query Context the handler needs.
// messageId is the id of the message the tapped keyboard is attached to
// (ctx.callbackQuery.message.message_id) — used to bind a tap to the exact
// pending request so a stale keyboard can't resolve a later, id-reusing one.
export interface PgateCallbackContext {
  callbackQuery: { data: string; messageId?: number }
  from: { id: number }
  answerCallbackQuery(arg?: { text?: string }): Promise<void>
}

export interface PermissionGateUi {
  /** Send the Allow/Deny card for a freshly-submitted request. */
  sendPrompt(requestId: string): Promise<void>
  /** Dispatch a `pgate:*` callback. Returns true if it consumed the event. */
  handlePgateCallback(ctx: PgateCallbackContext): Promise<boolean>
  /** Strip the keyboard + mark a card as expired (used on relay timeout so a
   *  stale Allow button can't resolve a future request that reuses the id). */
  clearKeyboard(chatId: string, messageId: number, note: string): Promise<void>
}

export interface PermissionGateUiDeps {
  config: AppConfig
  log: Logger
  telegramApi: TelegramApi
  relay: PermissionGateRelay
}

const MAX_PREVIEW = 600

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildKeyboard(requestId: string): InlineKeyboardLike {
  return {
    inline_keyboard: [
      [
        { text: '✅ Allow', callback_data: `pgate:allow:${requestId}` },
        { text: '❌ Deny', callback_data: `pgate:deny:${requestId}` },
      ],
    ],
  }
}

function renderCard(toolName: string, reason: string, preview: string): string {
  const previewClipped = preview.length > MAX_PREVIEW ? `${preview.slice(0, MAX_PREVIEW)}…` : preview
  const lines = [
    `🔐 <b>Запрос подтверждения</b>`,
    ``,
    `Инструмент: <code>${escapeHtml(toolName)}</code>`,
    `Причина: ${escapeHtml(reason)}`,
  ]
  if (previewClipped.length > 0) {
    lines.push(``, `<pre>${escapeHtml(previewClipped)}</pre>`)
  }
  return lines.join('\n')
}

export function createPermissionGateUi(deps: PermissionGateUiDeps): PermissionGateUi {
  const { config, log, telegramApi, relay } = deps

  async function sendPrompt(requestId: string): Promise<void> {
    const req = relay.getPending(requestId)
    if (!req) {
      log.debug('permission_gate sendPrompt: no pending request', { request_id: requestId })
      return
    }
    if (!req.chatId) {
      log.warn('permission_gate sendPrompt: missing chatId', { request_id: requestId })
      return
    }
    // Idempotency: if a keyboard was already sent (hook-wrapper replay routed a
    // second submit to the same live request) don't send a duplicate card.
    if (req.telegramMessageId !== undefined) {
      log.debug('permission_gate sendPrompt: keyboard already sent', { request_id: requestId })
      return
    }
    // NOTE: preview/reason are surfaced to the chat. The safe-telegram-api
    // wrapper around telegramApi redacts secrets before the send hits the
    // wire, so a Bash command carrying a token can't leak into the card.
    const body = renderCard(req.toolName, req.reason, req.preview)
    const sent = await telegramApi.sendMessage(req.chatId, body, {
      parse_mode: 'HTML',
      reply_markup: buildKeyboard(requestId),
    })
    relay.setTelegramMessageId(requestId, sent.message_id)
  }

  async function handlePgateCallback(ctx: PgateCallbackContext): Promise<boolean> {
    const parsed = parsePgateCallback(ctx.callbackQuery.data)
    if (!parsed) return false
    if (!isShortId(parsed.requestId)) {
      await ctx.answerCallbackQuery().catch(() => {})
      return true
    }

    // Authorize the tapper.
    const allowed = resolvePermissionGateAllowedUserIds(config)
    if (!allowed.includes(ctx.from.id)) {
      log.warn('permission_gate unauthorized tap', { request_id: parsed.requestId, user_id: ctx.from.id })
      await ctx.answerCallbackQuery({ text: 'Не авторизован' }).catch(() => {})
      return true
    }

    const pendingBefore = relay.getPending(parsed.requestId)

    // Message-id binding (Codex high + round-2): once a request has a keyboard
    // message id, a tap MUST carry the SAME message id. A 5-char short id can
    // be reused after its 60s tombstone expires; a stale Allow button left on
    // an old card must not resolve a later id-reusing request. We REQUIRE the
    // id (Telegram always sends message.message_id on inline-keyboard taps) —
    // a tap with a missing or mismatched id is rejected, never falls through.
    if (pendingBefore && pendingBefore.telegramMessageId !== undefined) {
      if (ctx.callbackQuery.messageId !== pendingBefore.telegramMessageId) {
        log.warn('permission_gate tap message-id mismatch/absent (stale keyboard)', { request_id: parsed.requestId })
        await ctx.answerCallbackQuery({ text: 'Запрос уже закрыт' }).catch(() => {})
        return true
      }
    }

    const status = relay.answer(parsed.requestId, parsed.behavior)

    if (status === 'idempotent') {
      await ctx.answerCallbackQuery({ text: 'Запрос уже закрыт' }).catch(() => {})
      return true
    }

    // Edit the card to reflect the decision and strip the keyboard so the
    // buttons can't be tapped again.
    if (pendingBefore?.chatId && pendingBefore.telegramMessageId !== undefined) {
      const verdict = parsed.behavior === 'allow' ? '✅ Разрешено' : '❌ Запрещено'
      const body = `${renderCard(pendingBefore.toolName, pendingBefore.reason, pendingBefore.preview)}\n\n<b>${verdict}</b>`
      await telegramApi
        .editMessageText(pendingBefore.chatId, pendingBefore.telegramMessageId, body, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [] },
        })
        .catch((err) => {
          log.warn('permission_gate edit after decision failed', {
            request_id: parsed.requestId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
    }

    await ctx.answerCallbackQuery({ text: parsed.behavior === 'allow' ? 'Разрешено' : 'Запрещено' }).catch(() => {})
    log.info('permission_gate resolved by tap', { request_id: parsed.requestId, behavior: parsed.behavior, user_id: ctx.from.id })
    return true
  }

  async function clearKeyboard(chatId: string, messageId: number, note: string): Promise<void> {
    await telegramApi
      .editMessageText(chatId, messageId, `🔐 <b>Запрос подтверждения</b>\n\n<b>${escapeHtml(note)}</b>`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] },
      })
      .catch((err) => {
        log.warn('permission_gate clearKeyboard failed', { error: err instanceof Error ? err.message : String(err) })
      })
  }

  return { sendPrompt, handlePgateCallback, clearKeyboard }
}
