// StatusManager multichat-policy isolation tests (Codex review fix
// 2026-05-27, TASK-2 / CRITICAL #1 + HIGH #9).
//
// Pre-fix the manager was constructed with a single boolean
// `streamingEnabled`, computed from the warchief's chat id. If the
// warchief DM had `streaming: 'progress'`, every chat — including a
// public group with `streaming: 'off'` or a chat absent from policy
// entirely — implicitly inherited streaming. The new design passes a
// `policy` reference and gates per-chat with `shouldStreamForChat`,
// which is fail-CLOSED for missing chats and respects each entry's
// own `streaming` flag.
//
// Surface under test:
//   * start(chatId, …) for warchief vs. public group
//   * recordActivityByChatId(chatId, …) including the SessionStart
//     lazy-open path that previously bypassed all gates because the
//     entry did not yet exist
//   * Legacy null-policy mode still streams (single-DM deployments
//     must not regress)
//   * activeChatIds() reflects only chats that actually opened —
//     denied chats never appear and so shutdown sweeps stay quiet

import { describe, expect, test } from 'bun:test'

import {
  StatusManager,
  type TelegramApiForStatus,
} from '../../src/status/status-manager.js'
import type { AppConfig } from '../../src/config.js'
import {
  type ChatPolicy,
  type MultichatPolicy,
} from '../../src/chats/policy-loader.js'
import { createLogger } from '../../src/log.js'

const silentLog = createLogger('test', {
  stream: { write: () => true } as unknown as NodeJS.WritableStream,
})

const WARCHIEF = '164795011'
const PUBLIC_GROUP = '-1003784643974'
const UNLISTED = '999'

// Tight ChatPolicy fixture builder. Defaults: private DM, streaming +
// mirror ON. Tests flip `streaming` / `tmux_mirror` only.
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

function makePolicy(chats: Record<string, ChatPolicy>): MultichatPolicy {
  return {
    version: 1,
    allowlist: { chats: Object.keys(chats), users: [] },
    mention_allowlist: [],
    chats,
  }
}

function makeConfig(): AppConfig {
  return {
    bot_id: 8507713167,
    dm_only: false,
    allowed_user_ids: [164795011],
    allowed_chat_ids: [164795011, -1003784643974],
    status: {
      enabled: true,
      interval_ms: 700,
      ttl_ms: 300_000,
      delete_on_complete: true,
      suppress_typing_bubble: false,
    },
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
    tmux_mirror: { enabled: false, pane_target: '', poll_interval_ms: 5000, line_count: 50, hide_segments: ['boot_banner', 'inbound_warning', 'footer_hints', 'input_box'], mode: 'latest_inbound_only', max_lines: 14 },
    multichat: { enabled: false },
    ask_user_question: { enabled: false, timeout_ms: 300_000, max_preview_chars: 1000 },
  }
}

interface FakeTimer {
  id: number
  deadline: number
  cb: () => void
  fired: boolean
}

class FakeClock {
  now = 0
  next = 1
  timers: FakeTimer[] = []
  setTimer = (cb: () => void, ms: number): NodeJS.Timeout => {
    const t: FakeTimer = { id: this.next++, deadline: this.now + ms, cb, fired: false }
    this.timers.push(t)
    return t as unknown as NodeJS.Timeout
  }
  clearTimer = (handle: NodeJS.Timeout): void => {
    const t = handle as unknown as FakeTimer
    t.fired = true
  }
  advance(ms: number): void {
    const deadline = this.now + ms
    while (true) {
      const due = this.timers
        .filter((t) => !t.fired && t.deadline <= deadline)
        .sort((a, b) => a.deadline - b.deadline)[0]
      if (!due) break
      this.now = due.deadline
      due.fired = true
      due.cb()
    }
    this.now = deadline
  }
}

interface ApiCall {
  kind: 'send' | 'edit' | 'delete' | 'chat_action'
  chatId: string
  messageId?: number
  text?: string
  action?: string
}

interface FakeApi {
  api: TelegramApiForStatus
  calls: ApiCall[]
  nextMessageId: number
}

function makeFakeApi(): FakeApi {
  const state: FakeApi = {
    calls: [],
    nextMessageId: 100,
    api: undefined as unknown as TelegramApiForStatus,
  }
  state.api = {
    sendMessage: async (chatId: string, text: string, _opts: unknown) => {
      const id = state.nextMessageId++
      state.calls.push({ kind: 'send', chatId, messageId: id, text })
      return { message_id: id }
    },
    editMessageText: async (chatId: string, messageId: number, text: string, _opts: unknown) => {
      state.calls.push({ kind: 'edit', chatId, messageId, text })
    },
    deleteMessage: async (chatId: string, messageId: number) => {
      state.calls.push({ kind: 'delete', chatId, messageId })
    },
    sendChatAction: async (chatId: string, action: string) => {
      state.calls.push({ kind: 'chat_action', chatId, action })
    },
  }
  return state
}

function makeManager(opts: {
  policy: MultichatPolicy | null
  clock?: FakeClock
  api?: FakeApi
}) {
  const clock = opts.clock ?? new FakeClock()
  const api = opts.api ?? makeFakeApi()
  const config = makeConfig()
  const mgr = new StatusManager({
    telegramApi: api.api,
    config,
    log: silentLog,
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    policy: opts.policy,
  })
  return { mgr, clock, api, config }
}

// ─────────────────────────────────────────────────────────────────────
// Policy-loaded scenarios — the manager must isolate per-chat
// decisions even when sharing a single instance across all chats.
// ─────────────────────────────────────────────────────────────────────

describe('StatusManager multichat policy isolation', () => {
  test('warchief chat with streaming=progress sends bubble; public group with streaming=off does not', async () => {
    const policy = makePolicy({
      [WARCHIEF]: makeChatPolicy({ streaming: 'progress' }),
      [PUBLIC_GROUP]: makeChatPolicy({ streaming: 'off', mode: 'public' }),
    })
    const { mgr, api } = makeManager({ policy })

    const wHandle = await mgr.start(WARCHIEF, undefined)
    const pHandle = await mgr.start(PUBLIC_GROUP, undefined)

    // Warchief: real message id, entry tracked, network send fired.
    expect(wHandle.messageId).toBe(100)
    expect(mgr.isActive(WARCHIEF)).toBe(true)
    const wSends = api.calls.filter(
      (c) => c.kind === 'send' && c.chatId === WARCHIEF,
    )
    expect(wSends.length).toBe(1)

    // Public group: sentinel handle, entry NOT tracked, zero traffic.
    expect(pHandle.messageId).toBe(0)
    expect(mgr.isActive(PUBLIC_GROUP)).toBe(false)
    const pCalls = api.calls.filter((c) => c.chatId === PUBLIC_GROUP)
    expect(pCalls.length).toBe(0)
  })

  test('chat absent from policy is fail-CLOSED (no send, no chat_action)', async () => {
    // Regression for HIGH #9: pre-fix `shouldStream()` returned `true`
    // for a missing chat entry — an unlisted group would inherit
    // streaming from the legacy fail-open default. Now it must be a
    // total no-op.
    const policy = makePolicy({
      [WARCHIEF]: makeChatPolicy({ streaming: 'progress' }),
    })
    const { mgr, api } = makeManager({ policy })

    const handle = await mgr.start(UNLISTED, undefined)
    expect(handle.messageId).toBe(0)
    expect(mgr.isActive(UNLISTED)).toBe(false)
    expect(api.calls.length).toBe(0)
  })

  test('recordActivityByChatId on public group with streaming=off is a no-op', async () => {
    const policy = makePolicy({
      [WARCHIEF]: makeChatPolicy({ streaming: 'progress' }),
      [PUBLIC_GROUP]: makeChatPolicy({ streaming: 'off', mode: 'public' }),
    })
    const { mgr, api } = makeManager({ policy })

    // SessionStart on a denied chat must NOT lazy-open a bubble.
    await mgr.recordActivityByChatId(PUBLIC_GROUP, { kind: 'session_start' })
    expect(mgr.isActive(PUBLIC_GROUP)).toBe(false)
    expect(api.calls.length).toBe(0)

    // A tool_start hook for the same chat: same silence.
    await mgr.recordActivityByChatId(PUBLIC_GROUP, {
      kind: 'tool_start',
      toolName: 'Bash',
      toolInput: { command: 'echo leak-canary' },
      toolUseId: 'u1',
    })
    expect(api.calls.length).toBe(0)
    expect(mgr.isActive(PUBLIC_GROUP)).toBe(false)
  })

  test('recordActivityByChatId on chat absent from policy is fail-closed (no lazy-open)', async () => {
    const policy = makePolicy({
      [WARCHIEF]: makeChatPolicy({ streaming: 'progress' }),
    })
    const { mgr, api } = makeManager({ policy })

    // The lazy-open branch in recordActivityByChatId previously did
    // not consult any per-chat policy. It must now refuse missing
    // chats up front.
    await mgr.recordActivityByChatId(UNLISTED, { kind: 'session_start' })
    await mgr.recordActivityByChatId(UNLISTED, { kind: 'reasoning' })
    expect(api.calls.length).toBe(0)
    expect(mgr.isActive(UNLISTED)).toBe(false)
  })

  test('warchief streaming continues to work alongside denied public group', async () => {
    // Smoke test that the gate does not break the happy path: a
    // shared manager handling both chats keeps emitting warchief
    // edits while staying silent for the public group.
    const policy = makePolicy({
      [WARCHIEF]: makeChatPolicy({ streaming: 'progress' }),
      [PUBLIC_GROUP]: makeChatPolicy({ streaming: 'off', mode: 'public' }),
    })
    const { mgr, api } = makeManager({ policy })

    await mgr.start(WARCHIEF, undefined)
    await mgr.start(PUBLIC_GROUP, undefined)
    await mgr.updateByChatId(WARCHIEF, { kind: 'thinking' })
    await mgr.updateByChatId(PUBLIC_GROUP, { kind: 'thinking' })

    const wEdits = api.calls.filter(
      (c) => c.kind === 'edit' && c.chatId === WARCHIEF,
    )
    const pEdits = api.calls.filter(
      (c) => c.kind === 'edit' && c.chatId === PUBLIC_GROUP,
    )
    expect(wEdits.length).toBeGreaterThan(0)
    expect(pEdits.length).toBe(0)
  })

  test('activeChatIds() only includes chats that were actually allowed to open', async () => {
    const policy = makePolicy({
      [WARCHIEF]: makeChatPolicy({ streaming: 'progress' }),
      [PUBLIC_GROUP]: makeChatPolicy({ streaming: 'off', mode: 'public' }),
    })
    const { mgr } = makeManager({ policy })

    await mgr.start(WARCHIEF, undefined)
    await mgr.start(PUBLIC_GROUP, undefined)
    await mgr.start(UNLISTED, undefined)

    // The shutdown sweep iterates activeChatIds() and calls cancel()
    // on each — denied chats must not appear so the sweep doesn't
    // try to surface an `Остановлено: shutdown` bubble in a chat the
    // bot was told not to write to.
    expect(mgr.activeChatIds()).toEqual([WARCHIEF])
  })

  test('complete() and cancel() on denied chat are silent no-ops', async () => {
    // The MCP `status` tool and `/stop` command both invoke complete/
    // cancel via chat_id. For a chat that never opened (denied at
    // start), entries.get returns undefined and the methods are
    // idempotent no-ops — verify nothing slips into the wire.
    const policy = makePolicy({
      [WARCHIEF]: makeChatPolicy({ streaming: 'progress' }),
      [PUBLIC_GROUP]: makeChatPolicy({ streaming: 'off', mode: 'public' }),
    })
    const { mgr, api } = makeManager({ policy })

    await mgr.start(PUBLIC_GROUP, undefined)
    await mgr.complete(PUBLIC_GROUP)
    await mgr.cancel(PUBLIC_GROUP, 'user stop')
    expect(api.calls.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Legacy single-DM mode — policy === null must preserve historical
// behaviour (every chat streams). Existing deployments without a
// multichat policy file must not regress.
// ─────────────────────────────────────────────────────────────────────

describe('StatusManager legacy null-policy mode', () => {
  test('null policy: start(any_chat) sends bubble (legacy behaviour preserved)', async () => {
    const { mgr, api } = makeManager({ policy: null })
    const handle = await mgr.start(WARCHIEF, undefined)
    expect(handle.messageId).toBe(100)
    expect(mgr.isActive(WARCHIEF)).toBe(true)
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(1)
  })

  test('null policy: even an arbitrary chat id streams (no fail-closed in legacy mode)', async () => {
    const { mgr, api } = makeManager({ policy: null })
    await mgr.start('42', undefined)
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(1)
  })

  test('omitting `policy` in deps defaults to null (legacy behaviour)', async () => {
    // The constructor accepts an optional `policy`; absence must be
    // treated identically to `policy: null`. Guard regression where a
    // missing dep silently defaults to denying every chat.
    const config = makeConfig()
    const api = makeFakeApi()
    const clock = new FakeClock()
    const mgr = new StatusManager({
      telegramApi: api.api,
      config,
      log: silentLog,
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      // `policy` deliberately omitted.
    })
    await mgr.start(WARCHIEF, undefined)
    expect(mgr.isActive(WARCHIEF)).toBe(true)
    expect(api.calls.filter((c) => c.kind === 'send').length).toBe(1)
  })
})
