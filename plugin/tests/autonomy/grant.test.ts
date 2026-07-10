// Autonomy M2 — lease GRANT paths.
//
// Covers the pure parsers (marker parse/strip, ttl cap, malformed markers,
// affirmative label matrix, `/lease` command args), the store-level grant core
// (applyLeaseGrant: grantSourceId idempotency, identical-scope no-op, supersede),
// the grantLease orchestrator, the retention prune, and the version>1 read-only
// guard.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  clampTtlHours,
  grantLease,
  isAffirmativeLabel,
  LEASE_DEFAULT_TTL_HOURS,
  LEASE_MAX_TTL_HOURS,
  parseLeaseCommandArgs,
  parseLeaseMarker,
  stripLeaseMarkerForDisplay,
} from '../../src/autonomy/grant.js'
import {
  activeLeases,
  addLease,
  applyLeaseGrant,
  autonomyStatePath,
  computeScopeDigest,
  emptyAutonomyState,
  loadAutonomyState,
  PRUNE_MAX_AGE_MS,
  pruneAutonomyState,
  resolveQuestion,
  addQuestion,
  consumeLease,
  revokeLease,
  updateAutonomyState,
  type AutonomyState,
} from '../../src/autonomy/store.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = 1_752_000_000_000

let root: string
const paths = () => ({ root })
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-grant-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────
// parseLeaseMarker + stripLeaseMarkerForDisplay
// ─────────────────────────────────────────────────────────────────────

describe('parseLeaseMarker', () => {
  test('bare marker → scope, default ttl, no supersede, display falls back to scope', () => {
    const m = parseLeaseMarker('[LEASE: deploy staging] Разрешаешь?')
    expect(m).not.toBeNull()
    expect(m!.scope).toBe('deploy staging')
    expect(m!.ttlHours).toBe(LEASE_DEFAULT_TTL_HOURS)
    expect(m!.supersede).toBe(false)
    expect(m!.displayText).toBe('Разрешаешь?')
  })

  test('marker with no trailing question → display is the scope text', () => {
    const m = parseLeaseMarker('[LEASE: catch up the wave]')
    expect(m!.displayText).toBe('catch up the wave')
  })

  test('ttl parsed and clamped at 72h', () => {
    expect(parseLeaseMarker('[LEASE: x; ttl=48h] q')!.ttlHours).toBe(48)
    expect(parseLeaseMarker('[LEASE: x; ttl=200h] q')!.ttlHours).toBe(LEASE_MAX_TTL_HOURS)
    // ttl=0h or negative → default (a dead-on-arrival mandate is a mistake).
    expect(parseLeaseMarker('[LEASE: x; ttl=0h] q')!.ttlHours).toBe(LEASE_DEFAULT_TTL_HOURS)
  })

  test('supersede flag recognised (order-independent)', () => {
    expect(parseLeaseMarker('[LEASE: x; supersede] q')!.supersede).toBe(true)
    expect(parseLeaseMarker('[LEASE: x; ttl=12h; supersede] q')).toMatchObject({
      scope: 'x', ttlHours: 12, supersede: true,
    })
    expect(parseLeaseMarker('[LEASE: x; supersede; ttl=12h] q')).toMatchObject({
      scope: 'x', ttlHours: 12, supersede: true,
    })
  })

  test('case-insensitive LEASE keyword', () => {
    expect(parseLeaseMarker('[lease: x] q')!.scope).toBe('x')
  })

  test('malformed — empty scope → null (treated as a normal question)', () => {
    expect(parseLeaseMarker('[LEASE: ] real question?')).toBeNull()
    expect(parseLeaseMarker('[LEASE:] q')).toBeNull()
  })

  test('no closing bracket → null', () => {
    expect(parseLeaseMarker('[LEASE: x q')).toBeNull()
  })

  test('marker not at the start → null (normal question)', () => {
    expect(parseLeaseMarker('please [LEASE: x] approve')).toBeNull()
  })

  test('a plain question → null', () => {
    expect(parseLeaseMarker('деплой на staging?')).toBeNull()
  })

  test('leading whitespace tolerated', () => {
    expect(parseLeaseMarker('   [LEASE: x] q')!.scope).toBe('x')
  })

  test('unknown option segments are ignored but the card is still valid', () => {
    const m = parseLeaseMarker('[LEASE: scope; frobnicate; ttl=5h] q')
    expect(m).toMatchObject({ scope: 'scope', ttlHours: 5 })
  })
})

describe('stripLeaseMarkerForDisplay', () => {
  test('strips a marker', () => {
    expect(stripLeaseMarkerForDisplay('[LEASE: x] Разрешаешь?')).toBe('Разрешаешь?')
  })
  test('identity for a non-lease question', () => {
    expect(stripLeaseMarkerForDisplay('обычный вопрос')).toBe('обычный вопрос')
  })
})

describe('clampTtlHours', () => {
  test('default / cap / floor', () => {
    expect(clampTtlHours(undefined)).toBe(24)
    expect(clampTtlHours(48)).toBe(48)
    expect(clampTtlHours(1000)).toBe(72)
    expect(clampTtlHours(0)).toBe(24)
    expect(clampTtlHours(-5)).toBe(24)
    expect(clampTtlHours(Number.NaN)).toBe(24)
  })
})

// ─────────────────────────────────────────────────────────────────────
// isAffirmativeLabel
// ─────────────────────────────────────────────────────────────────────

describe('isAffirmativeLabel', () => {
  test('exact affirmative labels match (case-insensitive, trimmed)', () => {
    for (const l of ['Да', 'да', '  Да  ', 'Да, весь трейн', 'Да, разрешаю', 'Yes', 'yes']) {
      expect(isAffirmativeLabel(l)).toBe(true)
    }
  })
  test('non-affirmative labels never match', () => {
    for (const l of ['Нет', 'Нет, не сейчас', 'Да позже', 'Yeah', 'Ок', 'Другое', '', 'Разрешаю']) {
      expect(isAffirmativeLabel(l)).toBe(false)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// parseLeaseCommandArgs
// ─────────────────────────────────────────────────────────────────────

describe('parseLeaseCommandArgs', () => {
  test('empty args → bare', () => {
    expect(parseLeaseCommandArgs('')).toEqual({ kind: 'bare' })
    expect(parseLeaseCommandArgs('   ')).toEqual({ kind: 'bare' })
  })
  test('scope only → grant with default ttl', () => {
    expect(parseLeaseCommandArgs('деплой стейджинга')).toEqual({
      kind: 'grant', scope: 'деплой стейджинга', ttlHours: 24,
    })
  })
  test('scope + ttl', () => {
    expect(parseLeaseCommandArgs('деплой; ttl=48h')).toEqual({
      kind: 'grant', scope: 'деплой', ttlHours: 48,
    })
  })
  test('only a ttl option with no scope → bare', () => {
    expect(parseLeaseCommandArgs('; ttl=48h')).toEqual({ kind: 'bare' })
  })
})

// ─────────────────────────────────────────────────────────────────────
// applyLeaseGrant — store core
// ─────────────────────────────────────────────────────────────────────

describe('applyLeaseGrant', () => {
  const base = { expiresAtMs: NOW + DAY, source: 'ask_card' as const, chatId: '1' }

  test('grants a fresh lease with scopeDigest + binding fields', () => {
    const r = applyLeaseGrant(emptyAutonomyState(), { ...base, scope: 's', grantSourceId: 'ask:aaaaa:0', grantorMessageId: 42 }, NOW)
    expect(r.outcome).toBe('granted')
    expect(r.lease!.scope).toBe('s')
    expect(r.lease!.scopeDigest).toBe(computeScopeDigest('s'))
    expect(r.lease!.grantSourceId).toBe('ask:aaaaa:0')
    expect(r.lease!.chatId).toBe('1')
    expect(r.lease!.grantorMessageId).toBe(42)
    expect(r.state.leases.length).toBe(1)
  })

  test('same grantSourceId → idempotent no-op (duplicate_source), one lease', () => {
    let state = emptyAutonomyState()
    const first = applyLeaseGrant(state, { ...base, scope: 's', grantSourceId: 'ask:aaaaa:0' }, NOW)
    state = first.state
    const second = applyLeaseGrant(state, { ...base, scope: 'DIFFERENT scope', grantSourceId: 'ask:aaaaa:0' }, NOW)
    expect(second.outcome).toBe('duplicate_source')
    expect(second.lease!.id).toBe(first.lease!.id) // returns the existing lease
    expect(second.state.leases.length).toBe(1)
    expect(second.state).toBe(state) // unchanged reference
  })

  test('identical ACTIVE scope (different source) → duplicate_scope no-op', () => {
    let state = emptyAutonomyState()
    const first = applyLeaseGrant(state, { ...base, scope: 'same', grantSourceId: 'src-1' }, NOW)
    state = first.state
    const second = applyLeaseGrant(state, { ...base, scope: 'same', grantSourceId: 'src-2' }, NOW)
    expect(second.outcome).toBe('duplicate_scope')
    expect(second.lease!.id).toBe(first.lease!.id)
    expect(second.state.leases.length).toBe(1)
  })

  test('different scopes coexist (no supersede)', () => {
    let state = emptyAutonomyState()
    state = applyLeaseGrant(state, { ...base, scope: 'a', grantSourceId: 's-a' }, NOW).state
    const r = applyLeaseGrant(state, { ...base, scope: 'b', grantSourceId: 's-b' }, NOW)
    expect(r.outcome).toBe('granted')
    expect(activeLeases(r.state, NOW).length).toBe(2)
  })

  test('supersede revokes differing active leases then grants (superseded)', () => {
    let state = emptyAutonomyState()
    const old = applyLeaseGrant(state, { ...base, scope: 'old', grantSourceId: 's-old' }, NOW)
    state = old.state
    const r = applyLeaseGrant(state, { ...base, scope: 'new', grantSourceId: 's-new', supersede: true }, NOW)
    expect(r.outcome).toBe('superseded')
    const active = activeLeases(r.state, NOW)
    expect(active.map((l) => l.scope)).toEqual(['new'])
    const revoked = r.state.leases.find((l) => l.id === old.lease!.id)!
    expect(revoked.revokedAtMs).toBe(NOW)
    expect(revoked.revokedBy).toBe('owner_card')
    expect(revoked.revokeReason).toBe('superseded')
  })

  test('supersede with identical scope is the duplicate_scope no-op (never revokes itself)', () => {
    let state = emptyAutonomyState()
    const first = applyLeaseGrant(state, { ...base, scope: 'same', grantSourceId: 's-1' }, NOW)
    state = first.state
    const r = applyLeaseGrant(state, { ...base, scope: 'same', grantSourceId: 's-2', supersede: true }, NOW)
    expect(r.outcome).toBe('duplicate_scope')
    expect(r.lease!.id).toBe(first.lease!.id)
  })

  test('supersede with no other active lease → plain granted', () => {
    const r = applyLeaseGrant(emptyAutonomyState(), { ...base, scope: 'x', grantSourceId: 's-x', supersede: true }, NOW)
    expect(r.outcome).toBe('granted')
  })
})

// ─────────────────────────────────────────────────────────────────────
// grantLease — orchestrator over the serialized writer
// ─────────────────────────────────────────────────────────────────────

describe('grantLease', () => {
  test('persists a lease with the computed expiry', async () => {
    const res = await grantLease(paths(), '1', {
      scope: 's', ttlHours: 48, source: 'owner_cmd', grantSourceId: 'cmd:1:99',
    }, undefined, NOW)
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') throw new Error('unreachable')
    expect(res.outcome).toBe('granted')
    expect(res.lease!.expiresAtMs).toBe(NOW + 48 * HOUR)
    const loaded = loadAutonomyState(paths(), '1')
    expect(loaded.leases.length).toBe(1)
    expect(loaded.leases[0]!.source).toBe('owner_cmd')
  })

  test('replayed grantSourceId mints exactly one lease', async () => {
    const g = () => grantLease(paths(), '1', {
      scope: 's', ttlHours: 24, source: 'ask_card', grantSourceId: 'ask:aaaaa:0',
    }, undefined, NOW)
    const first = await g()
    const second = await g()
    expect(first.kind).toBe('ok')
    expect(second.kind).toBe('ok')
    if (second.kind === 'ok') expect(second.outcome).toBe('duplicate_source')
    expect(loadAutonomyState(paths(), '1').leases.length).toBe(1)
  })

  test('concurrent double-tap of the same grant → one lease', async () => {
    const g = () => grantLease(paths(), '1', {
      scope: 's', ttlHours: 24, source: 'ask_card', grantSourceId: 'ask:aaaaa:0',
    }, undefined, NOW)
    await Promise.all([g(), g(), g()])
    expect(loadAutonomyState(paths(), '1').leases.length).toBe(1)
  })

  test('version_unsupported when the on-disk file is a newer schema', async () => {
    writeFileSync(
      autonomyStatePath(paths(), '1'),
      JSON.stringify({ version: 2, revision: 5, leases: [], questions: [] }),
      'utf8',
    )
    const res = await grantLease(paths(), '1', {
      scope: 's', ttlHours: 24, source: 'owner_cmd', grantSourceId: 'cmd:1:1',
    }, undefined, NOW)
    expect(res.kind).toBe('version_unsupported')
  })
})

// ─────────────────────────────────────────────────────────────────────
// pruneAutonomyState (PR-1 leftover 4a)
// ─────────────────────────────────────────────────────────────────────

describe('pruneAutonomyState', () => {
  function withLease(state: AutonomyState, over: Partial<Parameters<typeof addLease>[1]> & { id: string }): AutonomyState {
    return addLease(state, { scope: 's', expiresAtMs: NOW + DAY, source: 'manual', ...over }, NOW).state
  }

  test('keeps active leases and open questions regardless of age', () => {
    let s = emptyAutonomyState()
    s = withLease(s, { id: 'L-active', expiresAtMs: NOW + DAY })
    s = addQuestion(s, { id: 'Q-open', summary: 'q', askedAtMs: NOW - 100 * DAY }, NOW).state
    const pruned = pruneAutonomyState(s, NOW)
    expect(pruned.leases.map((l) => l.id)).toEqual(['L-active'])
    expect(pruned.questions.map((q) => q.id)).toEqual(['Q-open'])
    expect(pruned).toBe(s) // nothing pruned → same reference
  })

  test('drops consumed/revoked/expired leases older than 14 days; keeps recent ones', () => {
    let s = emptyAutonomyState()
    // consumed long ago
    s = withLease(s, { id: 'L-old-consumed', expiresAtMs: NOW + DAY })
    s = consumeLease(s, 'L-old-consumed', NOW - 20 * DAY).state
    // revoked long ago
    s = withLease(s, { id: 'L-old-revoked', expiresAtMs: NOW + DAY })
    s = revokeLease(s, 'L-old-revoked', NOW - 20 * DAY, 'owner').state
    // expired long ago (never consumed/revoked)
    s = withLease(s, { id: 'L-old-expired', expiresAtMs: NOW - 20 * DAY })
    // consumed recently — kept
    s = withLease(s, { id: 'L-recent-consumed', expiresAtMs: NOW + DAY })
    s = consumeLease(s, 'L-recent-consumed', NOW - 2 * DAY).state

    const pruned = pruneAutonomyState(s, NOW)
    const ids = pruned.leases.map((l) => l.id).sort()
    expect(ids).toEqual(['L-recent-consumed'])
  })

  test('drops resolved questions older than 14 days; keeps recent resolved + open', () => {
    let s = emptyAutonomyState()
    s = addQuestion(s, { id: 'Q-old', summary: 'a', askedAtMs: NOW - 30 * DAY }, NOW).state
    s = resolveQuestion(s, 'Q-old', 'answered', NOW - 20 * DAY).state
    s = addQuestion(s, { id: 'Q-recent', summary: 'b', askedAtMs: NOW - 5 * DAY }, NOW).state
    s = resolveQuestion(s, 'Q-recent', 'answered', NOW - 3 * DAY).state
    s = addQuestion(s, { id: 'Q-open', summary: 'c', askedAtMs: NOW - 40 * DAY }, NOW).state

    const pruned = pruneAutonomyState(s, NOW)
    expect(pruned.questions.map((q) => q.id).sort()).toEqual(['Q-open', 'Q-recent'])
  })

  test('boundary: exactly 14 days old is kept (inclusive)', () => {
    let s = emptyAutonomyState()
    s = withLease(s, { id: 'L-edge', expiresAtMs: NOW - PRUNE_MAX_AGE_MS })
    expect(pruneAutonomyState(s, NOW).leases.map((l) => l.id)).toEqual(['L-edge'])
  })

  test('applied on the save path via updateAutonomyState', async () => {
    // Seed an old consumed lease directly on disk, then trigger any mutation.
    let seed = emptyAutonomyState()
    seed = withLease(seed, { id: 'L-stale', expiresAtMs: NOW + DAY })
    seed = consumeLease(seed, 'L-stale', NOW - 30 * DAY).state
    // Persist via a first mutation that adds a fresh active lease.
    await updateAutonomyState(paths(), '1', () => ({ state: seed, result: null }), undefined, NOW)
    // A second mutation prunes the stale one on the way to disk.
    await updateAutonomyState(paths(), '1', (state) => {
      const r = addLease(state, { id: 'L-fresh', scope: 'f', expiresAtMs: NOW + DAY, source: 'manual' }, NOW)
      return { state: r.state, result: r.outcome }
    }, undefined, NOW)
    const ids = loadAutonomyState(paths(), '1').leases.map((l) => l.id).sort()
    expect(ids).toEqual(['L-fresh'])
  })
})

// ─────────────────────────────────────────────────────────────────────
// version>1 read-only (PR-1 leftover 4b)
// ─────────────────────────────────────────────────────────────────────

describe('version>1 read-only', () => {
  test('loads (coerces) a future-version file best-effort', () => {
    writeFileSync(
      autonomyStatePath(paths(), '1'),
      JSON.stringify({
        version: 2,
        revision: 7,
        leases: [{ id: 'L-x', scope: 's', grantedAtMs: NOW, expiresAtMs: NOW + DAY, source: 'manual' }],
        questions: [],
      }),
      'utf8',
    )
    const loaded = loadAutonomyState(paths(), '1')
    expect(loaded.version as number).toBe(2) // preserved so the guard can see it
    expect(loaded.leases.length).toBe(1)
  })

  test('mutation on a future-version file is refused and NEVER overwrites it', async () => {
    const file = autonomyStatePath(paths(), '1')
    const body = JSON.stringify({ version: 2, revision: 7, leases: [], questions: [] })
    writeFileSync(file, body, 'utf8')
    const res = await updateAutonomyState(paths(), '1', (state) => {
      const r = addLease(state, { id: 'L-x', scope: 's', expiresAtMs: NOW + DAY, source: 'manual' }, NOW)
      return { state: r.state, result: r.outcome }
    }, undefined, NOW)
    expect(res.kind).toBe('version_unsupported')
    // File byte-identical — no downgrade write happened.
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(file, 'utf8')).toBe(body)
  })
})
