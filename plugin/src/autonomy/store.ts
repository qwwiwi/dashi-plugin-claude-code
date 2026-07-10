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
// Persistence: one JSON file per chat, `autonomy-<chatKey>.json`, in the same
// state root the other per-chat persisters use (StatePaths.root — see
// context-hud.ts `context-hud-<chatId>.json` and task-reality-mirror.ts
// `task-reality-epoch-<chatId>.json`). Atomic tmp('wx')+fchmod+fsync+rename
// (+ best-effort directory fsync), 0o600. A corrupt/missing file loads as
// empty state and NEVER throws — a broken registry must never break delivery.
//
// SINGLE-WRITER MODEL (fix-loop #1 + fix-loop-2 #1/#2, Sol architecture
// review): the MCP/webhook server process is the DESIGNED sole writer of
// these files; the hooks (channel-reminder, HUD render path) are strictly
// READ-ONLY consumers. Within the process, ALL mutations MUST go through
// `updateAutonomyState`, which serializes load→mutate→save per chat via an
// in-process promise chain. Two additional guarantees make a second-process
// writer SAFE to detect rather than silently corrupting:
//   * `revision` counter — every save increments it; updateAutonomyState
//     re-reads the on-disk revision before writing and, when it moved under
//     us, reloads + re-applies the mutator on the fresh state (logged as
//     `autonomy_state_revision_conflict`).
//   * writer heartbeat lock — `autonomy-writer.lock` (writerId + pid +
//     refreshedAtMs, refreshed lazily on write). A FRESH lock held by a
//     DIFFERENT writerId refuses the mutation with `writer_conflict`; a
//     stale or own lock is taken over / refreshed atomically. Freshness +
//     writerId is the criterion — pid is diagnostic only, PID-existence is
//     deliberately NOT used as a lock.

import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
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
  // e.g. `L-20260710-a1b2c3d4`. Stable across the lease's lifetime.
  id: string
  // Verbatim owner-granted scope text (never paraphrased).
  scope: string
  // Integrity anchor for the scope text (fix-loop-2 #3):
  // `sha256:<hex(sha256(utf8 scope))>`. Lets a later audit prove the scope
  // was not silently edited. Optional on read (pre-digest files).
  scopeDigest?: string
  // Version of the scope-digest scheme (1 = sha256 over raw utf8 bytes).
  scopeVersion?: number
  grantedAtMs: number
  expiresAtMs: number
  source: LeaseSource
  // The Telegram message id of the grant, when known (PR-2 button relay).
  grantorMessageId?: number
  // Set to a timestamp when the lease is consumed; null/undefined while active.
  consumedAtMs?: number | null
  // Revocation is a TERMINAL state distinct from consumption (fix-loop-2 #4):
  // consumed = the mandate was USED; revoked = authority was WITHDRAWN.
  revokedAtMs?: number
  revokedBy?: string
  revokeReason?: string
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
  // Monotonic save counter (fix-loop-2 #1): every successful save writes
  // `revision + 1`. updateAutonomyState compares the loaded revision against
  // the on-disk one right before writing to DETECT a cross-process writer.
  revision: number
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
  return { version: AUTONOMY_STATE_VERSION, revision: 0, leases: [], questions: [] }
}

// A lease is active when it has NOT been consumed, NOT been revoked and has
// NOT expired.
function isLeaseActive(lease: AutonomyLease, nowMs: number): boolean {
  const consumed = lease.consumedAtMs !== undefined && lease.consumedAtMs !== null
  const revoked = lease.revokedAtMs !== undefined
  return !consumed && !revoked && lease.expiresAtMs > nowMs
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

// Short crypto-random suffix for generated ids (8 hex chars, filename-safe).
// Crypto-sourced so regenerated-on-collision ids can't cycle through the same
// PRNG sequence (review 2026-07-10 fix-loop #4).
function randSuffix(): string {
  return randomBytes(4).toString('hex')
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

// Outcome of an add: `duplicate` is returned ONLY for an EXPLICIT id that
// already exists (the state is returned unchanged so a colliding grant can
// never create two consumable leases with one id). Auto-generated ids
// regenerate on collision instead — they never report duplicate.
export type AddOutcome = 'ok' | 'duplicate'

// Generate an id guaranteed unique within `existing`, regenerating on the
// (astronomically unlikely) crypto-random collision.
function uniqueId(gen: () => string, existing: ReadonlySet<string>): string {
  let id = gen()
  while (existing.has(id)) id = gen()
  return id
}

/**
 * Add a lease and return the NEW state plus the created lease. Pure: the input
 * `state` is not mutated (a fresh `leases` array is returned). Granting still
 * only happens through this API — the MCP tool never reaches it.
 *
 * ID uniqueness (fix-loop #4): an explicit `input.id` colliding with an
 * existing lease → `outcome: 'duplicate'`, state unchanged, no lease. An
 * omitted id is generated and regenerated until unique.
 */
export function addLease(
  state: AutonomyState,
  input: NewLeaseInput,
  nowMs: number = Date.now(),
): { state: AutonomyState; lease?: AutonomyLease; outcome: AddOutcome } {
  const existing = new Set(state.leases.map((l) => l.id))
  if (input.id !== undefined && existing.has(input.id)) {
    return { state, outcome: 'duplicate' }
  }
  const lease: AutonomyLease = {
    id: input.id ?? uniqueId(() => newLeaseId(nowMs), existing),
    scope: input.scope,
    scopeDigest: computeScopeDigest(input.scope),
    scopeVersion: SCOPE_DIGEST_VERSION,
    grantedAtMs: input.grantedAtMs ?? nowMs,
    expiresAtMs: input.expiresAtMs,
    source: input.source,
    consumedAtMs: null,
    ...(input.grantorMessageId !== undefined ? { grantorMessageId: input.grantorMessageId } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  }
  return { state: { ...state, leases: [...state.leases, lease] }, lease, outcome: 'ok' }
}

// Scope-digest scheme v1: sha256 over the RAW utf8 bytes of the verbatim
// scope text, hex-encoded, prefixed with the algorithm (fix-loop-2 #3).
export const SCOPE_DIGEST_VERSION = 1 as const

export function computeScopeDigest(scope: string): string {
  return `sha256:${createHash('sha256').update(scope, 'utf8').digest('hex')}`
}

export type ConsumeOutcome = 'ok' | 'not_found' | 'already_consumed' | 'revoked' | 'expired'

/**
 * Mark a lease consumed. Returns the new state and an outcome the caller turns
 * into user-facing text:
 *   `not_found`         — unknown id.
 *   `already_consumed`  — the id exists but was consumed earlier.
 *   `revoked`           — the mandate's authority was withdrawn (fix-loop-2
 *                         #4): a revoked lease can never be consumed.
 *   `expired`           — the mandate's window has passed (fix-loop #8): the
 *                         consume is refused honestly instead of reporting a
 *                         success on a dead mandate.
 */
export function consumeLease(
  state: AutonomyState,
  id: string,
  nowMs: number = Date.now(),
): { state: AutonomyState; outcome: ConsumeOutcome } {
  const idx = state.leases.findIndex((l) => l.id === id)
  if (idx === -1) return { state, outcome: 'not_found' }
  const lease = state.leases[idx] as AutonomyLease
  if (lease.revokedAtMs !== undefined) {
    return { state, outcome: 'revoked' }
  }
  if (lease.consumedAtMs !== undefined && lease.consumedAtMs !== null) {
    return { state, outcome: 'already_consumed' }
  }
  if (lease.expiresAtMs <= nowMs) {
    return { state, outcome: 'expired' }
  }
  const leases = state.leases.slice()
  leases[idx] = { ...lease, consumedAtMs: nowMs }
  return { state: { ...state, leases }, outcome: 'ok' }
}

export type RevokeOutcome = 'ok' | 'not_found' | 'already_consumed' | 'already_revoked' | 'expired'

/**
 * Revoke a lease — withdraw its authority (fix-loop-2 #4). TERMINAL and
 * distinct from consumption. Kept simple by design:
 *   `already_consumed` — a used mandate cannot be revoked (nothing to withdraw);
 *   `already_revoked`  — revocation is final;
 *   `expired`          — an expired mandate has no authority left, revoke is a
 *                        no-op (reported honestly, state untouched).
 */
export function revokeLease(
  state: AutonomyState,
  id: string,
  nowMs: number,
  revokedBy: string,
  reason?: string,
): { state: AutonomyState; outcome: RevokeOutcome } {
  const idx = state.leases.findIndex((l) => l.id === id)
  if (idx === -1) return { state, outcome: 'not_found' }
  const lease = state.leases[idx] as AutonomyLease
  if (lease.revokedAtMs !== undefined) return { state, outcome: 'already_revoked' }
  if (lease.consumedAtMs !== undefined && lease.consumedAtMs !== null) {
    return { state, outcome: 'already_consumed' }
  }
  if (lease.expiresAtMs <= nowMs) return { state, outcome: 'expired' }
  const leases = state.leases.slice()
  leases[idx] = {
    ...lease,
    revokedAtMs: nowMs,
    revokedBy,
    ...(reason !== undefined ? { revokeReason: reason } : {}),
  }
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

/**
 * Add an open question and return the NEW state plus the created question.
 * Same ID-uniqueness contract as addLease: explicit colliding id →
 * `outcome: 'duplicate'` (state unchanged); omitted id regenerates to unique.
 */
export function addQuestion(
  state: AutonomyState,
  input: NewQuestionInput,
  nowMs: number = Date.now(),
): { state: AutonomyState; question?: OpenQuestion; outcome: AddOutcome } {
  const existing = new Set(state.questions.map((q) => q.id))
  if (input.id !== undefined && existing.has(input.id)) {
    return { state, outcome: 'duplicate' }
  }
  const question: OpenQuestion = {
    id: input.id ?? uniqueId(() => newQuestionId(nowMs), existing),
    summary: input.summary,
    askedAtMs: input.askedAtMs ?? nowMs,
    status: input.status ?? 'open',
    ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
    ...(input.defaultAction !== undefined ? { defaultAction: input.defaultAction } : {}),
    ...(input.sticky !== undefined ? { sticky: input.sticky } : {}),
  }
  return { state: { ...state, questions: [...state.questions, question] }, question, outcome: 'ok' }
}

export type ResolveOutcome = 'ok' | 'not_found' | 'sticky_forbidden' | 'already_resolved'

/**
 * Resolve a question to `answered` or `bypassed`, stamping resolvedAtMs.
 * Invariants live HERE, in the store, not in prose (fix-loop #2):
 *   `not_found`        — unknown id.
 *   `sticky_forbidden` — a sticky (security) question can NEVER be bypassed;
 *                        only `answered` is accepted for it.
 *   `already_resolved` — the question is no longer open; resolution is final
 *                        and cannot be rewritten.
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
  if (q.status !== 'open') return { state, outcome: 'already_resolved' }
  if (q.sticky === true && status === 'bypassed') {
    return { state, outcome: 'sticky_forbidden' }
  }
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
      // Short scope-digest anchor (first 12 hex chars) — tool status ONLY,
      // never in the reminder/HUD surfaces (fix-loop-2 #3).
      const digest = l.scopeDigest !== undefined ? ` [${l.scopeDigest.slice(7, 19)}]` : ''
      lines.push(`  ${l.id}: «${truncate(l.scope, SCOPE_MAX_CHARS)}» — ещё ${left} (source: ${l.source})${digest}`)
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

// ONE canonicalizer for the per-chat file key, used by path building, the
// tmp-file naming AND the write-serialization map — so "00123" and "123" can
// never address two different files/locks (fix-loop #3).
//   * Numeric strings (the normal Telegram case, incl. negative supergroup
//     ids) normalize via BigInt: leading zeros / "-0" collapse to the
//     canonical integer form.
//   * Non-numeric strings encode INJECTIVELY: [0-9A-Za-z-] pass through,
//     every other code point (including `_`, the escape char itself) becomes
//     `_<hex>_` — two distinct inputs can never collide, unlike a lossy
//     replace-with-`_`.
export function canonicalChatKey(chatId: string): string {
  const trimmed = chatId.trim()
  if (/^-?\d+$/.test(trimmed)) {
    try {
      return BigInt(trimmed).toString()
    } catch {
      // unreachable for the regex above; fall through defensively
    }
  }
  let out = ''
  for (const ch of trimmed) {
    if (/[0-9A-Za-z-]/.test(ch)) out += ch
    else out += `_${(ch.codePointAt(0) as number).toString(16)}_`
  }
  return out
}

// Filename-safe per-chat path, keyed by the canonical chat key.
export function autonomyStatePath(paths: AutonomyPaths, chatId: string): string {
  return join(paths.root, `autonomy-${canonicalChatKey(chatId)}.json`)
}

// Narrow an unknown parsed blob into a valid AutonomyState, dropping anything
// malformed. A partially-corrupt file yields the well-formed entries it can and
// empty state otherwise — never throws.
function coerceState(parsed: unknown): AutonomyState {
  const out = emptyAutonomyState()
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out
  const obj = parsed as Record<string, unknown>
  if (typeof obj.revision === 'number' && Number.isFinite(obj.revision) && obj.revision >= 0) {
    out.revision = Math.floor(obj.revision)
  }
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
  if (typeof o.scopeDigest === 'string' && o.scopeDigest.length > 0) lease.scopeDigest = o.scopeDigest
  if (typeof o.scopeVersion === 'number' && Number.isFinite(o.scopeVersion)) lease.scopeVersion = o.scopeVersion
  if (typeof o.revokedAtMs === 'number' && Number.isFinite(o.revokedAtMs)) lease.revokedAtMs = o.revokedAtMs
  if (typeof o.revokedBy === 'string') lease.revokedBy = o.revokedBy
  if (typeof o.revokeReason === 'string') lease.revokeReason = o.revokeReason
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
  } catch {
    // File existed but held invalid JSON — worth a warning, but never fatal.
    // Log ONLY a stable error code: the JSON.parse message can embed file
    // content, which must never reach the logs (fix-loop #9).
    if (log) {
      log.warn('autonomy state parse failed, using empty state', {
        chat_id: chatId,
        code: 'autonomy_state_parse_error',
      })
    }
    // Forensics (fix-loop-2 #5): move the corrupt file aside so the next
    // save does not destroy evidence — a rogue-empty-state incident stays
    // investigable. Best-effort, never throws.
    preserveCorruptFile(paths, chatId)
    return emptyAutonomyState()
  }
}

// Keep at most this many `*.json.corrupt-*` evidence files per chat key.
const MAX_CORRUPT_FILES = 3

// Per-process monotonic sequence for corrupt-evidence suffixes. Several
// corruptions can land in the SAME millisecond (a tight retry loop); with a
// random tie-breaker the lexicographic prune order within that ms was decided
// by the random hex — the «oldest» pruned could actually be the NEWEST file
// (flaky forensics test caught in review). The seq resolves same-ms ties
// deterministically. Cross-PROCESS ties are out of scope: the single-writer
// assumption (module header) means one process produces this evidence.
let corruptEvidenceSeq = 0

// Rename `autonomy-<key>.json` → `autonomy-<key>.json.corrupt-<ts>-<seq>-<rand>`
// and prune older evidence beyond MAX_CORRUPT_FILES. The suffix is MONOTONIC
// within the process so a lexicographic filename sort IS chronological:
// zero-padded 14-digit ms timestamp (fixes digit-length ordering for good),
// then the zero-padded base36 seq (same-ms ties), and the crypto-rand LAST —
// uniqueness across restarts only, never an ordering key. Best-effort: every
// step is allowed to fail.
function preserveCorruptFile(paths: AutonomyPaths, chatId: string): void {
  try {
    const key = canonicalChatKey(chatId)
    const file = autonomyStatePath(paths, chatId)
    const ts = String(Date.now()).padStart(14, '0')
    const seq = (corruptEvidenceSeq++).toString(36).padStart(4, '0')
    const suffix = `${ts}-${seq}-${randomBytes(3).toString('hex')}`
    renameSync(file, join(paths.root, `autonomy-${key}.json.corrupt-${suffix}`))
    const prefix = `autonomy-${key}.json.corrupt-`
    const evidence = readdirSync(paths.root)
      .filter((f) => f.startsWith(prefix))
      .sort()
    while (evidence.length > MAX_CORRUPT_FILES) {
      const oldest = evidence.shift()
      if (oldest === undefined) break
      try {
        unlinkSync(join(paths.root, oldest))
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort — forensics must never break the load path
  }
}

/**
 * Persist the per-chat autonomy state atomically. Durability hardening
 * (fix-loop #7, upgrades over state/store.ts writeUpdateOffset):
 *   * tmp opened with 'wx' (exclusive — a name collision fails loud instead
 *     of clobbering a concurrent writer's staging file);
 *   * fchmod 0600 right after open (mode arg is umask-masked; fchmod is not);
 *   * tmp cleaned up on ANY failure of the write path, not just rename;
 *   * best-effort directory fsync after rename so the rename itself is
 *     durable across a crash.
 */
export function saveAutonomyState(
  paths: AutonomyPaths,
  chatId: string,
  state: AutonomyState,
): void {
  // Normalize on write: stamp the current schema version and INCREMENT the
  // revision counter (fix-loop-2 #1) — every save is observable on disk.
  const nextRevision = (Number.isFinite(state.revision) ? state.revision : 0) + 1
  const body = JSON.stringify(
    {
      version: AUTONOMY_STATE_VERSION,
      revision: nextRevision,
      leases: state.leases,
      questions: state.questions,
    },
    null,
    2,
  )
  atomicWriteInRoot(paths, `autonomy-${canonicalChatKey(chatId)}.json`, body)
}

// Shared atomic writer for files in the state root (state files + the writer
// lock). tmp('wx') + fchmod 0600 + fsync + rename + tmp cleanup on ANY
// failure + best-effort directory fsync.
function atomicWriteInRoot(paths: AutonomyPaths, filename: string, body: string): void {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 })
  const target = join(paths.root, filename)
  const rand = randomBytes(3).toString('hex')
  const tmp = join(paths.root, `${filename}.tmp.${process.pid}.${Date.now()}.${rand}`)
  let fd: number | undefined
  let renamed = false
  try {
    fd = openSync(tmp, 'wx', 0o600)
    fchmodSync(fd, 0o600)
    writeSync(fd, body)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, target)
    renamed = true
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // best-effort
      }
    }
    if (!renamed) {
      try {
        unlinkSync(tmp)
      } catch {
        // best-effort cleanup — tmp may never have been created
      }
    }
  }
  // Directory fsync: makes the rename durable. Best-effort — some platforms
  // refuse O_RDONLY fsync on directories; a failure never breaks the save.
  try {
    const dirFd = openSync(paths.root, 'r')
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } catch {
    // best-effort
  }
}

// ─────────────────────────────────────────────────────────────────────
// Writer heartbeat lock (fix-loop-2 #2). One lock per state root, shared by
// all chats. Sol's criterion: freshness + writerId, NEVER bare PID-existence
// (pid stored for diagnostics only).
// ─────────────────────────────────────────────────────────────────────

export const WRITER_LOCK_FILENAME = 'autonomy-writer.lock'
// Refresh the own lock lazily when it is older than this (no timers).
export const WRITER_LOCK_REFRESH_MS = 30_000
// A FOREIGN lock younger than this blocks mutations; older is stale and is
// taken over.
export const WRITER_LOCK_STALE_MS = 90_000

// Random per-process writer identity — two processes can never share it even
// with equal pids across container boundaries.
export const AUTONOMY_WRITER_ID = randomBytes(8).toString('hex')

interface WriterLock {
  writerId: string
  pid: number
  refreshedAtMs: number
}

function readWriterLock(paths: AutonomyPaths): WriterLock | undefined {
  try {
    const raw = readFileSync(join(paths.root, WRITER_LOCK_FILENAME), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const o = parsed as Record<string, unknown>
    if (typeof o.writerId !== 'string' || o.writerId.length === 0) return undefined
    if (typeof o.refreshedAtMs !== 'number' || !Number.isFinite(o.refreshedAtMs)) return undefined
    return {
      writerId: o.writerId,
      pid: typeof o.pid === 'number' && Number.isFinite(o.pid) ? o.pid : -1,
      refreshedAtMs: o.refreshedAtMs,
    }
  } catch {
    // Missing or corrupt lock → treated as absent (take-over path).
    return undefined
  }
}

function writeWriterLock(paths: AutonomyPaths, nowMs: number): void {
  atomicWriteInRoot(
    paths,
    WRITER_LOCK_FILENAME,
    JSON.stringify({ writerId: AUTONOMY_WRITER_ID, pid: process.pid, refreshedAtMs: nowMs }),
  )
}

/**
 * Ensure THIS process holds the writer lock. Returns false when a FRESH lock
 * belongs to a different writer (the caller must refuse the mutation).
 *   * missing/corrupt lock → take it (write own), true;
 *   * own lock → refresh when older than WRITER_LOCK_REFRESH_MS, true;
 *   * foreign fresh (<WRITER_LOCK_STALE_MS) → log + false;
 *   * foreign stale → take over atomically, true.
 */
export function acquireWriterLock(
  paths: AutonomyPaths,
  nowMs: number = Date.now(),
  log?: Logger,
): boolean {
  const lock = readWriterLock(paths)
  if (lock === undefined) {
    writeWriterLock(paths, nowMs)
    return true
  }
  if (lock.writerId === AUTONOMY_WRITER_ID) {
    if (nowMs - lock.refreshedAtMs > WRITER_LOCK_REFRESH_MS) writeWriterLock(paths, nowMs)
    return true
  }
  if (nowMs - lock.refreshedAtMs < WRITER_LOCK_STALE_MS) {
    if (log) {
      log.warn('autonomy writer lock held by another live process — mutation refused', {
        code: 'autonomy_writer_conflict',
        holder_pid: lock.pid,
      })
    }
    return false
  }
  // Stale foreign lock — the holder stopped heartbeating; take over.
  writeWriterLock(paths, nowMs)
  return true
}

// ─────────────────────────────────────────────────────────────────────
// Serialized read-modify-write (fix-loop #1). ALL mutations of the per-chat
// file MUST route through here — a bare load→mutate→save in a caller races
// (two concurrent consumes both observing the pre-consume state).
// ─────────────────────────────────────────────────────────────────────

// Per-(root, chatKey) promise chain. Keyed by root TOO so two test dirs with
// the same chat id never share a lock. In-process only — see the
// single-writer assumption in the module header.
const updateChains = new Map<string, Promise<void>>()

// Cheap read of the ON-DISK revision, never throws. Missing/corrupt/invalid
// → 0 (matches what loadAutonomyState would produce for the same file).
function peekRevision(paths: AutonomyPaths, chatId: string): number {
  try {
    const parsed: unknown = JSON.parse(readFileSync(autonomyStatePath(paths, chatId), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const r = (parsed as Record<string, unknown>).revision
      if (typeof r === 'number' && Number.isFinite(r) && r >= 0) return Math.floor(r)
    }
    return 0
  } catch {
    return 0
  }
}

// Result of a serialized update. `writer_conflict` = a FRESH writer lock is
// held by another process — the mutation was refused entirely (fix-loop-2 #2).
export type UpdateResult<T> = { kind: 'ok'; result: T } | { kind: 'writer_conflict' }

/**
 * Atomically (within this process) apply `mutator` to the chat's state:
 * load → mutate → save, serialized per chat via a promise chain. The mutator
 * is pure/synchronous and returns the next state plus a result; when it
 * returns the SAME state reference (a failed/no-op mutation), the save is
 * skipped.
 *
 * Cross-process guards (fix-loop-2):
 *   * writer lock — a fresh foreign `autonomy-writer.lock` refuses the whole
 *     mutation with `{ kind: 'writer_conflict' }`;
 *   * revision check — right before writing, the on-disk revision is
 *     re-read; if it moved under us (a second-process writer slipped past
 *     the lock window), the state is RELOADED and the mutator re-applied on
 *     the fresh state, so the foreign write is absorbed, not clobbered.
 *     Within the in-process queue this never triggers.
 */
export function updateAutonomyState<T>(
  paths: AutonomyPaths,
  chatId: string,
  mutator: (state: AutonomyState) => { state: AutonomyState; result: T },
  log?: Logger,
): Promise<UpdateResult<T>> {
  const key = `${paths.root}|${canonicalChatKey(chatId)}`
  const step = (): UpdateResult<T> => {
    if (!acquireWriterLock(paths, Date.now(), log)) {
      return { kind: 'writer_conflict' }
    }
    let state = loadAutonomyState(paths, chatId, log)
    let out = mutator(state)
    if (out.state === state) return { kind: 'ok', result: out.result }
    // Detect a cross-process write between our load and this write.
    if (peekRevision(paths, chatId) !== state.revision) {
      if (log) {
        log.warn('autonomy state revision moved under writer — re-applying mutator on fresh state', {
          chat_id: chatId,
          code: 'autonomy_state_revision_conflict',
        })
      }
      state = loadAutonomyState(paths, chatId, log)
      out = mutator(state)
      if (out.state === state) return { kind: 'ok', result: out.result }
    }
    saveAutonomyState(paths, chatId, out.state)
    return { kind: 'ok', result: out.result }
  }
  const prior = updateChains.get(key) ?? Promise.resolve()
  // Run after the prior op regardless of its outcome (the chain must never
  // poison). Errors from THIS op propagate to the caller.
  const run = prior.then(step, step)
  const settled: Promise<void> = run.then(
    () => undefined,
    () => undefined,
  )
  updateChains.set(key, settled)
  void settled.then(() => {
    if (updateChains.get(key) === settled) updateChains.delete(key)
  })
  return run
}
