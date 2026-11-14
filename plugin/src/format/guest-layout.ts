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

const BLOCKQUOTE_TAG_RE = /<\/?blockquote\b[^>]*>/gi

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
