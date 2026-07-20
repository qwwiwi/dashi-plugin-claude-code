// fix/eyes-on-read (2026-05-28) — webhook route tests for POST /hooks/react.
// Exercises the read-receipt route end-to-end via fetch() with a stub
// reactToMessage so no live TG bot is needed.
//
// Taxonomy: happy path (DM + negative group chat_id), emoji default,
// reactToMessage failure → 200 react_failed, 503 when capability unwired,
// 403 chat not in allowlist, 401 missing bearer, 400 malformed body.

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
const GROUP_ID = '-1003784643974'

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
  stateDir = mkdtempSync(join(tmpdir(), 'agent47-channel-react-'))
  delete process.env.TELEGRAM_WEBHOOK_TOKEN
  const env = {
    TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    TELEGRAM_STATE_DIR: stateDir,
    TELEGRAM_ALLOWED_CHAT_IDS: `${WARCHIEF_ID},${GROUP_ID}`,
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

interface ReactCall {
  chatId: string
  messageId: number
  emoji: string
}

async function start(
  opts: {
    omitReact?: boolean
    reactToMessage?: WebhookDeps['reactToMessage']
  } = {},
): Promise<{ h: WebhookServerHandle; calls: ReactCall[] }> {
  const calls: ReactCall[] = []
  const config: AppConfig = { ...baseConfig, webhook: { enabled: true, host: '127.0.0.1', port: 0 } }
  const reactToMessage =
    opts.reactToMessage ??
    (async (chatId: string, messageId: number, emoji: string) => {
      calls.push({ chatId, messageId, emoji })
    })
  const deps: WebhookDeps = {
    mcpServer: makeMcpStub().server as never,
    config,
    statePaths: paths,
    log: createLogger('test-react'),
    // 503 path: leave the capability unwired entirely.
    ...(opts.omitReact ? {} : { reactToMessage }),
  }
  const h = await startWebhookServer(config, deps)
  if (!h) throw new Error('expected handle')
  handle = h
  return { h, calls }
}

function url(h: WebhookServerHandle, path: string): string {
  return `http://${h.host}:${h.port}${path}`
}

function post(h: WebhookServerHandle, body: unknown, token: string | null = WEBHOOK_TOKEN): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(url(h, '/hooks/react'), { method: 'POST', headers, body: JSON.stringify(body) })
}

describe('POST /hooks/react', () => {
  test('happy path sets 👀 for a DM message_id', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h, calls } = await start()
    const resp = await post(h, { chat_id: WARCHIEF_ID, message_id: 28045 })
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ status: 'reacted' })
    expect(calls).toEqual([{ chatId: WARCHIEF_ID, messageId: 28045, emoji: '👀' }])
  })

  test('coerces numeric-string message_id and supports negative group chat_id', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h, calls } = await start()
    const resp = await post(h, { chat_id: GROUP_ID, message_id: '42' })
    expect(resp.status).toBe(200)
    expect(calls).toEqual([{ chatId: GROUP_ID, messageId: 42, emoji: '👀' }])
  })

  test('honours an explicit emoji override', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h, calls } = await start()
    await post(h, { chat_id: WARCHIEF_ID, message_id: 1, emoji: '🔥' })
    expect(calls[0]?.emoji).toBe('🔥')
  })

  test('reactToMessage throw → 200 react_failed, never wedges the hook', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start({
      reactToMessage: async () => {
        throw new Error('429 Too Many Requests')
      },
    })
    const resp = await post(h, { chat_id: WARCHIEF_ID, message_id: 5 })
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ status: 'react_failed' })
  })

  test('503 when reaction capability is not wired', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start({ omitReact: true })
    const resp = await post(h, { chat_id: WARCHIEF_ID, message_id: 5 })
    expect(resp.status).toBe(503)
    expect(await resp.json()).toEqual({ status: 'reactions_unavailable' })
  })

  test('403 when chat_id not in allowlist', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h, calls } = await start()
    const resp = await post(h, { chat_id: '999999', message_id: 5 })
    expect(resp.status).toBe(403)
    expect(calls).toEqual([])
  })

  test('401 without bearer', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h, calls } = await start()
    const resp = await post(h, { chat_id: WARCHIEF_ID, message_id: 5 }, null)
    expect(resp.status).toBe(401)
    expect(calls).toEqual([])
  })

  test('400 on malformed body (missing message_id)', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start()
    const resp = await post(h, { chat_id: WARCHIEF_ID })
    expect(resp.status).toBe(400)
  })

  test('400 on non-positive message_id', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start()
    const resp = await post(h, { chat_id: WARCHIEF_ID, message_id: 0 })
    expect(resp.status).toBe(400)
  })
})
