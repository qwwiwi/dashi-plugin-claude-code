// StatusManager — owns the transient "Печатает.../Думает.../🔧 tool" message
// the bot edits while Claude works on a reply. Mirrors gateway.py:2895-2930
// behaviour: lazy status message, periodic edit while task is in flight, delete
// (or finalize) before the real answer ships.
//
// Design notes:
//   * One active StatusHandle per chatId. Calling start() while another is
//     active silently cancels the previous one (no edit to "canceled" label —
//     the new status starts immediately and is what the user sees).
//   * Timers are injected via setTimer/clearTimer so tests can drive the
//     ticker with fake clocks. We never call global setInterval directly.
//   * Telegram edit failures are SWALLOWED (logged at warn). A flaky edit
//     must never propagate to a 500 in the tool layer — the real reply path
//     is the source of truth.
//   * TTL guard auto-cancels after `config.status.ttl_ms` so a stuck status
//     (e.g. Claude crashed without firing complete()) doesn't haunt the chat
//     forever.

import type { AppConfig } from '../config.js'
import type { Logger } from '../log.js'
import type { ChatAction, TelegramApi } from '../channel/tools.js'
import {
  shouldStreamForChat,
  type MultichatPolicy,
} from '../chats/policy-loader.js'
import { escapeHtml } from '../format/html.js'
import type { ActivityStatusEvent } from '../hooks/claude-events.js'
import { classifyEditError } from '../safety/telegram-edit-classifier.js'
import {
  buildActivityDetail,
  buildHumanizedActivityLine,
  maskSecrets,
  renderActivityBlock,
  type ActivityCall,
  type ActivitySnapshot,
} from './activity-renderer.js'

/**
 * @deprecated Use {@link shouldStreamForChat} from `chats/policy-loader`
 *   directly. This symbol stays exported for backward compatibility
 *   ONLY — any caller still wired to it would otherwise re-introduce
 *   the fail-OPEN regression CRITICAL #1 / HIGH #9 (codex review
 *   2026-05-27) eliminated: pre-fix this function returned `true` for
 *   chats absent from `policy.chats`, leaking warchief streaming into
 *   misconfigured public groups. Re-implemented as a thin shim around
 *   the fail-CLOSED primitive so legacy imports get the correct
 *   semantics automatically (FIX-C bug #4, codex status #4).
 *
 * Signature delta vs. the new primitive: this helper accepts
 * `policy?: MultichatPolicy` (optional) for source-compat with the old
 * call sites. An omitted policy is forwarded as `null`, preserving the
 * "legacy single-DM mode" branch in `shouldStreamForChat`.
 */
export function shouldStream(
  chatId: string,
  policy?: MultichatPolicy,
): boolean {
  return shouldStreamForChat(policy ?? null, chatId)
}

// Telegram's `sendChatAction` indicator expires after 5 s; re-pulse on a 4 s
// timer to keep the header animation continuous without spamming the API.
const CHAT_ACTION_PULSE_MS = 4000

// All active StatusStates map to a single `typing` action. Tool-specific
// actions (`upload_document`, etc.) are not used today because Telegram's
// header animation is the same for `typing` and we want to keep the contract
// simple. Extend here if a per-tool icon becomes worth the noise.
function chatActionFor(state: StatusState): ChatAction | null {
  switch (state.kind) {
    case 'typing':
    case 'thinking':
    case 'tool':
    case 'activity':
      return 'typing'
    case 'stopped':
    case 'error':
      return null
  }
}

export type StatusState =
  | { kind: 'typing' }
  | { kind: 'thinking' }
  | { kind: 'tool'; toolName: string }
  | { kind: 'activity'; snapshot: ActivitySnapshot }
  | { kind: 'stopped'; reason?: string }
  | { kind: 'error'; reason?: string }

// Cap on the in-memory tool-call buffer per active chat. Gateway uses 10
// (gateway.py:1876-1879); render window is 5 (`activity-renderer.ts`
// `ACTIVITY_WINDOW`). Keeping more than we render lets the "+N earlier"
// summary stay accurate after collapses without an unbounded buffer.
const ACTIVITY_MAX_BUFFER = 10

// Throttle non-Agent tool edits to once per this many ms. Agent dispatches
// always edit immediately. Mirrors gateway.py:1738 `_last_tool_render` + 5 s
// throttle in `_TaskBoundaryTracker`.
const ACTIVITY_EDIT_THROTTLE_MS = 5000

// Per-chat 403/forbidden cache. After Telegram returns 401/403 on a
// chat surface (bot kicked, chat 403, user blocked), subsequent
// start() calls within this TTL must short-circuit BEFORE sending —
// otherwise every inbound update pays a fresh sendMessage 403 round-
// trip (MED-A #1). After the TTL elapses we allow one probe in case
// the bot was re-added.
const BLOCKED_CHAT_TTL_MS = 5 * 60 * 1000 // 5 minutes
// Prune the entire blockedChats map of entries older than this so a
// long-running plugin doesn't leak unbounded chatId state. Pruned
// entries are simply re-probed on the next start() — same as if the
// entry had been removed by `firstSeen` ageing out below.
const BLOCKED_CHAT_PRUNE_MS = 60 * 60 * 1000 // 1 hour

export interface StatusHandle {
  readonly chatId: string
  // messageId is `0` while the bubble is suppressed (lazy-create
  // mode); it becomes the real Telegram message id only after
  // ensureBubble() runs. Callers MUST NOT key staleness checks on
  // this field — use `generation` instead (see below).
  readonly messageId: number
  readonly startedAt: number
  // Monotonic per-chat lifecycle token captured at start(). The
  // staleness check in update() compares `handle.generation ===
  // entry.generation` rather than messageId, so a caller that took
  // the handle BEFORE ensureBubble() flipped messageId from 0 to the
  // real id keeps writing successfully (FIX-C bug #2, codex status
  // #2). On complete()/cancel() the manager bumps entry.generation,
  // so any leftover handle from the previous lifecycle is rejected.
  readonly generation: number
}

// Telegram surface the manager actually touches. Pulled out of channel/tools
// TelegramApi so we can extend with deleteMessage without bloating that
// type's import graph elsewhere.
export interface TelegramApiForStatus {
  sendMessage: TelegramApi['sendMessage']
  editMessageText: TelegramApi['editMessageText']
  deleteMessage?: (chatId: string, messageId: number) => Promise<void>
  // Native Telegram `typing` indicator in the chat header. Optional so unit
  // tests can stub a minimal surface. Action expires after 5 s on Telegram's
  // side, so the manager re-pulses on a 4 s timer while a status is active.
  sendChatAction?: TelegramApi['sendChatAction']
}

export interface StatusManagerDeps {
  telegramApi: TelegramApiForStatus
  config: AppConfig
  log: Logger
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout
  clearTimer?: (handle: NodeJS.Timeout) => void
  // Multichat policy gate, evaluated per-chat at every public entry
  // point (start / update / cancel / complete / recordActivityByChatId).
  //
  // Semantics (delegated to {@link shouldStreamForChat}):
  //   * `null` / omitted — legacy single-DM mode. Every chat streams
  //     (preserves pre-multichat behaviour where only the warchief's
  //     DM existed).
  //   * `MultichatPolicy` loaded — chat must be present with
  //     `streaming: 'progress'`. Missing entries OR `streaming: 'off'`
  //     turn every method into a no-op for that chat (fail-closed).
  //
  // The gate is consulted per call rather than memoised at construction
  // because StatusManager is a singleton across all chats — a
  // construction-time boolean (legacy `streamingEnabled` option) leaked
  // warchief DM behaviour into public groups when the chosen anchor
  // chat had `streaming: 'progress'` (codex review 2026-05-27,
  // CRITICAL #1 / HIGH #9).
  policy?: MultichatPolicy | null
}

// Internal mirror of StatusHandle without the `readonly` modifiers — we
// mutate messageId lazily when the bubble is created after a typing-only
// start. The public StatusHandle (returned to callers) stays readonly.
//
// `generation` lives on BOTH the entry (canonical) and the mirrored
// handle. The mirror stays in sync with `entry.generation` for as long
// as the entry is alive, so `updateByChatId` can pass `entry.handle`
// straight to `update(handle, …)` and the staleness check still
// passes. The public StatusHandle copy returned to callers takes its
// own snapshot of `entry.generation` at start(); after a lifecycle
// flip the public copy diverges and `update` rejects the stale handle.
interface MutableHandle {
  chatId: string
  messageId: number
  startedAt: number
  generation: number
}

interface InternalEntry {
  handle: MutableHandle
  state: StatusState
  // Cycle index used to advance the dot animation on each tick.
  tick: number
  lastText: string
  intervalHandle: NodeJS.Timeout | null
  ttlHandle: NodeJS.Timeout | null
  // Separate cadence from the message edit ticker — see CHAT_ACTION_PULSE_MS.
  chatActionHandle: NodeJS.Timeout | null
  // Original reply target captured from start(). Re-used when the bubble is
  // created lazily on the first non-typing transition so it threads under
  // the same inbound message the user originally sent.
  replyToMessageId: number | undefined
  // True when sendMessage has not been called yet because state is still
  // typing and suppress_typing_bubble is on. Lazy-create path flips this on
  // first non-typing transition.
  bubbleSuppressed: boolean
  // Idempotency guard for ensureBubble — multiple concurrent non-typing
  // events used to each fire their own sendMessage, leaking message_ids.
  // The first caller sets this promise; subsequent callers await it and
  // return. Reset to `null` after success/failure so a failed creation
  // can retry on the next event.
  bubbleCreationPromise: Promise<void> | null
  // Monotonic generation counter — incremented on every lifecycle
  // transition (start replaces an existing entry, complete, cancel).
  // Timer callbacks capture the generation at scheduling time; on fire
  // they check entry.generation against the captured value and drop the
  // edit when they mismatch. Without this, a tick scheduled against the
  // previous lifecycle would mutate the new entry mid-flight.
  generation: number
  // Rolling activity state — kept on the entry even while state.kind!=
  // 'activity' so a Stop after a non-tool reasoning phase still has the
  // recorded history. Last-tool-render timestamp throttles non-Agent edits.
  activityCalls: ActivityCall[]
  activityPhase: 'reasoning' | 'tool'
  activityStartedAt: number
  lastToolRenderAt: number
  // Map tool_use_id → call buffer index, so PostToolUse Agent can update
  // the recorded line with a short done summary.
  toolUseIndex: Map<string, number>
  // Edit-error classifier outputs map here:
  //   • disabled — set when a 401/403 from Telegram terminates the chat
  //     surface. editSafely / ensureBubble bail without an attempt. The
  //     entry stays in `entries` so isActive() stays truthful, but no
  //     Telegram I/O ever fires for this entry again.
  //   • messageGoneRecoveryDone — flip to true the first time we
  //     recreate the bubble after a "message to edit not found". A
  //     second occurrence simply drops the messageId without recreate,
  //     preventing a permanent recreate loop on a chat where Telegram
  //     keeps GC'ing the message.
  //   • parseDowngraded — flip to true after a parse-error retry. Next
  //     parse error in the same entry surfaces as a normal transient
  //     drop (we don't have a third downgrade path).
  disabled: boolean
  messageGoneRecoveryDone: boolean
  parseDowngraded: boolean
  // MED-A #4: 429 backoff. When Telegram's rate-limit wrapper exhausts
  // its retries and surfaces the `flood` classifier kind, we capture
  // `now + retryAfterSec*1000` here. Subsequent timer ticks (interval
  // + chat_action pulse + TTL) check `now() < pausedUntil` and bail
  // BEFORE issuing any Telegram I/O — without this the next tick
  // fired immediately and hit 429 again. `0` (or any past value)
  // means no active pause.
  pausedUntil: number
}

function renderState(state: StatusState, tick: number, nowMs: number): string {
  // Ellipsis animation for typing/thinking: 1→2→3 dots.
  const dotCount = (tick % 3) + 1
  const dots = '.'.repeat(dotCount)
  switch (state.kind) {
    case 'typing':
      return `<i>Печатает${dots}</i>`
    case 'thinking':
      return `<i>Думает${dots}</i>`
    case 'tool':
      return `<i>🔧 ${escapeHtml(state.toolName)}</i>`
    case 'activity':
      return renderActivityBlock(state.snapshot, nowMs)
    case 'stopped': {
      const tail = state.reason ? `: ${escapeHtml(state.reason)}` : ''
      return `<i>Остановлено${tail}</i>`
    }
    case 'error': {
      const tail = state.reason ? `: ${escapeHtml(state.reason)}` : ''
      return `<i>Ошибка${tail}</i>`
    }
  }
}

export class StatusManager {
  private readonly telegramApi: TelegramApiForStatus
  private readonly config: AppConfig
  private readonly log: Logger
  private readonly now: () => number
  private readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout
  private readonly clearTimer: (handle: NodeJS.Timeout) => void
  private readonly entries: Map<string, InternalEntry>
  // Per-chat lifecycle FIFO. Every start/complete/cancel chains onto
  // the chat's tail-promise so two concurrent operations cannot race
  // on the entries map. We replace the tail with the new operation's
  // promise; errors are swallowed via `.catch(() => {})` on the await
  // so one failed op cannot permanently break the chain for a chat.
  //
  // Without this, two concurrent start() calls could each pass the
  // `entries.has(chatId)` check, both fire sendMessage, then race on
  // `entries.set(chatId, …)` — one Telegram message becomes orphaned
  // (no entry tracks it) and its timer-driven edits chase a stale
  // message_id (HIGH #3, codex review 2026-05-27).
  private readonly lifecycleLocks: Map<string, Promise<void>>
  // Per-chat 403 cache (MED-A #1). When Telegram returns forbidden
  // (401/403) on send / edit / chat_action, we record the chatId here
  // with a wall-clock timestamp. Subsequent start() calls within
  // BLOCKED_CHAT_TTL_MS short-circuit to a sentinel handle BEFORE the
  // sendMessage attempt — otherwise every inbound message on a
  // permanently-blocked chat (bot kicked, user blocked, chat 403)
  // paid a fresh 403 round-trip.
  //
  // After BLOCKED_CHAT_TTL_MS elapses we allow one probe — the bot
  // may have been re-added or the user unblocked. The cache is
  // periodically pruned via maybePruneBlockedChats() on entry-points
  // (cheap call site amortisation; no separate timer needed).
  private readonly blockedChats: Map<
    string,
    { firstSeen: number; lastSeen: number; reason: string }
  >
  private lastBlockedPruneAt: number
  // Multichat policy reference (or `null` for legacy single-DM mode).
  // Every public mutation re-evaluates `shouldStreamForChat(policy,
  // chatId)` against the TARGET chat — we never memoise the answer at
  // construction time, because the manager is shared across all chats.
  private readonly policy: MultichatPolicy | null

  constructor(deps: StatusManagerDeps) {
    this.telegramApi = deps.telegramApi
    this.config = deps.config
    this.log = deps.log
    this.now = deps.now ?? (() => Date.now())
    // Bind to global timers as a default so production code doesn't need to
    // pass anything. Tests inject deterministic fake timers.
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))
    this.entries = new Map()
    this.lifecycleLocks = new Map()
    this.blockedChats = new Map()
    this.lastBlockedPruneAt = 0
    this.policy = deps.policy ?? null
  }

  // Record a 403/forbidden Telegram failure for a chat. Future start()
  // calls within BLOCKED_CHAT_TTL_MS will short-circuit without trying
  // sendMessage. Idempotent — repeated calls just refresh `lastSeen`.
  private markChatBlocked(chatId: string, reason: string): void {
    const t = this.now()
    const prev = this.blockedChats.get(chatId)
    if (prev) {
      prev.lastSeen = t
      prev.reason = reason
    } else {
      this.blockedChats.set(chatId, { firstSeen: t, lastSeen: t, reason })
    }
  }

  // Returns true when the chat is in the blocked cache AND the most
  // recent 403 happened within BLOCKED_CHAT_TTL_MS. Re-probes after
  // the window allow recovery if the bot was re-added.
  private isChatBlocked(chatId: string): boolean {
    const rec = this.blockedChats.get(chatId)
    if (!rec) return false
    const t = this.now()
    if (t - rec.lastSeen >= BLOCKED_CHAT_TTL_MS) {
      // TTL elapsed — drop the entry so the next start() probes fresh.
      // If Telegram still returns 403, mark it again immediately.
      this.blockedChats.delete(chatId)
      return false
    }
    return true
  }

  // Periodically drop entries older than BLOCKED_CHAT_PRUNE_MS so a
  // long-running plugin doesn't accumulate dead chatIds. Runs at most
  // once per BLOCKED_CHAT_TTL_MS to keep amortised cost negligible.
  private maybePruneBlockedChats(): void {
    const t = this.now()
    if (t - this.lastBlockedPruneAt < BLOCKED_CHAT_TTL_MS) return
    this.lastBlockedPruneAt = t
    for (const [id, rec] of this.blockedChats.entries()) {
      if (t - rec.firstSeen >= BLOCKED_CHAT_PRUNE_MS) {
        this.blockedChats.delete(id)
      }
    }
  }

  // Per-chat lifecycle serialization. Caller's `op` runs only after
  // any pending lifecycle work on the same chat finishes. Errors are
  // returned to the caller verbatim — the chain itself swallows
  // upstream errors so a single failure doesn't strand later callers.
  private async runLifecycle<T>(chatId: string, op: () => Promise<T>): Promise<T> {
    const prev = this.lifecycleLocks.get(chatId) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((r) => {
      release = r
    })
    this.lifecycleLocks.set(chatId, next)
    try {
      await prev.catch(() => {})
      return await op()
    } finally {
      release()
      // GC the lock when the FIFO drains. `lifecycleLocks.get(chatId)`
      // may already point to a later op's promise; only delete when we
      // own the tail.
      if (this.lifecycleLocks.get(chatId) === next) {
        this.lifecycleLocks.delete(chatId)
      }
    }
  }

  // Per-chat fail-closed gate. Returns `false` when the chat is not
  // allowed to receive interim status edits — every public method
  // bails out on this signal so a misconfigured public group never
  // sees rolling progress, tool calls, or `sendChatAction` pulses.
  private isStreamingAllowed(chatId: string): boolean {
    return shouldStreamForChat(this.policy, chatId)
  }

  isActive(chatId: string): boolean {
    return this.entries.has(chatId)
  }

  // List of active chat ids — used by shutdown to flush all status messages.
  activeChatIds(): string[] {
    return Array.from(this.entries.keys())
  }

  async start(
    chatId: string,
    replyToMessageId: number | undefined,
    initialState: StatusState = { kind: 'typing' },
  ): Promise<StatusHandle> {
    if (!this.isStreamingAllowed(chatId)) {
      // Per-chat fail-closed gate: chat is absent from policy or its
      // `streaming` setting is `off`. Return a sentinel handle that
      // does not correspond to any real Telegram message — update()
      // / cancel() / complete() bail out because we never insert this
      // chat into `entries`. Final replies still arrive via the
      // router's outbox loop, which is the only legitimate egress
      // path for non-streaming chats.
      return {
        chatId,
        messageId: 0,
        startedAt: this.now(),
        // Generation `0` is the sentinel for "no real entry exists".
        // Live entries start at `generation: 1` (see startInternal),
        // so a staleness check `handle.generation === entry.generation`
        // against this sentinel can never spuriously match a real
        // entry that landed on the same chatId after a policy change.
        generation: 0,
      }
    }
    // MED-A #1: short-circuit start() when a recent 403/forbidden was
    // recorded for this chat. Without this, every inbound message on
    // a permanently-blocked chat (bot kicked / user blocked / chat
    // 403) paid a fresh sendMessage round-trip just to learn Telegram
    // still refuses. Re-probe is allowed after BLOCKED_CHAT_TTL_MS so
    // the bot can recover if re-added to the chat. Return the same
    // sentinel shape the policy-gate uses so downstream tools see a
    // consistent "no active surface" signal.
    this.maybePruneBlockedChats()
    if (this.isChatBlocked(chatId)) {
      return {
        chatId,
        messageId: 0,
        startedAt: this.now(),
        generation: 0,
      }
    }
    // Serialize per-chat lifecycle ops so two concurrent start() calls
    // can't both pass the `entries.has` check, both fire sendMessage,
    // then race on entries.set — one Telegram message ended up orphaned
    // with a ghost timer chasing it (codex HIGH #3).
    return this.runLifecycle(chatId, () =>
      this.startInternal(chatId, replyToMessageId, initialState),
    )
  }

  private async startInternal(
    chatId: string,
    replyToMessageId: number | undefined,
    initialState: StatusState,
  ): Promise<StatusHandle> {
    // Only one active status per chat at a time: finalise the previous one
    // (edit the old message to "Остановлено: superseded" and clear timers)
    // so we don't leak a stale "Печатает…" message on top of the new one.
    // Album-path callers in handlers.ts call start() once per album item;
    // without this terminate step the first item's pulse stays forever.
    //
    // Inline cancel: we're already inside the lifecycle lock, so we
    // do the bookkeeping + edit directly. Going through `cancel()`
    // would re-acquire the lock and deadlock.
    const prev = this.entries.get(chatId)
    if (prev) {
      // Bump on both the canonical entry counter AND the mirror on
      // entry.handle. The mirror is what updateByChatId(chat, …)
      // reads when re-targeting the active status, so they MUST move
      // together — otherwise a re-target after supersede would slip
      // through with a stale generation handed out to a now-dead
      // lifecycle.
      prev.generation += 1
      prev.handle.generation = prev.generation
      this.stopTimers(prev)
      this.entries.delete(chatId)
      if (!prev.bubbleSuppressed && !prev.disabled) {
        const supersededText = renderState(
          { kind: 'stopped', reason: 'superseded' },
          0,
          this.now(),
        )
        try {
          await this.telegramApi.editMessageText(
            chatId,
            prev.handle.messageId,
            supersededText,
            { parse_mode: 'HTML' },
          )
        } catch (err) {
          const cls = classifyEditError(err)
          if (cls.kind !== 'benign' && cls.kind !== 'message_gone') {
            this.log.warn('status superseded edit failed', {
              chat_id: chatId,
              message_id: prev.handle.messageId,
              kind: cls.kind,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }
    }

    const suppressBubble =
      this.config.status.suppress_typing_bubble && initialState.kind === 'typing'

    const text = renderState(initialState, 0, this.now())
    let messageId = 0
    if (!suppressBubble) {
      const sendOpts: { parse_mode: 'HTML'; reply_to_message_id?: number } = {
        parse_mode: 'HTML',
      }
      if (replyToMessageId !== undefined) sendOpts.reply_to_message_id = replyToMessageId

      let sent: { message_id: number }
      try {
        sent = await this.telegramApi.sendMessage(chatId, text, sendOpts)
      } catch (err) {
        // MED-A #1: classify the failure. A 403/forbidden on the
        // initial send means the bot has no access to the chat — mark
        // it blocked so the next start() short-circuits without
        // another sendMessage round-trip. Other error kinds rethrow
        // (handlers.ts treats status as best-effort and catches).
        const cls = classifyEditError(err)
        if (cls.kind === 'forbidden') {
          this.markChatBlocked(chatId, `start ${cls.code}: ${cls.description}`)
          this.log.warn('status start forbidden, chat marked blocked', {
            chat_id: chatId,
            code: cls.code,
          })
        } else {
          this.log.warn('status start failed', {
            chat_id: chatId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        throw err
      }
      messageId = sent.message_id
    }

    const handle: MutableHandle = {
      chatId,
      messageId,
      startedAt: this.now(),
      // Mirror of `entry.generation`. Initialised to 1 — must match
      // the entry.generation: 1 below so updateByChatId(chat, …),
      // which routes through update(entry.handle, …), passes the
      // staleness check. Kept in sync on every bump (see
      // complete/cancel/supersede).
      generation: 1,
    }
    const entry: InternalEntry = {
      handle,
      state: initialState,
      tick: 0,
      lastText: suppressBubble ? '' : text,
      intervalHandle: null,
      ttlHandle: null,
      chatActionHandle: null,
      replyToMessageId,
      bubbleSuppressed: suppressBubble,
      bubbleCreationPromise: null,
      generation: 1,
      activityCalls: [],
      activityPhase: 'reasoning',
      activityStartedAt: this.now(),
      // Sentinel — first non-Agent tool call always renders. Throttle only
      // applies AFTER a render has actually occurred.
      lastToolRenderAt: Number.NEGATIVE_INFINITY,
      toolUseIndex: new Map(),
      disabled: false,
      messageGoneRecoveryDone: false,
      parseDowngraded: false,
      pausedUntil: 0,
    }
    this.entries.set(chatId, entry)
    const generation = entry.generation

    // Fire-and-forget initial chat action so the Telegram header shows
    // `typing…` immediately, not on the first pulse 4 s in. Keeps firing
    // even when the message bubble is suppressed — the native indicator
    // is what the warchief still wants to see.
    void this.pulseChatAction(entry)
    entry.chatActionHandle = this.setTimer(
      () => this.chatActionTick(chatId, generation),
      CHAT_ACTION_PULSE_MS,
    )

    // Periodic tick — re-edit with advanced ellipsis (typing/thinking only)
    // or keep the same text for tool/stopped/error states. Same-text edits
    // collapse via the "message is not modified" swallow path below.
    //
    // While the bubble is suppressed we still advance the tick counter so
    // animation timing stays continuous when the bubble eventually appears,
    // but `editSafely` short-circuits because messageId is 0.
    //
    // Generation guard: a tick scheduled against the previous lifecycle
    // entry (e.g. after a rapid cancel-then-start) would otherwise mutate
    // the new entry's tick/state. Compare against the captured generation
    // at scheduling time and drop the callback when they diverge.
    const tick = (): void => {
      const live = this.entries.get(chatId)
      if (!live || live.generation !== generation) return
      // MED-A #4: if Telegram returned 429 and pausedUntil is in the
      // future, skip ALL work this tick — including the tick counter
      // and the edit — but keep the interval re-armed so we resume
      // automatically once the pause window expires. Re-arming with a
      // smaller delay so the resume isn't gated on a full interval.
      if (this.now() < live.pausedUntil) {
        const remaining = Math.max(50, live.pausedUntil - this.now())
        live.intervalHandle = this.setTimer(
          tick,
          Math.min(remaining, this.config.status.interval_ms),
        )
        return
      }
      live.tick += 1
      if (!live.bubbleSuppressed) {
        const next = renderState(live.state, live.tick, this.now())
        void this.editSafely(live, next)
      }
      // Re-arm next tick.
      live.intervalHandle = this.setTimer(tick, this.config.status.interval_ms)
    }
    entry.intervalHandle = this.setTimer(tick, this.config.status.interval_ms)

    // TTL guard. On expiry we cancel with reason='ttl' so the message turns
    // into "Остановлено: ttl" rather than vanishing silently. When the
    // bubble was suppressed end-to-end (pure typing session that timed
    // out) cancel() turns into a quiet cleanup with no Telegram edit.
    entry.ttlHandle = this.setTimer(() => {
      const live = this.entries.get(chatId)
      if (!live || live.generation !== generation) return
      void this.cancel(chatId, 'ttl')
    }, this.config.status.ttl_ms)

    return {
      chatId: handle.chatId,
      messageId: handle.messageId,
      startedAt: handle.startedAt,
      // Snapshot the entry's generation at handle-creation time. The
      // entry's generation will be bumped on each future complete/
      // cancel/supersede, so a leftover handle from this lifecycle
      // will be rejected by update() once the lifecycle ends. Within
      // the same lifecycle the value is stable — even after
      // ensureBubble() flips messageId from 0 to the real id, the
      // generation captured here still matches entry.generation,
      // so subsequent update(handle, …) calls remain valid
      // (FIX-C bug #2, codex status #2).
      generation: entry.generation,
    }
  }

  // Lazy-create the Telegram message bubble when state advances from typing
  // to anything else (thinking/tool/activity/stopped/error). No-op when the
  // bubble already exists. Used by update() and recordActivityByChatId().
  //
  // Idempotency: multiple concurrent non-typing events used to each fire
  // their own sendMessage (the awaits between rendering and `entries.set`
  // gave plenty of room to race). Now the first caller installs a
  // `bubbleCreationPromise`; subsequent callers await it and return. The
  // promise is cleared on resolve/reject so a failed create can retry on
  // the next event (codex HIGH #4).
  private async ensureBubble(entry: InternalEntry, state: StatusState): Promise<void> {
    if (entry.disabled) return
    if (!entry.bubbleSuppressed) return
    if (state.kind === 'typing') return
    if (entry.bubbleCreationPromise !== null) {
      // Another caller is creating the bubble right now — wait for them.
      // After the await we re-enter the suppress check: if the first
      // caller flipped bubbleSuppressed=false, we're done.
      await entry.bubbleCreationPromise
      return
    }
    const creation = this.createBubble(entry, state)
    entry.bubbleCreationPromise = creation
    try {
      await creation
    } finally {
      // Clear the lock regardless of outcome so a failed create can
      // retry on the next event (network blip, transient 5xx).
      if (entry.bubbleCreationPromise === creation) {
        entry.bubbleCreationPromise = null
      }
    }
  }

  // Single-flight body for ensureBubble. Splits out the actual
  // sendMessage so ensureBubble can install + await the shared promise
  // exactly once per chat per concurrent burst.
  private async createBubble(entry: InternalEntry, state: StatusState): Promise<void> {
    const text = renderState(state, 0, this.now())
    const sendOpts: { parse_mode?: 'HTML'; reply_to_message_id?: number } = {}
    // Skip parse_mode when we've previously had a parse downgrade so
    // the broken HTML can't trip Telegram a second time.
    if (!entry.parseDowngraded) sendOpts.parse_mode = 'HTML'
    if (entry.replyToMessageId !== undefined) {
      sendOpts.reply_to_message_id = entry.replyToMessageId
    }
    try {
      const sent = await this.telegramApi.sendMessage(
        entry.handle.chatId,
        text,
        sendOpts as { parse_mode: 'HTML'; reply_to_message_id?: number },
      )
      entry.handle.messageId = sent.message_id
      entry.lastText = text
      entry.bubbleSuppressed = false
    } catch (err) {
      const cls = classifyEditError(err)
      if (cls.kind === 'forbidden') {
        entry.disabled = true
        // MED-A #1: also mark the chat in the per-chat blocked cache
        // so the NEXT start() (after this entry is gone via complete
        // / cancel) short-circuits without another sendMessage 403.
        this.markChatBlocked(
          entry.handle.chatId,
          `lazy-send ${cls.code}: ${cls.description}`,
        )
        this.log.warn('status lazy-send forbidden, entry disabled', {
          chat_id: entry.handle.chatId,
          code: cls.code,
        })
        return
      }
      if (cls.kind === 'parse' && !entry.parseDowngraded) {
        entry.parseDowngraded = true
        this.log.warn('status lazy-send parse failure, retrying without parse_mode', {
          chat_id: entry.handle.chatId,
          description: cls.description,
        })
        // MED-A #6 (Codex status #5): retry must preserve
        // `reply_to_message_id` so the recovered bubble stays in the
        // same reply thread the warchief expects. Pre-fix retried
        // with `{}`, dropping the entire sendOpts including the
        // reply target — the rolling status then appeared at the
        // bottom of the chat unconnected to the originating message.
        // We drop only `parse_mode`, keeping every other option
        // (including reply_to_message_id) intact.
        const retryOpts: { reply_to_message_id?: number } = {}
        if (entry.replyToMessageId !== undefined) {
          retryOpts.reply_to_message_id = entry.replyToMessageId
        }
        try {
          const sent = await this.telegramApi.sendMessage(
            entry.handle.chatId,
            text,
            retryOpts as { parse_mode: 'HTML'; reply_to_message_id?: number },
          )
          entry.handle.messageId = sent.message_id
          entry.lastText = text
          entry.bubbleSuppressed = false
          return
        } catch (err2) {
          this.log.warn('status lazy-send retry without parse_mode failed', {
            chat_id: entry.handle.chatId,
            error: err2 instanceof Error ? err2.message : String(err2),
          })
          return
        }
      }
      // Best-effort — log and leave bubble suppressed. Next non-typing
      // event will retry the send.
      this.log.warn('status lazy-send failed (ignored)', {
        chat_id: entry.handle.chatId,
        kind: cls.kind,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async update(handle: StatusHandle, state: StatusState): Promise<void> {
    const entry = this.entries.get(handle.chatId)
    if (!entry) return
    if (entry.disabled) return
    // Staleness check is GENERATION-based (FIX-C bug #2, codex status #2).
    //
    // The previous messageId-based check broke after lazy-bubble creation:
    // start() returned a handle with messageId=0 (suppressed bubble),
    // ensureBubble() later flipped entry.handle.messageId to the real id,
    // and subsequent update(handle, …) calls hit
    // `entry.handle.messageId !== handle.messageId` (real id vs the
    // caller's stale `0`) and silently dropped — leaving the status
    // frozen at whatever ensureBubble's first send rendered.
    //
    // Generation is captured into the handle at start() and bumped on
    // every lifecycle transition (complete / cancel / supersede). It
    // stays stable across lazy-bubble creation, so the caller's handle
    // remains valid for the entire lifecycle yet is rejected the moment
    // a new lifecycle takes over the chat.
    if (handle.generation !== entry.generation) {
      // Stale handle — caller is editing something already completed.
      return
    }
    entry.state = state
    // Reset tick on state change so the ellipsis animation restarts at 1.
    entry.tick = 0
    if (entry.bubbleSuppressed) {
      await this.ensureBubble(entry, state)
      // ensureBubble already wrote the rendered text for non-typing states
      // and flipped bubbleSuppressed off. Nothing else to edit on this turn.
      return
    }
    const text = renderState(state, 0, this.now())
    await this.editSafely(entry, text)
  }

  // Convenience for the MCP `status` tool: the agent only has the chat_id,
  // not a StatusHandle (which is internal to the gateAndNotify caller). This
  // lets the tool re-target whichever status is currently active for the chat.
  async updateByChatId(chatId: string, state: StatusState): Promise<void> {
    const entry = this.entries.get(chatId)
    if (!entry) return
    await this.update(entry.handle, state)
  }

  /**
   * Apply a Claude Code hook event to the chat's status. Opens a new status
   * with no `reply_to_message_id` if none is active (SessionStart /
   * UserPromptSubmit / PreToolUse all act as openers — gateway parity).
   * Stop completes via `complete()` so existing delete_on_complete behaviour
   * holds.
   *
   * Non-Agent PreToolUse calls are recorded immediately but the on-Telegram
   * edit is throttled to once per 5 s; the next reasoning/Agent/Stop event
   * flushes the buffer (mirrors gateway.py:1738 `_last_tool_render`).
   */
  async recordActivityByChatId(chatId: string, event: ActivityStatusEvent): Promise<void> {
    if (!this.isStreamingAllowed(chatId)) {
      // Per-chat fail-closed gate: chat is absent from policy or its
      // `streaming` setting is `off`. Hook events arrive whether or
      // not we want to surface them — drop silently. Final reply
      // ships via the router outbox loop, not here.
      return
    }
    // Stop closes the session. Use existing complete() so delete_on_complete
    // semantics + timer cleanup stay in one place.
    if (event.kind === 'session_stop') {
      await this.complete(chatId)
      return
    }

    // Lazy-open: hook events can arrive before any inbound Telegram message.
    // In that case we open a status with no reply target so the rendering
    // surface exists. Initial state is `activity` so the first edit shows
    // the working block, not "Печатает…".
    let entry = this.entries.get(chatId)
    if (!entry) {
      const initial: StatusState = {
        kind: 'activity',
        snapshot: this.buildSnapshot([], 'reasoning', this.now()),
      }
      try {
        await this.start(chatId, undefined, initial)
      } catch {
        // Telegram send failed — already logged inside start(). Visibility
        // failure must not back-pressure Claude hooks; bail silently.
        return
      }
      entry = this.entries.get(chatId)
      if (!entry) return
    }
    if (entry.disabled) return

    const now = this.now()
    let shouldRender = false
    let isAgentEvent = false

    switch (event.kind) {
      case 'session_start':
      case 'reasoning': {
        entry.activityPhase = 'reasoning'
        shouldRender = true
        break
      }
      case 'tool_start': {
        // Record every call up to the buffer cap so PostToolUse can pair.
        const detail = buildActivityDetail(event.toolName, event.toolInput)
        const humanized = buildHumanizedActivityLine(event.toolName, event.toolInput)
        const call: ActivityCall = { toolName: event.toolName, detail, humanized }
        entry.activityCalls.push(call)
        if (entry.activityCalls.length > ACTIVITY_MAX_BUFFER) {
          entry.activityCalls.shift()
          // After shifting, indexes in toolUseIndex are stale; rebuild
          // lazily — only PostToolUse readers touch them.
          const rebuilt = new Map<string, number>()
          for (const [k, v] of entry.toolUseIndex.entries()) {
            if (v > 0) rebuilt.set(k, v - 1)
          }
          entry.toolUseIndex = rebuilt
        }
        entry.toolUseIndex.set(event.toolUseId, entry.activityCalls.length - 1)
        entry.activityPhase = 'tool'

        isAgentEvent = event.toolName === 'Agent'
        if (isAgentEvent) {
          shouldRender = true
        } else if (now - entry.lastToolRenderAt >= ACTIVITY_EDIT_THROTTLE_MS) {
          shouldRender = true
        } else {
          // Throttled — buffer remains; next render flush will surface it.
          shouldRender = false
        }
        break
      }
      case 'tool_end': {
        entry.activityPhase = 'reasoning'
        // For Agent PostToolUse, attach a short done summary to the matching
        // line — capped at 30 chars + masked AT STORE TIME (review §7).
        // Pre-fix the raw tool_result lived in the buffer until render; an
        // in-memory leak (debug dump, future log sink, serializer) would
        // surface raw tokens. Masking here means the buffer never holds an
        // unmasked secret-shaped string.
        if (event.toolName === 'Agent' && event.toolResult !== undefined) {
          const idx = entry.toolUseIndex.get(event.toolUseId)
          if (idx !== undefined && idx >= 0 && idx < entry.activityCalls.length) {
            const rawSummary =
              typeof event.toolResult === 'string'
                ? event.toolResult.slice(0, 30)
                : ''
            const summary = rawSummary ? maskSecrets(rawSummary) : ''
            if (summary) {
              const prev = entry.activityCalls[idx]
              if (prev) {
                entry.activityCalls[idx] = {
                  toolName: prev.toolName,
                  detail: `${prev.detail} — ${summary}`,
                  humanized:
                    prev.humanized !== null
                      ? `${prev.humanized} — ${escapeHtml(summary)}`
                      : null,
                }
              }
            }
          }
        }
        shouldRender = true
        break
      }
    }

    if (!shouldRender) return

    if (event.kind === 'tool_start' && !isAgentEvent) {
      entry.lastToolRenderAt = now
    } else if (event.kind === 'tool_start' && isAgentEvent) {
      entry.lastToolRenderAt = now
    }

    const snapshot = this.buildSnapshot(
      entry.activityCalls,
      entry.activityPhase,
      entry.activityStartedAt,
    )
    entry.state = { kind: 'activity', snapshot }
    entry.tick = 0
    if (entry.bubbleSuppressed) {
      // First non-typing event creates the bubble with the activity render
      // directly — no «Печатает.» preamble.
      await this.ensureBubble(entry, entry.state)
      return
    }
    const text = renderState(entry.state, 0, now)
    await this.editSafely(entry, text)
  }

  private buildSnapshot(
    calls: ReadonlyArray<ActivityCall>,
    phase: 'reasoning' | 'tool',
    startedAtMs: number,
  ): ActivitySnapshot {
    return {
      startedAtMs,
      // Defensive copy so consumers don't see future mutations.
      calls: calls.slice(),
      phase,
    }
  }

  async complete(chatId: string): Promise<void> {
    // Synchronous bookkeeping FIRST so isActive() flips immediately and
    // any pending timer ticks are invalidated before we yield to the
    // event loop. The Telegram delete (network I/O) runs inside the
    // lifecycle lock to serialize with concurrent start() calls.
    const entry = this.entries.get(chatId)
    if (!entry) return
    entry.generation += 1
    // Keep handle mirror in sync (see startInternal supersede branch).
    entry.handle.generation = entry.generation
    this.stopTimers(entry)
    this.entries.delete(chatId)

    // FIX-C bug #1 (codex status #2) — ensureBubble vs complete race.
    //
    // Pre-fix: with `suppress_typing_bubble: true` (production
    // default), ensureBubble() runs OUTSIDE the lifecycle lock. If
    // complete() fires while ensureBubble is mid-await on sendMessage,
    // `entry.bubbleSuppressed` is still `true` (the flip happens
    // AFTER the await resolves), so complete() bailed early — yet
    // sendMessage went on to succeed and entry.handle.messageId was
    // set to the real Telegram message id with nobody tracking it.
    // Result: a ghost bubble forever stuck in the chat.
    //
    // Approach (b) from FIX-C: await the in-flight creation promise
    // before reading bubbleSuppressed. After the await, if the bubble
    // was actually created (bubbleSuppressed === false now), the real
    // messageId is on entry.handle and we delete it like any other
    // completed bubble. If creation failed (bubbleSuppressed still
    // true) there is nothing to delete and we exit cleanly.
    if (entry.bubbleSuppressed && entry.bubbleCreationPromise !== null) {
      try {
        await entry.bubbleCreationPromise
      } catch {
        // ensureBubble swallows its own errors and leaves
        // bubbleSuppressed=true on failure. Nothing more to do.
      }
    }
    // Suppressed bubble = never sent a Telegram message, nothing to delete.
    if (entry.bubbleSuppressed) return
    if (entry.disabled) return
    if (!this.config.status.delete_on_complete) return
    if (!this.telegramApi.deleteMessage) return
    const deleteMessage = this.telegramApi.deleteMessage
    const messageId = entry.handle.messageId
    return this.runLifecycle(chatId, async () => {
      try {
        await deleteMessage(chatId, messageId)
      } catch (err) {
        // Stale message, deleted by user, or permission issue — never fatal.
        this.log.debug('status delete failed (ignored)', {
          chat_id: chatId,
          message_id: messageId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }

  async cancel(chatId: string, reason: string): Promise<void> {
    // Synchronous bookkeeping FIRST (see complete()). The "Остановлено"
    // edit runs inside the lifecycle lock to serialize against starts.
    const entry = this.entries.get(chatId)
    if (!entry) return
    entry.generation += 1
    // Keep handle mirror in sync (see startInternal supersede branch).
    entry.handle.generation = entry.generation
    this.stopTimers(entry)
    this.entries.delete(chatId)

    // FIX-C bug #1 (codex status #2) — mirror complete(): if
    // ensureBubble is mid-flight we must wait for it before deciding
    // whether to edit "Остановлено" into the message. Without this,
    // cancel sees bubbleSuppressed=true, bails, then ensureBubble's
    // sendMessage resolves and leaves an untracked ghost in the chat.
    if (entry.bubbleSuppressed && entry.bubbleCreationPromise !== null) {
      try {
        await entry.bubbleCreationPromise
      } catch {
        // Creation failed; bubbleSuppressed stays true; nothing to edit.
      }
    }
    // Pure typing session that ended without ever transitioning — no bubble
    // exists on Telegram, so there is nothing to mark as «Остановлено».
    if (entry.bubbleSuppressed) return
    if (entry.disabled) return
    const messageId = entry.handle.messageId
    const text = renderState({ kind: 'stopped', reason }, 0, this.now())
    return this.runLifecycle(chatId, async () => {
      try {
        await this.telegramApi.editMessageText(
          chatId,
          messageId,
          text,
          { parse_mode: 'HTML' },
        )
      } catch (err) {
        const cls = classifyEditError(err)
        if (cls.kind === 'benign') return
        if (cls.kind === 'message_gone') {
          // Cancel race: message already deleted (warchief tapped delete,
          // or it scrolled past Telegram's 48h edit window). Nothing to
          // do — the entry is already gone from our map.
          this.log.debug('status cancel target missing (ignored)', {
            chat_id: chatId,
            message_id: messageId,
          })
          return
        }
        this.log.warn('status cancel edit failed', {
          chat_id: chatId,
          message_id: messageId,
          kind: cls.kind,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }

  // ───── internals ─────

  private async editSafely(entry: InternalEntry, text: string): Promise<void> {
    // Bubble suppressed — no Telegram message to edit. Caller is expected to
    // go through ensureBubble() instead. Guard defends timer-driven ticks
    // that fire before the first non-typing transition.
    if (entry.disabled) return
    if (entry.bubbleSuppressed || entry.handle.messageId === 0) return
    if (text === entry.lastText) {
      // Skip the network roundtrip; Telegram would respond with "message is
      // not modified" anyway and we'd swallow it.
      return
    }
    const parseMode: 'HTML' | undefined = entry.parseDowngraded ? undefined : 'HTML'
    const opts: { parse_mode?: 'HTML' } = {}
    if (parseMode !== undefined) opts.parse_mode = parseMode
    try {
      await this.telegramApi.editMessageText(
        entry.handle.chatId,
        entry.handle.messageId,
        text,
        opts as { parse_mode: 'HTML' },
      )
      entry.lastText = text
      return
    } catch (err) {
      const cls = classifyEditError(err)
      switch (cls.kind) {
        case 'benign':
          // Telegram says "message is not modified" — sync our local
          // cache so the next tick doesn't repeat the same edit.
          entry.lastText = text
          return
        case 'forbidden':
          // Bot was kicked / blocked. Mark the entry disabled so timers
          // and update() / ensureBubble() all bail without further I/O.
          // We deliberately do NOT remove the entry — isActive() must
          // still return true so the outer pipeline knows there is a
          // live session, just one that we can't write to.
          entry.disabled = true
          // MED-A #1: per-chat blocked cache so the next start() also
          // short-circuits before sendMessage.
          this.markChatBlocked(
            entry.handle.chatId,
            `edit ${cls.code}: ${cls.description}`,
          )
          this.log.warn('status edit forbidden, entry disabled', {
            chat_id: entry.handle.chatId,
            code: cls.code,
            description: cls.description,
          })
          return
        case 'message_gone':
          // Target message was deleted (user / Telegram GC / 48h cap).
          // Drop the messageId so we stop chasing it. On the FIRST
          // occurrence we attempt a single recreate via ensureBubble —
          // the bubble flips back to suppressed and the next event
          // will lazy-recreate. On subsequent gone-errors we just
          // drop and rely on the next tick / cancel to surface state.
          this.log.info('status edit target missing', {
            chat_id: entry.handle.chatId,
            message_id: entry.handle.messageId,
            recovery_done: entry.messageGoneRecoveryDone,
          })
          entry.handle.messageId = 0
          entry.lastText = ''
          if (!entry.messageGoneRecoveryDone) {
            entry.messageGoneRecoveryDone = true
            entry.bubbleSuppressed = true
            // ensureBubble bails on suppressBubble && state.kind ===
            // 'typing'; for non-typing states it will fire sendMessage
            // and the rolling tick continues against the fresh id.
            await this.ensureBubble(entry, entry.state)
          }
          return
        case 'parse':
          // Broken HTML / Markdown in the rendered payload. Strip
          // parse_mode for this entry and retry the same text once.
          // Future edits on this entry stay parse_mode-less; the
          // downside (literal `<i>` rendering) is far preferable to an
          // edit storm that never recovers.
          if (!entry.parseDowngraded) {
            entry.parseDowngraded = true
            this.log.warn('status edit parse failure, retrying without parse_mode', {
              chat_id: entry.handle.chatId,
              description: cls.description,
            })
            try {
              await this.telegramApi.editMessageText(
                entry.handle.chatId,
                entry.handle.messageId,
                text,
                {} as { parse_mode: 'HTML' },
              )
              entry.lastText = text
              return
            } catch (err2) {
              this.log.warn('status edit parse retry failed (ignored)', {
                chat_id: entry.handle.chatId,
                error: err2 instanceof Error ? err2.message : String(err2),
              })
              return
            }
          }
          // Already downgraded once — second parse error means the
          // rendered text is genuinely broken. Log and drop.
          this.log.warn('status edit parse failure post-downgrade (ignored)', {
            chat_id: entry.handle.chatId,
            description: cls.description,
          })
          return
        case 'flood': {
          // MED-A #4: pause the chat's tick handlers for retryAfterSec
          // before any more I/O lands. Without this, the next interval
          // tick fired immediately and hit 429 again, generating an
          // edit storm that the rate-limit wrapper had already given
          // up on. Default to 5s when Telegram omitted retry_after.
          const pauseSec = cls.retryAfterSec ?? 5
          entry.pausedUntil = this.now() + pauseSec * 1000
          this.log.warn('status edit 429 post-retry, pausing chat ticks', {
            chat_id: entry.handle.chatId,
            retry_after_s: cls.retryAfterSec,
            paused_for_ms: pauseSec * 1000,
          })
          return
        }
        case 'transient':
          // Network glitch, 5xx, unknown 4xx. Drop and let the next
          // tick retry. lastText is intentionally NOT mutated — the
          // text we tried to send is still pending.
          this.log.warn('status edit failed (ignored)', {
            chat_id: entry.handle.chatId,
            message_id: entry.handle.messageId,
            description: cls.description,
          })
          return
      }
    }
  }

  private stopTimers(entry: InternalEntry): void {
    if (entry.intervalHandle !== null) {
      this.clearTimer(entry.intervalHandle)
      entry.intervalHandle = null
    }
    if (entry.ttlHandle !== null) {
      this.clearTimer(entry.ttlHandle)
      entry.ttlHandle = null
    }
    if (entry.chatActionHandle !== null) {
      this.clearTimer(entry.chatActionHandle)
      entry.chatActionHandle = null
    }
  }

  // Send a single chat action for the entry's current state. Swallows
  // errors — the header indicator is best-effort and a flaky call must
  // not derail the message edit path or surface to the agent. On a 401/
  // 403 we additionally disable the entry so further pulses / edits also
  // bail out.
  private async pulseChatAction(entry: InternalEntry): Promise<void> {
    if (entry.disabled) return
    if (!this.telegramApi.sendChatAction) return
    const action = chatActionFor(entry.state)
    if (action === null) return
    try {
      await this.telegramApi.sendChatAction(entry.handle.chatId, action)
    } catch (err) {
      const cls = classifyEditError(err)
      if (cls.kind === 'forbidden') {
        entry.disabled = true
        // MED-A #1: per-chat blocked cache so the next start() also
        // short-circuits before sendMessage.
        this.markChatBlocked(
          entry.handle.chatId,
          `chat_action ${cls.code}: ${cls.description}`,
        )
        this.log.warn('sendChatAction forbidden, entry disabled', {
          chat_id: entry.handle.chatId,
          code: cls.code,
        })
        return
      }
      this.log.debug('sendChatAction failed (ignored)', {
        chat_id: entry.handle.chatId,
        action,
        kind: cls.kind,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private chatActionTick(chatId: string, generation: number): void {
    const live = this.entries.get(chatId)
    if (!live || live.generation !== generation) return
    if (live.disabled) return
    // MED-A #4: respect the 429 pause window — sendChatAction shares
    // the same per-chat rate-limit bucket as editMessageText, so a
    // pulse during a 429 hold would just re-trigger the flood.
    if (this.now() < live.pausedUntil) {
      const remaining = Math.max(50, live.pausedUntil - this.now())
      live.chatActionHandle = this.setTimer(
        () => this.chatActionTick(chatId, generation),
        Math.min(remaining, CHAT_ACTION_PULSE_MS),
      )
      return
    }
    void this.pulseChatAction(live)
    live.chatActionHandle = this.setTimer(
      () => this.chatActionTick(chatId, generation),
      CHAT_ACTION_PULSE_MS,
    )
  }
}
