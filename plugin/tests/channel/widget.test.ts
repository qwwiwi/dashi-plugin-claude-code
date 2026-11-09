// Tests for the send_widget / edit_widget_data tools (#151, slice 1).
//
// The Telegram layer is stubbed the same way tools.test.ts does it: a
// hand-rolled TelegramApi that records calls. The raw grammY adapter is tested
// through a fake Bot whose `api.raw` records the request body.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { deflateSync } from 'zlib'
import type { Bot } from 'grammy'

import {
  callTool,
  createTelegramApi,
  listTools,
  type CallToolRequest,
  type TelegramApi,
  type ToolDeps,
} from '../../src/channel/tools.js'
import type { AppConfig, StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import { redactSecrets } from '../../src/safety/redact.js'

const silentLog = createLogger('test', { stream: { write: () => true } as unknown as NodeJS.WritableStream })

const OWNER_CHAT = '164795011'
const GROUP_CHAT = '-1001234567890'
const FAKE_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'

interface WidgetCall {
  method: 'sendWidget' | 'editWidgetData'
  chatId: string
  messageId?: number
  params?: Record<string, unknown>
  chatData?: string
}

function makeApi(opts: { fail?: Error } = {}): { api: TelegramApi; calls: WidgetCall[] } {
  const calls: WidgetCall[] = []
  const api = {
    async sendWidget(chatId: string, params: Record<string, unknown>) {
      calls.push({ method: 'sendWidget', chatId, params })
      if (opts.fail) throw opts.fail
      return { message_id: 777 }
    },
    async editWidgetData(chatId: string, messageId: number, chatData: string) {
      calls.push({ method: 'editWidgetData', chatId, messageId, chatData })
      if (opts.fail) throw opts.fail
    },
  } as unknown as TelegramApi
  return { api, calls }
}

function makeDeps(api: TelegramApi): ToolDeps {
  return {
    config: {
      allowed_user_ids: [164795011],
      allowed_chat_ids: [164795011, -1001234567890],
      richMessages: { enabled: false, perChatOptOut: [] },
    } as unknown as AppConfig,
    statePaths: {} as unknown as StatePaths,
    telegramApi: api,
    log: silentLog,
    statusManager: {} as unknown as ToolDeps['statusManager'],
  }
}

function req(name: string, args: Record<string, unknown>): CallToolRequest {
  return { params: { name, arguments: args } }
}

// Deterministic incompressible-ish text (xorshift) so the zlib test is stable.
function noise(len: number): string {
  let s = 0x2545f491
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/'
  let out = ''
  for (let i = 0; i < len; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out += alphabet[(s >>> 0) % alphabet.length]
  }
  return out
}

const OK_HTML = '<div id="w">ok</div>'

describe('listTools — widget tools', () => {
  test('send_widget and edit_widget_data are listed after the existing six, order stable', () => {
    expect(listTools().map(t => t.name)).toEqual([
      'reply',
      'react',
      'download_attachment',
      'edit_message',
      'status',
      'autonomy',
      'send_widget',
      'edit_widget_data',
    ])
  })

  test('input schemas declare the required fields', () => {
    const tools = listTools()
    expect(tools.find(t => t.name === 'send_widget')?.inputSchema.required).toEqual(['chat_id', 'html', 'caption'])
    expect(tools.find(t => t.name === 'edit_widget_data')?.inputSchema.required).toEqual([
      'chat_id',
      'message_id',
      'chat_data',
    ])
  })
})

describe('send_widget', () => {
  test('sends through the API with the parsed params and returns the message id', async () => {
    const { api, calls } = makeApi()
    const res = await callTool(
      req('send_widget', {
        chat_id: OWNER_CHAT,
        html: OK_HTML,
        caption: 'Status card',
        chat_data: '{"j":[]}',
        width: 320,
        height: 200,
      }),
      makeDeps(api),
    )
    expect(res.isError).toBeUndefined()
    expect(res.content[0]?.text).toContain('777')
    expect(calls).toEqual([
      {
        method: 'sendWidget',
        chatId: OWNER_CHAT,
        params: { html: OK_HTML, caption: 'Status card', chat_data: '{"j":[]}', width: 320, height: 200 },
      },
    ])
  })

  test('optional fields are omitted from the params when absent', async () => {
    const { api, calls } = makeApi()
    await callTool(req('send_widget', { chat_id: OWNER_CHAT, html: OK_HTML, caption: 'c' }), makeDeps(api))
    expect(calls[0]?.params).toEqual({ html: OK_HTML, caption: 'c' })
  })

  test('refuses a missing caption (fallback text for old clients) without calling the API', async () => {
    const { api, calls } = makeApi()
    const res = await callTool(req('send_widget', { chat_id: OWNER_CHAT, html: OK_HTML }), makeDeps(api))
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('caption')
    expect(calls).toHaveLength(0)
  })

  test('refuses an empty caption', async () => {
    const { api, calls } = makeApi()
    const res = await callTool(req('send_widget', { chat_id: OWNER_CHAT, html: OK_HTML, caption: '' }), makeDeps(api))
    expect(res.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test('refuses html over 32768 BYTES even when the char count is under it', async () => {
    const { api, calls } = makeApi()
    // 16385 two-byte chars = 32770 bytes, 16385 chars.
    const html = 'я'.repeat(16385)
    const res = await callTool(req('send_widget', { chat_id: OWNER_CHAT, html, caption: 'c' }), makeDeps(api))
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('32768')
    expect(res.content[0]?.text).toContain('32770')
    expect(calls).toHaveLength(0)
  })

  test('refuses html whose zlib level-9 size is over 4096 bytes', async () => {
    const { api, calls } = makeApi()
    const html = `<div>${noise(8000)}</div>`
    expect(Buffer.byteLength(html)).toBeLessThan(32768)
    expect(deflateSync(Buffer.from(html), { level: 9 }).length).toBeGreaterThan(4096)
    const res = await callTool(req('send_widget', { chat_id: OWNER_CHAT, html, caption: 'c' }), makeDeps(api))
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('4096')
    expect(res.content[0]?.text.toLowerCase()).toContain('zlib')
    expect(calls).toHaveLength(0)
  })

  test('refuses html that contains a NUL character', async () => {
    const { api, calls } = makeApi()
    const res = await callTool(
      req('send_widget', { chat_id: OWNER_CHAT, html: '<div>a\u0000b</div>', caption: 'c' }),
      makeDeps(api),
    )
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('NUL')
    expect(calls).toHaveLength(0)
  })

  test('refuses chat_data over 1024 bytes (multi-byte counted as bytes)', async () => {
    const { api, calls } = makeApi()
    const chat_data = 'я'.repeat(513) // 1026 bytes, 513 chars
    const res = await callTool(
      req('send_widget', { chat_id: OWNER_CHAT, html: OK_HTML, caption: 'c', chat_data }),
      makeDeps(api),
    )
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('1024')
    expect(calls).toHaveLength(0)
  })

  test('accepts chat_data of exactly 1024 bytes', async () => {
    const { api, calls } = makeApi()
    const res = await callTool(
      req('send_widget', { chat_id: OWNER_CHAT, html: OK_HTML, caption: 'c', chat_data: 'x'.repeat(1024) }),
      makeDeps(api),
    )
    expect(res.isError).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  test('refuses a group chat id (negative) — production widgets are private-chat only', async () => {
    const { api, calls } = makeApi()
    // The group IS on the allowlist, so the refusal comes from the widget rule.
    const res = await callTool(req('send_widget', { chat_id: GROUP_CHAT, html: OK_HTML, caption: 'c' }), makeDeps(api))
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('private')
    expect(calls).toHaveLength(0)
  })

  test('the chat allowlist gate applies: a private chat that is not allowlisted is refused', async () => {
    const { api, calls } = makeApi()
    const res = await callTool(req('send_widget', { chat_id: '999', html: OK_HTML, caption: 'c' }), makeDeps(api))
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('not allowlisted')
    expect(calls).toHaveLength(0)
  })

  test.each([
    ['width 0', { width: 0 }],
    ['negative height', { height: -5 }],
    ['fractional width', { width: 10.5 }],
  ])('refuses %s', async (_label, extra) => {
    const { api, calls } = makeApi()
    const res = await callTool(
      req('send_widget', { chat_id: OWNER_CHAT, html: OK_HTML, caption: 'c', ...extra }),
      makeDeps(api),
    )
    expect(res.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test('a Bot API error is returned to the agent, secrets redacted, and the call is not retried', async () => {
    const { api, calls } = makeApi({
      fail: new Error(`Call to 'sendWidget' failed! (404: Not Found: method not found) bot ${FAKE_TOKEN}`),
    })
    const res = await callTool(req('send_widget', { chat_id: OWNER_CHAT, html: OK_HTML, caption: 'c' }), makeDeps(api))
    expect(res.isError).toBe(true)
    const text = res.content[0]?.text ?? ''
    expect(text).toContain('method not found')
    expect(text).not.toContain(FAKE_TOKEN)
    expect(calls).toHaveLength(1)
  })
})

describe('edit_widget_data', () => {
  test('edits the state of a sent widget with a numeric message id', async () => {
    const { api, calls } = makeApi()
    const res = await callTool(
      req('edit_widget_data', { chat_id: OWNER_CHAT, message_id: '777', chat_data: '{"j":[["a",5,"r"]]}' }),
      makeDeps(api),
    )
    expect(res.isError).toBeUndefined()
    expect(res.content[0]?.text).toContain('777')
    expect(calls).toEqual([
      { method: 'editWidgetData', chatId: OWNER_CHAT, messageId: 777, chatData: '{"j":[["a",5,"r"]]}' },
    ])
  })

  test('refuses chat_data over 1024 bytes', async () => {
    const { api, calls } = makeApi()
    const res = await callTool(
      req('edit_widget_data', { chat_id: OWNER_CHAT, message_id: '1', chat_data: 'я'.repeat(513) }),
      makeDeps(api),
    )
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('1024')
    expect(calls).toHaveLength(0)
  })

  test('refuses a non-numeric message id', async () => {
    const { api, calls } = makeApi()
    const res = await callTool(
      req('edit_widget_data', { chat_id: OWNER_CHAT, message_id: 'abc', chat_data: '{}' }),
      makeDeps(api),
    )
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('message_id')
    expect(calls).toHaveLength(0)
  })

  test('refuses a group chat id and a non-allowlisted chat', async () => {
    const { api, calls } = makeApi()
    const group = await callTool(
      req('edit_widget_data', { chat_id: GROUP_CHAT, message_id: '1', chat_data: '{}' }),
      makeDeps(api),
    )
    expect(group.isError).toBe(true)
    expect(group.content[0]?.text).toContain('private')
    const stranger = await callTool(
      req('edit_widget_data', { chat_id: '999', message_id: '1', chat_data: '{}' }),
      makeDeps(api),
    )
    expect(stranger.isError).toBe(true)
    expect(stranger.content[0]?.text).toContain('not allowlisted')
    expect(calls).toHaveLength(0)
  })

  test('a Bot API error is returned redacted and not retried', async () => {
    const { api, calls } = makeApi({ fail: new Error(`400: Bad Request: MESSAGE_NOT_WIDGET ${FAKE_TOKEN}`) })
    const res = await callTool(
      req('edit_widget_data', { chat_id: OWNER_CHAT, message_id: '1', chat_data: '{}' }),
      makeDeps(api),
    )
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('MESSAGE_NOT_WIDGET')
    expect(res.content[0]?.text).not.toContain(FAKE_TOKEN)
    expect(calls).toHaveLength(1)
  })
})

describe('createTelegramApi — raw request for the Bot API', () => {
  function fakeBot(handlers: Record<string, (body: Record<string, unknown>) => Promise<unknown>>): Bot {
    return { api: { raw: handlers } } as unknown as Bot
  }

  test('sendWidget posts chat_id + widget params through the raw escape hatch', async () => {
    const bodies: Record<string, unknown>[] = []
    const api = createTelegramApi(
      fakeBot({
        sendWidget: async body => {
          bodies.push(body)
          return { message_id: 42 }
        },
      }),
      'unused-token',
    )
    const out = await api.sendWidget(OWNER_CHAT, {
      html: OK_HTML,
      caption: 'cap',
      chat_data: '{}',
      width: 300,
      height: 100,
    })
    expect(out).toEqual({ message_id: 42 })
    expect(bodies).toEqual([
      { chat_id: OWNER_CHAT, html: OK_HTML, caption: 'cap', chat_data: '{}', width: 300, height: 100 },
    ])
  })

  test('sendWidget reads the message id from a nested result envelope too', async () => {
    const api = createTelegramApi(fakeBot({ sendWidget: async () => ({ result: { message_id: 9 } }) }), 't')
    expect(await api.sendWidget(OWNER_CHAT, { html: OK_HTML, caption: 'c' })).toEqual({ message_id: 9 })
  })

  test('sendWidget throws when Telegram returns no message id', async () => {
    const api = createTelegramApi(fakeBot({ sendWidget: async () => ({}) }), 't')
    await expect(api.sendWidget(OWNER_CHAT, { html: OK_HTML, caption: 'c' })).rejects.toThrow('message_id')
  })

  test('editWidgetData calls editMessageWidgetData with chat_id, message_id, chat_data', async () => {
    const bodies: Record<string, unknown>[] = []
    const api = createTelegramApi(
      fakeBot({
        editMessageWidgetData: async body => {
          bodies.push(body)
          return true
        },
      }),
      't',
    )
    await api.editWidgetData(OWNER_CHAT, 42, '{"a":1}')
    expect(bodies).toEqual([{ chat_id: OWNER_CHAT, message_id: 42, chat_data: '{"a":1}' }])
  })

  test('a server that does not know the method surfaces its error verbatim', async () => {
    const api = createTelegramApi(
      fakeBot({
        sendWidget: async () => {
          throw new Error('Call to \'sendWidget\' failed! (404: Not Found)')
        },
      }),
      't',
    )
    await expect(api.sendWidget(OWNER_CHAT, { html: OK_HTML, caption: 'c' })).rejects.toThrow('404: Not Found')
  })

  test('a raw API without the method reports a clear error instead of a TypeError', async () => {
    const api = createTelegramApi(fakeBot({}), 't')
    await expect(api.sendWidget(OWNER_CHAT, { html: OK_HTML, caption: 'c' })).rejects.toThrow('sendWidget')
    await expect(api.editWidgetData(OWNER_CHAT, 1, '{}')).rejects.toThrow('editMessageWidgetData')
  })
})

describe('templates/status.html', () => {
  const template = readFileSync(join(import.meta.dir, '..', '..', 'templates', 'status.html'), 'utf8')

  test('fits the Bot API limits: 32768 bytes raw, 4096 bytes after zlib level 9, no NUL', () => {
    const raw = Buffer.byteLength(template, 'utf8')
    const zipped = deflateSync(Buffer.from(template, 'utf8'), { level: 9 }).length
    console.log(`status.html: ${raw} bytes raw, ${zipped} bytes zlib-9`)
    expect(raw).toBeLessThanOrEqual(32768)
    expect(zipped).toBeLessThanOrEqual(4096)
    expect(template.includes('\u0000')).toBe(false)
  })

  test('is self-contained: no network, no external assets, no inputs', () => {
    expect(template).not.toMatch(/https?:\/\//i)
    expect(template).not.toMatch(/<link\b|<img\b|<iframe\b|<input\b|<button\b|<textarea\b|<form\b/i)
    expect(template).not.toMatch(/\bsrc\s*=|@import|url\(|fetch\(|XMLHttpRequest|WebSocket|eval\(|innerHTML/)
  })

  test('reads TelegramWidget.chatData and re-renders on chatDataChanged', () => {
    expect(template).toContain('TelegramWidget.chatData')
    expect(template).toContain('chatDataChanged')
  })

  test('survives the secret redactor unchanged (no 24+ char identifier runs)', () => {
    expect(redactSecrets(template)).toBe(template)
  })
})

describe('status chat_data shape (compact, short keys)', () => {
  // {"m":[[title,[[label,pct],...]],...],"j":[[name,pct,state],...],"l":limits}
  // state: r running, q queued, d done, f failed, b blocked.
  function payload(labelLen: number, cyr: boolean): string {
    const ch = cyr ? 'ы' : 'a'
    const label = (n: number): string => `${ch.repeat(labelLen - 1)}${n}`
    const groups = [1, 2, 3].map(g => [
      `${ch.repeat(8)}${g}`,
      [1, 2, 3, 4, 5].map(r => [label(r), 10 * r + g]),
    ])
    const jobs = Array.from({ length: 8 }, (_v, i) => [`${ch.repeat(12)}${i}`, 10 * i, 'rqdfbrqd'[i]])
    return JSON.stringify({ m: groups, j: jobs, l: cyr ? 'нед 41% / 12%' : 'wk 41% / 12%' })
  }

  test('3 groups x 5 rows + 8 jobs + limits line fits 1024 bytes (Latin labels up to 16 chars)', () => {
    const bytes = Buffer.byteLength(payload(16, false), 'utf8')
    console.log(`chat_data latin: ${bytes} bytes`)
    expect(bytes).toBeLessThanOrEqual(1024)
  })

  test('same payload with Cyrillic labels up to 12 chars fits 1024 bytes', () => {
    const bytes = Buffer.byteLength(payload(12, true), 'utf8')
    console.log(`chat_data cyrillic: ${bytes} bytes`)
    expect(bytes).toBeLessThanOrEqual(1024)
  })
})
