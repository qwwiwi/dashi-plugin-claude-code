// Best-effort introspection of a PID holding the bot lock. Used by
// server.ts bootstrap to enrich the «another instance running» error
// before refusing to start. Pure function — no side effects, no kills.
//
// SECURITY NOTE (TASK-8 / HIGH #10): the previous bootstrap path read
// `bot.pid`, called `process.kill(stale, 0)` to probe liveness, and
// then sent SIGTERM to «replace» the holder. A tampered or stale-but-
// reused pid file could therefore terminate an unrelated process owned
// by the same user. We no longer send any signal from bootstrap — the
// only thing this module does is READ /proc and shape a human-readable
// description string. The tokenLock contract (poller.ts) owns the
// liveness check; the server refuses to start when the lock is held.
//
// Cross-platform: /proc/<pid>/cmdline is Linux-specific. macOS, BSD and
// Windows return an empty enrichment — callers MUST tolerate that.
//
// SECURITY NOTE (FIX-G / M2, Codex review 2026-05-27 #3): we used to
// emit the FULL argv (`/usr/bin/python3 /opt/foo/server.py --api-key SECRET`)
// in the refuse-to-start log line. A stale or tampered bot.pid pointing
// at an unrelated process can therefore leak `--api-key value` style
// argv to stderr / log aggregation. We now ONLY emit the basename of
// argv[0] (the executable's last path segment). Argv values past
// index 0 are dropped entirely — they are too dangerous to log and add
// no signal for identifying the holder.

import { readFileSync } from 'fs'
import { basename } from 'path'

const PROC_CMDLINE_MAX_BYTES = 4096

/**
 * Read `/proc/<pid>/cmdline` and return only the basename of argv[0].
 *
 * Returns `undefined` when /proc is unavailable (macOS, Windows), when
 * the pid does not exist, or when the file is empty/unreadable. ALL
 * argv values past index 0 are dropped — see security note at the top
 * of this file.
 *
 * Example: cmdline `/usr/bin/python3 /opt/foo/server.py --api-key SECRET`
 * returns `"python3"`. No path prefix, no argv values, no secrets.
 *
 * This is best-effort enrichment only — never throw, never side-effect.
 */
export function readProcCmdline(pid: number): string | undefined {
  if (!Number.isFinite(pid) || pid <= 1) return undefined
  if (process.platform !== 'linux') return undefined
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`)
    if (raw.length === 0) return undefined
    // cmdline uses NUL separators between argv entries. We only care
    // about argv[0] (the executable path) — everything past the first
    // NUL is dropped before decoding to avoid spending cycles or log
    // bytes on values we will never emit.
    const buf = raw.subarray(0, PROC_CMDLINE_MAX_BYTES)
    const firstNul = buf.indexOf(0)
    const argv0Bytes = firstNul === -1 ? buf : buf.subarray(0, firstNul)
    if (argv0Bytes.length === 0) return undefined
    const argv0 = argv0Bytes.toString('utf8').trim()
    if (argv0 === '') return undefined
    // basename strips the directory portion so a long install path
    // (`/opt/edge/python/3.12/bin/python3`) renders compactly. An
    // executable path with no slash returns itself unchanged.
    const exeBasename = basename(argv0)
    if (exeBasename === '') return undefined
    return exeBasename
  } catch {
    return undefined
  }
}

/**
 * Build a human-readable description of the process holding the bot
 * lock. Used by server.ts to enrich the «refuse-to-start» error before
 * exit. Always returns a string — falls back to bare `pid=N` on systems
 * without /proc or when the holder has already died between the lock
 * check and the description read (TOCTOU is harmless here — we are
 * only formatting a log line).
 *
 * Output shape: `pid=N (executable: python3)`. The basename comes from
 * {@link readProcCmdline} which drops argv[1+] for security — never
 * exposes `--api-key VALUE` style secrets even when the pid file is
 * stale/tampered and points at an unrelated process.
 */
export function describePidHolder(pid: number): string {
  if (!Number.isFinite(pid) || pid <= 1) {
    return `pid=${pid} (invalid)`
  }
  const exeBasename = readProcCmdline(pid)
  if (exeBasename === undefined) {
    return `pid=${pid}`
  }
  return `pid=${pid} (executable: ${exeBasename})`
}

/**
 * Best-effort read of the pid value stored in the bot.pid lock file.
 * Returns `undefined` when the file is missing, unreadable, empty, or
 * does not parse as a positive integer. Never throws — server.ts uses
 * this to enrich the refuse-to-start log; failure to read just means
 * the log line carries less detail.
 */
export function readLockHolder(pidFile: string): number | undefined {
  try {
    const raw = readFileSync(pidFile, 'utf8').trim()
    if (raw === '') return undefined
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n) || n <= 1) return undefined
    return n
  } catch {
    return undefined
  }
}
