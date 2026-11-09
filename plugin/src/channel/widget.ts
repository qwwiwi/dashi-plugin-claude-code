// Limits and pre-flight validation for Telegram Bot API widgets (sendWidget /
// editMessageWidgetData, released 2026-11-09). Every rule here is checked
// BEFORE the HTTP call so the agent gets a precise refusal (with the measured
// size) instead of an opaque Bot API 400.
//
// Limits (https://core.telegram.org/bots/widgets):
//   html       <= 32768 bytes UTF-8, AND <= 4096 bytes after zlib level 9,
//              no NUL character
//   chat_data  <= 1024 bytes UTF-8
// Widgets only work in a private chat with the bot in production.

import { deflateSync } from 'zlib'

export const WIDGET_HTML_MAX_BYTES = 32768
export const WIDGET_HTML_MAX_ZLIB_BYTES = 4096
export const WIDGET_CHAT_DATA_MAX_BYTES = 1024

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

// Size of the html after zlib at level 9 (the form Telegram measures).
export function zlibBytes(text: string): number {
  return deflateSync(Buffer.from(text, 'utf8'), { level: 9 }).length
}

// Returns a human-readable refusal, or undefined when the html is sendable.
// Cheap checks first; the zlib pass only runs on html that already fits the
// raw cap, so it never compresses an arbitrarily large input.
export function checkWidgetHtml(html: string): string | undefined {
  if (html.includes('\u0000')) {
    return 'html contains a NUL character (\\u0000) — Telegram rejects it; remove it'
  }
  const raw = utf8Bytes(html)
  if (raw > WIDGET_HTML_MAX_BYTES) {
    return `html is ${raw} bytes in UTF-8, over the ${WIDGET_HTML_MAX_BYTES}-byte limit (bytes, not characters — multi-byte text counts more)`
  }
  const zipped = zlibBytes(html)
  if (zipped > WIDGET_HTML_MAX_ZLIB_BYTES) {
    return `html is ${zipped} bytes after zlib level 9, over the ${WIDGET_HTML_MAX_ZLIB_BYTES}-byte limit — shorten the markup/script or deduplicate repeated strings`
  }
  return undefined
}

export function checkWidgetChatData(chatData: string): string | undefined {
  const bytes = utf8Bytes(chatData)
  if (bytes > WIDGET_CHAT_DATA_MAX_BYTES) {
    return `chat_data is ${bytes} bytes in UTF-8, over the ${WIDGET_CHAT_DATA_MAX_BYTES}-byte limit (bytes, not characters) — use shorter keys/labels`
  }
  return undefined
}

// Widgets work only in a private chat with the bot in production. A private
// chat id is positive; groups, supergroups and channels are negative.
// Non-numeric ids fail closed.
export function checkWidgetChat(chatId: string): string | undefined {
  const n = Number(chatId)
  if (Number.isFinite(n) && n > 0) return undefined
  return `chat ${chatId} is not a private chat — in production Telegram supports widgets only in a private chat with the bot (positive chat id)`
}
