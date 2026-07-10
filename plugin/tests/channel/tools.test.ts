import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  callTool,
  listTools,
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

// Silent logger to keep test output clean.
const silentLog = createLogger('test', { stream: { write: () => true } as unknown as NodeJS.WritableStream })

function makeStubApi(overrides: Partial<TelegramApi> = {}): TelegramApi {
  return {
    sendMessage: async (_chatId: string, _text: string, _opts: SendMessageOpts) => ({ message_id: 1 }),
    // Default rich stub reports fallback so legacy reply tests (richMessages
    // disabled in makeConfig) never accidentally exercise the rich path.
    sendRichMessage: async () => ({ fallback: true as const }),
    editMessageText: async (_chatId: string, _messageId: number, _text: string, _opts: EditOpts) => {
      /* noop */
    },
    setMessageReaction: async (_chatId: string, _messageId: number, _emoji: string) => {
      /* noop */
    },
    sendChatAction: async () => {
      /* noop */
    },
    sendDocument: async (_chatId: string, _filePath: string, _opts: SendDocumentOpts) => ({ message_id: 2 }),
    sendPhoto: async (_chatId: string, _filePath: string, _opts: SendDocumentOpts) => ({ message_id: 3 }),
    downloadFile: async (_fileId: string, destDir: string): Promise<DownloadResult> => ({
      path: join(destDir, 'fake.bin'),
      size: 0,
    }),
    deleteMessage: async (_chatId: string, _messageId: number) => {
      /* noop */
    },
    answerGuestQuery: async (_guestQueryId: string, _text: string, _opts: AnswerGuestQueryOpts) => {
      /* noop */
    },
    ...overrides,
  }
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    bot_id: 8507713167,
    dm_only: true,
    allowed_user_ids: [164795011],
    allowed_chat_ids: [164795011],
    status: { enabled: true, interval_ms: 700, ttl_ms: 300_000, delete_on_complete: true, suppress_typing_bubble: false },
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
    tmux_mirror: { enabled: false, pane_target: '', socket_name: '', poll_interval_ms: 5000, line_count: 50, hide_segments: ['boot_banner', 'inbound_warning', 'footer_hints', 'input_box'], mode: 'latest_inbound_only', max_lines: 14 },
    multichat: { enabled: false },
    ask_user_question: { enabled: false, timeout_ms: 300_000, max_preview_chars: 1000 },
    permission_gate: { enabled: false, timeout_ms: 120_000 },
    richMessages: { enabled: false, perChatOptOut: [] },
    ...overrides,
  }
}

function makeStatePaths(): StatePaths {
  const root = mkdtempSync(join(tmpdir(), 'dashi-channel-tools-test-'))
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

// Inert StatusManager stub for tests that don't exercise status flow.
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

function makeDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    config: makeConfig(),
    statePaths: makeStatePaths(),
    telegramApi: makeStubApi(),
    log: silentLog,
    statusManager: makeStubStatusManager(),
    ...overrides,
  }
}

function callReq(name: string, args: Record<string, unknown>): CallToolRequest {
  return { params: { name, arguments: args } }
}

describe('listTools', () => {
  test('returns 6 tools with stable order: reply, react, download_attachment, edit_message, status, autonomy', () => {
    const tools = listTools()
    expect(tools.map(t => t.name)).toEqual([
      'reply',
      'react',
      'download_attachment',
      'edit_message',
      'status',
      'autonomy',
    ])
  })

  test('autonomy tool input schema requires chat_id and action', () => {
    const autonomy = listTools().find(t => t.name === 'autonomy')
    expect(autonomy?.inputSchema.required).toEqual(['chat_id', 'action'])
  })

  test('reply tool input schema requires chat_id and text', () => {
    const reply = listTools().find(t => t.name === 'reply')
    expect(reply?.inputSchema.required).toEqual(['chat_id', 'text'])
  })
})

describe('callTool', () => {
  test('status tool no-ops cleanly when no active session (returns no-op content)', async () => {
    const deps = makeDeps()
    const result = await callTool(
      callReq('status', { chat_id: '164795011', state: 'thinking' }),
      deps,
    )
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('no-op')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('status tool rejects missing state via zod', async () => {
    const deps = makeDeps()
    const result = await callTool(callReq('status', { chat_id: '164795011' }), deps)
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('state')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('status tool with state=tool requires tool_name', async () => {
    let active = true
    const stubMgr = {
      isActive: () => active,
      activeChatIds: () => ['164795011'],
      start: async () => ({ chatId: '164795011', messageId: 1, startedAt: 0 }),
      update: async () => {},
      updateByChatId: async () => {},
      complete: async () => { active = false },
      cancel: async () => { active = false },
    } as unknown as ToolDeps['statusManager']
    const deps = makeDeps({ statusManager: stubMgr })
    const result = await callTool(
      callReq('status', { chat_id: '164795011', state: 'tool' }),
      deps,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('tool_name')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('status tool routes stopped to manager.cancel', async () => {
    const calls: string[] = []
    const stubMgr = {
      isActive: () => true,
      activeChatIds: () => ['164795011'],
      start: async () => ({ chatId: '164795011', messageId: 1, startedAt: 0 }),
      update: async () => { calls.push('update') },
      updateByChatId: async () => { calls.push('updateByChatId') },
      complete: async () => { calls.push('complete') },
      cancel: async (_id: string, reason: string) => { calls.push(`cancel:${reason}`) },
    } as unknown as ToolDeps['statusManager']
    const deps = makeDeps({ statusManager: stubMgr })
    const result = await callTool(
      callReq('status', { chat_id: '164795011', state: 'stopped', reason: 'oops' }),
      deps,
    )
    expect(result.isError).toBeUndefined()
    expect(calls).toContain('cancel:oops')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('unknown tool name returns isError content', async () => {
    const deps = makeDeps()
    const result = await callTool(callReq('does_not_exist', {}), deps)
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('unknown tool')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('reply with files when workspace_root absent rejects with clear tool error', async () => {
    const deps = makeDeps()
    expect(deps.config.workspace_root).toBeUndefined()
    const result = await callTool(
      callReq('reply', {
        chat_id: '164795011',
        text: 'hi',
        files: ['/tmp/anything.png'],
      }),
      deps,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('TELEGRAM_WORKSPACE_ROOT')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('reply without files succeeds via stub api', async () => {
    let captured: { chatId: string; text: string } | null = null
    const api = makeStubApi({
      sendMessage: async (chatId, text) => {
        captured = { chatId, text }
        return { message_id: 99 }
      },
    })
    const deps = makeDeps({ telegramApi: api })
    const result = await callTool(callReq('reply', { chat_id: '164795011', text: 'hello' }), deps)
    expect(result.isError).toBeUndefined()
    expect(captured).not.toBeNull()
    expect(captured!.chatId).toBe('164795011')
    expect(captured!.text).toBe('hello')
    expect(result.content[0]?.text).toContain('sent')
    expect(result.content[0]?.text).toContain('99')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('reply rejects missing required chat_id via zod', async () => {
    const deps = makeDeps()
    const result = await callTool(callReq('reply', { text: 'hi' }), deps)
    expect(result.isError).toBe(true)
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('reply with format=html converts markdown and sends with parse_mode=HTML', async () => {
    const captured: Array<{ text: string; opts: SendMessageOpts }> = []
    const api = makeStubApi({
      sendMessage: async (_chatId, text, opts) => {
        captured.push({ text, opts })
        return { message_id: 100 + captured.length }
      },
    })
    const deps = makeDeps({ telegramApi: api })
    const result = await callTool(
      callReq('reply', {
        chat_id: '164795011',
        text: 'Hello **bold** world',
        format: 'html',
      }),
      deps,
    )
    expect(result.isError).toBeUndefined()
    expect(captured.length).toBe(1)
    expect(captured[0]!.opts.parse_mode).toBe('HTML')
    expect(captured[0]!.text).toContain('<b>bold</b>')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('reply tool applies reply_to only to first chunk', async () => {
    // Force chunking by sending text longer than 4000.
    const captured: Array<{ opts: SendMessageOpts }> = []
    const api = makeStubApi({
      sendMessage: async (_chatId, _text, opts) => {
        captured.push({ opts })
        return { message_id: 200 + captured.length }
      },
    })
    const deps = makeDeps({ telegramApi: api })
    // Build a body well past 4000 chars with paragraph breaks for clean cuts.
    const para = 'x'.repeat(1500)
    const body = [para, para, para, para].join('\n\n')
    const result = await callTool(
      callReq('reply', {
        chat_id: '164795011',
        text: body,
        reply_to: '55',
        format: 'html',
      }),
      deps,
    )
    expect(result.isError).toBeUndefined()
    expect(captured.length).toBeGreaterThanOrEqual(2)
    // First chunk threads under message 55
    expect(captured[0]!.opts.reply_to_message_id).toBe(55)
    expect(captured[0]!.opts.parse_mode).toBe('HTML')
    // Subsequent chunks do NOT include reply_to_message_id
    for (let i = 1; i < captured.length; i++) {
      expect(captured[i]!.opts.reply_to_message_id).toBeUndefined()
      expect(captured[i]!.opts.parse_mode).toBe('HTML')
    }
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('reply falls back to plain text on Telegram HTML parse error', async () => {
    const captured: Array<{ text: string; opts: SendMessageOpts }> = []
    let firstCall = true
    const api = makeStubApi({
      sendMessage: async (_chatId, text, opts) => {
        captured.push({ text, opts })
        if (firstCall) {
          firstCall = false
          // Simulate Telegram's parse-entities error.
          const err: Error & { description?: string } = new Error(
            "Bad Request: can't parse entities: unexpected end tag",
          )
          err.description = "can't parse entities: bad"
          throw err
        }
        return { message_id: 777 }
      },
    })
    const deps = makeDeps({ telegramApi: api })
    const result = await callTool(
      callReq('reply', {
        chat_id: '164795011',
        text: 'oops **bad** html',
        format: 'html',
      }),
      deps,
    )
    expect(result.isError).toBeUndefined()
    // Two sendMessage calls: one with HTML parse_mode (failed), one without (succeeded).
    expect(captured.length).toBe(2)
    expect(captured[0]!.opts.parse_mode).toBe('HTML')
    expect(captured[1]!.opts.parse_mode).toBeUndefined()
    // Both calls send the same chunk body — no content loss.
    expect(captured[1]!.text).toBe(captured[0]!.text)
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('reply format=html accepts new enum value', async () => {
    // Schema regression: 'html' must be a legal format value.
    const deps = makeDeps()
    const result = await callTool(
      callReq('reply', { chat_id: '164795011', text: 'hi', format: 'html' }),
      deps,
    )
    expect(result.isError).toBeUndefined()
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('reply format=rich accepts new enum value (falls back to HTML when richMessages disabled)', async () => {
    // Schema regression: 'rich' must be a legal format value (M1). With the
    // default makeConfig (richMessages.enabled=false) no rich send is
    // attempted — the body renders via the validated HTML path, parse_mode=HTML.
    const captured: Array<{ text: string; opts: SendMessageOpts }> = []
    const api = makeStubApi({
      sendMessage: async (_chatId, text, opts) => {
        captured.push({ text, opts })
        return { message_id: 700 + captured.length }
      },
    })
    const deps = makeDeps({ telegramApi: api })
    const result = await callTool(
      callReq('reply', { chat_id: '164795011', text: '# Title', format: 'rich' }),
      deps,
    )
    expect(result.isError).toBeUndefined()
    expect(captured).toHaveLength(1)
    expect(captured[0]?.opts.parse_mode).toBe('HTML')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('reply without explicit format defaults to html (markdown auto-converts)', async () => {
    // Regression: when the caller omits `format`, the schema defaults to
    // 'html'. The body should be markdown-converted and sent with
    // parse_mode='HTML'. Before this change, the default was 'text' and
    // markdown leaked through to the user as literal `**bold**`.
    const captured: Array<{ text: string; opts: SendMessageOpts }> = []
    const api = makeStubApi({
      sendMessage: async (_chatId, text, opts) => {
        captured.push({ text, opts })
        return { message_id: 600 + captured.length }
      },
    })
    const deps = makeDeps({ telegramApi: api })
    const result = await callTool(
      callReq('reply', { chat_id: '164795011', text: 'Hello **bold** world' }),
      deps,
    )
    expect(result.isError).toBeUndefined()
    expect(captured.length).toBe(1)
    expect(captured[0]!.opts.parse_mode).toBe('HTML')
    expect(captured[0]!.text).toContain('<b>bold</b>')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('reply default html auto-escapes raw &, <, > in plain text', async () => {
    // Regression: with default='html', callers who send literal &/</> in
    // ordinary text (URLs with query strings, code snippets in plain prose)
    // must not break Telegram's HTML parser. markdownToTelegramHtml escapes
    // them on the way out (& → &amp;, < → &lt;, > → &gt;) so the message
    // remains valid HTML and ships with parse_mode='HTML'.
    const captured: Array<{ text: string; opts: SendMessageOpts }> = []
    const api = makeStubApi({
      sendMessage: async (_chatId, text, opts) => {
        captured.push({ text, opts })
        return { message_id: 700 + captured.length }
      },
    })
    const deps = makeDeps({ telegramApi: api })
    const result = await callTool(
      callReq('reply', { chat_id: '164795011', text: 'curl https://x.com?a=1&b=2 < y > z' }),
      deps,
    )
    expect(result.isError).toBeUndefined()
    expect(captured.length).toBe(1)
    expect(captured[0]!.opts.parse_mode).toBe('HTML')
    expect(captured[0]!.text).toContain('a=1&amp;b=2')
    expect(captured[0]!.text).toContain('&lt; y &gt; z')
    // No raw ampersand survives outside an entity.
    expect(captured[0]!.text).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#)/)
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  // Fix 5 — long replies must chunk under all formats (not only html).
  test('reply text format chunks long messages under 4096 cap', async () => {
    const captured: Array<{ text: string; opts: SendMessageOpts }> = []
    const api = makeStubApi({
      sendMessage: async (_chatId, text, opts) => {
        captured.push({ text, opts })
        return { message_id: 800 + captured.length }
      },
    })
    const deps = makeDeps({ telegramApi: api })
    // 9000 chars of text with paragraph breaks → expect ≥3 chunks.
    const para = 'y'.repeat(2900)
    const body = [para, para, para].join('\n\n')
    const result = await callTool(
      callReq('reply', { chat_id: '164795011', text: body, format: 'text' }),
      deps,
    )
    expect(result.isError).toBeUndefined()
    expect(captured.length).toBeGreaterThanOrEqual(3)
    // Each chunk ≤4000 chars (the default splitMessage budget).
    for (const c of captured) {
      expect(c.text.length).toBeLessThanOrEqual(4000)
      // text format must NOT have a parse_mode applied.
      expect(c.opts.parse_mode).toBeUndefined()
    }
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('reply markdownv2 format chunks long messages with parse_mode on every chunk', async () => {
    const captured: Array<{ text: string; opts: SendMessageOpts }> = []
    const api = makeStubApi({
      sendMessage: async (_chatId, text, opts) => {
        captured.push({ text, opts })
        return { message_id: 900 + captured.length }
      },
    })
    const deps = makeDeps({ telegramApi: api })
    const para = 'z'.repeat(2900)
    const body = [para, para, para].join('\n\n')
    const result = await callTool(
      callReq('reply', { chat_id: '164795011', text: body, format: 'markdownv2' }),
      deps,
    )
    expect(result.isError).toBeUndefined()
    expect(captured.length).toBeGreaterThanOrEqual(3)
    for (const c of captured) {
      expect(c.text.length).toBeLessThanOrEqual(4000)
      expect(c.opts.parse_mode).toBe('MarkdownV2')
    }
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  // Fix 7 — download_attachment now requires chat_id and gates the chat.
  test('download_attachment rejects when chat_id missing (zod)', async () => {
    const deps = makeDeps()
    const result = await callTool(
      callReq('download_attachment', { file_id: 'abc' }),
      deps,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('chat_id')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('download_attachment rejects when chat_id not allowlisted', async () => {
    const deps = makeDeps()
    const result = await callTool(
      callReq('download_attachment', { chat_id: '99999', file_id: 'abc' }),
      deps,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('not allowlisted')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('download_attachment with allowlisted chat_id calls downloadFile', async () => {
    let captured: { fileId: string; destDir: string } | null = null
    const api = makeStubApi({
      downloadFile: async (fileId, destDir) => {
        captured = { fileId, destDir }
        return { path: join(destDir, 'fake.bin'), size: 0 }
      },
    })
    const deps = makeDeps({ telegramApi: api })
    const result = await callTool(
      callReq('download_attachment', { chat_id: '164795011', file_id: 'AgAD...' }),
      deps,
    )
    expect(result.isError).toBeUndefined()
    expect(captured).not.toBeNull()
    expect(captured!.fileId).toBe('AgAD...')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })
})

// ─────────────────────────────────────────────────────────────────────
// autonomy tool (PR-1). READ + resolve over the durable registry; it can
// NEVER grant a lease (granting arrives in PR-2 via the button relay).
// ─────────────────────────────────────────────────────────────────────

import {
  addLease,
  addQuestion,
  emptyAutonomyState,
  loadAutonomyState,
  saveAutonomyState,
} from '../../src/autonomy/store.js'

const OWNER_CHAT = '164795011'
const HOUR = 3_600_000

describe('autonomy tool', () => {
  test('status on empty registry → "nothing active" text', async () => {
    const deps = makeDeps()
    const res = await callTool(callReq('autonomy', { chat_id: OWNER_CHAT, action: 'status' }), deps)
    expect(res.isError).toBeUndefined()
    expect(res.content[0]?.text).toContain('Активных мандатов нет')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('status reflects a lease seeded through the store API', async () => {
    const deps = makeDeps()
    const seeded = addLease(
      emptyAutonomyState(),
      { id: 'L-seed', scope: 'ship the wave', expiresAtMs: Date.now() + 4 * HOUR, source: 'ask_card' },
      Date.now(),
    ).state
    saveAutonomyState(deps.statePaths, OWNER_CHAT, seeded)
    const res = await callTool(callReq('autonomy', { chat_id: OWNER_CHAT, action: 'status' }), deps)
    expect(res.content[0]?.text).toContain('L-seed')
    expect(res.content[0]?.text).toContain('ship the wave')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('consume marks the lease consumed on disk', async () => {
    const deps = makeDeps()
    const seeded = addLease(
      emptyAutonomyState(),
      { id: 'L-c', scope: 's', expiresAtMs: Date.now() + HOUR, source: 'manual' },
      Date.now(),
    ).state
    saveAutonomyState(deps.statePaths, OWNER_CHAT, seeded)

    const res = await callTool(callReq('autonomy', { chat_id: OWNER_CHAT, action: 'consume', lease_id: 'L-c' }), deps)
    expect(res.isError).toBeUndefined()
    expect(res.content[0]?.text).toContain('lease consumed: L-c')

    const after = loadAutonomyState(deps.statePaths, OWNER_CHAT)
    expect(after.leases[0]?.consumedAtMs).toBeGreaterThan(0)
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('consume unknown lease → error', async () => {
    const deps = makeDeps()
    const res = await callTool(callReq('autonomy', { chat_id: OWNER_CHAT, action: 'consume', lease_id: 'L-nope' }), deps)
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('lease not found')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('consume already-consumed lease → error', async () => {
    const deps = makeDeps()
    saveAutonomyState(
      deps.statePaths,
      OWNER_CHAT,
      addLease(emptyAutonomyState(), { id: 'L-c', scope: 's', expiresAtMs: Date.now() + HOUR, source: 'manual' }, Date.now()).state,
    )
    await callTool(callReq('autonomy', { chat_id: OWNER_CHAT, action: 'consume', lease_id: 'L-c' }), deps)
    const res = await callTool(callReq('autonomy', { chat_id: OWNER_CHAT, action: 'consume', lease_id: 'L-c' }), deps)
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('already consumed')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('consume without lease_id → schema error', async () => {
    const deps = makeDeps()
    const res = await callTool(callReq('autonomy', { chat_id: OWNER_CHAT, action: 'consume' }), deps)
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('lease_id')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('resolve_question sets status on disk', async () => {
    const deps = makeDeps()
    saveAutonomyState(
      deps.statePaths,
      OWNER_CHAT,
      addQuestion(emptyAutonomyState(), { id: 'Q-1', summary: 'deploy?', askedAtMs: Date.now() }, Date.now()).state,
    )
    const res = await callTool(
      callReq('autonomy', { chat_id: OWNER_CHAT, action: 'resolve_question', question_id: 'Q-1', resolution: 'answered' }),
      deps,
    )
    expect(res.isError).toBeUndefined()
    expect(res.content[0]?.text).toContain('Q-1 resolved: answered')
    expect(loadAutonomyState(deps.statePaths, OWNER_CHAT).questions[0]?.status).toBe('answered')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('resolve_question unknown id → error', async () => {
    const deps = makeDeps()
    const res = await callTool(
      callReq('autonomy', { chat_id: OWNER_CHAT, action: 'resolve_question', question_id: 'Q-x', resolution: 'answered' }),
      deps,
    )
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('question not found')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('resolve_question missing question_id/resolution → schema error', async () => {
    const deps = makeDeps()
    const res = await callTool(callReq('autonomy', { chat_id: OWNER_CHAT, action: 'resolve_question' }), deps)
    expect(res.isError).toBe(true)
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('CANNOT grant: there is no grant action (enum rejects it)', async () => {
    const deps = makeDeps()
    const res = await callTool(callReq('autonomy', { chat_id: OWNER_CHAT, action: 'grant', scope: 'x' }), deps)
    expect(res.isError).toBe(true)
    // No file is created / no lease appears.
    expect(loadAutonomyState(deps.statePaths, OWNER_CHAT).leases).toEqual([])
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('rejects a non-allowlisted chat', async () => {
    const deps = makeDeps()
    const res = await callTool(callReq('autonomy', { chat_id: '999999', action: 'status' }), deps)
    expect(res.isError).toBe(true)
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })
})

// Fix-loop 2026-07-10: serialization, expired honesty, sticky/final invariants.
describe('autonomy tool — fix-loop invariants', () => {
  test('two PARALLEL consume calls → exactly one ok, one already_consumed', async () => {
    const deps = makeDeps()
    saveAutonomyState(
      deps.statePaths,
      OWNER_CHAT,
      addLease(emptyAutonomyState(), { id: 'L-par', scope: 's', expiresAtMs: Date.now() + HOUR, source: 'manual' }, Date.now()).state,
    )
    const call = () =>
      callTool(callReq('autonomy', { chat_id: OWNER_CHAT, action: 'consume', lease_id: 'L-par' }), deps)
    const [a, b] = await Promise.all([call(), call()])
    const oks = [a, b].filter((r) => r.isError === undefined)
    const errs = [a, b].filter((r) => r.isError === true)
    expect(oks.length).toBe(1)
    expect(errs.length).toBe(1)
    expect(errs[0]?.content[0]?.text).toContain('already consumed')
    // Disk agrees: consumed exactly once.
    const final = loadAutonomyState(deps.statePaths, OWNER_CHAT)
    expect(final.leases.filter((l) => l.consumedAtMs != null).length).toBe(1)
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('consume of an EXPIRED lease → honest error, not success', async () => {
    const deps = makeDeps()
    saveAutonomyState(
      deps.statePaths,
      OWNER_CHAT,
      addLease(emptyAutonomyState(), { id: 'L-exp', scope: 's', expiresAtMs: Date.now() - 1, source: 'manual' }, Date.now() - HOUR).state,
    )
    const res = await callTool(callReq('autonomy', { chat_id: OWNER_CHAT, action: 'consume', lease_id: 'L-exp' }), deps)
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('lease expired')
    // Not marked consumed on disk.
    expect(loadAutonomyState(deps.statePaths, OWNER_CHAT).leases[0]?.consumedAtMs).toBe(null)
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('bypassing a STICKY question → refused with sticky error', async () => {
    const deps = makeDeps()
    saveAutonomyState(
      deps.statePaths,
      OWNER_CHAT,
      addQuestion(emptyAutonomyState(), { id: 'Q-st', summary: 'wipe db?', askedAtMs: Date.now(), sticky: true }, Date.now()).state,
    )
    const res = await callTool(
      callReq('autonomy', { chat_id: OWNER_CHAT, action: 'resolve_question', question_id: 'Q-st', resolution: 'bypassed' }),
      deps,
    )
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('sticky')
    expect(loadAutonomyState(deps.statePaths, OWNER_CHAT).questions[0]?.status).toBe('open')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })

  test('re-resolving an already-resolved question → error', async () => {
    const deps = makeDeps()
    saveAutonomyState(
      deps.statePaths,
      OWNER_CHAT,
      addQuestion(emptyAutonomyState(), { id: 'Q-f', summary: 's', askedAtMs: Date.now() }, Date.now()).state,
    )
    const first = await callTool(
      callReq('autonomy', { chat_id: OWNER_CHAT, action: 'resolve_question', question_id: 'Q-f', resolution: 'answered' }),
      deps,
    )
    expect(first.isError).toBeUndefined()
    const second = await callTool(
      callReq('autonomy', { chat_id: OWNER_CHAT, action: 'resolve_question', question_id: 'Q-f', resolution: 'bypassed' }),
      deps,
    )
    expect(second.isError).toBe(true)
    expect(second.content[0]?.text).toContain('already resolved')
    expect(loadAutonomyState(deps.statePaths, OWNER_CHAT).questions[0]?.status).toBe('answered')
    rmSync(deps.statePaths.root, { recursive: true, force: true })
  })
})
