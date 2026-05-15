// Phase 8 / T2 — hot-writer tests.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { appendHotEntry, snippet } from '../../src/memory/hot-writer.js'

let dir: string
let hotPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dashi-hot-writer-'))
  hotPath = join(dir, 'core', 'hot', 'recent.md')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function defaultInput(overrides: Partial<Parameters<typeof appendHotEntry>[0]> = {}): Parameters<typeof appendHotEntry>[0] {
  return {
    path: hotPath,
    ts: '2026-05-15 12:00',
    agentLabel: 'Silvana',
    sourceTag: 'tg',
    userSnippet: 'hello',
    agentSnippet: 'hi there',
    maxBytes: 20480,
    trimKeepLines: 600,
    ...overrides,
  }
}

describe('snippet', () => {
  test('collapses newlines to spaces', () => {
    expect(snippet('a\nb\nc')).toBe('a b c')
  })

  test('slices to max chars (default 200)', () => {
    const s = 'x'.repeat(300)
    expect(snippet(s).length).toBe(200)
  })

  test('honours explicit max', () => {
    expect(snippet('abcdef', 3)).toBe('abc')
  })

  test('returns empty string for empty/falsy input', () => {
    expect(snippet('')).toBe('')
    // typecheck-safe: function tolerates undefined-ish via the `|| ''` guard
    expect(snippet(undefined as unknown as string)).toBe('')
  })
})

describe('appendHotEntry', () => {
  test('writes 4-line entry with gateway.py-format header (newline + ### + tag, **User:**, **Agent:**)', async () => {
    await appendHotEntry(defaultInput())
    const text = readFileSync(hotPath, 'utf8')
    // First char is a leading newline (per gateway.py format spec).
    expect(text.startsWith('\n### 2026-05-15 12:00 [tg]\n')).toBe(true)
    expect(text).toContain('**User:** hello\n')
    expect(text).toContain('**Silvana:** hi there\n')
  })

  test('mkdir -p creates core/hot/ on first write', async () => {
    // sanity — parent doesn't exist yet
    let parentExisted = true
    try {
      readdirSync(dirname(hotPath))
    } catch {
      parentExisted = false
    }
    expect(parentExisted).toBe(false)
    await appendHotEntry(defaultInput())
    // file now exists
    expect(readFileSync(hotPath, 'utf8').length).toBeGreaterThan(0)
  })

  test('appends across multiple calls (no overwrite)', async () => {
    await appendHotEntry(defaultInput({ userSnippet: 'first' }))
    await appendHotEntry(defaultInput({ userSnippet: 'second' }))
    const text = readFileSync(hotPath, 'utf8')
    expect(text).toContain('**User:** first\n')
    expect(text).toContain('**User:** second\n')
  })

  test('concurrent 200 appends: every line present, no interleave', async () => {
    const N = 200
    const tasks: Promise<void>[] = []
    for (let i = 0; i < N; i++) {
      tasks.push(
        appendHotEntry(
          defaultInput({
            userSnippet: `u${i.toString().padStart(4, '0')}`,
            agentSnippet: `a${i.toString().padStart(4, '0')}`,
          }),
        ),
      )
    }
    await Promise.all(tasks)
    const text = readFileSync(hotPath, 'utf8')
    for (let i = 0; i < N; i++) {
      const id = i.toString().padStart(4, '0')
      expect(text).toContain(`**User:** u${id}\n`)
      expect(text).toContain(`**Silvana:** a${id}\n`)
    }
    // Cheap interleave check: every '**User:** uNNNN' must be followed
    // by the matching '**Silvana:** aNNNN' on the next non-empty line.
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const m = /^\*\*User:\*\* u(\d{4})$/.exec(lines[i]!)
      if (!m) continue
      const next = lines[i + 1] ?? ''
      expect(next).toBe(`**Silvana:** a${m[1]}`)
    }
  })

  test('triggers emergency trim when file exceeds maxBytes', async () => {
    // Pre-seed ~30 KB so the first append triggers the >20 KB branch.
    const pre = '\n### 2026-05-15 11:00 [tg]\n' +
      '**User:** ' + 'a'.repeat(180) + '\n' +
      '**Silvana:** ' + 'b'.repeat(180) + '\n'
    // mkdir-p so we can pre-seed before the writer ever runs.
    const fs = await import('node:fs/promises')
    await fs.mkdir(dirname(hotPath), { recursive: true })
    let seed = ''
    while (seed.length < 30 * 1024) seed += pre
    writeFileSync(hotPath, seed, 'utf8')

    await appendHotEntry(defaultInput({ maxBytes: 20480, trimKeepLines: 50 }))

    const text = readFileSync(hotPath, 'utf8')
    expect(text.length).toBeLessThanOrEqual(20480 + 256) // small slack for header
    // First non-empty line after the header section must start with `### `
    const lines = text.split('\n')
    let firstEntryIdx = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.startsWith('### ')) { firstEntryIdx = i; break }
    }
    expect(firstEntryIdx).toBeGreaterThanOrEqual(0)
    // Header is preserved at the top — ASCII `--`, byte-parity with
    // gateway.py:1973 + scripts/trim-hot.sh. NOT em-dash (review HIGH).
    expect(text.startsWith('# Hot memory -- last 24h rolling journal\n\n')).toBe(true)
    // Exact-byte check on the first 42 bytes (length of the header).
    const headerLiteral = '# Hot memory -- last 24h rolling journal\n\n'
    expect(text.slice(0, headerLiteral.length)).toBe(headerLiteral)
  })

  test('trim leaves no orphan .recent.md.tmp.* file in target dir', async () => {
    const fs = await import('node:fs/promises')
    await fs.mkdir(dirname(hotPath), { recursive: true })
    const pre = '\n### 2026-05-15 11:00 [tg]\n' +
      '**User:** ' + 'a'.repeat(180) + '\n' +
      '**Silvana:** ' + 'b'.repeat(180) + '\n'
    let seed = ''
    while (seed.length < 30 * 1024) seed += pre
    writeFileSync(hotPath, seed, 'utf8')

    await appendHotEntry(defaultInput({ maxBytes: 20480, trimKeepLines: 50 }))

    const siblings = readdirSync(dirname(hotPath))
    for (const name of siblings) {
      expect(name.startsWith('.recent.md.tmp.')).toBe(false)
    }
  })

  test('trim cleans up tmp orphan when rename throws (review MEDIUM)', async () => {
    // Pre-fix: writeFile + rename had no try/catch. If rename failed
    // (EBUSY, EIO, kill-between-awaits) the tmp file stayed forever; PID
    // + ms suffixes meant successive faulted trims would accumulate
    // distinct .recent.md.tmp.* orphans. After the fix, any throw
    // between writeFile and rename triggers an unlink on tmp.
    const fs = await import('node:fs/promises')
    await fs.mkdir(dirname(hotPath), { recursive: true })
    const pre = '\n### 2026-05-15 11:00 [tg]\n' +
      '**User:** ' + 'a'.repeat(180) + '\n' +
      '**Silvana:** ' + 'b'.repeat(180) + '\n'
    let seed = ''
    while (seed.length < 30 * 1024) seed += pre
    writeFileSync(hotPath, seed, 'utf8')

    // Inject deps: writeFile real, rename throws EBUSY once, unlink real.
    let renameCalls = 0
    let unlinkCalls = 0
    const deps = {
      writeFile: fs.writeFile,
      rename: async (..._args: unknown[]) => {
        renameCalls++
        const e = new Error('EBUSY: device or resource busy') as Error & { code?: string }
        e.code = 'EBUSY'
        throw e
      },
      unlink: async (p: string) => {
        unlinkCalls++
        return fs.unlink(p)
      },
    } as unknown as Parameters<typeof appendHotEntry>[1]

    let caught: unknown
    try {
      await appendHotEntry(
        defaultInput({ maxBytes: 20480, trimKeepLines: 50 }),
        deps,
      )
    } catch (err) {
      caught = err
    }
    // (a) trim threw — the appendHotEntry call propagated the rename error.
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error & { code?: string }).code).toBe('EBUSY')
    expect(renameCalls).toBe(1)
    expect(unlinkCalls).toBe(1)
    // (b) no orphan .recent.md.tmp.* file remains in the directory.
    const siblings = readdirSync(dirname(hotPath))
    for (const name of siblings) {
      expect(name.startsWith('.recent.md.tmp.')).toBe(false)
    }
  })

  test('newlines in snippets are caller responsibility (writer does not collapse — uses snippet() upstream)', async () => {
    // The hot-writer takes already-flattened snippets; embedding a raw
    // newline produces multi-line entries by design. snippet() is the
    // helper callers must use. This locks the contract.
    await appendHotEntry(defaultInput({ userSnippet: 'line1\nline2' }))
    const text = readFileSync(hotPath, 'utf8')
    expect(text).toContain('**User:** line1\nline2\n')
  })
})
