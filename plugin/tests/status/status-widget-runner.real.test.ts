// Real Linux descendant cleanup (B2): a leader spawns a grandchild in the same
// process group; the runner must take BOTH down on timeout, abort and output
// overflow, and sweep a surviving grandchild when the leader exits normally.
//
// Readiness handshake: the grandchild publishes its pid, then the leader
// publishes its own; the test polls (bounded) for both files. No fixed sleeps.
// The test only signals processes it spawned itself (cleanup in afterEach).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runStatusCommand } from '../../src/status/status-widget-runner.js'

const LINUX = process.platform === 'linux'
const NODE = process.execPath

let dir: string
const seenPids: number[] = []

const GRANDCHILD = `
import { renameSync, writeFileSync } from 'node:fs'
const dir = process.argv[2]
writeFileSync(dir + '/gc.tmp', String(process.pid))
renameSync(dir + '/gc.tmp', dir + '/gc.pid')
setInterval(() => {}, 1000)
`

const LEADER = `
import { spawn } from 'node:child_process'
import { existsSync, renameSync, writeFileSync } from 'node:fs'
const dir = process.argv[2]
const mode = process.argv[3]
spawn(process.execPath, [dir + '/grandchild.mjs', dir], { stdio: 'ignore' })
const poll = setInterval(() => {
  if (!existsSync(dir + '/gc.pid')) return
  clearInterval(poll)
  writeFileSync(dir + '/leader.tmp', String(process.pid))
  renameSync(dir + '/leader.tmp', dir + '/leader.pid')
  if (mode === 'overflow') process.stdout.write('x'.repeat(100000))
  if (mode === 'exit') {
    process.stdout.write('{"l":"ok"}')
    process.exit(0)
  }
  setInterval(() => {}, 1000)
}, 10)
`

function readPid(name: string): number | undefined {
  const file = join(dir, name)
  if (!existsSync(file)) return undefined
  const n = Number.parseInt(readFileSync(file, 'utf8'), 10)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

function isGone(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // «pid (comm) S ...»: a zombie is dead, only waiting to be reaped by init.
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
    return state === 'Z' || state === 'X'
  } catch {
    return true
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return cond()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dashi-runner-real-'))
  writeFileSync(join(dir, 'grandchild.mjs'), GRANDCHILD)
  writeFileSync(join(dir, 'leader.mjs'), LEADER)
  seenPids.length = 0
})

afterEach(() => {
  for (const name of ['gc.pid', 'leader.pid']) {
    const pid = readPid(name)
    if (pid !== undefined) seenPids.push(pid)
  }
  for (const pid of seenPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

async function bothReady(): Promise<{ leader: number; gc: number }> {
  expect(await waitFor(() => readPid('gc.pid') !== undefined && readPid('leader.pid') !== undefined, 2500)).toBe(true)
  return { leader: readPid('leader.pid')!, gc: readPid('gc.pid')! }
}

async function expectBothGone(pids: { leader: number; gc: number }): Promise<void> {
  expect(await waitFor(() => isGone(pids.leader), 4000)).toBe(true)
  expect(await waitFor(() => isGone(pids.gc), 4000)).toBe(true)
}

describe.skipIf(!LINUX)('runner: real descendant cleanup', () => {
  test('timeout takes the leader AND its grandchild down', async () => {
    const run = runStatusCommand([NODE, join(dir, 'leader.mjs'), dir, 'hang'], { timeoutMs: 3500, maxStdoutBytes: 4096 })
    const pids = await bothReady()
    const res = await run
    expect(res).toEqual({ ok: false, reason: 'timeout' })
    await expectBothGone(pids)
  }, 20_000)

  test('abort takes the leader AND its grandchild down', async () => {
    const ac = new AbortController()
    const run = runStatusCommand([NODE, join(dir, 'leader.mjs'), dir, 'hang'], {
      timeoutMs: 8000,
      maxStdoutBytes: 4096,
      signal: ac.signal,
    } as never)
    const pids = await bothReady()
    ac.abort()
    const res = await run
    expect(res).toEqual({ ok: false, reason: 'aborted' })
    await expectBothGone(pids)
  }, 20_000)

  test('output overflow takes the leader AND its grandchild down', async () => {
    const run = runStatusCommand([NODE, join(dir, 'leader.mjs'), dir, 'overflow'], { timeoutMs: 8000, maxStdoutBytes: 2048 })
    const res = await run
    expect(res).toEqual({ ok: false, reason: 'too_large' })
    const pids = await bothReady()
    await expectBothGone(pids)
  }, 20_000)

  test('a leader that exits normally does not leave its grandchild behind', async () => {
    const run = runStatusCommand([NODE, join(dir, 'leader.mjs'), dir, 'exit'], { timeoutMs: 8000, maxStdoutBytes: 4096 })
    const res = await run
    expect(res).toEqual({ ok: true, stdout: '{"l":"ok"}' })
    const pids = await bothReady()
    await expectBothGone(pids)
  }, 20_000)
})
