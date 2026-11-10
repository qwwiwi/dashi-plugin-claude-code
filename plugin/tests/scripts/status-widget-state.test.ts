// Example state producer for the model-free status card
// (scripts/status-widget-state.mjs): mapping, ordering, the 1024-byte budget.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { redactSecrets } from '../../src/safety/redact.js'
import { buildCardState, mapJobs } from '../../scripts/status-widget-state.mjs'

const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'status-widget-state.mjs')
const NOW = Date.parse('2026-11-09T12:00:00Z')
const iso = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString()
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

interface Job {
  id: string
  title: string
  kind?: string
  status: string
  model?: string
  turns?: number
  max_turns?: number
  timeout_minutes?: number
  started_at?: string | null
  finished_at?: string | null
  created_at?: string
}

function job(over: Partial<Job> & { id: string; status: string }): Job {
  return { title: `job ${over.id}`, kind: 'general', model: 'opus', turns: 0, max_turns: 0, created_at: iso(120), ...over }
}

describe('mapJobs: status letters', () => {
  const cases: Array<[string, 'r' | 'q' | 'd' | 'f' | 'b']> = [
    ['running', 'r'],
    ['queued', 'q'],
    ['succeeded', 'd'],
    ['failed', 'f'],
    ['timeout', 'f'],
    ['stopped', 'b'],
    ['cancelled', 'b'],
  ]
  for (const [status, letter] of cases) {
    test(`${status} -> ${letter}`, () => {
      const rows = mapJobs([job({ id: 'a', status, started_at: iso(5), finished_at: status === 'running' || status === 'queued' ? null : iso(2) })], NOW)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.state).toBe(letter)
    })
  }

  test('an unknown status is skipped (the card never invents a state)', () => {
    expect(mapJobs([job({ id: 'a', status: 'weird' })], NOW)).toEqual([])
  })

  test('null, numbers and rows without an id/title do not throw', () => {
    expect(() => mapJobs([null, 5, 'x', {}, { status: 'running' }] as unknown[], NOW)).not.toThrow()
  })
})

describe('mapJobs: ordering and selection', () => {
  test('running first, then queued, then the most recently finished', () => {
    const rows = mapJobs(
      [
        job({ id: 'done-old', status: 'succeeded', started_at: iso(25), finished_at: iso(20) }),
        job({ id: 'q1', status: 'queued', created_at: iso(30) }),
        job({ id: 'run1', status: 'running', started_at: iso(10), turns: 5, max_turns: 50 }),
        job({ id: 'done-new', status: 'failed', started_at: iso(9), finished_at: iso(3) }),
        job({ id: 'q2', status: 'queued', created_at: iso(10) }),
      ],
      NOW,
    )
    expect(rows.map((r) => r.id)).toEqual(['run1', 'q1', 'q2', 'done-new', 'done-old'])
  })

  test('at most 5 rows: running and queued win over finished', () => {
    const jobs = [
      ...Array.from({ length: 3 }, (_, i) => job({ id: `r${i}`, status: 'running', started_at: iso(10 - i) })),
      ...Array.from({ length: 4 }, (_, i) => job({ id: `q${i}`, status: 'queued', created_at: iso(50 - i) })),
      job({ id: 'f1', status: 'succeeded', started_at: iso(8), finished_at: iso(1) }),
    ]
    const rows = mapJobs(jobs, NOW)
    expect(rows).toHaveLength(5)
    expect(rows.map((r) => r.id)).toEqual(['r0', 'r1', 'r2', 'q0', 'q1'])
  })

  test('finished jobs older than 30 minutes are skipped, exactly 30 is kept', () => {
    const rows = mapJobs(
      [
        job({ id: 'old', status: 'succeeded', started_at: iso(60), finished_at: iso(31) }),
        job({ id: 'edge', status: 'succeeded', started_at: iso(60), finished_at: iso(30) }),
        job({ id: 'nodate', status: 'failed' }),
      ],
      NOW,
    )
    expect(rows.map((r) => r.id)).toEqual(['edge'])
  })
})

describe('mapJobs: percent and details', () => {
  test('running: turns / max_turns, capped at 95', () => {
    const [a] = mapJobs([job({ id: 'a', status: 'running', started_at: iso(5), turns: 20, max_turns: 80 })], NOW)
    expect(a!.pct).toBe(25)
    const [b] = mapJobs([job({ id: 'b', status: 'running', started_at: iso(5), turns: 200, max_turns: 80 })], NOW)
    expect(b!.pct).toBe(95)
  })

  test('running without max_turns: elapsed share of timeout_minutes, capped at 95', () => {
    const [a] = mapJobs([job({ id: 'a', status: 'running', started_at: iso(15), timeout_minutes: 60 })], NOW)
    expect(a!.pct).toBe(25)
    const [b] = mapJobs([job({ id: 'b', status: 'running', started_at: iso(500), timeout_minutes: 60 })], NOW)
    expect(b!.pct).toBe(95)
    const [c] = mapJobs([job({ id: 'c', status: 'running', started_at: iso(5) })], NOW)
    expect(c!.pct).toBe(0)
  })

  test('queued is 0, succeeded is 100', () => {
    const rows = mapJobs(
      [job({ id: 'q', status: 'queued' }), job({ id: 'd', status: 'succeeded', started_at: iso(9), finished_at: iso(2) })],
      NOW,
    )
    expect(rows.find((r) => r.id === 'q')!.pct).toBe(0)
    expect(rows.find((r) => r.id === 'd')!.pct).toBe(100)
  })

  test('details carry the model and minutes running', () => {
    const [a] = mapJobs([job({ id: 'a', status: 'running', started_at: iso(12), model: 'sonnet' })], NOW)
    expect(a!.model).toBe('sonnet')
    expect(a!.minutes).toBe(12)
  })

  test('a bad max_turns / turns never yields NaN or a percent outside 0..100', () => {
    const rows = mapJobs(
      [job({ id: 'a', status: 'running', started_at: iso(5), turns: Number.NaN, max_turns: -4 }), job({ id: 'b', status: 'running', started_at: 'garbage', turns: 'x' as unknown as number, max_turns: 10 })],
      NOW,
    )
    for (const r of rows) expect(Number.isInteger(r.pct) && r.pct >= 0 && r.pct <= 100).toBe(true)
  })
})

describe('buildCardState', () => {
  const milestones = {
    works: [
      { title: 'Первая', active: true, phases: [{ label: 'Фаза А', pct: 90 }, { label: 'Фаза Б', pct: 10 }] },
      { title: 'Закрытая', active: false, phases: [{ label: 'Не видно', pct: 100 }] },
      { title: 'Вторая', active: true, phases: [{ label: 'Фаза В', pct: 40 }] },
    ],
  }

  test('only active works, in file order, shaped for the template', () => {
    const { state } = buildCardState({ milestones, jobs: [], footer: '', nowMs: NOW })
    expect(state.m).toEqual([
      ['Первая', [['Фаза А', 90], ['Фаза Б', 10]]],
      ['Вторая', [['Фаза В', 40]]],
    ])
    expect(state.j).toBeUndefined()
    expect(state.l).toBeUndefined()
  })

  test('jobs and footer land in the card', () => {
    const { state } = buildCardState({
      milestones: { works: [] },
      jobs: [job({ id: 'a', title: 'Сборка', status: 'running', started_at: iso(7), turns: 10, max_turns: 20, model: 'opus' })],
      footer: 'лимит 40%',
      nowMs: NOW,
    })
    expect(state.j).toEqual([['Сборка', 50, 'r', { m: 'opus', t: 7 }]])
    expect(state.l).toBe('лимит 40%')
  })

  test('a normal card is one compact JSON under 1024 bytes', () => {
    const { json } = buildCardState({ milestones, jobs: [], footer: '', nowMs: NOW })
    expect(bytes(json)).toBeLessThanOrEqual(1024)
    expect(JSON.parse(json)).toBeTruthy()
  })
})

describe('buildCardState: the 1024-byte budget', () => {
  const longRu = 'Очень длинное название задачи про миграцию базы данных пользователей'
  const manyWorks = Array.from({ length: 3 }, (_, w) => ({
    title: `${longRu} ${w}`,
    active: true,
    phases: Array.from({ length: 8 }, (_, p) => ({ label: `${longRu} этап ${p}`, pct: (p * 13) % 101 })),
  }))
  const manyJobs = [
    ...Array.from({ length: 3 }, (_, i) => job({ id: `r${i}`, title: `${longRu} ${i}`, status: 'running', started_at: iso(40 + i), turns: 12, max_turns: 80, model: 'claude-opus-5-5' })),
    job({ id: 'q', title: longRu, status: 'queued', model: 'gpt-6.1-sol' }),
    job({ id: 'd', title: longRu, status: 'succeeded', started_at: iso(20), finished_at: iso(5), model: 'sonnet' }),
  ]

  test('long Cyrillic titles: still within 1024 bytes and valid JSON', () => {
    const { json } = buildCardState({ milestones: { works: manyWorks }, jobs: manyJobs, footer: 'Лимиты: Claude 12% / Codex 7% · неделя', nowMs: NOW })
    expect(bytes(json)).toBeLessThanOrEqual(1024)
    const parsed = JSON.parse(json) as { m?: unknown[]; j?: unknown[] }
    expect(parsed.m?.length ?? 0).toBeGreaterThan(0)
  })

  test('details are dropped FIRST: titles stay whole while dropping details is enough', () => {
    const title = 'Миграция базы клиентов'
    const jobs = Array.from({ length: 5 }, (_, i) =>
      job({ id: `r${i}`, title: `${title} ${i}`, status: 'running', started_at: iso(30), turns: 5, max_turns: 50, model: 'claude-opus-5-5-long-model-name' }),
    )
    const works = (rows: number) =>
      Array.from({ length: 3 }, (_, w) => ({
        title: `Работа ${w}`,
        active: true,
        phases: Array.from({ length: rows }, (_, p) => ({ label: `Этап номер ${p}`, pct: 50 })),
      }))
    // 4 rows per work: everything fits WITH details.
    const small = buildCardState({ milestones: { works: works(4) }, jobs, footer: '', nowMs: NOW })
    expect(JSON.stringify(small.state.j)).toContain('claude-opus')
    // 6 rows per work: it does not, so the details go first and titles stay whole.
    const { state, json } = buildCardState({ milestones: { works: works(6) }, jobs, footer: '', nowMs: NOW })
    expect(bytes(json)).toBeLessThanOrEqual(1024)
    const names = (state.j as unknown[][]).map((r) => r[0])
    expect(names).toEqual(jobs.map((_, i) => `${title} ${i}`))
    for (const row of state.j as unknown[][]) expect(row[3]).toBeUndefined()
  })

  test('titles are shortened (with an ellipsis) before any job is dropped', () => {
    const jobs = Array.from({ length: 5 }, (_, i) =>
      job({ id: `r${i}`, title: `${longRu} ${longRu} ${i}`, status: 'running', started_at: iso(3), turns: 1, max_turns: 10 }),
    )
    const { state, json } = buildCardState({ milestones: { works: manyWorks }, jobs, footer: '', nowMs: NOW })
    expect(bytes(json)).toBeLessThanOrEqual(1024)
    const names = (state.j as unknown[][] | undefined)?.map((r) => String(r[0])) ?? []
    expect(names.length).toBe(5)
    expect(names.some((n) => n.endsWith('…'))).toBe(true)
  })

  test('the oldest finished jobs are dropped before running ones', () => {
    const jobs = [
      job({ id: 'run', title: 'Работа', status: 'running', started_at: iso(3), turns: 1, max_turns: 10 }),
      ...Array.from({ length: 4 }, (_, i) =>
        job({ id: `f${i}`, title: `${longRu} ${longRu}`, status: 'succeeded', started_at: iso(25), finished_at: iso(i + 1) }),
      ),
    ]
    const heavy = Array.from({ length: 3 }, (_, w) => ({
      title: `Работа ${w}`,
      active: true,
      phases: Array.from({ length: 8 }, (_, p) => ({ label: `Этап номер ${p}`, pct: 50 })),
    }))
    const { state, json } = buildCardState({ milestones: { works: heavy }, jobs, footer: '', nowMs: NOW })
    expect(bytes(json)).toBeLessThanOrEqual(1024)
    const ids = (state.j as unknown[][] | undefined)?.map((r) => String(r[0])) ?? []
    expect(ids[0]).toBe('Работа')
  })

  test('an absurd input (50 works x 30 phases, 200 jobs) still fits', () => {
    const works = Array.from({ length: 50 }, (_, w) => ({
      title: `${longRu} ${w}`,
      active: true,
      phases: Array.from({ length: 30 }, (_, p) => ({ label: `${longRu} ${p}`, pct: p })),
    }))
    const jobs = Array.from({ length: 200 }, (_, i) => job({ id: `r${i}`, title: longRu, status: 'running', started_at: iso(3), turns: 1, max_turns: 10 }))
    const { json } = buildCardState({ milestones: { works }, jobs, footer: 'ф'.repeat(500), nowMs: NOW })
    expect(bytes(json)).toBeLessThanOrEqual(1024)
    expect(() => JSON.parse(json)).not.toThrow()
  })

  test('phases beyond the template capacity (3 groups x 8 rows) are dropped under pressure', () => {
    const works = Array.from({ length: 5 }, (_, w) => ({
      title: `Работа ${w}`,
      active: true,
      phases: Array.from({ length: 12 }, (_, p) => ({ label: `Этап ${p}`, pct: 50 })),
    }))
    const { state, json } = buildCardState({ milestones: { works }, jobs: [], footer: '', nowMs: NOW })
    expect(bytes(json)).toBeLessThanOrEqual(1024)
    const m = state.m as unknown[][]
    expect(m.length).toBeLessThanOrEqual(3)
    for (const g of m) expect((g[1] as unknown[]).length).toBeLessThanOrEqual(8)
  })

  test('a long ASCII identifier never trips the plugin redactor (24+ run is cut)', () => {
    const { json } = buildCardState({
      milestones: { works: [{ title: 'a'.repeat(40), active: true, phases: [{ label: 'phase_' + 'b'.repeat(30), pct: 1 }] }] },
      jobs: [],
      footer: '',
      nowMs: NOW,
    })
    expect(redactSecrets(json)).toBe(json)
  })
})

describe('CLI', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'status-state-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function run(args: string[]): { code: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 20_000 })
    return { code: r.status, stdout: r.stdout, stderr: r.stderr }
  }

  const MS = { works: [{ title: 'Работа', active: true, phases: [{ label: 'Этап', pct: 50 }] }] }

  test('milestones only: prints the card JSON and exits 0', () => {
    const file = join(dir, 'm.json')
    writeFileSync(file, JSON.stringify(MS))
    const r = run(['--milestones', file, '--now', '2026-11-09T12:00:00Z'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ m: [['Работа', [['Этап', 50]]]] })
  })

  test('jobs command (an argv array, no shell) and footer are used', () => {
    const file = join(dir, 'm.json')
    writeFileSync(file, JSON.stringify(MS))
    const payload = JSON.stringify({ jobs: [{ id: 'x1', title: 'Задача', status: 'queued', created_at: '2026-11-09T11:00:00Z' }] })
    const r = run([
      '--milestones', file,
      '--jobs-cmd', JSON.stringify([process.execPath, '-e', `process.stdout.write(process.argv[1])`, payload]),
      '--footer', 'подвал',
      '--now', '2026-11-09T12:00:00Z',
    ])
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout) as { j: unknown[][]; l: string }
    expect(out.j).toEqual([['Задача', 0, 'q']])
    expect(out.l).toBe('подвал')
  })

  test('the 1024-byte limit applies to the JSON itself: stdout carries exactly the JSON, no extra byte', () => {
    // Find (bounded search) a card whose JSON is EXACTLY 1024 bytes: many short
    // phase rows plus an ASCII footer of 1..20 letters tune the size to the byte.
    const phases = (n: number): Array<{ label: string; pct: number }> =>
      Array.from({ length: n }, (_, i) => ({ label: `w${String(i).padStart(3, '0')}`, pct: 50 }))
    const card = (n: number, footer: string): { works: unknown[]; json: string } => {
      const works = [{ title: 'Работа', active: true, phases: phases(n) }]
      return { works, json: buildCardState({ milestones: { works }, jobs: [], footer, nowMs: NOW }).json }
    }
    let hit: { n: number; footer: string; works: unknown[] } | undefined
    for (let n = 1; n <= 200 && hit === undefined; n++) {
      if (bytes(card(n, '').json) > 1024) break
      for (let f = 1; f <= 20; f++) {
        const footer = 'x'.repeat(f)
        const c = card(n, footer)
        if (bytes(c.json) === 1024) {
          hit = { n, footer, works: c.works }
          break
        }
      }
    }
    expect(hit).toBeDefined()
    const file = join(dir, 'm.json')
    writeFileSync(file, JSON.stringify({ works: hit!.works }))
    const r = run(['--milestones', file, '--footer', hit!.footer, '--now', '2026-11-09T12:00:00Z'])
    expect(r.code).toBe(0)
    expect(bytes(r.stdout)).toBe(1024)
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(card(hit!.n, hit!.footer).json))
  })

  test('an unreadable milestones file: non-zero exit, a message on stderr, nothing on stdout', () => {
    const r = run(['--milestones', join(dir, 'missing.json')])
    expect(r.code).not.toBe(0)
    expect(r.stderr.length).toBeGreaterThan(0)
    expect(r.stdout).toBe('')
  })

  test('invalid JSON in milestones: non-zero exit', () => {
    const file = join(dir, 'bad.json')
    writeFileSync(file, '{not json')
    const r = run(['--milestones', file])
    expect(r.code).not.toBe(0)
    expect(r.stdout).toBe('')
  })

  test('no --milestones: non-zero exit with a usage message', () => {
    const r = run([])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('--milestones')
  })

  test('a failing or non-JSON jobs command: non-zero exit (the old card stays)', () => {
    const file = join(dir, 'm.json')
    writeFileSync(file, JSON.stringify(MS))
    const failing = run(['--milestones', file, '--jobs-cmd', JSON.stringify([process.execPath, '-e', 'process.exit(2)'])])
    expect(failing.code).not.toBe(0)
    const garbage = run(['--milestones', file, '--jobs-cmd', JSON.stringify([process.execPath, '-e', 'console.log("nope")'])])
    expect(garbage.code).not.toBe(0)
    const notArray = run(['--milestones', file, '--jobs-cmd', 'echo hi'])
    expect(notArray.code).not.toBe(0)
  })
})
