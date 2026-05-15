// Telegram message chunking.
//
// Telegram caps sendMessage at 4096 chars. We chunk at 4000 by default to
// leave headroom for grammY's reply_parameters / parse_mode overhead.
//
// Boundary preference (port of gateway.py:514-562 + pre/code preservation
// improvement requested in PLAN T5):
//   1. Paragraph (\n\n) — split at the last paragraph break that fits
//   2. Line (\n) — split at the last line break that fits
//   3. Hard cut at `max` chars — only when neither boundary exists
//
// Pre/code preservation: if a split lands inside a <pre>…</pre> or
// <code>…</code> block, we close the open tag on the chunk we emit and
// reopen it on the next chunk so each chunk on its own is valid HTML and
// Telegram accepts each with parse_mode=HTML.

export const TELEGRAM_MAX_MESSAGE = 4096
const DEFAULT_MAX = 4000

// Tags we treat as "must stay balanced across chunk boundaries". <pre> is
// the common one (code blocks) — <code> is wrapped inside <pre> by our
// markdownToTelegramHtml fenced-block output but might appear alone for
// inline code. We balance both defensively.
type BalancedTag = 'pre' | 'code'
const BALANCED_TAGS: BalancedTag[] = ['pre', 'code']

interface OpenTagState {
  // Tags currently open at the cut point. Outermost first, innermost last —
  // we close innermost→outermost and reopen outermost→innermost.
  open: BalancedTag[]
}

/**
 * Scan `text` and report which balanced tags (pre, code) are still open
 * at the end of the substring. We treat opening tags with optional
 * attributes (e.g. `<code class="language-py">`) as opening — closers are
 * the literal `</pre>` / `</code>`.
 */
function openTagsAt(text: string): OpenTagState {
  const stack: BalancedTag[] = []
  // Match opens and closes for either tag, in document order.
  const re = /<\s*(\/?)\s*(pre|code)\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const isClose = m[1] === '/'
    const tag = (m[2] as string).toLowerCase() as BalancedTag
    if (isClose) {
      // Pop the most recent matching open. If none, ignore — input was
      // already malformed and we can't fix it here.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i] === tag) {
          stack.splice(i, 1)
          break
        }
      }
    } else {
      stack.push(tag)
    }
  }
  return { open: stack }
}

function closingTagsFor(state: OpenTagState): string {
  // Close innermost first.
  return [...state.open].reverse().map(t => `</${t}>`).join('')
}

function openingTagsFor(state: OpenTagState): string {
  // Reopen outermost first. We deliberately use bare opening tags (no
  // class attribute) on subsequent chunks — the "language-…" hint only
  // needs to live on the first chunk for Telegram's syntax styling.
  return state.open.map(t => `<${t}>`).join('')
}

/**
 * Choose the best cut index within [0, max] for `text`. Returns the cut
 * position (exclusive).
 *
 * Strict preference order (PLAN.md T5):
 *   1. last paragraph break (`\n\n`) at any position in [0, max]
 *   2. last line break (`\n`) at any position in [0, max]
 *   3. hard cut at exactly `max`
 *
 * No `minCut` floor: if the only natural boundary sits low (e.g. a 30-char
 * header followed by 4000 chars of single-line body), we still prefer it
 * over a hard cut in the middle of the line. Tiny prefix chunks are an
 * acceptable cost for honouring the documented preference order.
 */
function chooseCut(text: string, max: number): number {
  if (text.length <= max) return text.length

  const slice = text.slice(0, max)
  const lastPara = slice.lastIndexOf('\n\n')
  if (lastPara >= 0) return lastPara + 2 // include the \n\n in the emitted chunk

  const lastLine = slice.lastIndexOf('\n')
  if (lastLine >= 0) return lastLine + 1

  return max
}

/**
 * Split `text` into chunks that each render under Telegram's parse_mode=HTML.
 * Each chunk is <= `max` (default 4000). Leading newlines are trimmed from
 * each chunk after the first.
 *
 * If a balanced tag (<pre>, <code>) is open at a cut point, we close it on
 * the emitted chunk and reopen it on the next. This is a behavior addition
 * over gateway.py — the Python gateway hard-cuts and relies on the
 * parse-error fallback to retry as plain text.
 */
export function splitMessage(text: string, max: number = DEFAULT_MAX): string[] {
  if (max <= 0) throw new Error(`splitMessage: max must be positive, got ${max}`)
  if (text.length === 0) return []
  if (text.length <= max) return [text]

  const chunks: string[] = []
  let remaining = text
  // Tags inherited from the previous chunk that we need to reopen at the
  // start of this chunk.
  let inherited: OpenTagState = { open: [] }

  // Guard against pathological inputs that would otherwise loop forever.
  const hardCap = Math.ceil(text.length / Math.max(1, Math.floor(max / 4))) + 16
  let iterations = 0

  // Per-balanced-tag worst-case suffix length: `</pre>` = 6, `</code>` = 7.
  // We use the max over BALANCED_TAGS so the per-tag reservation upper-bounds
  // every closing tag we might emit; max across the set protects against
  // future tag additions (M6 hardening).
  const perTagSuffix = BALANCED_TAGS.reduce(
    (mx, t) => Math.max(mx, (`</${t}>`).length),
    0,
  )

  while (remaining.length > 0) {
    if (iterations++ > hardCap) {
      // Bail out — emit the rest as a single oversized chunk rather than
      // hang. Tests/typecheck should never hit this; it's defense-in-depth.
      chunks.push(openingTagsFor(inherited) + remaining)
      break
    }

    const prefix = openingTagsFor(inherited)
    // Budget for the substring we cut from `remaining`. Prefix tags eat
    // into the budget; we reserve room only for closing-tags we know are
    // open RIGHT NOW (inherited stack). Tags opened inside `body` are
    // handled by the overflow-recovery branch below.
    const suffixReserve = inherited.open.length * perTagSuffix
    const cut = chooseCut(remaining, Math.max(1, max - prefix.length - suffixReserve))
    const body = remaining.slice(0, cut)

    const afterState = openTagsAt(prefix + body)
    const suffix = closingTagsFor(afterState)
    let chunk = prefix + body + suffix

    // Overflow recovery. Triggers when the body itself opens new tags
    // we didn't budget for. Shrink the cut by the overflow PLUS a full
    // worst-case suffix budget (all balanced tags open) so the retry can
    // never overshoot again — this is the M6 hardening: previously we
    // used a hand-tuned `+8` fudge that could in theory be undersized.
    if (chunk.length > max) {
      const fullSuffixBudget = BALANCED_TAGS.length * perTagSuffix
      const overflow = chunk.length - max
      const newCut = Math.max(1, cut - overflow - fullSuffixBudget)
      const body2 = remaining.slice(0, newCut)
      const afterState2 = openTagsAt(prefix + body2)
      const suffix2 = closingTagsFor(afterState2)
      chunk = prefix + body2 + suffix2
      remaining = remaining.slice(newCut)
      inherited = afterState2
    } else {
      remaining = remaining.slice(cut)
      inherited = afterState
    }

    // Trim leading newlines on subsequent chunks (gateway.py paragraph split
    // does this implicitly — we do it explicitly). Prefix tags don't start
    // with \n so the regex is safe to run on the full chunk.
    if (chunks.length > 0) {
      chunk = chunk.replace(/^\n+/, '')
    }

    if (chunk.length > 0) chunks.push(chunk)
  }

  return chunks
}
