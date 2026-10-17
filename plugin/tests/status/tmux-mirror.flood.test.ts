// TmuxMirror flood-control tests (incident 2026-10-16).
//
// The mirror edited one message up to 12x/min because volatile pane
// counters («3m 38s · ↓ 214.9k tokens», «1d 0h 17m») changed the hash on
// almost every poll. Telegram answered with a ~7h bot-wide 429 ban, and the
// mirror kept hitting it. These tests pin the fix:
//   • a 429 parks the mirror for the REAL retry_after (no 60s cap);
//   • a counter-only pane change produces no edit;
//   • the minimum edit interval and the per-minute budget hold;
//   • mirror calls are marked `background` for the flood gate, and on top of
//     the real rate-limited layer a closed gate keeps them off the API.

import { describe, expect, test } from 'bun:test'

import type {
  ChatAction,
  DownloadResult,
  EditOpts,
  SendDocumentOpts,
  SendMessageOpts,
  TelegramApi,
} from '../../src/channel/tools.js'
import type { Logger } from '../../src/log.js'
import { createRateLimitedTelegramApi } from '../../src/safety/rate-limited-telegram-api.js'
import {
  TmuxMirror,
  normalizeForHash,
  type TmuxExec,
  type TmuxExecResult,
} from '../../src/status/tmux-mirror.js'

class TelegramError extends Error {
  error_code: number
  description: string
  parameters?: { retry_after?: number }
  constructor(code: number, description: string, params?: { retry_after?: number }) {
    super(`telegram ${code}: ${description}`)
    this.error_code = code
    this.description = description
    if (params) this.parameters = params
  }
}

interface Op {
  method: 'sendMessage' | 'editMessageText' | 'deleteMessage'
  text?: string
  opts?: SendMessageOpts | EditOpts
}

function makeStubApi(): {
  api: TelegramApi
  ops: Op[]
  queueEditError(err: Error): void
} {
  const ops: Op[] = []
  const editErrors: Error[] = []
  let nextId = 100
  const api: TelegramApi = {
    async sendMessage(_chatId, text, opts: SendMessageOpts) {
      ops.push({ method: 'sendMessage', text, opts })
      return { message_id: nextId++ }
    },
    async sendRichMessage() {
      return { fallback: true as const }
    },
    async editRichMessage() {
      return { fallback: true } as const
    },
    async editMessageText(_chatId, _messageId, text, opts: EditOpts) {
      ops.push({ method: 'editMessageText', text, opts })
      const err = editErrors.shift()
      if (err) throw err
    },
    async answerGuestQuery() {},
    async deleteMessage() {
      ops.push({ method: 'deleteMessage' })
    },
    async setMessageReaction() {},
    async sendChatAction(_chatId, _action: ChatAction) {},
    async sendDocument(_chatId, _filePath, _opts: SendDocumentOpts) {
      return { message_id: 0 }
    },
    async sendPhoto(_chatId, _filePath, _opts: SendDocumentOpts) {
      return { message_id: 0 }
    },
    async downloadFile(): Promise<DownloadResult> {
      return { path: '/tmp/x', size: 0 }
    },
  }
  return { api, ops, queueEditError: (err) => editErrors.push(err) }
}

const stubLog: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function ok(stdout: string): TmuxExecResult {
  return { stdout, stderr: '', exitCode: 0 }
}

// Exec that returns whatever `pane.text` holds right now, and counts calls.
function livePane(initial: string): { exec: TmuxExec; pane: { text: string }; calls: () => number } {
  const pane = { text: initial }
  let n = 0
  return {
    pane,
    calls: () => n,
    exec: async () => {
      n += 1
      return ok(pane.text)
    },
  }
}

function makeMirror(
  api: TelegramApi,
  exec: TmuxExec,
  clock: { t: number },
  extra: { minEditIntervalMs?: number; maxEditsPerMinute?: number } = {},
): TmuxMirror {
  return new TmuxMirror({
    api,
    log: stubLog,
    chatId: '100',
    paneTarget: 'channel-silvana:0.0',
    pollIntervalMs: 60_000,
    lineCount: 50,
    exec,
    now: () => clock.t,
    // Raw pane: the structural filter is not under test here.
    mode: 'full_pane',
    hideSegments: [],
    ...extra,
  })
}

const edits = (ops: Op[]): Op[] => ops.filter((o) => o.method === 'editMessageText')

describe('normalizeForHash', () => {
  test('masks counters inside Claude Code status rows only', () => {
    const a = [
      '✻ Cogitating… (3m 38s · ↓ 214.9k tokens · esc to interrupt)',
      '  agent-1 · 3m 38s · ↓ 214.9k tokens',
      '  agent-2   1d 0h 17m',
    ].join('\n')
    const b = [
      '✽ Pondering… (3m 43s · ↓ 215.2k tokens · esc to interrupt)',
      '  agent-1 · 3m 43s · ↓ 215.2k tokens',
      '  agent-2   1d 0h 18m',
    ].join('\n')
    expect(normalizeForHash(a)).toBe(normalizeForHash(b))
  })

  test('numbers with units outside status rows are kept verbatim', () => {
    for (const [a, b] of [
      ['Timeout: 20s', 'Timeout: 30s'],
      ['retry in 5m', 'retry in 10m'],
      ['built at 14:05', 'built at 14:07'],
      ['coverage 81%', 'coverage 84%'],
      ['Read 120 tokens of input', 'Read 900 tokens of input'],
    ] as const) {
      expect(normalizeForHash(a)).not.toBe(normalizeForHash(b))
    }
  })

  test('a substantive change next to a status row still differs', () => {
    const a = '● Bash(git status)\n  agent-1 · 3m 38s · ↓ 214.9k tokens'
    const b = '● Bash(bun test)\n  agent-1 · 3m 43s · ↓ 215.2k tokens'
    expect(normalizeForHash(a)).not.toBe(normalizeForHash(b))
  })
})

describe('TmuxMirror — flood control', () => {
  test('a counter-only pane change produces no edit (until the 5-min refresh)', async () => {
    const stub = makeStubApi()
    const clock = { t: 1_000_000 }
    const pane = (i: number): string =>
      `● Bash(bun test)\n  agent-1 · 3m ${38 + i}s · ↓ ${214 + i}.9k tokens\n  agent-2   1d 0h ${17 + i}m`
    const live = livePane(pane(0))
    const mirror = makeMirror(stub.api, live.exec, clock)
    await mirror.start()
    expect(stub.ops.filter((o) => o.method === 'sendMessage').length).toBe(1)

    // Counters tick every 5s poll for 4m55s — well past every budget window.
    let i = 0
    while (i < 59) {
      i += 1
      clock.t += 5_000
      live.pane.text = pane(i)
      await mirror.onPoll()
    }
    expect(edits(stub.ops).length).toBe(0)

    // Safety net: at 5 min the stale counters get ONE refresh, then quiet again.
    i += 1
    clock.t += 5_000
    live.pane.text = pane(i)
    await mirror.onPoll()
    expect(edits(stub.ops).length).toBe(1)
    expect(edits(stub.ops)[0]?.text).toContain(`1d 0h ${17 + i}m`)
    for (let k = 0; k < 12; k += 1) {
      i += 1
      clock.t += 5_000
      live.pane.text = pane(i)
      await mirror.onPoll()
    }
    expect(edits(stub.ops).length).toBe(1)
    await mirror.stop()
  })

  test('a real change like "Timeout: 20s" → "Timeout: 30s" produces an edit', async () => {
    const stub = makeStubApi()
    const clock = { t: 1_000_000 }
    const live = livePane('● Bash(curl api)\n  Timeout: 20s')
    const mirror = makeMirror(stub.api, live.exec, clock)
    await mirror.start()
    clock.t += 20_000
    live.pane.text = '● Bash(curl api)\n  Timeout: 30s'
    await mirror.onPoll()
    expect(edits(stub.ops).length).toBe(1)
    expect(edits(stub.ops)[0]?.text).toContain('Timeout: 30s')
    await mirror.stop()
  })

  test('min_edit_interval_ms above 60s is honoured (not pruned with the 60s window)', async () => {
    const stub = makeStubApi()
    const clock = { t: 1_000_000 }
    const live = livePane('v0')
    const mirror = makeMirror(stub.api, live.exec, clock, { minEditIntervalMs: 120_000 })
    await mirror.start()
    const editTimes: number[] = []
    for (let i = 1; i <= 60; i += 1) {
      clock.t += 5_000
      live.pane.text = `v${'z'.repeat(i)}`
      const before = edits(stub.ops).length
      await mirror.onPoll()
      if (edits(stub.ops).length > before) editTimes.push(clock.t)
    }
    // 5 minutes of changes → edits at 5s, 125s, 245s.
    expect(editTimes.length).toBe(3)
    for (let k = 1; k < editTimes.length; k += 1) {
      expect(editTimes[k]! - editTimes[k - 1]!).toBeGreaterThanOrEqual(120_000)
    }
    await mirror.stop()
  })

  test('min edit interval (20s default) is respected and the change is not lost', async () => {
    const stub = makeStubApi()
    const clock = { t: 1_000_000 }
    const live = livePane('step 0')
    const mirror = makeMirror(stub.api, live.exec, clock, { maxEditsPerMinute: 0 })
    await mirror.start()

    // Pane changes substantively on EVERY 5s poll.
    const editTimes: number[] = []
    for (let i = 1; i <= 12; i += 1) {
      clock.t += 5_000
      live.pane.text = `step ${'x'.repeat(i)}`
      const before = edits(stub.ops).length
      await mirror.onPoll()
      if (edits(stub.ops).length > before) editTimes.push(clock.t)
    }
    // 60s of changes → edits at 5s, 25s, 45s only.
    expect(editTimes.length).toBe(3)
    for (let i = 1; i < editTimes.length; i += 1) {
      expect(editTimes[i]! - editTimes[i - 1]!).toBeGreaterThanOrEqual(20_000)
    }
    // The last edit carried the pane as it was at that poll (latest, not stale).
    const last = edits(stub.ops).at(-1)
    expect(last?.text).toContain(`step ${'x'.repeat(9)}`)
    await mirror.stop()
  })

  test('per-minute budget caps edits even with the interval disabled', async () => {
    const stub = makeStubApi()
    const clock = { t: 1_000_000 }
    const live = livePane('v0')
    const mirror = makeMirror(stub.api, live.exec, clock, { minEditIntervalMs: 0, maxEditsPerMinute: 3 })
    await mirror.start()
    for (let i = 1; i <= 10; i += 1) {
      clock.t += 1_000
      live.pane.text = `v${'y'.repeat(i)}`
      await mirror.onPoll()
    }
    expect(edits(stub.ops).length).toBe(3)
    await mirror.stop()
  })

  test('mirror sends and edits are marked background', async () => {
    const stub = makeStubApi()
    const clock = { t: 1_000_000 }
    const live = livePane('a')
    const mirror = makeMirror(stub.api, live.exec, clock)
    await mirror.start()
    clock.t += 20_000
    live.pane.text = 'b'
    await mirror.onPoll()
    expect(stub.ops.length).toBe(2)
    for (const op of stub.ops) expect(op.opts?.background).toBe(true)
    await mirror.stop()
  })

  test('a 429 on an edit pauses the mirror for the real retry_after (no 60s cap)', async () => {
    const stub = makeStubApi()
    const clock = { t: 1_000_000 }
    const live = livePane('a')
    const mirror = makeMirror(stub.api, live.exec, clock)
    await mirror.start()

    const BAN_S = 7 * 3600
    stub.queueEditError(new TelegramError(429, 'Too Many Requests: retry after 25200', { retry_after: BAN_S }))
    clock.t += 20_000
    live.pane.text = 'b'
    await mirror.onPoll()
    expect(edits(stub.ops).length).toBe(1)
    expect(mirror.status().pausedUntil).toBe(clock.t + BAN_S * 1000)
    expect(mirror.status().disabled).toBeUndefined()

    // Poll every 5s for the next 6h59m: no capture, no API call, no bump.
    const capturesAtBan = live.calls()
    const opsAtBan = stub.ops.length
    const banEnd = clock.t + BAN_S * 1000
    while (clock.t + 60_000 < banEnd) {
      clock.t += 60_000
      live.pane.text = `change ${clock.t}`
      await mirror.onPoll()
      await mirror.bump()
    }
    expect(stub.ops.length).toBe(opsAtBan)
    expect(live.calls()).toBe(capturesAtBan)

    // Ban over → the next poll ships the latest pane.
    clock.t = banEnd
    await mirror.onPoll()
    expect(edits(stub.ops).length).toBe(2)
    expect(mirror.status().pausedUntil).toBeUndefined()
    await mirror.stop()
  })

  test('on the real rate-limited layer: one 429, then the flood gate keeps the mirror off the API', async () => {
    const stub = makeStubApi()
    const clock = { t: 1_000_000 }
    const sleeps: number[] = []
    const api = createRateLimitedTelegramApi(stub.api, stubLog, {
      now: () => clock.t,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      jitterMaxMs: 0,
    })
    const live = livePane('a')
    const mirror = makeMirror(api, live.exec, clock)
    await mirror.start()

    stub.queueEditError(new TelegramError(429, 'Too Many Requests', { retry_after: 600 }))
    clock.t += 20_000
    live.pane.text = 'b'
    await mirror.onPoll()
    // Exactly one attempt reached the stub, and no in-process retry sleep.
    expect(edits(stub.ops).length).toBe(1)
    expect(sleeps).toEqual([])
    expect(mirror.status().pausedUntil).toBe(clock.t + 600_000)
    await mirror.stop()
  })
})
