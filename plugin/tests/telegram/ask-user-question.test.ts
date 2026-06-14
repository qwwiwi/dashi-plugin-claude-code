// PRX-1 TASK-2 — tests for the AskUserQuestion Telegram UX.
//
// Coverage targets (per task brief):
//   * Render single-select question: body + N+1 keyboard rows (options + Other)
//   * Render multiSelect question:    body + N+2 keyboard rows (+ Done),
//                                     label prefixes show [ ] / [x]
//   * Callback ask:choose:.. → relay.answerChoice, keyboard cleared
//   * Callback ask:toggle:.. → relay.toggle, message re-rendered with updated label
//   * Callback ask:other:..  → "Введи ответ текстом" sent, awaiting set
//   * Text follow-up → relay.answerOther called, awaiting cleared
//   * Unauthorized callback → answerCallbackQuery deny + audit log; no relay mutation
//   * Malformed `ask:bogus:foo` → ignored, no relay calls

import { describe, expect, test } from 'bun:test'

import {
  buildQuestionKeyboard,
  createAskUserQuestionUi,
  parseAskCallback,
  renderQuestionBody,
  type AskCallbackContext,
} from '../../src/telegram/ask-user-question.js'
import { createAskUserQuestionRelay } from '../../src/channel/ask-user-question.js'
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

// ─────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────

function silentLog(): Logger {
  const events: { level: string; msg: string; fields?: unknown }[] = []
  return {
    debug: (msg, fields) => events.push({ level: 'debug', msg, fields }),
    info: (msg, fields) => events.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => events.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => events.push({ level: 'error', msg, fields }),
  }
}

function spyLog(): { log: Logger; events: { level: string; msg: string; fields?: unknown }[] } {
  const events: { level: string; msg: string; fields?: unknown }[] = []
  const log: Logger = {
    debug: (msg, fields) => events.push({ level: 'debug', msg, fields }),
    info: (msg, fields) => events.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => events.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => events.push({ level: 'error', msg, fields }),
  }
  return { log, events }
}

interface FakeTelegramSends {
  sendCalls: { chatId: string; text: string; opts: SendMessageOpts }[]
  editCalls: { chatId: string; messageId: number; text: string; opts: EditOpts }[]
  nextMessageId: number
}

function fakeTelegram(state: FakeTelegramSends, opts?: { editThrows?: boolean }): TelegramApi {
  return {
    async sendMessage(chatId, text, sendOpts) {
      state.sendCalls.push({ chatId, text, opts: sendOpts })
      const id = state.nextMessageId
      state.nextMessageId += 1
      return { message_id: id }
    },
    async sendRichMessage(_chatId, _rawMarkdown, _opts) {
      return { fallback: true as const }
    },
    async editMessageText(chatId, messageId, text, editOpts) {
      state.editCalls.push({ chatId, messageId, text, opts: editOpts })
      if (opts?.editThrows) throw new Error('edit refused for test')
    },
    async setMessageReaction(_chatId: string, _messageId: number, _emoji: string): Promise<void> {
      /* no-op */
    },
    async sendChatAction(_chatId: string, _action: ChatAction): Promise<void> {
      /* no-op */
    },
    async sendDocument(_chatId: string, _filePath: string, _o: SendDocumentOpts) {
      return { message_id: 0 }
    },
    async sendPhoto(_chatId: string, _filePath: string, _o: SendDocumentOpts) {
      return { message_id: 0 }
    },
    async downloadFile(_fileId: string, _destDir: string): Promise<DownloadResult> {
      return { path: '/tmp/x' }
    },
    async deleteMessage(_chatId: string, _messageId: number): Promise<void> {
      /* no-op */
    },
  }
}

function mkConfig(overrides: { allowedUserIds?: number[]; maxPreview?: number; timeoutMs?: number } = {}): AppConfig {
  // Build a minimal AppConfig that exercises only the surfaces this UI
  // touches. We cast through unknown so we don't have to populate every
  // unrelated config slice (memory/multichat/etc.) — the UI never reads
  // them, and the test would otherwise drift every time another module
  // adds a config block.
  return {
    bot_id: 8507713167,
    dm_only: true,
    allowed_user_ids: [164795011],
    allowed_chat_ids: [164795011],
    status: { enabled: false, interval_ms: 700, ttl_ms: 300_000, delete_on_complete: true, suppress_typing_bubble: false },
    album: { flush_ms: 2000 },
    voice: { provider: 'groq', language: 'ru', model: 'whisper-large-v3-turbo' },
    webhook: { enabled: false, host: '127.0.0.1', port: 0 },
    permission_relay: { enabled: true, allowed_user_ids: overrides.allowedUserIds ?? [164795011], bash_only_proof: true },
    commands: { help: true, status: true, stop: true, reset: true, new: true },
    memory: {
      enabled: false,
      source_tag: 'tg',
      max_hot_bytes: 20480,
      trim_keep_lines: 600,
      buffer_ttl_ms: 5 * 60 * 1000,
      buffer_max_entries: 100,
    },
    progress: { enabled: false, edit_throttle_ms: 3000, recent_buffer: 10, session_ttl_ms: 600000 },
    task_mirror: { enabled: false, edit_throttle_ms: 3000, session_ttl_ms: 600000, collapse_completed_after: 5 },
    watcher: { enabled: false, debounce_ms: 10000, busy_threshold_ms: 30000 },
    ask_user_question: {
      enabled: true,
      timeout_ms: overrides.timeoutMs ?? 300_000,
      max_preview_chars: overrides.maxPreview ?? 1000,
    },
  } as unknown as AppConfig
}

interface UiHarness {
  ui: ReturnType<typeof createAskUserQuestionUi>
  relay: ReturnType<typeof createAskUserQuestionRelay>
  send: FakeTelegramSends
  config: AppConfig
}

async function mkUi(
  cfgOverrides: Parameters<typeof mkConfig>[0] = {},
  apiOpts?: { editThrows?: boolean },
): Promise<UiHarness> {
  const config = mkConfig(cfgOverrides)
  const send: FakeTelegramSends = { sendCalls: [], editCalls: [], nextMessageId: 1001 }
  const api = fakeTelegram(send, apiOpts)
  const relay = createAskUserQuestionRelay({ log: silentLog() })
  const ui = createAskUserQuestionUi({ config, log: silentLog(), telegramApi: api, relay })
  return { ui, relay, send, config }
}

// ─────────────────────────────────────────────────────────────────────
// parseAskCallback
// ─────────────────────────────────────────────────────────────────────

describe('parseAskCallback', () => {
  test('parses choose / toggle / done / other', () => {
    expect(parseAskCallback('ask:choose:abcde:0:1')).toEqual({
      kind: 'choose', requestId: 'abcde', questionIndex: 0, optionIndex: 1,
    })
    expect(parseAskCallback('ask:toggle:abcde:0:2')).toEqual({
      kind: 'toggle', requestId: 'abcde', questionIndex: 0, optionIndex: 2,
    })
    expect(parseAskCallback('ask:done:abcde:1')).toEqual({
      kind: 'done', requestId: 'abcde', questionIndex: 1,
    })
    expect(parseAskCallback('ask:other:abcde:0')).toEqual({
      kind: 'other', requestId: 'abcde', questionIndex: 0,
    })
  })

  test('rejects unknown kind / wrong arity / bad id / bad index', () => {
    expect(parseAskCallback('ask:bogus:foo')).toBeNull()
    expect(parseAskCallback('ask:choose:abcde:0')).toBeNull() // missing opt
    expect(parseAskCallback('ask:choose:abcde:0:1:2')).toBeNull() // extra
    expect(parseAskCallback('ask:choose:abcdl:0:1')).toBeNull() // l disallowed
    expect(parseAskCallback('ask:choose:abcde:01:1')).toBeNull() // leading zero
    expect(parseAskCallback('ask:choose:abcde:100:0')).toBeNull() // > MAX_QUESTIONS
    expect(parseAskCallback('ask:choose:abcde:0:100')).toBeNull() // > MAX_OPTIONS
    expect(parseAskCallback('perm:allow:abcde')).toBeNull() // wrong prefix
    expect(parseAskCallback('garbage')).toBeNull()
  })

  test('worst-case callback_data byte length fits Telegram budget', () => {
    const worst = 'ask:toggle:abcde:99:99'
    expect(worst.length).toBeLessThanOrEqual(64)
  })
})

// ─────────────────────────────────────────────────────────────────────
// renderQuestionBody + buildQuestionKeyboard (single-select)
// ─────────────────────────────────────────────────────────────────────

describe('render single-select question', () => {
  test('body shows header/question/options and keyboard has N + 1 rows', async () => {
    const { ui, relay, send } = await mkUi()
    // FIX-T3 F1: submit() returns { requestId, result } synchronously.
    const handle = relay.submit({
      toolUseId: 'toolu_1',
      sessionId: 'sess_a',
      chatId: '164795011',
      questions: [{
        question: 'Pick a stack',
        options: [
          { label: 'React', description: 'UI library' },
          { label: 'Vue' },
          { label: 'Svelte' },
        ],
      }],
    })
    const reqId = handle.requestId!
    expect(reqId).toBeDefined()

    await ui.startQuestion(reqId)

    expect(send.sendCalls.length).toBe(1)
    const { chatId, text, opts } = send.sendCalls[0]!
    expect(chatId).toBe('164795011')
    expect(opts.parse_mode).toBe('HTML')
    // header + question both rendered
    expect(text).toContain('<b>Вопрос 1/1</b>')
    expect(text).toContain('Pick a stack')
    // options listed with description
    expect(text).toContain('React')
    expect(text).toContain('UI library')
    expect(text).toContain('Vue')
    expect(text).toContain('Svelte')
    // keyboard: 3 option rows + 1 footer (Other only)
    const kb = opts.reply_markup
    expect(kb).toBeDefined()
    expect(kb!.inline_keyboard.length).toBe(4)
    expect(kb!.inline_keyboard[0]?.[0]?.callback_data).toBe(`ask:choose:${reqId}:0:0`)
    expect(kb!.inline_keyboard[1]?.[0]?.callback_data).toBe(`ask:choose:${reqId}:0:1`)
    expect(kb!.inline_keyboard[2]?.[0]?.callback_data).toBe(`ask:choose:${reqId}:0:2`)
    // footer row = single Other button (no Done for single-select)
    expect(kb!.inline_keyboard[3]?.length).toBe(1)
    expect(kb!.inline_keyboard[3]?.[0]?.text).toBe('Другое')
    expect(kb!.inline_keyboard[3]?.[0]?.callback_data).toBe(`ask:other:${reqId}:0`)
    // relay learned about the message id
    expect(relay.getPending(reqId)?.telegramMessageId).toBe(1001)
    // submit promise still unresolved — relay hasn't been answered
    let settled = false
    void handle.result.then(() => { settled = true })
    await new Promise(r => setTimeout(r, 1))
    expect(settled).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Multi-select render + toggle state
// ─────────────────────────────────────────────────────────────────────

describe('render multi-select question', () => {
  test('keyboard has N + 2 rows; checkbox prefixes reflect toggled state', async () => {
    const { ui, relay, send } = await mkUi()
    relay.submit({
      toolUseId: 'toolu_2',
      sessionId: 'sess_b',
      chatId: '164795011',
      questions: [{
        question: 'Pick frameworks',
        multiSelect: true,
        options: [
          { label: 'React' },
          { label: 'Vue' },
          { label: 'Svelte' },
        ],
      }],
    })
    const reqId = relay.listPendingIds()[0]!
    await ui.startQuestion(reqId)

    const kb = send.sendCalls[0]!.opts.reply_markup!
    // 3 option rows + 1 footer row with [Other, Done]
    expect(kb.inline_keyboard.length).toBe(4)
    expect(kb.inline_keyboard[0]?.[0]?.text).toBe('[ ] React')
    expect(kb.inline_keyboard[0]?.[0]?.callback_data).toBe(`ask:toggle:${reqId}:0:0`)
    expect(kb.inline_keyboard[1]?.[0]?.text).toBe('[ ] Vue')
    expect(kb.inline_keyboard[2]?.[0]?.text).toBe('[ ] Svelte')
    const footer = kb.inline_keyboard[3]!
    expect(footer.length).toBe(2)
    expect(footer[0]?.text).toBe('Другое')
    expect(footer[1]?.text).toBe('Готово')
    expect(footer[1]?.callback_data).toBe(`ask:done:${reqId}:0`)
  })

  test('keyboard helper reflects in-flight checkbox state', async () => {
    const { ui, relay } = await mkUi()
    relay.submit({
      toolUseId: 'toolu_3',
      sessionId: 'sess_c',
      chatId: '164795011',
      questions: [{
        question: 'Q',
        multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }],
      }],
    })
    const reqId = relay.listPendingIds()[0]!
    await ui.startQuestion(reqId)
    relay.toggle(reqId, 0, 0)
    const kb = buildQuestionKeyboard(relay.getPending(reqId)!)
    expect(kb.inline_keyboard[0]?.[0]?.text).toBe('[x] A')
    expect(kb.inline_keyboard[1]?.[0]?.text).toBe('[ ] B')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Callback handling
// ─────────────────────────────────────────────────────────────────────

function mkCtx(data: string, fromId: number, chatId = '164795011'): {
  ctx: AskCallbackContext
  answers: { text?: string }[]
} {
  const answers: { text?: string }[] = []
  const ctx: AskCallbackContext = {
    callbackQuery: { data },
    from: { id: fromId },
    chatId,
    async answerCallbackQuery(arg) {
      answers.push(arg ?? {})
    },
  }
  return { ctx, answers }
}

describe('handleAskCallback — choose', () => {
  test('records single-select pick, clears previous keyboard, resolves promise', async () => {
    const { ui, relay, send } = await mkUi()
    const handle = relay.submit({
      toolUseId: 'toolu_choose',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{
        question: 'Q',
        options: [{ label: 'A' }, { label: 'B' }],
      }],
    })
    const reqId = handle.requestId!
    await ui.startQuestion(reqId)
    send.sendCalls.length = 0 // reset

    const { ctx, answers } = mkCtx(`ask:choose:${reqId}:0:1`, 164795011)
    await ui.handleAskCallback(ctx)

    expect(answers.length).toBeGreaterThanOrEqual(1)
    // Previous keyboard cleared via editMessageText with empty inline_keyboard
    expect(send.editCalls.length).toBe(1)
    expect(send.editCalls[0]?.messageId).toBe(1001)
    expect(send.editCalls[0]?.opts.reply_markup?.inline_keyboard).toEqual([])
    expect(send.editCalls[0]?.text).toContain('Ответ принят')
    // Single question; promise resolves answered.
    const result = await handle.result
    expect(result.status).toBe('answered')
    expect(result.updatedInput?.answers).toEqual({ Q: 'B' })
  })

  test('multi-question flow: choose advances and re-renders the next question', async () => {
    const { ui, relay, send } = await mkUi()
    relay.submit({
      toolUseId: 'toolu_multi',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [
        { question: 'Q1', options: [{ label: 'X' }, { label: 'Y' }] },
        { question: 'Q2', options: [{ label: 'P' }, { label: 'Q' }] },
      ],
    })
    const reqId = relay.listPendingIds()[0]!
    await ui.startQuestion(reqId)
    expect(send.sendCalls.length).toBe(1)
    send.sendCalls.length = 0

    const { ctx } = mkCtx(`ask:choose:${reqId}:0:0`, 164795011)
    await ui.handleAskCallback(ctx)

    // Old keyboard cleared via edit, next question sent fresh.
    expect(send.editCalls.length).toBe(1)
    expect(send.sendCalls.length).toBe(1)
    expect(send.sendCalls[0]?.text).toContain('Q2')
    expect(send.sendCalls[0]?.opts.reply_markup?.inline_keyboard[0]?.[0]?.callback_data)
      .toBe(`ask:choose:${reqId}:1:0`)
  })
})

describe('handleAskCallback — toggle', () => {
  test('updates relay in-flight + re-renders SAME message with new label', async () => {
    const { ui, relay, send } = await mkUi()
    relay.submit({
      toolUseId: 'toolu_t',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{
        question: 'Q',
        multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }],
      }],
    })
    const reqId = relay.listPendingIds()[0]!
    await ui.startQuestion(reqId)
    send.sendCalls.length = 0

    const { ctx } = mkCtx(`ask:toggle:${reqId}:0:1`, 164795011)
    await ui.handleAskCallback(ctx)

    expect(relay.getPending(reqId)?.multiSelectInFlight).toEqual(['B'])
    expect(send.editCalls.length).toBe(1)
    expect(send.editCalls[0]?.messageId).toBe(1001)
    const kb = send.editCalls[0]?.opts.reply_markup!
    expect(kb.inline_keyboard[0]?.[0]?.text).toBe('[ ] A')
    expect(kb.inline_keyboard[1]?.[0]?.text).toBe('[x] B')
    // NO new sendMessage — we edit the existing question card.
    expect(send.sendCalls.length).toBe(0)
  })
})

describe('handleAskCallback — other', () => {
  test('sends "Введи ответ текстом" prompt + records awaiting state', async () => {
    const { ui, relay, send } = await mkUi()
    relay.submit({
      toolUseId: 'toolu_o',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{ question: 'Q', options: [{ label: 'A' }] }],
    })
    const reqId = relay.listPendingIds()[0]!
    await ui.startQuestion(reqId)
    send.sendCalls.length = 0

    const { ctx } = mkCtx(`ask:other:${reqId}:0`, 164795011)
    await ui.handleAskCallback(ctx)

    expect(send.sendCalls.length).toBe(1)
    expect(send.sendCalls[0]?.text).toContain('Введи ответ текстом')
    expect(send.sendCalls[0]?.chatId).toBe('164795011')
    expect(ui.awaitingOtherCount()).toBe(1)
  })

  test('subsequent text consumed via tryHandleOtherText calls answerOther', async () => {
    const { ui, relay, send } = await mkUi()
    const handle = relay.submit({
      toolUseId: 'toolu_o2',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{ question: 'Q', options: [{ label: 'A' }] }],
    })
    const reqId = handle.requestId!
    await ui.startQuestion(reqId)
    const { ctx } = mkCtx(`ask:other:${reqId}:0`, 164795011)
    await ui.handleAskCallback(ctx)
    // Capture the prompt message_id that the «Other» send produced. After
    // FIX-T1 F4 (2026-05-27) tryHandleOtherText requires the inbound
    // message's replyToMessageId to match this anchor.
    const promptSendCall = send.sendCalls[send.sendCalls.length - 1]!
    // sendCalls return message_id auto-incremented from nextMessageId.
    // startQuestion used 1001, the Other prompt is 1002.
    expect(promptSendCall.text).toContain('Введи ответ текстом')
    const promptMessageId = 1002
    send.sendCalls.length = 0

    const consumed = await ui.tryHandleOtherText({
      chatId: '164795011',
      fromUserId: 164795011,
      text: 'my custom answer',
      replyToMessageId: promptMessageId,
    })
    expect(consumed).toBe(true)
    expect(ui.awaitingOtherCount()).toBe(0)
    const result = await handle.result
    expect(result.status).toBe('answered')
    expect(result.updatedInput?.answers).toEqual({ Q: 'my custom answer' })
  })

  test('tryHandleOtherText returns false when no awaiting state', async () => {
    const { ui } = await mkUi()
    const consumed = await ui.tryHandleOtherText({
      chatId: '164795011',
      fromUserId: 164795011,
      text: 'hello',
    })
    expect(consumed).toBe(false)
  })

  test('tryHandleOtherText refuses to consume from non-approver', async () => {
    const { ui, relay } = await mkUi()
    relay.submit({
      toolUseId: 'toolu_o3',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{ question: 'Q', options: [{ label: 'A' }] }],
    })
    const reqId = relay.listPendingIds()[0]!
    await ui.startQuestion(reqId)
    const { ctx } = mkCtx(`ask:other:${reqId}:0`, 164795011)
    await ui.handleAskCallback(ctx)

    const consumed = await ui.tryHandleOtherText({
      chatId: '164795011',
      fromUserId: 99,
      text: 'evil interloper',
      // Even with a correctly-anchored replyToMessageId, the auth check
      // (FIX-T1 F4 runs the reply gate first; non-approver gate second)
      // still rejects: only the warchief may answer.
      replyToMessageId: 1002,
    })
    expect(consumed).toBe(false)
    expect(ui.awaitingOtherCount()).toBe(1) // still waiting for warchief
  })
})

// ─────────────────────────────────────────────────────────────────────
// FIX-T1 F4 (PRX-1 Phase 5, 2026-05-27) — force_reply markup on the
// «Other» prompt + reply_to_message_id gate on text consumption.
// ─────────────────────────────────────────────────────────────────────

describe('FIX-T1 F4 — Other prompt force_reply contract', () => {
  test('Other prompt is sent with force_reply markup (Telegram auto-quote UX)', async () => {
    const { ui, relay, send } = await mkUi()
    relay.submit({
      toolUseId: 'toolu_f4_a',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{ question: 'Q', options: [{ label: 'A' }] }],
    })
    const reqId = relay.listPendingIds()[0]!
    await ui.startQuestion(reqId)
    send.sendCalls.length = 0

    const { ctx } = mkCtx(`ask:other:${reqId}:0`, 164795011)
    await ui.handleAskCallback(ctx)

    expect(send.sendCalls.length).toBe(1)
    const otherSend = send.sendCalls[0]!
    expect(otherSend.text).toContain('Введи ответ текстом')
    // reply_markup carries force_reply; selective + input_field_placeholder
    // ride along for the UX hint.
    const markup = otherSend.opts.reply_markup as unknown as Record<string, unknown>
    expect(markup).toBeDefined()
    expect(markup.force_reply).toBe(true)
    expect(markup.selective).toBe(true)
    expect(markup.input_field_placeholder).toBe('Введи ответ')
  })

  test('text WITHOUT reply_to_message_id is NOT consumed (hijack closed)', async () => {
    const { ui, relay, send } = await mkUi()
    relay.submit({
      toolUseId: 'toolu_f4_b',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{ question: 'Q', options: [{ label: 'A' }] }],
    })
    const reqId = relay.listPendingIds()[0]!
    await ui.startQuestion(reqId)
    const { ctx } = mkCtx(`ask:other:${reqId}:0`, 164795011)
    await ui.handleAskCallback(ctx)
    send.sendCalls.length = 0

    // Freeform text with NO reply_to_message_id → must NOT consume.
    const consumed = await ui.tryHandleOtherText({
      chatId: '164795011',
      fromUserId: 164795011,
      text: 'random message typed at top level',
    })
    expect(consumed).toBe(false)
    // Slot remains open — warchief can still answer by replying to the prompt.
    expect(ui.awaitingOtherCount()).toBe(1)
  })

  test('text with WRONG reply_to_message_id is NOT consumed', async () => {
    const { ui, relay, send } = await mkUi()
    relay.submit({
      toolUseId: 'toolu_f4_c',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{ question: 'Q', options: [{ label: 'A' }] }],
    })
    const reqId = relay.listPendingIds()[0]!
    await ui.startQuestion(reqId)
    const { ctx } = mkCtx(`ask:other:${reqId}:0`, 164795011)
    await ui.handleAskCallback(ctx)
    send.sendCalls.length = 0

    // Reply to some OTHER message (not the Other prompt) — must NOT consume.
    const consumed = await ui.tryHandleOtherText({
      chatId: '164795011',
      fromUserId: 164795011,
      text: 'reply to wrong anchor',
      replyToMessageId: 99999,
    })
    expect(consumed).toBe(false)
    expect(ui.awaitingOtherCount()).toBe(1)
  })

  test('text with CORRECT reply_to_message_id IS consumed', async () => {
    const { ui, relay, send } = await mkUi()
    const submitted = relay.submit({
      toolUseId: 'toolu_f4_d',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{ question: 'Q', options: [{ label: 'A' }] }],
    })
    const reqId = relay.listPendingIds()[0]!
    await ui.startQuestion(reqId)
    // startQuestion used msg_id 1001, Other prompt will be 1002.
    const { ctx } = mkCtx(`ask:other:${reqId}:0`, 164795011)
    await ui.handleAskCallback(ctx)
    send.sendCalls.length = 0

    const consumed = await ui.tryHandleOtherText({
      chatId: '164795011',
      fromUserId: 164795011,
      text: 'explicit reply',
      replyToMessageId: 1002,
    })
    expect(consumed).toBe(true)
    expect(ui.awaitingOtherCount()).toBe(0)
    // SubmittedRequest from relay (FIX-T3 contract): `{ requestId, result }`.
    const result = await submitted.result
    expect(result.status).toBe('answered')
    expect(result.updatedInput?.answers).toEqual({ Q: 'explicit reply' })
  })
})

// ─────────────────────────────────────────────────────────────────────
// Auth + malformed handling
// ─────────────────────────────────────────────────────────────────────

describe('handleAskCallback — auth + malformed', () => {
  test('unauthorized user → deny popup, no relay mutation', async () => {
    const { ui, relay, send } = await mkUi()
    relay.submit({
      toolUseId: 'toolu_u',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{ question: 'Q', options: [{ label: 'A' }, { label: 'B' }] }],
    })
    const reqId = relay.listPendingIds()[0]!
    await ui.startQuestion(reqId)
    send.sendCalls.length = 0

    const { ctx, answers } = mkCtx(`ask:choose:${reqId}:0:1`, 99)
    await ui.handleAskCallback(ctx)

    expect(answers.length).toBe(1)
    expect(answers[0]?.text).toBe('Не авторизован')
    // No edit, no relay state change.
    expect(send.editCalls.length).toBe(0)
    expect(relay.isPending(reqId)).toBe(true)
    expect(relay.getPending(reqId)?.currentIndex).toBe(0)
  })

  test('malformed callback data → silent ack, no relay mutation', async () => {
    const { ui, relay, send } = await mkUi()
    relay.submit({
      toolUseId: 'toolu_b',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{ question: 'Q', options: [{ label: 'A' }] }],
    })
    const reqId = relay.listPendingIds()[0]!
    await ui.startQuestion(reqId)
    send.sendCalls.length = 0

    const { ctx, answers } = mkCtx('ask:bogus:foo', 164795011)
    await ui.handleAskCallback(ctx)

    expect(answers.length).toBe(1)
    expect(answers[0]?.text).toBeUndefined()
    expect(send.editCalls.length).toBe(0)
    expect(send.sendCalls.length).toBe(0)
    expect(relay.isPending(reqId)).toBe(true)
  })

  test('stale request id → "Запрос уже закрыт" popup', async () => {
    const { ui } = await mkUi()
    const { ctx, answers } = mkCtx('ask:choose:aaaaa:0:0', 164795011)
    await ui.handleAskCallback(ctx)
    expect(answers[0]?.text).toBe('Запрос уже закрыт')
  })
})

// ─────────────────────────────────────────────────────────────────────
// renderQuestionBody HTML escaping
// ─────────────────────────────────────────────────────────────────────

describe('renderQuestionBody — HTML escaping', () => {
  test('user-supplied text is escaped, body keeps tags only for layout', async () => {
    const { ui: _ui, relay } = await mkUi()
    relay.submit({
      toolUseId: 'toolu_esc',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{
        question: 'pick <script>alert(1)</script>',
        options: [
          { label: 'A & B', description: 'tag: <b>foo</b>' },
        ],
      }],
    })
    const reqId = relay.listPendingIds()[0]!
    const body = renderQuestionBody(relay.getPending(reqId)!, 1000)
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(body).toContain('A &amp; B')
    expect(body).toContain('tag: &lt;b&gt;foo&lt;/b&gt;')
    // header retains b tag (it's our own markup, not user)
    expect(body).toContain('<b>Вопрос 1/1</b>')
  })

  test('preview field is escaped and clipped to max_preview_chars', async () => {
    const { ui: _ui, relay } = await mkUi({ maxPreview: 12 })
    const longPreview = '<dangerous>'.repeat(20)
    relay.submit({
      toolUseId: 'toolu_p',
      sessionId: 'sess',
      chatId: '164795011',
      // The local AskQuestionOption type doesn't expose `preview` but the
      // relay accepts arbitrary caller-supplied shape — runtime carries it
      // and the UI probes defensively. Cast through unknown to suppress
      // the typed-only mismatch in this test.
      questions: [{
        question: 'Q',
        options: [{ label: 'A', preview: longPreview } as unknown as { label: string }],
      }],
    })
    const reqId = relay.listPendingIds()[0]!
    const body = renderQuestionBody(relay.getPending(reqId)!, 12)
    // First 12 chars after slice: '<dangerous>«' (12 chars of the string), escaped
    expect(body).toContain('<pre>')
    // No raw `<dangerous>` should appear (escaped)
    expect(body.includes('<dangerous>')).toBe(false)
    expect(body).toContain('&lt;dangerous')
  })
})

// ─────────────────────────────────────────────────────────────────────
// FIX-T2 F2 — tag-safe HTML body truncation.
// A 5000-char preview must NOT break HTML structure. The pre-fix path
// sliced the rendered HTML at MAX_BODY_CHARS, which could cut inside
// `<pre>`, `<b>`, or `&lt;` and crash Telegram's parser. The new
// piecewise assembly truncates raw fields BEFORE escaping and appends
// a self-contained marker if the body overflows.
// ─────────────────────────────────────────────────────────────────────

/** Quick sanity check that no tag is left open / unclosed in `body`.
 *  Counts opening and closing instances of each safe tag we emit. */
function htmlIsWellFormed(body: string): { ok: boolean; reason?: string } {
  const tags = ['b', 'i', 'pre', 'code']
  for (const t of tags) {
    const open = (body.match(new RegExp(`<${t}\\b[^>]*>`, 'g')) ?? []).length
    const close = (body.match(new RegExp(`</${t}>`, 'g')) ?? []).length
    if (open !== close) return { ok: false, reason: `tag <${t}>: ${open} open vs ${close} close` }
  }
  // Trailing partial entity check — any `&` not followed by alnum/#…;
  // is suspicious. We accept `&amp;`, `&lt;`, `&gt;`, `&quot;`.
  // (Telegram does not require `&` to be escaped if it doesn't start an
  // entity, but a sliced `&am` would be malformed.)
  const partial = /&(?!(?:amp|lt|gt|quot|#\d+);)\w*$/.exec(body)
  if (partial) return { ok: false, reason: `partial entity at tail: ${partial[0]!}` }
  return { ok: true }
}

describe('renderQuestionBody — FIX-T2 F2 tag-safe truncation', () => {
  test('large preview that fits stays escaped + HTML well-formed', async () => {
    // 200-byte preview is small enough to fit inside MAX_BODY_CHARS.
    // The point is: raw `<` and `&` must be escaped in the rendered
    // HTML — no in-tag slice possible because clipRaw operates on the
    // raw text BEFORE escapeHtml.
    const preview = '<x>&'.repeat(50) // 200 chars
    const { relay } = await mkUi({ maxPreview: 5000 })
    relay.submit({
      toolUseId: 'toolu_f2_med',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{
        question: 'Q',
        options: [{ label: 'A', preview } as unknown as { label: string }],
      }],
    })
    const reqId = relay.listPendingIds()[0]!
    const body = renderQuestionBody(relay.getPending(reqId)!, 5000)
    expect(body.length).toBeLessThan(4096)
    expect(body.includes('<x>')).toBe(false)
    expect(body).toContain('&lt;x&gt;')
    expect(body).toContain('&amp;')
    expect(htmlIsWellFormed(body).ok).toBe(true)
  })

  test('5000-char preview overflows → truncated cleanly, HTML well-formed', async () => {
    // Preview chunk would exceed MAX_BODY_CHARS. The piecewise assembler
    // MUST refuse to push it (rather than slicing inside the `<pre>` /
    // entity) and append the overflow marker instead. Crucially the
    // body must still be well-formed and under Telegram's 4096-byte cap.
    const longPreview = '<x>'.repeat(2000) // 6000 raw chars
    const { relay } = await mkUi({ maxPreview: 5000 })
    relay.submit({
      toolUseId: 'toolu_f2_big',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{
        question: 'Q',
        options: [{ label: 'A', preview: longPreview } as unknown as { label: string }],
      }],
    })
    const reqId = relay.listPendingIds()[0]!
    const body = renderQuestionBody(relay.getPending(reqId)!, 5000)
    expect(body.length).toBeLessThan(4096)
    // No raw `<x>` should leak — preview was skipped, not sliced.
    expect(body.includes('<x>')).toBe(false)
    // Overflow marker appended cleanly.
    expect(body).toContain('(обрезано)')
    expect(body.endsWith('</i>')).toBe(true)
    expect(htmlIsWellFormed(body).ok).toBe(true)
  })

  test('overflow marker is appended cleanly (no mid-tag slice) when body too long', async () => {
    // 50 options, each with a 500-char description, will exceed
    // MAX_BODY_CHARS (3800). The piecewise assembler must stop on a
    // chunk boundary and append the overflow marker.
    const opts: Array<{ label: string; description: string }> = []
    for (let i = 0; i < 50; i++) {
      opts.push({
        label: `Option ${i}`,
        description: 'd'.repeat(500),
      })
    }
    const { relay } = await mkUi()
    relay.submit({
      toolUseId: 'toolu_f2_overflow',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{ question: 'Pick one', options: opts }],
    })
    const reqId = relay.listPendingIds()[0]!
    const body = renderQuestionBody(relay.getPending(reqId)!, 1000)
    expect(body.length).toBeLessThan(4096)
    expect(body).toContain('(обрезано)')
    // Overflow marker is self-contained `<i>…</i>` — no half tags.
    expect(body.endsWith('</i>')).toBe(true)
    expect(htmlIsWellFormed(body).ok).toBe(true)
  })

  test('option label longer than MAX_BUTTON_LABEL is truncated raw', async () => {
    // Pre-fix would render the full label inside `<b>` and risk slicing
    // mid-tag at the body cap. Now labels are clipRaw'd to 30 chars
    // BEFORE the `<b>...</b>` wrapper.
    const longLabel = 'L'.repeat(200)
    const { relay } = await mkUi()
    relay.submit({
      toolUseId: 'toolu_f2_lbl',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{
        question: 'Q',
        options: [{ label: longLabel, description: 'desc' }],
      }],
    })
    const reqId = relay.listPendingIds()[0]!
    const body = renderQuestionBody(relay.getPending(reqId)!, 1000)
    // 30-char cap leaves room for `<b>...</b>` (7 bytes) + numeric prefix.
    expect(body).toContain('L'.repeat(29))
    expect(body.includes('L'.repeat(200))).toBe(false)
    expect(htmlIsWellFormed(body).ok).toBe(true)
  })

  test('preview with raw `&` does not produce trailing partial entity', async () => {
    // Pre-fix path could slice mid-`&amp;` if the rendered string ended
    // exactly inside the entity. The new clipRaw operates on raw text
    // and `escapeHtml` runs AFTER the clip, so partial entities are
    // structurally impossible. Use a 200-byte preview that fits in
    // the body so the preview branch actually emits.
    const longPreview = '&'.repeat(200)
    const { relay } = await mkUi({ maxPreview: 200 })
    relay.submit({
      toolUseId: 'toolu_f2_amp',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{
        question: 'Q',
        options: [{ label: 'A', preview: longPreview } as unknown as { label: string }],
      }],
    })
    const reqId = relay.listPendingIds()[0]!
    const body = renderQuestionBody(relay.getPending(reqId)!, 200)
    expect(body.length).toBeLessThan(4096)
    // Every raw `&` became `&amp;`. No raw `&` followed by non-entity char.
    expect(body.includes('&amp;')).toBe(true)
    expect(htmlIsWellFormed(body).ok).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// FIX-T2 F1 — telegram-edit-classifier integration.
// Verifies that startQuestion / rerenderCurrent / clearKeyboard react
// to Telegram's permanent failures (forbidden, message_gone, parse)
// instead of swallowing them at warn.
// ─────────────────────────────────────────────────────────────────────

class FakeGrammyError extends Error {
  error_code: number
  description: string
  parameters?: { retry_after?: number }
  constructor(error_code: number, description: string, parameters?: { retry_after?: number }) {
    super(`Telegram Bot API error: ${error_code} ${description}`)
    this.error_code = error_code
    this.description = description
    if (parameters) this.parameters = parameters
  }
}

/** TelegramApi double whose send/edit calls dispatch through a queue
 *  of error throwers. Each call pops the next thrower (FIFO). When the
 *  queue is empty, the call succeeds normally and records to `state`. */
function scriptedTelegram(state: FakeTelegramSends, sendErrors: Array<Error | null>, editErrors: Array<Error | null>): TelegramApi {
  return {
    async sendMessage(chatId, text, sendOpts) {
      state.sendCalls.push({ chatId, text, opts: sendOpts })
      const err = sendErrors.shift() ?? null
      if (err) throw err
      const id = state.nextMessageId
      state.nextMessageId += 1
      return { message_id: id }
    },
    async editMessageText(chatId, messageId, text, editOpts) {
      state.editCalls.push({ chatId, messageId, text, opts: editOpts })
      const err = editErrors.shift() ?? null
      if (err) throw err
    },
    async sendRichMessage(_c, _r, _o) { return { fallback: true as const } },
    async setMessageReaction(_c, _m, _e) { /* no-op */ },
    async sendChatAction(_c, _a) { /* no-op */ },
    async sendDocument(_c, _f, _o) { return { message_id: 0 } },
    async sendPhoto(_c, _f, _o) { return { message_id: 0 } },
    async downloadFile(_f, _d): Promise<DownloadResult> { return { path: '/tmp/x' } },
    async deleteMessage(_c, _m) { /* no-op */ },
  }
}

interface ScriptedHarness {
  ui: ReturnType<typeof createAskUserQuestionUi>
  relay: ReturnType<typeof createAskUserQuestionRelay>
  send: FakeTelegramSends
  events: { level: string; msg: string; fields?: unknown }[]
}

function mkScriptedUi(
  cfgOverrides: Parameters<typeof mkConfig>[0] = {},
  sendErrors: Array<Error | null> = [],
  editErrors: Array<Error | null> = [],
): ScriptedHarness {
  const config = mkConfig(cfgOverrides)
  const send: FakeTelegramSends = { sendCalls: [], editCalls: [], nextMessageId: 1001 }
  const api = scriptedTelegram(send, sendErrors, editErrors)
  const { log, events } = spyLog()
  const relay = createAskUserQuestionRelay({ log: silentLog() })
  const ui = createAskUserQuestionUi({ config, log, telegramApi: api, relay })
  return { ui, relay, send, events }
}

describe('rerenderCurrent — FIX-T2 F1 classifier integration', () => {
  test('message_gone → re-anchors ONCE, then expires on second hit', async () => {
    // First edit: simulate "message to edit not found" (warchief deleted
    // the keyboard). The handler must re-anchor by sending a fresh
    // message — the second send succeeds (no error queued for index 1).
    // Then we force another rerender that ALSO fails with message_gone
    // — this must expire the relay.
    const goneErr = new FakeGrammyError(400, 'Bad Request: message to edit not found')
    const { ui, relay, send, events } = mkScriptedUi(
      {},
      [null, null], // 1st send: initial render; 2nd send: re-anchor after gone
      [goneErr, goneErr], // both rerenders fail with message_gone
    )
    const handle = relay.submit({
      toolUseId: 'toolu_gone',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{
        question: 'Q',
        multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }],
      }],
    })
    const reqId = handle.requestId!
    await ui.startQuestion(reqId)
    expect(send.sendCalls.length).toBe(1)
    expect(relay.getPending(reqId)?.telegramMessageId).toBe(1001)

    // 1st toggle → rerenderCurrent → edit fails with message_gone →
    // re-anchor via sendMessage(2nd, no error) → new message_id=1002.
    const { ctx: ctx1 } = mkCtx(`ask:toggle:${reqId}:0:0`, 164795011)
    await ui.handleAskCallback(ctx1)
    expect(send.sendCalls.length).toBe(2) // re-anchor send fired
    expect(relay.getPending(reqId)?.telegramMessageId).toBe(1002)
    expect(relay.isPending(reqId)).toBe(true) // still pending

    // 2nd toggle → rerenderCurrent → message_gone AGAIN → expire.
    const { ctx: ctx2 } = mkCtx(`ask:toggle:${reqId}:0:1`, 164795011)
    await ui.handleAskCallback(ctx2)
    expect(relay.isPending(reqId)).toBe(false)
    const verdict = await handle.result
    expect(verdict.status).toBe('timeout')
    expect(verdict.reason).toContain('twice')
    expect(events.some(e => e.msg.includes('expiring'))).toBe(true)
  })

  test('forbidden → expires relay immediately', async () => {
    const forbiddenErr = new FakeGrammyError(403, 'Forbidden: bot was blocked by the user')
    const { ui, relay, events } = mkScriptedUi(
      {},
      [null], // initial render succeeds
      [forbiddenErr], // rerender fails forbidden
    )
    const handle = relay.submit({
      toolUseId: 'toolu_fbd',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{
        question: 'Q',
        multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }],
      }],
    })
    const reqId = handle.requestId!
    await ui.startQuestion(reqId)
    const { ctx } = mkCtx(`ask:toggle:${reqId}:0:0`, 164795011)
    await ui.handleAskCallback(ctx)
    expect(relay.isPending(reqId)).toBe(false)
    const verdict = await handle.result
    expect(verdict.status).toBe('timeout')
    expect(verdict.reason).toContain('forbidden 403')
    expect(events.some(e => e.msg.includes('forbidden'))).toBe(true)
  })
})

describe('startQuestion — FIX-T2 F1 send error classification', () => {
  test('forbidden on initial send → expires relay', async () => {
    const forbiddenErr = new FakeGrammyError(401, 'Unauthorized')
    const { ui, relay, events } = mkScriptedUi({}, [forbiddenErr], [])
    const handle = relay.submit({
      toolUseId: 'toolu_send_fbd',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{ question: 'Q', options: [{ label: 'A' }] }],
    })
    const reqId = handle.requestId!
    await ui.startQuestion(reqId)
    expect(relay.isPending(reqId)).toBe(false)
    const verdict = await handle.result
    expect(verdict.status).toBe('timeout')
    expect(verdict.reason).toContain('401')
    expect(events.some(e => e.msg.includes('forbidden'))).toBe(true)
  })

  test('flood on initial send → retains pending (logs only)', async () => {
    const floodErr = new FakeGrammyError(429, 'Too Many Requests: retry after 30', { retry_after: 30 })
    const { ui, relay, events } = mkScriptedUi({}, [floodErr], [])
    const handle = relay.submit({
      toolUseId: 'toolu_send_flood',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [{ question: 'Q', options: [{ label: 'A' }] }],
    })
    const reqId = handle.requestId!
    await ui.startQuestion(reqId)
    // Relay still pending — caller (or timeout) will resolve.
    expect(relay.isPending(reqId)).toBe(true)
    expect(events.some(e => e.msg.includes('flood'))).toBe(true)
    // Cleanup so the test doesn't leak.
    relay.expire(reqId, 'test cleanup')
    await handle.result
  })
})

describe('clearKeyboard — FIX-T2 F1 classifier integration', () => {
  test('forbidden on clear → expires the relay before next render', async () => {
    const forbiddenErr = new FakeGrammyError(403, 'Forbidden: bot was kicked from the supergroup chat')
    // Two questions. Initial send succeeds; clearing the first keyboard
    // after answerChoice fails with forbidden — the relay must expire
    // BEFORE startQuestion is called for Q2.
    const { ui, relay, send, events } = mkScriptedUi(
      {},
      [null], // initial render only — no re-anchor because clear failed first
      [forbiddenErr], // clearKeyboard fails forbidden
    )
    const handle = relay.submit({
      toolUseId: 'toolu_clr_fbd',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [
        { question: 'Q1', options: [{ label: 'A' }] },
        { question: 'Q2', options: [{ label: 'B' }] },
      ],
    })
    const reqId = handle.requestId!
    await ui.startQuestion(reqId)
    expect(send.sendCalls.length).toBe(1)

    const { ctx } = mkCtx(`ask:choose:${reqId}:0:0`, 164795011)
    await ui.handleAskCallback(ctx)
    // clearKeyboard failed forbidden → relay expired → no Q2 send fired.
    expect(send.sendCalls.length).toBe(1)
    expect(relay.isPending(reqId)).toBe(false)
    const verdict = await handle.result
    expect(verdict.status).toBe('timeout')
    expect(verdict.reason).toContain('forbidden 403')
    expect(events.some(e => e.msg.includes('forbidden'))).toBe(true)
  })

  test('message_gone on clear → benign no-op, advances to next question', async () => {
    // The keyboard is already gone — that's exactly the state we wanted
    // after clearKeyboard, so the relay must continue to Q2.
    const goneErr = new FakeGrammyError(400, 'Bad Request: message to edit not found')
    const { ui, relay, send } = mkScriptedUi(
      {},
      [null, null], // Q1 send + Q2 send both succeed
      [goneErr], // clearKeyboard for Q1's keyboard finds it already gone
    )
    const handle = relay.submit({
      toolUseId: 'toolu_clr_gone',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [
        { question: 'Q1', options: [{ label: 'A' }] },
        { question: 'Q2', options: [{ label: 'B' }] },
      ],
    })
    const reqId = handle.requestId!
    await ui.startQuestion(reqId)
    expect(send.sendCalls.length).toBe(1)

    const { ctx } = mkCtx(`ask:choose:${reqId}:0:0`, 164795011)
    await ui.handleAskCallback(ctx)
    // Q2 was sent even though clear hit message_gone.
    expect(send.sendCalls.length).toBe(2)
    expect(send.sendCalls[1]?.text).toContain('Q2')
    expect(relay.isPending(reqId)).toBe(true)
    // Clean up.
    relay.expire(reqId, 'test cleanup')
    await handle.result
  })
})
