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

/** Flatten a RichText (string | RichText[] | typed object) to plain text. */
export function richTextToPlain(rt: unknown): string {
  if (typeof rt === 'string') return rt
  if (Array.isArray(rt)) return rt.map(richTextToPlain).join('')
  if (!isObj(rt)) return ''
  switch (rt.type) {
    case 'url': {
      const label = richTextToPlain(rt.text)
      const url = typeof rt.url === 'string' ? rt.url : ''
      return url && label !== url ? `${label} (${url})` : label || url
    }
    case 'custom_emoji':
      return typeof rt.alternative_text === 'string' ? rt.alternative_text : ''
    case 'mathematical_expression':
      return typeof rt.expression === 'string' ? `$${rt.expression}$` : ''
    case 'code':
      return `\`${richTextToPlain(rt.text)}\``
    case 'button':
      return isObj(rt.button) && typeof rt.button.text === 'string' ? `[${rt.button.text}]` : ''
    case 'anchor':
      return ''
    default:
      // bold/italic/mention/hashtag/… and any future inline type: keep the text.
      return richTextToPlain(rt.text)
  }
}

function captionOf(block: Obj): string {
  const cap = block.caption
  if (isObj(cap)) return richTextToPlain(cap.text)
  return richTextToPlain(cap)
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map(line => prefix + line)
    .join('\n')
}

function blocksToText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map(blockToText)
    .filter(s => s.length > 0)
    .join('\n\n')
}

function blockToText(block: unknown): string {
  if (!isObj(block)) return ''
  const media = typeof block.type === 'string' ? MEDIA_BLOCKS[block.type] : undefined
  if (media !== undefined) {
    const cap = captionOf(block)
    return cap ? `[${media.label}] ${cap}` : `[${media.label}]`
  }
  switch (block.type) {
    case 'heading': {
      const size = typeof block.size === 'number' && block.size >= 1 && block.size <= 6 ? block.size : 1
      return `${'#'.repeat(size)} ${richTextToPlain(block.text)}`
    }
    case 'pre': {
      const lang = typeof block.language === 'string' ? block.language : ''
      return `\`\`\`${lang}\n${richTextToPlain(block.text)}\n\`\`\``
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
          const body = blocksToText(item.blocks)
          const [first = '', ...rest] = body.split('\n')
          const tail = rest.length ? '\n' + indent(rest.join('\n'), '   ') : ''
          return `${label} ${box}${first}${tail}`
        })
        .join('\n')
    }
    case 'blockquote':
      return indent(blocksToText(block.blocks), '> ')
    case 'expandable_blockquote':
    case 'pullquote':
      return indent(richTextToPlain(block.text), '> ')
    case 'details': {
      const summary = richTextToPlain(block.summary)
      const body = blocksToText(block.blocks)
      return [summary, body].filter(Boolean).join('\n')
    }
    case 'collage':
    case 'slideshow': {
      const cap = captionOf(block)
      return [blocksToText(block.blocks), cap].filter(Boolean).join('\n\n')
    }
    case 'table': {
      if (!Array.isArray(block.cells)) return ''
      const rows = block.cells
        .filter(Array.isArray)
        .map(row => `| ${row.map(cell => (isObj(cell) ? richTextToPlain(cell.text) : '')).join(' | ')} |`)
      const cap = richTextToPlain(block.caption)
      return [cap, rows.join('\n')].filter(Boolean).join('\n')
    }
    case 'map':
      return '[карта]'
    case 'buttons':
    case 'anchor':
    case 'thinking':
      return ''
    default:
      // paragraph, footer, and any future block type that carries `text`.
      return richTextToPlain(block.text) || blocksToText(block.blocks)
  }
}

/** Flatten `message.rich_message` to plain text. Never throws. */
export function richMessageToText(rich: unknown): string {
  if (!isObj(rich)) return ''
  return blocksToText(rich.blocks).trim()
}

// Depth-first list of media blocks (collages/slideshows/quotes nest blocks).
function collectMediaBlocks(blocks: unknown, out: Obj[]): Obj[] {
  if (!Array.isArray(blocks)) return out
  for (const b of blocks) {
    if (!isObj(b)) continue
    if (typeof b.type === 'string' && MEDIA_BLOCKS[b.type] !== undefined) out.push(b)
    collectMediaBlocks(b.blocks, out)
    if (Array.isArray(b.items)) for (const item of b.items) if (isObj(item)) collectMediaBlocks(item.blocks, out)
  }
  return out
}

/**
 * Fill `text`/`caption` (and, when needed, one top-level media field) of an
 * inbound message from its `rich_message`. Mutates `message` in place.
 * Returns true when the message was changed.
 */
export function normalizeRichInbound(message: Obj): boolean {
  const rich = message.rich_message
  if (!isObj(rich)) return false
  if (message.text !== undefined || message.caption !== undefined) return false

  let text = richMessageToText(rich)
  let hasMedia = TOP_LEVEL_MEDIA.some(f => message[f] !== undefined)

  if (!hasMedia) {
    const media = collectMediaBlocks(rich.blocks, [])
    const first = media[0]
    if (first !== undefined && typeof first.type === 'string') {
      const spec = MEDIA_BLOCKS[first.type]
      if (spec !== undefined && first[first.type] !== undefined) {
        message[spec.field] = first[first.type]
        hasMedia = true
        if (media.length > 1) {
          text = [text, `[в rich-сообщении ещё ${media.length - 1} медиа – не приложено]`].filter(Boolean).join('\n\n')
        }
      }
    }
  }

  if (!text && !hasMedia) return false
  if (hasMedia) {
    if (text) message.caption = text
  } else {
    message.text = text
  }
  return true
}

/**
 * grammY middleware: normalize `message` / `guest_message` rich content before
 * any filter (`message:text`, `message:photo`, …) runs. `onFlatten` is called
 * with the update key for each message it changed (logging hook).
 */
export function richInboundMiddleware(
  onFlatten?: (updateKey: string) => void,
): (ctx: { update: object }, next: () => Promise<void>) => Promise<void> {
  return (ctx, next) => {
    const update = ctx.update as Obj
    for (const key of ['message', 'guest_message']) {
      const msg = update[key]
      if (isObj(msg) && normalizeRichInbound(msg)) onFlatten?.(key)
    }
    return next()
  }
}
