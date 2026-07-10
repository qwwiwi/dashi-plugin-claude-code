// AskUserQuestion Telegram UX (PRX-1 TASK-2, 2026-05-27).
//
// Renders one question at a time as a Telegram message + inline keyboard,
// dispatches `ask:*` callback_query payloads, and feeds the warchief's
// answers back into the AskUserQuestion relay (TASK-1).
//
// Scope:
//   * Pure UI/dispatch — relay state machine (TASK-1) owns lifecycle.
//   * Talks ONLY through the safe-wrapped TelegramApi (redact + HTML
//     validate). Never reach into grammy directly.
//   * Auth check on every callback: ctx.from.id MUST be in
//     resolveAskUserQuestionAllowedUserIds(config). Otherwise reply
//     «Не авторизован» and log audit event `request_unauthorized`.
//
// Callback payload taxonomy (per Codex plan, fits in Telegram's 64-byte
// callback_data budget):
//
//   ask:choose:<reqId>:<qIdx>:<optIdx>   single-select pick
//   ask:toggle:<reqId>:<qIdx>:<optIdx>   multiSelect toggle
//   ask:done:<reqId>:<qIdx>              multiSelect commit
//   ask:other:<reqId>:<qIdx>             open «Other» text-entry prompt
//
// Worst-case length: `ask:toggle:abcde:99:99` = 22 bytes. The qIdx /
// optIdx caps mean we MUST refuse to render keyboards with > 99 options
// per question — `MAX_KEYBOARD_OPTIONS = 99` is the hard ceiling.
// Same applies to question count: `MAX_QUESTIONS_PER_REQUEST = 99`.
//
// «Other» text-entry flow (FIX-T1 F4, PRX-1 Phase 5, 2026-05-27):
//   1. Warchief taps «Другое» → we send «Введи ответ текстом» with
//      `force_reply: true, selective: true` (Telegram clients auto-quote
//      the prompt for the warchief). The returned message_id is stored
//      in `awaitingOtherFor[chatId] = {requestId, questionIndex,
//      promptMessageId, expiresAt}`.
//   2. tryHandleOtherText consumes the next text ONLY when its
//      `reply_to_message_id` matches `promptMessageId`. Without this
//      gate ANY text typed in the chat would be eaten — a `yes <id>`
//      permission reply, a normal channel message, even a stray emoji —
//      blocking the warchief's intent and silently consuming sensitive
//      input into the Other slot. Texts without the matching reply_to
//      fall through to the normal handlers (permission, OOB, channel
//      forward).
//   3. The pending map is pruned on every read and bounded by TTL so a
//      forgotten tap doesn't leak state.

import type { Logger } from '../log.js'
import type { AppConfig } from '../config.js'
import { resolveAskUserQuestionAllowedUserIds } from '../config.js'
import type {
  AskAnswerOutcome,
  AskSettleEvent,
  AskUserQuestionRelay,
  PendingAskRequest,
} from '../channel/ask-user-question.js'
import type { InlineKeyboardLike, TelegramApi } from '../channel/tools.js'
import { escapeHtml } from '../format/html.js'
import { classifyEditError } from '../safety/telegram-edit-classifier.js'
import { addQuestion, computeScopeDigest, updateAutonomyState, type AutonomyPaths } from '../autonomy/store.js'
import {
  grantLease,
  isAffirmativeLabel,
  looksLikeLeaseMarker,
  parseLeaseMarker,
  stripLeaseMarkerForDisplay,
  type ParsedLeaseMarker,
} from '../autonomy/grant.js'
import {
  deleteLeaseIntent,
  loadLeaseIntent,
  saveLeaseIntent,
  type PersistedLeaseIntent,
} from '../autonomy/ask-intents.js'

// ─────────────────────────────────────────────────────────────────────
// Autonomy M2 — lease-card helpers (fix-loop #1, CRITICAL).
//
// The GRANT INTENT of a card is derived by ONE function from the question's
// immutable text + multiSelect flag, and the rendered card must ALWAYS show
// the intent built from the PARSED fields — never from agent free text. A
// question whose intent cannot be parsed/validated (malformed marker, bad
// ttl, over-long scope, multiSelect card) is a NORMAL question: nothing is
// stripped (the owner sees the raw marker — honest), no mandate block is
// rendered, and a tap grants NOTHING. «rendered ≠ granted» can never happen:
// both the renderers and the tap handler consume the same intent.
// ─────────────────────────────────────────────────────────────────────

/** Parse the grant intent of a question at CARD CREATION — the ONE place a
 *  marker parse is allowed to feed a grant, and only en route to the durable
 *  persist (fix-loop-2 #1). multiSelect cards are NEVER grant-capable
 *  (fail-closed — an accumulating toggle is not an explicit affirmative tap). */
export function leaseIntentForQuestion(
  questionText: string,
  multiSelect: boolean | undefined,
): ParsedLeaseMarker | null {
  if (multiSelect === true) return null
  return parseLeaseMarker(questionText)
}

// The subset of the persisted intent the renderers consume. Structural — a
// PersistedLeaseIntent is assignable. The renderers take this as INPUT and
// never parse question text themselves (fix-loop-2 #1: render and grant read
// the same durable record).
export interface LeaseIntentView {
  scope: string
  ttlHours: number
  supersede: boolean
  displayText: string
}

// The mandate block appended to an OPEN grant-capable card. Built ONLY from
// the persisted intent fields; scope is escaped. The «Тап "Да"» line names
// the exact action.
function renderMandateBlockOpen(intent: LeaseIntentView): string {
  const sup = intent.supersede ? '; заменит действующий мандат' : ''
  return (
    `\n\n⚡ Мандат автономии: «${escapeHtml(intent.scope)}» — ttl ${intent.ttlHours}ч${sup}`
    + '\n<i>Тап «Да» выдаст этот мандат.</i>'
  )
}

// The mandate line on a CLOSED card (no tap hint — the card is settled, but
// the owner must still see exactly what scope the card was about).
function renderMandateLineClosed(intent: LeaseIntentView): string {
  const sup = intent.supersede ? '; заменит действующий мандат' : ''
  return `\n⚡ Мандат автономии: «${escapeHtml(intent.scope)}» — ttl ${intent.ttlHours}ч${sup}`
}

// Honesty note on a card whose text LOOKS like a lease marker but which is
// not grant-capable (invalid marker, registry unavailable, persist failure) —
// fix-loop-2 #5. The raw marker stays visible; this line removes any illusion
// that a tap would grant.
const INVALID_MARKER_NOTE = '\n\n<i>Маркер мандата некорректен — тап мандат НЕ выдаст.</i>'
// Closed-card line for a card that WAS grant-capable but whose persisted
// intent is gone (restart before the durable record, file loss) — fix-loop-2
// #1: the grant is refused and the owner is told, never a silent divergence.
const INTENT_LOST_LINE = '\n⚠️ Мандат НЕ выдан: intent утерян (рестарт).'

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

// Hard caps tied to the 64-byte callback_data budget. With the longest
// payload pattern `ask:toggle:<5>:<2>:<2>` we have 22 bytes — well under
// 64 — but we still cap the renderable counts so an oversized incoming
// request degrades gracefully (truncated to N options + an «overflow»
// note) rather than producing payloads we cannot parse back.
export const MAX_KEYBOARD_OPTIONS = 99
export const MAX_QUESTIONS_PER_REQUEST = 99

// Telegram button text cap is ~30 chars in practice (4 lines of compact
// display on mobile clients). Beyond that the label truncates ugly.
const MAX_BUTTON_LABEL = 30

// Telegram inline-button text limit is 64 bytes per Bot API docs; we cap
// well under to keep room for the checkbox prefix («[x] » = 4 bytes).
const MULTISELECT_PREFIX_CHECKED = '[x] '
const MULTISELECT_PREFIX_UNCHECKED = '[ ] '

// Soft cap for the rendered message body. Telegram itself caps at 4096
// but our chunker (format/chunk.ts) targets 4000 — staying under that
// avoids any need to split a question card across two messages, which
// would break the «one keyboard per question» invariant.
export const MAX_BODY_CHARS = 3800

// FIX-T2 F2 — per-field raw caps applied BEFORE HTML rendering. The
// pre-fix path sliced the rendered HTML at MAX_BODY_CHARS, which could
// cut inside `<pre>`, `<b>`, or a `&lt;` entity and produce Telegram
// parse errors. Capping the raw fields up-front + piecewise assembly
// guarantees we only ever slice between completed tag pairs.
const MAX_HEADER_CHARS = 80
const MAX_QUESTION_CHARS = 1000
const MAX_OPTION_DESCRIPTION_CHARS = 500
// Marker appended when the assembled body would overflow MAX_BODY_CHARS.
// Self-contained HTML — no open tags, never sliced.
const OVERFLOW_MARKER = '\n<i>… (обрезано)</i>'

// ── Card-close copy (2026-07-02, warchief UX feedback) ────────────────
// When a question is answered / times out we STRIP the keyboard and edit
// the message so it no longer looks tappable, keeping the question text
// for context and appending a one-line outcome. Tone matches the
// permission relay's «✅ Allowed / ❌ Denied» verdict-edit convention.

// Raw cap for the chosen-answer echo. «Другое» free-text can be long —
// truncate so the closed card stays compact.
const MAX_ANSWER_CHARS = 100
// Outcome line shown once the warchief has answered a question.
function formatChosenLine(rawAnswer: string): string {
  return `✅ Ответ: <b>${escapeHtml(clipRaw(rawAnswer, MAX_ANSWER_CHARS))}</b>`
}
// Outcome line shown when the request times out (or is externally expired)
// with the card still open. Static, HTML-safe literal.
const TIMEOUT_OUTCOME_LINE = '⏰ Время истекло — спрошу заново'
// One-shot completion message sent after the LAST question is answered.
const COMPLETION_TEXT = 'Ответы принял, продолжаю ✅'

/**
 * Render a CLOSED question card: header + original question text + a single
 * outcome line, no keyboard. Used both when a question is answered (outcome
 * = the chosen answer) and on timeout (outcome = the «время истекло» note).
 * `outcomeLineHtml` is trusted HTML — callers build it via `formatChosenLine`
 * (escapes user content) or a static safe literal. Header + question are
 * escaped here. Exported for tests.
 *
 * Autonomy M2 (fix-loop #1): a grant-capable card keeps its mandate line on
 * the CLOSED body too — the owner must be able to see exactly what scope the
 * card carried after it settles. `opts.multiSelect` gates grant-capability
 * (a multiSelect card never is); a non-grant-capable card renders the RAW
 * question text, marker included.
 */
export function renderClosedQuestionBody(
  questionRaw: string,
  currentIndex: number,
  totalQuestions: number,
  outcomeLineHtml: string,
  opts: { leaseIntent?: LeaseIntentView; intentLost?: boolean } = {},
): string {
  const header = clipRaw(`Вопрос ${currentIndex + 1}/${totalQuestions}`, MAX_HEADER_CHARS)
  const headerHtml = `<b>${escapeHtml(header)}</b>`
  // fix-loop-2 #1: the mandate line comes ONLY from the caller-provided
  // persisted intent — this function never parses question text.
  const intent = opts.leaseIntent
  const mandateLine = intent
    ? renderMandateLineClosed(intent)
    : opts.intentLost === true
      ? INTENT_LOST_LINE
      : ''
  const display = intent ? intent.displayText : questionRaw
  // Shared body budget (fix-loop-2 #2): the mandate line + outcome are
  // reserved UP-FRONT and never truncated; the question text shrinks to fit.
  // Escape expansion (& → &amp; etc.) can blow a raw cap past the budget, so
  // the raw cap halves until the ESCAPED text fits — never slicing escaped
  // HTML. Reserved parts are bounded (scope ≤400cp → ≤2.4k escaped; outcome
  // answer ≤100cp raw), so the fixed section always leaves question headroom.
  const fixedLen = headerHtml.length + 1 + mandateLine.length + 2 + outcomeLineHtml.length
  let rawCap = MAX_QUESTION_CHARS
  let questionHtml = escapeHtml(clipRaw(display, rawCap))
  while (fixedLen + questionHtml.length > MAX_BODY_CHARS && rawCap > 8) {
    rawCap = Math.floor(rawCap / 2)
    questionHtml = escapeHtml(clipRaw(display, rawCap))
  }
  return `${headerHtml}\n${questionHtml}${mandateLine}\n\n${outcomeLineHtml}`
}

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

export interface AskUserQuestionUiDeps {
  config: AppConfig
  log: Logger
  telegramApi: TelegramApi
  relay: AskUserQuestionRelay
  /** Override clock for tests. */
  now?: () => number
  // Autonomy M2: state root for the durable lease/question registry. When set,
  // an affirmative tap on a `[LEASE: …]` card mints a lease, and a timed-out
  // question is auto-registered as an open question. Optional so pre-M2 wiring
  // (and tests that don't exercise autonomy) still construct the UI. Every
  // registry access is fail-open — a store error NEVER breaks the ask flow.
  autonomyPaths?: AutonomyPaths
}

export interface AskUserQuestionUi {
  /**
   * Render the current question of the request to the chat stored on
   * the pending record. Called by TASK-3 after a fresh request is
   * submitted, and recursively by `handleAskCallback` after a `choose`
   * / `done` advances the relay to the next question.
   *
   * No-op when:
   *   * the request is no longer pending (resolved/timed out), or
   *   * the pending record has no chatId (defensive — relay would have
   *     returned pass_through on submit).
   */
  startQuestion(requestId: string): Promise<void>

  /**
   * Dispatch one `callback_query:data` event whose `data` starts with
   * `ask:`. Caller (server.ts callback_query handler) is responsible
   * for forwarding non-`ask:` payloads to the permission relay.
   *
   * Always answers the callback (Telegram spinner) even on errors so
   * the warchief's UI doesn't appear stuck.
   */
  handleAskCallback(ctx: AskCallbackContext): Promise<void>

  /**
   * Consume an inbound text message as the answer to a pending
   * «Other» prompt. Returns true if the text was consumed (caller
   * MUST NOT continue with the normal channel-forward flow), false
   * otherwise.
   *
   * FIX-T1 F4 (PRX-1 Phase 5): `replyToMessageId` MUST equal the stored
   * `promptMessageId` for consumption. When absent or mismatched the
   * caller is told to fall through so a parallel `yes <id>` or normal
   * channel message is not silently swallowed.
   */
  tryHandleOtherText(input: {
    chatId: string
    fromUserId: number
    text: string
    replyToMessageId?: number
  }): Promise<boolean>

  /**
   * React to a terminal settle the UI did NOT drive itself — chiefly the
   * relay's internal timeout, where no callback path runs to close the open
   * keyboard. Wired to the relay's `onSettle` in server.ts. Best-effort:
   * closes the currently-open question card (strips keyboard, appends the
   * timeout note) and never throws. A no-op for `answered` (the driven
   * callback path already closed the card + sent the completion message).
   */
  handleSettle(event: AskSettleEvent): Promise<void>

  /** Test/inspection — pending «Other» prompts. */
  awaitingOtherCount(): number
}

/**
 * Subset of grammy's callback_query Context the handler reads. Kept
 * structural so tests can stub without pulling grammy.
 */
export interface AskCallbackContext {
  callbackQuery: { data?: string }
  from: { id: number }
  /** ID of the chat the keyboard message lives in (matches `from.id`
   *  for DM callbacks, group/channel id for group keyboards). */
  chatId: string
  /**
   * Phase 5 FIX-T3 F4 (2026-05-27): message_id of the Telegram message
   * the inline keyboard belongs to (`ctx.callback_query.message.message_id`).
   * Used to reject stale callbacks that target a keyboard older than the
   * relay's currently-anchored message (e.g. a re-render advanced the
   * anchor and Telegram replayed an old tap from the cleared message).
   * Optional — clients that can't supply it skip the message-id check
   * but still benefit from the questionIndex + chatId guards below.
   */
  callbackMessageId?: number | undefined
  answerCallbackQuery(arg?: { text?: string }): Promise<void>
}

// ─────────────────────────────────────────────────────────────────────
// Module-level helpers — pure, exported for tests
// ─────────────────────────────────────────────────────────────────────

export type AskCallbackPayload =
  | { kind: 'choose'; requestId: string; questionIndex: number; optionIndex: number }
  | { kind: 'toggle'; requestId: string; questionIndex: number; optionIndex: number }
  | { kind: 'done'; requestId: string; questionIndex: number }
  | { kind: 'other'; requestId: string; questionIndex: number }

const REQ_ID_RE = /^[a-km-z]{5}$/
// Numeric segments are bounded by MAX_KEYBOARD_OPTIONS/MAX_QUESTIONS_PER_REQUEST
// (max 2 digits). Allow 1-2 digits, no leading zeros (so we cannot mint
// duplicates from `01` vs `1`).
const INDEX_RE = /^(?:0|[1-9][0-9]?)$/

/** Parse one `ask:*` callback payload. Returns null on any malformed
 *  shape — caller silently acks the spinner without touching relay state. */
export function parseAskCallback(data: string): AskCallbackPayload | null {
  if (!data.startsWith('ask:')) return null
  const parts = data.split(':')
  // ['ask', '<kind>', '<reqId>', '<qIdx>', '<optIdx>?']
  if (parts.length < 4 || parts.length > 5) return null
  const kind = parts[1]
  const requestId = parts[2] ?? ''
  const qIdxStr = parts[3] ?? ''
  if (!REQ_ID_RE.test(requestId)) return null
  if (!INDEX_RE.test(qIdxStr)) return null
  const questionIndex = Number.parseInt(qIdxStr, 10)
  if (questionIndex > MAX_QUESTIONS_PER_REQUEST) return null

  if (kind === 'choose' || kind === 'toggle') {
    if (parts.length !== 5) return null
    const optIdxStr = parts[4] ?? ''
    if (!INDEX_RE.test(optIdxStr)) return null
    const optionIndex = Number.parseInt(optIdxStr, 10)
    if (optionIndex > MAX_KEYBOARD_OPTIONS) return null
    return { kind, requestId, questionIndex, optionIndex }
  }
  if (kind === 'done' || kind === 'other') {
    if (parts.length !== 4) return null
    return { kind, requestId, questionIndex }
  }
  return null
}

/** Truncate a button label to the safe display width. Ellipsis with a
 *  Unicode horizontal ellipsis to keep byte cost low (3 bytes). */
function truncateLabel(label: string, max: number = MAX_BUTTON_LABEL): string {
  if (label.length <= max) return label
  return label.slice(0, Math.max(1, max - 1)) + '…'
}

/** Cap a raw (un-escaped) field to N chars. The cap is applied to the
 *  raw user-supplied text BEFORE escaping; this guarantees we never slice
 *  a multi-byte `&lt;` entity or a `<pre>`/`<b>` tag in half. Appends a
 *  Unicode ellipsis (3 bytes, render-safe) when truncated. */
function clipRaw(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, Math.max(1, max - 1)) + '…'
}

/**
 * Render the message body for one question. Pure — returns the HTML
 * string ready for sendMessage(parse_mode: HTML). Exported for tests.
 *
 * FIX-T2 F2 — tag-safe rendering. The pre-fix implementation rendered
 * the full body to a single string and then sliced it at MAX_BODY_CHARS,
 * which could cut inside `<pre>`, `<b>`, or an HTML entity like `&lt;`
 * and crash Telegram's parser. The new strategy:
 *
 *   1. Cap each RAW (un-escaped) field up-front: header, question,
 *      option labels, option descriptions, option previews.
 *   2. Assemble the body piecewise, tracking the running length. If the
 *      next piece would push us past MAX_BODY_CHARS, stop and append
 *      a self-contained `<i>… (обрезано)</i>` marker — never slice
 *      inside an open tag or entity.
 *
 * Slicing inside `escapeHtml`'s output (e.g. partial `&amp;`) is now
 * structurally impossible: every field is escaped AFTER its raw cap, and
 * the only place we still slice strings (`clipRaw`) operates on raw
 * un-escaped text. Telegram receives well-formed HTML in all cases.
 */
export function renderQuestionBody(
  pending: Readonly<PendingAskRequest>,
  maxPreviewChars: number,
  renderOpts?: { leaseIntent?: LeaseIntentView },
): string {
  const q = pending.questions[pending.currentIndex]
  if (!q) return ''

  // Cap per-field caller-supplied raw text BEFORE rendering. After this
  // point we only escape + assemble — no in-tag slicing possible.
  const header = clipRaw(
    `Вопрос ${pending.currentIndex + 1}/${pending.questions.length}`,
    MAX_HEADER_CHARS,
  )
  // Autonomy M2 (fix-loop #1 CRITICAL + fix-loop-2 #1): a grant-capable card
  // renders the MANDATE BLOCK built from the PERSISTED canonical intent the
  // caller passes in — the owner must see the exact scope a «Да» tap will
  // grant, never a hidden one, and this function NEVER re-parses question
  // text. No intent passed (invalid marker, multiSelect, registry
  // unavailable, persist failure, legacy record) → normal question: raw text
  // shown (marker included — honest), no block, a tap grants nothing; if the
  // text still LOOKS like a marker, an explicit «тап мандат НЕ выдаст» note
  // is appended (fix-loop-2 #5).
  const intent = renderOpts?.leaseIntent
  const questionRaw = clipRaw(intent ? intent.displayText : q.question, MAX_QUESTION_CHARS)
  const mandateBlock = intent
    ? renderMandateBlockOpen(intent)
    : looksLikeLeaseMarker(q.question)
      ? INVALID_MARKER_NOTE
      : ''
  const opts = q.options.slice(0, MAX_KEYBOARD_OPTIONS)

  // Assemble piecewise. `pieces` is the running list of fully-formed
  // HTML chunks (no half-open tags). `running` is the assembled length.
  // Budget = MAX_BODY_CHARS minus the overflow marker so we always have
  // room to append it cleanly if we hit the cap. The mandate block's length
  // is RESERVED up-front so the block is ALWAYS appended in full — the scope
  // can never be the part that gets truncated (scope ≤400 code points ⇒
  // escaped block ≤ ~2.1k chars, so the reserve always leaves headroom).
  const budget = MAX_BODY_CHARS - OVERFLOW_MARKER.length - mandateBlock.length
  const pieces: string[] = []
  let running = 0
  let truncated = false

  // Try to append a fully-formed HTML chunk. Returns true if appended,
  // false if we hit the budget (and sets truncated=true). The newline
  // separator between chunks is accounted for so the joined body stays
  // under `budget`.
  function tryPush(chunk: string): boolean {
    if (truncated) return false
    const sep = pieces.length === 0 ? 0 : 1 // '\n' join cost
    const need = running + sep + chunk.length
    if (need > budget) {
      truncated = true
      return false
    }
    pieces.push(chunk)
    running = need
    return true
  }

  // 1) Header + question text.
  tryPush(`<b>${escapeHtml(header)}</b>`)
  tryPush(escapeHtml(questionRaw))
  tryPush('') // blank line separator (cheap: 0-length chunk + join newline)

  // 2) Option list. Each entry is its own self-contained chunk — if we
  //    run out of budget mid-list the loop bails cleanly, no half tags.
  const optsCount = opts.length
  for (let i = 0; i < optsCount; i++) {
    const opt = opts[i]!
    const label = escapeHtml(clipRaw(opt.label, MAX_BUTTON_LABEL))
    const descRaw = typeof opt.description === 'string' ? opt.description : ''
    let line: string
    if (descRaw.length > 0) {
      const desc = escapeHtml(clipRaw(descRaw, MAX_OPTION_DESCRIPTION_CHARS))
      line = `${i + 1}. <b>${label}</b> — ${desc}`
    } else {
      line = `${i + 1}. ${label}`
    }
    if (!tryPush(line)) break
  }

  // 3) Keyboard-overflow note (only meaningful if the option list itself
  //    overflowed MAX_KEYBOARD_OPTIONS — same rule as the keyboard builder).
  if (!truncated && q.options.length > MAX_KEYBOARD_OPTIONS) {
    tryPush('')
    tryPush(
      `<i>(показаны первые ${MAX_KEYBOARD_OPTIONS} из ${q.options.length} — обрезано)</i>`,
    )
  }

  // 4) Optional `preview` field on options — Claude's AskUserQuestion
  //    API exposes it; our local type doesn't model it strictly
  //    (caller-supplied shape). Probe defensively, clip raw to
  //    config.max_preview_chars, then escape inside `<pre>`.
  if (!truncated) {
    let openedPreviewSection = false
    for (let i = 0; i < opts.length; i++) {
      const opt = opts[i]!
      const previewCandidate = (opt as { preview?: unknown }).preview
      if (typeof previewCandidate !== 'string' || previewCandidate.length === 0) continue
      const clipped = clipRaw(previewCandidate, maxPreviewChars)
      const labelHtml = escapeHtml(clipRaw(opt.label, MAX_BUTTON_LABEL))
      const previewChunk = `<b>${labelHtml}:</b>\n<pre>${escapeHtml(clipped)}</pre>`
      if (!openedPreviewSection) {
        if (!tryPush('')) break
        openedPreviewSection = true
      }
      if (!tryPush(previewChunk)) break
    }
  }

  let body = pieces.join('\n')
  if (truncated) {
    // Self-contained marker — never sliced, never inside another tag.
    body += OVERFLOW_MARKER
  }
  // The mandate block goes LAST and in full — its budget was reserved above,
  // so it is never subject to truncation (fix-loop #1).
  body += mandateBlock
  return body
}

/** Build the inline keyboard for one question. Multi-select rows show
 *  a checkbox prefix reflecting `multiSelectInFlight`. Exported for tests. */
export function buildQuestionKeyboard(
  pending: Readonly<PendingAskRequest>,
): InlineKeyboardLike {
  const q = pending.questions[pending.currentIndex]
  if (!q) return { inline_keyboard: [] }
  const rows: { text: string; callback_data?: string }[][] = []
  const opts = q.options.slice(0, MAX_KEYBOARD_OPTIONS)
  const multiSelect = q.multiSelect === true

  for (let i = 0; i < opts.length; i++) {
    const opt = opts[i]!
    let buttonText: string
    if (multiSelect) {
      const checked = pending.multiSelectInFlight.includes(opt.label)
      const prefix = checked ? MULTISELECT_PREFIX_CHECKED : MULTISELECT_PREFIX_UNCHECKED
      buttonText = prefix + truncateLabel(opt.label, MAX_BUTTON_LABEL - prefix.length)
    } else {
      buttonText = truncateLabel(opt.label)
    }
    const verb = multiSelect ? 'toggle' : 'choose'
    rows.push([
      {
        text: buttonText,
        callback_data: `ask:${verb}:${pending.requestId}:${pending.currentIndex}:${i}`,
      },
    ])
  }

  // Footer row(s): «Другое» always; «Готово» for multiSelect.
  const footer: { text: string; callback_data?: string }[] = [
    {
      text: 'Другое',
      callback_data: `ask:other:${pending.requestId}:${pending.currentIndex}`,
    },
  ]
  if (multiSelect) {
    footer.push({
      text: 'Готово',
      callback_data: `ask:done:${pending.requestId}:${pending.currentIndex}`,
    })
  }
  rows.push(footer)
  return { inline_keyboard: rows }
}

// ─────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────

interface AwaitingOtherEntry {
  requestId: string
  questionIndex: number
  expiresAt: number
  // FIX-T1 F4 (PRX-1 Phase 5): Telegram message_id of the «Введи ответ»
  // prompt. tryHandleOtherText REQUIRES the inbound message's
  // reply_to_message_id to equal this value before consuming, so a
  // freeform text typed at top level cannot hijack the slot. When the
  // sendMessage failed (network blip, Telegram 5xx) the entry is left
  // out — without a prompt id we cannot safely consume any reply.
  promptMessageId?: number
}

export function createAskUserQuestionUi(
  deps: AskUserQuestionUiDeps,
): AskUserQuestionUi {
  const { config, log, telegramApi, relay } = deps
  const now = deps.now ?? (() => Date.now())

  // chatId → pending «Other» state. TTL aligned with the relay's own
  // timeout so we cannot outlive the request itself by more than ~1s.
  // Pruned on every read.
  const awaitingOther = new Map<string, AwaitingOtherEntry>()
  const otherTtlMs = config.ask_user_question.timeout_ms

  function pruneOther(): void {
    const t = now()
    for (const [chatId, entry] of awaitingOther) {
      if (entry.expiresAt <= t) awaitingOther.delete(chatId)
    }
  }

  function isAuthorized(userId: number): boolean {
    const allowed = resolveAskUserQuestionAllowedUserIds(config)
    return allowed.includes(userId)
  }

  // FIX-T2 F1 (PRX-1 Phase 5): per-request «recovered once» marker for the
  // message_gone path in rerenderCurrent. The first time Telegram tells us
  // the anchor message no longer exists (warchief deleted it, 48h edit
  // window expired, etc.) we re-anchor by calling startQuestion. If a
  // SECOND message_gone arrives for the same request, repeated re-anchor
  // would loop until timeout — so we hard-expire the relay instead. The
  // set is keyed by requestId; on settle the relay drops the request and
  // we never touch the marker again, so leakage is bounded by the lifetime
  // of the relay (process restart clears).
  const recoveredOnce = new Set<string>()

  // Autonomy M2 (fix-loop #1 + fix-loop-2 #1): per-question GRANT-INTENT,
  // parsed ONCE at card creation (startQuestion), PERSISTED durably
  // (ask-intents.ts) and keyed `<requestId>:<qIdx>`. This map is only a read
  // CACHE over the durable record: open render, closed render and the tap
  // grant all consume the persisted intent — never a re-parse — so the
  // owner-visible scope and the granted scope cannot diverge across a
  // restart or a parser change. `null` caches «known absent» (not
  // grant-capable). Entries are dropped on settle and after a grant attempt.
  const leaseIntents = new Map<string, PersistedLeaseIntent | null>()

  // Resolve the persisted intent for a card question: cache → disk. Never
  // creates (creation happens in startQuestion only), never parses.
  function resolveLeaseIntent(key: string, chatId: string | undefined): PersistedLeaseIntent | null {
    const cached = leaseIntents.get(key)
    if (cached !== undefined) return cached
    if (!deps.autonomyPaths || chatId === undefined) {
      leaseIntents.set(key, null)
      return null
    }
    const fromDisk = loadLeaseIntent(deps.autonomyPaths, chatId, key) ?? null
    leaseIntents.set(key, fromDisk)
    return fromDisk
  }

  async function clearKeyboard(
    requestId: string | undefined,
    chatId: string,
    messageId: number,
    terminalNote: string,
  ): Promise<void> {
    // Telegram doesn't have a single «clear keyboard» edit when the
    // body text doesn't change. We re-send the body with a one-line
    // terminal note appended and an empty inline_keyboard so the
    // buttons disappear. This mirrors the permission relay's «edit on
    // verdict» behaviour (channel/permissions.ts:319-326).
    try {
      await telegramApi.editMessageText(
        chatId,
        messageId,
        terminalNote,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } },
      )
    } catch (err) {
      // FIX-T2 F1: classify instead of swallowing at warn. For
      // clearKeyboard specifically, message_gone is benign (we wanted
      // the keyboard gone anyway); forbidden indicates the bot lost
      // access to the chat and any further edits/sends would also fail
      // — expire the relay so the hook wrapper gets a clean verdict.
      const cls = classifyEditError(err)
      switch (cls.kind) {
        case 'benign':
        case 'message_gone':
          // Already-gone or already-in-sync — both achieve the intent.
          log.debug('ask_user_question clearKeyboard edit no-op', {
            chat_id: chatId,
            message_id: messageId,
            kind: cls.kind,
          })
          return
        case 'forbidden':
          log.warn('ask_user_question clearKeyboard forbidden — expiring relay', {
            chat_id: chatId,
            message_id: messageId,
            code: cls.code,
            request_id: requestId,
          })
          if (requestId !== undefined) {
            relay.expire(requestId, `telegram forbidden ${cls.code}: ${cls.description}`)
          }
          return
        case 'parse':
          log.error('ask_user_question clearKeyboard parse error', {
            chat_id: chatId,
            message_id: messageId,
            description: cls.description,
            request_id: requestId,
          })
          if (requestId !== undefined) {
            relay.expire(requestId, `telegram parse error: ${cls.description}`)
          }
          return
        case 'flood':
        case 'transient':
          // Rate-limit wrapper already retried 429 transparently; reaching
          // here means retries exhausted or unrelated transient. The
          // keyboard stays orphaned until the next state change — not
          // ideal but recoverable; logging at warn is the right level.
          log.warn('ask_user_question clearKeyboard transient failure', {
            chat_id: chatId,
            message_id: messageId,
            kind: cls.kind,
            description: cls.description,
          })
          return
      }
    }
  }

  async function startQuestion(requestId: string): Promise<void> {
    pruneOther()
    const pending = relay.getPending(requestId)
    if (!pending) {
      log.debug('ask_user_question startQuestion no pending', { request_id: requestId })
      return
    }
    if (!pending.chatId) {
      log.warn('ask_user_question startQuestion missing chatId', { request_id: requestId })
      return
    }
    // Autonomy M2 (fix-loop #1 + fix-loop-2 #1/#3): CARD CREATION is the one
    // place the marker is parsed — and the card is grant-capable ONLY when
    // the canonical intent was durably persisted. No autonomyPaths (factory
    // wired without a registry), no chatId, parse-invalid, multiSelect, or a
    // failed persist → NOT grant-capable: no mandate block, tap grants
    // nothing. The persisted record is what render + tap consume from here on.
    {
      const q = pending.questions[pending.currentIndex]
      const key = `${requestId}:${pending.currentIndex}`
      if (q !== undefined && !leaseIntents.has(key)) {
        let resolved: PersistedLeaseIntent | null = null
        const existing = deps.autonomyPaths
          ? loadLeaseIntent(deps.autonomyPaths, pending.chatId!, key)
          : undefined
        if (existing !== undefined) {
          resolved = existing // recovery: durable record wins, no re-parse
        } else if (deps.autonomyPaths) {
          const parsed = leaseIntentForQuestion(q.question, q.multiSelect)
          if (parsed !== null) {
            const intent: PersistedLeaseIntent = {
              scope: parsed.scope,
              ttlHours: parsed.ttlHours,
              supersede: parsed.supersede,
              scopeDigest: computeScopeDigest(parsed.scope),
              displayText: parsed.displayText,
              createdAtMs: now(),
            }
            if (saveLeaseIntent(deps.autonomyPaths, pending.chatId!, key, intent, log)) {
              resolved = intent
            }
            // persist failed → resolved stays null → card NOT grant-capable
          }
        }
        leaseIntents.set(key, resolved)
      }
    }
    // Phase 5 FIX-T3 F3 (2026-05-27): replay protection. When the webhook
    // submits the same toolUseId twice in a tight window, the relay
    // returns the same requestId from both `.submit()` calls, and the
    // route would call `startQuestion(requestId)` twice. Without this
    // guard the second call would send a fresh message and overwrite
    // the relay's `telegramMessageId`, orphaning the first keyboard
    // (still tappable) and creating a double-anchor. If we already have
    // a message id stashed, re-render the existing anchor instead of
    // minting a new one. rerenderCurrent is owned by FIX-T2 and is
    // idempotent on a no-op edit (Telegram «message is not modified»
    // is swallowed there).
    if (pending.telegramMessageId !== undefined) {
      log.info('ask_user_question startQuestion replay — rerendering anchor', {
        request_id: requestId,
        message_id: pending.telegramMessageId,
      })
      await rerenderCurrent(requestId)
      return
    }
    const startIntent = resolveLeaseIntent(`${requestId}:${pending.currentIndex}`, pending.chatId)
    const body = renderQuestionBody(pending, config.ask_user_question.max_preview_chars, {
      ...(startIntent !== null ? { leaseIntent: startIntent } : {}),
    })
    const keyboard = buildQuestionKeyboard(pending)
    try {
      const sent = await telegramApi.sendMessage(pending.chatId, body, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      })
      relay.setTelegramMessageId(requestId, sent.message_id)
      log.info('ask_user_question rendered', {
        request_id: requestId,
        chat_id: pending.chatId,
        question_index: pending.currentIndex,
        question_count: pending.questions.length,
        message_id: sent.message_id,
      })
    } catch (err) {
      // FIX-T2 F1: classify send error. The original implementation
      // logged and dropped silently, leaving the relay pending until
      // TTL. For permanent failures (bot kicked, parse error) that's
      // 5min of wasted wall-clock and a useless «timeout» verdict.
      const cls = classifyEditError(err)
      switch (cls.kind) {
        case 'forbidden':
          log.warn('ask_user_question render forbidden — expiring relay', {
            request_id: requestId,
            chat_id: pending.chatId,
            code: cls.code,
          })
          relay.expire(
            requestId,
            `telegram forbidden ${cls.code}: bot kicked or unauthorized for chat`,
          )
          return
        case 'parse':
          log.error('ask_user_question render parse error — expiring relay', {
            request_id: requestId,
            chat_id: pending.chatId,
            description: cls.description,
          })
          relay.expire(requestId, `telegram parse error: ${cls.description}`)
          return
        case 'flood':
          // Rate-limit wrapper exhausted retries. Retain pending; the
          // next interaction (user submits same toolUseId) will trigger
          // the replay path, OR the timeout fires.
          log.warn('ask_user_question render flood retry exhausted', {
            request_id: requestId,
            chat_id: pending.chatId,
            retry_after_s: cls.retryAfterSec,
          })
          return
        case 'benign':
        case 'message_gone':
        case 'transient':
          // benign / message_gone can't happen for a fresh sendMessage —
          // no anchor existed. We still log defensively so an unexpected
          // classifier hit is visible.
          log.error('ask_user_question render send failed', {
            request_id: requestId,
            chat_id: pending.chatId,
            kind: cls.kind,
            error: err instanceof Error ? err.message : String(err),
          })
          return
      }
    }
  }

  async function rerenderCurrent(requestId: string): Promise<void> {
    const pending = relay.getPending(requestId)
    if (!pending) return
    if (!pending.chatId || pending.telegramMessageId === undefined) {
      // No previous render — fall back to a fresh send.
      await startQuestion(requestId)
      return
    }
    const rerenderIntent = resolveLeaseIntent(
      `${requestId}:${pending.currentIndex}`,
      pending.chatId,
    )
    const body = renderQuestionBody(pending, config.ask_user_question.max_preview_chars, {
      ...(rerenderIntent !== null ? { leaseIntent: rerenderIntent } : {}),
    })
    const keyboard = buildQuestionKeyboard(pending)
    const chatId = pending.chatId
    const messageId = pending.telegramMessageId
    try {
      await telegramApi.editMessageText(
        chatId,
        messageId,
        body,
        { parse_mode: 'HTML', reply_markup: keyboard },
      )
    } catch (err) {
      // FIX-T2 F1: classify and react instead of warn-and-forget. The
      // pre-fix path swallowed all errors at warn, so a deleted-message
      // or kicked-bot scenario would silently wait until TTL.
      const cls = classifyEditError(err)
      switch (cls.kind) {
        case 'benign':
          // «message is not modified» — body identical to what's there
          // already (e.g. double-tap on the same toggle). No-op.
          log.debug('ask_user_question rerender no-op (not modified)', {
            request_id: requestId,
          })
          return
        case 'message_gone':
          // Warchief deleted the keyboard message, or it aged out of the
          // 48h edit window. Re-anchor ONCE: drop the stale message id and
          // call startQuestion, which sends a fresh keyboard. A SECOND
          // message_gone for the same request means re-anchor didn't help
          // (chat permissions, bot kicked, …) — hard-expire so the hook
          // wrapper gets a clean verdict.
          if (recoveredOnce.has(requestId)) {
            log.warn('ask_user_question rerender message_gone twice — expiring', {
              request_id: requestId,
              chat_id: chatId,
              description: cls.description,
            })
            relay.expire(requestId, 'telegram anchor message gone twice; cannot recover')
            recoveredOnce.delete(requestId)
            return
          }
          recoveredOnce.add(requestId)
          log.info('ask_user_question rerender message_gone — re-anchoring', {
            request_id: requestId,
            chat_id: chatId,
            description: cls.description,
          })
          // Drop the stale id BEFORE calling startQuestion, otherwise the
          // FIX-T3 F3 replay-protection branch would re-enter rerenderCurrent
          // and recurse on the same dead message. The relay setter exposed
          // by TASK-1 only accepts numbers; we work around by simulating an
          // un-anchored state through the relay's per-question reset path —
          // i.e. just call startQuestion, which on no-pending or missing-id
          // already handles the fresh-send case. To force the missing-id
          // path we mutate the local pending snapshot's view via the
          // setTelegramMessageId contract: there's no clear() exposed, so
          // we send a fresh message and overwrite. startQuestion's existing
          // FIX-T3 F3 guard will see telegramMessageId still set and try to
          // rerender — recursion risk. Avoid by sending directly here.
          try {
            const sent = await telegramApi.sendMessage(chatId, body, {
              parse_mode: 'HTML',
              reply_markup: keyboard,
            })
            relay.setTelegramMessageId(requestId, sent.message_id)
            log.info('ask_user_question re-anchored after message_gone', {
              request_id: requestId,
              chat_id: chatId,
              message_id: sent.message_id,
            })
          } catch (sendErr) {
            const sendCls = classifyEditError(sendErr)
            log.warn('ask_user_question re-anchor send failed', {
              request_id: requestId,
              chat_id: chatId,
              kind: sendCls.kind,
              error: sendErr instanceof Error ? sendErr.message : String(sendErr),
            })
            if (sendCls.kind === 'forbidden') {
              relay.expire(requestId, `telegram forbidden ${sendCls.code}: ${sendCls.description}`)
              recoveredOnce.delete(requestId)
            }
          }
          return
        case 'forbidden':
          log.warn('ask_user_question rerender forbidden — expiring relay', {
            request_id: requestId,
            chat_id: chatId,
            code: cls.code,
          })
          relay.expire(requestId, `telegram forbidden ${cls.code}: ${cls.description}`)
          return
        case 'parse':
          log.error('ask_user_question rerender parse error — expiring', {
            request_id: requestId,
            chat_id: chatId,
            description: cls.description,
          })
          relay.expire(requestId, `telegram parse error: ${cls.description}`)
          return
        case 'flood':
          // Rate-limit wrapper exhausted retries. Drop this edit; the
          // user can still tap the same button again to trigger a fresh
          // edit attempt, or tap «Готово» (multi-select) to commit.
          log.warn('ask_user_question rerender flood retry exhausted', {
            request_id: requestId,
            chat_id: chatId,
            retry_after_s: cls.retryAfterSec,
          })
          return
        case 'transient':
          log.warn('ask_user_question rerender transient failure', {
            request_id: requestId,
            chat_id: chatId,
            description: cls.description,
          })
          return
      }
    }
  }

  // Snapshot of the just-answered question, captured in the callback handler
  // BEFORE the relay mutation (which advances currentIndex / clears the
  // in-flight list / drops the anchor). Carries everything needed to close
  // the card with the chosen answer.
  interface AnswerSnapshot {
    requestId: string
    chatId: string | undefined
    messageId: number | undefined
    questionIndex: number
    questionText: string
    totalQuestions: number
    // The persisted grant intent of the answered question (resolved cache→disk
    // BEFORE the relay mutation) — the closed-card renderer shows exactly this
    // scope, and the grant consumes exactly this record (fix-loop-2 #1).
    leaseIntent?: PersistedLeaseIntent
    // True when the question LOOKS like a lease card but the persisted intent
    // is gone (restart before persist, file loss) — closed card then shows
    // «Мандат НЕ выдан: intent утерян (рестарт)».
    intentLost: boolean
    // Pre-built, HTML-safe outcome line («✅ Ответ: <label>»).
    outcomeLineHtml: string
  }

  // One-shot «Ответы приняты» confirmation after the final question. New
  // message (not an edit) so the warchief's device pings. Best-effort.
  async function sendCompletion(chatId: string): Promise<void> {
    try {
      await telegramApi.sendMessage(chatId, COMPLETION_TEXT, { parse_mode: 'HTML' })
    } catch (err) {
      const cls = classifyEditError(err)
      log.debug('ask_user_question completion send failed', {
        chat_id: chatId,
        kind: cls.kind,
      })
    }
  }

  // Compact UTC stamp for the grant-feedback message.
  function fmtLeaseUntil(ms: number): string {
    return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  }

  // Autonomy M2 — mint a lease when the OWNER taps an affirmative option on a
  // `[LEASE: …]` card.
  //
  // SECURITY INVARIANT: this runs ONLY from handleAskCallback's `choose`
  // branch, AFTER `isAuthorized(ctx.from.id)` has passed — i.e. behind the
  // owner allowlist. It is one of exactly TWO lease-grant call sites in the
  // whole plugin (the other is the `/lease` owner command); no agent-callable
  // surface (MCP tool, hook) can reach a grant.
  //
  // FAIL-CLOSED BY DESIGN (fix-loop #8): multiSelect toggles/«Готово» commits
  // and «Другое» free-text NEVER grant — the intent resolver returns null for
  // multiSelect questions, and this helper is not wired into the toggle/done/
  // other/answerOther paths at all. Only an exact affirmative single-select
  // tap grants.
  //
  // Registry errors are fail-open for the ASK flow (the answer is never
  // lost), but NEVER silent for the owner (fix-loop #7): every grant attempt
  // ends in an explicit «выдан / НЕ выдан» feedback message.
  async function maybeGrantLeaseFromTap(input: {
    // The PERSISTED canonical intent resolved (cache → disk) before the relay
    // mutation — exactly the record the card rendered (fix-loop-2 #1).
    intent: PersistedLeaseIntent
    chosenLabel: string
    requestId: string
    questionIndex: number
    chatId: string | undefined
    grantorMessageId: number | undefined
    // A chat we can always reach for feedback (ctx.chatId) even when the
    // pending record's chatId was lost — fix-loop-2 #3: never a silent
    // failure on a grant-capable card.
    feedbackChatId: string
  }): Promise<void> {
    if (!isAffirmativeLabel(input.chosenLabel)) return
    if (!deps.autonomyPaths || input.chatId === undefined) {
      // A grant-capable card reached the tap while the registry is not
      // reachable in THIS process (runtime-only failure — creation-time
      // gating makes this near-impossible). Fail-closed AND visible.
      log.warn('autonomy lease grant impossible — registry unavailable at tap', {
        request_id: input.requestId,
        has_paths: deps.autonomyPaths !== undefined,
      })
      try {
        await telegramApi.sendMessage(input.feedbackChatId, 'Мандат НЕ выдан: реестр недоступен', { parse_mode: 'HTML' })
      } catch {
        // feedback is best-effort
      }
      return
    }
    const intent = input.intent
    let feedback: string
    try {
      const res = await grantLease(
        deps.autonomyPaths,
        input.chatId,
        {
          scope: intent.scope,
          ttlHours: intent.ttlHours,
          source: 'ask_card',
          // Idempotency: a double-tap / replayed callback carrying the same
          // requestId+questionIndex mints exactly one lease (durable ledger
          // in the store survives lease pruning).
          grantSourceId: `ask:${input.requestId}:${input.questionIndex}`,
          supersede: intent.supersede,
          ...(input.grantorMessageId !== undefined ? { grantorMessageId: input.grantorMessageId } : {}),
        },
        log,
        now(),
      )
      if (res.kind === 'ok') {
        log.info('autonomy lease grant from ask card', {
          request_id: input.requestId,
          chat_id: input.chatId,
          outcome: res.outcome,
          lease_id: res.lease?.id,
        })
        switch (res.outcome) {
          case 'granted':
          case 'superseded': {
            const lease = res.lease
            feedback = lease !== undefined
              ? `Мандат ${lease.id} выдан до ${fmtLeaseUntil(lease.expiresAtMs)}`
                + (res.outcome === 'superseded' ? ' (прежний мандат отозван)' : '')
              : 'Мандат НЕ выдан: реестр не вернул запись мандата'
            break
          }
          case 'duplicate_source':
          case 'duplicate_scope':
            feedback = res.lease !== undefined
              ? `Мандат уже существует: ${res.lease.id} (повторный тап, новый не выдан)`
              : 'Этот грант уже был обработан ранее — новый мандат не выдан'
            break
          case 'source_conflict':
            feedback = 'Мандат НЕ выдан: конфликт источника гранта (source_conflict) — этот запрос уже обрабатывался с другим scope'
            break
        }
      } else {
        log.warn('autonomy lease grant from ask card refused', {
          request_id: input.requestId,
          chat_id: input.chatId,
          reason: res.kind,
        })
        feedback = res.kind === 'writer_conflict'
          ? 'Мандат НЕ выдан: реестр занят другим процессом (writer_conflict)'
          : 'Мандат НЕ выдан: реестр записан более новой версией плагина (version_unsupported)'
      }
    } catch (err) {
      log.warn('autonomy lease grant from ask card threw', {
        request_id: input.requestId,
        error: err instanceof Error ? err.message : String(err),
      })
      feedback = 'Мандат НЕ выдан: внутренняя ошибка реестра автономии'
    }
    // Owner feedback — best-effort send, but the attempt itself is mandatory
    // (fix-loop #7: never silent).
    try {
      await telegramApi.sendMessage(input.chatId, feedback, { parse_mode: 'HTML' })
    } catch (err) {
      log.warn('autonomy lease grant feedback send failed', {
        request_id: input.requestId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Codex HIGH (2026-07-02): the follow-up rendering path is decided by the
  // relay's SYNCHRONOUS mutation outcome, NOT by re-inferring state from
  // `getPending()` after an await. The pre-fix code awaited the callback ack
  // between the mutation and this function; if the internal timeout settled
  // the request during that await, a NON-final answer saw
  // `getPending() === undefined` and took the «answered final» branch —
  // closing the card + sending «Ответы принял…» although the request settled
  // as timeout. `outcome.final` is computed at mutation time and immune.
  async function advanceAfterAnswer(snap: AnswerSnapshot, outcome: AskAnswerOutcome): Promise<void> {
    // Relay refused the mutation (stale/duplicate/out-of-range/empty text)
    // — nothing changed, nothing to render.
    if (!outcome.applied) return

    // multiSelect accumulation: an «Другое» free-text entry (or a stray tap)
    // added to the in-flight list WITHOUT advancing. The card stays open —
    // just re-render it so the current state shows. No close, no completion.
    if (!outcome.advanced) {
      await rerenderCurrent(snap.requestId)
      return
    }

    // Close the answered card: keep the question text, append the chosen
    // answer, strip the keyboard so it no longer looks tappable.
    const closedBody = renderClosedQuestionBody(
      snap.questionText,
      snap.questionIndex,
      snap.totalQuestions,
      snap.outcomeLineHtml,
      {
        ...(snap.leaseIntent !== undefined ? { leaseIntent: snap.leaseIntent } : {}),
        intentLost: snap.intentLost,
      },
    )

    if (!outcome.final) {
      // Advanced to the next question. Close the answered card, then render
      // the next. clearKeyboard is best-effort + classifier-aware (a
      // `forbidden` there expires the relay), so re-check before rendering.
      if (snap.chatId !== undefined && snap.messageId !== undefined) {
        await clearKeyboard(snap.requestId, snap.chatId, snap.messageId, closedBody)
      }
      // FIX-T2 F1 + timeout race: if clearKeyboard hit `forbidden` it already
      // expired the relay, and the internal timeout may have settled it during
      // the edit await — either way do NOT render a next question on a settled
      // request. (handleSettle owns the timeout note; anchor was cleared by
      // advance() so there is no double-edit of this card.)
      if (relay.getPending(snap.requestId) === undefined) return
      await startQuestion(snap.requestId)
      return
    }

    // outcome.final — THIS answer settled the request as `answered`. Close
    // the final card, then send ONE completion message. No requestId to
    // clearKeyboard: the relay already settled, so a `forbidden` there has
    // nothing left to expire.
    if (snap.chatId !== undefined && snap.messageId !== undefined) {
      await clearKeyboard(undefined, snap.chatId, snap.messageId, closedBody)
    }
    if (snap.chatId !== undefined) {
      await sendCompletion(snap.chatId)
    }
  }

  // Autonomy M2 — register a timed-out question in the durable registry so an
  // un-answered ask survives a compact/restart. summary = first 100 chars of
  // the (marker-stripped) question. defaultAction is left undefined: the
  // AskUserQuestion payload has no "recommended option" marker to read (the
  // option schema is label+description+preview), so there is nothing to carry.
  // sticky=false. Fail-open — a registry error never breaks settle handling.
  //
  // IDEMPOTENT (fix-loop #4, Codex MED): the question id is DERIVED from the
  // settle identity (`Q-ask-<requestId>-<qIdx>`) via addQuestion's explicit-id
  // path, so a duplicate settle (replayed event, double expire) is a clean
  // `duplicate` no-op — exactly one open question per timed-out card.
  const TIMED_OUT_SUMMARY_MAX = 100
  async function maybeRegisterTimedOutQuestion(event: AskSettleEvent): Promise<void> {
    if (!deps.autonomyPaths || !event.chatId) return
    const clean = stripLeaseMarkerForDisplay(event.questionText ?? '')
    const summary = Array.from(clean).slice(0, TIMED_OUT_SUMMARY_MAX).join('')
    const deterministicId = `Q-ask-${event.requestId}-${event.currentIndex}`
    try {
      const upd = await updateAutonomyState(
        deps.autonomyPaths,
        event.chatId,
        (state) => {
          const r = addQuestion(
            state,
            {
              id: deterministicId,
              summary,
              sticky: false,
              ...(event.telegramMessageId !== undefined ? { messageId: event.telegramMessageId } : {}),
            },
            now(),
          )
          return { state: r.state, result: r.outcome }
        },
        log,
        now(),
      )
      if (upd.kind === 'ok') {
        log.info('autonomy open question registration on timeout', {
          request_id: event.requestId,
          chat_id: event.chatId,
          outcome: upd.result,
        })
      }
    } catch (err) {
      log.warn('autonomy timeout question registration threw (ignored)', {
        request_id: event.requestId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Close the currently-open question card on a settle the UI did NOT drive
  // (internal timeout / external expire). Best-effort — never throws.
  async function handleSettle(event: AskSettleEvent): Promise<void> {
    try {
      // Resolve the persisted intent BEFORE any cleanup — the timeout-closed
      // card must show the same durable scope the open card showed.
      const settleKey = `${event.requestId}:${event.currentIndex}`
      const settleIntent = resolveLeaseIntent(settleKey, event.chatId)
      const settleIntentLost = settleIntent === null
        && event.questionMultiSelect !== true
        && looksLikeLeaseMarker(event.questionText ?? '')
      // Drop the request's grant-intent records on ANY terminal settle —
      // the request is gone, cache and durable record must not linger.
      for (const key of leaseIntents.keys()) {
        if (key.startsWith(`${event.requestId}:`)) leaseIntents.delete(key)
      }
      if (deps.autonomyPaths && event.chatId) {
        deleteLeaseIntent(deps.autonomyPaths, event.chatId, settleKey, log)
      }
      // `answered` is fully handled by the driven callback path (per-question
      // close + completion message); acting here would double-post. Only the
      // timeout/expire family leaves a card open with a live keyboard.
      if (event.status !== 'timeout') return
      // Autonomy M2: auto-register the un-answered question so it survives a
      // compact/restart and surfaces in the reminder/HUD until resolved.
      // Runs even when the card can't be closed (no chatId/messageId) — a
      // registry write only needs the chat id. Fail-open (never throws).
      await maybeRegisterTimedOutQuestion(event)
      if (!event.chatId || event.telegramMessageId === undefined) return
      const body = renderClosedQuestionBody(
        event.questionText ?? '',
        event.currentIndex,
        event.totalQuestions,
        TIMEOUT_OUTCOME_LINE,
        {
          ...(settleIntent !== null ? { leaseIntent: settleIntent } : {}),
          intentLost: settleIntentLost,
        },
      )
      // requestId undefined: relay already settled — nothing left to expire.
      await clearKeyboard(undefined, event.chatId, event.telegramMessageId, body)
    } catch (err) {
      log.debug('ask_user_question handleSettle failed', {
        request_id: event.requestId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function handleAskCallback(ctx: AskCallbackContext): Promise<void> {
    const data = ctx.callbackQuery.data ?? ''
    const parsed = parseAskCallback(data)
    if (!parsed) {
      // Unknown payload — silently ack so Telegram clears the spinner.
      // Do NOT log at warn: this happens normally for non-`ask:`
      // payloads if the dispatcher routed us a non-matching event.
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }

    if (!isAuthorized(ctx.from.id)) {
      log.warn('ask_user_question callback unauthorized', {
        request_id: parsed.requestId,
        user_id: ctx.from.id,
        kind: parsed.kind,
      })
      await ctx.answerCallbackQuery({ text: 'Не авторизован' }).catch(() => {})
      return
    }

    const pendingBefore = relay.getPending(parsed.requestId)
    if (!pendingBefore) {
      // Already resolved or never existed — Telegram replayed a stale tap.
      await ctx.answerCallbackQuery({ text: 'Запрос уже закрыт' }).catch(() => {})
      return
    }

    // Phase 5 FIX-T3 F4 (2026-05-27): stale callback verification BEFORE
    // any relay mutation. Predicate order (matches the task spec):
    //   1. questionIndex      — old keyboard for a question we've moved past
    //   2. chatId             — callback fired in a different chat than the
    //                           one we're waiting for (cross-chat replay)
    //   3. callbackMessageId  — old keyboard from an earlier message that
    //                           was re-anchored by rerenderCurrent/advance
    // Each failure logs a `request_stale_callback` audit line and acks
    // the spinner with a user-facing reason. The relay's own
    // `ensureCurrent` (TASK-1) keeps a silent guard as defence in depth.
    if (pendingBefore.currentIndex !== parsed.questionIndex) {
      log.warn('ask_user_question request_stale_callback', {
        reason: 'question_index_mismatch',
        request_id: parsed.requestId,
        user_id: ctx.from.id,
        kind: parsed.kind,
        callback_question_index: parsed.questionIndex,
        current_index: pendingBefore.currentIndex,
      })
      await ctx.answerCallbackQuery({ text: 'Этот вопрос уже закрыт' }).catch(() => {})
      return
    }
    if (String(pendingBefore.chatId) !== String(ctx.chatId)) {
      log.warn('ask_user_question request_stale_callback', {
        reason: 'chat_id_mismatch',
        request_id: parsed.requestId,
        user_id: ctx.from.id,
        kind: parsed.kind,
        callback_chat_id: ctx.chatId,
        pending_chat_id: pendingBefore.chatId,
      })
      await ctx.answerCallbackQuery({ text: 'Не авторизован' }).catch(() => {})
      return
    }
    if (
      pendingBefore.telegramMessageId !== undefined &&
      ctx.callbackMessageId !== undefined &&
      ctx.callbackMessageId !== pendingBefore.telegramMessageId
    ) {
      log.warn('ask_user_question request_stale_callback', {
        reason: 'message_id_mismatch',
        request_id: parsed.requestId,
        user_id: ctx.from.id,
        kind: parsed.kind,
        callback_message_id: ctx.callbackMessageId,
        anchored_message_id: pendingBefore.telegramMessageId,
      })
      await ctx.answerCallbackQuery({ text: 'Этот вопрос уже закрыт' }).catch(() => {})
      return
    }

    const prevMessageId = pendingBefore.telegramMessageId
    const prevChatId = pendingBefore.chatId
    const currentQuestion = pendingBefore.questions[pendingBefore.currentIndex]
    const totalQuestions = pendingBefore.questions.length

    try {
      if (parsed.kind === 'choose') {
        // Capture the chosen label BEFORE the relay advances past this
        // question — afterwards currentIndex points at the next one.
        const chosenLabel = currentQuestion?.options[parsed.optionIndex]?.label ?? ''
        const isMulti = currentQuestion?.multiSelect === true
        // Autonomy M2 (fix-loop-2 #1): resolve the PERSISTED intent BEFORE
        // the relay mutation — the final-question settle fires synchronously
        // inside answerChoice and clears the cache. Cache → disk only; NEVER
        // a re-parse of the question text (a parser change between deploys
        // must not alter what an already-rendered card grants).
        const intentKey = `${parsed.requestId}:${pendingBefore.currentIndex}`
        const leaseIntent = resolveLeaseIntent(intentKey, prevChatId ?? ctx.chatId)
        // «intent lost»: the text looks like a lease card (presentation-only
        // prefix check) but the durable record is gone — restart before
        // persist / file loss. Fail-closed + visible on the closed card.
        const intentLost = leaseIntent === null && !isMulti
          && looksLikeLeaseMarker(currentQuestion?.question ?? '')
        leaseIntents.delete(intentKey)
        const snap: AnswerSnapshot = {
          requestId: parsed.requestId,
          chatId: prevChatId,
          messageId: prevMessageId,
          questionIndex: pendingBefore.currentIndex,
          questionText: currentQuestion?.question ?? '',
          totalQuestions,
          ...(leaseIntent !== null ? { leaseIntent } : {}),
          intentLost,
          outcomeLineHtml: formatChosenLine(chosenLabel),
        }
        const outcome = relay.answerChoice(parsed.requestId, parsed.questionIndex, parsed.optionIndex)
        // Render BEFORE acking the spinner: the ack is cosmetic and can
        // trail, while any await placed between the mutation and the
        // follow-up render widens the timeout race window (Codex HIGH).
        await advanceAfterAnswer(snap, outcome)
        // Autonomy M2: an affirmative single-select tap on a grant-capable
        // `[LEASE: …]` card mints a lease. Fail-closed gates:
        //   * `outcome.applied && outcome.advanced` — a stale/no-op tap or a
        //     multiSelect toggle-accumulation grants nothing;
        //   * `!isMulti` — multiSelect cards are NEVER grant-capable (their
        //     `choose` is a toggle), and «Готово»/«Другое» paths never reach
        //     a grant at all;
        //   * `leaseIntent !== null` — the card must have rendered a valid
        //     mandate block (the same snapshot is what gets granted).
        if (outcome.applied && outcome.advanced && !isMulti) {
          if (leaseIntent !== null) {
            await maybeGrantLeaseFromTap({
              intent: leaseIntent,
              chosenLabel,
              requestId: parsed.requestId,
              questionIndex: snap.questionIndex,
              chatId: snap.chatId ?? ctx.chatId,
              grantorMessageId: snap.messageId,
              feedbackChatId: ctx.chatId,
            })
            // The intent is consumed — drop the durable record (idempotency
            // of the GRANT lives in the registry ledger, not here).
            if (deps.autonomyPaths) {
              deleteLeaseIntent(deps.autonomyPaths, snap.chatId ?? ctx.chatId, intentKey, log)
            }
          } else if (intentLost && isAffirmativeLabel(chosenLabel)) {
            // The owner affirmed a card that USED to be grant-capable but
            // whose durable intent is gone — refuse loudly (fix-loop-2 #1).
            log.warn('autonomy lease intent lost — grant refused', {
              request_id: parsed.requestId,
              question_index: snap.questionIndex,
            })
            try {
              await telegramApi.sendMessage(ctx.chatId, 'Мандат НЕ выдан: intent утерян (рестарт)', { parse_mode: 'HTML' })
            } catch {
              // best-effort
            }
          }
        }
        await ctx.answerCallbackQuery().catch(() => {})
        return
      }
      if (parsed.kind === 'toggle') {
        relay.toggle(parsed.requestId, parsed.questionIndex, parsed.optionIndex)
        await ctx.answerCallbackQuery().catch(() => {})
        await rerenderCurrent(parsed.requestId)
        return
      }
      if (parsed.kind === 'done') {
        // Snapshot the committed multi-select labels BEFORE `done()` clears
        // the in-flight list (advance resets it to []).
        const committedLabels = [...pendingBefore.multiSelectInFlight]
        const snap: AnswerSnapshot = {
          requestId: parsed.requestId,
          chatId: prevChatId,
          messageId: prevMessageId,
          questionIndex: pendingBefore.currentIndex,
          questionText: currentQuestion?.question ?? '',
          totalQuestions,
          // done() commits a multiSelect question — never grant-capable, so
          // no intent and no lost-intent warning.
          intentLost: false,
          outcomeLineHtml: formatChosenLine(committedLabels.join(', ')),
        }
        const outcome = relay.done(parsed.requestId, parsed.questionIndex)
        // Same ordering rationale as `choose`: render first, ack after.
        await advanceAfterAnswer(snap, outcome)
        await ctx.answerCallbackQuery().catch(() => {})
        return
      }
      // kind === 'other'
      pruneOther()
      const targetChatId = prevChatId ?? ctx.chatId
      await ctx.answerCallbackQuery().catch(() => {})
      // FIX-T1 F4 (PRX-1 Phase 5, 2026-05-27): send with force_reply so
      // Telegram clients auto-quote the prompt — the warchief's next
      // message will carry `reply_to_message_id === sent.message_id`,
      // which tryHandleOtherText then validates. The reply_markup shape
      // is widened via cast: the structural `InlineKeyboardLike` only
      // declares inline_keyboard, but Telegram's wire format accepts
      // ForceReply on the same field. createTelegramApi forwards the
      // markup verbatim and safe-telegram-api passes non-inline
      // markups through unmodified (no string fields to redact).
      const forceReply = {
        force_reply: true,
        selective: true,
        input_field_placeholder: 'Введи ответ',
      }
      let promptMessageId: number | undefined
      try {
        const sent = await telegramApi.sendMessage(
          targetChatId,
          '<i>Введи ответ текстом одним сообщением.</i>',
          {
            parse_mode: 'HTML',
            reply_markup: forceReply as unknown as InlineKeyboardLike,
          },
        )
        promptMessageId = sent.message_id
      } catch (err) {
        log.warn('ask_user_question other prompt send failed', {
          request_id: parsed.requestId,
          chat_id: targetChatId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      // Seed the awaiting slot AFTER the send so promptMessageId is set
      // on success. On send failure we DO NOT seed: without a prompt
      // anchor any subsequent reply could not be safely validated, and
      // a stray reply would otherwise be eaten if we left promptMessageId
      // undefined (tryHandleOtherText's gate would treat undefined as
      // «no check», which is exactly the hijack F4 closes).
      if (promptMessageId !== undefined) {
        awaitingOther.set(targetChatId, {
          requestId: parsed.requestId,
          questionIndex: parsed.questionIndex,
          expiresAt: now() + otherTtlMs,
          promptMessageId,
        })
      }
    } catch (err) {
      log.error('ask_user_question callback handler threw', {
        request_id: parsed.requestId,
        kind: parsed.kind,
        error: err instanceof Error ? err.message : String(err),
      })
      // Best-effort spinner ack so the warchief's UI doesn't hang.
      await ctx.answerCallbackQuery().catch(() => {})
    }
  }

  async function tryHandleOtherText(input: {
    chatId: string
    fromUserId: number
    text: string
    replyToMessageId?: number
  }): Promise<boolean> {
    pruneOther()
    const entry = awaitingOther.get(input.chatId)
    if (!entry) return false
    // FIX-T1 F4 (PRX-1 Phase 5, 2026-05-27): explicit reply-to-prompt
    // gate. Without this, any text in the chat (a permission verdict, a
    // freeform question, a stray emoji) would be silently consumed into
    // the Other slot until the relay timed out. Require the inbound
    // message to actually reply to OUR «Введи ответ» prompt.
    //
    // Both branches return false (NOT true) so the caller falls through
    // to the permission/OOB/channel-forward path — the slot stays open
    // and the warchief can still answer by tapping the reply UI.
    if (entry.promptMessageId === undefined) {
      // Send failed earlier — no anchor to validate against. Refuse to
      // consume on principle so a stray reply is never silently eaten.
      log.debug('ask_user_question other text but no promptMessageId, ignored', {
        request_id: entry.requestId,
      })
      return false
    }
    if (input.replyToMessageId !== entry.promptMessageId) {
      log.debug('ask_user_question other text without matching reply_to, ignored', {
        request_id: entry.requestId,
        expected_reply_to: entry.promptMessageId,
        got_reply_to: input.replyToMessageId ?? null,
      })
      return false
    }
    // Only the warchief (or an allowed approver) can complete the
    // «Other» prompt. If a different sender types in the chat while we
    // wait, ignore — their message flows through normal handlers.
    if (!isAuthorized(input.fromUserId)) {
      log.debug('ask_user_question other text from non-approver, ignored', {
        request_id: entry.requestId,
        user_id: input.fromUserId,
      })
      return false
    }
    // Consume — even on empty text (relay drops empty internally and
    // logs at debug). We still clear the awaiting marker so the user
    // is not silently swallowed forever.
    //
    // Autonomy M2 (fix-loop #8): the «Другое» free-text path NEVER grants a
    // lease — no call into maybeGrantLeaseFromTap here, by design. Only an
    // exact affirmative single-select TAP can grant.
    const pendingBefore = relay.getPending(entry.requestId)
    const currentQuestion = pendingBefore?.questions[pendingBefore.currentIndex]
    const otherIntent = resolveLeaseIntent(
      `${entry.requestId}:${pendingBefore?.currentIndex ?? entry.questionIndex}`,
      pendingBefore?.chatId ?? input.chatId,
    )
    const snap: AnswerSnapshot = {
      requestId: entry.requestId,
      chatId: pendingBefore?.chatId,
      messageId: pendingBefore?.telegramMessageId,
      questionIndex: pendingBefore?.currentIndex ?? entry.questionIndex,
      questionText: currentQuestion?.question ?? '',
      totalQuestions: pendingBefore?.questions.length ?? 0,
      // Closed card of a grant-capable question keeps its mandate line even
      // though «Другое» free-text NEVER grants (fail-closed by design).
      ...(otherIntent !== null ? { leaseIntent: otherIntent } : {}),
      intentLost: false,
      // «Другое» free-text is the chosen answer (truncated in the echo).
      outcomeLineHtml: formatChosenLine(input.text.trim()),
    }
    awaitingOther.delete(input.chatId)
    const outcome = relay.answerOther(entry.requestId, entry.questionIndex, input.text)
    await advanceAfterAnswer(snap, outcome)
    return true
  }

  function awaitingOtherCount(): number {
    pruneOther()
    return awaitingOther.size
  }

  return {
    startQuestion,
    handleAskCallback,
    tryHandleOtherText,
    handleSettle,
    awaitingOtherCount,
  }
}
