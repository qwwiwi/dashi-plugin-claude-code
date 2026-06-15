import { describe, expect, test } from 'bun:test'

import { RuntimeEnvSchema } from '../src/config.js'

describe('webhook-only: TELEGRAM_BOT_TOKEN optional in schema', () => {
  test('schema parses WITHOUT token (webhook-only path relies on it being optional)', () => {
    const parsed = RuntimeEnvSchema.parse({ TELEGRAM_WEBHOOK_PORT: '9101' })
    expect(parsed.TELEGRAM_BOT_TOKEN).toBeUndefined()
  })

  test('schema still accepts a token when present', () => {
    const parsed = RuntimeEnvSchema.parse({ TELEGRAM_BOT_TOKEN: '123:ABC' })
    expect(parsed.TELEGRAM_BOT_TOKEN).toBe('123:ABC')
  })

  test('empty-string token is rejected (must be undefined or non-empty)', () => {
    expect(() => RuntimeEnvSchema.parse({ TELEGRAM_BOT_TOKEN: '' })).toThrow()
  })
})
