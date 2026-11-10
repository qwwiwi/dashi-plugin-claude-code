// Request-builder units and child-process coverage with a stalled transport.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const HOOK_SCRIPT = new URL('../../scripts/post-hook.ts', import.meta.url).pathname
const PRIVATE_PAYLOAD = 'private-hook-payload-do-not-log'
let fixtureDir: string
let preloadPath: string

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'post-hook-timeout-'))
  preloadPath = join(fixtureDir, 'stalled-fetch.ts')
  // Loopback listeners are unavailable in the restricted test environment.
  // Replace only the transport; the script uses real AbortSignal timers and
  // runs unchanged in its own process with stdin/stdout/stderr pipes.
  await writeFile(preloadPath, `
globalThis.fetch = async (_url, init) => {
  process.stderr.write('test-webhook-started\\n')
  const signal = init?.signal
  return new Promise((_resolve, reject) => {
    const pendingConnection = setInterval(() => {}, 1000)
    const abort = () => {
      clearInterval(pendingConnection)
      reject(signal.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
`)
})

afterAll(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
})

// A killed child means the hook did not enforce its own deadline. The watchdog
// keeps the regression test bounded even when run against the old implementation.
async function runStalledHook(timeout?: string) {
  const env = { ...process.env }
  delete env.TELEGRAM_HOOK_TIMEOUT_MS
  if (timeout !== undefined) env.TELEGRAM_HOOK_TIMEOUT_MS = timeout
  Object.assign(env, {
    TELEGRAM_WEBHOOK_URL: 'http://127.0.0.1:8089/hooks/agent',
    TELEGRAM_WEBHOOK_TOKEN: TOKEN,
    TELEGRAM_HOOK_CHAT_ID: '1',
  })
  const started = performance.now()
  const child = Bun.spawn([process.execPath, '--preload', preloadPath, HOOK_SCRIPT], {
    env,
    stdin: new Blob([JSON.stringify({ ...baseHook(), prompt: PRIVATE_PAYLOAD })]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let forcedKill = false
  const watchdog = setTimeout(() => {
    forcedKill = true
    child.kill()
  }, 4500)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { forcedKill, elapsed: performance.now() - started, exitCode, stdout, stderr }
  } finally {
    clearTimeout(watchdog)
    child.kill()
  }
}

function expectFailOpenTimeout(result: Awaited<ReturnType<typeof runStalledHook>>) {
  expect(result.stderr).toContain('test-webhook-started')
  expect(result.forcedKill).toBe(false)
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('webhook fetch failed')
  expect(result.stderr).not.toContain(TOKEN)
  expect(result.stderr).not.toContain(PRIVATE_PAYLOAD)
}

describe('post-hook HTTP deadline', () => {
  test('stalled webhook exits fail-open after the default 3000 ms', async () => {
    const result = await runStalledHook()
    expectFailOpenTimeout(result)
    expect(result.elapsed).toBeGreaterThanOrEqual(2900)
    expect(result.elapsed).toBeLessThan(4200)
  }, 6000)

  test('positive env override bounds a stalled webhook without stdout or secrets', async () => {
    const result = await runStalledHook('120')
    expectFailOpenTimeout(result)
    expect(result.elapsed).toBeGreaterThanOrEqual(100)
    expect(result.elapsed).toBeLessThan(1200)
  }, 6000)

  test('nonpositive, nonfinite and empty env values fall back to the 3000 ms deadline', async () => {
    const results = await Promise.all(['0', '-1', 'NaN', 'Infinity', '-Infinity', '', '   '].map(runStalledHook))
    for (const result of results) {
      expectFailOpenTimeout(result)
      expect(result.elapsed).toBeGreaterThanOrEqual(2900)
      expect(result.elapsed).toBeLessThan(4200)
    }
  }, 6000)
})
