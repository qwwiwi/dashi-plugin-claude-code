// /card: the out-of-band command that sends a FRESH status card. It is handled
// by the plugin itself and must never reach the model session.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Context } from 'grammy'

import type { TelegramApi } from '../../src/channel/tools.js'
import {
  BOT_COMMANDS,
  executeOobResult,
  handleOobCommand,
  parseOobCommand,
  type OobContext,
} from '../../src/commands/oob.js'
import type { AppConfig, StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import { handleInboundText, type HandlerDeps } from '../../src/telegram/handlers.js'

const silentLog = createLogger('test', { stream: { write: () => true } as unknown as NodeJS.WritableStream })

const OWNER = 111111111

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    bot_id: 123456789,
    dm_only: true,
    allowed_user_ids: [111111111],
    allowed_chat_ids: [111111111],
    status: { enabled: true, interval_ms: 700, ttl_ms: 300_000, delete_on_complete: true, suppress_typing_bubble: false },
    album: { flush_ms: 2000 },
    voice: { provider: 'groq', language: 'ru', model: 'whisper-large-v3-turbo' },
    webhook: { enabled: false, host: '127.0.0.1', port: 0 },
    permission_relay: {
      enabled: true,
      allowed_user_ids: [111111111],
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
    tmux_mirror: { enabled: false, pane_target: '', socket_name: '', poll_interval_ms: 5000, line_count: 50, hide_segments: ['boot_banner', 'inbound_warning', 'footer_hints', 'input_box'], mode: 'latest_inbound_only', max_lines: 14, min_edit_interval_ms: 20000, max_edits_per_min: 3 },
    multichat: { enabled: false },
    ask_user_question: { enabled: false, timeout_ms: 300_000, max_preview_chars: 1000 },
    permission_gate: { enabled: false, timeout_ms: 120_000 },
    richMessages: { enabled: false, perChatOptOut: [] },
    status_widget: { enabled: true, chat_id: '111111111', command: ['state-cmd'], interval_sec: 60, timeout_ms: 5000 },
    ...overrides,
  }
}

function makeStatePaths(root: string): StatePaths {
  return {
    root,
    env: join(root, '.env'),
    config: join(root, 'config.json'),
    allowlist: join(root, 'allowlist.json'),
    pid: join(root, 'bot.pid'),
    lock: join(root, 'bot.lock'),
    updateOffset: join(root, 'update-offset'),
    inbox: join(root, 'inbox'),
    sessionIds: join(root, 'session-ids'),
    deadLetterUpdates: join(root, 'dead-letter', 'updates'),
    deadLetterWebhook: join(root, 'dead-letter', 'webhook'),
    deadLetterOutbound: join(root, 'dead-letter', 'outbound'),
    logs: {
      server: join(root, 'logs', 'server.log'),
      telegram: join(root, 'logs', 'telegram.log'),
      permissions: join(root, 'logs', 'permissions.jsonl'),
      webhook: join(root, 'logs', 'webhook.log'),
      ask_user_question: join(root, 'logs', 'ask-user-question.jsonl'),
      permission_gate: join(root, 'logs', 'permission-gate.jsonl'),
    },
  }
}

function makeApi(sent: string[]): TelegramApi {
  const noop = async (): Promise<never> => {
    throw new Error('unexpected api call')
  }
  return {
    sendMessage: (async (_c: string, text: string) => {
      sent.push(text)
      return { message_id: 1 }
    }) as unknown as TelegramApi['sendMessage'],
    sendRichMessage: noop as unknown as TelegramApi['sendRichMessage'],
    editRichMessage: async () => ({ fallback: true }) as const,
    editMessageText: noop as unknown as TelegramApi['editMessageText'],
    setMessageReaction: async () => undefined,
    sendChatAction: async () => undefined,
    sendDocument: noop as unknown as TelegramApi['sendDocument'],
    sendPhoto: noop as unknown as TelegramApi['sendPhoto'],
    downloadFile: noop as unknown as TelegramApi['downloadFile'],
    deleteMessage: noop as unknown as TelegramApi['deleteMessage'],
    async sendWidget() { return { message_id: 0 } },
    async editWidgetData() {},
    answerGuestQuery: noop as unknown as TelegramApi['answerGuestQuery'],
  }
}

function dmCtx(text: string, fromId: number, chatId: number): Context {
  return {
    chat: { id: chatId, type: 'private' as const },
    from: { id: fromId, is_bot: false, first_name: 'x' },
    me: { id: 123456789, username: 'canarybot' },
    message: {
      message_id: 42,
      date: 1700000000,
      text,
      chat: { id: chatId, type: 'private' as const },
      from: { id: fromId, is_bot: false, first_name: 'x' },
    },
  } as unknown as Context
}

describe('/card parsing and menu', () => {
  test('parses as a known command (with and without the bot suffix)', () => {
    expect(parseOobCommand('/card')?.name).toBe('card')
    expect(parseOobCommand('/Card@canarybot')?.name).toBe('card')
  })

  test('is registered in the bot command list; /status stays', () => {
    const names = BOT_COMMANDS.map((c) => c.command)
    expect(names).toContain('card')
    expect(names).toContain('status')
  })
})

describe('/card handling', () => {
  test('asks the status service for a fresh card in the requesting chat; no model notification', async () => {
    const asked: string[] = []
    const sent: string[] = []
    const ctx: OobContext = {
      chatId: String(OWNER),
      senderId: String(OWNER),
      config: makeConfig(),
      telegramApi: makeApi(sent),
      log: silentLog,
      statusWidget: {
        sendFresh: async (chatId) => {
          asked.push(chatId)
          return { ok: true }
        },
      },
    }
    const res = await handleOobCommand(parseOobCommand('/card')!, ctx)
    expect(asked).toEqual([String(OWNER)])
    expect(res.handled).toBe(true)
    expect(res.command).toBe('card')
    expect(res.notifyChannel).toBeUndefined()
  })

  test('a disabled service answers with a clear text and never wakes the model', async () => {
    const ctx: OobContext = {
      chatId: String(OWNER),
      senderId: String(OWNER),
      config: makeConfig(),
      telegramApi: makeApi([]),
      log: silentLog,
    }
    const res = await handleOobCommand(parseOobCommand('/card')!, ctx)
    expect(res.notifyChannel).toBeUndefined()
    expect(res.replyToTelegram?.text).toContain('status_widget')
  })

  test('a service refusal is shown to the owner', async () => {
    const ctx: OobContext = {
      chatId: String(OWNER),
      senderId: String(OWNER),
      config: makeConfig(),
      telegramApi: makeApi([]),
      log: silentLog,
      statusWidget: { sendFresh: async () => ({ ok: false, reason: 'нет состояния' }) },
    }
    const res = await handleOobCommand(parseOobCommand('/card')!, ctx)
    expect(res.replyToTelegram?.text).toContain('нет состояния')
    expect(res.notifyChannel).toBeUndefined()
  })

  test('the failure reply never claims the card was not sent (the outcome may be unknown)', async () => {
    const ctx: OobContext = {
      chatId: String(OWNER),
      senderId: String(OWNER),
      config: makeConfig(),
      telegramApi: makeApi([]),
      log: silentLog,
      statusWidget: { sendFresh: async () => ({ ok: false, reason: 'ответ Телеграма не получен' }) },
    }
    const res = await handleOobCommand(parseOobCommand('/card')!, ctx)
    expect(res.replyToTelegram?.text).not.toContain('не отправлена')
  })

  test('an uncertain send explains the state: the card may have arrived, updates are paused, /card resumes', async () => {
    const ctx: OobContext = {
      chatId: String(OWNER),
      senderId: String(OWNER),
      config: makeConfig(),
      telegramApi: makeApi([]),
      log: silentLog,
      statusWidget: { sendFresh: async () => ({ ok: false, reason: 'ответ Телеграма не получен', uncertain: true }) },
    }
    const res = await handleOobCommand(parseOobCommand('/card')!, ctx)
    const text = res.replyToTelegram?.text ?? ''
    expect(text).toContain('ответ Телеграма не получен')
    expect(text).toContain('могла дойти')
    expect(text).toContain('дубль')
    expect(text).toContain('/card')
    expect(text).not.toContain('не отправлена')
  })

  test('a throwing service never throws out of the handler', async () => {
    const ctx: OobContext = {
      chatId: String(OWNER),
      senderId: String(OWNER),
      config: makeConfig(),
      telegramApi: makeApi([]),
      log: silentLog,
      statusWidget: {
        sendFresh: async () => {
          throw new Error('boom')
        },
      },
    }
    const res = await handleOobCommand(parseOobCommand('/card')!, ctx)
    expect(res.replyToTelegram?.text.length).toBeGreaterThan(0)
  })
})

describe('/card through the inbound handler', () => {
  function rig(): { deps: HandlerDeps; notifications: unknown[]; asked: string[]; sent: string[]; root: string } {
    const root = mkdtempSync(join(tmpdir(), 'card-oob-'))
    const notifications: unknown[] = []
    const asked: string[] = []
    const sent: string[] = []
    const deps: HandlerDeps = {
      server: {
        notification: async (n: unknown) => {
          notifications.push(n)
        },
      } as unknown as HandlerDeps['server'],
      config: makeConfig(),
      statePaths: makeStatePaths(root),
      telegramApi: makeApi(sent),
      log: silentLog,
      bot: { id: 123456789, username: 'canarybot' },
      botApi: { api: {} } as unknown as HandlerDeps['botApi'],
      botToken: 'fake-token',
      env: {},
      statusWidget: {
        sendFresh: async (chatId: string) => {
          asked.push(chatId)
          return { ok: true } as const
        },
      },
    }
    return { deps, notifications, asked, sent, root }
  }

  test('the allowed owner in a private chat gets a card and the model sees nothing', async () => {
    const r = rig()
    await handleInboundText(dmCtx('/card', OWNER, OWNER), r.deps)
    await new Promise((res) => setTimeout(res, 0))
    expect(r.asked).toEqual([String(OWNER)])
    expect(r.notifications).toEqual([])
    rmSync(r.root, { recursive: true, force: true })
  })

  test('a user outside the allowlist cannot trigger it', async () => {
    const r = rig()
    await handleInboundText(dmCtx('/card', 222222222, 222222222), r.deps)
    await new Promise((res) => setTimeout(res, 0))
    expect(r.asked).toEqual([])
    rmSync(r.root, { recursive: true, force: true })
  })

  test('executeOobResult for /card emits no channel notification', async () => {
    const r = rig()
    const notifications: unknown[] = []
    const ctx: OobContext = {
      chatId: String(OWNER),
      senderId: String(OWNER),
      config: makeConfig(),
      telegramApi: makeApi([]),
      log: silentLog,
      statusWidget: { sendFresh: async () => ({ ok: true }) },
    }
    const res = await handleOobCommand(parseOobCommand('/card')!, ctx)
    await executeOobResult(res, ctx, {
      notification: async (n: unknown) => {
        notifications.push(n)
      },
    } as unknown as HandlerDeps['server'])
    expect(notifications).toEqual([])
    rmSync(r.root, { recursive: true, force: true })
  })
})
