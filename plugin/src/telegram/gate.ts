// Inbound + outbound Telegram allowlist gate.
//
// Scope A (DM-only, legacy): static config allowlist. Sender id is the
// authentication primitive; chat.id is a defensive secondary check
// because in DMs Telegram sets chat.id == user.id.
//
// Scope B (multichat): when a MultichatPolicy is passed in, groups and
// supergroups become allowed if (a) chatId is in policy.allowlist.chats
// and (b) senderId is in policy.allowlist.users. The mention_allowlist
// check (only the warchief may summon the bot via @mention) is delegated
// to `addressing.ts` — see `isAddressedToBot(..., mentionAllowlist)` —
// because it needs full grammy Context for mention parsing.
//
// Backward compatibility: when `policy` is omitted, the legacy
// "DM-only or drop" behaviour is preserved exactly. Existing tests that
// call gateTelegramMessage(input, config) without a policy keep their
// expectations.
//
// No side effects. All drop branches return a typed reason; the caller
// is responsible for logging at debug level so authorized-only inboxes
// don't get spammed by injection attempts.
import type { MultichatPolicy } from '../chats/policy-loader.js'
import type { AppConfig } from '../config.js'

export type GateDropReason =
  | 'not_dm'
  | 'missing_sender'
  | 'sender_not_allowed'
  | 'chat_not_allowed'
  | 'no_policy_for_groups'
  | 'sender_not_allowed_in_group'
  | 'not_in_mention_allowlist'

export type GateDecision =
  | { kind: 'allow'; senderId: string; chatId: string }
  | { kind: 'drop'; reason: GateDropReason }

export interface GateInput {
  chatType: 'private' | 'group' | 'supergroup' | 'channel' | undefined
  chatId: string | undefined
  senderId: string | undefined
  isBot: boolean | undefined
}

// Coerce config ids (number | string) to string for set membership.
function toStringSet(values: ReadonlyArray<number | string>): Set<string> {
  const out = new Set<string>()
  for (const v of values) out.add(String(v))
  return out
}

export function gateTelegramMessage(
  input: GateInput,
  config: AppConfig,
  policy?: MultichatPolicy,
): GateDecision {
  // Channel posts: not supported on any path.
  if (input.chatType === 'channel' || input.chatType === undefined) {
    return { kind: 'drop', reason: 'not_dm' }
  }

  if (input.chatType === 'private') {
    return gateDm(input, config)
  }

  // Group or supergroup.
  if (policy === undefined) {
    // Backward compat: legacy DM-only mode. Groups drop with the
    // historical reason `not_dm` so existing tests stay green and
    // operators see the same log line they always have.
    return { kind: 'drop', reason: 'not_dm' }
  }

  if (input.chatId === undefined || input.chatId === '') {
    return { kind: 'drop', reason: 'chat_not_allowed' }
  }
  if (input.senderId === undefined || input.senderId === '') {
    return { kind: 'drop', reason: 'missing_sender' }
  }

  const allowedChats = new Set(policy.allowlist.chats)
  if (!allowedChats.has(input.chatId)) {
    return { kind: 'drop', reason: 'chat_not_allowed' }
  }

  const allowedUsers = new Set(policy.allowlist.users)
  if (!allowedUsers.has(input.senderId)) {
    return { kind: 'drop', reason: 'sender_not_allowed_in_group' }
  }

  // mention_allowlist enforcement is performed upstream in
  // isAddressedToBot(..., policy.mention_allowlist); we only gate on
  // chat + sender membership here.
  return { kind: 'allow', senderId: input.senderId, chatId: input.chatId }
}

function gateDm(input: GateInput, config: AppConfig): GateDecision {
  if (input.senderId === undefined || input.senderId === '') {
    return { kind: 'drop', reason: 'missing_sender' }
  }

  const allowedUsers = toStringSet(config.allowed_user_ids)
  if (!allowedUsers.has(input.senderId)) {
    return { kind: 'drop', reason: 'sender_not_allowed' }
  }

  // Defensive secondary check. In Telegram DMs chat.id == user.id, so this
  // is rarely tripped — but if a future config drift adds a user without the
  // matching chat, we'd rather drop than deliver to an unverified chat.
  const allowedChats = toStringSet(config.allowed_chat_ids)
  if (input.chatId === undefined || !allowedChats.has(input.chatId)) {
    return { kind: 'drop', reason: 'chat_not_allowed' }
  }

  return { kind: 'allow', senderId: input.senderId, chatId: input.chatId }
}

// Outbound gate. Mirrors refs/telegram-official/server.ts:194-199 but reads
// from config instead of the on-disk allowlist.json. Used by reply/react/
// edit_message/sendDocument to ensure tool calls cannot leak to chats the
// inbound gate would never deliver from.
//
// H4 fix (2026-05-23): unify outbound authorization across legacy and
// multichat modes. When `policy` is provided (multichat mode), the
// policy.allowlist.chats list is the single source of truth and the
// legacy `config.allowed_chat_ids` is intentionally ignored — having
// two parallel allowlists for outbound was producing edge-case
// conflicts (a chat listed in config but absent from policy, or vice
// versa, would behave inconsistently between inbound and outbound).
// When `policy` is omitted (legacy DM-only deployment), behaviour is
// unchanged from before this fix.
export function assertAllowedChat(
  chatId: string,
  config: AppConfig,
  policy?: MultichatPolicy,
): void {
  if (policy !== undefined) {
    // Multichat mode — policy.allowlist.chats is authoritative. The
    // chat must ALSO be present in policy.chats; without a chat-policy
    // entry the spawn-side guard (C3) would refuse to launch a tmux
    // session, so allowing outbound to a chat that cannot host an
    // inbound session is incoherent.
    const allowedChats = new Set(policy.allowlist.chats)
    if (!allowedChats.has(chatId)) {
      throw new Error(
        `chat ${chatId} is not allowlisted — add to policy.allowlist.chats`,
      )
    }
    if (!(chatId in policy.chats)) {
      throw new Error(
        `chat ${chatId} has no policy.chats entry — outbound refused`,
      )
    }
    return
  }
  // Legacy mode — unchanged behaviour.
  const allowed = toStringSet(config.allowed_chat_ids)
  if (!allowed.has(chatId)) {
    throw new Error(`chat ${chatId} is not allowlisted — add to allowed_chat_ids`)
  }
}
