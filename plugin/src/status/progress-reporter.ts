// ProgressReporter — persistent Telegram thread showing per-tool activity
// in real time. Owns ONE message per chat, edited via editMessageText as
// new Claude hook events arrive.
//
// Why separate from StatusManager:
//   * StatusManager owns a transient bubble that auto-cancels on every
//     real reply (see status-manager.ts: «start() while active silently
//     cancels»). Result: the warchief sees nothing.
//   * ProgressReporter owns a different message that persists through
//     replies — a running log of «what Thrall is doing now». Both
//     coexist; the webhook fires them in parallel and independently.
//
// Design contract (from Codex GPT-5.5 plan 2026-05-18 + dual review fixes):
//   * `recordEvent(chatId, event)` is fire-and-forget from the caller's
//     point of view. Top-level try/catch swallows all throws and logs.
//   * Single-slot per-chat queue: at most one Telegram request in flight
//     per chat. New events while one is in flight overwrite `desiredText`
//     so the freshest snapshot publishes after the in-flight settles.
//     This serializes send/edit ordering and removes both the first-send
//     race and out-of-order edit landings (review findings C1, Codex §3).
//   * Throttle: `edit_throttle_ms` between successive edits. First send
//     bypasses throttle (immediate). Subsequent edits within the window
//     defer via a single one-shot timer.
//   * Stop awaits any in-flight flush before posting the final
//     «✓ done -- Ns» line (review C2/H1 fix — no orphan messages).
//   * Session TTL: an entry older than `session_ttl_ms` since last
//     activity is evicted on next event for the chat. Protects against
//     lost session_stop hooks and cross-session pollution (review C2).
//   * Telegram failures are caught + logged at warn; state stays alive
//     so the next event can retry.

import type { AppConfig } from '../config.js'
import type { Logger } from '../log.js'
import type { ActivityStatusEvent } from '../hooks/claude-events.js'
import {
  buildActivityDetail,
  buildHumanizedActivityLine,
  renderActivityBlock,
  type ActivityCall,
  type ActivitySnapshot,
} from './activity-renderer.js'

// Telegram surface shared with task-mirror. Canonical definition lives in
// `./telegram-api.ts` so both modules depend on it instead of on each
// other. Re-exported here for back-compat with existing imports
// (`from './progress-reporter.js'` is still legal but new code should
// import from `./telegram-api.js` directly).
export type { TelegramApiForProgress } from './telegram-api.js'
import type { TelegramApiForProgress } from './telegram-api.js'

export interface ProgressReporterDeps {
  telegramApi: TelegramApiForProgress
  config: AppConfig
  log: Logger
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout
  clearTimer?: (handle: NodeJS.Timeout) => void
}

// Per-chat lifecycle: lazy-created on first event, evicted on
// session_stop or TTL expiry.
//
// Ordering invariant: at any time, at most ONE of `flushPromise`
// (in-flight Telegram op) and `pendingTimer` (throttle-deferred flush)
// is non-null. `desiredText` accumulates the newest text to publish.
interface ChatProgressEntry {
  chatId: string
  messageId?: number
  startedAtMs: number
  // Updated on every recordEvent. Used by TTL eviction in getOrCreate.
  lastActivityMs: number
  // Sliding window of recent ActivityCalls; renderer caps the display.
  calls: ActivityCall[]
  // Last text we actually sent / edited. Skip Telegram round-trip when
  // newly rendered body is identical.
  lastRenderedText?: string
  // Timestamp of the last successful send or edit. Used for throttle.
  lastEditAtMs: number
  // Newest snapshot text waiting to be published. Multiple events
  // overwrite this so only the freshest view ever lands on Telegram.
  desiredText?: string
  // Single-slot scheduler: non-null while a Telegram op is in flight.
  // After it settles, we re-check `desiredText` and re-arm if needed.
  flushPromise: Promise<void> | null
  // Single-slot throttle timer. Non-null while waiting for the throttle
  // window to elapse before publishing `desiredText`.
  pendingTimer: NodeJS.Timeout | null
  // True once Stop has been processed. Guards idempotency.
  stopped: boolean
}

// HTML used as parse_mode for both send and edit so renderActivityBlock's
// inline tags (<b>, <code>, <pre>) are rendered.
const HTML_OPTS = { parse_mode: 'HTML' as const }

// Tools that should never appear in the rolling activity card. Deferred-tool
// lookups (ToolSearch) are pure bookkeeping; the dashi-channel MCP reply tools
// are the channel itself (mirroring them would recurse), and gbrain-recall is
// background context fetching the operator does not need to see.
//
// NB: Read/Grep/Glob are intentionally NOT skipped — the operator's preferred
// verbose card (gateway era) listed reads and globs alongside Bash/Edit. They
// were un-filtered 2026-06-14 to restore that density. Bash/Edit/Write/
// WebFetch/WebSearch/Agent and gbrain mutations always flow through.
const NOISY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'ToolSearch',
])
const NOISY_TOOL_PREFIXES: ReadonlyArray<string> = [
  'mcp__dashi-channel__',
  'mcp__dashi-gbrain-recall__',
]

export function shouldSkipTool(toolName: string): boolean {
  if (NOISY_TOOL_NAMES.has(toolName)) return true
  return NOISY_TOOL_PREFIXES.some((p) => toolName.startsWith(p))
}

export class ProgressReporter {
  private readonly telegramApi: TelegramApiForProgress
  private readonly config: AppConfig
  private readonly log: Logger
  private readonly now: () => number
  private readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout
  private readonly clearTimer: (handle: NodeJS.Timeout) => void
  private readonly chats: Map<string, ChatProgressEntry>

  constructor(deps: ProgressReporterDeps) {
    this.telegramApi = deps.telegramApi
    this.config = deps.config
    this.log = deps.log
    this.now = deps.now ?? (() => Date.now())
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))
    this.chats = new Map()
  }

  /**
   * Main entry point. Called by the webhook handler for every
   * `claude_hook` payload. Never throws — top-level try/catch swallows
   * any failure so the webhook 200 path is never blocked.
   */
  async recordEvent(chatId: string, event: ActivityStatusEvent): Promise<void> {
    if (!this.config.progress.enabled) return
    try {
      if (event.kind === 'session_stop') {
        await this.handleStop(chatId)
        return
      }

      const entry = this.getOrCreate(chatId)
      if (entry.stopped) return
      entry.lastActivityMs = this.now()
      this.applyEvent(entry, event)
      this.scheduleFlush(entry)
    } catch (err) {
      this.log.warn('progress reporter recordEvent failed (ignored)', {
        chat_id: chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Read-only: returns true if a Claude session is actively running tools
   * for this chat — used by InboundWatcher to decide whether to auto-reply
   * «Тралл занят». Definition:
   *   entry exists AND !entry.stopped AND (now - lastActivityMs) < threshold
   *
   * `thresholdMs` is REQUIRED — the watcher owns the threshold via its
   * own config slice and passes it in. This module deliberately does NOT
   * reach into `config.watcher` to keep the dependency direction one-way
   * (status module is upstream of watcher; watcher reads from us, not the
   * other way around).
   *
   * Boundary semantics: strict `<` so a tick at exactly the threshold is
   * already considered idle — matches the natural «more than N ms idle =
   * not busy» reading.
   */
  isBusy(chatId: string, thresholdMs: number): boolean {
    const entry = this.chats.get(chatId)
    if (!entry || entry.stopped) return false
    return this.now() - entry.lastActivityMs < thresholdMs
  }

  /**
   * Returns the most recently OBSERVED tool name from the calls window for
   * this chat, or `undefined` if no entry exists / no tools have been
   * recorded. Used by InboundWatcher to compose the auto-reply body —
   * «активный инструмент: Bash».
   *
   * Important semantic note for future maintainers:
   *   The name STAYS POPULATED after `tool_end`. We do NOT clear it on
   *   tool completion. This is intentional — the watcher's busy-threshold
   *   accounts for the gap between `tool_end` and the next `tool_start`.
   *   Returning `undefined` here during that brief idle window would cause
   *   false-negative auto-replies (the watcher would see «not busy» and
   *   suppress the «Тралл занят» message even though Claude is about to
   *   call the next tool any millisecond now).
   *
   *   `tool_end` is render-only inside this module (see applyEvent) — it
   *   moves the elapsed counter forward without mutating `entry.calls`.
   *   The latest call therefore continues to anchor the «active tool»
   *   answer until either (a) a fresh `tool_start` overwrites it or
   *   (b) the chat is evicted by session_stop / TTL.
   */
  getActiveToolName(chatId: string): string | undefined {
    const entry = this.chats.get(chatId)
    if (!entry || entry.calls.length === 0) return undefined
    return entry.calls[entry.calls.length - 1]?.toolName
  }

  /**
   * Test-only: wait until any in-flight Telegram operation for the given
   * chat settles AND any follow-up reschedule completes. Used by unit
   * tests to assert on `TelegramApi.calls` after asynchronous
   * publication finishes. Production callers should NOT depend on this.
   */
  async _idleForTests(chatId: string): Promise<void> {
    // Drain up to a small fixed number of cycles. Each iteration awaits
    // the current flushPromise (if any), which may schedule a follow-up
    // flush in its finally handler; the next iteration picks that up.
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

  private getOrCreate(chatId: string): ChatProgressEntry {
    const existing = this.chats.get(chatId)
    if (existing) {
      // TTL eviction: if too long since last activity, treat this as a
      // new session. The old entry (whose Telegram message we never
      // finalized because session_stop was lost) is discarded — its
      // message is left in Telegram as-is, no edit attempted.
      const idle = this.now() - existing.lastActivityMs
      if (idle > this.config.progress.session_ttl_ms) {
        this.log.debug('progress entry TTL expired, starting fresh thread', {
          chat_id: chatId,
          idle_ms: idle,
        })
        this.chats.delete(chatId)
      } else {
        return existing
      }
    }
    const entry: ChatProgressEntry = {
      chatId,
      startedAtMs: this.now(),
      lastActivityMs: this.now(),
      calls: [],
      lastEditAtMs: 0,
      flushPromise: null,
      pendingTimer: null,
      stopped: false,
    }
    this.chats.set(chatId, entry)
    return entry
  }

  /**
   * Mutate `entry.calls` based on the event. tool_start appends; other
   * non-Stop events are render-only (move the elapsed counter forward).
   *
   * Noise-filter: tool names in `NOISY_TOOLS` (Read/Grep/Glob/ToolSearch and
   * the dashi-channel + recall MCP prefixes) update `lastActivityMs` upstream
   * but never enter `entry.calls`, so the rolling card stays focused on
   * meaningful actions (Bash, Edit, Write, WebFetch, Agent, gbrain mutations).
   */
  private applyEvent(entry: ChatProgressEntry, event: ActivityStatusEvent): void {
    switch (event.kind) {
      case 'tool_start': {
        if (shouldSkipTool(event.toolName)) break
        const detail = buildActivityDetail(event.toolName, event.toolInput)
        const humanized = buildHumanizedActivityLine(event.toolName, event.toolInput)
        const call: ActivityCall = { toolName: event.toolName, detail, humanized }
        entry.calls.push(call)
        const cap = this.config.progress.recent_buffer
        if (entry.calls.length > cap) {
          entry.calls.splice(0, entry.calls.length - cap)
        }
        break
      }
      case 'tool_end':
      case 'reasoning':
      case 'session_start':
        // Re-render only. No buffer mutation. The «working -- Ns» header
        // moves forward with elapsed time.
        break
      case 'session_stop':
        // Handled before applyEvent in recordEvent; unreachable here but
        // kept for exhaustiveness.
        break
    }
  }

  /**
   * Render the current snapshot and schedule a flush. Idempotent — if a
   * flush is already in progress or a timer is already armed, just
   * update `desiredText` and return.
   */
  private scheduleFlush(entry: ChatProgressEntry): void {
    if (entry.stopped) return
    const snapshot = this.buildSnapshot(entry)
    const text = this.safeRender(snapshot)
    if (!text || text === entry.lastRenderedText) return
    entry.desiredText = text

    // If a flush is already running or a timer is already armed, the
    // desiredText we just stored will be picked up at the end of the
    // current cycle. Nothing more to do here.
    if (entry.flushPromise !== null || entry.pendingTimer !== null) return

    const isFirstSend = entry.messageId === undefined
    const elapsed = this.now() - entry.lastEditAtMs
    const wait = isFirstSend
      ? 0
      : Math.max(0, this.config.progress.edit_throttle_ms - elapsed)

    if (wait > 0) {
      entry.pendingTimer = this.setTimer(() => {
        entry.pendingTimer = null
        this.startFlush(entry)
      }, wait)
    } else {
      this.startFlush(entry)
    }
  }

  /**
   * Kick off a Telegram round-trip if there is text to publish and no
   * flush in progress. Sets `flushPromise` for the duration of the
   * round-trip; on settle, re-checks `desiredText` and reschedules.
   */
  private startFlush(entry: ChatProgressEntry): void {
    if (entry.stopped) return
    if (entry.flushPromise !== null) return
    const text = entry.desiredText
    if (text === undefined || text === entry.lastRenderedText) return
    delete entry.desiredText

    entry.flushPromise = this.executeFlush(entry, text).finally(() => {
      entry.flushPromise = null
      // Re-schedule if a newer text accumulated during the flush.
      if (
        !entry.stopped &&
        entry.desiredText !== undefined &&
        entry.desiredText !== entry.lastRenderedText
      ) {
        this.scheduleFlush(entry)
      }
    })
  }

  /**
   * The actual Telegram round-trip. First call sends; subsequent calls
   * edit the existing message. All errors caught + logged; state
   * mutations (`messageId`, `lastRenderedText`, `lastEditAtMs`) are
   * gated on `!entry.stopped` so a Stop arriving mid-flight leaves the
   * entry clean for eviction.
   */
  private async executeFlush(entry: ChatProgressEntry, text: string): Promise<void> {
    if (entry.messageId === undefined) {
      try {
        const sent = await this.telegramApi.sendMessage(entry.chatId, text, HTML_OPTS)
        if (!entry.stopped) {
          entry.messageId = sent.message_id
          entry.lastRenderedText = text
          entry.lastEditAtMs = this.now()
        } else {
          // Stop arrived while we were sending. The message exists in
          // Telegram but our entry was evicted before send resolved —
          // we cannot finalize without owning the entry. Log so an
          // operator can find the orphan if it matters.
          this.log.warn('progress send completed after stop (orphan)', {
            chat_id: entry.chatId,
            message_id: sent.message_id,
          })
        }
      } catch (err) {
        this.log.warn('progress reporter sendMessage failed (ignored)', {
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
      }
    } catch (err) {
      this.log.warn('progress reporter editMessageText failed (ignored)', {
        chat_id: entry.chatId,
        message_id: entry.messageId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private buildSnapshot(entry: ChatProgressEntry): ActivitySnapshot {
    return {
      startedAtMs: entry.startedAtMs,
      calls: entry.calls,
      phase: entry.calls.length > 0 ? 'tool' : 'reasoning',
    }
  }

  private safeRender(snapshot: ActivitySnapshot): string {
    try {
      return renderActivityBlock(snapshot, this.now())
    } catch (err) {
      this.log.warn('progress reporter render failed (ignored)', {
        error: err instanceof Error ? err.message : String(err),
      })
      return ''
    }
  }

  /**
   * session_stop handler — cancels the throttle timer, awaits any
   * in-flight flush, then posts a final «done -- Ns» edit on the
   * existing message (if one was sent). Idempotent: second call is a
   * no-op. Evicts the entry so a follow-up event in the same chat
   * starts a fresh thread.
   */
  private async handleStop(chatId: string): Promise<void> {
    const entry = this.chats.get(chatId)
    if (!entry || entry.stopped) return
    entry.stopped = true

    if (entry.pendingTimer !== null) {
      this.clearTimer(entry.pendingTimer)
      entry.pendingTimer = null
    }

    // Wait for any in-flight Telegram op to settle so we don't race the
    // final edit against an outstanding send/edit. The promise itself
    // never rejects (executeFlush catches), but use try/catch defensively.
    if (entry.flushPromise !== null) {
      try {
        await entry.flushPromise
      } catch {
        /* already logged inside executeFlush */
      }
    }

    if (entry.messageId !== undefined) {
      const text = this.renderFinal(entry)
      if (text && text !== entry.lastRenderedText) {
        try {
          await this.telegramApi.editMessageText(entry.chatId, entry.messageId, text, HTML_OPTS)
          entry.lastRenderedText = text
        } catch (err) {
          this.log.warn('progress reporter final edit failed (ignored)', {
            chat_id: entry.chatId,
            message_id: entry.messageId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    this.chats.delete(chatId)
  }

  /**
   * Final-line render: re-uses renderActivityBlock to keep visual
   * parity with intermediate edits, then appends «done -- Ns» as the
   * last line inside the <pre> body so a single block paragraph remains.
   */
  private renderFinal(entry: ChatProgressEntry): string {
    const snapshot = this.buildSnapshot(entry)
    const block = this.safeRender(snapshot)
    if (!block) return ''
    const elapsedSec = Math.max(0, Math.floor((this.now() - entry.startedAtMs) / 1000))
    const doneLine = `\n\ndone -- ${elapsedSec}s`
    if (block.endsWith('</pre>')) {
      return `${block.slice(0, -'</pre>'.length)}${doneLine}</pre>`
    }
    return `${block}${doneLine}`
  }
}
