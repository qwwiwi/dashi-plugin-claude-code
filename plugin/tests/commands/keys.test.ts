import { describe, expect, test } from 'bun:test'

import {
  MAX_KEY_TOKENS,
  parseKeyTokens,
  parseCcCommand,
  sendKeys,
  sendSlashCommand,
  type KeysExec,
} from '../../src/commands/keys.js'

describe('parseKeyTokens', () => {
  test('digits and named keys parse into steps', () => {
    const r = parseKeyTokens('2')
    expect('steps' in r && r.steps).toEqual([{ literal: true, key: '2' }])
    const r2 = parseKeyTokens('1 enter')
    expect('steps' in r2 && r2.steps).toEqual([
      { literal: true, key: '1' },
      { literal: false, key: 'Enter' },
    ])
    const r3 = parseKeyTokens('ESC')
    expect('steps' in r3 && r3.steps).toEqual([{ literal: false, key: 'Escape' }])
  })

  test('empty args -> usage error', () => {
    const r = parseKeyTokens('   ')
    expect('error' in r && r.error).toContain('usage')
  })

  test('arbitrary text is rejected (no shell injection surface)', () => {
    for (const bad of ['rm', 'a', '11', 'C-c', '$(reboot)', '1;rm', 'ls -la']) {
      const r = parseKeyTokens(bad)
      expect('error' in r).toBe(true)
    }
  })

  test('token count is capped', () => {
    const r = parseKeyTokens(Array(MAX_KEY_TOKENS + 1).fill('1').join(' '))
    expect('error' in r && r.error).toContain('максимум')
  })
})

describe('sendKeys', () => {
  function capture(): { calls: string[][]; exec: KeysExec } {
    const calls: string[][] = []
    const exec: KeysExec = async (args) => {
      calls.push([...args])
      return { exitCode: 0, stderr: '' }
    }
    return { calls, exec }
  }

  test('literal step uses -l, named step does not', async () => {
    const { calls, exec } = capture()
    const parsed = parseKeyTokens('2 enter')
    if ('error' in parsed) throw new Error('parse failed')
    const res = await sendKeys({ paneTarget: '%5', socketPath: '/tmp/sock' }, parsed, exec)
    expect(res.ok).toBe(true)
    expect(calls).toEqual([
      ['-S', '/tmp/sock', 'send-keys', '-t', '%5', '-l', '2'],
      ['-S', '/tmp/sock', 'send-keys', '-t', '%5', 'Enter'],
    ])
  })

  test('socketName uses -L; no socket flags when neither set', async () => {
    const { calls, exec } = capture()
    const parsed = parseKeyTokens('y')
    if ('error' in parsed) throw new Error('parse failed')
    await sendKeys({ paneTarget: 'sess:0.0', socketName: 'channel-x' }, parsed, exec)
    expect(calls[0]).toEqual(['-L', 'channel-x', 'send-keys', '-t', 'sess:0.0', '-l', 'y'])

    const second = capture()
    await sendKeys({ paneTarget: 'sess:0.0' }, parsed, second.exec)
    expect(second.calls[0]).toEqual(['send-keys', '-t', 'sess:0.0', '-l', 'y'])
  })

  test('stops on first tmux failure and reports stderr', async () => {
    const calls: string[][] = []
    const exec: KeysExec = async (args) => {
      calls.push([...args])
      return { exitCode: 1, stderr: 'no such pane' }
    }
    const parsed = parseKeyTokens('1 enter')
    if ('error' in parsed) throw new Error('parse failed')
    const res = await sendKeys({ paneTarget: '%9' }, parsed, exec)
    expect(res.ok).toBe(false)
    expect(!res.ok && res.error).toContain('no such pane')
    expect(calls.length).toBe(1) // second step never attempted
  })
})

describe('parseCcCommand', () => {
  test('name only and name+args parse', () => {
    const r = parseCcCommand('compact')
    expect('name' in r && r.name).toBe('compact')
    const r2 = parseCcCommand('model opus')
    expect('name' in r2 && r2.name).toBe('model')
    expect('name' in r2 && r2.rest).toBe('opus')
    // leading slash is tolerated
    const r3 = parseCcCommand('/context')
    expect('name' in r3 && r3.name).toBe('context')
    // namespaced skill command
    const r4 = parseCcCommand('superpowers:brainstorm')
    expect('name' in r4 && r4.name).toBe('superpowers:brainstorm')
  })

  test('shell metacharacters in args are rejected', () => {
    for (const bad of ['model $(reboot)', 'x; rm -rf /', 'a | sh', 'a `id`', 'a && b', 'a > /etc/x', "a'b", 'a"b', 'a\\b']) {
      const r = parseCcCommand(bad)
      expect('error' in r).toBe(true)
    }
  })

  test('bad command names rejected', () => {
    for (const bad of ['', '1abc', '-x', 'A'.repeat(50), 'a!b', 'имя']) {
      const r = parseCcCommand(bad)
      expect('error' in r).toBe(true)
    }
  })
})

describe('sendSlashCommand', () => {
  test('clears line, types literal starting with /, submits Enter', async () => {
    const calls: string[][] = []
    const exec = async (args: readonly string[]) => {
      calls.push([...args])
      return { exitCode: 0, stderr: '' }
    }
    const r = await sendSlashCommand({ paneTarget: '%2', socketPath: '/tmp/s' }, { name: 'compact', rest: '' }, exec)
    expect(r.ok).toBe(true)
    expect(calls).toEqual([
      ['-S', '/tmp/s', 'send-keys', '-t', '%2', 'C-u'],
      ['-S', '/tmp/s', 'send-keys', '-t', '%2', '-l', '/compact'],
      ['-S', '/tmp/s', 'send-keys', '-t', '%2', 'Enter'],
    ])
    // literal always begins with '/', never a leading dash → no tmux flag risk
    expect(calls[1]![6]!.startsWith('/')).toBe(true)
  })

  test('args are appended after a space', async () => {
    const calls: string[][] = []
    const exec = async (args: readonly string[]) => { calls.push([...args]); return { exitCode: 0, stderr: '' } }
    await sendSlashCommand({ paneTarget: '%2' }, { name: 'model', rest: 'opus' }, exec)
    expect(calls[1]).toEqual(['send-keys', '-t', '%2', '-l', '/model opus'])
  })
})

import { sendNamedKey } from '../../src/commands/keys.js'
describe('sendNamedKey', () => {
  test('sends a single named key', async () => {
    const calls: string[][] = []
    const exec = async (args: readonly string[]) => { calls.push([...args]); return { exitCode: 0, stderr: '' } }
    const r = await sendNamedKey({ paneTarget: '%3', socketName: 'sk' }, 'Escape', exec)
    expect(r.ok).toBe(true)
    expect(calls).toEqual([['-L', 'sk', 'send-keys', '-t', '%3', 'Escape']])
  })
})

describe('parseCcCommand newline guard', () => {
  test('any carriage return or newline is rejected', () => {
    for (const bad of ['compact\n; rm', 'compact\nrm -rf /', 'a\rb', 'model\nopus']) {
      const r = parseCcCommand(bad)
      expect('error' in r).toBe(true)
    }
  })
})
