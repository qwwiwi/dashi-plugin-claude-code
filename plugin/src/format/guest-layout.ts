// Guest Mode answer layout (#861).
//
// A guest answer lands in a public foreign chat and is one-shot. The layout
// is built here, in code, so it does not depend on what the model wrote:
// a long answer becomes ONE collapsed `<blockquote expandable>` (a few
// summary lines visible, a chevron expands the rest). Short answers stay
// plain. Telegram forbids nested blockquotes, so any blockquote tags the
// model already wrote are stripped (their text is kept) before wrapping —
// which also makes "already exactly one expandable blockquote" come out as
// a single block instead of a double wrap.

import { TELEGRAM_MAX_MESSAGE } from './chunk.js'

export const GUEST_BLOCKQUOTE_OPEN = '<blockquote expandable>'
export const GUEST_BLOCKQUOTE_CLOSE = '</blockquote>'
export const GUEST_WRAPPER_LENGTH = GUEST_BLOCKQUOTE_OPEN.length + GUEST_BLOCKQUOTE_CLOSE.length

/** Default number of visible characters above which a guest answer is collapsed. */
export const DEFAULT_GUEST_COLLAPSE_THRESHOLD = 350

/** Budget for the inner text so that wrapper + inner stays within Telegram's cap. */
export const GUEST_INNER_MAX = TELEGRAM_MAX_MESSAGE - GUEST_WRAPPER_LENGTH

// Quoted attribute values may contain `>`; walk them as units.
const BLOCKQUOTE_TAG_RE = /<\/?blockquote\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi

/** Remove every blockquote open/close tag, keeping the text between them. */
export function stripBlockquoteTags(html: string): string {
  return html.replace(BLOCKQUOTE_TAG_RE, '')
}

/** Approximate user-visible length of an HTML body: tags dropped, entities decoded. */
export function visibleLength(html: string): number {
  const text = html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
  return text.length
}

/** True when the answer is long enough to be collapsed. */
export function shouldCollapseGuestAnswer(html: string, threshold: number): boolean {
  return visibleLength(html) > threshold
}

/** Wrap an already-trimmed inner HTML body in the single expandable block. */
export function wrapGuestBlock(inner: string): string {
  return `${GUEST_BLOCKQUOTE_OPEN}${inner}${GUEST_BLOCKQUOTE_CLOSE}`
}

// ─────────────────────────────────────────────────────────────────────
// Bounding helpers for the FINAL guest payload (#861 review, B1)
// ─────────────────────────────────────────────────────────────────────

// One tag (with quoted attribute values) or one complete entity.
const HTML_TOKEN_RE =
  /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:[^>"']|"[^"]*"|'[^']*')*>|&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/y

const VOID_TAGS: ReadonlySet<string> = new Set(['br'])

/**
 * Cut `html` to at most `max` UTF-16 units without breaking markup: never
 * inside a tag, an entity or a surrogate pair, and every tag still open at
 * the cut is closed (the closers count against `max`). Input that already
 * fits and is well-formed comes back unchanged. A trailing half-written tag
 * or entity (`<a href="x`, `&am`) is dropped.
 */
export function truncateHtmlBalanced(html: string, max: number): string {
  const stack: string[] = []
  let closeLen = 0
  let out = ''
  let pos = 0
  while (pos < html.length) {
    HTML_TOKEN_RE.lastIndex = pos
    const m = HTML_TOKEN_RE.exec(html)
    if (m !== null) {
      const tok = m[0]
      const name = m[2]?.toLowerCase()
      if (name === undefined) {
        // entity
        if (out.length + tok.length + closeLen > max) break
        out += tok
      } else if (m[1] === '/') {
        if (stack[stack.length - 1] !== name) {
          pos += tok.length // stray closer: drop it
          continue
        }
        if (out.length + tok.length + (closeLen - (name.length + 3)) > max) break
        out += tok
        stack.pop()
        closeLen -= name.length + 3
      } else {
        const selfClosing = VOID_TAGS.has(name) || tok.endsWith('/>')
        const added = selfClosing ? 0 : name.length + 3
        if (out.length + tok.length + closeLen + added > max) break
        out += tok
        if (!selfClosing) {
          stack.push(name)
          closeLen += added
        }
      }
      pos += tok.length
      continue
    }
    if (html[pos] === '<') break // half-written tag: stop here
    const cp = String.fromCodePoint(html.codePointAt(pos) as number)
    if (out.length + cp.length + closeLen > max) break
    out += cp
    pos += cp.length
  }
  for (let i = stack.length - 1; i >= 0; i--) out += `</${stack[i]}>`
  return out
}

const ANY_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:[^>"']|"[^"]*"|'[^']*')*>/g

/** HTML → plain text: tags removed (`<br>` → newline), basic entities decoded. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(ANY_TAG_RE, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Hard cut of a plain string to `max` UTF-16 units, never splitting a surrogate pair. */
export function boundPlain(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return text.slice(0, end)
}
