// FIX-F tests (2026-05-27) — Opus router #14: OutboxMessage format
// regression after PR #22.
//
// Bug: OutboxMessage lacked a `format` / `parse_mode` field. When the
// tmux-side reply tool wrote a payload containing `<b>...</b>` HTML or
// markdown, the router called bot.api.sendMessage WITHOUT parse_mode,
// so Telegram delivered HTML/Markdown markers as literal text.
//
// Fix:
//   1. OutboxMessageSchema (Zod, in inbox-bridge.ts) gains a
//      `format: 'html'|'markdown'|'text'` field with default 'html'.
//   2. pollOutboxOnce uses Zod parsing instead of an unchecked
//      `as OutboxMessage` cast — corrupt files dead-letter cleanly.
//   3. multichat-router.deliverClaim maps `format` to `parse_mode`:
//        'html'      → parse_mode='HTML'
//        'markdown'  → parse_mode='MarkdownV2'
//        'text'      → parse_mode omitted
//
// Tests below cover:
//   * Schema: explicit format values parse and round-trip; missing
//     format applies the default 'html'; invalid format rejects.
//   * End-to-end (router + outbox loop):
//       - `<b>bold</b>` payload with format='html' →
//         sendMessage(text, {parse_mode:'HTML'}).
//       - `*bold*` payload with format='markdown' →
//         sendMessage(text, {parse_mode:'MarkdownV2'}).
//       - plain payload with format='text' → sendMessage(text, {})
//         (no parse_mode key).
//       - Payload omitting `format` entirely → router applies the
//         schema default 'html' → parse_mode='HTML' (the regression
//         fix).
//       - Invalid format string ('rich') → file dead-lettered, never
//         delivered, sidecar `.fail.json` carries the parse error.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
import {
  OutboxMessageSchema,
  type OutboxMessage,
} from '../../src/router/inbox-bridge.js'

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

function makeRouter(fx: Fixture, policy: MultichatPolicy): MultichatRouter {
  return new MultichatRouter({
    policy,
    pool: fx.pool as unknown as TmuxSessionPool,
    stateDir: fx.stateDir,
    workspaceDir: fx.workspaceDir,
    telegramApi: fx.telegram.api,
    logger: fx.loggerState.logger,
  })
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
// Schema tests — OutboxMessageSchema
// ──────────────────────────────────────────────────────────────────────

describe('OutboxMessageSchema (FIX-F)', () => {
  test('format=html parses and round-trips', () => {
    const parsed = OutboxMessageSchema.parse({
      text: '<b>bold</b>',
      chat_id: '164795011',
      timestamp: '2026-05-27T00:00:00Z',
      format: 'html',
    })
    expect(parsed.format).toBe('html')
    expect(parsed.text).toBe('<b>bold</b>')
  })

  test('format=markdown parses', () => {
    const parsed = OutboxMessageSchema.parse({
      text: '*bold*',
      chat_id: '164795011',
      timestamp: '2026-05-27T00:00:00Z',
      format: 'markdown',
    })
    expect(parsed.format).toBe('markdown')
  })

  test('format=text parses', () => {
    const parsed = OutboxMessageSchema.parse({
      text: 'plain text',
      chat_id: '164795011',
      timestamp: '2026-05-27T00:00:00Z',
      format: 'text',
    })
    expect(parsed.format).toBe('text')
  })

  test('missing format → default html applied', () => {
    const parsed = OutboxMessageSchema.parse({
      text: 'no format key',
      chat_id: '164795011',
      timestamp: '2026-05-27T00:00:00Z',
    })
    // Default keeps the regression fix safe: a writer that forgets
    // to set format gets HTML rendering instead of silent literal-
    // text fallback (the pre-fix behaviour).
    expect(parsed.format).toBe('html')
  })

  test('format=rich (invalid enum) → ZodError', () => {
    const result = OutboxMessageSchema.safeParse({
      text: 'x',
      chat_id: '164795011',
      timestamp: '2026-05-27T00:00:00Z',
      format: 'rich',
    })
    expect(result.success).toBe(false)
    // The downstream pollOutboxOnce wraps this into a parse_failed
    // dead-letter reason — see the e2e test below.
  })

  test('format=undefined explicit → still default html', () => {
    // A writer who writes `{format: undefined}` literally (i.e.
    // JSON.stringify drops the key) lands in the same default path.
    const parsed = OutboxMessageSchema.parse({
      text: 'x',
      chat_id: '164795011',
      timestamp: '2026-05-27T00:00:00Z',
      format: undefined,
    })
    expect(parsed.format).toBe('html')
  })

  test('OutboxMessage type compiles with required format field', () => {
    // Compile-time check: TypeScript would fail this block if the
    // inferred type still treated `format` as optional missing
    // (the Zod `.default(...)` makes the OUTPUT type non-optional).
    const msg: OutboxMessage = {
      text: 'x',
      chat_id: '1',
      timestamp: 't',
      format: 'html',
    }
    expect(msg.format).toBe('html')
  })
})

// ──────────────────────────────────────────────────────────────────────
// End-to-end tests — router drains seeded outbox, sendMessage called
// with the correct parse_mode (or omitted).
// ──────────────────────────────────────────────────────────────────────

describe('deliverClaim format → parse_mode mapping (FIX-F)', () => {
  let fx: Fixture
  const ownerChat = '164795011'

  beforeEach(() => {
    fx = setupFixture()
  })
  afterEach(() => {
    cleanupFixture(fx)
  })

  function policyForOwner(): MultichatPolicy {
    return makePolicy({
      chats: { [ownerChat]: makeChatPolicy() },
      allowlist_users: [ownerChat],
    })
  }

  test('format=html → sendMessage with parse_mode=HTML', async () => {
    const router = makeRouter(fx, policyForOwner())
    await seedOutboxFile(fx.stateDir, ownerChat, `${Date.now()}-aaaa.json`, {
      text: '<b>bold</b>',
      chat_id: ownerChat,
      timestamp: '2026-05-27T00:00:00Z',
      format: 'html',
    })

    await router.start()
    // Two poll intervals (200ms each) + jitter.
    await new Promise((r) => setTimeout(r, 600))
    await router.stop()

    expect(fx.telegram.calls.length).toBe(1)
    expect(fx.telegram.calls[0]?.text).toBe('<b>bold</b>')
    expect(fx.telegram.calls[0]?.opts.parse_mode).toBe('HTML')
  }, 5_000)

  test('format=markdown → sendMessage with parse_mode=MarkdownV2', async () => {
    const router = makeRouter(fx, policyForOwner())
    await seedOutboxFile(fx.stateDir, ownerChat, `${Date.now()}-bbbb.json`, {
      text: '*bold*',
      chat_id: ownerChat,
      timestamp: '2026-05-27T00:00:00Z',
      format: 'markdown',
    })

    await router.start()
    await new Promise((r) => setTimeout(r, 600))
    await router.stop()

    expect(fx.telegram.calls.length).toBe(1)
    expect(fx.telegram.calls[0]?.text).toBe('*bold*')
    expect(fx.telegram.calls[0]?.opts.parse_mode).toBe('MarkdownV2')
  }, 5_000)

  test('format=text → sendMessage WITHOUT parse_mode key', async () => {
    const router = makeRouter(fx, policyForOwner())
    await seedOutboxFile(fx.stateDir, ownerChat, `${Date.now()}-cccc.json`, {
      text: '<b>literal angle brackets</b>',
      chat_id: ownerChat,
      timestamp: '2026-05-27T00:00:00Z',
      format: 'text',
    })

    await router.start()
    await new Promise((r) => setTimeout(r, 600))
    await router.stop()

    expect(fx.telegram.calls.length).toBe(1)
    expect(fx.telegram.calls[0]?.text).toBe('<b>literal angle brackets</b>')
    // Contract: 'text' format MUST NOT set parse_mode at all — Telegram
    // would otherwise try to parse the angle brackets as an HTML tag.
    // We check the key is ABSENT, not just undefined, so a future
    // refactor cannot regress to `parse_mode: undefined` and look ok.
    expect('parse_mode' in fx.telegram.calls[0]!.opts).toBe(false)
  }, 5_000)

  test('format omitted → default html → parse_mode=HTML (regression fix)', async () => {
    // This is the EXACT regression the FIX-F closes: pre-fix, a
    // payload without `format` got no parse_mode and Telegram rendered
    // `<b>bold</b>` as literal text. With the Zod default and the
    // mapping, the same payload now renders bold.
    const router = makeRouter(fx, policyForOwner())
    await seedOutboxFile(fx.stateDir, ownerChat, `${Date.now()}-dddd.json`, {
      text: '<b>bold</b>',
      chat_id: ownerChat,
      timestamp: '2026-05-27T00:00:00Z',
      // Intentionally NO `format` field.
    })

    await router.start()
    await new Promise((r) => setTimeout(r, 600))
    await router.stop()

    expect(fx.telegram.calls.length).toBe(1)
    expect(fx.telegram.calls[0]?.text).toBe('<b>bold</b>')
    expect(fx.telegram.calls[0]?.opts.parse_mode).toBe('HTML')
  }, 5_000)

  test('invalid format → file dead-lettered, sendMessage never called', async () => {
    const router = makeRouter(fx, policyForOwner())
    const filename = `${Date.now()}-eeee.json`
    await seedOutboxFile(fx.stateDir, ownerChat, filename, {
      text: 'x',
      chat_id: ownerChat,
      timestamp: '2026-05-27T00:00:00Z',
      format: 'rich', // not in enum
    })

    await router.start()
    await new Promise((r) => setTimeout(r, 600))
    await router.stop()

    // Telegram untouched.
    expect(fx.telegram.calls.length).toBe(0)

    // File moved to dead-letter (timestamp prefix in front of the
    // original name). Confirm presence + sidecar with parse error.
    const deadLetterDir = join(
      fx.stateDir,
      'chats',
      ownerChat,
      'outbox',
      'dead-letter',
    )
    expect(existsSync(deadLetterDir)).toBe(true)
    const entries = readdirSync(deadLetterDir)
    const payloadFile = entries.find(
      (n) => n.endsWith('.json') && !n.endsWith('.fail.json'),
    )
    const sidecar = entries.find((n) => n.endsWith('.fail.json'))
    expect(payloadFile).toBeDefined()
    expect(sidecar).toBeDefined()

    const sidecarRaw = readFileSync(join(deadLetterDir, sidecar as string), 'utf8')
    const sidecarMeta = JSON.parse(sidecarRaw) as Record<string, unknown>
    // pollOutboxOnce prefixes the reason with `parse_failed:` when
    // either JSON.parse or Zod throws.
    expect(typeof sidecarMeta.reason).toBe('string')
    expect((sidecarMeta.reason as string).startsWith('parse_failed:')).toBe(
      true,
    )
  }, 5_000)
})

// ──────────────────────────────────────────────────────────────────────
// reply_to is independent of format — combined opts must include both
// reply_to_message_id and parse_mode when both signals are present.
// ──────────────────────────────────────────────────────────────────────

describe('deliverClaim combined reply_to + format (FIX-F)', () => {
  let fx: Fixture
  const ownerChat = '164795011'

  beforeEach(() => {
    fx = setupFixture()
  })
  afterEach(() => {
    cleanupFixture(fx)
  })

  test('reply_to=42 + format=html → both keys present', async () => {
    const policy = makePolicy({
      chats: { [ownerChat]: makeChatPolicy() },
      allowlist_users: [ownerChat],
    })
    const router = makeRouter(fx, policy)
    await seedOutboxFile(fx.stateDir, ownerChat, `${Date.now()}-ffff.json`, {
      text: '<b>quoted reply</b>',
      chat_id: ownerChat,
      reply_to: '42',
      timestamp: '2026-05-27T00:00:00Z',
      format: 'html',
    })

    await router.start()
    await new Promise((r) => setTimeout(r, 600))
    await router.stop()

    expect(fx.telegram.calls.length).toBe(1)
    expect(fx.telegram.calls[0]?.opts.parse_mode).toBe('HTML')
    expect(fx.telegram.calls[0]?.opts.reply_to_message_id).toBe(42)
  }, 5_000)
})
