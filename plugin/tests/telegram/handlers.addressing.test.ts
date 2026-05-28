// TASK-4 Bug #3 + #4 — addressed-only side effects.
//
// Covers:
//   * watcher does not fire for a group message without @mention / reply
//   * tmux-mirror bump does not fire for a non-addressed group message
//   * setMessageReaction does NOT run when the allowlist gate would
//     drop the sender (unallowed sender, or allowed sender in a chat
//     not in the gate's allowlist)
//   * setMessageReaction DOES fire for an allowed DM sender and for
//     an allowed group sender that @mentions the bot
//
// Permitted-side effects in legacy mode (no policy) are exercised in
// handlers.test.ts; this file focuses on the multichat-aware paths
// where the policy / mention_allowlist matter.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Context } from 'grammy'

import {
  handleInboundText,
  type HandlerDeps,
} from '../../src/telegram/handlers.js'
import {
  InboundWatcher,
  type ProgressReporterForWatcher,
} from '../../src/telegram/watcher.js'
import {
  type ChatPolicy,
  type MultichatPolicy,
} from '../../src/chats/policy-loader.js'
import type { AppConfig, StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import type { TelegramApi } from '../../src/channel/tools.js'
import type { BotIdentity } from '../../src/prompt/build.js'
import type { TmuxMirrorControl } from '../../src/commands/oob.js'
import type { MultichatRouter } from '../../src/router/multichat-router.js'
import type { InboundMessage } from '../../src/router/inbox-bridge.js'

const silentLog = createLogger('test', {
  stream: { write: () => true } as unknown as NodeJS.WritableStream,
})

const WARCHIEF_USER_ID = 164795011
const ALLOWED_GROUP_CHAT_ID = -1003784643974

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    bot_id: 8507713167,
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
    ...overrides,
  } as unknown as AppConfig
}

function makeStatePaths(): StatePaths {
  const root = mkdtempSync(join(tmpdir(), 'dashi-addr-test-'))
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
    },
  }
}

function makePolicy(overrides: {
  chats?: Record<string, ChatPolicy>
  allowlist_chats?: string[]
  allowlist_users?: string[]
  mention_allowlist?: string[]
} = {}): MultichatPolicy {
  const dmChatPolicy: ChatPolicy = {
    mode: 'private',
    streaming: 'progress',
    tmux_mirror: true,
    edit_message_progress: true,
    delivery: 'streamed',
    persona_file: 'thrall.md',
    handoff_file: 'handoff.md',
    system_reminder: '',
    idle_ttl_ms: 1_800_000,
    max_queue_depth: 1,
  }
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
  const defaultChats: Record<string, ChatPolicy> = {
    [String(WARCHIEF_USER_ID)]: dmChatPolicy,
    [String(ALLOWED_GROUP_CHAT_ID)]: groupChatPolicy,
  }
  const chats = overrides.chats ?? defaultChats
  return {
    version: 1,
    allowlist: {
      chats: overrides.allowlist_chats ?? Object.keys(chats),
      users: overrides.allowlist_users ?? [String(WARCHIEF_USER_ID)],
    },
    mention_allowlist:
      overrides.mention_allowlist ?? [String(WARCHIEF_USER_ID)],
    chats,
  }
}

function makeTelegramApi(): {
  api: TelegramApi
  reactions: Array<{ chatId: string; messageId: number; emoji: string }>
} {
  const reactions: Array<{ chatId: string; messageId: number; emoji: string }> = []
  const noop = async (): Promise<never> => {
    throw new Error('unexpected api call in addressing test')
  }
  const api: TelegramApi = {
    sendMessage: (async () => ({ message_id: 1 })) as unknown as TelegramApi['sendMessage'],
    editMessageText: noop as unknown as TelegramApi['editMessageText'],
    setMessageReaction: async (chatId, messageId, emoji) => {
      reactions.push({ chatId, messageId, emoji })
    },
    sendChatAction: async () => undefined,
    sendDocument: noop as unknown as TelegramApi['sendDocument'],
    sendPhoto: noop as unknown as TelegramApi['sendPhoto'],
    downloadFile: noop as unknown as TelegramApi['downloadFile'],
    deleteMessage: noop as unknown as TelegramApi['deleteMessage'],
  }
  return { api, reactions }
}

function makeFakeProgress(busy: boolean, toolName?: string): ProgressReporterForWatcher {
  return {
    isBusy: () => busy,
    getActiveToolName: () => toolName,
  }
}

interface MakeDepsOpts {
  config?: AppConfig
  policy?: MultichatPolicy
  watcher?: InboundWatcher
  tmuxMirror?: TmuxMirrorControl
  telegramApi?: TelegramApi
}
function makeDeps(opts: MakeDepsOpts = {}): {
  deps: HandlerDeps
  statePaths: StatePaths
} {
  const config = opts.config ?? makeConfig()
  const statePaths = makeStatePaths()
  const bot: BotIdentity = { id: 8507713167, username: 'canarybot' }
  const tg = opts.telegramApi ?? makeTelegramApi().api
  const deps: HandlerDeps = {
    server: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      notification: async () => undefined,
    } as any,
    config,
    statePaths,
    telegramApi: tg,
    log: silentLog,
    bot,
    botApi: { api: {} } as unknown as HandlerDeps['botApi'],
    botToken: 'fake-token',
    env: {},
    ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
    ...(opts.watcher !== undefined ? { watcher: opts.watcher } : {}),
    ...(opts.tmuxMirror !== undefined ? { tmuxMirror: opts.tmuxMirror } : {}),
  }
  return { deps, statePaths }
}

// Group context with optional @mention and reply-to-bot. `botUsername`
// matches the `bot.username` injected via deps.bot above. grammY's
// ctx.me is consulted by addressing.ts so we must populate it.
function makeGroupCtx(opts: {
  text: string
  chatId: number
  fromId: number
  mentionBot?: boolean
  replyToBot?: boolean
  botUsername?: string
}): Context {
  const botUsername = opts.botUsername ?? 'canarybot'
  const text = opts.mentionBot ? `${opts.text} @${botUsername}` : opts.text
  const reply = opts.replyToBot
    ? {
        message_id: 100,
        date: 1700000000,
        text: 'bot speaking',
        from: {
          id: 8507713167,
          is_bot: true,
          username: botUsername,
        },
      }
    : undefined
  return {
    chat: { id: opts.chatId, type: 'supergroup' as const },
    from: { id: opts.fromId, is_bot: false, first_name: 'x' },
    me: { id: 8507713167, username: botUsername },
    message: {
      message_id: 42,
      date: 1700000000,
      text,
      chat: { id: opts.chatId, type: 'supergroup' as const },
      from: { id: opts.fromId, is_bot: false, first_name: 'x' },
      ...(reply ? { reply_to_message: reply } : {}),
    },
  } as unknown as Context
}

function makeDmCtx(opts: { text: string; chatId: number; fromId: number; botUsername?: string }): Context {
  const botUsername = opts.botUsername ?? 'canarybot'
  return {
    chat: { id: opts.chatId, type: 'private' as const },
    from: { id: opts.fromId, is_bot: false, first_name: 'x' },
    me: { id: 8507713167, username: botUsername },
    message: {
      message_id: 42,
      date: 1700000000,
      text: opts.text,
      chat: { id: opts.chatId, type: 'private' as const },
      from: { id: opts.fromId, is_bot: false, first_name: 'x' },
    },
  } as unknown as Context
}

// ─────────────────────────────────────────────────────────────────────
// Bug #3 — watcher / mirror require BOTH allowlist AND addressing
// ─────────────────────────────────────────────────────────────────────

describe('handleInboundText — addressing gate on side effects (Bug #3)', () => {
  test('group message WITHOUT mention does NOT trigger watcher', async () => {
    const policy = makePolicy()
    const sendCalls: string[] = []
    const tg = makeTelegramApi()
    const api: TelegramApi = {
      ...tg.api,
      sendMessage: async (_chatId, text) => {
        sendCalls.push(text)
        return { message_id: 1 }
      },
    }
    const watcher = new InboundWatcher({
      telegramApi: api,
      config: makeConfig(),
      log: silentLog,
      progressReporter: makeFakeProgress(true, 'Bash'),
    })
    const { deps, statePaths } = makeDeps({
      policy,
      watcher,
      telegramApi: api,
    })

    const ctx = makeGroupCtx({
      text: 'just chatting in the group',
      chatId: ALLOWED_GROUP_CHAT_ID,
      fromId: WARCHIEF_USER_ID,
      mentionBot: false,
    })
    await handleInboundText(ctx, deps)
    await new Promise((r) => setTimeout(r, 0))

    // No auto-reply — group message without @mention is not addressed.
    expect(sendCalls.length).toBe(0)
    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('group message WITH mention DOES trigger watcher', async () => {
    const policy = makePolicy()
    const sendCalls: string[] = []
    const tg = makeTelegramApi()
    const api: TelegramApi = {
      ...tg.api,
      sendMessage: async (_chatId, text) => {
        sendCalls.push(text)
        return { message_id: 1 }
      },
    }
    const watcher = new InboundWatcher({
      telegramApi: api,
      config: makeConfig(),
      log: silentLog,
      progressReporter: makeFakeProgress(true, 'Bash'),
    })
    const { deps, statePaths } = makeDeps({
      policy,
      watcher,
      telegramApi: api,
    })

    const ctx = makeGroupCtx({
      text: 'привет',
      chatId: ALLOWED_GROUP_CHAT_ID,
      fromId: WARCHIEF_USER_ID,
      mentionBot: true,
    })
    await handleInboundText(ctx, deps)
    await new Promise((r) => setTimeout(r, 0))

    // Mention → addressed → watcher fires.
    expect(sendCalls.length).toBe(1)
    expect(sendCalls[0]).toContain('Bash')
    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('group message WITHOUT mention does NOT bump tmux mirror', async () => {
    const policy = makePolicy()
    let bumps = 0
    const tmuxMirror: TmuxMirrorControl = {
      start: async () => undefined,
      stop: async () => undefined,
      status: () => ({ enabled: true }),
      bump: async () => {
        bumps++
      },
    }
    const { deps, statePaths } = makeDeps({ policy, tmuxMirror })
    const ctx = makeGroupCtx({
      text: 'plain group chat',
      chatId: ALLOWED_GROUP_CHAT_ID,
      fromId: WARCHIEF_USER_ID,
      mentionBot: false,
    })
    await handleInboundText(ctx, deps)
    await new Promise((r) => setTimeout(r, 0))
    expect(bumps).toBe(0)
    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('DM ALWAYS bumps mirror (addressing always true)', async () => {
    let bumps = 0
    const tmuxMirror: TmuxMirrorControl = {
      start: async () => undefined,
      stop: async () => undefined,
      status: () => ({ enabled: true }),
      bump: async () => {
        bumps++
      },
    }
    // Legacy mode (no policy) — relies on legacy allowlist; DM passes
    // addressing unconditionally.
    const { deps, statePaths } = makeDeps({ tmuxMirror })
    const ctx = makeDmCtx({
      text: 'hi',
      chatId: WARCHIEF_USER_ID,
      fromId: WARCHIEF_USER_ID,
    })
    await handleInboundText(ctx, deps)
    await new Promise((r) => setTimeout(r, 0))
    expect(bumps).toBe(1)
    rmSync(statePaths.root, { recursive: true, force: true })
  })
})

// ─────────────────────────────────────────────────────────────────────
// Bug #4 — reaction must require gate.allow before firing
// ─────────────────────────────────────────────────────────────────────

describe('handleInboundText — reaction guard (Bug #4)', () => {
  test('unallowed DM sender does NOT receive reaction', async () => {
    const tg = makeTelegramApi()
    const { deps, statePaths } = makeDeps({ telegramApi: tg.api })
    // Sender 99999 is not in allowed_user_ids.
    const ctx = makeDmCtx({
      text: 'random hello',
      chatId: WARCHIEF_USER_ID, // chat id is allowed, but…
      fromId: 99999, // …sender is not.
    })
    await handleInboundText(ctx, deps)
    // gate.drop → no reaction.
    expect(tg.reactions.length).toBe(0)
    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('allowed DM sender DOES receive reaction', async () => {
    const tg = makeTelegramApi()
    const { deps, statePaths } = makeDeps({ telegramApi: tg.api })
    const ctx = makeDmCtx({
      text: 'hi',
      chatId: WARCHIEF_USER_ID,
      fromId: WARCHIEF_USER_ID,
    })
    await handleInboundText(ctx, deps)
    expect(tg.reactions.length).toBe(1)
    expect(tg.reactions[0]!.emoji).toBe('👀')
    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('allowed sender in group + mention → reaction fires after gate', async () => {
    const policy = makePolicy()
    const tg = makeTelegramApi()
    const { deps, statePaths } = makeDeps({ policy, telegramApi: tg.api })
    const ctx = makeGroupCtx({
      text: 'привет',
      chatId: ALLOWED_GROUP_CHAT_ID,
      fromId: WARCHIEF_USER_ID,
      mentionBot: true,
    })
    await handleInboundText(ctx, deps)
    expect(tg.reactions.length).toBe(1)
    expect(tg.reactions[0]!.chatId).toBe(String(ALLOWED_GROUP_CHAT_ID))
    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('group sender WITHOUT mention → no reaction (addressing fails)', async () => {
    const policy = makePolicy()
    const tg = makeTelegramApi()
    const { deps, statePaths } = makeDeps({ policy, telegramApi: tg.api })
    const ctx = makeGroupCtx({
      text: 'just talking',
      chatId: ALLOWED_GROUP_CHAT_ID,
      fromId: WARCHIEF_USER_ID,
      mentionBot: false,
    })
    await handleInboundText(ctx, deps)
    expect(tg.reactions.length).toBe(0)
    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('group sender NOT in mention_allowlist with mention → no reaction', async () => {
    // Set mention_allowlist to empty so even @-mentions from a sender
    // in the chat-allowlist are silently dropped.
    const policy = makePolicy({
      mention_allowlist: [],
      allowlist_users: [String(WARCHIEF_USER_ID), '99999'],
    })
    const tg = makeTelegramApi()
    const { deps, statePaths } = makeDeps({ policy, telegramApi: tg.api })
    const ctx = makeGroupCtx({
      text: 'я тут',
      chatId: ALLOWED_GROUP_CHAT_ID,
      fromId: 99999,
      mentionBot: true,
    })
    await handleInboundText(ctx, deps)
    expect(tg.reactions.length).toBe(0)
    rmSync(statePaths.root, { recursive: true, force: true })
  })
})

// ─────────────────────────────────────────────────────────────────────
// FIX-D M1 — policy without router in group → drop with error log,
// no legacy notify leak.
// ─────────────────────────────────────────────────────────────────────

describe('FIX-D M1 — text handler policy/router XOR check', () => {
  test('group text + policy + missing router → drops with error log, no notify', async () => {
    // Capture notify calls — they should NEVER fire for a group dispatch
    // when router is missing (otherwise traffic leaks to master session).
    const notifyCalls: Array<{ method: string; params: unknown }> = []
    const errorLogs: string[] = []
    const log = {
      ...silentLog,
      error: (msg: string) => {
        errorLogs.push(msg)
      },
    }
    const policy = makePolicy({
      // Sender 164795011 is in users; group chat allowed.
    })
    const tg = makeTelegramApi()
    // Build deps with policy but NO router — the bug we're defending.
    const statePaths = makeStatePaths()
    const bot: BotIdentity = { id: 8507713167, username: 'canarybot' }
    const deps: HandlerDeps = {
      server: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        notification: async (msg: any) => {
          notifyCalls.push({ method: msg.method, params: msg.params })
        },
      } as any,
      config: makeConfig(),
      statePaths,
      telegramApi: tg.api,
      log,
      bot,
      botApi: { api: {} } as unknown as HandlerDeps['botApi'],
      botToken: 'fake-token',
      env: {},
      policy,
      // router intentionally undefined
    }

    const ctx = makeGroupCtx({
      text: 'help me',
      chatId: ALLOWED_GROUP_CHAT_ID,
      fromId: WARCHIEF_USER_ID,
      mentionBot: true,
    })
    await handleInboundText(ctx, deps)

    // Zero legacy notifications — the XOR check refused dispatch.
    expect(notifyCalls.length).toBe(0)
    // Error log fires so operator notices the misconfig.
    expect(errorLogs.some((m) => m.includes('policy_router_misconfig'))).toBe(true)
    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('DM text + policy + missing router → legacy notify still works (DM exempt)', async () => {
    // The XOR check only fires for group/supergroup dispatch. DMs use
    // the legacy notify path intentionally in single-chat builds even
    // when policy is configured.
    const notifyCalls: Array<{ method: string; params: unknown }> = []
    const policy = makePolicy()
    const tg = makeTelegramApi()
    const statePaths = makeStatePaths()
    const bot: BotIdentity = { id: 8507713167, username: 'canarybot' }
    const deps: HandlerDeps = {
      server: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        notification: async (msg: any) => {
          notifyCalls.push({ method: msg.method, params: msg.params })
        },
      } as any,
      config: makeConfig(),
      statePaths,
      telegramApi: tg.api,
      log: silentLog,
      bot,
      botApi: { api: {} } as unknown as HandlerDeps['botApi'],
      botToken: 'fake-token',
      env: {},
      policy,
      // router omitted
    }

    const ctx = makeDmCtx({
      text: 'hi',
      chatId: WARCHIEF_USER_ID,
      fromId: WARCHIEF_USER_ID,
    })
    await handleInboundText(ctx, deps)

    // DM notify fires through legacy path.
    expect(notifyCalls.length).toBe(1)
    rmSync(statePaths.root, { recursive: true, force: true })
  })
})

// ─────────────────────────────────────────────────────────────────────
// Hybrid routing (2026-05-28): even with router AND policy wired, a
// private DM lands in the master (channel-thrall) session via legacy
// notify — NOT a per-chat tmux session. Only group/supergroup chats are
// dispatched to the router. This is the warchief's explicit topology:
// "main Telegram → channel-thrall, group chats → multichat".
// ─────────────────────────────────────────────────────────────────────

describe('hybrid routing — DM to master, groups to per-chat (router wired)', () => {
  function makeRouterSpy(): { router: MultichatRouter; calls: InboundMessage[] } {
    const calls: InboundMessage[] = []
    const router = {
      dispatch: async (msg: InboundMessage) => {
        calls.push(msg)
      },
    } as unknown as MultichatRouter
    return { router, calls }
  }

  function makeDepsWithRouter(
    router: MultichatRouter,
    policy: MultichatPolicy,
    notifyCalls: Array<{ method: string; params: unknown }>,
  ): { deps: HandlerDeps; statePaths: StatePaths } {
    const statePaths = makeStatePaths()
    const bot: BotIdentity = { id: 8507713167, username: 'canarybot' }
    const deps: HandlerDeps = {
      server: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        notification: async (msg: any) => {
          notifyCalls.push({ method: msg.method, params: msg.params })
        },
      } as any,
      config: makeConfig(),
      statePaths,
      telegramApi: makeTelegramApi().api,
      log: silentLog,
      bot,
      botApi: { api: {} } as unknown as HandlerDeps['botApi'],
      botToken: 'fake-token',
      env: {},
      policy,
      router,
    }
    return { deps, statePaths }
  }

  test('DM + policy + router PRESENT → legacy notify, NO router dispatch', async () => {
    const { router, calls } = makeRouterSpy()
    const notifyCalls: Array<{ method: string; params: unknown }> = []
    const { deps, statePaths } = makeDepsWithRouter(router, makePolicy(), notifyCalls)

    const ctx = makeDmCtx({
      text: 'привет',
      chatId: WARCHIEF_USER_ID,
      fromId: WARCHIEF_USER_ID,
    })
    await handleInboundText(ctx, deps)

    // DM stays on the master session — router is NOT used.
    expect(calls.length).toBe(0)
    expect(notifyCalls.length).toBe(1)
    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('group + policy + router PRESENT → router dispatch, NO legacy notify', async () => {
    const { router, calls } = makeRouterSpy()
    const notifyCalls: Array<{ method: string; params: unknown }> = []
    const { deps, statePaths } = makeDepsWithRouter(router, makePolicy(), notifyCalls)

    const ctx = makeGroupCtx({
      text: 'эй',
      chatId: ALLOWED_GROUP_CHAT_ID,
      fromId: WARCHIEF_USER_ID,
      mentionBot: true,
    })
    await handleInboundText(ctx, deps)

    // Group goes to its per-chat session via the router, not the master.
    expect(calls.length).toBe(1)
    expect(calls[0]?.chat_id).toBe(String(ALLOWED_GROUP_CHAT_ID))
    expect(notifyCalls.length).toBe(0)
    rmSync(statePaths.root, { recursive: true, force: true })
  })
})
