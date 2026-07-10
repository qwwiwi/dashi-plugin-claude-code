import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AUTONOMY_STATE_VERSION,
  activeLeases,
  addLease,
  addQuestion,
  autonomyStatePath,
  buildAutonomyHudLine,
  buildAutonomyReminderBlock,
  consumeLease,
  emptyAutonomyState,
  humanizeDurationMs,
  loadAutonomyState,
  newLeaseId,
  newQuestionId,
  openQuestions,
  questionAgeMs,
  renderAutonomyStatus,
  resolveQuestion,
  saveAutonomyState,
  type AutonomyState,
} from '../../src/autonomy/store.js'

const HOUR = 3_600_000
const NOW = 1_752_000_000_000 // fixed clock for deterministic ids/ages

let root: string
const paths = () => ({ root })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-autonomy-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// Seed a state with one active lease + one open question.
function seedState(): AutonomyState {
  let state = emptyAutonomyState()
  state = addLease(
    state,
    { id: 'L-20260710-aaaa', scope: 'catch up the payments wave', expiresAtMs: NOW + 4 * HOUR, source: 'ask_card' },
    NOW,
  ).state
  state = addQuestion(
    state,
    { id: 'Q-20260710-bbbb', summary: 'deploy to prod now?', askedAtMs: NOW - 3 * HOUR, defaultAction: 'wait' },
    NOW,
  ).state
  return state
}

describe('emptyAutonomyState', () => {
  test('is a versioned empty registry', () => {
    expect(emptyAutonomyState()).toEqual({ version: AUTONOMY_STATE_VERSION, leases: [], questions: [] })
  })
})

describe('round-trip persistence', () => {
  test('save then load returns identical state', () => {
    const state = seedState()
    saveAutonomyState(paths(), '164795011', state)
    const loaded = loadAutonomyState(paths(), '164795011')
    expect(loaded).toEqual(state)
  })

  test('file lives at autonomy-<chatId>.json in the state root', () => {
    saveAutonomyState(paths(), '164795011', seedState())
    expect(autonomyStatePath(paths(), '164795011')).toBe(join(root, 'autonomy-164795011.json'))
    expect(readdirSync(root)).toContain('autonomy-164795011.json')
  })

  test('negative (supergroup) chat id is sanitized in the filename', () => {
    saveAutonomyState(paths(), '-1001234567890', seedState())
    // The `-` is filename-safe and preserved; no path traversal.
    expect(autonomyStatePath(paths(), '-1001234567890')).toBe(join(root, 'autonomy--1001234567890.json'))
    expect(readdirSync(root)).toContain('autonomy--1001234567890.json')
  })

  test('atomic write leaves no tmp strays', () => {
    saveAutonomyState(paths(), '164795011', seedState())
    saveAutonomyState(paths(), '164795011', seedState())
    const strays = readdirSync(root).filter((f) => f.includes('.tmp.'))
    expect(strays).toEqual([])
  })

  test('save always stamps the current schema version', () => {
    const state = { version: 999 as unknown as typeof AUTONOMY_STATE_VERSION, leases: [], questions: [] }
    saveAutonomyState(paths(), '1', state)
    expect(loadAutonomyState(paths(), '1').version).toBe(AUTONOMY_STATE_VERSION)
  })
})

describe('loadAutonomyState — corrupt / missing → empty', () => {
  test('missing file → empty state, no throw', () => {
    expect(loadAutonomyState(paths(), 'nope')).toEqual(emptyAutonomyState())
  })

  test('corrupt JSON → empty state, no throw, warns via logger', () => {
    writeFileSync(autonomyStatePath(paths(), '1'), '{not json', 'utf8')
    const warnings: string[] = []
    const log = {
      debug: () => {},
      info: () => {},
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
    }
    expect(loadAutonomyState(paths(), '1', log)).toEqual(emptyAutonomyState())
    expect(warnings.length).toBe(1)
  })

  test('non-object JSON → empty state', () => {
    writeFileSync(autonomyStatePath(paths(), '1'), '[1,2,3]', 'utf8')
    expect(loadAutonomyState(paths(), '1')).toEqual(emptyAutonomyState())
  })

  test('drops malformed lease/question entries, keeps the well-formed ones', () => {
    const blob = {
      version: 1,
      leases: [
        { id: 'L-ok', scope: 's', grantedAtMs: NOW, expiresAtMs: NOW + HOUR, source: 'ask_card' },
        { id: 'L-bad', scope: 's', grantedAtMs: NOW, expiresAtMs: NOW + HOUR, source: 'not_a_source' },
        { scope: 'no id', grantedAtMs: NOW, expiresAtMs: NOW + HOUR, source: 'manual' },
      ],
      questions: [
        { id: 'Q-ok', summary: 's', askedAtMs: NOW, status: 'open' },
        { id: 'Q-bad', summary: 's', askedAtMs: NOW, status: 'weird' },
      ],
    }
    writeFileSync(autonomyStatePath(paths(), '1'), JSON.stringify(blob), 'utf8')
    const loaded = loadAutonomyState(paths(), '1')
    expect(loaded.leases.map((l) => l.id)).toEqual(['L-ok'])
    expect(loaded.questions.map((q) => q.id)).toEqual(['Q-ok'])
  })
})

describe('id generation', () => {
  test('lease id: L-YYYYMMDD-xxxx', () => {
    expect(newLeaseId(NOW)).toMatch(/^L-\d{8}-[0-9a-z]{4}$/)
  })
  test('question id: Q-YYYYMMDD-xxxx', () => {
    expect(newQuestionId(NOW)).toMatch(/^Q-\d{8}-[0-9a-z]{4}$/)
  })
  test('addLease/addQuestion generate ids when omitted', () => {
    const l = addLease(emptyAutonomyState(), { scope: 's', expiresAtMs: NOW + HOUR, source: 'manual' }, NOW)
    expect(l.lease.id).toMatch(/^L-/)
    const q = addQuestion(emptyAutonomyState(), { summary: 's' }, NOW)
    expect(q.question.id).toMatch(/^Q-/)
  })
  test('addLease is pure — input state is not mutated', () => {
    const s0 = emptyAutonomyState()
    addLease(s0, { scope: 's', expiresAtMs: NOW + HOUR, source: 'manual' }, NOW)
    expect(s0.leases).toEqual([])
  })
})

describe('activeLeases — expiry + consume', () => {
  test('excludes expired leases', () => {
    let state = emptyAutonomyState()
    state = addLease(state, { id: 'L-live', scope: 's', expiresAtMs: NOW + HOUR, source: 'manual' }, NOW).state
    state = addLease(state, { id: 'L-dead', scope: 's', expiresAtMs: NOW - HOUR, source: 'manual' }, NOW).state
    expect(activeLeases(state, NOW).map((l) => l.id)).toEqual(['L-live'])
  })

  test('excludes consumed leases', () => {
    let state = emptyAutonomyState()
    state = addLease(state, { id: 'L-1', scope: 's', expiresAtMs: NOW + HOUR, source: 'manual' }, NOW).state
    state = consumeLease(state, 'L-1', NOW).state
    expect(activeLeases(state, NOW)).toEqual([])
  })

  test('sorts soonest-expiry first', () => {
    let state = emptyAutonomyState()
    state = addLease(state, { id: 'L-late', scope: 's', expiresAtMs: NOW + 5 * HOUR, source: 'manual' }, NOW).state
    state = addLease(state, { id: 'L-soon', scope: 's', expiresAtMs: NOW + 1 * HOUR, source: 'manual' }, NOW).state
    expect(activeLeases(state, NOW).map((l) => l.id)).toEqual(['L-soon', 'L-late'])
  })

  test('consumeLease outcomes: ok / not_found / already_consumed', () => {
    let state = emptyAutonomyState()
    state = addLease(state, { id: 'L-1', scope: 's', expiresAtMs: NOW + HOUR, source: 'manual' }, NOW).state

    const miss = consumeLease(state, 'L-nope', NOW)
    expect(miss.outcome).toBe('not_found')

    const first = consumeLease(state, 'L-1', NOW)
    expect(first.outcome).toBe('ok')
    expect(first.state.leases[0]?.consumedAtMs).toBe(NOW)

    const again = consumeLease(first.state, 'L-1', NOW)
    expect(again.outcome).toBe('already_consumed')
  })
})

describe('questions — age + resolve', () => {
  test('openQuestions excludes resolved, sorts oldest-first', () => {
    let state = emptyAutonomyState()
    state = addQuestion(state, { id: 'Q-new', summary: 's', askedAtMs: NOW - HOUR }, NOW).state
    state = addQuestion(state, { id: 'Q-old', summary: 's', askedAtMs: NOW - 5 * HOUR }, NOW).state
    state = addQuestion(state, { id: 'Q-done', summary: 's', askedAtMs: NOW - 2 * HOUR }, NOW).state
    state = resolveQuestion(state, 'Q-done', 'answered', NOW).state
    expect(openQuestions(state).map((q) => q.id)).toEqual(['Q-old', 'Q-new'])
  })

  test('questionAgeMs clamps a future askedAtMs to 0', () => {
    const q = addQuestion(emptyAutonomyState(), { summary: 's', askedAtMs: NOW + HOUR }, NOW).question
    expect(questionAgeMs(q, NOW)).toBe(0)
  })

  test('resolveQuestion outcomes + timestamp', () => {
    let state = emptyAutonomyState()
    state = addQuestion(state, { id: 'Q-1', summary: 's', askedAtMs: NOW }, NOW).state

    expect(resolveQuestion(state, 'Q-nope', 'answered', NOW).outcome).toBe('not_found')

    const r = resolveQuestion(state, 'Q-1', 'bypassed', NOW + HOUR)
    expect(r.outcome).toBe('ok')
    expect(r.state.questions[0]?.status).toBe('bypassed')
    expect(r.state.questions[0]?.resolvedAtMs).toBe(NOW + HOUR)
  })
})

describe('humanizeDurationMs', () => {
  test('sub-hour → minutes', () => {
    expect(humanizeDurationMs(45 * 60_000)).toBe('45м')
  })
  test('exact hours → "<h>ч"', () => {
    expect(humanizeDurationMs(2 * HOUR)).toBe('2ч')
  })
  test('partial hour → "<h>ч <m>м"', () => {
    expect(humanizeDurationMs(2 * HOUR + 15 * 60_000)).toBe('2ч 15м')
  })
  test('negative clamps to 0м', () => {
    expect(humanizeDurationMs(-5)).toBe('0м')
  })
})

describe('renderAutonomyStatus', () => {
  test('lists active leases + open questions with ids, time-left and age', () => {
    const text = renderAutonomyStatus(seedState(), NOW)
    expect(text).toContain('L-20260710-aaaa')
    expect(text).toContain('catch up the payments wave')
    expect(text).toContain('ещё 4ч')
    expect(text).toContain('Q-20260710-bbbb')
    expect(text).toContain('без ответа 3ч')
    expect(text).toContain('дефолт: wait')
  })

  test('empty state → clear "nothing active" wording', () => {
    const text = renderAutonomyStatus(emptyAutonomyState(), NOW)
    expect(text).toContain('Активных мандатов нет')
    expect(text).toContain('Открытых вопросов нет')
  })

  test('sticky question is flagged', () => {
    let state = emptyAutonomyState()
    state = addQuestion(state, { id: 'Q-s', summary: 'delete prod db?', askedAtMs: NOW, sticky: true }, NOW).state
    expect(renderAutonomyStatus(state, NOW)).toContain('[sticky]')
  })
})

describe('buildAutonomyReminderBlock', () => {
  test('empty state → undefined (no block)', () => {
    expect(buildAutonomyReminderBlock(emptyAutonomyState(), NOW)).toBeUndefined()
  })

  test('renders mandate + question guidance', () => {
    const block = buildAutonomyReminderBlock(seedState(), NOW) as string
    expect(block).toContain('Активный мандат L-20260710-aaaa')
    expect(block).toContain('истекает через 4ч')
    expect(block).toContain('Act-with-veto')
    expect(block).toContain('Открытый вопрос вождю Q-20260710-bbbb')
    expect(block).toContain('дефолт: wait')
    expect(block).toContain('бери дефолт')
  })

  test('sticky question → NEVER auto-bypass guidance', () => {
    let state = emptyAutonomyState()
    state = addQuestion(state, { id: 'Q-s', summary: 'wipe db?', askedAtMs: NOW, sticky: true }, NOW).state
    const block = buildAutonomyReminderBlock(state, NOW) as string
    expect(block).toContain('sticky-вопрос')
    expect(block).toContain('НЕ обходить')
    expect(block).not.toContain('бери дефолт')
  })
})

describe('buildAutonomyHudLine', () => {
  test('empty state → undefined', () => {
    expect(buildAutonomyHudLine(emptyAutonomyState(), NOW)).toBeUndefined()
  })

  test('renders mandate + unanswered-questions count', () => {
    const line = buildAutonomyHudLine(seedState(), NOW) as string
    expect(line).toContain('Мандат: L-20260710-aaaa')
    expect(line).toContain('ещё 4ч')
    expect(line).toContain('Вопросы без ответа: 1')
    expect(line).toContain('старший 3ч')
    expect(line).toContain(' · ')
  })

  test('applies the injected escaper to scope + id', () => {
    let state = emptyAutonomyState()
    state = addLease(state, { id: 'L-1', scope: 'a < b & c', expiresAtMs: NOW + HOUR, source: 'manual' }, NOW).state
    const line = buildAutonomyHudLine(state, NOW, { escape: (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;') }) as string
    expect(line).toContain('&lt;')
    expect(line).toContain('&amp;')
    expect(line).not.toMatch(/[^&]< /)
  })

  test('multiple active leases → "+N" marker', () => {
    let state = emptyAutonomyState()
    state = addLease(state, { id: 'L-1', scope: 's', expiresAtMs: NOW + HOUR, source: 'manual' }, NOW).state
    state = addLease(state, { id: 'L-2', scope: 's', expiresAtMs: NOW + 2 * HOUR, source: 'manual' }, NOW).state
    expect(buildAutonomyHudLine(state, NOW) as string).toContain('+1')
  })
})
