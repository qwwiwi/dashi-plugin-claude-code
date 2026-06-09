// HTTP webhook listener for /hooks/agent.
//
// Ports the behaviour of gateway.py:3531-3589: bearer-token auth, 256 KB
// body cap, JSON parse with dead-letter on failure, chatId allowlist check,
// optional agentId match, then forward as a channel notification with
// meta.source="webhook" so downstream Claude Code sees a webhook-originated
// message.
//
// Disabled by default (config.webhook.enabled=false). When enabled, the
// host MUST be 127.0.0.1 unless TELEGRAM_WEBHOOK_TOKEN is configured —
// non-loopback hosts without a token are refused so we never expose an
// unauthenticated injection endpoint on the network.

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'http'
import { timingSafeEqual } from 'crypto'
import { appendFileSync, mkdirSync } from 'fs'
import type { AddressInfo } from 'net'
import { dirname } from 'path'
import { z } from 'zod'

import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import type { AppConfig, StatePaths } from '../config.js'
import { redactToken, resolveAskUserQuestionAllowedUserIds } from '../config.js'
import type { Logger } from '../log.js'
import { writeDeadLetter } from '../state/store.js'
import {
  AskUserQuestionAnswerSchema,
  AskUserQuestionRequestSchema,
  FallbackReplyRouteRequestSchema,
  PermissionRequestRouteSchema,
  ReactRouteRequestSchema,
  WebhookPayloadSchema,
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
  type PermissionRequestRoute,
  type WebhookPayload,
} from '../schemas.js'
import { resolvePermissionGateAllowedUserIds } from '../config.js'
import type { PermissionGateRelay } from '../channel/permission-gate-relay.js'
import { sendChannelNotification, normalizeMeta } from '../channel/notify.js'
import { toActivityEvent, toTodoWriteEvent } from '../hooks/claude-events.js'
import type {
  AskUserQuestionRelay,
  AskUserQuestionResult,
} from '../channel/ask-user-question.js'
import { isShortId } from '../channel/short-id.js'
import type { MemoryWriter } from '../memory/writer.js'
import type { ProgressReporter } from '../status/progress-reporter.js'
import type { TaskMirror } from '../status/task-mirror.js'
import type { InboundWatcher } from '../telegram/watcher.js'

const BODY_LIMIT_BYTES = 256 * 1024
// Per-route cap for AskUserQuestion bodies. Cheap pre-check: drains
// fewer bytes than the generic limit before paying Zod's parse cost.
// 64 KB is the upper bound the PRX-1 plan reserved for AskUserQuestion;
// 4 questions × 4 options × ~1 KB preview ≈ 16 KB worst case, leaving
// headroom for header/description text + question prose.
const ASK_BODY_LIMIT_BYTES = 64 * 1024
// Read-receipt bodies are tiny ({chat_id, message_id, emoji}); 4 KB is
// generous and keeps the route cheap to abuse-proof.
const REACT_BODY_LIMIT_BYTES = 4 * 1024
// Fallback-reply bodies carry one text up to Telegram's 4096-char cap plus a
// short chat_id. FIX 5 (2026-06-03): 4096 chars × up to 4 UTF-8 bytes + JSON
// overhead can exceed 16 KB, which would 413 BEFORE the schema validates the
// 4096-char text. 32 KB covers the worst-case multibyte body with headroom
// while still cheap to abuse-proof.
const FALLBACK_REPLY_BODY_LIMIT_BYTES = 32 * 1024
// Permission-request bodies carry tool_name + a bounded preview/reason
// (4096 + 1024 chars). 32 KB covers the worst-case multibyte body with
// headroom while staying cheap to abuse-proof.
const PERMISSION_REQUEST_BODY_LIMIT_BYTES = 32 * 1024
// Margin added on top of the relay's logical timeout for the socket-level
// request timeout, mirroring ASK_SOCKET_TIMEOUT_MARGIN_MS — the relay's clean
// timeout verdict must win over a socket abort.
const PERMISSION_SOCKET_TIMEOUT_MARGIN_MS = 15_000
const DEFAULT_AGENT_ID = 'dashi-channel'

// Margin added on top of the configured AskUserQuestion timeout to set
// the underlying socket-level request timeout. The plugin must observe
// the soft (logical) timeout from the relay BEFORE the framework cuts
// the socket, otherwise the hook wrapper sees a connection drop instead
// of the clean `{ status: 'timeout' }` JSON it expects.
const ASK_SOCKET_TIMEOUT_MARGIN_MS = 30_000

// F4: how long we await `askUi.startQuestion` before giving up and
// letting the relay's own timeout drive the verdict. Telegram's API
// usually responds in <1s; 10s is a generous ceiling that still leaves
// 4.5 min of the default 5min relay window for the user to actually
// answer. We do NOT cancel the underlying send — the warchief still
// gets the prompt if TG recovers within the relay's longer window.
const START_QUESTION_DEADLINE_MS = 10_000

// Loopback hosts that count as «caller is on this machine». Mirrors the
// L5 guard in startWebhookServer — `localhost` is intentionally NOT in
// this list because /etc/hosts can redirect it elsewhere.
function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false
  // Node's req.socket.remoteAddress reports IPv6-mapped v4 as `::ffff:127.0.0.1`.
  if (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') return true
  if (addr.startsWith('127.')) return true
  return false
}

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

// Structural surface for the hook branch. Avoids importing the full
// StatusManager type so test stubs can pass a minimal object. The webhook
// server only needs to push events into the manager — no read APIs.
export interface StatusManagerForWebhook {
  recordActivityByChatId(
    chatId: string,
    event: ReturnType<typeof toActivityEvent>,
  ): Promise<void>
}

// Structural surface for the AskUserQuestion Telegram UI handler (TASK-2).
// We accept any object exposing `startQuestion(requestId)` so the webhook
// layer is decoupled from the concrete implementation in
// src/telegram/ask-user-question.ts (which TASK-2 owns). The function is
// async because TG sendMessage is async; we await it before resolving so
// the warchief sees the keyboard before the relay times out.
export interface AskUserQuestionUi {
  startQuestion(requestId: string): Promise<void> | void
}

export interface WebhookDeps {
  mcpServer: McpServer
  config: AppConfig
  statePaths: StatePaths
  log: Logger
  // Optional — if absent, hook-event payloads are accepted but no Telegram
  // status update happens. The 200 path stays open so Claude hooks never
  // back-pressure on visibility outages.
  statusManager?: StatusManagerForWebhook
  // Phase 8: optional memory writer. Receives a sibling dispatch of every
  // hook payload (UserPromptSubmit buffers, Stop writes recent.md +
  // verbose.jsonl). Throws are caught and logged — never block the 200.
  memoryWriter?: MemoryWriter
  // ProgressReporter (2026-05-18): persistent activity thread sibling
  // dispatch alongside statusManager. Optional so legacy paths and tests
  // can omit it. Failures inside the reporter never propagate (it logs
  // and swallows) so no error handling is required at the call site.
  progressReporter?: ProgressReporter
  // TaskMirror (PR-A2, 2026-05-20): third sibling that owns a rolling
  // TodoWrite milestone message per chat. Optional — when absent, the
  // dispatch block below is skipped. Errors inside `recordEvent` are
  // logged and swallowed; we still defensively wrap in try/catch here
  // to match the statusManager / progressReporter pattern.
  taskMirror?: TaskMirror
  // PR-A3 (M3 fix): InboundWatcher — on session_stop the webhook clears
  // the per-chat debounce marker so a fresh session can auto-reply on its
  // very first inbound message without waiting for the previous session's
  // debounce window to expire. Optional so tests/legacy paths can omit.
  watcher?: InboundWatcher
  // PRX-1 TASK-3 (2026-05-27): AskUserQuestion HTTP relay routes. Both
  // must be present for /hooks/ask-user-question/* to handle requests;
  // when either is undefined the routes still exist but respond with
  // 503 so the hook wrapper falls back to native CC UI. (We chose 503
  // rather than 404 so an operator triaging a stuck session can tell
  // "wired but disabled" from "wrong route".)
  askRelay?: AskUserQuestionRelay
  askUi?: AskUserQuestionUi
  // fix/eyes-on-read (2026-05-28): read-receipt route. The Stop hook posts
  // {chat_id, message_id} here once it has confirmed the agent actually read
  // an inbound message in a turn (parsed from the session transcript). We set
  // the 👀 reaction at THAT point — not when the bot first received the update
  // — so the reaction deterministically means "Thrall read it through the
  // plugin". Optional so tests/legacy paths can omit; when absent the route
  // answers 503 and the hook degrades to a no-op (no read receipt, no crash).
  reactToMessage?: (chatId: string, messageId: number, emoji: string) => Promise<void>
  // 2026-06-03: DM fallback-reply capability. The warchief's DM session
  // normally answers through the `mcp__dashi-channel__reply` MCP tool. When a
  // turn ends WITHOUT having sent such a reply, the fallback-reply Stop hook
  // posts the turn's final assistant text to POST /hooks/fallback-reply and we
  // send it via this capability — a fire-and-forget plain-text Telegram
  // message so the warchief still sees the answer. Wired through the same
  // safe-wrapped, rate-limited telegramApi as every other outbound send.
  // Optional so tests/legacy paths can omit; when absent the route answers 503
  // and the hook degrades to a no-op (no fallback, no crash).
  sendMessage?: (chatId: string, text: string) => Promise<void>
  // Permission gate (2026-06-09): the interactive confirm relay + its
  // Telegram Allow/Deny UI. POST /hooks/permission/request submits to the
  // relay, sends the keyboard via permissionUi.sendPrompt, and long-waits for
  // the verdict. Both must be present for the route to handle requests; when
  // either is undefined (or the feature is disabled in config) the route
  // answers 503 / pass_through and the hook fails closed to deny.
  permissionRelay?: PermissionGateRelay
  permissionUi?: {
    sendPrompt(requestId: string): Promise<void>
    clearKeyboard?(chatId: string, messageId: number, note: string): Promise<void>
  }
}

export interface WebhookServerHandle {
  readonly port: number
  readonly host: string
  close(): Promise<void>
}

// ─────────────────────────────────────────────────────────────────────
// Payload validation. Wraps the Zod schema and rethrows with a
// token-redacted Error so we never leak the bot token in a Zod issue.
// ─────────────────────────────────────────────────────────────────────

export function validateWebhookPayload(value: unknown): WebhookPayload {
  try {
    return WebhookPayloadSchema.parse(value)
  } catch (err) {
    if (err instanceof z.ZodError) {
      // Cap the issue summary so a deeply-nested or discriminated-union
      // failure can't return a kilobyte-long error to the caller / dead
      // letter (review L2). 512 chars is plenty to identify which field
      // failed without amplifying payload-shaped attacks.
      const summary = err.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')
        .slice(0, 512)
      throw new Error(redactToken(`invalid webhook payload: ${summary}`))
    }
    throw new Error(redactToken(`invalid webhook payload: ${err instanceof Error ? err.message : String(err)}`))
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function reply(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) {
    try { res.end() } catch { /* ignore */ }
    return
  }
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function bearerEquals(received: string, expected: string): boolean {
  // Pad both sides to a single fixed length BEFORE the comparison so we run
  // the exact same timingSafeEqual call regardless of input lengths — no
  // length-conditional code path that could leak a length bit (review M4).
  // Final result combines the constant-time byte-compare with an explicit
  // length-equality bit, so mismatched lengths still return false.
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  const max = Math.max(a.length, b.length, 32)
  const padA = Buffer.alloc(max)
  const padB = Buffer.alloc(max)
  a.copy(padA)
  b.copy(padB)
  const bytesEqual = timingSafeEqual(padA, padB)
  return bytesEqual && a.length === b.length
}

// Drain request body up to BODY_LIMIT_BYTES + 1. We return early as soon
// as the cap is exceeded so a hostile sender can't burn memory on us.
function readBody(req: IncomingMessage): Promise<{ tooLarge: boolean; buf: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let length = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      length += chunk.length
      if (length > BODY_LIMIT_BYTES) {
        tooLarge = true
        // Stop accumulating; destroy the stream to free socket buffers.
        try { req.destroy() } catch { /* ignore */ }
        resolve({ tooLarge: true, buf: Buffer.alloc(0) })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return
      resolve({ tooLarge: false, buf: Buffer.concat(chunks) })
    })
    req.on('error', (err) => {
      if (tooLarge) return
      reject(err)
    })
  })
}

function chatIdAllowed(config: AppConfig, chatId: string): boolean {
  for (const entry of config.allowed_chat_ids) {
    if (String(entry) === chatId) return true
  }
  return false
}

// Build a "safe" public view of config for /health. No tokens, no env.
function healthBody(config: AppConfig): Record<string, unknown> {
  return {
    status: 'ok',
    bot_id: config.bot_id,
    allowed_chat_ids: config.allowed_chat_ids.map((v) => String(v)),
  }
}

// ─────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookDeps,
  webhookToken: string | undefined,
): Promise<void> {
  const {
    config,
    statePaths,
    log,
    mcpServer,
    statusManager,
    memoryWriter,
    progressReporter,
    taskMirror,
    watcher,
  } = deps
  const method = req.method ?? 'GET'
  const url = req.url ?? '/'

  // Strip query string for routing.
  const path = url.split('?', 1)[0] ?? '/'

  if (method === 'GET' && path === '/health') {
    reply(res, 200, healthBody(config))
    return
  }

  // PRX-1 TASK-3 (2026-05-27): AskUserQuestion HTTP relay routes. Wired
  // BEFORE /hooks/agent so the more-specific paths take priority. Both
  // routes require loopback origin + bearer auth + the route handler
  // owns its own body-read / Zod-validate flow (different payload shape
  // than the /hooks/agent envelope).
  if (method === 'POST' && path === '/hooks/ask-user-question/request') {
    await handleAskRequest(req, res, deps, webhookToken)
    return
  }
  if (method === 'POST' && path === '/hooks/ask-user-question/answer') {
    await handleAskAnswer(req, res, deps, webhookToken)
    return
  }

  // fix/eyes-on-read (2026-05-28): read-receipt route. Wired before
  // /hooks/agent so the more-specific path takes priority. Loopback +
  // bearer + chat allowlist, then sets 👀 via deps.reactToMessage.
  if (method === 'POST' && path === '/hooks/react') {
    await handleReact(req, res, deps, webhookToken)
    return
  }

  // 2026-06-03 (feature/dm-fallback-reply-hook): DM fallback-reply route.
  // Wired before /hooks/agent so the more-specific path takes priority.
  // Loopback + bearer + chat allowlist, then sends the turn's final assistant
  // text via deps.sendMessage when the DM turn ended without an MCP reply().
  if (method === 'POST' && path === '/hooks/fallback-reply') {
    await handleFallbackReply(req, res, deps, webhookToken)
    return
  }

  // Permission gate (2026-06-09): interactive confirm relay. Wired before
  // /hooks/agent so the more-specific path takes priority. Loopback + bearer,
  // feature gate (config.permission_gate.enabled), then submit + long-wait.
  if (method === 'POST' && path === '/hooks/permission/request') {
    await handlePermissionRequest(req, res, deps, webhookToken)
    return
  }

  if (!(method === 'POST' && path === '/hooks/agent')) {
    reply(res, 404, { error: 'not found' })
    return
  }

  // Auth — require a configured token. Empty/undefined token = hard reject
  // (matches gateway.py:3535-3537: empty configured token returns 503).
  if (!webhookToken) {
    reply(res, 503, { error: 'webhook auth not configured' })
    return
  }
  const authHeader = (req.headers['authorization'] ?? '').toString()
  const expected = `Bearer ${webhookToken}`
  if (!bearerEquals(authHeader, expected)) {
    reply(res, 401, { error: 'unauthorized' })
    return
  }

  // Content-Length quick reject before draining.
  const lenHeader = req.headers['content-length']
  if (lenHeader !== undefined) {
    const declared = Number.parseInt(Array.isArray(lenHeader) ? (lenHeader[0] ?? '0') : lenHeader, 10)
    if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) {
      reply(res, 413, { error: 'payload too large' })
      return
    }
  }

  let body: Buffer
  try {
    const drained = await readBody(req)
    if (drained.tooLarge) {
      reply(res, 413, { error: 'payload too large' })
      return
    }
    body = drained.buf
  } catch (err) {
    reply(res, 400, { error: 'invalid body' })
    log.warn('webhook body read failed', { error: err instanceof Error ? err.message : String(err) })
    return
  }

  // Parse JSON.
  let parsed: unknown
  try {
    parsed = body.length > 0 ? JSON.parse(body.toString('utf8')) : {}
  } catch (err) {
    writeDeadLetter(statePaths, 'webhook', {
      error: 'invalid json',
      reason: err instanceof Error ? err.message : String(err),
      body_preview: body.slice(0, 1024).toString('utf8'),
    })
    reply(res, 400, { error: 'invalid json' })
    return
  }

  // Validate schema.
  let payload: WebhookPayload
  try {
    payload = validateWebhookPayload(parsed)
  } catch (err) {
    writeDeadLetter(statePaths, 'webhook', {
      error: 'invalid payload',
      reason: err instanceof Error ? err.message : String(err),
      body: parsed,
    })
    reply(res, 400, { error: err instanceof Error ? err.message : 'invalid payload' })
    return
  }

  // chatId allowlist — defence in depth even with a leaked token.
  if (!chatIdAllowed(config, payload.chatId)) {
    log.warn('webhook chatId not in allowlist', { chat_id: payload.chatId })
    reply(res, 403, { error: 'chatId not in allowlist' })
    return
  }

  // agentId, optional. If present, must match this plugin's known id.
  if (payload.agentId !== undefined && payload.agentId !== DEFAULT_AGENT_ID) {
    reply(res, 404, { error: `agent '${payload.agentId}' not found` })
    return
  }

  // Branch on payload variant. Discriminator was set by the Zod transform
  // so we don't have to re-sniff fields here.
  if (payload.kind === 'claude_hook') {
    // Phase 8: dispatch to memory writer first, BEFORE the status branch,
    // so memory persistence runs regardless of status.enabled. Errors are
    // logged and swallowed — memory must never back-pressure the 200.
    if (config.memory.enabled && memoryWriter) {
      try {
        await memoryWriter.onHook(payload)
      } catch (err) {
        log.warn('[memory] writer error (ignored)', {
          hook: payload.hook_event_name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Two independent visibility surfaces fire from the same hook event.
    // Both are best-effort: failures are caught and logged, never block
    // the 200 response (Claude hooks must not back-pressure on visibility).
    //
    //   * StatusManager — transient bubble (auto-cancelled by reply()).
    //     Gate: config.status.enabled.
    //   * ProgressReporter — persistent activity thread (survives reply).
    //     Gate: config.progress.enabled (checked inside the reporter).
    //
    // The two MUST be dispatched independently so an operator can turn
    // one off without disabling the other (review C3 fix).
    const activityEvent = toActivityEvent(payload)
    const statusDispatched = config.status.enabled === true && statusManager !== undefined
    if (statusDispatched) {
      try {
        await statusManager!.recordActivityByChatId(payload.chatId, activityEvent)
      } catch (err) {
        log.warn('hook event status update failed (ignored)', {
          chat_id: payload.chatId,
          hook: payload.hook_event_name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    } else {
      log.debug('hook event status dispatch skipped (disabled or no manager)', {
        chat_id: payload.chatId,
        hook: payload.hook_event_name,
      })
    }

    if (progressReporter) {
      try {
        await progressReporter.recordEvent(payload.chatId, activityEvent)
      } catch (err) {
        log.warn('hook event progress update failed (ignored)', {
          chat_id: payload.chatId,
          hook: payload.hook_event_name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // PR-A2 (2026-05-20): TaskMirror handles TodoWrite + Stop hooks. The
    // mapper returns null for every other event, so the cost when no
    // TodoWrite is in flight is one schema test per hook — negligible.
    if (taskMirror) {
      const todoEvent = toTodoWriteEvent(payload, log)
      if (todoEvent !== null) {
        try {
          await taskMirror.recordEvent(payload.chatId, todoEvent)
        } catch (err) {
          log.warn('hook event task mirror update failed (ignored)', {
            chat_id: payload.chatId,
            hook: payload.hook_event_name,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    // PR-A3 (M3 fix): on session_stop, clear the watcher's debounce marker
    // for this chat so the next session can fire its first auto-reply
    // immediately. Without this, a stale marker from the previous session
    // would block the auto-reply for up to debounce_ms.
    if (watcher && payload.hook_event_name === 'Stop') {
      try {
        watcher.clearDebounce(payload.chatId)
      } catch (err) {
        // clearDebounce is a Map.delete() under the hood — should never throw.
        log.warn('watcher clearDebounce failed (ignored)', {
          chat_id: payload.chatId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Preserve the legacy status_disabled note when status is off so
    // existing webhook smoke tests can detect the disabled path.
    if (!statusDispatched && config.status.enabled !== true) {
      reply(res, 200, { status: 'accepted', note: 'status_disabled' })
      return
    }

    reply(res, 200, { status: 'accepted' })
    return
  }

  // Forward message payload to MCP channel (existing behaviour).
  const metaRaw: Record<string, unknown> = {
    source: 'webhook',
    chat_id: payload.chatId,
  }
  if (payload.agentId !== undefined) metaRaw.agent_id = payload.agentId

  const delivered = await sendChannelNotification(
    mcpServer,
    { content: payload.message, meta: normalizeMeta(metaRaw) },
    log,
  )

  if (!delivered) {
    // Transport error already logged inside sendChannelNotification. Surface
    // 503 so the caller can retry; 200 would let the message be lost silently.
    reply(res, 503, { error: 'channel unavailable' })
    return
  }

  reply(res, 200, { status: 'accepted' })
}

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
// ─────────────────────────────────────────────────────────────────────

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

// Boot-time consistency check (F1 follow-up): if an operator set
// `ask_user_question.allowed_user_ids` explicitly AND it does NOT match
// `permission_relay.allowed_user_ids`, log a warning so a drift between
// the two lists is visible at startup rather than only at the first
// failed round-trip. Both lists are allowed to differ (operator may
// want only warchief in permission_relay but a wider audience for
// AskUserQuestion), but the divergence should be intentional.
function logAskUserQuestionAllowlistConsistency(
  config: AppConfig,
  log: Logger,
): void {
  const explicit = config.ask_user_question.allowed_user_ids
  if (explicit === undefined) return // fallback path — by definition consistent
  const permission = config.permission_relay.allowed_user_ids
  const permissionSet = new Set(permission)
  const askSet = new Set(explicit)
  const onlyInAsk = explicit.filter((u) => !permissionSet.has(u))
  const onlyInPermission = permission.filter((u) => !askSet.has(u))
  if (onlyInAsk.length > 0 || onlyInPermission.length > 0) {
    log.warn('ask_user_question allowed_user_ids differs from permission_relay', {
      ask_user_question_only: onlyInAsk,
      permission_relay_only: onlyInPermission,
      ask_user_question_total: explicit.length,
      permission_relay_total: permission.length,
    })
  }
}

async function readJsonBody<T>(
  req: IncomingMessage,
  res: ServerResponse,
  log: Logger,
  cap: number,
  schema: z.ZodType<T>,
  routeLabel: string,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const lenHeader = req.headers['content-length']
  if (lenHeader !== undefined) {
    const declared = Number.parseInt(Array.isArray(lenHeader) ? (lenHeader[0] ?? '0') : lenHeader, 10)
    if (Number.isFinite(declared) && declared > cap) {
      reply(res, 413, { error: 'payload too large' })
      return { ok: false }
    }
  }
  let buf: Buffer
  try {
    const drained = await readBodyWithCap(req, cap)
    if (drained.tooLarge) {
      reply(res, 413, { error: 'payload too large' })
      return { ok: false }
    }
    buf = drained.buf
  } catch (err) {
    reply(res, 400, { error: 'invalid body' })
    log.warn(`${routeLabel} body read failed`, {
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: false }
  }
  let parsed: unknown
  try {
    parsed = buf.length > 0 ? JSON.parse(buf.toString('utf8')) : {}
  } catch (err) {
    reply(res, 400, { error: 'invalid json' })
    log.warn(`${routeLabel} json parse failed`, {
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: false }
  }
  const result = schema.safeParse(parsed)
  if (!result.success) {
    const summary = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')
      .slice(0, 512)
    reply(res, 400, { error: `invalid payload: ${summary}` })
    log.warn(`${routeLabel} schema validation failed`, { summary })
    return { ok: false }
  }
  return { ok: true, value: result.data }
}

// Drain helper used by AskUserQuestion routes — parameterised on cap so
// the same primitive serves both the 64 KB AskUserQuestion budget and
// any future route that needs a tighter limit. The legacy /hooks/agent
// path keeps using `readBody` above (hardcoded 256 KB) to minimise
// churn in already-shipped behaviour.
function readBodyWithCap(req: IncomingMessage, cap: number): Promise<{ tooLarge: boolean; buf: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let length = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      length += chunk.length
      if (length > cap) {
        tooLarge = true
        try { req.destroy() } catch { /* ignore */ }
        resolve({ tooLarge: true, buf: Buffer.alloc(0) })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return
      resolve({ tooLarge: false, buf: Buffer.concat(chunks) })
    })
    req.on('error', (err) => {
      if (tooLarge) return
      reject(err)
    })
  })
}

// Shared auth/origin gate. Returns `false` when the response has
// already been written (route handler short-circuits on false return).
function authGate(
  req: IncomingMessage,
  res: ServerResponse,
  webhookToken: string | undefined,
): boolean {
  // Loopback origin check — even on a 127.0.0.1 bind we re-verify the
  // socket peer so a future change to host config (or a port-forward
  // through an SSH tunnel) doesn't silently expose these routes.
  const remote = req.socket.remoteAddress
  if (!isLoopbackAddress(remote)) {
    reply(res, 403, { error: 'loopback only' })
    return false
  }
  if (!webhookToken) {
    reply(res, 503, { error: 'webhook auth not configured' })
    return false
  }
  const authHeader = (req.headers['authorization'] ?? '').toString()
  const expected = `Bearer ${webhookToken}`
  if (!bearerEquals(authHeader, expected)) {
    reply(res, 401, { error: 'unauthorized' })
    return false
  }
  return true
}

// fix/eyes-on-read (2026-05-28): POST /hooks/react — set the 👀 read
// receipt on an inbound message the agent has actually read in a turn.
// Auth: loopback origin + bearer (same fence as the AskUserQuestion
// routes). Defence in depth: chatId must be in the allowlist, so a leaked
// token still can't make the bot react in an arbitrary chat.
async function handleReact(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookDeps,
  webhookToken: string | undefined,
): Promise<void> {
  const { config, log, reactToMessage } = deps

  if (!authGate(req, res, webhookToken)) return

  // Feature wiring gate: when no reaction capability was injected we answer
  // 503 (not 404) so an operator can tell "wired but disabled" from "wrong
  // route", and the hook degrades to a no-op without retry storms.
  if (!reactToMessage) {
    reply(res, 503, { status: 'reactions_unavailable' })
    return
  }

  const parsed = await readJsonBody(
    req,
    res,
    log,
    REACT_BODY_LIMIT_BYTES,
    ReactRouteRequestSchema,
    'react',
  )
  if (!parsed.ok) return
  const payload = parsed.value
  const emoji = payload.emoji ?? '👀'

  if (!chatIdAllowed(config, payload.chat_id)) {
    log.warn('react chatId not in allowlist', { chat_id: payload.chat_id })
    reply(res, 403, { error: 'chatId not in allowlist' })
    return
  }

  try {
    await reactToMessage(payload.chat_id, payload.message_id, emoji)
  } catch (err) {
    // A failed reaction must never wedge the hook. Telegram returns 400 for
    // reactions on messages too old to react to (and 429 under burst); we
    // log and answer 200 so the hook records the message as handled and
    // moves on rather than retrying forever.
    log.warn('react setMessageReaction failed', {
      chat_id: payload.chat_id,
      message_id: payload.message_id,
      error: err instanceof Error ? redactToken(err.message) : String(err),
    })
    reply(res, 200, { status: 'react_failed' })
    return
  }

  reply(res, 200, { status: 'reacted' })
}

// 2026-06-03 (feature/dm-fallback-reply-hook): POST /hooks/fallback-reply —
// forward the DM turn's final assistant text to the warchief's Telegram when
// the turn ended WITHOUT an MCP reply()/edit_message() call. Auth: loopback
// origin + bearer (same fence as the react route). Defence in depth: chatId
// must be in the allowlist, so a leaked token still can't make the bot post
// into an arbitrary chat. Modeled on handleReact.
async function handleFallbackReply(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookDeps,
  webhookToken: string | undefined,
): Promise<void> {
  const { config, log, sendMessage } = deps

  if (!authGate(req, res, webhookToken)) return

  // Feature wiring gate: when no send capability was injected we answer 503
  // (not 404) so an operator can tell "wired but disabled" from "wrong route",
  // and the hook degrades to a no-op without retry storms.
  if (!sendMessage) {
    reply(res, 503, { status: 'fallback_reply_unavailable' })
    return
  }

  const parsed = await readJsonBody(
    req,
    res,
    log,
    FALLBACK_REPLY_BODY_LIMIT_BYTES,
    FallbackReplyRouteRequestSchema,
    'fallback-reply',
  )
  if (!parsed.ok) return
  const payload = parsed.value

  if (!chatIdAllowed(config, payload.chat_id)) {
    log.warn('fallback-reply chatId not in allowlist', { chat_id: payload.chat_id })
    reply(res, 403, { error: 'chatId not in allowlist' })
    return
  }

  try {
    await sendMessage(payload.chat_id, payload.text)
  } catch (err) {
    // A failed send must never wedge the hook. We log and answer 200 (not 5xx)
    // with an explicit {status:'send_failed'} so the hook can distinguish a
    // real delivery from a failure: it records dedup ONLY on {status:'sent'},
    // so a send that keeps failing is re-attempted on the next Stop fire
    // instead of being silently marked delivered.
    log.warn('fallback-reply sendMessage failed', {
      chat_id: payload.chat_id,
      error: err instanceof Error ? redactToken(err.message) : String(err),
    })
    reply(res, 200, { status: 'send_failed' })
    return
  }

  reply(res, 200, { status: 'sent' })
}

// 2026-06-09: POST /hooks/permission/request — interactive permission confirm.
// The PreToolUse permission-gate hook posts a `confirm`-tier tool call here.
// We submit to the relay, send the Allow/Deny keyboard via permissionUi, and
// long-wait for the verdict, then respond {status: 'allow'|'deny'|'timeout'}.
// Auth: loopback origin + bearer (same fence as the ask routes). The hook is
// fail-closed: any non-200 / non-allow verdict denies the tool, so the unhappy
// paths here all map to a safe deny on the hook side.
async function handlePermissionRequest(
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

async function handleAskRequest(
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

async function handleAskAnswer(
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

// ─────────────────────────────────────────────────────────────────────
// Public entry — start server when enabled.
// ─────────────────────────────────────────────────────────────────────

export async function startWebhookServer(
  config: AppConfig,
  deps: WebhookDeps,
): Promise<WebhookServerHandle | null> {
  if (!config.webhook.enabled) return null

  // F1 follow-up: emit a single warn line at boot if the two allowlists
  // diverge. Skipped silently in the happy path (no log noise).
  logAskUserQuestionAllowlistConsistency(config, deps.log)

  const webhookToken = process.env.TELEGRAM_WEBHOOK_TOKEN
  const host = config.webhook.host
  // L5: only literal loopback IPs count. `localhost` can be redirected to a
  // non-loopback address by /etc/hosts; operators wanting loopback should
  // spell it as 127.0.0.1 or ::1.
  const isLoopback = host === '127.0.0.1' || host === '::1'
  if (!isLoopback && !webhookToken) {
    throw new Error(
      `webhook server refuses to bind ${host}: TELEGRAM_WEBHOOK_TOKEN required for non-loopback host`,
    )
  }

  const server: HttpServer = createServer((req, res) => {
    handleRequest(req, res, deps, webhookToken).catch((err) => {
      deps.log.error('webhook handler crashed', {
        error: err instanceof Error ? err.message : String(err),
      })
      try { reply(res, 500, { error: 'internal error' }) } catch { /* ignore */ }
    })
  })

  // PRX-1 TASK-3 (2026-05-27): widen the server-level inactivity timeout
  // so AskUserQuestion long-waits aren't cut off by Node defaults. Newer
  // Node ships with `requestTimeout = 300_000` (5 min) which exactly
  // matches the relay default and would race the relay's own timeout
  // every time. We bump to `config.ask_user_question.timeout_ms +
  // ASK_SOCKET_TIMEOUT_MARGIN_MS` so the relay's clean `timeout` JSON
  // always wins over a socket-level abort. The per-request setTimeout
  // call inside handleAskRequest is a second layer of defence for
  // runtimes that ignore the server default.
  const askWaitCeilingMs = config.ask_user_question.timeout_ms + ASK_SOCKET_TIMEOUT_MARGIN_MS
  try {
    // requestTimeout = max time to receive the whole request (Node ≥18)
    server.requestTimeout = askWaitCeilingMs
    // headersTimeout must be ≥ requestTimeout for Node not to warn
    server.headersTimeout = askWaitCeilingMs
    // keepAliveTimeout doesn't gate the in-flight response but we widen
    // it so a slow client doesn't lose connection between request and
    // long-wait response.
    server.keepAliveTimeout = askWaitCeilingMs
    server.timeout = askWaitCeilingMs
  } catch {
    /* older Node — silently skip */
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(config.webhook.port, host)
  })

  const addr = server.address() as AddressInfo
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : config.webhook.port
  deps.log.info('webhook server listening', { host, port: boundPort })

  let closing = false
  return {
    port: boundPort,
    host,
    close: () => {
      if (closing) return Promise.resolve()
      closing = true
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
        // Force-close idle keep-alive connections so shutdown isn't blocked.
        try { server.closeAllConnections?.() } catch { /* node < 18.2 */ }
      })
    },
  }
}
