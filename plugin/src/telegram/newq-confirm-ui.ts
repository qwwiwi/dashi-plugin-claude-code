// /new confirm card — a one-tap-with-confirm destructive control.
//
// `/new` clears the current Claude Code context (it runs the native `/clear`).
// Because that is irreversible, a bare `/new` does NOT act immediately: it
// posts a confirmation card with two buttons. The tap is what actually drives
// the pane, routed through the RELIABLE `sendControlCommand` (probe → optionally
// interrupt → send → confirm), never a blind Enter.
//
// Callback data uses the `newq:` prefix so it never collides with the other
// inline flows sharing bot.on('callback_query:data'):
//   * `kkey:*`  — /keys keystroke keypad
//   * `ccmd:*`  — /cc command panel
//   * `pgate:*` — permission-gate Allow/Deny
//   * `ask:*`   — AskUserQuestion
//
//   newq:confirm — clear the context (types /clear into the pane)
//   newq:cancel  — abort, leave the session untouched
//
// Security: a tap is honoured ONLY for a user id in the same allow-list that
// guards every other session-driving control (config.allowed_user_ids). Anyone
// else gets an answerCallbackQuery toast and NOTHING is typed. Auth precedes
// parsing so a non-allowed caller learns nothing about the flow.

import {
  sendControlCommand,
  type ControlCommandResult,
  type KeysCaptureExec,
  type KeysExec,
  type TmuxKeysTarget,
} from '../commands/keys.js'
import { controlFailureMessage } from './control-result.js'
import type { InlineKeyboardLike } from '../channel/tools.js'
import type { Logger } from '../log.js'

// The callback prefix. Distinct from kkey:/ccmd:/pgate:/ask: by construction.
export const NEWQ_PREFIX = 'newq:'

// FIX-14 (Fable M2): confirm taps are only honoured within this window after the
// card was built. A stale card left in the chat scrollback can't re-fire /clear.
export const NEWQ_TTL_MS = 60_000

export type NewqAction = 'confirm' | 'cancel'

export interface ParsedNewq {
  action: NewqAction
  // The card's build-time timestamp (ms), or null for a legacy card that carries
  // no nonce (`newq:confirm` without a suffix). Used for TTL staleness.
  ts: number | null
  // IT2-5: the FULL nonce string after the action — `<ts>:<rand>` (current) or a
  // bare `<ts>` (legacy) — or null when absent. Used for double-tap dedup so two
  // cards built in the SAME millisecond (same ts, different rand) don't collide.
  nonce: string | null
}

// Parse a `newq:<action>[:<ts>[:<rand>]]` callback_data string. Returns the
// validated action + optional nonce, or null for anything else — a non-newq
// prefix, an unknown action, or a malformed nonce. Null callers answer with a
// toast and do NOTHING (fail-closed).
export function parseNewqCallback(data: string): ParsedNewq | null {
  if (typeof data !== 'string') return null
  if (!data.startsWith(NEWQ_PREFIX)) return null
  const rest = data.slice(NEWQ_PREFIX.length)
  const sep = rest.indexOf(':')
  const actionRaw = sep === -1 ? rest : rest.slice(0, sep)
  const nonceRaw = sep === -1 ? '' : rest.slice(sep + 1)
  if (actionRaw !== 'confirm' && actionRaw !== 'cancel') return null
  let ts: number | null = null
  let nonce: string | null = null
  if (nonceRaw.length > 0) {
    // Nonce shape: `<ts>` or `<ts>:<rand>`. The TS component (up to the first
    // ':') must be a positive integer — a present-but-garbage nonce is
    // fail-closed (reject), not silently ignored. The optional `<rand>` suffix
    // is opaque (dedup key only), so it is not further validated.
    const tsEnd = nonceRaw.indexOf(':')
    const tsPart = tsEnd === -1 ? nonceRaw : nonceRaw.slice(0, tsEnd)
    const n = Number(tsPart)
    if (!Number.isInteger(n) || n <= 0) return null
    ts = n
    nonce = nonceRaw
  }
  return { action: actionRaw, ts, nonce }
}

// A tap's chat is an owner DM iff it is a configured owner id AND a positive
// (DM) numeric chat id. Shared by the /new confirm + HUD callbacks (FIX-8).
// Lives here (not context-hud) so context-hud can import it without a cycle.
export function isOwnerDmChat(
  chatId: string | undefined,
  ownerChatIds: readonly (number | string)[] | undefined,
): boolean {
  // No owner set configured → skip the check (legacy single-DM / tests).
  if (ownerChatIds === undefined) return true
  if (chatId === undefined || chatId.length === 0) return false
  const n = Number(chatId)
  if (!Number.isInteger(n) || n <= 0) return false
  return ownerChatIds.some((id) => String(id) === chatId)
}

// FIX-14: a tiny consumed-nonce guard so a double/stale tap of the SAME card
// can't fire /clear twice (belt-and-suspenders alongside removing the buttons
// on first tap). `claim` returns true only the FIRST time a nonce is seen.
// TTL-swept so the map cannot grow unbounded.
export interface NewqNonceGuard {
  claim(nonce: string): boolean
}

export function createNewqNonceGuard(ttlMs: number = 5 * 60 * 1000): NewqNonceGuard {
  const seen = new Map<string, number>()
  return {
    claim(nonce: string): boolean {
      const now = Date.now()
      for (const [k, t] of seen) {
        if (now - t > ttlMs) seen.delete(k)
      }
      if (seen.has(nonce)) return false
      seen.set(nonce, now)
      return true
    },
  }
}

// Process-wide default guard (production). Tests inject their own so the shared
// module state can't couple test cases.
const defaultNonceGuard = createNewqNonceGuard()

// Build the confirm card (text + inline keyboard). Kept as a small pure helper
// (like buildKeysKeyboard) so both the /new OOB handler and unit tests render
// the exact same surface. FIX-14: the confirm button embeds a build-time nonce
// (`newq:confirm:<ts>:<rand>`) so a stale/duplicate tap can be rejected.
export function buildNewConfirmCard(): { text: string; inlineKeyboard: InlineKeyboardLike } {
  const ts = Date.now()
  // IT2-5: append a random suffix so two cards built in the SAME millisecond get
  // DISTINCT nonces. Keyed by ts alone, the second card's first tap would hit the
  // consumed-nonce guard and be wrongly refused as «уже выполнено». The suffix
  // keeps the callback_data well under Telegram's 64-byte limit.
  const rand = Math.random().toString(36).slice(2, 10)
  const nonce = `${ts}:${rand}`
  return {
    text: '<b>Новый диалог</b> — очистит текущий контекст. Продолжить?',
    inlineKeyboard: {
      inline_keyboard: [
        [{ text: 'Да, очистить', callback_data: `${NEWQ_PREFIX}confirm:${nonce}` }],
        [{ text: 'Отмена', callback_data: `${NEWQ_PREFIX}cancel` }],
      ],
    },
  }
}

// ─────────────────────────────────────────────────────────────────────
// Callback handler. Mirrors handleCcmdCallback's fail-closed shape:
// auth FIRST → parse → act. Edits the card message to the real outcome so the
// warchief sees whether the clear actually fired.
// ─────────────────────────────────────────────────────────────────────

export interface NewqCallbackContext {
  callbackQuery: { data: string }
  from?: { id?: number | undefined }
  // The chat the tap came from (FIX-8). Optional for source-compat with older
  // test stubs; when absent the owner-DM check is skipped (see deps.ownerChatIds).
  chatId?: string
  answerCallbackQuery(arg?: { text: string }): Promise<void>
  // `reply_markup` lets the handler strip the buttons on first tap (FIX-14).
  editMessageText(
    text: string,
    opts?: { parse_mode?: 'HTML'; reply_markup?: InlineKeyboardLike },
  ): Promise<void>
}

// Injectable control-command sender — defaults to the real reliable
// `sendControlCommand`. Tests pass a fake so they never touch tmux.
export type ControlSender = (
  target: TmuxKeysTarget,
  name: string,
  opts: { interruptIfBusy?: boolean; exec?: KeysExec; captureExec?: KeysCaptureExec; sleep?: (ms: number) => Promise<void> },
) => Promise<ControlCommandResult>

export interface NewqCallbackDeps {
  allowedUserIds: readonly number[]
  tmuxKeysTarget?: TmuxKeysTarget
  log: Logger
  // Injected for tests; defaults to the real reliable sender.
  sendControl?: ControlSender
  // FIX-8: owner DM chat ids (resolveOwnerChatIds). A confirm from a non-owner
  // chat is refused (the /clear drives the single global DM session). Omitted →
  // check skipped (legacy/tests).
  ownerChatIds?: readonly (number | string)[]
  // FIX-14: consumed-nonce guard. Injected for tests; defaults to the shared
  // process-wide guard.
  nonceGuard?: NewqNonceGuard
}

// Dispatch a `newq:*` callback. Always answers the callback query and returns
// true when it consumed the event. NEVER drives the pane for a non-allowed user
// id. On confirm it edits the card to the real clear outcome.
export async function handleNewqCallback(
  ctx: NewqCallbackContext,
  deps: NewqCallbackDeps,
): Promise<boolean> {
  // AUTH FIRST — before parsing or touching the pane.
  const fromId = ctx.from?.id
  if (typeof fromId !== 'number' || !deps.allowedUserIds.includes(fromId)) {
    deps.log.warn('newq unauthorized tap', {
      user_id: fromId,
      data: ctx.callbackQuery.data,
    })
    await ctx.answerCallbackQuery({ text: 'не авторизовано' })
    return true
  }
  const parsed = parseNewqCallback(ctx.callbackQuery.data)
  if (parsed === null) {
    await ctx.answerCallbackQuery({ text: 'неизвестное действие' })
    return true
  }
  if (parsed.action === 'cancel') {
    await ctx.editMessageText('Отменено', { parse_mode: 'HTML' })
    await ctx.answerCallbackQuery()
    return true
  }
  // confirm — the destructive /clear path.

  // FIX-8: a confirm only drives the pane from the OWNER DM. A tap from a
  // non-owner chat is refused (the /clear acts on the single global DM session).
  if (!isOwnerDmChat(ctx.chatId, deps.ownerChatIds)) {
    deps.log.warn('newq confirm from non-owner chat refused', {
      chat_id: ctx.chatId,
      user_id: fromId,
    })
    await ctx.answerCallbackQuery({ text: 'недоступно в этом чате' })
    return true
  }

  // FIX-14: reject a stale card. A nonce-bearing confirm older than NEWQ_TTL_MS
  // is expired — a card sitting in the scrollback must not re-fire /clear.
  if (parsed.ts !== null && Date.now() - parsed.ts > NEWQ_TTL_MS) {
    await ctx.answerCallbackQuery({ text: 'запрос устарел, повтори /new' })
    await ctx.editMessageText('<b>новый диалог</b> — запрос устарел.', { parse_mode: 'HTML' })
    return true
  }

  // FIX-14 / IT2-5: reject an already-consumed nonce (double-tap before the
  // button removal below lands). Keyed by the FULL nonce (`<ts>:<rand>`) so two
  // cards built in the same millisecond do NOT share a dedup key. Only applies to
  // nonce-bearing cards.
  if (parsed.nonce !== null) {
    const guard = deps.nonceGuard ?? defaultNonceGuard
    if (!guard.claim(parsed.nonce)) {
      await ctx.answerCallbackQuery({ text: 'уже выполнено' })
      return true
    }
  }

  if (deps.tmuxKeysTarget === undefined) {
    await ctx.answerCallbackQuery({ text: 'pane недоступен' })
    await ctx.editMessageText('<b>новый диалог</b> — pane недоступен.', { parse_mode: 'HTML' })
    return true
  }
  await ctx.answerCallbackQuery({ text: 'Очищаю…' })
  // FIX-14: strip the buttons on first tap so a stale/double tap can't re-fire.
  // Best-effort — a failed edit must not block the clear.
  try {
    await ctx.editMessageText('<b>новый диалог</b> — очищаю…', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] },
    })
  } catch (err) {
    deps.log.warn('newq button-removal edit failed (ignored)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  const send = deps.sendControl ?? sendControlCommand
  const result = await send(deps.tmuxKeysTarget, 'clear', { interruptIfBusy: true })
  const text = result.ok
    ? '<b>новый диалог</b> — контекст очищен.'
    : controlFailureMessage(result.reason)
  await ctx.editMessageText(text, { parse_mode: 'HTML' })
  return true
}
