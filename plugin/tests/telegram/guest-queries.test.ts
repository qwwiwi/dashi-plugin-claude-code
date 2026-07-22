// Unit tests for the Guest Mode query registry (src/telegram/guest-queries.ts).
//
// The registry is the authorization primitive for guest replies: only
// allowlisted callers' queries are ever registered, and claim() is the
// one-shot gate the reply tool relies on. These tests pin the fail-closed
// contract refined by the 2026-07-04 dual review: duplicate register is a
// NO-OP (Codex #1), cap eviction never touches inflight entries and
// prefers answered tombstones (Codex #2 / Fable #1), release() re-arms
// only inflight entries, confirm() freezes them.

import { describe, expect, test } from 'bun:test'

import { GuestQueryRegistry } from '../../src/telegram/guest-queries.js'

function makeRegistry(ttlMs = 15 * 60 * 1000): {
  registry: GuestQueryRegistry
  clock: { t: number }
} {
  const clock = { t: 1_000_000 }
  const registry = new GuestQueryRegistry(ttlMs, () => clock.t)
  return { registry, clock }
}

const ENTRY = {
  guestQueryId: 'q1',
  callerUserId: '164795011',
  callerChatId: '-100123',
  messageText: 'что это за ошибка?',
}

describe('GuestQueryRegistry', () => {
  test('claim on a registered query succeeds exactly once', () => {
    const { registry } = makeRegistry()
    expect(registry.register(ENTRY)).toBe(true)

    const first = registry.claim('q1')
    expect(first.kind).toBe('ok')
    if (first.kind === 'ok') {
      expect(first.entry.callerUserId).toBe('164795011')
      expect(first.entry.messageText).toBe('что это за ошибка?')
    }

    const second = registry.claim('q1')
    expect(second.kind).toBe('consumed')
  })

  test('claim on an unknown id refuses', () => {
    const { registry } = makeRegistry()
    expect(registry.claim('nope').kind).toBe('unknown')
  })

  test('claim after TTL refuses as expired', () => {
    const { registry, clock } = makeRegistry(1000)
    registry.register(ENTRY)
    clock.t += 1001
    expect(registry.claim('q1').kind).toBe('expired')
    // Expired entries are dropped — a later claim sees 'unknown'.
    expect(registry.claim('q1').kind).toBe('unknown')
  })

  test('claim exactly AT the TTL boundary is still valid', () => {
    const { registry, clock } = makeRegistry(1000)
    registry.register(ENTRY)
    clock.t += 1000
    expect(registry.claim('q1').kind).toBe('ok')
  })

  test('release re-arms an inflight entry (failed-send retry path)', () => {
    const { registry } = makeRegistry()
    registry.register(ENTRY)
    expect(registry.claim('q1').kind).toBe('ok')
    registry.release('q1')
    expect(registry.claim('q1').kind).toBe('ok')
  })

  test('confirm freezes the entry — release can no longer re-open it', () => {
    const { registry } = makeRegistry()
    registry.register(ENTRY)
    expect(registry.claim('q1').kind).toBe('ok')
    registry.confirm('q1')
    registry.release('q1')
    expect(registry.claim('q1').kind).toBe('consumed')
  })

  test('release on unknown id is a no-op', () => {
    const { registry } = makeRegistry()
    registry.release('ghost')
    expect(registry.claim('ghost').kind).toBe('unknown')
  })

  test('duplicate register is a NO-OP — a consumed query is never resurrected', () => {
    const { registry } = makeRegistry()
    registry.register(ENTRY)
    expect(registry.claim('q1').kind).toBe('ok')
    registry.confirm('q1')
    // Telegram redelivery of the same update must not re-open the query.
    expect(registry.register({ ...ENTRY, messageText: 'redelivered' })).toBe(true)
    const claim = registry.claim('q1')
    expect(claim.kind).toBe('consumed')
  })

  test('duplicate register preserves the original entry content', () => {
    const { registry } = makeRegistry()
    registry.register(ENTRY)
    registry.register({ ...ENTRY, messageText: 'second' })
    const claim = registry.claim('q1')
    expect(claim.kind).toBe('ok')
    if (claim.kind === 'ok') expect(claim.entry.messageText).toBe('что это за ошибка?')
  })

  test('entry cap evicts the oldest pending registration', () => {
    const { registry } = makeRegistry()
    for (let i = 0; i < 65; i++) {
      expect(registry.register({ ...ENTRY, guestQueryId: `q${i}` })).toBe(true)
    }
    // q0 was evicted by the 65th insert; the newest survives.
    expect(registry.claim('q0').kind).toBe('unknown')
    expect(registry.claim('q64').kind).toBe('ok')
  })

  test('duplicate register at cap does not evict anyone', () => {
    const { registry } = makeRegistry()
    for (let i = 0; i < 64; i++) {
      registry.register({ ...ENTRY, guestQueryId: `q${i}` })
    }
    // Re-register an existing id while the map is full — nothing changes.
    expect(registry.register({ ...ENTRY, guestQueryId: 'q3' })).toBe(true)
    expect(registry.claim('q0').kind).toBe('ok')
    expect(registry.claim('q63').kind).toBe('ok')
  })

  test('cap eviction prefers answered tombstones over pending entries', () => {
    const { registry } = makeRegistry()
    for (let i = 0; i < 64; i++) {
      registry.register({ ...ENTRY, guestQueryId: `q${i}` })
    }
    // Answer a mid-list entry — it becomes the eviction victim, not q0.
    expect(registry.claim('q10').kind).toBe('ok')
    registry.confirm('q10')
    expect(registry.register({ ...ENTRY, guestQueryId: 'fresh' })).toBe(true)
    expect(registry.claim('q0').kind).toBe('ok')
    expect(registry.claim('q10').kind).toBe('unknown')
    expect(registry.claim('fresh').kind).toBe('ok')
  })

  test('cap eviction never touches inflight entries; all-inflight refuses registration', () => {
    const { registry } = makeRegistry()
    for (let i = 0; i < 64; i++) {
      registry.register({ ...ENTRY, guestQueryId: `q${i}` })
      expect(registry.claim(`q${i}`).kind).toBe('ok') // all inflight now
    }
    expect(registry.register({ ...ENTRY, guestQueryId: 'overflow' })).toBe(false)
    // Every inflight entry survived — release still works on all of them.
    registry.release('q0')
    expect(registry.claim('q0').kind).toBe('ok')
  })

  // ── hasActiveEntry (download_attachment authorization) ──────────────
  describe('hasActiveEntry', () => {
    test('pending entry with matching chat → true', () => {
      const { registry } = makeRegistry()
      registry.register(ENTRY) // callerChatId: '-100123'
      expect(registry.hasActiveEntry('q1', '-100123')).toBe(true)
    })

    test('inflight entry (claimed, not yet answered) → true', () => {
      const { registry } = makeRegistry()
      registry.register(ENTRY)
      expect(registry.claim('q1').kind).toBe('ok') // now inflight
      expect(registry.hasActiveEntry('q1', '-100123')).toBe(true)
    })

    test('answered entry → false', () => {
      const { registry } = makeRegistry()
      registry.register(ENTRY)
      registry.claim('q1')
      registry.confirm('q1')
      expect(registry.hasActiveEntry('q1', '-100123')).toBe(false)
    })

    test('expired entry → false, WITHOUT mutating (no delete)', () => {
      const { registry, clock } = makeRegistry(1000)
      registry.register(ENTRY)
      clock.t += 1001
      expect(registry.hasActiveEntry('q1', '-100123')).toBe(false)
      // Non-mutating: a later claim still sees it as an entry (expired), not
      // a swept 'unknown'. claim() is what deletes an expired entry.
      expect(registry.claim('q1').kind).toBe('expired')
    })

    test('chat mismatch → false', () => {
      const { registry } = makeRegistry()
      registry.register(ENTRY) // origin -100123
      expect(registry.hasActiveEntry('q1', '-100999')).toBe(false)
    })

    test('unknown id → false', () => {
      const { registry } = makeRegistry()
      expect(registry.hasActiveEntry('ghost', '-100123')).toBe(false)
    })

    test('idempotent across N calls — never consumes the entry', () => {
      const { registry } = makeRegistry()
      registry.register(ENTRY)
      for (let i = 0; i < 5; i++) {
        expect(registry.hasActiveEntry('q1', '-100123')).toBe(true)
      }
      // Still claimable exactly once after all those checks.
      expect(registry.claim('q1').kind).toBe('ok')
    })

    test('entry with unknown origin (callerChatId undefined) accepts any chat', () => {
      const { registry } = makeRegistry()
      // Register WITHOUT callerChatId → entry.callerChatId is undefined.
      registry.register({ guestQueryId: 'q-noorigin', callerUserId: '164795011', messageText: 'q' })
      expect(registry.hasActiveEntry('q-noorigin', '-100123')).toBe(true)
      expect(registry.hasActiveEntry('q-noorigin', '-999')).toBe(true)
    })
  })

  test('pendingCount tracks unconsumed live entries', () => {
    const { registry, clock } = makeRegistry(1000)
    registry.register({ ...ENTRY, guestQueryId: 'a' })
    registry.register({ ...ENTRY, guestQueryId: 'b' })
    expect(registry.pendingCount()).toBe(2)
    registry.claim('a')
    expect(registry.pendingCount()).toBe(1)
    clock.t += 1001
    expect(registry.pendingCount()).toBe(0)
  })
})
