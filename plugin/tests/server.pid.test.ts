// TASK-8 / HIGH #10 tests: bootstrap PID handling refuses to start when
// the bot.pid lock is held by a live process and NEVER sends a signal
// to the holder. Also pins the unhandled-rejection redaction pipeline
// added alongside (HIGH #11): the crash handlers must redact
// caller-supplied exact-substring secrets (webhook token, Groq key) in
// addition to the pattern-based redactor.
//
// We cannot import `src/server.ts` directly — it is a binary entry
// point with side effects (spawns Telegram client, MCP, watchdog). So
// we exercise the same units server.ts wires together:
//   1. `pid-inspect.ts` (describePidHolder, readLockHolder, readProcCmdline)
//   2. `poller.ts` (tokenLock — the contract server.ts respects)
//   3. `redactToken` from config.ts with the same `apiSecrets` list
//
// The bootstrap refuse-to-start scenario is reconstructed by:
//   - writing a live foreign PID into bot.pid
//   - calling tokenLock.acquire(paths) → expect false
//   - calling describePidHolder(pid) → expect the cmdline enrichment
//   - confirming no signal was sent (the holder still runs)

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getStatePaths, loadConfig, redactToken, type StatePaths } from '../src/config.js'
import { ensureStateDirs } from '../src/state/store.js'
import { tokenLock } from '../src/telegram/poller.js'
import {
  describePidHolder,
  readLockHolder,
  readProcCmdline,
} from '../src/telegram/pid-inspect.js'

const FAKE_TOKEN = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'

let stateDir: string
let paths: StatePaths

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'dashi-channel-pid-'))
  const env = { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_STATE_DIR: stateDir }
  const cfg = loadConfig(env)
  paths = getStatePaths(cfg, {
    TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    TELEGRAM_STATE_DIR: stateDir,
  })
  ensureStateDirs(paths)
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────
// pid-inspect helpers
// ─────────────────────────────────────────────────────────────────────

describe('readLockHolder', () => {
  test('returns undefined when bot.pid is missing', () => {
    expect(readLockHolder(paths.pid)).toBeUndefined()
  })

  test('returns undefined for empty pid file', () => {
    writeFileSync(paths.pid, '', { mode: 0o600 })
    expect(readLockHolder(paths.pid)).toBeUndefined()
  })

  test('returns undefined for garbage content', () => {
    writeFileSync(paths.pid, 'not-a-number', { mode: 0o600 })
    expect(readLockHolder(paths.pid)).toBeUndefined()
  })

  test('returns undefined for non-positive pid', () => {
    writeFileSync(paths.pid, '0', { mode: 0o600 })
    expect(readLockHolder(paths.pid)).toBeUndefined()
    writeFileSync(paths.pid, '1', { mode: 0o600 })
    expect(readLockHolder(paths.pid)).toBeUndefined()
    writeFileSync(paths.pid, '-5', { mode: 0o600 })
    expect(readLockHolder(paths.pid)).toBeUndefined()
  })

  test('parses a valid pid', () => {
    writeFileSync(paths.pid, '12345\n', { mode: 0o600 })
    expect(readLockHolder(paths.pid)).toBe(12345)
  })
})

describe('readProcCmdline', () => {
  test('returns undefined for invalid pid', () => {
    expect(readProcCmdline(0)).toBeUndefined()
    expect(readProcCmdline(1)).toBeUndefined()
    expect(readProcCmdline(NaN)).toBeUndefined()
  })

  test('returns own basename on Linux, undefined elsewhere', () => {
    const own = readProcCmdline(process.pid)
    if (process.platform === 'linux') {
      expect(own).toBeDefined()
      // FIX-G / M2: post-fix the helper returns ONLY the basename of
      // argv[0] (the executable's last path segment), never argv[1+].
      // We assert the string is non-empty AND has no slash AND has no
      // spaces — those are the invariants the basename contract
      // guarantees and the security boundary depends on.
      const value = own ?? ''
      expect(value.length).toBeGreaterThan(0)
      expect(value).not.toContain('/')
      expect(value).not.toContain(' ')
    } else {
      expect(own).toBeUndefined()
    }
  })

  test('returns undefined for a pid that does not exist', () => {
    // 999999 is past most default PID ranges on macOS/Linux test
    // runners — /proc/999999/cmdline will be missing.
    expect(readProcCmdline(999999)).toBeUndefined()
  })
})

describe('describePidHolder', () => {
  test('falls back to bare pid for invalid input', () => {
    expect(describePidHolder(0)).toContain('invalid')
    expect(describePidHolder(1)).toContain('invalid')
  })

  test('includes pid=N for any positive integer', () => {
    expect(describePidHolder(42)).toContain('pid=42')
  })

  test('includes executable basename on Linux for a live pid', () => {
    if (process.platform !== 'linux') return
    const out = describePidHolder(process.pid)
    expect(out).toContain(`pid=${process.pid}`)
    // FIX-G / M2: shape is `pid=N (executable: <basename>)`. The
    // legacy `cmdline:` token (which used to ship the full argv
    // including `--api-key SECRET`) MUST NOT appear anywhere.
    expect(out).toContain('executable:')
    expect(out).not.toContain('cmdline:')
  })

  test('returns bare pid=N when /proc entry is missing', () => {
    if (process.platform !== 'linux') return
    // 999999 is almost certainly not running on a test runner.
    const out = describePidHolder(999999)
    expect(out).toBe('pid=999999')
    expect(out).not.toContain('executable:')
    expect(out).not.toContain('cmdline:')
  })
})

// ─────────────────────────────────────────────────────────────────────
// FIX-G / M2 (Codex review 2026-05-27 server #3): describePidHolder
// must not leak `--api-key SECRET` style argv values into the log line
// even when bot.pid points at an unrelated process whose argv contains
// secrets. We can't synthesize a fake /proc entry, so we spawn a real
// process with a secret in argv and assert the description contains
// only the executable basename.
// ─────────────────────────────────────────────────────────────────────

describe('describePidHolder — argv leak guard (FIX-G / M2)', () => {
  test('returns only basename, never argv values, for a process with --api-key in argv', async () => {
    if (process.platform !== 'linux') return
    // Spawn a long-lived node process with secret-looking argv. We
    // pass `--` before `--api-key` so node passes the rest through
    // to process.argv rather than rejecting it as an unknown flag —
    // the result is a real process whose /proc/<pid>/cmdline contains
    // a `--api-key SECRET` pair, exactly what a real misbehaving
    // service might expose if its pid file ended up in our lock slot.
    const secret = 'SECRET_TOKEN_THAT_MUST_NOT_LEAK_12345'
    const nodePath = '/usr/bin/node'
    // Skip silently when /usr/bin/node is unavailable (some CI
    // images ship only bun) — the test runtime needs a real
    // long-lived process whose /proc/<pid>/cmdline carries the
    // simulated secret in argv[1+].
    try {
      readFileSync(nodePath)
    } catch {
      return
    }
    const proc = Bun.spawn({
      cmd: [
        nodePath,
        '-e',
        'setTimeout(()=>{}, 30000)',
        '--',
        '--api-key',
        secret,
      ],
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    try {
      // Give the kernel a beat to populate /proc/<pid>/cmdline.
      await new Promise((r) => setTimeout(r, 100))
      const out = describePidHolder(proc.pid)
      // Invariants the security boundary depends on:
      expect(out).toContain(`pid=${proc.pid}`)
      expect(out).toContain('executable:')
      // No argv values past index 0 may surface — the secret and the
      // `--api-key` flag must both be absent.
      expect(out).not.toContain(secret)
      expect(out).not.toContain('--api-key')
      // The basename should be `node`, NEVER the full install path.
      // We assert the absence of a slash to pin that and verify it
      // matches the expected executable name.
      const match = out.match(/executable:\s+(\S+)\)/)
      expect(match).not.toBeNull()
      const exe = match?.[1] ?? ''
      expect(exe).not.toContain('/')
      expect(exe).not.toContain(' ')
      expect(exe).toBe('node')
    } finally {
      proc.kill()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// Bootstrap refuse-to-start contract: live PID in bot.pid =>
// tokenLock.acquire returns false, no signal is sent to the holder.
// This pins the contract server.ts depends on after the SIGTERM path
// was removed (TASK-8).
// ─────────────────────────────────────────────────────────────────────

describe('bootstrap refuse-to-start (TASK-8)', () => {
  test('live PID in bot.pid => tokenLock.acquire returns false; holder unharmed', async () => {
    // Spawn a child that sleeps long enough for us to test against
    // its pid without depending on `bun` being on PATH.
    const proc = Bun.spawn({
      cmd: [process.execPath, '-e', 'await new Promise(r=>setTimeout(r,30000))'],
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    try {
      writeFileSync(paths.pid, String(proc.pid), { mode: 0o600 })

      // Lock contract: refuse-to-start on live foreign PID.
      const ok = tokenLock.acquire(paths)
      expect(ok).toBe(false)

      // The lock file MUST be untouched — server.ts no longer
      // overwrites or removes it from bootstrap.
      const after = Number.parseInt(readFileSync(paths.pid, 'utf8').trim(), 10)
      expect(after).toBe(proc.pid)

      // Enrichment helpers — what server.ts would log on refuse.
      const holderPid = readLockHolder(paths.pid)
      expect(holderPid).toBe(proc.pid)
      const description = describePidHolder(proc.pid)
      expect(description).toContain(`pid=${proc.pid}`)

      // The holder MUST still be alive — server.ts must NOT send any
      // signal during bootstrap. We re-probe with signal 0 (the same
      // call that the legacy SIGTERM path used as its liveness check)
      // and expect it to succeed.
      let alive = true
      try {
        process.kill(proc.pid, 0)
      } catch {
        alive = false
      }
      expect(alive).toBe(true)
    } finally {
      proc.kill()
    }
  })

  test('stale (dead) PID => tokenLock.acquire replaces it without SIGTERM', () => {
    // Pin the TASK-7 contract from the server.ts angle: server does
    // NOT pre-clean stale locks; tokenLock replaces them in-place.
    writeFileSync(paths.pid, '999999', { mode: 0o600 })
    const ok = tokenLock.acquire(paths)
    expect(ok).toBe(true)
    const written = Number.parseInt(readFileSync(paths.pid, 'utf8').trim(), 10)
    expect(written).toBe(process.pid)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Crash-handler redaction pipeline (HIGH #11, TASK-8 step 4).
// Verifies that redactToken (alias of redactSecrets, the same primitive
// used by the unhandledRejection/uncaughtException handlers in
// server.ts) scrubs:
//   - Telegram bot token by PATTERN
//   - exact-substring secrets passed via extras (webhook token,
//     Groq key, etc.)
// ─────────────────────────────────────────────────────────────────────

describe('crash handler redaction (HIGH #11)', () => {
  test('redacts Telegram bot token by pattern with no extras', () => {
    const msg = `unhandled rejection: connect ECONNREFUSED https://api.telegram.org/bot${FAKE_TOKEN}/getMe`
    const out = redactToken(msg)
    expect(out).not.toContain(FAKE_TOKEN)
    expect(out).toContain('[REDACTED]')
  })

  test('redacts arbitrary webhook token via exact-substring extras', () => {
    // Webhook tokens have NO public pattern — the only way to scrub
    // them is via the exact-substring `extras` list. server.ts seeds
    // crashSecrets with TELEGRAM_WEBHOOK_TOKEN; we replicate that
    // here.
    const webhookToken = 'secret-token-xyz-12345'
    const apiSecrets = [webhookToken]
    const msg = `unhandled rejection: Error: webhook fired with token=${webhookToken}`
    const out = redactToken(msg, apiSecrets)
    expect(out).not.toContain(webhookToken)
    expect(out).toContain('[REDACTED]')
  })

  test('redacts Groq key by pattern AND via extras simultaneously', () => {
    const groqKey = 'gsk_' + 'a'.repeat(48)
    const webhookToken = 'wh-' + 'b'.repeat(32)
    const apiSecrets = [webhookToken, groqKey]
    const msg = `uncaught exception: Error: providers failed groq=${groqKey} webhook=${webhookToken}`
    const out = redactToken(msg, apiSecrets)
    expect(out).not.toContain(groqKey)
    expect(out).not.toContain(webhookToken)
    expect(out.match(/\[REDACTED\]/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  test('is idempotent — running redactToken twice produces identical output', () => {
    const apiSecrets = ['some-webhook-token-aaa']
    const msg = `error: token=${FAKE_TOKEN} webhook=some-webhook-token-aaa`
    const once = redactToken(msg, apiSecrets)
    const twice = redactToken(once, apiSecrets)
    expect(twice).toBe(once)
  })
})
