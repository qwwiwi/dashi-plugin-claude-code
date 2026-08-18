// Launch-model detection — the ONLY place the `--model` flag of the hosting
// Claude Code process is read.
//
// Why this exists: the transcript's per-turn `model` is the id the API served,
// and for some 1M-window variants it comes back BARE — a session launched as
// `claude --model claude-opus-5[1m]` writes `"model":"claude-opus-5"` into the
// transcript. The family table then honestly resolves 200k and the pinned HUD
// under-reports a 1M window by 5x. The marker survives in exactly one place:
// the argv of the process that launched us. This module recovers it.
//
// The channel server runs as a child of that Claude Code process, so the parent
// chain is walked (a few hops, in case a shell/wrapper sits in between). Linux
// /proc only; every failure path returns undefined and the caller falls back to
// the model table, so a missing /proc never breaks the HUD.

import { readFileSync } from 'node:fs'

import { parseLaunchModelFlag } from '../config.js'

// How many ancestors to inspect. The direct parent is normally the Claude Code
// process; the extra hops cover a wrapper/shell without walking to PID 1.
const MAX_ANCESTORS = 8

function readCmdline(pid: number): readonly string[] | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    if (raw.length === 0) return undefined
    // /proc cmdline is NUL-separated with a trailing NUL.
    return raw.split('\0').filter((a) => a.length > 0)
  } catch {
    return undefined
  }
}

function readParentPid(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // Fields: pid (comm) state ppid ... — comm is parenthesized and may itself
    // contain spaces/parens, so split AFTER the last ')'.
    const close = stat.lastIndexOf(')')
    if (close === -1) return undefined
    const rest = stat.slice(close + 1).trim().split(/\s+/)
    // rest[0] = state, rest[1] = ppid
    const ppid = Number(rest[1])
    return Number.isInteger(ppid) && ppid > 1 ? ppid : undefined
  } catch {
    return undefined
  }
}

export interface ReadLaunchModelOptions {
  // Where to start walking. Defaults to this process's parent.
  startPid?: number | undefined
  // Injectable readers — tests drive a fake process tree without /proc.
  readCmdlineFn?: (pid: number) => readonly string[] | undefined
  readParentPidFn?: (pid: number) => number | undefined
  maxAncestors?: number | undefined
}

/**
 * The model id the hosting Claude Code process was launched with, or undefined
 * when no ancestor carries a `--model` flag (or /proc is unavailable).
 *
 * Never throws. Read ONCE at boot — the launch flag cannot change without a
 * restart, and a per-render /proc walk would be pointless work.
 */
export function readLaunchModelId(opts?: ReadLaunchModelOptions): string | undefined {
  const readCmd = opts?.readCmdlineFn ?? readCmdline
  const readParent = opts?.readParentPidFn ?? readParentPid
  const limit = opts?.maxAncestors ?? MAX_ANCESTORS
  let pid = opts?.startPid ?? process.ppid
  const seen = new Set<number>()
  for (let hop = 0; hop < limit; hop += 1) {
    if (!Number.isInteger(pid) || pid <= 1 || seen.has(pid)) return undefined
    seen.add(pid)
    // The built-in readers already swallow their own errors; the try wraps the
    // INJECTED readers too, so the never-throws contract holds for every caller.
    let parent: number | undefined
    try {
      const argv = readCmd(pid)
      if (argv !== undefined) {
        const model = parseLaunchModelFlag(argv)
        if (model !== undefined) return model
      }
      parent = readParent(pid)
    } catch {
      return undefined
    }
    if (parent === undefined) return undefined
    pid = parent
  }
  return undefined
}
