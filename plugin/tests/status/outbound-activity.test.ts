// Tests for OutboundActivityTracker — the monotonic-latest last-outbound clock.

import { describe, expect, test } from 'bun:test'
import { OutboundActivityTracker } from '../../src/status/outbound-activity.js'

describe('OutboundActivityTracker', () => {
  test('undefined before any send', () => {
    const t = new OutboundActivityTracker()
    expect(t.lastOutboundAt('1')).toBeUndefined()
  })

  test('records and reads per chat', () => {
    const t = new OutboundActivityTracker()
    t.record('1', 1000)
    t.record('2', 2000)
    expect(t.lastOutboundAt('1')).toBe(1000)
    expect(t.lastOutboundAt('2')).toBe(2000)
  })

  test('monotonic-latest — never moves backwards', () => {
    const t = new OutboundActivityTracker()
    t.record('1', 5000)
    t.record('1', 3000) // late-completing older send
    expect(t.lastOutboundAt('1')).toBe(5000)
    t.record('1', 6000)
    expect(t.lastOutboundAt('1')).toBe(6000)
  })
})
