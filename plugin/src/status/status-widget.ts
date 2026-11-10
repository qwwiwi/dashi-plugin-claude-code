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
// Persistence (state machine EMPTY / TRACKED / UNCERTAIN): the tracked card id
// survives a restart, so the SAME message keeps being edited. A card send is
// not idempotent and Telegram may deliver it while the answer is lost, so a
// pending attempt (id + time) is persisted BEFORE every send:
//   - confirmed success      -> TRACKED
//   - confirmed non-delivery -> the pre-attempt record is restored
//   - anything else          -> stays UNCERTAIN: no automatic work at all (also
//                               after a restart, no expiry) until the owner
//                               sends /card, which accepts a possible duplicate.
// A persistence failure or an unreadable state file blocks automatic work too
// and is never read as «no card».
//
// Lifecycle: stop() is terminal. It aborts the producer, settles queued work as
// stopped and waits (bounded) for a send that was already invoked, so its
// message id is persisted before the process exits.

import { randomUUID } from 'crypto'

import type { SendWidgetParams, TelegramApi } from '../channel/tools.js'
import { checkWidgetHtml, checkWidgetPayload } from '../channel/widget.js'
import type { AppConfig } from '../config.js'
import type { Logger } from '../log.js'
import { WidgetPreSendError } from '../safety/pre-send-error.js'
import { classifySendError, extractStatusCode } from '../safety/reliable-telegram-api.js'
import type { StatusWidgetLoad, StatusWidgetRecord } from '../state/store.js'
import type { CommandResult, CommandRunner } from './status-widget-runner.js'

export type { CommandResult, CommandRunner } from './status-widget-runner.js'
export type { StatusWidgetLoad, StatusWidgetRecord } from '../state/store.js'

// The state is a Bot API chat_data: UTF-8 <= 1024 bytes. The command may
// print a little more than that (indentation, newline) before it is
// compacted, but never an unbounded stream. The 1024 limit applies to the
// compact JSON WITHOUT surrounding whitespace.
const STDOUT_CAP_BYTES = 16 * 1024
const MAX_BACKOFF_MS = 600_000
// How long stop() waits for work that is already running. Leaves room inside
// the server's 2 s shutdown ceiling.
export const STOP_DRAIN_MS = 1500
const RETRY_AFTER_CAP_MS = 60_000

export interface StatusWidgetStore {
  // Never throws: damage is reported as `unreadable`.
  load(): StatusWidgetLoad
  // Atomic; THROWS on failure.
  save(record: StatusWidgetRecord): void
  // Idempotent for a missing record; THROWS on a real failure.
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
  // Test seam: schedule(fn, delayMs) returns a cancel function. Also times the stop drain.
  schedule?: (fn: () => void, delayMs: number) => () => void
  // Test seams: epoch-millisecond clock and attempt id source.
  now?: () => number
  newAttemptId?: () => string
}

export type FreshCardResult =
  | { ok: true }
  // `uncertain`: Telegram may have delivered the card; automatic updates stay suspended.
  | { ok: false; reason: string; uncertain?: boolean }

export interface StatusWidgetService {
  start(): void
  // Terminal and idempotent: every call returns the same promise.
  stop(): Promise<{ drained: boolean }>
  // One refresh cycle. Never throws.
  tick(): Promise<void>
  // Send a FRESH card right now and track it (the /card command). In the
  // uncertain / blocked state this is the explicit recovery.
  sendFresh(chatId: string): Promise<FreshCardResult>
}

interface ValidState {
  data: string
  caption: string
}

type StateRead = { ok: true; state: ValidState } | { ok: false; reason: string }

type Mode = 'empty' | 'tracked' | 'uncertain' | 'blocked'

type AttemptResult = { ok: true } | { ok: false; reason: string; uncertain: boolean }

const STOPPED_REASON = 'сервис остановлен'

// Telegram answers for an edit of a deleted/unknown message. The card is gone:
// forget it and send a new one.
const MESSAGE_GONE = /message to edit not found|message can't be edited|message_id_invalid|message to be edited not found/i

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

// Telegram provably did NOT process the request: it never left us (connect
// phase failure, local validation refusal), was rate limited, or was rejected
// with an explicit numeric 4xx. The classifier's `permanent` is NOT enough: it
// is also the bucket for unknown errors.
function isConfirmedNonDelivery(err: unknown): boolean {
  if (err instanceof WidgetPreSendError) return true
  const cls = classifySendError(err, RETRY_AFTER_CAP_MS)
  if (cls.kind === 'pre_send' || cls.kind === 'rate_limited') return true
  const code = extractStatusCode(err)
  return cls.kind === 'permanent' && typeof code === 'number' && code >= 400 && code <= 499
}

interface QueuedJob {
  run: () => Promise<void>
  cancel: () => void
}

export function createStatusWidgetService(deps: StatusWidgetDeps): StatusWidgetService {
  const { config, api, runner, store, html, redact, log } = deps
  const now = deps.now ?? ((): number => Date.now())
  const newAttemptId = deps.newAttemptId ?? ((): string => randomUUID())
  const intervalMs = config.interval_sec * 1000
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number): (() => void) => {
      const t = setTimeout(fn, ms)
      return () => clearTimeout(t)
    })

  // ---- persisted state machine -------------------------------------------
  let mode: Mode = 'empty'
  // What the state file holds (undefined: no file / unreadable).
  let persisted: StatusWidgetRecord | undefined
  // The tracked card of THIS chat (kept while UNCERTAIN: the previous id).
  let card: { chatId: string; messageId: number } | undefined
  let currentAttempt: string | undefined

  function loadInitial(): void {
    let loaded: StatusWidgetLoad
    try {
      loaded = store.load()
    } catch (err) {
      loaded = { kind: 'unreadable', error: errorText(err) }
    }
    if (loaded.kind === 'unreadable') {
      mode = 'blocked'
      log.error('status widget: the saved card state is unreadable, automatic updates are suspended until /card', {
        error: loaded.error,
      })
      return
    }
    if (loaded.kind === 'empty') return
    const rec = loaded.record
    persisted = rec
    if (rec.pending !== null) {
      mode = 'uncertain'
      if (rec.messageId !== null && rec.chatId === config.chat_id) card = { chatId: rec.chatId, messageId: rec.messageId }
      return
    }
    if (rec.messageId !== null && rec.chatId === config.chat_id) {
      mode = 'tracked'
      card = { chatId: rec.chatId, messageId: rec.messageId }
    }
    // A stored card of another chat (config changed) is not ours to edit.
  }
  loadInitial()

  // Bytes of the last state that LANDED on the tracked card.
  let lastData: string | undefined
  // Last validated state, kept for /card when the command is failing.
  let lastGood: ValidState | undefined
  let failures = 0
  let latchWarned = false

  // ---- lifecycle -----------------------------------------------------------
  let started = false
  let stopped = false
  let stopPromise: Promise<{ drained: boolean }> | undefined
  let cancelNext: (() => void) | undefined
  const abort = new AbortController()

  // Ticks and /card run one at a time; queued entries can be cancelled.
  const jobs: QueuedJob[] = []
  let active: Promise<void> | undefined

  function pump(): void {
    if (active !== undefined) return
    const job = jobs.shift()
    if (job === undefined) return
    active = job.run().finally(() => {
      active = undefined
      pump()
    })
  }

  function enqueue<T>(fn: () => Promise<T>, whenStopped: () => T): Promise<T> {
    if (stopped) return Promise.resolve(whenStopped())
    return new Promise<T>((resolve, reject) => {
      jobs.push({
        run: async () => {
          try {
            resolve(await fn())
          } catch (err) {
            reject(err)
          }
        },
        cancel: () => resolve(whenStopped()),
      })
      pump()
    })
  }

  function latched(): boolean {
    return mode === 'uncertain' || mode === 'blocked'
  }

  async function readState(): Promise<StateRead> {
    let result: CommandResult
    try {
      result = await runner(config.command, {
        timeoutMs: config.timeout_ms,
        maxStdoutBytes: STDOUT_CAP_BYTES,
        signal: abort.signal,
      })
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

  // One send attempt through the state machine. Never throws.
  async function attemptSend(state: ValidState): Promise<AttemptResult> {
    if (stopped) return { ok: false, reason: STOPPED_REASON, uncertain: false }
    const priorMode = mode
    const attemptId = newAttemptId()
    const pendingRecord: StatusWidgetRecord = {
      version: 1,
      chatId: config.chat_id,
      messageId: card?.messageId ?? null,
      pending: { attemptId, startedAt: now() },
    }
    // Record to restore after a confirmed non-delivery. For an unreadable state
    // there is nothing valid to restore: the pending record itself stays.
    const baseline: StatusWidgetRecord | undefined = priorMode === 'blocked' && persisted === undefined ? pendingRecord : persisted

    // 1. Persist the pending attempt BEFORE the API is touched.
    try {
      store.save(pendingRecord)
    } catch (err) {
      mode = 'blocked'
      log.error('status widget: could not persist the pending send, nothing was sent', { error: errorText(err) })
      return { ok: false, reason: 'не удалось сохранить состояние карточки, подробности в логе плагина', uncertain: false }
    }
    persisted = pendingRecord
    currentAttempt = attemptId
    mode = 'uncertain'

    // 2. The send. From here on the outcome may be unknown.
    const params: SendWidgetParams = {
      html,
      caption: state.caption,
      chat_data: state.data,
      // The card is the plugin talking to itself, not the model talking to the owner.
      skipOutboundStamp: true,
    }
    let sent: unknown
    try {
      sent = await api.sendWidget(config.chat_id, params)
    } catch (err) {
      if (isConfirmedNonDelivery(err)) {
        try {
          if (baseline === undefined) store.clear()
          else store.save(baseline)
        } catch (restoreErr) {
          // The file keeps the pending record: still a valid, latched state.
          log.error('status widget: could not restore the card record after a rejected send', {
            error: errorText(restoreErr),
          })
          return { ok: false, reason: 'Телеграм не принял запрос, подробности в логе плагина', uncertain: true }
        }
        persisted = baseline
        mode = priorMode
        return { ok: false, reason: 'Телеграм не принял запрос, подробности в логе плагина', uncertain: false }
      }
      log.warn('status widget: the send outcome is unknown, automatic updates are suspended until /card', {
        error: errorText(err),
      })
      return { ok: false, reason: 'ответ Телеграма не получен, карточка могла дойти', uncertain: true }
    }

    // 3. Confirmed only with a real message id.
    const messageId = (sent as { message_id?: unknown } | null | undefined)?.message_id
    if (!isPositiveInt(messageId)) {
      log.warn('status widget: the send answer has no message id, automatic updates are suspended until /card')
      return { ok: false, reason: 'ответ Телеграма без номера сообщения, карточка могла дойти', uncertain: true }
    }
    // A late completion (after the stop deadline) may only settle ITS attempt.
    if (currentAttempt !== attemptId) return { ok: false, reason: 'устаревшая отправка', uncertain: true }
    const tracked: StatusWidgetRecord = { version: 1, chatId: config.chat_id, messageId, pending: null }
    card = { chatId: config.chat_id, messageId }
    lastData = state.data
    try {
      store.save(tracked)
    } catch (err) {
      // Delivered, but the record is not saved: a restart must not send a duplicate.
      mode = 'blocked'
      log.error('status widget: the card was sent but its record could not be saved, automatic updates are suspended', {
        error: errorText(err),
      })
      return {
        ok: false,
        reason: 'карточка отправлена, но запись о ней не сохранилась, подробности в логе плагина',
        uncertain: false,
      }
    }
    persisted = tracked
    mode = 'tracked'
    latchWarned = false
    return { ok: true }
  }

  function warnLatched(): void {
    if (latchWarned) return
    latchWarned = true
    log.warn('status widget: automatic updates are suspended (uncertain send or unsaved state), send /card to recover')
  }

  // Returns true when the cycle was healthy (no backoff needed).
  async function cycle(): Promise<boolean> {
    if (stopped) return true
    // Latched: no producer and no API work at all.
    if (latched()) {
      warnLatched()
      return true
    }
    const read = await readState()
    if (stopped) return true
    if (!read.ok) {
      log.warn('status widget: state not refreshed, keeping the previous card', { reason: read.reason })
      return false
    }
    const { state } = read
    lastGood = state
    if (mode === 'empty') {
      const res = await attemptSend(state)
      if (!res.ok) log.warn('status widget: send failed', { reason: res.reason })
      return res.ok
    }
    if (card === undefined || state.data === lastData) return true
    if (stopped) return true
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
          mode = 'blocked'
          log.error('status widget: could not clear the card record, automatic updates are suspended', {
            error: errorText(clearErr),
          })
          return false
        }
        persisted = undefined
        mode = 'empty'
        return true
      }
      log.warn('status widget: edit failed', { error: text })
      return false
    }
  }

  async function runTick(): Promise<void> {
    try {
      failures = (await cycle()) ? 0 : failures + 1
    } catch (err) {
      failures += 1
      log.warn('status widget: unexpected tick error', { error: errorText(err) })
    }
  }

  function tick(): Promise<void> {
    return enqueue(runTick, () => undefined)
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

  function drain(): Promise<{ drained: boolean }> {
    const work = active
    if (work === undefined) return Promise.resolve({ drained: true })
    return new Promise((resolve) => {
      let settled = false
      const cancel = schedule(() => {
        if (settled) return
        settled = true
        resolve({ drained: false })
      }, STOP_DRAIN_MS)
      void work.then(() => {
        if (settled) return
        settled = true
        cancel()
        resolve({ drained: true })
      })
    })
  }

  const stoppedResult = (): FreshCardResult => ({ ok: false, reason: STOPPED_REASON })

  return {
    start(): void {
      if (stopped) {
        log.warn('status widget: start() ignored, the service is stopped')
        return
      }
      if (started) return
      const refusal = checkWidgetHtml(html)
      if (refusal !== undefined) {
        log.error('status widget disabled: the status template is not sendable', { reason: refusal })
        return
      }
      started = true
      if (latched()) warnLatched()
      cancelNext = schedule(() => void loop(), 0)
    },

    stop(): Promise<{ drained: boolean }> {
      if (stopPromise !== undefined) return stopPromise
      stopped = true
      cancelNext?.()
      cancelNext = undefined
      abort.abort()
      // Queued ticks and /card requests settle as stopped; only the active job
      // (and a send it already invoked) is waited for.
      for (const job of jobs.splice(0)) job.cancel()
      stopPromise = drain()
      return stopPromise
    },

    tick,

    async sendFresh(chatId: string): Promise<FreshCardResult> {
      if (chatId !== config.chat_id) {
        return { ok: false, reason: 'карточка статуса настроена для другого чата' }
      }
      return enqueue(async (): Promise<FreshCardResult> => {
        if (stopped) return stoppedResult()
        const read = await readState()
        if (stopped) return stoppedResult()
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
        const res = await attemptSend(state)
        if (res.ok) return { ok: true }
        log.warn('status widget: /card send did not complete', { reason: res.reason })
        return res.uncertain ? { ok: false, reason: res.reason, uncertain: true } : { ok: false, reason: res.reason }
      }, stoppedResult)
    },
  }
}

// The card goes to a chat only when the widget tools could also reach it: the
// chat must be on the legacy allowlist (multichat mode lists its chats there
// too).
export function isStatusWidgetChatAllowed(config: Pick<AppConfig, 'allowed_chat_ids'>, chatId: string): boolean {
  return config.allowed_chat_ids.some((id) => String(id) === chatId)
}
