// Stage 1 (2026-08-30) — unit tests around the notification-hook request
// builder. No real network: we exercise `buildNotificationRequest` directly.

import { describe, expect, test } from 'bun:test'

import { buildNotificationRequest } from '../../scripts/notification-hook.js'

const TOKEN = 'unit-test-token'

function baseHook(): Record<string, unknown> {
  return {
    hook_event_name: 'Notification',
    session_id: 's1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp',
    message: 'Claude needs your permission to use Bash',
  }
}

describe('buildNotificationRequest', () => {
  test('builds POST with bearer + JSON body containing chat_id + message', () => {
    const result = buildNotificationRequest({
      env: {
        TELEGRAM_HOOK_CHAT_ID: '164795011',
        TELEGRAM_WEBHOOK_URL: 'http://127.0.0.1:8092/hooks/notification',
        TELEGRAM_WEBHOOK_TOKEN: TOKEN,
      },
      hook: baseHook(),
    })
    expect('kind' in result).toBe(false)
    if ('kind' in result) throw new Error('unreachable')
    expect(result.url).toBe('http://127.0.0.1:8092/hooks/notification')
    expect(result.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(result.body).toContain('"chat_id":"164795011"')
    expect(result.body).toContain('"message":"Claude needs your permission to use Bash"')
    // Does NOT forward transcript_path / cwd — those are noise + host layout.
    expect(result.body).not.toContain('transcript_path')
    expect(result.body).not.toContain('/tmp')
  })

  test('attaches agent_id + session_id when present', () => {
    const result = buildNotificationRequest({
      env: {
        TELEGRAM_HOOK_CHAT_ID: '1',
        TELEGRAM_HOOK_AGENT_ID: 'coder',
        TELEGRAM_WEBHOOK_URL: 'http://x',
        TELEGRAM_WEBHOOK_TOKEN: TOKEN,
      },
      hook: baseHook(),
    })
    if ('kind' in result) throw new Error('unreachable')
    expect(result.body).toContain('"agent_id":"coder"')
    expect(result.body).toContain('"session_id":"s1"')
  })

  test('empty agent_id + session_id are serialised as empty strings', () => {
    const result = buildNotificationRequest({
      env: {
        TELEGRAM_HOOK_CHAT_ID: '1',
        TELEGRAM_WEBHOOK_URL: 'http://x',
        TELEGRAM_WEBHOOK_TOKEN: TOKEN,
      },
      hook: { hook_event_name: 'Notification', message: 'idle 60s' },
    })
    if ('kind' in result) throw new Error('unreachable')
    expect(result.body).toContain('"agent_id":""')
    expect(result.body).toContain('"session_id":""')
  })

  test('missing TELEGRAM_WEBHOOK_URL → structured error', () => {
    const result = buildNotificationRequest({
      env: { TELEGRAM_HOOK_CHAT_ID: '1', TELEGRAM_WEBHOOK_TOKEN: TOKEN },
      hook: baseHook(),
    })
    expect('kind' in result).toBe(true)
    if (!('kind' in result)) throw new Error('unreachable')
    expect(result.reason).toContain('TELEGRAM_WEBHOOK_URL')
  })

  test('wrong hook_event_name → structured error', () => {
    const result = buildNotificationRequest({
      env: {
        TELEGRAM_HOOK_CHAT_ID: '1',
        TELEGRAM_WEBHOOK_URL: 'http://x',
        TELEGRAM_WEBHOOK_TOKEN: TOKEN,
      },
      hook: { ...baseHook(), hook_event_name: 'PreToolUse' },
    })
    expect('kind' in result).toBe(true)
    if (!('kind' in result)) throw new Error('unreachable')
    expect(result.reason).toContain('not Notification')
  })

  test('missing message → structured error', () => {
    const result = buildNotificationRequest({
      env: {
        TELEGRAM_HOOK_CHAT_ID: '1',
        TELEGRAM_WEBHOOK_URL: 'http://x',
        TELEGRAM_WEBHOOK_TOKEN: TOKEN,
      },
      hook: { hook_event_name: 'Notification' },
    })
    expect('kind' in result).toBe(true)
    if (!('kind' in result)) throw new Error('unreachable')
    expect(result.reason).toContain('message')
  })

  test('empty message string → structured error', () => {
    const result = buildNotificationRequest({
      env: {
        TELEGRAM_HOOK_CHAT_ID: '1',
        TELEGRAM_WEBHOOK_URL: 'http://x',
        TELEGRAM_WEBHOOK_TOKEN: TOKEN,
      },
      hook: { hook_event_name: 'Notification', message: '' },
    })
    expect('kind' in result).toBe(true)
    if (!('kind' in result)) throw new Error('unreachable')
    expect(result.reason).toContain('message')
  })
})
