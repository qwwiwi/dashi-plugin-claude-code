// Inbound Telegram entities → Telegram-subset HTML (pure, no I/O).
//
// WHY (#1914): the inbound handlers forwarded only `message.text` /
// `message.caption`. Telegram strips formatting out of those strings and
// carries it in `entities` / `caption_entities`, so a forwarded post arrived
// at the agent with its bold, italic and spoilers gone — the agent could not
// repeat or forward it with the same markup via `reply format=html`.
//
// This module rebuilds the markup in the HTML subset Telegram itself accepts
// for parse_mode=HTML, so the agent can paste it straight back.
//
// Contract:
//   * offsets/lengths are UTF-16 code units (Telegram's unit; JS strings are
//     UTF-16 too, so plain `slice` is exact — emoji/surrogate pairs included);
//   * nested and partially overlapping entities are supported: an overlap is
//     rendered by closing and re-opening tags, which keeps the HTML well-formed;
//   * `<`, `>`, `&` are escaped in text; attribute values also escape quotes;
//   * mention / hashtag / cashtag / bot_command / url / email / phone_number
//     are NOT formatting — they stay as plain (escaped) text;
//   * with no formatting entity the input text is returned UNCHANGED (no
//     escaping) — callers that never saw entities keep the old behaviour.

import { escapeHtmlAttr } from '../format/html.js'

// Text nodes: only the three characters Telegram requires. Quotes stay as is
// so a resend through `reply format=html` (which escapes `&` again) does not
// turn every `"` into a visible `&quot;`.
export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Structural subset of grammY's MessageEntity that this module reads. */
export interface InboundEntity {
  type: string
  offset: number
  length: number
  url?: string
  language?: string
  custom_emoji_id?: string
  user?: { id: number }
}

const FORMATTING_TYPES = new Set([
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'spoiler',
  'code',
  'pre',
  'text_link',
  'text_mention',
  'blockquote',
  'expandable_blockquote',
  'custom_emoji',
])

const LITERAL_TYPES = new Set(['code', 'pre'])

interface Span {
  type: string
  start: number
  end: number
  idx: number
  open: string
  close: string
}

function tagsFor(e: InboundEntity): { open: string; close: string } | null {
  switch (e.type) {
    case 'bold':
      return { open: '<b>', close: '</b>' }
    case 'italic':
      return { open: '<i>', close: '</i>' }
    case 'underline':
      return { open: '<u>', close: '</u>' }
    case 'strikethrough':
      return { open: '<s>', close: '</s>' }
    case 'spoiler':
      return { open: '<tg-spoiler>', close: '</tg-spoiler>' }
    case 'code':
      return { open: '<code>', close: '</code>' }
    case 'pre':
      return typeof e.language === 'string' && e.language.length > 0
        ? {
            open: `<pre><code class="language-${escapeHtmlAttr(e.language)}">`,
            close: '</code></pre>',
          }
        : { open: '<pre>', close: '</pre>' }
    case 'text_link':
      if (typeof e.url !== 'string' || e.url.length === 0) return null
      return { open: `<a href="${escapeHtmlAttr(e.url)}">`, close: '</a>' }
    case 'text_mention':
      if (e.user === undefined || !Number.isSafeInteger(e.user.id)) return null
      return { open: `<a href="tg://user?id=${e.user.id}">`, close: '</a>' }
    case 'blockquote':
      return { open: '<blockquote>', close: '</blockquote>' }
    case 'expandable_blockquote':
      return { open: '<blockquote expandable>', close: '</blockquote>' }
    case 'custom_emoji':
      if (typeof e.custom_emoji_id !== 'string' || !/^\d+$/.test(e.custom_emoji_id)) return null
      return { open: `<tg-emoji emoji-id="${e.custom_emoji_id}">`, close: '</tg-emoji>' }
    default:
      return null
  }
}

function toSpans(text: string, entities: readonly InboundEntity[]): Span[] {
  const spans: Span[] = []
  entities.forEach((e, idx) => {
    if (e === null || typeof e !== 'object' || !FORMATTING_TYPES.has(e.type)) return
    if (!Number.isInteger(e.offset) || !Number.isInteger(e.length)) return
    const start = Math.max(0, e.offset)
    const end = Math.min(text.length, e.offset + e.length)
    if (end <= start) return
    const tags = tagsFor(e)
    if (tags === null) return
    spans.push({ type: e.type, start, end, idx, ...tags })
  })
  // Telegram never renders formatting inside code/pre; nested markup there
  // would also turn into literal text when the agent sends it back. Drop any
  // span fully contained in a different code/pre span.
  return spans.filter(
    (s) =>
      !spans.some(
        (c) =>
          c !== s &&
          LITERAL_TYPES.has(c.type) &&
          c.start <= s.start &&
          s.end <= c.end &&
          // equal-range code/pre pair: keep the first one only
          (c.start !== s.start || c.end !== s.end || c.idx < s.idx),
      ),
  )
}

/** True when at least one entity would add markup to the HTML rendering. */
export function hasFormattingEntities(
  text: string,
  entities: readonly InboundEntity[] | undefined,
): boolean {
  if (entities === undefined || entities.length === 0 || text.length === 0) return false
  return toSpans(text, entities).length > 0
}

/**
 * Render `text` + Telegram `entities` as Telegram-subset HTML.
 * Without any formatting entity the text is returned as is (unescaped).
 */
export function entitiesToHtml(
  text: string,
  entities: readonly InboundEntity[] | undefined,
): string {
  if (entities === undefined || entities.length === 0 || text.length === 0) return text
  const spans = toSpans(text, entities)
  if (spans.length === 0) return text

  const cuts = new Set<number>([0, text.length])
  for (const s of spans) {
    cuts.add(s.start)
    cuts.add(s.end)
  }
  const bounds = [...cuts].sort((a, b) => a - b)

  // Outer-first order: longer span (later end) outside, then earlier start,
  // then original order (Telegram lists outer entities first).
  const outerFirst = (a: Span, b: Span): number =>
    b.end - a.end || a.start - b.start || a.idx - b.idx

  const out: string[] = []
  const stack: Span[] = []
  for (let k = 0; k + 1 < bounds.length; k++) {
    const a = bounds[k]!
    const b = bounds[k + 1]!
    const active = new Set(spans.filter((s) => s.start <= a && b <= s.end))

    // Keep the longest prefix of the open stack that is still active; close
    // everything above it (overlap → close + re-open, keeps HTML well-formed).
    let keep = 0
    while (keep < stack.length && active.has(stack[keep]!)) keep++
    while (stack.length > keep) out.push(stack.pop()!.close)

    const toOpen = [...active].filter((s) => !stack.includes(s)).sort(outerFirst)
    for (const s of toOpen) {
      out.push(s.open)
      stack.push(s)
    }
    out.push(escapeText(text.slice(a, b)))
  }
  while (stack.length > 0) out.push(stack.pop()!.close)
  return out.join('')
}

/**
 * Append an HTML rendering of the formatting as a separate block after the
 * plain text, for the agent to reuse with `reply format=html`. The plain text
 * stays first and byte-identical, so nothing that reads the text changes.
 * Returns `plain` unchanged when there is no formatting entity.
 *
 * `source` is the raw Telegram string the entity offsets refer to; `plain` is
 * what the caller already sends (it may be a trimmed copy of `source`).
 */
export function withFormattedBlock(
  plain: string,
  source: string,
  entities: readonly InboundEntity[] | undefined,
): string {
  if (!hasFormattingEntities(source, entities)) return plain
  const html = entitiesToHtml(source, entities).trim()
  return `${plain}\n<formatted format="html">\n${html}\n</formatted>`
}
