// TaskRealityMirror — the M3 wiring layer that makes the task surfaces reflect
// the harness's REAL task list even when the agent forgets to call task tools.
//
// It fuses two truth sources per chat:
//   (a) the plugin's own tool-event stream (TodoWrite / TaskCreate / TaskUpdate)
//       already flowing through the webhook, and
//   (b) validated snapshots of the task list Claude Code renders directly in the
//       tmux pane (captured via the shared pane-capture code path).
//
// The pure fusion + freshness logic lives in the M2 `task-reconciler` module;
// this file owns ONLY the stateful orchestration the pure layer forbids itself:
// per-chat state, the session binding, the turn-active window, the capture
// timer (20s cadence, 5s coalesce, immediate on SessionStart / UserPromptSubmit
// / Stop), and pushing the reconciled view + freshness indicator into the
// surfaces (context HUD pin + TaskMirror). Every method is best-effort and must
// never throw into the webhook 200 path.
//
// Degradation: when no pane is capturable (tmux absent, session gone, wrong
// pane), reconciliation produces no valid snapshot and the view renders
// «НЕ СВЕРЕНО» (events only) — the surfaces still show the optimistic list.

import type { Logger } from '../log.js'
import type { TodoItem } from '../schemas.js'
import type { TaskMirrorEvent, TaskMutationEvent } from '../hooks/claude-events.js'
import { isTaskMutationEvent } from '../hooks/claude-events.js'
import { applyTaskCreateToMap, applyTaskUpdateToMap } from './task-mirror.js'
import {
  capturePaneText,
  resolvePaneCwd,
  type PaneCaptureConfig,
  type TmuxExec,
} from './pane-capture.js'
import {
  deriveHealth,
  initialReconciledState,
  normalizeDescription,
  parsePaneTaskList,
  reconcileTaskState,
  validateSnapshot,
  type PaneProvenance,
  type PaneSnapshot,
  type ReconciledState,
  type ReconciledTask,
  type SessionBinding,
  type ToolTaskEvent,
} from './task-reconciler.js'
import { formatUtcHm, type TaskFreshness } from './task-freshness.js'

// ─────────────────────────────────────────────────────────────────────
// Sink contract — the surfaces the reconciled view is pushed into.
// ─────────────────────────────────────────────────────────────────────

/** The reconciled task view a surface renders (reconciled list + freshness). */
export interface ReconciledView {
  sessionId: string
  todos: ReadonlyArray<TodoItem>
  freshness: TaskFreshness
}

/** A surface that can render a reconciled view (context HUD, TaskMirror). */
export interface ReconciledViewSink {
  applyReconciledView(chatId: string, view: ReconciledView): void | Promise<void>
}

// ─────────────────────────────────────────────────────────────────────
// Options.
// ─────────────────────────────────────────────────────────────────────

export interface TaskRealityMirrorOptions {
  exec: TmuxExec
  /** Pane the agent's task list renders in (reused from tmux_mirror config). */
  capture: PaneCaptureConfig
  log: Logger
  /** Surfaces to feed. Order is irrelevant; each is best-effort. */
  sinks: ReadonlyArray<ReconciledViewSink>
  /** Periodic capture cadence while a session is active. Default 20s. */
  captureIntervalMs?: number
  /** Coalesce window: triggers within this collapse to one capture. Default 5s. */
  coalesceWindowMs?: number
  /** Orphan-timer TTL: an idle non-active session parks its timer past this. Default 10min. */
  ttlMs?: number
  /** Owner-chat gate — the reconciler acts ONLY for owner DM chats. */
  isOwnerChat?: (chatId: string) => boolean
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

interface ChatRec {
  chatId: string
  sessionId: string
  binding: SessionBinding
  state: ReconciledState
  // Event-derived TodoItem map (same appliers the surfaces use) — kept so we
  // can emit ONLY the changed tasks as ToolTaskEvents (re-emitting unchanged
  // tasks would reset their updatedAt and wrongly out-rank pane snapshots).
  eventMap: Map<string, TodoItem>
  turnActive: boolean
  ended: boolean
  lastActivityMs: number
  periodicTimer: ReturnType<typeof setTimeout> | null
  coalesceTimer: ReturnType<typeof setTimeout> | null
  lastCaptureAt: number
  capturing: boolean
}

const DEFAULT_CAPTURE_INTERVAL_MS = 20_000
const DEFAULT_COALESCE_WINDOW_MS = 5_000
const DEFAULT_TTL_MS = 10 * 60 * 1000

export class TaskRealityMirror {
  private readonly exec: TmuxExec
  private readonly capture: PaneCaptureConfig
  private readonly log: Logger
  private readonly sinks: ReadonlyArray<ReconciledViewSink>
  private readonly captureIntervalMs: number
  private readonly coalesceWindowMs: number
  private readonly ttlMs: number
  private readonly isOwnerChat: (chatId: string) => boolean
  private readonly now: () => number
  private readonly setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  private readonly recs = new Map<string, ChatRec>()

  constructor(opts: TaskRealityMirrorOptions) {
    this.exec = opts.exec
    this.capture = opts.capture
    this.log = opts.log
    this.sinks = opts.sinks
    this.captureIntervalMs = opts.captureIntervalMs ?? DEFAULT_CAPTURE_INTERVAL_MS
    this.coalesceWindowMs = opts.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.isOwnerChat = opts.isOwnerChat ?? ((): boolean => true)
    this.now = opts.now ?? ((): number => Date.now())
    this.setTimer = opts.setTimer ?? ((cb, ms): ReturnType<typeof setTimeout> => setTimeout(cb, ms))
    this.clearTimer = opts.clearTimer ?? ((h): void => clearTimeout(h))
  }

  // ─── lifecycle entry points (called from the webhook dispatcher) ──────

  /** SessionStart: (re)bind, reset on a session change, arm the timer, capture now. */
  onSessionStart(chatId: string, opts: { sessionId: string; cwd?: string }): void {
    if (!this.isOwnerChat(chatId)) return
    try {
      const rec = this.ensureRec(chatId, opts.sessionId, opts.cwd)
      this.ensureSession(rec, opts.sessionId)
      rec.ended = false
      rec.lastActivityMs = this.now()
      this.pushView(rec)
      this.ensureTicking(rec)
      this.triggerCapture(rec, true)
    } catch (err) {
      this.warn('onSessionStart', chatId, err)
    }
  }

  /** UserPromptSubmit: a turn has begun — mark active, arm the timer, capture now. */
  onUserPromptSubmit(chatId: string, opts: { sessionId: string; cwd?: string }): void {
    if (!this.isOwnerChat(chatId)) return
    try {
      const rec = this.ensureRec(chatId, opts.sessionId, opts.cwd)
      this.ensureSession(rec, opts.sessionId)
      rec.ended = false
      rec.turnActive = true
      rec.lastActivityMs = this.now()
      this.pushView(rec)
      this.ensureTicking(rec)
      this.triggerCapture(rec, true)
    } catch (err) {
      this.warn('onUserPromptSubmit', chatId, err)
    }
  }

  /** Stop (turn-end): capture BEFORE closing the turn window, then go idle. */
  onStop(chatId: string): void {
    if (!this.isOwnerChat(chatId)) return
    const rec = this.recs.get(chatId)
    if (rec === undefined || rec.ended) return
    try {
      // Immediate capture while the turn is still "active" so a fresh list is
      // reconciled before the HUD refreshes; the window closes right after.
      this.triggerCapture(rec, true)
      rec.turnActive = false
      rec.lastActivityMs = this.now()
      this.pushView(rec)
    } catch (err) {
      this.warn('onStop', chatId, err)
    }
  }

  /**
   * SessionEnd (the REAL end): freeze the surface. Consumes the LATEST
   * reconciled state — does NOT capture (the pane may already be gone) — stops
   * the timers, and pushes a frozen «сессия завершена» view.
   */
  onSessionEnd(chatId: string, opts: { sessionId: string }): void {
    if (!this.isOwnerChat(chatId)) return
    const rec = this.recs.get(chatId)
    if (rec === undefined) return
    // Ignore a late SessionEnd naming a session we've already moved past.
    if (rec.sessionId !== opts.sessionId) return
    try {
      rec.ended = true
      rec.turnActive = false
      this.disarm(rec)
      this.pushView(rec)
    } catch (err) {
      this.warn('onSessionEnd', chatId, err)
    }
  }

  /** A task mutation event (TodoWrite / TaskCreate / TaskUpdate). */
  onTaskEvent(chatId: string, event: TaskMirrorEvent, opts: { cwd?: string } = {}): void {
    if (!this.isOwnerChat(chatId)) return
    if (!isTaskMutationEvent(event)) return // lifecycle handled by the entry points above
    try {
      const rec = this.ensureRec(chatId, event.sessionId, opts.cwd)
      this.ensureSession(rec, event.sessionId)
      rec.lastActivityMs = this.now()
      const now = this.now()
      for (const te of this.deriveToolEvents(rec, event, now)) {
        rec.state = reconcileTaskState(rec.state, { kind: 'event', event: te })
      }
      this.pushView(rec)
    } catch (err) {
      this.warn('onTaskEvent', chatId, err)
    }
  }

  /** Stop every timer (process shutdown). */
  stop(): void {
    for (const rec of this.recs.values()) this.disarm(rec)
  }

  // ─── per-chat state ──────────────────────────────────────────────────

  private ensureRec(chatId: string, sessionId: string, cwd?: string): ChatRec {
    let rec = this.recs.get(chatId)
    if (rec === undefined) {
      rec = {
        chatId,
        sessionId,
        binding: { sessionId, paneTarget: this.capture.paneTarget, cwd: cwd ?? '' },
        state: initialReconciledState(sessionId),
        eventMap: new Map(),
        turnActive: false,
        ended: false,
        lastActivityMs: this.now(),
        periodicTimer: null,
        coalesceTimer: null,
        // −∞ so the FIRST trigger always captures immediately (no 5s coalesce
        // wait on a brand-new session).
        lastCaptureAt: Number.NEGATIVE_INFINITY,
        capturing: false,
      }
      this.recs.set(chatId, rec)
    } else if (cwd !== undefined && cwd.length > 0 && rec.binding.cwd !== cwd) {
      rec.binding = { ...rec.binding, cwd }
    }
    return rec
  }

  // Reset state on a genuine session change (harness task ids restart at #1).
  private ensureSession(rec: ChatRec, sessionId: string): void {
    if (rec.sessionId === sessionId) return
    rec.sessionId = sessionId
    rec.binding = { ...rec.binding, sessionId }
    rec.state = initialReconciledState(sessionId)
    rec.eventMap = new Map()
    rec.ended = false
    rec.turnActive = false
  }

  // ─── capture scheduling ──────────────────────────────────────────────

  private ensureTicking(rec: ChatRec): void {
    if (rec.ended) return
    if (rec.periodicTimer !== null) return
    this.scheduleTick(rec)
  }

  private scheduleTick(rec: ChatRec): void {
    if (rec.ended) return
    rec.periodicTimer = this.setTimer(() => this.onTick(rec), this.captureIntervalMs)
  }

  private onTick(rec: ChatRec): void {
    rec.periodicTimer = null
    if (rec.ended) return
    const idle = this.now() - rec.lastActivityMs
    if (!rec.turnActive && idle > this.ttlMs) {
      // Orphan timer: a long-idle session with no SessionEnd. Park the timer
      // (stop rearming) — a fresh UserPromptSubmit / SessionStart restarts it.
      this.log.debug('task reality mirror timer parked (idle > ttl)', {
        chat_id: rec.chatId,
      })
      return
    }
    this.triggerCapture(rec, false)
    // Advance the freshness indicator (minute buckets) even if the capture is
    // async / a no-op; the sinks dedup identical renders.
    this.pushView(rec)
    this.scheduleTick(rec)
  }

  // Coalesce triggers within `coalesceWindowMs` into a single capture.
  private triggerCapture(rec: ChatRec, immediate: boolean): void {
    if (rec.ended) return
    const since = this.now() - rec.lastCaptureAt
    if (immediate && since >= this.coalesceWindowMs) {
      void this.doCapture(rec)
      return
    }
    if (rec.coalesceTimer !== null) return
    const wait = Math.max(0, this.coalesceWindowMs - since)
    if (wait === 0) {
      void this.doCapture(rec)
      return
    }
    rec.coalesceTimer = this.setTimer(() => {
      rec.coalesceTimer = null
      void this.doCapture(rec)
    }, wait)
  }

  private async doCapture(rec: ChatRec): Promise<void> {
    if (rec.capturing || rec.ended) return
    rec.capturing = true
    rec.lastCaptureAt = this.now()
    try {
      const cap = await capturePaneText(this.exec, this.capture)
      if (!cap.ok) {
        // No pane / capture failed — no snapshot. Refresh the indicator only
        // (health may transition to stale if a turn is active).
        this.pushView(rec)
        return
      }
      // Resolve the pane's cwd for provenance. When unobtainable, degrade by
      // reusing the binding cwd so validateSnapshot skips the cross-check
      // rather than false-flagging a mismatch (documented M3 degrade).
      const paneCwd = await resolvePaneCwd(this.exec, this.capture)
      const cwd = paneCwd ?? rec.binding.cwd
      const provenance: PaneProvenance = {
        sessionId: rec.binding.sessionId,
        paneTarget: this.capture.paneTarget,
        cwd,
        capturedAt: this.now(),
      }
      const snapshot = parsePaneTaskList(cap.text, provenance)
      if (snapshot === null) {
        // No task list in the pane. While IDLE this is normal (the harness does
        // not redraw the list between turns) — do NOT churn state; the last
        // valid snapshot stays rendered as verified. deriveHealth handles the
        // active-turn staleness case.
        this.pushView(rec)
        return
      }
      const verdict = validateSnapshot(snapshot, rec.binding)
      // §5 positional-alias pre-pass: re-key moved tasks to the snapshot's
      // ordinals by unique description so a genuine move is a merge, not a
      // remove+add. Only meaningful when the snapshot is authoritative.
      const base = verdict.authoritative ? realignOrdinals(rec.state, snapshot) : rec.state
      rec.state = reconcileTaskState(base, { kind: 'snapshot', snapshot, verdict })
      this.pushView(rec)
    } catch (err) {
      this.warn('doCapture', rec.chatId, err)
    } finally {
      rec.capturing = false
    }
  }

  private disarm(rec: ChatRec): void {
    if (rec.periodicTimer !== null) {
      this.clearTimer(rec.periodicTimer)
      rec.periodicTimer = null
    }
    if (rec.coalesceTimer !== null) {
      this.clearTimer(rec.coalesceTimer)
      rec.coalesceTimer = null
    }
  }

  // ─── view push ───────────────────────────────────────────────────────

  private pushView(rec: ChatRec): void {
    const view: ReconciledView = {
      sessionId: rec.sessionId,
      todos: reconciledToTodos(rec.state),
      freshness: this.computeFreshness(rec),
    }
    for (const sink of this.sinks) {
      try {
        const r = sink.applyReconciledView(rec.chatId, view)
        if (r instanceof Promise) {
          r.catch((err: unknown) => this.warn('sink.applyReconciledView', rec.chatId, err))
        }
      } catch (err) {
        // Guard a SYNCHRONOUS throw from a sink so it can't escape into a hook.
        this.warn('sink.applyReconciledView', rec.chatId, err)
      }
    }
  }

  private computeFreshness(rec: ChatRec): TaskFreshness {
    const now = this.now()
    if (rec.ended) {
      return {
        kind: 'ended',
        reconciledAtLabel: rec.state.lastReconciledAt > 0 ? formatUtcHm(rec.state.lastReconciledAt) : null,
      }
    }
    const health = deriveHealth(rec.state, now, rec.turnActive)
    if (health === 'unverified') return { kind: 'unverified' }
    if (health === 'stale') {
      const eventAgeMs = rec.state.lastEventAt > 0 ? now - rec.state.lastEventAt : now - rec.state.lastReconciledAt
      return { kind: 'stale', reconciledAgeMs: now - rec.state.lastReconciledAt, eventAgeMs }
    }
    return { kind: 'fresh', reconciledAgeMs: now - rec.state.lastReconciledAt }
  }

  // ─── tool-event derivation ───────────────────────────────────────────

  // Apply the mutation to the event-derived map, then emit ToolTaskEvents for
  // ONLY the tasks whose status/description actually changed (or are new). This
  // keeps unchanged tasks from re-stamping `updatedAt` and wrongly out-ranking
  // authoritative pane snapshots.
  private deriveToolEvents(rec: ChatRec, event: TaskMutationEvent, now: number): ToolTaskEvent[] {
    const pre = new Map(rec.eventMap)
    applyEventToEventMap(rec.eventMap, event)
    const out: ToolTaskEvent[] = []
    for (const [id, item] of rec.eventMap) {
      const prev = pre.get(id)
      if (
        prev !== undefined &&
        prev.status === item.status &&
        prev.content === item.content &&
        prev.activeForm === item.activeForm
      ) {
        continue
      }
      const ordinal = numericOrdinal(id)
      out.push({
        ...(ordinal !== undefined ? { ordinal } : {}),
        status: item.status,
        description: item.content,
        at: now,
      })
    }
    return out
  }

  private warn(where: string, chatId: string, err: unknown): void {
    this.log.warn(`task reality mirror ${where} failed (ignored)`, {
      chat_id: chatId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ─────────────────────────────────────────────────────────────────────
// Pure helpers (exported for tests).
// ─────────────────────────────────────────────────────────────────────

/** Numeric harness ordinal from a task id (`"3"` → 3), or undefined for non-numeric ids. */
export function numericOrdinal(id: string): number | undefined {
  return /^\d+$/.test(id) ? Number.parseInt(id, 10) : undefined
}

/** Apply a task mutation to an event-derived TodoItem map (same appliers the surfaces use). */
export function applyEventToEventMap(map: Map<string, TodoItem>, event: TaskMutationEvent): void {
  switch (event.kind) {
    case 'todo_write': {
      map.clear()
      event.todos.forEach((t, i) => {
        map.set(t.id !== undefined && t.id.length > 0 ? t.id : `todo-${i + 1}`, t)
      })
      return
    }
    case 'task_create':
      applyTaskCreateToMap(map, event)
      return
    case 'task_update':
      applyTaskUpdateToMap(map, event)
      return
  }
}

/** Project the reconciled state into the TodoItem list the surfaces render. */
export function reconciledToTodos(state: ReconciledState): TodoItem[] {
  return state.tasks.map((t) => {
    const content = t.descriptionTruncated ? `${t.description}…` : t.description
    const item: TodoItem = {
      id: t.ordinal !== null ? String(t.ordinal) : t.key,
      content,
      status: t.status,
    }
    return item
  })
}

/**
 * §5 positional-alias re-association. The live harness renders NO ordinals —
 * keys are positional — so a task that MOVES position looks like a
 * removal-at-old + addition-at-new to the reconciler's canonical-key merge,
 * which would churn the list. Before reconciling an authoritative snapshot,
 * re-key each committed pane-confirmed task to the snapshot ordinal that
 * uniquely matches its normalized description, but ONLY when the move is
 * genuine (the task's old ordinal is not itself present in the snapshot — that
 * would be a duplicate description, not a move). Genuine removals/regressions
 * keep the reconciler's two-snapshot rule untouched.
 *
 * PURE — returns a new state; `state` is not mutated. Coupled to the M2
 * canonical-key format `${sessionId}:#${ordinal}`.
 */
export function realignOrdinals(state: ReconciledState, snapshot: PaneSnapshot): ReconciledState {
  const sessionId = state.sessionId
  const keyOf = (ord: number): string => `${sessionId}:#${ord}`

  // Committed pane-confirmed tasks that can "move": have an ordinal, are pane
  // confirmed, and carry a non-truncated description we can match on.
  const committed = state.tasks.filter(
    (t): t is ReconciledTask & { ordinal: number } =>
      t.ordinal !== null && t.paneConfirmed && !t.descriptionTruncated,
  )
  // description → unique committed task (null marks an ambiguous description).
  const byDesc = new Map<string, (ReconciledTask & { ordinal: number }) | null>()
  for (const t of committed) {
    const d = normalizeDescription(t.description)
    byDesc.set(d, byDesc.has(d) ? null : t)
  }
  const snapOrdinals = new Set(snapshot.tasks.map((s) => s.ordinal))

  const remap = new Map<number, number>() // oldOrdinal → newOrdinal
  const takenNew = new Set<number>()
  for (const s of snapshot.tasks) {
    if (s.descriptionTruncated) continue
    const match = byDesc.get(normalizeDescription(s.description))
    if (match === undefined || match === null) continue
    const oldOrd = match.ordinal
    if (oldOrd === s.ordinal) continue // already correctly placed
    // Genuine SHIFT only: the task's old ordinal must be vacated in the new
    // snapshot. If the old ordinal is still present, the description appears in
    // two places (a positional SWAP or a duplicate) — ambiguous with positional
    // keys, so we leave it to the reconciler's two-snapshot rule.
    if (snapOrdinals.has(oldOrd)) continue
    if (remap.has(oldOrd) || takenNew.has(s.ordinal)) continue
    remap.set(oldOrd, s.ordinal)
    takenNew.add(s.ordinal)
  }
  if (remap.size === 0) return state

  // Apply the remap, then float the re-keyed tasks to the END so that if a
  // re-key target collides with a soon-to-be-removed committed occupant, the
  // re-keyed (correct) task wins the reconciler's by-key lookup.
  const remapped = new Set<ReconciledTask>()
  const mapped = state.tasks.map((t) => {
    if (t.ordinal !== null && remap.has(t.ordinal)) {
      const newOrd = remap.get(t.ordinal) as number
      const nt: ReconciledTask = { ...t, ordinal: newOrd, key: keyOf(newOrd) }
      remapped.add(nt)
      return nt
    }
    return t
  })
  const tasks = [...mapped.filter((t) => !remapped.has(t)), ...mapped.filter((t) => remapped.has(t))]

  // Re-key prevSnapshotFacts so the two-snapshot removal/regression rule stays
  // coherent after the move.
  const prevSnapshotFacts = new Map(state.prevSnapshotFacts)
  for (const [oldOrd, newOrd] of remap) {
    const oldKey = keyOf(oldOrd)
    const facts = prevSnapshotFacts.get(oldKey)
    prevSnapshotFacts.delete(oldKey)
    if (facts !== undefined) prevSnapshotFacts.set(keyOf(newOrd), facts)
  }

  return { ...state, tasks, prevSnapshotFacts }
}
