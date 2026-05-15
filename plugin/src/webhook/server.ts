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
import type { AddressInfo } from 'net'
import { z } from 'zod'

import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import type { AppConfig, StatePaths } from '../config.js'
import { redactToken } from '../config.js'
import type { Logger } from '../log.js'
import { writeDeadLetter } from '../state/store.js'
import { WebhookPayloadSchema, type WebhookPayload } from '../schemas.js'
import { sendChannelNotification, normalizeMeta } from '../channel/notify.js'

const BODY_LIMIT_BYTES = 256 * 1024
const DEFAULT_AGENT_ID = 'dashi-channel'

export interface WebhookDeps {
  mcpServer: McpServer
  config: AppConfig
  statePaths: StatePaths
  log: Logger
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
      const summary = err.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')
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
  // Encode to fixed-length buffers so timingSafeEqual never throws on
  // length mismatch; length difference is independently checked.
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    // Still run a constant-time compare on equal-length padded buffers so
    // the failure path runs the same code; the length check is its own bit.
    const pad = Buffer.alloc(b.length)
    timingSafeEqual(pad, b)
    return false
  }
  return timingSafeEqual(a, b)
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
  const { config, statePaths, log, mcpServer } = deps
  const method = req.method ?? 'GET'
  const url = req.url ?? '/'

  // Strip query string for routing.
  const path = url.split('?', 1)[0] ?? '/'

  if (method === 'GET' && path === '/health') {
    reply(res, 200, healthBody(config))
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

  // Forward to MCP channel.
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
// Public entry — start server when enabled.
// ─────────────────────────────────────────────────────────────────────

export async function startWebhookServer(
  config: AppConfig,
  deps: WebhookDeps,
): Promise<WebhookServerHandle | null> {
  if (!config.webhook.enabled) return null

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
