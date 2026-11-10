// The widget methods must pass through the same safety layers as the other
// outbound calls: redaction (safe), per-chat queue (rate-limited), and the
// reliable layer's no-retry-on-ambiguous rule for non-idempotent sends.

import { describe, expect, test } from 'bun:test'

import type { TelegramApi } from '../../src/channel/tools.js'
import { createLogger } from '../../src/log.js'
import { redactSecrets } from '../../src/safety/redact.js'
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
  test('redacts the caption and forwards clean html / chat_data / width untouched', async () => {
    const { raw, seen } = recorder()
    const safe = createSafeTelegramApi(raw, log)
    const res = await safe.sendWidget('1', {
      html: '<div>ok</div>',
      caption: `cap ${TOKEN}`,
      chat_data: '{"k":1}',
      width: 100,
    })
    expect(res).toEqual({ message_id: 5 })
    const params = seen.send[0]?.params ?? {}
    expect(JSON.stringify(params)).not.toContain(TOKEN)
    expect(params.html).toBe('<div>ok</div>')
    expect(params.chat_data).toBe('{"k":1}')
    expect(params.width).toBe(100)
  })

  test('a secret in html or chat_data is refused, never forwarded (see the F1 block below)', async () => {
    const { raw, seen } = recorder()
    const safe = createSafeTelegramApi(raw, log)
    await expect(safe.sendWidget('1', { html: `<div>${TOKEN}</div>`, caption: 'c' })).rejects.toThrow(/secret/i)
    await expect(safe.editWidgetData('1', 3, `{"k":"${TOKEN}"}`)).rejects.toThrow(/secret/i)
    expect(seen.send).toHaveLength(0)
    expect(seen.edit).toHaveLength(0)
  })
})

describe('safe wrapper — F1: a redaction that would change widget html or chat_data fails closed', () => {
  const SECRET_RUN = 'abcdefghijklmnopqrstuvwx'
  const SCRIPT = `<script>const ${SECRET_RUN}=1;</script>`

  test('html that the redactor would alter is refused with the offset, nothing is sent, the value is not echoed', async () => {
    const { raw, seen } = recorder()
    const safe = createSafeTelegramApi(raw, log)
    const err = await safe.sendWidget('1', { html: SCRIPT, caption: 'c' }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    const msg = (err as Error).message
    expect(msg).toContain('html')
    expect(msg).toMatch(/secret/i)
    expect(msg).toMatch(/offset \d+/)
    expect(msg).not.toContain(SECRET_RUN)
    expect(seen.send).toHaveLength(0)
  })

  test('the reported offset is where the redactor first changes the text', async () => {
    const { raw } = recorder()
    const safe = createSafeTelegramApi(raw, log)
    const html = `<p>${'x'.repeat(10)} ?key=zz</p>`
    const redacted = redactSecrets(html)
    const changedAt = [...html].findIndex((ch, i) => redacted[i] !== ch)
    expect(changedAt).toBeGreaterThan(0)
    const err = await safe.sendWidget('1', { html, caption: 'c' }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect((err as Error).message).toContain(`offset ${changedAt}`)
  })

  test('chat_data that the redactor would alter is refused on send and on edit', async () => {
    const { raw, seen } = recorder()
    const safe = createSafeTelegramApi(raw, log)
    await expect(
      safe.sendWidget('1', { html: '<b>x</b>', caption: 'c', chat_data: `{"k":"${TOKEN}"}` }),
    ).rejects.toThrow(/chat_data.*offset \d+/)
    await expect(safe.editWidgetData('1', 3, `{"k":"${TOKEN}"}`)).rejects.toThrow(/chat_data.*offset \d+/)
    expect(seen.send).toHaveLength(0)
    expect(seen.edit).toHaveLength(0)
  })

  test('html and chat_data that the redactor leaves alone go through byte-identical', async () => {
    const { raw, seen } = recorder()
    const safe = createSafeTelegramApi(raw, log)
    const html = '<div id="w">ok</div><script>const a=1</script>'
    await safe.sendWidget('1', { html, caption: 'c', chat_data: '{"j":[1,2]}' })
    await safe.editWidgetData('1', 3, '')
    expect(seen.send[0]?.params.html).toBe(html)
    expect(seen.send[0]?.params.chat_data).toBe('{"j":[1,2]}')
    expect(seen.edit[0]?.chatData).toBe('')
  })

  test('a caption with a secret is still REDACTED (not refused), as for normal messages', async () => {
    const { raw, seen } = recorder()
    const safe = createSafeTelegramApi(raw, log)
    await safe.sendWidget('1', { html: '<b>x</b>', caption: `cap ${TOKEN}` })
    const caption = String(seen.send[0]?.params.caption)
    expect(caption).not.toContain(TOKEN)
    expect(caption).toContain('cap')
  })

  test('caller-supplied extra secrets in html also fail closed', async () => {
    const { raw, seen } = recorder()
    const safe = createSafeTelegramApi(raw, log, ['hunter2-extra'])
    await expect(safe.sendWidget('1', { html: '<p>hunter2-extra</p>', caption: 'c' })).rejects.toThrow(/offset \d+/)
    expect(seen.send).toHaveLength(0)
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

  test('editWidgetData: «message is not modified» is success (the edit is idempotent)', async () => {
    const err = Object.assign(new Error('Bad Request: message is not modified'), {
      error_code: 400,
      description: 'Bad Request: message is not modified',
    })
    const { raw, seen } = recorder(err)
    const api = createReliableTelegramApi(raw, log, { sleep: async () => {} })
    await api.editWidgetData('1', 5, '{}') // resolves
    expect(seen.edit).toHaveLength(1)
  })

  test('editWidgetData: an ambiguous transport error is retried and then succeeds', async () => {
    const { seen } = recorder()
    let n = 0
    const raw = {
      async editWidgetData(chatId: string, messageId: number, chatData: string) {
        seen.edit.push({ chatId, messageId, chatData })
        if (n++ === 0) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
      },
    } as unknown as TelegramApi
    const api = createReliableTelegramApi(raw, log, { sleep: async () => {} })
    await api.editWidgetData('1', 5, '{"a":1}')
    expect(seen.edit).toHaveLength(2)
  })

  test('editWidgetData: a permanent Bot API error is thrown without retry', async () => {
    const err = Object.assign(new Error('Bad Request: MESSAGE_NOT_WIDGET'), {
      error_code: 400,
      description: 'Bad Request: MESSAGE_NOT_WIDGET',
    })
    const { raw, seen } = recorder(err)
    const api = createReliableTelegramApi(raw, log, { sleep: async () => {} })
    await expect(api.editWidgetData('1', 5, '{}')).rejects.toThrow('MESSAGE_NOT_WIDGET')
    expect(seen.edit).toHaveLength(1)
  })
})

// N1 (fix loop 2): the retry of one widget edit must not let a NEWER edit of
// the same widget overtake it. The whole operation (attempts + backoff) is
// serialized per widget (chat + message); different widgets stay independent.
describe('reliable wrapper — N1: per-widget edit order across retries', () => {
  const transient = (): Error => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })

  /** Fake clock: every backoff sleep parks until the test releases it. */
  function gate(): { sleep: (ms: number) => Promise<void>; release: () => void; sleeping: () => number } {
    const waiters: Array<() => void> = []
    return {
      sleep: () => new Promise<void>(resolve => void waiters.push(resolve)),
      release: () => waiters.splice(0).forEach(w => w()),
      sleeping: () => waiters.length,
    }
  }

  const tick = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }

  /** Raw api: failures[key] = how many leading attempts of that chat_data fail. */
  function fake(failures: Record<string, number>): {
    raw: TelegramApi
    calls: string[]
    applied: Map<string, string>
  } {
    const calls: string[] = []
    const applied = new Map<string, string>()
    const left = { ...failures }
    const raw = {
      async editWidgetData(chatId: string, messageId: number, chatData: string) {
        calls.push(`${chatId}:${messageId}=${chatData}`)
        if ((left[chatData] ?? 0) > 0) {
          left[chatData] = (left[chatData] ?? 0) - 1
          throw transient()
        }
        applied.set(`${chatId}:${messageId}`, chatData)
      },
    } as unknown as TelegramApi
    return { raw, calls, applied }
  }

  test('an older edit that retries is applied before the newer one; the final state is the newer', async () => {
    const { raw, calls, applied } = fake({ old: 1 })
    const g = gate()
    const api = createReliableTelegramApi(raw, log, { sleep: g.sleep })

    const first = api.editWidgetData('1', 5, 'old')
    await tick()
    expect(g.sleeping()).toBe(1) // old failed once, parked in backoff
    const second = api.editWidgetData('1', 5, 'new')
    await tick()
    g.release()
    await Promise.all([first, second])

    expect(calls).toEqual(['1:5=old', '1:5=old', '1:5=new'])
    expect(applied.get('1:5')).toBe('new')
  })

  test('edits of different widgets do not wait for each other', async () => {
    const { raw, calls, applied } = fake({ a: 1 })
    const g = gate()
    const api = createReliableTelegramApi(raw, log, { sleep: g.sleep })

    const slow = api.editWidgetData('1', 5, 'a') // parked in backoff
    await tick()
    await api.editWidgetData('1', 6, 'b') // other message: must finish now
    await api.editWidgetData('2', 5, 'c') // other chat: must finish now
    expect(applied.get('1:6')).toBe('b')
    expect(applied.get('2:5')).toBe('c')
    expect(applied.has('1:5')).toBe(false)
    g.release()
    await slow
    expect(applied.get('1:5')).toBe('a')
    expect(calls.filter(c => c.startsWith('1:5'))).toEqual(['1:5=a', '1:5=a'])
  })

  test('an exhausted edit rejects and does not block the next edit of the same widget', async () => {
    const { raw, calls, applied } = fake({ old: 99 })
    const g = gate()
    const api = createReliableTelegramApi(raw, log, { sleep: g.sleep })

    const first = api.editWidgetData('1', 5, 'old')
    const firstResult = first.then(
      () => 'ok',
      (e: unknown) => (e as Error).message,
    )
    await tick()
    const second = api.editWidgetData('1', 5, 'new')
    for (let i = 0; i < 4; i++) {
      await tick()
      g.release()
    }
    expect(await firstResult).toContain('ECONNRESET')
    await second
    expect(calls).toEqual(['1:5=old', '1:5=old', '1:5=old', '1:5=new'])
    expect(applied.get('1:5')).toBe('new')
  })

  test('a later edit after a settled one still runs (the queue does not leak or wedge)', async () => {
    const { raw, applied } = fake({})
    const api = createReliableTelegramApi(raw, log, { sleep: async () => {} })
    await api.editWidgetData('1', 5, 'x')
    await api.editWidgetData('1', 5, 'y')
    expect(applied.get('1:5')).toBe('y')
  })
})
