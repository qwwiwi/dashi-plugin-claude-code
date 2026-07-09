// pane-capture — the SINGLE shared `tmux capture-pane` + ANSI-strip code path.
//
// Both the rolling TmuxMirror (human-facing terminal mirror) and the
// TaskRealityMirror (task-list reconciler) need to read the agent's pane and
// clean it. This module owns that primitive so neither surface duplicates the
// capture-pane argv or the ANSI/control stripping — a review hard-requirement
// for M3 (do NOT duplicate capture-pane logic). TmuxMirror re-exports the
// `TmuxExec` / `TmuxExecResult` seams from here for backward-compat.
//
// Deliberately I/O-thin: `capturePaneText` runs ONE exec and returns cleaned
// text; `resolvePaneCwd` runs ONE `display-message` and returns the pane's
// working directory (best-effort, for reconciler provenance). Neither throws —
// a dead pane / missing tmux surfaces as `ok:false` / `null`, and the caller
// decides how to degrade.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Test seam: production wraps `tmux <args>`; tests inject a deterministic stub.
// Args are exactly the argv AFTER the `tmux` binary. Shared with TmuxMirror.
export interface TmuxExecResult {
  stdout: string
  stderr: string
  exitCode: number
}
export type TmuxExec = (args: readonly string[]) => Promise<TmuxExecResult>

// Default production exec: spawn `tmux` with an ARGV ARRAY (no shell, so pane
// targets / socket names can't inject). Never throws — a non-zero exit is
// returned so the caller renders the failure instead of crashing the loop.
// Shared by TmuxMirror and TaskRealityMirror.
const execFileAsync = promisify(execFile)
export async function defaultTmuxExec(args: readonly string[]): Promise<TmuxExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync('tmux', args as string[], {
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      timeout: 5000,
    })
    return { stdout, stderr, exitCode: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string }
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? 'tmux exec failed',
      exitCode: typeof e.code === 'number' ? e.code : 1,
    }
  }
}

// Strip ANSI / vt control sequences and bare control characters. Keep
// newlines + tabs. Patterns:
//   • CSI:  ESC [ ... terminator-letter
//   • OSC:  ESC ] ... BEL  OR  ESC ] ... ST (ESC \)
//   • DCS/PM/APC/SOS: ESC (P|^|_|X) ... ST
//   • two-byte: ESC + single char in @-Z, \, -, _
// Stripping happens BEFORE any HTML escaping so leftover characters can't blow
// up Telegram's HTML parser. ST is `ESC \`; both BEL and ST terminate OSC.
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)|[P^_X][\s\S]*?\x1b\\|[@-Z\\\-_])/g
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g

/** Remove ANSI escapes + bare control chars, preserving `\n` and `\t`. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '').replace(CTRL_RE, '')
}

export interface PaneCaptureConfig {
  /** tmux target, `session:window.pane` (e.g. `channel-thrall:0.0`). */
  paneTarget: string
  /** tmux socket name (`tmux -L <name>`). Empty = default socket. */
  socketName?: string
  /** `-S -N`: capture the N most-recent lines. */
  lineCount: number
}

export interface PaneCaptureResult {
  /** true when the capture-pane exec returned exit 0. */
  ok: boolean
  /** ANSI-stripped pane text (empty on failure). */
  text: string
  exitCode: number
  /** stderr / failure reason when `ok` is false. */
  error?: string
}

function socketArgs(socketName: string | undefined): string[] {
  return socketName ? ['-L', socketName] : []
}

/**
 * Capture the pane and strip ANSI. ONE exec. Never throws — a failed capture
 * (session gone, tmux missing) returns `{ ok:false, text:'' }`.
 */
export async function capturePaneText(
  exec: TmuxExec,
  cfg: PaneCaptureConfig,
): Promise<PaneCaptureResult> {
  const result = await exec([
    ...socketArgs(cfg.socketName),
    'capture-pane',
    '-p',
    '-t',
    cfg.paneTarget,
    '-S',
    `-${cfg.lineCount}`,
  ])
  if (result.exitCode !== 0) {
    return {
      ok: false,
      text: '',
      exitCode: result.exitCode,
      error: result.stderr.trim() || `tmux exited ${result.exitCode}`,
    }
  }
  return { ok: true, text: stripAnsi(result.stdout), exitCode: 0 }
}

/**
 * Resolve the pane's current working directory (`#{pane_current_path}`) for
 * reconciler provenance. Best-effort — returns null when the pane is gone or
 * tmux errors, so the caller can degrade to skipping the cwd cross-check.
 */
export async function resolvePaneCwd(
  exec: TmuxExec,
  cfg: PaneCaptureConfig,
): Promise<string | null> {
  try {
    const result = await exec([
      ...socketArgs(cfg.socketName),
      'display-message',
      '-p',
      '-t',
      cfg.paneTarget,
      '#{pane_current_path}',
    ])
    if (result.exitCode !== 0) return null
    const cwd = stripAnsi(result.stdout).trim()
    return cwd.length > 0 ? cwd : null
  } catch {
    return null
  }
}
