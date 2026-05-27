// Inbound addressing helper.
//
// Decides whether a Telegram update is "addressed" to this bot — meaning
// the user intends the bot to notice it. Used to gate visibility signals
// (e.g. reactions) so the bot does not spam reactions on every message
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
// Multichat extension: when a `mentionAllowlist` is supplied, group/
// supergroup updates are additionally filtered by sender id. A @mention
// from a sender that is NOT in the allowlist returns `false` (silent
// drop) — no reaction, no router dispatch. DMs ignore the allowlist
// because they're already gated by the DM allowlist upstream.
//
// We deliberately do NOT consult the broader allowlist here — that is
// the gate's job. This helper is about intent ("is the user talking to
// me, and is this someone we listen to?"), not about authorization
// ("is this chat allowlisted at all?").
import type { Context } from 'grammy'

/**
 * Check whether a sender id is in a group's mention allowlist.
 *
 * Pure string-set membership. The allowlist is sourced from
 * `policy.mention_allowlist`; the values are stringified Telegram user
 * ids (matching the policy schema in `chats/policy-loader.ts`).
 *
 * Backward compat: if the allowlist is empty (`[]`), this returns
 * `false` — an empty allowlist means "nobody in this group can summon
 * the bot". To allow everyone, pass `undefined` to {@link isAddressedToBot}
 * instead of an empty array.
 */
export function checkMentionAllowlist(
  senderId: string,
  mentionAllowlist: readonly string[],
): boolean {
  if (senderId === '') return false
  for (const allowed of mentionAllowlist) {
    if (allowed === senderId) return true
  }
  return false
}

export function isAddressedToBot(
  ctx: Context,
  mentionAllowlist?: readonly string[],
): boolean {
  const chatType = ctx.chat?.type
  if (chatType === 'private') return true
  if (chatType !== 'group' && chatType !== 'supergroup') return false

  // Multichat gate: if a mention allowlist is provided, only listed
  // senders can summon the bot via @mention or reply. A non-allowlisted
  // user's mention is a silent no-op so the bot does not even react.
  if (mentionAllowlist !== undefined) {
    const senderId = ctx.from?.id !== undefined ? String(ctx.from.id) : ''
    if (!checkMentionAllowlist(senderId, mentionAllowlist)) {
      return false
    }
  }

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
