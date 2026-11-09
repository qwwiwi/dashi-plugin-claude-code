// The widget methods must pass through the same safety layers as the other
// outbound calls: redaction (safe), per-chat queue (rate-limited), and the
// reliable layer's no-retry-on-ambiguous rule for non-idempotent sends.

import { describe, expect, test } from 'bun:test'

import type { TelegramApi } from '../../src/channel/tools.js'
import { createLogger } from '../../src/log.js'
import { createRateLimitedTelegramApi } from '../../src/safety/rate-limited-telegram-api.js'
import { createReliableTelegramApi } from '../../src/safety/reliable-telegram-api.js'
import { createSafeTelegramApi } from '../../src/safety/safe-telegram-api.js'

const log = createLogger('test', { stream: { write: () => true } as unknown as NodeJS.WritableStream })
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'

interface Seen {
  send: Array<{ chatId: string; params: Record<string, unknown> }>
  edit: Array<{ chatId: string; messageId: number; chatData: string }>
}

function recorder(failWith?: Error): { raw: TelegramApi; seen: Seen } {
  const seen: Seen = { send: [], edit: [] }
  const raw = {
    async sendWidget(chatId: string, params: Record<string, unknown>) {
      seen.send.push({ chatId, params })
      if (failWith) throw failWith
      return { message_id: 5 }
    },
    async editWidgetData(chatId: string, messageId: number, chatData: string) {
      seen.edit.push({ chatId, messageId, chatData })
      if (failWith) throw failWith
    },
  } as unknown as TelegramApi
  return { raw, seen }
}

describe('safe wrapper', () => {
  test('redacts secrets in html, caption and chat_data before the raw call', async () => {
    const { raw, seen } = recorder()
    const safe = createSafeTelegramApi(raw, log)
    const res = await safe.sendWidget('1', {
      html: `<div>${TOKEN}</div>`,
      caption: `cap ${TOKEN}`,
      chat_data: `{"k":"${TOKEN}"}`,
      width: 100,
    })
    expect(res).toEqual({ message_id: 5 })
    const params = seen.send[0]?.params ?? {}
    expect(JSON.stringify(params)).not.toContain(TOKEN)
    expect(params.width).toBe(100)
  })

  test('redacts chat_data on edit', async () => {
    const { raw, seen } = recorder()
    await createSafeTelegramApi(raw, log).editWidgetData('1', 3, `{"k":"${TOKEN}"}`)
    expect(seen.edit[0]?.chatData).not.toContain(TOKEN)
  })
})

describe('rate-limited wrapper', () => {
  test('forwards sendWidget and editWidgetData', async () => {
    const { raw, seen } = recorder()
    const api = createRateLimitedTelegramApi(raw, log)
    expect(await api.sendWidget('1', { html: '<b>x</b>', caption: 'c' })).toEqual({ message_id: 5 })
    await api.editWidgetData('1', 5, '{}')
    expect(seen.send).toHaveLength(1)
    expect(seen.edit).toHaveLength(1)
  })
})

describe('reliable wrapper', () => {
  test('sendWidget is NOT retried on an ambiguous transport error (no duplicate card)', async () => {
    const { raw, seen } = recorder(new Error('read ECONNRESET'))
    const api = createReliableTelegramApi(raw, log, { sleep: async () => {} })
    await expect(api.sendWidget('1', { html: '<b>x</b>', caption: 'c' })).rejects.toThrow('ECONNRESET')
    expect(seen.send).toHaveLength(1)
  })

  test('a successful sendWidget stamps the outbound-activity clock', async () => {
    const { raw } = recorder()
    const stamped: string[] = []
    const api = createReliableTelegramApi(raw, log, { recordOutbound: chatId => void stamped.push(chatId) })
    await api.sendWidget('42', { html: '<b>x</b>', caption: 'c' })
    expect(stamped).toEqual(['42'])
  })

  test('editWidgetData passes straight through', async () => {
    const { raw, seen } = recorder()
    await createReliableTelegramApi(raw, log).editWidgetData('1', 5, '{}')
    expect(seen.edit).toEqual([{ chatId: '1', messageId: 5, chatData: '{}' }])
  })
})
