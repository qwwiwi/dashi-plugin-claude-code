// Tests for HeartbeatMonitor (M4, fix-loop 1): mechanical heartbeat (pin @25m
// / message @60m, hourly budget PER CHAT persistent across turns, silence
// window seeded when no outbound record exists), dead-man (pane frozen >10m),
// and open-question reminders (2h once / sticky 6h cadence, restart-burst
// seeding). Deterministic clock + injected send/pin callbacks; the autonomy
// registry is a real on-disk file so we can also prove the heartbeat path
// NEVER mutates it (byte-identical assertion — no lease field touched).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Logger } from '../../src/log.js'
import { HeartbeatMonitor, type HeartbeatMonitorOptions } from '../../src/status/heartbeat-monitor.js'
import {
  addLease,
  addQuestion,
  emptyAutonomyState,
  saveAutonomyState,
  type AutonomyState,
} from '../../src/autonomy/store.js'

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger

const CHAT = '164795011'
const MIN = 60 * 1000
const HOUR = 60 * MIN

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hb-monitor-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

interface Harness {
  sends: Array<{ chatId: string; text: string }>
  pins: Array<{ chatId: string; suffix: string | null }>
  now: number
  outbound: number | undefined
  monitor: HeartbeatMonitor
}
function make(overrides: Partial<HeartbeatMonitorOptions> = {}): Harness {
  // NB: the object we return IS the one the callbacks close over, so a test
  // mutating h.now / h.outbound is seen by the live monitor (no spread copy).
  const h: Harness = {
    sends: [],
    pins: [],
    now: 100 * HOUR,
    outbound: undefined,
    monitor: undefined as unknown as HeartbeatMonitor,
  }
  h.monitor = new HeartbeatMonitor({
    log: silentLog,
    send: (chatId, text) => {
      h.sends.push({ chatId, text })
      return Promise.resolve()
    },
    pinHeartbeat: (chatId, suffix) => {
      h.pins.push({ chatId, suffix })
    },
    autonomyPaths: { root },
    lastOutboundAt: () => h.outbound,
    now: () => h.now,
    ...overrides,
  })
  return h
}

// ── heartbeat ─────────────────────────────────────────────────────────

describe('heartbeat pin / message thresholds', () => {
  test('no pin before 25 min of silence', () => {
    const h = make()
    h.outbound = h.now - 24 * MIN
    h.monitor.evaluate(CHAT, { turnActive: true, inProgressTask: 'билд', nowMs: h.now })
    expect(h.pins).toEqual([])
    expect(h.sends).toEqual([])
  })

  test('pin suffix at 25 min', () => {
    const h = make()
    h.outbound = h.now - 26 * MIN
    h.monitor.evaluate(CHAT, { turnActive: true, inProgressTask: 'сборка воркера', nowMs: h.now })
    expect(h.sends).toEqual([])
    expect(h.pins.length).toBe(1)
    expect(h.pins[0]?.suffix).toContain('работаю: сборка воркера ·')
  })

  test('real message at 60 min supersedes pin, at most once per hour per chat', () => {
    const h = make()
    h.outbound = h.now - 61 * MIN
    h.monitor.evaluate(CHAT, { turnActive: true, inProgressTask: 'миграция', nowMs: h.now })
    expect(h.sends.length).toBe(1)
    expect(h.sends[0]?.text).toBe('Работаю дольше часа без отчёта: миграция. Продолжаю.')
    // pin cleared (message supersedes) — nothing set this call
    expect(h.pins.every((p) => p.suffix === null)).toBe(true)
    // 20s later, still >60m silent (stub outbound unchanged) — NOT re-sent (hourly cap)
    h.now += 20 * 1000
    h.monitor.evaluate(CHAT, { turnActive: true, inProgressTask: 'миграция', nowMs: h.now })
    expect(h.sends.length).toBe(1)
  })

  test('recent outbound → silent (no pin, no message)', () => {
    const h = make()
    h.outbound = h.now - 5 * MIN
    h.monitor.evaluate(CHAT, { turnActive: true, inProgressTask: 'x', nowMs: h.now })
    expect(h.sends).toEqual([])
    expect(h.pins).toEqual([])
  })

  test('no outbound record → silence window SEEDED from first active evaluate (fix-loop-1 #4)', () => {
    const h = make()
    h.outbound = undefined
    // First evaluate seeds the baseline — nothing fires immediately.
    h.monitor.evaluate(CHAT, { turnActive: true, inProgressTask: 'x', nowMs: h.now })
    expect(h.sends).toEqual([])
    expect(h.pins).toEqual([])
    // 26 min later, still no outbound → the pin heartbeat DOES fire (pre-fix
    // the heartbeat was disabled forever until the first real send).
    h.now += 26 * MIN
    h.monitor.evaluate(CHAT, { turnActive: true, inProgressTask: 'x', nowMs: h.now })
    expect(h.pins.length).toBe(1)
    expect(h.pins[0]?.suffix).toContain('работаю: x ·')
    // 61 min after the seed → the real message fires.
    h.now += 35 * MIN
    h.monitor.evaluate(CHAT, { turnActive: true, inProgressTask: 'x', nowMs: h.now })
    expect(h.sends.length).toBe(1)
    expect(h.sends[0]?.text).toBe('Работаю дольше часа без отчёта: x. Продолжаю.')
  })

  test('pin cleared when silence drops back under 25m', () => {
    const h = make()
    h.outbound = h.now - 30 * MIN
    h.monitor.evaluate(CHAT, { turnActive: true, inProgressTask: 'x', nowMs: h.now })
    expect(h.pins.at(-1)?.suffix).toContain('работаю')
    // owner replied — outbound fresh now
    h.outbound = h.now
    h.monitor.evaluate(CHAT, { turnActive: true, inProgressTask: 'x', nowMs: h.now })
    expect(h.pins.at(-1)?.suffix).toBeNull()
  })

  test('idle turn clears any pin', () => {
    const h = make()
    h.outbound = h.now - 30 * MIN
    h.monitor.evaluate(CHAT, { turnActive: true, inProgressTask: 'x', nowMs: h.now })
    expect(h.pins.at(-1)?.suffix).toContain('работаю')
    h.monitor.evaluate(CHAT, { turnActive: false, inProgressTask: 'x', nowMs: h.now })
    expect(h.pins.at(-1)?.suffix).toBeNull()
  })

  test('hourly message budget PERSISTS across turn ends (fix-loop-1 #3)', () => {
    const h = make()
    h.outbound = h.now - 61 * MIN
    h.monitor.evaluate(CHAT, { turnActive: true, inProgressTask: 't', nowMs: h.now })
    expect(h.sends.length).toBe(1)
    // Turn ends; a new turn begins seconds later, still >60m silent — the
    // budget must NOT reset (pre-fix: an immediate second message here).
    h.monitor.onTurnEnd(CHAT)
    h.now += 20 * 1000
    h.monitor.evaluate(CHAT, { turnActive: true, inProgressTask: 't', nowMs: h.now })
    expect(h.sends.length).toBe(1)
    // A full hour after the first message the budget re-opens.
    h.now += 61 * MIN
    h.monitor.evaluate(CHAT, { turnActive: true, inProgressTask: 't', nowMs: h.now })
    expect(h.sends.length).toBe(2)
  })
})

// ── dead-man ──────────────────────────────────────────────────────────

describe('dead-man alert', () => {
  test('fires once when pane frozen >10m during active turn, resets on change', () => {
    const h = make()
    h.outbound = h.now // fresh outbound so heartbeat stays quiet
    // baseline
    h.monitor.observePane(CHAT, 'frame-A', h.now, true)
    expect(h.sends).toEqual([])
    // 11 min later, same frame → alert once
    h.now += 11 * MIN
    h.monitor.observePane(CHAT, 'frame-A', h.now, true)
    expect(h.sends.length).toBe(1)
    expect(h.sends[0]?.text).toBe(
      'Сессия молчит >10 мин при активном ходе — возможно OOM/зависание или жду подтверждения (карточка/гейт)',
    )
    // another observe, still frozen → NOT re-alerted
    h.now += 5 * MIN
    h.monitor.observePane(CHAT, 'frame-A', h.now, true)
    expect(h.sends.length).toBe(1)
    // pane changes → incident resets
    h.now += 1 * MIN
    h.monitor.observePane(CHAT, 'frame-B', h.now, true)
    // frozen again >10m → alert again
    h.now += 11 * MIN
    h.monitor.observePane(CHAT, 'frame-B', h.now, true)
    expect(h.sends.length).toBe(2)
  })

  test('does not fire while idle (no active turn)', () => {
    const h = make()
    h.monitor.observePane(CHAT, 'frame-A', h.now, false)
    h.now += 30 * MIN
    h.monitor.observePane(CHAT, 'frame-A', h.now, false)
    expect(h.sends).toEqual([])
  })

  test('idle gap between turns does not count toward the hang clock', () => {
    const h = make()
    h.monitor.observePane(CHAT, 'frame-A', h.now, true) // turn active baseline
    h.now += 20 * MIN
    h.monitor.observePane(CHAT, 'frame-A', h.now, false) // idle refreshes baseline
    h.now += 5 * MIN
    h.monitor.observePane(CHAT, 'frame-A', h.now, true) // new turn, only 5m of freeze
    expect(h.sends).toEqual([])
  })
})

// ── open-question reminders ───────────────────────────────────────────

function seed(mutate: (s: AutonomyState, now: number) => AutonomyState, now: number): void {
  const s = mutate(emptyAutonomyState(), now)
  saveAutonomyState({ root }, CHAT, s)
}

describe('open-question reminders', () => {
  // Normal (non-restart) flow: the monitor sees the question while it is
  // FRESH (first evaluate seeds it at ~asked time), so the 2h window is
  // effectively age-based.
  test('2h reminder fires once with default', () => {
    const h = make()
    seed((s, now) => addQuestion(s, { summary: 'катить прод?', defaultAction: 'катить', askedAtMs: now }, now).state, h.now)
    h.monitor.evaluate(CHAT, { turnActive: false, inProgressTask: null, nowMs: h.now })
    expect(h.sends).toEqual([]) // fresh question — nothing yet
    h.now += 3 * HOUR
    h.monitor.evaluate(CHAT, { turnActive: false, inProgressTask: null, nowMs: h.now })
    expect(h.sends.length).toBe(1)
    expect(h.sends[0]?.text).toBe('Вопрос без ответа 2ч: "катить прод?". Беру дефолт: катить. Скажи стоп, если против.')
    // re-evaluated → NOT repeated
    h.now += 20 * 1000
    h.monitor.evaluate(CHAT, { turnActive: false, inProgressTask: null, nowMs: h.now })
    expect(h.sends.length).toBe(1)
  })

  test('2h reminder without default uses the fallback phrasing', () => {
    const h = make()
    seed((s, now) => addQuestion(s, { summary: 'что дальше?', askedAtMs: now }, now).state, h.now)
    h.monitor.evaluate(CHAT, { turnActive: false, inProgressTask: null, nowMs: h.now })
    h.now += 3 * HOUR
    h.monitor.evaluate(CHAT, { turnActive: false, inProgressTask: null, nowMs: h.now })
    expect(h.sends[0]?.text).toBe('Вопрос без ответа 2ч: "что дальше?". Жду или беру безопасный дефолт по ситуации.')
  })

  test('question younger than 2h → no reminder', () => {
    const h = make()
    seed((s, now) => addQuestion(s, { summary: 'x', askedAtMs: now }, now).state, h.now)
    h.monitor.evaluate(CHAT, { turnActive: false, inProgressTask: null, nowMs: h.now })
    h.now += 1 * HOUR
    h.monitor.evaluate(CHAT, { turnActive: false, inProgressTask: null, nowMs: h.now })
    expect(h.sends).toEqual([])
  })

  test('question appearing AFTER the seed pass fires on its normal age threshold', () => {
    const h = make()
    // First evaluate on an EMPTY registry consumes the seed pass.
    h.monitor.evaluate(CHAT, { turnActive: false, inProgressTask: null, nowMs: h.now })
    // A question asked 3h ago materialises later (no seed entry for it).
    seed((s, now) => addQuestion(s, { summary: 'late?', defaultAction: 'да', askedAtMs: now - 3 * HOUR }, now).state, h.now)
    h.monitor.evaluate(CHAT, { turnActive: false, inProgressTask: null, nowMs: h.now })
    expect(h.sends.length).toBe(1)
    expect(h.sends[0]?.text).toContain('Вопрос без ответа 2ч: "late?"')
  })

  test('sticky (security) question re-reminds at most every 6h', () => {
    const h = make()
    seed((s, now) => addQuestion(s, { summary: 'дать доступ root?', sticky: true, askedAtMs: now }, now).state, h.now)
    h.monitor.evaluate(CHAT, { turnActive: false, inProgressTask: null, nowMs: h.now })
    expect(h.sends).toEqual([])
    // 7h after the seed → first sticky reminder.
    h.now += 7 * HOUR
    h.monitor.evaluate(CHAT, { turnActive: false, inProgressTask: null, nowMs: h.now })
    expect(h.sends.length).toBe(1)
    expect(h.sends[0]?.text).toBe('Security-вопрос всё ещё без ответа: "дать доступ root?"')
    // 3h later — within the 6h cadence → NOT repeated
    h.now += 3 * HOUR
    h.monitor.evaluate(CHAT, { turnActive: false, inProgressTask: null, nowMs: h.now })
    expect(h.sends.length).toBe(1)
    // 6h+ after the first → repeats
    h.now += 4 * HOUR
    h.monitor.evaluate(CHAT, { turnActive: false, inProgressTask: null, nowMs: h.now })
    expect(h.sends.length).toBe(2)
  })

  test('restart burst protection (fix-loop-1 #8): pre-existing questions re-arm a fresh window', () => {
    const h = make()
    // Simulated restart: BOTH questions were already long past their
    // thresholds when this (fresh) monitor first sees them.
    seed((s, now) => {
      let st = addQuestion(s, { summary: 'старый?', defaultAction: 'д', askedAtMs: now - 5 * HOUR }, now).state
      st = addQuestion(st, { summary: 'root?', sticky: true, askedAtMs: now - 9 * HOUR }, now).state
      return st
    }, h.now)
    // First pass → NO burst.
    h.monitor.evaluate(CHAT, { turnActive: false, inProgressTask: null, nowMs: h.now })
    expect(h.sends).toEqual([])
    // 20s later still nothing (window re-armed, not skipped by one tick).
    h.now += 20 * 1000
    h.monitor.evaluate(CHAT, { turnActive: false, inProgressTask: null, nowMs: h.now })
    expect(h.sends).toEqual([])
    // 2h after the seed → the 2h question reminds (its NEXT threshold crossing).
    h.now += 2 * HOUR
    h.monitor.evaluate(CHAT, { turnActive: false, inProgressTask: null, nowMs: h.now })
    expect(h.sends.length).toBe(1)
    expect(h.sends[0]?.text).toContain('старый?')
    // 6h after the seed → the sticky question reminds too.
    h.now += 4 * HOUR
    h.monitor.evaluate(CHAT, { turnActive: false, inProgressTask: null, nowMs: h.now })
    expect(h.sends.length).toBe(2)
    expect(h.sends[1]?.text).toContain('root?')
  })

  test('reminder path NEVER mutates the registry (leases untouched, byte-identical)', () => {
    const h = make()
    seed((s, now) => {
      let st = addLease(s, { scope: 'do X', expiresAtMs: now + HOUR, source: 'manual' }, now).state
      st = addQuestion(st, { summary: 'q?', defaultAction: 'd', askedAtMs: now - 3 * HOUR }, now).state
      return st
    }, h.now)
    const path = join(root, `autonomy-${CHAT}.json`)
    const before = readFileSync(path, 'utf8')
    // Multiple evaluations (reminder fires, dead-man observed) — all read-only.
    h.monitor.evaluate(CHAT, { turnActive: true, inProgressTask: 'X', nowMs: h.now })
    h.monitor.observePane(CHAT, 'p', h.now, true)
    h.now += 7 * HOUR
    h.monitor.evaluate(CHAT, { turnActive: true, inProgressTask: 'X', nowMs: h.now })
    const after = readFileSync(path, 'utf8')
    expect(after).toBe(before)
  })
})

// ── isolation ─────────────────────────────────────────────────────────

describe('isolation — best-effort, never throws', () => {
  test('a throwing send callback does not escape evaluate', () => {
    const h = make({
      send: () => {
        throw new Error('boom')
      },
    })
    h.outbound = h.now - 61 * MIN
    expect(() =>
      h.monitor.evaluate(CHAT, { turnActive: true, inProgressTask: 't', nowMs: h.now }),
    ).not.toThrow()
  })

  test('a throwing pin callback does not escape evaluate', () => {
    const h = make({
      pinHeartbeat: () => {
        throw new Error('boom')
      },
    })
    h.outbound = h.now - 30 * MIN
    expect(() =>
      h.monitor.evaluate(CHAT, { turnActive: true, inProgressTask: 't', nowMs: h.now }),
    ).not.toThrow()
  })

  test('non-owner chat is a no-op', () => {
    const h = make({ isOwnerChat: () => false })
    h.outbound = h.now - 61 * MIN
    h.monitor.evaluate(CHAT, { turnActive: true, inProgressTask: 't', nowMs: h.now })
    h.monitor.observePane(CHAT, 'p', h.now, true)
    expect(h.sends).toEqual([])
    expect(h.pins).toEqual([])
  })
})
