import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ContextHud,
  HUD_PREFIX,
  buildHudKeyboard,
  handleHudCallback,
  parseHudCallback,
  renderHud,
  renderStatusTasks,
  type HudCallbackContext,
  type HudCallbackDeps,
  type HudTelegramApi,
  type SessionInfoReader,
} from '../../src/status/context-hud.js'
import type { TaskMirrorEvent } from '../../src/hooks/claude-events.js'
import type { TodoItem } from '../../src/schemas.js'
import type { ControlCommandResult } from '../../src/commands/keys.js'
import type { ControlSender } from '../../src/telegram/newq-confirm-ui.js'
import type { EditOpts, InlineKeyboardLike, SendMessageOpts } from '../../src/channel/tools.js'
import type { Logger } from '../../src/log.js'

const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger
const OWNER = '164795011'
const WINDOW = 200_000
const PANE = { paneTarget: '%1', socketPath: '/tmp/s' }
const ALLOWED = [164795011]

// Track temp dirs for cleanup.
const tmpDirs: string[] = []
function stateDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'hud-'))
  tmpDirs.push(d)
  return d
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// ─────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────

interface SendRecord {
  chatId: string
  text: string
  opts: SendMessageOpts
  message_id: number
}
interface EditRecord {
  chatId: string
  messageId: number
  text: string
  opts: EditOpts
}
interface PinRecord {
  chatId: string
  messageId: number
  opts: { disable_notification?: boolean }
}

class FakeApi implements HudTelegramApi {
  sent: SendRecord[] = []
  edited: EditRecord[] = []
  pinned: PinRecord[] = []
  deleted: Array<{ chatId: string; messageId: number }> = []
  unpinned: Array<{ chatId: string; messageId: number }> = []
  nextId = 100
  sendError: unknown
  editError: unknown
  pinError: unknown
  deleteError: unknown
  unpinError: unknown

  async sendMessage(
    chatId: string,
    text: string,
    opts: SendMessageOpts,
  ): Promise<{ message_id: number }> {
    if (this.sendError) throw this.sendError
    const message_id = this.nextId++
    this.sent.push({ chatId, text, opts, message_id })
    return { message_id }
  }

  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    opts: EditOpts,
  ): Promise<void> {
    this.edited.push({ chatId, messageId, text, opts })
    if (this.editError) throw this.editError
  }

  async pinChatMessage(
    chatId: string,
    messageId: number,
    opts: { disable_notification?: boolean },
  ): Promise<void> {
    this.pinned.push({ chatId, messageId, opts })
    if (this.pinError) throw this.pinError
  }

  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    if (this.deleteError) throw this.deleteError
    this.deleted.push({ chatId, messageId })
  }

  async unpinChatMessage(chatId: string, messageId: number): Promise<void> {
    if (this.unpinError) throw this.unpinError
    this.unpinned.push({ chatId, messageId })
  }
}

function fakeSession(info: {
  transcriptPath?: string
  model?: string
  permissionMode?: string
}): SessionInfoReader {
  return { get: () => info }
}

function makeHud(
  api: HudTelegramApi,
  opts: {
    dir?: string
    enabled?: boolean
    usage?: { usedTokens: number; pct: number } | null
    session?: SessionInfoReader
  } = {},
): ContextHud {
  return new ContextHud({
    api,
    log,
    sessionInfo: opts.session ?? fakeSession({ transcriptPath: '/t/a.jsonl', model: 'opus' }),
    windowTokens: WINDOW,
    ownerChatIds: [OWNER],
    stateDir: opts.dir ?? stateDir(),
    enabled: opts.enabled ?? true,
    readContextUsage: async () =>
      opts.usage === undefined ? { usedTokens: 114_000, pct: 0.57 } : opts.usage,
  })
}

// ─────────────────────────────────────────────────────────────────────
// renderHud (pure)
// ─────────────────────────────────────────────────────────────────────

function filledCount(text: string): number {
  return (text.match(/▰/g) ?? []).length
}
function emptyCount(text: string): number {
  return (text.match(/▱/g) ?? []).length
}

describe('renderHud', () => {
  test('0% → 0 filled segments, 10 empty', () => {
    const { text } = renderHud({ usedTokens: 0 }, WINDOW)
    expect(filledCount(text)).toBe(0)
    expect(emptyCount(text)).toBe(10)
    expect(text).toContain('0% (0k / 200k)')
  })

  test('50% → 5 filled segments', () => {
    const { text } = renderHud({ usedTokens: 100_000 }, WINDOW)
    expect(filledCount(text)).toBe(5)
    expect(emptyCount(text)).toBe(5)
    expect(text).toContain('50% (100k / 200k)')
  })

  test('57% → 6 filled segments (rounds 5.7)', () => {
    const { text } = renderHud({ usedTokens: 114_000 }, WINDOW)
    expect(filledCount(text)).toBe(6)
    expect(text).toContain('🧠 <b>Контекст</b>:')
    expect(text).toContain('57% (114k / 200k)')
  })

  test('100% → 10 filled segments', () => {
    const { text } = renderHud({ usedTokens: 200_000 }, WINDOW)
    expect(filledCount(text)).toBe(10)
    expect(emptyCount(text)).toBe(0)
    expect(text).toContain('100% (200k / 200k)')
  })

  test('over 100% clamps to a full bar and 100%', () => {
    const { text } = renderHud({ usedTokens: 250_000 }, WINDOW)
    expect(filledCount(text)).toBe(10)
    expect(text).toContain('100% (250k / 200k)')
  })

  test('null usage → «Контекст: —», no bar', () => {
    const { text } = renderHud(null, WINDOW)
    expect(text).toContain('🧠 <b>Контекст</b>: —')
    expect(filledCount(text)).toBe(0)
    expect(emptyCount(text)).toBe(0)
  })

  test('model renders as an optional escaped second line', () => {
    const { text } = renderHud({ usedTokens: 100_000 }, WINDOW, 'claude-opus-4-8')
    expect(text).toContain('\n<i>claude-opus-4-8</i>')
    const escaped = renderHud(null, WINDOW, 'a<b>&c').text
    expect(escaped).toContain('<i>a&lt;b&gt;&amp;c</i>')
  })

  test('keyboard shape: single Сжать row, no Новый диалог button', () => {
    const { keyboard } = renderHud({ usedTokens: 0 }, WINDOW)
    expect(keyboard).toEqual(buildHudKeyboard())
    const rows = keyboard.inline_keyboard
    expect(rows.length).toBe(1)
    expect(rows[0]![0]!.callback_data).toBe(`${HUD_PREFIX}compact`)
    expect(rows[0]![0]!.text).toContain('Сжать')
    const flat = JSON.stringify(keyboard)
    expect(flat).not.toContain('Новый диалог')
    expect(flat).not.toContain(`${HUD_PREFIX}new`)
  })
})

// ─────────────────────────────────────────────────────────────────────
// ContextHud manager
// ─────────────────────────────────────────────────────────────────────

describe('ContextHud lifecycle', () => {
  test('onSessionStart: first run sends + pins + persists id', async () => {
    const api = new FakeApi()
    const dir = stateDir()
    const hud = makeHud(api, { dir })
    await hud.onSessionStart(OWNER)

    expect(api.sent.length).toBe(1)
    expect(api.sent[0]!.opts.parse_mode).toBe('HTML')
    expect(api.sent[0]!.opts.reply_markup).toEqual(buildHudKeyboard())
    expect(api.pinned.length).toBeGreaterThanOrEqual(1)
    expect(api.pinned[0]!.opts.disable_notification).toBe(true)

    const persisted = JSON.parse(
      readFileSync(join(dir, `context-hud-${OWNER}.json`), 'utf8'),
    ) as { message_id: number }
    expect(persisted.message_id).toBe(api.sent[0]!.message_id)
  })

  test('second refresh edits the SAME message id (no re-send)', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.onSessionStart(OWNER)
    const id = api.sent[0]!.message_id
    await hud.onStop(OWNER)

    expect(api.sent.length).toBe(1)
    expect(api.edited.length).toBe(1)
    expect(api.edited[0]!.messageId).toBe(id)
    expect(api.edited[0]!.opts.reply_markup).toEqual(buildHudKeyboard())
  })

  test('"not modified" edit error is swallowed, no recreate', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.onSessionStart(OWNER)
    api.editError = new Error('Bad Request: message is not modified')
    await hud.onStop(OWNER) // must not throw

    expect(api.sent.length).toBe(1) // no recreate
    expect(api.edited.length).toBe(1)
  })

  test('deleted message (400) recreates exactly once + repins', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.onSessionStart(OWNER)
    const pinsBefore = api.pinned.length
    api.editError = { error_code: 400, description: 'Bad Request: message to edit not found' }
    await hud.onStop(OWNER)

    expect(api.edited.length).toBe(1) // the failed edit
    expect(api.sent.length).toBe(2) // recreated ONCE (no loop)
    expect(api.pinned.length).toBeGreaterThan(pinsBefore) // repinned
    // The new id is persisted (in-memory cache advanced): another refresh
    // edits the NEW id, proving the recreate replaced the stale one.
    api.editError = undefined
    await hud.onStop(OWNER)
    expect(api.sent.length).toBe(2)
    expect(api.edited[api.edited.length - 1]!.messageId).toBe(api.sent[1]!.message_id)
  })

  test('send failure never throws (best-effort isolation)', async () => {
    const api = new FakeApi()
    api.sendError = new Error('network down')
    const hud = makeHud(api)
    await expect(hud.onSessionStart(OWNER)).resolves.toBeUndefined()
    await expect(hud.onStop(OWNER)).resolves.toBeUndefined()
    expect(api.sent.length).toBe(0)
    expect(api.edited.length).toBe(0)
  })

  test('pin failure never throws and does not block the send', async () => {
    const api = new FakeApi()
    api.pinError = new Error('not enough rights to pin')
    const hud = makeHud(api)
    await expect(hud.onSessionStart(OWNER)).resolves.toBeUndefined()
    expect(api.sent.length).toBe(1) // send still happened
  })

  test('null usage renders «—» through the manager', async () => {
    const api = new FakeApi()
    const hud = makeHud(api, { usage: null })
    await hud.onSessionStart(OWNER)
    expect(api.sent[0]!.text).toContain('🧠 <b>Контекст</b>: —')
  })

  test('non-owner chat is a no-op', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.onSessionStart('999')
    await hud.onStop('999')
    expect(api.sent.length).toBe(0)
    expect(api.edited.length).toBe(0)
  })

  test('disabled HUD is a no-op', async () => {
    const api = new FakeApi()
    const hud = makeHud(api, { enabled: false })
    await hud.onSessionStart(OWNER)
    await hud.onStop(OWNER)
    expect(api.sent.length).toBe(0)
  })

  // FIX-8: a group id is NEVER a HUD owner even if it slipped into the owner
  // set — the pinned HUD (with destructive buttons) must never surface in a
  // group. isOwner requires a positive (DM) numeric chat id.
  test('group chat id in the owner set → still no HUD (DM-only)', async () => {
    const api = new FakeApi()
    const GROUP = '-1001234567890'
    const hud = new ContextHud({
      api,
      log,
      sessionInfo: fakeSession({ transcriptPath: '/t/a.jsonl', model: 'opus' }),
      windowTokens: WINDOW,
      ownerChatIds: [GROUP], // misconfigured: a group id
      stateDir: stateDir(),
      enabled: true,
      readContextUsage: async () => ({ usedTokens: 100_000, pct: 0.5 }),
    })
    await hud.onSessionStart(GROUP)
    await hud.onStop(GROUP)
    expect(api.sent.length).toBe(0)
    expect(api.pinned.length).toBe(0)
  })

  // FIX-9: a concurrent SessionStart + Stop (both firing before the first send
  // persists an id) must NOT create two pinned HUDs. Per-chat serialization
  // makes the second op reuse the id the first cached.
  test('concurrent SessionStart + Stop → exactly ONE HUD created', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await Promise.all([hud.onSessionStart(OWNER), hud.onStop(OWNER)])
    expect(api.sent.length).toBe(1) // one message, not two
  })

  test('persistence survives a restart: reuse + repin the same message', async () => {
    const dir = stateDir()
    const api1 = new FakeApi()
    const hud1 = makeHud(api1, { dir })
    await hud1.onSessionStart(OWNER)
    const id = api1.sent[0]!.message_id

    // Fresh instance (plugin restart) pointed at the SAME state dir.
    const api2 = new FakeApi()
    const hud2 = makeHud(api2, { dir })
    await hud2.onStop(OWNER)
    expect(api2.sent.length).toBe(0) // no new message spammed
    expect(api2.edited.length).toBe(1)
    expect(api2.edited[0]!.messageId).toBe(id) // reused persisted id
  })
})

// ─────────────────────────────────────────────────────────────────────
// hud: callback handler
// ─────────────────────────────────────────────────────────────────────

function fakeSender(result: ControlCommandResult): { calls: string[]; sender: ControlSender } {
  const calls: string[] = []
  const sender: ControlSender = async (_target, name) => {
    calls.push(name)
    return result
  }
  return { calls, sender }
}

function makeCbCtx(
  data: string,
  fromId: number | undefined,
): {
  ctx: HudCallbackContext
  answers: (string | undefined)[]
} {
  const answers: (string | undefined)[] = []
  const ctx: HudCallbackContext = {
    callbackQuery: { data },
    from: { id: fromId },
    chatId: OWNER,
    answerCallbackQuery: async (arg) => {
      answers.push(arg?.text)
    },
  }
  return { ctx, answers }
}

function makeCards(): {
  cards: { chatId: string; text: string; keyboard: InlineKeyboardLike }[]
  send: HudCallbackDeps['sendConfirmCard']
} {
  const cards: { chatId: string; text: string; keyboard: InlineKeyboardLike }[] = []
  const send: HudCallbackDeps['sendConfirmCard'] = async (chatId, text, keyboard) => {
    cards.push({ chatId, text, keyboard })
  }
  return { cards, send }
}

describe('parseHudCallback', () => {
  test('accepts compact / new; rejects the rest', () => {
    expect(parseHudCallback(`${HUD_PREFIX}compact`)).toBe('compact')
    expect(parseHudCallback(`${HUD_PREFIX}new`)).toBe('new')
    expect(parseHudCallback(`${HUD_PREFIX}nope`)).toBeNull()
    expect(parseHudCallback('newq:confirm')).toBeNull()
    expect(parseHudCallback(`${HUD_PREFIX}`)).toBeNull()
    // @ts-expect-error runtime guard for non-string
    expect(parseHudCallback(undefined)).toBeNull()
  })
})

describe('handleHudCallback', () => {
  test('unauthorized user id → toast, NO compact, NO card', async () => {
    const { calls, sender } = fakeSender({ ok: true })
    const { cards, send } = makeCards()
    const deps: HudCallbackDeps = {
      allowedUserIds: ALLOWED,
      tmuxKeysTarget: PANE,
      log,
      sendConfirmCard: send,
      sendControl: sender,
    }
    const { ctx, answers } = makeCbCtx(`${HUD_PREFIX}compact`, 999)
    await handleHudCallback(ctx, deps)
    expect(calls.length).toBe(0)
    expect(cards.length).toBe(0)
    expect(answers[0]).toContain('не авторизовано')
  })

  test('missing id is unauthorized (fail-closed)', async () => {
    const { calls, sender } = fakeSender({ ok: true })
    const { send } = makeCards()
    const deps: HudCallbackDeps = {
      allowedUserIds: ALLOWED,
      tmuxKeysTarget: PANE,
      log,
      sendConfirmCard: send,
      sendControl: sender,
    }
    const { ctx, answers } = makeCbCtx(`${HUD_PREFIX}compact`, undefined)
    await handleHudCallback(ctx, deps)
    expect(calls.length).toBe(0)
    expect(answers[0]).toContain('не авторизовано')
  })

  test('hud:compact ok → answers «Сжимаю…» and calls sendControlCommand', async () => {
    const { calls, sender } = fakeSender({ ok: true })
    const { send } = makeCards()
    const deps: HudCallbackDeps = {
      allowedUserIds: ALLOWED,
      tmuxKeysTarget: PANE,
      log,
      sendConfirmCard: send,
      sendControl: sender,
    }
    const { ctx, answers } = makeCbCtx(`${HUD_PREFIX}compact`, ALLOWED[0]!)
    await handleHudCallback(ctx, deps)
    expect(calls).toEqual(['compact'])
    expect(answers[0]).toContain('Сжимаю')
  })

  // L10 (IT2-8): a failed compact must be surfaced VISIBLY (a fresh message),
  // NOT via a second answerCallbackQuery (Telegram drops it → invisible). The
  // first toast stays «Сжимаю…»; the reason arrives as a message.
  test('hud:compact failure surfaces the reason as a message (not a 2nd toast)', async () => {
    const { calls, sender } = fakeSender({ ok: false, reason: 'busy' })
    const { cards, send } = makeCards()
    const deps: HudCallbackDeps = {
      allowedUserIds: ALLOWED,
      tmuxKeysTarget: PANE,
      log,
      sendConfirmCard: send,
      sendControl: sender,
    }
    const { ctx, answers } = makeCbCtx(`${HUD_PREFIX}compact`, ALLOWED[0]!)
    await handleHudCallback(ctx, deps)
    expect(calls).toEqual(['compact'])
    // Failure went out as a visible message carrying the reason…
    expect(cards.length).toBe(1)
    expect(cards[0]!.text).toContain('занят')
    // …NOT as a second toast (only the «Сжимаю…» spinner answer was sent).
    expect(answers).toEqual(['Сжимаю…'])
  })

  test('hud:compact with no pane → toast, no sendControlCommand', async () => {
    const { calls, sender } = fakeSender({ ok: true })
    const { send } = makeCards()
    const deps: HudCallbackDeps = {
      allowedUserIds: ALLOWED,
      log,
      sendConfirmCard: send,
      sendControl: sender,
    }
    const { ctx, answers } = makeCbCtx(`${HUD_PREFIX}compact`, ALLOWED[0]!)
    await handleHudCallback(ctx, deps)
    expect(calls.length).toBe(0)
    expect(answers[0]).toContain('pane недоступен')
  })

  test('hud:new → posts the /new confirm card (NOT a direct clear)', async () => {
    const { calls, sender } = fakeSender({ ok: true })
    const { cards, send } = makeCards()
    const deps: HudCallbackDeps = {
      allowedUserIds: ALLOWED,
      tmuxKeysTarget: PANE,
      log,
      sendConfirmCard: send,
      sendControl: sender,
    }
    const { ctx } = makeCbCtx(`${HUD_PREFIX}new`, ALLOWED[0]!)
    await handleHudCallback(ctx, deps)
    // No control command was driven — the destructive clear must confirm first.
    expect(calls.length).toBe(0)
    expect(cards.length).toBe(1)
    expect(cards[0]!.chatId).toBe(OWNER)
    expect(cards[0]!.text).toContain('Новый диалог')
    // The card carries the wave-3A newq:* buttons, reusing the existing flow.
    // FIX-14: confirm now carries a build-time nonce; cancel stays plain.
    const datas = cards[0]!.keyboard.inline_keyboard.flat().map((b) => b.callback_data)
    expect(datas[0]).toMatch(/^newq:confirm:\d+:[a-z0-9]+$/)
    expect(datas[1]).toBe('newq:cancel')
  })

  // FIX-8: a HUD tap from a non-owner chat (a group where a stray HUD surfaced)
  // must be refused — the control buttons drive the single global DM pane.
  test('hud tap from a non-owner chat → refused, NO compact/card', async () => {
    const { calls, sender } = fakeSender({ ok: true })
    const { cards, send } = makeCards()
    const deps: HudCallbackDeps = {
      allowedUserIds: ALLOWED,
      tmuxKeysTarget: PANE,
      log,
      sendConfirmCard: send,
      sendControl: sender,
      ownerChatIds: [164795011],
    }
    // Tap from a group chat (negative id), authorized user, but wrong chat.
    const answers: (string | undefined)[] = []
    const ctx: HudCallbackContext = {
      callbackQuery: { data: `${HUD_PREFIX}compact` },
      from: { id: ALLOWED[0]! },
      chatId: '-1001234567890',
      answerCallbackQuery: async (arg) => {
        answers.push(arg?.text)
      },
    }
    await handleHudCallback(ctx, deps)
    expect(calls.length).toBe(0)
    expect(cards.length).toBe(0)
    expect(answers[0]).toContain('недоступно')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Status pin (2026-07-04): renderStatusTasks + work view + bump + todos
// ─────────────────────────────────────────────────────────────────────

function todo(id: string, status: TodoItem['status'], content: string, activeForm?: string): TodoItem {
  return { id, status, content, ...(activeForm !== undefined ? { activeForm } : {}) }
}

describe('renderStatusTasks', () => {
  test('empty list → empty string (section omitted)', () => {
    expect(renderStatusTasks([])).toBe('')
  })

  test('bar reflects done/total and header carries the count', () => {
    const todos = [
      todo('1', 'completed', 'a'),
      todo('2', 'completed', 'b'),
      todo('3', 'completed', 'c'),
      todo('4', 'in_progress', 'd'),
      todo('5', 'pending', 'e'),
    ]
    const text = renderStatusTasks(todos)
    expect(text).toContain('<b>Задачи</b>')
    expect(text).toContain('3/5')
    expect((text.match(/▰/g) ?? []).length).toBe(6) // round(3/5*10)
    expect((text.match(/▱/g) ?? []).length).toBe(4)
  })

  test('in-progress uses activeForm; content is escaped and truncated', () => {
    const long = 'x'.repeat(120)
    const text = renderStatusTasks([
      todo('1', 'in_progress', 'raw', 'Working <on> & stuff'),
      todo('2', 'pending', long),
    ])
    expect(text).toContain('◐ Working &lt;on&gt; &amp; stuff')
    expect(text).toContain('…')
    expect(text).not.toContain(long)
  })

  test('pending capped at 5 with a «+N ещё…» tail', () => {
    const todos = Array.from({ length: 7 }, (_, i) => todo(String(i), 'pending', `p${i}`))
    const text = renderStatusTasks(todos)
    expect((text.match(/◻/g) ?? []).length).toBe(5)
    expect(text).toContain('<i>+2 ещё…</i>')
  })

  test('completed shows the last 2 with a hidden-count line', () => {
    const todos = [
      ...Array.from({ length: 4 }, (_, i) => todo(String(i), 'completed', `d${i}`)),
      todo('x', 'in_progress', 'now'),
    ]
    const text = renderStatusTasks(todos)
    expect((text.match(/☑/g) ?? []).length).toBe(2)
    expect(text).toContain('☑ d2')
    expect(text).toContain('☑ d3')
    expect(text).toContain('<i>+2 завершено ранее</i>')
  })
})

describe('renderStatusTasks budget', () => {
  test('total budget: a flood of long in-progress items stays bounded', () => {
    const todos = Array.from({ length: 40 }, (_, i) =>
      todo(String(i), 'in_progress', `<${'очень длинная задача с разметкой & сущностями '.repeat(2)}${i}>`))
    const text = renderStatusTasks(todos)
    expect(text.length).toBeLessThan(1700)
    expect(text).toContain('строк скрыто')
  })

  test('truncation never splits a surrogate pair', () => {
    const raw = '𝕏'.repeat(100) // astral-plane chars (2 UTF-16 units each)
    const text = renderStatusTasks([todo('1', 'pending', raw)])
    expect(text).not.toContain('\uFFFD')
    expect(text).toContain('…')
  })
})

describe('renderHud work view', () => {
  test('permissionMode plan → «режим: план»; other → «выполнение»; absent → no line', () => {
    const plan = renderHud({ usedTokens: 0 }, WINDOW, 'm', { todos: [], permissionMode: 'plan' })
    expect(plan.text).toContain('<i>режим: план</i>')
    const exec = renderHud({ usedTokens: 0 }, WINDOW, 'm', { todos: [], permissionMode: 'acceptEdits' })
    expect(exec.text).toContain('<i>режим: выполнение</i>')
    const none = renderHud({ usedTokens: 0 }, WINDOW, 'm', { todos: [] })
    expect(none.text).not.toContain('режим:')
  })

  test('todos append a «Задачи» section; empty todos omit it', () => {
    const withTasks = renderHud({ usedTokens: 0 }, WINDOW, undefined, {
      todos: [todo('1', 'in_progress', 'работаю')],
    })
    expect(withTasks.text).toContain('\n\n<b>Задачи</b>')
    expect(withTasks.text).toContain('◐ работаю')
    const without = renderHud({ usedTokens: 0 }, WINDOW)
    expect(without.text).not.toContain('Задачи')
  })
})

describe('ContextHud bump', () => {
  test('existing message: delete old → send fresh → pin; persisted id updated', async () => {
    const api = new FakeApi()
    const dir = stateDir()
    const hud = makeHud(api, { dir })
    await hud.onSessionStart(OWNER)
    const oldId = api.sent[0]!.message_id

    await hud.bump(OWNER)
    expect(api.deleted).toEqual([{ chatId: OWNER, messageId: oldId }])
    expect(api.unpinned.length).toBe(0)
    expect(api.sent.length).toBe(2)
    const newId = api.sent[1]!.message_id
    expect(newId).not.toBe(oldId)
    expect(api.pinned.map((p) => p.messageId)).toContain(newId)
    const persisted = JSON.parse(
      readFileSync(join(dir, `context-hud-${OWNER}.json`), 'utf8'),
    ) as { message_id: number }
    expect(persisted.message_id).toBe(newId)
  })

  test('delete refused (older than 48h) → unpin fallback, fresh message still sent', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.onSessionStart(OWNER)
    const oldId = api.sent[0]!.message_id
    api.deleteError = new Error('400: message can\'t be deleted')

    await hud.bump(OWNER)
    expect(api.unpinned).toEqual([{ chatId: OWNER, messageId: oldId }])
    expect(api.sent.length).toBe(2)
  })

  test('delete AND unpin both fail → bump aborts, old card kept (one-pin invariant)', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.onSessionStart(OWNER)
    const oldId = api.sent[0]!.message_id
    api.deleteError = new Error('400: message can\'t be deleted')
    api.unpinError = new Error('network')

    await hud.bump(OWNER)
    expect(api.sent.length).toBe(1) // NO replacement sent — two pins impossible
    // The old id survives: a later refresh edits the SAME card.
    await hud.updateNow(OWNER)
    const lastEdit = api.edited[api.edited.length - 1]!
    expect(lastEdit.messageId).toBe(oldId)
  })

  test('debounce: a second bump within the window is a no-op', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.onSessionStart(OWNER)
    await hud.bump(OWNER)
    await hud.bump(OWNER)
    expect(api.deleted.length).toBe(1)
    expect(api.sent.length).toBe(2)
  })

  test('no prior message → just sends + pins (no delete/unpin)', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.bump(OWNER)
    expect(api.deleted.length).toBe(0)
    expect(api.unpinned.length).toBe(0)
    expect(api.sent.length).toBe(1)
    expect(api.pinned.length).toBe(1)
  })

  test('non-owner chat → complete no-op', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.bump('-1001234567890')
    await hud.bump('99999')
    expect(api.sent.length).toBe(0)
  })
})

describe('ContextHud onTodoEvent', () => {
  test('todo_write refreshes the card with a tasks section', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.onSessionStart(OWNER)

    const event: TaskMirrorEvent = {
      kind: 'todo_write',
      todos: [todo('1', 'in_progress', 'шаг один'), todo('2', 'pending', 'шаг два')],
    }
    await hud.onTodoEvent(OWNER, event)
    const last = api.edited[api.edited.length - 1]!
    expect(last.text).toContain('<b>Задачи</b>')
    expect(last.text).toContain('◐ шаг один')
    expect(last.text).toContain('◻ шаг два')
    expect(last.text).toContain('0/2')
  })

  test('task_create + task_update accumulate; todo_session_stop keeps the view', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.onSessionStart(OWNER)

    await hud.onTodoEvent(OWNER, {
      kind: 'task_create',
      toolUseId: 'tu1',
      input: { subject: 'собрать фичу' },
      toolResult: 'Task #7 created successfully',
    })
    await hud.onTodoEvent(OWNER, {
      kind: 'task_update',
      toolUseId: 'tu2',
      input: { taskId: '7', status: 'completed' },
    })
    let last = api.edited[api.edited.length - 1]!
    expect(last.text).toContain('☑ собрать фичу')
    expect(last.text).toContain('1/1')

    const editsBefore = api.edited.length
    await hud.onTodoEvent(OWNER, { kind: 'todo_session_stop' })
    expect(api.edited.length).toBe(editsBefore) // stop never clears/re-renders
    // A later refresh still carries the last snapshot.
    await hud.updateNow(OWNER)
    last = api.edited[api.edited.length - 1] ?? last
    expect(last.text).toContain('☑ собрать фичу')
  })
})
