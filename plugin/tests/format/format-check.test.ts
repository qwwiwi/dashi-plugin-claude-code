// Unit tests for the observe-only TOV/format checker.
import { describe, expect, test } from 'bun:test'
import { analyzeFormat, formatHint } from '../../src/format/format-check.js'

function codes(text: string): string[] {
  return analyzeFormat(text).map((f) => f.code)
}

describe('analyzeFormat', () => {
  test('clean short reply → no findings', () => {
    expect(analyzeFormat('Готово. Порядок восстановлен.')).toEqual([])
  })

  test('empty string → no findings', () => {
    expect(analyzeFormat('')).toEqual([])
  })

  test('P450 fires on an oversized paragraph', () => {
    const para = 'слово '.repeat(100) // ~600 visible chars, one paragraph
    const found = analyzeFormat(para)
    expect(found.find((f) => f.code === 'P450')?.count).toBe(1)
  })

  test('P450 does not fire on a long FENCED code block', () => {
    const code = '```\n' + 'x'.repeat(600) + '\n```'
    expect(codes(code)).not.toContain('P450')
  })

  // Review fix (2026-07-09): a fenced block CONTAINING blank lines used to
  // leak its code lines into a surrounding "paragraph" and fire P450.
  test('P450 does not fire on a fenced block containing blank lines', () => {
    const code = '```\n' + 'x'.repeat(300) + '\n\n' + 'y'.repeat(300) + '\n```'
    expect(codes(code)).not.toContain('P450')
  })

  test('P450 still fires on long prose ADJACENT to a fence with blank lines', () => {
    const prose = 'слово '.repeat(100)
    const code = '```\na\n\nb\n```'
    const found = analyzeFormat(`${prose}\n\n${code}`)
    expect(found.find((f) => f.code === 'P450')?.count).toBe(1)
  })

  // Review fix (2026-07-09): ``` inside an open ~~~ fence is content, not a
  // closer — nothing after it may be scored as prose.
  test('mixed fence chars: prose-like lines after an inner ``` stay protected', () => {
    expect(codes('~~~\nM1 — a\n```\nM2 — b\nM3 — c\nM4 — d\n~~~')).toEqual([])
  })

  test('SOFTLIST fires on a run of 3+ soft-break prose lines', () => {
    const found = analyzeFormat('M1 — a\nM2 — b\nM3 — c')
    expect(found.find((f) => f.code === 'SOFTLIST')?.count).toBe(1)
  })

  test('SOFTLIST does not fire on only two prose lines', () => {
    expect(codes('M1 — a\nM2 — b')).not.toContain('SOFTLIST')
  })

  test('SOFTLIST does not fire on a real markdown list', () => {
    expect(codes('- a\n- b\n- c\n- d')).not.toContain('SOFTLIST')
  })

  test('SOFTLIST ignores prose lines inside a fence', () => {
    expect(codes('```\nM1 — a\nM2 — b\nM3 — c\n```')).not.toContain('SOFTLIST')
  })

  test('HEAD_NB fires on a heading glued to following text', () => {
    const found = analyzeFormat('**Заголовок**\nтело сразу под заголовком')
    expect(found.find((f) => f.code === 'HEAD_NB')?.count).toBe(1)
  })

  test('HEAD_NB does not fire when heading is wrapped in blank lines', () => {
    expect(codes('вступление\n\n**Заголовок**\n\nтело')).not.toContain('HEAD_NB')
  })

  test('never returns any message text — only codes + numeric counts', () => {
    for (const f of analyzeFormat('M1 — секрет\nM2 — секрет\nM3 — секрет')) {
      expect(typeof f.count).toBe('number')
      expect(f.code).toMatch(/^[A-Z0-9_]+$/)
    }
  })
})

describe('formatHint', () => {
  test('empty findings → empty string', () => {
    expect(formatHint([])).toBe('')
  })

  test('renders codes + counts, references docs/TOV.md, no message text', () => {
    const hint = formatHint([
      { code: 'SOFTLIST', count: 1 },
      { code: 'P450', count: 2 },
    ])
    expect(hint).toContain('SOFTLIST=1')
    expect(hint).toContain('P450=2')
    expect(hint).toContain('docs/TOV.md')
  })
})
