#!/usr/bin/env bun
// channel-reminder.ts — UserPromptSubmit hook that re-injects the Telegram
// bridge invariant on EVERY warchief turn.
//
// Why this exists (2026-06-12): agents run as long-lived `claude … server:
// dashi-channel` sessions. The dashi-channel MCP server states the reply
// discipline once at session start ("the sender reads Telegram, not this
// terminal"), and plugin/CLAUDE.md repeats it as a durable invariant — but
// over a long session both fade, and agents end turns with terminal-only
// text the warchief never sees. A UserPromptSubmit hook fires on every
// inbound prompt, so emitting the reminder here re-grounds the model each
// turn instead of relying on start-of-session context alone.
//
// Output contract: a single JSON object on stdout carrying
// `hookSpecificOutput.additionalContext` — Claude Code prepends that string
// to the turn as context. It is NEVER sent to Telegram; the only way it
// reaches the chat is if the model parrots it, so the text stays terse.
//
// Hard invariants (shared with the other dashi hooks):
//   * Exit code 0 in EVERY path — a non-zero hook blocks the model; a
//     missing reminder must never gate the turn.
//   * stdout carries ONLY the JSON envelope (no logs, no secrets) — anything
//     else on stdout becomes additional model context.
//   * No file reads/writes; configuration is env-only.
//
// Env:
//   CHAT_ID   the Telegram chat id this session serves. Negative ids are
//             groups/supergroups (multichat); anything else is treated as a
//             direct chat with the warchief. Absent → DM-safe generic.

const DM_REMINDER =
  'Telegram bridge: the sender reads Telegram, not this terminal — terminal/transcript text never reaches them. ' +
  'Every reply, question, confirmation, status update, or final answer for this chat MUST go through the ' +
  'mcp__dashi-channel__reply tool (pass chat_id) before you end the turn. Do not end a turn that owes the sender ' +
  'a response without calling reply.'

const GROUP_REMINDER =
  'Telegram bridge: this turn comes from a public/multichat group — the sender reads Telegram, not this terminal. ' +
  'Final text is delivered by the channel outbox path, so do not assume terminal-only text is visible, but also do ' +
  'not force a manual reply call where the group outbox already handles delivery.'

// Generic, DM-safe wording for the case where CHAT_ID is unset — it states
// the invariant without asserting a specific delivery path.
const GENERIC_REMINDER =
  'Telegram bridge: the sender reads Telegram, not this terminal. Anything meant for them must be delivered through ' +
  'the channel (the mcp__dashi-channel__reply tool in a direct chat); terminal-only text is not visible to the sender.'

/**
 * Pick the reminder for a chat id. Negative id → group; a present non-negative
 * id → DM; absent/blank → generic DM-safe.
 */
export function reminderForChat(chatId: string | undefined): string {
  const trimmed = (chatId ?? '').trim()
  if (trimmed === '') return GENERIC_REMINDER
  if (trimmed.startsWith('-')) return GROUP_REMINDER
  return DM_REMINDER
}

/** The exact stdout envelope Claude Code reads for UserPromptSubmit context. */
export function renderContext(text: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  })
}

// Side-effecting entrypoint — skipped when imported by tests.
if (import.meta.main) {
  // We do not even need to read stdin: the reminder is independent of the
  // prompt body, and reading it would only risk echoing private content.
  try {
    process.stdout.write(renderContext(reminderForChat(process.env.CHAT_ID)))
  } catch {
    // Never gate the turn on a reminder failure.
  }
  process.exit(0)
}
