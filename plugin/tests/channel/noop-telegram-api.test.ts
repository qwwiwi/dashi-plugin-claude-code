import { describe, expect, test } from 'bun:test'

import { createNoopTelegramApi } from '../../src/channel/noop-telegram-api.js'

describe('noop TelegramApi (webhook-only)', () => {
  const api = createNoopTelegramApi()

  test('sendMessage throws fail-loud', async () => {
    await expect(api.sendMessage('1', 'x', {})).rejects.toThrow(/webhook-only/)
  })
  test('downloadFile throws fail-loud', async () => {
    await expect(api.downloadFile('f', '/tmp')).rejects.toThrow(/webhook-only/)
  })
  test('deleteMessage throws fail-loud', async () => {
    await expect(api.deleteMessage('1', 2)).rejects.toThrow(/webhook-only/)
  })
})
