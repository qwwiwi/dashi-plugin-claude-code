// Shared HTTP route infrastructure for the webhook server's sub-routes.
//
// These helpers are used by more than one route handler (react,
// fallback-reply, permission, ask-user-question) and by the top-level
// dispatcher in ../server.ts. They were extracted verbatim from server.ts
// during the route-module split — no behaviour change.

import type { IncomingMessage, ServerResponse } from 'http'
import { timingSafeEqual } from 'crypto'
import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type { Logger } from '../../log.js'

// Margin added on top of the configured AskUserQuestion timeout to set
// the underlying socket-level request timeout. The plugin must observe
// the soft (logical) timeout from the relay BEFORE the framework cuts
// the socket, otherwise the hook wrapper sees a connection drop instead
// of the clean `{ status: 'timeout' }` JSON it expects. Shared between
// handleAskRequest (per-request socket bump) and startWebhookServer
// (server-level ceiling), so it lives here rather than in a route module.
export const ASK_SOCKET_TIMEOUT_MARGIN_MS = 30_000

// Loopback hosts that count as «caller is on this machine». Mirrors the
// L5 guard in startWebhookServer — `localhost` is intentionally NOT in
// this list because /etc/hosts can redirect it elsewhere.
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false
  // Node's req.socket.remoteAddress reports IPv6-mapped v4 as `::ffff:127.0.0.1`.
  if (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') return true
  if (addr.startsWith('127.')) return true
  return false
}

export function reply(res: ServerResponse, status: number, body: Record<string, unknown>): void {
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

export function bearerEquals(received: string, expected: string): boolean {
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

export function chatIdAllowed(config: AppConfig, chatId: string): boolean {
  for (const entry of config.allowed_chat_ids) {
    if (String(entry) === chatId) return true
  }
  return false
}

// Drain helper used by AskUserQuestion routes — parameterised on cap so
// the same primitive serves both the 64 KB AskUserQuestion budget and
// any future route that needs a tighter limit. The legacy /hooks/agent
// path keeps using `readBody` above (hardcoded 256 KB) to minimise
// churn in already-shipped behaviour.
export function readBodyWithCap(req: IncomingMessage, cap: number): Promise<{ tooLarge: boolean; buf: Buffer }> {
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

export async function readJsonBody<T>(
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

// Shared auth/origin gate. Returns `false` when the response has
// already been written (route handler short-circuits on false return).
export function authGate(
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
