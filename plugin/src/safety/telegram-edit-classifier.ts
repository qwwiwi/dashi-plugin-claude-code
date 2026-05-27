// Telegram edit/send error classifier — shared between StatusManager and
// TmuxMirror so both surfaces react to permanent failures identically.
//
// Pre-fix, both modules logged any non-"message is not modified" failure at
// `warn` and kept retrying on the next timer tick. For PERMANENT failures
// (message deleted by user, bot kicked from chat, parse_mode error in the
// rendered HTML) this turned into an edit storm until TTL — wasted Telegram
// quota, log noise, and zero recovery.
//
// We classify into five buckets:
//   • benign         — Telegram says "message is not modified". No-op,
//                      keep lastText cache consistent.
//   • message_gone   — The target message no longer exists. Drop the
//                      messageId; caller may recreate ONCE.
//   • forbidden      — 401 / 403. Bot lost access to the chat. Caller
//                      should disable the surface for this chat — no
//                      further edits, sends, or pulses will succeed.
//   • parse          — 400 with "can't parse entities" / "can't find end
//                      of the entity tag". The rendered payload has a
//                      broken HTML/Markdown structure. Caller should
//                      downgrade (strip parse_mode, retry once).
//   • flood          — 429. Includes `parameters.retry_after` (seconds)
//                      when Telegram provided it. The rate-limit wrapper
//                      already retries 429 transparently, so this branch
//                      only fires when retries are exhausted — treat as
//                      transient: drop the edit, next tick gets a fresh
//                      attempt.
//   • transient      — Network glitches, 5xx, or anything else not
//                      classified above. Caller logs and retries on the
//                      next tick.
//
// Telegram's wire shape on grammY errors:
//   GrammyError { error_code: 400, description: "Bad Request: ..." }
// safe-telegram-api re-throws these unchanged. We accept either the
// strongly-typed GrammyError instance OR a plain object that quacks like
// one — keeps the classifier reusable in tests that fabricate errors
// without pulling in grammY.

export type EditErrorClass =
  | { kind: 'benign' }
  | { kind: 'message_gone'; description: string }
  | { kind: 'forbidden'; code: 401 | 403; description: string }
  | { kind: 'parse'; description: string }
  | { kind: 'flood'; retryAfterSec: number | undefined; description: string }
  | { kind: 'transient'; description: string }

interface MaybeGrammyError {
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
  message?: string
}

function asGrammy(err: unknown): MaybeGrammyError {
  if (err === null || typeof err !== 'object') return {}
  return err as MaybeGrammyError
}

// Loose substring match — Telegram's exact wording varies between API
// versions and between Bot API / TDLib responses. The set of phrases
// below is the union of what we've actually seen on production traffic
// (see DECISIONS log entry 2026-05-27).
function descContains(desc: string, needles: ReadonlyArray<string>): boolean {
  const lc = desc.toLowerCase()
  for (const n of needles) {
    if (lc.includes(n)) return true
  }
  return false
}

const MESSAGE_GONE_PHRASES: ReadonlyArray<string> = [
  'message to edit not found',
  'message not found',
  'message_id_invalid',
  // Telegram returns this when a message is too old (>48h) OR was sent
  // by another bot / user. From the caller's POV it's equally permanent:
  // we can never edit this message_id again.
  "message can't be edited",
  'message can not be edited',
  'message to delete not found',
]

const PARSE_PHRASES: ReadonlyArray<string> = [
  "can't parse entities",
  'can not parse entities',
  "can't find end of the entity",
  'unsupported start tag',
  'unmatched end tag',
]

/**
 * Classify a Telegram error from an edit / send / delete call. The
 * caller uses the returned `kind` to decide whether to:
 *   • benign       — sync lastText cache, no-op
 *   • message_gone — drop the messageId, optionally recreate ONCE
 *   • forbidden    — disable the surface, no more I/O for this chat
 *   • parse        — downgrade parse_mode + retry once
 *   • flood        — log + drop, next tick retries
 *   • transient    — log + drop, next tick retries
 *
 * The classifier is total — every error maps to one of the kinds above.
 * Unknown shapes fall through to `transient` so a buggy classifier never
 * silently disables a working chat.
 */
export function classifyEditError(err: unknown): EditErrorClass {
  // The "message is not modified" path is the only string-based check
  // that runs before looking at error_code — grammY sometimes wraps
  // this case as a plain Error from the HTTP layer rather than as a
  // GrammyError with error_code populated.
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (/message is not modified/i.test(msg)) {
    return { kind: 'benign' }
  }

  const g = asGrammy(err)
  const code = typeof g.error_code === 'number' ? g.error_code : undefined
  const desc = (g.description ?? g.message ?? msg).trim()

  if (code === 401 || code === 403) {
    return { kind: 'forbidden', code, description: desc }
  }

  if (code === 429) {
    const raw = g.parameters?.retry_after
    const retryAfterSec =
      typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined
    return { kind: 'flood', retryAfterSec, description: desc }
  }

  // 400 / 404 with a "message gone" phrase → permanent.
  if ((code === 400 || code === 404) && descContains(desc, MESSAGE_GONE_PHRASES)) {
    return { kind: 'message_gone', description: desc }
  }

  // 400 with a parse-entity phrase → caller should downgrade parse_mode.
  if (code === 400 && descContains(desc, PARSE_PHRASES)) {
    return { kind: 'parse', description: desc }
  }

  // Anything else (network, 5xx, unknown 4xx) → transient. Caller drops
  // this attempt; next timer tick (interval / TTL) retries.
  return { kind: 'transient', description: desc }
}
