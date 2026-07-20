// Webhook route tests for the permission gate (2026-06-09).
//
// Exercises POST /hooks/permission/request end-to-end via fetch() with the
// real relay + a stub UI (no live TG bot). Covers: disabled→503, missing
// bearer→401, allow round-trip, deny round-trip, timeout, no-recipient
// fail-closed deny, and sendPrompt failure→fail-closed deny.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getStatePaths, loadConfig, type AppConfig, type StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import { ensureStateDirs } from '../../src/state/store.js'
import { startWebhookServer, type WebhookServerHandle } from '../../src/webhook/server.js'
import { createPermissionGateRelay, type PermissionGateRelay } from '../../src/channel/permission-gate-relay.js'

const FAKE_TOKEN = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'
const WEBHOOK_TOKEN = 'wh_test_token_32_chars__________'

let stateDir: string
let paths: StatePaths
let baseConfig: AppConfig
let handle: WebhookServerHandle | null

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'agent47-channel-pgate-routes-'))
  process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
  const env = { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_STATE_DIR: stateDir }
  baseConfig = loadConfig(env)
  paths = getStatePaths(baseConfig, env)
  ensureStateDirs(paths)
  handle = null
})

afterEach(async () => {
  if (handle) { await handle.close(); handle = null }
  delete process.env.TELEGRAM_WEBHOOK_TOKEN
  rmSync(stateDir, { recursive: true, force: true })
})

function cfg(opts: { enabled?: boolean; timeoutMs?: number; allowed?: number[] } = {}): AppConfig {
  return {
    ...baseConfig,
    webhook: { enabled: true, host: '127.0.0.1', port: 0 },
    permission_gate: {
      enabled: opts.enabled ?? true,
      timeout_ms: opts.timeoutMs ?? 5000,
      ...(opts.allowed !== undefined ? { allowed_user_ids: opts.allowed } : {}),
    },
  }
}

async function start(
  config: AppConfig,
  onPrompt?: (relay: PermissionGateRelay, requestId: string) => void,
): Promise<{ h: WebhookServerHandle; relay: PermissionGateRelay; promptCalls: string[] }> {
  const relay = createPermissionGateRelay({ log: createLogger('t-relay'), defaultTimeoutMs: config.permission_gate.timeout_ms })
  const promptCalls: string[] = []
  const ui = {
    async sendPrompt(requestId: string) {
      promptCalls.push(requestId)
      if (onPrompt) onPrompt(relay, requestId)
    },
  }
  const h = await startWebhookServer(config, {
    mcpServer: { notification: async () => {} } as never,
    config,
    statePaths: paths,
    log: createLogger('t-webhook'),
    permissionRelay: relay,
    permissionUi: ui,
  })
  if (!h) throw new Error('expected handle')
  handle = h
  return { h, relay, promptCalls }
}

function url(h: WebhookServerHandle, path: string): string {
  return `http://${h.host}:${h.port}${path}`
}

function body(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 's-1',
    tool_use_id: 'tu-1',
    tool_name: 'Bash',
    preview: 'git push origin main',
    reason: 'risky',
    ...extra,
  })
}

const AUTH = { 'Content-Type': 'application/json', Authorization: `Bearer ${WEBHOOK_TOKEN}` }

describe('POST /hooks/permission/request', () => {
  test('disabled gate → 503 (hook fails closed)', async () => {
    const { h } = await start(cfg({ enabled: false }))
    const res = await fetch(url(h, '/hooks/permission/request'), { method: 'POST', headers: AUTH, body: body() })
    expect(res.status).toBe(503)
  })

  test('missing bearer → 401', async () => {
    const { h } = await start(cfg())
    const res = await fetch(url(h, '/hooks/permission/request'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body(),
    })
    expect(res.status).toBe(401)
  })

  test('allow round-trip: tap allow → {status:allow}', async () => {
    const { h } = await start(cfg(), (relay, requestId) => {
      // Simulate the warchief tapping Allow right after the keyboard is sent.
      relay.answer(requestId, 'allow')
    })
    const res = await fetch(url(h, '/hooks/permission/request'), { method: 'POST', headers: AUTH, body: body() })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'allow' })
  })

  test('deny round-trip: tap deny → {status:deny}', async () => {
    const { h } = await start(cfg(), (relay, requestId) => {
      relay.answer(requestId, 'deny')
    })
    const res = await fetch(url(h, '/hooks/permission/request'), { method: 'POST', headers: AUTH, body: body() })
    const json = await res.json() as { status: string }
    expect(json.status).toBe('deny')
  })

  test('timeout → {status:timeout}', async () => {
    const { h } = await start(cfg({ timeoutMs: 30 }))
    const res = await fetch(url(h, '/hooks/permission/request'), { method: 'POST', headers: AUTH, body: body() })
    const json = await res.json() as { status: string }
    expect(json.status).toBe('timeout')
  })

  test('no configured recipient → fail-closed deny', async () => {
    const { h } = await start(cfg({ allowed: [] }))
    const res = await fetch(url(h, '/hooks/permission/request'), { method: 'POST', headers: AUTH, body: body() })
    const json = await res.json() as { status: string }
    expect(json.status).toBe('deny')
  })

  test('sendPrompt failure → fail-closed deny (no waiting out the timeout)', async () => {
    const relay = createPermissionGateRelay({ log: createLogger('t'), defaultTimeoutMs: 5000 })
    const ui = { async sendPrompt() { throw new Error('telegram down') } }
    const h = await startWebhookServer(cfg(), {
      mcpServer: { notification: async () => {} } as never,
      config: cfg(),
      statePaths: paths,
      log: createLogger('t'),
      permissionRelay: relay,
      permissionUi: ui,
    })
    if (!h) throw new Error('handle')
    handle = h
    const res = await fetch(url(h, '/hooks/permission/request'), { method: 'POST', headers: AUTH, body: body() })
    const json = await res.json() as { status: string }
    expect(json.status).toBe('deny')
  })

  test('writes an audit JSONL with created + resolved events', async () => {
    const { h } = await start(cfg(), (relay, requestId) => relay.answer(requestId, 'allow'))
    await fetch(url(h, '/hooks/permission/request'), { method: 'POST', headers: AUTH, body: body() })
    expect(existsSync(paths.logs.permission_gate)).toBe(true)
    const lines = readFileSync(paths.logs.permission_gate, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.some((e) => e.event === 'request_created')).toBe(true)
    expect(lines.some((e) => e.event === 'request_resolved' && e.status === 'allow')).toBe(true)
  })
})
