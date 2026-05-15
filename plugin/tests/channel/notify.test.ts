import { describe, expect, test } from 'bun:test'
import { normalizeMeta } from '../../src/channel/notify.js'

describe('normalizeMeta', () => {
  test('drops keys with hyphens', () => {
    const out = normalizeMeta({ 'chat-id': '123', chat_id: '456' })
    expect(out['chat-id']).toBeUndefined()
    expect(out.chat_id).toBe('456')
  })

  test('coerces numbers and booleans to string', () => {
    const out = normalizeMeta({ count: 42, ok: true, off: false })
    expect(out.count).toBe('42')
    expect(out.ok).toBe('true')
    expect(out.off).toBe('false')
  })

  test('drops null and undefined values', () => {
    const out = normalizeMeta({ keep: 'yes', a: null, b: undefined })
    expect(out.keep).toBe('yes')
    expect(Object.keys(out)).toEqual(['keep'])
  })

  test("rejects keys that don't match identifier regex", () => {
    const out = normalizeMeta({
      good_key: 'a',
      '1starts_with_digit': 'b',
      'has space': 'c',
      'has.dot': 'd',
      _underscore_ok: 'e',
    })
    expect(out.good_key).toBe('a')
    expect(out._underscore_ok).toBe('e')
    expect(out['1starts_with_digit']).toBeUndefined()
    expect(out['has space']).toBeUndefined()
    expect(out['has.dot']).toBeUndefined()
  })
})
