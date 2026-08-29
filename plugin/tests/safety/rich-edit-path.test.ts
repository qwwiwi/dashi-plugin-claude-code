// Wave 2: the safe wrapper's rich-EDIT error contract. These four branches
// are where a naive port loses or duplicates a message, so each gets a test:
//   not-modified → ok (no legacy retry)  ·  capability → latch + fallback
//   parser       → fallback (no latch)   ·  transient  → THROW (no retry)

import { describe, expect, test } from 'bun:test'
import type { TelegramApi } from '../../src/channel/tools.js'
import { createLogger } from '../../src/log.js'
import { createSafeTelegramApi } from '../../src/safety/safe-telegram-api.js'
import { createRichLatch } from '../../src/safety/rich-latch.js'

const silentLog = createLogger('test', {
  stream: { write: () => true } as unknown as NodeJS.WritableStream,
})
const DM = '164795011'

function makeInner(
  editBehaviour: (md: string) => Promise<{ ok: true } | { fallback: true }>,
  seen: { md: string[] },
): TelegramApi {
  return {
    async sendMessage() { return { message_id: 1 } },
    async sendRichMessage() { return { fallback: true } as const },
    async editRichMessage(_chatId: string, _messageId: number, rawMarkdown: string) {
      seen.md.push(rawMarkdown)
      return editBehaviour(rawMarkdown)
    },
    async editMessageText() {},
    async setMessageReaction() {},
    async sendChatAction() {},
    async sendDocument() { return { message_id: 2 } },
    async sendPhoto() { return { message_id: 3 } },
    async downloadFile() { return { path: '/tmp/x' } },
    async deleteMessage() {},
    async answerGuestQuery() {},
  } as unknown as TelegramApi
}

describe('safe wrapper — rich edit', () => {
  test('success passes through as ok', async () => {
    const seen = { md: [] as string[] }
    const latch = createRichLatch()
    const safe = createSafeTelegramApi(makeInner(async () => ({ ok: true }), seen), silentLog, undefined, latch)
    expect(await safe.editRichMessage(DM, 7, 'x')).toEqual({ ok: true })
  })

  test('"not modified" is a SUCCESS, not a fallback — no legacy retry', async () => {
    const seen = { md: [] as string[] }
    const latch = createRichLatch()
    const safe = createSafeTelegramApi(
      makeInner(async () => { throw { error_code: 400, description: 'Bad Request: message is not modified' } }, seen),
      silentLog, undefined, latch,
    )
    expect(await safe.editRichMessage(DM, 7, 'x')).toEqual({ ok: true })
    expect(latch.sendDisabled).toBe(false)
  })

  test('capability error latches rich off and reports fallback', async () => {
    const seen = { md: [] as string[] }
    const latch = createRichLatch()
    const safe = createSafeTelegramApi(
      makeInner(async () => { throw { error_code: 404, description: 'Not Found: method not found' } }, seen),
      silentLog, undefined, latch,
    )
    expect(await safe.editRichMessage(DM, 7, 'x')).toEqual({ fallback: true })
    expect(latch.sendDisabled).toBe(true)
  })

  test('parser rejection reports fallback WITHOUT latching', async () => {
    const seen = { md: [] as string[] }
    const latch = createRichLatch()
    const safe = createSafeTelegramApi(
      makeInner(async () => { throw { error_code: 400, description: "Bad Request: can't parse entities" } }, seen),
      silentLog, undefined, latch,
    )
    expect(await safe.editRichMessage(DM, 7, 'x')).toEqual({ fallback: true })
    expect(latch.sendDisabled).toBe(false)
  })

  test('transient error THROWS — the edit may already have landed', async () => {
    const seen = { md: [] as string[] }
    const latch = createRichLatch()
    const safe = createSafeTelegramApi(
      makeInner(async () => { throw { error_code: 503, description: 'Service Unavailable' } }, seen),
      silentLog, undefined, latch,
    )
    await expect(safe.editRichMessage(DM, 7, 'x')).rejects.toBeDefined()
    expect(latch.sendDisabled).toBe(false)
  })

  test('a latched-off session skips the raw call entirely', async () => {
    const seen = { md: [] as string[] }
    const latch = createRichLatch()
    latch.sendDisabled = true
    const safe = createSafeTelegramApi(makeInner(async () => ({ ok: true }), seen), silentLog, undefined, latch)
    expect(await safe.editRichMessage(DM, 7, 'x')).toEqual({ fallback: true })
    expect(seen.md).toHaveLength(0)
  })

  test('secrets are redacted BEFORE the raw edit', async () => {
    const seen = { md: [] as string[] }
    const latch = createRichLatch()
    const safe = createSafeTelegramApi(makeInner(async () => ({ ok: true }), seen), silentLog, undefined, latch)
    await safe.editRichMessage(DM, 7, 'key sk-abcdefghijklmnopqrstuvwxyz0123456789 end')
    expect(seen.md[0]).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    expect(seen.md[0]).toContain('[REDACTED]')
  })
})
