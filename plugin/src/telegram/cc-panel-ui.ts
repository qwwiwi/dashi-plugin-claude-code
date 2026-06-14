// /cc panel — one-tap inline-button keypad for running the MOST COMMON
// Claude Code slash commands (/compact, /clear, /model, …) in the agent's
// tmux pane from Telegram. It is the graphical front-end to the SAME
// passthrough `/cc <command>` performs: a tap types `/<name>` into the pane
// and submits with Enter (via sendSlashCommand, which C-u clears the input
// line first so a leftover draft can't corrupt the command).
//
// Callback data uses the `ccmd:` prefix so it never collides with the other
// inline flows sharing bot.on('callback_query:data'):
//   * `kkey:*`  — /keys keystroke keypad (telegram/keys-panel-ui.ts)
//   * `pgate:*` — permission-gate Allow/Deny
//   * `ask:*`   — AskUserQuestion
//   * `perm:*`  — headless MCP permission relay
//
//   ccmd:<name>   where <name> is ONE entry of the CLOSED command whitelist
//                 below (argless, popular Claude Code commands only).
//
// Security: a tap is honoured ONLY for a user id in the same allow-list that
// guards the sibling `/cc` OOB command (config.allowed_user_ids). Anyone else
// gets an answerCallbackQuery toast and NOTHING is typed. The command set is a
// FROZEN whitelist — there is no way to type arbitrary text into the pane, so
// a pane that dropped to a shell can't be driven to run a shell command.

import { sendSlashCommand, type KeysExec, type TmuxKeysTarget } from '../commands/keys.js'
import type { InlineKeyboardLike } from '../channel/tools.js'
import type { Logger } from '../log.js'

// The callback prefix. Distinct from kkey:/pgate:/ask:/perm: by construction.
export const CCMD_PREFIX = 'ccmd:'

// Closed, frozen whitelist of the popular Claude Code slash commands the panel
// exposes. name = the command typed (no leading slash, no args); label = the
// button text; desc = one-line explanation rendered in the header. Argless on
// purpose: a tap is a fixed command, not a macro. `model` opens Claude Code's
// interactive model picker — drive the selection afterwards with the /keys
// arrows + ⏎. Object.freeze (deep) so the set can't be widened at runtime.
export interface CcCommandSpec {
  readonly name: string
  readonly label: string
  readonly desc: string
}
export const CC_PANEL_COMMANDS: readonly CcCommandSpec[] = Object.freeze([
  Object.freeze({ name: 'compact', label: '🗜 compact', desc: 'сжать контекст (освободить место)' }),
  Object.freeze({ name: 'context', label: '📊 context', desc: 'показать расход контекста' }),
  Object.freeze({ name: 'cost', label: '💰 cost', desc: 'стоимость токенов сессии' }),
  Object.freeze({ name: 'status', label: 'ℹ️ status', desc: 'статус Claude Code' }),
  Object.freeze({ name: 'model', label: '🧠 model', desc: 'выбрать модель (дальше стрелки /keys + ⏎)' }),
  Object.freeze({ name: 'resume', label: '⏯ resume', desc: 'список/возобновить сессии' }),
  Object.freeze({ name: 'export', label: '📤 export', desc: 'экспорт диалога' }),
  Object.freeze({ name: 'clear', label: '🧹 clear', desc: 'очистить диалог — НОВЫЙ контекст (необратимо)' }),
] as const)

// Membership lookup built from the frozen specs — single source of truth.
const ALLOWED_CCMD: ReadonlySet<string> = new Set<string>(
  CC_PANEL_COMMANDS.map((c) => c.name),
)

// Parse a `ccmd:<name>` callback_data string. Returns the validated command
// name (one entry of the frozen whitelist) or null for anything else — a
// non-ccmd prefix, an empty name, or a name outside the whitelist. Null
// callers answer the callback with a toast and type NOTHING (fail-closed).
export function parseCcmdCallback(data: string): string | null {
  if (typeof data !== 'string') return null
  if (!data.startsWith(CCMD_PREFIX)) return null
  const name = data.slice(CCMD_PREFIX.length)
  if (name.length === 0) return null
  if (!ALLOWED_CCMD.has(name)) return null
  return name
}

// Build the keypad: two commands per row, in the CC_PANEL_COMMANDS order.
export function buildCcKeyboard(): InlineKeyboardLike {
  const rows: Array<Array<{ text: string; callback_data: string }>> = []
  for (let i = 0; i < CC_PANEL_COMMANDS.length; i += 2) {
    const row = CC_PANEL_COMMANDS.slice(i, i + 2).map((c) => ({
      text: c.label,
      callback_data: `${CCMD_PREFIX}${c.name}`,
    }))
    rows.push(row)
  }
  return { inline_keyboard: rows }
}

// Header text rendered above the keypad. HTML parse mode. Lists each command
// with its explanation so the warchief knows what every button does.
export const CC_PANEL_HEADER =
  '<b>Команды Claude Code</b> — тап = выполнить в моей сессии.\n'
  + CC_PANEL_COMMANDS.map((c) => `<code>/${c.name}</code> — ${c.desc}`).join('\n')

// ─────────────────────────────────────────────────────────────────────
// Callback handler — mirrors handleKkeyCallback. Security model: fail-closed
// auth FIRST → parse name → pane check → run. A reject at ANY step toasts and
// types NOTHING. Auth precedes parsing so a non-allowed caller can never learn
// which commands are valid.
// ─────────────────────────────────────────────────────────────────────

export interface CcmdCallbackContext {
  callbackQuery: { data: string }
  from?: { id?: number | undefined }
  answerCallbackQuery(arg: { text: string }): Promise<void>
}

export interface CcmdCallbackDeps {
  allowedUserIds: readonly number[]
  tmuxKeysTarget?: TmuxKeysTarget
  log: Logger
  exec?: KeysExec
}

// Dispatch a `ccmd:*` callback. Always answers the callback query and returns
// true when it consumed the event. NEVER types a command for a non-allowed
// user id. Does NOT mutate the keyboard message (the warchief taps it
// repeatedly).
export async function handleCcmdCallback(
  ctx: CcmdCallbackContext,
  deps: CcmdCallbackDeps,
): Promise<boolean> {
  // AUTH FIRST — before parsing the name or touching the pane. A non-allowed
  // (or missing/non-number id) caller gets ONLY «не авторизовано» and learns
  // nothing about command validity or pane state.
  const fromId = ctx.from?.id
  if (typeof fromId !== 'number' || !deps.allowedUserIds.includes(fromId)) {
    deps.log.warn('ccmd unauthorized tap', {
      user_id: fromId,
      data: ctx.callbackQuery.data,
    })
    await ctx.answerCallbackQuery({ text: 'не авторизовано' })
    return true
  }
  const name = parseCcmdCallback(ctx.callbackQuery.data)
  if (name === null) {
    await ctx.answerCallbackQuery({ text: 'неизвестная команда' })
    return true
  }
  if (deps.tmuxKeysTarget === undefined) {
    await ctx.answerCallbackQuery({ text: 'pane недоступен' })
    return true
  }
  // rest is always '' — the panel runs argless commands only.
  const sent = await sendSlashCommand(deps.tmuxKeysTarget, { name, rest: '' }, deps.exec)
  if (sent.ok) {
    await ctx.answerCallbackQuery({ text: `выполнено: /${name}` })
  } else {
    await ctx.answerCallbackQuery({ text: `ошибка: ${sent.error.slice(0, 180)}` })
  }
  return true
}
