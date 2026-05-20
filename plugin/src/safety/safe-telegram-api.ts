// Safety wrapper around TelegramApi.
//
// Every outbound TEXT method (sendMessage, editMessageText) runs through:
//   1. redactSecrets(text, extraSecrets) — strips tokens, IPs, secret paths,
//      and any caller-supplied substrings before the body leaves the process.
//   2. validateTelegramHtml(text) — only when parse_mode === 'HTML'. If the
//      body is invalid Telegram HTML, we downgrade by removing parse_mode
//      and shipping the body as plain text. Telegram will accept it.
//
// Methods that don't accept user text (sendDocument, sendPhoto, downloadFile,
// setMessageReaction, deleteMessage, sendChatAction) are forwarded verbatim.
// Captions on document/photo sends DO contain user text — Phase A1 keeps the
// scope tight to text-only methods; PR-A2 can extend to captions if needed
// (most callers route formatted text through sendMessage with attachment
// resolution done as a separate call).
//
// The wrapper returns a fresh TelegramApi-shaped object whose every method
// is a thin function. Callers swap the raw instance for this one and need
// no code changes downstream.

import type { Logger } from '../log.js'
import type {
  ChatAction,
  DownloadResult,
  EditOpts,
  SendDocumentOpts,
  SendMessageOpts,
  TelegramApi,
} from '../channel/tools.js'
import { redactSecrets } from './redact.js'
import { validateTelegramHtml } from './html-validator.js'

/**
 * Wrap the raw TelegramApi so every text-sending call is funneled through
 * redaction + HTML validation. Logger receives a `warn` on HTML downgrade
 * — only the reason is logged, never the body (which may still contain
 * pre-redaction secrets if the agent was sloppy about logging upstream).
 *
 * @param raw           The underlying TelegramApi (typically createTelegramApi()).
 * @param log           Channel logger.
 * @param extraSecrets  Optional list of exact-substring secrets to mask
 *                      (e.g. webhook token, Groq key). Passed through to
 *                      redactSecrets on every send.
 */
export function createSafeTelegramApi(
  raw: TelegramApi,
  log: Logger,
  extraSecrets?: ReadonlyArray<string>,
): TelegramApi {
  const sanitize = (
    text: string,
    parseMode: 'MarkdownV2' | 'HTML' | undefined,
  ): { text: string; parseMode: 'MarkdownV2' | 'HTML' | undefined } => {
    // Redact first — secrets must be stripped regardless of parse mode.
    const redacted = redactSecrets(text, extraSecrets)
    if (parseMode !== 'HTML') {
      return { text: redacted, parseMode }
    }
    const validated = validateTelegramHtml(redacted)
    if (validated.downgraded) {
      // Telegram-bound payload is unknown to the operator, so log only the
      // classification (reason). The original text is intentionally NOT in
      // ctx — even after redaction it may carry sensitive context the
      // caller didn't whitelist.
      log.warn('telegram html downgrade', { reason: validated.reason ?? 'unknown' })
      return { text: validated.html, parseMode: undefined }
    }
    return { text: validated.html, parseMode }
  }

  return {
    async sendMessage(chatId: string, text: string, opts: SendMessageOpts): Promise<{ message_id: number }> {
      const { text: safeText, parseMode } = sanitize(text, opts.parse_mode)
      // Rebuild opts without mutating caller's object.
      const safeOpts: SendMessageOpts = { ...opts }
      if (parseMode === undefined) {
        delete safeOpts.parse_mode
      } else {
        safeOpts.parse_mode = parseMode
      }
      return raw.sendMessage(chatId, safeText, safeOpts)
    },

    async editMessageText(chatId: string, messageId: number, text: string, opts: EditOpts): Promise<void> {
      const { text: safeText, parseMode } = sanitize(text, opts.parse_mode)
      const safeOpts: EditOpts = { ...opts }
      if (parseMode === undefined) {
        delete safeOpts.parse_mode
      } else {
        safeOpts.parse_mode = parseMode
      }
      return raw.editMessageText(chatId, messageId, safeText, safeOpts)
    },

    // ─── Pass-through methods ────────────────────────────────────────
    // These accept no user-controlled HTML text. Captions could carry user
    // text but Phase A1 keeps the scope tight; see header comment.

    async setMessageReaction(chatId: string, messageId: number, emoji: string): Promise<void> {
      return raw.setMessageReaction(chatId, messageId, emoji)
    },

    async sendChatAction(chatId: string, action: ChatAction): Promise<void> {
      return raw.sendChatAction(chatId, action)
    },

    async sendDocument(chatId: string, filePath: string, opts: SendDocumentOpts): Promise<{ message_id: number }> {
      // Caption is plain text on Telegram unless parse_mode is set on the
      // raw call (we don't expose that here). Redact it defensively in case
      // the caller threaded user text into the caption.
      const safeOpts: SendDocumentOpts = { ...opts }
      if (typeof safeOpts.caption === 'string') {
        safeOpts.caption = redactSecrets(safeOpts.caption, extraSecrets)
      }
      return raw.sendDocument(chatId, filePath, safeOpts)
    },

    async sendPhoto(chatId: string, filePath: string, opts: SendDocumentOpts): Promise<{ message_id: number }> {
      const safeOpts: SendDocumentOpts = { ...opts }
      if (typeof safeOpts.caption === 'string') {
        safeOpts.caption = redactSecrets(safeOpts.caption, extraSecrets)
      }
      return raw.sendPhoto(chatId, filePath, safeOpts)
    },

    async downloadFile(fileId: string, destDir: string): Promise<DownloadResult> {
      return raw.downloadFile(fileId, destDir)
    },

    async deleteMessage(chatId: string, messageId: number): Promise<void> {
      return raw.deleteMessage(chatId, messageId)
    },
  }
}
