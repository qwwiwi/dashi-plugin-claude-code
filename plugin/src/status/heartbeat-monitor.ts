// HeartbeatMonitor — mechanical liveness for the owner channel (M4, 2026-07-10
// communication audit). Three failure modes the audit surfaced become
// automatic, so the owner stops having to ask «Статус?»:
//
//   1. HEARTBEAT — during an active turn, when the owner has heard nothing for
//      >25 min, append a no-ping «работаю: <task> · HH:MM» suffix to the
//      context pin; past >60 min send ONE real message «Работаю дольше часа без
//      отчёта: <task>. Продолжаю.» — rate-limited to at most one per hour PER
//      CHAT, persistent across turns within the process (fix-loop-1 #3: a
//      per-turn budget would let back-to-back turns each fire a message
//      minutes apart). When no outbound record exists yet (fresh process /
//      first turn), the silence window is SEEDED from the first evaluate of an
//      active turn (fix-loop-1 #4) — a restart never disables the heartbeat.
//   2. DEAD-MAN — during an active turn, when the tmux pane hash has not
//      changed for >10 min and no Stop arrived, send ONE alert (possible
//      OOM/hang — or an unanswered confirmation card; the text says both).
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
//   • Heartbeat/reminder sends go out with `skipOutboundStamp` (wired in
//     server.ts) so a nudge never counts as «the owner heard a real report».
//
// State is in-memory only; persistence is deliberately omitted. Restart
// semantics (fix-loop-1 #8): on the FIRST evaluation of a chat, reminder
// bookkeeping is SEEDED to «now» for every already-open question — a restart
// therefore never fires a burst of immediate 2h/6h reminders; each pre-restart
// question re-arms a FRESH full window and reminds only on its next threshold
// crossing (a question that already reminded before the restart may remind at
// most once more, one full window later). The heartbeat silence window resets
// the same way (seeded from the first active evaluate) — a delayed nudge, never
// a spurious immediate one.

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
  /** A turn ended (Stop) — clear the pin suffix + reset the dead-man incident.
   *  The hourly heartbeat-message budget deliberately SURVIVES turn ends
   *  (fix-loop-1 #3). */
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

// Per-question reminder bookkeeping: `at` = the window anchor (seed time or
// last reminder time), `fired` = the one-shot 2h reminder already went out.
interface ReminderEntry {
  at: number
  fired: boolean
}

interface ChatHb {
  // ── dead-man ──
  lastPaneHash?: string
  paneChangedAtMs: number
  deadmanAlerted: boolean
  // ── heartbeat ──
  pinSuffixActive: boolean
  // Per-CHAT hourly budget — survives turn ends (fix-loop-1 #3); dropped only
  // with the whole rec (onChatGone).
  lastHeartbeatMsgAtMs: number
  // Fallback silence anchor when no outbound record exists yet (fix-loop-1
  // #4): set on the first evaluate of an active turn, so the 25/60-min
  // thresholds still fire after a restart / before the first real report.
  silenceBaselineMs?: number
  // ── question reminders ── key `${questionId}:2h` | `${questionId}:sticky`
  questionReminders: Map<string, ReminderEntry>
  // First remindQuestions run for this chat seeds entries for every
  // already-open question (fix-loop-1 #8) — restart burst protection.
  remindersSeeded: boolean
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

  // `nowMs` is the CALLER's clock reading (fix-loop-1 #9) — every entry point
  // already carries one; mixing in this.now() here could stamp a baseline
  // ahead of / behind the timestamps the same call then compares against.
  private rec(chatId: string, nowMs: number): ChatHb {
    let r = this.recs.get(chatId)
    if (r === undefined) {
      r = {
        paneChangedAtMs: nowMs,
        deadmanAlerted: false,
        pinSuffixActive: false,
        lastHeartbeatMsgAtMs: Number.NEGATIVE_INFINITY,
        questionReminders: new Map(),
        remindersSeeded: false,
      }
      this.recs.set(chatId, r)
    }
    return r
  }

  observePane(chatId: string, paneText: string, nowMs: number, turnActive: boolean): void {
    if (!this.isOwnerChat(chatId)) return
    try {
      const rec = this.rec(chatId, nowMs)
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
          'Сессия молчит >10 мин при активном ходе — возможно OOM/зависание или жду подтверждения (карточка/гейт)',
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
      const rec = this.rec(chatId, ctx.nowMs)
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
      // A fresh turn gets a fresh dead-man incident. The hourly heartbeat
      // MESSAGE budget deliberately does NOT reset here (fix-loop-1 #3): the
      // limiter is per chat and persistent across turns within the process,
      // otherwise back-to-back turns could each fire a «работаю дольше часа»
      // message minutes apart.
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
    // No outbound record yet (fresh process / first turn) — seed the silence
    // window from THIS first evaluate of an active turn (fix-loop-1 #4).
    // Pre-fix the heartbeat was silently disabled forever until the first
    // real send; now a restart merely delays the nudge by a full window.
    let anchor: number
    if (last !== undefined) {
      anchor = last
    } else {
      if (rec.silenceBaselineMs === undefined) rec.silenceBaselineMs = nowMs
      anchor = rec.silenceBaselineMs
    }
    const silence = nowMs - anchor
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
    // Restart-burst protection (fix-loop-1 #8): the FIRST reminder pass for a
    // chat only SEEDS bookkeeping for every already-open question — each
    // re-arms a fresh full window anchored at «now» and reminds on its NEXT
    // threshold crossing, never immediately. Questions opened after this pass
    // get no entry and fire on their normal age-based threshold.
    if (!rec.remindersSeeded) {
      rec.remindersSeeded = true
      for (const q of questions) {
        const key = q.sticky === true ? `${q.id}:sticky` : `${q.id}:2h`
        rec.questionReminders.set(key, { at: nowMs, fired: false })
      }
    }
    const liveKeys = new Set<string>()
    for (const q of questions) {
      const age = questionAgeMs(q, nowMs)
      if (q.sticky === true) {
        const key = `${q.id}:sticky`
        liveKeys.add(key)
        const entry = rec.questionReminders.get(key)
        // Cadence anchor: the seed / last reminder when present, else the
        // question's own age. At most one reminder per stickyReminderMs.
        const due =
          entry !== undefined
            ? nowMs - entry.at >= this.stickyReminderMs
            : age >= this.stickyReminderMs
        if (!due) continue
        rec.questionReminders.set(key, { at: nowMs, fired: true })
        this.fireSend(chatId, `Security-вопрос всё ещё без ответа: "${q.summary}"`)
      } else {
        const key = `${q.id}:2h`
        liveKeys.add(key)
        const entry = rec.questionReminders.get(key)
        if (entry?.fired === true) continue // ONE 2h reminder per question
        const due =
          entry !== undefined
            ? nowMs - entry.at >= this.questionReminderMs // seeded: fresh window
            : age >= this.questionReminderMs
        if (!due) continue
        rec.questionReminders.set(key, { at: nowMs, fired: true })
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
    // Guard BOTH a sync throw and an async rejection from the injected sender
    // — a broken nudge must never escape into the mirror's capture loop.
    try {
      this.send(chatId, text).catch((err: unknown) => this.warn('send', chatId, err))
    } catch (err) {
      this.warn('send', chatId, err)
    }
  }

  private warn(where: string, chatId: string, err: unknown): void {
    this.log.warn(`heartbeat monitor ${where} failed (ignored)`, {
      chat_id: chatId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
