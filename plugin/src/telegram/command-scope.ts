// Owner-scoped Telegram command registration.
//
// Telegram command scopes have a precedence: chat > all_private_chats > default.
// If we register commands under the DEFAULT scope, EVERY chat the bot is in sees
// them in the «/» autocomplete. The warchief's requirement is that the command
// menu is visible ONLY to the owner. So we:
//   1. CLEAR the broader scopes (default + all_private_chats) that a previous
//      build may have populated — otherwise their stale entries keep showing.
//   2. Register the command list under the per-CHAT scope for each owner chat.
//
// Best-effort: each Bot API call is wrapped so a transient failure (offline,
// revoked token) never blocks startup. The whole routine is a fire-and-forget
// side effect at boot.

import type { Logger } from '../log.js'

export interface CommandSpec {
  command: string
  description: string
}

// Structural subset of grammY's `bot.api` this routine needs. Kept narrow so
// the module never reaches into grammY internals and unit tests can pass a fake
// recording object. The scope object literals match the exact Telegram
// BotCommandScope variants we use.
export interface CommandScopeApi {
  deleteMyCommands(options?: { scope: { type: 'all_private_chats' } }): Promise<unknown>
  setMyCommands(
    commands: readonly CommandSpec[],
    options: { scope: { type: 'chat'; chat_id: number | string } },
  ): Promise<unknown>
}

// Register `commands` scoped to the owner's chat(s), clearing stale broader
// scopes first. `chatIds` should be config.allowed_chat_ids (falling back to
// allowed_user_ids as DM chat ids — in a DM the chat id equals the user id).
export async function registerOwnerScopedCommands(
  api: CommandScopeApi,
  commands: readonly CommandSpec[],
  chatIds: ReadonlyArray<number | string>,
  log: Logger,
): Promise<void> {
  // 1. Clear the broader scopes so their old entries stop showing. FIX-11
  //    (Fable L5): the two deletes live in SEPARATE try/catch so a failure of
  //    the first (default scope) does not skip the second (all_private_chats).
  //    Before, a single throw left all_private_chats populated and its stale
  //    menu kept showing in every private chat.
  try {
    await api.deleteMyCommands() // default scope = bare call
  } catch (err) {
    log.warn('deleteMyCommands (default scope) failed (ignored)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  try {
    await api.deleteMyCommands({ scope: { type: 'all_private_chats' } })
  } catch (err) {
    log.warn('deleteMyCommands (all_private_chats scope) failed (ignored)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 2. Register per owner chat. FIX-11 (both reviews): register the per-CHAT
  //    scope ONLY for positive (DM) ids — in a DM the chat id equals the user
  //    id. A negative group/supergroup id or an @channel string is NOT an owner
  //    DM, and pinning the owner command menu there would expose it in a public
  //    group. Such ids are skipped (fail-closed).
  // NOT IN SCOPE (fast-follow): clearing the per-chat scope for chat ids that
  // were DROPPED from the allowlist — a removed owner keeps a stale menu until
  // its scope is explicitly deleted. Tracked separately.
  let registered = 0
  for (const chatId of chatIds) {
    if (typeof chatId !== 'number' || !Number.isInteger(chatId) || chatId <= 0) {
      log.info('command-scope: skipping non-DM chat id (owner menu is DM-only)', {
        chat_id: chatId,
      })
      continue
    }
    try {
      await api.setMyCommands(commands, { scope: { type: 'chat', chat_id: chatId } })
      registered += 1
    } catch (err) {
      log.warn('setMyCommands (owner scope) failed (ignored)', {
        chat_id: chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  log.info('telegram commands registered (owner-scoped)', {
    count: commands.length,
    chats: registered,
  })
}
