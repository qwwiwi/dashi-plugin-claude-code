// Unit tests for the Guest Mode query registry (src/telegram/guest-queries.ts).
//
// The registry is the authorization primitive for guest replies: only
// allowlisted callers' queries are ever registered, and claim() is the
// one-shot gate the reply tool relies on. These tests pin the fail-closed
// contract: unknown / consumed / expired all refuse, release() re-arms
// after a failed send, and the entry cap drops the oldest.

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
    registry.register(ENTRY)

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

  test('release re-arms a consumed entry (failed-send retry path)', () => {
    const { registry } = makeRegistry()
    registry.register(ENTRY)
    expect(registry.claim('q1').kind).toBe('ok')
    registry.release('q1')
    expect(registry.claim('q1').kind).toBe('ok')
  })

  test('release on unknown id is a no-op', () => {
    const { registry } = makeRegistry()
    registry.release('ghost')
    expect(registry.claim('ghost').kind).toBe('unknown')
  })

  test('re-register of the same id resets the consumed tombstone', () => {
    const { registry } = makeRegistry()
    registry.register(ENTRY)
    expect(registry.claim('q1').kind).toBe('ok')
    // Telegram never reuses guest_query_id in practice, but the map must
    // not wedge if it did — a fresh register wins.
    registry.register({ ...ENTRY, messageText: 'second' })
    const claim = registry.claim('q1')
    expect(claim.kind).toBe('ok')
    if (claim.kind === 'ok') expect(claim.entry.messageText).toBe('second')
  })

  test('entry cap drops the oldest registration', () => {
    const { registry } = makeRegistry()
    for (let i = 0; i < 65; i++) {
      registry.register({ ...ENTRY, guestQueryId: `q${i}` })
    }
    // q0 was evicted by the 65th insert; the newest survives.
    expect(registry.claim('q0').kind).toBe('unknown')
    expect(registry.claim('q64').kind).toBe('ok')
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
