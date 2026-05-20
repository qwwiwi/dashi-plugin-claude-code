import { describe, expect, test } from 'bun:test'

import {
  handleOobCommand,
  parseOobCommand,
  type OobContext,
} from '../../src/commands/oob.js'
import type { AppConfig } from '../../src/config.js'
import type { Logger } from '../../src/log.js'
import type { TelegramApi } from '../../src/channel/tools.js'

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    bot_id: 8507713167,
    dm_only: true,
    allowed_user_ids: [164795011],
    allowed_chat_ids: [164795011],
    status: { enabled: true, interval_ms: 700, ttl_ms: 300_000, delete_on_complete: true },
    album: { flush_ms: 2000 },
    voice: { provider: 'groq', language: 'ru', model: 'whisper-large-v3-turbo' },
    webhook: { enabled: false, host: '127.0.0.1', port: 0 },
    permission_relay: {
      enabled: true,
      allowed_user_ids: [164795011],
      bash_only_proof: true,
    },
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
      session_ttl_ms: 600000,
    },
    task_mirror: {
      enabled: true,
      edit_throttle_ms: 3000,
      session_ttl_ms: 600000,
      collapse_completed_after: 5,
    },
    watcher: {
      enabled: true,
      debounce_ms: 10_000,
      busy_threshold_ms: 30_000,
    },
    ...overrides,
  }
}

function makeLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
}

function makeTelegramApi(): TelegramApi {
  // /help and /status tests don't actually invoke handleOobCommand's side
  // effects on the API — the result object carries replyToTelegram and the
  // caller (executeOobResult / handlers.ts) issues sendMessage. We stub
  // every method to throw if accidentally invoked.
  const fail = (name: string) => {
    return (): never => {
      throw new Error(`unexpected TelegramApi call: ${name}`)
    }
  }
  return {
    sendMessage: fail('sendMessage') as TelegramApi['sendMessage'],
    editMessageText: fail('editMessageText') as TelegramApi['editMessageText'],
    setMessageReaction: fail(
      'setMessageReaction',
    ) as TelegramApi['setMessageReaction'],
    sendChatAction: fail('sendChatAction') as TelegramApi['sendChatAction'],
    sendDocument: fail('sendDocument') as TelegramApi['sendDocument'],
    sendPhoto: fail('sendPhoto') as TelegramApi['sendPhoto'],
    downloadFile: fail('downloadFile') as TelegramApi['downloadFile'],
    deleteMessage: fail('deleteMessage') as TelegramApi['deleteMessage'],
  }
}

function makeCtx(overrides: Partial<OobContext> = {}): OobContext {
  return {
    chatId: '164795011',
    senderId: '164795011',
    config: makeConfig(),
    telegramApi: makeTelegramApi(),
    log: makeLogger(),
    botId: 8507713167,
    stateDir: '/tmp/state',
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────
// parseOobCommand
// ─────────────────────────────────────────────────────────────────────

describe('parseOobCommand', () => {
  test('returns null on plain text', () => {
    expect(parseOobCommand('hello world')).toBeNull()
    expect(parseOobCommand('not a command')).toBeNull()
  })

  test('parses /help', () => {
    const r = parseOobCommand('/help')
    expect(r).not.toBeNull()
    expect(r!.name).toBe('help')
    expect(r!.args).toBe('')
    expect(r!.hasForceFlag).toBe(false)
  })

  test('parses /status@botname strips suffix', () => {
    const r = parseOobCommand('/status@dashicanarybot', 'dashicanarybot')
    expect(r).not.toBeNull()
    expect(r!.name).toBe('status')
  })

  test('parses /reset force with hasForceFlag=true', () => {
    const r = parseOobCommand('/reset force')
    expect(r).not.toBeNull()
    expect(r!.name).toBe('reset')
    expect(r!.args).toBe('force')
    expect(r!.hasForceFlag).toBe(true)
  })

  test('parses /new without force has hasForceFlag=false', () => {
    const r = parseOobCommand('/new')
    expect(r).not.toBeNull()
    expect(r!.name).toBe('new')
    expect(r!.hasForceFlag).toBe(false)
  })

  test('parses unknown /foo as null', () => {
    expect(parseOobCommand('/foo')).toBeNull()
    expect(parseOobCommand('/compact')).toBeNull()
    expect(parseOobCommand('/halt')).toBeNull()
  })

  test('parses /stop case-insensitively (/STOP)', () => {
    const r = parseOobCommand('/STOP')
    expect(r).not.toBeNull()
    expect(r!.name).toBe('stop')
  })
})

// ─────────────────────────────────────────────────────────────────────
// handleOobCommand
// ─────────────────────────────────────────────────────────────────────

describe('handleOobCommand', () => {
  test('/help returns HTML reply listing commands, no channel notify', async () => {
    const parsed = parseOobCommand('/help')!
    const result = await handleOobCommand(parsed, makeCtx())
    expect(result.handled).toBe(true)
    expect(result.command).toBe('help')
    expect(result.notifyChannel).toBeUndefined()
    expect(result.replyToTelegram).toBeDefined()
    const text = result.replyToTelegram!.text
    expect(result.replyToTelegram!.parseMode).toBe('HTML')
    // Lists all 5 Scope A commands.
    expect(text).toContain('/help')
    expect(text).toContain('/status')
    expect(text).toContain('/stop')
    expect(text).toContain('/reset')
    expect(text).toContain('/new')
    // Scope B commands explicitly absent.
    expect(text).not.toContain('/compact')
    expect(text).not.toContain('/halt')
  })

  test('/status includes bot_id state_dir allowed_user', async () => {
    const parsed = parseOobCommand('/status')!
    const result = await handleOobCommand(
      parsed,
      makeCtx({
        botId: 8507713167,
        stateDir: '/var/lib/canary',
        senderId: '164795011',
      }),
    )
    expect(result.notifyChannel).toBeUndefined()
    expect(result.replyToTelegram).toBeDefined()
    const text = result.replyToTelegram!.text
    expect(text).toContain('8507713167')
    expect(text).toContain('/var/lib/canary')
    expect(text).toContain('164795011')
  })

  test('/status includes status_manager and webhook info when supplied', async () => {
    const parsed = parseOobCommand('/status')!
    const result = await handleOobCommand(
      parsed,
      makeCtx({
        statusManager: {
          isActive: (cid: string) => cid === '164795011',
          cancel: async () => {},
        },
        webhookStatus: () => ({ enabled: true, port: 8089 }),
        pollerStatus: () => ({ offset: 42 }),
      }),
    )
    const text = result.replyToTelegram!.text
    expect(text).toContain('active')
    expect(text).toContain('on:8089')
    expect(text).toContain('42')
  })

  test('/stop emits channel notification with meta.command=stop', async () => {
    const parsed = parseOobCommand('/stop')!
    const result = await handleOobCommand(parsed, makeCtx())
    expect(result.command).toBe('stop')
    expect(result.notifyChannel).toBeDefined()
    expect(result.notifyChannel!.meta.command).toBe('stop')
    expect(result.notifyChannel!.meta.chat_id).toBe('164795011')
    expect(result.notifyChannel!.meta.source).toBe('telegram')
    expect(result.replyToTelegram).toBeDefined()
  })

  test('/reset force emits channel notification meta.command=reset', async () => {
    const parsed = parseOobCommand('/reset force')!
    const result = await handleOobCommand(parsed, makeCtx())
    expect(result.command).toBe('reset')
    expect(result.notifyChannel).toBeDefined()
    expect(result.notifyChannel!.meta.command).toBe('reset')
    expect(result.replyToTelegram!.text).toContain('сброшена')
  })

  test('/reset (no force) returns reply asking for force flag, no channel notify', async () => {
    const parsed = parseOobCommand('/reset')!
    const result = await handleOobCommand(parsed, makeCtx())
    expect(result.command).toBe('reset')
    expect(result.notifyChannel).toBeUndefined()
    expect(result.replyToTelegram).toBeDefined()
    expect(result.replyToTelegram!.text).toContain('force')
  })

  test('/new force emits channel notification meta.command=new', async () => {
    const parsed = parseOobCommand('/new force')!
    const result = await handleOobCommand(parsed, makeCtx())
    expect(result.command).toBe('new')
    expect(result.notifyChannel).toBeDefined()
    expect(result.notifyChannel!.meta.command).toBe('new')
  })

  test('/new (no force) returns reply asking for force flag, no channel notify', async () => {
    const parsed = parseOobCommand('/new')!
    const result = await handleOobCommand(parsed, makeCtx())
    expect(result.notifyChannel).toBeUndefined()
    expect(result.replyToTelegram!.text).toContain('force')
  })
})

// ─────────────────────────────────────────────────────────────────────
// /mirror — toggles the TmuxMirror; falls back to «disabled» when no
// mirror instance is wired into the context. Subactions: on / off /
// status (default).
// ─────────────────────────────────────────────────────────────────────

function makeFakeMirror(): {
  control: NonNullable<OobContext['tmuxMirror']>
  log: { start: number; stop: number }
  state: { enabled: boolean; messageId?: number; lastPollAt?: number; lastError?: string }
} {
  const log = { start: 0, stop: 0 }
  const state: {
    enabled: boolean
    messageId?: number
    lastPollAt?: number
    lastError?: string
  } = { enabled: false }
  const control: NonNullable<OobContext['tmuxMirror']> = {
    async start() {
      log.start += 1
      state.enabled = true
      state.messageId = 999
      state.lastPollAt = Date.now()
    },
    async stop() {
      log.stop += 1
      state.enabled = false
      delete state.messageId
    },
    status() {
      const out: ReturnType<NonNullable<OobContext['tmuxMirror']>['status']> = {
        enabled: state.enabled,
      }
      if (state.messageId !== undefined) out.messageId = state.messageId
      if (state.lastPollAt !== undefined) out.lastPollAt = state.lastPollAt
      if (state.lastError !== undefined) out.lastError = state.lastError
      return out
    },
  }
  return { control, log, state }
}

describe('/mirror command', () => {
  test('/mirror parses with no args', () => {
    const r = parseOobCommand('/mirror')
    expect(r).not.toBeNull()
    expect(r!.name).toBe('mirror')
    expect(r!.args).toBe('')
  })

  test('/mirror on parses with args=on', () => {
    const r = parseOobCommand('/mirror on')
    expect(r!.name).toBe('mirror')
    expect(r!.args).toBe('on')
  })

  test('/mirror without configured mirror replies «отключено в конфиге»', async () => {
    const parsed = parseOobCommand('/mirror status')!
    const result = await handleOobCommand(parsed, makeCtx())
    expect(result.command).toBe('mirror')
    expect(result.replyToTelegram!.text).toContain('отключено в конфиге')
    expect(result.notifyChannel).toBeUndefined()
  })

  test('/mirror on calls start() and reports on', async () => {
    const mirror = makeFakeMirror()
    const parsed = parseOobCommand('/mirror on')!
    const result = await handleOobCommand(parsed, makeCtx({ tmuxMirror: mirror.control }))
    expect(mirror.log.start).toBe(1)
    expect(result.replyToTelegram!.text).toContain('on')
    expect(result.notifyChannel).toBeUndefined()
  })

  test('/mirror off calls stop() and reports off', async () => {
    const mirror = makeFakeMirror()
    // start first so stop has work to do.
    await mirror.control.start()
    const parsed = parseOobCommand('/mirror off')!
    const result = await handleOobCommand(parsed, makeCtx({ tmuxMirror: mirror.control }))
    expect(mirror.log.stop).toBe(1)
    expect(result.replyToTelegram!.text).toContain('off')
  })

  test('/mirror status reports enabled + message_id when active', async () => {
    const mirror = makeFakeMirror()
    await mirror.control.start()
    const parsed = parseOobCommand('/mirror status')!
    const result = await handleOobCommand(parsed, makeCtx({ tmuxMirror: mirror.control }))
    const text = result.replyToTelegram!.text
    expect(text).toContain('зеркало терминала — статус')
    expect(text).toContain('on')
    expect(text).toContain('999') // messageId
  })

  test('/mirror with unknown sub-action shows usage hint', async () => {
    const mirror = makeFakeMirror()
    const parsed = parseOobCommand('/mirror blabla')!
    const result = await handleOobCommand(parsed, makeCtx({ tmuxMirror: mirror.control }))
    expect(result.replyToTelegram!.text).toContain('usage:')
  })

  test('/mirror on swallows start() throws without crashing handler', async () => {
    const failingMirror: NonNullable<OobContext['tmuxMirror']> = {
      async start() {
        throw new Error('boom')
      },
      async stop() {
        /* no-op */
      },
      status() {
        return { enabled: false }
      },
    }
    const parsed = parseOobCommand('/mirror on')!
    // Must NOT throw.
    const result = await handleOobCommand(parsed, makeCtx({ tmuxMirror: failingMirror }))
    expect(result.command).toBe('mirror')
    expect(result.replyToTelegram!.text).toContain('on')
  })
})
