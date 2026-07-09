// TaskMirror — third rolling Telegram message per chat. Where StatusManager
// owns the transient «Печатает.../🔧 tool» bubble and ProgressReporter owns
// the per-tool activity thread, TaskMirror owns a separate persistent message
// that mirrors Claude's TodoWrite milestone list: in-progress / pending /
// completed items.
//
// The three surfaces NEVER share state — each Map entry is keyed on chatId
// inside its own class. This isolation is intentional: an operator can flip
// any of (status.enabled / progress.enabled / task_mirror.enabled) without
// disturbing the others.
//
// Architectural mirror of ProgressReporter (see plan §2.1):
//   * Single-slot queue per chat — `flushPromise !== null` guards in-flight
//     ops. Multiple TodoWrite events while a flush runs overwrite
//     `desiredText`; only the freshest snapshot ever publishes.
//   * Throttle via `edit_throttle_ms`. First send bypasses throttle, subsequent
//     edits within the window defer onto a single timer slot.
//   * Idempotency: same rendered text → no Telegram round-trip.
//   * Session namespacing: the snapshot is keyed on the harness `sessionId`.
//     A SessionStart with a new id (or a task event carrying one) resets the
//     mirror; compact / resume of the same id preserve it. The mirror finalizes
//     ONLY on SessionEnd (the real session end) — NEVER on Stop (turn-end).
//   * TTL (`session_ttl_ms`) is orphan cleanup ONLY: a same-session snapshot is
//     never expired for idleness; the TTL merely decides whether a session
//     change drops the old snapshot silently (stale orphan) or finalizes it
//     with a marker (fresh handoff).
//   * Persistence: `{sessionId, messageId, todos}` is written per chat under the
//     plugin state dir, so a plugin restart restores the rolling message
//     instead of spamming a fresh one.
//   * `recordEvent` is serialized per chat and its try/catch swallows every
//     throw so the webhook 200 path is never blocked.

import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AppConfig } from '../config.js'
import type { Logger } from '../log.js'
import type { TaskMirrorEvent } from '../hooks/claude-events.js'
import { TodoItemSchema, type TodoItem } from '../schemas.js'
import type { TelegramApiForProgress } from './telegram-api.js'
import { escapeHtml } from '../format/html.js'
import { renderFreshnessHeader, type TaskFreshness } from './task-freshness.js'

// Telegram editMessageText cap (4096 chars). Default render budget below it
// — the spec asks for ~3500-char headroom (see plan §3 file 4).
const DEFAULT_MAX_CHARS = 3500
const TRUNCATE_MARGIN = 100 // safety cushion below MAX_CHARS for tail strings

// Status icons. Unicode glyphs match the plan §2.3 spec.
const ICONS = {
  in_progress: '◐',
  pending: '◻',
  completed: '☑',
} as const

// HTML used as parse_mode for both send and edit — same as ProgressReporter.
const HTML_OPTS = { parse_mode: 'HTML' as const }

export interface TaskMirrorDeps {
  telegramApi: TelegramApiForProgress
  config: AppConfig
  log: Logger
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout
  clearTimer?: (handle: NodeJS.Timeout) => void
  // Plugin state dir. When set, the mirror persists `{sessionId, messageId,
  // todos}` per chat so a plugin restart restores the rolling message instead
  // of losing the snapshot. Omitted in unit tests that don't exercise restart.
  stateDir?: string
}

// On-disk snapshot persisted per chat under `task-mirror-<chatId>.json`. Lets a
// plugin restart pick up the SAME rolling message (edit in place) and the SAME
// session namespace, instead of spamming a fresh message on the next event.
interface PersistedTaskState {
  sessionId?: string
  messageId: number
  todos: ReadonlyArray<TodoItem>
  // true when `todos` had NOT yet been rendered into the remote message at
  // persist time (throttled edit pending / edit rejected). On hydration a
  // dirty snapshot forces one replay edit; otherwise the restored
  // lastRenderedText would suppress it and the remote message would stay
  // stale forever (review 2026-07-09 #3a).
  dirty?: boolean
  // Absolute epoch ms of the entry's last activity. Without it an ancient
  // orphan looked freshly-active after every restart and was finalized
  // gracefully instead of dropped (review 2026-07-09 #3c).
  lastActivityMs?: number
}

// Per-chat lifecycle entry. Field-for-field parallel to ChatProgressEntry,
// only `calls[]` is replaced with `todos[]` (latest snapshot, not a window).
interface ChatTaskEntry {
  chatId: string
  messageId?: number
  // Session this snapshot belongs to. Harness task ids restart at #1 every
  // session, so a mutation whose event.sessionId differs resets the mirror.
  sessionId?: string
  startedAtMs: number
  // Updated on every recordEvent. Used by TTL orphan cleanup on session change.
  lastActivityMs: number
  // Latest TodoWrite snapshot from Claude. Replaced wholesale on each event
  // — TodoWrite is itself the full list, so we never merge incrementally.
  todos: ReadonlyArray<TodoItem>
  // Incremental task map for the TaskCreate/TaskUpdate path (newer Claude Code
  // harness). Key is the harness taskId once reconciled from `toolResult`, or
  // the provisional `toolUseId` until then. `todos` is rebuilt from this map
  // after every mutation so `scheduleFlush` keeps using the existing renderer.
  // Insertion-order Map keeps the visual ordering stable across renders.
  taskMap: Map<string, TodoItem>
  // M3 reality mirror: freshness indicator for the «Задачи» header. Set by
  // applyReconciledView; undefined in the legacy event-only path (header stays
  // the plain «Задачи»).
  freshness?: TaskFreshness
  // Last text we actually sent / edited. Idempotency gate.
  lastRenderedText?: string
  // Timestamp of the last successful send or edit. Used for throttle.
  lastEditAtMs: number
  // Newest snapshot text waiting to be published. Multiple events overwrite
  // so only the freshest view ever lands on Telegram.
  desiredText?: string
  // Single-slot scheduler: non-null while a Telegram op is in flight.
  flushPromise: Promise<void> | null
  // Single-slot throttle timer. Non-null while waiting for the throttle
  // window to elapse before publishing.
  pendingTimer: NodeJS.Timeout | null
  // True once the entry has been finalized (session end) or dropped (orphan /
  // session change). Idempotency + orphan guard for late in-flight flushes.
  stopped: boolean
}

// Extract the harness-assigned task id from a TaskCreate PostToolUse
// `tool_result`. The harness emits `Task #<n> created successfully...`; we
// pull out the first `#<digits>` token. Returns null if the shape doesn't
// match — caller falls back to the provisional `toolUseId`.
function parseCreatedTaskId(toolResult: unknown): string | null {
  if (typeof toolResult !== 'string') return null
  const match = toolResult.match(/#(\d+)/)
  return match ? (match[1] ?? null) : null
}

// ─────────────────────────────────────────────────────────────────────
// Pure task-map appliers — shared by TaskMirror and the ContextHud work
// section so both surfaces synthesise IDENTICAL todo snapshots from the
// same TaskCreate/TaskUpdate event stream. Exported for reuse + tests.
// ─────────────────────────────────────────────────────────────────────

/**
 * Apply a `task_create` event to a task map (see TaskMirror.applyTaskCreate
 * docs for the provisional-id → harness-id reconciliation contract).
 */
export function applyTaskCreateToMap(
  taskMap: Map<string, TodoItem>,
  event: Extract<TaskMirrorEvent, { kind: 'task_create' }>,
): void {
  const realId =
    event.toolResult !== undefined ? parseCreatedTaskId(event.toolResult) : null
  const provisionalId = event.toolUseId
  const provisional = taskMap.get(provisionalId)
  const item: TodoItem = {
    id: realId ?? provisional?.id ?? provisionalId,
    content: event.input.subject,
    status: provisional?.status ?? 'pending',
    ...(event.input.activeForm !== undefined
      ? { activeForm: event.input.activeForm }
      : provisional?.activeForm !== undefined
        ? { activeForm: provisional.activeForm }
        : {}),
  }
  taskMap.delete(provisionalId)
  if (realId !== null && realId !== provisionalId) {
    taskMap.delete(realId)
  }
  taskMap.set(item.id ?? provisionalId, item)
}

/**
 * Apply a `task_update` event to a task map. `status: 'deleted'` removes the
 * entry; a missing target synthesises a minimal placeholder (webhook drops).
 */
export function applyTaskUpdateToMap(
  taskMap: Map<string, TodoItem>,
  event: Extract<TaskMirrorEvent, { kind: 'task_update' }>,
): void {
  const id = event.input.taskId
  if (event.input.status === 'deleted') {
    taskMap.delete(id)
    return
  }
  const existing = taskMap.get(id)
  const status = event.input.status ?? existing?.status ?? 'pending'
  const next: TodoItem = {
    id,
    content: event.input.subject ?? existing?.content ?? `task ${id}`,
    status,
    ...(event.input.activeForm !== undefined
      ? { activeForm: event.input.activeForm }
      : existing?.activeForm !== undefined
        ? { activeForm: existing.activeForm }
        : {}),
  }
  taskMap.set(id, next)
}

export class TaskMirror {
  private readonly telegramApi: TelegramApiForProgress
  private readonly config: AppConfig
  private readonly log: Logger
  private readonly now: () => number
  private readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout
  private readonly clearTimer: (handle: NodeJS.Timeout) => void
  private readonly stateDir: string | undefined
  private readonly chats: Map<string, ChatTaskEntry>
  // Per-chat serialization. Session transitions (finalize old → start new) and
  // throttled flushes must not interleave across concurrent webhook requests,
  // or a late old-session edit could race the new session's snapshot. Every
  // recordEvent for a chat is chained through this settled (never-rejecting)
  // promise — mirrors ContextHud.runSerialized.
  private readonly chatLocks: Map<string, Promise<void>>
  // Per-chat ACTIVE session id, tracked from SessionStart/SessionEnd
  // INDEPENDENTLY of whether a task entry exists (review 2026-07-09 #2:
  // handleSessionStart previously stored nothing when no tasks existed, so the
  // new session wasn't authoritative until its first mutation).
  private readonly activeSessions = new Map<string, string>()
  // Per-chat tombstones: session ids that received SessionEnd (bounded). A
  // LATE event naming a retired session must be DROPPED — pre-fix it was
  // treated as "newer", finalizing/clearing the active session's snapshot and
  // adopting the dead id. SessionStart with the same id (resume) un-retires.
  private readonly retiredSessions = new Map<string, Set<string>>()

  constructor(deps: TaskMirrorDeps) {
    this.telegramApi = deps.telegramApi
    this.config = deps.config
    this.log = deps.log
    this.now = deps.now ?? (() => Date.now())
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))
    this.stateDir = deps.stateDir
    this.chats = new Map()
    this.chatLocks = new Map()
  }

  /**
   * Main entry point. Called by the webhook handler for every Claude hook
   * that mapped to a TaskMirrorEvent. Never throws — the inner handler's
   * try/catch swallows any failure so the webhook 200 path stays open.
   *
   * Serialized per chat so a session transition and its flushes can't
   * interleave with a concurrent event for the same chat.
   */
  async recordEvent(chatId: string, event: TaskMirrorEvent): Promise<void> {
    if (!this.config.task_mirror.enabled) return
    await this.runSerialized(chatId, () => this.recordEventInner(chatId, event))
  }

  /**
   * Serialized body. Five input shapes:
   *   - `session_start`: reset the snapshot when the session id changes
   *     (genuine new session); preserve it on compact / resume of the same id.
   *   - `session_end`: finalize the surface (marker + evict). The REAL session
   *     end — Stop no longer reaches here.
   *   - `todo_write`: full list snapshot (legacy TodoWrite tool). Replaces
   *     `todos` wholesale AND clears `taskMap`.
   *   - `task_create` / `task_update`: incremental events. Mutate `taskMap`,
   *     then synthesise the `todos` array from it.
   */
  private async recordEventInner(chatId: string, event: TaskMirrorEvent): Promise<void> {
    try {
      if (event.kind === 'session_start') {
        await this.handleSessionStart(chatId, event.sessionId)
        return
      }
      if (event.kind === 'session_end') {
        await this.handleSessionEnd(chatId, event.sessionId)
        return
      }

      // Task mutation. Reset the mirror first if this event belongs to a
      // different session than the current snapshot; DROP it entirely when it
      // names a retired (ended) session — a late straggler must not resurrect
      // a dead session or clear the active one (review 2026-07-09 #2).
      const accepted = await this.ensureSessionForMutation(chatId, event.sessionId)
      if (!accepted) return
      const entry = this.getOrCreate(chatId)
      if (entry.stopped) return
      entry.sessionId = event.sessionId
      entry.lastActivityMs = this.now()

      switch (event.kind) {
        case 'todo_write':
          // Replace the snapshot wholesale. TodoWrite payloads ARE the full list.
          entry.taskMap.clear()
          entry.todos = event.todos
          break
        case 'task_create':
          this.applyTaskCreate(entry, event)
          entry.todos = Array.from(entry.taskMap.values())
          break
        case 'task_update':
          this.applyTaskUpdate(entry, event)
          entry.todos = Array.from(entry.taskMap.values())
          break
      }
      // Persist eagerly once the message exists so a restart mid-session
      // restores the latest todos even if the throttled edit hasn't landed.
      if (entry.messageId !== undefined) this.persistEntry(entry)
      this.scheduleFlush(entry)
      // Materialise the FIRST send inside the lock so a following serialized
      // event edits the same message instead of double-sending. Deferred
      // (throttled) edits keep messageId already set, so we do NOT await them
      // and throttling is preserved.
      if (entry.messageId === undefined && entry.flushPromise !== null) {
        try {
          await entry.flushPromise
        } catch {
          /* already logged inside executeFlush */
        }
      }
    } catch (err) {
      this.log.warn('task mirror recordEvent failed (ignored)', {
        chat_id: chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * M3 reality mirror entry point. Publishes a reconciled (pane-verified) task
   * list + freshness indicator into the rolling message. The reconciled list is
   * the FULL authoritative list, so it replaces the snapshot wholesale (clears
   * the incremental taskMap). Serialized per chat like recordEvent; never throws.
   *
   * When the reconciler is wired (server.ts), the raw recordEvent path is
   * bypassed and this is the sole driver — so the two never fight over `todos`.
   * An empty list before any message exists is NOT materialised (we don't post
   * an empty «задач нет» card for a fresh session with no tasks yet).
   */
  async applyReconciledView(
    chatId: string,
    view: { sessionId: string; todos: ReadonlyArray<TodoItem>; freshness: TaskFreshness },
  ): Promise<void> {
    if (!this.config.task_mirror.enabled) return
    await this.runSerialized(chatId, () => this.applyReconciledViewInner(chatId, view))
  }

  private async applyReconciledViewInner(
    chatId: string,
    view: { sessionId: string; todos: ReadonlyArray<TodoItem>; freshness: TaskFreshness },
  ): Promise<void> {
    try {
      const accepted = await this.ensureSessionForMutation(chatId, view.sessionId)
      if (!accepted) return // retired session — drop
      const entry = this.getOrCreate(chatId)
      if (entry.stopped) return
      // Restart guard (review 2026-07-09 #10): right after a plugin restart the
      // reconciler knows nothing yet (empty, unverified) while the entry may
      // hold a RESTORED populated message. Applying the empty view would edit
      // the live card down to «задач нет» — skip it; the reconciler pushes a
      // real view as soon as events/pane arrive.
      if (
        view.todos.length === 0 &&
        view.freshness.kind === 'unverified' &&
        entry.todos.length > 0
      ) {
        return
      }
      entry.sessionId = view.sessionId
      entry.lastActivityMs = this.now()
      // Reconciled list is the full authoritative snapshot.
      entry.taskMap.clear()
      entry.todos = view.todos
      entry.freshness = view.freshness
      // Don't create an empty card for a fresh session with no tasks yet; wait
      // until a task actually appears. Once a message exists we keep editing it
      // (a freshness change on a non-empty list still updates in place).
      if (entry.messageId === undefined && view.todos.length === 0) return
      if (entry.messageId !== undefined) this.persistEntry(entry)
      this.scheduleFlush(entry)
      if (entry.messageId === undefined && entry.flushPromise !== null) {
        try {
          await entry.flushPromise
        } catch {
          /* already logged inside executeFlush */
        }
      }
    } catch (err) {
      this.log.warn('task mirror applyReconciledView failed (ignored)', {
        chat_id: chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Serialize an operation per chat. The returned promise resolves when THIS op
  // completes; the next call for the same chat waits for it. `fn` swallows its
  // own errors (recordEventInner try/catch), so the chain never rejects.
  private runSerialized(chatId: string, fn: () => Promise<void>): Promise<void> {
    const prior = this.chatLocks.get(chatId) ?? Promise.resolve()
    const result = prior.then(fn, fn)
    const settled: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    )
    this.chatLocks.set(chatId, settled)
    void settled.then(() => {
      if (this.chatLocks.get(chatId) === settled) this.chatLocks.delete(chatId)
    })
    return result
  }

  /**
   * TaskCreate handler. PreToolUse adds the task to `taskMap` keyed on
   * `toolUseId` (provisional id, always present). The follow-up PostToolUse
   * carries `toolResult`; if we can parse a real `#<n>` id we re-key the
   * entry so subsequent `TaskUpdate` events (which use the real id) can find
   * it. Two arrivals are idempotent — a TaskCreate that has already been
   * recorded under its provisional id and a matching PostToolUse with the
   * same toolUseId find the entry and reconcile without duplicating.
   *
   * Note: the harness convention is `Task #N created successfully` — see
   * TaskCreate tool description. `parseCreatedTaskId` extracts the first
   * `#<digits>` substring and returns null on shape mismatch.
   */
  private applyTaskCreate(
    entry: ChatTaskEntry,
    event: Extract<TaskMirrorEvent, { kind: 'task_create' }>,
  ): void {
    // Re-keying (provisional → canonical id) moves the task to the Map tail on
    // reconciliation — the right place visually (most recently activated).
    applyTaskCreateToMap(entry.taskMap, event)
  }

  /**
   * TaskUpdate handler. `taskId` from the harness is always a string after
   * the schema coerce. If the entry exists, mutate in place; if not (e.g.
   * TaskMirror missed the TaskCreate due to a webhook drop), synthesise a
   * minimal placeholder so the list stays consistent.
   */
  private applyTaskUpdate(
    entry: ChatTaskEntry,
    event: Extract<TaskMirrorEvent, { kind: 'task_update' }>,
  ): void {
    applyTaskUpdateToMap(entry.taskMap, event)
  }

  /**
   * Test-only drain — same contract as ProgressReporter._idleForTests.
   */
  async _idleForTests(chatId: string): Promise<void> {
    for (let i = 0; i < 16; i++) {
      const entry = this.chats.get(chatId)
      if (!entry || entry.flushPromise === null) return
      try {
        await entry.flushPromise
      } catch {
        /* already logged */
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────

  // Return the in-memory entry, restoring it from disk first if the process
  // just restarted. Unlike the old getOrCreate, this NEVER expires an entry by
  // TTL — an active same-session snapshot must survive idle gaps (the mirror no
  // longer finalizes on Stop, so idleness is normal). TTL now bites ONLY as
  // orphan cleanup on a session change (see ensureSessionForMutation).
  private hydrate(chatId: string): ChatTaskEntry | undefined {
    const mem = this.chats.get(chatId)
    if (mem) return mem
    const persisted = this.loadPersisted(chatId)
    if (!persisted) return undefined
    const entry = this.reconstructEntry(chatId, persisted)
    this.chats.set(chatId, entry)
    // Dirty snapshot: the persisted todos were never acked into the remote
    // message (throttled edit pending / rejected at crash time). Replay ONE
    // edit now — reconstructEntry left lastRenderedText unset so the flush is
    // not suppressed by the idempotency gate (review 2026-07-09 #3a).
    if (persisted.dirty === true) this.scheduleFlush(entry)
    return entry
  }

  private getOrCreate(chatId: string): ChatTaskEntry {
    const existing = this.hydrate(chatId)
    if (existing) return existing
    const entry: ChatTaskEntry = {
      chatId,
      startedAtMs: this.now(),
      lastActivityMs: this.now(),
      todos: [],
      taskMap: new Map(),
      lastEditAtMs: 0,
      flushPromise: null,
      pendingTimer: null,
      stopped: false,
    }
    this.chats.set(chatId, entry)
    return entry
  }

  // Rebuild an entry from its persisted snapshot. For a CLEAN snapshot,
  // lastRenderedText is set so the idempotency gate holds (an identical
  // follow-up event is a no-op); for a DIRTY one it is left unset so the
  // hydration replay edit goes through. lastEditAt is 0 so the first
  // post-restore edit isn't throttled. lastActivityMs restores the ABSOLUTE
  // persisted timestamp (clamped to now) so an ancient orphan is recognized as
  // such after a restart instead of looking freshly active.
  private reconstructEntry(chatId: string, persisted: PersistedTaskState): ChatTaskEntry {
    const taskMap = new Map<string, TodoItem>()
    persisted.todos.forEach((t, i) => {
      taskMap.set(t.id ?? `restored-${i}`, t)
    })
    const now = this.now()
    const lastActivityMs =
      persisted.lastActivityMs !== undefined ? Math.min(persisted.lastActivityMs, now) : now
    return {
      chatId,
      messageId: persisted.messageId,
      ...(persisted.sessionId !== undefined ? { sessionId: persisted.sessionId } : {}),
      startedAtMs: now,
      lastActivityMs,
      todos: persisted.todos,
      taskMap,
      ...(persisted.dirty === true
        ? {}
        : { lastRenderedText: this.safeRender(persisted.todos) }),
      lastEditAtMs: 0,
      flushPromise: null,
      pendingTimer: null,
      stopped: false,
    }
  }

  // ─── session lifecycle ────────────────────────────────────────────────

  // Bounded tombstone bookkeeping (review 2026-07-09 #2).
  private retire(chatId: string, sessionId: string): void {
    let set = this.retiredSessions.get(chatId)
    if (set === undefined) {
      set = new Set()
      this.retiredSessions.set(chatId, set)
    }
    set.delete(sessionId) // re-add moves to the tail (freshest)
    set.add(sessionId)
    while (set.size > 8) {
      const oldest = set.values().next().value
      if (oldest === undefined) break
      set.delete(oldest)
    }
  }

  private isRetired(chatId: string, sessionId: string): boolean {
    return this.retiredSessions.get(chatId)?.has(sessionId) === true
  }

  // SessionStart: mark the session ACTIVE for the chat (independent of any
  // task entry existing), un-retire it (a resume of an ended session is
  // legitimate), then reset the snapshot on a genuine session change and
  // preserve it on compact / resume (same id).
  private async handleSessionStart(chatId: string, sessionId: string): Promise<void> {
    this.retiredSessions.get(chatId)?.delete(sessionId) // resume legitimizes
    const active = this.activeSessions.get(chatId)
    if (active !== undefined && active !== sessionId) this.retire(chatId, active)
    this.activeSessions.set(chatId, sessionId)

    const existing = this.hydrate(chatId)
    if (!existing) return
    if (existing.sessionId === undefined) {
      existing.sessionId = sessionId
      return
    }
    if (existing.sessionId === sessionId) return // compact / resume — preserve
    await this.resetForNewSession(chatId, existing)
  }

  // SessionEnd (the REAL session end): finalize the surface and TOMBSTONE the
  // session so late events naming it are dropped. A late SessionEnd naming a
  // session that is NOT the active one only tombstones it — it must never
  // finalize the active session's mirror.
  private async handleSessionEnd(chatId: string, sessionId: string): Promise<void> {
    const active = this.activeSessions.get(chatId)
    if (active !== undefined && active !== sessionId) {
      this.retire(chatId, sessionId) // late end from a retired session
      return
    }
    this.retire(chatId, sessionId)
    this.activeSessions.delete(chatId)

    const existing = this.hydrate(chatId)
    if (!existing) return
    if (existing.sessionId !== undefined && existing.sessionId !== sessionId) return
    await this.finalize(chatId, existing)
  }

  // A task mutation arrived. Returns false when the event must be DROPPED
  // (retired session). Otherwise resets the entry if the event belongs to a
  // different session than the current snapshot (missed SessionStart) and
  // adopts the event's session as active.
  private async ensureSessionForMutation(chatId: string, sessionId: string): Promise<boolean> {
    if (this.isRetired(chatId, sessionId)) return false // late event from a dead session
    const active = this.activeSessions.get(chatId)
    if (active !== undefined && active !== sessionId) {
      // Unknown (not retired) session — a missed SessionStart for a newer one.
      this.retire(chatId, active)
    }
    this.activeSessions.set(chatId, sessionId)

    const existing = this.hydrate(chatId)
    if (!existing) return true
    if (existing.sessionId === undefined) return true // adopted by the mutation
    if (existing.sessionId === sessionId) return true
    await this.resetForNewSession(chatId, existing)
    return true
  }

  // Reset on session change. If the old snapshot is fresh, finalize it
  // gracefully (final «сессия завершена» edit) so the warchief sees the handoff;
  // if it is past the TTL it is a stale orphan and dropped silently.
  private async resetForNewSession(chatId: string, existing: ChatTaskEntry): Promise<void> {
    const idle = this.now() - existing.lastActivityMs
    if (idle > this.config.task_mirror.session_ttl_ms) {
      this.dropOrphan(chatId, existing)
    } else {
      await this.finalize(chatId, existing)
    }
  }

  /**
   * Render the current snapshot and schedule a flush. Idempotent — if a
   * flush is already in flight or a timer is armed, just update
   * `desiredText` and return.
   */
  private scheduleFlush(entry: ChatTaskEntry): void {
    if (entry.stopped) return
    const text = this.safeRender(entry.todos, entry.freshness)
    if (!text || text === entry.lastRenderedText) return
    entry.desiredText = text

    if (entry.flushPromise !== null || entry.pendingTimer !== null) return

    const isFirstSend = entry.messageId === undefined
    const elapsed = this.now() - entry.lastEditAtMs
    const wait = isFirstSend
      ? 0
      : Math.max(0, this.config.task_mirror.edit_throttle_ms - elapsed)

    if (wait > 0) {
      entry.pendingTimer = this.setTimer(() => {
        entry.pendingTimer = null
        this.startFlush(entry)
      }, wait)
    } else {
      this.startFlush(entry)
    }
  }

  private startFlush(entry: ChatTaskEntry): void {
    if (entry.stopped) return
    if (entry.flushPromise !== null) return
    const text = entry.desiredText
    if (text === undefined || text === entry.lastRenderedText) return
    delete entry.desiredText

    entry.flushPromise = this.executeFlush(entry, text).finally(() => {
      entry.flushPromise = null
      if (
        !entry.stopped &&
        entry.desiredText !== undefined &&
        entry.desiredText !== entry.lastRenderedText
      ) {
        this.scheduleFlush(entry)
      }
    })
  }

  private async executeFlush(entry: ChatTaskEntry, text: string): Promise<void> {
    if (entry.messageId === undefined) {
      try {
        const sent = await this.telegramApi.sendMessage(entry.chatId, text, HTML_OPTS)
        if (!entry.stopped) {
          entry.messageId = sent.message_id
          entry.lastRenderedText = text
          entry.lastEditAtMs = this.now()
          this.persistEntry(entry)
        } else {
          this.log.warn('task mirror send completed after stop (orphan)', {
            chat_id: entry.chatId,
            message_id: sent.message_id,
          })
        }
      } catch (err) {
        this.log.warn('task mirror sendMessage failed (ignored)', {
          chat_id: entry.chatId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }
    try {
      await this.telegramApi.editMessageText(entry.chatId, entry.messageId, text, HTML_OPTS)
      if (!entry.stopped) {
        entry.lastRenderedText = text
        entry.lastEditAtMs = this.now()
        this.persistEntry(entry)
      }
    } catch (err) {
      this.log.warn('task mirror editMessageText failed (ignored)', {
        chat_id: entry.chatId,
        message_id: entry.messageId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Finalize a session. Cancels timers, awaits any in-flight flush, posts a
   * final edit (if a message exists) with the latest snapshot AND a «сессия
   * завершена» marker line, then evicts the entry and clears its persisted
   * snapshot. Called on SessionEnd and on a fresh session change — NEVER on
   * Stop (Stop is turn-end, not session-end).
   *
   * Why the marker: without it, if the last snapshot was already rendered the
   * idempotency gate (`text === lastRenderedText`) skips the final edit — the
   * warchief never sees a visual «session ended» signal. Appending a non-empty
   * marker line guarantees the final text differs.
   */
  private async finalize(chatId: string, entry: ChatTaskEntry): Promise<void> {
    if (entry.stopped) return
    entry.stopped = true

    if (entry.pendingTimer !== null) {
      this.clearTimer(entry.pendingTimer)
      entry.pendingTimer = null
    }

    if (entry.flushPromise !== null) {
      try {
        await entry.flushPromise
      } catch {
        /* already logged */
      }
    }

    if (entry.messageId !== undefined) {
      const text = this.renderFinal(entry)
      if (text && text !== entry.lastRenderedText) {
        try {
          await this.telegramApi.editMessageText(entry.chatId, entry.messageId, text, HTML_OPTS)
          entry.lastRenderedText = text
        } catch (err) {
          this.log.warn('task mirror final edit failed (ignored)', {
            chat_id: entry.chatId,
            message_id: entry.messageId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    this.chats.delete(chatId)
    this.clearPersisted(chatId)
  }

  /**
   * Drop a stale orphan (a snapshot whose session changed AND that is past the
   * TTL — a long-dead session we never got a clean SessionEnd for). Silent: no
   * «сессия завершена» edit, since the old message is long stale. Cancels the
   * throttle timer and marks the entry stopped so any in-flight flush no-ops.
   */
  private dropOrphan(chatId: string, entry: ChatTaskEntry): void {
    entry.stopped = true
    if (entry.pendingTimer !== null) {
      this.clearTimer(entry.pendingTimer)
      entry.pendingTimer = null
    }
    this.log.debug('task mirror orphan dropped on session change (TTL elapsed)', {
      chat_id: chatId,
    })
    this.chats.delete(chatId)
    this.clearPersisted(chatId)
  }

  /**
   * Final-edit body: current snapshot + «сессия завершена» marker. The
   * marker ALWAYS differs from any intermediate render so idempotency
   * never skips this edit (otherwise the warchief might never see a
   * session-end signal). Same DEFAULT_MAX_CHARS budget applies — if the
   * snapshot already pushes against the cap, the marker still fits inside
   * the safety margin renderTodoList reserves.
   *
   * When the reality mirror already stamped an `ended` freshness header
   * («Задачи · сессия завершена · сверено HH:MM UTC»), the footer marker is
   * SKIPPED — otherwise the card would say «сессия завершена» twice.
   */
  private renderFinal(entry: ChatTaskEntry): string {
    const block = this.safeRender(entry.todos, entry.freshness)
    if (!block) return ''
    if (entry.freshness?.kind === 'ended') return block
    return `${block}\n<i>сессия завершена</i>`
  }

  private safeRender(todos: ReadonlyArray<TodoItem>, freshness?: TaskFreshness): string {
    try {
      return renderTodoList(todos, this.config.task_mirror.collapse_completed_after, undefined, freshness)
    } catch (err) {
      this.log.warn('task mirror render failed (ignored)', {
        error: err instanceof Error ? err.message : String(err),
      })
      return ''
    }
  }

  // ─── persistence ──────────────────────────────────────────────────────
  // Best-effort, same pattern as ContextHud: a persistence failure NEVER
  // disturbs the surface (the mirror keeps working from memory). Files are
  // written atomically (temp + rename in the same dir) so a partial write can't
  // corrupt the snapshot. No-op when no state dir was configured.

  private persistPath(chatId: string): string {
    const safe = chatId.replace(/[^0-9A-Za-z_-]/g, '_')
    return join(this.stateDir as string, `task-mirror-${safe}.json`)
  }

  private persistEntry(entry: ChatTaskEntry): void {
    if (this.stateDir === undefined) return
    if (entry.messageId === undefined) return
    // dirty = the current todos have NOT been acked into the remote message
    // yet (throttled edit pending / edit failed). Computed structurally so
    // every persist site gets it right: the snapshot is clean exactly when
    // rendering the persisted todos reproduces the last successfully-sent text.
    const dirty = this.safeRender(entry.todos, entry.freshness) !== entry.lastRenderedText
    const snapshot: PersistedTaskState = {
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      messageId: entry.messageId,
      todos: entry.todos,
      dirty,
      lastActivityMs: entry.lastActivityMs,
    }
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      const path = this.persistPath(entry.chatId)
      const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
      writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 })
      try {
        renameSync(tmp, path)
      } catch (err) {
        try {
          unlinkSync(tmp)
        } catch {
          /* ignore */
        }
        throw err
      }
    } catch (err) {
      this.log.warn('task mirror persist failed (ignored)', {
        chat_id: entry.chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private loadPersisted(chatId: string): PersistedTaskState | undefined {
    if (this.stateDir === undefined) return undefined
    let raw: string
    try {
      raw = readFileSync(this.persistPath(chatId), 'utf8')
    } catch {
      return undefined // missing file → no persisted snapshot
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
      const obj = parsed as Record<string, unknown>
      const messageId = obj.messageId
      if (typeof messageId !== 'number' || !Number.isInteger(messageId) || messageId <= 0) {
        return undefined
      }
      // Schema-validate EVERY todo (review 2026-07-09 #3b). Pre-fix a snapshot
      // like `{todos:[null]}` passed the Array.isArray check, then threw at
      // `t.id` inside reconstructEntry on EVERY subsequent webhook event — a
      // permanent wedge. An invalid snapshot is quarantined (ignored) and the
      // mirror continues fresh.
      if (!Array.isArray(obj.todos)) return undefined
      const todos: TodoItem[] = []
      for (const rawItem of obj.todos) {
        const item = TodoItemSchema.safeParse(rawItem)
        if (!item.success) {
          this.log.warn('task mirror persisted snapshot invalid — quarantined, starting fresh', {
            chat_id: chatId,
          })
          return undefined
        }
        todos.push(item.data)
      }
      const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : undefined
      const dirty = obj.dirty === true
      const lastActivityMs =
        typeof obj.lastActivityMs === 'number' && Number.isFinite(obj.lastActivityMs)
          ? obj.lastActivityMs
          : undefined
      return {
        ...(sessionId !== undefined ? { sessionId } : {}),
        messageId,
        todos,
        dirty,
        ...(lastActivityMs !== undefined ? { lastActivityMs } : {}),
      }
    } catch {
      return undefined // malformed JSON → treat as no snapshot
    }
  }

  private clearPersisted(chatId: string): void {
    if (this.stateDir === undefined) return
    try {
      rmSync(this.persistPath(chatId), { force: true })
    } catch (err) {
      this.log.warn('task mirror clearPersisted failed (ignored)', {
        chat_id: chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Renderer (exported for tests)
// ─────────────────────────────────────────────────────────────────────

/**
 * Render a TodoWrite snapshot as Telegram-friendly HTML. Section order:
 *   1. Header — bold «Задачи» + counts.
 *   2. In-progress items — icon ◐.
 *   3. Pending items — icon ◻.
 *   4. Last `collapseCompletedAfter` completed items — icon ☑.
 *   5. Tail line if more completed exist: `<i>+M завершено ранее</i>`.
 *
 * Edge cases:
 *   - Empty list: `<i>задач нет</i>` (don't delete the message).
 *   - Total length cap at ~DEFAULT_MAX_CHARS: pending list truncates first,
 *     then completed, with `<i>+N ещё…</i>` tail.
 *
 * Every dynamic string passes through `escapeHtml` so user-supplied todo
 * content can't break out of the message.
 */
export function renderTodoList(
  todos: ReadonlyArray<TodoItem>,
  collapseCompletedAfter: number,
  maxChars: number = DEFAULT_MAX_CHARS,
  freshness?: TaskFreshness,
): string {
  // M3: the bold «Задачи» header is replaced by the reconciliation-freshness
  // label (+ optional subline) when a freshness value is supplied.
  const fh = freshness !== undefined ? renderFreshnessHeader(freshness) : { label: '<b>Задачи</b>' }
  const headerLabel = fh.label
  const headerSub = 'sub' in fh && fh.sub !== undefined ? fh.sub : undefined

  if (todos.length === 0) {
    const subLine = headerSub !== undefined ? `\n${headerSub}` : ''
    return `${headerLabel}${subLine}\n<i>задач нет</i>`
  }

  let doneCount = 0
  let inProgressCount = 0
  let pendingCount = 0
  const inProgress: TodoItem[] = []
  const pending: TodoItem[] = []
  const completed: TodoItem[] = []
  for (const t of todos) {
    switch (t.status) {
      case 'in_progress':
        inProgressCount++
        inProgress.push(t)
        break
      case 'pending':
        pendingCount++
        pending.push(t)
        break
      case 'completed':
        doneCount++
        completed.push(t)
        break
    }
  }

  const headerLines = headerSub !== undefined ? [headerLabel, headerSub] : [headerLabel]
  const counts = `${doneCount} done / ${inProgressCount} in progress / ${pendingCount} pending`

  // Show only the last N completed items; older ones collapse into a tail
  // notice. `collapseCompletedAfter=0` means «hide all completed» — render
  // none, then the tail says how many were hidden.
  const visibleCompleted = collapseCompletedAfter > 0
    ? completed.slice(-collapseCompletedAfter)
    : []
  const hiddenCompletedCount = completed.length - visibleCompleted.length

  const lines: string[] = [...headerLines, counts, '']
  for (const t of inProgress) lines.push(`${ICONS.in_progress} ${escapeTodoLine(t)}`)
  for (const t of pending) lines.push(`${ICONS.pending} ${escapeTodoLine(t)}`)
  if (hiddenCompletedCount > 0) {
    lines.push(`<i>+${hiddenCompletedCount} завершено ранее</i>`)
  }
  for (const t of visibleCompleted) lines.push(`${ICONS.completed} ${escapeTodoLine(t)}`)

  let body = lines.join('\n')
  if (body.length <= maxChars) return body

  // Over budget. Truncation pass: drop trailing pending lines first, then
  // completed. Always keep header + counts + at least the in-progress block.
  const safeBudget = maxChars - TRUNCATE_MARGIN
  // Header block (header + optional freshness subline + counts + blank line) is mandatory.
  const headerBlock = [...headerLines, counts, ''].join('\n')
  const inProgressBlock = inProgress
    .map((t) => `${ICONS.in_progress} ${escapeTodoLine(t)}`)
    .join('\n')
  let used = headerBlock.length + (inProgressBlock.length > 0 ? 1 + inProgressBlock.length : 0)
  const out: string[] = [headerBlock]
  if (inProgressBlock.length > 0) out.push(inProgressBlock)

  // Add pending lines one by one until budget runs out.
  let droppedPending = 0
  const pendingLines = pending.map((t) => `${ICONS.pending} ${escapeTodoLine(t)}`)
  const pendingKept: string[] = []
  for (const line of pendingLines) {
    // +1 for the joining newline.
    if (used + 1 + line.length > safeBudget) {
      droppedPending = pendingLines.length - pendingKept.length
      break
    }
    pendingKept.push(line)
    used += 1 + line.length
  }
  if (pendingKept.length > 0) out.push(pendingKept.join('\n'))
  if (droppedPending > 0) {
    const tail = `<i>+${droppedPending} ещё…</i>`
    out.push(tail)
    used += 1 + tail.length
  }

  // Completed: respect collapse rule first, then truncate visible block.
  let droppedCompleted = hiddenCompletedCount
  if (hiddenCompletedCount > 0) {
    const tail = `<i>+${hiddenCompletedCount} завершено ранее</i>`
    if (used + 1 + tail.length <= safeBudget) {
      out.push(tail)
      used += 1 + tail.length
    }
  }
  const completedLines = visibleCompleted.map(
    (t) => `${ICONS.completed} ${escapeTodoLine(t)}`,
  )
  const completedKept: string[] = []
  for (const line of completedLines) {
    if (used + 1 + line.length > safeBudget) {
      droppedCompleted += completedLines.length - completedKept.length
      break
    }
    completedKept.push(line)
    used += 1 + line.length
  }
  if (completedKept.length > 0) out.push(completedKept.join('\n'))
  if (droppedCompleted > hiddenCompletedCount) {
    const extraDropped = droppedCompleted - hiddenCompletedCount
    const tail = `<i>+${extraDropped} ещё…</i>`
    out.push(tail)
  }

  return out.join('\n')
}

function escapeTodoLine(todo: TodoItem): string {
  // Prefer `activeForm` for in-progress items (Claude convention is
  // gerund — «Reading file» vs «Read file»), otherwise show `content`.
  const raw = todo.status === 'in_progress' && todo.activeForm
    ? todo.activeForm
    : todo.content
  return escapeHtml(raw)
}
