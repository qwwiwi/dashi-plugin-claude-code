// Integration tests for the ask-guard choke point on the reply tool
// (autonomy M3). These exercise the REAL wiring in src/channel/tools.ts: the
// guard reads the per-chat autonomy registry, and only when an ACTIVE lease
// exists AND the outgoing body is a self-gating permission-ask does it
// intercept (block) or annotate (advisory). Everything else — no lease, a
// hard-gate ask, benign prose, the kill-switch — ships the reply unchanged.
//
// The harness mirrors tools.test.ts (a stub TelegramApi that records sends, a
// tmp state dir, a default AppConfig). The ASK_GUARD_* env vars are cleared in
// beforeEach and restored in afterEach so a stray global value can never leak
// between tests (resolveAskGuardMode reads process.env directly).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  callTool,
  type AnswerGuestQueryOpts,
  type CallToolRequest,
  type DownloadResult,
  type EditOpts,
  type SendDocumentOpts,
  type SendMessageOpts,
  type TelegramApi,
  type ToolDeps,
} from '../../src/channel/tools.js'
import type { AppConfig, StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import {
  addLease,
  emptyAutonomyState,
  saveAutonomyState,
} from '../../src/autonomy/store.js'

const silentLog = createLogger('test', { stream: { write: () => true } as unknown as NodeJS.WritableStream })

const CHAT = '164795011'
const HOUR = 3_600_000

interface SentRecord {
  chatId: string
  text: string
}

function makeRecordingApi(sent: SentRecord[]): TelegramApi {
  return {
    sendMessage: async (chatId: string, text: string, _opts: SendMessageOpts) => {
      sent.push({ chatId, text })
      return { message_id: 1 }
    },
    sendRichMessage: async () => ({ fallback: true as const }),
    editMessageText: async (_c: string, _m: number, _t: string, _o: EditOpts) => {},
    setMessageReaction: async (_c: string, _m: number, _e: string) => {},
    sendChatAction: async () => {},
    sendDocument: async (_c: string, _f: string, _o: SendDocumentOpts) => ({ message_id: 2 }),
    sendPhoto: async (_c: string, _f: string, _o: SendDocumentOpts) => ({ message_id: 3 }),
    downloadFile: async (_id: string, destDir: string): Promise<DownloadResult> => ({
      path: join(destDir, 'fake.bin'),
      size: 0,
    }),
    deleteMessage: async (_c: string, _m: number) => {},
    answerGuestQuery: async (_id: string, _t: string, _o: AnswerGuestQueryOpts) => {},
  }
}

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
    tmux_mirror: { enabled: false, pane_target: '', socket_name: '', poll_interval_ms: 5000, line_count: 50, hide_segments: [], mode: 'latest_inbound_only', max_lines: 14 },
    multichat: { enabled: false },
    ask_user_question: { enabled: false, timeout_ms: 300_000, max_preview_chars: 1000 },
    permission_gate: { enabled: false, timeout_ms: 120_000 },
    richMessages: { enabled: false, perChatOptOut: [] },
    ...overrides,
  }
}

function makeStatePaths(): StatePaths {
  const root = mkdtempSync(join(tmpdir(), 'dashi-ask-guard-tools-'))
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

function makeStubStatusManager(): ToolDeps['statusManager'] {
  return {
    isActive: () => false,
    activeChatIds: () => [],
    start: async () => ({ chatId: '0', messageId: 0, startedAt: 0 }),
    update: async () => {},
    updateByChatId: async () => {},
    complete: async () => {},
    cancel: async () => {},
  } as unknown as ToolDeps['statusManager']
}

// Seed an ACTIVE lease into the per-chat autonomy registry under `paths`.
function seedActiveLease(paths: StatePaths, chatId: string, nowMs: number): void {
  const { state } = addLease(
    emptyAutonomyState(),
    { scope: 'реализуй M3 ask-guard по порядку', expiresAtMs: nowMs + 4 * HOUR, source: 'owner_cmd', chatId },
    nowMs,
  )
  saveAutonomyState(paths, chatId, state)
}

function replyReq(text: string): CallToolRequest {
  return { params: { name: 'reply', arguments: { chat_id: CHAT, text } } }
}

let statePaths: StatePaths
let sent: SentRecord[]
let deps: ToolDeps
let savedEnabled: string | undefined
let savedMode: string | undefined

beforeEach(() => {
  statePaths = makeStatePaths()
  sent = []
  deps = {
    config: makeConfig(),
    statePaths,
    telegramApi: makeRecordingApi(sent),
    log: silentLog,
    statusManager: makeStubStatusManager(),
  }
  savedEnabled = process.env.ASK_GUARD_ENABLED
  savedMode = process.env.ASK_GUARD_MODE
  delete process.env.ASK_GUARD_ENABLED
  delete process.env.ASK_GUARD_MODE
})

afterEach(() => {
  rmSync(statePaths.root, { recursive: true, force: true })
  if (savedEnabled === undefined) delete process.env.ASK_GUARD_ENABLED
  else process.env.ASK_GUARD_ENABLED = savedEnabled
  if (savedMode === undefined) delete process.env.ASK_GUARD_MODE
  else process.env.ASK_GUARD_MODE = savedMode
})

function resultText(res: Awaited<ReturnType<typeof callTool>>): string {
  const first = res.content[0]
  return first !== undefined && first.type === 'text' ? first.text : ''
}

describe('ask-guard reply choke point — block mode', () => {
  test('blocks a self-gating ask when a lease is active: nothing sent, isError', async () => {
    process.env.ASK_GUARD_MODE = 'block'
    seedActiveLease(statePaths, CHAT, Date.now())
    const res = await callTool(replyReq('Всё собрано. Жду го, мой вождь.'), deps)
    expect(res.isError).toBe(true)
    expect(sent.length).toBe(0)
    expect(resultText(res)).toContain('ASK_GUARD')
    expect(resultText(res)).toContain('AskUserQuestion')
  })

  test('NO resend-valve: an identical re-send is blocked again', async () => {
    process.env.ASK_GUARD_MODE = 'block'
    seedActiveLease(statePaths, CHAT, Date.now())
    const first = await callTool(replyReq('жду го'), deps)
    const second = await callTool(replyReq('жду го'), deps)
    expect(first.isError).toBe(true)
    expect(second.isError).toBe(true)
    expect(sent.length).toBe(0)
  })

  test('block does NOT fire for a hard-gate ask (money) — reply ships', async () => {
    process.env.ASK_GUARD_MODE = 'block'
    seedActiveLease(statePaths, CHAT, Date.now())
    const res = await callTool(replyReq('жду го на списание денег'), deps)
    expect(res.isError).toBeUndefined()
    expect(sent.length).toBe(1)
  })

  test('block does NOT fire for benign prose — reply ships unchanged', async () => {
    process.env.ASK_GUARD_MODE = 'block'
    seedActiveLease(statePaths, CHAT, Date.now())
    const res = await callTool(replyReq('Готово, мой вождь. Код чист.'), deps)
    expect(res.isError).toBeUndefined()
    expect(sent.length).toBe(1)
    expect(resultText(res)).not.toContain('ask_guard_hint')
  })

  test('block does NOT fire without an active lease — reply ships', async () => {
    process.env.ASK_GUARD_MODE = 'block'
    // no lease seeded
    const res = await callTool(replyReq('жду го'), deps)
    expect(res.isError).toBeUndefined()
    expect(sent.length).toBe(1)
  })
})

describe('ask-guard reply choke point — advisory mode (default)', () => {
  test('ships the reply AND appends ask_guard_hint when lease active + self-gate', async () => {
    // default mode is advisory (no env, no config.ask_guard)
    seedActiveLease(statePaths, CHAT, Date.now())
    const res = await callTool(replyReq('жду го'), deps)
    expect(res.isError).toBeUndefined()
    expect(sent.length).toBe(1)
    expect(resultText(res)).toContain('ask_guard_hint')
  })

  test('no hint when there is no active lease', async () => {
    const res = await callTool(replyReq('жду го'), deps)
    expect(sent.length).toBe(1)
    expect(resultText(res)).not.toContain('ask_guard_hint')
  })

  test('no hint for a benign reply under an active lease', async () => {
    seedActiveLease(statePaths, CHAT, Date.now())
    const res = await callTool(replyReq('Готово. Порядок восстановлен.'), deps)
    expect(sent.length).toBe(1)
    expect(resultText(res)).not.toContain('ask_guard_hint')
  })
})

describe('ask-guard reply choke point — kill-switch', () => {
  test('ASK_GUARD_ENABLED=0 forces off: self-gate ships with no hint, even in block config', async () => {
    process.env.ASK_GUARD_ENABLED = '0'
    process.env.ASK_GUARD_MODE = 'block'
    seedActiveLease(statePaths, CHAT, Date.now())
    const res = await callTool(replyReq('жду го'), deps)
    expect(res.isError).toBeUndefined()
    expect(sent.length).toBe(1)
    expect(resultText(res)).not.toContain('ask_guard_hint')
  })
})

describe('ask-guard reply choke point — edit_message is NOT guarded', () => {
  test('edit_message with a self-gating body under an active lease is untouched', async () => {
    process.env.ASK_GUARD_MODE = 'block'
    seedActiveLease(statePaths, CHAT, Date.now())
    const res = await callTool(
      { params: { name: 'edit_message', arguments: { chat_id: CHAT, message_id: '42', text: 'жду го' } } },
      deps,
    )
    // edit_message path returns a plain "edited" ack, never the guard refusal.
    expect(res.isError).toBeUndefined()
    expect(resultText(res)).toContain('edited')
  })
})
