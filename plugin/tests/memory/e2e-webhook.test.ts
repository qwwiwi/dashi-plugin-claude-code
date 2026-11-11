// Phase 8 / T8 — End-to-end: real webhook + real MemoryWriter + real
// tmp workspace. POST UserPromptSubmit + Stop and assert recent.md and
// verbose-YYYY-MM-DD.jsonl appear with the expected contents.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getStatePaths, loadConfig, type AppConfig, type StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import { ensureStateDirs } from '../../src/state/store.js'
import { MemoryWriter, type MemoryConfig } from '../../src/memory/writer.js'
import { startWebhookServer, type WebhookServerHandle } from '../../src/webhook/server.js'

const FAKE_TOKEN = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'
const WEBHOOK_TOKEN = 'wh_test_token_32_chars__________'

let stateDir: string
let paths: StatePaths
let baseConfig: AppConfig
let handle: WebhookServerHandle | null
let workspaceDir: string
let logsDir: string

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'dashi-memory-e2e-state-'))
  workspaceDir = mkdtempSync(join(tmpdir(), 'dashi-memory-e2e-ws-'))
  logsDir = join(workspaceDir, '..', 'logs-' + Math.random().toString(36).slice(2, 8))
  delete process.env.TELEGRAM_WEBHOOK_TOKEN
  const env = {
    TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    TELEGRAM_ALLOWED_USER_IDS: '164795011',
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
  rmSync(workspaceDir, { recursive: true, force: true })
  rmSync(logsDir, { recursive: true, force: true })
})

function makeMcpStub(): { server: any; calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = []
  const server = {
    notification: async (msg: { method: string; params: unknown }) => {
      calls.push({ method: msg.method, params: msg.params })
    },
  }
  return { server, calls }
}

function memCfg(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    workspacePath: workspaceDir,
    logsPath: logsDir,
    sourceTag: 'tg',
    agentLabel: 'Silvana',
    maxHotBytes: 20480,
    trimKeepLines: 600,
    bufferTtlMs: 5 * 60 * 1000,
    bufferMaxEntries: 100,
    ...overrides,
  }
}

function enabledConfig(): AppConfig {
  return {
    ...baseConfig,
    webhook: { enabled: true, host: '127.0.0.1', port: 0 },
    memory: {
      enabled: true,
      workspace_path: workspaceDir,
      logs_path: logsDir,
      source_tag: 'tg',
      agent_label: 'Silvana',
      max_hot_bytes: 20480,
      trim_keep_lines: 600,
      buffer_ttl_ms: 5 * 60 * 1000,
      buffer_max_entries: 100,
    },
  }
}

async function startWithMemory(): Promise<{
  h: WebhookServerHandle
  mcp: ReturnType<typeof makeMcpStub>
  writer: MemoryWriter
}> {
  const mcp = makeMcpStub()
  const writer = new MemoryWriter(memCfg(), createLogger('test', {
    stream: { write: () => true } as unknown as NodeJS.WritableStream,
  }))
  const cfg = enabledConfig()
  const h = await startWebhookServer(cfg, {
    mcpServer: mcp.server,
    config: cfg,
    statePaths: paths,
    log: createLogger('test', { stream: { write: () => true } as unknown as NodeJS.WritableStream }),
    memoryWriter: writer,
  })
  if (!h) throw new Error('expected handle')
  handle = h
  return { h, mcp, writer }
}

function url(h: WebhookServerHandle, p: string): string {
  return `http://${h.host}:${h.port}${p}`
}

describe('end-to-end: webhook → MemoryWriter → recent.md + verbose.jsonl', () => {
  test('UserPromptSubmit + Stop produces both files with expected contents', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN

    // Seed a Claude transcript file the Stop hook will reference.
    const transcriptPath = join(workspaceDir, 'session.jsonl')
    writeFileSync(transcriptPath, JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'agent answered the question' }] },
    }) + '\n', 'utf8')

    const { h } = await startWithMemory()

    const submit = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatId: 164795011,
        hook_event_name: 'UserPromptSubmit',
        session_id: 'e2e-sid',
        transcript_path: transcriptPath,
        cwd: workspaceDir,
        prompt: 'end-to-end user prompt',
      }),
    })
    expect(submit.status).toBe(200)

    // verbose.jsonl shouldn't exist yet (UserPromptSubmit only buffers).
    let logsExist = true
    try { readdirSync(logsDir) } catch { logsExist = false }
    expect(logsExist).toBe(false)

    const stop = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatId: 164795011,
        hook_event_name: 'Stop',
        session_id: 'e2e-sid',
        transcript_path: transcriptPath,
        cwd: workspaceDir,
      }),
    })
    expect(stop.status).toBe(200)

    // recent.md
    const hotPath = join(workspaceDir, 'core', 'hot', 'recent.md')
    const hot = readFileSync(hotPath, 'utf8')
    expect(hot).toMatch(/### \d{4}-\d{2}-\d{2} \d{2}:\d{2} \[tg\]/)
    expect(hot).toContain('**User:** end-to-end user prompt\n')
    expect(hot).toContain('**Silvana:** agent answered the question\n')

    // verbose-YYYY-MM-DD.jsonl
    const files = readdirSync(logsDir).filter(f => f.startsWith('verbose-'))
    expect(files.length).toBe(1)
    const v = JSON.parse(readFileSync(join(logsDir, files[0]!), 'utf8').trim())
    expect(v.sid).toBe('e2e-sid')
    expect(v.ch).toBe('tg')
    expect(v.user).toBe('end-to-end user prompt')
    expect(v.agent).toBe('agent answered the question')
    expect(typeof v.dur_ms).toBe('number')
    expect(v.dur_ms).toBeGreaterThanOrEqual(0)
    expect(v.status).toBe('completed')
  })

  test('50 concurrent UserPromptSubmit+Stop turns from different chats: all entries present', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN

    // Allow many chat ids by writing config.json before loadConfig is called
    // for this test. Simpler: override allowed_chat_ids at runtime.
    const cfg = enabledConfig()
    cfg.allowed_chat_ids = Array.from({ length: 50 }, (_, i) => 100000 + i)
    const mcp = makeMcpStub()
    const writer = new MemoryWriter(memCfg(), createLogger('test', {
      stream: { write: () => true } as unknown as NodeJS.WritableStream,
    }))
    const h = await startWebhookServer(cfg, {
      mcpServer: mcp.server,
      config: cfg,
      statePaths: paths,
      log: createLogger('test', { stream: { write: () => true } as unknown as NodeJS.WritableStream }),
      memoryWriter: writer,
    })
    if (!h) throw new Error('expected handle')
    handle = h

    const transcriptPath = join(workspaceDir, 'multi.jsonl')
    writeFileSync(transcriptPath, JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'shared agent answer' }] },
    }) + '\n', 'utf8')

    const N = 50
    const submits = Array.from({ length: N }, (_, i) =>
      fetch(url(h, '/hooks/agent'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${WEBHOOK_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 100000 + i,
          hook_event_name: 'UserPromptSubmit',
          session_id: `sid-${i}`,
          transcript_path: transcriptPath,
          cwd: workspaceDir,
          prompt: `user-prompt-${i.toString().padStart(3, '0')}`,
        }),
      }),
    )
    const submitResults = await Promise.all(submits)
    for (const r of submitResults) expect(r.status).toBe(200)

    const stops = Array.from({ length: N }, (_, i) =>
      fetch(url(h, '/hooks/agent'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${WEBHOOK_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: 100000 + i,
          hook_event_name: 'Stop',
          session_id: `sid-${i}`,
          transcript_path: transcriptPath,
          cwd: workspaceDir,
        }),
      }),
    )
    const stopResults = await Promise.all(stops)
    for (const r of stopResults) expect(r.status).toBe(200)

    // Every user-prompt-NNN must appear in recent.md.
    const hot = readFileSync(join(workspaceDir, 'core', 'hot', 'recent.md'), 'utf8')
    for (let i = 0; i < N; i++) {
      const id = i.toString().padStart(3, '0')
      expect(hot).toContain(`**User:** user-prompt-${id}\n`)
    }
    // And all 50 records must be in the day's verbose file.
    const vFiles = readdirSync(logsDir).filter(f => f.startsWith('verbose-'))
    expect(vFiles.length).toBe(1)
    const lines = readFileSync(join(logsDir, vFiles[0]!), 'utf8').trim().split('\n')
    expect(lines.length).toBe(N)
    const seenSids = new Set<string>()
    for (const ln of lines) {
      const r = JSON.parse(ln)
      seenSids.add(r.sid)
    }
    expect(seenSids.size).toBe(N)
  })

  test('memory.enabled=false on config: writes nothing even with writer wired', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const cfg: AppConfig = {
      ...enabledConfig(),
      memory: {
        enabled: false,
        workspace_path: workspaceDir,
        logs_path: logsDir,
        source_tag: 'tg',
        max_hot_bytes: 20480,
        trim_keep_lines: 600,
        buffer_ttl_ms: 5 * 60 * 1000,
        buffer_max_entries: 100,
      },
    }
    const mcp = makeMcpStub()
    const writer = new MemoryWriter(memCfg(), createLogger('test', {
      stream: { write: () => true } as unknown as NodeJS.WritableStream,
    }))
    const h = await startWebhookServer(cfg, {
      mcpServer: mcp.server,
      config: cfg,
      statePaths: paths,
      log: createLogger('test', { stream: { write: () => true } as unknown as NodeJS.WritableStream }),
      memoryWriter: writer,
    })
    if (!h) throw new Error('expected handle')
    handle = h

    const resp = await fetch(url(h, '/hooks/agent'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${WEBHOOK_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: 164795011,
        hook_event_name: 'Stop',
        session_id: 'sid-x',
        transcript_path: '/tmp/missing.jsonl',
        cwd: workspaceDir,
      }),
    })
    expect(resp.status).toBe(200)

    let hotExists = true
    try { readFileSync(join(workspaceDir, 'core', 'hot', 'recent.md'), 'utf8') } catch { hotExists = false }
    expect(hotExists).toBe(false)
    let logsExist = true
    try { readdirSync(logsDir) } catch { logsExist = false }
    expect(logsExist).toBe(false)
  })
})

