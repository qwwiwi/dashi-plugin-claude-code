// Wave 3: rich delivery for GROUP answers (multichat router).
//
// The group path is NOT the reply tool — outbox files are drained by
// MultichatRouter.deliverClaim, which sends via sendMessage with 4000-char
// chunking. These tests pin the wave-3 contract on that path:
//   * only format 'auto' may go rich (the one case where the router owns
//     text shape; for html/markdown/text the writer already decided)
//   * the CONTENT decides — prose stays on HTML, a table earns rich
//   * both client shields veto rich, and the message still ships
//   * exactly one path sends: rich OR chunked HTML, never both
//   * an api without sendRichMessage behaves exactly as before

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Logger } from '../../src/log.js'
import type {
  ChatPolicy,
  MultichatPolicy,
} from '../../src/chats/policy-loader.js'
import {
  MultichatRouter,
  type MultichatTelegramApi,
} from '../../src/router/multichat-router.js'
import type {
  SessionHandle,
  TmuxSessionPool,
} from '../../src/router/tmux-session-pool.js'

// ──────────────────────────────────────────────────────────────────────
// Shared helpers (mirrored from multichat-router.gate.test.ts so the
// FIX-F tests stay self-contained — touching the gate-test fixture
// while FIX-E is mid-merge would risk a needless conflict).
// ──────────────────────────────────────────────────────────────────────

interface CapturedLog {
  level: 'debug' | 'info' | 'warn' | 'error'
  msg: string
  ctx: Record<string, unknown> | undefined
}

function capturingLogger(): { logger: Logger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = []
  const push = (level: CapturedLog['level']) =>
    (msg: string, ctx?: Record<string, unknown>): void => {
      logs.push({ level, msg, ctx })
    }
  return {
    logs,
    logger: {
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
    },
  }
}

function makeChatPolicy(overrides: Partial<ChatPolicy> = {}): ChatPolicy {
  return {
    mode: 'private',
    streaming: 'progress',
    tmux_mirror: true,
    edit_message_progress: true,
    delivery: 'streamed',
    persona_file: 'persona.md',
    handoff_file: 'handoff.md',
    system_reminder: '',
    idle_ttl_ms: 1_800_000,
    max_queue_depth: 1,
    ...overrides,
  }
}

function makePolicy(opts: {
  chats?: Record<string, ChatPolicy>
  allowlist_chats?: string[]
  allowlist_users?: string[]
}): MultichatPolicy {
  const chats = opts.chats ?? {}
  return {
    version: 1,
    allowlist: {
      chats: opts.allowlist_chats ?? Object.keys(chats),
      users: opts.allowlist_users ?? [],
    },
    mention_allowlist: [],
    chats,
  }
}

// Minimal in-memory fake of TmuxSessionPool. The FIX-F flow does not
// exercise spawn — we drop the outbox file directly and let the router
// drain it. start() iterates policy.allowlist.chats and starts outbox
// loops, which is what we need.
class FakePool {
  spawned: string[] = []
  touched: string[] = []
  watchdogStarted = false
  watchdogStopped = false

  async loadSessions(): Promise<void> {
    /* no-op */
  }
  startWatchdog(): void {
    this.watchdogStarted = true
  }
  stopWatchdog(): void {
    this.watchdogStopped = true
  }
  async getOrSpawn(chatId: string): Promise<SessionHandle> {
    this.spawned.push(chatId)
    return {
      chatId,
      sessionName: `claude-${chatId}`,
      spawnedAt: Date.now(),
      lastMessageAt: Date.now(),
    }
  }
  touch(chatId: string): void {
    this.touched.push(chatId)
  }
  async kill(_chatId: string): Promise<void> {
    /* no-op */
  }
}

// Spy Telegram API that records each sendMessage call. `opts` is
// captured as-is so we can assert presence/absence of `parse_mode`
// at the key level (not just value-level) — the FIX-F contract says
// format='text' MUST OMIT parse_mode, not set it to undefined.
function spyTelegramApi(): {
  api: MultichatTelegramApi
  calls: Array<{ chatId: string; text: string; opts: Record<string, unknown> }>
} {
  const calls: Array<{
    chatId: string
    text: string
    opts: Record<string, unknown>
  }> = []
  const api: MultichatTelegramApi = {
    sendMessage: async (chatId, text, opts) => {
      calls.push({ chatId, text, opts: opts as Record<string, unknown> })
      return { ok: true, result: { message_id: calls.length } } as unknown as Awaited<
        ReturnType<MultichatTelegramApi['sendMessage']>
      >
    },
    sendChatAction: async () => {},
  }
  return { api, calls }
}

interface Fixture {
  tmpDir: string
  stateDir: string
  workspaceDir: string
  pool: FakePool
  telegram: ReturnType<typeof spyTelegramApi>
  loggerState: ReturnType<typeof capturingLogger>
}

function setupFixture(): Fixture {
  const tmpDir = mkdtempSync(join(tmpdir(), 'fix-f-test-'))
  return {
    tmpDir,
    stateDir: join(tmpDir, 'state'),
    workspaceDir: join(tmpDir, 'workspace'),
    pool: new FakePool(),
    telegram: spyTelegramApi(),
    loggerState: capturingLogger(),
  }
}

function cleanupFixture(fx: Fixture): void {
  try {
    rmSync(fx.tmpDir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

// Seed one outbox file with the given JSON payload, then return the
// path so a test can introspect quarantine/dead-letter behaviour.
async function seedOutboxFile(
  stateDir: string,
  chatId: string,
  filename: string,
  payload: unknown,
): Promise<string> {
  const outboxDir = join(stateDir, 'chats', chatId, 'outbox')
  await mkdir(join(outboxDir, 'processing'), { recursive: true })
  await mkdir(join(outboxDir, 'dead-letter'), { recursive: true })
  const path = join(outboxDir, filename)
  await writeFile(path, JSON.stringify(payload))
  return path
}


// ──────────────────────────────────────────────────────────────────────
// Wave 3 — rich on the group path
// ──────────────────────────────────────────────────────────────────────

const TABLE = '| a | b |\n| --- | --- |\n| 1 | 2 |'

function spyRichApi(richBehaviour: () => Promise<{ message_id: number } | { fallback: true }>): {
  api: MultichatTelegramApi
  sends: Array<{ text: string }>
  richSends: Array<{ text: string }>
} {
  const sends: Array<{ text: string }> = []
  const richSends: Array<{ text: string }> = []
  const api: MultichatTelegramApi = {
    sendMessage: async (_chatId, text) => {
      sends.push({ text })
      return { message_id: sends.length }
    },
    sendChatAction: async () => {},
    sendRichMessage: async (_chatId, rawMarkdown) => {
      richSends.push({ text: rawMarkdown })
      return richBehaviour()
    },
  }
  return { api, sends, richSends }
}

describe('multichat router — rich group delivery (wave 3)', () => {
  let fx: Fixture
  const groupChat = '-1001234567890'

  beforeEach(() => {
    fx = setupFixture()
  })
  afterEach(() => {
    cleanupFixture(fx)
  })

  function policyForGroup(): MultichatPolicy {
    return makePolicy({
      chats: { [groupChat]: makeChatPolicy({ mode: 'public' }) },
      allowlist_chats: [groupChat],
    })
  }

  async function drain(
    api: MultichatTelegramApi,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const router = new MultichatRouter({
      policy: policyForGroup(),
      pool: fx.pool as unknown as TmuxSessionPool,
      stateDir: fx.stateDir,
      workspaceDir: fx.workspaceDir,
      telegramApi: api,
      logger: fx.loggerState.logger,
    })
    await seedOutboxFile(fx.stateDir, groupChat, `${Date.now()}-w3.json`, {
      chat_id: groupChat,
      timestamp: '2026-08-30T00:00:00Z',
      ...payload,
    })
    await router.start()
    await new Promise((r) => setTimeout(r, 600))
    await router.stop()
  }

  test('a table with format=auto goes rich — and NOT through sendMessage', async () => {
    const spy = spyRichApi(async () => ({ message_id: 77 }))
    await drain(spy.api, { text: `итог:\n\n${TABLE}`, format: 'auto' })
    expect(spy.richSends.length).toBe(1)
    expect(spy.sends.length).toBe(0)
  }, 5_000)

  test('ordinary group prose stays on the HTML path', async () => {
    const spy = spyRichApi(async () => ({ message_id: 77 }))
    await drain(spy.api, { text: 'обычный ответ в группу', format: 'auto' })
    expect(spy.richSends.length).toBe(0)
    expect(spy.sends.length).toBe(1)
  }, 5_000)

  test('format=html with a table NEVER goes rich — the writer owns the shape', async () => {
    const spy = spyRichApi(async () => ({ message_id: 77 }))
    await drain(spy.api, { text: TABLE, format: 'html' })
    expect(spy.richSends.length).toBe(0)
    expect(spy.sends.length).toBe(1)
  }, 5_000)

  test('rich fallback → exactly ONE chunked HTML send, no duplicate', async () => {
    const spy = spyRichApi(async () => ({ fallback: true }))
    await drain(spy.api, { text: `итог:\n\n${TABLE}`, format: 'auto' })
    expect(spy.richSends.length).toBe(1)
    expect(spy.sends.length).toBe(1)
  }, 5_000)

  test('CJK trips the shield — message still ships, via HTML', async () => {
    const spy = spyRichApi(async () => ({ message_id: 77 }))
    await drain(spy.api, { text: `${TABLE}\n\n\u3053\u3093\u306b\u3061\u306f`, format: 'auto' })
    expect(spy.richSends.length).toBe(0)
    expect(spy.sends.length).toBe(1)
  }, 5_000)

  test('math inside details trips the shield — message still ships, via HTML', async () => {
    const spy = spyRichApi(async () => ({ message_id: 77 }))
    await drain(spy.api, { text: `${TABLE}\n\n<details>$$x^2$$</details>`, format: 'auto' })
    expect(spy.richSends.length).toBe(0)
    expect(spy.sends.length).toBe(1)
  }, 5_000)

  test('an api without sendRichMessage behaves exactly as before', async () => {
    const spy = spyRichApi(async () => ({ message_id: 77 }))
    delete (spy.api as { sendRichMessage?: unknown }).sendRichMessage
    await drain(spy.api, { text: `итог:\n\n${TABLE}`, format: 'auto' })
    expect(spy.richSends.length).toBe(0)
    expect(spy.sends.length).toBe(1)
  }, 5_000)
})
