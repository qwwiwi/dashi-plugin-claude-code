// Context-window usage parser tests. All fixtures are inline JSON strings —
// never read a real transcript here (they are many MB and machine-specific).

import { describe, expect, test } from 'bun:test'

import {
  computeContextUsage,
  formatContextUsage,
  formatWindowTokens,
} from '../../src/status/context-usage.js'

// Build one transcript line. `isSidechain` defaults to false (main thread).
// `model` (when set) lands on `message.model`, mirroring a real Claude Code
// assistant line ("claude-fable-5" etc.).
function assistantLine(
  usage: Record<string, number> | null,
  opts: { isSidechain?: boolean; model?: unknown } = {},
): string {
  const message: Record<string, unknown> = { role: 'assistant', content: [] }
  if (usage !== null) message.usage = usage
  if ('model' in opts) message.model = opts.model
  return JSON.stringify({
    type: 'assistant',
    isSidechain: opts.isSidechain ?? false,
    parentUuid: 'p',
    userType: 'external',
    message,
  })
}

function userLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    isSidechain: false,
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
}

describe('computeContextUsage', () => {
  test('normal main-thread turn → input + both cache fields, correct pct', () => {
    const lines = [
      userLine('hi'),
      assistantLine({
        input_tokens: 2,
        cache_read_input_tokens: 100000,
        cache_creation_input_tokens: 12000,
        output_tokens: 5000,
      }),
    ]
    const result = computeContextUsage(lines, 200000)
    // 2 + 100000 + 12000 = 112002 (output_tokens EXCLUDED)
    expect(result).toEqual({ usedTokens: 112002, pct: 112002 / 200000 })
  })

  test('missing cache fields → treated as 0', () => {
    const lines = [assistantLine({ input_tokens: 50000, output_tokens: 100 })]
    const result = computeContextUsage(lines, 200000)
    expect(result).toEqual({ usedTokens: 50000, pct: 50000 / 200000 })
  })

  test('only cache_read present → cache_creation defaults to 0', () => {
    const lines = [
      assistantLine({ input_tokens: 10, cache_read_input_tokens: 30000 }),
    ]
    const result = computeContextUsage(lines, 100000)
    expect(result).toEqual({ usedTokens: 30010, pct: 30010 / 100000 })
  })

  test('no assistant turn → null', () => {
    const lines = [userLine('a'), userLine('b')]
    expect(computeContextUsage(lines, 200000)).toBeNull()
  })

  test('empty input → null', () => {
    expect(computeContextUsage([], 200000)).toBeNull()
  })

  test('assistant turns without usage are skipped, earlier good one wins', () => {
    const lines = [
      assistantLine({ input_tokens: 5, cache_read_input_tokens: 40000 }),
      assistantLine(null), // no usage — skip
    ]
    const result = computeContextUsage(lines, 200000)
    expect(result).toEqual({ usedTokens: 40005, pct: 40005 / 200000 })
  })

  test('malformed / truncated lines interleaved → skipped, good line still found', () => {
    const good = assistantLine({
      input_tokens: 3,
      cache_read_input_tokens: 80000,
      cache_creation_input_tokens: 2000,
    })
    const lines = [
      good,
      '', // blank
      '{"type":"assistant","message":{"role":"assis', // truncated JSON
      'not json at all',
      'null', // valid JSON, wrong shape
      '[1,2,3]', // valid JSON, bare array
    ]
    const result = computeContextUsage(lines, 200000)
    expect(result).toEqual({ usedTokens: 82003, pct: 82003 / 200000 })
  })

  test('sidechain line AFTER real main-thread line → sidechain ignored', () => {
    const main = assistantLine({
      input_tokens: 4,
      cache_read_input_tokens: 150000,
      cache_creation_input_tokens: 3000,
    })
    const side = assistantLine(
      { input_tokens: 500, cache_read_input_tokens: 1200 },
      { isSidechain: true },
    )
    // Scanning backwards hits the sidechain line first; it must be skipped.
    const lines = [main, side]
    const result = computeContextUsage(lines, 200000)
    expect(result).toEqual({ usedTokens: 153004, pct: 153004 / 200000 })
  })

  test('latest main-thread turn wins over earlier main-thread turns', () => {
    const lines = [
      assistantLine({ input_tokens: 1, cache_read_input_tokens: 10000 }),
      assistantLine({ input_tokens: 1, cache_read_input_tokens: 90000 }),
    ]
    const result = computeContextUsage(lines, 200000)
    expect(result?.usedTokens).toBe(90001)
  })

  test('windowTokens <= 0 → usedTokens real, pct 0 (no Infinity/NaN)', () => {
    const lines = [assistantLine({ input_tokens: 10, cache_read_input_tokens: 20000 })]
    const zero = computeContextUsage(lines, 0)
    expect(zero).toEqual({ usedTokens: 20010, pct: 0 })
    const neg = computeContextUsage(lines, -5)
    expect(neg).toEqual({ usedTokens: 20010, pct: 0 })
  })

  test('usage present but input_tokens missing → not a usable turn, skip', () => {
    const lines = [
      assistantLine({ input_tokens: 7, cache_read_input_tokens: 60000 }),
      // usage object with no input_tokens — skipped, falls back to earlier line
      JSON.stringify({
        type: 'assistant',
        isSidechain: false,
        message: { role: 'assistant', usage: { cache_read_input_tokens: 999 } },
      }),
    ]
    const result = computeContextUsage(lines, 200000)
    expect(result?.usedTokens).toBe(60007)
  })

  // FIX-13 (Fable L3): an API-error synthetic turn can persist a usage block
  // that sums to 0. Treating it as the live window would flash the HUD to 0%
  // mid-session — scan PAST it to the last genuine turn.
  test('FIX-13: a zero-sum synthetic turn is skipped, earlier real turn wins', () => {
    const lines = [
      assistantLine({ input_tokens: 5, cache_read_input_tokens: 40000 }), // real
      assistantLine({ input_tokens: 0, output_tokens: 120 }), // synthetic: used = 0
    ]
    const result = computeContextUsage(lines, 200000)
    expect(result).toEqual({ usedTokens: 40005, pct: 40005 / 200000 })
  })

  test('FIX-13: all turns zero-sum → null (no usable window)', () => {
    const lines = [assistantLine({ input_tokens: 0 }), assistantLine({ input_tokens: 0 })]
    expect(computeContextUsage(lines, 200000)).toBeNull()
  })

  // Model capture: hook payloads carry no model, so the transcript is the HUD's
  // only source of the true context window (Fable = 1M).
  test('model comes from the last usable assistant line', () => {
    const lines = [
      assistantLine({ input_tokens: 10, cache_read_input_tokens: 50000 }, {
        model: 'claude-fable-5',
      }),
    ]
    const result = computeContextUsage(lines, 1_000_000)
    expect(result).toEqual({
      usedTokens: 50010,
      pct: 50010 / 1_000_000,
      model: 'claude-fable-5',
    })
  })

  test('model absent → undefined (field never set)', () => {
    const lines = [assistantLine({ input_tokens: 50000 })]
    const result = computeContextUsage(lines, 200000)
    expect(result).toEqual({ usedTokens: 50000, pct: 50000 / 200000 })
    expect(result?.model).toBeUndefined()
  })

  test('model empty string → undefined', () => {
    const lines = [assistantLine({ input_tokens: 50000 }, { model: '' })]
    expect(computeContextUsage(lines, 200000)?.model).toBeUndefined()
  })

  test('model non-string (e.g. number) → undefined', () => {
    const lines = [assistantLine({ input_tokens: 50000 }, { model: 42 })]
    expect(computeContextUsage(lines, 200000)?.model).toBeUndefined()
  })

  test('model comes from the LATEST usable turn, not an earlier one', () => {
    const lines = [
      assistantLine({ input_tokens: 1, cache_read_input_tokens: 10000 }, { model: 'opus' }),
      assistantLine({ input_tokens: 2, cache_read_input_tokens: 20000 }, {
        model: 'claude-fable-5',
      }),
    ]
    expect(computeContextUsage(lines, 200000)?.model).toBe('claude-fable-5')
  })

  test('sidechain line carrying a model is still skipped (no leak of subagent model)', () => {
    const lines = [
      assistantLine({ input_tokens: 5, cache_read_input_tokens: 40000 }, { model: 'opus' }), // main
      assistantLine({ input_tokens: 900, cache_read_input_tokens: 900 }, {
        isSidechain: true,
        model: 'claude-fable-5',
      }),
    ]
    const result = computeContextUsage(lines, 200000)
    expect(result?.usedTokens).toBe(40005)
    expect(result?.model).toBe('opus')
  })

  test('model is NOT scavenged from a different line when the usable turn lacks it', () => {
    const lines = [
      assistantLine({ input_tokens: 1, cache_read_input_tokens: 10000 }, {
        model: 'claude-fable-5',
      }), // earlier, has model
      assistantLine({ input_tokens: 2, cache_read_input_tokens: 20000 }), // latest usable, NO model
    ]
    // The latest usable turn wins and it has no model — do not borrow from the
    // earlier line.
    expect(computeContextUsage(lines, 200000)?.model).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────
// readContextUsage — FIX-12 (bytesRead slicing). A normal read must still
// parse correctly; a regression that decoded the whole allocation (NUL padding)
// would corrupt the final line and return null.
// ─────────────────────────────────────────────────────────────────────

describe('readContextUsage (file tail)', () => {
  test('reads the last main-thread turn from a real transcript file', async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { readContextUsage } = await import('../../src/status/context-usage.js')
    const dir = mkdtempSync(join(tmpdir(), 'ctxusage-'))
    try {
      const p = join(dir, 's.jsonl')
      writeFileSync(
        p,
        userLine('hi') +
          '\n' +
          assistantLine({ input_tokens: 100000, cache_read_input_tokens: 10000 }) +
          '\n',
      )
      const usage = await readContextUsage(p, 200000)
      expect(usage?.usedTokens).toBe(110000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('missing file → null (never throws)', async () => {
    const { readContextUsage } = await import('../../src/status/context-usage.js')
    expect(await readContextUsage('/no/such/transcript.jsonl', 200000)).toBeNull()
  })
})

describe('formatContextUsage', () => {
  test('rounds tokens to nearest 1k and pct to integer', () => {
    expect(formatContextUsage({ usedTokens: 114000 }, 200000)).toBe('114k / 200k (57%)')
  })

  test('rounds k up at the half boundary', () => {
    expect(formatContextUsage({ usedTokens: 115500 }, 200000)).toBe('116k / 200k (58%)')
  })

  test('rounds pct to nearest integer', () => {
    // 91234 / 200000 = 45.617% → 46%
    expect(formatContextUsage({ usedTokens: 91234 }, 200000)).toBe('91k / 200k (46%)')
  })

  test('windowTokens <= 0 → 0%', () => {
    expect(formatContextUsage({ usedTokens: 50000 }, 0)).toBe('50k / 0k (0%)')
  })

  test('1M window renders «1M» denominator (not 1000k)', () => {
    // 151k of a 1M window ≈ 15%.
    expect(formatContextUsage({ usedTokens: 151000 }, 1_000_000)).toBe('151k / 1M (15%)')
  })
})

describe('formatWindowTokens', () => {
  test('historical 200k window stays «200k»', () => {
    expect(formatWindowTokens(200_000)).toBe('200k')
  })

  test('whole millions render as «M»', () => {
    expect(formatWindowTokens(1_000_000)).toBe('1M')
    expect(formatWindowTokens(2_000_000)).toBe('2M')
  })

  test('non-whole-million large window falls back to «k»', () => {
    expect(formatWindowTokens(1_500_000)).toBe('1500k')
  })
})
