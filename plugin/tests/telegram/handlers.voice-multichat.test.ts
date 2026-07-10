// Multichat voice transcript delivery (fix 2026-06-11).
//
// Production bug: a voice message in a multichat group produced an
// InboundMessage with empty `text` and NO media payload — the rendered
// media descriptors (which carry the Groq transcript) were dropped on
// the router path, so the per-chat session received nothing to read.
// The DM path renders descriptors via buildChannelContent; the router
// path must carry the same strings in `media_descriptors`.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Context } from 'grammy'

import { handleInboundVoice } from '../../src/telegram/handlers.js'
import type { HandlerDeps } from '../../src/telegram/handlers.js'
import type {
  ChatPolicy,
  MultichatPolicy,
} from '../../src/chats/policy-loader.js'
import type { AppConfig, StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import type { TelegramApi } from '../../src/channel/tools.js'
import type { BotIdentity } from '../../src/prompt/build.js'
import type { MultichatRouter } from '../../src/router/multichat-router.js'
import type { InboundMessage } from '../../src/router/inbox-bridge.js'
import { renderMediaDescriptor } from '../../src/telegram/media.js'

const silentLog = createLogger('test', {
  stream: { write: () => true } as unknown as NodeJS.WritableStream,
})

const WARCHIEF_USER_ID = 164795011
const ALLOWED_GROUP_CHAT_ID = -1003784643974
const BOT_ID = 8507713167

function makeConfig(): AppConfig {
  return {
    bot_id: BOT_ID,
    dm_only: true,
    allowed_user_ids: [WARCHIEF_USER_ID],
    allowed_chat_ids: [WARCHIEF_USER_ID],
    status: {
      enabled: false,
      interval_ms: 700,
      ttl_ms: 300_000,
      delete_on_complete: true,
      suppress_typing_bubble: false,
    },
    album: { flush_ms: 2000 },
    voice: { provider: 'groq', language: 'ru', model: 'whisper-large-v3-turbo' },
    webhook: { enabled: false, host: '127.0.0.1', port: 0 },
    permission_relay: { enabled: false, allowed_user_ids: [], bash_only_proof: true },
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
  } as unknown as AppConfig
}

function makeStatePaths(): StatePaths {
  const root = mkdtempSync(join(tmpdir(), 'dashi-voice-mc-test-'))
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

function makePolicy(): MultichatPolicy {
  const groupChatPolicy: ChatPolicy = {
    mode: 'public',
    streaming: 'off',
    tmux_mirror: false,
    edit_message_progress: false,
    delivery: 'final_only',
    persona_file: 'thrall.md',
    handoff_file: 'handoff.md',
    system_reminder: '',
    idle_ttl_ms: 1_800_000,
    max_queue_depth: 1,
  }
  const chats: Record<string, ChatPolicy> = {
    [String(ALLOWED_GROUP_CHAT_ID)]: groupChatPolicy,
  }
  return {
    version: 1,
    allowlist: {
      chats: Object.keys(chats),
      users: [String(WARCHIEF_USER_ID)],
    },
    mention_allowlist: [String(WARCHIEF_USER_ID)],
    chats,
  }
}

function makeTelegramApi(): TelegramApi {
  const noop = async (): Promise<never> => {
    throw new Error('unexpected api call in voice-multichat test')
  }
  return {
    sendMessage: (async () => ({ message_id: 1 })) as unknown as TelegramApi['sendMessage'],
    sendRichMessage: noop as unknown as TelegramApi['sendRichMessage'],
    editMessageText: noop as unknown as TelegramApi['editMessageText'],
    setMessageReaction: async () => undefined,
    sendChatAction: async () => undefined,
    sendDocument: noop as unknown as TelegramApi['sendDocument'],
    sendPhoto: noop as unknown as TelegramApi['sendPhoto'],
    downloadFile: noop as unknown as TelegramApi['downloadFile'],
    deleteMessage: noop as unknown as TelegramApi['deleteMessage'],
    answerGuestQuery: noop as unknown as TelegramApi['answerGuestQuery'],
  }
}

function makeRouterSpy(): { router: MultichatRouter; calls: InboundMessage[] } {
  const calls: InboundMessage[] = []
  const router = {
    dispatch: async (msg: InboundMessage) => {
      calls.push(msg)
    },
  } as unknown as MultichatRouter
  return { router, calls }
}

function makeDeps(router: MultichatRouter): { deps: HandlerDeps; statePaths: StatePaths } {
  const statePaths = makeStatePaths()
  const bot: BotIdentity = { id: BOT_ID, username: 'canarybot' }
  const deps: HandlerDeps = {
    server: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      notification: async () => undefined,
    } as any,
    config: makeConfig(),
    statePaths,
    telegramApi: makeTelegramApi(),
    log: silentLog,
    bot,
    botApi: { api: {} } as unknown as HandlerDeps['botApi'],
    botToken: 'fake-token',
    env: {}, // no GROQ_API_KEY → transcription_status="missing_key", no download
    policy: makePolicy(),
    router,
  }
  return { deps, statePaths }
}

// Voice message in the allowed group, replying to a bot message — the
// reply-to-bot satisfies the addressing gate (a voice note has no text
// to carry an @mention; this is exactly how the warchief talks to the
// bot in the intensive group).
function makeGroupVoiceCtx(): Context {
  return {
    chat: { id: ALLOWED_GROUP_CHAT_ID, type: 'supergroup' as const },
    from: { id: WARCHIEF_USER_ID, is_bot: false, username: 'dashieshiev' },
    me: { id: BOT_ID, username: 'canarybot' },
    message: {
      message_id: 1793,
      date: 1700000000,
      voice: {
        file_id: 'voice-file-id-1',
        duration: 10,
        mime_type: 'audio/ogg',
        file_size: 37410,
      },
      chat: { id: ALLOWED_GROUP_CHAT_ID, type: 'supergroup' as const },
      from: { id: WARCHIEF_USER_ID, is_bot: false, username: 'dashieshiev' },
      reply_to_message: {
        message_id: 1792,
        date: 1700000000,
        text: 'bot speaking',
        from: { id: BOT_ID, is_bot: true, username: 'canarybot' },
      },
    },
  } as unknown as Context
}

describe('multichat voice → media descriptors reach the per-chat session', () => {
  test('group voice dispatches InboundMessage with media_descriptors', async () => {
    const { router, calls } = makeRouterSpy()
    const { deps, statePaths } = makeDeps(router)

    await handleInboundVoice(makeGroupVoiceCtx(), deps)

    expect(calls.length).toBe(1)
    const msg = calls[0]!
    // Voice has no caption — text stays empty; the payload must live in
    // media_descriptors instead of being silently dropped.
    expect(msg.text).toBe('')
    expect(msg.media_descriptors).toBeDefined()
    expect(msg.media_descriptors!.length).toBe(1)
    const d = msg.media_descriptors![0]!
    expect(d.startsWith('<media kind="voice"')).toBe(true)
    expect(d).toContain('transcription_status="missing_key"')
    // Single physical line — the tmux watcher pastes line-oriented.
    expect(d.includes('\n')).toBe(false)
    rmSync(statePaths.root, { recursive: true, force: true })
  })
})

describe('renderMediaDescriptor — single-line invariant', () => {
  test('transcript with newlines/control chars renders as one line', () => {
    const rendered = renderMediaDescriptor({
      kind: 'voice',
      fileId: 'f1',
      mime: 'audio/ogg',
      size: 1000,
      durationSec: 3,
      transcript: 'первая строка\nвторая строка\r\nтретья\tтаббип',
      transcriptionStatus: 'ok',
    })
    expect(rendered.includes('\n')).toBe(false)
    expect(rendered.includes('\r')).toBe(false)
    expect(rendered).toContain('первая строка')
    expect(rendered).toContain('вторая строка')
    // Tag shape survives sanitization.
    expect(rendered.startsWith('<media kind="voice"')).toBe(true)
    expect(rendered.endsWith('/>')).toBe(true)
  })
})

// Integration slice (Codex finding 3): the field must survive the real
// inbox write — the bash watcher reads the JSON file, not the TS object.
import { writeToInbox, ensureChatStateDirs } from '../../src/router/inbox-bridge.js'
import { readFileSync } from 'fs'

describe('writeToInbox persists media_descriptors to the JSON file', () => {
  test('round-trip: descriptor string lands in the on-disk JSON', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dashi-inbox-rt-'))
    const chatId = '-1003784643974'
    await ensureChatStateDirs(chatId, stateDir)
    const descriptor =
      '<media kind="voice" file_id="f1" transcript="привет" transcription_status="ok" />'
    const path = await writeToInbox(
      chatId,
      {
        text: '',
        chat_id: chatId,
        user_id: '164795011',
        user: 'dashieshiev',
        timestamp: new Date().toISOString(),
        media_descriptors: [descriptor],
      },
      stateDir,
    )
    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    expect(onDisk.media_descriptors).toEqual([descriptor])
    rmSync(stateDir, { recursive: true, force: true })
  })
})
