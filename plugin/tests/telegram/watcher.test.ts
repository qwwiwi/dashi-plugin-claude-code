// InboundWatcher tests (PR-A3 / 2026-05-20) — auto-reply when busy.
// Patterned on the FakeApi style used in progress-reporter.test.ts.

import { describe, expect, test } from 'bun:test'

import {
  InboundWatcher,
  composeAutoReply,
  type ProgressReporterForWatcher,
} from '../../src/telegram/watcher.js'
import type { TelegramApi } from '../../src/channel/tools.js'
import type { AppConfig } from '../../src/config.js'
import { createLogger } from '../../src/log.js'

const silentLog = createLogger('test', {
  stream: { write: () => true } as unknown as NodeJS.WritableStream,
})

function makeConfig(overrides: Partial<AppConfig['watcher']> = {}): AppConfig {
  return {
    bot_id: 8507713167,
    dm_only: true,
    allowed_user_ids: [164795011],
    allowed_chat_ids: [164795011],
    status: { enabled: true, interval_ms: 700, ttl_ms: 300_000, delete_on_complete: true, suppress_typing_bubble: false },
    album: { flush_ms: 2000 },
    voice: { provider: 'groq', language: 'ru', model: 'whisper-large-v3-turbo' },
    webhook: { enabled: false, host: '127.0.0.1', port: 0 },
    permission_relay: { enabled: true, allowed_user_ids: [164795011], bash_only_proof: true },
    commands: { help: true, status: true, stop: true, reset: true, new: true },
    memory: {
      enabled: false,
      source_tag: 'tg',
      max_hot_bytes: 20480,
      trim_keep_lines: 600,
      buffer_ttl_ms: 5 * 60 * 1000,
      buffer_max_entries: 100,
    },
    progress: {
      enabled: true,
      edit_throttle_ms: 3000,
      recent_buffer: 10,
      session_ttl_ms: 10 * 60 * 1000,
    },
    task_mirror: {
      enabled: true,
      edit_throttle_ms: 3000,
      session_ttl_ms: 10 * 60 * 1000,
      collapse_completed_after: 5,
    },
    watcher: {
      enabled: true,
      debounce_ms: 10_000,
      busy_threshold_ms: 30_000,
      ...overrides,
    },
  }
}

interface ApiCall {
  chatId: string
  text: string
  parse_mode?: string
  reply_to_message_id?: number
}

interface FakeApi {
  api: TelegramApi
  calls: ApiCall[]
  failSendWith?: Error
}

function makeFakeApi(): FakeApi {
  const state: FakeApi = {
    calls: [],
    api: undefined as unknown as TelegramApi,
  }
  const noop = async (): Promise<never> => {
    throw new Error('unexpected api call in watcher test')
  }
  state.api = {
    sendMessage: async (chatId, text, opts) => {
      if (state.failSendWith) throw state.failSendWith
      const entry: ApiCall = { chatId, text }
      if (opts.parse_mode !== undefined) entry.parse_mode = opts.parse_mode
      if (opts.reply_to_message_id !== undefined) {
        entry.reply_to_message_id = opts.reply_to_message_id
      }
      state.calls.push(entry)
      return { message_id: 999 }
    },
    editMessageText: noop as unknown as TelegramApi['editMessageText'],
    setMessageReaction: noop as unknown as TelegramApi['setMessageReaction'],
    sendChatAction: noop as unknown as TelegramApi['sendChatAction'],
    sendDocument: noop as unknown as TelegramApi['sendDocument'],
    sendPhoto: noop as unknown as TelegramApi['sendPhoto'],
    downloadFile: noop as unknown as TelegramApi['downloadFile'],
    deleteMessage: noop as unknown as TelegramApi['deleteMessage'],
  }
  return state
}

interface FakeProgress {
  busy: boolean
  toolName: string | undefined
  reporter: ProgressReporterForWatcher
}

function makeFakeProgress(opts: { busy?: boolean; toolName?: string } = {}): FakeProgress {
  const state: FakeProgress = {
    busy: opts.busy ?? false,
    toolName: opts.toolName,
    reporter: undefined as unknown as ProgressReporterForWatcher,
  }
  state.reporter = {
    isBusy: () => state.busy,
    getActiveToolName: () => state.toolName,
  }
  return state
}

function makeClock(initial = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let cur = initial
  return {
    now: () => cur,
    advance: (ms: number) => {
      cur += ms
    },
  }
}

function makeWatcher(opts: {
  config?: AppConfig
  api?: FakeApi
  progress?: FakeProgress
  clock?: { now: () => number; advance: (ms: number) => void }
} = {}): {
  watcher: InboundWatcher
  config: AppConfig
  api: FakeApi
  progress: FakeProgress
  clock: { now: () => number; advance: (ms: number) => void }
} {
  const config = opts.config ?? makeConfig()
  const api = opts.api ?? makeFakeApi()
  const progress = opts.progress ?? makeFakeProgress()
  const clock = opts.clock ?? makeClock()
  const watcher = new InboundWatcher({
    telegramApi: api.api,
    config,
    log: silentLog,
    progressReporter: progress.reporter,
    now: clock.now,
  })
  return { watcher, config, api, progress, clock }
}

describe('InboundWatcher', () => {
  test('not busy → { replied: false, reason: "not-busy" }, no sendMessage', async () => {
    const { watcher, api } = makeWatcher({
      progress: makeFakeProgress({ busy: false }),
    })
    const res = await watcher.maybeAutoReply({ chatId: '111', messageId: 42 })
    expect(res).toEqual({ replied: false, reason: 'not-busy' })
    expect(api.calls.length).toBe(0)
  })

  test('busy + first call → replied: true with reply_to_message_id', async () => {
    const { watcher, api } = makeWatcher({
      progress: makeFakeProgress({ busy: true, toolName: 'Bash' }),
    })
    const res = await watcher.maybeAutoReply({ chatId: '111', messageId: 42 })
    expect(res).toEqual({ replied: true })
    expect(api.calls.length).toBe(1)
    expect(api.calls[0]!.chatId).toBe('111')
    expect(api.calls[0]!.reply_to_message_id).toBe(42)
    expect(api.calls[0]!.parse_mode).toBe('HTML')
    expect(api.calls[0]!.text).toContain('Bash')
  })

  test('busy + second call within debounce → debounced, no second sendMessage', async () => {
    const { watcher, api, clock } = makeWatcher({
      progress: makeFakeProgress({ busy: true, toolName: 'Bash' }),
    })
    const first = await watcher.maybeAutoReply({ chatId: '111', messageId: 42 })
    expect(first).toEqual({ replied: true })

    clock.advance(5000) // < 10_000 debounce
    const second = await watcher.maybeAutoReply({ chatId: '111', messageId: 43 })
    expect(second).toEqual({ replied: false, reason: 'debounced' })
    expect(api.calls.length).toBe(1)
  })

  test('busy + after debounce window → replied: true again', async () => {
    const { watcher, api, clock } = makeWatcher({
      progress: makeFakeProgress({ busy: true, toolName: 'Read' }),
    })
    await watcher.maybeAutoReply({ chatId: '111', messageId: 42 })
    clock.advance(10_001)
    const res = await watcher.maybeAutoReply({ chatId: '111', messageId: 43 })
    expect(res).toEqual({ replied: true })
    expect(api.calls.length).toBe(2)
  })

  test('disabled config → { replied: false, reason: "disabled" } even when busy', async () => {
    const { watcher, api } = makeWatcher({
      config: makeConfig({ enabled: false }),
      progress: makeFakeProgress({ busy: true, toolName: 'Bash' }),
    })
    const res = await watcher.maybeAutoReply({ chatId: '111', messageId: 42 })
    expect(res).toEqual({ replied: false, reason: 'disabled' })
    expect(api.calls.length).toBe(0)
  })

  test('send failure → { replied: false, reason: "send-failed" }, lastReplyMs rolls back', async () => {
    const api = makeFakeApi()
    api.failSendWith = new Error('telegram down')
    const { watcher, clock } = makeWatcher({
      api,
      progress: makeFakeProgress({ busy: true, toolName: 'Bash' }),
    })
    const res = await watcher.maybeAutoReply({ chatId: '111', messageId: 42 })
    expect(res).toEqual({ replied: false, reason: 'send-failed' })

    // Recovery: next call within debounce window must STILL retry, because
    // the failed call rolled the marker back to its previous value
    // (`undefined`, since this was the very first attempt for the chat).
    delete api.failSendWith
    clock.advance(100)
    const second = await watcher.maybeAutoReply({ chatId: '111', messageId: 43 })
    expect(second).toEqual({ replied: true })
  })

  test('send failure after a successful send rolls back to the previous timestamp', async () => {
    const api = makeFakeApi()
    const { watcher, clock } = makeWatcher({
      api,
      progress: makeFakeProgress({ busy: true, toolName: 'Bash' }),
    })
    // First call succeeds — establishes lastReplyMs.
    const first = await watcher.maybeAutoReply({ chatId: '111', messageId: 1 })
    expect(first).toEqual({ replied: true })
    // Advance past the debounce window so the next call would otherwise pass.
    clock.advance(15_000)
    // Second call fails — marker must NOT advance to the failed-call time,
    // it must stay at the timestamp of the prior successful send.
    api.failSendWith = new Error('telegram down')
    const second = await watcher.maybeAutoReply({ chatId: '111', messageId: 2 })
    expect(second).toEqual({ replied: false, reason: 'send-failed' })
    // Recovery: a third call right after the failure should succeed (the
    // previous successful send is now ~15s old, past the 10s debounce).
    delete api.failSendWith
    const third = await watcher.maybeAutoReply({ chatId: '111', messageId: 3 })
    expect(third).toEqual({ replied: true })
    // Sanity: api recorded two successful sends.
    expect(api.calls.length).toBe(2)
  })

  test('concurrent calls collapse to exactly one sendMessage (debounce race)', async () => {
    // Critical race regression test: two messages arriving in the same
    // event-loop turn must NOT both trigger sendMessage. The marker is set
    // before the await — the second invocation observes it and short-circuits.
    let resolveSend: (() => void) | undefined
    const api: FakeApi = makeFakeApi()
    // Replace sendMessage with a version that parks on the first call so we
    // can stage a true concurrent invocation. The second invocation must
    // observe the marker BEFORE the parked send resolves.
    api.api = {
      ...api.api,
      sendMessage: async (chatId: string, text: string, opts) => {
        await new Promise<void>((resolve) => {
          resolveSend = resolve
        })
        const entry: ApiCall = { chatId, text }
        if (opts.parse_mode !== undefined) entry.parse_mode = opts.parse_mode
        if (opts.reply_to_message_id !== undefined) {
          entry.reply_to_message_id = opts.reply_to_message_id
        }
        api.calls.push(entry)
        return { message_id: 999 }
      },
    } as TelegramApi
    const { watcher } = makeWatcher({
      api,
      progress: makeFakeProgress({ busy: true, toolName: 'Bash' }),
    })

    const [r1, r2] = await Promise.all([
      // Kick the parked send.
      watcher
        .maybeAutoReply({ chatId: 'X', messageId: 1 })
        .finally(() => undefined),
      // Stage the second call in the same tick. Microtask ordering: r2
      // schedules synchronously before the parked send resolves.
      (async () => {
        const res = await watcher.maybeAutoReply({ chatId: 'X', messageId: 2 })
        // Release the parked send only after the second result is observed,
        // proving the second call short-circuited without waiting on Telegram.
        resolveSend?.()
        return res
      })(),
    ])
    expect(r2).toEqual({ replied: false, reason: 'debounced' })
    expect(r1).toEqual({ replied: true })
    expect(api.calls.length).toBe(1)
  })

  test('clearDebounce resets the marker so a debounced chat can reply again', async () => {
    const { watcher, api, clock } = makeWatcher({
      progress: makeFakeProgress({ busy: true, toolName: 'Bash' }),
    })
    const first = await watcher.maybeAutoReply({ chatId: '111', messageId: 1 })
    expect(first).toEqual({ replied: true })
    // Within debounce window → would normally be blocked.
    clock.advance(100)
    watcher.clearDebounce('111')
    const second = await watcher.maybeAutoReply({ chatId: '111', messageId: 2 })
    expect(second).toEqual({ replied: true })
    expect(api.calls.length).toBe(2)
  })

  test('HTML special chars in tool name are escaped', async () => {
    const { watcher, api } = makeWatcher({
      progress: makeFakeProgress({ busy: true, toolName: '<Bash>&"evil"' }),
    })
    await watcher.maybeAutoReply({ chatId: '111', messageId: 42 })
    expect(api.calls[0]!.text).not.toContain('<Bash>')
    expect(api.calls[0]!.text).toContain('&lt;Bash&gt;')
    expect(api.calls[0]!.text).toContain('&amp;')
    expect(api.calls[0]!.text).toContain('&quot;evil&quot;')
  })

  test('multi-chat isolation: debounce on chat A does not block chat B', async () => {
    const { watcher, api } = makeWatcher({
      progress: makeFakeProgress({ busy: true, toolName: 'Bash' }),
    })
    const a = await watcher.maybeAutoReply({ chatId: 'A', messageId: 42 })
    const b = await watcher.maybeAutoReply({ chatId: 'B', messageId: 99 })
    expect(a).toEqual({ replied: true })
    expect(b).toEqual({ replied: true })
    expect(api.calls.length).toBe(2)
  })

  test('composeAutoReply: undefined tool name renders «…» placeholder', () => {
    const text = composeAutoReply(undefined)
    expect(text).toContain('<code>…</code>')
  })

  test('composeAutoReply: known tool name appears wrapped in <code>', () => {
    expect(composeAutoReply('Read')).toContain('<code>Read</code>')
  })
})
