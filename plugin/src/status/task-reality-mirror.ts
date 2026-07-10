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
// Hardening (review fix-loop 2026-07-09):
//   • Generation token — every session change / end / eviction bumps
//     `rec.generation`; an in-flight doCapture re-checks it after EVERY await
//     and discards its work when stale, so old-pane output can never commit
//     into a new session binding.
//   • Session tombstones — a session that received SessionEnd is remembered
//     (bounded set); late mutations / prompts naming it are dropped instead of
//     resurrecting state. SessionStart with the same id (resume) un-tombstones.
//   • Hard TTL — a rec idle past `ttlMs` is EVICTED regardless of turnActive
//     (a missed Stop must not poll tmux + edit Telegram forever).
//   • Unresolved pane cwd ⇒ snapshot is OBSERVATIONAL (the cwd cross-check is
//     the one real provenance check; silently skipping it would neuter it).
//
// Degradation: when no pane is capturable (tmux absent, session gone, wrong
// pane), reconciliation produces no valid snapshot and the view renders
// «НЕ СВЕРЕНО» (events only) — the surfaces still show the optimistic list.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
  type SnapshotFacts,
  type SnapshotVerdict,
  type ToolTaskEvent,
} from './task-reconciler.js'
import { formatUtcHm, type TaskFreshness } from './task-freshness.js'
import type { LivenessMonitor } from './heartbeat-monitor.js'

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
  /** HARD inactivity TTL: a rec idle past this is evicted (timers stopped,
   *  state dropped) regardless of turnActive — a missed Stop must not keep
   *  polling forever. Default 10min. */
  ttlMs?: number
  /** Owner-chat gate — the reconciler acts ONLY for owner DM chats. */
  isOwnerChat?: (chatId: string) => boolean
  /** M4 mechanical liveness (heartbeat + dead-man + open-question reminders).
   *  Optional and best-effort: when omitted the reconciler behaves exactly as
   *  before. Fed the pane captures (its dead-man diffs the SAME capture this
   *  file already runs — no second capture path) and evaluated once per tick. */
  liveness?: LivenessMonitor
  /** Plugin state dir. When set, the session-epoch state (active + retired
   *  tombstones) is persisted per chat (`task-reality-epoch-<chat>.json`) so a
   *  plugin restart cannot be rolled back by late lifecycle stragglers
   *  (review 2026-07-10 r3 #1). Omitted in unit tests that don't exercise it. */
  stateDir?: string
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
  // Monotonic OBSERVATION REVISION (review 2026-07-10 #3). Bumped on EVERY
  // state mutation: tool events, session change/end, eviction, cwd rebind.
  // doCapture snapshots it at entry and re-checks after every await; a
  // mismatch means the pane text predates a state change (e.g. a TodoWrite
  // landed during the cwd-resolution await) and the capture is discarded —
  // otherwise old pane text would be stamped POST-event and committed,
  // defeating both per-task recency and the stale-fact protection.
  revision: number
  // Event-sourced removal tombstones (review 2026-07-10 #4): canonical key →
  // event time of the TodoWrite that authoritatively removed a PANE-CONFIRMED
  // task. A pane snapshot NEWER than the tombstone clears it (pane is the
  // higher authority — it may resurrect the task or confirm the removal); a
  // stale/older pane snapshot may NOT resurrect it. Without tmux the
  // tombstone wins outright. Cleared on session change.
  eventRemovedAt: Map<string, number>
}

const DEFAULT_CAPTURE_INTERVAL_MS = 20_000
const DEFAULT_COALESCE_WINDOW_MS = 5_000
const DEFAULT_TTL_MS = 10 * 60 * 1000
// Bounded per-chat memory of ended (tombstoned) session ids. 64 (review
// 2026-07-10 #2): at 8, a burst of short sessions evicted older tombstones and
// their late stragglers became «unknown» again, able to switch epochs.
const MAX_TOMBSTONES = 64

export class TaskRealityMirror {
  private readonly exec: TmuxExec
  private readonly capture: PaneCaptureConfig
  private readonly log: Logger
  private readonly sinks: ReadonlyArray<ReconciledViewSink>
  private readonly captureIntervalMs: number
  private readonly coalesceWindowMs: number
  private readonly ttlMs: number
  private readonly isOwnerChat: (chatId: string) => boolean
  private readonly liveness: LivenessMonitor | undefined
  private readonly now: () => number
  private readonly setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  private readonly recs = new Map<string, ChatRec>()
  private readonly stateDir: string | undefined
  // Per-chat tombstones: session ids that received SessionEnd. Late events
  // naming a tombstoned session are dropped — they must never finalize/clear
  // the ACTIVE session or resurrect the retired one. SessionStart with the
  // same id (a genuine resume) removes the tombstone.
  private readonly endedSessions = new Map<string, Set<string>>()
  // Per-chat ACTIVE session id — survives rec eviction (unlike recs) and, via
  // persistence, plugin restarts. Cleared by SessionEnd; kept by hard-TTL
  // eviction (the session never ended, it just went silent).
  private readonly activeSessions = new Map<string, string>()
  // Chats whose persisted epoch state has been restored this process lifetime.
  private readonly epochsRestored = new Set<string>()

  constructor(opts: TaskRealityMirrorOptions) {
    this.exec = opts.exec
    this.capture = opts.capture
    this.log = opts.log
    this.sinks = opts.sinks
    this.captureIntervalMs = opts.captureIntervalMs ?? DEFAULT_CAPTURE_INTERVAL_MS
    this.coalesceWindowMs = opts.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.isOwnerChat = opts.isOwnerChat ?? ((): boolean => true)
    this.liveness = opts.liveness
    this.stateDir = opts.stateDir
    this.now = opts.now ?? ((): number => Date.now())
    this.setTimer = opts.setTimer ?? ((cb, ms): ReturnType<typeof setTimeout> => setTimeout(cb, ms))
    this.clearTimer = opts.clearTimer ?? ((h): void => clearTimeout(h))
  }

  // ─── lifecycle entry points (called from the webhook dispatcher) ──────

  /** SessionStart: (re)bind, reset on a session change, arm the timer, capture now. */
  onSessionStart(chatId: string, opts: { sessionId: string; cwd?: string }): void {
    if (!this.isOwnerChat(chatId)) return
    try {
      this.restoreEpochs(chatId)
      // Rollback guard (review 2026-07-10 #2): a SessionStart naming a
      // TOMBSTONED id while a DIFFERENT session is active is a late/replayed
      // straggler — it must NOT displace the active session. A resume of a
      // tombstoned id is valid only when no different session is active.
      // «Active» comes from activeSessions (persisted, survives restart —
      // review 2026-07-10 r3 #1), not the transient rec.
      if (this.isTombstoned(chatId, opts.sessionId)) {
        const active = this.activeSessions.get(chatId)
        if (active !== undefined && active !== opts.sessionId) {
          this.log.debug('task reality mirror dropped late SessionStart for tombstoned session', {
            chat_id: chatId,
          })
          return
        }
        // Genuine RESUME — the harness is alive again under the same id.
        this.untombstone(chatId, opts.sessionId)
        this.persistEpochs(chatId)
      }
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
    this.restoreEpochs(chatId)
    if (this.isTombstoned(chatId, opts.sessionId)) return // late event from a retired session
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
      // M4: the turn ended — clear the heartbeat pin suffix and reset the
      // per-turn heartbeat/dead-man budget. Best-effort (the monitor swallows).
      this.liveness?.onTurnEnd(chatId)
    } catch (err) {
      this.warn('onStop', chatId, err)
    }
  }

  /**
   * SessionEnd (the REAL end): freeze the surface. Consumes the LATEST
   * reconciled state — does NOT capture (the pane may already be gone) —
   * pushes a frozen «сессия завершена» view, tombstones the session id, then
   * EVICTS the rec (timers stopped, in-flight captures invalidated). A late
   * SessionEnd naming a session we've already moved past only tombstones it.
   */
  onSessionEnd(chatId: string, opts: { sessionId: string }): void {
    if (!this.isOwnerChat(chatId)) return
    try {
      this.restoreEpochs(chatId)
      this.tombstone(chatId, opts.sessionId)
      if (this.activeSessions.get(chatId) === opts.sessionId) {
        this.activeSessions.delete(chatId)
      }
      this.persistEpochs(chatId)
      const rec = this.recs.get(chatId)
      if (rec === undefined) return
      // Late end for a retired session: never touch the active rec.
      if (rec.sessionId !== opts.sessionId) return
      rec.ended = true
      rec.turnActive = false
      this.pushView(rec) // frozen ended view goes out BEFORE the state is dropped
      this.evict(rec)
    } catch (err) {
      this.warn('onSessionEnd', chatId, err)
    }
  }

  /** A task mutation event (TodoWrite / TaskCreate / TaskUpdate). */
  onTaskEvent(chatId: string, event: TaskMirrorEvent, opts: { cwd?: string } = {}): void {
    if (!this.isOwnerChat(chatId)) return
    if (!isTaskMutationEvent(event)) return // lifecycle handled by the entry points above
    this.restoreEpochs(chatId)
    if (this.isTombstoned(chatId, event.sessionId)) return // retired session — drop
    try {
      const rec = this.ensureRec(chatId, event.sessionId, opts.cwd)
      this.ensureSession(rec, event.sessionId)
      rec.lastActivityMs = this.now()
      const now = this.now()
      if (event.kind === 'todo_write') {
        // TodoWrite IS the harness's own full list — treat it as an
        // authoritative event snapshot INCLUDING removals, and preserve the
        // event ids so identical descriptions stay distinct tasks (review
        // 2026-07-09 #5: the per-task delta path lost removals in the
        // events-only degrade ⇒ ghosts forever without tmux).
        applyEventToEventMap(rec.eventMap, event) // keep the map coherent for later task_update matching
        const applied = applyTodoWriteToState(rec.state, event.todos, now)
        rec.state = applied.state
        // Removed PANE-CONFIRMED tasks get a versioned tombstone (review
        // 2026-07-10 #4): only a NEWER pane snapshot may resurrect them.
        for (const r of applied.removals) rec.eventRemovedAt.set(r.key, r.at)
        // A TodoWrite that REINTRODUCES a removed key reasserts the task with
        // full event authority — its tombstone must be CLEARED, or an
        // equal-millisecond pane snapshot would delete the valid re-addition
        // via enforceEventRemovals (review 2026-07-10 r3 #3).
        for (const key of [...rec.eventRemovedAt.keys()]) {
          if (rec.state.tasks.some((t) => t.key === key)) rec.eventRemovedAt.delete(key)
        }
        while (rec.eventRemovedAt.size > 64) {
          const oldest = rec.eventRemovedAt.keys().next().value
          if (oldest === undefined) break
          rec.eventRemovedAt.delete(oldest)
        }
      } else {
        for (const te of this.deriveToolEvents(rec, event, now)) {
          rec.state = reconcileTaskState(rec.state, { kind: 'event', event: te })
        }
      }
      // Every event application invalidates in-flight captures (their pane
      // text predates this state change) — review 2026-07-10 #3.
      rec.revision += 1
      this.pushView(rec)
    } catch (err) {
      this.warn('onTaskEvent', chatId, err)
    }
  }

  /** Stop every timer and invalidate in-flight captures (process shutdown). */
  stop(): void {
    for (const rec of [...this.recs.values()]) this.evict(rec)
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
        revision: 0,
        eventRemovedAt: new Map(),
      }
      this.recs.set(chatId, rec)
      this.setActive(chatId, sessionId)
    } else if (cwd !== undefined && cwd.length > 0 && rec.binding.cwd !== cwd) {
      rec.binding = { ...rec.binding, cwd }
      // A binding change invalidates in-flight captures (their provenance was
      // resolved against the old cwd) — review 2026-07-10 #3.
      rec.revision += 1
    }
    return rec
  }

  // Reset state on a genuine session change (harness task ids restart at #1).
  // Bumps the revision so any in-flight capture from the OLD session binding
  // discards itself instead of committing old-pane output into the new state.
  private ensureSession(rec: ChatRec, sessionId: string): void {
    if (rec.sessionId === sessionId) return
    rec.revision += 1
    rec.sessionId = sessionId
    rec.binding = { ...rec.binding, sessionId }
    rec.state = initialReconciledState(sessionId)
    rec.eventMap = new Map()
    rec.eventRemovedAt = new Map()
    rec.ended = false
    rec.turnActive = false
    this.setActive(rec.chatId, sessionId)
  }

  // Track (and persist) the active session id for the chat.
  private setActive(chatId: string, sessionId: string): void {
    if (this.activeSessions.get(chatId) === sessionId) return
    this.activeSessions.set(chatId, sessionId)
    this.persistEpochs(chatId)
  }

  // Drop a rec entirely: timers disarmed, in-flight captures invalidated via
  // the revision bump, entry removed from the map. Used by SessionEnd, the
  // hard TTL and stop().
  private evict(rec: ChatRec): void {
    this.disarm(rec)
    rec.revision += 1
    if (this.recs.get(rec.chatId) === rec) this.recs.delete(rec.chatId)
    // M4: the session is gone (SessionEnd / hard TTL / shutdown) — drop the
    // liveness state for this chat so no heartbeat/dead-man fires for a dead
    // session. Best-effort.
    this.liveness?.onChatGone(rec.chatId)
  }

  // ─── tombstones ──────────────────────────────────────────────────────

  private tombstone(chatId: string, sessionId: string): void {
    let set = this.endedSessions.get(chatId)
    if (set === undefined) {
      set = new Set()
      this.endedSessions.set(chatId, set)
    }
    set.delete(sessionId) // re-add moves it to the tail (freshest)
    set.add(sessionId)
    while (set.size > MAX_TOMBSTONES) {
      const oldest = set.values().next().value
      if (oldest === undefined) break
      set.delete(oldest)
    }
  }

  private untombstone(chatId: string, sessionId: string): void {
    this.endedSessions.get(chatId)?.delete(sessionId)
  }

  private isTombstoned(chatId: string, sessionId: string): boolean {
    return this.endedSessions.get(chatId)?.has(sessionId) === true
  }

  // ─── epoch persistence (review 2026-07-10 r3 #1) ─────────────────────
  // The reality mirror's epoch state (active session + retired tombstones)
  // was process-local: after a restart a late SessionStart for a session that
  // ended PRE-restart displaced the restored active one. Persisted per chat
  // in its own schema-versioned file with the same atomic tmp+rename pattern
  // as TaskMirror. Best-effort: persistence failures never disturb the mirror.

  private epochPath(chatId: string): string {
    const safe = chatId.replace(/[^0-9A-Za-z_-]/g, '_')
    return join(this.stateDir as string, `task-reality-epoch-${safe}.json`)
  }

  private persistEpochs(chatId: string): void {
    if (this.stateDir === undefined) return
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      const active = this.activeSessions.get(chatId)
      const retired = this.endedSessions.get(chatId)
      const body = {
        v: 1,
        ...(active !== undefined ? { active } : {}),
        retired: retired !== undefined ? [...retired] : [],
      }
      const path = this.epochPath(chatId)
      const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
      writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 })
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
      this.warn('persistEpochs', chatId, err)
    }
  }

  // Restore persisted epoch state ONCE per chat; runtime state is never
  // clobbered. Called at the top of every lifecycle/event entry point so the
  // tombstone checks always see post-restart truth.
  private restoreEpochs(chatId: string): void {
    if (this.epochsRestored.has(chatId)) return
    this.epochsRestored.add(chatId)
    if (this.stateDir === undefined) return
    try {
      const raw = readFileSync(this.epochPath(chatId), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
      const obj = parsed as Record<string, unknown>
      if (
        typeof obj.active === 'string' &&
        obj.active.length > 0 &&
        !this.activeSessions.has(chatId)
      ) {
        this.activeSessions.set(chatId, obj.active)
      }
      if (Array.isArray(obj.retired) && !this.endedSessions.has(chatId)) {
        const retired = obj.retired
          .filter((s): s is string => typeof s === 'string' && s.length > 0)
          .slice(-MAX_TOMBSTONES)
        if (retired.length > 0) this.endedSessions.set(chatId, new Set(retired))
      }
    } catch {
      // Missing file / malformed JSON → nothing persisted.
    }
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
    if (idle > this.ttlMs) {
      // HARD TTL (review 2026-07-09 #6): evict regardless of turnActive — a
      // missed Stop would otherwise leave turnActive=true and the timer would
      // poll tmux + cross age buckets + edit Telegram forever. A fresh
      // SessionStart / UserPromptSubmit rebuilds the rec from scratch.
      //
      // Terminal push FIRST (review 2026-07-10 #7): without it the surfaces
      // would keep showing «сверено меньше минуты назад» forever for data
      // nobody updates any more. One frozen «данные не обновляются» view goes
      // out, THEN state is dropped and in-flight captures invalidated.
      this.log.debug('task reality mirror rec evicted (idle > ttl)', {
        chat_id: rec.chatId,
        idle_ms: idle,
      })
      this.pushView(rec, { kind: 'expired' })
      this.evict(rec)
      return
    }
    this.triggerCapture(rec, false)
    // Advance the freshness indicator (minute buckets) even if the capture is
    // async / a no-op; the sinks dedup identical renders.
    this.pushView(rec)
    // M4: per-tick heartbeat + open-question reminder evaluation. Dead-man is
    // driven separately from doCapture (it needs the fresh pane hash). Passes
    // the reconciled in-progress task so a heartbeat names what we're doing.
    this.liveness?.evaluate(rec.chatId, {
      turnActive: rec.turnActive,
      inProgressTask: currentInProgressTask(rec.state),
      nowMs: this.now(),
    })
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
    // Observation-revision snapshot (review 2026-07-10 #3): if ANY state
    // mutation lands while one of the awaits below is pending (a tool event, a
    // session change/end, a cwd rebind), the captured pane text predates that
    // mutation and MUST be discarded — re-checked after EVERY await.
    const rev = rec.revision
    try {
      const cap = await capturePaneText(this.exec, this.capture)
      if (rec.revision !== rev || rec.ended) return
      // M4 dead-man: feed the SAME capture to the liveness monitor (no second
      // capture path). Only meaningful when the pane was actually read (ok);
      // a failed capture yields no hash to diff. Best-effort.
      if (this.liveness !== undefined && cap.ok) {
        this.liveness.observePane(rec.chatId, cap.text, this.now(), rec.turnActive)
      }
      // Stamp capturedAt NOW — the moment capture-pane returned — so an event
      // landing during the cwd resolution below can never be out-ranked by
      // this (older) pane text (review 2026-07-10 #3).
      const capturedAt = this.now()
      if (!cap.ok) {
        // No pane / capture failed — no snapshot. Refresh the indicator only
        // (health may transition to stale if a turn is active).
        this.pushView(rec)
        return
      }
      // Resolve the pane's cwd for provenance. When UNRESOLVABLE the snapshot
      // degrades to OBSERVATIONAL (review 2026-07-09 #9): the cwd cross-check
      // is the one provenance check with real signal here; substituting the
      // binding cwd would make validation unconditionally pass and neuter it.
      const paneCwd = await resolvePaneCwd(this.exec, this.capture)
      if (rec.revision !== rev || rec.ended) return
      const provenance: PaneProvenance = {
        sessionId: rec.binding.sessionId,
        paneTarget: this.capture.paneTarget,
        cwd: paneCwd ?? '',
        capturedAt,
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
      const verdict: SnapshotVerdict =
        paneCwd === null
          ? { authoritative: false, reasons: ['cwd_mismatch'] }
          : validateSnapshot(snapshot, rec.binding)
      // §5 positional-alias pre-pass: re-key moved tasks to the snapshot's
      // ordinals by unique description so a genuine move is a merge, not a
      // remove+add. Only meaningful when the snapshot is authoritative.
      const base = verdict.authoritative ? realignOrdinals(rec.state, snapshot) : rec.state
      rec.state = reconcileTaskState(base, { kind: 'snapshot', snapshot, verdict })
      // Event-removal tombstones (review 2026-07-10 #4): only a pane snapshot
      // NEWER than the removing TodoWrite may resurrect (or finally confirm the
      // absence of) a removed task; a stale one may not re-add it.
      if (verdict.authoritative && rec.eventRemovedAt.size > 0) {
        rec.state = enforceEventRemovals(rec.state, rec.eventRemovedAt, capturedAt)
      }
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

  private pushView(rec: ChatRec, freshnessOverride?: TaskFreshness): void {
    const view: ReconciledView = {
      sessionId: rec.sessionId,
      todos: reconciledToTodos(rec.state),
      freshness: freshnessOverride ?? this.computeFreshness(rec),
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

  // ─── tool-event derivation (TaskCreate / TaskUpdate only) ─────────────

  // Apply the mutation to the event-derived map, then emit ToolTaskEvents for
  // ONLY the tasks whose status/description actually changed (or are new). This
  // keeps unchanged tasks from re-stamping `updatedAt` and wrongly out-ranking
  // authoritative pane snapshots. TodoWrite takes the applyTodoWriteToState
  // path instead (full replacement including removals).
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

/**
 * The description of the FIRST in-progress reconciled task (what the heartbeat
 * names as «работаю: …»), or null when nothing is marked in-progress. Uses the
 * same projection the surfaces render so the label matches the pin exactly.
 */
export function currentInProgressTask(state: ReconciledState): string | null {
  const hit = reconciledToTodos(state).find((t) => t.status === 'in_progress')
  return hit !== undefined ? hit.content : null
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
 * Fold a TodoWrite payload into the reconciled state as an AUTHORITATIVE event
 * snapshot (review 2026-07-09 #5). TodoWrite is the harness's own full task
 * list, so unlike the per-task delta path it must express REMOVALS: an
 * event-only task absent from the payload is gone; a PANE-CONFIRMED task
 * absent from the payload is removed too, and reported in `removals` so the
 * caller can record a VERSIONED removal tombstone (review 2026-07-10 #4 —
 * pre-fix `|| t.paneConfirmed` kept it alive, and if tmux died afterwards the
 * ghost lived forever). Resurrection policy lives in
 * {@link enforceEventRemovals}: only a pane snapshot NEWER than the tombstone
 * may bring the task back.
 *
 * Event ids are preserved in the task keys (`${sessionId}:~id:<id>` for
 * non-numeric ids, canonical `#N` for numeric ones) so two tasks with
 * IDENTICAL descriptions remain distinct instead of collapsing into one
 * provisional keyed by description.
 *
 * Unchanged matched tasks keep their `updatedAt` untouched, so pane snapshots
 * retain recency authority over them. PURE — returns a new state + removals.
 */
export interface TodoWriteApplied {
  state: ReconciledState
  /** Pane-confirmed tasks the payload omitted — tombstone material. */
  removals: ReadonlyArray<{ key: string; at: number }>
}

export function applyTodoWriteToState(
  state: ReconciledState,
  todos: ReadonlyArray<TodoItem>,
  at: number,
): TodoWriteApplied {
  const sessionId = state.sessionId
  const tasks = state.tasks.map((t) => ({ ...t }))
  const byKey = new Map(tasks.map((t) => [t.key, t]))
  const matched = new Set<ReconciledTask>()
  const additions: ReconciledTask[] = []

  todos.forEach((todo, i) => {
    const id = todo.id !== undefined && todo.id.length > 0 ? todo.id : `todo-${i + 1}`
    const ordinal = numericOrdinal(id)
    const key = ordinal !== undefined ? `${sessionId}:#${ordinal}` : `${sessionId}:~id:${id}`
    let target = byKey.get(key)
    if ((target === undefined || matched.has(target)) && ordinal === undefined) {
      // Fall back to a UNIQUE normalized-description match among not-yet-matched
      // tasks so an id-less rewrite can attach to a pane-confirmed row.
      const norm = normalizeDescription(todo.content)
      const hits = tasks.filter(
        (t) =>
          !matched.has(t) &&
          !t.descriptionTruncated &&
          normalizeDescription(t.description) === norm,
      )
      if (hits.length === 1) target = hits[0]
    }
    if (target !== undefined && !matched.has(target)) {
      matched.add(target)
      const changed = target.status !== todo.status || target.description !== todo.content
      if (changed && at >= target.updatedAt) {
        target.status = todo.status
        target.description = todo.content
        target.descriptionTruncated = false
        target.source = 'event'
        target.updatedAt = at
      }
      return
    }
    additions.push({
      key,
      ordinal: ordinal ?? null,
      status: todo.status,
      description: todo.content,
      descriptionTruncated: false,
      source: 'event',
      provisional: ordinal === undefined,
      paneConfirmed: false,
      updatedAt: at,
    })
  })

  // Removals: any task absent from the full list is authoritatively gone,
  // unless a NEWER observation touched it. Pane-confirmed removals are
  // reported so the caller can tombstone them (resurrection is then gated on
  // pane-snapshot recency in enforceEventRemovals).
  const removals: Array<{ key: string; at: number }> = []
  const kept = tasks.filter((t) => {
    if (matched.has(t) || t.updatedAt > at) return true
    if (t.paneConfirmed) removals.push({ key: t.key, at })
    return false
  })

  return {
    state: {
      ...state,
      tasks: [...kept, ...additions],
      lastEventAt: Math.max(state.lastEventAt, at),
    },
    removals,
  }
}

/**
 * Enforce event-sourced removal tombstones against a freshly reconciled state
 * (review 2026-07-10 #4). For each tombstoned key:
 *   • pane snapshot NEWER than the tombstone ⇒ the pane (higher authority)
 *     has spoken since the removal — drop the tombstone; whatever the
 *     reconciler decided (resurrect or omit) stands;
 *   • pane snapshot OLDER/equal ⇒ a stale pane may NOT resurrect the task —
 *     filter it back out and KEEP the tombstone.
 * Without tmux this function is never reached and the removal (already
 * applied by applyTodoWriteToState) simply wins. PURE over `state`; mutates
 * ONLY the passed tombstone map (deliberate — it is the caller's own record).
 */
export function enforceEventRemovals(
  state: ReconciledState,
  removedAt: Map<string, number>,
  snapshotCapturedAt: number,
): ReconciledState {
  let tasks: ReadonlyArray<ReconciledTask> = state.tasks
  for (const [key, at] of removedAt) {
    if (snapshotCapturedAt > at) {
      removedAt.delete(key)
      continue
    }
    if (tasks.some((t) => t.key === key)) {
      tasks = tasks.filter((t) => t.key !== key)
    }
  }
  return tasks === state.tasks ? state : { ...state, tasks }
}

/**
 * §5 positional-alias re-association. The live harness renders NO ordinals —
 * keys are positional — so a task that MOVES position looks like a
 * removal-at-old + addition-at-new to the reconciler's canonical-key merge,
 * which would churn the list. Before reconciling an authoritative snapshot,
 * re-key each committed pane-confirmed task to the snapshot ordinal that
 * uniquely matches its normalized description, but ONLY when the move is a
 * clean SHIFT (the task's old ordinal is vacated in the snapshot — an ordinal
 * still present would mean a duplicate description or a positional swap, both
 * ambiguous with positional keys).
 *
 * FULL PERMUTATION (review 2026-07-10 #8): movers are computed for ALL
 * snapshot tasks SIMULTANEOUSLY over unique exact normalized descriptions and
 * applied atomically. The old per-mover «old ordinal must be vacated» guard
 * broke CHAINS ([A,B,C,D] → [A,C,D]: C 3→2 was refused because ordinal 3 was
 * still present — it belongs to D's new slot — so B kept key #2 an extra
 * cycle and an ordinal-2 event updated the WRONG task). Duplicate committed
 * descriptions stay ambiguous (never matched); a snapshot task whose unique
 * committed match was already consumed by an earlier snapshot row (duplicate
 * descriptions in the SNAPSHOT) is skipped.
 *
 * DISPLACEMENT (review 2026-07-09 #7, resolved by test): a mover's target
 * ordinal may currently be held by a DIFFERENT committed task — e.g.
 * [A#1,B#2,C#3] → [A#1,C#2]: C moves 3→2 while B still holds key #2. Stomping
 * B's key would let the reconciler's consumedKeys pass swallow B and delete it
 * on the FIRST omission, violating the two-snapshot anti-flap contract. So the
 * displaced task is MOVED to a free ordinal (a vacated mover ordinal, else one
 * past the end), carrying its prev-snapshot facts, and thereby survives as a
 * first-omission candidate — dropped only by the SECOND consecutive omission.
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

  // A description participates in the permutation ONLY when it is unique on
  // BOTH sides (review 2026-07-10 r3 #4): `byDesc` already nulls committed
  // duplicates; this counts the SNAPSHOT side — committed [X#1, A#2] against
  // snapshot [A#1, A#2] must not remap A (which copy is which is ambiguous).
  const snapDescCount = new Map<string, number>()
  for (const s of snapshot.tasks) {
    if (s.descriptionTruncated) continue
    const d = normalizeDescription(s.description)
    snapDescCount.set(d, (snapDescCount.get(d) ?? 0) + 1)
  }

  // Full simultaneous permutation over descriptions unique on both sides (#8).
  const consumed = new Set<ReconciledTask>()
  const remap = new Map<number, number>() // mover oldOrdinal → newOrdinal
  const takenNew = new Set<number>()
  for (const s of snapshot.tasks) {
    if (s.descriptionTruncated) continue
    const d = normalizeDescription(s.description)
    if (snapDescCount.get(d) !== 1) continue // duplicated in the snapshot — ambiguous
    const match = byDesc.get(d)
    if (match === undefined || match === null) continue
    if (consumed.has(match)) continue // defensive (unreachable with unique counts)
    consumed.add(match)
    if (match.ordinal === s.ordinal) continue // already correctly placed
    if (takenNew.has(s.ordinal)) continue
    remap.set(match.ordinal, s.ordinal)
    takenNew.add(s.ordinal)
  }
  if (remap.size === 0) return state

  // Displacement pass: any committed task sitting on a mover's TARGET ordinal
  // (and not itself a mover) must be re-keyed away so no duplicate keys exist
  // and the two-snapshot omission rule still sees it (see docstring).
  const moverNewOrds = new Set(remap.values())
  const allOrds = new Set<number>(snapOrdinals)
  for (const t of state.tasks) if (t.ordinal !== null) allOrds.add(t.ordinal)
  // Free pool: vacated mover ordinals that are not themselves targets and not
  // in the snapshot; fallback: ordinals past the maximum in play.
  const pool = [...remap.keys()].filter((o) => !moverNewOrds.has(o) && !snapOrdinals.has(o))
  let overflow = Math.max(0, ...allOrds) + 1
  const nextFree = (): number => {
    const fromPool = pool.shift()
    if (fromPool !== undefined) return fromPool
    while (snapOrdinals.has(overflow) || moverNewOrds.has(overflow)) overflow += 1
    const out = overflow
    overflow += 1
    return out
  }
  const displacedRemap = new Map<number, number>()
  for (const t of state.tasks) {
    if (t.ordinal === null) continue
    if (!moverNewOrds.has(t.ordinal)) continue // not on a mover's target
    if (remap.has(t.ordinal)) continue // it is itself a mover (its key moves anyway)
    if (displacedRemap.has(t.ordinal)) continue
    displacedRemap.set(t.ordinal, nextFree())
  }

  const combined = new Map<number, number>([...remap, ...displacedRemap])

  const tasks = state.tasks.map((t) => {
    if (t.ordinal !== null && combined.has(t.ordinal)) {
      const newOrd = combined.get(t.ordinal) as number
      return { ...t, ordinal: newOrd, key: keyOf(newOrd) }
    }
    return t
  })

  // Re-key prevSnapshotFacts alongside (two-phase so chains/swaps of keys
  // can't clobber each other) — the omission/regression confirmations must
  // follow the tasks they describe.
  const prevSnapshotFacts = new Map<string, SnapshotFacts>(state.prevSnapshotFacts)
  const liftedFacts = new Map<number, SnapshotFacts>()
  for (const [oldOrd] of combined) {
    const facts = prevSnapshotFacts.get(keyOf(oldOrd))
    if (facts !== undefined) {
      liftedFacts.set(oldOrd, facts)
      prevSnapshotFacts.delete(keyOf(oldOrd))
    }
  }
  for (const [oldOrd, newOrd] of combined) {
    const facts = liftedFacts.get(oldOrd)
    if (facts !== undefined) prevSnapshotFacts.set(keyOf(newOrd), facts)
  }

  return { ...state, tasks, prevSnapshotFacts }
}
