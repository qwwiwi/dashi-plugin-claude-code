// Forward an inline-button tap that no built-in handler claimed (not an
// AskUserQuestion `ask:` keyboard, not a permission `perm:` card) to the
// agent session as a synthetic inbound message. The plugin owns the bot's
// update stream, so a cron-sent reminder keyboard (e.g. medicine
// `taken::course::<id>`) has no other consumer — without this its taps are
// silently dropped. Keeping the plugin generic: it forwards the raw tap and
// the agent (a skill) decides what it means.

import type { InboundMessage } from '../router/inbox-bridge.js'

// Prefixes the plugin handles itself; everything else is forwardable.
const HANDLED_PREFIXES = ['ask:', 'perm:']

export function isForwardableCallback(data: string): boolean {
  if (data.length === 0) return false
  return !HANDLED_PREFIXES.some(p => data.startsWith(p))
}

export function buildCallbackInboundMessage(opts: {
  data: string
  chatId: string
  userId: string
  user: string
  timestamp: string
  messageId?: string
}): InboundMessage {
  return {
    text: `[inline-button] ${opts.data}`,
    chat_id: opts.chatId,
    user_id: opts.userId,
    user: opts.user,
    timestamp: opts.timestamp,
    ...(opts.messageId !== undefined ? { message_id: opts.messageId } : {}),
  }
}
