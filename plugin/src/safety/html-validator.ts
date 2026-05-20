// Pre-send Telegram HTML validator.
//
// Telegram's `parse_mode=HTML` accepts a fixed allowlist of tags. Anything
// outside that set produces a 400 Bad Request and drops the message. Rather
// than discover this at runtime, we pre-validate every outgoing HTML body.
// If the body is invalid, we DOWNGRADE: strip all tags, escape the body
// with the canonical `escapeHtml`, return a plain-text reply that ships
// without parse_mode. Better a missing <b> than a missing answer.
//
// This module is deliberately conservative — the cost of a false downgrade
// (plain text instead of bold) is far less than the cost of dropping a
// reply because Telegram rejected a stray `<div>`.
//
// NEVER throws. Pathological inputs (`<<<>>>`, unterminated `<a href="…`)
// always return a `ValidatedHtml`. Empty input is valid.

import { escapeHtml } from '../format/html.js'

// ─────────────────────────────────────────────────────────────────────
// Allowlist. Source of truth: https://core.telegram.org/bots/api#html-style.
// We include the historical aliases (strong=b, em=i, ins=u, strike=s,
// del=s) that Telegram still accepts. `br` is a void element — both
// `<br>` and `<br/>` shapes are allowed.
// ─────────────────────────────────────────────────────────────────────

const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'a',
  'code',
  'pre',
  'blockquote',
  'tg-spoiler',
  'br',
])

// Void elements never have a closing tag. Currently only `br` in the
// Telegram allowlist; declared separately so future additions stay tidy.
const VOID_TAGS: ReadonlySet<string> = new Set(['br'])

// `<a>` accepts a small set of URL schemes. Anything else (javascript:,
// data:, vbscript:, file:, etc.) is unsafe — even if Telegram clients
// happen to render it, we refuse and downgrade.
const SAFE_HREF_RE = /^(https?:|tg:|mailto:)/i

export interface ValidatedHtml {
  html: string
  downgraded: boolean
  reason?: string
}

// ─────────────────────────────────────────────────────────────────────
// Tokenizer. We walk the input once with a regex that finds `<...>` runs;
// the body between tokens is ignored (we trust the agent not to embed
// raw `<` inside text and rely on escapeHtml at construction time). If
// the markup is invalid we don't need to know exactly where — only that
// a downgrade is required.
// ─────────────────────────────────────────────────────────────────────

interface ParsedTag {
  /** Lowercased tag name, e.g. "a", "br". */
  name: string
  /** True for `</foo>`. */
  closing: boolean
  /** True for `<foo/>` (self-closing). */
  selfClosing: boolean
  /** Raw attribute substring (between name and closing `>`), trimmed. */
  attrsRaw: string
}

const TAG_RE = /<([^>]*)>/g

function parseTag(inner: string): ParsedTag | null {
  // `inner` is the substring between `<` and `>`. Whitespace and bogus
  // shapes are normalized; anything we can't classify returns null and
  // forces a downgrade.
  const trimmed = inner.trim()
  if (trimmed.length === 0) return null

  const closing = trimmed.startsWith('/')
  // Strip leading `/` for the closing-tag case.
  const head = closing ? trimmed.slice(1).trim() : trimmed

  // Detect self-closing: trailing `/`, e.g. `br/` or `br /`. Closing tags
  // can't be self-closing.
  let selfClosing = false
  let body = head
  if (!closing && body.endsWith('/')) {
    selfClosing = true
    body = body.slice(0, -1).trim()
  }

  // First whitespace splits name from attributes. Name must match the
  // simple identifier shape — letters, digits, hyphen (for `tg-spoiler`).
  const wsIdx = body.search(/\s/)
  const name = (wsIdx === -1 ? body : body.slice(0, wsIdx)).toLowerCase()
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return null

  const attrsRaw = wsIdx === -1 ? '' : body.slice(wsIdx + 1).trim()
  return { name, closing, selfClosing, attrsRaw }
}

/**
 * Extract the `href` attribute value from a tag's attribute substring.
 * Returns null if the attribute is absent or malformed (unterminated
 * quotes, etc.). Only double-quoted and single-quoted values are
 * accepted — bare unquoted hrefs would let an attacker break out of
 * the attribute with `>`.
 */
function extractHref(attrsRaw: string): string | null {
  const m = attrsRaw.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)')/i)
  if (!m) return null
  return m[2] ?? m[3] ?? null
}

function downgrade(input: string, reason: string): ValidatedHtml {
  // Escape the ORIGINAL input wholesale rather than stripping tags first.
  // Rationale:
  //   1. The user/agent intent is preserved — the receiver sees the literal
  //      `<script>alert(1)</script>` text and can spot the mis-attempted
  //      formatting instead of getting a silently-edited body.
  //   2. Escape-only is a single, predictable transform: every `<`, `>`,
  //      `&`, `"` becomes its entity form. No tag-stripping edge cases
  //      (nested tags, malformed brackets) can leak through.
  //   3. For unsafe-href downgrade specifically, the link text and href
  //      both land as escaped text — operator sees the suspicious URL
  //      rather than losing all context.
  // The downgrade is meant to ship plain text via Telegram WITHOUT
  // parse_mode, so escaping ensures no entity is re-interpreted later.
  return {
    html: escapeHtml(input),
    downgraded: true,
    reason,
  }
}

export function validateTelegramHtml(input: string): ValidatedHtml {
  // Empty input is trivially valid.
  if (input.length === 0) {
    return { html: input, downgraded: false }
  }

  // Stray `<` or `>` with no closing bracket → invalid markup. A lone `<`
  // without a matching `>` confuses Telegram's parser. We detect by
  // looking for any `<` that isn't followed eventually by `>`.
  // Easier: tokenize via TAG_RE, then verify the unmatched-bracket
  // count by counting `<` and `>` raw occurrences.
  const ltCount = (input.match(/</g) ?? []).length
  const gtCount = (input.match(/>/g) ?? []).length
  if (ltCount !== gtCount) {
    return downgrade(input, 'unbalanced angle brackets')
  }

  // Walk tags with a stack to verify nesting and tag-name validity.
  const stack: string[] = []
  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(input)) !== null) {
    const inner = m[1] ?? ''
    const parsed = parseTag(inner)
    if (parsed === null) {
      return downgrade(input, 'malformed tag')
    }
    if (!ALLOWED_TAGS.has(parsed.name)) {
      return downgrade(input, `unsupported tag: ${parsed.name}`)
    }
    // Void tag rules: br must NOT have a closing form.
    if (VOID_TAGS.has(parsed.name)) {
      if (parsed.closing) {
        return downgrade(input, `void tag has closing form: ${parsed.name}`)
      }
      // self-closing or bare both fine; no stack work.
      continue
    }
    if (parsed.closing) {
      const top = stack.pop()
      if (top !== parsed.name) {
        return downgrade(input, `mismatched closing tag: </${parsed.name}>`)
      }
      continue
    }
    // Opening tag. `<a>` requires a safe href.
    if (parsed.name === 'a') {
      const href = extractHref(parsed.attrsRaw)
      if (href === null) {
        return downgrade(input, '<a> missing href')
      }
      if (!SAFE_HREF_RE.test(href)) {
        return downgrade(input, `<a> unsafe href: ${href.slice(0, 32)}`)
      }
    }
    if (parsed.selfClosing) {
      // Self-closing form is uncommon for Telegram tags but harmless when
      // the tag is otherwise valid. Don't push to stack.
      continue
    }
    stack.push(parsed.name)
  }

  if (stack.length > 0) {
    return downgrade(input, `unclosed tag: <${stack[stack.length - 1]}>`)
  }

  return { html: input, downgraded: false }
}
