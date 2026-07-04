// Guest Mode reply-path tests (src/channel/tools.ts `reply` with
// guest_query_id).
//
// Contract under test:
//   - guest replies bypass assertAllowedChat (foreign chat is by definition
//     not allowlisted) — authorization is registry claim()
//   - unknown / consumed / expired claims → tool error, no API call
//   - attachments / reply_to → tool error, claim NOT spent
//   - happy path: answerGuestQuery called once with HTML parse_mode,
//     sendMessage never called
//   - >4000-char bodies ship as ONE truncated message (flagged in result)
//   - HTML parse error → plain-text retry on the same query
//   - hard send failure → release() re-arms the claim
//   - guest_query_id without a wired registry → tool error

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  callTool,
  type AnswerGuestQueryOpts,
  type CallToolRequest,
  type TelegramApi,
  type ToolDeps,
} from '../../src/channel/tools.js'
import { GuestQueryRegistry } from '../../src/telegram/guest-queries.js'
import type { AppConfig, StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'

const silentLog = createLogger('test', {
  stream: { write: () => true } as unknown as NodeJS.WritableStream,
})

function makeConfig(): AppConfig {
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
    tmux_mirror: { enabled: false, pane_target: '', socket_name: '', poll_interval_ms: 5000, line_count: 50, hide_segments: ['boot_banner', 'inbound_warning', 'footer_hints', 'input_box'], mode: 'latest_inbound_only', max_lines: 14 },
    multichat: { enabled: false },
    ask_user_question: { enabled: false, timeout_ms: 300_000, max_preview_chars: 1000 },
    permission_gate: { enabled: false, timeout_ms: 120_000 },
    guest_mode: { enabled: true },
    // Rich disabled: guest replies must exercise answerGuestQuery only.
    richMessages: { enabled: false, perChatOptOut: [] },
  }
}

function makeStatePaths(): StatePaths {
  const root = mkdtempSync(join(tmpdir(), 'dashi-tools-guest-test-'))
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

interface GuestCall {
  guestQueryId: string
  text: string
  opts: AnswerGuestQueryOpts
}

function makeStubApi(opts: { failures?: Error[] } = {}): {
  api: TelegramApi
  guestCalls: GuestCall[]
  sendMessageCalls: number
} {
  const guestCalls: GuestCall[] = []
  const failures = [...(opts.failures ?? [])]
  const counters = { sendMessage: 0 }
  const noop = async (): Promise<never> => {
    throw new Error('unexpected api call in guest tools test')
  }
  const api: TelegramApi = {
    sendMessage: async () => {
      counters.sendMessage += 1
      return { message_id: 1 }
    },
    // Guest replies must never take the rich path — throw loudly if they do.
    sendRichMessage: noop as unknown as TelegramApi['sendRichMessage'],
    editMessageText: noop as unknown as TelegramApi['editMessageText'],
    setMessageReaction: noop as unknown as TelegramApi['setMessageReaction'],
    sendChatAction: async () => {},
    sendDocument: noop as unknown as TelegramApi['sendDocument'],
    sendPhoto: noop as unknown as TelegramApi['sendPhoto'],
    downloadFile: noop as unknown as TelegramApi['downloadFile'],
    deleteMessage: noop as unknown as TelegramApi['deleteMessage'],
    answerGuestQuery: async (guestQueryId, text, guestOpts) => {
      const failure = failures.shift()
      if (failure) throw failure
      guestCalls.push({ guestQueryId, text, opts: guestOpts })
    },
  }
  return {
    api,
    guestCalls,
    get sendMessageCalls() {
      return counters.sendMessage
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
    noteHookActivity: () => {},
    noteToolActivity: () => {},
  } as unknown as ToolDeps['statusManager']
}

function makeDeps(opts: {
  api: TelegramApi
  registry?: GuestQueryRegistry
}): ToolDeps {
  return {
    config: makeConfig(),
    statePaths: makeStatePaths(),
    telegramApi: opts.api,
    log: silentLog,
    statusManager: makeStubStatusManager(),
    ...(opts.registry !== undefined ? { guestQueries: opts.registry } : {}),
  }
}

function replyReq(args: Record<string, unknown>): CallToolRequest {
  return { params: { name: 'reply', arguments: args } }
}

function registered(registry: GuestQueryRegistry, id: string): void {
  registry.register({
    guestQueryId: id,
    callerUserId: '164795011',
    callerChatId: '-100987',
    messageText: 'q',
  })
}

// Telegram HTML parse errors are matched by message shape — mirror the
// format grammY surfaces (see isTelegramHtmlParseError).
function htmlParseError(): Error {
  return new Error("Bad Request: can't parse entities: unclosed tag at byte offset 5")
}

describe('reply tool — guest path', () => {
  test('happy path: answerGuestQuery once, HTML parse_mode, no sendMessage, no chat-allowlist check', async () => {
    const stub = makeStubApi()
    const registry = new GuestQueryRegistry()
    registered(registry, 'gq-1')
    const deps = makeDeps({ api: stub.api, registry })

    // chat_id is the FOREIGN chat — deliberately not in allowed_chat_ids.
    const result = await callTool(
      replyReq({ chat_id: '-100987', guest_query_id: 'gq-1', text: '**жирный** ответ' }),
      deps,
    )

    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toBe('guest answer sent')
    expect(stub.guestCalls.length).toBe(1)
    expect(stub.guestCalls[0]!.guestQueryId).toBe('gq-1')
    expect(stub.guestCalls[0]!.text).toContain('<b>жирный</b>')
    expect(stub.guestCalls[0]!.opts.parse_mode).toBe('HTML')
    expect(stub.sendMessageCalls).toBe(0)
    // One-shot: the claim is spent.
    expect(registry.claim('gq-1').kind).toBe('consumed')
  })

  test("format 'rich' degrades to HTML rendering — answerGuestQuery gets rendered body, never sendRichMessage", async () => {
    const stub = makeStubApi()
    const registry = new GuestQueryRegistry()
    registered(registry, 'gq-rich')
    const deps = makeDeps({ api: stub.api, registry })

    // answerGuestQuery has no rich_message payload: 'rich' must render the
    // same HTML subset as the default path (sendRichMessage stub throws, so
    // any rich attempt fails this test loudly).
    const result = await callTool(
      replyReq({
        chat_id: '-100987',
        guest_query_id: 'gq-rich',
        text: '**жирный** ответ',
        format: 'rich',
      }),
      deps,
    )

    expect(result.isError).toBeUndefined()
    expect(stub.guestCalls.length).toBe(1)
    expect(stub.guestCalls[0]!.text).toContain('<b>жирный</b>')
    expect(stub.guestCalls[0]!.opts.parse_mode).toBe('HTML')
    expect(stub.sendMessageCalls).toBe(0)
  })

  test('unknown guest query → tool error, no API call', async () => {
    const stub = makeStubApi()
    const deps = makeDeps({ api: stub.api, registry: new GuestQueryRegistry() })
    const result = await callTool(
      replyReq({ chat_id: '-100987', guest_query_id: 'ghost', text: 'x' }),
      deps,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('unknown')
    expect(stub.guestCalls.length).toBe(0)
  })

  test('second reply to the same query → consumed error', async () => {
    const stub = makeStubApi()
    const registry = new GuestQueryRegistry()
    registered(registry, 'gq-2')
    const deps = makeDeps({ api: stub.api, registry })

    await callTool(replyReq({ chat_id: '-100987', guest_query_id: 'gq-2', text: 'a' }), deps)
    const second = await callTool(
      replyReq({ chat_id: '-100987', guest_query_id: 'gq-2', text: 'b' }),
      deps,
    )
    expect(second.isError).toBe(true)
    expect(second.content[0]!.text).toContain('consumed')
    expect(stub.guestCalls.length).toBe(1)
  })

  test('attachments are rejected before the claim is spent', async () => {
    const stub = makeStubApi()
    const registry = new GuestQueryRegistry()
    registered(registry, 'gq-3')
    const deps = makeDeps({ api: stub.api, registry })

    const result = await callTool(
      replyReq({
        chat_id: '-100987',
        guest_query_id: 'gq-3',
        text: 'x',
        files: ['/tmp/pic.png'],
      }),
      deps,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('text-only')
    // Claim untouched — a follow-up text-only reply still works.
    expect(registry.claim('gq-3').kind).toBe('ok')
  })

  test('reply_to is rejected before the claim is spent', async () => {
    const stub = makeStubApi()
    const registry = new GuestQueryRegistry()
    registered(registry, 'gq-4')
    const deps = makeDeps({ api: stub.api, registry })

    const result = await callTool(
      replyReq({ chat_id: '-100987', guest_query_id: 'gq-4', text: 'x', reply_to: '5' }),
      deps,
    )
    expect(result.isError).toBe(true)
    expect(registry.claim('gq-4').kind).toBe('ok')
  })

  test('long body ships as ONE truncated message and flags it', async () => {
    const stub = makeStubApi()
    const registry = new GuestQueryRegistry()
    registered(registry, 'gq-5')
    const deps = makeDeps({ api: stub.api, registry })

    const long = 'а'.repeat(9000)
    const result = await callTool(
      replyReq({ chat_id: '-100987', guest_query_id: 'gq-5', text: long }),
      deps,
    )
    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toContain('TRUNCATED')
    expect(stub.guestCalls.length).toBe(1)
    expect(stub.guestCalls[0]!.text.length).toBeLessThanOrEqual(4096)
  })

  test('HTML parse error retries the same query as plain text', async () => {
    const stub = makeStubApi({ failures: [htmlParseError()] })
    const registry = new GuestQueryRegistry()
    registered(registry, 'gq-6')
    const deps = makeDeps({ api: stub.api, registry })

    const result = await callTool(
      replyReq({ chat_id: '-100987', guest_query_id: 'gq-6', text: 'ответ' }),
      deps,
    )
    expect(result.isError).toBeUndefined()
    expect(stub.guestCalls.length).toBe(1)
    expect(stub.guestCalls[0]!.opts.parse_mode).toBeUndefined()
  })

  test('hard send failure releases the claim for retry', async () => {
    const stub = makeStubApi({ failures: [new Error('network down')] })
    const registry = new GuestQueryRegistry()
    registered(registry, 'gq-7')
    const deps = makeDeps({ api: stub.api, registry })

    const result = await callTool(
      replyReq({ chat_id: '-100987', guest_query_id: 'gq-7', text: 'x' }),
      deps,
    )
    expect(result.isError).toBe(true)
    // release() re-armed the claim — a retry succeeds.
    const retry = await callTool(
      replyReq({ chat_id: '-100987', guest_query_id: 'gq-7', text: 'x' }),
      deps,
    )
    expect(retry.isError).toBeUndefined()
    expect(stub.guestCalls.length).toBe(1)
  })

  test('guest_query_id without a wired registry → clear tool error', async () => {
    const stub = makeStubApi()
    const deps = makeDeps({ api: stub.api })
    const result = await callTool(
      replyReq({ chat_id: '-100987', guest_query_id: 'gq-8', text: 'x' }),
      deps,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('guest_mode is not enabled')
  })

  test('markdownv2 entity-parse error also retries as plain text (Fable #2)', async () => {
    const stub = makeStubApi({ failures: [htmlParseError()] })
    const registry = new GuestQueryRegistry()
    registered(registry, 'gq-9')
    const deps = makeDeps({ api: stub.api, registry })

    const result = await callTool(
      replyReq({
        chat_id: '-100987',
        guest_query_id: 'gq-9',
        text: '*broken _markdown',
        format: 'markdownv2',
      }),
      deps,
    )
    expect(result.isError).toBeUndefined()
    expect(stub.guestCalls.length).toBe(1)
    expect(stub.guestCalls[0]!.opts.parse_mode).toBeUndefined()
  })

  test('plain-text fallback ships the PRE-render body, not HTML tag soup (Fable #3)', async () => {
    const stub = makeStubApi({ failures: [htmlParseError()] })
    const registry = new GuestQueryRegistry()
    registered(registry, 'gq-10')
    const deps = makeDeps({ api: stub.api, registry })

    await callTool(
      replyReq({ chat_id: '-100987', guest_query_id: 'gq-10', text: '**жирный** текст' }),
      deps,
    )
    expect(stub.guestCalls.length).toBe(1)
    expect(stub.guestCalls[0]!.text).toBe('**жирный** текст')
    expect(stub.guestCalls[0]!.text).not.toContain('<b>')
  })

  test('double failure (parse error, then hard error) releases the claim', async () => {
    const stub = makeStubApi({ failures: [htmlParseError(), new Error('network down')] })
    const registry = new GuestQueryRegistry()
    registered(registry, 'gq-11')
    const deps = makeDeps({ api: stub.api, registry })

    const result = await callTool(
      replyReq({ chat_id: '-100987', guest_query_id: 'gq-11', text: 'x' }),
      deps,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('network down')
    // Claim re-armed — a retry succeeds.
    const retry = await callTool(
      replyReq({ chat_id: '-100987', guest_query_id: 'gq-11', text: 'x' }),
      deps,
    )
    expect(retry.isError).toBeUndefined()
  })

  test('chat_id mismatch with the query origin refuses and re-arms (Fable #5)', async () => {
    const stub = makeStubApi()
    const registry = new GuestQueryRegistry()
    registered(registry, 'gq-12') // callerChatId: -100987
    const deps = makeDeps({ api: stub.api, registry })

    const result = await callTool(
      replyReq({ chat_id: '-100555', guest_query_id: 'gq-12', text: 'x' }),
      deps,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('-100987')
    expect(stub.guestCalls.length).toBe(0)
    // Claim was released — the correct pair still works.
    const correct = await callTool(
      replyReq({ chat_id: '-100987', guest_query_id: 'gq-12', text: 'x' }),
      deps,
    )
    expect(correct.isError).toBeUndefined()
  })

  test('successful answer is frozen — release cannot re-open it (confirm path)', async () => {
    const stub = makeStubApi()
    const registry = new GuestQueryRegistry()
    registered(registry, 'gq-13')
    const deps = makeDeps({ api: stub.api, registry })

    await callTool(replyReq({ chat_id: '-100987', guest_query_id: 'gq-13', text: 'a' }), deps)
    registry.release('gq-13') // hostile/buggy release after success
    const again = await callTool(
      replyReq({ chat_id: '-100987', guest_query_id: 'gq-13', text: 'b' }),
      deps,
    )
    expect(again.isError).toBe(true)
    expect(again.content[0]!.text).toContain('consumed')
    expect(stub.guestCalls.length).toBe(1)
  })
})
