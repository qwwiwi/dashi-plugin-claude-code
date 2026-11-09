// The real command runner: argv without a shell, timeout, stdout cap.
// Spawns the current runtime itself (no external tools, no network).

import { describe, expect, test } from 'bun:test'

import { runStatusCommand } from '../../src/status/status-widget-runner.js'

const NODE = process.execPath

describe('runStatusCommand', () => {
  test('returns stdout of a successful command', async () => {
    const res = await runStatusCommand([NODE, '-e', 'process.stdout.write("{\\"l\\":\\"ok\\"}")'], {
      timeoutMs: 10_000,
      maxStdoutBytes: 4096,
    })
    expect(res).toEqual({ ok: true, stdout: '{"l":"ok"}' })
  })

  test('runs WITHOUT a shell: metacharacters are plain arguments', async () => {
    const res = await runStatusCommand(
      [NODE, '-e', 'process.stdout.write(process.argv[1])', '$(echo injected); echo x'],
      { timeoutMs: 10_000, maxStdoutBytes: 4096 },
    )
    expect(res).toEqual({ ok: true, stdout: '$(echo injected); echo x' })
  })

  test('non-zero exit is a failure', async () => {
    const res = await runStatusCommand([NODE, '-e', 'process.exit(3)'], { timeoutMs: 10_000, maxStdoutBytes: 4096 })
    expect(res).toEqual({ ok: false, reason: 'exit' })
  })

  test('a missing binary is a spawn failure, not a throw', async () => {
    const res = await runStatusCommand(['/nonexistent/status-binary-xyz'], { timeoutMs: 10_000, maxStdoutBytes: 4096 })
    expect(res).toEqual({ ok: false, reason: 'spawn' })
  })

  test('stdout over the cap is refused and the process stops', async () => {
    const res = await runStatusCommand(
      [NODE, '-e', 'process.stdout.write("x".repeat(100000)); setInterval(()=>{},1000)'],
      { timeoutMs: 10_000, maxStdoutBytes: 2048 },
    )
    expect(res).toEqual({ ok: false, reason: 'too_large' })
  })

  test('a hanging command is killed at the timeout', async () => {
    const res = await runStatusCommand([NODE, '-e', 'setInterval(()=>{},1000)'], { timeoutMs: 300, maxStdoutBytes: 4096 })
    expect(res).toEqual({ ok: false, reason: 'timeout' })
  })

  test('secret-looking environment variables are not passed to the command', async () => {
    process.env.STATUS_WIDGET_TEST_TOKEN = 'must-not-leak'
    process.env.STATUS_WIDGET_TEST_PLAIN = 'visible'
    try {
      const res = await runStatusCommand(
        [NODE, '-e', 'process.stdout.write(JSON.stringify([process.env.STATUS_WIDGET_TEST_TOKEN ?? null, process.env.STATUS_WIDGET_TEST_PLAIN ?? null]))'],
        { timeoutMs: 10_000, maxStdoutBytes: 4096 },
      )
      expect(res).toEqual({ ok: true, stdout: '[null,"visible"]' })
    } finally {
      delete process.env.STATUS_WIDGET_TEST_TOKEN
      delete process.env.STATUS_WIDGET_TEST_PLAIN
    }
  })
})
