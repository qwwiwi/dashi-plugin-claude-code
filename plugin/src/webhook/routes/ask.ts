// ─────────────────────────────────────────────────────────────────────
// AskUserQuestion route handlers (PRX-1 TASK-3, 2026-05-27).
//
// Two endpoints feed the same in-process relay (TASK-1):
//   POST /hooks/ask-user-question/request — long-wait. Hook wrapper
//     posts the AskUserQuestion tool_input + a per-call timeout; we
//     submit() to the relay (which sends the keyboard via TASK-2),
//     await the relay promise (up to config-clamped timeout), then
//     respond with `{ status, updatedInput? }`. Idle for ≤5 min.
//   POST /hooks/ask-user-question/answer — short. External relay
//     (Telegram → cloud function → loopback) can call this to feed an
//     answer into the relay; in-process callback flows use TASK-2's
//     own grammy bot.on('callback_query:data') path instead. Optional
//     seam — implemented for symmetry/forward-compat.
//
// Authoritative auth chain (run on EVERY request):
//   1. loopback-only socket (defence-in-depth even on 127.0.0.1 binds)
//   2. bearer token via timing-safe compare
//   3. relay+UI must both be wired (else 503 → hook falls back to
//      native UI)
//   4. config.ask_user_question.enabled must be true (else `pass_through`)
//   5. body parse + Zod schema validate (caps + per-route 64 KB read)
//
// chatId resolution for MVP (warchief DM hardcoded):
//   `resolveAskUserQuestionAllowedUserIds(config)[0]` — the SAME helper
//   the /answer route uses to authorise the answerer. Using a different
//   source here (e.g. permission_relay.allowed_user_ids[0] directly)
//   would mean the prompt lands in chat A but only chat B is allowed
//   to answer — a misconfiguration we'd discover only when an answer
//   never arrives (Codex webhook #1). In a DM the user_id and chat_id
//   are identical (Telegram convention) so the first allowed user id
//   is the warchief's DM chat. TODO(multichat): derive from session_id
//   ⇨ tmux session ⇨ originating chat. Out of scope for MVP.
//
// Extracted verbatim from server.ts during the route-module split; no
// behaviour change.
// ─────────────────────────────────────────────────────────────────────

import type { IncomingMessage, ServerResponse } from 'http'
import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

import type { AppConfig, StatePaths } from '../../config.js'
import { resolveAskUserQuestionAllowedUserIds } from '../../config.js'
import type { Logger } from '../../log.js'
import {
  AskUserQuestionAnswerSchema,
  AskUserQuestionRequestSchema,
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
} from '../../schemas.js'
import { isShortId } from '../../channel/short-id.js'
import type {
  AskUserQuestionRelay,
  AskUserQuestionResult,
} from '../../channel/ask-user-question.js'
import type { WebhookDeps } from '../server.js'
import { ASK_SOCKET_TIMEOUT_MARGIN_MS, authGate, readJsonBody, reply } from './shared.js'

// Per-route cap for AskUserQuestion bodies. Cheap pre-check: drains
// fewer bytes than the generic limit before paying Zod's parse cost.
// 64 KB is the upper bound the PRX-1 plan reserved for AskUserQuestion;
// 4 questions × 4 options × ~1 KB preview ≈ 16 KB worst case, leaving
// headroom for header/description text + question prose.
const ASK_BODY_LIMIT_BYTES = 64 * 1024

// F4: how long we await `askUi.startQuestion` before giving up and
// letting the relay's own timeout drive the verdict. Telegram's API
// usually responds in <1s; 10s is a generous ceiling that still leaves
// 4.5 min of the default 5min relay window for the user to actually
// answer. We do NOT cancel the underlying send — the warchief still
// gets the prompt if TG recovers within the relay's longer window.
const START_QUESTION_DEADLINE_MS = 10_000

// Append-only audit JSONL writer for AskUserQuestion route events.
// Mirrors the pattern in channel/permissions.ts (`mkdirSync + appendFileSync`)
// but lives here because the audit fires from request/answer endpoints,
// not from the relay itself. Failures are swallowed with a `log.warn` —
// audit loss must never block a route response.
function writeAskAuditEvent(
  statePaths: StatePaths,
  log: Logger,
  event: Record<string, unknown>,
): void {
  const auditPath = statePaths.logs.ask_user_question
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n'
  try {
    mkdirSync(dirname(auditPath), { recursive: true, mode: 0o700 })
    appendFileSync(auditPath, line, { mode: 0o600 })
  } catch (err) {
    log.warn('ask_user_question audit write failed', {
      path: auditPath,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

function resolveAskChatId(config: AppConfig): string | undefined {
  // MVP: warchief DM. The warchief's chat_id == user_id in DM context.
  // Routed through `resolveAskUserQuestionAllowedUserIds` so the route
  // is guaranteed to use the same authoritative allowlist as /answer.
  // The helper falls back to permission_relay when ask_user_question's
  // dedicated list is unset — so a single allowlist change still
  // propagates to BOTH the prompt destination and the answer authz.
  const allowed = resolveAskUserQuestionAllowedUserIds(config)
  const first = allowed[0]
  return first === undefined ? undefined : String(first)
}

export async function handleAskRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookDeps,
  webhookToken: string | undefined,
): Promise<void> {
  const { config, statePaths, log, askRelay, askUi } = deps

  if (!authGate(req, res, webhookToken)) return

  const parsed = await readJsonBody(
    req,
    res,
    log,
    ASK_BODY_LIMIT_BYTES,
    AskUserQuestionRequestSchema,
    'ask_user_question/request',
  )
  if (!parsed.ok) return
  const payload: AskUserQuestionRequest = parsed.value

  // Feature gate: when the operator hasn't enabled the relay we still
  // accept the call (200) but tell the hook wrapper to fall back to
  // native CC UI. Returning a non-200 here would deny the tool, which
  // is the opposite of the intended UX while the feature is dormant.
  if (config.ask_user_question.enabled !== true) {
    reply(res, 200, { status: 'pass_through' })
    return
  }

  if (!askRelay || !askUi) {
    // Wired in config but not in the process — operator deployed an old
    // build, or the relay constructor threw at boot. Fail soft with 503
    // so the hook wrapper falls back to native UI rather than denying.
    log.warn('ask_user_question/request received but relay or ui not wired', {
      has_relay: askRelay !== undefined,
      has_ui: askUi !== undefined,
    })
    reply(res, 503, { error: 'ask_user_question relay not wired' })
    return
  }

  const chatId = resolveAskChatId(config)
  if (chatId === undefined) {
    // No reachable chat → pass through. Defensive: schema guarantees
    // permission_relay.allowed_user_ids has ≥1 entry, but if a future
    // refactor relaxes that we still want a clean fallback.
    log.warn('ask_user_question/request no chatId available — pass_through')
    reply(res, 200, { status: 'pass_through' })
    return
  }

  // Clamp the per-call timeout against the configured maximum so a
  // misbehaving hook wrapper can't pin a socket for hours. The hook
  // wrapper's `ASK_USER_QUESTION_TIMEOUT_MS` env var already enforces
  // a low default on its side; this is the server-side authority.
  const configMaxTimeoutMs = config.ask_user_question.timeout_ms
  const requestedTimeoutMs = payload.timeout_ms ?? configMaxTimeoutMs
  const effectiveTimeoutMs = Math.min(requestedTimeoutMs, configMaxTimeoutMs)

  // Generously raise the socket-level inactivity timeout to match the
  // logical wait. `setTimeout(0)` disables Node's default 0 ms request
  // timeout AND silences the per-socket idle timeout, but we want a
  // bounded window — set it to the relay timeout plus a 30 s margin so
  // a runaway promise still releases the socket eventually.
  try {
    req.setTimeout(effectiveTimeoutMs + ASK_SOCKET_TIMEOUT_MARGIN_MS)
    res.setTimeout(effectiveTimeoutMs + ASK_SOCKET_TIMEOUT_MARGIN_MS)
  } catch {
    /* very old runtimes — best effort */
  }

  // Submit to the relay. The relay returns a Promise that resolves on
  // answered / timeout / pass_through / unauthorized / idempotent.
  //
  // F2: pass the FULL question shape through (question, header,
  // multiSelect, options[{label, description, preview}]) so the TG
  // renderer in `src/telegram/ask-user-question.ts` can read header
  // and per-option `preview` via `relay.getPending(requestId)`.
  // Previously this site stripped header + preview, which silently
  // dropped warchief-facing context (Codex webhook #2).
  //
  // The relay's `AskQuestion` type is the canonical narrow shape
  // (`question`, optional `multiSelect`, `options[{label, description}]`).
  // Coordination with FIX-T3 is to widen it to include `header?` and
  // `options[].preview?`. Until that widening lands the relay stores
  // whatever we pass — JavaScript runtime ignores TS-level field
  // assertions — so we cast at the boundary AND keep all fields. The
  // cast is the only place the boundary widens, so when FIX-T3 lands
  // its widened type, the cast becomes a no-op.
  type RelaySubmitQuestion = Parameters<AskUserQuestionRelay['submit']>[0]['questions'][number]
  const submitQuestions = payload.questions.map((q) => {
    const options = q.options.map((o) => ({
      label: o.label,
      description: o.description,
      // preview is optional on the wire; only forward when present so
      // the relay's pending record doesn't carry a literal `undefined`
      // through to `getPending()` consumers under
      // exactOptionalPropertyTypes.
      ...(o.preview !== undefined ? { preview: o.preview } : {}),
    }))
    return {
      question: q.question,
      header: q.header,
      multiSelect: q.multiSelect,
      options,
    } as unknown as RelaySubmitQuestion
  })

  // F3: consume FIX-T3's new submit() contract that returns
  // `{ requestId, result }` synchronously, so we no longer race against
  // `listPendingIds()` to discover the id we just minted (Codex webhook
  // #3). The new contract removes the race window entirely.
  //
  // Adapter: detect the shape at runtime. When FIX-T3 has shipped the
  // new contract `submit()` returns an object with both fields; when it
  // hasn't yet, `submit()` still returns a Promise<AskUserQuestionResult>
  // and we fall back to the (racy) discovery path with an audit-only
  // warn. This lets the two scopes ship independently without one of us
  // blocking the other; once FIX-T3 lands the fallback branch becomes
  // unreachable and can be deleted.
  let pendingResult: Promise<AskUserQuestionResult>
  let requestId: string | undefined
  try {
    const submitInput = {
      sessionId: payload.session_id,
      toolUseId: payload.tool_use_id,
      questions: submitQuestions,
      chatId,
      timeoutMs: effectiveTimeoutMs,
    }
    const submitOutput = (askRelay.submit as (input: typeof submitInput) => unknown)(submitInput)
    if (
      submitOutput !== null
      && typeof submitOutput === 'object'
      && 'requestId' in submitOutput
      && 'result' in submitOutput
    ) {
      const typed = submitOutput as { requestId: string; result: Promise<AskUserQuestionResult> }
      requestId = typed.requestId
      pendingResult = typed.result
    } else {
      // OLD contract — fallback. Discover requestId by scanning pending
      // ids for a record with our toolUseId. Race window: another submit
      // with the same toolUseId in flight could collide; toolUseIds are
      // UUID-shaped per CC, so collision is effectively zero in practice.
      pendingResult = submitOutput as Promise<AskUserQuestionResult>
      requestId = askRelay.listPendingIds().find((id) => {
        const pending = askRelay.getPending(id)
        return pending?.toolUseId === payload.tool_use_id
      })
      // TODO(FIX-T3 cleanup): remove this branch once relay.submit()
      // returns `{ requestId, result }` unconditionally.
    }
  } catch (err) {
    log.error('ask_user_question/request submit threw', {
      tool_use_id: payload.tool_use_id,
      session_id: payload.session_id,
      error: err instanceof Error ? err.message : String(err),
    })
    reply(res, 500, { error: 'submit failed' })
    return
  }

  if (requestId === undefined) {
    // Relay resolved synchronously (zero questions, no-chat fast path,
    // or an idempotent replay). Skip the TG keyboard step and let the
    // Promise resolve below — pendingResult already has the verdict.
    log.debug('ask_user_question/request no pending requestId — sync resolution', {
      tool_use_id: payload.tool_use_id,
    })
  } else {
    writeAskAuditEvent(statePaths, log, {
      event: 'request_created',
      request_id: requestId,
      tool_use_id: payload.tool_use_id,
      session_id: payload.session_id,
      chat_id: chatId,
      question_count: payload.questions.length,
      timeout_ms: effectiveTimeoutMs,
    })

    // F4: fire `startQuestion` into the background with a deadline-bound
    // failure log. The route does NOT block on the send completing
    // (previous behaviour pinned the request socket until TG ACKed).
    // Reasoning: the relay's own 5min timer is the authoritative
    // timeout, so waiting for the TG send before proceeding to await
    // the relay only ADDS latency — if TG is slow but eventually
    // succeeds the warchief still sees the prompt and the answer flow
    // works. If TG never succeeds the relay's timeout fires cleanly.
    //
    // We still wire a 10s deadline so a stalled send produces a single
    // visible warn line per request (instead of being silently lost).
    // The send itself runs to completion regardless of the deadline.
    const sendStartedAt = Date.now()
    const sendPromise = (async () => {
      await Promise.resolve(askUi.startQuestion(requestId!))
    })()
    // Best-effort observation — never throws, never blocks the route.
    void Promise.race([
      sendPromise.then(
        () => 'ok' as const,
        (err: unknown) => ({ kind: 'error' as const, err }),
      ),
      new Promise<{ kind: 'deadline' }>((resolve) => {
        const t = setTimeout(
          () => resolve({ kind: 'deadline' }),
          START_QUESTION_DEADLINE_MS,
        )
        const unref = (t as unknown as { unref?: () => void }).unref
        if (typeof unref === 'function') unref.call(t)
      }),
    ]).then((outcome) => {
      if (outcome === 'ok') return
      const elapsed = Date.now() - sendStartedAt
      if (typeof outcome === 'object' && outcome.kind === 'deadline') {
        log.warn('ask_user_question ui.startQuestion deadline exceeded', {
          request_id: requestId,
          deadline_ms: START_QUESTION_DEADLINE_MS,
          elapsed_ms: elapsed,
        })
      } else if (typeof outcome === 'object' && outcome.kind === 'error') {
        log.warn('ask_user_question ui.startQuestion failed (continuing)', {
          request_id: requestId,
          error: outcome.err instanceof Error ? outcome.err.message : String(outcome.err),
          elapsed_ms: elapsed,
        })
      }
    })
  }

  // Long-wait. The relay enforces its own setTimeout; we just await.
  const startedAt = Date.now()
  let result: AskUserQuestionResult
  try {
    result = await pendingResult
  } catch (err) {
    log.error('ask_user_question relay rejected', {
      request_id: requestId,
      tool_use_id: payload.tool_use_id,
      error: err instanceof Error ? err.message : String(err),
    })
    reply(res, 500, { error: 'relay error' })
    return
  }
  const latencyMs = Date.now() - startedAt

  // Audit on terminal status. `idempotent` is treated as `answered` to
  // the hook wrapper (transparent retry) but distinguished in the audit
  // so an operator grepping the JSONL sees the duplicate.
  switch (result.status) {
    case 'answered':
      writeAskAuditEvent(statePaths, log, {
        event: 'request_answered',
        request_id: result.requestId ?? requestId,
        tool_use_id: payload.tool_use_id,
        total_latency_ms: latencyMs,
        answers_count: Object.keys(result.updatedInput?.answers ?? {}).length,
      })
      reply(res, 200, { status: 'answered', updatedInput: result.updatedInput })
      return
    case 'idempotent':
      writeAskAuditEvent(statePaths, log, {
        event: 'request_duplicate',
        request_id: result.requestId ?? requestId,
        tool_use_id: payload.tool_use_id,
        source: 'submit_replay',
      })
      // Transparent to the hook wrapper: same shape as `answered`.
      reply(res, 200, { status: 'answered', updatedInput: result.updatedInput })
      return
    case 'timeout':
      writeAskAuditEvent(statePaths, log, {
        event: 'request_timeout',
        request_id: result.requestId ?? requestId,
        tool_use_id: payload.tool_use_id,
        age_ms: latencyMs,
      })
      reply(res, 200, {
        status: 'timeout',
        reason: result.reason ?? `no response in ${effectiveTimeoutMs}ms`,
      })
      return
    case 'unauthorized':
      reply(res, 200, { status: 'unauthorized' })
      return
    case 'pass_through':
      reply(res, 200, { status: 'pass_through' })
      return
    default: {
      // Future-proof: an unknown status from a newer relay version
      // shouldn't crash us. Surface as pass_through so the hook
      // falls back rather than denying.
      log.warn('ask_user_question unknown relay status', {
        status: (result as { status: string }).status,
      })
      reply(res, 200, { status: 'pass_through' })
      return
    }
  }
}

export async function handleAskAnswer(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookDeps,
  webhookToken: string | undefined,
): Promise<void> {
  const { config, statePaths, log, askRelay } = deps

  if (!authGate(req, res, webhookToken)) return

  // Feature gate same as /request — operator off-switch.
  if (config.ask_user_question.enabled !== true) {
    reply(res, 200, { status: 'pass_through' })
    return
  }

  if (!askRelay) {
    reply(res, 503, { error: 'ask_user_question relay not wired' })
    return
  }

  const parsed = await readJsonBody(
    req,
    res,
    log,
    ASK_BODY_LIMIT_BYTES,
    AskUserQuestionAnswerSchema,
    'ask_user_question/answer',
  )
  if (!parsed.ok) return
  // Cast: readJsonBody's generic T infers from the schema's INPUT shape
  // (Zod's z.ZodType<T> generic binds both input + output to T). The
  // schema's `chat_id` accepts `number | string` on the wire and
  // transforms to `string` — the runtime guarantee is enforced by
  // Zod, but TS sees the input union. Cast back to the output type
  // we documented in `AskUserQuestionAnswer`.
  const payload = parsed.value as AskUserQuestionAnswer

  // Defensive double-check on the short id format even though the
  // schema already validated — the helper is the canonical guard in
  // every other call site (permissions.ts, etc.).
  if (!isShortId(payload.request_id)) {
    reply(res, 400, { error: 'invalid request_id format' })
    return
  }

  // Pending check first — answers for already-settled requests return
  // a clean `expired` status (NOT 404, which the hook wrapper would
  // mis-classify as a transport error).
  const pending = askRelay.getPending(payload.request_id)
  if (!pending) {
    reply(res, 200, { status: 'expired' })
    return
  }

  // F6: chat-id binding. The /answer schema accepts an optional
  // `chat_id` field. When the caller supplies one, it MUST match the
  // pending request's `chatId` — otherwise an allowed user who knows
  // (or guesses) the 5-letter short id of ANOTHER chat's pending
  // question could answer it. We audit the attempted mismatch so an
  // operator can detect cross-chat probing. When `chat_id` is absent
  // (legacy callers / DM-only deployments) we skip the check and fall
  // through to the user_id allowlist below.
  if (payload.chat_id !== undefined) {
    const pendingChatId = pending.chatId === undefined ? undefined : String(pending.chatId)
    if (pendingChatId !== payload.chat_id) {
      writeAskAuditEvent(statePaths, log, {
        event: 'request_unauthorized',
        request_id: payload.request_id,
        user_id_attempted: payload.user_id,
        chat_id_attempted: payload.chat_id,
        chat_id_expected: pendingChatId,
        reason: 'chat_id mismatch',
      })
      reply(res, 200, { status: 'unauthorized' })
      return
    }
  }

  // Authorise the answerer. Inherits from permission_relay when the
  // dedicated allowlist isn't set — see resolveAskUserQuestionAllowedUserIds.
  const allowedUserIds = resolveAskUserQuestionAllowedUserIds(config)
  const isAuthorized = allowedUserIds.some((id) => id === payload.user_id)
  if (!isAuthorized) {
    writeAskAuditEvent(statePaths, log, {
      event: 'request_unauthorized',
      request_id: payload.request_id,
      user_id_attempted: payload.user_id,
      reason: 'user_id not in allowlist',
    })
    reply(res, 200, { status: 'unauthorized' })
    return
  }

  // Dispatch by action. Each branch validates the fields it needs and
  // returns 400 on missing inputs rather than silently no-oping inside
  // the relay (the relay's own internal `ensureCurrent` is debug-logged
  // only — we want the caller to see schema violations).
  //
  // F5: response carries a discriminated status enum
  // {accepted | stale | expired | invalid | unauthorized}. When FIX-T3
  // teaches the relay methods to return `{ status }` we propagate that
  // value verbatim. Until then we derive it locally:
  //   - if the relay method threw -> 500 'dispatch failed' (transport)
  //   - if the request was pending before the call AND is no longer
  //     pending after -> 'accepted' (settled)
  //   - if still pending after -> 'accepted' (multi-question or
  //     multi-select toggle, progresses through more inbound calls)
  //   - if was not pending after parse-time `pending` check still
  //     true but the relay refused (e.g. stale questionIndex, the
  //     relay drops with debug log only) -> 'stale'
  // The discriminator surface here matches the hook wrapper's
  // taxonomy so the caller can branch on a single field.
  type AnswerDispatchStatus =
    | { kind: 'accepted' }
    | { kind: 'stale' }
    | { kind: 'invalid'; error: string }

  const dispatch = (): AnswerDispatchStatus => {
    switch (payload.action) {
      case 'choose': {
        const qIdx = payload.question_index ?? 0
        const optIdx = payload.selected_option_index
        if (optIdx === undefined) {
          return { kind: 'invalid', error: 'selected_option_index required for action=choose' }
        }
        // Stale gate: the relay's ensureCurrent() silently drops a
        // callback whose questionIndex doesn't match currentIndex,
        // logging only at debug. Surface that to the caller as
        // `stale` so a late double-tap from an old keyboard is
        // distinguishable from `accepted`.
        if (qIdx !== pending.currentIndex) return { kind: 'stale' }
        askRelay.answerChoice(payload.request_id, qIdx, optIdx)
        return { kind: 'accepted' }
      }
      case 'toggle': {
        const qIdx = payload.question_index
        const optIdx = payload.selected_option_index
        if (qIdx === undefined || optIdx === undefined) {
          return { kind: 'invalid', error: 'question_index and selected_option_index required for action=toggle' }
        }
        if (qIdx !== pending.currentIndex) return { kind: 'stale' }
        askRelay.toggle(payload.request_id, qIdx, optIdx)
        return { kind: 'accepted' }
      }
      case 'done': {
        const qIdx = payload.question_index
        if (qIdx === undefined) {
          return { kind: 'invalid', error: 'question_index required for action=done' }
        }
        if (qIdx !== pending.currentIndex) return { kind: 'stale' }
        askRelay.done(payload.request_id, qIdx)
        return { kind: 'accepted' }
      }
      case 'other': {
        const qIdx = payload.question_index ?? 0
        const label = payload.selected_label
        if (!label || label.length === 0) {
          return { kind: 'invalid', error: 'selected_label required for action=other' }
        }
        if (qIdx !== pending.currentIndex) return { kind: 'stale' }
        askRelay.answerOther(payload.request_id, qIdx, label)
        return { kind: 'accepted' }
      }
    }
  }

  let outcome: AnswerDispatchStatus
  try {
    outcome = dispatch()
  } catch (err) {
    log.error('ask_user_question/answer relay dispatch threw', {
      request_id: payload.request_id,
      action: payload.action,
      error: err instanceof Error ? err.message : String(err),
    })
    reply(res, 500, { error: 'dispatch failed' })
    return
  }

  switch (outcome.kind) {
    case 'invalid':
      reply(res, 400, { error: outcome.error })
      return
    case 'stale':
      // The relay refused (stale questionIndex). We surface this as
      // `stale` so the caller can distinguish a late double-tap from a
      // genuine `expired` (already-settled) or `accepted` outcome.
      reply(res, 200, { status: 'stale' })
      return
    case 'accepted':
      reply(res, 200, { status: 'accepted' })
      return
  }
}
