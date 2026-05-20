// InboundWatcher — auto-reply «Тралл занят» when the warchief sends plain
// text while a Claude session is mid-tool. Sits between OOB resolution and
// the gate/notify call in `handleInboundText` — OOB always takes priority,
// and the watcher NEVER replaces the channel notification (auto-reply AND
// gate-and-notify both fire on a busy chat).
//
// Behaviour contract (plan §2.2, warchief defaults 2026-05-20):
//   * Disabled (`config.watcher.enabled === false`) → no-op, reason='disabled'.
//   * Not busy (per ProgressReporter.isBusy) → no-op, reason='not-busy'.
//   * Debounced — within `config.watcher.debounce_ms` of the last successful
//     auto-reply for THIS chat → no-op, reason='debounced'.
//   * Send fails — caught, reason='send-failed', lastReplyMs NOT updated so
//     the next message can retry.
//   * Otherwise — `sendMessage` quote-replies the warchief's message via
//     `reply_to_message_id`, lastReplyMs updates, return `{ replied: true }`.
//
// Tone constraints (rules.md):
//   * No emoji in production paths. The warchief explicitly asked for «🔧»
//     prefix on auto-reply (visual cue that Тралл is mid-tool — single
//     character, anchored, NOT a decorative emoji string).
//   * HTML output through `escapeHtml` for the tool name; the safe-wrapper
//     also validates HTML before send.

import type { AppConfig } from '../config.js'
import type { Logger } from '../log.js'
import type { TelegramApi } from '../channel/tools.js'
import { escapeHtml } from '../format/html.js'

// Narrow read-only view of ProgressReporter — watcher must not mutate
// reporter state. Both methods are implemented in `progress-reporter.ts`
// as plain accessors over `chats: Map<string, ChatProgressEntry>`.
export interface ProgressReporterForWatcher {
  isBusy(chatId: string, thresholdMs?: number): boolean
  getActiveToolName(chatId: string): string | undefined
}

export interface WatcherDeps {
  telegramApi: TelegramApi
  config: AppConfig
  log: Logger
  progressReporter: ProgressReporterForWatcher
  now?: () => number
}

export interface AutoReplyInput {
  readonly chatId: string
  readonly messageId: number
  readonly text: string
}

export type AutoReplyResult =
  | { readonly replied: true }
  | { readonly replied: false; readonly reason: AutoReplyReason }

export type AutoReplyReason =
  | 'disabled'
  | 'not-busy'
  | 'debounced'
  | 'send-failed'

export class InboundWatcher {
  private readonly telegramApi: TelegramApi
  private readonly config: AppConfig
  private readonly log: Logger
  private readonly progressReporter: ProgressReporterForWatcher
  private readonly now: () => number
  private readonly lastReplyMs: Map<string, number>

  constructor(deps: WatcherDeps) {
    this.telegramApi = deps.telegramApi
    this.config = deps.config
    this.log = deps.log
    this.progressReporter = deps.progressReporter
    this.now = deps.now ?? (() => Date.now())
    this.lastReplyMs = new Map()
  }

  /**
   * Fire-and-forget entry point — caller MUST schedule via `void` so
   * channel-notification latency never depends on Telegram round-trips.
   * The method itself never throws: send failures are caught and logged.
   */
  async maybeAutoReply(input: AutoReplyInput): Promise<AutoReplyResult> {
    try {
      if (!this.config.watcher.enabled) {
        return { replied: false, reason: 'disabled' }
      }
      if (!this.progressReporter.isBusy(input.chatId)) {
        return { replied: false, reason: 'not-busy' }
      }
      const last = this.lastReplyMs.get(input.chatId)
      if (last !== undefined && this.now() - last < this.config.watcher.debounce_ms) {
        return { replied: false, reason: 'debounced' }
      }

      const toolName = this.progressReporter.getActiveToolName(input.chatId)
      const text = composeAutoReply(toolName)

      try {
        await this.telegramApi.sendMessage(input.chatId, text, {
          parse_mode: 'HTML',
          reply_to_message_id: input.messageId,
        })
      } catch (err) {
        this.log.warn('watcher sendMessage failed (ignored)', {
          chat_id: input.chatId,
          error: err instanceof Error ? err.message : String(err),
        })
        return { replied: false, reason: 'send-failed' }
      }

      this.lastReplyMs.set(input.chatId, this.now())
      return { replied: true }
    } catch (err) {
      // Outer safety net — never escape recordEvent-style guard.
      this.log.warn('watcher maybeAutoReply failed (ignored)', {
        chat_id: input.chatId,
        error: err instanceof Error ? err.message : String(err),
      })
      return { replied: false, reason: 'send-failed' }
    }
  }
}

/**
 * Compose the auto-reply body. Exposed for tests so the HTML shape is
 * pinned without invoking the full class.
 */
export function composeAutoReply(toolName: string | undefined): string {
  const tool = toolName ?? '…'
  return `🔧 Тралл занят, активный инструмент: <code>${escapeHtml(tool)}</code>. Жди или /stop.`
}
