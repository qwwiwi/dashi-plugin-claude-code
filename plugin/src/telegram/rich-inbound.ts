// Inbound Telegram Bot API 10.1 "Rich Messages" — pure normalizer (no I/O).
//
// WHY: a rich message carries its content in `message.rich_message.blocks`
// (paragraphs, headings, lists, tables, media blocks…) instead of
// `message.text` / `message.caption`. The inbound handlers are registered on
// `message:text` and on media filters, so a rich prompt from the owner was
// dropped whole — only an attached screenshot (top-level `photo`) reached the
// session (owner-reported 2026-10-11).
//
// FIX: a middleware runs this BEFORE the handlers. It flattens the blocks to
// plain markdown-ish text and writes it where the existing pipeline already
// reads user input: `caption` when the message carries media, `text`
// otherwise. If the only media lives inside a block, the FIRST media block is
// promoted to the matching top-level field so the existing media handler
// downloads it. Everything downstream (allowlist gate, redaction, prompt
// build) stays the single code path — this module only fills in fields.
//
// It never overwrites a `text` or `caption` Telegram already set.

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Top-level media fields a message can carry, in handler-relevant order.
const TOP_LEVEL_MEDIA = ['photo', 'animation', 'document', 'video', 'voice', 'audio', 'video_note', 'sticker'] as const

// Media block type → top-level message field (the block keeps the media
// object under its own `type` name) + the marker shown in the flattened text.
const MEDIA_BLOCKS: Record<string, { field: string; label: string }> = {
  photo: { field: 'photo', label: 'фото' },
  video: { field: 'video', label: 'видео' },
  animation: { field: 'animation', label: 'анимация' },
  document: { field: 'document', label: 'документ' },
  audio: { field: 'audio', label: 'аудио' },
  voice_note: { field: 'voice', label: 'голосовое' },
}

// Nesting cap for RichText / RichBlock recursion. Real messages nest a few
// levels; a hostile or corrupt payload nested thousands deep must not blow
// the stack inside the middleware (that would stop next() and drop the update).
const MAX_DEPTH = 64

/** Flatten a RichText (string | RichText[] | typed object) to plain text. */
export function richTextToPlain(rt: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) return ''
  const d = depth + 1
  if (typeof rt === 'string') return rt
  if (Array.isArray(rt)) return rt.map(x => richTextToPlain(x, d)).join('')
  if (!isObj(rt)) return ''
  switch (rt.type) {
    case 'url': {
      const label = richTextToPlain(rt.text, d)
      const url = typeof rt.url === 'string' ? rt.url : ''
      return url && label !== url ? `${label} (${url})` : label || url
    }
    case 'custom_emoji':
      return typeof rt.alternative_text === 'string' ? rt.alternative_text : ''
    case 'mathematical_expression':
      return typeof rt.expression === 'string' ? `$${rt.expression}$` : ''
    case 'code':
      return `\`${richTextToPlain(rt.text, d)}\``
    case 'button': {
      // RichMessageButton.text is RichText, not just a string.
      const label = isObj(rt.button) ? richTextToPlain(rt.button.text, d) : ''
      return label ? `[${label}]` : ''
    }
    case 'anchor':
      return ''
    default:
      // bold/italic/mention/hashtag/… and any future inline type: keep the text.
      return richTextToPlain(rt.text, d)
  }
}

// RichBlockCaption {text, credit?} (media/collage/map) or a bare RichText
// (table caption). A credit is appended after « – ».
function captionOf(cap: unknown, d: number): string {
  if (isObj(cap) && cap.type === undefined && ('text' in cap || 'credit' in cap)) {
    return withCredit(richTextToPlain(cap.text, d), cap.credit, d)
  }
  return richTextToPlain(cap, d)
}

function withCredit(text: string, credit: unknown, d: number): string {
  const c = richTextToPlain(credit, d)
  return c ? [text, `– ${c}`].filter(Boolean).join(' ') : text
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map(line => prefix + line)
    .join('\n')
}

function blocksToText(blocks: unknown, depth: number): string {
  if (!Array.isArray(blocks) || depth > MAX_DEPTH) return ''
  return blocks
    .map(b => blockToText(b, depth + 1))
    .filter(s => s.length > 0)
    .join('\n\n')
}

function blockToText(block: unknown, d: number): string {
  if (!isObj(block) || d > MAX_DEPTH) return ''
  const media = typeof block.type === 'string' ? MEDIA_BLOCKS[block.type] : undefined
  if (media !== undefined) {
    const cap = captionOf(block.caption, d)
    return cap ? `[${media.label}] ${cap}` : `[${media.label}]`
  }
  switch (block.type) {
    case 'heading': {
      const size = typeof block.size === 'number' && block.size >= 1 && block.size <= 6 ? block.size : 1
      return `${'#'.repeat(size)} ${richTextToPlain(block.text, d)}`
    }
    case 'pre': {
      const lang = typeof block.language === 'string' ? block.language : ''
      return `\`\`\`${lang}\n${richTextToPlain(block.text, d)}\n\`\`\``
    }
    case 'divider':
      return '---'
    case 'mathematical_expression':
      return typeof block.expression === 'string' ? `$$${block.expression}$$` : ''
    case 'list': {
      if (!Array.isArray(block.items)) return ''
      return block.items
        .filter(isObj)
        .map(item => {
          const label = typeof item.label === 'string' && item.label ? item.label : '-'
          const box = item.has_checkbox === true ? (item.is_checked === true ? '[x] ' : '[ ] ') : ''
          const body = blocksToText(item.blocks, d)
          const [first = '', ...rest] = body.split('\n')
          const tail = rest.length ? '\n' + indent(rest.join('\n'), '   ') : ''
          return `${label} ${box}${first}${tail}`
        })
        .join('\n')
    }
    case 'blockquote':
      return indent(withCredit(blocksToText(block.blocks, d), block.credit, d), '> ')
    case 'expandable_blockquote':
    case 'pullquote':
      return indent(withCredit(richTextToPlain(block.text, d), block.credit, d), '> ')
    case 'details': {
      const summary = richTextToPlain(block.summary, d)
      const body = blocksToText(block.blocks, d)
      return [summary, body].filter(Boolean).join('\n')
    }
    case 'collage':
    case 'slideshow': {
      const cap = captionOf(block.caption, d)
      return [blocksToText(block.blocks, d), cap].filter(Boolean).join('\n\n')
    }
    case 'table': {
      if (!Array.isArray(block.cells)) return ''
      const rows = block.cells
        .filter(Array.isArray)
        .map(row => `| ${row.map(cell => (isObj(cell) ? richTextToPlain(cell.text, d) : '')).join(' | ')} |`)
      const cap = captionOf(block.caption, d)
      return [cap, rows.join('\n')].filter(Boolean).join('\n')
    }
    case 'map': {
      const cap = captionOf(block.caption, d)
      return cap ? `[карта] ${cap}` : '[карта]'
    }
    case 'buttons': {
      if (!Array.isArray(block.buttons)) return ''
      return block.buttons
        .map(b => (isObj(b) ? richTextToPlain(b.text, d) : ''))
        .filter(Boolean)
        .map(label => `[${label}]`)
        .join(' ')
    }
    case 'anchor':
    case 'thinking':
      return ''
    default:
      // paragraph, footer, and any future block type that carries `text`.
      return richTextToPlain(block.text, d) || blocksToText(block.blocks, d)
  }
}

/** Flatten `message.rich_message` to plain text. Never throws. */
export function richMessageToText(rich: unknown): string {
  if (!isObj(rich)) return ''
  return blocksToText(rich.blocks, 0).trim()
}

// Depth-first list of media blocks (collages/slideshows/quotes/lists nest blocks).
function collectMediaBlocks(blocks: unknown, out: Obj[], depth: number): Obj[] {
  if (!Array.isArray(blocks) || depth > MAX_DEPTH) return out
  for (const b of blocks) {
    if (!isObj(b)) continue
    if (typeof b.type === 'string' && MEDIA_BLOCKS[b.type] !== undefined && b[b.type] !== undefined) out.push(b)
    collectMediaBlocks(b.blocks, out, depth + 1)
    if (Array.isArray(b.items)) {
      for (const item of b.items) if (isObj(item)) collectMediaBlocks(item.blocks, out, depth + 1)
    }
  }
  return out
}

/**
 * Outcome of normalizing one message:
 *   'flattened' — text/caption (and maybe one media field) were filled in;
 *   'kept'      — a rich message already had text/caption, left untouched
 *                 (logged so an undocumented Telegram shape is visible in prod);
 *   'none'      — not a rich message, or nothing to add.
 */
export type RichNormalizeOutcome = 'flattened' | 'kept' | 'none'

/**
 * Fill `text`/`caption` (and, when needed, one top-level media field) of an
 * inbound message from its `rich_message`. Mutates `message` in place.
 */
export function normalizeRichInbound(message: Obj): RichNormalizeOutcome {
  const rich = message.rich_message
  if (!isObj(rich)) return 'none'
  if (message.text !== undefined || message.caption !== undefined) return 'kept'

  let text = richMessageToText(rich)
  const media = collectMediaBlocks(rich.blocks, [], 0)
  const topField = TOP_LEVEL_MEDIA.find(f => message[f] !== undefined)
  let attached = 0

  if (topField !== undefined) {
    // Telegram duplicated one media into the top-level field (e.g. `photo`):
    // one matching block is that same media, the rest are not attached.
    attached = media.some(b => typeof b.type === 'string' && MEDIA_BLOCKS[b.type]?.field === topField) ? 1 : 0
  } else if (media[0] !== undefined && typeof media[0].type === 'string') {
    const first = media[0]
    const spec = MEDIA_BLOCKS[first.type as string]
    if (spec !== undefined) {
      message[spec.field] = first[first.type as string]
      attached = 1
    }
  }
  const missing = media.length - attached
  if (missing > 0) {
    text = [text, `[в rich-сообщении ещё ${missing} медиа – не приложено]`].filter(Boolean).join('\n\n')
  }

  const hasMedia = topField !== undefined || attached > 0
  if (!text) return attached > 0 ? 'flattened' : 'none'
  if (hasMedia) message.caption = text
  else message.text = text
  return 'flattened'
}

/**
 * grammY middleware: normalize `message` / `guest_message` rich content (and
 * the message they reply to, so a reply to a rich card keeps its context)
 * before any filter (`message:text`, `message:photo`, …) runs. `onEvent` is a
 * logging hook. Any unexpected error is reported and the update still flows.
 */
export function richInboundMiddleware(
  onEvent?: (updateKey: string, outcome: Exclude<RichNormalizeOutcome, 'none'>) => void,
  onError?: (error: unknown) => void,
): (ctx: { update: object }, next: () => Promise<void>) => Promise<void> {
  return (ctx, next) => {
    try {
      const update = ctx.update as Obj
      for (const key of ['message', 'guest_message']) {
        const msg = update[key]
        if (!isObj(msg)) continue
        const outcome = normalizeRichInbound(msg)
        if (outcome !== 'none') onEvent?.(key, outcome)
        if (isObj(msg.reply_to_message)) {
          const replyOutcome = normalizeRichInbound(msg.reply_to_message)
          if (replyOutcome !== 'none') onEvent?.(`${key}.reply_to_message`, replyOutcome)
        }
      }
    } catch (err) {
      onError?.(err)
    }
    return next()
  }
}
