// Stage 1 (2026-08-30) — webhook route tests for POST /hooks/notification.
// Route end-to-end via fetch() with a stub sendMessage. Verifies the wrapped
// «⚠️ <agent> ждёт ответ: …» format, agent_id label + tmux hint, fail-open on
// send errors, and the usual auth/allowlist fences.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getStatePaths, loadConfig, type AppConfig, type StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import { ensureStateDirs } from '../../src/state/store.js'
import { startWebhookServer, type WebhookDeps, type WebhookServerHandle } from '../../src/webhook/server.js'

const FAKE_TOKEN = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'
const WEBHOOK_TOKEN = 'wh_test_token_32_chars__________'
const WARCHIEF_ID = '164795011'
const OTHER_ID = '999999999'

let stateDir: string
let paths: StatePaths
let baseConfig: AppConfig
let handle: WebhookServerHandle | null

interface StubMcp {
  server: { notification: () => Promise<void> }
}
function makeMcpStub(): StubMcp {
  return { server: { notification: async () => { /* noop */ } } }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'dashi-channel-notif-'))
  delete process.env.TELEGRAM_WEBHOOK_TOKEN
  const env = {
    TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    TELEGRAM_STATE_DIR: stateDir,
    TELEGRAM_ALLOWED_CHAT_IDS: WARCHIEF_ID,
  }
  baseConfig = loadConfig(env)
  paths = getStatePaths(baseConfig, { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_STATE_DIR: stateDir })
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

interface SendCall { chatId: string; text: string }

async function start(
  opts: { omitSend?: boolean; sendMessage?: WebhookDeps['sendMessage'] } = {},
): Promise<{ h: WebhookServerHandle; calls: SendCall[] }> {
  const calls: SendCall[] = []
  const config: AppConfig = { ...baseConfig, webhook: { enabled: true, host: '127.0.0.1', port: 0 } }
  const sendMessage =
    opts.sendMessage ??
    (async (chatId: string, text: string) => { calls.push({ chatId, text }) })
  const deps: WebhookDeps = {
    mcpServer: makeMcpStub().server as never,
    config,
    statePaths: paths,
    log: createLogger('test-notification'),
    ...(opts.omitSend ? {} : { sendMessage }),
  }
  const h = await startWebhookServer(config, deps)
  if (!h) throw new Error('expected handle')
  handle = h
  return { h, calls }
}

function url(h: WebhookServerHandle, p: string): string {
  return `http://${h.host}:${h.port}${p}`
}

function post(h: WebhookServerHandle, body: unknown, token: string | null = WEBHOOK_TOKEN): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(url(h, '/hooks/notification'), { method: 'POST', headers, body: JSON.stringify(body) })
}

describe('POST /hooks/notification', () => {
  test('happy path formats with agent label + tmux hint', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h, calls } = await start()
    const resp = await post(h, {
      chat_id: WARCHIEF_ID,
      agent_id: 'coder',
      session_id: 'sess-123',
      message: 'Claude needs your permission to use Bash',
    })
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ status: 'sent' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.chatId).toBe(WARCHIEF_ID)
    expect(calls[0]?.text).toContain('⚠️ coder ждёт ответ')
    expect(calls[0]?.text).toContain('Claude needs your permission to use Bash')
    expect(calls[0]?.text).toContain('открой tmux coder')
  })

  test('falls back to "session" label when agent_id is empty', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h, calls } = await start()
    const resp = await post(h, {
      chat_id: WARCHIEF_ID,
      message: 'idle 60s',
    })
    expect(resp.status).toBe(200)
    expect(calls[0]?.text).toContain('⚠️ session ждёт ответ')
    expect(calls[0]?.text).not.toContain('открой tmux')
  })

  test('sendMessage throw → 200 send_failed, never wedges the hook', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start({
      sendMessage: async () => { throw new Error('boom') },
    })
    const resp = await post(h, {
      chat_id: WARCHIEF_ID,
      agent_id: 'coder',
      message: 'x',
    })
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ status: 'send_failed' })
  })

  test('503 when sendMessage capability is unwired', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start({ omitSend: true })
    const resp = await post(h, { chat_id: WARCHIEF_ID, message: 'x' })
    expect(resp.status).toBe(503)
  })

  test('403 when chat_id not in allowlist', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start()
    const resp = await post(h, { chat_id: OTHER_ID, message: 'x' })
    expect(resp.status).toBe(403)
  })

  test('401 when bearer is missing', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start()
    const resp = await post(h, { chat_id: WARCHIEF_ID, message: 'x' }, null)
    expect(resp.status).toBe(401)
  })

  test('400 when message is missing', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start()
    const resp = await post(h, { chat_id: WARCHIEF_ID })
    expect(resp.status).toBe(400)
  })
})
