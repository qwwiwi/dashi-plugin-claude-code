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
import { escapeHtml } from '../format/html.js'

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
  | { kind: 'stopped'; reason?: string }
  | { kind: 'error'; reason?: string }

export interface StatusHandle {
  readonly chatId: string
  readonly messageId: number
  readonly startedAt: number
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
}

interface InternalEntry {
  handle: StatusHandle
  state: StatusState
  // Cycle index used to advance the dot animation on each tick.
  tick: number
  lastText: string
  intervalHandle: NodeJS.Timeout | null
  ttlHandle: NodeJS.Timeout | null
  // Separate cadence from the message edit ticker — see CHAT_ACTION_PULSE_MS.
  chatActionHandle: NodeJS.Timeout | null
}

// Reuse Telegram's "message is not modified" detection. We can't import a
// real grammY error class here (would couple status module to grammY); use
// a substring check that matches the wire payload Telegram returns.
function isMessageNotModifiedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /message is not modified/i.test(msg)
}

function renderState(state: StatusState, tick: number): string {
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
    // Only one active status per chat at a time: finalise the previous one
    // (edit the old message to "Остановлено: superseded" and clear timers)
    // so we don't leak a stale "Печатает…" message on top of the new one.
    // Album-path callers in handlers.ts call start() once per album item;
    // without this terminate step the first item's pulse stays forever.
    if (this.entries.has(chatId)) {
      await this.cancel(chatId, 'superseded')
    }

    const text = renderState(initialState, 0)
    const sendOpts: { parse_mode: 'HTML'; reply_to_message_id?: number } = {
      parse_mode: 'HTML',
    }
    if (replyToMessageId !== undefined) sendOpts.reply_to_message_id = replyToMessageId

    let sent: { message_id: number }
    try {
      sent = await this.telegramApi.sendMessage(chatId, text, sendOpts)
    } catch (err) {
      // If we can't even send the initial status, log and rethrow — caller
      // can decide whether to proceed without status. (handlers.ts treats
      // status as best-effort and will catch this.)
      this.log.warn('status start failed', {
        chat_id: chatId,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }

    const handle: StatusHandle = {
      chatId,
      messageId: sent.message_id,
      startedAt: this.now(),
    }
    const entry: InternalEntry = {
      handle,
      state: initialState,
      tick: 0,
      lastText: text,
      intervalHandle: null,
      ttlHandle: null,
      chatActionHandle: null,
    }
    this.entries.set(chatId, entry)

    // Fire-and-forget initial chat action so the Telegram header shows
    // `typing…` immediately, not on the first pulse 4 s in.
    void this.pulseChatAction(entry)
    entry.chatActionHandle = this.setTimer(
      () => this.chatActionTick(chatId, handle.messageId),
      CHAT_ACTION_PULSE_MS,
    )

    // Periodic tick — re-edit with advanced ellipsis (typing/thinking only)
    // or keep the same text for tool/stopped/error states. Same-text edits
    // collapse via the "message is not modified" swallow path below.
    const tick = (): void => {
      const live = this.entries.get(chatId)
      if (!live || live.handle.messageId !== handle.messageId) return
      live.tick += 1
      const next = renderState(live.state, live.tick)
      void this.editSafely(live, next)
      // Re-arm next tick.
      live.intervalHandle = this.setTimer(tick, this.config.status.interval_ms)
    }
    entry.intervalHandle = this.setTimer(tick, this.config.status.interval_ms)

    // TTL guard. On expiry we cancel with reason='ttl' so the message turns
    // into "Остановлено: ttl" rather than vanishing silently.
    entry.ttlHandle = this.setTimer(() => {
      const live = this.entries.get(chatId)
      if (!live || live.handle.messageId !== handle.messageId) return
      void this.cancel(chatId, 'ttl')
    }, this.config.status.ttl_ms)

    return handle
  }

  async update(handle: StatusHandle, state: StatusState): Promise<void> {
    const entry = this.entries.get(handle.chatId)
    if (!entry || entry.handle.messageId !== handle.messageId) {
      // Stale handle — caller is editing something already completed.
      // Drop silently; the original status is gone.
      return
    }
    entry.state = state
    // Reset tick on state change so the ellipsis animation restarts at 1.
    entry.tick = 0
    const text = renderState(state, 0)
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

  async complete(chatId: string): Promise<void> {
    const entry = this.entries.get(chatId)
    if (!entry) return
    this.stopTimers(entry)
    this.entries.delete(chatId)
    if (this.config.status.delete_on_complete && this.telegramApi.deleteMessage) {
      try {
        await this.telegramApi.deleteMessage(chatId, entry.handle.messageId)
      } catch (err) {
        // Stale message, deleted by user, or permission issue — never fatal.
        this.log.debug('status delete failed (ignored)', {
          chat_id: chatId,
          message_id: entry.handle.messageId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  async cancel(chatId: string, reason: string): Promise<void> {
    const entry = this.entries.get(chatId)
    if (!entry) return
    this.stopTimers(entry)
    this.entries.delete(chatId)
    const text = renderState({ kind: 'stopped', reason }, 0)
    try {
      await this.telegramApi.editMessageText(
        chatId,
        entry.handle.messageId,
        text,
        { parse_mode: 'HTML' },
      )
    } catch (err) {
      if (!isMessageNotModifiedError(err)) {
        this.log.warn('status cancel edit failed', {
          chat_id: chatId,
          message_id: entry.handle.messageId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  // ───── internals ─────

  private async editSafely(entry: InternalEntry, text: string): Promise<void> {
    if (text === entry.lastText) {
      // Skip the network roundtrip; Telegram would respond with "message is
      // not modified" anyway and we'd swallow it.
      return
    }
    try {
      await this.telegramApi.editMessageText(
        entry.handle.chatId,
        entry.handle.messageId,
        text,
        { parse_mode: 'HTML' },
      )
      entry.lastText = text
    } catch (err) {
      if (isMessageNotModifiedError(err)) {
        // Treat as success — sync our local cache so we don't retry next tick.
        entry.lastText = text
        return
      }
      this.log.warn('status edit failed (ignored)', {
        chat_id: entry.handle.chatId,
        message_id: entry.handle.messageId,
        error: err instanceof Error ? err.message : String(err),
      })
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
  // not derail the message edit path or surface to the agent.
  private async pulseChatAction(entry: InternalEntry): Promise<void> {
    if (!this.telegramApi.sendChatAction) return
    const action = chatActionFor(entry.state)
    if (action === null) return
    try {
      await this.telegramApi.sendChatAction(entry.handle.chatId, action)
    } catch (err) {
      this.log.debug('sendChatAction failed (ignored)', {
        chat_id: entry.handle.chatId,
        action,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private chatActionTick(chatId: string, messageId: number): void {
    const live = this.entries.get(chatId)
    if (!live || live.handle.messageId !== messageId) return
    void this.pulseChatAction(live)
    live.chatActionHandle = this.setTimer(
      () => this.chatActionTick(chatId, messageId),
      CHAT_ACTION_PULSE_MS,
    )
  }
}
