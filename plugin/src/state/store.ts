// src/state/store.ts
//
// On-disk state for the dashi-channel plugin.
// Reconstructed from tests/state.test.ts + src/config.ts (StatePaths).
// Fix for upstream Issue #7: plugin/.gitignore line 6 (`state/`) excluded
// this file from the original commit, breaking `bun install` from a clean
// clone. The .gitignore must be updated (allow `!src/state/`) alongside
// committing this file.
//
// API surface (from tests/state.test.ts):
//   ensureStateDirs(paths)            — create root (0o700) + subdirs
//   readUpdateOffset(paths)           — number | undefined
//   writeUpdateOffset(paths, n)       — atomic via tmp + rename
//   migrateLegacyAllowlist(paths)     — access.json → allowlist.json (one-shot)
//   writeDeadLetter(paths, bucket, v) — append JSON wrapper, return file path

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs'
import { dirname, join } from 'path'
import type { StatePaths } from '../config.js'

// ─────────────────────────────────────────────────────────────────────
// ensureStateDirs
// ─────────────────────────────────────────────────────────────────────

/**
 * Create the state root and all required subdirectories.
 * Root is created with mode 0o700 (owner-only access — token + offsets live here).
 * Subdirectories inherit umask but caller's umask is assumed to mask group/other.
 */
export function ensureStateDirs(paths: StatePaths): void {
  // Root: explicit 0o700 — secrets-bearing dir.
  mkdirSync(paths.root, { recursive: true, mode: 0o700 })
  // Subdirs: recursive creates parents (e.g. dead-letter/ before dead-letter/updates).
  mkdirSync(paths.inbox, { recursive: true })
  mkdirSync(paths.sessionIds, { recursive: true })
  mkdirSync(paths.deadLetterUpdates, { recursive: true })
  mkdirSync(paths.deadLetterWebhook, { recursive: true })
  mkdirSync(paths.deadLetterOutbound, { recursive: true })
  // logs/ — server.log etc. live here; create parent so first log write succeeds.
  mkdirSync(dirname(paths.logs.server), { recursive: true })
}

// ─────────────────────────────────────────────────────────────────────
// updateOffset — Telegram getUpdates long-poll offset, persisted across restarts
// ─────────────────────────────────────────────────────────────────────

export function readUpdateOffset(paths: StatePaths): number | undefined {
  if (!existsSync(paths.updateOffset)) return undefined
  const raw = readFileSync(paths.updateOffset, 'utf8').trim()
  if (raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  return n
}

/**
 * Atomic write: tmp file + fsync + rename. On rename failure, tmp is removed
 * and the target is guaranteed not to exist (test "no partial-write file
 * appears if rename fails" enforces this).
 */
export function writeUpdateOffset(paths: StatePaths, offset: number): void {
  const tmp = join(paths.root, `update-offset.tmp.${process.pid}.${Date.now()}`)
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, String(offset))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, paths.updateOffset)
  } catch (err) {
    // Cleanup tmp on rename failure — test asserts no `update-offset.tmp.*`
    // strays remain in root.
    try {
      unlinkSync(tmp)
    } catch {
      // best-effort
    }
    throw err
  }
}

// ─────────────────────────────────────────────────────────────────────
// migrateLegacyAllowlist — one-shot rename of access.json → allowlist.json
// ─────────────────────────────────────────────────────────────────────

/**
 * If a legacy `access.json` exists in the same dir as `paths.allowlist`
 * AND `allowlist.json` does NOT exist, rename it. Returns true on rename,
 * false otherwise (including when neither file is present, or both are).
 *
 * Operator decides what to do with the legacy file when both exist —
 * we never overwrite the current allowlist.
 */
export function migrateLegacyAllowlist(paths: StatePaths): boolean {
  const legacy = join(dirname(paths.allowlist), 'access.json')
  if (!existsSync(legacy)) return false
  if (existsSync(paths.allowlist)) return false
  renameSync(legacy, paths.allowlist)
  return true
}

// ─────────────────────────────────────────────────────────────────────
// writeDeadLetter — quarantine bucket for un-processable inputs
// ─────────────────────────────────────────────────────────────────────

export type DeadLetterBucket = 'updates' | 'webhook' | 'outbound'

/**
 * Wrap a value as `{ ts, bucket, value }` and write it to the bucket's
 * directory under a timestamped filename. Returns the full file path.
 *
 * Filename format: `<isoTs>-<pid>-<rand>.json` — ISO timestamp first so
 * `ls` sorts chronologically; pid + rand for collision-resistance under
 * concurrent writes.
 */
export function writeDeadLetter(
  paths: StatePaths,
  bucket: DeadLetterBucket,
  value: unknown,
): string {
  const ts = new Date().toISOString()
  const dir =
    bucket === 'updates'
      ? paths.deadLetterUpdates
      : bucket === 'webhook'
        ? paths.deadLetterWebhook
        : paths.deadLetterOutbound
  const safeTs = ts.replace(/[:.]/g, '-')
  const rand = Math.random().toString(36).slice(2, 8)
  const file = join(dir, `${safeTs}-${process.pid}-${rand}.json`)
  const payload = JSON.stringify({ ts, bucket, value }, null, 2)
  writeFileSync(file, payload, { mode: 0o600 })
  return file
}
