// Html components for replies: the vendored html-components Telegram packs
// (plugin/vendor/html-components, pinned commit in its VENDOR.md) rendered
// into widget html, plus a plain-text rendering of the same data for when a
// widget cannot be shown. No network at runtime: everything is read from the
// vendored copy.

import { readFileSync } from 'fs'

import { renderComponent, templates, validate } from '../../vendor/html-components/index.mjs'
import { TELEGRAM_MAX_MESSAGE } from '../format/chunk.js'
import { COMPONENT_NAMES, type ComponentName } from '../schemas.js'

export { COMPONENT_NAMES, type ComponentName }

export type ComponentRender =
  | { ok: true; html: string; caption: string }
  | { ok: false; reason: string }

const ERROR_HINTS: Record<string, string> = {
  UNKNOWN_PACK: 'no such component',
  INVALID_DATA: 'data does not match the component schema',
  CHAT_DATA_LIMIT: 'data is over 1024 bytes as chat_data',
  HTML_LIMIT: 'too much data for one widget (32 KiB raw / 3900 bytes zlib)',
}

// Renders one component into widget html + its generated caption. Never
// throws: a renderer exception becomes a RENDER_ERROR reason.
export function renderComponentWidget(name: ComponentName, data: unknown): ComponentRender {
  try {
    const out = renderComponent(name, data)
    if (out.error !== undefined) {
      const code = out.error.code
      return { ok: false, reason: `${code}: ${ERROR_HINTS[code] ?? 'render refused'}` }
    }
    return { ok: true, html: out.html, caption: out.caption }
  } catch (err) {
    return { ok: false, reason: `RENDER_ERROR: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// Schema and example of one pack, straight from the vendored files.
export function componentSchema(name: ComponentName): { component: ComponentName; schema: unknown; example: unknown } {
  const dir = new URL(`../../vendor/html-components/telegram/packs/${name}/`, import.meta.url)
  const read = (file: string): unknown => JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as unknown
  return { component: name, schema: read('schema.json'), example: read('example.json') }
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

// Shape-agnostic text for data the pack caption cannot handle (it failed
// validation): primitives of one object share a line, nested values follow
// on their own lines. Depth-capped so a hostile structure cannot recurse far.
function flatten(value: unknown, depth: number): string[] {
  if (depth > 6 || value === null || value === undefined) return []
  if (isPrimitive(value)) return [String(value)]
  if (Array.isArray(value)) {
    if (value.every(isPrimitive)) return value.length > 0 ? [value.map(String).join(' · ')] : []
    return value.flatMap(item => flatten(item, depth + 1))
  }
  if (typeof value === 'object') {
    const entries = Object.values(value as Record<string, unknown>)
    const head = entries.filter(isPrimitive).map(String).join(' ')
    const rest = entries.filter(v => !isPrimitive(v)).flatMap(v => flatten(v, depth + 1))
    return head.length > 0 ? [head, ...rest] : rest
  }
  return []
}

function capToOneMessage(text: string): string {
  if (text.length <= TELEGRAM_MAX_MESSAGE) return text
  return text.slice(0, TELEGRAM_MAX_MESSAGE - 1).replace(/[\uD800-\uDBFF]$/, '') + '…'
}

// Short readable plain text of the data, for a reply without a widget.
// Valid data uses the pack's own caption builder (the same text old clients
// see under the widget); anything else falls back to a generic flattening.
// Always non-empty and within one Telegram message.
export function componentFallbackText(name: string, data: unknown, header?: string): string {
  const record = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
  const title = typeof record.title === 'string' ? record.title : undefined
  let body: string | undefined
  const template = templates[name]
  if (template !== undefined && validate(name, data)) {
    try {
      body = template.caption(data)
    } catch {
      body = undefined
    }
  }
  if (body === undefined) {
    const { title: _omit, ...rest } = record
    body = flatten(Array.isArray(data) || isPrimitive(data) ? data : rest, 0).join('\n')
  }
  const parts = [header, title, body].filter((p): p is string => p !== undefined && p.trim().length > 0)
  const text = parts.join('\n')
  return capToOneMessage(text.length > 0 ? text : `(${name}: no data)`)
}
