// Unified secret redactor for all outbound text destined for Telegram, logs,
// or any other channel that might leak to operators.
//
// ORDER MATTERS. Patterns are applied in the sequence declared in the
// `RULES` array below. More specific shapes (Telegram bot tokens, provider
// API keys, IPs, Supabase hosts, Firebase JSON fields, secret paths) MUST
// run BEFORE the generic ≥24-char [A-Za-z0-9_-] long-token rule, otherwise
// the generic rule would chew through the head/tail of a token and produce
// a partially-masked-but-still-recognisable string that a careful eye can
// reverse. We pin order via a flat list rather than calling N replace()s in
// arbitrary order; if you add a new rule, slot it where its specificity
// belongs in the constant below.
//
// The redactor is IDEMPOTENT: `redactSecrets(redactSecrets(x))` equals
// `redactSecrets(x)` for every input. The `[REDACTED]` placeholder itself
// contains no characters matched by any pattern (no digits, no slashes,
// no ≥24-char run), so re-running cannot expand the mask. Tests pin this.

// Internal rule shape — kept unexported because no caller outside this
// module composes rules dynamically. If a future caller needs to inject
// a custom rule, expose this then.
interface RedactionRule {
  pattern: RegExp
  replacement: string | ((match: string, ...groups: string[]) => string)
}

// ─────────────────────────────────────────────────────────────────────
// Pattern definitions. Each entry is a single global regex + replacement.
// Order is load-bearing — see header comment.
// ─────────────────────────────────────────────────────────────────────

// Telegram bot token: `<8-12 digits>:<30+ urlsafe base64 chars>`.
// Port of TELEGRAM_TOKEN_RE in config.ts:134.
const TELEGRAM_TOKEN_RE = /\d{8,12}:[A-Za-z0-9_-]{30,}/g

// Provider API keys. Each shape is well-known and the prefix anchors the
// match so we don't collide with random base64 in URLs.
const GROQ_KEY_RE = /gsk_[A-Za-z0-9]{40,}/g
const OPENAI_PROJ_RE = /sk-proj-[A-Za-z0-9_-]{20,}/g
const OPENAI_RE = /sk-[A-Za-z0-9_-]{20,}/g
const GITHUB_PAT_RE = /ghp_[A-Za-z0-9]{30,}/g
const RESEND_RE = /re_[A-Za-z0-9_]{20,}/g
const SLACK_BOT_RE = /xoxb-[A-Za-z0-9-]+/g

// Firebase service-account JSON fields: keep the key visible, replace the
// value with `[REDACTED]`. Use a tight pattern that matches a JSON string
// value (`"…"`) only — we don't want to swallow trailing commas/braces.
// The (\\.|[^"\\])* body permits escaped quotes/newlines inside the value
// (Firebase keys have literal `\n` sequences in JSON).
const FIREBASE_FIELDS = ['private_key', 'private_key_id', 'client_email']
const FIREBASE_REs: RedactionRule[] = FIREBASE_FIELDS.map((field) => ({
  pattern: new RegExp(`("${field}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, 'g'),
  replacement: '$1"[REDACTED]"',
}))

// Authorization: Bearer <opaque> — preserve the "Bearer " prefix so the
// type of header remains obvious in logs (helps spot missing auth, etc.).
// Match the casing flexibly but not the "Bearer" word itself.
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._\-+/=]{8,}/gi

// Query-string / fragment tokens. Anchored by `[?&#]` and the param name
// so we don't match `&keyword=` etc. The name list deliberately covers
// signed-URL shapes (AWS/GCS/CloudFront) and OAuth params — with the URL
// exemption on the generic rule (below), these named params are the main
// line of defense for secrets riding in URLs. `#` anchor: OAuth implicit
// flow puts access_token in the FRAGMENT, which is easy to forget is
// sensitive (Codex review 2026-06-05).
const QUERY_TOKEN_RE =
  /([?&#](?:access_token|refresh_token|id_token|api_key|apikey|token|key|secret|auth|password|passwd|pwd|sig|signature|code|policy|key-pair-id|x-amz-signature|x-amz-credential|x-goog-signature)=)[^&#\s"']+/gi

// URL userinfo password: `https://user:secret@host/...`. Keep the user
// visible (debugging), mask the password. Without this the URL exemption
// would carry basic-auth credentials verbatim.
const URL_USERINFO_RE = /(https?:\/\/[^/\s:@]+:)[^@/\s]+(@)/gi

// JWT anywhere (path, query, fragment, prose): three dot-separated
// base64url segments, the first two starting with `eyJ` (= `{"`). The
// generic rule never caught these reliably (dots break the char class),
// and the URL exemption would otherwise let them ride inside URLs.
const JWT_RE =
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g

// Webhook URLs whose PATH SEGMENT is the secret — no prefix and no param
// name to anchor on, so the URL exemption would leak them verbatim.
const DISCORD_WEBHOOK_RE =
  /(discord(?:app)?\.com\/api\/webhooks\/\d+\/)[A-Za-z0-9_-]+/gi
const SLACK_WEBHOOK_RE = /(hooks\.slack\.com\/services\/)[A-Za-z0-9/]+/gi

// IPv4 — keep first and last octet (helps debugging) and mask the middle
// two. Loopback (127.*) and 0.* placeholders are pure debug noise; the
// callback returns the raw match unchanged for those so operators can read
// "127.0.0.1" verbatim. Port of activity-renderer.ts:62-73.
const IPV4_RE = /\b(\d{1,3})\.\d{1,3}\.\d{1,3}\.(\d{1,3})\b/g
function ipv4Replacer(full: string, first: string, last: string): string {
  if (first === '127' || first === '0') return full
  return `${first}.***.***.${last}`
}

// Secret paths.
//   1. `~/.foo/secrets/<file>` — legacy tilde-anchored form.
//   2. anchored `secrets/<file>` — catches collapsed summaries like
//      `secrets/openviking.key`. Must match at string start OR after a
//      whitespace/path separator so we don't mangle `my-secrets/x`.
const SECRET_PATH_TILDE_RE = /(~\/?\.\w+\/)secrets\/\S+/g
const SECRET_PATH_ANCHORED_RE = /(^|[\s/])secrets\/\S+/g

// Supabase project host: `<projectid>.supabase.co`. The callback masks the
// inner project-id segment while leaving `.supabase.co` intact so the
// provider remains identifiable in logs.
const SUPABASE_HOST_RE = /[a-z0-9]{10,}\.supabase\.co/g
function supabaseReplacer(host: string): string {
  const parts = host.split('.')
  if (parts.length === 0) return host
  const first = parts[0] ?? ''
  if (first.length > 8) {
    parts[0] = `${first.slice(0, 4)}*****${first.slice(-4)}`
  }
  if (parts.length > 1) {
    const idx = parts.length - 2
    const seg = parts[idx] ?? ''
    if (seg.length > 5) {
      parts[idx] = `${seg.slice(0, 4)}***`
    }
  }
  return parts.join('.')
}

// Telegram bot token (mid-shape variant from activity-renderer.ts): emits
// `NNN***:AA***` instead of `[REDACTED]` so the prefix shape stays visible.
// We keep this AFTER the canonical TELEGRAM_TOKEN_RE rule because the
// canonical rule replaces the whole token with `[REDACTED]` — once that
// fires, this regex no longer matches (no digits remain). Order ensures
// idempotency.
const TELEGRAM_TOKEN_PARTIAL_RE = /\b(\d{3})\d{7,}:(AA\w{2})\w+/g

// Generic long token rule (≥24 chars of [A-Za-z0-9_-]). LAST — keeps head
// and tail visible so a partial mask is still useful for debugging.
//
// URL exemption (2026-06-05): this rule does NOT fire inside http(s) URLs.
// Long hyphenated path segments are overwhelmingly public identifiers —
// repo slugs (`dashi-plugin-claude-code`), commit SHAs, PR paths — and
// masking them produced dead links the warchief could not open. Secrets
// embedded in URLs are still covered by every SPECIFIC rule above (bot
// tokens, ghp_/sk- prefixes, ?token= query params, Supabase hosts, IPs),
// all of which run regardless of URL context.
const GENERIC_LONG_TOKEN_RE = /\b([A-Za-z0-9_-]{4})[A-Za-z0-9_-]{16,}([A-Za-z0-9_-]{4})\b/g

// URL detector for the exemption above. Tighter than a linkifier needs to
// be — when in doubt the range SHRINKS, which merely re-enables generic
// masking for the tail (fail-closed). `,;` excluded entirely: rare in
// real links, but a comma can glue a secret onto a URL and smuggle it
// into the exempt range (Codex review 2026-06-05).
const URL_RE = /https?:\/\/[^\s<>"'),;\]]+/g

// Trailing prose punctuation that linkifiers drop but our char class
// admits — trimmed off the detected range so `…/pull/49.` doesn't extend
// the exemption past the real link.
const URL_TRAILING_PUNCT_RE = /[.:!?]+$/

// Replace GENERIC_LONG_TOKEN_RE matches everywhere EXCEPT inside http(s)
// URLs. Ranges are recomputed per call from the current text (earlier
// rules may have shifted offsets). Idempotent: skipped matches are left
// byte-identical, masked ones no longer match the pattern.
function maskLongTokensOutsideUrls(text: string): string {
  const urlRanges: Array<[number, number]> = []
  for (const m of text.matchAll(URL_RE)) {
    if (m.index !== undefined) {
      const trimmed = m[0].replace(URL_TRAILING_PUNCT_RE, '')
      urlRanges.push([m.index, m.index + trimmed.length])
    }
  }
  return text.replace(
    GENERIC_LONG_TOKEN_RE,
    (match: string, head: string, tail: string, offset: number) => {
      const inUrl = urlRanges.some(
        ([start, end]) => offset >= start && offset < end,
      )
      return inUrl ? match : `${head}***${tail}`
    },
  )
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

const RULES: ReadonlyArray<RedactionRule> = [
  // 1. Provider tokens with anchored prefixes — most specific first.
  { pattern: TELEGRAM_TOKEN_RE, replacement: '[REDACTED]' },
  { pattern: GROQ_KEY_RE, replacement: '[REDACTED]' },
  { pattern: OPENAI_PROJ_RE, replacement: '[REDACTED]' },
  { pattern: OPENAI_RE, replacement: '[REDACTED]' },
  { pattern: GITHUB_PAT_RE, replacement: '[REDACTED]' },
  { pattern: RESEND_RE, replacement: '[REDACTED]' },
  { pattern: SLACK_BOT_RE, replacement: '[REDACTED]' },
  // 2. Firebase JSON fields — value replaced, key preserved.
  ...FIREBASE_REs,
  // 3. Auth header + query/fragment params + URL-borne secrets. These
  //    MUST stay ahead of the generic rule's URL exemption: they are what
  //    keeps a secret from riding inside an exempt URL.
  { pattern: BEARER_RE, replacement: '$1[REDACTED]' },
  { pattern: QUERY_TOKEN_RE, replacement: '$1[REDACTED]' },
  { pattern: URL_USERINFO_RE, replacement: '$1[REDACTED]$2' },
  { pattern: JWT_RE, replacement: '[REDACTED]' },
  { pattern: DISCORD_WEBHOOK_RE, replacement: '$1[REDACTED]' },
  { pattern: SLACK_WEBHOOK_RE, replacement: '$1[REDACTED]' },
  // 4. IPv4 — middle-octet mask.
  { pattern: IPV4_RE, replacement: ipv4Replacer },
  // 5. Secret paths.
  { pattern: SECRET_PATH_TILDE_RE, replacement: '$1secrets/***' },
  { pattern: SECRET_PATH_ANCHORED_RE, replacement: '$1secrets/***' },
  // 6. Supabase host.
  { pattern: SUPABASE_HOST_RE, replacement: supabaseReplacer },
  // 7. Telegram partial-mask shape (renderer-style).
  { pattern: TELEGRAM_TOKEN_PARTIAL_RE, replacement: '$1***:$2***' },
  // 8. Generic long-token rule — LAST, applied via the URL-aware wrapper
  //    in redactSecrets() (NOT listed here; see maskLongTokensOutsideUrls).
]

/**
 * Apply every redaction rule to `text` in declaration order, then mask
 * caller-supplied exact-substring secrets (`extras`). Returns the redacted
 * string. Idempotent for any input.
 *
 * @param text  Arbitrary string. Treated as untrusted — may contain secrets.
 * @param extras Optional list of exact substrings to mask (e.g. webhook
 *               tokens that have no public pattern). Strings shorter than
 *               4 chars are ignored to avoid catastrophic false positives.
 */
export function redactSecrets(
  text: string,
  extras?: ReadonlyArray<string>,
): string {
  let out = text
  // Extras BEFORE patterns: caller-supplied exact substrings (e.g. webhook
  // tokens with no public shape) get masked first so the downstream generic
  // long-token rule doesn't partially eat them and leave a recoverable
  // prefix/suffix. Short (<4 chars) entries are ignored as catastrophic-
  // false-positive guards.
  if (extras && extras.length > 0) {
    for (const secret of extras) {
      if (!secret || secret.length < 4) continue
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      out = out.replace(new RegExp(escaped, 'g'), '[REDACTED]')
    }
  }
  for (const rule of RULES) {
    // String replacement: replace() accepts string OR callback. We narrow
    // explicitly so TS picks the right overload.
    if (typeof rule.replacement === 'string') {
      out = out.replace(rule.pattern, rule.replacement)
    } else {
      // Cast to satisfy String.prototype.replace's variadic callback shape.
      // The replacer is typed (match, ...groups) which matches replace()'s
      // contract for capturing groups.
      out = out.replace(rule.pattern, rule.replacement as (sub: string, ...args: unknown[]) => string)
    }
  }
  // Generic long-token rule runs LAST and outside RULES: it needs the
  // final post-specific-rules text to compute URL ranges (offsets shift
  // as earlier rules rewrite the string).
  out = maskLongTokensOutsideUrls(out)
  return out
}
