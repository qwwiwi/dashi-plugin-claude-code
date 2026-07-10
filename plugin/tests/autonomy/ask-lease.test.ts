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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_BODY_CHARS,
  renderClosedQuestionBody,
  createAskUserQuestionUi,
  type AskCallbackContext,
  type AskUserQuestionUi,
} from '../../src/telegram/ask-user-question.js'
import {
  createAskUserQuestionRelay,
  type AskQuestion,
  type AskUserQuestionRelay,
} from '../../src/channel/ask-user-question.js'
import { activeLeases, computeScopeDigest, loadAutonomyState, openQuestions } from '../../src/autonomy/store.js'
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

function mkHarness(opts: { withAutonomy?: boolean } = {}): Harness {
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
    ...(opts.withAutonomy === false ? {} : { autonomyPaths: { root } }),
  })
  uiRef = ui
  return { ui, relay, send }
}

// Simulated RESTART of the UI layer (fix-loop-2 #1): a FRESH factory (empty
// in-memory cache) over the SAME relay and the SAME state root — the durable
// ask-intents file is the only carrier of the grant intent across it.
function restartUi(h: Harness): Harness {
  const send: Sends = { sendCalls: [], editCalls: [], nextMessageId: 9000 }
  const api = fakeTelegram(send)
  const ui = createAskUserQuestionUi({
    config: mkConfig(),
    log: silentLog(),
    telegramApi: api,
    relay: h.relay,
    autonomyPaths: { root },
  })
  return { ui, relay: h.relay, send }
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

  test('OPEN card shows the mandate block built from parsed fields (fix-loop #1 CRITICAL)', async () => {
    const h = mkHarness()
    await submitAndRender(
      h,
      '[LEASE: полный прод-доступ; ttl=72h; supersede] Разрешаешь проверить staging?',
      [{ label: 'Да' }, { label: 'Нет' }],
    )
    const body = h.send.sendCalls[0]!.text
    // The raw marker is stripped…
    expect(body).not.toContain('[LEASE')
    // …but the GRANTED scope is explicitly visible — the exploit (hidden
    // scope behind an innocuous question) is dead.
    expect(body).toContain('Мандат автономии')
    expect(body).toContain('полный прод-доступ')
    expect(body).toContain('ttl 72ч')
    expect(body).toContain('заменит действующий мандат')
    expect(body).toContain('Тап «Да» выдаст этот мандат')
    expect(body).toContain('Разрешаешь проверить staging?')
  })

  test('CLOSED card (after tap) still shows the granted scope', async () => {
    const h = mkHarness()
    const { requestId, messageId } = await submitAndRender(
      h,
      '[LEASE: деплой стейджинга] Разрешаешь?',
      [{ label: 'Да' }, { label: 'Нет' }],
    )
    await h.ui.handleAskCallback(tap(requestId, 0, messageId))
    const closed = h.send.editCalls.find((e) => e.messageId === messageId)
    expect(closed).toBeDefined()
    expect(closed!.text).toContain('Мандат автономии')
    expect(closed!.text).toContain('деплой стейджинга')
    expect(closed!.text).not.toContain('[LEASE')
  })

  test('tap grants EXACTLY the rendered snapshot scope', async () => {
    const h = mkHarness()
    const { requestId, messageId } = await submitAndRender(
      h,
      '[LEASE: аудит платежей] Разрешаешь?',
      [{ label: 'Да' }, { label: 'Нет' }],
    )
    const rendered = h.send.sendCalls[0]!.text
    await h.ui.handleAskCallback(tap(requestId, 0, messageId))
    const lease = activeLeases(loadAutonomyState({ root }, CHAT), Date.now())[0]!
    // The granted scope is byte-identical to the parsed intent the card showed.
    expect(lease.scope).toBe('аудит платежей')
    expect(rendered).toContain(`«${lease.scope}»`)
  })

  test('INVALID marker (bad ttl / unknown segment) → normal question: raw text shown, tap grants NOTHING', async () => {
    const h = mkHarness()
    for (const [i, q] of [
      '[LEASE: deploy; ttl=200h] Разрешаешь?', // ttl over cap — invalid, not clamped
      '[LEASE: аудит; production] Разрешаешь?', // unknown segment — invalid
    ].entries()) {
      const { requestId, messageId } = await submitAndRender(h, q, [{ label: 'Да' }, { label: 'Нет' }])
      const body = h.send.sendCalls.at(-1)!.text
      // Honest raw render — the owner SEES the malformed marker, no block.
      expect(body).toContain('[LEASE')
      expect(body).not.toContain('Мандат автономии')
      await h.ui.handleAskCallback(tap(requestId, 0, messageId))
      expect(loadAutonomyState({ root }, CHAT).leases.length).toBe(0)
      void i
    }
  })

  test('multiSelect card with a marker is NEVER grant-capable (fail-closed)', async () => {
    const h = mkHarness()
    const q: AskQuestion = {
      question: '[LEASE: deploy] Что разрешаешь?',
      multiSelect: true,
      options: [{ label: 'Да' }, { label: 'Нет' }],
    }
    const { requestId } = h.relay.submit({ toolUseId: 't-ms', sessionId: 's', questions: [q], chatId: CHAT })
    await h.ui.startQuestion(requestId!)
    const body = h.send.sendCalls.at(-1)!.text
    expect(body).toContain('[LEASE') // raw — not grant-capable
    expect(body).not.toContain('Мандат автономии')
    const messageId = h.relay.getPending(requestId!)!.telegramMessageId!
    // A `choose` tap on a multiSelect question is a toggle — must not grant.
    await h.ui.handleAskCallback(tap(requestId!, 0, messageId))
    expect(loadAutonomyState({ root }, CHAT).leases.length).toBe(0)
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

describe('grant outcome feedback (fix-loop #7 — never silent)', () => {
  test('successful grant → owner gets «Мандат L-… выдан до …»', async () => {
    const h = mkHarness()
    const { requestId, messageId } = await submitAndRender(
      h,
      '[LEASE: deploy] Разрешаешь?',
      [{ label: 'Да' }, { label: 'Нет' }],
    )
    await h.ui.handleAskCallback(tap(requestId, 0, messageId))
    const lease = loadAutonomyState({ root }, CHAT).leases[0]!
    const feedback = h.send.sendCalls.map((c) => c.text).find((t) => t.includes('выдан до'))
    expect(feedback).toBeDefined()
    expect(feedback!).toContain(`Мандат ${lease.id} выдан до `)
    expect(feedback!).toContain('UTC')
  })

  test('registry failure → owner gets «Мандат НЕ выдан: …»', async () => {
    const h = mkHarness()
    const { requestId, messageId } = await submitAndRender(
      h,
      '[LEASE: deploy] Разрешаешь?',
      [{ label: 'Да' }, { label: 'Нет' }],
    )
    // Make the registry read-only AFTER the card is up: unsupported version.
    writeFileSync(
      join(root, `autonomy-${CHAT}.json`),
      JSON.stringify({ version: 2, revision: 1, leases: [], questions: [] }),
      'utf8',
    )
    await h.ui.handleAskCallback(tap(requestId, 0, messageId))
    const feedback = h.send.sendCalls.map((c) => c.text).find((t) => t.includes('Мандат НЕ выдан'))
    expect(feedback).toBeDefined()
    expect(feedback!).toContain('version_unsupported')
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

  test('IDEMPOTENT: a duplicate settle registers exactly one question (fix-loop #4)', async () => {
    const h = mkHarness()
    const event = {
      requestId: 'abcde',
      toolUseId: 't-1',
      status: 'timeout' as const,
      chatId: CHAT,
      telegramMessageId: undefined,
      currentIndex: 0,
      totalQuestions: 1,
      questionText: 'Вопрос без ответа?',
      questionMultiSelect: undefined,
      reason: 'test',
    }
    await h.ui.handleSettle(event)
    await h.ui.handleSettle(event) // replayed settle → no-op
    const qs = openQuestions(loadAutonomyState({ root }, CHAT))
    expect(qs.length).toBe(1)
    // Deterministic id derived from the settle identity.
    expect(qs[0]!.id).toBe('Q-ask-abcde-0')
  })
})

describe('durable intent — restart survival (fix-loop-2 #1 CRITICAL)', () => {
  test('after a UI restart the tap grants EXACTLY the persisted scope and the closed card shows it', async () => {
    const h = mkHarness()
    const { requestId, messageId } = await submitAndRender(
      h,
      '[LEASE: деплой стейджинга; ttl=48h] Разрешаешь?',
      [{ label: 'Да' }, { label: 'Нет' }],
    )
    // RESTART: fresh factory, empty in-memory cache, same state root.
    const h2 = restartUi(h)
    await h2.ui.handleAskCallback(tap(requestId, 0, messageId))
    const leases = activeLeases(loadAutonomyState({ root }, CHAT), Date.now())
    expect(leases.length).toBe(1)
    expect(leases[0]!.scope).toBe('деплой стейджинга')
    // Closed card rendered by the restarted UI still shows the same scope.
    const closed = h2.send.editCalls.find((e) => e.messageId === messageId)
    expect(closed).toBeDefined()
    expect(closed!.text).toContain('деплой стейджинга')
  })

  test('the DISK record is the only grant source — an edited record wins over the question text', async () => {
    const h = mkHarness()
    const { requestId, messageId } = await submitAndRender(
      h,
      '[LEASE: original scope] Разрешаешь?',
      [{ label: 'Да' }, { label: 'Нет' }],
    )
    // Simulate a parser/deploy divergence: rewrite the persisted intent.
    const file = join(root, `ask-lease-intents-${CHAT}.json`)
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      intents: Record<string, { scope: string; scopeDigest: string }>
    }
    const key = `${requestId}:0`
    parsed.intents[key]!.scope = 'edited scope'
    parsed.intents[key]!.scopeDigest = computeScopeDigest('edited scope')
    writeFileSync(file, JSON.stringify(parsed), 'utf8')
    const h2 = restartUi(h)
    await h2.ui.handleAskCallback(tap(requestId, 0, messageId))
    const leases = activeLeases(loadAutonomyState({ root }, CHAT), Date.now())
    // Granted from the persisted record, NOT from re-parsing the question.
    expect(leases.map((l) => l.scope)).toEqual(['edited scope'])
  })

  test('legacy/lost intent → fail-closed: no grant, «intent утерян» on closed card and as feedback', async () => {
    const h = mkHarness()
    const { requestId, messageId } = await submitAndRender(
      h,
      '[LEASE: deploy] Разрешаешь?',
      [{ label: 'Да' }, { label: 'Нет' }],
    )
    // Lose the durable record (restart happened before/without persist).
    rmSync(join(root, `ask-lease-intents-${CHAT}.json`), { force: true })
    const h2 = restartUi(h)
    await h2.ui.handleAskCallback(tap(requestId, 0, messageId))
    expect(loadAutonomyState({ root }, CHAT).leases.length).toBe(0)
    const closed = h2.send.editCalls.find((e) => e.messageId === messageId)
    expect(closed).toBeDefined()
    expect(closed!.text).toContain('Мандат НЕ выдан: intent утерян (рестарт)')
    const feedback = h2.send.sendCalls.map((c) => c.text).find((t) => t.includes('intent утерян'))
    expect(feedback).toBeDefined()
  })
})

describe('no silent grant-capable cards (fix-loop-2 #3)', () => {
  test('factory WITHOUT autonomyPaths → card is a normal question (no block), tap grants nothing', async () => {
    const h = mkHarness({ withAutonomy: false })
    const { requestId, messageId } = await submitAndRender(
      h,
      '[LEASE: deploy] Разрешаешь?',
      [{ label: 'Да' }, { label: 'Нет' }],
    )
    const body = h.send.sendCalls[0]!.text
    expect(body).not.toContain('Мандат автономии') // NOT grant-capable
    expect(body).toContain('[LEASE') // honest raw render
    expect(body).toContain('тап мандат НЕ выдаст')
    await h.ui.handleAskCallback(tap(requestId, 0, messageId))
    expect(loadAutonomyState({ root }, CHAT).leases.length).toBe(0)
  })
})

describe('runtime registry failure on tap (fix-loop-2 #3)', () => {
  test('grant-capable card + registry gone at tap → «Мандат НЕ выдан: реестр недоступен»', async () => {
    // Build a UI whose deps object we keep, so autonomyPaths can vanish
    // AFTER card creation (runtime-only failure — impossible via config, but
    // must still be visible, never silent).
    const send: Sends = { sendCalls: [], editCalls: [], nextMessageId: 7000 }
    const api = fakeTelegram(send)
    const relay = createAskUserQuestionRelay({ log: silentLog() })
    const deps = {
      config: mkConfig(),
      log: silentLog(),
      telegramApi: api,
      relay,
      autonomyPaths: { root } as { root: string } | undefined,
    }
    const ui = createAskUserQuestionUi(deps as Parameters<typeof createAskUserQuestionUi>[0])
    const q: AskQuestion = { question: '[LEASE: deploy] Разрешаешь?', options: [{ label: 'Да' }, { label: 'Нет' }] }
    const { requestId } = relay.submit({ toolUseId: 't-rt', sessionId: 's', questions: [q], chatId: CHAT })
    await ui.startQuestion(requestId!)
    const body = send.sendCalls[0]!.text
    expect(body).toContain('Мандат автономии') // card WAS grant-capable
    const messageId = relay.getPending(requestId!)!.telegramMessageId!
    // Registry vanishes at runtime.
    deps.autonomyPaths = undefined
    await ui.handleAskCallback(tap(requestId!, 0, messageId))
    expect(loadAutonomyState({ root }, CHAT).leases.length).toBe(0)
    const feedback = send.sendCalls.map((c) => c.text).find((t) => t.includes('реестр недоступен'))
    expect(feedback).toBeDefined()
    expect(feedback!).toContain('Мандат НЕ выдан')
  })
})

describe('closed-card body budget (fix-loop-2 #2)', () => {
  test('maximally-escaping 400cp scope: closed body stays under MAX_BODY_CHARS', () => {
    const scope = '&'.repeat(400) // escapes 5x → 2000 chars
    const intent = {
      scope,
      ttlHours: 24,
      supersede: false,
      displayText: '&'.repeat(900), // question text also expands hard
    }
    const outcome = `✅ Ответ: <b>${'&amp;'.repeat(100)}</b>`
    const body = renderClosedQuestionBody('raw?', 0, 1, outcome, { leaseIntent: intent })
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS)
    // The mandate scope is NEVER the truncated part.
    expect(body).toContain('&amp;'.repeat(400))
    expect(body).toContain('ttl 24ч')
  })

  test('quote-heavy scope (6x escape expansion) also fits', () => {
    const scope = '"'.repeat(400) // &quot; → 2400 chars
    const intent = { scope, ttlHours: 24, supersede: false, displayText: 'q?' }
    const body = renderClosedQuestionBody('raw?', 0, 1, '✅ Ответ: <b>Да</b>', { leaseIntent: intent })
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS)
    expect(body).toContain('&quot;'.repeat(400))
  })
})
