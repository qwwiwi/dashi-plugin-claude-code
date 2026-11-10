// Tests for the model-free status card service (src/status/status-widget.ts).
//
// No real timers, no real network, no real processes: the command runner, the
// scheduler, the Telegram API and the state store are all injected fakes.
// Synthetic ids only (public repo).

import { describe, expect, test } from 'bun:test'

import type { TelegramApi, SendWidgetParams } from '../../src/channel/tools.js'
import type { Logger } from '../../src/log.js'
import { redactSecrets } from '../../src/safety/redact.js'
import { createReliableTelegramApi } from '../../src/safety/reliable-telegram-api.js'
import {
  createStatusWidgetService,
  isStatusWidgetChatAllowed,
  type CommandResult,
  type CommandRunner,
  type StatusWidgetStore,
} from '../../src/status/status-widget.js'

interface StoredCard {
  chatId: string
  messageId: number
}

const CHAT = '111111111'
const HTML = '<!doctype html><div id="a"></div>'

interface Rig {
  sends: Array<{ chatId: string; params: SendWidgetParams }>
  edits: Array<{ chatId: string; messageId: number; chatData: string }>
  warns: Array<{ msg: string; ctx: Record<string, unknown> | undefined }>
  errors: string[]
  delays: number[]
  cancelled: number
  runs: string[][]
  stored: { card: StoredCard | undefined; writes: number; clears: number }
  results: CommandResult[]
  sendFails: Error[]
  editFails: Error[]
  nextMessageId: number
  fire: () => Promise<void>
  svc: ReturnType<typeof createStatusWidgetService>
}

function ok(state: unknown): CommandResult {
  return { ok: true, stdout: typeof state === 'string' ? state : JSON.stringify(state) }
}

function makeRig(opts: { stored?: StoredCard; html?: string; redact?: (t: string) => string } = {}): Rig {
  const rig = {
    sends: [],
    edits: [],
    warns: [],
    errors: [],
    delays: [],
    cancelled: 0,
    runs: [],
    stored: { card: opts.stored, writes: 0, clears: 0 },
    results: [],
    sendFails: [],
    editFails: [],
    nextMessageId: 500,
  } as unknown as Rig
  const api = {
    async sendWidget(chatId: string, params: SendWidgetParams) {
      const fail = rig.sendFails.shift()
      if (fail) throw fail
      rig.sends.push({ chatId, params })
      return { message_id: rig.nextMessageId++ }
    },
    async editWidgetData(chatId: string, messageId: number, chatData: string) {
      const fail = rig.editFails.shift()
      if (fail) throw fail
      rig.edits.push({ chatId, messageId, chatData })
    },
  } as unknown as Pick<TelegramApi, 'sendWidget' | 'editWidgetData'>
  const runner: CommandRunner = async (argv) => {
    rig.runs.push([...argv])
    const next = rig.results.shift()
    if (!next) return { ok: false, reason: 'exit' }
    return next
  }
  const store: StatusWidgetStore = {
    load: () =>
      rig.stored.card === undefined
        ? { kind: 'empty' }
        : { kind: 'record', record: { version: 1, chatId: rig.stored.card.chatId, messageId: rig.stored.card.messageId, pending: null } },
    save: (rec) => {
      // `card` is the TRACKED card: a pending attempt keeps the previous one.
      if (rec.pending === null) {
        rig.stored.card = rec.messageId === null ? undefined : { chatId: rec.chatId, messageId: rec.messageId }
      }
      rig.stored.writes += 1
    },
    clear: () => {
      rig.stored.card = undefined
      rig.stored.clears += 1
    },
  }
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg, ctx) => {
      rig.warns.push({ msg, ctx })
    },
    error: (msg) => {
      rig.errors.push(msg)
    },
  }
  let pending: (() => void) | undefined
  rig.fire = async () => {
    const fn = pending
    pending = undefined
    if (fn) fn()
    // Let the tick (a chain of microtasks) settle.
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  rig.svc = createStatusWidgetService({
    config: { chat_id: CHAT, command: ['state-cmd', '--flag'], interval_sec: 60, timeout_ms: 5000 },
    api,
    runner,
    store,
    html: opts.html ?? HTML,
    redact: opts.redact ?? ((t) => redactSecrets(t)),
    log,
    schedule: (fn, ms) => {
      rig.delays.push(ms)
      pending = fn
      return () => {
        rig.cancelled += 1
        if (pending === fn) pending = undefined
      }
    },
  })
  return rig
}

const STATE_A = { m: [['Этап', [['Один', 50]]]], j: [['Задача', 10, 'r']], l: 'a' }
const STATE_B = { m: [['Этап', [['Один', 60]]]], j: [['Задача', 20, 'r']], l: 'b' }

describe('status widget service: first card', () => {
  test('sends the card once with the status template and remembers chat + message id', async () => {
    const rig = makeRig()
    rig.results.push(ok(STATE_A))
    await rig.svc.tick()
    expect(rig.runs).toEqual([['state-cmd', '--flag']])
    expect(rig.sends).toHaveLength(1)
    expect(rig.sends[0]!.chatId).toBe(CHAT)
    expect(rig.sends[0]!.params.html).toBe(HTML)
    expect(rig.sends[0]!.params.chat_data).toBe(JSON.stringify(STATE_A))
    expect(rig.sends[0]!.params.caption.length).toBeGreaterThan(0)
    expect(rig.edits).toHaveLength(0)
    expect(rig.stored.card).toEqual({ chatId: CHAT, messageId: 500 })
  })

  test('the card send does not count as model outbound activity (skipOutboundStamp)', async () => {
    const rig = makeRig()
    rig.results.push(ok(STATE_A))
    await rig.svc.tick()
    expect(rig.sends[0]!.params.skipOutboundStamp).toBe(true)
  })

  test('through the reliable layer the card send and edits never stamp the outbound clock', async () => {
    const stamps: string[] = []
    const seen: SendWidgetParams[] = []
    const raw = {
      async sendWidget(_c: string, p: SendWidgetParams) {
        seen.push(p)
        return { message_id: 9 }
      },
      async editWidgetData() {},
    } as unknown as TelegramApi
    const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} }
    const reliable = createReliableTelegramApi(raw, silent, {
      recordOutbound: (chatId) => {
        stamps.push(chatId)
      },
    })
    await reliable.sendWidget(CHAT, { html: HTML, caption: 'c', skipOutboundStamp: true })
    await reliable.editWidgetData(CHAT, 9, '{}')
    expect(stamps).toEqual([])
    // The wrapper-only flag never travels downstream.
    expect('skipOutboundStamp' in seen[0]!).toBe(false)
    // Without the flag a widget send still stamps (existing behaviour kept).
    await reliable.sendWidget(CHAT, { html: HTML, caption: 'c' })
    expect(stamps).toEqual([CHAT])
  })
})

describe('status widget service: edit only on change', () => {
  test('edits the same message only when the state bytes changed', async () => {
    const rig = makeRig()
    rig.results.push(ok(STATE_A), ok(STATE_A), ok(STATE_B), ok(STATE_B))
    await rig.svc.tick() // send
    await rig.svc.tick() // same bytes: nothing
    expect(rig.edits).toHaveLength(0)
    await rig.svc.tick() // changed: edit
    expect(rig.edits).toEqual([{ chatId: CHAT, messageId: 500, chatData: JSON.stringify(STATE_B) }])
    await rig.svc.tick() // same as last edit: nothing
    expect(rig.edits).toHaveLength(1)
    expect(rig.sends).toHaveLength(1)
  })

  test('whitespace-only differences in the command output are not a change', async () => {
    const rig = makeRig()
    rig.results.push(ok(JSON.stringify(STATE_A)), ok(JSON.stringify(STATE_A, null, 2) + '\n'))
    await rig.svc.tick()
    await rig.svc.tick()
    expect(rig.edits).toHaveLength(0)
  })

  test('a failed edit is retried on the next tick with the same bytes', async () => {
    const rig = makeRig()
    rig.results.push(ok(STATE_A), ok(STATE_B), ok(STATE_B))
    await rig.svc.tick()
    rig.editFails.push(new Error('network down'))
    await rig.svc.tick() // edit fails
    expect(rig.edits).toHaveLength(0)
    await rig.svc.tick() // same bytes, but the last edit never landed
    expect(rig.edits).toHaveLength(1)
    expect(rig.sends).toHaveLength(1)
  })
})

describe('status widget service: restart', () => {
  test('a restart continues editing the SAME message instead of sending a new card', async () => {
    const rig = makeRig({ stored: { chatId: CHAT, messageId: 4242 } })
    rig.results.push(ok(STATE_A))
    await rig.svc.tick()
    expect(rig.sends).toHaveLength(0)
    expect(rig.edits).toEqual([{ chatId: CHAT, messageId: 4242, chatData: JSON.stringify(STATE_A) }])
  })

  test('a stored card of a different chat is ignored: a fresh card is sent', async () => {
    const rig = makeRig({ stored: { chatId: '222222222', messageId: 4242 } })
    rig.results.push(ok(STATE_A))
    await rig.svc.tick()
    expect(rig.edits).toHaveLength(0)
    expect(rig.sends).toHaveLength(1)
    expect(rig.stored.card).toEqual({ chatId: CHAT, messageId: 500 })
  })
})

describe('status widget service: failures keep the old card', () => {
  const failures: Array<[string, CommandResult]> = [
    ['non-zero exit', { ok: false, reason: 'exit' }],
    ['timeout', { ok: false, reason: 'timeout' }],
    ['spawn error', { ok: false, reason: 'spawn' }],
    ['stdout over the cap', { ok: false, reason: 'too_large' }],
  ]
  for (const [name, result] of failures) {
    test(`${name}: no API call, a warning without payload, the card stays`, async () => {
      const rig = makeRig()
      rig.results.push(ok(STATE_A), result, ok(STATE_B))
      await rig.svc.tick()
      await rig.svc.tick()
      expect(rig.edits).toHaveLength(0)
      expect(rig.sends).toHaveLength(1)
      expect(rig.warns.length).toBe(1)
      expect(rig.stored.card).toEqual({ chatId: CHAT, messageId: 500 })
      // The next good state edits the card that is still tracked.
      await rig.svc.tick()
      expect(rig.edits).toEqual([{ chatId: CHAT, messageId: 500, chatData: JSON.stringify(STATE_B) }])
    })
  }

  test('a command failure with no card yet sends nothing', async () => {
    const rig = makeRig()
    rig.results.push({ ok: false, reason: 'exit' })
    await rig.svc.tick()
    expect(rig.sends).toHaveLength(0)
    expect(rig.edits).toHaveLength(0)
  })

  test('a thrown runner never crashes the tick', async () => {
    const rig = makeRig()
    rig.results.push(ok(STATE_A))
    await rig.svc.tick()
    const boom = createStatusWidgetService({
      config: { chat_id: CHAT, command: ['x'], interval_sec: 60, timeout_ms: 5000 },
      api: { sendWidget: async () => ({ message_id: 1 }), editWidgetData: async () => {} },
      runner: async () => {
        throw new Error('runner exploded')
      },
      store: { load: () => ({ kind: 'empty' }), save: () => {}, clear: () => {} },
      html: HTML,
      redact: (t) => t,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      schedule: () => () => {},
    })
    await boom.tick()
  })
})

describe('status widget service: invalid or oversized state is never sent', () => {
  const secretLike = 'a'.repeat(30)
  const secretText = JSON.stringify({ l: `key ${secretLike}` })
  const big = JSON.stringify({ l: 'я'.repeat(600) }) // 1200+ bytes
  const exact = (n: number): string => {
    const base = JSON.stringify({ l: '' })
    // Spaced filler: a long unbroken run would (rightly) trip the redactor.
    return JSON.stringify({ l: 'a '.repeat(n).slice(0, n - Buffer.byteLength(base)) })
  }
  const cases: Array<[string, string]> = [
    ['invalid JSON', 'not json {'],
    ['empty output', ''],
    ['a JSON array', '[1,2,3]'],
    ['a JSON number', '42'],
    ['null', 'null'],
    ['over 1024 bytes (Cyrillic counts by bytes)', big],
    ['1025 bytes', exact(1025)],
    ['secret-looking text (fail-closed redaction)', secretText],
  ]
  for (const [name, stdout] of cases) {
    test(`${name}: nothing is sent or edited; the warning carries no payload`, async () => {
      const rig = makeRig()
      rig.results.push(ok(stdout))
      await rig.svc.tick()
      expect(rig.sends).toHaveLength(0)
      expect(rig.edits).toHaveLength(0)
      expect(rig.warns.length).toBe(1)
      const logged = JSON.stringify(rig.warns)
      expect(logged).not.toContain(secretLike)
      expect(logged).not.toContain('яяяя')
      expect(logged).not.toContain('not json')
    })
  }

  test('the 1024-byte limit counts the JSON without the trailing newline', async () => {
    const accepted = makeRig()
    accepted.results.push(ok(exact(1024) + '\n'))
    await accepted.svc.tick()
    expect(accepted.sends).toHaveLength(1)
    const refused = makeRig()
    refused.results.push(ok(exact(1025) + '\n'))
    await refused.svc.tick()
    expect(refused.sends).toHaveLength(0)
  })

  test('exactly 1024 bytes is accepted', async () => {
    const rig = makeRig()
    rig.results.push(ok(exact(1024)))
    await rig.svc.tick()
    expect(rig.sends).toHaveLength(1)
  })

  test('an invalid state after a good one leaves the old card untouched', async () => {
    const rig = makeRig()
    rig.results.push(ok(STATE_A), ok(secretText), ok(big))
    await rig.svc.tick()
    await rig.svc.tick()
    await rig.svc.tick()
    expect(rig.sends).toHaveLength(1)
    expect(rig.edits).toHaveLength(0)
  })

  test('a template the Bot API would refuse disables the service at start', () => {
    const rig = makeRig({ html: 'x'.repeat(40_000) })
    rig.svc.start()
    expect(rig.delays).toEqual([])
    expect(rig.errors.length).toBe(1)
  })
})

describe('status widget service: lost message', () => {
  for (const text of [
    'Bad Request: message to edit not found',
    "Bad Request: message can't be edited",
    'Bad Request: MESSAGE_ID_INVALID',
  ]) {
    test(`"${text}" forgets the message and sends a fresh card on the next tick`, async () => {
      const rig = makeRig()
      rig.results.push(ok(STATE_A), ok(STATE_B), ok(STATE_B))
      await rig.svc.tick()
      rig.editFails.push(new Error(text))
      await rig.svc.tick()
      expect(rig.stored.card).toBeUndefined()
      expect(rig.stored.clears).toBe(1)
      expect(rig.sends).toHaveLength(1)
      await rig.svc.tick()
      expect(rig.sends).toHaveLength(2)
      expect(rig.sends[1]!.params.chat_data).toBe(JSON.stringify(STATE_B))
      expect(rig.stored.card).toEqual({ chatId: CHAT, messageId: 501 })
    })
  }

  test('an unrelated edit error keeps the stored message', async () => {
    const rig = makeRig()
    rig.results.push(ok(STATE_A), ok(STATE_B))
    await rig.svc.tick()
    rig.editFails.push(new Error('fetch failed'))
    await rig.svc.tick()
    expect(rig.stored.card).toEqual({ chatId: CHAT, messageId: 500 })
    expect(rig.stored.clears).toBe(0)
  })
})

describe('status widget service: schedule and backoff', () => {
  test('start schedules the first tick at once and each tick plans the next at the interval', async () => {
    const rig = makeRig()
    rig.results.push(ok(STATE_A), ok(STATE_A))
    rig.svc.start()
    expect(rig.delays).toEqual([0])
    await rig.fire()
    expect(rig.sends).toHaveLength(1)
    expect(rig.delays).toEqual([0, 60_000])
    await rig.fire()
    expect(rig.delays).toEqual([0, 60_000, 60_000])
  })

  test('repeated failures back off, capped; one success resets the delay', async () => {
    const rig = makeRig()
    rig.svc.start()
    for (let i = 0; i < 8; i++) {
      rig.results.push({ ok: false, reason: 'exit' })
      await rig.fire()
    }
    const failed = rig.delays.slice(1)
    for (let i = 1; i < failed.length; i++) expect(failed[i]!).toBeGreaterThanOrEqual(failed[i - 1]!)
    expect(failed[0]!).toBeGreaterThan(60_000)
    expect(failed[failed.length - 1]!).toBeLessThanOrEqual(600_000)
    expect(failed[failed.length - 1]!).toBe(failed[failed.length - 2]!) // reached the cap
    rig.results.push(ok(STATE_A))
    await rig.fire()
    expect(rig.delays[rig.delays.length - 1]).toBe(60_000)
  })

  test('a failing send backs off too (never a tight loop)', async () => {
    const rig = makeRig()
    rig.svc.start()
    rig.results.push(ok(STATE_A))
    rig.sendFails.push(new Error('fetch failed'))
    await rig.fire()
    expect(rig.delays[1]!).toBeGreaterThan(60_000)
    expect(rig.stored.card).toBeUndefined()
  })

  test('stop cancels the pending timer and ignores later ticks', async () => {
    const rig = makeRig()
    rig.svc.start()
    rig.svc.stop()
    expect(rig.cancelled).toBe(1)
    rig.results.push(ok(STATE_A))
    await rig.fire()
    expect(rig.sends).toHaveLength(0)
  })
})

describe('status widget service: sendFresh (the /card path)', () => {
  test('sends a fresh card right now and tracks it; the next tick edits the new message', async () => {
    const rig = makeRig({ stored: { chatId: CHAT, messageId: 4242 } })
    rig.results.push(ok(STATE_A), ok(STATE_B))
    const res = await rig.svc.sendFresh(CHAT)
    expect(res).toEqual({ ok: true })
    expect(rig.sends).toHaveLength(1)
    expect(rig.sends[0]!.params.skipOutboundStamp).toBe(true)
    expect(rig.stored.card).toEqual({ chatId: CHAT, messageId: 500 })
    await rig.svc.tick()
    expect(rig.edits).toEqual([{ chatId: CHAT, messageId: 500, chatData: JSON.stringify(STATE_B) }])
  })

  test('after sendFresh the same state bytes are not edited again', async () => {
    const rig = makeRig()
    rig.results.push(ok(STATE_A), ok(STATE_A))
    await rig.svc.sendFresh(CHAT)
    await rig.svc.tick()
    expect(rig.edits).toHaveLength(0)
  })

  test('uses the last good state when the command fails; no state at all is a clear refusal', async () => {
    const rig = makeRig()
    rig.results.push({ ok: false, reason: 'exit' })
    const none = await rig.svc.sendFresh(CHAT)
    expect(none.ok).toBe(false)
    expect(rig.sends).toHaveLength(0)
    rig.results.push(ok(STATE_A), { ok: false, reason: 'timeout' })
    await rig.svc.tick()
    const again = await rig.svc.sendFresh(CHAT)
    expect(again).toEqual({ ok: true })
    expect(rig.sends).toHaveLength(2)
    expect(rig.sends[1]!.params.chat_data).toBe(JSON.stringify(STATE_A))
  })

  test('refuses any chat other than the configured one', async () => {
    const rig = makeRig()
    rig.results.push(ok(STATE_A))
    const res = await rig.svc.sendFresh('222222222')
    expect(res.ok).toBe(false)
    expect(rig.sends).toHaveLength(0)
    expect(rig.runs).toHaveLength(0)
  })

  test('a failing send is reported, not thrown', async () => {
    const rig = makeRig()
    rig.results.push(ok(STATE_A))
    rig.sendFails.push(new Error('fetch failed'))
    const res = await rig.svc.sendFresh(CHAT)
    expect(res.ok).toBe(false)
  })
})

describe('status widget chat gate', () => {
  test('the card chat must be on the same allowlist the widget tools use', () => {
    expect(isStatusWidgetChatAllowed({ allowed_chat_ids: [111111111, -100222222222] }, '111111111')).toBe(true)
    expect(isStatusWidgetChatAllowed({ allowed_chat_ids: [333333333] }, '111111111')).toBe(false)
    expect(isStatusWidgetChatAllowed({ allowed_chat_ids: [] }, '111111111')).toBe(false)
  })
})
