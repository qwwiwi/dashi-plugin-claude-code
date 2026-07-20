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
import type { AddressInfo } from 'net'
import { z } from 'zod'

import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import type { AppConfig, StatePaths } from '../config.js'
import { redactToken } from '../config.js'
import type { Logger } from '../log.js'
import { writeDeadLetter } from '../state/store.js'
import {
  WebhookPayloadSchema,
  type WebhookPayload,
} from '../schemas.js'
import type { PermissionGateRelay } from '../channel/permission-gate-relay.js'
import { sendChannelNotification, normalizeMeta } from '../channel/notify.js'
import {
  toActivityEvent,
  toTodoWriteEvent,
  isTaskMutationEvent,
  type TaskMirrorEvent,
} from '../hooks/claude-events.js'
import type { AskUserQuestionRelay } from '../channel/ask-user-question.js'
import type { MemoryWriter } from '../memory/writer.js'
import type { ProgressReporter } from '../status/progress-reporter.js'
import type { TaskMirror } from '../status/task-mirror.js'
import type { InboundWatcher } from '../telegram/watcher.js'
import { handleAskAnswer, handleAskRequest } from './routes/ask.js'
import { handleFallbackReply } from './routes/fallback-reply.js'
import { handlePermissionRequest } from './routes/permission.js'
import { handleReact } from './routes/react.js'
import { ASK_SOCKET_TIMEOUT_MARGIN_MS, bearerEquals, chatIdAllowed, reply } from './routes/shared.js'

const BODY_LIMIT_BYTES = 256 * 1024
const DEFAULT_AGENT_ID = 'agent47-channel'

// Structural surface for the hook branch. Avoids importing the full
// StatusManager type so test stubs can pass a minimal object. The webhook
// server only needs to push events into the manager — no read APIs.
export interface StatusManagerForWebhook {
  recordActivityByChatId(
    chatId: string,
    event: ReturnType<typeof toActivityEvent>,
  ): Promise<void>
}

// Structural surface for the SessionInfoStore. Every claude_hook carries
// transcript_path + session_id; SessionStart also carries model. We record the
// latest so /status (and the context HUD) can read them. Write-only here.
export interface SessionInfoRecorder {
  record(
    chatId: string | undefined,
    info: {
      transcriptPath?: string
      sessionId?: string
      model?: string
      permissionMode?: string
    },
  ): void
}

// Structural surface for the context HUD (wave 3B). SessionStart (re)pins +
// refreshes the pinned HUD message; Stop refreshes its percentage. Both entry
// points are best-effort inside the HUD (they swallow + log, never throw), so
// the webhook fires them fire-and-forget and never blocks the 200. Optional —
// when absent the hook path is unchanged (no HUD).
//
// Status-pin wave (2026-07-04): `onTodoEvent` feeds the HUD's «Задачи»
// section from the SAME TaskMirrorEvent stream TaskMirror consumes. Optional
// on the interface so older stubs/tests remain valid.
export interface ContextHudForWebhook {
  onSessionStart(
    chatId: string,
    opts?: { sessionId?: string; source?: string },
  ): Promise<void> | void
  // Stop refreshes the pinned context percentage only — it must NOT finalize
  // the task surface (Stop is turn-end, not session-end).
  onStop(chatId: string): Promise<void> | void
  // SessionEnd is the real session end (distinct Claude Code hook).
  onSessionEnd?(chatId: string, opts?: { sessionId?: string }): Promise<void> | void
  onTodoEvent?(chatId: string, event: TaskMirrorEvent): Promise<void> | void
}

// Fire a HUD entry point without EVER letting it disturb the hook 200 path.
// `Promise.resolve(fn()).catch()` alone is not enough: fn() runs before the
// wrap, so a synchronous throw would escape (codex review 2026-07-04, HIGH #2).
function fireHud(log: Logger, fn: () => Promise<void> | void): void {
  try {
    void Promise.resolve(fn()).catch(() => {})
  } catch (err) {
    log.warn('context hud dispatch threw synchronously (ignored)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
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

// M3 reality mirror surface. All methods are synchronous best-effort (they
// catch internally); the webhook calls them fire-and-forget so a reconciler
// fault never touches the 200 path.
export interface TaskRealityMirrorForWebhook {
  onSessionStart(chatId: string, opts: { sessionId: string; cwd?: string }): void
  onUserPromptSubmit(chatId: string, opts: { sessionId: string; cwd?: string }): void
  onStop(chatId: string): void
  onSessionEnd(chatId: string, opts: { sessionId: string }): void
  onTaskEvent(chatId: string, event: TaskMirrorEvent, opts?: { cwd?: string }): void
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
  // Session facts store (task: context HUD). Records transcript_path + model
  // from every claude_hook so /status can show context usage. Optional — when
  // absent the hook path is unchanged (no capture). Pure in-memory, never
  // throws, so the record call needs no error wrapping.
  sessionInfo?: SessionInfoRecorder
  // Context HUD (wave 3B): the pinned context-usage indicator. SessionStart /
  // Stop hooks drive it. Optional — when absent no HUD is rendered. Fired
  // fire-and-forget so a HUD failure never back-pressures the 200.
  contextHud?: ContextHudForWebhook
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
  // M3 reality mirror (2026-07-09): reconciles the tool-event stream with the
  // real task list Claude Code renders in the tmux pane. When present it is the
  // SOLE driver of the two task surfaces (context HUD «Задачи» + TaskMirror) —
  // the raw taskMirror.recordEvent / contextHud.onTodoEvent mutation dispatch
  // below is bypassed so the reconciled (freshness-tagged) view is authoritative.
  // Its methods are sync + best-effort (they catch internally). Optional —
  // absent = legacy event-only path.
  taskRealityMirror?: TaskRealityMirrorForWebhook
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
  // normally answers through the `mcp__agent47-channel__reply` MCP tool. When a
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
//
// The shared route infrastructure (reply, bearerEquals, chatIdAllowed,
// authGate, readJsonBody, readBodyWithCap) lives in ./routes/shared.ts —
// see the imports above. `readBody` (256 KB, /hooks/agent only) and
// `healthBody` remain local because nothing else uses them.

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
    taskRealityMirror,
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
    // Capture the latest session facts (transcript_path + model) so /status and
    // the context HUD can read them. transcript_path + session_id ride on every
    // hook; model rides on SessionStart and Stop. Pure in-memory record.
    if (deps.sessionInfo) {
      const info: {
        transcriptPath?: string
        sessionId?: string
        model?: string
        permissionMode?: string
      } = {
        transcriptPath: payload.transcript_path,
        sessionId: payload.session_id,
      }
      // model rides on SessionStart AND Stop (a mid-session model switch is
      // observable at turn boundaries). Capture it from any hook that carries a
      // non-empty value; SessionInfoStore MERGES, so a hook without model never
      // wipes the last known one. Read via a narrow cast rather than the
      // discriminated-union narrowing so both variants are handled uniformly and
      // any future model-bearing hook is picked up automatically.
      const hookModel = (payload as { model?: unknown }).model
      if (typeof hookModel === 'string' && hookModel.length > 0) {
        info.model = hookModel
      }
      // permission_mode rides on any hook that carries it (schema-optional).
      // The status pin renders «план» / «выполнение» from the latest value.
      if (
        typeof payload.permission_mode === 'string'
        && payload.permission_mode.length > 0
      ) {
        info.permissionMode = payload.permission_mode
      }
      deps.sessionInfo.record(payload.chatId, info)
    }

    // Context HUD (wave 3B): drive the pinned indicator on the session
    // lifecycle. SessionStart (re)pins + refreshes; Stop refreshes the
    // percentage after a turn. COMPLETELY isolated from the 200 path: the HUD
    // methods swallow + log internally. fireHud additionally guards against a
    // SYNCHRONOUS throw — `Promise.resolve(fn()).catch()` alone evaluates
    // fn() BEFORE the wrap, so a sync throw would 500 the hook response
    // (codex review 2026-07-04, HIGH #2). The HUD gates on the owner chat
    // internally, so a non-owner chatId is a safe no-op.
    if (deps.contextHud) {
      const hud = deps.contextHud
      if (payload.hook_event_name === 'SessionStart') {
        const opts: { sessionId?: string; source?: string } = {
          sessionId: payload.session_id,
        }
        if (typeof payload.source === 'string') opts.source = payload.source
        fireHud(log, () => hud.onSessionStart(payload.chatId, opts))
      } else if (payload.hook_event_name === 'SessionEnd') {
        fireHud(log, () => hud.onSessionEnd?.(payload.chatId, { sessionId: payload.session_id }))
      } else if (payload.hook_event_name === 'Stop') {
        // Stop refreshes the context percentage only — it no longer finalizes
        // the task surfaces (Stop is turn-end, not session-end).
        fireHud(log, () => hud.onStop(payload.chatId))
      }
    }

    // M3 reality mirror: drive the pane-vs-events reconciliation on the session
    // lifecycle. SessionStart binds + captures; UserPromptSubmit opens the turn
    // window + captures; Stop captures then closes the window; SessionEnd
    // freezes. All calls are sync best-effort (the mirror catches internally),
    // fired fire-and-forget so the reconciler never touches the 200 path.
    if (taskRealityMirror) {
      const rm = taskRealityMirror
      const cwd = payload.cwd
      fireHud(log, () => {
        switch (payload.hook_event_name) {
          case 'SessionStart':
            rm.onSessionStart(payload.chatId, { sessionId: payload.session_id, cwd })
            break
          case 'UserPromptSubmit':
            rm.onUserPromptSubmit(payload.chatId, { sessionId: payload.session_id, cwd })
            break
          case 'Stop':
            rm.onStop(payload.chatId)
            break
          case 'SessionEnd':
            rm.onSessionEnd(payload.chatId, { sessionId: payload.session_id })
            break
        }
      })
    }

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

    // TaskMirror + HUD «Задачи» section. toTodoWriteEvent maps SessionStart /
    // SessionEnd (lifecycle) and PostToolUse TodoWrite/TaskCreate/TaskUpdate
    // (mutations); everything else (including Stop) → null, so the cost when no
    // task activity is in flight is one schema test per hook — negligible.
    //
    // TaskMirror consumes BOTH lifecycle and mutation events (it resets on a
    // session change and finalizes on SessionEnd). The HUD's onTodoEvent
    // consumes ONLY mutations — its session lifecycle is driven by the
    // dedicated onSessionStart / onSessionEnd calls above.
    //
    // M3: when the reality mirror is wired it is the SOLE driver of the task
    // surfaces' CONTENT — mutation events feed it (it reconciles them against
    // the pane and pushes a freshness-tagged view into both surfaces); the
    // legacy direct taskMirror.recordEvent(mutation) + contextHud.onTodoEvent
    // path never runs, so the two never double-render. LIFECYCLE events
    // (session_start / session_end) still reach TaskMirror so its own epoch
    // machinery (finalize + eviction + persistence cleanup + tombstones) stays
    // coherent — the reconciler's frozen ended view lands FIRST (its dispatch
    // above enqueues synchronously into the same per-chat lock), then finalize.
    if (taskRealityMirror) {
      const todoEvent = toTodoWriteEvent(payload, log)
      if (todoEvent !== null) {
        if (isTaskMutationEvent(todoEvent)) {
          const rm = taskRealityMirror
          const cwd = payload.cwd
          fireHud(log, () => rm.onTaskEvent(payload.chatId, todoEvent, { cwd }))
        } else if (taskMirror) {
          try {
            await taskMirror.recordEvent(payload.chatId, todoEvent)
          } catch (err) {
            log.warn('hook event task mirror lifecycle update failed (ignored)', {
              chat_id: payload.chatId,
              hook: payload.hook_event_name,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }
    } else if (taskMirror || deps.contextHud?.onTodoEvent) {
      const todoEvent = toTodoWriteEvent(payload, log)
      if (todoEvent !== null) {
        if (taskMirror) {
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
        if (deps.contextHud?.onTodoEvent && isTaskMutationEvent(todoEvent)) {
          const hud = deps.contextHud
          fireHud(log, () => hud.onTodoEvent?.(payload.chatId, todoEvent))
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
// Boot helpers
// ─────────────────────────────────────────────────────────────────────

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
