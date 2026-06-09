import { describe, expect, test } from 'bun:test'

import { createPermissionGateRelay } from '../../src/channel/permission-gate-relay.js'

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof createPermissionGateRelay>[0]['log']

function makeRelay(timeoutMs = 1000) {
  return createPermissionGateRelay({ log, defaultTimeoutMs: timeoutMs })
}

const base = {
  toolUseId: 'tu-1',
  sessionId: 's-1',
  toolName: 'Bash',
  preview: 'git push origin main',
  reason: 'risky command needs confirmation',
}

describe('permission-gate relay', () => {
  test('submit without chatId → pass_through, no id', async () => {
    const r = makeRelay()
    const { requestId, result } = r.submit({ ...base })
    expect(requestId).toBeUndefined()
    expect((await result).status).toBe('pass_through')
  })

  test('allow tap resolves the promise with allow', async () => {
    const r = makeRelay()
    const { requestId, result } = r.submit({ ...base, chatId: '164795011' })
    expect(requestId).toBeDefined()
    expect(r.pendingCount()).toBe(1)
    expect(r.answer(requestId!, 'allow')).toBe('allow')
    const v = await result
    expect(v.status).toBe('allow')
    expect(r.pendingCount()).toBe(0)
  })

  test('deny tap resolves with deny', async () => {
    const r = makeRelay()
    const { requestId, result } = r.submit({ ...base, chatId: '164795011' })
    r.answer(requestId!, 'deny')
    expect((await result).status).toBe('deny')
  })

  test('second tap on a settled request is idempotent (first wins)', async () => {
    const r = makeRelay()
    const { requestId, result } = r.submit({ ...base, chatId: '164795011' })
    expect(r.answer(requestId!, 'allow')).toBe('allow')
    expect(r.answer(requestId!, 'deny')).toBe('idempotent')
    expect((await result).status).toBe('allow')
  })

  test('timeout resolves with timeout', async () => {
    const r = makeRelay(20)
    const { result } = r.submit({ ...base, chatId: '164795011' })
    const v = await result
    expect(v.status).toBe('timeout')
  })

  test('expire resolves with deny (fail-closed)', async () => {
    const r = makeRelay()
    const { requestId, result } = r.submit({ ...base, chatId: '164795011' })
    r.expire(requestId!, 'boom')
    const v = await result
    expect(v.status).toBe('deny')
    expect(v.reason).toContain('boom')
  })

  test('toolUseId replay attaches to the live request (same promise)', async () => {
    const r = makeRelay()
    const a = r.submit({ ...base, chatId: '164795011' })
    const b = r.submit({ ...base, chatId: '164795011' })
    expect(b.requestId).toBe(a.requestId)
    r.answer(a.requestId!, 'allow')
    expect((await a.result).status).toBe('allow')
    expect((await b.result).status).toBe('allow')
  })

  test('toolUseId replay after settle returns the cached verdict', async () => {
    const r = makeRelay()
    const a = r.submit({ ...base, chatId: '164795011' })
    r.answer(a.requestId!, 'deny')
    await a.result
    const b = r.submit({ ...base, chatId: '164795011' })
    expect(b.requestId).toBeUndefined()
    expect((await b.result).status).toBe('deny')
  })

  test('answer on an unknown id is idempotent (no throw)', () => {
    const r = makeRelay()
    expect(r.answer('abcde', 'allow')).toBe('idempotent')
  })

  test('setTelegramMessageId stashes the message id', () => {
    const r = makeRelay()
    const { requestId } = r.submit({ ...base, chatId: '164795011' })
    r.setTelegramMessageId(requestId!, 42)
    expect(r.getPending(requestId!)?.telegramMessageId).toBe(42)
  })
})
