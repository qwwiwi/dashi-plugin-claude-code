// Permission-gate relay — in-plugin pending-request state machine for the
// interactive bypassPermissions session.
//
// Counterpart to the AskUserQuestion relay (channel/ask-user-question.ts) but
// for the binary Allow/Deny permission confirm. Sits between the PreToolUse
// hook (scripts/permission-gate-hook.ts) and the Telegram keyboard UX
// (telegram/permission-gate-ui.ts):
//
//   hook POST /hooks/permission/request → relay.submit() → Promise
//     → UI sends Allow/Deny keyboard → warchief taps → callback → relay.answer()
//     → Promise resolves {status:'allow'|'deny'} → webhook responds → hook emits
//       the matching PreToolUse decision.
//
// NOT the headless MCP permission path (channel/permissions.ts, the
// `notifications/claude/channel/permission_request` flow used by
// `--permission-prompt-tool` in `-p` mode). That path never fires in an
// interactive bypassPermissions session, which is exactly why this exists.
//
// Strict scope: PURE LOGIC. No Telegram send, no HTTP, no audit jsonl — those
// live in the UI / webhook layers. We expose `telegramMessageId` + `chatId`
// for the UI to stash render state.
//
// Fail-closed posture: the relay only ever resolves to allow on an explicit
// warchief tap. Timeout, expire, and any non-allow transition resolve to deny
// (the hook maps `timeout` → deny too, but we keep the status distinct for
// audit). One Promise per submit(); first transition wins.

import { generateUniqueShortId } from './short-id.js'
import type { Logger } from '../log.js'

export type PermissionGateStatus = 'allow' | 'deny' | 'timeout' | 'pass_through' | 'idempotent'

export interface PermissionGateResult {
  status: PermissionGateStatus
  requestId?: string
  toolUseId?: string
  reason?: string
}

export interface PermissionGateSubmitInput {
  toolUseId: string
  sessionId: string
  toolName: string
  /** Short, redaction-safe preview of the command / path being confirmed. */
  preview: string
  /** Why the classifier routed this to confirm. */
  reason: string
  /** Chat that receives the keyboard. Absent → pass_through (no chat). */
  chatId?: string
  /** Hard override; otherwise deps.defaultTimeoutMs. */
  timeoutMs?: number
}

export interface PendingPermissionGate {
  requestId: string
  toolUseId: string
  sessionId: string
  toolName: string
  preview: string
  reason: string
  createdAt: number
  expiresAt: number
  chatId?: string
  telegramMessageId?: number
  _settled: boolean
  _timer: ReturnType<typeof setTimeout> | null
  _resolve: (result: PermissionGateResult) => void
}

export interface PermissionGateSubmitted {
  /** Undefined when submit() resolved synchronously (pass_through / replay). */
  requestId: string | undefined
  result: Promise<PermissionGateResult>
}

export interface PermissionGateRelayDeps {
  log: Logger
  now?: () => number
  defaultTimeoutMs?: number
  completedTtlMs?: number
}

export interface PermissionGateRelay {
  submit(input: PermissionGateSubmitInput): PermissionGateSubmitted
  /** Resolve a pending request with the warchief's tap. First tap wins;
   *  a later tap on the same request returns idempotent (no-op). */
  answer(requestId: string, behavior: 'allow' | 'deny'): PermissionGateStatus
  /** External give-up → resolves deny with reason. */
  expire(requestId: string, reason?: string): void
  isPending(requestId: string): boolean
  getPending(requestId: string): Readonly<PendingPermissionGate> | undefined
  setTelegramMessageId(requestId: string, messageId: number): void
  pendingCount(): number
  listPendingIds(): string[]
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_COMPLETED_TTL_MS = 60_000

export function createPermissionGateRelay(deps: PermissionGateRelayDeps): PermissionGateRelay {
  const log = deps.log
  const now = deps.now ?? (() => Date.now())
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const completedTtlMs = deps.completedTtlMs ?? DEFAULT_COMPLETED_TTL_MS

  const pending = new Map<string, PendingPermissionGate>()
  const toolUseIndex = new Map<string, string>()
  const completedIds = new Map<string, { result: PermissionGateResult; expiresAt: number }>()
  const completedByToolUseId = new Map<string, { result: PermissionGateResult; expiresAt: number }>()
  const liveResultPromise = new Map<string, Promise<PermissionGateResult>>()

  function pruneCompleted(): void {
    const t = now()
    for (const [id, entry] of completedIds) if (entry.expiresAt <= t) completedIds.delete(id)
    for (const [id, entry] of completedByToolUseId) if (entry.expiresAt <= t) completedByToolUseId.delete(id)
  }

  function settle(req: PendingPermissionGate, result: PermissionGateResult): void {
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
      log.error('permission_gate resolve threw', {
        request_id: req.requestId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function submit(input: PermissionGateSubmitInput): PermissionGateSubmitted {
    pruneCompleted()
    // No chat → pass-through (hook treats as deny; there is no UI to fall back
    // to in bypassPermissions, but the status distinguishes "no recipient"
    // from "owner denied" in the audit).
    if (!input.chatId) {
      return {
        requestId: undefined,
        result: Promise.resolve({
          status: 'pass_through',
          toolUseId: input.toolUseId,
          reason: 'no chat available for this session',
        }),
      }
    }

    // toolUseId replay: attach to the live request, or return the cached
    // verdict if it already settled (hook wrapper retried after a hiccup).
    const existingReqId = toolUseIndex.get(input.toolUseId)
    if (existingReqId !== undefined) {
      const live = liveResultPromise.get(existingReqId)
      if (live) {
        log.info('permission_gate replay attaches to live request', {
          tool_use_id: input.toolUseId,
          request_id: existingReqId,
        })
        return { requestId: existingReqId, result: live }
      }
    }
    const cached = completedByToolUseId.get(input.toolUseId)
    if (cached && cached.expiresAt > now()) {
      log.info('permission_gate replay returns cached verdict', {
        tool_use_id: input.toolUseId,
        status: cached.result.status,
      })
      return { requestId: undefined, result: Promise.resolve(cached.result) }
    }

    const requestId = generateUniqueShortId((id) => pending.has(id) || completedIds.has(id))
    const timeoutMs = input.timeoutMs ?? defaultTimeoutMs
    const createdAt = now()

    let resolver!: (r: PermissionGateResult) => void
    const promise = new Promise<PermissionGateResult>((resolve) => {
      resolver = resolve
    })

    const req: PendingPermissionGate = {
      requestId,
      toolUseId: input.toolUseId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      preview: input.preview,
      reason: input.reason,
      createdAt,
      expiresAt: createdAt + timeoutMs,
      chatId: input.chatId,
      _settled: false,
      _timer: null,
      _resolve: resolver,
    }

    req._timer = setTimeout(() => {
      const stillHere = pending.get(requestId)
      if (!stillHere || stillHere._settled) return
      settle(stillHere, {
        status: 'timeout',
        requestId,
        toolUseId: req.toolUseId,
        reason: `permission confirm timed out after ${timeoutMs}ms`,
      })
    }, timeoutMs)
    const timer = req._timer as unknown as { unref?: () => void }
    if (typeof timer.unref === 'function') timer.unref()

    pending.set(requestId, req)
    toolUseIndex.set(input.toolUseId, requestId)
    liveResultPromise.set(requestId, promise)

    log.info('permission_gate submitted', {
      request_id: requestId,
      tool_use_id: input.toolUseId,
      session_id: input.sessionId,
      tool_name: input.toolName,
      chat_id: input.chatId,
      timeout_ms: timeoutMs,
    })

    return { requestId, result: promise }
  }

  function answer(requestId: string, behavior: 'allow' | 'deny'): PermissionGateStatus {
    pruneCompleted()
    const req = pending.get(requestId)
    if (!req) {
      // Already settled (timeout fired, or a previous tap won) → idempotent.
      return 'idempotent'
    }
    settle(req, {
      status: behavior,
      requestId,
      toolUseId: req.toolUseId,
      reason: behavior === 'allow' ? 'owner allowed via Telegram' : 'owner denied via Telegram',
    })
    return behavior
  }

  function expire(requestId: string, reason?: string): void {
    pruneCompleted()
    const req = pending.get(requestId)
    if (!req) return
    settle(req, {
      status: 'deny',
      requestId,
      toolUseId: req.toolUseId,
      reason: reason ?? 'explicit expire; fail-closed',
    })
  }

  return {
    submit,
    answer,
    expire,
    isPending: (id) => pending.has(id),
    getPending: (id) => pending.get(id),
    setTelegramMessageId: (id, messageId) => {
      const req = pending.get(id)
      if (req) req.telegramMessageId = messageId
    },
    pendingCount: () => pending.size,
    listPendingIds: () => Array.from(pending.keys()),
  }
}
