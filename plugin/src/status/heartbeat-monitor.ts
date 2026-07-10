// HeartbeatMonitor — mechanical liveness for the owner channel (M4, 2026-07-10
// communication audit). Three failure modes the audit surfaced become
// automatic, so the owner stops having to ask «Статус?»:
//
//   1. HEARTBEAT — during an active turn, when the owner has heard nothing for
//      >25 min, append a no-ping «работаю: <task> · HH:MM» suffix to the
//      context pin; past >60 min send ONE real message «Работаю дольше часа без
//      отчёта: <task>. Продолжаю.» (rate-limited to ~one per hour per turn).
//   2. DEAD-MAN — during an active turn, when the tmux pane hash has not
//      changed for >10 min (a likely OOM / hang) and no Stop arrived, send ONE
//      alert «Сессия молчит >10 мин при активном ходе — возможно OOM/зависание».
//   3. OPEN-QUESTION REMINDER — when a question to the owner crosses 2h unanswered
//      send ONE reminder naming the default; a sticky (security) question is
//      instead re-reminded at most every 6h. This only REMINDS — bypassing an
//      open question is the agent's own protocol action, never taken here.
//
// Architectural invariants (binding, from the M4 brief):
//   • This path NEVER reads or touches lease TTLs / scope — it only reads open
//     QUESTIONS, read-only via loadAutonomyState (no writer lock taken).
//   • Best-effort + isolated: every public method swallows its own errors and
//     every send/pin callback is fire-and-forget with `.catch`, so a failure
//     here can NEVER break normal reply delivery.
//   • The pane hash + capture are supplied by the caller (TaskRealityMirror,
//     the single pane-capture owner) — this module adds NO second capture path.
//
// State is in-memory only. Persistence is deliberately omitted: after a plugin
// restart a 2h reminder or a heartbeat may re-fire once — an acceptable
// duplicate, and the safe direction (a redundant nudge, never a missed one).

import { createHash } from 'node:crypto'

import type { Logger } from '../log.js'
import type { AutonomyPaths } from '../autonomy/store.js'
import { loadAutonomyState, openQuestions, questionAgeMs } from '../autonomy/store.js'
import { formatUtcHm } from './task-freshness.js'

// The narrow surface TaskRealityMirror drives. Kept as an interface so the
// mirror depends on a stub in tests and never imports the concrete class.
export interface LivenessMonitor {
  /** Feed one pane capture (raw text) taken during an active/idle session. */
  observePane(chatId: string, paneText: string, nowMs: number, turnActive: boolean): void
  /** Per-tick evaluation of the heartbeat + open-question reminders. */
  evaluate(
    chatId: string,
    ctx: { turnActive: boolean; inProgressTask: string | null; nowMs: number },
  ): void
  /** A turn ended (Stop) — clear the pin suffix + reset the per-turn budget. */
  onTurnEnd(chatId: string): void
  /** The chat's session is gone (SessionEnd / TTL evict) — drop all state. */
  onChatGone(chatId: string): void
}

const DEFAULTS = {
  pinAfterMs: 25 * 60 * 1000,
  messageAfterMs: 60 * 60 * 1000,
  messageMinIntervalMs: 60 * 60 * 1000,
  deadmanMs: 10 * 60 * 1000,
  questionReminderMs: 2 * 60 * 60 * 1000,
  stickyReminderMs: 6 * 60 * 60 * 1000,
} as const

const TASK_LABEL_MAX = 80

export interface HeartbeatMonitorOptions {
  log: Logger
  /** Send a real (pinging) message — server wires the rate-limited/reliable api. */
  send: (chatId: string, text: string) => Promise<void>
  /** Set/clear the no-ping pin suffix — server wires ContextHud.setHeartbeatSuffix. */
  pinHeartbeat?: (chatId: string, suffix: string | null) => void | Promise<void>
  /** Read-only autonomy state root (for open questions). */
  autonomyPaths: AutonomyPaths
  /** How long since the owner last heard from us (OutboundActivityTracker). */
  lastOutboundAt: (chatId: string) => number | undefined
  /** Owner-chat gate. Defaults to always-true (the mirror already gates). */
  isOwnerChat?: (chatId: string) => boolean
  now?: () => number
  // Thresholds — overridable for deterministic tests.
  pinAfterMs?: number
  messageAfterMs?: number
  messageMinIntervalMs?: number
  deadmanMs?: number
  questionReminderMs?: number
  stickyReminderMs?: number
}

interface ChatHb {
  // ── dead-man ──
  lastPaneHash?: string
  paneChangedAtMs: number
  deadmanAlerted: boolean
  // ── heartbeat ──
  pinSuffixActive: boolean
  lastHeartbeatMsgAtMs: number
  // ── question reminders ── key `${questionId}:2h` | `${questionId}:sticky` → last sent ms
  questionReminders: Map<string, number>
}

function truncate(s: string, maxCps: number): string {
  const cps = Array.from(s)
  if (cps.length <= maxCps) return s
  return `${cps.slice(0, Math.max(0, maxCps - 1)).join('')}…`
}

function taskLabel(task: string | null): string {
  const t = task !== null ? task.trim() : ''
  return t.length > 0 ? truncate(t, TASK_LABEL_MAX) : '(задача не указана)'
}

export class HeartbeatMonitor implements LivenessMonitor {
  private readonly log: Logger
  private readonly send: (chatId: string, text: string) => Promise<void>
  private readonly pinHeartbeat?: (chatId: string, suffix: string | null) => void | Promise<void>
  private readonly autonomyPaths: AutonomyPaths
  private readonly lastOutboundAt: (chatId: string) => number | undefined
  private readonly isOwnerChat: (chatId: string) => boolean
  private readonly now: () => number
  private readonly pinAfterMs: number
  private readonly messageAfterMs: number
  private readonly messageMinIntervalMs: number
  private readonly deadmanMs: number
  private readonly questionReminderMs: number
  private readonly stickyReminderMs: number
  private readonly recs = new Map<string, ChatHb>()

  constructor(opts: HeartbeatMonitorOptions) {
    this.log = opts.log
    this.send = opts.send
    if (opts.pinHeartbeat !== undefined) this.pinHeartbeat = opts.pinHeartbeat
    this.autonomyPaths = opts.autonomyPaths
    this.lastOutboundAt = opts.lastOutboundAt
    this.isOwnerChat = opts.isOwnerChat ?? ((): boolean => true)
    this.now = opts.now ?? ((): number => Date.now())
    this.pinAfterMs = opts.pinAfterMs ?? DEFAULTS.pinAfterMs
    this.messageAfterMs = opts.messageAfterMs ?? DEFAULTS.messageAfterMs
    this.messageMinIntervalMs = opts.messageMinIntervalMs ?? DEFAULTS.messageMinIntervalMs
    this.deadmanMs = opts.deadmanMs ?? DEFAULTS.deadmanMs
    this.questionReminderMs = opts.questionReminderMs ?? DEFAULTS.questionReminderMs
    this.stickyReminderMs = opts.stickyReminderMs ?? DEFAULTS.stickyReminderMs
  }

  private rec(chatId: string): ChatHb {
    let r = this.recs.get(chatId)
    if (r === undefined) {
      r = {
        paneChangedAtMs: this.now(),
        deadmanAlerted: false,
        pinSuffixActive: false,
        lastHeartbeatMsgAtMs: Number.NEGATIVE_INFINITY,
        questionReminders: new Map(),
      }
      this.recs.set(chatId, r)
    }
    return r
  }

  observePane(chatId: string, paneText: string, nowMs: number, turnActive: boolean): void {
    if (!this.isOwnerChat(chatId)) return
    try {
      const rec = this.rec(chatId)
      const hash = createHash('sha256').update(paneText, 'utf8').digest('hex')
      // Idle (no active turn): keep the baseline fresh so the dead-man clock
      // only ever accumulates across a CONTINUOUSLY active turn with a frozen
      // pane — an idle gap between turns must not count as a hang.
      if (!turnActive) {
        rec.lastPaneHash = hash
        rec.paneChangedAtMs = nowMs
        rec.deadmanAlerted = false
        return
      }
      if (rec.lastPaneHash !== hash) {
        rec.lastPaneHash = hash
        rec.paneChangedAtMs = nowMs
        rec.deadmanAlerted = false
        return
      }
      // Unchanged AND a turn is active: candidate hang.
      if (rec.deadmanAlerted) return
      if (nowMs - rec.paneChangedAtMs > this.deadmanMs) {
        rec.deadmanAlerted = true // once per incident; reset on pane change / turn end
        this.fireSend(
          chatId,
          'Сессия молчит >10 мин при активном ходе — возможно OOM/зависание',
        )
      }
    } catch (err) {
      this.warn('observePane', chatId, err)
    }
  }

  evaluate(
    chatId: string,
    ctx: { turnActive: boolean; inProgressTask: string | null; nowMs: number },
  ): void {
    if (!this.isOwnerChat(chatId)) return
    try {
      const rec = this.rec(chatId)
      if (ctx.turnActive) {
        this.evaluateHeartbeat(chatId, rec, ctx.inProgressTask, ctx.nowMs)
      } else {
        this.clearPin(chatId, rec)
      }
      // Reminders are independent of turnActive — an unanswered question must
      // be chased even between turns.
      this.remindQuestions(chatId, rec, ctx.nowMs)
    } catch (err) {
      this.warn('evaluate', chatId, err)
    }
  }

  onTurnEnd(chatId: string): void {
    try {
      const rec = this.recs.get(chatId)
      if (rec === undefined) return
      this.clearPin(chatId, rec)
      // A fresh turn gets a fresh per-turn heartbeat-message budget and a fresh
      // dead-man incident.
      rec.lastHeartbeatMsgAtMs = Number.NEGATIVE_INFINITY
      rec.deadmanAlerted = false
      rec.paneChangedAtMs = this.now()
    } catch (err) {
      this.warn('onTurnEnd', chatId, err)
    }
  }

  onChatGone(chatId: string): void {
    this.recs.delete(chatId)
  }

  // ─── internals ───────────────────────────────────────────────────────

  private evaluateHeartbeat(
    chatId: string,
    rec: ChatHb,
    inProgressTask: string | null,
    nowMs: number,
  ): void {
    const last = this.lastOutboundAt(chatId)
    // No outbound baseline yet (nothing ever sent this process) — we cannot
    // measure silence, so do nothing (the safe direction).
    if (last === undefined) {
      this.clearPin(chatId, rec)
      return
    }
    const silence = nowMs - last
    if (
      silence >= this.messageAfterMs &&
      nowMs - rec.lastHeartbeatMsgAtMs >= this.messageMinIntervalMs
    ) {
      rec.lastHeartbeatMsgAtMs = nowMs
      // A real message supersedes the pin suffix.
      this.clearPin(chatId, rec)
      this.fireSend(
        chatId,
        `Работаю дольше часа без отчёта: ${taskLabel(inProgressTask)}. Продолжаю.`,
      )
      return
    }
    if (silence >= this.pinAfterMs) {
      const suffix = `работаю: ${taskLabel(inProgressTask)} · ${formatUtcHm(nowMs)}`
      rec.pinSuffixActive = true
      this.firePin(chatId, suffix)
      return
    }
    // Silence back under 25 min (owner replied / heartbeat fired) — drop any
    // stale pin suffix.
    this.clearPin(chatId, rec)
  }

  private remindQuestions(chatId: string, rec: ChatHb, nowMs: number): void {
    let state
    try {
      // READ-ONLY — no writer lock (the heartbeat path must never mutate the
      // registry). Best-effort: a broken registry degrades to no reminders.
      state = loadAutonomyState(this.autonomyPaths, chatId, this.log)
    } catch (err) {
      this.warn('remindQuestions.load', chatId, err)
      return
    }
    const questions = openQuestions(state)
    const liveKeys = new Set<string>()
    for (const q of questions) {
      const age = questionAgeMs(q, nowMs)
      if (q.sticky === true) {
        const key = `${q.id}:sticky`
        liveKeys.add(key)
        if (age < this.stickyReminderMs) continue
        const prev = rec.questionReminders.get(key)
        if (prev === undefined || nowMs - prev >= this.stickyReminderMs) {
          rec.questionReminders.set(key, nowMs)
          this.fireSend(chatId, `Security-вопрос всё ещё без ответа: "${q.summary}"`)
        }
      } else {
        const key = `${q.id}:2h`
        liveKeys.add(key)
        if (age < this.questionReminderMs) continue
        if (rec.questionReminders.has(key)) continue // ONE 2h reminder per question
        rec.questionReminders.set(key, nowMs)
        const tail =
          q.defaultAction !== undefined
            ? `Беру дефолт: ${q.defaultAction}. Скажи стоп, если против.`
            : 'Жду или беру безопасный дефолт по ситуации.'
        this.fireSend(chatId, `Вопрос без ответа 2ч: "${q.summary}". ${tail}`)
      }
    }
    // Forget reminder bookkeeping for questions that are no longer open, so the
    // map cannot grow without bound across a long-lived session.
    for (const key of [...rec.questionReminders.keys()]) {
      if (!liveKeys.has(key)) rec.questionReminders.delete(key)
    }
  }

  private clearPin(chatId: string, rec: ChatHb): void {
    if (!rec.pinSuffixActive) return
    rec.pinSuffixActive = false
    this.firePin(chatId, null)
  }

  private firePin(chatId: string, suffix: string | null): void {
    if (this.pinHeartbeat === undefined) return
    try {
      const r = this.pinHeartbeat(chatId, suffix)
      if (r instanceof Promise) r.catch((err: unknown) => this.warn('pinHeartbeat', chatId, err))
    } catch (err) {
      this.warn('pinHeartbeat', chatId, err)
    }
  }

  private fireSend(chatId: string, text: string): void {
    this.send(chatId, text).catch((err: unknown) => this.warn('send', chatId, err))
  }

  private warn(where: string, chatId: string, err: unknown): void {
    this.log.warn(`heartbeat monitor ${where} failed (ignored)`, {
      chat_id: chatId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
