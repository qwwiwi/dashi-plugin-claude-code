#!/usr/bin/env node
// Example state producer for the model-free status card (templates/status.html).
//
// The plugin's status_widget service runs a command and reads the card state
// JSON from its stdout. This script is one such command: plain Node/Bun, no
// dependencies. It prints ONE compact JSON object, guaranteed <= 1024 bytes
// UTF-8 (the Bot API chat_data limit).
//
// Usage:
//   status-widget-state.mjs --milestones <file> [--jobs-cmd '<json argv array>']
//                           [--footer <text>] [--now <ISO time, for tests>]
//
// Milestones file: {"works":[{"title":"...","active":true,
//                             "phases":[{"label":"...","pct":90}]}]}
// Only works with active:true go to the card, in file order.
//
// Jobs command (an argv array, run WITHOUT a shell) prints
//   {"jobs":[{id,title,kind,status,model,turns,max_turns,started_at,
//             finished_at,created_at,timeout_minutes?, ...}]}
// (the output of a job runner's `list --json`).
//
// Exit code: 0 and the card on stdout; non-zero with a message on stderr when
// an input is unreadable (the plugin then keeps the previous card).

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const MAX_STATE_BYTES = 1024
// Template capacity (templates/status.html): groups, rows per group, jobs.
export const CAPACITY = { groups: 3, rows: 8, jobs: 5 }
const FINISHED_MAX_AGE_MS = 30 * 60_000
const PCT_CAP_ACTIVE = 95
const FIRST_TITLE_MAX = 28
const TITLE_STEPS = [24, 20, 16, 12, 10, 8]

const STATE_LETTER = {
  running: 'r',
  queued: 'q',
  succeeded: 'd',
  failed: 'f',
  timeout: 'f',
  stopped: 'b',
  cancelled: 'b',
}

const bytes = (text) => Buffer.byteLength(text, 'utf8')
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const clampPct = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0)
const parseTime = (v) => {
  if (typeof v !== 'string') return undefined
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : t
}

// ---------------------------------------------------------------- text

// The plugin refuses (fail closed) any state its redactor would change, and the
// redactor flags an unbroken run of 24+ ASCII letters/digits/underscores. Cut
// such runs here so a long identifier never blanks the whole card refresh.
function plain(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[A-Za-z0-9_]{24,}/g, (run) => `${run.slice(0, 20)}…`)
}

// Shorten to at most `max` characters (code points), ending with an ellipsis.
function short(text, max) {
  const chars = [...plain(text)]
  if (chars.length <= max) return chars.join('')
  return `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`
}

// ---------------------------------------------------------------- jobs

// Progress reached so far, 0..95 (never claims "done" for a job that is not).
function progress(job, endMs) {
  const maxTurns = Number(job.max_turns)
  const turns = Number(job.turns)
  if (Number.isFinite(maxTurns) && maxTurns > 0 && Number.isFinite(turns)) {
    return Math.min(PCT_CAP_ACTIVE, clampPct((turns / maxTurns) * 100))
  }
  const timeoutMinutes = Number(job.timeout_minutes)
  const started = parseTime(job.started_at)
  if (Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 && started !== undefined) {
    return Math.min(PCT_CAP_ACTIVE, clampPct(((endMs - started) / 60_000 / timeoutMinutes) * 100))
  }
  return 0
}

const byTimeAsc = (a, b) => (a.sortKey ?? Infinity) - (b.sortKey ?? Infinity)

// Map a job runner's list to card rows, in display order: running (oldest
// first), queued (FIFO), then the most recently finished; 5 at most; finished
// jobs older than 30 minutes (or without a finish time) are skipped.
export function mapJobs(jobs, nowMs) {
  const running = []
  const queued = []
  const finished = []
  for (const raw of Array.isArray(jobs) ? jobs : []) {
    if (!isRecord(raw)) continue
    const state = STATE_LETTER[String(raw.status)]
    if (state === undefined) continue
    const title = plain(raw.title) || plain(raw.id) || 'без названия'
    const started = parseTime(raw.started_at)
    const model = plain(raw.model)
    const row = { id: String(raw.id ?? ''), title, state, pct: 0, model: model || undefined, minutes: undefined }
    if (state === 'r') {
      row.pct = progress(raw, nowMs)
      if (started !== undefined) row.minutes = Math.max(0, Math.floor((nowMs - started) / 60_000))
      row.sortKey = started
      running.push(row)
    } else if (state === 'q') {
      row.sortKey = parseTime(raw.created_at)
      queued.push(row)
    } else {
      const end = parseTime(raw.finished_at)
      if (end === undefined || nowMs - end > FINISHED_MAX_AGE_MS) continue
      row.pct = state === 'd' ? 100 : progress(raw, end)
      if (started !== undefined) row.minutes = Math.max(0, Math.floor((end - started) / 60_000))
      row.sortKey = end
      finished.push(row)
    }
  }
  running.sort(byTimeAsc)
  queued.sort(byTimeAsc)
  finished.sort((a, b) => (b.sortKey ?? 0) - (a.sortKey ?? 0))
  return [...running, ...queued, ...finished].slice(0, CAPACITY.jobs).map(({ sortKey: _sortKey, ...row }) => row)
}

// ---------------------------------------------------------------- card

function activeWorks(milestones) {
  const works = isRecord(milestones) && Array.isArray(milestones.works) ? milestones.works : []
  return works
    .filter((w) => isRecord(w) && w.active === true)
    .map((w) => ({
      title: plain(w.title) || 'Этапы',
      phases: (Array.isArray(w.phases) ? w.phases : [])
        .filter(isRecord)
        .map((p) => ({ label: plain(p.label) || 'Без названия', pct: clampPct(Number(p.pct)) })),
    }))
}

function render(cfg, works, rows, footer) {
  const state = {}
  const groups = (cfg.capacity ? works.slice(0, CAPACITY.groups) : works).map((w) => [
    short(w.title, cfg.titleMax),
    (cfg.capacity ? w.phases.slice(0, CAPACITY.rows) : w.phases).map((p) => [short(p.label, cfg.titleMax), p.pct]),
  ])
  if (groups.length > 0) state.m = groups
  const shown = rows.slice(0, cfg.jobs)
  if (shown.length > 0) {
    state.j = shown.map((r) => {
      const row = [short(r.title, cfg.titleMax), r.pct, r.state]
      if (cfg.details) {
        const d = {}
        if (r.model) d.m = short(r.model, 24)
        if (r.minutes !== undefined) d.t = r.minutes
        if (Object.keys(d).length > 0) row.push(d)
      }
      return row
    })
  }
  const foot = short(footer, cfg.titleMax >= FIRST_TITLE_MAX ? 60 : cfg.titleMax * 2)
  if (cfg.footer && foot) state.l = foot
  return state
}

const fits = (state) => bytes(JSON.stringify(state)) <= MAX_STATE_BYTES

// Build the card state. Byte-budget order when the card is too big:
//   1. drop job details  2. shorten titles/labels  3. drop the oldest finished
//   jobs  4. drop phases/groups beyond the template capacity  5. (last resort)
//   trim trailing phases, groups, the footer and jobs until it fits.
export function buildCardState({ milestones, jobs, footer, nowMs }) {
  const works = activeWorks(milestones)
  const rows = mapJobs(jobs, nowMs)
  const nonFinished = rows.filter((r) => r.state === 'r' || r.state === 'q').length
  const foot = footer ?? ''

  const candidates = [{ details: true, titleMax: FIRST_TITLE_MAX, jobs: rows.length, capacity: false, footer: true }]
  candidates.push({ ...candidates[0], details: false })
  for (const titleMax of TITLE_STEPS) candidates.push({ ...candidates[0], details: false, titleMax })
  const lastTitle = TITLE_STEPS[TITLE_STEPS.length - 1]
  for (let n = rows.length - 1; n >= nonFinished; n--) {
    candidates.push({ details: false, titleMax: lastTitle, jobs: n, capacity: false, footer: true })
  }
  const capped = { details: false, titleMax: lastTitle, jobs: nonFinished, capacity: true, footer: true }
  candidates.push(capped)

  for (const cfg of candidates) {
    const state = render(cfg, works, rows, foot)
    if (fits(state)) return { state, json: JSON.stringify(state) }
  }

  // Last resort: trim from the tail until the card fits.
  const trimmed = works.slice(0, CAPACITY.groups).map((w) => ({ ...w, phases: w.phases.slice(0, CAPACITY.rows) }))
  let jobCount = nonFinished
  let withFooter = true
  for (;;) {
    const state = render({ ...capped, jobs: jobCount, footer: withFooter }, trimmed, rows, foot)
    if (fits(state)) return { state, json: JSON.stringify(state) }
    const last = trimmed[trimmed.length - 1]
    if (last !== undefined) {
      if (last.phases.length > 0) last.phases.pop()
      else trimmed.pop()
    } else if (withFooter) {
      withFooter = false
    } else if (jobCount > 0) {
      jobCount -= 1
    } else {
      return { state: {}, json: '{}' }
    }
  }
}

// ---------------------------------------------------------------- CLI

class InputError extends Error {}

function parseArgs(argv) {
  const out = {}
  const known = new Set(['--milestones', '--jobs-cmd', '--footer', '--now'])
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (!known.has(flag)) throw new InputError(`unknown argument: ${flag}`)
    if (value === undefined) throw new InputError(`${flag} needs a value`)
    out[flag.slice(2)] = value
  }
  return out
}

function readJsonFile(path, label) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    throw new InputError(`cannot read ${label} file: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new InputError(`${label} file is not valid JSON`)
  }
}

function runJobsCommand(spec) {
  let argv
  try {
    argv = JSON.parse(spec)
  } catch {
    throw new InputError('--jobs-cmd must be a JSON array of strings, e.g. \'["runner","list","--json"]\'')
  }
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string' && a !== '')) {
    throw new InputError('--jobs-cmd must be a non-empty JSON array of strings')
  }
  const res = spawnSync(argv[0], argv.slice(1), { shell: false, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
  if (res.error || res.status !== 0) throw new InputError('the jobs command failed or timed out')
  let parsed
  try {
    parsed = JSON.parse(res.stdout)
  } catch {
    throw new InputError('the jobs command did not print JSON')
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.jobs)) throw new InputError('the jobs command output has no "jobs" array')
  return parsed.jobs
}

export function main(argv) {
  const args = parseArgs(argv)
  if (args.milestones === undefined) throw new InputError('usage: status-widget-state.mjs --milestones <file> [--jobs-cmd \'<json argv>\'] [--footer <text>]')
  const milestones = readJsonFile(args.milestones, 'milestones')
  if (!isRecord(milestones) || !Array.isArray(milestones.works)) throw new InputError('milestones file needs a "works" array')
  const jobs = args['jobs-cmd'] !== undefined ? runJobsCommand(args['jobs-cmd']) : []
  const nowMs = args.now !== undefined ? Date.parse(args.now) : Date.now()
  if (Number.isNaN(nowMs)) throw new InputError('--now is not a valid time')
  return buildCardState({ milestones, jobs, footer: args.footer ?? '', nowMs }).json
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${main(process.argv.slice(2))}\n`)
  } catch (err) {
    process.stderr.write(`status-widget-state: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(err instanceof InputError ? 2 : 1)
  }
}
