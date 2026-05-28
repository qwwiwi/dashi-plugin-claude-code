// FIX-E tests (2026-05-27) — three MAJORs closed in the Phase 5 fix
// loop:
//
//   M1 (Codex router #4)  — getOrSpawn duplicate-spawn race when an
//                            existing handle is stale and two callers
//                            both pass through the isAlive await.
//   M2 (Codex router #5
//      + Opus #18)         — kill() preserves outbox/dead-letter/ and
//                            outbox/mismatched/ instead of recursively
//                            wiping the entire outbox subtree.
//   M3 (Codex router #6)   — max_queue_depth must hold under concurrent
//                            dispatch() calls for the same chat —
//                            per-chat dispatch mutex.
//
// We use minimal in-memory fakes (no real tmux, no real Telegram) so
// the assertions stay focused on the FIX-E behaviour. The shared
// helpers in multichat-router.gate.test.ts already cover the broader
// dispatch flow.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
import {
  TmuxSessionPool,
  type PoolLogger,
  type SessionHandle,
} from '../../src/router/tmux-session-pool.js'

// ──────────────────────────────────────────────────────────────────────
// Shared helpers
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

function capturingPoolLogger(): { logger: PoolLogger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = []
  const push = (level: CapturedLog['level']) =>
    (msg: string, ctx?: object): void => {
      logs.push({ level, msg, ctx: ctx as Record<string, unknown> | undefined })
    }
  return {
    logs,
    logger: {
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

// ──────────────────────────────────────────────────────────────────────
// M1 — getOrSpawn duplicate-spawn race (Codex router #4)
// ──────────────────────────────────────────────────────────────────────
//
// Strategy: subclass TmuxSessionPool to override isAlive (delay +
// return false) and spawnInternal (count calls + resolve to a stable
// handle). Fire two getOrSpawn() calls in parallel; assert
// spawnInternal ran EXACTLY ONCE.

describe('FIX-E M1 — getOrSpawn duplicate-spawn race', () => {
  let tmpDir: string
  let stateDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fix-e-m1-'))
    stateDir = join(tmpDir, 'state')
    mkdirSync(stateDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  // Helper to build a pool whose isAlive returns false after a delay
  // and whose spawnInternal counts calls. We assign in the
  // constructor body via prototype patching — class-level field
  // assignment to `this` outside the constructor is a TS-only
  // syntactic illusion that bun's parser rejects.
  function makeRacingPool(opts: {
    chatId: string
    isAliveDelayMs: number
    spawnDelayMs: number
    handle: SessionHandle
    onSpawn: () => void
  }): TmuxSessionPool {
    const policy = makePolicy({
      chats: { [opts.chatId]: makeChatPolicy() },
      allowlist_users: [opts.chatId],
    })
    const { logger } = capturingPoolLogger()
    const pool = new TmuxSessionPool({
      policy,
      stateDir,
      workspaceDir: join(tmpDir, 'ws'),
      chatsBasePath: join(tmpDir, 'ws', 'chats'),
      claudeBinary: 'claude',
      logger,
    })
    // Override isAlive with a delayed false (race window).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(pool as any).isAlive = async (_sessionName: string): Promise<boolean> => {
      await new Promise((r) => setTimeout(r, opts.isAliveDelayMs))
      return false
    }
    // Override spawnInternal with a counter + delayed resolve.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(pool as any).spawnInternal = async (): Promise<SessionHandle> => {
      opts.onSpawn()
      await new Promise((r) => setTimeout(r, opts.spawnDelayMs))
      return opts.handle
    }
    // Seed a stale handle so the existing.isAlive branch is taken.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(pool as any).sessions.set(opts.chatId, {
      chatId: opts.chatId,
      sessionName: opts.handle.sessionName,
      spawnedAt: 0,
      lastMessageAt: 0,
    } satisfies SessionHandle)
    return pool
  }

  test('parallel callers + stale isAlive → spawnInternal runs exactly once', async () => {
    let spawnCount = 0
    const fakeSpawnHandle: SessionHandle = {
      chatId: '99999',
      sessionName: 'multichat-99999',
      spawnedAt: Date.now(),
      lastMessageAt: Date.now(),
    }
    const pool = makeRacingPool({
      chatId: '99999',
      isAliveDelayMs: 50,
      spawnDelayMs: 20,
      handle: fakeSpawnHandle,
      onSpawn: () => {
        spawnCount += 1
      },
    })

    // Fire two getOrSpawn calls in parallel WITHOUT awaiting between
    // them — both must land in the same JS tick to exercise the race.
    const [h1, h2] = await Promise.all([
      pool.getOrSpawn('99999'),
      pool.getOrSpawn('99999'),
    ])

    expect(spawnCount).toBe(1)
    // Both callers should observe the same handle (joined the same
    // pending promise).
    expect(h1).toBe(h2)
    expect(h1.sessionName).toBe('multichat-99999')
  }, 5_000)

  test('three parallel callers with delayed isAlive false → one spawn', async () => {
    let spawnCount = 0
    const handle: SessionHandle = {
      chatId: '12345',
      sessionName: 'multichat-12345',
      spawnedAt: Date.now(),
      lastMessageAt: Date.now(),
    }
    const pool = makeRacingPool({
      chatId: '12345',
      isAliveDelayMs: 30,
      spawnDelayMs: 10,
      handle,
      onSpawn: () => {
        spawnCount += 1
      },
    })

    const results = await Promise.all([
      pool.getOrSpawn('12345'),
      pool.getOrSpawn('12345'),
      pool.getOrSpawn('12345'),
    ])
    expect(spawnCount).toBe(1)
    // All three callers share the same handle.
    expect(results[0]).toBe(results[1])
    expect(results[1]).toBe(results[2])
  }, 5_000)
})

// ──────────────────────────────────────────────────────────────────────
// M2 — kill() preserves dead-letter + mismatched (Codex router #5 + Opus #18)
// ──────────────────────────────────────────────────────────────────────
//
// We construct the per-chat state dir layout manually, seed files in
// dead-letter and mismatched, then invoke pool.kill(chatId). The
// quarantine files must still exist; the inbox / outbox-root /
// processing files must be gone.
//
// We monkey-patch `runTmux` indirectly by giving the pool a chatId
// it has a SessionHandle for in memory, so kill() reaches the
// scrubVolatileQueueState path. We do NOT need real tmux — kill()
// catches the tmux error and continues to the FS cleanup.

describe('FIX-E M2 — kill() preserves dead-letter + mismatched', () => {
  let tmpDir: string
  let stateDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fix-e-m2-'))
    stateDir = join(tmpDir, 'state')
    mkdirSync(stateDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  function seedChatState(chatId: string): {
    inboxFile: string
    outboxRootFile: string
    processingFile: string
    deadLetterFile: string
    deadLetterSidecar: string
    mismatchedFile: string
    mismatchedSidecar: string
    albumFile: string
  } {
    const chatDir = join(stateDir, 'chats', chatId)
    const inboxDir = join(chatDir, 'inbox')
    const outboxDir = join(chatDir, 'outbox')
    const processingDir = join(outboxDir, 'processing')
    const deadLetterDir = join(outboxDir, 'dead-letter')
    const mismatchedDir = join(outboxDir, 'mismatched')
    const albumsDir = join(chatDir, 'albums')

    for (const dir of [
      inboxDir,
      outboxDir,
      processingDir,
      deadLetterDir,
      mismatchedDir,
      albumsDir,
    ]) {
      mkdirSync(dir, { recursive: true })
    }

    const inboxFile = join(inboxDir, '1748340000000-aaaa.json')
    const outboxRootFile = join(outboxDir, '1748340000001-bbbb.json')
    const processingFile = join(processingDir, '1748340000002-cccc.json')
    const deadLetterFile = join(deadLetterDir, '1748340000003-dead.json')
    const deadLetterSidecar = `${deadLetterFile}.fail.json`
    const mismatchedFile = join(mismatchedDir, '1748340000004-mis.json')
    const mismatchedSidecar = `${mismatchedFile}.mismatch.json`
    const albumFile = join(albumsDir, 'album-1.json')

    writeFileSync(inboxFile, '{"text":"i"}')
    writeFileSync(outboxRootFile, '{"text":"o"}')
    writeFileSync(processingFile, '{"text":"p"}')
    writeFileSync(deadLetterFile, '{"text":"dead"}')
    writeFileSync(deadLetterSidecar, '{"reason":"send_failed"}')
    writeFileSync(mismatchedFile, '{"text":"mis"}')
    writeFileSync(
      mismatchedSidecar,
      '{"expectedChatId":"x","actualChatId":"y"}',
    )
    writeFileSync(albumFile, '{"album":"data"}')

    return {
      inboxFile,
      outboxRootFile,
      processingFile,
      deadLetterFile,
      deadLetterSidecar,
      mismatchedFile,
      mismatchedSidecar,
      albumFile,
    }
  }

  test('kill() removes inbox + outbox-root + processing, preserves dead-letter + mismatched + albums', async () => {
    const chatId = '77777'
    const policy = makePolicy({
      chats: { [chatId]: makeChatPolicy() },
      allowlist_users: [chatId],
    })
    const { logger, logs } = capturingPoolLogger()

    const pool = new TmuxSessionPool({
      policy,
      stateDir,
      workspaceDir: join(tmpDir, 'ws'),
      chatsBasePath: join(tmpDir, 'ws', 'chats'),
      claudeBinary: 'claude',
      logger,
    })

    // Seed a SessionHandle so kill() proceeds past the early return.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(pool as any).sessions.set(chatId, {
      chatId,
      sessionName: `multichat-${chatId}`,
      spawnedAt: Date.now(),
      lastMessageAt: Date.now(),
    } satisfies SessionHandle)

    const seeded = seedChatState(chatId)

    await pool.kill(chatId)

    // Volatile state — must be GONE.
    expect(existsSync(seeded.inboxFile)).toBe(false)
    expect(existsSync(seeded.outboxRootFile)).toBe(false)
    expect(existsSync(seeded.processingFile)).toBe(false)

    // Operator-facing state — must be PRESERVED.
    expect(existsSync(seeded.deadLetterFile)).toBe(true)
    expect(existsSync(seeded.deadLetterSidecar)).toBe(true)
    expect(existsSync(seeded.mismatchedFile)).toBe(true)
    expect(existsSync(seeded.mismatchedSidecar)).toBe(true)
    expect(existsSync(seeded.albumFile)).toBe(true)

    // Quarantine directories themselves must still exist (so future
    // writes don't have to recreate them).
    const outboxDir = join(stateDir, 'chats', chatId, 'outbox')
    expect(existsSync(join(outboxDir, 'dead-letter'))).toBe(true)
    expect(existsSync(join(outboxDir, 'mismatched'))).toBe(true)
    expect(existsSync(join(stateDir, 'chats', chatId, 'albums'))).toBe(true)

    // Each uncommitted processing claim got logged as warn before
    // removal so the operator sees what was lost on idle-kill.
    const processingWarns = logs.filter((l) =>
      l.msg.includes('uncommitted outbox claim'),
    )
    expect(processingWarns.length).toBeGreaterThanOrEqual(1)
  })

  test('kill() with no inbox/outbox dirs is a no-op (no throw)', async () => {
    const chatId = '88888'
    const policy = makePolicy({
      chats: { [chatId]: makeChatPolicy() },
      allowlist_users: [chatId],
    })
    const { logger } = capturingPoolLogger()
    const pool = new TmuxSessionPool({
      policy,
      stateDir,
      workspaceDir: join(tmpDir, 'ws'),
      chatsBasePath: join(tmpDir, 'ws', 'chats'),
      claudeBinary: 'claude',
      logger,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(pool as any).sessions.set(chatId, {
      chatId,
      sessionName: `multichat-${chatId}`,
      spawnedAt: Date.now(),
      lastMessageAt: Date.now(),
    } satisfies SessionHandle)

    await expect(pool.kill(chatId)).resolves.toBeUndefined()
  })

  test('kill() preserves dead-letter sidecar JSON content (no truncation)', async () => {
    const chatId = '66666'
    const policy = makePolicy({
      chats: { [chatId]: makeChatPolicy() },
      allowlist_users: [chatId],
    })
    const { logger } = capturingPoolLogger()
    const pool = new TmuxSessionPool({
      policy,
      stateDir,
      workspaceDir: join(tmpDir, 'ws'),
      chatsBasePath: join(tmpDir, 'ws', 'chats'),
      claudeBinary: 'claude',
      logger,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(pool as any).sessions.set(chatId, {
      chatId,
      sessionName: `multichat-${chatId}`,
      spawnedAt: Date.now(),
      lastMessageAt: Date.now(),
    } satisfies SessionHandle)

    const seeded = seedChatState(chatId)
    await pool.kill(chatId)

    // Sidecar content unchanged.
    const fs = await import('node:fs')
    const dl = fs.readFileSync(seeded.deadLetterSidecar, 'utf8')
    expect(dl).toBe('{"reason":"send_failed"}')
    const mis = fs.readFileSync(seeded.mismatchedSidecar, 'utf8')
    expect(mis).toBe('{"expectedChatId":"x","actualChatId":"y"}')
  })
})

// ──────────────────────────────────────────────────────────────────────
// M3 — concurrent dispatch + max_queue_depth (Codex router #6)
// ──────────────────────────────────────────────────────────────────────
//
// Fire N concurrent dispatch() calls for the same chat with
// max_queue_depth=1. After all settle, the inbox must contain AT MOST
// `max_queue_depth` (1) committed `.json` file. Pre-fix the cap-check
// readdir + writeToInbox were not serialised, so the inbox could
// accumulate `N` files.

describe('FIX-E M3 — dispatch concurrent + max_queue_depth', () => {
  let tmpDir: string
  let stateDir: string
  let workspaceDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fix-e-m3-'))
    stateDir = join(tmpDir, 'state')
    workspaceDir = join(tmpDir, 'workspace')
    mkdirSync(stateDir, { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  // Minimal pool fake — getOrSpawn is a no-op so the test focuses on
  // the router's dispatch serialisation rather than tmux behaviour.
  class FakePool {
    spawned: string[] = []
    touched: string[] = []
    async loadSessions(): Promise<void> {}
    startWatchdog(): void {}
    stopWatchdog(): void {}
    async getOrSpawn(chatId: string): Promise<SessionHandle> {
      this.spawned.push(chatId)
      return {
        chatId,
        sessionName: `multichat-${chatId}`,
        spawnedAt: Date.now(),
        lastMessageAt: Date.now(),
      }
    }
    touch(chatId: string): void {
      this.touched.push(chatId)
    }
    async kill(_chatId: string): Promise<void> {}
  }

  function nopTelegram(): MultichatTelegramApi {
    return {
      sendMessage: async () =>
        ({ ok: true, result: { message_id: 1 } }) as unknown as Awaited<
          ReturnType<MultichatTelegramApi['sendMessage']>
        >,
      sendChatAction: async () => {},
    }
  }

  test('5 concurrent dispatches with max_queue_depth=1 → at most 1 inbox file', async () => {
    const chatId = '164795011'
    const policy = makePolicy({
      chats: { [chatId]: makeChatPolicy({ max_queue_depth: 1 }) },
      allowlist_users: [chatId],
      allowlist_chats: [chatId],
    })
    const pool = new FakePool()
    const { logger } = capturingLogger()

    const router = new MultichatRouter({
      policy,
      pool: pool as unknown as TmuxSessionPool,
      stateDir,
      workspaceDir,
      telegramApi: nopTelegram(),
      logger,
    })

    // Fire 5 dispatch calls in the same tick. WITHOUT the FIX-E M3
    // mutex these all readdir() in parallel, see 0 files, all
    // writeToInbox → 5 committed files. WITH the mutex they
    // serialise: dispatch 1 writes file A; dispatch 2 sees A, drops
    // A, writes B; … final state has 1 file.
    const tasks: Promise<void>[] = []
    for (let i = 0; i < 5; i += 1) {
      tasks.push(
        router.dispatch({
          text: `msg-${i}`,
          chat_id: chatId,
          user_id: chatId,
          user: 'dashi',
          timestamp: `2026-05-27T00:00:0${i}Z`,
        }),
      )
    }
    await Promise.all(tasks)

    const inboxDir = join(stateDir, 'chats', chatId, 'inbox')
    const committed = readdirSync(inboxDir).filter((n) =>
      n.endsWith('.json'),
    )
    // At most max_queue_depth (1) files survive.
    expect(committed.length).toBeLessThanOrEqual(1)
  })

  test('10 concurrent dispatches with max_queue_depth=3 → at most 3 inbox files', async () => {
    const chatId = '-1003784643974'
    const policy = makePolicy({
      chats: {
        [chatId]: makeChatPolicy({ max_queue_depth: 3, mode: 'public' }),
      },
      allowlist_users: ['164795011'],
      allowlist_chats: [chatId],
    })
    const pool = new FakePool()
    const { logger } = capturingLogger()

    const router = new MultichatRouter({
      policy,
      pool: pool as unknown as TmuxSessionPool,
      stateDir,
      workspaceDir,
      telegramApi: nopTelegram(),
      logger,
    })

    const tasks: Promise<void>[] = []
    for (let i = 0; i < 10; i += 1) {
      tasks.push(
        router.dispatch({
          text: `msg-${i}`,
          chat_id: chatId,
          user_id: '164795011',
          user: 'dashi',
          timestamp: `2026-05-27T00:00:${String(i).padStart(2, '0')}Z`,
        }),
      )
    }
    await Promise.all(tasks)

    const inboxDir = join(stateDir, 'chats', chatId, 'inbox')
    const committed = readdirSync(inboxDir).filter((n) =>
      n.endsWith('.json'),
    )
    expect(committed.length).toBeLessThanOrEqual(3)
  })

  test('serial dispatches do not block one another (mutex releases)', async () => {
    // Regression guard: the mutex must not wedge — sequential
    // dispatch calls should each complete promptly.
    const chatId = '11111'
    const policy = makePolicy({
      chats: { [chatId]: makeChatPolicy() },
      allowlist_users: [chatId],
      allowlist_chats: [chatId],
    })
    const pool = new FakePool()
    const { logger } = capturingLogger()
    const router = new MultichatRouter({
      policy,
      pool: pool as unknown as TmuxSessionPool,
      stateDir,
      workspaceDir,
      telegramApi: nopTelegram(),
      logger,
    })

    for (let i = 0; i < 3; i += 1) {
      await router.dispatch({
        text: `serial-${i}`,
        chat_id: chatId,
        user_id: chatId,
        user: 'dashi',
        timestamp: `2026-05-27T00:00:0${i}Z`,
      })
    }

    // Three sequential calls + max_queue_depth=1 → exactly 1 file.
    const inboxDir = join(stateDir, 'chats', chatId, 'inbox')
    const committed = readdirSync(inboxDir).filter((n) =>
      n.endsWith('.json'),
    )
    expect(committed.length).toBe(1)
    // FIX-E self-cleanup: dispatchLocks should be drained for this
    // chat after all calls settle (test only checks reachability
    // via reflection).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const locks = (router as any).dispatchLocks as Map<string, unknown>
    // Either the entry is gone OR the stored value has already
    // resolved (we can't easily await a Map value here, but the
    // self-clean is a finally so by this point it should be cleared).
    expect(locks.has(chatId)).toBe(false)
  })
})
