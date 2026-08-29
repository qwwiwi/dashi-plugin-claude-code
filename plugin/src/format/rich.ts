// Telegram Bot API 10.1 "Rich Messages" — pure helpers (no I/O).
//
// Rich Messages let Telegram render RAW markdown server-side: tables, math,
// headings, task-lists, <details>, footnotes — far beyond the HTML subset
// markdownToTelegramHtml targets. The cap is 32768 bytes (vs 4096 for a
// normal sendMessage), so a long structured answer ships as ONE message
// instead of being chunked + lossily HTML-converted.
//
// This module is deliberately side-effect-free: it only classifies errors,
// checks length limits, and builds the raw-api request body. The actual
// send (and the transparent HTML fallback) lives in the safe-telegram-api
// wrapper + the reply tool, so redaction and rate-limiting still apply.
//
// Layering reminder: the rich method is a new TelegramApi method so it flows
// through safeTelegramApi (redaction) → rateLimitedTelegramApi (429 queue)
// → rawTelegramApi (grammY raw escape hatch). NEVER call the raw send
// directly from the reply tool — that would bypass secret redaction.

// Telegram Bot API 10.1 rich-message body cap. Telegram measures this in
// UTF-8 bytes, not JS code-units; contentFitsRichLimits() below compares
// byte length so a Cyrillic/emoji-heavy answer is gated correctly.
export const RICH_MESSAGE_MAX_CHARS = 32768

// ─────────────────────────────────────────────────────────────────────
// Soft-break hardening (newline preservation on the rich path)
// ─────────────────────────────────────────────────────────────────────
//
// WHY: Bot API 10.1 rich messages render RAW markdown server-side with
// CommonMark semantics. Under CommonMark a single `\n` between two prose
// lines is a *soft break* that collapses to a space — so an answer like
//   «M1 — …\nM2 — …»
// renders as one merged wall of text on the phone (owner-reported,
// screenshot-verified 2026-07-09). The plugin's own HTML converter
// (format/html.ts) keeps newlines literal, so ONLY the rich path leaks.
//
// FIX: before the rich body is sent, promote every lone soft break between
// two plain prose lines into a CommonMark HARD break. We use the backslash-
// at-end-of-line form (`\` + `\n`) — CommonMark's canonical hard break that
// survives whitespace-trimming (unlike trailing-two-spaces, which editors
// and transports silently strip). NOTE FOR LIVE VERIFICATION: confirm on a
// real device that Telegram's rich renderer honours the backslash hard break;
// if it does not, switch HARD_BREAK to '  ' (two trailing spaces).
//
// SCOPE (deliberately conservative — target the reported bug, nothing else):
//   * Only a boundary between two *plain prose* lines is hardened. Markdown
//     block constructs already break on their own, so they are left alone:
//     list items (`- `, `* `, `1. `), ATX headings (`# `), blockquotes (`> `),
//     tables (`| … |`), fenced code, and thematic breaks are NOT hardened,
//     and a break INTO or OUT OF one of them is left untouched.
//   * Blank lines (`\n\n+`, paragraph breaks) are never touched.
//   * Fenced code blocks, inline code content, and table blocks pass through
//     byte-identical (we only ever append `\` to a *plain prose* line, and a
//     closed inline-code span sits fully inside that line, so its bytes are
//     unchanged).
//   * A line already ending in a hard break (trailing `\` or 2+ spaces) or
//     carrying an unbalanced backtick is left as-is.

// CommonMark hard-line-break token appended before the preserved `\n`.
const HARD_BREAK = '\\'

// A line that begins a markdown block construct — these already render as
// their own block, so a soft break adjacent to one needs no hardening.
const BLOCK_START_RE =
  /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|\||```|~~~|(?:[-*_])\s*(?:[-*_])\s*(?:[-*_]))/

/** True when `line` is blank (empty or whitespace-only). */
function isBlankLine(line: string): boolean {
  return line.trim().length === 0
}

/** True when `line` is plain prose: non-blank and not a markdown block start. */
function isProseLine(line: string): boolean {
  return !isBlankLine(line) && !BLOCK_START_RE.test(line)
}

/** True when `line` already ends in a CommonMark hard break. */
function endsWithHardBreak(line: string): boolean {
  return /(?:\\|\s{2,})$/.test(line)
}

/** True when `line` has an odd number of backticks (possibly unbalanced
 *  inline code) — conservatively skip hardening it. */
function hasUnbalancedBacktick(line: string): boolean {
  const count = (line.match(/`/g) ?? []).length
  return count % 2 === 1
}

/**
 * Per-line fenced-code mask: `true` = the line is a fence delimiter or lives
 * inside an open fence and must be treated as protected code.
 *
 * CommonMark fence matching (review fix 2026-07-09): an OPENING fence is a
 * run of 3+ backticks or tildes (an info string may follow); the CLOSING
 * fence must use the SAME character, be at least as LONG as the opener, and
 * carry nothing but whitespace after the run. The previous scan toggled on
 * ANY ```/~~~ line, so a ``` line inside an open ~~~ fence was treated as a
 * closer and hardening injected backslashes into subsequent code lines —
 * corrupting copy-paste shell snippets.
 *
 * Shared by hardenSoftBreaks and the observe-only format checker so both
 * agree on what counts as protected code.
 */
export function fenceProtectedLines(lines: ReadonlyArray<string>): boolean[] {
  const mask: boolean[] = new Array<boolean>(lines.length).fill(false)
  let open: { char: string; len: number } | undefined
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[i] as string)
    if (open === undefined) {
      if (m !== null) {
        mask[i] = true
        const run = m[1] as string
        open = { char: run[0] as string, len: run.length }
      }
      continue
    }
    // Inside an open fence: every line (including the closer) is code.
    mask[i] = true
    if (m !== null) {
      const run = m[1] as string
      const trailing = (m[2] as string).trim()
      if (run[0] === open.char && run.length >= open.len && trailing === '') {
        open = undefined
      }
    }
  }
  return mask
}

/**
 * Promote lone soft breaks into CommonMark hard breaks so Telegram's rich
 * (raw-markdown) renderer shows a real line break instead of collapsing the
 * newline into a space. Pure and idempotent-ish: re-running never stacks a
 * second break because a line already ending in `\` is skipped.
 *
 * Applied to the RAW markdown body BEFORE redaction/send on the rich path
 * only — the HTML path keeps newlines literal and must NOT be routed here.
 */
export function hardenSoftBreaks(text: string): string {
  if (text.length === 0) return text
  // CRLF → LF first so `\r` never rides along into the emitted body.
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')

  // Fence-aware protection with CommonMark open/close matching — prose-
  // looking lines INSIDE a fence stay byte-identical.
  const insideFence = fenceProtectedLines(lines)

  // Rebuild, deciding each boundary (between line i and i+1) independently.
  let out = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    out += line
    if (i === lines.length - 1) break // no trailing boundary to consider

    const next = lines[i + 1] as string
    const harden =
      !insideFence[i] &&
      !insideFence[i + 1] &&
      isProseLine(line) &&
      isProseLine(next) &&
      !endsWithHardBreak(line) &&
      !hasUnbalancedBacktick(line)

    if (harden) out += HARD_BREAK
    out += '\n'
  }
  return out
}

/**
 * True when `text` fits inside a single rich message. Telegram counts the
 * body in UTF-8 bytes, so we measure bytes — not `text.length` (which counts
 * UTF-16 code units and would let a Cyrillic payload sneak past the cap).
 * Boundary: exactly RICH_MESSAGE_MAX_CHARS bytes fits; one more does not.
 */
export function contentFitsRichLimits(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') <= RICH_MESSAGE_MAX_CHARS
}

// Error classification for the rich send path. Drives the transparent
// fallback in safe-telegram-api:
//   - capability : Telegram (or this grammY build) doesn't know the method.
//                  Latch it OFF for the session and fall back to HTML.
//   - parser     : Telegram's markdown parser rejected the body (400). One-off
//                  fall back to HTML (which DOES validate) — do NOT latch.
//   - oversize   : body too large (400 about size). Fall back to HTML chunking.
//   - transient  : anything else (network, 5xx, 429). Re-throw — the
//                  rate-limit wrapper handles 429; other transients surface so
//                  we never silently swallow then double-send.
export type RichErrorClass = 'capability' | 'parser' | 'oversize' | 'transient'

// Pull an HTTP-ish status code out of the many shapes an error can take:
// grammY's GrammyError (`error_code`), a fetch Response-ish (`status`), or a
// plain object carrying either. Returns undefined when no numeric code found.
function extractStatusCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const e = err as Record<string, unknown>
  if (typeof e.error_code === 'number') return e.error_code
  if (typeof e.status === 'number') return e.status
  if (typeof e.statusCode === 'number') return e.statusCode
  return undefined
}

// Lowercased human-readable message for substring sniffing. grammY's
// GrammyError exposes `.description`; native errors expose `.message`.
function extractMessage(err: unknown): string {
  if (typeof err === 'string') return err.toLowerCase()
  if (typeof err !== 'object' || err === null) return ''
  const e = err as Record<string, unknown>
  const parts: string[] = []
  if (typeof e.description === 'string') parts.push(e.description)
  if (typeof e.message === 'string') parts.push(e.message)
  return parts.join(' ').toLowerCase()
}

/**
 * Classify a rich-send failure so the caller can decide fallback vs latch
 * vs re-throw. See RichErrorClass for the policy each class drives.
 *
 * capability — HTTP 404, or message mentioning "method not found",
 *   "unsupported", "not implemented". Telegram returns 404 for unknown
 *   methods; an older grammY/local build can surface "not found"/"unsupported".
 * parser — a 400 BadRequest that is NOT about size. Markdown the parser
 *   rejected; one-off fall back to the HTML path.
 * oversize — a 400 mentioning the body being too large ("too long",
 *   "message is too long", "too large", "entities too long").
 * transient — everything else (network, 5xx, 429, unknown). Re-thrown.
 */
export function richErrorClass(err: unknown): RichErrorClass {
  const code = extractStatusCode(err)
  const msg = extractMessage(err)

  // Capability: explicit 404, or a message that names the method as unknown.
  // Checked first because some transports report unknown-method as 400 with a
  // "method not found" description rather than 404.
  if (
    code === 404 ||
    msg.includes('method not found') ||
    msg.includes('not implemented') ||
    msg.includes('unsupported') ||
    msg.includes('method is not supported')
  ) {
    return 'capability'
  }

  if (code === 400) {
    // Oversize is a 400 sub-case — sniff the size wording first so we don't
    // misclassify it as a generic parser error (both fall back, but the
    // distinction is useful for logs/metrics and matches the spec contract).
    if (
      msg.includes('too long') ||
      msg.includes('too large') ||
      msg.includes('message is too long') ||
      msg.includes('entities too long')
    ) {
      return 'oversize'
    }
    return 'parser'
  }

  // 5xx, 429, network errors, or anything we can't read — treat as transient
  // and let the caller re-throw (the rate-limit wrapper owns 429 retries).
  return 'transient'
}

// Options accepted by buildRichMessagePayload. Mirrors the subset of the
// rich-message body we set today (chat target + threading via
// reply_parameters). Kept minimal — M3/M4 can extend (streaming drafts,
// group threads).
export interface BuildRichMessageOpts {
  chat_id: string
  reply_to_message_id?: number
}

// Shape of the raw-api body handed to grammY's
// `bot.api.raw.sendRichMessage(...)`. grammY raw bodies are plain objects
// keyed by the Bot API param names. We model the fields we set; `[key:
// string]` would invite typos, so we keep it explicit + optional.
//
// Wire format confirmed against the shipped Hermes reference
// (gateway/platforms/telegram.py `_rich_message_payload`/`_try_send_rich`):
// sendRichMessage takes a top-level `rich_message` InputRichMessage object
// whose raw markdown lives in its `markdown` field — NOT a flat top-level
// `markdown`. i.e. `sendRichMessage(chat_id, rich_message={markdown}, reply_parameters?)`.
export interface InputRichMessage {
  markdown: string
}
export interface RichMessageBody {
  chat_id: string
  rich_message: InputRichMessage
  reply_parameters?: { message_id: number }
}

/**
 * Build the raw-api request body for sendRichMessage. Pure: no redaction,
 * no I/O. Redaction runs on `rawMarkdown` in the safe wrapper BEFORE this
 * body reaches the transport, so do not pre-process the text here.
 *
 * grammY raw bodies use Bot-API param names directly — threading is
 * `reply_parameters: { message_id }` (same convention createTelegramApi
 * uses for sendMessage), not the legacy `reply_to_message_id`.
 */
export function buildRichMessagePayload(
  rawMarkdown: string,
  opts: BuildRichMessageOpts,
): RichMessageBody {
  const body: RichMessageBody = {
    chat_id: opts.chat_id,
    rich_message: { markdown: rawMarkdown },
  }
  if (opts.reply_to_message_id !== undefined) {
    body.reply_parameters = { message_id: opts.reply_to_message_id }
  }
  return body
}

// ─────────────────────────────────────────────────────────────────────
// Selective rich delivery + client-crash shields
// ─────────────────────────────────────────────────────────────────────
//
// Ported 1:1 from the Hermes reference implementation (NousResearch/
// hermes-agent, release v2026.8.27 / v0.20.6, plugins/platforms/telegram/
// adapter.py). Hermes shipped rich messages first, then walked the default
// back to opt-in after live client damage. Rather than repeat their path we
// adopt the end state directly:
//
//   1. needsRichRendering() — only pay the rich path when raw markdown
//      MATERIALLY beats the HTML path. Ordinary prose stays on HTML so
//      Telegram renders a consistent font weight/spacing and the text stays
//      easy to copy (their stated reason for defaulting rich off: rich
//      bodies are awkward to copy as plain text, which is worse than a
//      degraded table for command snippets and mobile handoffs).
//   2. hasDetailsMathCrashShape() — math INSIDE a <details> block crashes
//      Telegram Desktop 6.9.1 while rendering a rich message
//      (telegramdesktop/tdesktop#30808). The Bot API accepts the payload, so
//      the sender must refuse up front.
//   3. hasCjkGarbleShape() — CJK/Hangul text renders with overlapping glyph
//      artifacts in current Telegram Mac/Desktop rich rendering (#47653).
//      The HTML path renders the same text cleanly.
//
// Both shields are "skip rich, send the legacy way" — never "drop the
// message". Content that trips them still ships, just through HTML.

// A GFM table separator row: `|---|:--:|` etc. Presence of such a line is the
// cheapest reliable signal that the body contains a pipe table — the one
// construct the HTML converter flattens into a <pre> block.
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/
// GFM task list: `- [ ] item` / `* [x] item`.
const TASK_LIST_RE = /^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/m
// Collapsible block markers at the start of a line.
const DETAILS_LINE_RE = /^(<details\b|<\/details>|<summary\b|<\/summary>)/m
// Block math delimiter.
const BLOCK_MATH = '$$'

/**
 * True when the body contains a construct the legacy HTML path degrades, so
 * the rich endpoint is worth using. Everything else — ordinary prose, bold,
 * links, inline code, fenced code — renders fine as HTML and stays there.
 *
 * This is the auto-enable rule: rich is not a mode the caller turns on, it is
 * a capability the CONTENT asks for.
 */
export function needsRichRendering(text: string): boolean {
  if (!text) return false
  // Constructs INSIDE a fenced code block are literals the reader wants
  // verbatim — the HTML path already preserves them, so routing the whole
  // message through rich for a `| --- |` line inside ```…``` buys nothing.
  // fenceProtectedLines() is the same fence tracker hardenSoftBreaks uses,
  // so both agree on what counts as code. (Codex review finding.)
  const lines = text.split('\n')
  const inFence = fenceProtectedLines(lines)
  const prose = lines.filter((_, i) => !inFence[i]).join('\n')
  if (!prose) return false
  for (let i = 0; i < lines.length; i++) {
    if (!inFence[i] && TABLE_SEPARATOR_RE.test(lines[i]!)) return true
  }
  if (TASK_LIST_RE.test(prose)) return true
  if (DETAILS_LINE_RE.test(prose)) return true
  if (prose.includes(BLOCK_MATH)) return true
  return false
}

// `<details ...> … </details>`, non-greedy, across newlines.
const DETAILS_BLOCK_RE = /<details\b[^>]*>[\s\S]*?<\/details>/gi
// Math inside such a block: $$…$$, \[…\], \(…\), or a common LaTeX command.
const MATH_IN_DETAILS_RE =
  /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\\(?:sum|frac|alpha|beta|gamma|delta|theta|lambda|mu|pi|sigma|int|prod|sqrt|lim|infty|begin\{(?:equation|align|matrix|cases)\}))/i

/**
 * True when the body pairs a collapsible block with math — the shape that
 * crashes Telegram Desktop 6.9.1 during rich rendering. Skip rich, send HTML.
 */
export function hasDetailsMathCrashShape(text: string): boolean {
  if (!text) return false
  const blocks = text.match(DETAILS_BLOCK_RE)
  if (!blocks) return false
  return blocks.some(block => MATH_IN_DETAILS_RE.test(block))
}

// Hiragana/Katakana, CJK ext-A, CJK unified, Hangul syllables, CJK
// compatibility ideographs, and the astral CJK extensions. The astral range
// needs the `u` flag.
// NOTE — deliberate SUPERSET of the Hermes regex. The owner asked for a 1:1
// port; this is the ONE place I widened it, and only in the safe direction.
// Upstream matches precomposed Hangul syllables (AC00-D7AF) but not the
// DECOMPOSED form: «han» written as U+1112 U+1161 U+11AB is the same visible
// Korean text, garbles identically, yet slips past the upstream class.
// Adding the Jamo blocks can only route MORE text to the safe HTML path,
// never fewer — it cannot expose a client to the artifact. (Codex review.)
const CJK_RE =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\ud7b0-\ud7ff]|[\u{20000}-\u{323af}]/u

/**
 * True when the body contains CJK/Hangul text, which current Telegram
 * Mac/Desktop rich rendering garbles with overlapping glyph artifacts.
 * Skip rich, send HTML — which renders the same text cleanly.
 */
export function hasCjkGarbleShape(text: string): boolean {
  return Boolean(text) && CJK_RE.test(text)
}
