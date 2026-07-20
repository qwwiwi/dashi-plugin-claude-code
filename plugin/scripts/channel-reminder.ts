#!/usr/bin/env bun
// channel-reminder.ts — UserPromptSubmit hook that re-injects the Telegram
// bridge invariant on EVERY warchief turn.
//
// Why this exists (2026-06-12): agents run as long-lived `claude … server:
// agent47-channel` sessions. The agent47-channel MCP server states the reply
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
// It also appends a short TONE-OF-VOICE / formatting reminder (2026-07-09) so
// replies stay readable on the phone: results-first, short headings on their
// own line with blank lines around, one item per line. The fleet baseline
// lives in docs/TOV-reminder.md; the hook mirrors it as an embedded constant
// and can be pointed at a per-agent override file via TOV_REMINDER_PATH.
//
// Hard invariants (shared with the other dashi hooks):
//   * Exit code 0 in EVERY path — a non-zero hook blocks the model; a
//     missing reminder must never gate the turn.
//   * stdout carries ONLY the JSON envelope (no logs, no secrets) — anything
//     else on stdout becomes additional model context.
//   * File reads are OPTIONAL and best-effort: the TOV reminder file (falls
//     back to the embedded constant) and the per-chat autonomy registry
//     (autonomy-<chat>.json; unreadable/corrupt → the block is omitted).
//     Neither can ever gate the turn. Everything else is env-only.
//   * The autonomy store module is loaded LAZILY inside a try (fix-loop #6):
//     a module-load failure (partial deploy, syntax error in src/) degrades
//     to «no autonomy block» — it can never kill the hook and lose the
//     channel-discipline reminder itself.
//
// Env:
//   CHAT_ID              the Telegram chat id this session serves. Negative
//                        ids are groups/supergroups (multichat); anything
//                        else is a direct chat. Absent → DM-safe generic. Also
//                        keys the autonomy-registry lookup below.
//   TELEGRAM_STATE_DIR   the plugin state root, BAKED into the hook command by
//                        patch-claude-settings (fix-loop #5) so the hook reads
//                        the same registry the server writes. The per-turn
//                        autonomy block (active mandates + open owner
//                        questions) is read from
//                        <state-dir>/autonomy-<chat>.json and appended.
//                        MULTICHAT_STATE_DIR is a documented last-resort
//                        fallback for legacy per-chat sessions. Absent or
//                        unreadable → the block is silently omitted
//                        (fail-open; a broken registry never gates the turn).
//   TOV_REMINDER_ENABLED falsy (0/false/no/off, case-insensitive) disables
//                        the TOV block. Default: enabled.
//   TOV_REMINDER_PATH    per-agent override file for the TOV block. MUST live
//                        inside the plugin docs/ directory (realpath-checked,
//                        symlinks escaping it are rejected). Default:
//                        docs/TOV-reminder.md. Unreadable, out-of-tree, or
//                        over the size cap (8 lines / 1KB) → embedded
//                        constant.

import { readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DM_REMINDER =
  'Telegram bridge: the sender reads Telegram, not this terminal — terminal/transcript text never reaches them. ' +
  'Every reply, question, confirmation, status update, or final answer for this chat MUST go through the ' +
  'mcp__agent47-channel__reply tool (pass chat_id) before you end the turn. Do not end a turn that owes the sender ' +
  'a response without calling reply.'

const GROUP_REMINDER =
  'Telegram bridge: this turn comes from a public/multichat group — the sender reads Telegram, not this terminal. ' +
  'Final text is delivered by the channel outbox path, so do not assume terminal-only text is visible, but also do ' +
  'not force a manual reply call where the group outbox already handles delivery.'

// Generic, DM-safe wording for the case where CHAT_ID is unset — it states
// the invariant without asserting a specific delivery path.
const GENERIC_REMINDER =
  'Telegram bridge: the sender reads Telegram, not this terminal. Anything meant for them must be delivered through ' +
  'the channel (the mcp__agent47-channel__reply tool in a direct chat); terminal-only text is not visible to the sender.'

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

// Embedded fleet-baseline TOV reminder — a byte-for-byte mirror of
// docs/TOV-reminder.md. Used when the file is disabled or unreadable so the
// hook never depends on filesystem state to emit the baseline.
export const EMBEDDED_TOV_REMINDER =
  'Пиши владельцу по-русски, кратко и прямо; сначала вывод или решение.\n' +
  'В длинном ответе используй короткие заголовки отдельной строкой: **Заголовок**.\n' +
  'Оставляй пустую строку до и после каждого заголовка и между смысловыми блоками.\n' +
  'Один абзац -- 1-3 предложения. Каждый пункт списка -- с новой строки.\n' +
  'Выделяй жирным только важные числа, сроки и решения. Без emoji; кавычки «»; тире --.'

/** Falsy env values that switch a boolean-ish flag OFF. Mirrors config.ts. */
function isFalsyEnv(value: string | undefined): boolean {
  if (value === undefined) return false
  return ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase())
}

// Caps on injected TOV content (review fix 2026-07-09): the block rides into
// EVERY turn's context, so an oversized or mis-pointed file must not bloat
// per-turn tokens or leak arbitrary file contents into model context.
// Over-cap or out-of-tree → embedded baseline (never truncated fragments).
const TOV_MAX_BYTES = 1024
const TOV_MAX_LINES = 8

/** The plugin docs/ directory (this script lives in <plugin>/scripts).
 *  Resolved from the module URL so it works regardless of process cwd. */
function tovDocsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', 'docs')
}

function defaultTovPath(): string {
  return resolve(tovDocsDir(), 'TOV-reminder.md')
}

/**
 * Resolve the TOV reminder block. Returns undefined when disabled. Reads the
 * override/default file best-effort with two guards, any failure → embedded
 * baseline (the block is always emitted when enabled):
 *   * containment — realpath of BOTH the file and docs/ must place the file
 *     inside the plugin docs/ directory. Rejects TOV_REMINDER_PATH pointing
 *     elsewhere (e.g. a .env) AND a symlink inside docs/ escaping it.
 *   * size cap — over TOV_MAX_BYTES bytes or TOV_MAX_LINES lines → baseline,
 *     keeping the per-turn injected context bounded.
 */
export function tovReminder(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (isFalsyEnv(env.TOV_REMINDER_ENABLED)) return undefined
  const requested = env.TOV_REMINDER_PATH?.trim() || defaultTovPath()
  try {
    const real = realpathSync(requested)
    const docsReal = realpathSync(tovDocsDir())
    if (!real.startsWith(docsReal + sep)) return EMBEDDED_TOV_REMINDER
    const text = readFileSync(real, 'utf8').trim()
    if (
      text.length > 0 &&
      Buffer.byteLength(text, 'utf8') <= TOV_MAX_BYTES &&
      text.split('\n').length <= TOV_MAX_LINES
    ) {
      return text
    }
  } catch {
    // fall through to embedded baseline
  }
  return EMBEDDED_TOV_REMINDER
}

/**
 * Resolve the per-turn AUTONOMY block from the durable registry, or undefined
 * when there is nothing active / the state can't be located. FAIL-OPEN: any
 * error returns undefined so the reminder still ships without the block — a
 * broken registry must never gate the turn.
 *
 * State dir resolution: the CANONICAL source is the inline TELEGRAM_STATE_DIR
 * that patch-claude-settings bakes into the hook command (fix-loop #5) — that
 * is the SAME resolved root the running server writes its registry into.
 * MULTICHAT_STATE_DIR is honored only as a documented last-resort fallback
 * for legacy per-chat sessions whose command predates the baked var. When
 * neither a state dir nor a chat id is available, the block is simply omitted.
 *
 * The store module is imported LAZILY inside the try (fix-loop #6): a static
 * top-level import from ../src/ would make a module-load failure (partial
 * deploy, syntax error) kill the WHOLE hook — losing the channel-discipline
 * reminder too. A failed dynamic import degrades to «no autonomy block».
 */
export async function autonomyReminder(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  try {
    const chatId = (env.CHAT_ID ?? '').trim()
    if (chatId === '') return undefined
    const stateDir = env.TELEGRAM_STATE_DIR ?? env.MULTICHAT_STATE_DIR
    if (!stateDir || stateDir.trim() === '') return undefined
    const { buildAutonomyReminderBlock, loadAutonomyState } = await import(
      '../src/autonomy/store.js'
    )
    const state = loadAutonomyState({ root: stateDir }, chatId)
    return buildAutonomyReminderBlock(state, Date.now())
  } catch {
    // Never gate the turn on an autonomy-state / module-load failure.
    return undefined
  }
}

/** Compose the full additionalContext string: channel discipline first, then
 *  the optional autonomy block, then the optional TOV block — each separated by
 *  a blank line. Async because the autonomy block loads its module lazily. */
export async function composeReminder(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const channel = reminderForChat(env.CHAT_ID)
  const autonomy = await autonomyReminder(env)
  const tov = tovReminder(env)
  return [channel, autonomy, tov].filter((s): s is string => s !== undefined && s.length > 0).join('\n\n')
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
  // Set exitCode and let the process terminate naturally — calling
  // process.exit() right after an async stdout write can truncate the
  // payload before the stream flushes (Codex review). The payload is one
  // short line, but natural termination is the safe pattern.
  try {
    const text = await composeReminder(process.env)
    process.stdout.write(renderContext(text))
  } catch {
    // Never gate the turn on a reminder failure. Emit the bare channel
    // reminder as the floor so the discipline text still reaches the turn.
    try {
      process.stdout.write(renderContext(reminderForChat(process.env.CHAT_ID)))
    } catch {
      // truly nothing to do
    }
  }
  process.exitCode = 0
}
