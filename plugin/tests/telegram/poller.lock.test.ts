// T7 tests: atomic token-lock (bug A in TASK-7).
//
// The legacy acquire() used existsSync -> readFileSync -> writeFileSync,
// which is racy: two competing processes can both observe "no/stale pid"
// and both win the lock. The new implementation uses an exclusive create
// (`openSync` with O_CREAT|O_EXCL) + atomic rename for stale replacement,
// so exactly one acquirer can succeed at a time.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getStatePaths, loadConfig, type AppConfig, type StatePaths } from '../../src/config.js'
import { ensureStateDirs } from '../../src/state/store.js'
import { acquireWithHooks, tokenLock, type AcquireHooks } from '../../src/telegram/poller.js'

const FAKE_TOKEN = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'

let stateDir: string
let paths: StatePaths
let config: AppConfig

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'dashi-channel-poller-lock-'))
  const env = { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_STATE_DIR: stateDir }
  config = loadConfig(env)
  paths = getStatePaths(config, {
    TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    TELEGRAM_STATE_DIR: stateDir,
  })
  ensureStateDirs(paths)
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

describe('tokenLock atomic acquire (TASK-7 bug A)', () => {
  // Concurrent acquire: only one wins. We can't fork two real processes here,
  // but the failure mode is observable in-process: simulate the race by
  // checking that once the lock exists with our live pid, a second acquire()
  // from a hypothetical foreign process (different pid in the file) is
  // refused. We assert both branches: (1) re-acquire from the SAME pid is
  // idempotent (returns true, file unchanged) and (2) any foreign live pid
  // is refused without overwriting the file.
  test('re-acquire from same pid is a no-op success (idempotent)', () => {
    expect(tokenLock.acquire(paths)).toBe(true)
    const after1 = readFileSync(paths.pid, 'utf8').trim()
    expect(after1).toBe(String(process.pid))
    // Second call from the same process: should still return true, file
    // contents unchanged.
    expect(tokenLock.acquire(paths)).toBe(true)
    const after2 = readFileSync(paths.pid, 'utf8').trim()
    expect(after2).toBe(String(process.pid))
  })

  test('two competing creators: exclusive create lets only one win', () => {
    // Simulate the race: first competitor's `openSync(path, 'wx')` succeeds.
    // The second competitor sees EEXIST. Because the file holds our (live)
    // process.pid, acquire() must return true for the owner-pid path but
    // refuse for any foreign live pid.
    expect(tokenLock.acquire(paths)).toBe(true)
    // Manually rewrite the lock with a foreign live pid (our own bun runner
    // is alive) to simulate a competitor's pid sitting in the file.
    const fakeForeign = Bun.spawn({
      cmd: [process.execPath, '-e', 'await new Promise(r=>setTimeout(r,30000))'],
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    try {
      writeFileSync(paths.pid, String(fakeForeign.pid), { mode: 0o600 })
      // Second acquire from a different "process" view: foreign live pid → refuse.
      expect(tokenLock.acquire(paths)).toBe(false)
      // File unchanged.
      const after = Number.parseInt(readFileSync(paths.pid, 'utf8').trim(), 10)
      expect(after).toBe(fakeForeign.pid)
    } finally {
      fakeForeign.kill()
    }
  })

  test('refuses to start when foreign live pid already holds the lock', () => {
    // Spawn a child sleeping long enough for the test.
    const proc = Bun.spawn({
      cmd: [process.execPath, '-e', 'await new Promise(r=>setTimeout(r,30000))'],
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    try {
      writeFileSync(paths.pid, String(proc.pid), { mode: 0o600 })
      expect(tokenLock.acquire(paths)).toBe(false)
      // File untouched.
      const after = Number.parseInt(readFileSync(paths.pid, 'utf8').trim(), 10)
      expect(after).toBe(proc.pid)
    } finally {
      proc.kill()
    }
  })

  test('stale pid (no live process) is atomically replaced — single new pid file written', () => {
    // 999999 is almost certainly dead on any test runner.
    writeFileSync(paths.pid, '999999', { mode: 0o600 })
    expect(tokenLock.acquire(paths)).toBe(true)
    // Exactly one file at the lock path, with our pid.
    expect(existsSync(paths.pid)).toBe(true)
    const written = Number.parseInt(readFileSync(paths.pid, 'utf8').trim(), 10)
    expect(written).toBe(process.pid)
  })

  test('unparseable lock file is treated as stale and replaced', () => {
    // Junk content that fails Number.parseInt.
    writeFileSync(paths.pid, 'corrupted-pid-file', { mode: 0o600 })
    expect(tokenLock.acquire(paths)).toBe(true)
    const written = Number.parseInt(readFileSync(paths.pid, 'utf8').trim(), 10)
    expect(written).toBe(process.pid)
  })

  test('release deletes our own pid file', () => {
    expect(tokenLock.acquire(paths)).toBe(true)
    tokenLock.release(paths)
    expect(existsSync(paths.pid)).toBe(false)
  })

  test('release leaves a foreign pid alone', () => {
    writeFileSync(paths.pid, '999998', { mode: 0o600 })
    tokenLock.release(paths)
    expect(existsSync(paths.pid)).toBe(true)
  })

  test('release on non-existent lock is a no-op (no throw)', () => {
    // Sanity: previous bug used existsSync up-front; new code relies on
    // ENOENT catch. Make sure release() doesn't throw when there is no file.
    expect(existsSync(paths.pid)).toBe(false)
    expect(() => tokenLock.release(paths)).not.toThrow()
  })
})

describe('tokenLock atomic acquire (FIX-B: hard stale-pid race)', () => {
  // Hard race: two processes both observe the SAME stale pid in the lock
  // file at the same time. With the old renameSync(tmp, path) replacement,
  // BOTH would write their tmp file and BOTH renames would succeed (rename
  // overwrites without checking). With unlink + O_EXCL, exactly one wins
  // the create — the other sees EEXIST and must re-inspect.
  //
  // We drive the interleaving deterministically via injected hooks that
  // share a single in-memory filesystem state.
  test('two processes both seeing stale pid: only one acquire() returns true', () => {
    const DEAD_PID = 999_001
    const PID_A = 111_111
    const PID_B = 222_222
    // Shared "filesystem": null = no file; number = pid in file.
    let lockHolder: number | null = DEAD_PID

    // Coordinate the interleave: A unlinks → B unlinks → A creates → B creates.
    // After A's create, the file holds PID_A (live, from B's perspective).
    // B's tryExclusiveCreate must therefore see EEXIST and on the next
    // inspection observe PID_A alive → return false.
    const liveSet = new Set<number>([PID_A, PID_B]) // both "processes" are alive

    const makeHooks = (selfPid: number): AcquireHooks => ({
      tryExclusiveCreate: (_path: string, pid: number): boolean => {
        if (lockHolder !== null) return false // EEXIST behaviour
        lockHolder = pid
        return true
      },
      readPidFile: (_path: string): number => {
        return lockHolder ?? Number.NaN
      },
      unlinkLock: (_path: string): void => {
        // ENOENT is silently swallowed by the real hook; mirror that.
        lockHolder = null
      },
      pidAlive: (pid: number): boolean => liveSet.has(pid),
      selfPid,
    })

    // Interleaving driver: instead of running A→B serially, we orchestrate
    // the exact race window. We do this by wrapping the hooks so that A's
    // unlink fires, then control yields to B which ALSO unlinks (no-op,
    // file already gone), then B creates (wins), then A's create runs
    // (sees EEXIST → re-inspects → sees B's live pid → returns false).
    //
    // We simulate this by running B's acquire from inside A's unlinkLock
    // hook — that is the tightest possible race window for the bug.
    const hooksA = makeHooks(PID_A)
    let bResult: boolean | undefined
    const racingUnlink = hooksA.unlinkLock
    hooksA.unlinkLock = (path: string): void => {
      racingUnlink(path)
      // Re-entrant: B runs its FULL acquire here, while A is mid-flight.
      // After this call returns, A continues with tryExclusiveCreate which
      // MUST now see EEXIST because B claimed the lock.
      const hooksB = makeHooks(PID_B)
      bResult = acquireWithHooks(paths, hooksB)
    }

    const aResult = acquireWithHooks(paths, hooksA)

    // Exactly one winner. With the old renameSync bug both would be true.
    const winners = [aResult, bResult].filter((r) => r === true).length
    expect(winners).toBe(1)
    // B got first into the empty file (after A unlinked) → B wins.
    expect(bResult).toBe(true)
    expect(aResult).toBe(false)
    // Final file holds B's pid (live), not A's.
    expect(lockHolder).toBe(PID_B)
  })

  test('repeated stale collisions bounded by MAX_REPLACE_ATTEMPTS (3) → give up', () => {
    // Pathological case: every time we unlink, a stale-pid competitor
    // races in with another DEAD pid. We must give up after 3 attempts
    // instead of livelocking.
    const DEAD_PIDS = [999_001, 999_002, 999_003, 999_004, 999_005]
    let idx = 0
    let lockHolder: number | null = DEAD_PIDS[idx++]!

    const hooks: AcquireHooks = {
      tryExclusiveCreate: (_path: string, _pid: number): boolean => {
        // Always lose: a competing dead pid lands in the file before us.
        if (lockHolder === null && idx < DEAD_PIDS.length) {
          lockHolder = DEAD_PIDS[idx++]!
        }
        return false
      },
      readPidFile: (_path: string): number => lockHolder ?? Number.NaN,
      unlinkLock: (_path: string): void => {
        lockHolder = null
      },
      pidAlive: (_pid: number): boolean => false, // all dead → keep retrying
      selfPid: 333_333,
    }

    const result = acquireWithHooks(paths, hooks)
    expect(result).toBe(false)
  })
})
