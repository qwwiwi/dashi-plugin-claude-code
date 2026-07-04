import { describe, expect, test } from 'bun:test'

import {
  NEWQ_PREFIX,
  buildNewConfirmCard,
  createNewqNonceGuard,
  handleNewqCallback,
  parseNewqCallback,
  type ControlSender,
  type NewqCallbackContext,
  type NewqCallbackDeps,
} from '../../src/telegram/newq-confirm-ui.js'
import type { ControlCommandResult } from '../../src/commands/keys.js'
import type { Logger } from '../../src/log.js'

const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger
const ALLOWED = [164795011]
const PANE = { paneTarget: '%1', socketPath: '/tmp/s' }

function makeCtx(
  data: string,
  fromId: number | undefined,
  chatId?: string,
): {
  ctx: NewqCallbackContext
  answers: (string | undefined)[]
  edits: string[]
} {
  const answers: (string | undefined)[] = []
  const edits: string[] = []
  const ctx: NewqCallbackContext = {
    callbackQuery: { data },
    from: { id: fromId },
    ...(chatId !== undefined ? { chatId } : {}),
    answerCallbackQuery: async (arg) => {
      answers.push(arg?.text)
    },
    editMessageText: async (text) => {
      edits.push(text)
    },
  }
  return { ctx, answers, edits }
}

// A ControlSender fake that records the call and returns a scripted result.
function fakeSender(result: ControlCommandResult): { calls: string[]; sender: ControlSender } {
  const calls: string[] = []
  const sender: ControlSender = async (_target, name) => {
    calls.push(name)
    return result
  }
  return { calls, sender }
}

describe('parseNewqCallback', () => {
  test('accepts confirm / cancel (with + without nonce); rejects the rest', () => {
    expect(parseNewqCallback(`${NEWQ_PREFIX}confirm`)).toEqual({ action: 'confirm', ts: null, nonce: null })
    expect(parseNewqCallback(`${NEWQ_PREFIX}cancel`)).toEqual({ action: 'cancel', ts: null, nonce: null })
    // Legacy bare-<ts> nonce still parses (ts + nonce both set).
    expect(parseNewqCallback(`${NEWQ_PREFIX}confirm:1720000000000`)).toEqual({
      action: 'confirm',
      ts: 1720000000000,
      nonce: '1720000000000',
    })
    // IT2-5: current `<ts>:<rand>` nonce — ts parsed for TTL, full string kept.
    expect(parseNewqCallback(`${NEWQ_PREFIX}confirm:1720000000000:ab12cd`)).toEqual({
      action: 'confirm',
      ts: 1720000000000,
      nonce: '1720000000000:ab12cd',
    })
    expect(parseNewqCallback(`${NEWQ_PREFIX}nope`)).toBeNull()
    expect(parseNewqCallback('ccmd:compact')).toBeNull()
    expect(parseNewqCallback(`${NEWQ_PREFIX}`)).toBeNull()
    // A present-but-garbage nonce is fail-closed (rejected).
    expect(parseNewqCallback(`${NEWQ_PREFIX}confirm:abc`)).toBeNull()
    // @ts-expect-error runtime guard for non-string
    expect(parseNewqCallback(undefined)).toBeNull()
  })
})

describe('buildNewConfirmCard', () => {
  test('two buttons: confirm carries a nonce, cancel is plain', () => {
    const card = buildNewConfirmCard()
    expect(card.text).toContain('Новый диалог')
    const datas = card.inlineKeyboard.inline_keyboard.flat().map((b) => b.callback_data)
    // IT2-5: confirm nonce is `<ts>:<rand>`.
    expect(datas[0]).toMatch(/^newq:confirm:\d+:[a-z0-9]+$/)
    expect(datas[1]).toBe(`${NEWQ_PREFIX}cancel`)
  })
})

describe('handleNewqCallback', () => {
  test('unauthorized user id → toast, NO clear, NO edit', async () => {
    const { calls, sender } = fakeSender({ ok: true })
    const deps: NewqCallbackDeps = { allowedUserIds: ALLOWED, tmuxKeysTarget: PANE, log, sendControl: sender }
    const { ctx, answers, edits } = makeCtx(`${NEWQ_PREFIX}confirm`, 999)
    await handleNewqCallback(ctx, deps)
    expect(calls.length).toBe(0)
    expect(edits.length).toBe(0)
    expect(answers[0]).toContain('не авторизовано')
  })

  test('missing id is unauthorized (fail-closed)', async () => {
    const { calls, sender } = fakeSender({ ok: true })
    const deps: NewqCallbackDeps = { allowedUserIds: ALLOWED, tmuxKeysTarget: PANE, log, sendControl: sender }
    const { ctx, answers } = makeCtx(`${NEWQ_PREFIX}confirm`, undefined)
    await handleNewqCallback(ctx, deps)
    expect(calls.length).toBe(0)
    expect(answers[0]).toContain('не авторизовано')
  })

  test('confirm ok → clears + edits card to «контекст очищен»', async () => {
    const { calls, sender } = fakeSender({ ok: true })
    const deps: NewqCallbackDeps = { allowedUserIds: ALLOWED, tmuxKeysTarget: PANE, log, sendControl: sender }
    const { ctx, answers, edits } = makeCtx(`${NEWQ_PREFIX}confirm`, ALLOWED[0]!)
    await handleNewqCallback(ctx, deps)
    expect(calls).toEqual(['clear'])
    expect(answers[0]).toContain('Очищаю')
    // FIX-14: buttons are stripped first (an «очищаю…» edit), then the result.
    expect(edits.some((e) => e.includes('контекст очищен'))).toBe(true)
  })

  test('confirm busy → edits card to the busy failure message', async () => {
    const { sender } = fakeSender({ ok: false, reason: 'busy' })
    const deps: NewqCallbackDeps = { allowedUserIds: ALLOWED, tmuxKeysTarget: PANE, log, sendControl: sender }
    const { ctx, edits } = makeCtx(`${NEWQ_PREFIX}confirm`, ALLOWED[0]!)
    await handleNewqCallback(ctx, deps)
    expect(edits.some((e) => e.includes('агент занят'))).toBe(true)
  })

  test('cancel → edits card to «Отменено», no clear', async () => {
    const { calls, sender } = fakeSender({ ok: true })
    const deps: NewqCallbackDeps = { allowedUserIds: ALLOWED, tmuxKeysTarget: PANE, log, sendControl: sender }
    const { ctx, edits } = makeCtx(`${NEWQ_PREFIX}cancel`, ALLOWED[0]!)
    await handleNewqCallback(ctx, deps)
    expect(calls.length).toBe(0)
    expect(edits[0]).toBe('Отменено')
  })

  test('confirm with no pane → toast + edit, no clear', async () => {
    const { calls, sender } = fakeSender({ ok: true })
    const deps: NewqCallbackDeps = { allowedUserIds: ALLOWED, log, sendControl: sender }
    const { ctx, answers, edits } = makeCtx(`${NEWQ_PREFIX}confirm`, ALLOWED[0]!)
    await handleNewqCallback(ctx, deps)
    expect(calls.length).toBe(0)
    expect(answers[0]).toContain('pane недоступен')
    expect(edits[0]).toContain('pane недоступен')
  })

  // ─── FIX-14: nonce staleness + double-tap dedup ──────────────────────────

  test('expired confirm nonce (>60s) → refused, NO clear', async () => {
    const { calls, sender } = fakeSender({ ok: true })
    const deps: NewqCallbackDeps = { allowedUserIds: ALLOWED, tmuxKeysTarget: PANE, log, sendControl: sender }
    const staleTs = Date.now() - 120_000 // 2 min old
    const { ctx, answers, edits } = makeCtx(`${NEWQ_PREFIX}confirm:${staleTs}`, ALLOWED[0]!)
    await handleNewqCallback(ctx, deps)
    expect(calls.length).toBe(0)
    expect(answers[0]).toContain('устарел')
    expect(edits.some((e) => e.includes('устарел'))).toBe(true)
  })

  test('fresh nonce → clears; a SECOND tap of the same nonce is refused', async () => {
    const { calls, sender } = fakeSender({ ok: true })
    const guard = createNewqNonceGuard()
    const ts = Date.now()
    const data = `${NEWQ_PREFIX}confirm:${ts}`
    const deps: NewqCallbackDeps = {
      allowedUserIds: ALLOWED,
      tmuxKeysTarget: PANE,
      log,
      sendControl: sender,
      nonceGuard: guard,
    }
    // First tap fires the clear.
    const first = makeCtx(data, ALLOWED[0]!)
    await handleNewqCallback(first.ctx, deps)
    expect(calls).toEqual(['clear'])
    // Second (double) tap of the SAME card is refused — clear runs only once.
    const second = makeCtx(data, ALLOWED[0]!)
    await handleNewqCallback(second.ctx, deps)
    expect(calls).toEqual(['clear']) // still just one
    expect(second.answers[0]).toContain('уже выполнено')
  })

  // IT2-5: two cards built in the SAME millisecond carry the same <ts> but a
  // DIFFERENT <rand>, so their FULL nonces differ. Both first-taps must fire —
  // the second card must NOT be swallowed as «уже выполнено».
  test('two same-ms cards (same ts, different rand) → BOTH first taps fire', async () => {
    const { calls, sender } = fakeSender({ ok: true })
    const guard = createNewqNonceGuard()
    const ts = Date.now()
    const deps: NewqCallbackDeps = {
      allowedUserIds: ALLOWED,
      tmuxKeysTarget: PANE,
      log,
      sendControl: sender,
      nonceGuard: guard,
    }
    const cardA = makeCtx(`${NEWQ_PREFIX}confirm:${ts}:aaaa1111`, ALLOWED[0]!)
    const cardB = makeCtx(`${NEWQ_PREFIX}confirm:${ts}:bbbb2222`, ALLOWED[0]!)
    await handleNewqCallback(cardA.ctx, deps)
    await handleNewqCallback(cardB.ctx, deps)
    // Distinct nonces → neither is deduped away → clear fired for BOTH.
    expect(calls).toEqual(['clear', 'clear'])
    expect(cardB.answers.some((a) => a?.includes('уже выполнено'))).toBe(false)
  })

  // ─── FIX-8: owner-DM scoping ─────────────────────────────────────────────

  test('confirm from a NON-owner chat → refused, NO clear', async () => {
    const { calls, sender } = fakeSender({ ok: true })
    const deps: NewqCallbackDeps = {
      allowedUserIds: ALLOWED,
      tmuxKeysTarget: PANE,
      log,
      sendControl: sender,
      ownerChatIds: [164795011],
    }
    // Tap arrives from a group chat (negative id) — not the owner DM.
    const { ctx, answers } = makeCtx(`${NEWQ_PREFIX}confirm`, ALLOWED[0]!, '-1001234567890')
    await handleNewqCallback(ctx, deps)
    expect(calls.length).toBe(0)
    expect(answers[0]).toContain('недоступно')
  })

  test('confirm from the owner DM → clears', async () => {
    const { calls, sender } = fakeSender({ ok: true })
    const deps: NewqCallbackDeps = {
      allowedUserIds: ALLOWED,
      tmuxKeysTarget: PANE,
      log,
      sendControl: sender,
      ownerChatIds: [164795011],
    }
    const { ctx } = makeCtx(`${NEWQ_PREFIX}confirm`, ALLOWED[0]!, '164795011')
    await handleNewqCallback(ctx, deps)
    expect(calls).toEqual(['clear'])
  })
})
