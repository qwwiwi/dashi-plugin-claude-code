// TASK-5 tests (2026-05-27) — multichat router policy gate + outbox
// claim validation.
//
// Covers four Codex-review findings (HIGH #7 / HIGH #8 / MEDIUM-drain /
// MEDIUM-chatid):
//   1. dispatch() denies BEFORE filesystem mutation when policy.chats
//      lacks the chat id — no inbox dir, no inbox file, no spawn.
//   2. dispatch() proceeds (inbox dir + file created) when the chat IS
//      in policy and the user is allowlisted.
//   3. deliverClaim() quarantines a claim whose `message.chat_id` does
//      NOT match the owning chat directory — outbox/mismatched/ filled,
//      sendMessage NEVER invoked.
//   4. Concurrent outbox drain ticks: the second tick is a no-op when
//      the first is still in flight (no overlapping sendMessage calls).
//   5. assertValidChatId guards: dispatch with `chat_id: "../x"` or
//      `chat_id: "abc"` drops without touching the FS.
//
// The router pool dependency is replaced by a minimal fake — these
// tests target dispatch + outbox loop logic only, not tmux spawning.

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

// ──────────────────────────────────────────────────────────────────────
// Helpers
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

// Minimal in-memory fake of TmuxSessionPool. We only need the surface
// the router touches: loadSessions, startWatchdog, stopWatchdog,
// getOrSpawn, touch. spawnInternal's policy enforcement is out of
// scope — this fake never refuses, so the test asserts the ROUTER
// gate did its job before reaching us.
class FakePool {
  spawned: string[] = []
  touched: string[] = []
  loaded = 0
  watchdogStarted = false
  watchdogStopped = false
  // When set, getOrSpawn throws — used to simulate the C3 refusal so
  // we can confirm the order of operations matches the pre-fix bug
  // path: without bug 1 fix, ensure/write happen even when spawn
  // fails. With bug 1 fix in place, those side effects must NOT
  // occur because we deny before they run.
  spawnError: Error | null = null

  async loadSessions(): Promise<void> {
    this.loaded += 1
  }
  startWatchdog(): void {
    this.watchdogStarted = true
  }
  stopWatchdog(): void {
    this.watchdogStopped = true
  }
  async getOrSpawn(chatId: string): Promise<SessionHandle> {
    if (this.spawnError !== null) throw this.spawnError
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
    /* unused in these tests */
  }
}

// Spy Telegram API. Records every sendMessage call. Lets the test
// assert "we never sent" for the mismatch case.
function spyTelegramApi(): {
  api: MultichatTelegramApi
  calls: Array<{ chatId: string; text: string; opts: unknown }>
  setBehaviour: (b: 'ok' | 'slow') => void
  releaseSlow: () => void
} {
  const calls: Array<{ chatId: string; text: string; opts: unknown }> = []
  let behaviour: 'ok' | 'slow' = 'ok'
  let release: (() => void) | null = null

  const api: MultichatTelegramApi = {
    sendMessage: async (chatId, text, opts) => {
      calls.push({ chatId, text, opts })
      if (behaviour === 'slow') {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return { ok: true, result: { message_id: calls.length } } as unknown as Awaited<
        ReturnType<MultichatTelegramApi['sendMessage']>
      >
    },
    sendChatAction: async () => {},
  }
  return {
    api,
    calls,
    setBehaviour: (b) => {
      behaviour = b
    },
    releaseSlow: () => {
      if (release !== null) {
        release()
        release = null
      }
    },
  }
}

// ──────────────────────────────────────────────────────────────────────
// Test fixture
// ──────────────────────────────────────────────────────────────────────

interface Fixture {
  tmpDir: string
  stateDir: string
  workspaceDir: string
  pool: FakePool
  telegram: ReturnType<typeof spyTelegramApi>
  loggerState: ReturnType<typeof capturingLogger>
}

function setupFixture(): Fixture {
  const tmpDir = mkdtempSync(join(tmpdir(), 'multichat-router-test-'))
  const stateDir = join(tmpDir, 'state')
  const workspaceDir = join(tmpDir, 'workspace')
  return {
    tmpDir,
    stateDir,
    workspaceDir,
    pool: new FakePool(),
    telegram: spyTelegramApi(),
    loggerState: capturingLogger(),
  }
}

function cleanupFixture(fx: Fixture): void {
  try {
    rmSync(fx.tmpDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
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

// ──────────────────────────────────────────────────────────────────────
// Bug 1 — policy gate before filesystem mutation
// ──────────────────────────────────────────────────────────────────────

describe('dispatch() policy gate (TASK-5 bug 1)', () => {
  let fx: Fixture

  beforeEach(() => {
    fx = setupFixture()
  })
  afterEach(() => {
    cleanupFixture(fx)
  })

  test('DM with chat absent from policy.chats: no dirs, no inbox, no spawn', async () => {
    // User IS in allowlist.users, but the chat itself is NOT in
    // policy.chats. The pre-fix code allowed this through because
    // it only checked allowlist.users for DMs and deferred the
    // chat-policy check to pool.spawnInternal — by which time
    // ensureChatStateDirs + writeToInbox had already created the
    // inbox dir + file on disk.
    const policy = makePolicy({
      chats: {}, // empty
      allowlist_users: ['164795011'],
      allowlist_chats: [],
    })
    const router = makeRouter(fx, policy)

    await router.dispatch({
      text: 'hi',
      chat_id: '164795011',
      user_id: '164795011',
      user: 'dashi',
      timestamp: '2026-05-27T00:00:00Z',
    })

    // No FS side effects.
    expect(existsSync(join(fx.stateDir, 'chats', '164795011'))).toBe(false)
    // No spawn attempt.
    expect(fx.pool.spawned).toEqual([])
    // Deny log emitted with both signals visible.
    const denies = fx.loggerState.logs.filter(
      (l) => l.level === 'warn' && l.msg === 'router.dispatch.denied',
    )
    expect(denies.length).toBe(1)
    expect(denies[0]?.ctx).toMatchObject({
      chat_id: '164795011',
      user_id: '164795011',
      has_chat_policy: false,
    })
  })

  test('DM present in policy.chats: dirs created, inbox written, spawn called', async () => {
    const policy = makePolicy({
      chats: { '164795011': makeChatPolicy() },
      allowlist_users: ['164795011'],
      allowlist_chats: ['164795011'],
    })
    const router = makeRouter(fx, policy)

    await router.dispatch({
      text: 'hi',
      chat_id: '164795011',
      user_id: '164795011',
      user: 'dashi',
      timestamp: '2026-05-27T00:00:00Z',
    })

    // Inbox dir + at least one .json file present.
    const inboxDir = join(fx.stateDir, 'chats', '164795011', 'inbox')
    expect(existsSync(inboxDir)).toBe(true)
    const inboxFiles = readdirSync(inboxDir).filter((n) => n.endsWith('.json'))
    expect(inboxFiles.length).toBe(1)
    // Spawn happened with the correct chat id.
    expect(fx.pool.spawned).toEqual(['164795011'])
    expect(fx.pool.touched).toEqual(['164795011'])
  })

  test('Group present but user not in allowlist: denied, no FS', async () => {
    const policy = makePolicy({
      chats: { '-1003784643974': makeChatPolicy({ mode: 'public' }) },
      allowlist_users: ['164795011'],
      allowlist_chats: ['-1003784643974'],
    })
    const router = makeRouter(fx, policy)

    await router.dispatch({
      text: 'hi from stranger',
      chat_id: '-1003784643974',
      user_id: '99999', // not in allowlist.users
      user: 'stranger',
      timestamp: '2026-05-27T00:00:00Z',
    })

    expect(existsSync(join(fx.stateDir, 'chats', '-1003784643974'))).toBe(false)
    expect(fx.pool.spawned).toEqual([])
    const denies = fx.loggerState.logs.filter(
      (l) => l.msg === 'router.dispatch.denied',
    )
    expect(denies.length).toBe(1)
    expect(denies[0]?.ctx).toMatchObject({
      user_in_allowlist: false,
      has_chat_policy: true,
    })
  })

  test('Group present and user allowlisted: flow proceeds', async () => {
    const policy = makePolicy({
      chats: { '-1003784643974': makeChatPolicy({ mode: 'public' }) },
      allowlist_users: ['164795011'],
      allowlist_chats: ['-1003784643974'],
    })
    const router = makeRouter(fx, policy)

    await router.dispatch({
      text: '@thrall ping',
      chat_id: '-1003784643974',
      user_id: '164795011',
      user: 'dashi',
      timestamp: '2026-05-27T00:00:00Z',
    })

    expect(existsSync(join(fx.stateDir, 'chats', '-1003784643974', 'inbox'))).toBe(
      true,
    )
    expect(fx.pool.spawned).toEqual(['-1003784643974'])
  })
})

// ──────────────────────────────────────────────────────────────────────
// Bug 4 — assertValidChatId at dispatch boundary
// ──────────────────────────────────────────────────────────────────────

describe('dispatch() chat_id validation (TASK-5 bug 4)', () => {
  let fx: Fixture
  beforeEach(() => {
    fx = setupFixture()
  })
  afterEach(() => {
    cleanupFixture(fx)
  })

  test('chat_id "abc" — drop, no FS, no crash', async () => {
    const policy = makePolicy({
      chats: { '164795011': makeChatPolicy() },
      allowlist_users: ['164795011'],
    })
    const router = makeRouter(fx, policy)

    await router.dispatch({
      text: 'x',
      chat_id: 'abc',
      user_id: '164795011',
      user: 'dashi',
      timestamp: '2026-05-27T00:00:00Z',
    })

    // No chats dir created — assertValidChatId killed it at the gate.
    expect(existsSync(join(fx.stateDir, 'chats'))).toBe(false)
    expect(fx.pool.spawned).toEqual([])
    const denies = fx.loggerState.logs.filter(
      (l) => l.msg === 'router.dispatch.invalid_chat_id',
    )
    expect(denies.length).toBe(1)
  })

  test('chat_id "../x" — drop, no path traversal, no crash', async () => {
    const policy = makePolicy({
      chats: { '164795011': makeChatPolicy() },
      allowlist_users: ['164795011'],
    })
    const router = makeRouter(fx, policy)

    await router.dispatch({
      text: 'x',
      chat_id: '../x',
      user_id: '164795011',
      user: 'dashi',
      timestamp: '2026-05-27T00:00:00Z',
    })

    expect(existsSync(join(fx.stateDir, 'chats'))).toBe(false)
    // Specifically verify nothing escaped above stateDir.
    expect(existsSync(join(fx.stateDir, '..', 'x'))).toBe(false)
    expect(fx.pool.spawned).toEqual([])
  })

  test('chat_id "1; rm" — drop', async () => {
    const policy = makePolicy({
      chats: { '164795011': makeChatPolicy() },
      allowlist_users: ['164795011'],
    })
    const router = makeRouter(fx, policy)

    await router.dispatch({
      text: 'x',
      chat_id: '1; rm',
      user_id: '164795011',
      user: 'dashi',
      timestamp: '2026-05-27T00:00:00Z',
    })

    expect(fx.pool.spawned).toEqual([])
    expect(
      fx.loggerState.logs.some((l) => l.msg === 'router.dispatch.invalid_chat_id'),
    ).toBe(true)
  })

  // ──────────────────────────────────────────────────────────────────
  // Opus MED-B #20 (2026-05-27): expanded chat_id edge cases at the
  // dispatch boundary. Each payload below MUST be dropped without
  // creating any chats directory and without crashing the dispatch
  // loop. The primitive (assertValidChatId) carries the rejection;
  // these tests assert that the router's catch block routes it to a
  // structured log + early return.
  // ──────────────────────────────────────────────────────────────────

  const MED_B_INVALID_CHAT_IDS: Array<{ name: string; chatId: string }> = [
    { name: 'absolute path (/etc/passwd)', chatId: '/etc/passwd' },
    { name: 'Windows traversal (..\\\\x)', chatId: '..\\x' },
    { name: 'single space', chatId: ' ' },
    { name: 'newline', chatId: '\n' },
    { name: 'float 1.5', chatId: '1.5' },
    { name: 'empty string', chatId: '' },
    { name: 'Infinity string', chatId: 'Infinity' },
    { name: 'negative zero', chatId: '-0' },
    { name: '4 KB digit smuggle', chatId: '1'.repeat(4096) },
  ]

  for (const { name, chatId } of MED_B_INVALID_CHAT_IDS) {
    test(`MED-B #20: chat_id ${name} — drop, no FS, structured log`, async () => {
      const policy = makePolicy({
        chats: { '164795011': makeChatPolicy() },
        allowlist_users: ['164795011'],
      })
      const router = makeRouter(fx, policy)

      await router.dispatch({
        text: 'x',
        chat_id: chatId,
        user_id: '164795011',
        user: 'dashi',
        timestamp: '2026-05-27T00:00:00Z',
      })

      // No chats dir created — primitive killed the dispatch.
      expect(existsSync(join(fx.stateDir, 'chats'))).toBe(false)
      expect(fx.pool.spawned).toEqual([])
      const invalidLogs = fx.loggerState.logs.filter(
        (l) => l.msg === 'router.dispatch.invalid_chat_id',
      )
      expect(invalidLogs.length).toBe(1)
      // Log MUST NOT echo the full smuggle payload (4 KB) verbatim —
      // the dispatch path truncates at 64 chars.
      const ctx = invalidLogs[0]?.ctx
      const echoed = typeof ctx?.chat_id === 'string' ? ctx.chat_id : ''
      expect(echoed.length).toBeLessThanOrEqual(64)
    })
  }
})

// ──────────────────────────────────────────────────────────────────────
// Bug 2 — outbox claim chat_id mismatch quarantine
// ──────────────────────────────────────────────────────────────────────

describe('deliverClaim chat_id mismatch (TASK-5 bug 2)', () => {
  let fx: Fixture
  beforeEach(() => {
    fx = setupFixture()
  })
  afterEach(() => {
    cleanupFixture(fx)
  })

  test('claim.message.chat_id !== owning chatId → quarantined, never sent', async () => {
    const ownerChat = '164795011'
    const policy = makePolicy({
      chats: { [ownerChat]: makeChatPolicy() },
      allowlist_users: ['164795011'],
    })
    const router = makeRouter(fx, policy)

    // Build the outbox structure manually and drop a mismatched claim
    // file. Then trigger one drain pass.
    const outboxDir = join(fx.stateDir, 'chats', ownerChat, 'outbox')
    await mkdir(join(outboxDir, 'processing'), { recursive: true })
    await mkdir(join(outboxDir, 'dead-letter'), { recursive: true })

    const file = `${Date.now()}-aaaa.json`
    // chat_id INSIDE the payload is a DIFFERENT chat — the bug we
    // fix. Pre-fix, the router would have sent this to ownerChat
    // anyway, leaking content addressed elsewhere.
    const payload = {
      text: 'leaked content',
      chat_id: '-1003784643974', // different from ownerChat
      timestamp: '2026-05-27T00:00:00Z',
    }
    await writeFile(join(outboxDir, file), JSON.stringify(payload))

    // Drive the outbox loop a single tick by calling startOutboxLoop
    // via dispatch + waiting a beat. Simpler: invoke drainOutbox
    // through start() which arms the loop, then wait a tick.
    await router.start()
    // Wait two poll intervals (200ms each) plus jitter.
    await new Promise((r) => setTimeout(r, 600))
    await router.stop()

    // sendMessage MUST NOT have been called.
    expect(fx.telegram.calls).toEqual([])

    // The mismatched file must have been quarantined.
    const mismatchedDir = join(outboxDir, 'mismatched')
    expect(existsSync(mismatchedDir)).toBe(true)
    const quarantined = readdirSync(mismatchedDir)
    // We expect: one moved payload file + one sidecar .mismatch.json
    const payloadFile = quarantined.find((n) => n.endsWith('.json') && !n.endsWith('.mismatch.json'))
    const sidecar = quarantined.find((n) => n.endsWith('.mismatch.json'))
    expect(payloadFile).toBeDefined()
    expect(sidecar).toBeDefined()

    // Sidecar carries both expected and actual chat ids.
    const sidecarRaw = readFileSync(join(mismatchedDir, sidecar as string), 'utf8')
    const sidecarMeta = JSON.parse(sidecarRaw) as Record<string, unknown>
    expect(sidecarMeta.expectedChatId).toBe(ownerChat)
    expect(sidecarMeta.actualChatId).toBe('-1003784643974')
    expect(sidecarMeta.reason).toBe('outbox_chat_mismatch')

    // Structured log line with the audit keyword.
    const mismatchLogs = fx.loggerState.logs.filter(
      (l) => l.msg === 'router.outbox.chat_mismatch',
    )
    expect(mismatchLogs.length).toBeGreaterThanOrEqual(1)
    expect(mismatchLogs[0]?.ctx?.outbox_chat_mismatch).toBe(true)
  }, 5_000)

  test('claim.message.chat_id === owning chatId → flows through to sendMessage', async () => {
    const ownerChat = '164795011'
    const policy = makePolicy({
      chats: { [ownerChat]: makeChatPolicy() },
      allowlist_users: ['164795011'],
    })
    const router = makeRouter(fx, policy)

    const outboxDir = join(fx.stateDir, 'chats', ownerChat, 'outbox')
    await mkdir(join(outboxDir, 'processing'), { recursive: true })

    const file = `${Date.now()}-bbbb.json`
    await writeFile(
      join(outboxDir, file),
      JSON.stringify({
        text: 'hello',
        chat_id: ownerChat,
        timestamp: '2026-05-27T00:00:00Z',
      }),
    )

    await router.start()
    await new Promise((r) => setTimeout(r, 600))
    await router.stop()

    expect(fx.telegram.calls.length).toBe(1)
    expect(fx.telegram.calls[0]?.chatId).toBe(ownerChat)
    expect(fx.telegram.calls[0]?.text).toBe('hello')
    expect(existsSync(join(outboxDir, 'mismatched'))).toBe(false)
  }, 5_000)
})

// ──────────────────────────────────────────────────────────────────────
// Bug 3 — concurrent drain guard
// ──────────────────────────────────────────────────────────────────────

describe('outbox drain concurrency guard (TASK-5 bug 3)', () => {
  let fx: Fixture
  beforeEach(() => {
    fx = setupFixture()
  })
  afterEach(() => {
    cleanupFixture(fx)
  })

  test('slow first drain in flight → second tick skips, single sendMessage call', async () => {
    // Opus MED-B #19 (2026-05-27): the previous version of this test
    // used real `setTimeout(800)` to wait through multiple 200 ms
    // poll ticks. On loaded CI the wall clock slipped and the
    // assertion `skipped >= 1` flaked.
    //
    // Fake timers (vi.useFakeTimers) do not work here because
    // pollOutboxOnce performs real libuv I/O (readdir, rename,
    // readFile) — those operations only resolve on a real event-loop
    // tick, not on Promise.resolve / process.nextTick / setImmediate
    // (the latter is also faked under vi.useFakeTimers). Fake timers
    // therefore wedge the drain indefinitely.
    //
    // The deterministic alternative: spy on global setInterval before
    // start(), capture the interval callback, and NEVER let it auto-
    // fire. We drive ticks by calling the captured callback by hand —
    // each invocation is observable, each one happens after we have
    // explicitly awaited the previous tick's work to settle (or
    // confirmed it is still in-flight). Real I/O completes naturally
    // between awaits; no wall-clock waits are required.
    const ownerChat = '164795011'
    const policy = makePolicy({
      chats: { [ownerChat]: makeChatPolicy() },
      allowlist_users: ['164795011'],
    })
    const router = makeRouter(fx, policy)

    // Configure the Telegram spy to block on the first call until
    // we explicitly release it.
    fx.telegram.setBehaviour('slow')

    const outboxDir = join(fx.stateDir, 'chats', ownerChat, 'outbox')
    await mkdir(join(outboxDir, 'processing'), { recursive: true })

    // Drop one claim. After the first drain claims it, subsequent
    // ticks must see `draining.has(chatId) === true` and skip — that
    // is the in-flight guard contract under test.
    const file = `${Date.now()}-cccc.json`
    await writeFile(
      join(outboxDir, file),
      JSON.stringify({
        text: 'slow',
        chat_id: ownerChat,
        timestamp: '2026-05-27T00:00:00Z',
      }),
    )

    // Capture the router's outbox interval callback by replacing
    // global setInterval with a recorder. We return a no-op handle
    // (with the unref shape the router calls) so the interval never
    // auto-fires; the captured callback is the function we hand-
    // invoke per "tick".
    const capturedTicks: Array<() => void> = []
    const originalSetInterval = globalThis.setInterval
    globalThis.setInterval = ((fn: () => void, _ms?: number): ReturnType<
      typeof setInterval
    > => {
      capturedTicks.push(fn)
      // Return an object shaped like a NodeJS.Timer so the router's
      // `.unref?.()` call and the eventual `clearInterval` no-op.
      return {
        ref: () => undefined,
        unref: () => undefined,
        hasRef: () => false,
        refresh: () => undefined,
        [Symbol.toPrimitive]: () => 0,
        [Symbol.dispose]: () => undefined,
      } as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval

    // Yield to the real event loop for `ms` milliseconds so libuv
    // I/O (readdir, rename, readFile) and the awaited sendMessage
    // entry callback can settle. We piggy-back on the captured
    // setInterval reference instead of using bare setTimeout — that
    // way if some future test swap also wraps setTimeout, this
    // helper still hits the real timer.
    const realDelay = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        const handle = originalSetInterval(() => {
          clearInterval(handle)
          resolve()
        }, ms)
      })

    try {
      await router.start()
      // The router installed its outbox interval — capturedTicks now
      // holds the tick callback.
      expect(capturedTicks.length).toBe(1)
      const tick = capturedTicks[0]
      if (tick === undefined) throw new Error('tick not captured')

      // Tick 1: drainOutbox runs, claims the file, calls sendMessage
      // (slow spy adds the call to `calls[]` synchronously before
      // awaiting `release`). The `draining` set holds the chat id
      // until the send resolves.
      tick()
      await realDelay(20) // let readdir/rename/readFile/send-entry settle

      expect(fx.telegram.calls.length).toBe(1)

      // Ticks 2..4: each one observes `draining.has(chatId) === true`
      // and logs `tick_skipped_inflight` without spawning a new
      // drain. No extra sendMessage calls.
      for (let i = 0; i < 3; i++) {
        tick()
        await realDelay(5)
      }
      expect(fx.telegram.calls.length).toBe(1)

      const skipped = fx.loggerState.logs.filter(
        (l) => l.msg === 'router.outbox.tick_skipped_inflight',
      )
      expect(skipped.length).toBeGreaterThanOrEqual(3)

      // Release the slow send so the drain completes, then let
      // confirmOutboxClaim run and `draining` clear.
      fx.telegram.releaseSlow()
      await realDelay(20)

      // Next tick should NOT be skipped — outbox is empty so
      // drainOutbox returns early without another send. Total send
      // count stays at 1.
      tick()
      await realDelay(10)
      expect(fx.telegram.calls.length).toBe(1)
    } finally {
      globalThis.setInterval = originalSetInterval
      await router.stop()
    }
  }, 5_000)
})
