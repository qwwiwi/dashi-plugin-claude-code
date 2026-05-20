// Inbound addressing helper.
//
// Decides whether a Telegram update is "addressed" to this bot — meaning
// the prince intends the bot to notice it. Used to gate visibility signals
// (e.g. 👀 reactions) so the bot does not spam reactions on every message
// in groups it happens to be a member of.
//
// Rules (mirror Python gateway helper at gateway.py:753-793):
//   - Private chat → always addressed (DM is the primary channel).
//   - Group/supergroup with text or caption that @-mentions the bot → addressed.
//   - Group/supergroup with reply_to_message authored by the bot itself → addressed.
//   - Group/supergroup voice/video_note reply (no text to @-mention with) → addressed
//     if the parent message is from the bot.
//   - Anything else → not addressed.
//
// We deliberately do NOT consult the allowlist here — that is the gate's job.
// This helper is about intent ("is the user talking to me?"), not authorization
// ("is the user allowed to talk to me?"). The reaction is harmless either way.
import type { Context } from 'grammy'

export function isAddressedToBot(ctx: Context): boolean {
  const chatType = ctx.chat?.type
  if (chatType === 'private') return true
  if (chatType !== 'group' && chatType !== 'supergroup') return false

  const botUsername = ctx.me?.username?.toLowerCase()
  if (!botUsername) return false

  const text = (ctx.message?.text ?? ctx.message?.caption ?? '').toLowerCase()
  if (text.length > 0 && text.includes(`@${botUsername}`)) return true

  const replyTo = ctx.message?.reply_to_message
  if (replyTo?.from?.is_bot && replyTo.from?.username?.toLowerCase() === botUsername) {
    return true
  }

  // Voice / video_note replies have no text to @-mention with — any reply
  // to the bot counts. Mirrors gateway.py:783-784.
  if (replyTo && (ctx.message?.voice || ctx.message?.video_note)) {
    const replyUsername = replyTo.from?.username?.toLowerCase()
    if (replyTo.from?.is_bot && replyUsername === botUsername) {
      return true
    }
  }
  return false
}
