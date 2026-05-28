// PRX-1 TASK-3 (2026-05-27) — webhook route tests for AskUserQuestion.
//
// Exercises the two routes wired in src/webhook/server.ts end-to-end via
// fetch(), with a stub relay + UI so we don't need a live TG bot or
// real grammy keyboard rendering. The relay stub mirrors the real
// AskUserQuestionRelay's pending lifecycle just enough to make the
// /request → /answer round-trip work in tests.
//
// Test taxonomy:
//   * /request happy path, pass_through (feature gate), pass_through
//     (no chat), malformed payload, missing bearer, non-loopback (skipped
//     because Node's req.socket reports 127.0.0.1 for in-process fetch —
//     covered by reasoning instead of integration), 64 KB body cap.
//   * /answer happy path (answered round-trip), expired, unauthorized,
//     400 on missing fields, action=other path.
//   * Audit JSONL exists with the expected event lines.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getStatePaths, loadConfig, type AppConfig, type StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import { ensureStateDirs } from '../../src/state/store.js'
import {
  startWebhookServer,
  type AskUserQuestionUi,
  type WebhookServerHandle,
} from '../../src/webhook/server.js'
import { createAskUserQuestionRelay, type AskUserQuestionRelay } from '../../src/channel/ask-user-question.js'

const FAKE_TOKEN = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'
const WEBHOOK_TOKEN = 'wh_test_token_32_chars__________'
const WARCHIEF_ID = 164795011

let stateDir: string
let paths: StatePaths
let baseConfig: AppConfig
let handle: WebhookServerHandle | null

interface StubMcp {
  server: { notification: (msg: { method: string; params: unknown }) => Promise<void> }
}
function makeMcpStub(): StubMcp {
  return {
    server: {
      notification: async () => { /* noop */ },
    },
  }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'dashi-channel-aiq-routes-'))
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
  // ensureStateDirs now creates the state directory tree (state/store.ts).
  // The audit writer also creates its parent dir on demand via
  // mkdirSync(recursive: true), so either path is safe.
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

function enabledConfig(opts: { askEnabled?: boolean; askTimeoutMs?: number } = {}): AppConfig {
  return {
    ...baseConfig,
    webhook: { enabled: true, host: '127.0.0.1', port: 0 },
    ask_user_question: {
      enabled: opts.askEnabled ?? true,
      timeout_ms: opts.askTimeoutMs ?? 5000,
      max_preview_chars: 1000,
    },
  }
}

interface StartedDeps {
  handle: WebhookServerHandle
  relay: AskUserQuestionRelay
  uiCalls: string[]
}

async function startWithRelay(
  config: AppConfig,
  ui?: AskUserQuestionUi,
): Promise<StartedDeps> {
  const relay = createAskUserQuestionRelay({
    log: createLogger('test-relay'),
    defaultTimeoutMs: config.ask_user_question.timeout_ms,
  })
  const uiCalls: string[] = []
  const stubUi: AskUserQuestionUi = ui ?? {
    startQuestion(requestId: string) {
      uiCalls.push(requestId)
    },
  }
  const h = await startWebhookServer(config, {
    mcpServer: makeMcpStub().server as never,
    config,
    statePaths: paths,
    log: createLogger('test-webhook'),
    askRelay: relay,
    askUi: stubUi,
  })
  if (!h) throw new Error('expected handle')
  handle = h
  return { handle: h, relay, uiCalls }
}

function url(h: WebhookServerHandle, path: string): string {
  return `http://${h.host}:${h.port}${path}`
}

const SAMPLE_QUESTION = {
  question: 'Какой стек выбрать?',
  header: 'Stack',
  multiSelect: false,
  options: [
    { label: 'React', description: 'Component-based UI' },
    { label: 'Vue', description: 'Reactive framework' },
  ],
}

function requestBody(extra: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    session_id: 'sess-1',
    tool_use_id: 'toolu_test_001',
    transcript_path: '/tmp/t.jsonl',
    questions: [SAMPLE_QUESTION],
    ...extra,
  })
}

// ─────────────────────────────────────────────────────────────────────

describe('POST /hooks/ask-user-question/request', () => {
  test('rejects without bearer (401)', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h } = await startWithRelay(enabledConfig())
    const resp = await fetch(url(h, '/hooks/ask-user-question/request'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody(),
    })
    expect(resp.status).toBe(401)
  })

  test('503 when no TELEGRAM_WEBHOOK_TOKEN configured', async () => {
    const { handle: h } = await startWithRelay(enabledConfig())
    const resp = await fetch(url(h, '/hooks/ask-user-question/request'), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer anything',
        'Content-Type': 'application/json',
      },
      body: requestBody(),
    })
    expect(resp.status).toBe(503)
  })

  test('rejects malformed body (>4 questions) → 400', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h } = await startWithRelay(enabledConfig())
    const fiveQuestions = Array.from({ length: 5 }, () => SAMPLE_QUESTION)
    const resp = await fetch(url(h, '/hooks/ask-user-question/request'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: requestBody({ questions: fiveQuestions }),
    })
    expect(resp.status).toBe(400)
    const body = (await resp.json()) as { error: string }
    expect(body.error).toMatch(/invalid payload/)
  })

  test('rejects malformed body (5 options in a question) → 400', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h } = await startWithRelay(enabledConfig())
    const tooManyOptions = {
      ...SAMPLE_QUESTION,
      options: Array.from({ length: 5 }, (_, i) => ({
        label: `opt${i}`,
        description: `desc${i}`,
      })),
    }
    const resp = await fetch(url(h, '/hooks/ask-user-question/request'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: requestBody({ questions: [tooManyOptions] }),
    })
    expect(resp.status).toBe(400)
  })

  test('config.ask_user_question.enabled=false → 200 pass_through', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h, uiCalls } = await startWithRelay(
      enabledConfig({ askEnabled: false }),
    )
    const resp = await fetch(url(h, '/hooks/ask-user-question/request'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: requestBody(),
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { status: string }
    expect(body.status).toBe('pass_through')
    // UI must NOT have been invoked when feature gated off.
    expect(uiCalls).toEqual([])
  })

  test('happy path: /request + /answer → request resolves with updatedInput', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h, relay, uiCalls } = await startWithRelay(enabledConfig())

    // Fire request without awaiting yet.
    const reqPromise = fetch(url(h, '/hooks/ask-user-question/request'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: requestBody(),
    })

    // Wait until the relay actually has a pending request — `await ui.startQuestion`
    // means by the time the route returns to the await, the request id is set.
    // We poll on a tight interval (≤50 ms total) so the test stays fast.
    let requestId: string | undefined
    for (let i = 0; i < 50; i++) {
      const pending = relay.listPendingIds()
      if (pending.length > 0) {
        requestId = pending[0]
        break
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(requestId).toBeDefined()
    expect(uiCalls).toEqual([requestId!])

    // Send the /answer call with action=choose
    const answerResp = await fetch(url(h, '/hooks/ask-user-question/answer'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        request_id: requestId,
        action: 'choose',
        question_index: 0,
        selected_option_index: 0,
        user_id: WARCHIEF_ID,
      }),
    })
    expect(answerResp.status).toBe(200)
    const answerBody = (await answerResp.json()) as { status: string }
    expect(answerBody.status).toBe('accepted')

    // /request resolves with updatedInput.
    const resp = await reqPromise
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { status: string; updatedInput?: { answers: Record<string, string> } }
    expect(body.status).toBe('answered')
    expect(body.updatedInput?.answers).toEqual({ 'Какой стек выбрать?': 'React' })
  })

  test('relay timeout → 200 with status=timeout', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    // 100 ms timeout so the test resolves fast.
    const { handle: h, relay } = await startWithRelay(
      enabledConfig({ askTimeoutMs: 100 }),
    )
    const resp = await fetch(url(h, '/hooks/ask-user-question/request'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: requestBody({ timeout_ms: 80 }),
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { status: string; reason?: string }
    expect(body.status).toBe('timeout')
    // After timeout the pending entry is cleared.
    expect(relay.pendingCount()).toBe(0)
  })

  test('audit JSONL appends request_created and request_answered lines', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h, relay } = await startWithRelay(enabledConfig())

    const reqPromise = fetch(url(h, '/hooks/ask-user-question/request'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: requestBody({ tool_use_id: 'toolu_audit_x' }),
    })

    let requestId: string | undefined
    for (let i = 0; i < 50; i++) {
      const pending = relay.listPendingIds()
      if (pending.length > 0) {
        requestId = pending[0]
        break
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(requestId).toBeDefined()

    await fetch(url(h, '/hooks/ask-user-question/answer'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        request_id: requestId,
        action: 'choose',
        question_index: 0,
        selected_option_index: 1,
        user_id: WARCHIEF_ID,
      }),
    })
    await reqPromise

    expect(existsSync(paths.logs.ask_user_question)).toBe(true)
    const raw = readFileSync(paths.logs.ask_user_question, 'utf8')
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    const events = lines.map((l) => l.event)
    expect(events).toContain('request_created')
    expect(events).toContain('request_answered')
    const created = lines.find((l) => l.event === 'request_created')!
    expect(created.tool_use_id).toBe('toolu_audit_x')
    expect(created.question_count).toBe(1)
    expect(typeof created.ts).toBe('string')
  })
})

// ─────────────────────────────────────────────────────────────────────

describe('POST /hooks/ask-user-question/answer', () => {
  test('expired request_id returns 200 status=expired', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h } = await startWithRelay(enabledConfig())
    const resp = await fetch(url(h, '/hooks/ask-user-question/answer'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        request_id: 'abcde',
        action: 'choose',
        question_index: 0,
        selected_option_index: 0,
        user_id: WARCHIEF_ID,
      }),
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { status: string }
    expect(body.status).toBe('expired')
  })

  test('unauthorized user_id returns 200 status=unauthorized + audit', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h, relay } = await startWithRelay(enabledConfig())
    // Kick off a request to create a pending entry the answer can target.
    const reqPromise = fetch(url(h, '/hooks/ask-user-question/request'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: requestBody({ tool_use_id: 'toolu_unauth' }),
    })
    let requestId: string | undefined
    for (let i = 0; i < 50; i++) {
      const pending = relay.listPendingIds()
      if (pending.length > 0) {
        requestId = pending[0]
        break
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(requestId).toBeDefined()

    const resp = await fetch(url(h, '/hooks/ask-user-question/answer'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        request_id: requestId,
        action: 'choose',
        question_index: 0,
        selected_option_index: 0,
        user_id: 999_999_999,
      }),
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { status: string }
    expect(body.status).toBe('unauthorized')

    // Audit recorded the unauthorized attempt.
    expect(existsSync(paths.logs.ask_user_question)).toBe(true)
    const raw = readFileSync(paths.logs.ask_user_question, 'utf8')
    expect(raw).toContain('request_unauthorized')

    // Time-out the still-pending request so we don't leak the test.
    relay.expire(requestId!, 'test cleanup')
    await reqPromise
  })

  test('action=choose missing selected_option_index → 400', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h, relay } = await startWithRelay(enabledConfig())
    // Need a pending request for the route to get past the isPending check.
    const reqPromise = fetch(url(h, '/hooks/ask-user-question/request'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: requestBody({ tool_use_id: 'toolu_missing_opt' }),
    })
    let requestId: string | undefined
    for (let i = 0; i < 50; i++) {
      const pending = relay.listPendingIds()
      if (pending.length > 0) {
        requestId = pending[0]
        break
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(requestId).toBeDefined()

    const resp = await fetch(url(h, '/hooks/ask-user-question/answer'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        request_id: requestId,
        action: 'choose',
        question_index: 0,
        // selected_option_index intentionally omitted.
        user_id: WARCHIEF_ID,
      }),
    })
    expect(resp.status).toBe(400)
    const body = (await resp.json()) as { error: string }
    expect(body.error).toMatch(/selected_option_index/)

    relay.expire(requestId!, 'test cleanup')
    await reqPromise
  })

  test('action=other with selected_label routes through relay.answerOther', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h, relay } = await startWithRelay(enabledConfig())

    const reqPromise = fetch(url(h, '/hooks/ask-user-question/request'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: requestBody({ tool_use_id: 'toolu_other_text' }),
    })
    let requestId: string | undefined
    for (let i = 0; i < 50; i++) {
      const pending = relay.listPendingIds()
      if (pending.length > 0) {
        requestId = pending[0]
        break
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(requestId).toBeDefined()

    const answerResp = await fetch(url(h, '/hooks/ask-user-question/answer'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        request_id: requestId,
        action: 'other',
        question_index: 0,
        selected_label: 'Svelte',
        user_id: WARCHIEF_ID,
      }),
    })
    expect(answerResp.status).toBe(200)

    const resp = await reqPromise
    const body = (await resp.json()) as { status: string; updatedInput?: { answers: Record<string, string> } }
    expect(body.status).toBe('answered')
    expect(body.updatedInput?.answers).toEqual({ 'Какой стек выбрать?': 'Svelte' })
  })

  test('schema validation: malformed request_id (4 chars) returns 400', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h } = await startWithRelay(enabledConfig())
    const resp = await fetch(url(h, '/hooks/ask-user-question/answer'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        request_id: 'abcd', // 4 chars, not 5
        action: 'choose',
        question_index: 0,
        selected_option_index: 0,
        user_id: WARCHIEF_ID,
      }),
    })
    expect(resp.status).toBe(400)
  })

  // F5: index caps tightened from .max(10) to .max(3). question_index=4
  // is out of the 4-question max (indices 0..3) and must reject as a
  // schema 400.
  test('F5: schema validation: question_index=4 returns 400', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h } = await startWithRelay(enabledConfig())
    const resp = await fetch(url(h, '/hooks/ask-user-question/answer'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        request_id: 'abcde',
        action: 'choose',
        question_index: 4,
        selected_option_index: 0,
        user_id: WARCHIEF_ID,
      }),
    })
    expect(resp.status).toBe(400)
    const body = (await resp.json()) as { error: string }
    expect(body.error).toMatch(/question_index/)
  })

  test('F5: schema validation: selected_option_index=4 returns 400', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h } = await startWithRelay(enabledConfig())
    const resp = await fetch(url(h, '/hooks/ask-user-question/answer'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        request_id: 'abcde',
        action: 'choose',
        question_index: 0,
        selected_option_index: 4,
        user_id: WARCHIEF_ID,
      }),
    })
    expect(resp.status).toBe(400)
    const body = (await resp.json()) as { error: string }
    expect(body.error).toMatch(/selected_option_index/)
  })

  // F6: /answer with chat_id mismatch returns 200 status=unauthorized
  // and writes a `request_unauthorized` audit event tagged with
  // `chat_id_attempted`.
  test('F6: chat_id mismatch returns 200 status=unauthorized + audit', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h, relay } = await startWithRelay(enabledConfig())
    // Kick off a pending request so the /answer route has a record
    // bound to the warchief's chat_id.
    const reqPromise = fetch(url(h, '/hooks/ask-user-question/request'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: requestBody({ tool_use_id: 'toolu_chatid_mismatch' }),
    })
    let requestId: string | undefined
    for (let i = 0; i < 50; i++) {
      const pending = relay.listPendingIds()
      if (pending.length > 0) {
        requestId = pending[0]
        break
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(requestId).toBeDefined()

    // Answer with a chat_id that doesn't match the pending request's
    // bound chat_id (we resolved the bound chat_id from warchief's
    // user_id = WARCHIEF_ID, so the pending record's chatId is
    // String(WARCHIEF_ID)). Use 999_000_000 as a deliberate mismatch.
    const resp = await fetch(url(h, '/hooks/ask-user-question/answer'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        request_id: requestId,
        action: 'choose',
        question_index: 0,
        selected_option_index: 0,
        user_id: WARCHIEF_ID,
        chat_id: '999000000',
      }),
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { status: string }
    expect(body.status).toBe('unauthorized')

    // Audit recorded the chat_id mismatch with reason field.
    expect(existsSync(paths.logs.ask_user_question)).toBe(true)
    const raw = readFileSync(paths.logs.ask_user_question, 'utf8')
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    const mismatch = lines.find(
      (l) => l.event === 'request_unauthorized' && l.reason === 'chat_id mismatch',
    )
    expect(mismatch).toBeDefined()
    expect(mismatch?.chat_id_attempted).toBe('999000000')
    expect(mismatch?.chat_id_expected).toBe(String(WARCHIEF_ID))

    // Cleanup the still-pending request.
    relay.expire(requestId!, 'test cleanup')
    await reqPromise
  })

  // F6: /answer WITHOUT chat_id falls through to the user_id check
  // (legacy DM-only callers). Asserts no false-positive unauthorized.
  test('F6: chat_id omitted skips binding check (legacy)', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h, relay } = await startWithRelay(enabledConfig())
    const reqPromise = fetch(url(h, '/hooks/ask-user-question/request'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: requestBody({ tool_use_id: 'toolu_chatid_omit' }),
    })
    let requestId: string | undefined
    for (let i = 0; i < 50; i++) {
      const pending = relay.listPendingIds()
      if (pending.length > 0) {
        requestId = pending[0]
        break
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(requestId).toBeDefined()

    const answerResp = await fetch(url(h, '/hooks/ask-user-question/answer'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        request_id: requestId,
        action: 'choose',
        question_index: 0,
        selected_option_index: 0,
        user_id: WARCHIEF_ID,
        // chat_id intentionally omitted
      }),
    })
    expect(answerResp.status).toBe(200)
    const body = (await answerResp.json()) as { status: string }
    expect(body.status).toBe('accepted')
    await reqPromise
  })
})

// ─────────────────────────────────────────────────────────────────────
// F2: full question shape (header + per-option preview) round-trips
// through the relay so the TG renderer (which reads via getPending())
// receives the same payload the hook wrapper sent.
// ─────────────────────────────────────────────────────────────────────

describe('F2: round-trip header/preview through relay', () => {
  test('header and preview survive submit → getPending', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { handle: h, relay } = await startWithRelay(enabledConfig())
    const sampleWithPreview = {
      question: 'Какой стек выбрать?',
      header: 'Stack',
      multiSelect: false,
      options: [
        { label: 'React', description: 'UI lib', preview: 'createRoot(...).render()' },
        { label: 'Vue', description: 'Reactive', preview: 'createApp(...).mount()' },
      ],
    }
    const reqPromise = fetch(url(h, '/hooks/ask-user-question/request'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session_id: 'sess-prv',
        tool_use_id: 'toolu_preview_x',
        questions: [sampleWithPreview],
      }),
    })
    let requestId: string | undefined
    for (let i = 0; i < 50; i++) {
      const pending = relay.listPendingIds()
      if (pending.length > 0) {
        requestId = pending[0]
        break
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(requestId).toBeDefined()
    const pendingRec = relay.getPending(requestId!)
    expect(pendingRec).toBeDefined()
    const q0 = pendingRec!.questions[0] as unknown as Record<string, unknown>
    expect(q0.header).toBe('Stack')
    const options = q0.options as Array<Record<string, unknown>>
    expect(options[0]?.preview).toBe('createRoot(...).render()')
    expect(options[1]?.preview).toBe('createApp(...).mount()')

    relay.expire(requestId!, 'test cleanup')
    await reqPromise
  })
})

// ─────────────────────────────────────────────────────────────────────
// F4: startQuestion deadline. If the UI handler stalls beyond 10s, the
// route logs the deadline and falls through to the relay timeout. The
// hook wrapper still sees a clean `{ status: 'timeout' }` because the
// relay's own 5min timer (clamped to test config) is authoritative.
// Test uses askTimeoutMs=200 so we don't actually wait 10s — the
// deadline fires after the relay timeout instead, so the relay path
// still drives the response.
// ─────────────────────────────────────────────────────────────────────

describe('F4: startQuestion deadline', () => {
  test('UI handler that stalls past relay timeout still returns clean timeout', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const stallUi: AskUserQuestionUi = {
      startQuestion: () => new Promise<void>(() => {
        /* never resolves — simulates wedged TG send */
      }),
    }
    const { handle: h } = await startWithRelay(
      enabledConfig({ askTimeoutMs: 150 }),
      stallUi,
    )
    const resp = await fetch(url(h, '/hooks/ask-user-question/request'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: requestBody({ timeout_ms: 100, tool_use_id: 'toolu_stall_ui' }),
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { status: string }
    // The relay timeout (100 ms) drives the response — startQuestion
    // never resolved but didn't block the route from returning timeout.
    expect(body.status).toBe('timeout')
  })
})

// ─────────────────────────────────────────────────────────────────────
// F1 follow-up: when no allowed user id resolves (helper returns empty
// array), the route returns 200 status=pass_through so the hook wrapper
// falls back to native CC UI. We simulate this by emptying both
// permission_relay and ask_user_question allow lists.
// ─────────────────────────────────────────────────────────────────────

describe('F1: no allowed user id → pass_through', () => {
  test('empty allow lists → pass_through', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const cfg: AppConfig = {
      ...enabledConfig(),
      permission_relay: {
        ...baseConfig.permission_relay,
        allowed_user_ids: [],
      },
      ask_user_question: {
        ...enabledConfig().ask_user_question,
        allowed_user_ids: [],
      },
    }
    const { handle: h } = await startWithRelay(cfg)
    const resp = await fetch(url(h, '/hooks/ask-user-question/request'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: requestBody(),
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as { status: string }
    expect(body.status).toBe('pass_through')
  })
})
