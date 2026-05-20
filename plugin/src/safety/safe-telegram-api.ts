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
  InlineKeyboardLike,
  SendDocumentOpts,
  SendMessageOpts,
  TelegramApi,
} from '../channel/tools.js'
import { redactSecrets } from './redact.js'
import { validateTelegramHtml } from './html-validator.js'

/**
 * Walk an inline keyboard and redact every button's `text` and `url`
 * fields in place on a freshly cloned object. The structural type
 * `InlineKeyboardLike` only declares `{ text, callback_data? }` cells,
 * but Telegram's wire format also accepts `url` (and several other
 * button kinds). We treat each cell as an open record so an unknown
 * field — say `web_app.url` or `login_url.url` — survives untouched.
 *
 * We don't run HTML validation on button text or url: buttons don't
 * render markup. We only redact secrets.
 */
function redactReplyMarkup(
  markup: InlineKeyboardLike,
  extraSecrets: ReadonlyArray<string> | undefined,
): InlineKeyboardLike {
  // Defensive: the array may be missing, malformed, or contain unknown
  // cells. We copy row by row, cell by cell, redacting only string-typed
  // `text` and `url` fields.
  const rows = Array.isArray(markup.inline_keyboard) ? markup.inline_keyboard : []
  const safeRows: { text: string; callback_data?: string }[][] = rows.map((row) => {
    if (!Array.isArray(row)) return []
    return row.map((cell) => {
      // Treat the cell as an open record so we can read/write `url` and
      // other fields without leaking `any`. Unknown keys are preserved.
      const c = cell as Record<string, unknown>
      const next: Record<string, unknown> = { ...c }
      if (typeof c.text === 'string') {
        next.text = redactSecrets(c.text, extraSecrets)
      }
      if (typeof c.url === 'string') {
        next.url = redactSecrets(c.url, extraSecrets)
      }
      // Cast back to the structural cell type — the unknown extra keys
      // ride along because TS doesn't widen object literal property sets
      // through Record-cast. This is intentional: we forward whatever
      // shape grammY sent us with only text/url sanitised.
      return next as { text: string; callback_data?: string }
    })
  })
  return { inline_keyboard: safeRows }
}

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
      return { text: validated.text, parseMode: undefined }
    }
    return { text: validated.text, parseMode }
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
      if (safeOpts.reply_markup) {
        safeOpts.reply_markup = redactReplyMarkup(safeOpts.reply_markup, extraSecrets)
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
