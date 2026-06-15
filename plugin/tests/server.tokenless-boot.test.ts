//
// Главный критерий webhook-only: при DASHI_WEBHOOK_ONLY=1 и БЕЗ
// TELEGRAM_BOT_TOKEN сервер стартует, открывает webhook-порт, логирует
// "webhook server listening", и НЕ кидает uncaught exception (Zod/new Bot).
// Spawn'им src/server.ts как subprocess (как реальный MCP-запуск), держим
// stdin открытым (tail-подобно), читаем stdout+stderr.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let proc: ReturnType<typeof Bun.spawn> | undefined
let stateDir = ''

afterEach(() => {
  proc?.kill()
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
})

async function drain(stream: ReadableStream<Uint8Array>, sink: { text: string }): Promise<void> {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      sink.text += dec.decode(value)
    }
  } catch {
    // stream closed on kill — fine
  } finally {
    reader.releaseLock()
  }
}

describe('webhook-only tokenless boot', () => {
  test('server starts WITHOUT a bot token and opens the webhook port', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'dashi-tokenless-'))
    const PORT = '9176' // заведомо свободный в тесте
    const configFile = join(stateDir, 'config.json')
    writeFileSync(configFile, JSON.stringify({ webhook: { enabled: true } }))

    // env БЕЗ TELEGRAM_BOT_TOKEN (undefined, не ''): удаляем из копии process.env.
    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    delete env.TELEGRAM_BOT_TOKEN
    Object.assign(env, {
      DASHI_WEBHOOK_ONLY: '1',
      TELEGRAM_WEBHOOK_HOST: '127.0.0.1',
      TELEGRAM_WEBHOOK_PORT: PORT,
      TELEGRAM_WEBHOOK_TOKEN: 'test-webhook-secret',
      TELEGRAM_STATE_DIR: join(stateDir, 'state'),
      TELEGRAM_CONFIG_FILE: configFile,
      TELEGRAM_WORKSPACE_ROOT: join(stateDir, 'ws'),
      TELEGRAM_ALLOWED_CHAT_IDS: '292142498',
    })

    proc = Bun.spawn(['bun', 'run', 'src/server.ts'], {
      cwd: process.cwd(),
      stdin: 'pipe', // держим открытым — MCP stdio transport не закроется по EOF
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    })

    const sink = { text: '' }
    void drain(proc.stdout as ReadableStream<Uint8Array>, sink)
    void drain(proc.stderr as ReadableStream<Uint8Array>, sink)

    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (sink.text.includes('webhook server listening')) break
      if (sink.text.includes('uncaught exception')) break
      await new Promise((r) => setTimeout(r, 100))
    }

    expect(sink.text).toContain('webhook server listening')
    expect(sink.text).not.toContain('uncaught exception')
    // Подтверждаем, что webhook-only режим действительно активен (не реальный бот).
    expect(sink.text).toContain('webhook-only')

    // Порт реально слушает — TCP connect.
    const sock = await Bun.connect({
      hostname: '127.0.0.1',
      port: Number(PORT),
      socket: { data() {} },
    })
    expect(sock).toBeTruthy()
    sock.end()
  }, 20_000)
})
