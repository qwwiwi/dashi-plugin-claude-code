// Tests for send_component / update_component / component_schema: html
// components from the vendored html-components packs, sent through the
// existing widget path, with a plain-text fallback so the owner never gets
// nothing.
//
// The whole outbound chain below the tool is real (safe layer -> raw grammY
// adapter); only the grammY Bot is faked, so every pack example also passes
// the last-layer size checks and the secret-redaction guard on widget code.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Bot } from 'grammy'

import {
  callTool,
  createTelegramApi,
  listTools,
  type CallToolRequest,
  type TelegramApi,
  type ToolDeps,
} from '../../src/channel/tools.js'
import { COMPONENT_NAMES, componentFallbackText } from '../../src/channel/components.js'
import type { AppConfig, StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import { createSafeTelegramApi } from '../../src/safety/safe-telegram-api.js'

const silentLog = createLogger('test', { stream: { write: () => true } as unknown as NodeJS.WritableStream })

// Synthetic ids on purpose (public repo): never a real chat id.
const OWNER_CHAT = '111111111'
const GROUP_CHAT = '-100222222222'
const OTHER_CHAT = '333333333'

const PACKS_DIR = join(import.meta.dir, '..', '..', 'vendor', 'html-components', 'telegram', 'packs')
const ALL_PACKS = [
  'kpi',
  'bars',
  'progress',
  'steps',
  'compare',
  'pros-cons',
  'faq',
  'status',
  'flowchart',
  'architecture',
  'line-area',
  'donut',
  'timeline-roadmap',
  'radar',
  'bars3d',
  'network3d',
]

function example(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PACKS_DIR, name, 'example.json'), 'utf8')) as Record<string, unknown>
}

interface Recorded {
  method: string
  body: Record<string, unknown>
}

// A fake grammY Bot: sendWidget goes through `api.raw` (as in production),
// sendMessage / deleteMessage through the typed api. `failWidget` makes the
// Bot API reject the widget; `failText` makes the plain-text send fail too.
function fakeBot(opts: { failWidget?: string; failText?: string; failDelete?: string } = {}): {
  bot: Bot
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  let nextId = 500
  const bot = {
    api: {
      raw: {
        sendWidget: async (body: Record<string, unknown>) => {
          calls.push({ method: 'sendWidget', body })
          if (opts.failWidget !== undefined) throw new Error(opts.failWidget)
          return { message_id: ++nextId }
        },
      },
      sendMessage: async (chat_id: string, text: string, other: Record<string, unknown>) => {
        calls.push({ method: 'sendMessage', body: { chat_id, text, ...other } })
        if (opts.failText !== undefined) throw new Error(opts.failText)
        return { message_id: ++nextId }
      },
      deleteMessage: async (chat_id: string, message_id: number) => {
        calls.push({ method: 'deleteMessage', body: { chat_id, message_id } })
        if (opts.failDelete !== undefined) throw new Error(opts.failDelete)
        return true
      },
    },
  } as unknown as Bot
  return { bot, calls }
}

function chain(bot: Bot): TelegramApi {
  return createSafeTelegramApi(createTelegramApi(bot, 'unused-token'), silentLog)
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

function text(res: { content: Array<{ text: string }> }): string {
  return res.content.map(c => c.text).join('\n')
}

describe('component tools — listing and descriptions', () => {
  test('send_component, update_component and component_schema are listed after the widget tools', () => {
    expect(listTools().map(t => t.name)).toEqual([
      'reply',
      'react',
      'download_attachment',
      'edit_message',
      'status',
      'autonomy',
      'send_widget',
      'edit_widget_data',
      'send_component',
      'update_component',
      'component_schema',
    ])
  })

  test('the plugin knows exactly the 16 vendored packs', () => {
    const known: string[] = [...COMPONENT_NAMES].sort()
    expect(known).toEqual([...ALL_PACKS].sort())
    expect(known).toEqual(readdirSync(PACKS_DIR).sort())
  })

  test('send_component description names every component and points at component_schema', () => {
    const tool = listTools().find(t => t.name === 'send_component')
    expect(tool).toBeDefined()
    for (const name of ALL_PACKS) expect(tool?.description).toContain(name)
    expect(tool?.description).toContain('component_schema')
    expect(tool?.inputSchema.required).toEqual(['chat_id', 'component', 'data'])
    const enumValues = (tool?.inputSchema.properties?.component as { enum?: string[] } | undefined)?.enum
    expect(enumValues?.slice().sort()).toEqual([...ALL_PACKS].sort())
  })

  test('update_component and component_schema declare their required fields', () => {
    const tools = listTools()
    expect(tools.find(t => t.name === 'update_component')?.inputSchema.required).toEqual([
      'chat_id',
      'message_id',
      'component',
      'data',
    ])
    expect(tools.find(t => t.name === 'component_schema')?.inputSchema.required).toEqual(['component'])
  })
})

describe('component tools — argument validation (nothing is sent)', () => {
  test.each([
    ['unknown component', { chat_id: OWNER_CHAT, component: 'pie', data: {} }, 'pie'],
    ['missing data', { chat_id: OWNER_CHAT, component: 'kpi' }, 'data'],
    ['data is not an object', { chat_id: OWNER_CHAT, component: 'kpi', data: [1, 2] }, 'data'],
    ['data is a string', { chat_id: OWNER_CHAT, component: 'kpi', data: '{"metrics":[]}' }, 'data'],
    ['missing chat_id', { component: 'kpi', data: example('kpi') }, 'chat_id'],
    ['non-numeric reply_to', { chat_id: OWNER_CHAT, component: 'kpi', data: example('kpi'), reply_to: 'abc' }, 'reply_to'],
    ['caption over 1024 characters', { chat_id: OWNER_CHAT, component: 'kpi', data: example('kpi'), caption: 'c'.repeat(1025) }, 'caption'],
  ])('send_component refuses %s', async (_label, args, field) => {
    const { bot, calls } = fakeBot()
    const res = await callTool(req('send_component', args), makeDeps(chain(bot)))
    expect(res.isError).toBe(true)
    expect(text(res)).toContain(field)
    expect(calls).toHaveLength(0)
  })

  test('update_component refuses a non-numeric message_id', async () => {
    const { bot, calls } = fakeBot()
    const res = await callTool(
      req('update_component', { chat_id: OWNER_CHAT, message_id: 'x1', component: 'kpi', data: example('kpi') }),
      makeDeps(chain(bot)),
    )
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('message_id')
    expect(calls).toHaveLength(0)
  })

  test('the chat allowlist gate applies: a chat that is not allowlisted gets nothing', async () => {
    const { bot, calls } = fakeBot()
    const res = await callTool(
      req('send_component', { chat_id: OTHER_CHAT, component: 'kpi', data: example('kpi') }),
      makeDeps(chain(bot)),
    )
    expect(res.isError).toBe(true)
    expect(text(res)).toContain(OTHER_CHAT)
    expect(calls).toHaveLength(0)
  })

  test('component_schema refuses an unknown component', async () => {
    const { bot } = fakeBot()
    const res = await callTool(req('component_schema', { component: 'pie' }), makeDeps(chain(bot)))
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('pie')
  })
})

describe('send_component — every pack example renders and goes out as a widget', () => {
  test.each(ALL_PACKS)('%s', async name => {
    const { bot, calls } = fakeBot()
    const res = await callTool(
      req('send_component', { chat_id: OWNER_CHAT, component: name, data: example(name) }),
      makeDeps(chain(bot)),
    )
    expect(res.isError).toBeUndefined()
    expect(calls.map(c => c.method)).toEqual(['sendWidget'])
    const body = calls[0]?.body ?? {}
    expect(body.chat_id).toBe(OWNER_CHAT)
    expect(String(body.html)).toContain(`<main class="${name}"`)
    // The widget caption is the text clients without widget support show.
    expect(String(body.caption).length).toBeGreaterThan(0)
    expect(text(res)).toContain('id: 501')
    expect(text(res)).not.toContain('fallback')
  })
})

describe('send_component — options', () => {
  test('caption overrides the generated one; reply_to threads the widget', async () => {
    const { bot, calls } = fakeBot()
    await callTool(
      req('send_component', {
        chat_id: OWNER_CHAT,
        component: 'progress',
        data: example('progress'),
        caption: 'Ход курса: 75%',
        reply_to: '42',
      }),
      makeDeps(chain(bot)),
    )
    expect(calls[0]?.body.caption).toBe('Ход курса: 75%')
    expect(calls[0]?.body.reply_parameters).toEqual({ message_id: 42 })
  })
})

describe('send_component — plain-text fallback (the owner never gets nothing)', () => {
  test('INVALID_DATA: no widget, a readable text with the data goes out, the result says so', async () => {
    const { bot, calls } = fakeBot()
    const data = { title: 'Ход курса', label: 'Пройдено занятий', value: 150 } // value must be 0..100
    const res = await callTool(
      req('send_component', { chat_id: OWNER_CHAT, component: 'progress', data }),
      makeDeps(chain(bot)),
    )
    expect(res.isError).toBeUndefined()
    expect(calls.map(c => c.method)).toEqual(['sendMessage'])
    const sent = String(calls[0]?.body.text)
    expect(sent).toContain('Ход курса')
    expect(sent).toContain('Пройдено занятий')
    expect(sent).toContain('150')
    // Plain text: no parse mode, so no markup can break it.
    expect(calls[0]?.body.parse_mode).toBeUndefined()
    const out = text(res)
    expect(out).toContain('INVALID_DATA')
    expect(out).toContain('plain-text')
    expect(out).toContain('component_schema')
  })

  test('render failure on data of an unexpected shape still produces readable text', async () => {
    const { bot, calls } = fakeBot()
    const data = { title: 'Итоги', something: { nested: ['альфа', 7] } }
    const res = await callTool(
      req('send_component', { chat_id: OWNER_CHAT, component: 'kpi', data }),
      makeDeps(chain(bot)),
    )
    expect(res.isError).toBeUndefined()
    expect(calls.map(c => c.method)).toEqual(['sendMessage'])
    const sent = String(calls[0]?.body.text)
    expect(sent).toContain('Итоги')
    expect(sent).toContain('альфа')
    expect(sent).toContain('7')
  })

  test('HTML_LIMIT: too much data for one widget falls back to text', async () => {
    const { bot, calls } = fakeBot()
    const items = Array.from({ length: 8 }, (_, i) => ({
      question: `Вопрос ${i} ` + 'длинный текст вопроса '.repeat(3),
      answer: `Ответ ${i} ` + 'подробный ответ без повторов '.repeat(6),
    }))
    const res = await callTool(
      req('send_component', { chat_id: OWNER_CHAT, component: 'faq', data: { title: 'FAQ', items } }),
      makeDeps(chain(bot)),
    )
    expect(res.isError).toBeUndefined()
    expect(calls.map(c => c.method)).toEqual(['sendMessage'])
    expect(text(res)).toMatch(/INVALID_DATA|HTML_LIMIT/)
  })

  test('Telegram rejects the widget: the plain-text version goes out and the result names the error', async () => {
    const { bot, calls } = fakeBot({ failWidget: 'Bad Request: INPUT_MEDIA_WIDGET_HTML_INVALID' })
    const res = await callTool(
      req('send_component', { chat_id: OWNER_CHAT, component: 'kpi', data: example('kpi'), reply_to: '42' }),
      makeDeps(chain(bot)),
    )
    expect(res.isError).toBeUndefined()
    expect(calls.map(c => c.method)).toEqual(['sendWidget', 'sendMessage'])
    const sent = String(calls[1]?.body.text)
    expect(sent).toContain('Итоги практикума')
    expect(sent).toContain('Участников 48')
    expect(calls[1]?.body.reply_parameters).toEqual({ message_id: 42 })
    const out = text(res)
    // The Bot API error is named (secret-looking 24+ char runs are masked,
    // as for every tool error).
    expect(out).toContain('Telegram did not accept the widget: Bad Request')
    expect(out).toContain('plain-text')
  })

  test('a group chat (widgets are private-only) gets the plain-text version without a widget attempt', async () => {
    const { bot, calls } = fakeBot()
    const res = await callTool(
      req('send_component', { chat_id: GROUP_CHAT, component: 'steps', data: example('steps') }),
      makeDeps(chain(bot)),
    )
    expect(res.isError).toBeUndefined()
    expect(calls.map(c => c.method)).toEqual(['sendMessage'])
    expect(String(calls[0]?.body.text)).toContain('1. ')
    expect(text(res)).toContain('plain-text')
  })

  test('widget AND text both fail: an error result naming both, so the agent knows nothing arrived', async () => {
    const { bot } = fakeBot({ failWidget: 'widget boom', failText: 'text boom' })
    const res = await callTool(
      req('send_component', { chat_id: OWNER_CHAT, component: 'kpi', data: example('kpi') }),
      makeDeps(chain(bot)),
    )
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('widget boom')
    expect(text(res)).toContain('text boom')
  })
})

describe('update_component — widget code is frozen, so an update is a fresh widget', () => {
  test('renders the new data, sends a new widget, deletes the old message, returns the new id', async () => {
    const { bot, calls } = fakeBot()
    const res = await callTool(
      req('update_component', { chat_id: OWNER_CHAT, message_id: '77', component: 'progress', data: example('progress') }),
      makeDeps(chain(bot)),
    )
    expect(res.isError).toBeUndefined()
    expect(calls.map(c => c.method)).toEqual(['sendWidget', 'deleteMessage'])
    expect(calls[1]?.body).toEqual({ chat_id: OWNER_CHAT, message_id: 77 })
    expect(text(res)).toContain('id: 501')
    expect(text(res)).toContain('77')
  })

  test('Telegram rejects the new widget: text fallback goes out and the old message is KEPT', async () => {
    const { bot, calls } = fakeBot({ failWidget: 'Bad Request: INPUT_MEDIA_WIDGET_TOO_LARGE' })
    const res = await callTool(
      req('update_component', { chat_id: OWNER_CHAT, message_id: '77', component: 'progress', data: example('progress') }),
      makeDeps(chain(bot)),
    )
    expect(res.isError).toBeUndefined()
    expect(calls.map(c => c.method)).toEqual(['sendWidget', 'sendMessage'])
    expect(text(res)).toContain('plain-text')
    expect(text(res)).toContain('Telegram did not accept the widget: Bad Request')
  })

  test('render error: text fallback, no widget attempt, old message kept', async () => {
    const { bot, calls } = fakeBot()
    const res = await callTool(
      req('update_component', { chat_id: OWNER_CHAT, message_id: '77', component: 'progress', data: { label: 'x', value: -1 } }),
      makeDeps(chain(bot)),
    )
    expect(res.isError).toBeUndefined()
    expect(calls.map(c => c.method)).toEqual(['sendMessage'])
    expect(text(res)).toContain('INVALID_DATA')
  })

  test('a failed delete of the old message is reported, the new widget still counts as sent', async () => {
    const { bot, calls } = fakeBot({ failDelete: 'Bad Request: message to delete not found' })
    const res = await callTool(
      req('update_component', { chat_id: OWNER_CHAT, message_id: '77', component: 'kpi', data: example('kpi') }),
      makeDeps(chain(bot)),
    )
    expect(res.isError).toBeUndefined()
    expect(calls.map(c => c.method)).toEqual(['sendWidget', 'deleteMessage'])
    expect(text(res)).toContain('id: 501')
    expect(text(res)).toContain('message to delete not found')
  })
})

describe('component_schema', () => {
  test.each(ALL_PACKS)('%s returns the pack schema and its example', async name => {
    const { bot, calls } = fakeBot()
    const res = await callTool(req('component_schema', { component: name }), makeDeps(chain(bot)))
    expect(res.isError).toBeUndefined()
    const parsed = JSON.parse(text(res)) as { component: string; schema: unknown; example: unknown }
    expect(parsed.component).toBe(name)
    expect(parsed.schema).toEqual(JSON.parse(readFileSync(join(PACKS_DIR, name, 'schema.json'), 'utf8')))
    expect(parsed.example).toEqual(example(name))
    expect(calls).toHaveLength(0)
  })
})

describe('componentFallbackText', () => {
  test.each(ALL_PACKS)('%s example gives a short readable text with the title', name => {
    const data = example(name)
    const out = componentFallbackText(name, data)
    expect(out.length).toBeGreaterThan(0)
    expect(out.length).toBeLessThanOrEqual(4096)
    if (typeof data.title === 'string') expect(out).toContain(data.title)
    expect(out).not.toContain('<')
  })

  test('a huge payload is cut to one Telegram message', () => {
    const out = componentFallbackText('steps', { steps: Array.from({ length: 500 }, (_, i) => `шаг ${i} `.repeat(5)) })
    expect(out.length).toBeLessThanOrEqual(4096)
  })
})
