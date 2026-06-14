// Telegram Bot API 10.1 "Rich Messages" — pure helpers (no I/O).
//
// Rich Messages let Telegram render RAW markdown server-side: tables, math,
// headings, task-lists, <details>, footnotes — far beyond the HTML subset
// markdownToTelegramHtml targets. The cap is 32768 bytes (vs 4096 for a
// normal sendMessage), so a long structured answer ships as ONE message
// instead of being chunked + lossily HTML-converted.
//
// This module is deliberately side-effect-free: it only classifies errors,
// checks length limits, and builds the raw-api request body. The actual
// send (and the transparent HTML fallback) lives in the safe-telegram-api
// wrapper + the reply tool, so redaction and rate-limiting still apply.
//
// Layering reminder: the rich method is a new TelegramApi method so it flows
// through safeTelegramApi (redaction) → rateLimitedTelegramApi (429 queue)
// → rawTelegramApi (grammY raw escape hatch). NEVER call the raw send
// directly from the reply tool — that would bypass secret redaction.

// Telegram Bot API 10.1 rich-message body cap. Telegram measures this in
// UTF-8 bytes, not JS code-units; contentFitsRichLimits() below compares
// byte length so a Cyrillic/emoji-heavy answer is gated correctly.
export const RICH_MESSAGE_MAX_CHARS = 32768

/**
 * True when `text` fits inside a single rich message. Telegram counts the
 * body in UTF-8 bytes, so we measure bytes — not `text.length` (which counts
 * UTF-16 code units and would let a Cyrillic payload sneak past the cap).
 * Boundary: exactly RICH_MESSAGE_MAX_CHARS bytes fits; one more does not.
 */
export function contentFitsRichLimits(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') <= RICH_MESSAGE_MAX_CHARS
}

// Error classification for the rich send path. Drives the transparent
// fallback in safe-telegram-api:
//   - capability : Telegram (or this grammY build) doesn't know the method.
//                  Latch it OFF for the session and fall back to HTML.
//   - parser     : Telegram's markdown parser rejected the body (400). One-off
//                  fall back to HTML (which DOES validate) — do NOT latch.
//   - oversize   : body too large (400 about size). Fall back to HTML chunking.
//   - transient  : anything else (network, 5xx, 429). Re-throw — the
//                  rate-limit wrapper handles 429; other transients surface so
//                  we never silently swallow then double-send.
export type RichErrorClass = 'capability' | 'parser' | 'oversize' | 'transient'

// Pull an HTTP-ish status code out of the many shapes an error can take:
// grammY's GrammyError (`error_code`), a fetch Response-ish (`status`), or a
// plain object carrying either. Returns undefined when no numeric code found.
function extractStatusCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const e = err as Record<string, unknown>
  if (typeof e.error_code === 'number') return e.error_code
  if (typeof e.status === 'number') return e.status
  if (typeof e.statusCode === 'number') return e.statusCode
  return undefined
}

// Lowercased human-readable message for substring sniffing. grammY's
// GrammyError exposes `.description`; native errors expose `.message`.
function extractMessage(err: unknown): string {
  if (typeof err === 'string') return err.toLowerCase()
  if (typeof err !== 'object' || err === null) return ''
  const e = err as Record<string, unknown>
  const parts: string[] = []
  if (typeof e.description === 'string') parts.push(e.description)
  if (typeof e.message === 'string') parts.push(e.message)
  return parts.join(' ').toLowerCase()
}

/**
 * Classify a rich-send failure so the caller can decide fallback vs latch
 * vs re-throw. See RichErrorClass for the policy each class drives.
 *
 * capability — HTTP 404, or message mentioning "method not found",
 *   "unsupported", "not implemented". Telegram returns 404 for unknown
 *   methods; an older grammY/local build can surface "not found"/"unsupported".
 * parser — a 400 BadRequest that is NOT about size. Markdown the parser
 *   rejected; one-off fall back to the HTML path.
 * oversize — a 400 mentioning the body being too large ("too long",
 *   "message is too long", "too large", "entities too long").
 * transient — everything else (network, 5xx, 429, unknown). Re-thrown.
 */
export function richErrorClass(err: unknown): RichErrorClass {
  const code = extractStatusCode(err)
  const msg = extractMessage(err)

  // Capability: explicit 404, or a message that names the method as unknown.
  // Checked first because some transports report unknown-method as 400 with a
  // "method not found" description rather than 404.
  if (
    code === 404 ||
    msg.includes('method not found') ||
    msg.includes('not implemented') ||
    msg.includes('unsupported') ||
    msg.includes('method is not supported')
  ) {
    return 'capability'
  }

  if (code === 400) {
    // Oversize is a 400 sub-case — sniff the size wording first so we don't
    // misclassify it as a generic parser error (both fall back, but the
    // distinction is useful for logs/metrics and matches the spec contract).
    if (
      msg.includes('too long') ||
      msg.includes('too large') ||
      msg.includes('message is too long') ||
      msg.includes('entities too long')
    ) {
      return 'oversize'
    }
    return 'parser'
  }

  // 5xx, 429, network errors, or anything we can't read — treat as transient
  // and let the caller re-throw (the rate-limit wrapper owns 429 retries).
  return 'transient'
}

// Options accepted by buildRichMessagePayload. Mirrors the subset of the
// rich-message body we set today (chat target + threading via
// reply_parameters). Kept minimal — M3/M4 can extend (streaming drafts,
// group threads).
export interface BuildRichMessageOpts {
  chat_id: string
  reply_to_message_id?: number
}

// Shape of the raw-api body handed to grammY's
// `bot.api.raw.sendRichMessage(...)`. grammY raw bodies are plain objects
// keyed by the Bot API param names. We model the fields we set; `[key:
// string]` would invite typos, so we keep it explicit + optional.
//
// Wire format confirmed against the shipped Hermes reference
// (gateway/platforms/telegram.py `_rich_message_payload`/`_try_send_rich`):
// sendRichMessage takes a top-level `rich_message` InputRichMessage object
// whose raw markdown lives in its `markdown` field — NOT a flat top-level
// `markdown`. i.e. `sendRichMessage(chat_id, rich_message={markdown}, reply_parameters?)`.
export interface InputRichMessage {
  markdown: string
}
export interface RichMessageBody {
  chat_id: string
  rich_message: InputRichMessage
  reply_parameters?: { message_id: number }
}

/**
 * Build the raw-api request body for sendRichMessage. Pure: no redaction,
 * no I/O. Redaction runs on `rawMarkdown` in the safe wrapper BEFORE this
 * body reaches the transport, so do not pre-process the text here.
 *
 * grammY raw bodies use Bot-API param names directly — threading is
 * `reply_parameters: { message_id }` (same convention createTelegramApi
 * uses for sendMessage), not the legacy `reply_to_message_id`.
 */
export function buildRichMessagePayload(
  rawMarkdown: string,
  opts: BuildRichMessageOpts,
): RichMessageBody {
  const body: RichMessageBody = {
    chat_id: opts.chat_id,
    rich_message: { markdown: rawMarkdown },
  }
  if (opts.reply_to_message_id !== undefined) {
    body.reply_parameters = { message_id: opts.reply_to_message_id }
  }
  return body
}
