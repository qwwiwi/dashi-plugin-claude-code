// Real command runner for the model-free status card: runs an argv array
// WITHOUT a shell, with a hard timeout and a stdout cap. Nothing it prints is
// ever logged by the caller; stderr is discarded.
//
// The command runs in its OWN process group (detached, still no shell) so a
// timeout, an abort or an output overflow takes down the whole tree it started,
// not just the direct child: SIGTERM to the group, SIGKILL 200 ms later. The
// result is reported only after the direct child has closed.

import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'

export type CommandResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: 'exit' | 'timeout' | 'spawn' | 'too_large' | 'aborted' | 'cleanup' }

export interface CommandRunOptions {
  timeoutMs: number
  maxStdoutBytes: number
  // Cancels the run: the whole process group is terminated.
  signal?: AbortSignal
}

export type CommandRunner = (argv: readonly string[], opts: CommandRunOptions) => Promise<CommandResult>

// Grace between SIGTERM and SIGKILL for the process group.
export const KILL_GRACE_MS = 200

// The part of a child process the runner relies on.
export type ChildLike = Pick<ChildProcess, 'pid' | 'stdout' | 'on'>

// Test seams (real implementations by default).
export interface RunnerSeams {
  spawn: (file: string, args: string[], options: SpawnOptions) => ChildLike
  // process.kill semantics: a negative pid addresses the whole process group.
  kill: (pid: number, signal: NodeJS.Signals) => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

// Environment names that look like credentials are not handed to the command:
// the state producer needs none of the plugin's secrets. An operator who needs
// a credential wraps the command (`env`, a wrapper script) explicitly.
const SECRET_ENV_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL/i

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!SECRET_ENV_NAME.test(name)) env[name] = value
  }
  return env
}

function isEsrch(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ESRCH'
}

const defaultSeams: RunnerSeams = {
  spawn: (file, args, options) => spawn(file, args, options),
  kill: (pid, signal) => {
    process.kill(pid, signal)
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

type Termination = 'timeout' | 'aborted' | 'too_large'

export function createStatusCommandRunner(overrides: Partial<RunnerSeams> = {}): CommandRunner {
  const seams: RunnerSeams = { ...defaultSeams, ...overrides }

  return (argv, opts) =>
    new Promise<CommandResult>((resolve) => {
      const [file, ...args] = argv
      if (file === undefined || file === '') {
        resolve({ ok: false, reason: 'spawn' })
        return
      }
      const { signal } = opts
      if (signal?.aborted === true) {
        resolve({ ok: false, reason: 'aborted' })
        return
      }

      let child: ChildLike
      try {
        child = seams.spawn(file, args, {
          shell: false,
          detached: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: cleanEnv(),
        })
      } catch {
        resolve({ ok: false, reason: 'spawn' })
        return
      }

      const pid = child.pid
      const chunks: Buffer[] = []
      let size = 0
      let done = false
      let closed = false
      let cleanupFailed = false
      let termination: Termination | undefined
      let killSent = false
      let timeoutTimer: unknown
      let graceTimer: unknown
      let onAbort: (() => void) | undefined

      // Signal the whole group. ESRCH = nothing left to signal; any other
      // failure is remembered and reported as `cleanup`.
      const signalGroup = (sig: NodeJS.Signals): void => {
        if (pid === undefined || pid <= 0) return
        try {
          seams.kill(-pid, sig)
        } catch (err) {
          if (!isEsrch(err)) cleanupFailed = true
        }
      }

      const finish = (result: CommandResult): void => {
        if (done) return
        done = true
        if (timeoutTimer !== undefined) seams.clearTimer(timeoutTimer)
        if (graceTimer !== undefined && !killSent) seams.clearTimer(graceTimer)
        if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort)
        resolve(cleanupFailed ? { ok: false, reason: 'cleanup' } : result)
      }

      // Resolve a terminated run once the direct child closed AND the KILL
      // escalation went out (the leader may exit first; its descendants may not).
      const maybeFinishTerminated = (): void => {
        if (termination !== undefined && closed && killSent) finish({ ok: false, reason: termination })
      }

      // One idempotent routine for timeout, abort and output overflow.
      const terminate = (why: Termination): void => {
        if (termination !== undefined || done) return
        termination = why
        if (timeoutTimer !== undefined) {
          seams.clearTimer(timeoutTimer)
          timeoutTimer = undefined
        }
        if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort)
        chunks.length = 0
        child.stdout?.destroy()
        signalGroup('SIGTERM')
        graceTimer = seams.setTimer(() => {
          signalGroup('SIGKILL')
          killSent = true
          maybeFinishTerminated()
        }, KILL_GRACE_MS)
      }

      child.on('error', () => {
        // Spawn failure: no process was started, nothing to signal.
        if (pid === undefined) finish({ ok: false, reason: 'spawn' })
        else cleanupFailed = true
      })

      child.stdout?.on('data', (chunk: Buffer) => {
        if (termination !== undefined || done) return
        size += chunk.length
        if (size > opts.maxStdoutBytes) {
          terminate('too_large')
          return
        }
        chunks.push(chunk)
      })

      child.on('close', (code) => {
        closed = true
        if (termination !== undefined) {
          maybeFinishTerminated()
          return
        }
        // The leader finished on its own. Members of its group may outlive it:
        // sweep them (ESRCH when nothing is left).
        signalGroup('SIGKILL')
        if (code === 0) finish({ ok: true, stdout: Buffer.concat(chunks).toString('utf8') })
        else finish({ ok: false, reason: 'exit' })
      })

      timeoutTimer = seams.setTimer(() => terminate('timeout'), opts.timeoutMs)

      if (signal !== undefined) {
        onAbort = (): void => terminate('aborted')
        signal.addEventListener('abort', onAbort, { once: true })
        // Aborted between the first check and the listener registration.
        if (signal.aborted) terminate('aborted')
      }
    })
}

export const runStatusCommand: CommandRunner = createStatusCommandRunner()
