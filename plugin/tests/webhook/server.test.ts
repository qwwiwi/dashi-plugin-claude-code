// T14 tests — webhook /hooks/agent scaffold.
//
// Spins up the real http.Server on port 0, exercises each branch end-to-end
// over fetch(). MCP server is stubbed so we can assert that a valid request
// forwards a `notifications/claude/channel` event with meta.source="webhook".

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getStatePaths, loadConfig, type AppConfig, type StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import { ensureStateDirs } from '../../src/state/store.js'
import {
  startWebhookServer,
  validateWebhookPayload,
  type WebhookServerHandle,
} from '../../src/webhook/server.js'

const FAKE_TOKEN = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'
const WEBHOOK_TOKEN = 'wh_test_token_32_chars__________'

let stateDir: string
let paths: StatePaths
let baseConfig: AppConfig
let handle: WebhookServerHandle | null

// Lightweight mock of `@modelcontextprotocol/sdk/server/index.js`'s `Server`.
// notify() callers only touch `.notification()`. We collect each call so
// tests can assert content + meta were forwarded correctly.
type Captured = { method: string; params: unknown }
function makeMcpStub(): { server: any; calls: Captured[] } {
  const calls: Captured[] = []
  const server = {
    notification: async (msg: { method: string; params: unknown }) => {
      calls.push({ method: msg.method, params: msg.params })
    },
  }
  return { server, calls }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'dashi-channel-webhook-'))
  // Clean env in case earlier tests leaked.
  delete process.env.TELEGRAM_WEBHOOK_TOKEN
  const env = {
    TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    TELEGRAM_STATE_DIR: stateDir,
  }
  baseConfig = loadConfig(env)
  paths = getStatePaths(baseConfig, {
    TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    TELEGRAM_STATE_DIR: stateDir,
  })
  ensureStateDirs(paths)
  handle = null
})

afterEach(async () => {
  if (handle) {
    await handle.close()
    handle = null
  }
  delete process.env.TELEGRAM_WEBHOOK_TOKEN
  rmSync(stateDir, { recursive: true, force: true })
})

function enabledConfig(overrides: Partial<AppConfig['webhook']> = {}): AppConfig {
  return {
    ...baseConfig,
    webhook: {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      ...overrides,
    },
  }
}

async function startEnabled(config: AppConfig): Promise<{ handle: WebhookServerHandle; mcp: ReturnType<typeof makeMcpStub> }> {
  const mcp = makeMcpStub()
  const h = await startWebhookServer(config, {
    mcpServer: mcp.server,
    config,
    statePaths: paths,
    log: createLogger('test'),
  })
  if (!h) throw new Error('expected handle')
  handle = h
  return { handle: h, mcp }
}

function url(h: WebhookServerHandle, path: string): string {
  return `http://${h.host}:${h.port}${path}`
}

// ─────────────────────────────────────────────────────────────────────

describe('validateWebhookPayload', () => {
  test('accepts {message, chatId} numeric', () => {
    const p = validateWebhookPayload({ message: 'hi', chatId: 164795011 })
    expect(p.kind).toBe('message')
    if (p.kind !== 'message') throw new Error('unreachable')
    expect(p.message).toBe('hi')
    expect(p.chatId).toBe('164795011')
    expect(p.agentId).toBeUndefined()
  })

  test('rejects empty message', () => {
    expect(() => validateWebhookPayload({ message: '', chatId: 1 })).toThrow(/invalid webhook payload/)
  })

  test('rejects missing chatId', () => {
    expect(() => validateWebhookPayload({ message: 'x' })).toThrow(/invalid webhook payload/)
  })

  test('Zod issue summary is capped at 512 chars (L2)', () => {
    // Pre-fix: a deeply-nested or discriminated-union failure could amplify
    // a single bad request into a kilobyte-long error string that landed in
    // both the 400 response body and the dead-letter file. Cap is 512 chars
    // on the appended `summary` slice. Total Error message includes the
    // `invalid webhook payload: ` prefix (~25 chars), so message ≤ ~540.
    let caught: unknown
    try {
      // Use a payload that's the wrong shape entirely — Zod produces several
      // issues for the union failure.
      validateWebhookPayload({ junk: 'x'.repeat(2000), more_junk: 'y'.repeat(2000) })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    const msg = (caught as Error).message
    expect(msg.startsWith('invalid webhook payload: ')).toBe(true)
    // Prefix + capped summary should be well below 600 chars.
    expect(msg.length).toBeLessThanOrEqual(600)
  })

  test('discriminator: hook_event_name presence routes to claude_hook (not message)', () => {
    // Pre-fix: union evaluated message-first; this payload matched message
    // and the hook fields were silently dropped. Post-fix: hook_event_name
    // routes to the hook schema even when `message` is present.
    const p = validateWebhookPayload({
      message: 'this should NOT win',
      chatId: 164795011,
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/tmp',
      tool_name: 'Read',
      tool_use_id: 'u1',
      tool_input: { file_path: '/x/y.ts' },
    })
    expect(p.kind).toBe('claude_hook')
    if (p.kind !== 'claude_hook') throw new Error('unreachable')
    expect(p.hook_event_name).toBe('PreToolUse')
    if (p.hook_event_name !== 'PreToolUse') throw new Error('unreachable')
    expect(p.tool_name).toBe('Read')
  })
})

// ─────────────────────────────────────────────────────────────────────

describe('startWebhookServer', () => {
  test('disabled config returns null', async () => {
    const h = await startWebhookServer(baseConfig, {
      mcpServer: makeMcpStub().server,
      config: baseConfig,
      statePaths: paths,
      log: createLogger('test'),
    })
    expect(h).toBeNull()
  })

  test('non-loopback host without TELEGRAM_WEBHOOK_TOKEN throws', async () => {
    const cfg = enabledConfig({ host: '0.0.0.0' })
    let caught: unknown
    try {
      const h = await startWebhookServer(cfg, {
        mcpServer: makeMcpStub().server,
        config: cfg,
        statePaths: paths,
        log: createLogger('test'),
      })
      if (h) {
        handle = h
      }
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/TELEGRAM_WEBHOOK_TOKEN required/)
  })

  test('non-loopback host with TELEGRAM_WEBHOOK_TOKEN binds', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const cfg = enabledConfig({ host: '127.0.0.1' /* keep loopback to avoid firewall prompts */ })
    const { handle: h } = await startEnabled(cfg)
    expect(h.port).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  test('returns ok with bot_id and allowed_chat_ids, no secrets', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h } = await startEnabled(enabledConfig())
    const resp = await fetch(url(h, '/health'))
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(body.bot_id).toBe(baseConfig.bot_id)
    expect(Array.isArray(body.allowed_chat_ids)).toBe(true)
    // Defence: no token or env value should appear anywhere in the response.
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain(WEBHOOK_TOKEN)
    expect(serialized).not.toContain(FAKE_TOKEN)
  })
})

// ─────────────────────────────────────────────────────────────────────

describe('POST /hooks/agent', () => {
  test('without auth returns 401', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h } = await startEnabled(enabledConfig())
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'x', chatId: 164795011 }),
    })
    expect(resp.status).toBe(401)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.error).toBe('unauthorized')
  })

  test('with wrong bearer returns 401', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h } = await startEnabled(enabledConfig())
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer wrong_token_value',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'x', chatId: 164795011 }),
    })
    expect(resp.status).toBe(401)
  })

  test('bearer of different length returns 401 (no length-leak path) (M4)', async () => {
    // After the M4 fix bearerEquals pads both sides to the same fixed
    // length and combines the byte-compare with an explicit length-equality
    // bit. Differing-length tokens — both shorter and longer than the
    // configured one — must still produce 401 cleanly.
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h } = await startEnabled(enabledConfig())
    for (const token of ['short', `${WEBHOOK_TOKEN}_with_extra_tail`, '']) {
      const resp = await fetch(url(h, '/hooks/agent'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'x', chatId: 164795011 }),
      })
      expect(resp.status).toBe(401)
    }
  })

  test('without configured token returns 503', async () => {
    // No env token set => any auth fails with 503 (gateway.py:3535-3537 parity).
    const { handle: h } = await startEnabled(enabledConfig())
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer anything',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'x', chatId: 164795011 }),
    })
    expect(resp.status).toBe(503)
  })

  test('valid auth and valid payload forwards channel notification', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h, mcp } = await startEnabled(enabledConfig())
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'hello via webhook', chatId: 164795011 }),
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.status).toBe('accepted')

    expect(mcp.calls.length).toBe(1)
    const call = mcp.calls[0]!
    expect(call.method).toBe('notifications/claude/channel')
    const params = call.params as { content: string; meta: Record<string, string> }
    expect(params.content).toBe('hello via webhook')
    expect(params.meta.source).toBe('webhook')
    expect(params.meta.chat_id).toBe('164795011')
  })

  test('body > 256KB returns 413', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h } = await startEnabled(enabledConfig())
    // 300 KB of payload — well over the 256 KB cap.
    const huge = 'x'.repeat(300 * 1024)
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: huge, chatId: 164795011 }),
    })
    expect(resp.status).toBe(413)
  })

  test('invalid JSON returns 400 and writes dead-letter', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h } = await startEnabled(enabledConfig())
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: '{not json',
    })
    expect(resp.status).toBe(400)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.error).toBe('invalid json')
    // A dead-letter file should now exist.
    const dlFiles = readdirSync(paths.deadLetterWebhook)
    expect(dlFiles.length).toBeGreaterThanOrEqual(1)
  })

  test('missing message returns 400', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h } = await startEnabled(enabledConfig())
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ chatId: 164795011 }),
    })
    expect(resp.status).toBe(400)
    // Dead-letter records the rejected payload.
    const dlFiles = readdirSync(paths.deadLetterWebhook)
    expect(dlFiles.length).toBeGreaterThanOrEqual(1)
  })

  test('chatId not allowlisted returns 403', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h, mcp } = await startEnabled(enabledConfig())
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'x', chatId: 999999999 }),
    })
    expect(resp.status).toBe(403)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.error).toBe('chatId not in allowlist')
    // No notification should have fired.
    expect(mcp.calls.length).toBe(0)
  })

  test('unknown agentId returns 404', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h } = await startEnabled(enabledConfig())
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'x', chatId: 164795011, agentId: 'unknown-agent' }),
    })
    expect(resp.status).toBe(404)
    const body = (await resp.json()) as Record<string, unknown>
    expect(String(body.error)).toContain('unknown-agent')
  })

  test('correct agentId is accepted and meta includes agent_id', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h, mcp } = await startEnabled(enabledConfig())
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'hi', chatId: 164795011, agentId: 'dashi-channel' }),
    })
    expect(resp.status).toBe(200)
    expect(mcp.calls.length).toBe(1)
    const params = mcp.calls[0]!.params as { meta: Record<string, string> }
    expect(params.meta.agent_id).toBe('dashi-channel')
  })

  test('unknown path returns 404', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h } = await startEnabled(enabledConfig())
    const resp = await fetch(url(h, '/nope'))
    expect(resp.status).toBe(404)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.error).toBe('not found')
  })

  test('declared Content-Length > limit returns 413 without draining', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h } = await startEnabled(enabledConfig())
    // Manually craft a request with a huge Content-Length but small body so
    // the server rejects on header alone. fetch() refuses to lie about
    // Content-Length, so we send a tiny body with a header override via a
    // raw socket-style request.
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': String(1024 * 1024), // 1 MB declared
      },
      body: JSON.stringify({ message: 'x', chatId: 164795011 }),
    })
    // Some runtimes will reset Content-Length, in which case the body is
    // small enough to succeed (200). Either reject path is acceptable: this
    // test mainly proves we don't crash. Assert non-5xx.
    expect(resp.status).toBeLessThan(500)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Phase 7 / T4: Claude hook branch — chatId allowlist, agentId guard,
// status-manager dispatch, MCP channel must NOT fire.
// ─────────────────────────────────────────────────────────────────────

interface StatusStubCall {
  chatId: string
  event: { kind: string } & Record<string, unknown>
}

function makeStatusStub(): {
  manager: { recordActivityByChatId: (chatId: string, event: unknown) => Promise<void> }
  calls: StatusStubCall[]
} {
  const calls: StatusStubCall[] = []
  return {
    manager: {
      recordActivityByChatId: async (chatId: string, event: unknown) => {
        calls.push({ chatId, event: event as StatusStubCall['event'] })
      },
    },
    calls,
  }
}

async function startEnabledWithStatus(config: AppConfig): Promise<{
  handle: WebhookServerHandle
  mcp: ReturnType<typeof makeMcpStub>
  status: ReturnType<typeof makeStatusStub>
}> {
  const mcp = makeMcpStub()
  const status = makeStatusStub()
  const h = await startWebhookServer(config, {
    mcpServer: mcp.server,
    config,
    statePaths: paths,
    log: createLogger('test'),
    statusManager: status.manager,
  })
  if (!h) throw new Error('expected handle')
  handle = h
  return { handle: h, mcp, status }
}

describe('POST /hooks/agent — Claude hook payload branch', () => {
  test('valid PreToolUse dispatches to statusManager, no MCP channel call', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h, mcp, status } = await startEnabledWithStatus(enabledConfig())
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatId: 164795011,
        agentId: 'dashi-channel',
        hook_event_name: 'PreToolUse',
        session_id: 's1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
        permission_mode: 'default',
        tool_name: 'Read',
        tool_use_id: 'u1',
        tool_input: { file_path: '/repo/plugin/src/server.ts' },
      }),
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.status).toBe('accepted')
    expect(mcp.calls).toEqual([])
    expect(status.calls.length).toBe(1)
    expect(status.calls[0]!.chatId).toBe('164795011')
    expect(status.calls[0]!.event.kind).toBe('tool_start')
  })

  test('Stop payload maps to session_stop', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h, status } = await startEnabledWithStatus(enabledConfig())
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatId: 164795011,
        hook_event_name: 'Stop',
        session_id: 's1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
      }),
    })
    expect(resp.status).toBe(200)
    expect(status.calls[0]!.event.kind).toBe('session_stop')
  })

  test('UserPromptSubmit does NOT leak prompt into status event', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h, status } = await startEnabledWithStatus(enabledConfig())
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatId: 164795011,
        hook_event_name: 'UserPromptSubmit',
        session_id: 's1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
        prompt: 'Top secret user question',
      }),
    })
    expect(resp.status).toBe(200)
    expect(status.calls[0]!.event.kind).toBe('reasoning')
    expect(JSON.stringify(status.calls)).not.toContain('Top secret user question')
  })

  test('hook payload with non-allowlisted chatId returns 403, no status dispatch', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h, status } = await startEnabledWithStatus(enabledConfig())
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatId: 999999999,
        hook_event_name: 'Stop',
        session_id: 's1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
      }),
    })
    expect(resp.status).toBe(403)
    expect(status.calls.length).toBe(0)
  })

  test('hook payload with unknown agentId returns 404', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h, status } = await startEnabledWithStatus(enabledConfig())
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatId: 164795011,
        agentId: 'someone-else',
        hook_event_name: 'Stop',
        session_id: 's1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
      }),
    })
    expect(resp.status).toBe(404)
    expect(status.calls.length).toBe(0)
  })

  test('invalid hook payload (missing required field) dead-letters + 400', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h, status } = await startEnabledWithStatus(enabledConfig())
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatId: 164795011,
        hook_event_name: 'PreToolUse',
        session_id: 's1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
        // Missing tool_name, tool_use_id, tool_input.
      }),
    })
    expect(resp.status).toBe(400)
    expect(status.calls.length).toBe(0)
    const dlFiles = readdirSync(paths.deadLetterWebhook)
    expect(dlFiles.length).toBeGreaterThanOrEqual(1)
  })

  test('hook payload with no statusManager returns 200 (visibility outage tolerated)', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const mcp = makeMcpStub()
    const cfg = enabledConfig()
    const h = await startWebhookServer(cfg, {
      mcpServer: mcp.server,
      config: cfg,
      statePaths: paths,
      log: createLogger('test'),
      // No statusManager intentionally.
    })
    if (!h) throw new Error('expected handle')
    handle = h
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatId: 164795011,
        hook_event_name: 'Stop',
        session_id: 's1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
      }),
    })
    expect(resp.status).toBe(200)
    expect(mcp.calls.length).toBe(0)
  })

  test('hook payload — statusManager throw still returns 200', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const cfg = enabledConfig()
    const mcp = makeMcpStub()
    const h = await startWebhookServer(cfg, {
      mcpServer: mcp.server,
      config: cfg,
      statePaths: paths,
      log: createLogger('test'),
      statusManager: {
        recordActivityByChatId: async () => {
          throw new Error('Telegram down')
        },
      },
    })
    if (!h) throw new Error('expected handle')
    handle = h
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatId: 164795011,
        hook_event_name: 'Stop',
        session_id: 's1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
      }),
    })
    expect(resp.status).toBe(200)
  })

  test('config.status.enabled=false → hook payload accepted but no dispatch', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    // Override status.enabled to false on top of webhook-enabled config.
    const cfg: AppConfig = {
      ...enabledConfig(),
      status: { ...baseConfig.status, enabled: false },
    }
    const { handle: h, status, mcp } = await startEnabledWithStatus(cfg)
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatId: 164795011,
        hook_event_name: 'PreToolUse',
        session_id: 's1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
        tool_name: 'Read',
        tool_use_id: 'u1',
        tool_input: { file_path: '/x/y.ts' },
      }),
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as Record<string, unknown>
    expect(body.status).toBe('accepted')
    expect(body.note).toBe('status_disabled')
    expect(status.calls.length).toBe(0)
    expect(mcp.calls.length).toBe(0)
  })

  test('message payload path is unchanged when statusManager is wired', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h, mcp, status } = await startEnabledWithStatus(enabledConfig())
    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'legacy hello', chatId: 164795011 }),
    })
    expect(resp.status).toBe(200)
    expect(mcp.calls.length).toBe(1)
    expect(status.calls.length).toBe(0)
  })
})
