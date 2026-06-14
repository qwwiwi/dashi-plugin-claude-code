// Integration tests for the M1 rich-message path.
//
// Two layers under test:
//   1. createSafeTelegramApi.sendRichMessage — redaction BEFORE the raw send,
//      error classification → fallback/latch/re-throw.
//   2. callTool('reply', …) rich decision gate — when rich is attempted vs
//      skipped, and the no-duplicate / no-loss invariant on every branch.
//
// We stub the INNER TelegramApi (the rate-limited layer) rather than grammY,
// so the test is decoupled from transport. The reply path is driven through
// the real createSafeTelegramApi so redaction + classification run for real.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  callTool,
  type CallToolRequest,
  type DownloadResult,
  type EditOpts,
  type SendDocumentOpts,
  type SendMessageOpts,
  type SendRichMessageOpts,
  type SendRichMessageResult,
  type TelegramApi,
  type ToolDeps,
} from '../../src/channel/tools.js'
import type { AppConfig, StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import { createSafeTelegramApi } from '../../src/safety/safe-telegram-api.js'
import { createRichLatch } from '../../src/safety/rich-latch.js'

const silentLog = createLogger('test', {
  stream: { write: () => true } as unknown as NodeJS.WritableStream,
})

const PRINCE_DM = '164795011' // positive id ⇒ DM
const GROUP = '-1001234567890' // negative id ⇒ group (M1 must skip)

// ─── Stub inner TelegramApi (records calls, programmable rich behaviour) ──

interface Recorder {
  sendMessage: Array<{ chatId: string; text: string; opts: SendMessageOpts }>
  sendRich: Array<{ chatId: string; rawMarkdown: string; opts: SendRichMessageOpts }>
}

function makeInnerApi(
  recorder: Recorder,
  richBehaviour: () => Promise<SendRichMessageResult>,
): TelegramApi {
  let nextId = 1000
  return {
    async sendMessage(chatId, text, opts) {
      recorder.sendMessage.push({ chatId, text, opts })
      return { message_id: nextId++ }
    },
    async sendRichMessage(chatId, rawMarkdown, opts) {
      recorder.sendRich.push({ chatId, rawMarkdown, opts })
      return richBehaviour()
    },
    async editMessageText(_chatId, _messageId, _text, _opts: EditOpts) {},
    async setMessageReaction(_chatId, _messageId, _emoji) {},
    async sendChatAction() {},
    async sendDocument(_chatId, _filePath, _opts: SendDocumentOpts) {
      return { message_id: nextId++ }
    },
    async sendPhoto(_chatId, _filePath, _opts: SendDocumentOpts) {
      return { message_id: nextId++ }
    },
    async downloadFile(_fileId, destDir): Promise<DownloadResult> {
      return { path: join(destDir, 'x.bin'), size: 0 }
    },
    async deleteMessage(_chatId, _messageId) {},
  }
}

function emptyRecorder(): Recorder {
  return { sendMessage: [], sendRich: [] }
}

// ─── Config / deps fixtures ──────────────────────────────────────────────

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    bot_id: 8507713167,
    dm_only: true,
    allowed_user_ids: [164795011],
    allowed_chat_ids: [164795011, -1001234567890],
    status: { enabled: false, interval_ms: 700, ttl_ms: 300_000, delete_on_complete: true, suppress_typing_bubble: true },
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
    richMessages: { enabled: true, perChatOptOut: [] },
    ...overrides,
  }
}

function makeStatePaths(): StatePaths {
  const root = mkdtempSync(join(tmpdir(), 'dashi-rich-path-test-'))
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
      permission_gate: join(root, 'logs', 'permission-gate.jsonl'),
    },
  }
}

function makeStatusManager(): ToolDeps['statusManager'] {
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

interface Harness {
  deps: ToolDeps
  recorder: Recorder
  latch: ReturnType<typeof createRichLatch>
  cleanup: () => void
}

function makeHarness(opts: {
  config?: Partial<AppConfig>
  richBehaviour?: () => Promise<SendRichMessageResult>
  extraSecrets?: string[]
}): Harness {
  const recorder = emptyRecorder()
  const latch = createRichLatch()
  const inner = makeInnerApi(
    recorder,
    opts.richBehaviour ?? (async () => ({ message_id: 5555 })),
  )
  // Real safe wrapper so redaction + classification run for real.
  const telegramApi = createSafeTelegramApi(inner, silentLog, opts.extraSecrets, latch)
  const statePaths = makeStatePaths()
  const deps: ToolDeps = {
    config: makeConfig(opts.config),
    statePaths,
    telegramApi,
    log: silentLog,
    statusManager: makeStatusManager(),
    richLatch: latch,
  }
  return {
    deps,
    recorder,
    latch,
    cleanup: () => rmSync(statePaths.root, { recursive: true, force: true }),
  }
}

function replyReq(args: Record<string, unknown>): CallToolRequest {
  return { params: { name: 'reply', arguments: args } }
}

// ─── safe wrapper: redaction + classification ─────────────────────────────

describe('safe-telegram-api.sendRichMessage', () => {
  test('redacts a planted secret in raw markdown BEFORE the raw call', async () => {
    const recorder = emptyRecorder()
    const latch = createRichLatch()
    const inner = makeInnerApi(recorder, async () => ({ message_id: 7 }))
    const safe = createSafeTelegramApi(inner, silentLog, undefined, latch)

    const res = await safe.sendRichMessage(
      PRINCE_DM,
      'token sk-abcdefghijklmnopqrstuvwxyz0123456789',
      {},
    )

    expect(res).toEqual({ message_id: 7 })
    expect(recorder.sendRich).toHaveLength(1)
    // The raw layer must NOT have seen the secret.
    expect(recorder.sendRich[0]?.rawMarkdown).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    expect(recorder.sendRich[0]?.rawMarkdown).toContain('[REDACTED]')
  })

  test('capability error → {fallback:true}, latch set, second call short-circuits', async () => {
    const recorder = emptyRecorder()
    const latch = createRichLatch()
    const inner = makeInnerApi(recorder, async () => {
      throw { error_code: 404, description: 'Not Found' }
    })
    const safe = createSafeTelegramApi(inner, silentLog, undefined, latch)

    const first = await safe.sendRichMessage(PRINCE_DM, 'hi', {})
    expect(first).toEqual({ fallback: true })
    expect(latch.sendDisabled).toBe(true)
    expect(recorder.sendRich).toHaveLength(1)

    // Second call must short-circuit WITHOUT touching the raw layer again.
    const second = await safe.sendRichMessage(PRINCE_DM, 'hi again', {})
    expect(second).toEqual({ fallback: true })
    expect(recorder.sendRich).toHaveLength(1) // unchanged — short-circuited
  })

  test('parser error → {fallback:true}, latch NOT set', async () => {
    const recorder = emptyRecorder()
    const latch = createRichLatch()
    const inner = makeInnerApi(recorder, async () => {
      throw { error_code: 400, description: "Bad Request: can't parse entities" }
    })
    const safe = createSafeTelegramApi(inner, silentLog, undefined, latch)

    const res = await safe.sendRichMessage(PRINCE_DM, 'oops', {})
    expect(res).toEqual({ fallback: true })
    expect(latch.sendDisabled).toBe(false) // one-off; not latched
  })

  test('transient error → throws (no swallow, no resend), latch NOT set', async () => {
    const recorder = emptyRecorder()
    const latch = createRichLatch()
    const inner = makeInnerApi(recorder, async () => {
      throw { error_code: 500, description: 'Internal Server Error' }
    })
    const safe = createSafeTelegramApi(inner, silentLog, undefined, latch)

    await expect(safe.sendRichMessage(PRINCE_DM, 'x', {})).rejects.toBeDefined()
    expect(latch.sendDisabled).toBe(false)
  })

  test('no latch wired → always reports fallback without hitting raw', async () => {
    const recorder = emptyRecorder()
    const inner = makeInnerApi(recorder, async () => ({ message_id: 1 }))
    const safe = createSafeTelegramApi(inner, silentLog, undefined, undefined)

    const res = await safe.sendRichMessage(PRINCE_DM, 'x', {})
    expect(res).toEqual({ fallback: true })
    expect(recorder.sendRich).toHaveLength(0)
  })
})

// ─── reply tool: rich decision gate + no-dup / no-loss invariant ──────────

describe("callTool('reply') rich gate", () => {
  test('happy path: one sendRichMessage, returns id, NO chunked sendMessage', async () => {
    const h = makeHarness({ richBehaviour: async () => ({ message_id: 4242 }) })
    const result = await callTool(replyReq({ chat_id: PRINCE_DM, text: '# Hi\n\n| a | b |' }), h.deps)

    expect(result.isError).toBeUndefined()
    expect(h.recorder.sendRich).toHaveLength(1)
    expect(h.recorder.sendMessage).toHaveLength(0) // no chunking — no dup
    expect(result.content[0]?.text).toContain('4242')
    h.cleanup()
  })

  test('rich fallback → exactly ONE HTML send, no duplicate', async () => {
    const h = makeHarness({ richBehaviour: async () => ({ fallback: true }) })
    const result = await callTool(replyReq({ chat_id: PRINCE_DM, text: 'plain body' }), h.deps)

    expect(result.isError).toBeUndefined()
    expect(h.recorder.sendRich).toHaveLength(1) // attempted …
    expect(h.recorder.sendMessage).toHaveLength(1) // … then HTML path, once
    // HTML path uses parse_mode HTML.
    expect(h.recorder.sendMessage[0]?.opts.parse_mode).toBe('HTML')
    h.cleanup()
  })

  test('transient error during rich → throws up as tool error, NO HTML duplicate', async () => {
    const h = makeHarness({
      richBehaviour: async () => {
        throw { error_code: 503, description: 'Service Unavailable' }
      },
    })
    const result = await callTool(replyReq({ chat_id: PRINCE_DM, text: 'body' }), h.deps)

    // The outer try in callTool turns the thrown transient into a tool error.
    expect(result.isError).toBe(true)
    // CRITICAL: no fallback HTML send happened — we must not double-send.
    expect(h.recorder.sendMessage).toHaveLength(0)
    h.cleanup()
  })

  test("format 'text' → rich NOT attempted, plain send", async () => {
    const h = makeHarness({})
    const result = await callTool(
      replyReq({ chat_id: PRINCE_DM, text: 'verbatim', format: 'text' }),
      h.deps,
    )
    expect(result.isError).toBeUndefined()
    expect(h.recorder.sendRich).toHaveLength(0)
    expect(h.recorder.sendMessage).toHaveLength(1)
    expect(h.recorder.sendMessage[0]?.opts.parse_mode).toBeUndefined()
    h.cleanup()
  })

  test("format 'markdownv2' → rich NOT attempted", async () => {
    const h = makeHarness({})
    const result = await callTool(
      replyReq({ chat_id: PRINCE_DM, text: '*md*', format: 'markdownv2' }),
      h.deps,
    )
    expect(result.isError).toBeUndefined()
    expect(h.recorder.sendRich).toHaveLength(0)
    expect(h.recorder.sendMessage).toHaveLength(1)
    expect(h.recorder.sendMessage[0]?.opts.parse_mode).toBe('MarkdownV2')
    h.cleanup()
  })

  test('> 32768 bytes → rich skipped, HTML path used', async () => {
    const h = makeHarness({})
    const huge = 'a'.repeat(32769)
    const result = await callTool(replyReq({ chat_id: PRINCE_DM, text: huge }), h.deps)
    expect(result.isError).toBeUndefined()
    expect(h.recorder.sendRich).toHaveLength(0)
    expect(h.recorder.sendMessage.length).toBeGreaterThanOrEqual(1) // chunked HTML
    h.cleanup()
  })

  test('perChatOptOut chat → rich skipped', async () => {
    const h = makeHarness({ config: { richMessages: { enabled: true, perChatOptOut: [PRINCE_DM] } } })
    const result = await callTool(replyReq({ chat_id: PRINCE_DM, text: 'hi' }), h.deps)
    expect(result.isError).toBeUndefined()
    expect(h.recorder.sendRich).toHaveLength(0)
    expect(h.recorder.sendMessage).toHaveLength(1)
    h.cleanup()
  })

  test('richMessages.enabled=false → rich skipped', async () => {
    const h = makeHarness({ config: { richMessages: { enabled: false, perChatOptOut: [] } } })
    const result = await callTool(replyReq({ chat_id: PRINCE_DM, text: 'hi' }), h.deps)
    expect(result.isError).toBeUndefined()
    expect(h.recorder.sendRich).toHaveLength(0)
    expect(h.recorder.sendMessage).toHaveLength(1)
    h.cleanup()
  })

  test('latch already disabled → rich skipped (no raw call)', async () => {
    const h = makeHarness({})
    h.latch.sendDisabled = true
    const result = await callTool(replyReq({ chat_id: PRINCE_DM, text: 'hi' }), h.deps)
    expect(result.isError).toBeUndefined()
    expect(h.recorder.sendRich).toHaveLength(0)
    expect(h.recorder.sendMessage).toHaveLength(1)
    h.cleanup()
  })

  test('files present → rich skipped (text+attachment goes legacy path)', async () => {
    // No workspace_root → attachment resolution rejects, but the point is that
    // rich is never attempted when files are present. Assert no rich call.
    const h = makeHarness({})
    await callTool(
      replyReq({ chat_id: PRINCE_DM, text: 'with file', files: ['/etc/hosts'] }),
      h.deps,
    )
    // Reply errors on the unresolved file (no workspace_root) — that's fine;
    // the invariant under test is that the rich path was NOT taken.
    expect(h.recorder.sendRich).toHaveLength(0)
    h.cleanup()
  })

  test('group chat (negative id) → rich skipped (M1 DM-only), HTML used', async () => {
    const h = makeHarness({})
    const result = await callTool(replyReq({ chat_id: GROUP, text: '# heading' }), h.deps)
    expect(result.isError).toBeUndefined()
    expect(h.recorder.sendRich).toHaveLength(0)
    expect(h.recorder.sendMessage.length).toBeGreaterThanOrEqual(1)
    h.cleanup()
  })

  test('reply_to threads the rich message via reply_to_message_id', async () => {
    const h = makeHarness({ richBehaviour: async () => ({ message_id: 11 }) })
    await callTool(replyReq({ chat_id: PRINCE_DM, text: 'hi', reply_to: '321' }), h.deps)
    expect(h.recorder.sendRich).toHaveLength(1)
    expect(h.recorder.sendRich[0]?.opts.reply_to_message_id).toBe(321)
    h.cleanup()
  })

  test('redaction end-to-end: secret in reply text never reaches raw rich call', async () => {
    const h = makeHarness({ richBehaviour: async () => ({ message_id: 1 }) })
    await callTool(
      replyReq({ chat_id: PRINCE_DM, text: 'my key sk-abcdefghijklmnopqrstuvwxyz0123456789 ok' }),
      h.deps,
    )
    expect(h.recorder.sendRich).toHaveLength(1)
    expect(h.recorder.sendRich[0]?.rawMarkdown).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    expect(h.recorder.sendRich[0]?.rawMarkdown).toContain('[REDACTED]')
    h.cleanup()
  })
})
