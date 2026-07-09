// Tests for the shared pane-capture primitive: ANSI strip + capture-pane exec
// wrapper + pane-cwd resolution. All driven through the injected exec seam so
// no tmux is required.

import { describe, expect, test } from 'bun:test'
import {
  capturePaneText,
  resolvePaneCwd,
  stripAnsi,
  type TmuxExec,
  type TmuxExecResult,
} from '../../src/status/pane-capture.js'

function recordingExec(result: TmuxExecResult): { exec: TmuxExec; argv: string[][] } {
  const argv: string[][] = []
  const exec: TmuxExec = async (args) => {
    argv.push([...args])
    return result
  }
  return { exec, argv }
}

describe('stripAnsi', () => {
  test('removes CSI colour codes but keeps text + newlines', () => {
    const input = '\x1b[31mred\x1b[0m\nplain\ttab'
    expect(stripAnsi(input)).toBe('red\nplain\ttab')
  })

  test('removes OSC (title) sequences and bare control chars', () => {
    const input = '\x1b]0;title\x07hello\x00world'
    expect(stripAnsi(input)).toBe('helloworld')
  })
})

describe('capturePaneText', () => {
  test('builds the capture-pane argv with socket + line count, strips ANSI', async () => {
    const { exec, argv } = recordingExec({ stdout: '\x1b[1m◼ Task\x1b[0m\n', stderr: '', exitCode: 0 })
    const res = await capturePaneText(exec, {
      paneTarget: 'channel-thrall:0.0',
      socketName: 'sock',
      lineCount: 200,
    })
    expect(res.ok).toBe(true)
    expect(res.text).toBe('◼ Task\n')
    expect(argv[0]).toEqual(['-L', 'sock', 'capture-pane', '-p', '-t', 'channel-thrall:0.0', '-S', '-200'])
  })

  test('omits the -L flag when no socket name', async () => {
    const { exec, argv } = recordingExec({ stdout: 'x', stderr: '', exitCode: 0 })
    await capturePaneText(exec, { paneTarget: 'p', lineCount: 50 })
    expect(argv[0]).toEqual(['capture-pane', '-p', '-t', 'p', '-S', '-50'])
  })

  test('non-zero exit surfaces ok:false with the stderr reason', async () => {
    const { exec } = recordingExec({ stdout: '', stderr: "can't find pane", exitCode: 1 })
    const res = await capturePaneText(exec, { paneTarget: 'gone', lineCount: 10 })
    expect(res.ok).toBe(false)
    expect(res.text).toBe('')
    expect(res.error).toBe("can't find pane")
  })
})

describe('resolvePaneCwd', () => {
  test('returns the trimmed pane_current_path', async () => {
    const { exec, argv } = recordingExec({ stdout: '/home/agent/repo\n', stderr: '', exitCode: 0 })
    const cwd = await resolvePaneCwd(exec, { paneTarget: 'p', lineCount: 1 })
    expect(cwd).toBe('/home/agent/repo')
    expect(argv[0]).toEqual(['display-message', '-p', '-t', 'p', '#{pane_current_path}'])
  })

  test('returns null on a failed display-message (degrade path)', async () => {
    const { exec } = recordingExec({ stdout: '', stderr: 'no server', exitCode: 1 })
    expect(await resolvePaneCwd(exec, { paneTarget: 'p', lineCount: 1 })).toBeNull()
  })

  test('returns null on empty output', async () => {
    const { exec } = recordingExec({ stdout: '\n', stderr: '', exitCode: 0 })
    expect(await resolvePaneCwd(exec, { paneTarget: 'p', lineCount: 1 })).toBeNull()
  })
})
