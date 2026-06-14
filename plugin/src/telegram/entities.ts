// Reconstruct Markdown links from Telegram message entities so the agent
// receives the URL behind a hyperlink, not just its visible label.
//
// Telegram delivers hyperlinks out-of-band: `entities` (for a text message)
// and `caption_entities` (for media captions). A `text_link` entity carries
// the target in `.url` and covers the substring [offset, offset+length)
// measured in UTF-16 code units — which match JS string indexing. The raw
// `text`/`caption` field holds only the visible label, so without this a
// forwarded `[читать](https://…)` reaches Claude as bare `читать` and the
// link is lost.

export interface MessageEntityLike {
  type: string
  offset: number
  length: number
  url?: string
}

export interface EntityCarrier {
  text?: string
  caption?: string
  entities?: readonly MessageEntityLike[]
  caption_entities?: readonly MessageEntityLike[]
}

/**
 * Return the message's text (or caption) with `text_link` hyperlinks
 * re-expanded to Markdown `[label](url)`. Non-link entities and messages
 * without link entities are returned unchanged. Safe on `undefined`.
 */
export function textWithEntities(msg: EntityCarrier | undefined): string {
  if (!msg) return ''
  const base = msg.text ?? msg.caption ?? ''
  const entities = msg.text !== undefined ? msg.entities : msg.caption_entities
  if (!base || !entities || entities.length === 0) return base

  const links = entities
    .filter(
      (e): e is MessageEntityLike & { url: string } =>
        e.type === 'text_link' && typeof e.url === 'string' && e.url.length > 0,
    )
    // Splice right-to-left so earlier offsets stay valid as we mutate.
    .sort((a, b) => b.offset - a.offset)

  let out = base
  for (const e of links) {
    const label = out.slice(e.offset, e.offset + e.length)
    out = out.slice(0, e.offset) + `[${label}](${e.url})` + out.slice(e.offset + e.length)
  }
  return out
}
