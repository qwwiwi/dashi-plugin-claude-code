// POST /hooks/fallback-reply — DM fallback-reply route. Extracted verbatim
// from server.ts during the route-module split; no behaviour change.

import type { IncomingMessage, ServerResponse } from 'http'

import { redactToken } from '../../config.js'
import { FallbackReplyRouteRequestSchema } from '../../schemas.js'
import type { WebhookDeps } from '../server.js'
import { authGate, chatIdAllowed, readJsonBody, reply } from './shared.js'

// Fallback-reply bodies carry one text up to Telegram's 4096-char cap plus a
// short chat_id. FIX 5 (2026-06-03): 4096 chars × up to 4 UTF-8 bytes + JSON
// overhead can exceed 16 KB, which would 413 BEFORE the schema validates the
// 4096-char text. 32 KB covers the worst-case multibyte body with headroom
// while still cheap to abuse-proof.
const FALLBACK_REPLY_BODY_LIMIT_BYTES = 32 * 1024

// 2026-06-03 (feature/dm-fallback-reply-hook): POST /hooks/fallback-reply —
// forward the DM turn's final assistant text to the warchief's Telegram when
// the turn ended WITHOUT an MCP reply()/edit_message() call. Auth: loopback
// origin + bearer (same fence as the react route). Defence in depth: chatId
// must be in the allowlist, so a leaked token still can't make the bot post
// into an arbitrary chat. Modeled on handleReact.
export async function handleFallbackReply(
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
