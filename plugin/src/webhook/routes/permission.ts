// POST /hooks/permission/request — interactive permission-gate route.
// Extracted verbatim from server.ts during the route-module split; no
// behaviour change.

import type { IncomingMessage, ServerResponse } from 'http'
import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

import type { StatePaths } from '../../config.js'
import { resolvePermissionGateAllowedUserIds } from '../../config.js'
import type { Logger } from '../../log.js'
import { PermissionRequestRouteSchema, type PermissionRequestRoute } from '../../schemas.js'
import type { WebhookDeps } from '../server.js'
import { authGate, readJsonBody, reply } from './shared.js'

// Permission-request bodies carry tool_name + a bounded preview/reason
// (4096 + 1024 chars). 32 KB covers the worst-case multibyte body with
// headroom while staying cheap to abuse-proof.
const PERMISSION_REQUEST_BODY_LIMIT_BYTES = 32 * 1024
// Margin added on top of the relay's logical timeout for the socket-level
// request timeout, mirroring ASK_SOCKET_TIMEOUT_MARGIN_MS — the relay's clean
// timeout verdict must win over a socket abort.
const PERMISSION_SOCKET_TIMEOUT_MARGIN_MS = 15_000

// Append-only audit JSONL for the permission-gate route. Mirrors
// writeAskAuditEvent; failures are swallowed (audit loss must never block a
// route response). Single writer is handlePermissionRequest.
function writePermissionAuditEvent(
  statePaths: StatePaths,
  log: Logger,
  event: Record<string, unknown>,
): void {
  const auditPath = statePaths.logs.permission_gate
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n'
  try {
    mkdirSync(dirname(auditPath), { recursive: true, mode: 0o700 })
    appendFileSync(auditPath, line, { mode: 0o600 })
  } catch (err) {
    log.warn('permission_gate audit write failed', {
      path: auditPath,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// 2026-06-09: POST /hooks/permission/request — interactive permission confirm.
// The PreToolUse permission-gate hook posts a `confirm`-tier tool call here.
// We submit to the relay, send the Allow/Deny keyboard via permissionUi, and
// long-wait for the verdict, then respond {status: 'allow'|'deny'|'timeout'}.
// Auth: loopback origin + bearer (same fence as the ask routes). The hook is
// fail-closed: any non-200 / non-allow verdict denies the tool, so the unhappy
// paths here all map to a safe deny on the hook side.
export async function handlePermissionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookDeps,
  webhookToken: string | undefined,
): Promise<void> {
  const { config, statePaths, log, permissionRelay, permissionUi } = deps

  if (!authGate(req, res, webhookToken)) return

  // Feature gate: when the gate isn't enabled we tell the hook to fail closed
  // (the hook treats a 503 as deny). We do NOT 200/pass_through here — unlike
  // AskUserQuestion (which falls back to native UI), there is no native UI in
  // bypassPermissions, so "disabled" must mean deny, not allow.
  if (config.permission_gate.enabled !== true) {
    reply(res, 503, { error: 'permission_gate disabled' })
    return
  }
  if (!permissionRelay || !permissionUi) {
    log.warn('permission/request received but relay or ui not wired', {
      has_relay: permissionRelay !== undefined,
      has_ui: permissionUi !== undefined,
    })
    reply(res, 503, { error: 'permission_gate relay not wired' })
    return
  }

  const parsed = await readJsonBody(
    req,
    res,
    log,
    PERMISSION_REQUEST_BODY_LIMIT_BYTES,
    PermissionRequestRouteSchema,
    'permission/request',
  )
  if (!parsed.ok) return
  // Cast: readJsonBody's generic binds to the schema INPUT shape, where
  // `.default()` fields read as optional. The runtime values are guaranteed
  // present (Zod applied the defaults) — cast to the output type.
  const payload = parsed.value as PermissionRequestRoute

  // Recipient = first allowed user id (DM chat == user id in Telegram). Same
  // helper authorizes the answerer in the UI, so prompt destination and
  // answer authz can never drift.
  const allowed = resolvePermissionGateAllowedUserIds(config)
  const chatId = allowed[0] === undefined ? undefined : String(allowed[0])
  if (chatId === undefined) {
    log.warn('permission/request no chatId available — fail-closed deny')
    reply(res, 200, { status: 'deny', reason: 'no permission-gate recipient configured; fail-closed' })
    return
  }

  const configTimeoutMs = config.permission_gate.timeout_ms
  const requestedTimeoutMs = payload.timeout_ms ?? configTimeoutMs
  const effectiveTimeoutMs = Math.min(requestedTimeoutMs, configTimeoutMs)

  try {
    req.setTimeout(effectiveTimeoutMs + PERMISSION_SOCKET_TIMEOUT_MARGIN_MS)
    res.setTimeout(effectiveTimeoutMs + PERMISSION_SOCKET_TIMEOUT_MARGIN_MS)
  } catch {
    /* old runtime — best effort */
  }

  const { requestId, result } = permissionRelay.submit({
    toolUseId: payload.tool_use_id,
    sessionId: payload.session_id,
    toolName: payload.tool_name,
    preview: payload.preview,
    reason: payload.reason,
    chatId,
    timeoutMs: effectiveTimeoutMs,
  })

  // Fresh request → send the keyboard. Replay / sync-resolution → skip
  // (requestId undefined means the relay already has a verdict).
  let sentMessageId: number | undefined
  if (requestId !== undefined) {
    writePermissionAuditEvent(statePaths, log, {
      event: 'request_created',
      request_id: requestId,
      tool_use_id: payload.tool_use_id,
      session_id: payload.session_id,
      tool_name: payload.tool_name,
      chat_id: chatId,
      timeout_ms: effectiveTimeoutMs,
    })
    try {
      await permissionUi.sendPrompt(requestId)
      // Capture the keyboard's message id while the request is still pending so
      // we can strip it on timeout (Codex high: a left-over Allow button could
      // resolve a future id-reusing request).
      sentMessageId = permissionRelay.getPending(requestId)?.telegramMessageId
    } catch (err) {
      // If we can't deliver the keyboard the warchief can never tap → there is
      // no point waiting out the timeout. Fail closed immediately.
      log.warn('permission/request sendPrompt failed — fail-closed deny', {
        request_id: requestId,
        error: err instanceof Error ? err.message : String(err),
      })
      permissionRelay.expire(requestId, 'keyboard delivery failed; fail-closed')
    }
  }

  const verdict = await result
  writePermissionAuditEvent(statePaths, log, {
    event: 'request_resolved',
    request_id: verdict.requestId ?? requestId,
    tool_use_id: payload.tool_use_id,
    status: verdict.status,
  })

  // Map the relay status to the hook's {allow|deny|timeout} contract. Anything
  // that isn't an explicit allow becomes deny on the hook side anyway, but we
  // surface the precise status for the hook's reason string + audit.
  switch (verdict.status) {
    case 'allow':
      reply(res, 200, { status: 'allow' })
      return
    case 'timeout':
      // Strip the stale keyboard so a late tap can't resolve a future request.
      if (sentMessageId !== undefined && permissionUi.clearKeyboard) {
        await permissionUi.clearKeyboard(chatId, sentMessageId, 'Истёк (нет ответа)').catch(() => {})
      }
      reply(res, 200, { status: 'timeout', reason: verdict.reason ?? `no tap in ${effectiveTimeoutMs}ms` })
      return
    case 'deny':
    case 'pass_through':
    case 'idempotent':
    default:
      reply(res, 200, { status: 'deny', reason: verdict.reason ?? 'denied' })
      return
  }
}
