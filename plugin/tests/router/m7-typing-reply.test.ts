// M7 tests (2026-05-28) — group typing indicator + reply-on-mention.
//
// Feature: in PUBLIC (group) chats the router
//   1. threads the FIRST outbound reply of a turn as a quote-reply to the
//      message that summoned the bot (reply_to_message_id), consuming the
//      stored id once; and
//   2. shows a `sendChatAction('typing')` indicator from dispatch until the
//      reply is delivered.
// Neither applies to PRIVATE (DM) chats — there the in-process StatusManager
// already drives the typing bubble and reply-to-mention is meaningless.
//
// Covered:
//   * public dispatch with message_id → outbox send carries reply_to_message_id
//   * the stored reply target is consumed ONCE (second outbox reply has none)
//   * an explicit OutboxMessage.reply_to is preserved (not overwritten)
//   * private chat → no reply_to_message_id and no typing
//   * public dispatch → at least one sendChatAction('typing') is sent

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Logger } from '../../src/log.js'
import type { ChatPolicy, MultichatPolicy } from '../../src/chats/policy-loader.js'
import {
  MultichatRouter,
  type MultichatTelegramApi,
} from '../../src/router/multichat-router.js'
import type {
  SessionHandle,
  TmuxSessionPool,
} from '../../src/router/tmux-session-pool.js'
import type { InboundMessage } from '../../src/router/inbox-bridge.js'

const GROUP = '-1001234567890'
const USER = '164795011'

function silentLogger(): Logger {
  const noop = (): void => {}
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger
}

function makeChatPolicy(overrides: Partial<ChatPolicy> = {}): ChatPolicy {
  return {
    mode: 'private',
    streaming: 'progress',
    tmux_mirror: false,
    edit_message_progress: false,
    delivery: 'streamed',
    persona_file: 'persona.md',
    handoff_file: 'handoff.md',
    system_reminder: '',
    idle_ttl_ms: 1_800_000,
    max_queue_depth: 1,
    ...overrides,
  }
}

function makePolicy(chats: Record<string, ChatPolicy>): MultichatPolicy {
  return {
    version: 1,
    allowlist: { chats: Object.keys(chats), users: [USER] },
    mention_allowlist: [USER],
    chats,
  }
}

class FakePool {
  async loadSessions(): Promise<void> {}
  startWatchdog(): void {}
  stopWatchdog(): void {}
  async getOrSpawn(chatId: string): Promise<SessionHandle> {
    return {
      chatId,
      sessionName: `claude-${chatId}`,
      spawnedAt: Date.now(),
      lastMessageAt: Date.now(),
    }
  }
  touch(): void {}
  async kill(): Promise<void> {}
}

function spy(): {
  api: MultichatTelegramApi
  sends: Array<{ chatId: string; text: string; opts: Record<string, unknown> }>
  actions: Array<{ chatId: string; action: string }>
} {
  const sends: Array<{ chatId: string; text: string; opts: Record<string, unknown> }> = []
  const actions: Array<{ chatId: string; action: string }> = []
  const api: MultichatTelegramApi = {
    sendMessage: async (chatId, text, opts) => {
      sends.push({ chatId, text, opts: opts as Record<string, unknown> })
      return { ok: true, result: { message_id: sends.length } } as unknown as Awaited<
        ReturnType<MultichatTelegramApi['sendMessage']>
      >
    },
    sendChatAction: async (chatId, action) => {
      actions.push({ chatId, action: action as unknown as string })
    },
  }
  return { api, sends, actions }
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    text: 'привет',
    chat_id: GROUP,
    user_id: USER,
    user: 'dashieshiev',
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

async function seedOutbox(
  stateDir: string,
  chatId: string,
  filename: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const outboxDir = join(stateDir, 'chats', chatId, 'outbox')
  await mkdir(join(outboxDir, 'processing'), { recursive: true })
  await mkdir(join(outboxDir, 'dead-letter'), { recursive: true })
  await writeFile(join(outboxDir, filename), JSON.stringify(payload))
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Fx {
  tmpDir: string
  stateDir: string
  telegram: ReturnType<typeof spy>
}

let fx: Fx

beforeEach(() => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'm7-test-'))
  fx = { tmpDir, stateDir: join(tmpDir, 'state'), telegram: spy() }
})
afterEach(() => {
  try {
    rmSync(fx.tmpDir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

function makeRouter(policy: MultichatPolicy): MultichatRouter {
  return new MultichatRouter({
    policy,
    pool: new FakePool() as unknown as TmuxSessionPool,
    stateDir: fx.stateDir,
    workspaceDir: join(fx.tmpDir, 'workspace'),
    telegramApi: fx.telegram.api,
    logger: silentLogger(),
  })
}

describe('M7 — reply-on-mention (public chats)', () => {
  test('public dispatch with message_id → outbox reply carries reply_to_message_id', async () => {
    const router = makeRouter(makePolicy({ [GROUP]: makeChatPolicy({ mode: 'public' }) }))
    await router.start()
    await router.dispatch(inbound({ message_id: '555' }))
    await seedOutbox(fx.stateDir, GROUP, `${Date.now()}-aaaa.json`, {
      text: 'ответ',
      chat_id: GROUP,
      timestamp: '2026-05-28T00:00:00Z',
      format: 'text',
    })
    await sleep(600)
    await router.stop()

    expect(fx.telegram.sends.length).toBe(1)
    expect(fx.telegram.sends[0]?.opts.reply_to_message_id).toBe(555)
  }, 5_000)

  test('the stored reply target is consumed ONCE (second reply has none)', async () => {
    const router = makeRouter(makePolicy({ [GROUP]: makeChatPolicy({ mode: 'public' }) }))
    await router.start()
    await router.dispatch(inbound({ message_id: '555' }))
    await seedOutbox(fx.stateDir, GROUP, `1000000000000-aaaa.json`, {
      text: 'первый', chat_id: GROUP, timestamp: '2026-05-28T00:00:00Z', format: 'text',
    })
    await seedOutbox(fx.stateDir, GROUP, `1000000000001-bbbb.json`, {
      text: 'второй', chat_id: GROUP, timestamp: '2026-05-28T00:00:01Z', format: 'text',
    })
    await sleep(900)
    await router.stop()

    expect(fx.telegram.sends.length).toBe(2)
    const byText = Object.fromEntries(fx.telegram.sends.map((s) => [s.text, s.opts]))
    expect(byText['первый']?.reply_to_message_id).toBe(555)
    expect('reply_to_message_id' in (byText['второй'] ?? {})).toBe(false)
  }, 5_000)

  test('an explicit OutboxMessage.reply_to is preserved, not overwritten', async () => {
    const router = makeRouter(makePolicy({ [GROUP]: makeChatPolicy({ mode: 'public' }) }))
    await router.start()
    await router.dispatch(inbound({ message_id: '555' }))
    await seedOutbox(fx.stateDir, GROUP, `${Date.now()}-cccc.json`, {
      text: 'ответ',
      chat_id: GROUP,
      reply_to: '999',
      timestamp: '2026-05-28T00:00:00Z',
      format: 'text',
    })
    await sleep(600)
    await router.stop()

    expect(fx.telegram.sends[0]?.opts.reply_to_message_id).toBe(999)
  }, 5_000)

  test('a non-numeric message_id is rejected (no reply_to)', async () => {
    const router = makeRouter(makePolicy({ [GROUP]: makeChatPolicy({ mode: 'public' }) }))
    await router.start()
    await router.dispatch(inbound({ message_id: '123abc' }))
    await seedOutbox(fx.stateDir, GROUP, `${Date.now()}-eeee.json`, {
      text: 'ответ',
      chat_id: GROUP,
      timestamp: '2026-05-28T00:00:00Z',
      format: 'text',
    })
    await sleep(600)
    await router.stop()

    expect(fx.telegram.sends.length).toBe(1)
    expect('reply_to_message_id' in fx.telegram.sends[0]!.opts).toBe(false)
  }, 5_000)

  test('private chat → no reply_to_message_id', async () => {
    const router = makeRouter(makePolicy({ [USER]: makeChatPolicy({ mode: 'private' }) }))
    await router.start()
    await router.dispatch(inbound({ chat_id: USER, message_id: '555' }))
    await seedOutbox(fx.stateDir, USER, `${Date.now()}-dddd.json`, {
      text: 'ответ',
      chat_id: USER,
      timestamp: '2026-05-28T00:00:00Z',
      format: 'text',
    })
    await sleep(600)
    await router.stop()

    expect(fx.telegram.sends.length).toBe(1)
    expect('reply_to_message_id' in fx.telegram.sends[0]!.opts).toBe(false)
  }, 5_000)
})

describe('M7 — typing indicator', () => {
  test('public dispatch sends sendChatAction("typing")', async () => {
    const router = makeRouter(makePolicy({ [GROUP]: makeChatPolicy({ mode: 'public' }) }))
    await router.start()
    await router.dispatch(inbound({ message_id: '555' }))
    await sleep(50)
    await router.stop()

    const typing = fx.telegram.actions.filter(
      (a) => a.chatId === GROUP && a.action === 'typing',
    )
    expect(typing.length).toBeGreaterThanOrEqual(1)
  }, 5_000)

  test('private dispatch sends NO typing action', async () => {
    const router = makeRouter(makePolicy({ [USER]: makeChatPolicy({ mode: 'private' }) }))
    await router.start()
    await router.dispatch(inbound({ chat_id: USER, message_id: '555' }))
    await sleep(50)
    await router.stop()

    expect(fx.telegram.actions.length).toBe(0)
  }, 5_000)

  test('stop() clears the typing loop (no actions after stop)', async () => {
    const router = makeRouter(makePolicy({ [GROUP]: makeChatPolicy({ mode: 'public' }) }))
    await router.start()
    await router.dispatch(inbound({ message_id: '555' }))
    await sleep(50)
    await router.stop()
    const countAfterStop = fx.telegram.actions.length
    await sleep(300)
    expect(fx.telegram.actions.length).toBe(countAfterStop)
  }, 5_000)
})
