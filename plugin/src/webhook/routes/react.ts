// POST /hooks/react — read-receipt route. Extracted verbatim from
// server.ts during the route-module split; no behaviour change.

import type { IncomingMessage, ServerResponse } from 'http'

import { redactToken } from '../../config.js'
import { ReactRouteRequestSchema } from '../../schemas.js'
import type { WebhookDeps } from '../server.js'
import { authGate, chatIdAllowed, readJsonBody, reply } from './shared.js'

// Read-receipt bodies are tiny ({chat_id, message_id, emoji}); 4 KB is
// generous and keeps the route cheap to abuse-proof.
const REACT_BODY_LIMIT_BYTES = 4 * 1024

// fix/eyes-on-read (2026-05-28): POST /hooks/react — set the 👀 read
// receipt on an inbound message the agent has actually read in a turn.
// Auth: loopback origin + bearer (same fence as the AskUserQuestion
// routes). Defence in depth: chatId must be in the allowlist, so a leaked
// token still can't make the bot react in an arbitrary chat.
export async function handleReact(
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
