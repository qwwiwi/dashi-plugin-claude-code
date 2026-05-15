// Phase 7 / T5 — unit tests around the post-hook request builder.
// No real network: we exercise `buildHookRequest` directly.

import { describe, expect, test } from 'bun:test'

import { buildHookRequest } from '../../scripts/post-hook.js'

const TOKEN = 'unit-test-token'

function baseHook(): Record<string, unknown> {
  return {
    hook_event_name: 'Stop',
    session_id: 's1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp',
  }
}

describe('buildHookRequest', () => {
  test('builds POST with bearer + JSON body containing chatId', () => {
    const result = buildHookRequest({
      env: {
        TELEGRAM_HOOK_CHAT_ID: '164795011',
        TELEGRAM_WEBHOOK_URL: 'http://127.0.0.1:8089/hooks/agent',
        TELEGRAM_WEBHOOK_TOKEN: TOKEN,
      },
      hook: baseHook(),
    })
    expect('kind' in result).toBe(false)
    if ('kind' in result) throw new Error('unreachable')
    expect(result.url).toBe('http://127.0.0.1:8089/hooks/agent')
    expect(result.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(result.headers['Content-Type']).toBe('application/json')
    expect(result.body).toContain('"chatId":"164795011"')
    expect(result.body).toContain('"hook_event_name":"Stop"')
  })

  test('attaches optional agentId when provided', () => {
    const result = buildHookRequest({
      env: {
        TELEGRAM_HOOK_CHAT_ID: '1',
        TELEGRAM_HOOK_AGENT_ID: 'dashi-channel',
        TELEGRAM_WEBHOOK_URL: 'http://x',
        TELEGRAM_WEBHOOK_TOKEN: TOKEN,
      },
      hook: baseHook(),
    })
    if ('kind' in result) throw new Error('unreachable')
    expect(result.body).toContain('"agentId":"dashi-channel"')
  })

  test('omits agentId when env unset', () => {
    const result = buildHookRequest({
      env: {
        TELEGRAM_HOOK_CHAT_ID: '1',
        TELEGRAM_WEBHOOK_URL: 'http://x',
        TELEGRAM_WEBHOOK_TOKEN: TOKEN,
      },
      hook: baseHook(),
    })
    if ('kind' in result) throw new Error('unreachable')
    expect(result.body).not.toContain('"agentId"')
  })

  test('missing TELEGRAM_WEBHOOK_URL → structured error', () => {
    const result = buildHookRequest({
      env: { TELEGRAM_HOOK_CHAT_ID: '1', TELEGRAM_WEBHOOK_TOKEN: TOKEN },
      hook: baseHook(),
    })
    expect('kind' in result).toBe(true)
    if (!('kind' in result)) throw new Error('unreachable')
    expect(result.reason).toContain('TELEGRAM_WEBHOOK_URL')
  })

  test('missing TELEGRAM_WEBHOOK_TOKEN → structured error', () => {
    const result = buildHookRequest({
      env: { TELEGRAM_HOOK_CHAT_ID: '1', TELEGRAM_WEBHOOK_URL: 'http://x' },
      hook: baseHook(),
    })
    if (!('kind' in result)) throw new Error('unreachable')
    expect(result.reason).toContain('TELEGRAM_WEBHOOK_TOKEN')
  })

  test('missing TELEGRAM_HOOK_CHAT_ID → structured error', () => {
    const result = buildHookRequest({
      env: { TELEGRAM_WEBHOOK_URL: 'http://x', TELEGRAM_WEBHOOK_TOKEN: TOKEN },
      hook: baseHook(),
    })
    if (!('kind' in result)) throw new Error('unreachable')
    expect(result.reason).toContain('TELEGRAM_HOOK_CHAT_ID')
  })

  test('hook payload without hook_event_name → error, never reaches network', () => {
    const result = buildHookRequest({
      env: {
        TELEGRAM_HOOK_CHAT_ID: '1',
        TELEGRAM_WEBHOOK_URL: 'http://x',
        TELEGRAM_WEBHOOK_TOKEN: TOKEN,
      },
      hook: { foo: 'bar' },
    })
    if (!('kind' in result)) throw new Error('unreachable')
    expect(result.reason).toContain('hook_event_name')
  })

  test('PreToolUse with prompt-shaped fields keeps tool_input intact', () => {
    const result = buildHookRequest({
      env: {
        TELEGRAM_HOOK_CHAT_ID: '1',
        TELEGRAM_WEBHOOK_URL: 'http://x',
        TELEGRAM_WEBHOOK_TOKEN: TOKEN,
      },
      hook: {
        hook_event_name: 'PreToolUse',
        session_id: 's1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
        tool_name: 'Bash',
        tool_use_id: 'u1',
        tool_input: { command: 'bun test' },
      },
    })
    if ('kind' in result) throw new Error('unreachable')
    // tool_input is forwarded verbatim — the server is the masking boundary,
    // not the helper. Keeps the helper trivial enough to audit by eye.
    expect(result.body).toContain('"command":"bun test"')
  })

  test('bearer token not echoed into body', () => {
    const result = buildHookRequest({
      env: {
        TELEGRAM_HOOK_CHAT_ID: '1',
        TELEGRAM_WEBHOOK_URL: 'http://x',
        TELEGRAM_WEBHOOK_TOKEN: 'super-secret-token',
      },
      hook: baseHook(),
    })
    if ('kind' in result) throw new Error('unreachable')
    expect(result.body).not.toContain('super-secret-token')
    // …and lives only inside the header.
    expect(result.headers.Authorization).toBe('Bearer super-secret-token')
  })
})
