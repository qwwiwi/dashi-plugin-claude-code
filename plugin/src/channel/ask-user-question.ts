// AskUserQuestion relay — in-plugin pending-request state machine.
//
// Lives between the PreToolUse hook wrapper (TASK-4) and the Telegram
// keyboard UX (TASK-2): the wrapper POSTs a `submit` here, gets a Promise
// that resolves only when the warchief answers via inline keyboard OR
// the timer fires. The webhook layer (TASK-3) routes Telegram callbacks
// back into `answerChoice` / `toggle` / `done` / `expire`.
//
// Strict scope (per Codex PLAN.md TASK-1):
//   - PURE LOGIC. No Telegram sendMessage, no HTTP, no audit jsonl.
//   - Telegram & audit live in TASK-2 / TASK-6 modules — we only EXPOSE
//     `telegramMessageId` + `chatId` fields on the pending record so the
//     UX module can stash render state for itself, and we re-emit them
//     unchanged on the result so audit callers downstream get them.
//
// Lifetime model — ONE Promise per submit():
//   submit() → { resolve, reject } captured in PendingAskRequest. All
//   subsequent state transitions (answerChoice / toggle / done / expire
//   / timeout) feed the SAME resolve. First transition wins; everything
//   else is a no-op. This keeps the public surface small (no new-promise-
//   per-call ceremony) and matches the natural CC contract: one tool call
//   blocks on one verdict.
//
// Idempotency surfaces:
//   1. completedIds — short TTL cache of just-resolved request_ids so a
//      late callback (network hiccup, double-tap on Telegram) returns
//      `{ status: 'idempotent' }` instead of mis-resolving a stale ID.
//   2. toolUseIndex — same toolUseId re-submitted within TTL returns the
//      existing pending Promise (the hook wrapper retried) OR the cached
//      result (the hook wrapper retried after we already resolved).
//   3. expire() / timeout race — guarded by `request._settled` flag.

import { generateUniqueShortId } from './short-id.js'
import type { Logger } from '../log.js'

// ─────────────────────────────────────────────────────────────────────
// Wire shapes — mirror the Claude Code AskUserQuestion tool input.
// Kept local to this module (not in schemas.ts) until TASK-3 wires them
// into the webhook body schema. Caller-supplied shape so we don't bind
// to a specific CC version here.
// ─────────────────────────────────────────────────────────────────────

export interface AskQuestionOption {
  label: string
  description?: string
}

export interface AskQuestion {
  question: string
  multiSelect?: boolean
  options: AskQuestionOption[]
}

export interface SubmitInput {
  toolUseId: string
  sessionId: string
  questions: AskQuestion[]
  // The chat that will receive the keyboard. Optional: callers that
  // determined no chat is reachable (no policy match, dm_only mismatch,
  // etc.) submit without chatId — we return `pass_through` immediately
  // so the hook wrapper falls back to native CC terminal UI.
  chatId?: string
  // Hard override; otherwise we use deps.defaultTimeoutMs.
  timeoutMs?: number
}

// Status taxonomy:
//   answered      — all questions resolved; `updatedInput` ready for CC
//   pass_through  — caller said no chat available; native UI takes over
//   timeout       — TTL fired before answer
//   unauthorized  — caller signalled the requester wasn't allowed
//                   (not used by the core relay, reserved for the
//                   webhook layer to short-circuit)
//   idempotent    — duplicate callback after request already settled
export type AskUserQuestionStatus =
  | 'answered'
  | 'pass_through'
  | 'timeout'
  | 'unauthorized'
  | 'idempotent'

// Fired by the relay whenever a request reaches a terminal state (answered
// / timeout / expire). The relay owns lifecycle (the internal timeout timer
// + external expire()), so this is the ONLY seam through which the UI (which
// owns rendering/edits) learns about a settle it did NOT drive itself — most
// importantly the internal timeout, where no callback path runs. The snapshot
// carries just enough render state (chatId, the currently-open keyboard's
// message id, the current question text/index) for the UI to close the open
// card. Pure data — the relay never touches Telegram.
export interface AskSettleEvent {
  requestId: string
  toolUseId: string
  status: AskUserQuestionStatus
  // The chat + message id of the CURRENTLY-OPEN question keyboard at settle
  // time. On `answered` the relay has already cleared the anchor (undefined);
  // on `timeout`/expire it points at the card the warchief left un-answered.
  chatId: string | undefined
  telegramMessageId: number | undefined
  currentIndex: number
  totalQuestions: number
  // Text of the currently-open question (for the closed-card re-render).
  questionText: string | undefined
  // Whether the currently-open question is multiSelect (autonomy M2): a
  // multiSelect card is NEVER grant-capable, so the closed-card renderer
  // must not present its lease marker as a mandate block either.
  questionMultiSelect: boolean | undefined
  reason: string | undefined
}

export interface AskUserQuestionResult {
  status: AskUserQuestionStatus
  requestId?: string
  toolUseId?: string
  // Only present on `status === 'answered'`. Shape mirrors CC's
  // PreToolUse `updatedInput` for AskUserQuestion: the original
  // questions array + a label-keyed `answers` map. Multi-select labels
  // are joined by ", " (CC docs convention).
  updatedInput?: {
    questions: AskQuestion[]
    answers: Record<string, string | string[]>
  }
  reason?: string
}

// Return shape of the answer-mutation methods (answerChoice / answerOther /
// done). Computed SYNCHRONOUSLY at mutation time so the UI can decide the
// follow-up rendering without re-inferring state after an await — inferring
// finality from `getPending() === undefined` later is racy: the internal
// timeout can settle the request during the await, making a NON-final answer
// look like «answered final» (Codex HIGH, 2026-07-02).
export interface AskAnswerOutcome {
  /** The call mutated state (recorded/accumulated an answer). False for
   *  missing request, stale questionIndex, out-of-range option, empty
   *  Other-text, done() on non-multiSelect or with empty selection. */
  applied: boolean
  /** The call moved PAST the question (single-select pick / multiSelect
   *  commit) — as opposed to accumulating into the in-flight list. */
  advanced: boolean
  /** THIS call settled the whole request as `answered` (it was the final
   *  question). The ONLY trustworthy trigger for the completion message. */
  final: boolean
}

const NOOP_OUTCOME: AskAnswerOutcome = { applied: false, advanced: false, final: false }

// ─────────────────────────────────────────────────────────────────────
// PendingAskRequest — the mutable per-request record.
// Public only because TASK-2 / TASK-3 inspect a few fields (chatId,
// telegramMessageId, currentIndex). Treat as opaque elsewhere.
// ─────────────────────────────────────────────────────────────────────

export interface PendingAskRequest {
  requestId: string
  toolUseId: string
  sessionId: string
  createdAt: number
  expiresAt: number
  questions: AskQuestion[]
  currentIndex: number
  answers: Record<string, string | string[]>
  multiSelectInFlight: string[] // labels accumulated for current question
  telegramMessageId?: number
  chatId?: string
  // Internal — set only via _settle(). Public reads via isPending() are
  // the contract for outside callers.
  _settled: boolean
  _timer: ReturnType<typeof setTimeout> | null
  _resolve: (result: AskUserQuestionResult) => void
  _reject: (err: Error) => void
}

// ─────────────────────────────────────────────────────────────────────
// Deps + factory.
// ─────────────────────────────────────────────────────────────────────

export interface AskUserQuestionRelayDeps {
  log: Logger
  now?: () => number
  defaultTimeoutMs?: number
  // How long to remember a resolved request_id for idempotent late
  // callbacks. Default 60s — longer than any reasonable Telegram retry
  // window, shorter than the typical timeout itself so we don't bloat
  // memory under load.
  completedTtlMs?: number
  // Terminal-state notifier. Fired once per request on settle (answered /
  // timeout / expire), AFTER the result Promise resolves. The UI registers
  // this to close the open keyboard on the paths it can't observe itself
  // (chiefly the internal timeout). Never awaited — best-effort, and a
  // throwing handler is logged, never allowed to break settle.
  onSettle?: (event: AskSettleEvent) => void
}

// Phase 5 FIX-T3 F1 (2026-05-27): submit() returns the requestId
// synchronously alongside the result Promise, eliminating the
// `listPendingIds().find(...toolUseId)` race in webhook/server.ts that
// could mis-route concurrent submits with the same toolUseId. The
// requestId is non-empty for fresh requests; for sync-resolved paths
// (no chatId → pass_through, empty questions → answered, toolUseId
// replay) it is undefined and the caller MUST skip any "wire up the
// keyboard now" step and rely on the Promise's verdict alone.
export interface SubmittedRequest {
  /** Undefined when submit() resolved synchronously (pass_through,
   *  empty-questions, or idempotent replay) — caller skips TG wiring. */
  requestId: string | undefined
  result: Promise<AskUserQuestionResult>
}

export interface AskUserQuestionRelay {
  submit(input: SubmitInput): SubmittedRequest
  // Record an option pick for the current question and advance.
  // `optionIndex` indexes into the current question's `options`.
  // Returns the mutation outcome (applied / advanced / final) computed
  // synchronously so the caller never has to re-infer it post-await.
  answerChoice(requestId: string, questionIndex: number, optionIndex: number): AskAnswerOutcome
  // Record free-form text (the "Other" button path) as the answer for
  // the current question. For multiSelect, appends to the in-flight
  // list; for single-select, advances immediately.
  answerOther(requestId: string, questionIndex: number, otherText: string): AskAnswerOutcome
  // Toggle a multi-select option on/off. No-op if not multiSelect.
  toggle(requestId: string, questionIndex: number, optionIndex: number): void
  // Commit the multi-select in-flight list as the answer and advance.
  done(requestId: string, questionIndex: number): AskAnswerOutcome
  // External "give up" — resolves with status='timeout' and reason.
  expire(requestId: string, reason?: string): void
  isPending(requestId: string): boolean
  // For TASK-2: peek render state without consuming.
  getPending(requestId: string): Readonly<PendingAskRequest> | undefined
  // For TASK-2: stash the Telegram message id after sending the keyboard
  // so subsequent edit/clear operations know what to target.
  setTelegramMessageId(requestId: string, messageId: number): void
  // Test/inspection — number of in-flight requests.
  pendingCount(): number
  // Test/inspection — enumerate in-flight request ids. Useful for
  // /status diagnostics and tests that need to discover an id generated
  // internally. Order is not contractual.
  listPendingIds(): string[]
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_COMPLETED_TTL_MS = 60 * 1000

export function createAskUserQuestionRelay(
  deps: AskUserQuestionRelayDeps,
): AskUserQuestionRelay {
  const log = deps.log
  const now = deps.now ?? (() => Date.now())
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const completedTtlMs = deps.completedTtlMs ?? DEFAULT_COMPLETED_TTL_MS
  const onSettle = deps.onSettle

  const pending = new Map<string, PendingAskRequest>()
  // toolUseId → live requestId (only while pending; cleared on settle so
  // a retry after timeout starts fresh).
  const toolUseIndex = new Map<string, string>()
  // requestId → cached terminal result. Pruned on read when expired.
  const completedIds = new Map<string, { result: AskUserQuestionResult; expiresAt: number }>()
  // toolUseId → cached terminal result. Mirrors completedIds so a hook
  // wrapper retry that doesn't know the requestId still gets the right
  // verdict back.
  const completedByToolUseId = new Map<string, { result: AskUserQuestionResult; expiresAt: number }>()
  // Promises in flight, keyed by requestId. Used so a duplicate submit
  // with the same toolUseId can attach to the existing Promise instead
  // of allocating a fresh pending record (which would leak).
  const liveResultPromise = new Map<string, Promise<AskUserQuestionResult>>()

  function pruneCompleted(): void {
    const t = now()
    for (const [id, entry] of completedIds) {
      if (entry.expiresAt <= t) completedIds.delete(id)
    }
    for (const [id, entry] of completedByToolUseId) {
      if (entry.expiresAt <= t) completedByToolUseId.delete(id)
    }
  }

  function settle(req: PendingAskRequest, result: AskUserQuestionResult): void {
    if (req._settled) return
    req._settled = true
    if (req._timer !== null) {
      clearTimeout(req._timer)
      req._timer = null
    }
    pending.delete(req.requestId)
    toolUseIndex.delete(req.toolUseId)
    liveResultPromise.delete(req.requestId)
    const expiresAt = now() + completedTtlMs
    completedIds.set(req.requestId, { result, expiresAt })
    completedByToolUseId.set(req.toolUseId, { result, expiresAt })
    try {
      req._resolve(result)
    } catch (err) {
      log.error('ask_user_question resolve threw', {
        request_id: req.requestId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    // Notify the UI so it can close the open keyboard on paths it can't
    // observe itself (the internal timeout timer, external expire). We read
    // the render fields off `req` — still intact even though we removed it
    // from the pending map above. Best-effort: a throwing handler is logged,
    // never allowed to poison the settle.
    if (onSettle) {
      try {
        const currentQuestion = req.questions[req.currentIndex]
        onSettle({
          requestId: req.requestId,
          toolUseId: req.toolUseId,
          status: result.status,
          chatId: req.chatId,
          telegramMessageId: req.telegramMessageId,
          currentIndex: req.currentIndex,
          totalQuestions: req.questions.length,
          questionText: currentQuestion?.question,
          questionMultiSelect: currentQuestion?.multiSelect,
          reason: result.reason,
        })
      } catch (err) {
        log.error('ask_user_question onSettle handler threw', {
          request_id: req.requestId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  function buildAnsweredResult(req: PendingAskRequest): AskUserQuestionResult {
    return {
      status: 'answered',
      requestId: req.requestId,
      toolUseId: req.toolUseId,
      updatedInput: {
        questions: req.questions,
        answers: req.answers,
      },
    }
  }

  function advance(req: PendingAskRequest): void {
    // Move to next question or settle as answered.
    req.currentIndex += 1
    req.multiSelectInFlight = []
    // Clear the keyboard message handle so TASK-2 sends a fresh one.
    delete req.telegramMessageId
    if (req.currentIndex >= req.questions.length) {
      settle(req, buildAnsweredResult(req))
    }
  }

  function recordSingle(req: PendingAskRequest, label: string): void {
    const q = req.questions[req.currentIndex]
    if (!q) return
    req.answers[q.question] = label
  }

  function recordMulti(req: PendingAskRequest, labels: string[]): void {
    const q = req.questions[req.currentIndex]
    if (!q) return
    // Join with ", " per CC docs; preserve the array as a fallback for
    // callers that prefer structured form (we type as string|string[]).
    req.answers[q.question] = labels.join(', ')
  }

  function ensureCurrent(req: PendingAskRequest, questionIndex: number, op: string): boolean {
    if (req._settled) return false
    if (questionIndex !== req.currentIndex) {
      // Stale callback from a prior question — silently drop. TASK-2 is
      // expected to keep the message id in sync, but a slow tap on an
      // already-edited keyboard can still fire.
      log.debug('ask_user_question stale callback ignored', {
        request_id: req.requestId,
        op,
        question_index: questionIndex,
        current_index: req.currentIndex,
      })
      return false
    }
    return true
  }

  function submit(input: SubmitInput): SubmittedRequest {
    pruneCompleted()
    // No chat → caller is signalling pass-through. Sync resolution, no id.
    if (!input.chatId) {
      const result: AskUserQuestionResult = {
        status: 'pass_through',
        toolUseId: input.toolUseId,
        reason: 'no chat available for this session',
      }
      return { requestId: undefined, result: Promise.resolve(result) }
    }
    // Empty questions array → answered with empty map. Defensive: CC
    // shouldn't fire AskUserQuestion with zero questions, but if a hook
    // wrapper is misbehaving we shouldn't hang forever.
    if (input.questions.length === 0) {
      const result: AskUserQuestionResult = {
        status: 'answered',
        toolUseId: input.toolUseId,
        updatedInput: { questions: [], answers: {} },
      }
      return { requestId: undefined, result: Promise.resolve(result) }
    }

    // toolUseId replay protection. Live attach exposes the EXISTING
    // requestId so the webhook layer treats this like a fresh submit for
    // audit + keyboard wiring (the UI's own startQuestion() idempotency
    // guard — FIX-T3 F3 — prevents a duplicate keyboard send).
    const existingReqId = toolUseIndex.get(input.toolUseId)
    if (existingReqId !== undefined) {
      const live = liveResultPromise.get(existingReqId)
      if (live) {
        log.info('ask_user_question replay attaches to live request', {
          tool_use_id: input.toolUseId,
          request_id: existingReqId,
        })
        return { requestId: existingReqId, result: live }
      }
    }
    const completed = completedByToolUseId.get(input.toolUseId)
    if (completed && completed.expiresAt > now()) {
      log.info('ask_user_question replay returns cached result', {
        tool_use_id: input.toolUseId,
        request_id: completed.result.requestId,
        status: completed.result.status,
      })
      // FIX-T2 F3 — submit() replay MUST return the cached terminal
      // status UNCHANGED. The hook wrapper (TASK-4) treats any unknown
      // status (including 'idempotent') as deny, so re-mapping a real
      // 'answered' to 'idempotent' here would block a valid retry. The
      // 'idempotent' status is reserved for the callback HTTP surface
      // (POST /answer), where duplicate clicks deserve a distinct code.
      // Sync resolution → requestId=undefined (the request is already
      // settled; the caller has nothing left to wire up).
      return { requestId: undefined, result: Promise.resolve(completed.result) }
    }

    // Phase 5 FIX-T3 F2 (2026-05-27): generate against BOTH the live
    // pending Map and the completedIds TTL cache. Otherwise a request
    // that just settled (still living in completedIds for the TTL
    // window) could have its id reused for a fresh request, and an old
    // Telegram callback could mis-route into the new request.
    const requestId = generateUniqueShortId(
      (id) => pending.has(id) || completedIds.has(id),
    )
    const timeoutMs = input.timeoutMs ?? defaultTimeoutMs
    const createdAt = now()
    const expiresAt = createdAt + timeoutMs

    let resolver!: (r: AskUserQuestionResult) => void
    let rejecter!: (err: Error) => void
    const promise = new Promise<AskUserQuestionResult>((resolve, reject) => {
      resolver = resolve
      rejecter = reject
    })

    const req: PendingAskRequest = {
      requestId,
      toolUseId: input.toolUseId,
      sessionId: input.sessionId,
      createdAt,
      expiresAt,
      questions: input.questions,
      currentIndex: 0,
      answers: {},
      multiSelectInFlight: [],
      chatId: input.chatId,
      _settled: false,
      _timer: null,
      _resolve: resolver,
      _reject: rejecter,
    }

    req._timer = setTimeout(() => {
      // Re-fetch to guard against `expire()` having already removed us.
      const stillHere = pending.get(requestId)
      if (!stillHere || stillHere._settled) return
      settle(stillHere, {
        status: 'timeout',
        requestId,
        toolUseId: req.toolUseId,
        reason: `ask_user_question timed out after ${timeoutMs}ms`,
      })
    }, timeoutMs)
    // Don't keep the event loop alive solely for this timer. Bun/Node
    // expose .unref() on Timer; guard for older runtimes.
    const timer = req._timer as unknown as { unref?: () => void }
    if (typeof timer.unref === 'function') timer.unref()

    pending.set(requestId, req)
    toolUseIndex.set(input.toolUseId, requestId)
    liveResultPromise.set(requestId, promise)

    log.info('ask_user_question submitted', {
      request_id: requestId,
      tool_use_id: input.toolUseId,
      session_id: input.sessionId,
      chat_id: input.chatId,
      question_count: input.questions.length,
      timeout_ms: timeoutMs,
    })

    return { requestId, result: promise }
  }

  function answerChoice(requestId: string, questionIndex: number, optionIndex: number): AskAnswerOutcome {
    // FIX-T2 F4 — call pruneCompleted on every public surface so cached
    // entries don't accumulate after a burst followed by idle time.
    pruneCompleted()
    const req = pending.get(requestId)
    if (!req) return NOOP_OUTCOME
    if (!ensureCurrent(req, questionIndex, 'answerChoice')) return NOOP_OUTCOME
    const q = req.questions[req.currentIndex]
    if (!q) return NOOP_OUTCOME
    const opt = q.options[optionIndex]
    if (!opt) {
      log.warn('ask_user_question answerChoice out of range', {
        request_id: requestId,
        question_index: questionIndex,
        option_index: optionIndex,
      })
      return NOOP_OUTCOME
    }
    if (q.multiSelect === true) {
      // For multi-select, a "choice" tap is a toggle. Keep semantics
      // explicit: callers should prefer toggle(); this is the safety
      // net if TASK-2 routes the wrong handler.
      toggleInternal(req, optionIndex)
      return { applied: true, advanced: false, final: false }
    }
    recordSingle(req, opt.label)
    advance(req)
    // `advance` only ever settles as `answered`; ensureCurrent guaranteed
    // _settled was false on entry, and nothing between here and there
    // awaits — so `req._settled` now means THIS call answered the final
    // question. This synchronous read is the whole point of the outcome.
    return { applied: true, advanced: true, final: req._settled }
  }

  function answerOther(requestId: string, questionIndex: number, otherText: string): AskAnswerOutcome {
    pruneCompleted() // FIX-T2 F4
    const req = pending.get(requestId)
    if (!req) return NOOP_OUTCOME
    if (!ensureCurrent(req, questionIndex, 'answerOther')) return NOOP_OUTCOME
    const q = req.questions[req.currentIndex]
    if (!q) return NOOP_OUTCOME
    const text = otherText.trim()
    if (text.length === 0) {
      log.debug('ask_user_question answerOther empty text', {
        request_id: requestId,
        question_index: questionIndex,
      })
      return NOOP_OUTCOME
    }
    if (q.multiSelect === true) {
      req.multiSelectInFlight = [...req.multiSelectInFlight, text]
      return { applied: true, advanced: false, final: false }
    }
    recordSingle(req, text)
    advance(req)
    return { applied: true, advanced: true, final: req._settled }
  }

  function toggleInternal(req: PendingAskRequest, optionIndex: number): void {
    const q = req.questions[req.currentIndex]
    if (!q || q.multiSelect !== true) return
    const opt = q.options[optionIndex]
    if (!opt) return
    const label = opt.label
    const idx = req.multiSelectInFlight.indexOf(label)
    if (idx === -1) {
      req.multiSelectInFlight = [...req.multiSelectInFlight, label]
    } else {
      req.multiSelectInFlight = [
        ...req.multiSelectInFlight.slice(0, idx),
        ...req.multiSelectInFlight.slice(idx + 1),
      ]
    }
  }

  function toggle(requestId: string, questionIndex: number, optionIndex: number): void {
    pruneCompleted() // FIX-T2 F4
    const req = pending.get(requestId)
    if (!req) return
    if (!ensureCurrent(req, questionIndex, 'toggle')) return
    toggleInternal(req, optionIndex)
  }

  function done(requestId: string, questionIndex: number): AskAnswerOutcome {
    pruneCompleted() // FIX-T2 F4
    const req = pending.get(requestId)
    if (!req) return NOOP_OUTCOME
    if (!ensureCurrent(req, questionIndex, 'done')) return NOOP_OUTCOME
    const q = req.questions[req.currentIndex]
    if (!q || q.multiSelect !== true) {
      log.debug('ask_user_question done on non-multiselect ignored', {
        request_id: requestId,
        question_index: questionIndex,
      })
      return NOOP_OUTCOME
    }
    if (req.multiSelectInFlight.length === 0) {
      // Defensive: TASK-2 should disable Done until at least one item is
      // toggled. If it slips through, do nothing — the user hasn't picked.
      log.debug('ask_user_question done with empty selection ignored', {
        request_id: requestId,
        question_index: questionIndex,
      })
      return NOOP_OUTCOME
    }
    recordMulti(req, req.multiSelectInFlight)
    advance(req)
    return { applied: true, advanced: true, final: req._settled }
  }

  function expire(requestId: string, reason?: string): void {
    pruneCompleted() // FIX-T2 F4
    const req = pending.get(requestId)
    if (!req) return
    settle(req, {
      status: 'timeout',
      requestId,
      toolUseId: req.toolUseId,
      reason: reason ?? 'explicit expire',
    })
  }

  function isPending(requestId: string): boolean {
    return pending.has(requestId)
  }

  function getPending(requestId: string): Readonly<PendingAskRequest> | undefined {
    return pending.get(requestId)
  }

  function setTelegramMessageId(requestId: string, messageId: number): void {
    const req = pending.get(requestId)
    if (!req) return
    req.telegramMessageId = messageId
  }

  function pendingCount(): number {
    return pending.size
  }

  function listPendingIds(): string[] {
    return Array.from(pending.keys())
  }

  return {
    submit,
    answerChoice,
    answerOther,
    toggle,
    done,
    expire,
    isPending,
    getPending,
    setTelegramMessageId,
    pendingCount,
    listPendingIds,
  }
}
