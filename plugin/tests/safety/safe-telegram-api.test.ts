// Tests for createSafeTelegramApi — the wrapper that funnels every outbound
// text through redactSecrets + validateTelegramHtml before delegating to
// the raw API. We use a hand-rolled stub TelegramApi rather than mocking
// grammy so the test stays decoupled from the transport.

import { describe, expect, test } from 'bun:test'
import type {
  ChatAction,
  DownloadResult,
  EditOpts,
  SendDocumentOpts,
  SendMessageOpts,
  TelegramApi,
} from '../../src/channel/tools.js'
import type { Logger } from '../../src/log.js'
import { createSafeTelegramApi } from '../../src/safety/safe-telegram-api.js'

interface SentCall {
  method: 'sendMessage' | 'editMessageText'
  chatId: string
  messageId?: number
  text: string
  opts: SendMessageOpts | EditOpts
}

function makeStubApi(): { api: TelegramApi; calls: SentCall[] } {
  const calls: SentCall[] = []
  const api: TelegramApi = {
    async sendMessage(chatId, text, opts) {
      calls.push({ method: 'sendMessage', chatId, text, opts })
      return { message_id: 42 }
    },
    async editMessageText(chatId, messageId, text, opts) {
      calls.push({ method: 'editMessageText', chatId, messageId, text, opts })
    },
    async setMessageReaction(_chatId, _messageId, _emoji) {},
    async sendChatAction(_chatId, _action: ChatAction) {},
    async sendDocument(_chatId, _filePath, _opts: SendDocumentOpts) {
      return { message_id: 0 }
    },
    async sendPhoto(_chatId, _filePath, _opts: SendDocumentOpts) {
      return { message_id: 0 }
    },
    async downloadFile(_fileId, _destDir): Promise<DownloadResult> {
      return { path: '/tmp/fake' }
    },
    async deleteMessage(_chatId, _messageId) {},
  }
  return { api, calls }
}

interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error'
  msg: string
  ctx?: Record<string, unknown>
}
function makeLog(): { log: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = []
  const log: Logger = {
    debug: (msg, ctx) => entries.push({ level: 'debug', msg, ...(ctx ? { ctx } : {}) }),
    info: (msg, ctx) => entries.push({ level: 'info', msg, ...(ctx ? { ctx } : {}) }),
    warn: (msg, ctx) => entries.push({ level: 'warn', msg, ...(ctx ? { ctx } : {}) }),
    error: (msg, ctx) => entries.push({ level: 'error', msg, ...(ctx ? { ctx } : {}) }),
  }
  return { log, entries }
}

describe('createSafeTelegramApi — secret redaction', () => {
  test('redacts Telegram bot token in sendMessage text', async () => {
    const { api, calls } = makeStubApi()
    const { log } = makeLog()
    const safe = createSafeTelegramApi(api, log)
    const token = '8507713167:AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPPQQRR'
    await safe.sendMessage('123', `oops token ${token} leaked`, {})
    expect(calls).toHaveLength(1)
    expect(calls[0]!.text).not.toContain(token)
    expect(calls[0]!.text).toContain('<redacted>')
  })

  test('redacts in editMessageText too', async () => {
    const { api, calls } = makeStubApi()
    const { log } = makeLog()
    const safe = createSafeTelegramApi(api, log)
    const token = 'gsk_' + 'X'.repeat(45)
    await safe.editMessageText('123', 7, `bad ${token}`, {})
    expect(calls[0]!.text).not.toContain(token)
  })

  test('honors extraSecrets parameter', async () => {
    const { api, calls } = makeStubApi()
    const { log } = makeLog()
    const webhook = 'wh_webhook_token_secret_value_here'
    const safe = createSafeTelegramApi(api, log, [webhook])
    await safe.sendMessage('123', `header was ${webhook}`, {})
    expect(calls[0]!.text).not.toContain(webhook)
  })
})

describe('createSafeTelegramApi — HTML validation', () => {
  test('valid HTML passes through with parse_mode=HTML', async () => {
    const { api, calls } = makeStubApi()
    const { log } = makeLog()
    const safe = createSafeTelegramApi(api, log)
    await safe.sendMessage('1', '<b>bold</b>', { parse_mode: 'HTML' })
    expect(calls[0]!.text).toBe('<b>bold</b>')
    expect((calls[0]!.opts as SendMessageOpts).parse_mode).toBe('HTML')
  })

  test('invalid HTML downgrades: parse_mode removed + text escaped', async () => {
    const { api, calls } = makeStubApi()
    const { log, entries } = makeLog()
    const safe = createSafeTelegramApi(api, log)
    await safe.sendMessage('1', '<script>x</script>', { parse_mode: 'HTML' })
    expect((calls[0]!.opts as SendMessageOpts).parse_mode).toBeUndefined()
    expect(calls[0]!.text).not.toContain('<script>')
    expect(calls[0]!.text).toContain('&lt;script&gt;')
    // Warn log fired without leaking original text.
    const warns = entries.filter((e) => e.level === 'warn')
    expect(warns.length).toBeGreaterThan(0)
    const w = warns[0]!
    expect(w.msg).toContain('downgrade')
    // The original text MUST NOT appear in the log ctx — only the reason.
    const ctxStr = JSON.stringify(w.ctx ?? {})
    expect(ctxStr).not.toContain('<script>')
  })

  test('no parse_mode → no HTML validation runs', async () => {
    const { api, calls } = makeStubApi()
    const { log } = makeLog()
    const safe = createSafeTelegramApi(api, log)
    // Raw `<` in plain text mode is fine — Telegram won't parse it.
    await safe.sendMessage('1', 'a < b', {})
    expect(calls[0]!.text).toBe('a < b')
    expect((calls[0]!.opts as SendMessageOpts).parse_mode).toBeUndefined()
  })

  test('MarkdownV2 parse mode skips HTML validation', async () => {
    const { api, calls } = makeStubApi()
    const { log } = makeLog()
    const safe = createSafeTelegramApi(api, log)
    // `<div>` would trip HTML validator, but with MarkdownV2 we leave it alone.
    await safe.sendMessage('1', '<div>not html mode</div>', { parse_mode: 'MarkdownV2' })
    expect((calls[0]!.opts as SendMessageOpts).parse_mode).toBe('MarkdownV2')
    expect(calls[0]!.text).toContain('<div>')
  })

  test('redaction runs even when validation downgrades', async () => {
    const { api, calls } = makeStubApi()
    const { log } = makeLog()
    const safe = createSafeTelegramApi(api, log)
    const token = '8507713167:AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPPQQRR'
    await safe.sendMessage('1', `<script>${token}</script>`, { parse_mode: 'HTML' })
    // Downgraded body must still have the token removed.
    expect(calls[0]!.text).not.toContain(token)
    expect((calls[0]!.opts as SendMessageOpts).parse_mode).toBeUndefined()
  })
})

describe('createSafeTelegramApi — pass-through methods', () => {
  test('setMessageReaction is forwarded unchanged', async () => {
    const { api } = makeStubApi()
    const { log } = makeLog()
    const safe = createSafeTelegramApi(api, log)
    // Should not throw — pass-through wraps but doesn't alter args.
    await safe.setMessageReaction('1', 2, '👍')
  })

  test('sendChatAction is forwarded', async () => {
    const { api } = makeStubApi()
    const { log } = makeLog()
    const safe = createSafeTelegramApi(api, log)
    await safe.sendChatAction('1', 'typing')
  })

  test('downloadFile is forwarded', async () => {
    const { api } = makeStubApi()
    const { log } = makeLog()
    const safe = createSafeTelegramApi(api, log)
    const r = await safe.downloadFile('fid', '/tmp')
    expect(r.path).toBe('/tmp/fake')
  })

  test('deleteMessage is forwarded', async () => {
    const { api } = makeStubApi()
    const { log } = makeLog()
    const safe = createSafeTelegramApi(api, log)
    await safe.deleteMessage('1', 2)
  })
})

describe('createSafeTelegramApi — inline keyboard redaction', () => {
  test('button url containing Bearer token is redacted before transport', async () => {
    const { api, calls } = makeStubApi()
    const { log } = makeLog()
    const safe = createSafeTelegramApi(api, log)
    const tok = 'abcdef1234567890ABCDEFGHIJK'
    const url = `https://x.example/cb?token=${tok}`
    // Use a structurally-typed reply_markup; the public InlineKeyboardLike
    // doesn't formally include `url` buttons but Telegram's wire format does.
    const reply_markup = {
      inline_keyboard: [[{ text: 'open', url } as unknown as { text: string }]],
    }
    await safe.sendMessage('1', 'see button', { reply_markup })
    expect(calls).toHaveLength(1)
    const sentMarkup = (calls[0]!.opts as SendMessageOpts).reply_markup
    expect(sentMarkup).toBeDefined()
    const row = sentMarkup!.inline_keyboard[0]!
    const btn = row[0]! as { text: string; url?: string }
    expect(btn.url).toBeDefined()
    expect(btn.url).not.toContain(tok)
  })

  test('button text containing Telegram bot token is redacted', async () => {
    const { api, calls } = makeStubApi()
    const { log } = makeLog()
    const safe = createSafeTelegramApi(api, log)
    const tok = '8507713167:AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPPQQRR'
    const reply_markup = {
      inline_keyboard: [[{ text: `leaked ${tok} oops` }]],
    }
    await safe.sendMessage('1', 'see button', { reply_markup })
    const sentMarkup = (calls[0]!.opts as SendMessageOpts).reply_markup
    const btn = sentMarkup!.inline_keyboard[0]![0]!
    expect(btn.text).not.toContain(tok)
    expect(btn.text).toContain('<redacted>')
  })

  test('extraSecrets also masked inside button url and text', async () => {
    const { api, calls } = makeStubApi()
    const { log } = makeLog()
    const webhook = 'wh_strange_webhook_token_value_xyz'
    const safe = createSafeTelegramApi(api, log, [webhook])
    const reply_markup = {
      inline_keyboard: [[
        { text: `tap to use ${webhook}`, url: `https://x.example/?k=${webhook}` } as unknown as { text: string },
      ]],
    }
    await safe.sendMessage('1', 'see button', { reply_markup })
    const sent = (calls[0]!.opts as SendMessageOpts).reply_markup
    const btn = sent!.inline_keyboard[0]![0]! as { text: string; url?: string }
    expect(btn.text).not.toContain(webhook)
    expect(btn.url).toBeDefined()
    expect(btn.url).not.toContain(webhook)
  })

  test('no reply_markup → no-op (sendMessage works as before)', async () => {
    const { api, calls } = makeStubApi()
    const { log } = makeLog()
    const safe = createSafeTelegramApi(api, log)
    await safe.sendMessage('1', 'plain', {})
    expect(calls[0]!.text).toBe('plain')
    expect((calls[0]!.opts as SendMessageOpts).reply_markup).toBeUndefined()
  })

  test('partial / unknown button shapes survive without throwing', async () => {
    const { api, calls } = makeStubApi()
    const { log } = makeLog()
    const safe = createSafeTelegramApi(api, log)
    // Mix of valid + malformed cells. Should not throw, should leave
    // unknown fields alone, and should still redact text/url where present.
    const reply_markup = {
      inline_keyboard: [
        // Row 1: well-formed cell
        [{ text: 'good', callback_data: 'cb' }],
        // Row 2: empty cell-array (defensive)
        [],
        // Row 3: cell with text+url
        [{ text: 'open', url: 'https://example.com/' } as unknown as { text: string }],
      ],
    }
    await safe.sendMessage('1', 'msg', { reply_markup })
    const sent = (calls[0]!.opts as SendMessageOpts).reply_markup
    expect(sent).toBeDefined()
    expect(sent!.inline_keyboard).toHaveLength(3)
  })
})
