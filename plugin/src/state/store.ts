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
  readdirSync,
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

// Cap for the `outbound` bucket (fix-loop-1 #7b): a persistent delivery
// problem (bot blocked, network flap) would otherwise grow the quarantine
// without bound. Newest 50 kept; older pruned on write (the pattern of the
// autonomy store's corrupt-evidence prune). Inbound buckets are NOT capped —
// their volume is operator-triaged and historically tiny.
const MAX_OUTBOUND_DEAD_LETTERS = 50

// Per-process monotonic sequence baked into dead-letter filenames so a
// lexicographic sort is chronological even for several writes within the SAME
// millisecond (mirrors the autonomy store's corrupt-evidence seq — a random
// tie-breaker would let the prune delete the newest record of a same-ms burst).
let deadLetterSeq = 0

/**
 * Wrap a value as `{ ts, bucket, value }` and write it to the bucket's
 * directory under a timestamped filename. Returns the full file path.
 *
 * Filename format: `<isoTs>-<pid>-<seq>-<rand>.json` — ISO timestamp first so
 * `ls` sorts chronologically; the zero-padded per-process seq orders same-ms
 * writes; pid + rand for collision-resistance across processes/restarts.
 *
 * The `outbound` bucket is capped at MAX_OUTBOUND_DEAD_LETTERS: after each
 * write the oldest surplus records are pruned (best-effort).
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
  const seq = (deadLetterSeq++).toString(36).padStart(4, '0')
  const rand = Math.random().toString(36).slice(2, 8)
  const file = join(dir, `${safeTs}-${process.pid}-${seq}-${rand}.json`)
  const payload = JSON.stringify({ ts, bucket, value }, null, 2)
  writeFileSync(file, payload, { mode: 0o600 })
  if (bucket === 'outbound') pruneOutboundDeadLetters(dir)
  return file
}

// Best-effort oldest-first prune of the outbound bucket. Lexicographic sort of
// the timestamp-seq filenames IS chronological (see writeDeadLetter docstring);
// every step is allowed to fail — pruning must never break the write path.
function pruneOutboundDeadLetters(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
    while (files.length > MAX_OUTBOUND_DEAD_LETTERS) {
      const oldest = files.shift()
      if (oldest === undefined) break
      try {
        unlinkSync(join(dir, oldest))
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort — a readdir failure must not fail the dead-letter write
  }
}

// ─────────────────────────────────────────────────────────────────────
// statusWidgetCard — the model-free status card the plugin keeps editing
// ─────────────────────────────────────────────────────────────────────

export interface StatusWidgetPending {
  // Random id of the send attempt that was persisted BEFORE the API call.
  attemptId: string
  // Epoch milliseconds when the attempt started (informational, never an expiry).
  startedAt: number
}

// Persisted status card state machine:
//   EMPTY      no record, or messageId null with no pending attempt;
//   TRACKED    messageId set, pending null;
//   UNCERTAIN  pending set: a send was started and its outcome is not known.
// While UNCERTAIN the previously tracked messageId is kept.
export interface StatusWidgetRecord {
  version: 1
  chatId: string
  messageId: number | null
  pending: StatusWidgetPending | null
}

export type StatusWidgetLoad =
  | { kind: 'empty' }
  | { kind: 'record'; record: StatusWidgetRecord }
  | { kind: 'unreadable'; error: string }

function statusWidgetCardPath(paths: StatePaths): string {
  return join(paths.root, 'status-widget.json')
}

function isRecordObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

// Parse the file content; undefined = not a valid record. The legacy shape
// (chat id + message id only) loads as TRACKED.
function parseStatusWidgetRecord(parsed: unknown): StatusWidgetRecord | undefined {
  if (!isRecordObject(parsed)) return undefined
  const { chatId } = parsed
  if (typeof chatId !== 'string' || chatId === '') return undefined
  if (!('version' in parsed)) {
    if (!isPositiveInt(parsed.messageId)) return undefined
    return { version: 1, chatId, messageId: parsed.messageId, pending: null }
  }
  if (parsed.version !== 1) return undefined
  const messageId = parsed.messageId
  if (messageId !== null && !isPositiveInt(messageId)) return undefined
  const rawPending = parsed.pending
  if (rawPending === null) return { version: 1, chatId, messageId, pending: null }
  if (!isRecordObject(rawPending)) return undefined
  const { attemptId, startedAt } = rawPending
  if (typeof attemptId !== 'string' || attemptId === '') return undefined
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined
  return { version: 1, chatId, messageId, pending: { attemptId, startedAt } }
}

// Read the persisted card record. A missing file is EMPTY. Anything that
// cannot be read or parsed is reported as `unreadable` and NEVER as empty:
// reading damage as «no card» would make the service send a duplicate.
export function readStatusWidgetRecord(paths: StatePaths): StatusWidgetLoad {
  const file = statusWidgetCardPath(paths)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return { kind: 'empty' }
    return { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) }
  }
  try {
    const record = parseStatusWidgetRecord(JSON.parse(text))
    if (record === undefined) return { kind: 'unreadable', error: 'status widget record has an unexpected shape' }
    return { kind: 'record', record }
  } catch {
    return { kind: 'unreadable', error: 'status widget record is not valid JSON' }
  }
}

// Atomic write (tmp + fsync + rename + directory fsync), 0o600 like the other
// state files. THROWS on any failure: the caller decides what an unsaved
// record means (the status service stops its automatic work).
export function writeStatusWidgetRecord(paths: StatePaths, record: StatusWidgetRecord): void {
  const file = statusWidgetCardPath(paths)
  const tmp = join(paths.root, `status-widget.tmp.${process.pid}.${Date.now()}`)
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(record))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, file)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // best-effort
    }
    throw err
  }
  // Make the rename itself durable: a crash right after the send must not
  // lose the pending attempt.
  const dirFd = openSync(paths.root, 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

// Forget the tracked card. Idempotent for a missing file; any other failure throws.
export function clearStatusWidgetRecord(paths: StatePaths): void {
  try {
    unlinkSync(statusWidgetCardPath(paths))
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return
    throw err
  }
}
