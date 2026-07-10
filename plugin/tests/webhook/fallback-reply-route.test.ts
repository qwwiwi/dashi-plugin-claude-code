// feature/dm-fallback-reply-hook (2026-06-03) — webhook route tests for POST
// /hooks/fallback-reply. Exercises the route end-to-end via fetch() with a
// stub sendMessage so no live TG bot is needed.
//
// Taxonomy: happy path (DM + negative group chat_id), sendMessage failure →
// 200 send_failed, 503 when capability unwired, 403 chat not in allowlist,
// 401 missing bearer, 400 malformed body, 413 body too large.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getStatePaths, loadConfig, type AppConfig, type StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import { ensureStateDirs } from '../../src/state/store.js'
import { addLease, emptyAutonomyState, saveAutonomyState } from '../../src/autonomy/store.js'
import { startWebhookServer, type WebhookDeps, type WebhookServerHandle } from '../../src/webhook/server.js'

const FAKE_TOKEN = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'
const WEBHOOK_TOKEN = 'wh_test_token_32_chars__________'
const WARCHIEF_ID = '164795011'
const GROUP_ID = '-1003784643974'

let stateDir: string
let paths: StatePaths
let baseConfig: AppConfig
let handle: WebhookServerHandle | null
let savedAskMode: string | undefined

const HOUR = 3_600_000

// Seed an ACTIVE lease into the per-chat autonomy registry used by the route
// (deps.statePaths = paths). chatId is the fallback body's chat_id.
function seedActiveLease(chatId: string): void {
  const { state } = addLease(
    emptyAutonomyState(),
    { scope: 'реализуй фичу по порядку', expiresAtMs: Date.now() + 4 * HOUR, source: 'owner_cmd', chatId },
    Date.now(),
  )
  saveAutonomyState(paths, chatId, state)
}

interface StubMcp {
  server: { notification: () => Promise<void> }
}
function makeMcpStub(): StubMcp {
  return { server: { notification: async () => { /* noop */ } } }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'dashi-channel-fallback-'))
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
  savedAskMode = process.env.ASK_GUARD_MODE
  delete process.env.ASK_GUARD_MODE
})

afterEach(async () => {
  if (handle) {
    await handle.close()
    handle = null
  }
  delete process.env.TELEGRAM_WEBHOOK_TOKEN
  if (savedAskMode === undefined) delete process.env.ASK_GUARD_MODE
  else process.env.ASK_GUARD_MODE = savedAskMode
  rmSync(stateDir, { recursive: true, force: true })
})

interface SendCall {
  chatId: string
  text: string
}

async function start(
  opts: {
    omitSend?: boolean
    sendMessage?: WebhookDeps['sendMessage']
  } = {},
): Promise<{ h: WebhookServerHandle; calls: SendCall[] }> {
  const calls: SendCall[] = []
  const config: AppConfig = { ...baseConfig, webhook: { enabled: true, host: '127.0.0.1', port: 0 } }
  const sendMessage =
    opts.sendMessage ??
    (async (chatId: string, text: string) => {
      calls.push({ chatId, text })
    })
  const deps: WebhookDeps = {
    mcpServer: makeMcpStub().server as never,
    config,
    statePaths: paths,
    log: createLogger('test-fallback'),
    // 503 path: leave the capability unwired entirely.
    ...(opts.omitSend ? {} : { sendMessage }),
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
  return fetch(url(h, '/hooks/fallback-reply'), { method: 'POST', headers, body: JSON.stringify(body) })
}

describe('POST /hooks/fallback-reply', () => {
  test('happy path sends the DM fallback text', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h, calls } = await start()
    const resp = await post(h, { chat_id: WARCHIEF_ID, text: 'final answer' })
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ status: 'sent' })
    expect(calls).toEqual([{ chatId: WARCHIEF_ID, text: 'final answer' }])
  })

  test('supports a negative group chat_id', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h, calls } = await start()
    const resp = await post(h, { chat_id: GROUP_ID, text: 'grp' })
    expect(resp.status).toBe(200)
    expect(calls).toEqual([{ chatId: GROUP_ID, text: 'grp' }])
  })

  test('sendMessage throw → 200 send_failed, never wedges the hook', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start({
      sendMessage: async () => {
        throw new Error('429 Too Many Requests')
      },
    })
    const resp = await post(h, { chat_id: WARCHIEF_ID, text: 'x' })
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ status: 'send_failed' })
  })

  test('503 when send capability is not wired', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start({ omitSend: true })
    const resp = await post(h, { chat_id: WARCHIEF_ID, text: 'x' })
    expect(resp.status).toBe(503)
    expect(await resp.json()).toEqual({ status: 'fallback_reply_unavailable' })
  })

  test('403 when chat_id not in allowlist', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h, calls } = await start()
    const resp = await post(h, { chat_id: '999999', text: 'x' })
    expect(resp.status).toBe(403)
    expect(calls).toEqual([])
  })

  test('401 without bearer', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h, calls } = await start()
    const resp = await post(h, { chat_id: WARCHIEF_ID, text: 'x' }, null)
    expect(resp.status).toBe(401)
    expect(calls).toEqual([])
  })

  test('400 on malformed body (missing text)', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start()
    const resp = await post(h, { chat_id: WARCHIEF_ID })
    expect(resp.status).toBe(400)
  })

  test('400 on non-numeric chat_id', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start()
    const resp = await post(h, { chat_id: 'abc', text: 'x' })
    expect(resp.status).toBe(400)
  })

  test('400 on empty text', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start()
    const resp = await post(h, { chat_id: WARCHIEF_ID, text: '' })
    expect(resp.status).toBe(400)
  })

  test('413 on a body over the route limit (FIX 5: now 32 KB)', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h, calls } = await start()
    // > FALLBACK_REPLY_BODY_LIMIT_BYTES (32 KB after FIX 5). Schema would also
    // reject text > 4096 chars, but the body cap rejects earlier with 413.
    const huge = 'a'.repeat(40 * 1024)
    const resp = await post(h, { chat_id: WARCHIEF_ID, text: huge })
    expect(resp.status).toBe(413)
    expect(calls).toEqual([])
  })

  test('FIX 5: a 4096-char multibyte text (≤4096 chars but >16 KB UTF-8) is delivered, not 413', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h, calls } = await start()
    // 4096 × 3-byte CJK chars ≈ 12 KB body; switch to 4-byte to exceed the
    // OLD 16 KB cap and prove the 32 KB cap admits it. The hook truncates to
    // ≤4096 chars before posting, so the schema's .max(4096) is satisfied.
    const cjk = '中'.repeat(4096) // 3 bytes each → ~12 KB; under both caps but exercises multibyte
    const resp = await post(h, { chat_id: WARCHIEF_ID, text: cjk })
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ status: 'sent' })
    expect(calls).toEqual([{ chatId: WARCHIEF_ID, text: cjk }])
  })
})

// fix-loop #7 (Fable MED-3) — the fallback route runs the SAME ask-guard so a
// blocked reply's final text cannot bypass the choke point through the DM
// fallback path.
describe('POST /hooks/fallback-reply — ask-guard', () => {
  test('block mode + active lease + self-gate → NOT forwarded, status ask_guard_blocked', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    process.env.ASK_GUARD_MODE = 'block'
    seedActiveLease(WARCHIEF_ID)
    const { h, calls } = await start()
    const resp = await post(h, { chat_id: WARCHIEF_ID, text: 'жду го, мой вождь' })
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ status: 'ask_guard_blocked' })
    expect(calls).toEqual([]) // nothing sent to the owner
  })

  test('block mode + active lease + BENIGN status text → forwarded (rephrased status goes out)', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    process.env.ASK_GUARD_MODE = 'block'
    seedActiveLease(WARCHIEF_ID)
    const { h, calls } = await start()
    const resp = await post(h, { chat_id: WARCHIEF_ID, text: 'Готово, мой вождь. Задеплоил.' })
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ status: 'sent' })
    expect(calls).toEqual([{ chatId: WARCHIEF_ID, text: 'Готово, мой вождь. Задеплоил.' }])
  })

  test('block mode + active lease + hard-gate self-gate → forwarded (hard-gate exempt)', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    process.env.ASK_GUARD_MODE = 'block'
    seedActiveLease(WARCHIEF_ID)
    const { h, calls } = await start()
    const resp = await post(h, { chat_id: WARCHIEF_ID, text: 'жду го на списание денег' })
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ status: 'sent' })
    expect(calls.length).toBe(1)
  })

  test('advisory mode + active lease + self-gate → forwarded unchanged', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    process.env.ASK_GUARD_MODE = 'advisory'
    seedActiveLease(WARCHIEF_ID)
    const { h, calls } = await start()
    const resp = await post(h, { chat_id: WARCHIEF_ID, text: 'жду го' })
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ status: 'sent' })
    expect(calls).toEqual([{ chatId: WARCHIEF_ID, text: 'жду го' }])
  })

  test('block mode but NO active lease → forwarded (guard inert)', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    process.env.ASK_GUARD_MODE = 'block'
    // no lease seeded
    const { h, calls } = await start()
    const resp = await post(h, { chat_id: WARCHIEF_ID, text: 'жду го' })
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ status: 'sent' })
    expect(calls.length).toBe(1)
  })

  test('kill-switch off + active lease + self-gate → forwarded (guard disabled)', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    process.env.ASK_GUARD_MODE = 'off'
    seedActiveLease(WARCHIEF_ID)
    const { h, calls } = await start()
    const resp = await post(h, { chat_id: WARCHIEF_ID, text: 'жду го' })
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ status: 'sent' })
    expect(calls.length).toBe(1)
  })
})
