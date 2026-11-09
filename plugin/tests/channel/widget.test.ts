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
import { createSafeTelegramApi } from '../../src/safety/safe-telegram-api.js'
import { checkWidgetCaption, checkWidgetHtml, zlibBytes } from '../../src/channel/widget.js'

const silentLog = createLogger('test', { stream: { write: () => true } as unknown as NodeJS.WritableStream })

// Synthetic ids on purpose (public repo): never a real chat id.
const OWNER_CHAT = '111111111'
const GROUP_CHAT = '-100222222222'
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
      allowed_user_ids: [Number(OWNER_CHAT)],
      allowed_chat_ids: [Number(OWNER_CHAT), Number(GROUP_CHAT)],
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

// ─── fix loop 1 (review 07e7): boundaries, final payload, caption ──────────

// html of the form <div>NOISE</div> whose zlib level-9 size is exactly `target`.
// noise() is a deterministic prefix-stable stream, so the size grows with n.
function htmlWithZlib(target: number): string {
  for (let n = 1; n < 12000; n++) {
    const html = `<div>${noise(n)}</div>`
    const z = zlibBytes(html)
    if (z === target) return html
    if (z > target) break
  }
  throw new Error(`no noise html with zlib size ${target}`)
}

function htmlOfBytes(bytes: number): string {
  const head = '<p>'
  const tail = '</p>'
  return head + ' '.repeat(bytes - head.length - tail.length) + tail
}

describe('size boundaries — tool level', () => {
  async function sendHtml(html: string): Promise<{ isError?: boolean | undefined; text: string; calls: number }> {
    const { api, calls } = makeApi()
    const res = await callTool(req('send_widget', { chat_id: OWNER_CHAT, html, caption: 'c' }), makeDeps(api))
    return { isError: res.isError, text: res.content[0]?.text ?? '', calls: calls.length }
  }

  test('html of exactly 32768 bytes is accepted, 32769 is refused', async () => {
    const ok = htmlOfBytes(32768)
    expect(Buffer.byteLength(ok)).toBe(32768)
    expect((await sendHtml(ok)).isError).toBeUndefined()
    const bad = await sendHtml(htmlOfBytes(32769))
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('32769')
    expect(bad.calls).toBe(0)
  })

  test('html of exactly 32768 bytes of multi-byte characters is accepted, one byte more refused', async () => {
    const ok = 'я'.repeat(16384) // 32768 bytes
    expect(Buffer.byteLength(ok)).toBe(32768)
    // identical text compresses to a few bytes, so only the raw cap is exercised
    expect((await sendHtml(ok)).isError).toBeUndefined()
    expect((await sendHtml(`${ok}a`)).isError).toBe(true)
  })

  test('html with zlib level-9 size 4096 is accepted, 4097 is refused', async () => {
    const ok = htmlWithZlib(4096)
    const bad = htmlWithZlib(4097)
    expect(zlibBytes(ok)).toBe(4096)
    expect(zlibBytes(bad)).toBe(4097)
    expect((await sendHtml(ok)).isError).toBeUndefined()
    const refused = await sendHtml(bad)
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('4097')
    expect(refused.calls).toBe(0)
  })

  test('chat_data of exactly 1024 bytes (multi-byte) is accepted, 1025 refused — send and edit', async () => {
    const ok = 'я'.repeat(512) // 1024 bytes
    const bad = `${ok}a` // 1025 bytes
    const { api, calls } = makeApi()
    const deps = makeDeps(api)
    const sendOk = await callTool(req('send_widget', { chat_id: OWNER_CHAT, html: OK_HTML, caption: 'c', chat_data: ok }), deps)
    expect(sendOk.isError).toBeUndefined()
    const sendBad = await callTool(req('send_widget', { chat_id: OWNER_CHAT, html: OK_HTML, caption: 'c', chat_data: bad }), deps)
    expect(sendBad.isError).toBe(true)
    expect(sendBad.content[0]?.text).toContain('1025')
    const editOk = await callTool(req('edit_widget_data', { chat_id: OWNER_CHAT, message_id: '1', chat_data: ok }), deps)
    expect(editOk.isError).toBeUndefined()
    const editBad = await callTool(req('edit_widget_data', { chat_id: OWNER_CHAT, message_id: '1', chat_data: bad }), deps)
    expect(editBad.isError).toBe(true)
    expect(calls).toHaveLength(2)
  })

  test('caption of exactly 1024 characters is accepted, 1025 is refused', async () => {
    const { api, calls } = makeApi()
    const deps = makeDeps(api)
    const ok = await callTool(req('send_widget', { chat_id: OWNER_CHAT, html: OK_HTML, caption: 'c'.repeat(1024) }), deps)
    expect(ok.isError).toBeUndefined()
    const bad = await callTool(req('send_widget', { chat_id: OWNER_CHAT, html: OK_HTML, caption: 'c'.repeat(1025) }), deps)
    expect(bad.isError).toBe(true)
    expect(bad.content[0]?.text).toContain('1024')
    expect(bad.content[0]?.text).toContain('caption')
    expect(calls).toHaveLength(1)
  })

  test('edit_widget_data with an EMPTY chat_data is allowed (it removes the state) and is passed through', async () => {
    const { api, calls } = makeApi()
    const res = await callTool(req('edit_widget_data', { chat_id: OWNER_CHAT, message_id: '5', chat_data: '' }), makeDeps(api))
    expect(res.isError).toBeUndefined()
    expect(calls).toEqual([{ method: 'editWidgetData', chatId: OWNER_CHAT, messageId: 5, chatData: '' }])
  })

  test('the edit_widget_data schema says that an empty chat_data removes the value', () => {
    const tool = listTools().find(t => t.name === 'edit_widget_data')
    const props = tool?.inputSchema.properties as Record<string, { description?: string }>
    expect(props.chat_data?.description?.toLowerCase()).toContain('empty string')
    expect(props.chat_data?.description?.toLowerCase()).toContain('remove')
  })

  test('the send_widget schema states the caption limit', () => {
    const tool = listTools().find(t => t.name === 'send_widget')
    const props = tool?.inputSchema.properties as Record<string, { description?: string }>
    expect(props.caption?.description).toContain('1024')
  })

  test('checkWidgetCaption / checkWidgetHtml are pure and agree with the tool', () => {
    expect(checkWidgetCaption('c'.repeat(1024))).toBeUndefined()
    expect(checkWidgetCaption('c'.repeat(1025))).toContain('1024')
    expect(checkWidgetHtml(htmlOfBytes(32768))).toBeUndefined()
    expect(checkWidgetHtml(htmlOfBytes(32769))).toContain('32769')
  })
})

describe('F2 — limits are re-checked on the FINAL payload at the last layer (createTelegramApi)', () => {
  function recordingBot(): { bot: Bot; bodies: Array<{ method: string; body: Record<string, unknown> }> } {
    const bodies: Array<{ method: string; body: Record<string, unknown> }> = []
    const handler = (method: string) => async (body: Record<string, unknown>) => {
      bodies.push({ method, body })
      return { message_id: 1 }
    }
    const bot = {
      api: { raw: { sendWidget: handler('sendWidget'), editMessageWidgetData: handler('editMessageWidgetData') } },
    } as unknown as Bot
    return { bot, bodies }
  }

  test('oversized html never reaches the raw call', async () => {
    const { bot, bodies } = recordingBot()
    const api = createTelegramApi(bot, 't')
    await expect(api.sendWidget(OWNER_CHAT, { html: htmlOfBytes(32769), caption: 'c' })).rejects.toThrow('32769')
    await expect(api.sendWidget(OWNER_CHAT, { html: htmlWithZlib(4097), caption: 'c' })).rejects.toThrow('4097')
    expect(bodies).toHaveLength(0)
  })

  test('oversized chat_data and caption never reach the raw call (send and edit)', async () => {
    const { bot, bodies } = recordingBot()
    const api = createTelegramApi(bot, 't')
    await expect(api.sendWidget(OWNER_CHAT, { html: OK_HTML, caption: 'c', chat_data: 'x'.repeat(1025) })).rejects.toThrow('1025')
    await expect(api.editWidgetData(OWNER_CHAT, 1, 'я'.repeat(513))).rejects.toThrow('1024')
    await expect(api.sendWidget(OWNER_CHAT, { html: OK_HTML, caption: 'c'.repeat(1025) })).rejects.toThrow('caption')
    expect(bodies).toHaveLength(0)
  })

  test('payloads exactly at the limits go through', async () => {
    const { bot, bodies } = recordingBot()
    const api = createTelegramApi(bot, 't')
    await api.sendWidget(OWNER_CHAT, { html: htmlOfBytes(32768), caption: 'c'.repeat(1024), chat_data: 'я'.repeat(512) })
    await api.sendWidget(OWNER_CHAT, { html: htmlWithZlib(4096), caption: 'c' })
    await api.editWidgetData(OWNER_CHAT, 1, 'я'.repeat(512))
    expect(bodies).toHaveLength(3)
  })

  test('safe -> last layer: a 1024-byte chat_data that the redactor would expand never leaves the process', async () => {
    const { bot, bodies } = recordingBot()
    const safe = createSafeTelegramApi(createTelegramApi(bot, 't'), silentLog)
    const chat_data = `${' '.repeat(1018)}?key=x` // 1024 bytes; the redactor would turn it into 1033
    expect(Buffer.byteLength(chat_data)).toBe(1024)
    await expect(safe.sendWidget(OWNER_CHAT, { html: OK_HTML, caption: 'c', chat_data })).rejects.toThrow()
    await expect(safe.editWidgetData(OWNER_CHAT, 1, chat_data)).rejects.toThrow()
    expect(bodies).toHaveLength(0)
  })

  test('safe -> last layer: a 32768-byte html that the redactor would expand never leaves the process', async () => {
    const { bot, bodies } = recordingBot()
    const safe = createSafeTelegramApi(createTelegramApi(bot, 't'), silentLog)
    const html = '<p title="?key=x">x</p>'.padEnd(32768, ' ')
    expect(Buffer.byteLength(html)).toBe(32768)
    await expect(safe.sendWidget(OWNER_CHAT, { html, caption: 'c' })).rejects.toThrow()
    expect(bodies).toHaveLength(0)
  })

  test('the tool surfaces that failure as an error and does not claim success', async () => {
    const { bot, bodies } = recordingBot()
    const safe = createSafeTelegramApi(createTelegramApi(bot, 't'), silentLog)
    const res = await callTool(
      req('send_widget', { chat_id: OWNER_CHAT, html: '<p title="?key=x">x</p>'.padEnd(32768, ' '), caption: 'c' }),
      makeDeps(safe),
    )
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).not.toContain('widget sent')
    expect(bodies).toHaveLength(0)
  })
})

describe('F4 — the widget fixtures hold only synthetic ids', () => {
  const root = join(import.meta.dir, '..', '..')
  const files = [
    'tests/channel/widget.test.ts',
    'tests/safety/widget-wrappers.test.ts',
    'docs/widgets.md',
    'templates/status.html',
  ]
  // Synthetic ids, the digits of the documented example bot-token shape, and the
  // digit run of the noise() alphabet constant (not an id).
  const ALLOWED = new Set(['111111111', '222222222', '100222222222', '123456789', '0123456789'])

  test('every digit run of 8+ is on the synthetic allowlist', () => {
    const offenders: string[] = []
    for (const f of files) {
      const text = readFileSync(join(root, f), 'utf8')
      for (const m of text.matchAll(/\d{8,}/g)) {
        if (!ALLOWED.has(m[0])) offenders.push(`${f}: ${m[0].slice(0, 3)}*** (${m[0].length} digits)`)
      }
    }
    expect(offenders).toEqual([])
  })
})
