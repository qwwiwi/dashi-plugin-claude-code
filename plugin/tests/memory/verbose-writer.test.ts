// Phase 8 / T3 — verbose-writer tests.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendVerbose, type VerboseRecord } from '../../src/memory/verbose-writer.js'

let dir: string
let logsDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dashi-verbose-writer-'))
  logsDir = join(dir, 'logs')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function record(overrides: Partial<VerboseRecord> = {}): VerboseRecord {
  return {
    ts: '2026-05-15T10:30:00.000Z',
    sid: 'session-1',
    ch: 'tg',
    user: 'hello',
    agent: 'world',
    dur_ms: 1234,
    status: 'completed',
    ...overrides,
  }
}

describe('appendVerbose', () => {
  test('creates logsDir if missing and writes verbose-YYYY-MM-DD.jsonl', async () => {
    await appendVerbose({ logsDir, record: record() })
    const files = readdirSync(logsDir)
    expect(files).toEqual(['verbose-2026-05-15.jsonl'])
  })

  test('record is one JSON object per line, terminated by \\n', async () => {
    await appendVerbose({ logsDir, record: record() })
    const text = readFileSync(join(logsDir, 'verbose-2026-05-15.jsonl'), 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(text.trim()) as VerboseRecord
    expect(parsed.ts).toBe('2026-05-15T10:30:00.000Z')
    expect(parsed.sid).toBe('session-1')
    expect(parsed.ch).toBe('tg')
    expect(parsed.user).toBe('hello')
    expect(parsed.agent).toBe('world')
    expect(parsed.dur_ms).toBe(1234)
    expect(parsed.status).toBe('completed')
  })

  test('key order matches gateway.py: ts, sid, ch, user, agent, dur_ms, status', async () => {
    await appendVerbose({ logsDir, record: record() })
    const text = readFileSync(join(logsDir, 'verbose-2026-05-15.jsonl'), 'utf8').trim()
    // Cheap order check: the substring positions of each key in the
    // raw JSON line must be strictly increasing.
    const expected = ['"ts":', '"sid":', '"ch":', '"user":', '"agent":', '"dur_ms":', '"status":']
    let last = -1
    for (const k of expected) {
      const idx = text.indexOf(k)
      expect(idx).toBeGreaterThan(last)
      last = idx
    }
  })

  test('multiple records on same day append into one file', async () => {
    await appendVerbose({ logsDir, record: record({ user: 'first' }) })
    await appendVerbose({ logsDir, record: record({ user: 'second' }) })
    const text = readFileSync(join(logsDir, 'verbose-2026-05-15.jsonl'), 'utf8')
    const lines = text.trim().split('\n')
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0]!).user).toBe('first')
    expect(JSON.parse(lines[1]!).user).toBe('second')
  })

  test('records on different UTC days land in different files', async () => {
    await appendVerbose({ logsDir, record: record({ ts: '2026-05-15T23:59:59.999Z' }) })
    await appendVerbose({ logsDir, record: record({ ts: '2026-05-16T00:00:00.000Z' }) })
    const files = readdirSync(logsDir).sort()
    expect(files).toEqual(['verbose-2026-05-15.jsonl', 'verbose-2026-05-16.jsonl'])
  })

  test('sid null is preserved (not undefined-stripped)', async () => {
    await appendVerbose({ logsDir, record: record({ sid: null }) })
    const text = readFileSync(join(logsDir, 'verbose-2026-05-15.jsonl'), 'utf8').trim()
    const parsed = JSON.parse(text) as VerboseRecord
    expect(parsed.sid).toBeNull()
    // Raw text must contain `"sid":null`, not omit the key.
    expect(text).toContain('"sid":null')
  })

  test('day derived from record.ts, not Date.now() (locks the doc-comment guarantee)', async () => {
    // Even though the clock might be 2026-05-15, a record from 2025-01-01
    // must go into the 2025 file.
    await appendVerbose({ logsDir, record: record({ ts: '2025-01-01T12:00:00.000Z' }) })
    expect(readdirSync(logsDir)).toEqual(['verbose-2025-01-01.jsonl'])
  })

  test('50 concurrent appends with multi-KB records: every line parseable JSON, no interleave (review HIGH)', async () => {
    // Pre-fix `appendFile` was NOT atomic for buffers > PIPE_BUF on macOS;
    // multi-KB records under burst load could interleave and produce
    // corrupt JSONL — exact failure mode the Cognee cron would silently
    // drop. After the mutex fix every record must round-trip JSON.parse
    // AND retain its full 10KB user/agent text.
    const N = 50
    const tasks: Promise<void>[] = []
    for (let i = 0; i < N; i++) {
      tasks.push(
        appendVerbose({
          logsDir,
          record: record({
            sid: `sess-${i.toString().padStart(4, '0')}`,
            user: 'U'.repeat(10_000),
            agent: 'A'.repeat(10_000),
          }),
        }),
      )
    }
    await Promise.all(tasks)

    const text = readFileSync(join(logsDir, 'verbose-2026-05-15.jsonl'), 'utf8')
    const lines = text.split('\n').filter((l) => l.length > 0)
    expect(lines.length).toBe(N)

    const seen = new Set<string>()
    for (const l of lines) {
      // No throw on JSON.parse — every line is well-formed.
      const parsed = JSON.parse(l) as VerboseRecord
      expect(parsed.user.length).toBeGreaterThanOrEqual(10_000)
      expect(parsed.agent.length).toBeGreaterThanOrEqual(10_000)
      // Every sid is preserved intact, proving no header/body mix-up.
      if (parsed.sid) seen.add(parsed.sid)
    }
    expect(seen.size).toBe(N)
  })
})
