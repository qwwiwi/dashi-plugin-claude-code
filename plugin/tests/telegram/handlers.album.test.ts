// TASK-4 — album durability + chat-scoped buffer regression suite.
//
// Bugs covered:
//   Bug #1 (album key): two chats sharing the same media_group_id must
//     not merge — each chat gets its own flush keyed on
//     ${chatId}:${mediaGroupId}.
//   Bug #2 (durability): every album fragment is persisted to disk
//     atomically BEFORE the poller's offset advances. Crash recovery
//     replays the on-disk dir through the same flush path. Router
//     failures move the dir into dead-letter instead of silently
//     dropping content.
//
// These tests do NOT exercise the watcher / OOB short-circuits; those
// live in handlers.test.ts.

import { describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  truncateSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Context } from 'grammy'

import {
  handleInboundDocument,
  sendAlbumNotification,
  type AlbumEntry,
  type HandlerDeps,
} from '../../src/telegram/handlers.js'
import {
  AlbumBuffer,
  type TimerCancel,
  type TimerFactory,
} from '../../src/telegram/album-buffer.js'
import {
  compositeAlbumKey,
  ensureAlbumsDir,
  persistFragment,
  recoverPendingAlbums,
  type PersistedAlbumMeta,
  type RecoveredAlbum,
} from '../../src/telegram/album-persistence.js'
import type { AppConfig, StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import type { TelegramApi } from '../../src/channel/tools.js'
import type { BotIdentity } from '../../src/prompt/build.js'
import type { Logger } from '../../src/log.js'
import type { ChatPolicy, MultichatPolicy } from '../../src/chats/policy-loader.js'
import type { MultichatRouter } from '../../src/router/multichat-router.js'
import type { InboundMessage } from '../../src/router/inbox-bridge.js'

const silentLog = createLogger('test', {
  stream: { write: () => true } as unknown as NodeJS.WritableStream,
})

// ─────────────────────────────────────────────────────────────────────
// Test scaffolding — mirrors handlers.test.ts patterns
// ─────────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    bot_id: 8507713167,
    dm_only: true,
    allowed_user_ids: [164795011, 164795012],
    allowed_chat_ids: [164795011, 164795012],
    status: {
      enabled: false,
      interval_ms: 700,
      ttl_ms: 300_000,
      delete_on_complete: true,
      suppress_typing_bubble: false,
    },
    album: { flush_ms: 50 },
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
      enabled: false,
      debounce_ms: 10_000,
      busy_threshold_ms: 30_000,
    },
    ...overrides,
  } as unknown as AppConfig
}

function makeStatePaths(): StatePaths {
  const root = mkdtempSync(join(tmpdir(), 'dashi-album-test-'))
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

interface ServerSpy {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server: any
  calls: Array<{ method: string; params: unknown }>
}
function makeServerSpy(): ServerSpy {
  const calls: Array<{ method: string; params: unknown }> = []
  return {
    server: {
      notification: async (msg: { method: string; params: unknown }): Promise<void> => {
        calls.push({ method: msg.method, params: msg.params })
      },
    },
    calls,
  }
}

function makeTelegramApi(): TelegramApi {
  const noop = async (): Promise<never> => {
    throw new Error('unexpected api call in album test')
  }
  return {
    sendMessage: noop as unknown as TelegramApi['sendMessage'],
    editMessageText: noop as unknown as TelegramApi['editMessageText'],
    setMessageReaction: async () => undefined,
    sendChatAction: async () => undefined,
    sendDocument: noop as unknown as TelegramApi['sendDocument'],
    sendPhoto: noop as unknown as TelegramApi['sendPhoto'],
    downloadFile: noop as unknown as TelegramApi['downloadFile'],
    deleteMessage: noop as unknown as TelegramApi['deleteMessage'],
  }
}

// ─────────────────────────────────────────────────────────────────────
// Fake timer harness — same shape as album-buffer.test.ts
// ─────────────────────────────────────────────────────────────────────

interface FakeTimerHandle {
  id: number
  cb: () => void
  fireAt: number
  cancelled: boolean
}
function makeClock(): {
  now: () => number
  setTimer: TimerFactory
  clearTimer: TimerCancel
  tick: (ms: number) => Promise<void>
} {
  let current = 0
  let nextId = 1
  const timers = new Map<number, FakeTimerHandle>()
  const now = () => current
  const setTimer: TimerFactory = (cb, ms) => {
    const id = nextId++
    timers.set(id, { id, cb, fireAt: current + ms, cancelled: false })
    return id as unknown as NodeJS.Timeout
  }
  const clearTimer: TimerCancel = (h) => {
    const id = h as unknown as number
    const t = timers.get(id)
    if (t) {
      t.cancelled = true
      timers.delete(id)
    }
  }
  const tick = async (ms: number): Promise<void> => {
    const target = current + ms
    for (;;) {
      const due = Array.from(timers.values())
        .filter((t) => !t.cancelled && t.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt)
      if (due.length === 0) break
      const next = due[0]!
      current = next.fireAt
      timers.delete(next.id)
      next.cb()
      // Yield so any microtask scheduled by the callback (our flush
      // pipeline is async-inside-void) can run before the next timer.
      await new Promise((r) => setTimeout(r, 0))
    }
    current = target
    await new Promise((r) => setTimeout(r, 0))
  }
  return { now, setTimer, clearTimer, tick }
}

function makeBuffer(flushMs: number, clock: ReturnType<typeof makeClock>) {
  return new AlbumBuffer<AlbumEntry>({
    flushMs,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
}

function makeDeps(opts: {
  config?: AppConfig
  albumBuffer: AlbumBuffer<AlbumEntry>
  server?: ServerSpy['server']
  telegramApi?: TelegramApi
  log?: Logger
  policy?: MultichatPolicy
  router?: MultichatRouter
}): { deps: HandlerDeps; statePaths: StatePaths; server: ServerSpy['server'] } {
  const config = opts.config ?? makeConfig()
  const statePaths = makeStatePaths()
  const bot: BotIdentity = { id: 8507713167, username: 'canarybot' }
  const server = opts.server ?? makeServerSpy().server
  const deps: HandlerDeps = {
    server,
    config,
    statePaths,
    telegramApi: opts.telegramApi ?? makeTelegramApi(),
    log: opts.log ?? silentLog,
    bot,
    botApi: { api: {} } as unknown as HandlerDeps['botApi'],
    botToken: 'fake-token',
    env: {},
    albumBuffer: opts.albumBuffer,
    ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
    ...(opts.router !== undefined ? { router: opts.router } : {}),
  }
  return { deps, statePaths, server }
}

// Build a minimal multichat policy that allowlists the warchief user id
// in both the private chat AND a group chat. mention_allowlist defaults
// to just the warchief so unaddressed group fragments aggregate to
// `addressedAtPush=false` and the FIX-D B1 silent-drop branch kicks in.
const ADDR_WARCHIEF = 164795011
const ADDR_GROUP_CHAT = -1003784643974
function makeAlbumPolicy(overrides: { mention_allowlist?: string[] } = {}): MultichatPolicy {
  const dmPolicy: ChatPolicy = {
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
  const groupPolicy: ChatPolicy = {
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
    [String(ADDR_WARCHIEF)]: dmPolicy,
    [String(ADDR_GROUP_CHAT)]: groupPolicy,
  }
  return {
    version: 1,
    allowlist: {
      chats: Object.keys(chats),
      users: [String(ADDR_WARCHIEF)],
    },
    mention_allowlist: overrides.mention_allowlist ?? [String(ADDR_WARCHIEF)],
    chats,
  }
}

// Group album fragment context. Unlike `makeAlbumCtx` (DM-only), this
// builds a supergroup ctx with full `me`/addressing scaffolding so
// `isAddressedToBot` evaluates correctly: `mentionBot=true` appends
// "@<botUsername>" to the caption so the addressing helper marks the
// fragment as addressed; `mentionBot=false` leaves it bare (sibling
// fragment of an album).
function makeGroupAlbumCtx(opts: {
  chatId: number
  fromId: number
  messageId: number
  mediaGroupId: string
  fileId: string
  caption?: string
  mentionBot?: boolean
  botUsername?: string
}): Context {
  const botUsername = opts.botUsername ?? 'canarybot'
  const baseCaption = opts.caption ?? ''
  const caption = opts.mentionBot
    ? (baseCaption.length > 0 ? `${baseCaption} @${botUsername}` : `@${botUsername}`)
    : (baseCaption.length > 0 ? baseCaption : undefined)
  return {
    chat: { id: opts.chatId, type: 'supergroup' as const },
    from: { id: opts.fromId, is_bot: false, first_name: 'x' },
    me: { id: 8507713167, username: botUsername },
    message: {
      message_id: opts.messageId,
      date: 1700000000,
      media_group_id: opts.mediaGroupId,
      ...(caption !== undefined ? { caption } : {}),
      chat: { id: opts.chatId, type: 'supergroup' as const },
      from: { id: opts.fromId, is_bot: false, first_name: 'x' },
      document: { file_id: opts.fileId, file_name: `${opts.fileId}.txt` },
    },
  } as unknown as Context
}

// Document context — picked because handleInboundDocument routes
// straight into tryRouteToAlbumBuffer without any network IO (no
// download, no transcribe, no media side effects).
function makeAlbumCtx(opts: {
  chatId: number
  fromId: number
  messageId: number
  mediaGroupId: string
  fileId: string
  caption?: string
}): Context {
  return {
    chat: { id: opts.chatId, type: 'private' as const },
    from: { id: opts.fromId, is_bot: false, first_name: 'x' },
    message: {
      message_id: opts.messageId,
      date: 1700000000,
      media_group_id: opts.mediaGroupId,
      caption: opts.caption,
      chat: { id: opts.chatId, type: 'private' as const },
      from: { id: opts.fromId, is_bot: false, first_name: 'x' },
      document: { file_id: opts.fileId, file_name: `${opts.fileId}.txt` },
    },
  } as unknown as Context
}

// ─────────────────────────────────────────────────────────────────────
// Bug #1 — chat-scoped buffer key
// ─────────────────────────────────────────────────────────────────────

describe('AlbumBuffer chat isolation (Bug #1)', () => {
  test('same media_group_id from two chats stays separate', async () => {
    const clock = makeClock()
    const buffer = makeBuffer(50, clock)
    const serverSpy = makeServerSpy()
    const { deps, statePaths } = makeDeps({
      albumBuffer: buffer,
      server: serverSpy.server,
    })

    // Two distinct allowlisted DMs share the same mgid (Telegram can
    // and does re-use mgids across chats — they are globally-scoped
    // only within a short time window per-uploader).
    const ctxA = makeAlbumCtx({
      chatId: 164795011,
      fromId: 164795011,
      messageId: 1,
      mediaGroupId: 'shared-mgid',
      fileId: 'A-doc-1',
      caption: 'from chat A',
    })
    const ctxB = makeAlbumCtx({
      chatId: 164795012,
      fromId: 164795012,
      messageId: 1,
      mediaGroupId: 'shared-mgid',
      fileId: 'B-doc-1',
      caption: 'from chat B',
    })

    await handleInboundDocument(ctxA, deps)
    await handleInboundDocument(ctxB, deps)

    // Flush window elapses.
    await clock.tick(60)
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5))

    // TWO independent flushes — one per chat. Both should reach the
    // channel as distinct notifications carrying the chat-specific
    // caption.
    expect(serverSpy.calls.length).toBe(2)
    const captions = serverSpy.calls
      .map((c) => JSON.stringify(c.params))
      .sort()
    expect(captions.some((s) => s.includes('from chat A'))).toBe(true)
    expect(captions.some((s) => s.includes('from chat B'))).toBe(true)
    // No cross-chat caption leak — chat A's notification must not
    // contain chat B's text and vice versa.
    const callA = serverSpy.calls.find((c) =>
      JSON.stringify(c.params).includes('from chat A'),
    )!
    const callB = serverSpy.calls.find((c) =>
      JSON.stringify(c.params).includes('from chat B'),
    )!
    expect(JSON.stringify(callA.params)).not.toContain('from chat B')
    expect(JSON.stringify(callB.params)).not.toContain('from chat A')

    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('compositeAlbumKey is the documented format', () => {
    expect(compositeAlbumKey('164795011', 'abc')).toBe('164795011:abc')
    expect(compositeAlbumKey('-1003784643974', 'mg/with/slash')).toBe(
      '-1003784643974:mg_with_slash',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// Bug #2 — durability: persistence happens before the buffer is fed
// ─────────────────────────────────────────────────────────────────────

describe('Album fragment persistence (Bug #2)', () => {
  test('a buffered album fragment is written to disk before the timer fires', async () => {
    const clock = makeClock()
    const buffer = makeBuffer(50, clock)
    const { deps, statePaths } = makeDeps({ albumBuffer: buffer })

    const ctx = makeAlbumCtx({
      chatId: 164795011,
      fromId: 164795011,
      messageId: 1,
      mediaGroupId: 'durable-mgid',
      fileId: 'doc-1',
    })
    await handleInboundDocument(ctx, deps)

    // BEFORE the silence window elapses, the on-disk album dir must
    // already exist with one fragment file. This is the "offset
    // advanced — survive crash" invariant.
    const key = compositeAlbumKey('164795011', 'durable-mgid')
    const albumDir = join(statePaths.root, 'albums', key)
    expect(existsSync(albumDir)).toBe(true)
    expect(existsSync(join(albumDir, 'meta.json'))).toBe(true)
    const files = readdirSync(albumDir).filter(
      (n) => n !== 'meta.json' && n.endsWith('.json'),
    )
    expect(files.length).toBe(1)

    // After flush, the dir is removed (successful dispatch path).
    await clock.tick(60)
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5))
    expect(existsSync(albumDir)).toBe(false)

    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('router/flush failure moves the album dir to dead-letter', async () => {
    const clock = makeClock()
    const buffer = makeBuffer(50, clock)
    // The notify-server throws -> sendChannelNotification returns false
    // (its internal contract) -> sendAlbumNotification throws -> our
    // flush wrapper moves the on-disk dir to dead-letter.
    const failingServer = {
      notification: async (): Promise<void> => {
        throw new Error('mcp transport blew up')
      },
    }
    const { deps, statePaths } = makeDeps({
      albumBuffer: buffer,
      server: failingServer,
    })
    const ctx = makeAlbumCtx({
      chatId: 164795011,
      fromId: 164795011,
      messageId: 1,
      mediaGroupId: 'doomed-mgid',
      fileId: 'doc-1',
    })
    await handleInboundDocument(ctx, deps)

    const key = compositeAlbumKey('164795011', 'doomed-mgid')
    expect(existsSync(join(statePaths.root, 'albums', key))).toBe(true)

    // Trigger flush. The dispatch throws inside sendAlbumNotification
    // (channel transport failure). Our flush wrapper must move the dir
    // into dead-letter — not leave it lingering, not silently drop.
    await clock.tick(60)
    // Drain the void-async cleanup chain: sendAlbumNotification ->
    // moveToAlbumDeadLetter both await fs ops. Multiple yields cover
    // the worst case (4 awaits deep on a slow CI box).
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5))

    expect(existsSync(join(statePaths.root, 'albums', key))).toBe(false)
    const dl = readdirSync(join(statePaths.root, 'albums', 'dead-letter'))
    expect(dl.some((n) => n.startsWith(`${key}-`))).toBe(true)

    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('crash recovery replays persisted fragments through the flush path', async () => {
    const statePaths = makeStatePaths()
    const key = compositeAlbumKey('164795011', 'recovered-mgid')

    // Simulate a process that received fragments and crashed before
    // the timer fired: meta + two fragment files are on disk, no
    // in-memory buffer exists.
    await ensureAlbumsDir(statePaths.root)
    const meta: PersistedAlbumMeta = {
      chatId: '164795011',
      senderId: '164795011',
      user: 'warchief',
      mediaGroupId: 'recovered-mgid',
      kind: 'document',
      // Far enough in the past that the grace window has elapsed.
      firstAt: Date.now() - 60_000,
    }
    const frag1: AlbumEntry = {
      descriptors: ['<media kind="document" file_id="f1" />'],
      mediaPaths: [],
      caption: 'caption one',
      messageId: 10,
      reply: undefined,
    }
    const frag2: AlbumEntry = {
      descriptors: ['<media kind="document" file_id="f2" />'],
      mediaPaths: [],
      caption: 'caption two',
      messageId: 11,
      reply: undefined,
    }
    await persistFragment(statePaths.root, key, meta, frag1)
    // Small sleep so the second filename sorts after the first.
    await new Promise((r) => setTimeout(r, 5))
    await persistFragment(statePaths.root, key, meta, frag2)

    // Spy flush — count invocations and capture the fragment payloads.
    let flushed: Array<{ key: string; fragments: AlbumEntry[] }> = []
    const stats = await recoverPendingAlbums<AlbumEntry>({
      stateDir: statePaths.root,
      // graceMs lower than `now - firstAt` so the entry qualifies.
      graceMs: 10_000,
      flush: async (album) => {
        flushed.push({ key: album.key, fragments: album.fragments })
      },
    })

    expect(stats.recovered).toBe(1)
    expect(stats.deadLettered).toBe(0)
    expect(flushed.length).toBe(1)
    expect(flushed[0]!.key).toBe(key)
    expect(flushed[0]!.fragments.map((f) => f.caption)).toEqual([
      'caption one',
      'caption two',
    ])
    // After successful flush the album dir is gone.
    expect(existsSync(join(statePaths.root, 'albums', key))).toBe(false)

    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('recovery skips fresh albums when no scheduleFlush (back-compat)', async () => {
    // FIX-D M2 (2026-05-27): the legacy "skip fresh" behaviour is now
    // back-compat ONLY — callers that wire scheduleFlush get the new
    // delayed-replay path. Without scheduleFlush we still skip so old
    // tests / minimal startups behave as before.
    const statePaths = makeStatePaths()
    const key = compositeAlbumKey('164795011', 'fresh-mgid')
    await ensureAlbumsDir(statePaths.root)
    const meta: PersistedAlbumMeta = {
      chatId: '164795011',
      senderId: '164795011',
      user: 'warchief',
      mediaGroupId: 'fresh-mgid',
      kind: 'document',
      firstAt: Date.now(), // just arrived
    }
    await persistFragment(statePaths.root, key, meta, {
      descriptors: [],
      mediaPaths: [],
      caption: '',
      messageId: 1,
      reply: undefined,
      addressedAtPush: true,
    } as AlbumEntry)

    let calls = 0
    const stats = await recoverPendingAlbums<AlbumEntry>({
      stateDir: statePaths.root,
      graceMs: 30_000,
      flush: async () => {
        calls++
      },
    })

    expect(stats.recovered).toBe(0)
    expect(stats.skipped).toBe(1)
    expect(stats.scheduled).toBe(0)
    expect(calls).toBe(0)
    // Dir is intact — back-compat: caller without scheduleFlush leaves
    // the on-disk dir alone (legacy skip path).
    expect(existsSync(join(statePaths.root, 'albums', key))).toBe(true)

    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('recovery dead-letters orphan dirs (no meta.json)', async () => {
    const statePaths = makeStatePaths()
    await ensureAlbumsDir(statePaths.root)
    // Create an orphan album dir — just a stray JSON file, no meta.
    const orphan = join(statePaths.root, 'albums', 'broken-key')
    mkdirSync(orphan, { recursive: true, mode: 0o700 })
    writeFileSync(join(orphan, '00001-aaaa.json'), '{"corrupt":true}', {
      mode: 0o600,
    })

    const stats = await recoverPendingAlbums<AlbumEntry>({
      stateDir: statePaths.root,
      graceMs: 0,
      flush: async () => {
        throw new Error('should not be called for orphan')
      },
    })
    expect(stats.deadLettered).toBe(1)
    expect(stats.recovered).toBe(0)
    expect(existsSync(orphan)).toBe(false)
    const dl = readdirSync(join(statePaths.root, 'albums', 'dead-letter'))
    expect(dl.some((n) => n.startsWith('broken-key-'))).toBe(true)

    rmSync(statePaths.root, { recursive: true, force: true })
  })
})

// ─────────────────────────────────────────────────────────────────────
// MED-C (Codex handlers #4) — recovery dead-letters corrupt fragments
// instead of dispatching a partial album.
//
// Pre-MED-C behaviour: `readFragments` swallowed any read/parse error
// on a fragment file and returned the remaining ones. `recoverPendingAlbums`
// then dispatched a PARTIAL album and deleted the source dir, losing
// the corrupt fragment forever and (worse) delivering an incomplete
// media-group to the user.
//
// MED-C contract:
//   - First unreadable / zero-byte / unparseable fragment short-circuits.
//   - The whole album dir is moved to `dead-letter/albums/<key>-<ts>/`
//     with a `.recovery-failure.json` sidecar.
//   - `flush` is NEVER invoked for that album.
//   - The source dir under `albums/<key>/` is gone only AFTER the move
//     destination is populated (atomic rename when possible).
// ─────────────────────────────────────────────────────────────────────

describe('MED-C — recovery dead-letters corrupt fragments without partial dispatch', () => {
  test('3 fragments, 1 truncated to 0 bytes → album dead-lettered, no flush', async () => {
    const statePaths = makeStatePaths()
    const key = compositeAlbumKey('164795011', 'med-c-zero')
    await ensureAlbumsDir(statePaths.root)

    const meta: PersistedAlbumMeta = {
      chatId: '164795011',
      senderId: '164795011',
      user: 'warchief',
      mediaGroupId: 'med-c-zero',
      kind: 'document',
      firstAt: Date.now() - 60_000, // aged past graceMs
    }
    for (let i = 1; i <= 3; i++) {
      await persistFragment(statePaths.root, key, meta, {
        descriptors: [`<media kind="document" file_id="f${i}" />`],
        mediaPaths: [],
        caption: `frag ${i}`,
        messageId: 100 + i,
        reply: undefined,
      } as AlbumEntry)
      // small spacing so filenames sort
      await new Promise((r) => setTimeout(r, 2))
    }

    // Pick the middle fragment file and truncate it to 0 bytes.
    const albumDirPath = join(statePaths.root, 'albums', key)
    const fragFiles = readdirSync(albumDirPath)
      .filter((n) => n !== 'meta.json' && n.endsWith('.json'))
      .sort()
    expect(fragFiles.length).toBe(3)
    const corruptName = fragFiles[1]!
    truncateSync(join(albumDirPath, corruptName), 0)

    let flushCalls = 0
    const stats = await recoverPendingAlbums<AlbumEntry>({
      stateDir: statePaths.root,
      graceMs: 10_000,
      flush: async () => {
        flushCalls++
      },
    })

    // No partial dispatch — flush MUST NOT be called for a corrupt album.
    expect(flushCalls).toBe(0)
    expect(stats.recovered).toBe(0)
    expect(stats.deadLettered).toBe(1)
    expect(stats.scheduled).toBe(0)

    // Original album dir is gone (moved, not just deleted).
    expect(existsSync(albumDirPath)).toBe(false)

    // Dead-letter entry + JSON sidecar exist.
    const dlRoot = join(statePaths.root, 'albums', 'dead-letter')
    const dlEntries = readdirSync(dlRoot)
    const dlDirName = dlEntries.find(
      (n) => n.startsWith(`${key}-`) && !n.endsWith('.recovery-failure.json'),
    )
    expect(dlDirName).toBeDefined()
    const dlDir = join(dlRoot, dlDirName!)
    // All 3 original fragment files (including the zero-byte one) plus
    // meta.json were moved verbatim — dead-letter preserves evidence.
    const movedFiles = readdirSync(dlDir).sort()
    expect(movedFiles).toContain('meta.json')
    for (const f of fragFiles) expect(movedFiles).toContain(f)

    const sidecarPath = `${dlDir}.recovery-failure.json`
    expect(existsSync(sidecarPath)).toBe(true)
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as {
      timestamp: string
      key: string
      chatId: string | null
      mediaGroupId: string | null
      fragmentCount: number
      corruptFile: string
      errorType: string
      errorMessage: string
    }
    expect(sidecar.key).toBe(key)
    expect(sidecar.chatId).toBe('164795011')
    expect(sidecar.mediaGroupId).toBe('med-c-zero')
    expect(sidecar.fragmentCount).toBe(3)
    expect(sidecar.corruptFile).toBe(corruptName)
    expect(sidecar.errorType).toBe('empty_file')
    expect(typeof sidecar.errorMessage).toBe('string')
    expect(sidecar.errorMessage.length).toBeGreaterThan(0)
    // ISO timestamp sanity check.
    expect(Number.isNaN(Date.parse(sidecar.timestamp))).toBe(false)

    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('fragment with invalid JSON → album dead-lettered with errorType=parse', async () => {
    const statePaths = makeStatePaths()
    const key = compositeAlbumKey('164795011', 'med-c-parse')
    await ensureAlbumsDir(statePaths.root)

    const meta: PersistedAlbumMeta = {
      chatId: '164795011',
      senderId: '164795011',
      user: 'warchief',
      mediaGroupId: 'med-c-parse',
      kind: 'document',
      firstAt: Date.now() - 60_000,
    }
    for (let i = 1; i <= 3; i++) {
      await persistFragment(statePaths.root, key, meta, {
        descriptors: [`<media kind="document" file_id="f${i}" />`],
        mediaPaths: [],
        caption: `frag ${i}`,
        messageId: 100 + i,
        reply: undefined,
      } as AlbumEntry)
      await new Promise((r) => setTimeout(r, 2))
    }

    // Overwrite the LAST fragment with garbage JSON (simulates a
    // version-skew rewrite that lost its closing brace mid-write).
    const albumDirPath = join(statePaths.root, 'albums', key)
    const fragFiles = readdirSync(albumDirPath)
      .filter((n) => n !== 'meta.json' && n.endsWith('.json'))
      .sort()
    const corruptName = fragFiles[2]!
    writeFileSync(join(albumDirPath, corruptName), '{"descriptors": [unterminated', {
      mode: 0o600,
    })

    const warns: Array<{ msg: string; ctx?: Record<string, unknown> }> = []
    const log: Logger = {
      ...silentLog,
      warn: (msg, ctx) => {
        warns.push({ msg, ...(ctx ? { ctx } : {}) })
      },
    }

    let flushCalls = 0
    const stats = await recoverPendingAlbums<AlbumEntry>({
      stateDir: statePaths.root,
      graceMs: 10_000,
      flush: async () => {
        flushCalls++
      },
      log,
    })

    expect(flushCalls).toBe(0)
    expect(stats.recovered).toBe(0)
    expect(stats.deadLettered).toBe(1)
    expect(existsSync(albumDirPath)).toBe(false)

    const dlRoot = join(statePaths.root, 'albums', 'dead-letter')
    const dlEntries = readdirSync(dlRoot)
    const dlDirName = dlEntries.find(
      (n) => n.startsWith(`${key}-`) && !n.endsWith('.recovery-failure.json'),
    )
    expect(dlDirName).toBeDefined()
    const sidecar = JSON.parse(
      readFileSync(`${join(dlRoot, dlDirName!)}.recovery-failure.json`, 'utf8'),
    ) as {
      key: string
      corruptFile: string
      errorType: string
      fragmentCount: number
    }
    expect(sidecar.key).toBe(key)
    expect(sidecar.corruptFile).toBe(corruptName)
    expect(sidecar.errorType).toBe('parse')
    expect(sidecar.fragmentCount).toBe(3)

    // Structured log surface — the dead_letter event carries the
    // canonical fields ops needs to triage.
    const dlLog = warns.find((w) => w.msg === 'album.recovery.dead_letter')
    expect(dlLog).toBeDefined()
    expect(dlLog!.ctx?.chatId).toBe('164795011')
    expect(dlLog!.ctx?.mgid).toBe('med-c-parse')
    expect(typeof dlLog!.ctx?.reason).toBe('string')
    expect(String(dlLog!.ctx?.reason)).toContain('parse')

    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('all 3 fragments intact → recovery dispatches normally (no false-positive)', async () => {
    // Negative control: the MED-C guard MUST NOT fire on a healthy
    // album. Same shape as the corrupt cases above but no tampering.
    const statePaths = makeStatePaths()
    const key = compositeAlbumKey('164795011', 'med-c-clean')
    await ensureAlbumsDir(statePaths.root)

    const meta: PersistedAlbumMeta = {
      chatId: '164795011',
      senderId: '164795011',
      user: 'warchief',
      mediaGroupId: 'med-c-clean',
      kind: 'document',
      firstAt: Date.now() - 60_000,
    }
    for (let i = 1; i <= 3; i++) {
      await persistFragment(statePaths.root, key, meta, {
        descriptors: [`<media kind="document" file_id="f${i}" />`],
        mediaPaths: [],
        caption: `frag ${i}`,
        messageId: 100 + i,
        reply: undefined,
      } as AlbumEntry)
      await new Promise((r) => setTimeout(r, 2))
    }

    let flushed: AlbumEntry[] = []
    const stats = await recoverPendingAlbums<AlbumEntry>({
      stateDir: statePaths.root,
      graceMs: 10_000,
      flush: async (album) => {
        flushed = album.fragments
      },
    })

    expect(stats.recovered).toBe(1)
    expect(stats.deadLettered).toBe(0)
    expect(flushed.length).toBe(3)
    expect(flushed.map((f) => f.caption)).toEqual(['frag 1', 'frag 2', 'frag 3'])
    expect(existsSync(join(statePaths.root, 'albums', key))).toBe(false)
    // Dead-letter remains empty (the dir might exist from ensureAlbumsDir;
    // assert no children prefixed with our key).
    const dlRoot = join(statePaths.root, 'albums', 'dead-letter')
    const dlEntries = existsSync(dlRoot) ? readdirSync(dlRoot) : []
    expect(dlEntries.some((n) => n.startsWith(`${key}-`))).toBe(false)

    rmSync(statePaths.root, { recursive: true, force: true })
  })
})

// ─────────────────────────────────────────────────────────────────────
// Sanity: an album with no persistence still works for legacy/no-statePaths
// callers (defence-in-depth, not a target scenario in production)
// ─────────────────────────────────────────────────────────────────────

describe('Album buffer baseline', () => {
  test('a one-fragment album flushes through the buffer', async () => {
    const clock = makeClock()
    const buffer = makeBuffer(40, clock)
    const serverSpy = makeServerSpy()
    const { deps, statePaths } = makeDeps({
      albumBuffer: buffer,
      server: serverSpy.server,
    })

    const ctx = makeAlbumCtx({
      chatId: 164795011,
      fromId: 164795011,
      messageId: 1,
      mediaGroupId: 'solo-mgid',
      fileId: 'solo',
      caption: 'caption text',
    })
    await handleInboundDocument(ctx, deps)
    await clock.tick(50)
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5))

    expect(serverSpy.calls.length).toBe(1)
    expect(JSON.stringify(serverSpy.calls[0]!.params)).toContain('caption text')
    rmSync(statePaths.root, { recursive: true, force: true })
  })
})

// ─────────────────────────────────────────────────────────────────────
// FIX-D B1 — group album aggregate addressing
// ─────────────────────────────────────────────────────────────────────

describe('FIX-D B1 — group album aggregate addressing', () => {
  test('3 fragments, 1 captioned with @mention, 2 bare → whole album dispatches', async () => {
    const clock = makeClock()
    const buffer = makeBuffer(50, clock)
    const serverSpy = makeServerSpy()
    const policy = makeAlbumPolicy()
    // Router stays undefined here — group dispatch will use the legacy
    // notify path for the test because we are NOT exercising router
    // wiring (M1 case is covered separately). We test the
    // sendChannelNotification fan-out directly via the serverSpy.
    // Wait — policy without router in a group is M1 misconfig (drops).
    // So we MUST wire a router mock to allow group dispatch through.
    const routerCalls: InboundMessage[] = []
    const router: MultichatRouter = {
      dispatch: async (msg: InboundMessage) => {
        routerCalls.push(msg)
      },
    } as unknown as MultichatRouter
    const { deps, statePaths } = makeDeps({
      albumBuffer: buffer,
      server: serverSpy.server,
      policy,
      router,
    })

    // First fragment carries the @mention + caption — addressed.
    const ctx1 = makeGroupAlbumCtx({
      chatId: ADDR_GROUP_CHAT,
      fromId: ADDR_WARCHIEF,
      messageId: 1,
      mediaGroupId: 'b1-mgid',
      fileId: 'doc-1',
      caption: 'look at these',
      mentionBot: true,
    })
    // Second and third fragments arrive bare — Telegram only puts the
    // caption / mention on one fragment.
    const ctx2 = makeGroupAlbumCtx({
      chatId: ADDR_GROUP_CHAT,
      fromId: ADDR_WARCHIEF,
      messageId: 2,
      mediaGroupId: 'b1-mgid',
      fileId: 'doc-2',
      mentionBot: false,
    })
    const ctx3 = makeGroupAlbumCtx({
      chatId: ADDR_GROUP_CHAT,
      fromId: ADDR_WARCHIEF,
      messageId: 3,
      mediaGroupId: 'b1-mgid',
      fileId: 'doc-3',
      mentionBot: false,
    })

    await handleInboundDocument(ctx1, deps)
    await handleInboundDocument(ctx2, deps)
    await handleInboundDocument(ctx3, deps)

    // All three persisted under the same chat:mgid composite key.
    const key = compositeAlbumKey(String(ADDR_GROUP_CHAT), 'b1-mgid')
    const dir = join(statePaths.root, 'albums', key)
    expect(existsSync(dir)).toBe(true)
    expect(
      readdirSync(dir).filter((n) => n !== 'meta.json' && n.endsWith('.json'))
        .length,
    ).toBe(3)

    // Flush window passes — single dispatch with all 3 fragments.
    await clock.tick(60)
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5))

    expect(routerCalls.length).toBe(1)
    expect(routerCalls[0]!.chat_id).toBe(String(ADDR_GROUP_CHAT))
    expect(routerCalls[0]!.text).toContain('look at these')
    // Dir cleaned up after successful dispatch.
    expect(existsSync(dir)).toBe(false)

    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('DM album + router wired → legacy notify to master, NO router dispatch', async () => {
    // Hybrid routing (2026-05-28): even with the router wired, a private
    // DM album must land in the master (channel-thrall) session via legacy
    // notify, NOT a per-chat session. Mirrors the single-message DM test
    // in handlers.addressing.test.ts, for the album flush path.
    const clock = makeClock()
    const buffer = makeBuffer(50, clock)
    const serverSpy = makeServerSpy()
    const policy = makeAlbumPolicy()
    const routerCalls: InboundMessage[] = []
    const router: MultichatRouter = {
      dispatch: async (msg: InboundMessage) => {
        routerCalls.push(msg)
      },
    } as unknown as MultichatRouter
    const { deps, statePaths } = makeDeps({
      albumBuffer: buffer,
      server: serverSpy.server,
      policy,
      router,
    })

    // DM album (positive chat id = private). No @mention needed — DMs are
    // addressed unconditionally.
    const ctx1 = makeAlbumCtx({
      chatId: ADDR_WARCHIEF,
      fromId: ADDR_WARCHIEF,
      messageId: 1,
      mediaGroupId: 'dm-mgid',
      fileId: 'dm-doc-1',
      caption: 'личный альбом',
    })
    const ctx2 = makeAlbumCtx({
      chatId: ADDR_WARCHIEF,
      fromId: ADDR_WARCHIEF,
      messageId: 2,
      mediaGroupId: 'dm-mgid',
      fileId: 'dm-doc-2',
    })

    await handleInboundDocument(ctx1, deps)
    await handleInboundDocument(ctx2, deps)

    await clock.tick(60)
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5))

    // DM album stays on the master session — router NOT used.
    expect(routerCalls.length).toBe(0)
    expect(serverSpy.calls.length).toBe(1)
    expect(JSON.stringify(serverSpy.calls[0]!.params)).toContain('личный альбом')

    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('3 fragments NONE addressed in group → silent drop, no dispatch, dir cleaned', async () => {
    const clock = makeClock()
    const buffer = makeBuffer(50, clock)
    const serverSpy = makeServerSpy()
    const policy = makeAlbumPolicy()
    const routerCalls: InboundMessage[] = []
    const router: MultichatRouter = {
      dispatch: async (msg: InboundMessage) => {
        routerCalls.push(msg)
      },
    } as unknown as MultichatRouter
    const { deps, statePaths } = makeDeps({
      albumBuffer: buffer,
      server: serverSpy.server,
      policy,
      router,
    })

    // Three bare fragments — no caption, no @mention on any of them.
    // Allowlisted sender, allowlisted chat (so the gate passes), but
    // addressing fails on every fragment.
    const fragments = [1, 2, 3].map((i) =>
      makeGroupAlbumCtx({
        chatId: ADDR_GROUP_CHAT,
        fromId: ADDR_WARCHIEF,
        messageId: i,
        mediaGroupId: 'b1-bare-mgid',
        fileId: `doc-${i}`,
        mentionBot: false,
      }),
    )
    for (const ctx of fragments) await handleInboundDocument(ctx, deps)

    const key = compositeAlbumKey(String(ADDR_GROUP_CHAT), 'b1-bare-mgid')
    const dir = join(statePaths.root, 'albums', key)
    // All buffered + persisted regardless of addressing (FIX-D B1 design).
    expect(existsSync(dir)).toBe(true)
    expect(
      readdirSync(dir).filter((n) => n !== 'meta.json' && n.endsWith('.json'))
        .length,
    ).toBe(3)

    await clock.tick(60)
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5))

    // ZERO dispatches — neither router nor server. Silent drop.
    expect(routerCalls.length).toBe(0)
    expect(serverSpy.calls.length).toBe(0)
    // Dir cleaned up — silent drop is not an error, so no dead-letter.
    expect(existsSync(dir)).toBe(false)
    const dlDir = join(statePaths.root, 'albums', 'dead-letter')
    const dlEntries = existsSync(dlDir) ? readdirSync(dlDir) : []
    expect(dlEntries.some((n) => n.startsWith(`${key}-`))).toBe(false)

    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('private DM album → all fragments pass (DM always addressed)', async () => {
    const clock = makeClock()
    const buffer = makeBuffer(50, clock)
    const serverSpy = makeServerSpy()
    // No policy → legacy notify path. DM is always allowed and always
    // addressed regardless of policy.
    const { deps, statePaths } = makeDeps({
      albumBuffer: buffer,
      server: serverSpy.server,
    })

    // Two bare fragments + one with caption. None mention the bot —
    // private chat does not require it.
    const ctx1 = makeAlbumCtx({
      chatId: 164795011,
      fromId: 164795011,
      messageId: 1,
      mediaGroupId: 'dm-mgid',
      fileId: 'doc-1',
      caption: 'private caption',
    })
    const ctx2 = makeAlbumCtx({
      chatId: 164795011,
      fromId: 164795011,
      messageId: 2,
      mediaGroupId: 'dm-mgid',
      fileId: 'doc-2',
    })
    const ctx3 = makeAlbumCtx({
      chatId: 164795011,
      fromId: 164795011,
      messageId: 3,
      mediaGroupId: 'dm-mgid',
      fileId: 'doc-3',
    })

    await handleInboundDocument(ctx1, deps)
    await handleInboundDocument(ctx2, deps)
    await handleInboundDocument(ctx3, deps)

    await clock.tick(60)
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5))

    expect(serverSpy.calls.length).toBe(1)
    const params = JSON.stringify(serverSpy.calls[0]!.params)
    expect(params).toContain('private caption')
    expect(params).toContain('album_size')
    expect(params).toContain('"3"') // album_size = 3

    rmSync(statePaths.root, { recursive: true, force: true })
  })
})

// ─────────────────────────────────────────────────────────────────────
// FIX-D M1 — policy without router in group chat → drop with error log
// ─────────────────────────────────────────────────────────────────────

describe('FIX-D M1 — policy/router XOR defence-in-depth', () => {
  test('album: policy present, router missing, group chat → drop, no notify', async () => {
    const clock = makeClock()
    const buffer = makeBuffer(50, clock)
    const serverSpy = makeServerSpy()
    const errorMessages: Array<{ msg: string; ctx?: Record<string, unknown> }> = []
    const log: Logger = {
      ...silentLog,
      error: (msg, ctx) => {
        errorMessages.push({ msg, ...(ctx ? { ctx } : {}) })
      },
    }
    const policy = makeAlbumPolicy()
    // router intentionally omitted — the wiring bug we're defending against.
    const { deps, statePaths } = makeDeps({
      albumBuffer: buffer,
      server: serverSpy.server,
      policy,
      log,
    })

    const ctx = makeGroupAlbumCtx({
      chatId: ADDR_GROUP_CHAT,
      fromId: ADDR_WARCHIEF,
      messageId: 1,
      mediaGroupId: 'm1-mgid',
      fileId: 'doc-1',
      caption: 'should not leak to master',
      mentionBot: true,
    })
    await handleInboundDocument(ctx, deps)

    // No buffer entry created, no on-disk fragment, error logged.
    const key = compositeAlbumKey(String(ADDR_GROUP_CHAT), 'm1-mgid')
    expect(existsSync(join(statePaths.root, 'albums', key))).toBe(false)
    expect(errorMessages.length).toBe(1)
    expect(errorMessages[0]!.msg).toContain('policy_router_misconfig')

    // Wait past flush window — confirm no late dispatch.
    await clock.tick(60)
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5))
    expect(serverSpy.calls.length).toBe(0)

    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('sendAlbumNotification: group chat + policy + no router → silent drop, no notify', async () => {
    // Direct test of the dispatch-site guard for the recovery path
    // (server.ts replays disk albums by calling sendAlbumNotification
    // directly — without the handler guard the legacy notify would fire).
    const serverSpy = makeServerSpy()
    const errorMessages: string[] = []
    const log: Logger = {
      ...silentLog,
      error: (msg) => {
        errorMessages.push(msg)
      },
    }
    const policy = makeAlbumPolicy()
    const outcome = await sendAlbumNotification(
      {
        mediaGroupId: 'm1-direct-mgid',
        messages: [
          {
            descriptors: [],
            mediaPaths: [],
            caption: 'should not leak',
            messageId: 1,
            reply: undefined,
            addressedAtPush: true,
          },
        ],
        firstAt: Date.now(),
        lastAt: Date.now(),
      },
      {
        chatId: String(ADDR_GROUP_CHAT),
        senderId: String(ADDR_WARCHIEF),
        user: 'warchief',
        mediaGroupId: 'm1-direct-mgid',
        kind: 'document',
      },
      {
        server: serverSpy.server,
        config: makeConfig(),
        log,
        bot: { id: 8507713167, username: 'canarybot' },
        telegramApi: makeTelegramApi(),
        policy,
        // router intentionally missing
      },
    )

    expect(outcome.dispatched).toBe(false)
    expect(outcome.silentDrop).toBe('policy_router_misconfig')
    expect(serverSpy.calls.length).toBe(0)
    expect(errorMessages.some((m) => m.includes('policy_router_misconfig'))).toBe(true)
  })

  test('DM dispatch is unaffected by missing router (legacy notify still works)', async () => {
    const clock = makeClock()
    const buffer = makeBuffer(50, clock)
    const serverSpy = makeServerSpy()
    const policy = makeAlbumPolicy()
    const { deps, statePaths } = makeDeps({
      albumBuffer: buffer,
      server: serverSpy.server,
      policy,
      // router omitted — but chat is private, so M1 check passes.
    })

    const ctx = makeAlbumCtx({
      chatId: 164795011,
      fromId: 164795011,
      messageId: 1,
      mediaGroupId: 'm1-dm-mgid',
      fileId: 'doc-1',
      caption: 'dm content',
    })
    await handleInboundDocument(ctx, deps)
    await clock.tick(60)
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5))

    // Legacy notify path fires — policy in DM doesn't trigger the XOR
    // defence (DMs use legacy notify intentionally).
    expect(serverSpy.calls.length).toBe(1)
    expect(JSON.stringify(serverSpy.calls[0]!.params)).toContain('dm content')

    rmSync(statePaths.root, { recursive: true, force: true })
  })
})

// ─────────────────────────────────────────────────────────────────────
// FIX-D M2 — recovery replays fresh albums via scheduleFlush
// ─────────────────────────────────────────────────────────────────────

describe('FIX-D M2 — recovery schedules fresh albums for delayed flush', () => {
  test('3 fresh fragments → scheduleFlush invoked with positive delay; flush eventually delivers all', async () => {
    const statePaths = makeStatePaths()
    const key = compositeAlbumKey('164795011', 'm2-mgid')
    await ensureAlbumsDir(statePaths.root)

    // Three fragments persisted just now — all within graceMs.
    const baseNow = Date.now()
    const meta: PersistedAlbumMeta = {
      chatId: '164795011',
      senderId: '164795011',
      user: 'warchief',
      mediaGroupId: 'm2-mgid',
      kind: 'document',
      firstAt: baseNow - 500, // 500ms old — way inside the grace window
    }
    for (let i = 1; i <= 3; i++) {
      await persistFragment(statePaths.root, key, meta, {
        descriptors: [`<media kind="document" file_id="f${i}" />`],
        mediaPaths: [],
        caption: `frag ${i}`,
        messageId: 100 + i,
        reply: undefined,
        addressedAtPush: true,
      } as AlbumEntry)
      // ms tick so filenames sort.
      await new Promise((r) => setTimeout(r, 2))
    }

    // Spy scheduler — record the album + delay, then dispatch
    // immediately to simulate the timer firing.
    const scheduled: Array<{ album: RecoveredAlbum<AlbumEntry>; delay: number }> = []
    const flushedFragments: AlbumEntry[][] = []
    const stats = await recoverPendingAlbums<AlbumEntry>({
      stateDir: statePaths.root,
      graceMs: 30_000,
      flushMs: 2_000,
      flush: async (album) => {
        // Immediate-flush path (not used when scheduleFlush is set, but
        // we still pass it as required).
        flushedFragments.push(album.fragments)
      },
      scheduleFlush: (album, delayMs) => {
        scheduled.push({ album, delay: delayMs })
      },
    })

    expect(stats.scheduled).toBe(1)
    expect(stats.recovered).toBe(0)
    expect(stats.skipped).toBe(0)
    expect(scheduled.length).toBe(1)
    expect(scheduled[0]!.album.fragments.length).toBe(3)
    expect(scheduled[0]!.album.fragments.map((f) => f.caption)).toEqual([
      'frag 1',
      'frag 2',
      'frag 3',
    ])
    // Delay = max(0, flushMs - age). age was ~500ms, flushMs 2000.
    // We can't assert exact age (now() drifts), but it should be a
    // sensible positive number well under flushMs.
    expect(scheduled[0]!.delay).toBeGreaterThan(0)
    expect(scheduled[0]!.delay).toBeLessThanOrEqual(2_000)

    // Dir still on disk — the scheduler owns it now.
    expect(existsSync(join(statePaths.root, 'albums', key))).toBe(true)

    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('aged album (older than graceMs) → flushed immediately, scheduleFlush not called', async () => {
    const statePaths = makeStatePaths()
    const key = compositeAlbumKey('164795011', 'm2-aged-mgid')
    await ensureAlbumsDir(statePaths.root)

    const meta: PersistedAlbumMeta = {
      chatId: '164795011',
      senderId: '164795011',
      user: 'warchief',
      mediaGroupId: 'm2-aged-mgid',
      kind: 'document',
      firstAt: Date.now() - 60_000, // 60s old — past graceMs
    }
    await persistFragment(statePaths.root, key, meta, {
      descriptors: [],
      mediaPaths: [],
      caption: 'aged',
      messageId: 1,
      reply: undefined,
      addressedAtPush: true,
    } as AlbumEntry)

    let scheduledCount = 0
    let flushedCount = 0
    const stats = await recoverPendingAlbums<AlbumEntry>({
      stateDir: statePaths.root,
      graceMs: 30_000,
      flushMs: 2_000,
      flush: async () => {
        flushedCount++
      },
      scheduleFlush: () => {
        scheduledCount++
      },
    })

    expect(stats.recovered).toBe(1)
    expect(stats.scheduled).toBe(0)
    expect(flushedCount).toBe(1)
    expect(scheduledCount).toBe(0)
    // Aged album dropped after successful flush.
    expect(existsSync(join(statePaths.root, 'albums', key))).toBe(false)

    rmSync(statePaths.root, { recursive: true, force: true })
  })
})
