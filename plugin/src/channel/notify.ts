// MCP `notifications/claude/channel` event helpers.
//
// Claude Code drops meta keys with hyphens silently (per RESEARCH.md). We
// enforce identifier-style snake_case keys and stringify all values so the
// receiver never has to guess how to render a number/boolean.
//
// Multichat contract: callers MUST populate `meta.chat_id` with the
// originating Telegram chat id (already done in handlers.ts:buildMeta).
// The master Claude session inspects `meta.chat_id` to know which chat
// the inbound message came from — there is NO implicit fallback to the
// warchief's DM. This module never injects a default chat_id; an event
// arriving without one is a wiring bug at the caller, not something we
// paper over here.

import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Logger } from '../log.js'

export type ChannelEvent = {
  content: string
  // Caller-supplied metadata. In multichat mode this MUST include
  // `chat_id` so the master session can route the event; in the legacy
  // DM-only mode `chat_id` is still set (handlers.ts always populates it).
  meta: Record<string, string>
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function normalizeMeta(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue
    if (key.includes('-')) continue
    if (!IDENT_RE.test(key)) continue
    if (typeof value === 'string') {
      out[key] = value
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = String(value)
    } else if (typeof value === 'boolean') {
      out[key] = value ? 'true' : 'false'
    } else if (typeof value === 'bigint') {
      out[key] = value.toString()
    } else {
      // Object/array/symbol/function — drop with a serialized fallback only if JSON works.
      try {
        out[key] = JSON.stringify(value)
      } catch {
        // skip
      }
    }
  }
  return out
}

// Returns true when server.notification accepted the write; false when the
// transport threw (error already logged). Callers MUST honour false: poller
// dead-letters the update, webhook returns 503.
export async function sendChannelNotification(
  server: Server,
  event: ChannelEvent,
  log: Logger,
): Promise<boolean> {
  try {
    await server.notification({
      method: 'notifications/claude/channel',
      params: {
        content: event.content,
        meta: event.meta,
      },
    })
    return true
  } catch (err) {
    log.error('channel notification failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}
