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
  canonicalChatKey,
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
  revokeLease,
  saveAutonomyState,
  updateAutonomyState,
  AUTONOMY_WRITER_ID,
  WRITER_LOCK_FILENAME,
  acquireWriterLock,
  computeScopeDigest,
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
    expect(emptyAutonomyState()).toEqual({ version: AUTONOMY_STATE_VERSION, revision: 0, leases: [], questions: [], usedGrantSources: [] })
  })
})

describe('round-trip persistence', () => {
  test('save then load returns identical content (revision bumped by the save)', () => {
    const state = seedState()
    saveAutonomyState(paths(), '164795011', state)
    const loaded = loadAutonomyState(paths(), '164795011')
    expect(loaded.leases).toEqual(state.leases)
    expect(loaded.questions).toEqual(state.questions)
    expect(loaded.revision).toBe(state.revision + 1)
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
    const state = { version: 999 as unknown as typeof AUTONOMY_STATE_VERSION, revision: 0, leases: [], questions: [], usedGrantSources: [] }
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

describe('id generation + uniqueness', () => {
  test('lease id: L-YYYYMMDD-<8 hex crypto chars>', () => {
    expect(newLeaseId(NOW)).toMatch(/^L-\d{8}-[0-9a-f]{8}$/)
  })
  test('question id: Q-YYYYMMDD-<8 hex crypto chars>', () => {
    expect(newQuestionId(NOW)).toMatch(/^Q-\d{8}-[0-9a-f]{8}$/)
  })
  test('addLease/addQuestion generate ids when omitted (outcome ok)', () => {
    const l = addLease(emptyAutonomyState(), { scope: 's', expiresAtMs: NOW + HOUR, source: 'manual' }, NOW)
    expect(l.outcome).toBe('ok')
    expect(l.lease?.id).toMatch(/^L-/)
    const q = addQuestion(emptyAutonomyState(), { summary: 's' }, NOW)
    expect(q.outcome).toBe('ok')
    expect(q.question?.id).toMatch(/^Q-/)
  })
  test('addLease is pure — input state is not mutated', () => {
    const s0 = emptyAutonomyState()
    addLease(s0, { scope: 's', expiresAtMs: NOW + HOUR, source: 'manual' }, NOW)
    expect(s0.leases).toEqual([])
  })

  test('colliding EXPLICIT lease id → duplicate, state unchanged, consume stays unambiguous', () => {
    let state = emptyAutonomyState()
    state = addLease(state, { id: 'L-dup', scope: 'first', expiresAtMs: NOW + HOUR, source: 'manual' }, NOW).state
    const second = addLease(state, { id: 'L-dup', scope: 'second', expiresAtMs: NOW + 9 * HOUR, source: 'manual' }, NOW)
    expect(second.outcome).toBe('duplicate')
    expect(second.lease).toBeUndefined()
    expect(second.state).toBe(state) // unchanged reference
    // Exactly ONE lease with the id exists → consume is unambiguous.
    expect(second.state.leases.filter((l) => l.id === 'L-dup').length).toBe(1)
    const consumed = consumeLease(second.state, 'L-dup', NOW)
    expect(consumed.outcome).toBe('ok')
    expect(consumed.state.leases.filter((l) => l.id === 'L-dup' && l.consumedAtMs === NOW).length).toBe(1)
  })

  test('colliding EXPLICIT question id → duplicate, state unchanged', () => {
    let state = emptyAutonomyState()
    state = addQuestion(state, { id: 'Q-dup', summary: 'first', askedAtMs: NOW }, NOW).state
    const second = addQuestion(state, { id: 'Q-dup', summary: 'second', askedAtMs: NOW }, NOW)
    expect(second.outcome).toBe('duplicate')
    expect(second.question).toBeUndefined()
    expect(second.state.questions.length).toBe(1)
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
    const q = addQuestion(emptyAutonomyState(), { summary: 's', askedAtMs: NOW + HOUR }, NOW).question!
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

  test('sticky question can NEVER be bypassed (store-enforced)', () => {
    let state = emptyAutonomyState()
    state = addQuestion(state, { id: 'Q-s', summary: 'wipe db?', askedAtMs: NOW, sticky: true }, NOW).state
    const bypass = resolveQuestion(state, 'Q-s', 'bypassed', NOW)
    expect(bypass.outcome).toBe('sticky_forbidden')
    expect(bypass.state.questions[0]?.status).toBe('open') // untouched
    // `answered` is still allowed for a sticky question.
    const answered = resolveQuestion(state, 'Q-s', 'answered', NOW)
    expect(answered.outcome).toBe('ok')
  })

  test('already-resolved question cannot be re-resolved', () => {
    let state = emptyAutonomyState()
    state = addQuestion(state, { id: 'Q-1', summary: 's', askedAtMs: NOW }, NOW).state
    state = resolveQuestion(state, 'Q-1', 'answered', NOW).state
    const again = resolveQuestion(state, 'Q-1', 'bypassed', NOW + HOUR)
    expect(again.outcome).toBe('already_resolved')
    expect(again.state.questions[0]?.status).toBe('answered') // final
  })
})

describe('consumeLease — expired honesty', () => {
  test('expired unconsumed lease → outcome expired, state untouched', () => {
    let state = emptyAutonomyState()
    state = addLease(state, { id: 'L-old', scope: 's', expiresAtMs: NOW - 1, source: 'manual' }, NOW - HOUR).state
    const r = consumeLease(state, 'L-old', NOW)
    expect(r.outcome).toBe('expired')
    expect(r.state.leases[0]?.consumedAtMs).toBe(null)
  })

  test('consumed beats expired in reporting (already_consumed wins)', () => {
    let state = emptyAutonomyState()
    state = addLease(state, { id: 'L-1', scope: 's', expiresAtMs: NOW + HOUR, source: 'manual' }, NOW).state
    state = consumeLease(state, 'L-1', NOW).state
    // Later, after expiry:
    const r = consumeLease(state, 'L-1', NOW + 2 * HOUR)
    expect(r.outcome).toBe('already_consumed')
  })
})

describe('canonicalChatKey', () => {
  test('numeric strings normalize via BigInt — "00123" and "123" share one file', () => {
    expect(canonicalChatKey('00123')).toBe('123')
    expect(canonicalChatKey('123')).toBe('123')
    expect(autonomyStatePath(paths(), '00123')).toBe(autonomyStatePath(paths(), '123'))
  })

  test('negative supergroup ids keep the canonical minus form', () => {
    expect(canonicalChatKey('-1001234567890')).toBe('-1001234567890')
    expect(canonicalChatKey('-0')).toBe('0')
  })

  test('non-numeric strings encode injectively (no lossy collisions)', () => {
    // Underscore and space must map to DIFFERENT keys (the old lossy `_`
    // replacement collided them).
    expect(canonicalChatKey('a b')).not.toBe(canonicalChatKey('a_b'))
    // Encoded output is filename-safe.
    expect(canonicalChatKey('a b')).toMatch(/^[0-9A-Za-z_-]+$/)
    expect(canonicalChatKey('@chan/x')).toMatch(/^[0-9A-Za-z_-]+$/)
  })
})

describe('updateAutonomyState — serialized read-modify-write', () => {
  test('two parallel consumes → exactly one ok, one already_consumed', async () => {
    saveAutonomyState(
      paths(),
      '1',
      addLease(emptyAutonomyState(), { id: 'L-race', scope: 's', expiresAtMs: NOW + 24 * HOUR, source: 'manual' }, NOW).state,
    )
    const consume = () =>
      updateAutonomyState(paths(), '1', (state) => {
        const r = consumeLease(state, 'L-race', NOW)
        return { state: r.state, result: r.outcome }
      }, undefined, NOW)
    const [ua, ub] = await Promise.all([consume(), consume()])
    expect(ua.kind).toBe('ok')
    expect(ub.kind).toBe('ok')
    const a = ua.kind === 'ok' ? ua.result : 'conflict'
    const b = ub.kind === 'ok' ? ub.result : 'conflict'
    expect([a, b].sort()).toEqual(['already_consumed', 'ok'])
    // On disk: consumed exactly once.
    const final = loadAutonomyState(paths(), '1')
    expect(final.leases[0]?.consumedAtMs).toBe(NOW)
  })

  test('N parallel writers → no lost updates', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        updateAutonomyState(paths(), '2', (state) => {
          const r = addLease(state, { id: `L-${i}`, scope: 's', expiresAtMs: NOW + HOUR, source: 'manual' }, NOW)
          return { state: r.state, result: r.outcome }
        }, undefined, NOW),
      ),
    )
    expect(loadAutonomyState(paths(), '2').leases.length).toBe(10)
  })

  test('no-op mutation (same state reference) skips the save', async () => {
    // No file exists; a not_found consume returns the same state → no write.
    const upd = await updateAutonomyState(paths(), '3', (state) => {
      const r = consumeLease(state, 'L-none', NOW)
      return { state: r.state, result: r.outcome }
    })
    expect(upd).toEqual({ kind: 'ok', result: 'not_found' })
    expect(readdirSync(root)).not.toContain('autonomy-3.json')
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

// ─────────────────────────────────────────────────────────────────────
// Fix-loop-2 (Sol architecture review): revision counter, writer lock,
// scopeDigest, revoke terminal state, corrupt-file forensics.
// ─────────────────────────────────────────────────────────────────────

import { existsSync, writeFileSync as wfs, readFileSync as rfs } from 'node:fs'

describe('revision counter (fix-loop-2 #1)', () => {
  test('every save increments the on-disk revision', () => {
    saveAutonomyState(paths(), '1', emptyAutonomyState())
    expect(loadAutonomyState(paths(), '1').revision).toBe(1)
    saveAutonomyState(paths(), '1', loadAutonomyState(paths(), '1'))
    expect(loadAutonomyState(paths(), '1').revision).toBe(2)
    saveAutonomyState(paths(), '1', loadAutonomyState(paths(), '1'))
    expect(loadAutonomyState(paths(), '1').revision).toBe(3)
  })

  test('external revision bump between load and save → mutator re-applied on fresh state (no lost update)', async () => {
    // Seed: lease A, on-disk revision 1.
    saveAutonomyState(
      paths(),
      '9',
      addLease(emptyAutonomyState(), { id: 'L-A', scope: 's', expiresAtMs: NOW + HOUR, source: 'manual' }, NOW).state,
    )
    let mutatorCalls = 0
    const upd = await updateAutonomyState(paths(), '9', (state) => {
      mutatorCalls++
      if (mutatorCalls === 1) {
        // Simulate a SECOND-PROCESS writer landing between our load and save:
        // it adds L-EXT and bumps the on-disk revision under us.
        saveAutonomyState(paths(), '9', addLease(state, { id: 'L-EXT', scope: 'x', expiresAtMs: NOW + HOUR, source: 'manual' }, NOW).state)
      }
      const r = addLease(state, { id: 'L-MINE', scope: 'm', expiresAtMs: NOW + HOUR, source: 'manual' }, NOW)
      return { state: r.state, result: r.outcome }
    }, undefined, NOW)
    expect(upd).toEqual({ kind: 'ok', result: 'ok' })
    // The mutator ran TWICE: stale apply detected, fresh re-apply persisted.
    expect(mutatorCalls).toBe(2)
    const final = loadAutonomyState(paths(), '9')
    const ids = final.leases.map((l) => l.id).sort()
    // BOTH the external write and ours survived — nothing was lost.
    expect(ids).toEqual(['L-A', 'L-EXT', 'L-MINE'])
  })
})

describe('writer heartbeat lock (fix-loop-2 #2)', () => {
  const lockPath = () => join(root, WRITER_LOCK_FILENAME)

  test('fresh FOREIGN lock blocks the mutation with writer_conflict', async () => {
    wfs(lockPath(), JSON.stringify({ writerId: 'feedfacedeadbeef', pid: 424242, refreshedAtMs: Date.now() }), 'utf8')
    const upd = await updateAutonomyState(paths(), '1', (state) => {
      const r = addLease(state, { id: 'L-x', scope: 's', expiresAtMs: NOW + HOUR, source: 'manual' }, NOW)
      return { state: r.state, result: r.outcome }
    }, undefined, NOW)
    expect(upd).toEqual({ kind: 'writer_conflict' })
    // Nothing was written; the foreign lock still stands.
    expect(loadAutonomyState(paths(), '1').leases).toEqual([])
    expect((JSON.parse(rfs(lockPath(), 'utf8')) as { writerId: string }).writerId).toBe('feedfacedeadbeef')
  })

  test('STALE foreign lock is taken over and the mutation proceeds', async () => {
    wfs(lockPath(), JSON.stringify({ writerId: 'feedfacedeadbeef', pid: 424242, refreshedAtMs: Date.now() - 120_000 }), 'utf8')
    const upd = await updateAutonomyState(paths(), '1', (state) => {
      const r = addLease(state, { id: 'L-x', scope: 's', expiresAtMs: NOW + HOUR, source: 'manual' }, NOW)
      return { state: r.state, result: r.outcome }
    }, undefined, NOW)
    expect(upd).toEqual({ kind: 'ok', result: 'ok' })
    expect((JSON.parse(rfs(lockPath(), 'utf8')) as { writerId: string }).writerId).toBe(AUTONOMY_WRITER_ID)
    expect(loadAutonomyState(paths(), '1').leases.length).toBe(1)
  })

  test('own aged lock refreshes lazily on write', () => {
    const before = Date.now()
    wfs(lockPath(), JSON.stringify({ writerId: AUTONOMY_WRITER_ID, pid: process.pid, refreshedAtMs: before - 60_000 }), 'utf8')
    expect(acquireWriterLock(paths(), before)).toBe(true)
    const after = JSON.parse(rfs(lockPath(), 'utf8')) as { writerId: string; refreshedAtMs: number }
    expect(after.writerId).toBe(AUTONOMY_WRITER_ID)
    expect(after.refreshedAtMs).toBe(before) // refreshed, not left at -60s
  })

  test('own FRESH lock is not rewritten (lazy refresh only)', () => {
    const stamped = Date.now() - 1000
    wfs(lockPath(), JSON.stringify({ writerId: AUTONOMY_WRITER_ID, pid: process.pid, refreshedAtMs: stamped }), 'utf8')
    expect(acquireWriterLock(paths(), Date.now())).toBe(true)
    const after = JSON.parse(rfs(lockPath(), 'utf8')) as { refreshedAtMs: number }
    expect(after.refreshedAtMs).toBe(stamped) // untouched — under refresh window
  })

  test('missing/corrupt lock is acquired', () => {
    expect(acquireWriterLock(paths(), Date.now())).toBe(true)
    wfs(lockPath(), '{broken', 'utf8')
    expect(acquireWriterLock(paths(), Date.now())).toBe(true)
    expect((JSON.parse(rfs(lockPath(), 'utf8')) as { writerId: string }).writerId).toBe(AUTONOMY_WRITER_ID)
  })
})

describe('scopeDigest (fix-loop-2 #3)', () => {
  test('stable for identical text, differs on any byte change', () => {
    const a = computeScopeDigest('ship the wave')
    expect(a).toBe(computeScopeDigest('ship the wave'))
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(computeScopeDigest('ship the wavE')).not.toBe(a)
    expect(computeScopeDigest('ship the wave ')).not.toBe(a)
  })

  test('addLease stores digest + scopeVersion; digest matches the scope', () => {
    const { lease } = addLease(emptyAutonomyState(), { scope: 'катить волну', expiresAtMs: NOW + HOUR, source: 'ask_card' }, NOW)
    expect(lease?.scopeDigest).toBe(computeScopeDigest('катить волну'))
    expect(lease?.scopeVersion).toBe(1)
  })

  test('status render shows the first 12 hex chars of the digest', () => {
    const { state } = addLease(emptyAutonomyState(), { id: 'L-d', scope: 's', expiresAtMs: NOW + HOUR, source: 'manual' }, NOW)
    const short = computeScopeDigest('s').slice(7, 19)
    expect(renderAutonomyStatus(state, NOW)).toContain(`[${short}]`)
    // But NOT in the reminder / HUD surfaces.
    expect(buildAutonomyReminderBlock(state, NOW)).not.toContain(short)
    expect(buildAutonomyHudLine(state, NOW)).not.toContain(short)
  })
})

describe('revokeLease (fix-loop-2 #4)', () => {
  const withLease = (over: Partial<Parameters<typeof addLease>[1]> = {}) =>
    addLease(emptyAutonomyState(), { id: 'L-r', scope: 's', expiresAtMs: NOW + HOUR, source: 'manual', ...over }, NOW).state

  test('ok: sets revokedAtMs/revokedBy/revokeReason', () => {
    const r = revokeLease(withLease(), 'L-r', NOW, 'agent', 'scope drift')
    expect(r.outcome).toBe('ok')
    expect(r.state.leases[0]?.revokedAtMs).toBe(NOW)
    expect(r.state.leases[0]?.revokedBy).toBe('agent')
    expect(r.state.leases[0]?.revokeReason).toBe('scope drift')
  })

  test('not_found', () => {
    expect(revokeLease(emptyAutonomyState(), 'L-x', NOW, 'agent').outcome).toBe('not_found')
  })

  test('consumed lease cannot be revoked (already_consumed)', () => {
    const consumed = consumeLease(withLease(), 'L-r', NOW).state
    expect(revokeLease(consumed, 'L-r', NOW, 'agent').outcome).toBe('already_consumed')
  })

  test('revocation is final (already_revoked)', () => {
    const revoked = revokeLease(withLease(), 'L-r', NOW, 'agent').state
    expect(revokeLease(revoked, 'L-r', NOW, 'agent').outcome).toBe('already_revoked')
  })

  test('expired lease → expired no-op', () => {
    const st = withLease({ expiresAtMs: NOW - 1 })
    const r = revokeLease(st, 'L-r', NOW, 'agent')
    expect(r.outcome).toBe('expired')
    expect(r.state.leases[0]?.revokedAtMs).toBeUndefined()
  })

  test('activeLeases excludes revoked; consume of revoked → revoked outcome', () => {
    const revoked = revokeLease(withLease(), 'L-r', NOW, 'agent').state
    expect(activeLeases(revoked, NOW)).toEqual([])
    expect(consumeLease(revoked, 'L-r', NOW).outcome).toBe('revoked')
  })

  test('revoked state round-trips through persistence', () => {
    const revoked = revokeLease(withLease(), 'L-r', NOW, 'owner', 'changed my mind').state
    saveAutonomyState(paths(), '5', revoked)
    const loaded = loadAutonomyState(paths(), '5')
    expect(loaded.leases[0]?.revokedAtMs).toBe(NOW)
    expect(loaded.leases[0]?.revokedBy).toBe('owner')
    expect(loaded.leases[0]?.revokeReason).toBe('changed my mind')
  })
})

describe('corrupt-file forensics (fix-loop-2 #5)', () => {
  test('corrupt file is preserved as evidence; load returns empty; subsequent save works', () => {
    const file = autonomyStatePath(paths(), '7')
    wfs(file, '{definitely broken', 'utf8')
    const loaded = loadAutonomyState(paths(), '7')
    expect(loaded).toEqual(emptyAutonomyState())
    // Original renamed aside — the slot is free, evidence kept.
    expect(existsSync(file)).toBe(false)
    const evidence = readdirSync(root).filter((f) => f.startsWith('autonomy-7.json.corrupt-'))
    expect(evidence.length).toBe(1)
    expect(rfs(join(root, evidence[0]!), 'utf8')).toBe('{definitely broken')
    // A subsequent save lands cleanly on the canonical name.
    saveAutonomyState(paths(), '7', addLease(emptyAutonomyState(), { id: 'L-n', scope: 's', expiresAtMs: NOW + HOUR, source: 'manual' }, NOW).state)
    expect(loadAutonomyState(paths(), '7').leases.length).toBe(1)
  })

  test('keeps at most 3 evidence files, oldest pruned', () => {
    for (let i = 0; i < 5; i++) {
      wfs(autonomyStatePath(paths(), '8'), `{broken-${i}`, 'utf8')
      loadAutonomyState(paths(), '8')
    }
    const evidence = readdirSync(root).filter((f) => f.startsWith('autonomy-8.json.corrupt-')).sort()
    expect(evidence.length).toBe(3)
    // The NEWEST corruption is among the kept files.
    const bodies = evidence.map((f) => rfs(join(root, f), 'utf8'))
    expect(bodies).toContain('{broken-4')
    expect(bodies).not.toContain('{broken-0')
  })
})
