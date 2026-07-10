// src/autonomy/store.ts
//
// Per-chat AUTONOMY state: the durable registry of owner-granted autonomy
// mandates (leases) and open questions to the owner.
//
// Why this exists (2026-07-10 communication audit): owner-granted autonomy
// mandates get forgotten after context compaction, and questions to the owner
// die silently. This module is the durable state layer that survives a
// compact/restart; PR-1 wires it into three read surfaces (an `autonomy` MCP
// tool, the per-turn channel-reminder injection, and the pinned context HUD).
// Enforcement hooks and lease-GRANTING arrive in later PRs — this module never
// grants a lease on its own; leases are added only through the store API.
//
// Persistence: one JSON file per chat, `autonomy-<chatId>.json`, in the same
// state root the other per-chat persisters use (StatePaths.root — see
// context-hud.ts `context-hud-<chatId>.json` and task-reality-mirror.ts
// `task-reality-epoch-<chatId>.json`). Atomic tmp+fsync+rename, 0o600, exactly
// like state/store.ts writeUpdateOffset. A corrupt/missing file loads as empty
// state and NEVER throws — a broken registry must never break message delivery.

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

import type { StatePaths } from '../config.js'
import type { Logger } from '../log.js'

// ─────────────────────────────────────────────────────────────────────
// Types.
// ─────────────────────────────────────────────────────────────────────

export const AUTONOMY_STATE_VERSION = 1 as const

// Where a lease came from. `ask_card` = an authenticated AskUserQuestion
// button grant (PR-2). `owner_cmd` = an owner command. `manual` = operator /
// test insertion. The tool surface can NEVER mint any of these.
export type LeaseSource = 'ask_card' | 'owner_cmd' | 'manual'

export interface AutonomyLease {
  // e.g. `L-20260710-a1b2`. Stable across the lease's lifetime.
  id: string
  // Verbatim owner-granted scope text (never paraphrased).
  scope: string
  grantedAtMs: number
  expiresAtMs: number
  source: LeaseSource
  // The Telegram message id of the grant, when known (PR-2 button relay).
  grantorMessageId?: number
  // Set to a timestamp when the lease is consumed; null/undefined while active.
  consumedAtMs?: number | null
  notes?: string
}

export type QuestionStatus = 'open' | 'answered' | 'bypassed'

export interface OpenQuestion {
  // e.g. `Q-20260710-a1b2`.
  id: string
  summary: string
  askedAtMs: number
  // Telegram message id the question was posted as, when known.
  messageId?: number
  status: QuestionStatus
  // What the agent should do if the owner never answers (the >2h default).
  defaultAction?: string
  // Security questions — NEVER auto-bypassed regardless of age.
  sticky?: boolean
  resolvedAtMs?: number
}

export interface AutonomyState {
  version: typeof AUTONOMY_STATE_VERSION
  leases: AutonomyLease[]
  questions: OpenQuestion[]
}

// The subset of StatePaths the store needs — just the state root. Full
// StatePaths is structurally assignable, and the reminder hook (which has no
// full StatePaths) can pass a bare `{ root }`.
export type AutonomyPaths = Pick<StatePaths, 'root'>

// ─────────────────────────────────────────────────────────────────────
// Pure state helpers (no I/O, no clock unless nowMs passed) — unit-tested
// in isolation.
// ─────────────────────────────────────────────────────────────────────

export function emptyAutonomyState(): AutonomyState {
  return { version: AUTONOMY_STATE_VERSION, leases: [], questions: [] }
}

// A lease is active when it has NOT been consumed and has NOT expired.
function isLeaseActive(lease: AutonomyLease, nowMs: number): boolean {
  const consumed = lease.consumedAtMs !== undefined && lease.consumedAtMs !== null
  return !consumed && lease.expiresAtMs > nowMs
}

/** Active leases (not consumed, not expired), soonest-expiry first. */
export function activeLeases(state: AutonomyState, nowMs: number): AutonomyLease[] {
  return state.leases
    .filter((l) => isLeaseActive(l, nowMs))
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs)
}

/** Open questions (status === 'open'), oldest-first. */
export function openQuestions(state: AutonomyState): OpenQuestion[] {
  return state.questions
    .filter((q) => q.status === 'open')
    .sort((a, b) => a.askedAtMs - b.askedAtMs)
}

/** Age of a question in ms (clamped ≥ 0 so a future askedAtMs never underflows). */
export function questionAgeMs(question: OpenQuestion, nowMs: number): number {
  return Math.max(0, nowMs - question.askedAtMs)
}

// Short random suffix for generated ids. Filename-safe (base36).
function randSuffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0')
}

// `YYYYMMDD` from an epoch-ms clock (UTC — stable across the fleet).
function yyyymmdd(nowMs: number): string {
  const d = new Date(nowMs)
  const y = d.getUTCFullYear().toString().padStart(4, '0')
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  const day = d.getUTCDate().toString().padStart(2, '0')
  return `${y}${m}${day}`
}

export function newLeaseId(nowMs: number): string {
  return `L-${yyyymmdd(nowMs)}-${randSuffix()}`
}

export function newQuestionId(nowMs: number): string {
  return `Q-${yyyymmdd(nowMs)}-${randSuffix()}`
}

export interface NewLeaseInput {
  scope: string
  expiresAtMs: number
  source: LeaseSource
  id?: string
  grantedAtMs?: number
  grantorMessageId?: number
  notes?: string
}

/**
 * Add a lease and return the NEW state plus the created lease. Pure: the input
 * `state` is not mutated (a fresh `leases` array is returned). Granting still
 * only happens through this API — the MCP tool never reaches it.
 */
export function addLease(
  state: AutonomyState,
  input: NewLeaseInput,
  nowMs: number = Date.now(),
): { state: AutonomyState; lease: AutonomyLease } {
  const lease: AutonomyLease = {
    id: input.id ?? newLeaseId(nowMs),
    scope: input.scope,
    grantedAtMs: input.grantedAtMs ?? nowMs,
    expiresAtMs: input.expiresAtMs,
    source: input.source,
    consumedAtMs: null,
    ...(input.grantorMessageId !== undefined ? { grantorMessageId: input.grantorMessageId } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  }
  return { state: { ...state, leases: [...state.leases, lease] }, lease }
}

export type ConsumeOutcome = 'ok' | 'not_found' | 'already_consumed'

/**
 * Mark a lease consumed. Returns the new state and an outcome the caller turns
 * into user-facing text. `already_consumed` is reported for an id that exists
 * but is already consumed (an expired-but-unconsumed lease still consumes ok —
 * expiry is a render concern, not a consume concern).
 */
export function consumeLease(
  state: AutonomyState,
  id: string,
  nowMs: number = Date.now(),
): { state: AutonomyState; outcome: ConsumeOutcome } {
  const idx = state.leases.findIndex((l) => l.id === id)
  if (idx === -1) return { state, outcome: 'not_found' }
  const lease = state.leases[idx] as AutonomyLease
  if (lease.consumedAtMs !== undefined && lease.consumedAtMs !== null) {
    return { state, outcome: 'already_consumed' }
  }
  const leases = state.leases.slice()
  leases[idx] = { ...lease, consumedAtMs: nowMs }
  return { state: { ...state, leases }, outcome: 'ok' }
}

export interface NewQuestionInput {
  summary: string
  id?: string
  askedAtMs?: number
  messageId?: number
  defaultAction?: string
  sticky?: boolean
  status?: QuestionStatus
}

/** Add an open question and return the NEW state plus the created question. */
export function addQuestion(
  state: AutonomyState,
  input: NewQuestionInput,
  nowMs: number = Date.now(),
): { state: AutonomyState; question: OpenQuestion } {
  const question: OpenQuestion = {
    id: input.id ?? newQuestionId(nowMs),
    summary: input.summary,
    askedAtMs: input.askedAtMs ?? nowMs,
    status: input.status ?? 'open',
    ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
    ...(input.defaultAction !== undefined ? { defaultAction: input.defaultAction } : {}),
    ...(input.sticky !== undefined ? { sticky: input.sticky } : {}),
  }
  return { state: { ...state, questions: [...state.questions, question] }, question }
}

export type ResolveOutcome = 'ok' | 'not_found'

/**
 * Resolve a question to `answered` or `bypassed`, stamping resolvedAtMs.
 * `not_found` when the id is unknown. Re-resolving an already-resolved question
 * is allowed (idempotent-ish) — the status/timestamp are simply overwritten.
 */
export function resolveQuestion(
  state: AutonomyState,
  id: string,
  status: Exclude<QuestionStatus, 'open'>,
  nowMs: number = Date.now(),
): { state: AutonomyState; outcome: ResolveOutcome } {
  const idx = state.questions.findIndex((q) => q.id === id)
  if (idx === -1) return { state, outcome: 'not_found' }
  const q = state.questions[idx] as OpenQuestion
  const questions = state.questions.slice()
  questions[idx] = { ...q, status, resolvedAtMs: nowMs }
  return { state: { ...state, questions }, outcome: 'ok' }
}

// ─────────────────────────────────────────────────────────────────────
// Rendering helpers (pure) — shared by the MCP tool, the reminder hook and
// the context HUD so the three surfaces never drift.
// ─────────────────────────────────────────────────────────────────────

// Compact humanizer for a NON-NEGATIVE duration: "<45>м" under an hour,
// otherwise "<h>ч" (+ minutes when a partial hour remains and it fits). Used
// for both "time left" and "age".
export function humanizeDurationMs(ms: number): string {
  const clamped = Math.max(0, ms)
  const totalMin = Math.floor(clamped / 60_000)
  if (totalMin < 60) return `${totalMin}м`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m > 0 ? `${h}ч ${m}м` : `${h}ч`
}

// Truncate on code points (not UTF-16 units) so a surrogate pair is never
// sliced — mirrors context-hud.taskLine.
function truncate(s: string, maxChars: number): string {
  const cps = Array.from(s)
  if (cps.length <= maxChars) return s
  return `${cps.slice(0, Math.max(0, maxChars - 1)).join('')}…`
}

const SCOPE_MAX_CHARS = 100
const SUMMARY_MAX_CHARS = 100
// Cap how many entries each read surface lists so the injected/pinned text
// stays short even with a pile of leases/questions.
const RENDER_MAX_ENTRIES = 3

/**
 * Compact human-readable status for the `autonomy` tool's `status` action:
 * active leases (id, scope, time left) + open questions (id, summary, age,
 * default action, sticky flag). Plain text, no markup. Empty state → a clear
 * "nothing active" line.
 */
export function renderAutonomyStatus(state: AutonomyState, nowMs: number): string {
  const leases = activeLeases(state, nowMs)
  const questions = openQuestions(state)
  const lines: string[] = []

  if (leases.length === 0) {
    lines.push('Активных мандатов нет.')
  } else {
    lines.push(`Активные мандаты (${leases.length}):`)
    for (const l of leases) {
      const left = humanizeDurationMs(l.expiresAtMs - nowMs)
      lines.push(`  ${l.id}: «${truncate(l.scope, SCOPE_MAX_CHARS)}» — ещё ${left} (source: ${l.source})`)
    }
  }

  if (questions.length === 0) {
    lines.push('Открытых вопросов нет.')
  } else {
    lines.push(`Открытые вопросы (${questions.length}):`)
    for (const q of questions) {
      const age = humanizeDurationMs(questionAgeMs(q, nowMs))
      const def = q.defaultAction !== undefined ? `; дефолт: ${truncate(q.defaultAction, SUMMARY_MAX_CHARS)}` : ''
      const sticky = q.sticky === true ? ' [sticky]' : ''
      lines.push(`  ${q.id}: «${truncate(q.summary, SUMMARY_MAX_CHARS)}» — без ответа ${age}${def}${sticky}`)
    }
  }

  return lines.join('\n')
}

/**
 * The per-turn reminder block appended by channel-reminder.ts (plain text,
 * Russian). Returns undefined when there is nothing active — the caller then
 * emits only the bridge/TOV reminder. Lists at most RENDER_MAX_ENTRIES of each.
 */
export function buildAutonomyReminderBlock(
  state: AutonomyState,
  nowMs: number,
): string | undefined {
  const leases = activeLeases(state, nowMs).slice(0, RENDER_MAX_ENTRIES)
  const questions = openQuestions(state).slice(0, RENDER_MAX_ENTRIES)
  if (leases.length === 0 && questions.length === 0) return undefined

  const lines: string[] = []
  for (const l of leases) {
    const left = humanizeDurationMs(l.expiresAtMs - nowMs)
    lines.push(
      `Активный мандат ${l.id}: «${truncate(l.scope, SCOPE_MAX_CHARS)}» — истекает через ${left}. ` +
        'Act-with-veto: в границах scope не спрашивай разрешения, действуй и докладывай.',
    )
  }
  for (const q of questions) {
    const age = humanizeDurationMs(questionAgeMs(q, nowMs))
    const def = q.defaultAction !== undefined ? truncate(q.defaultAction, SUMMARY_MAX_CHARS) : '—'
    const stickyNote = q.sticky === true
      ? ' Это sticky-вопрос — НЕ обходить дефолтом, дождись ответа вождя.'
      : ' >2ч без ответа — бери дефолт и сообщи (sticky-вопросы не обходить).'
    lines.push(
      `Открытый вопрос вождю ${q.id}: «${truncate(q.summary, SUMMARY_MAX_CHARS)}» — без ответа ${age}; дефолт: ${def}.${stickyNote}`,
    )
  }
  return lines.join('\n')
}

/**
 * The single optional HUD line (context-hud.ts). Returns undefined when there
 * is nothing active. `escape` is injected by the HUD (its escapeHtml) so the
 * line is safe under HTML parse mode; defaults to identity for plain contexts.
 * Shape: `Мандат: L-… (<short scope>, ещё <h>) · Вопросы без ответа: N (старший <age>)`.
 */
export function buildAutonomyHudLine(
  state: AutonomyState,
  nowMs: number,
  opts: { escape?: (s: string) => string } = {},
): string | undefined {
  const escape = opts.escape ?? ((s: string) => s)
  const leases = activeLeases(state, nowMs)
  const questions = openQuestions(state)
  if (leases.length === 0 && questions.length === 0) return undefined

  const parts: string[] = []
  const primary = leases[0]
  if (primary !== undefined) {
    const left = humanizeDurationMs(primary.expiresAtMs - nowMs)
    const scope = escape(truncate(primary.scope, 32))
    const extra = leases.length > 1 ? ` +${leases.length - 1}` : ''
    parts.push(`Мандат: ${escape(primary.id)} (${scope}, ещё ${left})${extra}`)
  }
  if (questions.length > 0) {
    const oldest = questions[0] as OpenQuestion
    const age = humanizeDurationMs(questionAgeMs(oldest, nowMs))
    parts.push(`Вопросы без ответа: ${questions.length} (старший ${age})`)
  }
  return parts.join(' · ')
}

// ─────────────────────────────────────────────────────────────────────
// Persistence (I/O). Never throws on load; atomic write like state/store.ts.
// ─────────────────────────────────────────────────────────────────────

// Filename-safe per-chat path. chatId is a numeric string (possibly negative
// for supergroups); sanitize defensively so a surprising value can never
// escape the state dir — identical convention to context-hud.persistPath.
export function autonomyStatePath(paths: AutonomyPaths, chatId: string): string {
  const safe = chatId.replace(/[^0-9A-Za-z_-]/g, '_')
  return join(paths.root, `autonomy-${safe}.json`)
}

// Narrow an unknown parsed blob into a valid AutonomyState, dropping anything
// malformed. A partially-corrupt file yields the well-formed entries it can and
// empty state otherwise — never throws.
function coerceState(parsed: unknown): AutonomyState {
  const out = emptyAutonomyState()
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out
  const obj = parsed as Record<string, unknown>
  if (Array.isArray(obj.leases)) {
    for (const raw of obj.leases) {
      const lease = coerceLease(raw)
      if (lease !== undefined) out.leases.push(lease)
    }
  }
  if (Array.isArray(obj.questions)) {
    for (const raw of obj.questions) {
      const q = coerceQuestion(raw)
      if (q !== undefined) out.questions.push(q)
    }
  }
  return out
}

const LEASE_SOURCES: ReadonlySet<string> = new Set<LeaseSource>(['ask_card', 'owner_cmd', 'manual'])
const QUESTION_STATUSES: ReadonlySet<string> = new Set<QuestionStatus>(['open', 'answered', 'bypassed'])

function coerceLease(raw: unknown): AutonomyLease | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id.length === 0) return undefined
  if (typeof o.scope !== 'string') return undefined
  if (typeof o.grantedAtMs !== 'number' || !Number.isFinite(o.grantedAtMs)) return undefined
  if (typeof o.expiresAtMs !== 'number' || !Number.isFinite(o.expiresAtMs)) return undefined
  if (typeof o.source !== 'string' || !LEASE_SOURCES.has(o.source)) return undefined
  const lease: AutonomyLease = {
    id: o.id,
    scope: o.scope,
    grantedAtMs: o.grantedAtMs,
    expiresAtMs: o.expiresAtMs,
    source: o.source as LeaseSource,
  }
  if (typeof o.grantorMessageId === 'number' && Number.isFinite(o.grantorMessageId)) {
    lease.grantorMessageId = o.grantorMessageId
  }
  if (o.consumedAtMs === null) lease.consumedAtMs = null
  else if (typeof o.consumedAtMs === 'number' && Number.isFinite(o.consumedAtMs)) {
    lease.consumedAtMs = o.consumedAtMs
  }
  if (typeof o.notes === 'string') lease.notes = o.notes
  return lease
}

function coerceQuestion(raw: unknown): OpenQuestion | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id.length === 0) return undefined
  if (typeof o.summary !== 'string') return undefined
  if (typeof o.askedAtMs !== 'number' || !Number.isFinite(o.askedAtMs)) return undefined
  if (typeof o.status !== 'string' || !QUESTION_STATUSES.has(o.status)) return undefined
  const q: OpenQuestion = {
    id: o.id,
    summary: o.summary,
    askedAtMs: o.askedAtMs,
    status: o.status as QuestionStatus,
  }
  if (typeof o.messageId === 'number' && Number.isFinite(o.messageId)) q.messageId = o.messageId
  if (typeof o.defaultAction === 'string') q.defaultAction = o.defaultAction
  if (o.sticky === true) q.sticky = true
  if (typeof o.resolvedAtMs === 'number' && Number.isFinite(o.resolvedAtMs)) q.resolvedAtMs = o.resolvedAtMs
  return q
}

/**
 * Load the per-chat autonomy state. A missing file, unreadable file, or corrupt
 * JSON → empty state (never throws). An optional logger emits a single warning
 * on a genuine read/parse error (not on the expected missing-file case).
 */
export function loadAutonomyState(
  paths: AutonomyPaths,
  chatId: string,
  log?: Logger,
): AutonomyState {
  const file = autonomyStatePath(paths, chatId)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    // Missing file on first use is expected — empty state, no warning.
    return emptyAutonomyState()
  }
  try {
    return coerceState(JSON.parse(raw))
  } catch (err) {
    // File existed but held invalid JSON — worth a warning, but never fatal.
    if (log) {
      log.warn('autonomy state parse failed, using empty state', {
        chat_id: chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return emptyAutonomyState()
  }
}

/**
 * Persist the per-chat autonomy state atomically (tmp + fsync + rename, 0o600).
 * On rename failure the tmp file is removed so no partial-write stray remains —
 * same contract as state/store.ts writeUpdateOffset.
 */
export function saveAutonomyState(
  paths: AutonomyPaths,
  chatId: string,
  state: AutonomyState,
): void {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 })
  const target = autonomyStatePath(paths, chatId)
  const tmp = join(paths.root, `autonomy-${chatId.replace(/[^0-9A-Za-z_-]/g, '_')}.tmp.${process.pid}.${Date.now()}`)
  // Normalize on write: always stamp the current schema version.
  const body = JSON.stringify(
    { version: AUTONOMY_STATE_VERSION, leases: state.leases, questions: state.questions },
    null,
    2,
  )
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, body)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, target)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // best-effort cleanup
    }
    throw err
  }
}
