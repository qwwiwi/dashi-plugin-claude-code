// Autonomy M2 — AskUserQuestion lease-card grant path + timeout registration.
//
// Drives the real relay + UI (createAskUserQuestionUi) against a fake Telegram
// and a real on-disk autonomy registry (temp dir). Covers:
//   * affirmative tap on a [LEASE:] card → lease minted (scope/ttl/binding)
//   * marker stripped from what Telegram renders
//   * non-affirmative tap → no lease
//   * non-lease card → no lease
//   * idempotent double-relay-submit → one lease (grantSourceId guard)
//   * timeout → open question auto-registered (marker-stripped summary)

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createAskUserQuestionUi,
  type AskCallbackContext,
  type AskUserQuestionUi,
} from '../../src/telegram/ask-user-question.js'
import {
  createAskUserQuestionRelay,
  type AskQuestion,
  type AskUserQuestionRelay,
} from '../../src/channel/ask-user-question.js'
import { activeLeases, loadAutonomyState, openQuestions } from '../../src/autonomy/store.js'
import type { AppConfig } from '../../src/config.js'
import type { Logger } from '../../src/log.js'
import type {
  ChatAction,
  DownloadResult,
  EditOpts,
  SendDocumentOpts,
  SendMessageOpts,
  TelegramApi,
} from '../../src/channel/tools.js'

const OWNER = 164795011
const CHAT = String(OWNER)

function silentLog(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

interface Sends {
  sendCalls: { chatId: string; text: string; opts: SendMessageOpts }[]
  editCalls: { chatId: string; messageId: number; text: string; opts: EditOpts }[]
  nextMessageId: number
}

function fakeTelegram(state: Sends): TelegramApi {
  return {
    async sendMessage(chatId, text, opts) {
      state.sendCalls.push({ chatId, text, opts })
      const id = state.nextMessageId++
      return { message_id: id }
    },
    async sendRichMessage() {
      return { fallback: true as const }
    },
    async editMessageText(chatId, messageId, text, opts) {
      state.editCalls.push({ chatId, messageId, text, opts })
    },
    async setMessageReaction() {},
    async sendChatAction(_c: string, _a: ChatAction) {},
    async sendDocument(_c: string, _f: string, _o: SendDocumentOpts) {
      return { message_id: 0 }
    },
    async sendPhoto(_c: string, _f: string, _o: SendDocumentOpts) {
      return { message_id: 0 }
    },
    async downloadFile(_id: string, _d: string): Promise<DownloadResult> {
      return { path: '/tmp/x' }
    },
    async answerGuestQuery() {},
    async deleteMessage() {},
  }
}

function mkConfig(): AppConfig {
  return {
    bot_id: 8507713167,
    dm_only: true,
    allowed_user_ids: [OWNER],
    allowed_chat_ids: [OWNER],
    permission_relay: { enabled: true, allowed_user_ids: [OWNER], bash_only_proof: true },
    ask_user_question: { enabled: true, timeout_ms: 300_000, max_preview_chars: 1000 },
  } as unknown as AppConfig
}

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-ask-lease-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

interface Harness {
  ui: AskUserQuestionUi
  relay: AskUserQuestionRelay
  send: Sends
}

function mkHarness(): Harness {
  const send: Sends = { sendCalls: [], editCalls: [], nextMessageId: 5000 }
  const api = fakeTelegram(send)
  let uiRef: AskUserQuestionUi | undefined
  const relay = createAskUserQuestionRelay({
    log: silentLog(),
    onSettle: (e) => {
      void uiRef?.handleSettle(e)
    },
  })
  const ui = createAskUserQuestionUi({
    config: mkConfig(),
    log: silentLog(),
    telegramApi: api,
    relay,
    autonomyPaths: { root },
  })
  uiRef = ui
  return { ui, relay, send }
}

// Submit a question and render it; returns the requestId + the sent message id.
async function submitAndRender(
  h: Harness,
  question: string,
  options: { label: string }[],
): Promise<{ requestId: string; messageId: number }> {
  const q: AskQuestion = { question, options }
  const { requestId } = h.relay.submit({ toolUseId: `t-${Math.random()}`, sessionId: 's', questions: [q], chatId: CHAT })
  if (requestId === undefined) throw new Error('no requestId')
  await h.ui.startQuestion(requestId)
  const messageId = h.relay.getPending(requestId)!.telegramMessageId!
  return { requestId, messageId }
}

function tap(requestId: string, optionIndex: number, messageId: number): AskCallbackContext {
  const acks: unknown[] = []
  return {
    callbackQuery: { data: `ask:choose:${requestId}:0:${optionIndex}` },
    from: { id: OWNER },
    chatId: CHAT,
    callbackMessageId: messageId,
    answerCallbackQuery: async (arg?: { text?: string }) => {
      acks.push(arg)
    },
  }
}

describe('ask-card lease grant', () => {
  test('affirmative tap on a [LEASE:] card mints a lease with scope/ttl/binding', async () => {
    const h = mkHarness()
    const { requestId, messageId } = await submitAndRender(
      h,
      '[LEASE: деплой стейджинга; ttl=48h] Разрешаешь деплой?',
      [{ label: 'Да' }, { label: 'Нет' }],
    )
    await h.ui.handleAskCallback(tap(requestId, 0, messageId))

    const state = loadAutonomyState({ root }, CHAT)
    const leases = activeLeases(state, Date.now())
    expect(leases.length).toBe(1)
    expect(leases[0]!.scope).toBe('деплой стейджинга')
    expect(leases[0]!.source).toBe('ask_card')
    expect(leases[0]!.grantSourceId).toBe(`ask:${requestId}:0`)
    expect(leases[0]!.chatId).toBe(CHAT)
    expect(leases[0]!.grantorMessageId).toBe(messageId)
    // ttl≈48h.
    const ttlH = (leases[0]!.expiresAtMs - leases[0]!.grantedAtMs) / 3_600_000
    expect(Math.round(ttlH)).toBe(48)
  })

  test('marker is stripped from the rendered Telegram card', async () => {
    const h = mkHarness()
    await submitAndRender(h, '[LEASE: deploy] Разрешаешь?', [{ label: 'Да' }, { label: 'Нет' }])
    const body = h.send.sendCalls[0]!.text
    expect(body).not.toContain('[LEASE')
    expect(body).toContain('Разрешаешь?')
  })

  test('non-affirmative tap → no lease', async () => {
    const h = mkHarness()
    const { requestId, messageId } = await submitAndRender(
      h,
      '[LEASE: deploy] Разрешаешь?',
      [{ label: 'Да' }, { label: 'Нет' }],
    )
    await h.ui.handleAskCallback(tap(requestId, 1, messageId)) // «Нет»
    expect(loadAutonomyState({ root }, CHAT).leases.length).toBe(0)
  })

  test('affirmative tap on a NON-lease card → no lease', async () => {
    const h = mkHarness()
    const { requestId, messageId } = await submitAndRender(
      h,
      'Обычный вопрос без маркера?',
      [{ label: 'Да' }, { label: 'Нет' }],
    )
    await h.ui.handleAskCallback(tap(requestId, 0, messageId))
    expect(loadAutonomyState({ root }, CHAT).leases.length).toBe(0)
  })

  test('supersede marker revokes a differing active lease', async () => {
    const h = mkHarness()
    // First lease.
    {
      const { requestId, messageId } = await submitAndRender(h, '[LEASE: old scope] q1?', [{ label: 'Да' }, { label: 'Нет' }])
      await h.ui.handleAskCallback(tap(requestId, 0, messageId))
    }
    // Second lease with ; supersede.
    {
      const { requestId, messageId } = await submitAndRender(h, '[LEASE: new scope; supersede] q2?', [{ label: 'Да' }, { label: 'Нет' }])
      await h.ui.handleAskCallback(tap(requestId, 0, messageId))
    }
    const active = activeLeases(loadAutonomyState({ root }, CHAT), Date.now())
    expect(active.map((l) => l.scope)).toEqual(['new scope'])
  })
})

describe('ask-card timeout → open question registered', () => {
  test('a timed-out question is registered with a marker-stripped summary', async () => {
    const h = mkHarness()
    const q: AskQuestion = {
      question: '[LEASE: deploy] Разрешаешь деплой прямо сейчас?',
      options: [{ label: 'Да' }, { label: 'Нет' }],
    }
    const { requestId } = h.relay.submit({ toolUseId: 't-timeout', sessionId: 's', questions: [q], chatId: CHAT })
    await h.ui.startQuestion(requestId!)
    // Force the timeout path (settles + fires onSettle → handleSettle).
    h.relay.expire(requestId!, 'test timeout')
    // onSettle is fire-and-forget; give the microtask queue a tick to flush.
    await new Promise((r) => setTimeout(r, 20))

    const qs = openQuestions(loadAutonomyState({ root }, CHAT))
    expect(qs.length).toBe(1)
    expect(qs[0]!.summary).toBe('Разрешаешь деплой прямо сейчас?')
    expect(qs[0]!.summary).not.toContain('[LEASE')
    expect(qs[0]!.sticky).not.toBe(true)
    expect(qs[0]!.defaultAction).toBeUndefined()
  })
})
