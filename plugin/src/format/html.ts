// Telegram HTML formatting utilities.
//
// Ports the BEHAVIOR of gateway.py:261-410 (escape_html / escape_html_attr /
// markdown_to_telegram_html / is_html_parse_error). We do NOT copy source —
// we re-implement to match observed output for the same input.
//
// Telegram's HTML "subset" supports: b, strong, i, em, u, ins, s, strike, del,
// a (with href), code, pre, br, blockquote, tg-spoiler. Anything else gets
// escaped to its &amp;…; form. Inside a <pre>/<code> block, content is
// pre-escaped literal — we MUST NOT recursively format inside those.
//
// "snake_case" italic heuristic: a single `*…*` or `_…_` adjacent to word
// characters should NOT become <i>, otherwise identifiers like `foo_bar_baz`
// or `r * x` get mangled. We use lookbehind/lookahead on word boundaries.

// ─────────────────────────────────────────────────────────────────────
// Escaping
// ─────────────────────────────────────────────────────────────────────

/**
 * Escape the four characters Telegram requires fenced when parse_mode=HTML.
 * Order is load-bearing: ampersand first, otherwise we'd double-escape.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Like escapeHtml but also escapes single quotes — required when placing
 * user-controlled text inside an HTML attribute value (e.g. <a href="…">).
 */
export function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/'/g, '&#39;')
}

// ─────────────────────────────────────────────────────────────────────
// Parse error fingerprint
// ─────────────────────────────────────────────────────────────────────

// Telegram returns 400 with descriptions like "Bad Request: can't parse
// entities: Unexpected end tag at byte offset 42". We classify these so the
// caller can retry the same chunk in plain text instead of dropping the
// reply entirely. Matches gateway.py:255-258.
const PARSE_ERR_RE =
  /can't parse entities|parse entities|find end of the entity|unsupported start tag|unexpected end tag/i

/**
 * Detect whether a grammY/Telegram error indicates an HTML parse failure
 * that would be fixed by retrying with no parse_mode. Accepts any shape —
 * Error, GrammyError, plain object, response body — and walks the most
 * common locations.
 */
export function isTelegramHtmlParseError(error: unknown): boolean {
  if (error == null) return false

  const candidates: string[] = []
  const visited = new Set<unknown>()

  const visit = (value: unknown, depth: number): void => {
    if (value == null || depth > 4) return
    if (typeof value === 'string') {
      candidates.push(value)
      return
    }
    if (typeof value !== 'object') return
    if (visited.has(value)) return
    visited.add(value)

    const obj = value as Record<string, unknown>
    // Common locations for the Telegram description.
    visit(obj.description, depth + 1)
    visit(obj.message, depth + 1)
    visit(obj.error_message, depth + 1)
    visit(obj.body, depth + 1)
    visit(obj.response, depth + 1)
    visit(obj.payload, depth + 1)
  }

  visit(error, 0)
  return candidates.some(s => PARSE_ERR_RE.test(s))
}

// ─────────────────────────────────────────────────────────────────────
// Markdown → Telegram HTML
// ─────────────────────────────────────────────────────────────────────

// Tags that the agent might emit and we should preserve verbatim. Everything
// else gets escaped. Kept in sync with gateway.py:377.
const SAFE_TAGS = [
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'strike',
  'del',
  'code',
  'pre',
  'a',
  'br',
  'blockquote',
  'tg-spoiler',
]

const SAFE_TAG_RE = new RegExp(`</?(?:${SAFE_TAGS.join('|')})(?:\\s[^>]*)?>`, 'gi')

// Sentinel markers. Using a private-use unicode char keeps these out of any
// realistic input text (Telegram clients render U+E000 as undefined).
const SENTINEL = ''
const sentinel = (prefix: string, n: number): string => `${SENTINEL}${prefix}${n}${SENTINEL}`

interface Placeholder {
  key: string
  html: string
}

function stashCodeBlocks(input: string, store: Placeholder[]): string {
  // ```lang\n…``` — non-greedy, dotall via [\s\S].
  const re = /```([a-zA-Z0-9_+\-]*)\n?([\s\S]*?)```/g
  return input.replace(re, (_full, lang: string, body: string) => {
    const trimmed = body.replace(/\n+$/, '')
    const escaped = escapeHtml(trimmed)
    const html = lang
      ? `<pre><code class="language-${escapeHtmlAttr(lang)}">${escaped}</code></pre>`
      : `<pre><code>${escaped}</code></pre>`
    const key = sentinel('CB', store.length)
    store.push({ key, html })
    return key
  })
}

function stashInlineCode(input: string, store: Placeholder[]): string {
  // `…` — single line only.
  const re = /`([^`\n]+?)`/g
  return input.replace(re, (_full, code: string) => {
    const html = `<code>${escapeHtml(code)}</code>`
    const key = sentinel('IC', store.length)
    store.push({ key, html })
    return key
  })
}

function tableToPre(table: string): string {
  // Split into rows, drop separator rows like |---|---|.
  const lines = table.trim().split('\n').map(l => l.trim()).filter(Boolean)
  const dataLines = lines.filter(l => !/^\|[\s\-:|]+\|$/.test(l))
  if (dataLines.length === 0) return table

  const rows: string[][] = dataLines.map(line =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map(c => c.trim()),
  )

  const numCols = rows.reduce((m, r) => Math.max(m, r.length), 0)
  const widths = new Array<number>(numCols).fill(0)
  for (const row of rows) {
    for (let i = 0; i < numCols; i++) {
      const cell = row[i] ?? ''
      if (cell.length > widths[i]!) widths[i] = cell.length
    }
  }

  const out = rows
    .map(row => {
      const parts: string[] = []
      for (let i = 0; i < numCols; i++) {
        const cell = row[i] ?? ''
        parts.push(cell.padEnd(widths[i] ?? 0))
      }
      return parts.join('  ').replace(/\s+$/, '')
    })
    .join('\n')

  return `<pre>${escapeHtml(out)}</pre>`
}

function stashTables(input: string, store: Placeholder[]): string {
  // Recognize contiguous blocks where every line is "| … |". Tolerates an
  // optional separator row.
  const re = /(?:^[ \t]*\|.+\|[ \t]*\n)+(?:^[ \t]*\|[-:\s|]+\|[ \t]*\n)?(?:^[ \t]*\|.+\|[ \t]*\n)*/gm
  return input.replace(re, (full: string) => {
    const html = tableToPre(full)
    if (!html.startsWith('<pre>')) return full
    const key = sentinel('TB', store.length)
    store.push({ key, html })
    return key
  })
}

function stashSafeTags(input: string, store: Placeholder[]): string {
  return input.replace(SAFE_TAG_RE, match => {
    const key = sentinel('TG', store.length)
    store.push({ key, html: match })
    return key
  })
}

function stashMdLinks(input: string, store: Placeholder[]): string {
  // Extract [text](url) BEFORE escaping so the URL doesn't get double-
  // escaped by the global escape pass. gateway.py has a latent bug here
  // (it would emit &amp;amp; in URLs with &); we improve on that.
  const re = /\[([^\]\n]+)\]\(([^)\s]+)\)/g
  return input.replace(re, (_full, label: string, url: string) => {
    // Escape label as HTML body, URL as attribute.
    const html = `<a href="${escapeHtmlAttr(url)}">${escapeHtml(label)}</a>`
    const key = sentinel('LN', store.length)
    store.push({ key, html })
    return key
  })
}

function restoreAll(input: string, stores: Placeholder[][]): string {
  // Restore in reverse order of stashing so nested replacements unwind.
  let out = input
  for (const store of stores) {
    for (const p of store) out = out.split(p.key).join(p.html)
  }
  return out
}

/**
 * Convert a Markdown subset to the HTML subset Telegram accepts.
 *
 * Strategy: extract code/tables/safe-tags into sentinels, escape the rest,
 * apply markdown transforms on the escaped text, then restore sentinels.
 * This guarantees that:
 *   - HTML never appears inside a code block (we stashed code first)
 *   - User-typed `<script>` etc gets escaped, agent-written `<b>` survives
 *   - snake_case identifiers don't get accidentally italicized
 */
export function markdownToTelegramHtml(text: string): string {
  if (!text) return text

  const codeStore: Placeholder[] = []
  const tableStore: Placeholder[] = []
  const inlineStore: Placeholder[] = []
  const linkStore: Placeholder[] = []
  const tagStore: Placeholder[] = []

  // 1. Fenced code blocks → <pre><code>…</code></pre> placeholders.
  let work = stashCodeBlocks(text, codeStore)
  // 2. Markdown tables → aligned <pre> placeholders.
  work = stashTables(work, tableStore)
  // 3. Inline code → <code> placeholders.
  work = stashInlineCode(work, inlineStore)
  // 4. Markdown links → <a> placeholders BEFORE escaping (avoid double-escape).
  work = stashMdLinks(work, linkStore)
  // 5. Stash agent's safe HTML tags so escaping doesn't mangle them.
  work = stashSafeTags(work, tagStore)

  // 5. Escape remaining raw text.
  work = work
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // 6. Markdown transforms on escaped text.
  //   Headings: # heading → <b>heading</b>
  work = work.replace(/^(#{1,6})\s+(.+)$/gm, (_m, _hashes, content) => `<b>${content}</b>`)
  //   Bold **…**
  work = work.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
  //   Strike ~~…~~
  work = work.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>')
  //   Italic *…* — must NOT touch *foo* if surrounded by word chars
  //   (multiplication, snake-globs, etc).
  work = work.replace(/(^|[^\w*])\*([^*\n]+?)\*(?!\w)/g, '$1<i>$2</i>')
  //   Italic _…_ — require whitespace/punct boundary, never inside identifiers.
  work = work.replace(
    /(^|[\s.,;:!?([])_([^_\n]+?)_(?=$|[\s.,;:!?)\]])/g,
    '$1<i>$2</i>',
  )
  // (links already stashed before escape — nothing to do here)

  // 7. Restore: safe tags → links → inline code → tables → code blocks.
  work = restoreAll(work, [tagStore, linkStore, inlineStore, tableStore, codeStore])
  return work
}
