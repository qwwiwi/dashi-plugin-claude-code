import { describe, expect, test } from 'bun:test'
import { normalizeMeta, sendChannelNotification } from '../../src/channel/notify.js'
import { createLogger } from '../../src/log.js'

// Silent logger so test output stays clean.
const silentLog = createLogger('test', {
  stream: { write: () => true } as unknown as NodeJS.WritableStream,
})

// Minimal MCP server stub. sendChannelNotification only touches
// `.notification()`.
function makeStubServer(behavior: 'ok' | 'throw'): {
  // Cast to the real Server type at the call-site to avoid pulling in the
  // SDK's deep types just for a structural stub.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server: any
  calls: Array<{ method: string; params: unknown }>
} {
  const calls: Array<{ method: string; params: unknown }> = []
  const server = {
    notification: async (msg: { method: string; params: unknown }): Promise<void> => {
      calls.push({ method: msg.method, params: msg.params })
      if (behavior === 'throw') throw new Error('transport closed')
    },
  }
  return { server, calls }
}

describe('normalizeMeta', () => {
  test('drops keys with hyphens', () => {
    const out = normalizeMeta({ 'chat-id': '123', chat_id: '456' })
    expect(out['chat-id']).toBeUndefined()
    expect(out.chat_id).toBe('456')
  })

  test('coerces numbers and booleans to string', () => {
    const out = normalizeMeta({ count: 42, ok: true, off: false })
    expect(out.count).toBe('42')
    expect(out.ok).toBe('true')
    expect(out.off).toBe('false')
  })

  test('drops null and undefined values', () => {
    const out = normalizeMeta({ keep: 'yes', a: null, b: undefined })
    expect(out.keep).toBe('yes')
    expect(Object.keys(out)).toEqual(['keep'])
  })

  test("rejects keys that don't match identifier regex", () => {
    const out = normalizeMeta({
      good_key: 'a',
      '1starts_with_digit': 'b',
      'has space': 'c',
      'has.dot': 'd',
      _underscore_ok: 'e',
    })
    expect(out.good_key).toBe('a')
    expect(out._underscore_ok).toBe('e')
    expect(out['1starts_with_digit']).toBeUndefined()
    expect(out['has space']).toBeUndefined()
    expect(out['has.dot']).toBeUndefined()
  })
})

describe('sendChannelNotification return contract', () => {
  test('returns true on successful transport write', async () => {
    const { server, calls } = makeStubServer('ok')
    const ok = await sendChannelNotification(
      server,
      { content: 'hello', meta: { source: 'telegram' } },
      silentLog,
    )
    expect(ok).toBe(true)
    expect(calls.length).toBe(1)
    expect(calls[0]!.method).toBe('notifications/claude/channel')
  })

  test('returns false (no rethrow) when server.notification throws', async () => {
    const { server } = makeStubServer('throw')
    const ok = await sendChannelNotification(
      server,
      { content: 'hello', meta: { source: 'telegram' } },
      silentLog,
    )
    expect(ok).toBe(false)
  })
})
