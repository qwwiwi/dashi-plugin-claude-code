// Guest Mode inbound handler tests (src/telegram/handlers.ts:handleGuestMessage).
//
// Contract under test:
//   - feature-gated: guest_mode absent/disabled → drop before any work
//   - fail-closed caller gate on guest_bot_caller_user ?? from vs
//     resolveGuestModeAllowedUserIds (silent drop, nothing registered)
//   - missing guest_query_id / empty text → drop, nothing registered
//   - allowed → registry.register + MCP notification with guest meta
//   - missing registry while enabled → drop with wiring error (no throw)

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Context } from 'grammy'

import { handleGuestMessage, type HandlerDeps } from '../../src/telegram/handlers.js'
import { GuestQueryRegistry } from '../../src/telegram/guest-queries.js'
import type { AppConfig, StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import type { TelegramApi } from '../../src/channel/tools.js'
import type { BotIdentity } from '../../src/prompt/build.js'

const silentLog = createLogger('test', {
  stream: { write: () => true } as unknown as NodeJS.WritableStream,
})

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    bot_id: 8507713167,
    dm_only: true,
    allowed_user_ids: [164795011],
    allowed_chat_ids: [164795011],
    status: { enabled: false, interval_ms: 700, ttl_ms: 300_000, delete_on_complete: true, suppress_typing_bubble: false },
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
    progress: { enabled: false, edit_throttle_ms: 3000, recent_buffer: 10, session_ttl_ms: 600000 },
    task_mirror: { enabled: false, edit_throttle_ms: 3000, session_ttl_ms: 600000, collapse_completed_after: 5 },
    watcher: { enabled: false, debounce_ms: 10_000, busy_threshold_ms: 30_000 },
    tmux_mirror: { enabled: false, pane_target: '', socket_name: '', poll_interval_ms: 5000, line_count: 50, hide_segments: ['boot_banner', 'inbound_warning', 'footer_hints', 'input_box'], mode: 'latest_inbound_only', max_lines: 14 },
    multichat: { enabled: false },
    ask_user_question: { enabled: false, timeout_ms: 300_000, max_preview_chars: 1000 },
    permission_gate: { enabled: false, timeout_ms: 120_000 },
    guest_mode: { enabled: true },
    richMessages: { enabled: false, perChatOptOut: [] },
    ...overrides,
  }
}

function makeStatePaths(): StatePaths {
  const root = mkdtempSync(join(tmpdir(), 'dashi-guest-handler-test-'))
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

interface ServerSpy {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server: any
  calls: Array<{ method: string; params: { content?: string; meta?: Record<string, string> } }>
}

function makeServerSpy(): ServerSpy {
  const calls: ServerSpy['calls'] = []
  return {
    server: {
      notification: async (msg: { method: string; params: ServerSpy['calls'][number]['params'] }): Promise<void> => {
        calls.push({ method: msg.method, params: msg.params })
      },
    },
    calls,
  }
}

function makeTelegramApi(): TelegramApi {
  const noop = async (): Promise<never> => {
    throw new Error('unexpected api call in guest handler test')
  }
  return {
    sendMessage: noop as unknown as TelegramApi['sendMessage'],
    sendRichMessage: noop as unknown as TelegramApi['sendRichMessage'],
    editMessageText: noop as unknown as TelegramApi['editMessageText'],
    setMessageReaction: noop as unknown as TelegramApi['setMessageReaction'],
    sendChatAction: async () => {},
    sendDocument: noop as unknown as TelegramApi['sendDocument'],
    sendPhoto: noop as unknown as TelegramApi['sendPhoto'],
    downloadFile: noop as unknown as TelegramApi['downloadFile'],
    deleteMessage: noop as unknown as TelegramApi['deleteMessage'],
    answerGuestQuery: noop as unknown as TelegramApi['answerGuestQuery'],
  }
}

function makeDeps(opts: {
  config?: AppConfig
  registry?: GuestQueryRegistry | undefined
  server?: ServerSpy
} = {}): { deps: HandlerDeps; serverSpy: ServerSpy; registry: GuestQueryRegistry | undefined } {
  const serverSpy = opts.server ?? makeServerSpy()
  const bot: BotIdentity = { id: 8507713167, username: 'canarybot' }
  const registry = 'registry' in opts ? opts.registry : new GuestQueryRegistry()
  const deps: HandlerDeps = {
    server: serverSpy.server,
    config: opts.config ?? makeConfig(),
    statePaths: makeStatePaths(),
    telegramApi: makeTelegramApi(),
    log: silentLog,
    bot,
    botApi: { api: {} } as unknown as HandlerDeps['botApi'],
    botToken: 'fake-token',
    env: {},
    ...(registry !== undefined ? { guestQueries: registry } : {}),
  }
  return { deps, serverSpy, registry }
}

// Minimal guest_message update Context. handleGuestMessage reads only
// ctx.update.guest_message.
function makeGuestCtx(opts: {
  text?: string
  caption?: string
  fromId?: number
  callerId?: number
  guestQueryId?: string
  chatId?: number
  replyTo?: { message_id: number; date: number; text: string; from: { id: number; is_bot: boolean } }
}): Context {
  const from =
    opts.fromId !== undefined
      ? { id: opts.fromId, is_bot: false, first_name: 'x' }
      : undefined
  const caller =
    opts.callerId !== undefined
      ? { id: opts.callerId, is_bot: false, first_name: 'c' }
      : undefined
  return {
    update: {
      update_id: 7,
      guest_message: {
        message_id: 555,
        date: 1700000000,
        chat: { id: opts.chatId ?? -100987, type: 'group', title: 'someone elses chat' },
        ...(from !== undefined ? { from } : {}),
        ...(caller !== undefined ? { guest_bot_caller_user: caller } : {}),
        ...(opts.guestQueryId !== undefined ? { guest_query_id: opts.guestQueryId } : {}),
        ...(opts.text !== undefined ? { text: opts.text } : {}),
        ...(opts.caption !== undefined ? { caption: opts.caption } : {}),
        ...(opts.replyTo !== undefined ? { reply_to_message: opts.replyTo } : {}),
      },
    },
  } as unknown as Context
}

describe('handleGuestMessage', () => {
  test('allowed caller → registry entry + MCP notification with guest meta', async () => {
    const { deps, serverSpy, registry } = makeDeps()
    const ctx = makeGuestCtx({
      text: '@canarybot что значит эта ошибка?',
      fromId: 164795011,
      guestQueryId: 'gq-1',
      chatId: -100987,
    })

    await handleGuestMessage(ctx, deps)

    expect(serverSpy.calls.length).toBe(1)
    const { params } = serverSpy.calls[0]!
    expect(params.meta?.guest).toBe('1')
    expect(params.meta?.guest_query_id).toBe('gq-1')
    expect(params.meta?.user_id).toBe('164795011')
    expect(params.meta?.chat_id).toBe('-100987')
    expect(params.content).toContain('что значит эта ошибка?')
    // Registered and claimable exactly once.
    expect(registry!.claim('gq-1').kind).toBe('ok')
    expect(registry!.claim('gq-1').kind).toBe('consumed')
  })

  test('guest_bot_caller_user wins over from for the gate', async () => {
    const { deps, serverSpy } = makeDeps()
    // from is a stranger, caller field is the owner — allowed.
    const ctx = makeGuestCtx({
      text: 'hi',
      fromId: 999,
      callerId: 164795011,
      guestQueryId: 'gq-2',
    })
    await handleGuestMessage(ctx, deps)
    expect(serverSpy.calls.length).toBe(1)
    expect(serverSpy.calls[0]!.params.meta?.user_id).toBe('164795011')
  })

  test('stranger caller → silent drop, nothing registered', async () => {
    const { deps, serverSpy, registry } = makeDeps()
    const ctx = makeGuestCtx({ text: 'gimme secrets', fromId: 999, guestQueryId: 'gq-3' })
    await handleGuestMessage(ctx, deps)
    expect(serverSpy.calls.length).toBe(0)
    expect(registry!.claim('gq-3').kind).toBe('unknown')
  })

  test('explicit guest_mode.allowed_user_ids overrides the inherited list', async () => {
    const config = makeConfig({
      guest_mode: { enabled: true, allowed_user_ids: [42] },
    })
    const { deps, serverSpy } = makeDeps({ config })
    // Owner is NOT in the explicit guest allowlist → drop.
    await handleGuestMessage(
      makeGuestCtx({ text: 'x', fromId: 164795011, guestQueryId: 'gq-4' }),
      deps,
    )
    expect(serverSpy.calls.length).toBe(0)
    // The explicit id passes.
    await handleGuestMessage(
      makeGuestCtx({ text: 'y', fromId: 42, guestQueryId: 'gq-5' }),
      deps,
    )
    expect(serverSpy.calls.length).toBe(1)
  })

  test('disabled feature → drop even for the owner', async () => {
    const { deps, serverSpy } = makeDeps({ config: makeConfig({ guest_mode: { enabled: false } }) })
    await handleGuestMessage(
      makeGuestCtx({ text: 'x', fromId: 164795011, guestQueryId: 'gq-6' }),
      deps,
    )
    expect(serverSpy.calls.length).toBe(0)
  })

  test('missing guest_query_id → drop', async () => {
    const { deps, serverSpy } = makeDeps()
    await handleGuestMessage(makeGuestCtx({ text: 'x', fromId: 164795011 }), deps)
    expect(serverSpy.calls.length).toBe(0)
  })

  test('empty text → drop, nothing registered', async () => {
    const { deps, serverSpy, registry } = makeDeps()
    await handleGuestMessage(
      makeGuestCtx({ text: '   ', fromId: 164795011, guestQueryId: 'gq-7' }),
      deps,
    )
    expect(serverSpy.calls.length).toBe(0)
    expect(registry!.claim('gq-7').kind).toBe('unknown')
  })

  test('missing caller entirely → drop', async () => {
    const { deps, serverSpy } = makeDeps()
    await handleGuestMessage(makeGuestCtx({ text: 'x', guestQueryId: 'gq-8' }), deps)
    expect(serverSpy.calls.length).toBe(0)
  })

  test('enabled but registry not wired → drop with no throw', async () => {
    const { deps, serverSpy } = makeDeps({ registry: undefined })
    await handleGuestMessage(
      makeGuestCtx({ text: 'x', fromId: 164795011, guestQueryId: 'gq-9' }),
      deps,
    )
    expect(serverSpy.calls.length).toBe(0)
  })

  test('caption-only guest message (media mention) is delivered', async () => {
    const { deps, serverSpy } = makeDeps()
    await handleGuestMessage(
      makeGuestCtx({ caption: 'что на этом скрине?', fromId: 164795011, guestQueryId: 'gq-cap' }),
      deps,
    )
    expect(serverSpy.calls.length).toBe(1)
    expect(serverSpy.calls[0]!.params.content).toContain('что на этом скрине?')
  })

  test('guest reply_to context is wrapped as untrusted_metadata (anti-spoof parity)', async () => {
    const { deps, serverSpy } = makeDeps()
    await handleGuestMessage(
      makeGuestCtx({
        text: 'объясни ошибку выше',
        fromId: 164795011,
        guestQueryId: 'gq-rt',
        replyTo: {
          message_id: 500,
          date: 1700000000,
          text: 'Traceback: boom',
          from: { id: 999, is_bot: false },
        },
      }),
      deps,
    )
    expect(serverSpy.calls.length).toBe(1)
    const content = serverSpy.calls[0]!.params.content ?? ''
    expect(content).toContain('<untrusted_metadata')
    expect(content).toContain('Traceback: boom')
  })

  test('notify transport failure throws so the poller dead-letters', async () => {
    const failingServer: ServerSpy = {
      server: {
        notification: async (): Promise<void> => {
          throw new Error('transport down')
        },
      },
      calls: [],
    }
    const { deps } = makeDeps({ server: failingServer })
    await expect(
      handleGuestMessage(
        makeGuestCtx({ text: 'x', fromId: 164795011, guestQueryId: 'gq-10' }),
        deps,
      ),
    ).rejects.toThrow('guest message dead-lettered')
  })
})
