// The byte-budget table in docs/widgets.md must come from a real run of the
// serializer: the test rebuilds each documented card and compares the doc.

import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

const DOC = readFileSync(new URL('../../docs/widgets.md', import.meta.url), 'utf8')
const LETTERS = 'Абвгдежзийк' // 11 Cyrillic letters
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

function card(groups: number[], jobCount: number, detailed: number): string {
  const detail = { m: 'local', t: 12, s: LETTERS, r: LETTERS }
  return JSON.stringify({
    m: groups.map((n) => [LETTERS, Array.from({ length: n }, () => [LETTERS, 50])]),
    j: Array.from({ length: jobCount }, (_, i) => (i < detailed ? [LETTERS, 50, 'r', detail] : [LETTERS, 50, 'r'])),
  })
}

describe('docs/widgets.md byte budget table', () => {
  const cases: Array<[string, string]> = [
    ['18 rows, 5 jobs, no details', card([8, 5, 5], 5, 0)],
    ['two jobs with details', card([8, 5, 5], 5, 2)],
    ['11 rows, all five jobs with details', card([4, 4, 3], 5, 5)],
    ['12 rows, all five jobs with details', card([4, 4, 4], 5, 5)],
  ]
  for (const [name, json] of cases) {
    test(`${name}: the documented size is the measured ${bytes(json)} bytes`, () => {
      expect(DOC).toContain(`| ${bytes(json)} bytes`)
    })
  }

  test('the example states its real detail values (model local, 12 minutes), not a Cyrillic model name', () => {
    expect(DOC).toContain('model `local`')
    expect(DOC).toContain('12 minutes')
  })
})
