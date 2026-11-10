// Shared fakes for the status card service tests: injected runner, scheduler,
// clock, Telegram API and state store. No real timers, network or processes.
// Synthetic ids only (public repo).

import type { SendWidgetParams, TelegramApi } from '../../../src/channel/tools.js'
import type { Logger } from '../../../src/log.js'
import { redactSecrets } from '../../../src/safety/redact.js'
import {
  createStatusWidgetService,
  type CommandResult,
  type StatusWidgetLoad,
  type StatusWidgetService,
} from '../../../src/status/status-widget.js'
import type { CommandRunOptions } from '../../../src/status/status-widget-runner.js'

export const CHAT = '111111111'
export const HTML = '<!doctype html><div id="a"></div>'
export const DRAIN_MS = 1500

export const STATE_A = { m: [['Этап', [['Один', 50]]]], j: [['Задача', 10, 'r']], l: 'a' }
export const STATE_B = { m: [['Этап', [['Один', 60]]]], j: [['Задача', 20, 'r']], l: 'b' }

export interface TestRecord {
  version: 1
  chatId: string
  messageId: number | null
  pending: { attemptId: string; startedAt: number } | null
}

export function trackedRecord(messageId: number, chatId: string = CHAT): TestRecord {
  return { version: 1, chatId, messageId, pending: null }
}

export function latchedRecord(messageId: number | null = null): TestRecord {
  return { version: 1, chatId: CHAT, messageId, pending: { attemptId: 'attempt-old', startedAt: 1_700_000_000_000 } }
}

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export function ok(state: unknown): CommandResult {
  return { ok: true, stdout: typeof state === 'string' ? state : JSON.stringify(state) }
}

export function httpError(code: number, description: string): Error {
  return Object.assign(new Error(description), { error_code: code })
}

export function sysError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

export interface Rig {
  sends: Array<{ chatId: string; params: SendWidgetParams }>
  edits: Array<{ chatId: string; messageId: number; chatData: string }>
  warns: string[]
  errors: string[]
  runs: Array<{ argv: string[]; opts: CommandRunOptions }>
  results: CommandResult[]
  // Count of cards Telegram really delivered (a lost response still counts).
  delivered: number
  nextMessageId: number
  // Override the Telegram send / the producer (deferred promises, failures).
  sendImpl: ((chatId: string, params: SendWidgetParams) => Promise<{ message_id: number }>) | undefined
  runnerImpl: ((argv: readonly string[], opts: CommandRunOptions) => Promise<CommandResult>) | undefined
  editFails: Error[]
  // Persisted store.
  record: TestRecord | undefined
  corrupt: boolean
  saves: TestRecord[]
  clears: number
  failSave: ((rec: TestRecord) => boolean) | undefined
  now: number
  // Scheduler: loop timers and the drain deadline are told apart by delay.
  delays: number[]
  cancelled: number
  fire: () => Promise<void>
  fireDrain: () => void
  drainTimerSet: () => boolean
  // Build a (new) service over the same persisted store: a restart.
  build: () => StatusWidgetService
  svc: StatusWidgetService
}

export function makeRig(opts: { record?: TestRecord; corrupt?: boolean } = {}): Rig {
  const rig = {
    sends: [],
    edits: [],
    warns: [],
    errors: [],
    runs: [],
    results: [],
    delivered: 0,
    nextMessageId: 500,
    sendImpl: undefined,
    runnerImpl: undefined,
    editFails: [],
    record: opts.record,
    corrupt: opts.corrupt === true,
    saves: [],
    clears: 0,
    failSave: undefined,
    now: 1_800_000_000_000,
    delays: [],
    cancelled: 0,
  } as unknown as Rig

  const api = {
    async sendWidget(chatId: string, params: SendWidgetParams) {
      if (rig.sendImpl) return rig.sendImpl(chatId, params)
      rig.sends.push({ chatId, params })
      rig.delivered += 1
      return { message_id: rig.nextMessageId++ }
    },
    async editWidgetData(chatId: string, messageId: number, chatData: string) {
      const fail = rig.editFails.shift()
      if (fail) throw fail
      rig.edits.push({ chatId, messageId, chatData })
    },
  } as unknown as Pick<TelegramApi, 'sendWidget' | 'editWidgetData'>

  const runner = async (argv: readonly string[], runOpts: CommandRunOptions): Promise<CommandResult> => {
    rig.runs.push({ argv: [...argv], opts: runOpts })
    if (rig.runnerImpl) return rig.runnerImpl(argv, runOpts)
    return rig.results.shift() ?? { ok: false, reason: 'exit' }
  }

  const store = {
    // New interface: persisted state machine record.
    load: (): StatusWidgetLoad => {
      if (rig.corrupt) return { kind: 'unreadable', error: 'corrupt' }
      if (rig.record === undefined) return { kind: 'empty' }
      return { kind: 'record', record: structuredClone(rig.record) }
    },
    save: (rec: TestRecord) => {
      if (rig.failSave?.(rec)) throw new Error('disk full')
      rig.saves.push(structuredClone(rec))
      rig.record = structuredClone(rec)
      rig.corrupt = false
    },
    clear: () => {
      rig.record = undefined
      rig.clears += 1
    },
  }

  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg) => {
      rig.warns.push(msg)
    },
    error: (msg) => {
      rig.errors.push(msg)
    },
  }

  let loopFn: (() => void) | undefined
  let drainFn: (() => void) | undefined
  rig.fire = async () => {
    const fn = loopFn
    loopFn = undefined
    if (fn) fn()
    await settle()
  }
  rig.fireDrain = () => {
    const fn = drainFn
    drainFn = undefined
    if (fn) fn()
  }
  rig.drainTimerSet = () => drainFn !== undefined

  rig.build = () =>
    createStatusWidgetService({
      config: { chat_id: CHAT, command: ['state-cmd', '--flag'], interval_sec: 60, timeout_ms: 5000 },
      api,
      runner,
      store,
      html: HTML,
      redact: (t) => redactSecrets(t),
      log,
      now: () => rig.now,
      schedule: (fn, ms) => {
        if (ms === DRAIN_MS) {
          drainFn = fn
          return () => {
            rig.cancelled += 1
            if (drainFn === fn) drainFn = undefined
          }
        }
        rig.delays.push(ms)
        loopFn = fn
        return () => {
          rig.cancelled += 1
          if (loopFn === fn) loopFn = undefined
        }
      },
    })
  rig.svc = rig.build()
  return rig
}
