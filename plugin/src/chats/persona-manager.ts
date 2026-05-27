// Persona/system-reminder resolver for per-chat sessions.
//
// The router calls these helpers when spawning a tmux session: the
// persona becomes the appended system prompt and the system_reminder
// is injected into the first user message so behavior overrides are
// idempotent across session restarts.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MultichatPolicy } from './policy-loader.ts'

/**
 * Read the persona markdown for a given chat id.
 *
 * Reads `{chatsBasePath}/{chatId}/persona.md` synchronously. The
 * persona file is required — missing file is a hard fatal because
 * spawning a session without an identity would let the master Claude
 * Code default persona answer in a public chat (security risk).
 *
 * @param chatId stringified Telegram chat id (negative for groups)
 * @param chatsBasePath directory containing per-chat subfolders,
 *   typically `~/.claude-lab/thrall/.claude/chats`
 * @returns persona markdown contents as a UTF-8 string
 * @throws Error when persona.md is absent or unreadable
 */
export function resolvePersona(chatId: string, chatsBasePath: string): string {
  const personaPath = join(chatsBasePath, chatId, 'persona.md')
  try {
    return readFileSync(personaPath, 'utf8')
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `persona.md not found for chat ${chatId} at ${personaPath}: ${reason}`,
    )
  }
}

/**
 * Resolve the system_reminder snippet for a given chat id.
 *
 * Returns an empty string when the chat is not in the policy — the
 * caller is expected to treat that as "no override" rather than a
 * fatal. This is intentionally permissive because gates upstream
 * already validate chat membership; the reminder is purely behavioral.
 *
 * @param policy loaded multichat policy
 * @param chatId stringified Telegram chat id
 * @returns system_reminder text, or empty string if not configured
 */
export function getSystemReminder(
  policy: MultichatPolicy,
  chatId: string,
): string {
  return policy.chats[chatId]?.system_reminder ?? ''
}
