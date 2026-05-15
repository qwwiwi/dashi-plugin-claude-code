import { describe, expect, test } from 'bun:test'

import { splitMessage, TELEGRAM_MAX_MESSAGE } from '../../src/format/chunk.js'

describe('splitMessage', () => {
  test('returns one chunk below the limit', () => {
    const out = splitMessage('hello world', 4000)
    expect(out).toEqual(['hello world'])
  })

  test('returns empty array for empty input', () => {
    expect(splitMessage('', 4000)).toEqual([])
  })

  test('splits on paragraph boundary before hard cutting', () => {
    const para1 = 'a'.repeat(60)
    const para2 = 'b'.repeat(60)
    const para3 = 'c'.repeat(60)
    const text = `${para1}\n\n${para2}\n\n${para3}`
    const out = splitMessage(text, 130)
    // Two chunks: first holds para1+para2 (60 + 2 + 60 = 122 <= 130), second holds para3.
    expect(out.length).toBe(2)
    expect(out[0]).toContain(para1)
    expect(out[0]).toContain(para2)
    expect(out[1]).toContain(para3)
    // No chunk exceeds the max
    for (const c of out) expect(c.length).toBeLessThanOrEqual(130)
  })

  test('splits long paragraph on line boundary', () => {
    // One paragraph (no \n\n) but several lines.
    const lines: string[] = []
    for (let i = 0; i < 10; i++) lines.push('x'.repeat(50))
    const text = lines.join('\n')
    const out = splitMessage(text, 120)
    expect(out.length).toBeGreaterThan(1)
    for (const c of out) expect(c.length).toBeLessThanOrEqual(120)
    // Reassembly (after trimming leading \n we trim ourselves) should contain
    // all the original line bodies.
    expect(out.join('').replace(/\n/g, '')).toContain('x'.repeat(50))
  })

  test('hard cuts a single over-limit line', () => {
    // Single line, no paragraph or newline boundaries.
    const text = 'z'.repeat(500)
    const out = splitMessage(text, 100)
    expect(out.length).toBeGreaterThanOrEqual(5)
    for (const c of out) expect(c.length).toBeLessThanOrEqual(100)
    expect(out.join('')).toBe(text)
  })

  test('preserves pre and code block boundaries when possible', () => {
    // A pre block that fits inside a single chunk should never be split.
    const text =
      'intro paragraph\n\n<pre>line1\nline2\nline3</pre>\n\noutro paragraph'
    const out = splitMessage(text, 4000)
    expect(out.length).toBe(1)
    expect(out[0]).toContain('<pre>line1\nline2\nline3</pre>')
  })

  test('closes and reopens pre tag when forced to split inside it', () => {
    // Pre block big enough that it MUST be cut. Each chunk should still
    // have balanced <pre>…</pre> tags so Telegram's HTML parser accepts it.
    const lines: string[] = []
    for (let i = 0; i < 12; i++) lines.push(`L${i}_${'y'.repeat(20)}`)
    const text = `<pre>${lines.join('\n')}</pre>`
    const out = splitMessage(text, 120)
    expect(out.length).toBeGreaterThan(1)
    for (const c of out) {
      const opens = (c.match(/<pre>/g) || []).length
      const closes = (c.match(/<\/pre>/g) || []).length
      expect(opens).toBe(closes)
      expect(c.length).toBeLessThanOrEqual(120)
    }
  })

  test('does not emit empty chunks after trimming leading newlines', () => {
    // Lots of paragraph breaks forces trimming; we must never emit "".
    const text = ['p1', 'p2', 'p3', 'p4'].map(p => p.repeat(20)).join('\n\n\n\n')
    const out = splitMessage(text, 50)
    for (const c of out) expect(c.length).toBeGreaterThan(0)
  })

  test('TELEGRAM_MAX_MESSAGE constant matches Telegram API cap', () => {
    expect(TELEGRAM_MAX_MESSAGE).toBe(4096)
  })

  test('default max is 4000 (leaves headroom under 4096 cap)', () => {
    const text = 'a'.repeat(4500)
    const out = splitMessage(text)
    expect(out.length).toBeGreaterThanOrEqual(2)
    for (const c of out) expect(c.length).toBeLessThanOrEqual(4000)
  })
})
