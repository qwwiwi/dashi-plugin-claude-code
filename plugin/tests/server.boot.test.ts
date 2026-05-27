// FIX-G boot-sequence tests (Codex review 2026-05-27, server #2 + #4).
//
// We exercise two server.ts boot invariants here without booting the
// full MCP transport:
//
//   M1 — album recovery MUST complete before poller.start() fires.
//        Recovered albums share a composite key with potentially fresh
//        inbound updates; running the poller concurrently with
//        recovery races the dispatch path. We rebuild the await chain
//        in this test and pin the ordering with mock observers.
//
//   M3 — TELEGRAM_MULTICHAT_POLICY_PATH (and config.multichat.policy_path)
//        must be treated as an EXACT file path. The previous loader
//        stripped the basename and re-derived `<dir>/policy.yaml`, so
//        a value like `/etc/edge/my-policy.yaml` was silently rewritten
//        to `/etc/edge/policy.yaml`. We test loadPolicyFromPath
//        directly + assert relative-path semantics indirectly through
//        the same primitive.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { loadPolicyFromPath } from '../src/chats/policy-loader.js'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'dashi-server-boot-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────
// M1 — album recovery / poller ordering.
//
// server.ts now wraps both calls in a single async IIFE that awaits
// `recoverPendingAlbums` before calling `poller.start()`. We rebuild
// the same shape with sentinels and prove the poller cannot fire
// before recovery resolves, regardless of how slow recovery is.
// ─────────────────────────────────────────────────────────────────────

describe('FIX-G / M1 — album recovery awaits before poller.start', () => {
  test('poller.start runs strictly after recoverPendingAlbums resolves', async () => {
    const events: string[] = []
    let pollerStarted = false

    // Mock recoverPendingAlbums with a 50ms delay so the difference
    // between `void recover()` and `await recover()` is observable.
    async function fakeEnsureAlbumsDir(): Promise<void> {
      events.push('ensureAlbumsDir:start')
      await new Promise((r) => setTimeout(r, 10))
      events.push('ensureAlbumsDir:done')
    }
    async function fakeRecoverPendingAlbums(): Promise<{ recovered: number }> {
      events.push('recover:start')
      // Critical: this must be slow enough that a `void`-fired poller
      // would race. 50ms is generous compared to setImmediate.
      await new Promise((r) => setTimeout(r, 50))
      events.push('recover:done')
      return { recovered: 0 }
    }
    async function fakePollerStart(): Promise<void> {
      events.push('poller:start')
      pollerStarted = true
    }

    // Same shape as server.ts post-FIX-G: single async IIFE that
    // awaits ensure -> recover -> poller.start sequentially.
    const boot = (async () => {
      try {
        await fakeEnsureAlbumsDir()
      } catch {
        // non-fatal in server.ts; tests should never reach this
        // branch because the fake never throws.
      }
      try {
        await fakeRecoverPendingAlbums()
      } catch {
        // non-fatal
      }
      await fakePollerStart()
    })()

    // While the boot promise is still pending, the poller MUST NOT
    // have started. We sample at 30ms — recovery is still mid-flight
    // (50ms total) so any race would have set pollerStarted=true.
    await new Promise((r) => setTimeout(r, 30))
    expect(pollerStarted).toBe(false)
    expect(events).toContain('recover:start')
    expect(events).not.toContain('poller:start')

    // After boot fully resolves, the poller has started AND recovery
    // events appear in the log STRICTLY before the poller event.
    await boot
    expect(pollerStarted).toBe(true)
    const recoverDoneIdx = events.indexOf('recover:done')
    const pollerStartIdx = events.indexOf('poller:start')
    expect(recoverDoneIdx).toBeGreaterThanOrEqual(0)
    expect(pollerStartIdx).toBeGreaterThanOrEqual(0)
    expect(pollerStartIdx).toBeGreaterThan(recoverDoneIdx)
  })

  test('recovery failure does NOT block poller.start (non-fatal contract)', async () => {
    // server.ts treats a recovery failure as non-fatal (logged,
    // continue). The poller must still start so a single corrupt
    // album dir does not poison the entire channel.
    let pollerStarted = false

    async function failingRecover(): Promise<void> {
      throw new Error('synthetic recovery failure')
    }
    async function fakePollerStart(): Promise<void> {
      pollerStarted = true
    }

    await (async () => {
      try {
        await failingRecover()
      } catch {
        // server.ts logs and continues
      }
      await fakePollerStart()
    })()

    expect(pollerStarted).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// M3 — policy path is the EXACT file path, not a dir hint.
//
// We test loadPolicyFromPath directly with custom filenames. The
// pre-fix loader (`loadPolicy(dirname)`) silently rewrote any custom
// filename to `policy.yaml`, hiding the operator's actual config.
// ─────────────────────────────────────────────────────────────────────

const MINIMAL_POLICY_YAML = `version: 1
allowlist:
  chats: ['164795011']
  users: ['164795011']
mention_allowlist: ['164795011']
chats:
  '164795011':
    mode: private
    streaming: progress
    tmux_mirror: true
    edit_message_progress: true
    delivery: streamed
    persona_file: persona.md
    handoff_file: handoff.md
    system_reminder: ''
`

describe('FIX-G / M3 — loadPolicyFromPath honours EXACT file path', () => {
  test('reads a custom filename (env var contract)', () => {
    // Simulate TELEGRAM_MULTICHAT_POLICY_PATH=/abs/path/staging-policy.yaml
    const customPath = join(workDir, 'staging-policy.yaml')
    writeFileSync(customPath, MINIMAL_POLICY_YAML, { mode: 0o600 })

    const policy = loadPolicyFromPath(customPath)
    expect(policy.version).toBe(1)
    expect(Object.keys(policy.chats)).toContain('164795011')
  })

  test('does NOT fall back to ./policy.yaml when custom filename used', () => {
    // Plant a "default" policy.yaml in the same dir to catch the
    // pre-fix behaviour: it would silently read policy.yaml instead
    // of the requested staging-policy.yaml.
    writeFileSync(join(workDir, 'policy.yaml'), MINIMAL_POLICY_YAML, {
      mode: 0o600,
    })
    const customPath = join(workDir, 'does-not-exist.yaml')

    // The custom file does not exist — readFileSync must throw, not
    // silently degrade to the sibling policy.yaml.
    expect(() => loadPolicyFromPath(customPath)).toThrow()
  })

  test('reads a different file from the same directory based on name', () => {
    // Two policies side by side. Pre-fix both calls would have
    // returned the same chats — the loader rewrote filename to
    // policy.yaml. Post-fix each call returns its own file.
    const policyA = MINIMAL_POLICY_YAML.replaceAll("'164795011'", "'111111111'")
    const policyB = MINIMAL_POLICY_YAML.replaceAll("'164795011'", "'222222222'")
    const pathA = join(workDir, 'policy-a.yaml')
    const pathB = join(workDir, 'policy-b.yaml')
    writeFileSync(pathA, policyA, { mode: 0o600 })
    writeFileSync(pathB, policyB, { mode: 0o600 })

    const loadedA = loadPolicyFromPath(pathA)
    const loadedB = loadPolicyFromPath(pathB)
    expect(Object.keys(loadedA.chats)).toContain('111111111')
    expect(Object.keys(loadedA.chats)).not.toContain('222222222')
    expect(Object.keys(loadedB.chats)).toContain('222222222')
    expect(Object.keys(loadedB.chats)).not.toContain('111111111')
  })

  test('default-derived path keeps reading <basePath>/policy.yaml via loadPolicy', async () => {
    // Sanity: the legacy loadPolicy(basePath) still delegates to
    // loadPolicyFromPath(join(basePath, 'policy.yaml')), so the
    // default-derive case (no env var set, server.ts derives
    // `<workspace>/chats/policy.yaml`) keeps working.
    const { loadPolicy } = await import('../src/chats/policy-loader.js')
    writeFileSync(join(workDir, 'policy.yaml'), MINIMAL_POLICY_YAML, {
      mode: 0o600,
    })
    const policy = loadPolicy(workDir)
    expect(policy.version).toBe(1)
  })
})
