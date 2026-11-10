// Process-group termination for the status command runner (B2), against fakes:
// injected spawn / kill / timer seams, no real processes.

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, test } from 'bun:test'

import * as runnerModule from '../../src/status/status-widget-runner.js'
import type { CommandResult } from '../../src/status/status-widget-runner.js'

const PID = 4242
const OPTS = { timeoutMs: 5000, maxStdoutBytes: 1024 }

interface FakeTimer {
  fn: () => void
  ms: number
  cleared: boolean
  fired: boolean
}

function makeFake(opts: { kill?: (pid: number, signal: string) => void } = {}) {
  const child = Object.assign(new EventEmitter(), { pid: PID as number | undefined, stdout: new PassThrough() })
  const spawned: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = []
  const kills: Array<{ pid: number; signal: string }> = []
  const timers: FakeTimer[] = []
  const factory = (runnerModule as unknown as {
    createStatusCommandRunner: (seams: Record<string, unknown>) => runnerModule.CommandRunner
  }).createStatusCommandRunner
  const runner = factory({
    spawn: (file: string, args: string[], options: Record<string, unknown>) => {
      spawned.push({ file, args, options })
      return child
    },
    kill: (pid: number, signal: string) => {
      kills.push({ pid, signal })
      opts.kill?.(pid, signal)
    },
    setTimer: (fn: () => void, ms: number) => {
      const t: FakeTimer = { fn, ms, cleared: false, fired: false }
      timers.push(t)
      return t
    },
    clearTimer: (h: unknown) => {
      ;(h as FakeTimer).cleared = true
    },
  })
  const fireTimer = (t: FakeTimer | undefined): void => {
    if (!t || t.cleared || t.fired) return
    t.fired = true
    t.fn()
  }
  const track = (p: Promise<CommandResult>): { result: () => CommandResult | undefined; count: () => number } => {
    let result: CommandResult | undefined
    let count = 0
    void p.then((r) => {
      result = r
      count += 1
    })
    return { result: () => result, count: () => count }
  }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  return { child, spawned, kills, timers, runner, fireTimer, track, flush }
}

const ESRCH = (): never => {
  throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
}

describe('runner: the command gets its own process group', () => {
  test('spawn is detached, shell-less, with the same stdio as before', async () => {
    const f = makeFake()
    const p = f.track(f.runner(['cmd', 'a'], OPTS))
    expect(f.spawned).toHaveLength(1)
    expect(f.spawned[0]!.file).toBe('cmd')
    expect(f.spawned[0]!.options.detached).toBe(true)
    expect(f.spawned[0]!.options.shell).toBe(false)
    expect(f.spawned[0]!.options.stdio).toEqual(['ignore', 'pipe', 'ignore'])
    f.child.emit('close', 0)
    await f.flush()
    expect(p.result()).toEqual({ ok: true, stdout: '' })
  })
})

describe('runner: one termination routine for timeout, overflow and abort', () => {
  test('timeout: SIGTERM to the negative pid, SIGKILL 200 ms later, resolve after close', async () => {
    const f = makeFake()
    const p = f.track(f.runner(['cmd'], OPTS))
    expect(f.timers[0]!.ms).toBe(5000)
    f.fireTimer(f.timers[0])
    expect(f.kills).toEqual([{ pid: -PID, signal: 'SIGTERM' }])
    const grace = f.timers[1]!
    expect(grace.ms).toBe(200)
    f.fireTimer(grace)
    expect(f.kills).toEqual([
      { pid: -PID, signal: 'SIGTERM' },
      { pid: -PID, signal: 'SIGKILL' },
    ])
    f.child.emit('close', null)
    await f.flush()
    expect(p.result()).toEqual({ ok: false, reason: 'timeout' })
  })

  test('output overflow: group terminated, stdout destroyed, reason too_large', async () => {
    const f = makeFake()
    const p = f.track(f.runner(['cmd'], OPTS))
    f.child.stdout.emit('data', Buffer.alloc(2048))
    expect(f.kills).toEqual([{ pid: -PID, signal: 'SIGTERM' }])
    expect(f.child.stdout.destroyed).toBe(true)
    f.fireTimer(f.timers.find((t) => t.ms === 200))
    f.child.emit('close', null)
    await f.flush()
    expect(p.result()).toEqual({ ok: false, reason: 'too_large' })
  })

  test('abort signal: same routine, reason aborted', async () => {
    const f = makeFake()
    const ac = new AbortController()
    const p = f.track(f.runner(['cmd'], { ...OPTS, signal: ac.signal } as never))
    ac.abort()
    expect(f.kills).toEqual([{ pid: -PID, signal: 'SIGTERM' }])
    f.fireTimer(f.timers.find((t) => t.ms === 200))
    f.child.emit('close', null)
    await f.flush()
    expect(p.result()).toEqual({ ok: false, reason: 'aborted' })
  })

  test('an already aborted signal never spawns', async () => {
    const f = makeFake()
    const ac = new AbortController()
    ac.abort()
    const res = await f.runner(['cmd'], { ...OPTS, signal: ac.signal } as never)
    expect(res).toEqual({ ok: false, reason: 'aborted' })
    expect(f.spawned).toHaveLength(0)
  })
})

describe('runner: the leader going first does not end the cleanup', () => {
  test('leader closes between TERM and KILL: the descendant group still receives KILL', async () => {
    const f = makeFake()
    const p = f.track(f.runner(['cmd'], OPTS))
    f.fireTimer(f.timers[0])
    f.child.emit('close', null)
    await f.flush()
    expect(p.result()).toBeUndefined() // not resolved before the escalation
    f.fireTimer(f.timers.find((t) => t.ms === 200))
    await f.flush()
    expect(f.kills.map((k) => k.signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(p.result()).toEqual({ ok: false, reason: 'timeout' })
  })

  test('the result waits for the direct child to close, with stdout destroyed', async () => {
    const f = makeFake()
    const p = f.track(f.runner(['cmd'], OPTS))
    f.fireTimer(f.timers[0])
    f.fireTimer(f.timers.find((t) => t.ms === 200))
    await f.flush()
    expect(f.kills).toHaveLength(2)
    expect(f.child.stdout.destroyed).toBe(true)
    expect(p.result()).toBeUndefined()
    f.child.emit('close', null)
    await f.flush()
    expect(p.result()).toEqual({ ok: false, reason: 'timeout' })
  })

  test('a leader that exits normally still gets its group swept', async () => {
    const f = makeFake()
    const p = f.track(f.runner(['cmd'], OPTS))
    f.child.stdout.emit('data', Buffer.from('{"l":"ok"}'))
    f.child.emit('close', 0)
    await f.flush()
    expect(f.kills).toEqual([{ pid: -PID, signal: 'SIGKILL' }])
    expect(p.result()).toEqual({ ok: true, stdout: '{"l":"ok"}' })
  })
})

describe('runner: races and signalling failures', () => {
  test('abort + timeout + close together: one result, no timer left armed', async () => {
    const f = makeFake({ kill: ESRCH })
    const ac = new AbortController()
    const p = f.track(f.runner(['cmd'], { ...OPTS, signal: ac.signal } as never))
    ac.abort()
    f.fireTimer(f.timers[0]) // the timeout timer was cleared by the abort: must be a no-op
    f.child.emit('close', null)
    f.fireTimer(f.timers.find((t) => t.ms === 200))
    f.child.emit('close', null)
    await f.flush()
    expect(p.count()).toBe(1)
    expect(p.result()).toEqual({ ok: false, reason: 'aborted' })
    expect(f.timers.every((t) => t.cleared || t.fired)).toBe(true)
  })

  test('ESRCH (the group is already gone) is not a failure', async () => {
    const f = makeFake({ kill: ESRCH })
    const p = f.track(f.runner(['cmd'], OPTS))
    f.fireTimer(f.timers[0])
    f.fireTimer(f.timers.find((t) => t.ms === 200))
    f.child.emit('close', null)
    await f.flush()
    expect(p.result()).toEqual({ ok: false, reason: 'timeout' })
  })

  test('another signalling failure is reported as cleanup', async () => {
    const f = makeFake({
      kill: () => {
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      },
    })
    const p = f.track(f.runner(['cmd'], OPTS))
    f.fireTimer(f.timers[0])
    f.fireTimer(f.timers.find((t) => t.ms === 200))
    f.child.emit('close', null)
    await f.flush()
    expect(p.result()).toEqual({ ok: false, reason: 'cleanup' })
  })

  test('a spawn error resolves as spawn and signals nothing', async () => {
    const f = makeFake()
    f.child.pid = undefined
    const p = f.track(f.runner(['cmd'], OPTS))
    f.child.emit('error', Object.assign(new Error('spawn cmd ENOENT'), { code: 'ENOENT' }))
    f.child.emit('close', -2)
    await f.flush()
    expect(p.result()).toEqual({ ok: false, reason: 'spawn' })
    expect(f.kills).toHaveLength(0)
  })
})
