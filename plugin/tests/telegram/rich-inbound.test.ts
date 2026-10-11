// Unit tests for inbound Bot API 10.1 rich messages (src/telegram/rich-inbound.ts).
//
// Bug (2026-10-11): the owner sent a long "Rich" formatted prompt with a
// screenshot. The plugin only listens on `message:text` / media captions, and a
// rich message carries its content in `message.rich_message.blocks` — so the
// text was dropped and only the photo reached the session.

import { describe, expect, test } from 'bun:test'

import {
  normalizeRichInbound,
  richMessageToText,
} from '../../src/telegram/rich-inbound.js'

const photoSizes = [
  { file_id: 'small', file_unique_id: 'u1', width: 90, height: 90 },
  { file_id: 'big', file_unique_id: 'u2', width: 1280, height: 720 },
]

describe('richMessageToText', () => {
  test('flattens paragraphs, headings, lists, quotes, code and tables', () => {
    const text = richMessageToText({
      blocks: [
        { type: 'heading', size: 2, text: 'Задача' },
        { type: 'paragraph', text: ['Сделай ', { type: 'bold', text: 'туннель' }, ' для зоны'] },
        {
          type: 'list',
          items: [
            { label: '1.', value: 1, blocks: [{ type: 'paragraph', text: 'создай tunnel' }] },
            { label: '2.', value: 2, has_checkbox: true, is_checked: true, blocks: [{ type: 'paragraph', text: 'DNS' }] },
          ],
        },
        { type: 'blockquote', blocks: [{ type: 'paragraph', text: 'цитата' }] },
        { type: 'pre', language: 'bash', text: 'echo hi' },
        { type: 'divider' },
        {
          type: 'table',
          cells: [
            [{ text: 'host', is_header: true, align: 'left', valign: 'top' }, { text: 'port', is_header: true, align: 'left', valign: 'top' }],
            [{ text: 'app', align: 'left', valign: 'top' }, { text: '3080', align: 'left', valign: 'top' }],
          ],
        },
        { type: 'paragraph', text: { type: 'url', text: 'ссылка', url: 'https://example.com' } },
      ],
    })
    expect(text).toBe(
      [
        '## Задача',
        'Сделай туннель для зоны',
        '1. создай tunnel\n2. [x] DNS',
        '> цитата',
        '```bash\necho hi\n```',
        '---',
        '| host | port |\n| app | 3080 |',
        'ссылка (https://example.com)',
      ].join('\n\n'),
    )
  })

  test('media blocks keep their caption text and a marker', () => {
    const text = richMessageToText({
      blocks: [
        { type: 'paragraph', text: 'Смотри скрин' },
        { type: 'photo', photo: photoSizes, caption: { text: 'ошибка в логе' } },
      ],
    })
    expect(text).toBe('Смотри скрин\n\n[фото] ошибка в логе')
  })

  test('unknown block and text types degrade to their text, never throw', () => {
    const text = richMessageToText({
      blocks: [
        { type: 'future_block', text: 'новое' },
        { type: 'paragraph', text: [{ type: 'future_inline', text: 'x' }, { type: 'custom_emoji', alternative_text: '!' }] },
        null,
        42,
      ],
    })
    expect(text).toBe('новое\n\nx!')
  })

  test('returns empty string for malformed input', () => {
    expect(richMessageToText(undefined)).toBe('')
    expect(richMessageToText({ blocks: 'nope' })).toBe('')
  })
})

describe('normalizeRichInbound', () => {
  test('text-only rich message becomes message.text', () => {
    const msg: Record<string, unknown> = {
      message_id: 1,
      rich_message: { blocks: [{ type: 'paragraph', text: 'длинный промт' }] },
    }
    expect(normalizeRichInbound(msg)).toBe(true)
    expect(msg.text).toBe('длинный промт')
    expect(msg.caption).toBeUndefined()
  })

  test('rich message with a top-level photo gets the text as caption (the reported bug)', () => {
    const msg: Record<string, unknown> = {
      message_id: 2,
      photo: photoSizes,
      rich_message: {
        blocks: [
          { type: 'paragraph', text: 'промт для Тралла' },
          { type: 'photo', photo: photoSizes },
        ],
      },
    }
    expect(normalizeRichInbound(msg)).toBe(true)
    expect(msg.caption).toBe('промт для Тралла\n\n[фото]')
    expect(msg.text).toBeUndefined()
  })

  test('photo only inside a block is promoted so the photo handler downloads it', () => {
    const msg: Record<string, unknown> = {
      message_id: 3,
      rich_message: {
        blocks: [
          { type: 'paragraph', text: 'текст' },
          { type: 'photo', photo: photoSizes },
        ],
      },
    }
    expect(normalizeRichInbound(msg)).toBe(true)
    expect(msg.photo).toEqual(photoSizes)
    expect(msg.caption).toBe('текст\n\n[фото]')
    expect(msg.text).toBeUndefined()
  })

  test('first media block wins and later ones are reported as not attached', () => {
    const msg: Record<string, unknown> = {
      message_id: 4,
      rich_message: {
        blocks: [
          { type: 'document', document: { file_id: 'doc', file_unique_id: 'd' } },
          { type: 'photo', photo: photoSizes },
        ],
      },
    }
    normalizeRichInbound(msg)
    expect(msg.document).toEqual({ file_id: 'doc', file_unique_id: 'd' })
    expect(msg.photo).toBeUndefined()
    expect(msg.caption).toBe('[документ]\n\n[фото]\n\n[в rich-сообщении ещё 1 медиа – не приложено]')
  })

  test('media nested in a collage is found', () => {
    const msg: Record<string, unknown> = {
      message_id: 5,
      rich_message: { blocks: [{ type: 'collage', blocks: [{ type: 'video', video: { file_id: 'v' } }] }] },
    }
    normalizeRichInbound(msg)
    expect(msg.video).toEqual({ file_id: 'v' })
  })

  test('never overwrites existing text or caption', () => {
    const withText: Record<string, unknown> = { text: 'orig', rich_message: { blocks: [{ type: 'paragraph', text: 'x' }] } }
    expect(normalizeRichInbound(withText)).toBe(false)
    expect(withText.text).toBe('orig')
    const withCaption: Record<string, unknown> = {
      photo: photoSizes,
      caption: 'orig',
      rich_message: { blocks: [{ type: 'paragraph', text: 'x' }] },
    }
    expect(normalizeRichInbound(withCaption)).toBe(false)
    expect(withCaption.caption).toBe('orig')
  })

  test('no rich_message: untouched', () => {
    const msg: Record<string, unknown> = { message_id: 6, text: 'hi' }
    expect(normalizeRichInbound(msg)).toBe(false)
    expect(msg).toEqual({ message_id: 6, text: 'hi' })
  })
})

describe('richInboundMiddleware with a real grammY Bot', () => {
  const botInfo = {
    id: 1, is_bot: true as const, first_name: 'b', username: 'b_bot',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
    allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
  }
  const base = { message_id: 10, date: 0, chat: { id: 7, type: 'private' as const, first_name: 'o' }, from: { id: 7, is_bot: false, first_name: 'o' } }

  async function route(message: Record<string, unknown>): Promise<{ kind: string; body: string | undefined }[]> {
    const { Bot } = await import('grammy')
    const { richInboundMiddleware } = await import('../../src/telegram/rich-inbound.js')
    const bot = new Bot('123:abc', { botInfo })
    const seen: { kind: string; body: string | undefined }[] = []
    bot.use(richInboundMiddleware())
    bot.on('message:text', ctx => { seen.push({ kind: 'text', body: ctx.message.text }) })
    bot.on('message:photo', ctx => { seen.push({ kind: 'photo', body: ctx.message.caption }) })
    await bot.handleUpdate({ update_id: 1, message: { ...base, ...message } } as never)
    return seen
  }

  test('rich text-only message reaches the text handler', async () => {
    expect(await route({ rich_message: { blocks: [{ type: 'paragraph', text: 'промт' }] } })).toEqual([
      { kind: 'text', body: 'промт' },
    ])
  })

  test('rich message with a screenshot reaches the photo handler WITH its text', async () => {
    expect(
      await route({
        photo: photoSizes,
        rich_message: { blocks: [{ type: 'paragraph', text: 'промт' }, { type: 'photo', photo: photoSizes }] },
      }),
    ).toEqual([{ kind: 'photo', body: 'промт\n\n[фото]' }])
  })
})
