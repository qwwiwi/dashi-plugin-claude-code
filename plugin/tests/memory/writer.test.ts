// Phase 8 / T6 — MemoryWriter facade tests (unit-level).
//
// T8 layers an end-to-end webhook test on top of these; here we drive
// the facade directly to assert UserPromptSubmit/Stop semantics,
// `(no prompt)` fallback, transcript-missing graceful path, and fake-
// clock determinism for ts + dur_ms.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryWriter, type MemoryConfig } from '../../src/memory/writer.js'
import type { Logger } from '../../src/log.js'
import type { ClaudeHookPayload } from '../../src/schemas.js'

interface LogCall { level: 'debug' | 'info' | 'warn' | 'error'; msg: string; ctx?: Record<string, unknown> }
function makeLog(): { log: Logger; calls: LogCall[] } {
  const calls: LogCall[] = []
  const log: Logger = {
    debug: (msg, ctx) => calls.push({ level: 'debug', msg, ...(ctx !== undefined ? { ctx } : {}) }),
    info: (msg, ctx) => calls.push({ level: 'info', msg, ...(ctx !== undefined ? { ctx } : {}) }),
    warn: (msg, ctx) => calls.push({ level: 'warn', msg, ...(ctx !== undefined ? { ctx } : {}) }),
    error: (msg, ctx) => calls.push({ level: 'error', msg, ...(ctx !== undefined ? { ctx } : {}) }),
  }
  return { log, calls }
}

let baseDir: string
let workspacePath: string
let logsPath: string

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'dashi-memory-writer-'))
  workspacePath = join(baseDir, 'workspace')
  logsPath = join(baseDir, 'logs')
  // workspace itself exists; core/hot/ is auto-mkdir'd by hot-writer.
  mkdirSync(workspacePath, { recursive: true })
})

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

function cfg(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    workspacePath,
    logsPath,
    sourceTag: 'tg',
    agentLabel: 'Silvana',
    maxHotBytes: 20480,
    trimKeepLines: 600,
    bufferTtlMs: 5 * 60 * 1000,
    bufferMaxEntries: 100,
    ...overrides,
  }
}

function fakeClock(start = Date.UTC(2026, 4, 15, 10, 0, 0)): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

function payload<E extends ClaudeHookPayload['hook_event_name']>(
  ev: E,
  extra: Record<string, unknown> = {},
): ClaudeHookPayload {
  const base = {
    chatId: '164795011',
    session_id: 'sid-1',
    transcript_path: '/tmp/none.jsonl',
    cwd: '/tmp',
    hook_event_name: ev,
    ...extra,
  }
  return base as unknown as ClaudeHookPayload
}

function writeTranscript(dir: string, content: string): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'session.jsonl')
  writeFileSync(p, content, 'utf8')
  return p
}

// ─────────────────────────────────────────────────────────────────────

describe('MemoryWriter.onHook', () => {
  test('UserPromptSubmit alone writes nothing — just buffers', async () => {
    const c = fakeClock()
    const { log } = makeLog()
    const w = new MemoryWriter(cfg(), log, c.now)

    await w.onHook(payload('UserPromptSubmit', { prompt: 'hi from user' }))

    // No files written yet.
    let hotExists = true
    try { readFileSync(join(workspacePath, 'core', 'hot', 'recent.md'), 'utf8') } catch { hotExists = false }
    expect(hotExists).toBe(false)
    let logsExist = true
    try { readdirSync(logsPath) } catch { logsExist = false }
    expect(logsExist).toBe(false)
  })

  test('UserPromptSubmit + Stop writes recent.md and verbose-*.jsonl with buffered prompt and transcript text', async () => {
    const c = fakeClock()
    const { log } = makeLog()
    const w = new MemoryWriter(cfg(), log, c.now)

    const transcript = writeTranscript(baseDir, JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'agent reply here' }] },
    }) + '\n')

    await w.onHook(payload('UserPromptSubmit', { prompt: 'user question?' }))
    c.advance(2500) // 2.5s "compute time"
    await w.onHook(payload('Stop', { transcript_path: transcript }))

    const hot = readFileSync(join(workspacePath, 'core', 'hot', 'recent.md'), 'utf8')
    expect(hot).toContain('**User:** user question?\n')
    expect(hot).toContain('**Silvana:** agent reply here\n')
    // Local-tz ts format: 'YYYY-MM-DD HH:MM' — just assert shape.
    expect(hot).toMatch(/### \d{4}-\d{2}-\d{2} \d{2}:\d{2} \[tg\]/)

    // verbose: derive day from record.ts (UTC ISO). fakeClock starts
    // at 2026-05-15 10:00 UTC + 2.5s, so day = 2026-05-15.
    const files = readdirSync(logsPath).sort()
    expect(files).toEqual(['verbose-2026-05-15.jsonl'])
    const v = JSON.parse(readFileSync(join(logsPath, 'verbose-2026-05-15.jsonl'), 'utf8').trim())
    expect(v.user).toBe('user question?')
    expect(v.agent).toBe('agent reply here')
    expect(v.sid).toBe('sid-1')
    expect(v.ch).toBe('tg')
    expect(v.dur_ms).toBe(2500)
    expect(v.status).toBe('completed')
    expect(v.ts).toBe(new Date(Date.UTC(2026, 4, 15, 10, 0, 2, 500)).toISOString())
  })

  test('Stop without prior UserPromptSubmit writes (no prompt) + warn + dur_ms=0', async () => {
    const c = fakeClock()
    const { log, calls } = makeLog()
    const w = new MemoryWriter(cfg(), log, c.now)

    await w.onHook(payload('Stop'))

    const hot = readFileSync(join(workspacePath, 'core', 'hot', 'recent.md'), 'utf8')
    expect(hot).toContain('**User:** (no prompt)\n')
    expect(hot).toContain('**Silvana:** (inline)\n')

    const v = JSON.parse(readFileSync(join(logsPath, 'verbose-2026-05-15.jsonl'), 'utf8').trim())
    expect(v.user).toBe('(no prompt)')
    expect(v.agent).toBe('')
    expect(v.dur_ms).toBe(0)

    const warns = calls.filter(c => c.level === 'warn')
    expect(warns.length).toBe(1)
    expect(warns[0]!.msg).toContain('Stop without buffered prompt')
  })

  test('Stop with unreadable transcript path uses empty agent text + (inline) snippet (no throw)', async () => {
    const c = fakeClock()
    const { log } = makeLog()
    const w = new MemoryWriter(cfg(), log, c.now)

    await w.onHook(payload('UserPromptSubmit', { prompt: 'q' }))
    await w.onHook(payload('Stop', { transcript_path: '/path/that/does/not/exist.jsonl' }))

    const hot = readFileSync(join(workspacePath, 'core', 'hot', 'recent.md'), 'utf8')
    expect(hot).toContain('**Silvana:** (inline)\n')
    const v = JSON.parse(readFileSync(join(logsPath, 'verbose-2026-05-15.jsonl'), 'utf8').trim())
    expect(v.agent).toBe('')
  })

  test('PreToolUse / PostToolUse / SessionStart hooks are no-ops', async () => {
    const c = fakeClock()
    const { log } = makeLog()
    const w = new MemoryWriter(cfg(), log, c.now)

    await w.onHook(payload('PreToolUse', { tool_name: 'Read', tool_use_id: 'u1', tool_input: {} }))
    await w.onHook(payload('PostToolUse', { tool_name: 'Read', tool_use_id: 'u1', tool_input: {} }))
    await w.onHook(payload('SessionStart'))

    let hotExists = true
    try { readFileSync(join(workspacePath, 'core', 'hot', 'recent.md'), 'utf8') } catch { hotExists = false }
    expect(hotExists).toBe(false)
    let logsExist = true
    try { readdirSync(logsPath) } catch { logsExist = false }
    expect(logsExist).toBe(false)
  })

  test('long prompt is truncated in recent.md but full-length in verbose.jsonl', async () => {
    const c = fakeClock()
    const { log } = makeLog()
    const w = new MemoryWriter(cfg(), log, c.now)

    const longPrompt = 'P'.repeat(500)
    const transcript = writeTranscript(baseDir, JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'A'.repeat(500) }] },
    }) + '\n')

    await w.onHook(payload('UserPromptSubmit', { prompt: longPrompt }))
    await w.onHook(payload('Stop', { transcript_path: transcript }))

    const hot = readFileSync(join(workspacePath, 'core', 'hot', 'recent.md'), 'utf8')
    // snippet() slices to 200 chars
    expect(hot).toContain('**User:** ' + 'P'.repeat(200) + '\n')
    expect(hot).toContain('**Silvana:** ' + 'A'.repeat(200) + '\n')

    const v = JSON.parse(readFileSync(join(logsPath, 'verbose-2026-05-15.jsonl'), 'utf8').trim())
    expect(v.user.length).toBe(500)
    expect(v.agent.length).toBe(500)
  })
})
