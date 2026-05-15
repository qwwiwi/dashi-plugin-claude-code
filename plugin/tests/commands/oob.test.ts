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
    expect(result.replyToTelegram!.text).toContain('reset')
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
