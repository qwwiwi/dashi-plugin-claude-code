// /keys panel — one-tap inline-button keypad for answering Claude Code's
// NATIVE terminal dialogs (permission rules, model switch, trust prompts)
// from Telegram. The buttons are a graphical front-end to the SAME
// keystroke injection that `/key` performs: a tap presses ONE whitelisted
// key in the agent's tmux pane.
//
// Callback data uses the `kkey:` prefix so it never collides with the other
// inline flows sharing bot.on('callback_query:data'):
//   * `pgate:*` — permission-gate Allow/Deny (telegram/permission-gate-ui.ts)
//   * `ask:*`   — AskUserQuestion (telegram/ask-user-question.ts)
//   * `perm:*`  — headless MCP permission relay (channel/permissions.ts)
//
//   kkey:<token>   where <token> is ONE entry of the /key whitelist.
//
// Security: a tap is honoured ONLY for a user id in the same allow-list that
// guards the sibling `/key` OOB command (config.allowed_user_ids). Anyone
// else gets an answerCallbackQuery toast and NO keystroke is sent. The token
// set is the exact keys.ts whitelist — there is no way to inject arbitrary
// text into the pane (so a pane that dropped to a shell can't be driven to
// run a command). See server.ts bot.on('callback_query:data') for the wiring.

import {
  LITERAL_TOKEN_LIST,
  NAMED_TOKENS,
  parseKeyTokens,
  sendKeys,
  type KeysExec,
  type TmuxKeysTarget,
} from '../commands/keys.js'
import type { InlineKeyboardLike } from '../channel/tools.js'
import type { Logger } from '../log.js'

// The callback prefix. Distinct from pgate:/ask:/perm: by construction.
export const KKEY_PREFIX = 'kkey:'

// The closed set of tokens a `kkey:` callback may carry === the keys.ts
// whitelist (digits 0-9, y, n, enter, esc/escape, tab, space, arrows).
// Derived from keys.ts's FROZEN canonical structures (the literal array +
// the frozen named-token map) so there is a single source of truth: extending
// the whitelist there extends what the panel accepts, no duplicate list. We
// build this local lookup from the frozen sources rather than importing a
// mutable Set — keys.ts no longer exports one (a cast-and-`.add` Set would be
// a runtime pane-injection hole).
//
// NOTE on `esc`/`escape`: NAMED_TOKENS maps BOTH to the Escape key — they are
// intentional aliases. parseKkeyCallback therefore accepts a `kkey:escape`
// callback too, but the rendered keypad (buildKeysKeyboard) intentionally
// surfaces `esc` ONLY: one Escape button is the complete capability, a second
// `escape` button would be redundant.
const ALLOWED_TOKENS: ReadonlySet<string> = new Set<string>([
  ...LITERAL_TOKEN_LIST,
  ...Object.keys(NAMED_TOKENS),
])

// Parse a `kkey:<token>` callback_data string. Returns the validated token
// (lower-cased, single entry of the whitelist) or null for anything else —
// a non-kkey prefix, an empty token, a multi-token payload, or a token
// outside the whitelist. Null callers answer the callback with a toast and
// send NO keystroke (fail-closed).
export function parseKkeyCallback(data: string): string | null {
  if (typeof data !== 'string') return null
  if (!data.startsWith(KKEY_PREFIX)) return null
  const token = data.slice(KKEY_PREFIX.length)
  // Single token only — reject embedded separators / whitespace / sequences
  // (e.g. `1;2`, `1 enter`). The pane-injection layer takes one key per tap.
  if (token.length === 0) return null
  if (!ALLOWED_TOKENS.has(token)) return null
  return token
}

// Build the 5-row keypad. Labels are human-friendly (✓ y, ⏎ enter, arrows);
// callback_data carries the raw whitelist token the handler injects. The
// panel exposes the FULL /key whitelist (no UI/parser mismatch) — Claude Code
// dialogs literally say "Tab to amend", so omitting tab/space/0/6-9 would
// limit live recovery.
//
// Row1: dialog option selectors 1-5
// Row2: dialog option selectors 6-9 + 0
// Row3: yes/no + confirm/cancel
// Row4: arrow navigation
// Row5: tab / space (Claude Code "Tab to amend", whitespace)
export function buildKeysKeyboard(): InlineKeyboardLike {
  return {
    inline_keyboard: [
      [
        { text: '1', callback_data: `${KKEY_PREFIX}1` },
        { text: '2', callback_data: `${KKEY_PREFIX}2` },
        { text: '3', callback_data: `${KKEY_PREFIX}3` },
        { text: '4', callback_data: `${KKEY_PREFIX}4` },
        { text: '5', callback_data: `${KKEY_PREFIX}5` },
      ],
      [
        { text: '6', callback_data: `${KKEY_PREFIX}6` },
        { text: '7', callback_data: `${KKEY_PREFIX}7` },
        { text: '8', callback_data: `${KKEY_PREFIX}8` },
        { text: '9', callback_data: `${KKEY_PREFIX}9` },
        { text: '0', callback_data: `${KKEY_PREFIX}0` },
      ],
      [
        { text: '✓ y', callback_data: `${KKEY_PREFIX}y` },
        { text: '✗ n', callback_data: `${KKEY_PREFIX}n` },
        { text: '⏎ enter', callback_data: `${KKEY_PREFIX}enter` },
        { text: '⎋ esc', callback_data: `${KKEY_PREFIX}esc` },
      ],
      [
        { text: '↑ up', callback_data: `${KKEY_PREFIX}up` },
        { text: '↓ down', callback_data: `${KKEY_PREFIX}down` },
        { text: '← left', callback_data: `${KKEY_PREFIX}left` },
        { text: '→ right', callback_data: `${KKEY_PREFIX}right` },
      ],
      [
        { text: '⇥ tab', callback_data: `${KKEY_PREFIX}tab` },
        { text: '␣ space', callback_data: `${KKEY_PREFIX}space` },
      ],
    ],
  }
}

// Header text rendered above the keypad. HTML parse mode.
export const KEYS_PANEL_HEADER =
  '<b>Управление сессией</b> — тап = нажатие в моей сессии. '
  + 'Для диалога Claude Code: 1/2/3 = выбор пункта, y/n = да/нет, '
  + '⏎ подтвердить, ⎋ отмена.'

// ─────────────────────────────────────────────────────────────────────
// Callback handler (extracted from server.ts so it is unit-testable in
// isolation, mirroring permission-gate-ui.ts's handlePgateCallback). The
// security model: fail-closed auth FIRST → parse token → pane check →
// inject. A reject at ANY step toasts and sends NO keystroke. Auth precedes
// parsing so a non-allowed caller can never learn token validity.
// ─────────────────────────────────────────────────────────────────────

// Structural subset of grammY's callback_query Context the handler needs.
// `from` (and its `id`) is optional: grammY callback contexts almost always
// carry a sender, but a malformed/replayed update can omit it. A missing or
// non-number id is treated as unauthorized (fail-closed) — see
// handleKkeyCallback's auth-first gate.
export interface KkeyCallbackContext {
  callbackQuery: { data: string }
  // `id?: number | undefined` (explicit `| undefined`) so a caller may pass
  // `{ id: ctx.from?.id }` directly under exactOptionalPropertyTypes — a
  // malformed update yields `undefined`, which the handler rejects as
  // unauthorized.
  from?: { id?: number | undefined }
  answerCallbackQuery(arg: { text: string }): Promise<void>
}

export interface KkeyCallbackDeps {
  // The SAME allowlist that guards the sibling `/key` OOB text command
  // (config.allowed_user_ids). A tap is honoured only for a user id in
  // this set — fail-closed for everyone else.
  allowedUserIds: readonly number[]
  // The resolved agent pane. Undefined when the plugin can't resolve a
  // pane (no tmux config / no $TMUX env) — a tap then toasts «pane
  // недоступен» and sends nothing.
  tmuxKeysTarget?: TmuxKeysTarget
  log: Logger
  // Injected for tests; defaults to the real tmux exec inside sendKeys.
  exec?: KeysExec
}

// Dispatch a `kkey:*` callback. Always answers the callback query (so the
// Telegram spinner clears) and returns true when it consumed the event.
// NEVER injects a keystroke for a non-allowed user id (the warchief's hard
// requirement). Does NOT mutate the keyboard message — the warchief taps it
// repeatedly across a multi-step dialog.
export async function handleKkeyCallback(
  ctx: KkeyCallbackContext,
  deps: KkeyCallbackDeps,
): Promise<boolean> {
  // AUTH FIRST — the strict first decision, before parsing the token or
  // touching the pane. A non-allowed (or missing/non-number id) caller must
  // get ONLY «не авторизовано» and learn nothing about token validity or
  // pane state. Parsing first would leak which tokens are valid (a malformed
  // `kkey:rm` would surface «неизвестная клавиша») and break uniform
  // fail-closed behaviour. A missing id is treated as unauthorized.
  const fromId = ctx.from?.id
  if (typeof fromId !== 'number' || !deps.allowedUserIds.includes(fromId)) {
    deps.log.warn('kkey unauthorized tap', {
      user_id: fromId,
      data: ctx.callbackQuery.data,
    })
    await ctx.answerCallbackQuery({ text: 'не авторизовано' })
    return true
  }
  const token = parseKkeyCallback(ctx.callbackQuery.data)
  if (token === null) {
    await ctx.answerCallbackQuery({ text: 'неизвестная клавиша' })
    return true
  }
  if (deps.tmuxKeysTarget === undefined) {
    await ctx.answerCallbackQuery({ text: 'pane недоступен' })
    return true
  }
  const parsedKeys = parseKeyTokens(token)
  if ('error' in parsedKeys) {
    // Unreachable: parseKkeyCallback already validated the token against the
    // same whitelist. Handle defensively so an unexpected reject toasts and
    // still sends nothing.
    await ctx.answerCallbackQuery({ text: 'неизвестная клавиша' })
    return true
  }
  const sent = await sendKeys(deps.tmuxKeysTarget, parsedKeys, deps.exec)
  if (sent.ok) {
    await ctx.answerCallbackQuery({ text: `нажато: ${token}` })
  } else {
    await ctx.answerCallbackQuery({ text: `ошибка: ${sent.error.slice(0, 180)}` })
  }
  return true
}
