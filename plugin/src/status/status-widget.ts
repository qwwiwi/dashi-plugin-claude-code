// Model-free status card (#151).
//
// The plugin runs an operator-configured command (argv, no shell) on a timer,
// takes the card state JSON from its stdout and keeps ONE private-chat widget
// up to date with the status template. No model is involved at any point:
// nothing here touches the MCP session, the channel notification path or the
// outbound-activity clock (the card send opts out with skipOutboundStamp).
//
// Failure policy: a failed command, a timeout, invalid JSON, an oversized
// state or one the redactor would change NEVER reaches Telegram: the previous
// card stays, one warning (reason only, never the payload) is logged and the
// next tick retries with exponential backoff (capped). The tick never throws.
//
// Persistence: chat id + message id of the tracked card are stored in the
// plugin state dir, so a restart keeps editing the SAME message. A lost
// message («message to edit not found» / «can't be edited») is forgotten and
// a fresh card is sent on the next tick.

import type { SendWidgetParams, TelegramApi } from '../channel/tools.js'
import { checkWidgetHtml, checkWidgetPayload } from '../channel/widget.js'
import type { AppConfig } from '../config.js'
import type { Logger } from '../log.js'
import type { CommandResult, CommandRunner } from './status-widget-runner.js'

export type { CommandResult, CommandRunner } from './status-widget-runner.js'

// The state is a Bot API chat_data: UTF-8 <= 1024 bytes. The command may
// print a little more than that (indentation, newline) before it is
// compacted, but never an unbounded stream.
const STDOUT_CAP_BYTES = 16 * 1024
const MAX_BACKOFF_MS = 600_000

export interface StoredCard {
  chatId: string
  messageId: number
}

export interface StatusWidgetStore {
  read(): StoredCard | undefined
  write(card: StoredCard): void
  clear(): void
}

export type StatusWidgetSettings = NonNullable<AppConfig['status_widget']>

export interface StatusWidgetDeps {
  config: Pick<StatusWidgetSettings, 'command' | 'interval_sec' | 'timeout_ms'> & { chat_id: string }
  api: Pick<TelegramApi, 'sendWidget' | 'editWidgetData'>
  runner: CommandRunner
  store: StatusWidgetStore
  // Contents of templates/status.html.
  html: string
  // Applies the plugin's redactor; a changed result means «looks like a secret».
  redact: (text: string) => string
  log: Logger
  // Test seam: schedule(fn, delayMs) returns a cancel function.
  schedule?: (fn: () => void, delayMs: number) => () => void
}

export type FreshCardResult = { ok: true } | { ok: false; reason: string }

export interface StatusWidgetService {
  start(): void
  stop(): void
  // One refresh cycle. Never throws.
  tick(): Promise<void>
  // Send a FRESH card right now and track it (the /card command).
  sendFresh(chatId: string): Promise<FreshCardResult>
}

interface ValidState {
  data: string
  caption: string
}

type StateRead = { ok: true; state: ValidState } | { ok: false; reason: string }

// Telegram answers for an edit of a deleted/unknown message. The card is gone:
// forget it and send a new one.
const MESSAGE_GONE = /message to edit not found|message can't be edited|message_id_invalid|message to be edited not found/i

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

export function createStatusWidgetService(deps: StatusWidgetDeps): StatusWidgetService {
  const { config, api, runner, store, html, redact, log } = deps
  const intervalMs = config.interval_sec * 1000
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number): (() => void) => {
      const t = setTimeout(fn, ms)
      return () => clearTimeout(t)
    })

  // A stored card of another chat (config changed) is not ours to edit.
  const stored = store.read()
  let card: StoredCard | undefined = stored !== undefined && stored.chatId === config.chat_id ? stored : undefined
  // Bytes of the last state that LANDED on the tracked card.
  let lastData: string | undefined
  // Last validated state, kept for /card when the command is failing.
  let lastGood: ValidState | undefined
  let failures = 0
  let stopped = false
  let cancelNext: (() => void) | undefined
  // Ticks and /card run one at a time.
  let queue: Promise<unknown> = Promise.resolve()

  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function readState(): Promise<StateRead> {
    let result: CommandResult
    try {
      result = await runner(config.command, { timeoutMs: config.timeout_ms, maxStdoutBytes: STDOUT_CAP_BYTES })
    } catch {
      return { ok: false, reason: 'runner_error' }
    }
    if (!result.ok) return { ok: false, reason: `command_${result.reason}` }
    const text = result.stdout.trim()
    if (text === '') return { ok: false, reason: 'empty_output' }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, reason: 'invalid_json' }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: 'not_a_json_object' }
    }
    // Compact form: whitespace-only differences are not a change.
    const data = JSON.stringify(parsed)
    // Same shared payload check the tools use (size in BYTES).
    const tooBig = checkWidgetPayload({ chat_data: data })
    if (tooBig !== undefined) return { ok: false, reason: tooBig }
    // Fail closed, like the safe API layer: never send state the redactor would rewrite.
    if (redact(data) !== data) return { ok: false, reason: 'refused_by_redaction' }
    const rec = parsed as Record<string, unknown>
    return {
      ok: true,
      state: { data, caption: `Статус: этапов ${countOf(rec.m)}, задач ${countOf(rec.j)}` },
    }
  }

  async function sendCard(state: ValidState): Promise<void> {
    const params: SendWidgetParams = {
      html,
      caption: state.caption,
      chat_data: state.data,
      // The card is the plugin talking to itself, not the model talking to the owner.
      skipOutboundStamp: true,
    }
    const sent = await api.sendWidget(config.chat_id, params)
    card = { chatId: config.chat_id, messageId: sent.message_id }
    lastData = state.data
    try {
      store.write(card)
    } catch (err) {
      // The card is delivered; losing the record only costs a duplicate after a restart.
      log.warn('status widget: could not persist the card record', { error: errorText(err) })
    }
  }

  // Returns true when the cycle was healthy (no backoff needed).
  async function cycle(): Promise<boolean> {
    const read = await readState()
    if (!read.ok) {
      log.warn('status widget: state not refreshed, keeping the previous card', { reason: read.reason })
      return false
    }
    const { state } = read
    lastGood = state
    if (card === undefined) {
      try {
        await sendCard(state)
        return true
      } catch (err) {
        log.warn('status widget: send failed', { error: errorText(err) })
        return false
      }
    }
    if (state.data === lastData) return true
    try {
      await api.editWidgetData(card.chatId, card.messageId, state.data)
      lastData = state.data
      return true
    } catch (err) {
      const text = errorText(err)
      if (MESSAGE_GONE.test(text)) {
        log.warn('status widget: the card message is gone, a fresh card follows on the next tick')
        card = undefined
        lastData = undefined
        try {
          store.clear()
        } catch (clearErr) {
          log.warn('status widget: could not clear the card record', { error: errorText(clearErr) })
        }
        return true
      }
      log.warn('status widget: edit failed', { error: text })
      return false
    }
  }

  async function tick(): Promise<void> {
    await exclusive(async () => {
      try {
        failures = (await cycle()) ? 0 : failures + 1
      } catch (err) {
        failures += 1
        log.warn('status widget: unexpected tick error', { error: errorText(err) })
      }
    })
  }

  function nextDelayMs(): number {
    if (failures === 0) return intervalMs
    return Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS)
  }

  async function loop(): Promise<void> {
    cancelNext = undefined
    if (stopped) return
    await tick()
    if (stopped) return
    cancelNext = schedule(() => void loop(), nextDelayMs())
  }

  return {
    start(): void {
      const refusal = checkWidgetHtml(html)
      if (refusal !== undefined) {
        log.error('status widget disabled: the status template is not sendable', { reason: refusal })
        return
      }
      stopped = false
      cancelNext = schedule(() => void loop(), 0)
    },

    stop(): void {
      stopped = true
      cancelNext?.()
      cancelNext = undefined
    },

    tick,

    async sendFresh(chatId: string): Promise<FreshCardResult> {
      if (chatId !== config.chat_id) {
        return { ok: false, reason: 'карточка статуса настроена для другого чата' }
      }
      return exclusive(async (): Promise<FreshCardResult> => {
        const read = await readState()
        let state: ValidState
        if (read.ok) {
          state = read.state
          lastGood = state
        } else if (lastGood !== undefined) {
          log.warn('status widget: /card uses the last good state', { reason: read.reason })
          state = lastGood
        } else {
          log.warn('status widget: /card has no state to show', { reason: read.reason })
          return { ok: false, reason: 'нет состояния: команда статуса не отдала корректный JSON' }
        }
        try {
          await sendCard(state)
          return { ok: true }
        } catch (err) {
          log.warn('status widget: /card send failed', { error: errorText(err) })
          return { ok: false, reason: 'не удалось отправить карточку, подробности в логе плагина' }
        }
      })
    },
  }
}

// The card goes to a chat only when the widget tools could also reach it: the
// chat must be on the legacy allowlist (multichat mode lists its chats there
// too).
export function isStatusWidgetChatAllowed(config: Pick<AppConfig, 'allowed_chat_ids'>, chatId: string): boolean {
  return config.allowed_chat_ids.some((id) => String(id) === chatId)
}
