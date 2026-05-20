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

// Per-tag attribute allowlist. Source: Telegram's HTML style spec —
// https://core.telegram.org/bots/api#html-style. The bot API rejects
// any unknown attribute on a styled tag, so we mirror the contract.
//
//   - <a> takes `href` (required, must pass safe-protocol check)
//   - <code> tolerates `class="language-…"` (rendered inside <pre><code>);
//     Telegram silently ignores it, but accepts the message.
//   - every other styled tag takes NO attributes.
//
// Empty set means "no attributes allowed". The validator emits a
// downgrade with the disallowed attribute NAME (never the value) in
// the reason string so logs stay payload-free.
const TAG_ATTR_ALLOWLIST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['a', new Set(['href'])],
  ['code', new Set(['class'])],
  ['pre', new Set<string>()],
  ['tg-spoiler', new Set<string>()],
  ['blockquote', new Set<string>()],
  ['b', new Set<string>()],
  ['strong', new Set<string>()],
  ['i', new Set<string>()],
  ['em', new Set<string>()],
  ['u', new Set<string>()],
  ['ins', new Set<string>()],
  ['s', new Set<string>()],
  ['strike', new Set<string>()],
  ['del', new Set<string>()],
  ['br', new Set<string>()],
])

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

interface RawToken {
  /** Raw substring between `<` and `>` (exclusive). */
  inner: string
  /** Position of the opening `<` in the source. */
  start: number
  /** Position of the closing `>` in the source. */
  end: number
}

/**
 * Tokenize the input into `<...>` runs, correctly tracking quoted regions
 * inside attribute values. A naive `<([^>]*)>` regex would terminate the
 * tag at the first `>`, which is wrong if an attribute value contains a
 * literal `>` (e.g. `<a href="foo>bar">`). We walk the string with a tiny
 * state machine: outside a tag, look for `<`; inside a tag, advance one
 * char at a time, tracking single/double quote nesting; on an unquoted
 * `>` we close the tag.
 *
 * If the input contains an opening `<` without a matching unquoted `>`,
 * the tokenizer signals an unclosed tag by returning `null`. Callers
 * downgrade accordingly.
 */
function tokenize(input: string): RawToken[] | null {
  const out: RawToken[] = []
  let i = 0
  while (i < input.length) {
    const lt = input.indexOf('<', i)
    if (lt === -1) break
    // Walk through tag interior tracking quote state.
    let j = lt + 1
    let quote: '"' | "'" | null = null
    let closed = false
    while (j < input.length) {
      const ch = input[j]
      if (quote !== null) {
        if (ch === quote) quote = null
        j++
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        j++
        continue
      }
      if (ch === '>') {
        closed = true
        break
      }
      if (ch === '<') {
        // A nested `<` inside an open tag is invalid markup. Treat the
        // *previous* `<` as unclosed and let downgrade fire.
        return null
      }
      j++
    }
    if (!closed) return null
    out.push({ inner: input.slice(lt + 1, j), start: lt, end: j })
    i = j + 1
  }
  return out
}

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
 * Walk an attribute substring and yield each attribute NAME (lowercased).
 * Handles double-quoted, single-quoted, and unquoted values, as well as
 * bare-word attributes with no value. Returns null on an unterminated
 * quoted value — callers downgrade.
 *
 * We deliberately do NOT yield values: the caller checks names against
 * an allowlist and never logs values. The lone exception is the safe-
 * href check, which uses extractHref() with its own quoted-only parser.
 */
function extractAttrNames(attrsRaw: string): string[] | null {
  const names: string[] = []
  let i = 0
  const s = attrsRaw
  while (i < s.length) {
    // Skip whitespace.
    while (i < s.length && /\s/.test(s[i] ?? '')) i++
    if (i >= s.length) break
    // Read name.
    const nameStart = i
    while (i < s.length && /[A-Za-z0-9_-]/.test(s[i] ?? '')) i++
    if (i === nameStart) {
      // Stray non-identifier character — bail out as malformed.
      return null
    }
    const name = s.slice(nameStart, i).toLowerCase()
    names.push(name)
    // Skip whitespace before `=` or next attribute.
    while (i < s.length && /\s/.test(s[i] ?? '')) i++
    if (i < s.length && s[i] === '=') {
      i++
      while (i < s.length && /\s/.test(s[i] ?? '')) i++
      if (i >= s.length) return null
      const q = s[i]
      if (q === '"' || q === "'") {
        // Quoted value — find the matching quote.
        i++
        const valEnd = s.indexOf(q, i)
        if (valEnd === -1) return null
        i = valEnd + 1
      } else {
        // Unquoted value — read until whitespace.
        while (i < s.length && !/\s/.test(s[i] ?? '')) i++
      }
    }
  }
  return names
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

  // Tokenize first — the quote-aware walker reports an unclosed `<` by
  // returning null, which we treat as invalid markup. Stray `>` without
  // a preceding `<` is harmless from a parse-correctness POV (Telegram
  // treats it as literal text), so we no longer bail on a raw `>` count
  // mismatch.
  const tokens = tokenize(input)
  if (tokens === null) {
    return downgrade(input, 'unbalanced angle brackets')
  }

  // Walk tags with a stack to verify nesting and tag-name validity.
  const stack: string[] = []
  for (const tok of tokens) {
    const parsed = parseTag(tok.inner)
    if (parsed === null) {
      return downgrade(input, 'malformed tag')
    }
    if (!ALLOWED_TAGS.has(parsed.name)) {
      return downgrade(input, `unsupported tag: ${parsed.name}`)
    }
    // Per-tag attribute allowlist. Closing tags must have no attributes.
    const allowedAttrs = TAG_ATTR_ALLOWLIST.get(parsed.name) ?? new Set<string>()
    if (parsed.closing) {
      if (parsed.attrsRaw.length > 0) {
        return downgrade(input, `closing tag </${parsed.name}> has attributes`)
      }
    } else if (parsed.attrsRaw.length > 0) {
      const names = extractAttrNames(parsed.attrsRaw)
      if (names === null) {
        return downgrade(input, 'malformed tag')
      }
      for (const attr of names) {
        if (!allowedAttrs.has(attr)) {
          return downgrade(input, `disallowed attribute "${attr}" on <${parsed.name}>`)
        }
      }
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
        // Reason is payload-free — we never include the href value here.
        // See M4 commit for further reason-string cleanup across all paths.
        return downgrade(input, 'unsafe href protocol on <a>')
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
