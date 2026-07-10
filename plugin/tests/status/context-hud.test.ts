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
    usage?: { usedTokens: number; pct: number; model?: string } | null
    session?: SessionInfoReader
    windowOverride?: number
  } = {},
): ContextHud {
  return new ContextHud({
    api,
    log,
    sessionInfo: opts.session ?? fakeSession({ transcriptPath: '/t/a.jsonl', model: 'opus' }),
    windowTokens: WINDOW,
    windowOverride: opts.windowOverride,
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

  test('1M window: denominator renders «1M», pct against 1M', () => {
    // 151k of a 1M window ≈ 15% (was mis-reported as 76% against a 200k cap).
    const { text } = renderHud({ usedTokens: 151_000 }, 1_000_000, 'claude-fable-5')
    expect(text).toContain('15% (151k / 1M)')
    expect(filledCount(text)).toBe(2) // round(15/10) = 2 segments
  })

  test('keyboard shape: single Сжать row, no Новый диалог button', () => {
    const { keyboard } = renderHud({ usedTokens: 0 }, WINDOW)
    expect(keyboard).toEqual(buildHudKeyboard())
    const rows = keyboard.inline_keyboard
    expect(rows.length).toBe(1)
    expect(rows[0]).toHaveLength(1)
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

// The core of this PR: hook payloads carry NO model field, so the HUD must
// derive the window from the transcript-provided model (readContextUsage →
// usage.model). Precedence: override > transcript model (usage.model, per-turn
// FRESH) > hook model (info.model) > fallback.
describe('ContextHud model-from-transcript window', () => {
  test('hook model absent + transcript model "claude-fable-5" → 1M window + model line', async () => {
    const api = new FakeApi()
    const hud = makeHud(api, {
      session: fakeSession({ transcriptPath: '/t/a.jsonl' }), // NO model on the hook
      usage: { usedTokens: 151_000, pct: 0.15, model: 'claude-fable-5' },
    })
    await hud.onSessionStart(OWNER)
    const text = api.sent[0]!.text
    expect(text).toContain('/ 1M)') // denominator is the 1M window, not 200k
    expect(text).toContain('15% (151k / 1M)')
    expect(text).toContain('<i>claude-fable-5</i>') // model line rendered
  })

  test('transcript model wins over hook model (per-turn fresh is authoritative)', async () => {
    const api = new FakeApi()
    const hud = makeHud(api, {
      // Stale hook says opus, but the transcript's fresh turn says Fable —
      // e.g. after a mid-session /model switch. Transcript must win.
      session: fakeSession({ transcriptPath: '/t/a.jsonl', model: 'claude-opus-4-8' }),
      usage: { usedTokens: 100_000, pct: 0.5, model: 'claude-fable-5' },
    })
    await hud.onSessionStart(OWNER)
    const text = api.sent[0]!.text
    expect(text).toContain('/ 1M)') // Fable (transcript) → 1M, not opus 200k
    expect(text).toContain('<i>claude-fable-5</i>')
  })

  test('hook model used when the transcript carries none', async () => {
    const api = new FakeApi()
    const hud = makeHud(api, {
      session: fakeSession({ transcriptPath: '/t/a.jsonl', model: 'claude-fable-5' }),
      usage: { usedTokens: 100_000, pct: 0.5 }, // no transcript model
    })
    await hud.onSessionStart(OWNER)
    const text = api.sent[0]!.text
    expect(text).toContain('/ 1M)') // hook Fable → 1M when transcript is silent
    expect(text).toContain('<i>claude-fable-5</i>')
  })

  test('explicit windowOverride still wins over the transcript model', async () => {
    const api = new FakeApi()
    const hud = makeHud(api, {
      session: fakeSession({ transcriptPath: '/t/a.jsonl' }), // no hook model
      usage: { usedTokens: 150_000, pct: 0.5, model: 'claude-fable-5' },
      windowOverride: 300_000,
    })
    await hud.onSessionStart(OWNER)
    const text = api.sent[0]!.text
    expect(text).toContain('50% (150k / 300k)') // override 300k beats Fable 1M
  })

  test('no model anywhere → 200k fallback', async () => {
    const api = new FakeApi()
    const hud = makeHud(api, {
      session: fakeSession({ transcriptPath: '/t/a.jsonl' }), // no hook model
      usage: { usedTokens: 100_000, pct: 0.5 }, // no transcript model
    })
    await hud.onSessionStart(OWNER)
    expect(api.sent[0]!.text).toContain('50% (100k / 200k)')
  })
})

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

  test('detail lives in an expandable blockquote; header stays outside', () => {
    const text = renderStatusTasks([
      todo('1', 'completed', 'done-a'),
      todo('2', 'in_progress', 'now', 'Doing X'),
      todo('3', 'pending', 'later'),
    ])
    const qi = text.indexOf('<blockquote expandable>')
    expect(qi).toBeGreaterThan(-1)
    // header (bar + count) is before the quote, not inside it
    expect(text.slice(0, qi)).toContain('<b>Задачи</b>')
    expect(text.endsWith('</blockquote>')).toBe(true)
    // per-task detail is inside the collapsible quote
    const inside = text.slice(qi)
    expect(inside).toContain('◐ Doing X')
    expect(inside).toContain('◻ later')
    expect(inside).toContain('☑ done-a')
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
      sessionId: 's1',
      todos: [todo('1', 'in_progress', 'шаг один'), todo('2', 'pending', 'шаг два')],
    }
    await hud.onTodoEvent(OWNER, event)
    const last = api.edited[api.edited.length - 1]!
    expect(last.text).toContain('<b>Задачи</b>')
    expect(last.text).toContain('◐ шаг один')
    expect(last.text).toContain('◻ шаг два')
    expect(last.text).toContain('0/2')
  })

  test('task_create + task_update accumulate; session_end keeps the view', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.onSessionStart(OWNER, { sessionId: 's1', source: 'startup' })

    await hud.onTodoEvent(OWNER, {
      kind: 'task_create',
      sessionId: 's1',
      toolUseId: 'tu1',
      input: { subject: 'собрать фичу' },
      toolResult: 'Task #7 created successfully',
    })
    await hud.onTodoEvent(OWNER, {
      kind: 'task_update',
      sessionId: 's1',
      toolUseId: 'tu2',
      input: { taskId: '7', status: 'completed' },
    })
    let last = api.edited[api.edited.length - 1]!
    expect(last.text).toContain('☑ собрать фичу')
    expect(last.text).toContain('1/1')

    // SessionEnd refreshes but keeps the last snapshot visible.
    await hud.onSessionEnd(OWNER, { sessionId: 's1' })
    await hud.updateNow(OWNER)
    last = api.edited[api.edited.length - 1] ?? last
    expect(last.text).toContain('☑ собрать фичу')
  })

  test('compact (same session id) preserves tasks; a new session id clears them', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.onSessionStart(OWNER, { sessionId: 's1', source: 'startup' })
    await hud.onTodoEvent(OWNER, {
      kind: 'todo_write',
      sessionId: 's1',
      todos: [todo('1', 'in_progress', 'живая задача')],
    })
    expect(api.edited[api.edited.length - 1]!.text).toContain('живая задача')

    // Compact: SAME id → tasks preserved.
    await hud.onSessionStart(OWNER, { sessionId: 's1', source: 'compact' })
    expect(api.edited[api.edited.length - 1]!.text).toContain('живая задача')

    // New session id → tasks cleared (section omitted).
    await hud.onSessionStart(OWNER, { sessionId: 's2', source: 'startup' })
    expect(api.edited[api.edited.length - 1]!.text).not.toContain('живая задача')
  })

  test('source=clear wipes tasks even on the same session id', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.onSessionStart(OWNER, { sessionId: 's1', source: 'startup' })
    await hud.onTodoEvent(OWNER, {
      kind: 'todo_write',
      sessionId: 's1',
      todos: [todo('1', 'in_progress', 'сотрётся')],
    })
    expect(api.edited[api.edited.length - 1]!.text).toContain('сотрётся')
    await hud.onSessionStart(OWNER, { sessionId: 's1', source: 'clear' })
    expect(api.edited[api.edited.length - 1]!.text).not.toContain('сотрётся')
  })

  test('a task event with a new session id resets the stale snapshot', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.onSessionStart(OWNER, { sessionId: 's1', source: 'startup' })
    await hud.onTodoEvent(OWNER, {
      kind: 'todo_write',
      sessionId: 's1',
      todos: [todo('1', 'in_progress', 'старое'), todo('2', 'pending', 'ещё старое')],
    })
    // A task event from a new session (missed SessionStart) — replace, not blend.
    await hud.onTodoEvent(OWNER, {
      kind: 'todo_write',
      sessionId: 's2',
      todos: [todo('9', 'in_progress', 'новое')],
    })
    const last = api.edited[api.edited.length - 1]!
    expect(last.text).toContain('новое')
    expect(last.text).not.toContain('старое')
  })
})

// ─────────────────────────────────────────────────────────────────────
// M3 reality mirror — applyReconciledView
// ─────────────────────────────────────────────────────────────────────

describe('applyReconciledView', () => {
  test('renders the reconciled list + freshness label into the pinned card', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.applyReconciledView(OWNER, {
      sessionId: 's1',
      todos: [
        { id: '1', content: 'живая задача', status: 'in_progress' },
        { id: '2', content: 'ещё одна', status: 'pending' },
      ],
      freshness: { kind: 'fresh', reconciledAgeMs: 5_000 },
    })
    const text = api.sent.length > 0 ? api.sent[0]!.text : api.edited[api.edited.length - 1]!.text
    expect(text).toContain('<b>Задачи</b> · <i>сверено меньше минуты назад</i>')
    expect(text).toContain('живая задача')
  })

  test('non-owner chat is a no-op', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.applyReconciledView('-100999', {
      sessionId: 's1',
      todos: [{ id: '1', content: 'x', status: 'pending' }],
      freshness: { kind: 'unverified' },
    })
    expect(api.sent.length).toBe(0)
  })

  test('«НЕ СВЕРЕНО» when the view is unverified', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.applyReconciledView(OWNER, {
      sessionId: 's1',
      todos: [{ id: '1', content: 'только событие', status: 'pending' }],
      freshness: { kind: 'unverified' },
    })
    const text = api.sent[0]!.text
    expect(text).toContain('<b>Задачи — НЕ СВЕРЕНО</b>')
    expect(text).toContain('Показаны только события инструментов')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Review fix-loop 2026-07-09 #2 — HUD session epochs / tombstones
// ─────────────────────────────────────────────────────────────────────

describe('HUD session end/start epochs', () => {
  test('end(s1) → start(s2): the new session does NOT inherit dead tasks', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.onSessionStart(OWNER, { sessionId: 's1', source: 'startup' })
    await hud.onTodoEvent(OWNER, {
      kind: 'todo_write',
      sessionId: 's1',
      todos: [todo('1', 'in_progress', 'мертвая задача')],
    })
    await hud.onSessionEnd(OWNER, { sessionId: 's1' })

    // Pre-fix: onSessionEnd deleted the tracked id → the next startup saw
    // sessionChanged=false and kept showing the dead session's tasks.
    await hud.onSessionStart(OWNER, { sessionId: 's2', source: 'startup' })
    const last = api.edited[api.edited.length - 1]!
    expect(last.text).not.toContain('мертвая задача')
  })

  test('end(s1) → resume(s1): tasks preserved and s1 events flow again', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.onSessionStart(OWNER, { sessionId: 's1', source: 'startup' })
    await hud.onTodoEvent(OWNER, {
      kind: 'todo_write',
      sessionId: 's1',
      todos: [todo('1', 'in_progress', 'живая работа')],
    })
    await hud.onSessionEnd(OWNER, { sessionId: 's1' })

    // Resume: SAME id → snapshot preserved (compact/resume semantics).
    await hud.onSessionStart(OWNER, { sessionId: 's1', source: 'resume' })
    expect(api.edited[api.edited.length - 1]!.text).toContain('живая работа')

    // Un-tombstoned: further s1 events are accepted.
    await hud.onTodoEvent(OWNER, {
      kind: 'todo_write',
      sessionId: 's1',
      todos: [todo('1', 'completed', 'живая работа')],
    })
    expect(api.edited[api.edited.length - 1]!.text).toContain('1/1')
  })

  test('a late task event from an ENDED session is dropped (no clobbering the active one)', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.onSessionStart(OWNER, { sessionId: 's1', source: 'startup' })
    await hud.onSessionEnd(OWNER, { sessionId: 's1' })
    await hud.onSessionStart(OWNER, { sessionId: 's2', source: 'startup' })
    await hud.onTodoEvent(OWNER, {
      kind: 'todo_write',
      sessionId: 's2',
      todos: [todo('1', 'in_progress', 'актуальная работа')],
    })
    expect(api.edited[api.edited.length - 1]!.text).toContain('актуальная работа')

    // Straggler from dead s1 — must NOT replace s2's snapshot.
    await hud.onTodoEvent(OWNER, {
      kind: 'todo_write',
      sessionId: 's1',
      todos: [todo('9', 'pending', 'призрак')],
    })
    const last = api.edited[api.edited.length - 1]!
    expect(last.text).toContain('актуальная работа')
    expect(last.text).not.toContain('призрак')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Review fix-loop 2026-07-09 SHOULD — reconciled-render dedup
// ─────────────────────────────────────────────────────────────────────

describe('applyReconciledView dedup', () => {
  test('identical renders (same bucket, same tasks) skip editMessageText', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    const view = {
      sessionId: 's1',
      todos: [todo('1', 'in_progress', 'долгая работа')],
      freshness: { kind: 'fresh', reconciledAgeMs: 5_000 } as const,
    }
    await hud.applyReconciledView(OWNER, view)
    const editsAfterFirst = api.edited.length
    // Reconciler ticks: same tasks, same «меньше минуты» bucket.
    await hud.applyReconciledView(OWNER, { ...view, freshness: { kind: 'fresh', reconciledAgeMs: 25_000 } })
    await hud.applyReconciledView(OWNER, { ...view, freshness: { kind: 'fresh', reconciledAgeMs: 45_000 } })
    expect(api.edited.length).toBe(editsAfterFirst) // zero extra edits

    // Bucket crossing («1 мин») changes the render → ONE refresh goes through.
    await hud.applyReconciledView(OWNER, { ...view, freshness: { kind: 'fresh', reconciledAgeMs: 65_000 } })
    expect(api.edited.length + api.sent.length).toBeGreaterThan(editsAfterFirst)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Review fix-loop round 2 (2026-07-10) — HUD rollback guard + epochs
// ─────────────────────────────────────────────────────────────────────

describe('HUD #2v2 rollback guard + persisted epochs', () => {
  test('late SessionStart for an ENDED session does not displace the active one', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.onSessionStart(OWNER, { sessionId: 's1', source: 'startup' })
    await hud.onSessionEnd(OWNER, { sessionId: 's1' })
    await hud.onSessionStart(OWNER, { sessionId: 's2', source: 'startup' })
    await hud.onTodoEvent(OWNER, {
      kind: 'todo_write',
      sessionId: 's2',
      todos: [todo('1', 'in_progress', 'актуальная')],
    })
    expect(api.edited[api.edited.length - 1]!.text).toContain('актуальная')

    // REPLAYED SessionStart for dead s1: must NOT clear s2's snapshot.
    await hud.onSessionStart(OWNER, { sessionId: 's1', source: 'startup' })
    expect(api.edited[api.edited.length - 1]!.text).toContain('актуальная')

    // s1 stays tombstoned — its late events remain dropped.
    await hud.onTodoEvent(OWNER, {
      kind: 'todo_write',
      sessionId: 's1',
      todos: [todo('9', 'pending', 'призрак')],
    })
    expect(api.edited[api.edited.length - 1]!.text).not.toContain('призрак')
  })

  test('epochs survive a restart: a straggler from an ended session stays dropped', async () => {
    const dir = stateDir()
    const api1 = new FakeApi()
    const hud1 = makeHud(api1, { dir })
    await hud1.onSessionStart(OWNER, { sessionId: 's1', source: 'startup' })
    await hud1.onSessionEnd(OWNER, { sessionId: 's1' })

    // «Restart»: fresh HUD instance, same state dir. Pre-fix the tombstones
    // were runtime-only — this straggler adopted the dead session again.
    const api2 = new FakeApi()
    const hud2 = makeHud(api2, { dir })
    await hud2.onTodoEvent(OWNER, {
      kind: 'todo_write',
      sessionId: 's1',
      todos: [todo('1', 'pending', 'призрак после рестарта')],
    })
    expect(api2.sent.length + api2.edited.length).toBe(0) // dropped

    // A fresh session works normally.
    await hud2.onTodoEvent(OWNER, {
      kind: 'todo_write',
      sessionId: 's2',
      todos: [todo('1', 'in_progress', 'новая работа')],
    })
    const last =
      api2.edited.length > 0 ? api2.edited[api2.edited.length - 1]!.text : api2.sent[0]!.text
    expect(last).toContain('новая работа')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Model-aware context window (the pin follows the session model)
// ─────────────────────────────────────────────────────────────────────

describe('ContextHud — model-aware window', () => {
  // A session view whose model can change between turns (mid-session switch).
  function mutableSession(initial: {
    transcriptPath?: string
    model?: string
  }): { reader: SessionInfoReader; set(model: string): void } {
    const info: { transcriptPath?: string; model?: string } = { ...initial }
    return {
      reader: { get: () => info },
      set(model: string) {
        info.model = model
      },
    }
  }

  function hudWith(
    api: HudTelegramApi,
    session: SessionInfoReader,
    override?: number,
  ): ContextHud {
    return new ContextHud({
      api,
      log,
      sessionInfo: session,
      windowTokens: WINDOW, // 200k fallback default
      windowOverride: override,
      ownerChatIds: [OWNER],
      stateDir: stateDir(),
      enabled: true,
      // Fixed numerator — the resolver only changes the DENOMINATOR.
      readContextUsage: async () => ({ usedTokens: 100_000, pct: 0.5 }),
    })
  }

  test('Fable-5 session reports its 1M window, not the 200k default', async () => {
    const api = new FakeApi()
    const s = mutableSession({ transcriptPath: '/t/a.jsonl', model: 'claude-fable-5' })
    const hud = hudWith(api, s.reader)
    await hud.onSessionStart(OWNER)
    // 100k / 1M = 10%.
    expect(api.sent[0]!.text).toContain("10% (100k / 1M)")
  })

  test("mid-session model switch (Opus → Fable) moves the denominator", async () => {
    const api = new FakeApi()
    const s = mutableSession({ transcriptPath: "/t/a.jsonl", model: "claude-opus-4-8" })
    const hud = hudWith(api, s.reader)
    await hud.onSessionStart(OWNER)
    // 100k / 200k = 50%.
    expect(api.sent[0]!.text).toContain("50% (100k / 200k)")

    s.set("claude-fable-5")
    await hud.onStop(OWNER)
    // Same used tokens, now against 1M → 10%.
    expect(api.edited[api.edited.length - 1]!.text).toContain("10% (100k / 1M)")
  })

  test("unknown model falls back to the 200k default", async () => {
    const api = new FakeApi()
    const s = mutableSession({ transcriptPath: "/t/a.jsonl", model: "gpt-5" })
    const hud = hudWith(api, s.reader)
    await hud.onSessionStart(OWNER)
    expect(api.sent[0]!.text).toContain("50% (100k / 200k)")
  })

  test("explicit override wins over the model table", async () => {
    const api = new FakeApi()
    const s = mutableSession({ transcriptPath: "/t/a.jsonl", model: "claude-fable-5" })
    const hud = hudWith(api, s.reader, 500_000)
    await hud.onSessionStart(OWNER)
    // Override 500k beats Fable 1M: 100k / 500k = 20%.
    expect(api.sent[0]!.text).toContain("20% (100k / 500k)")
  })
})
