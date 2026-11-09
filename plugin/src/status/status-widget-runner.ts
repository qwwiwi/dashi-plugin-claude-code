// Real command runner for the model-free status card: runs an argv array
// WITHOUT a shell, with a hard timeout and a stdout cap. Nothing it prints is
// ever logged by the caller; stderr is discarded.

import { spawn } from 'child_process'

export type CommandResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: 'exit' | 'timeout' | 'spawn' | 'too_large' }

export interface CommandRunOptions {
  timeoutMs: number
  maxStdoutBytes: number
}

export type CommandRunner = (argv: readonly string[], opts: CommandRunOptions) => Promise<CommandResult>

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

export const runStatusCommand: CommandRunner = (argv, opts) =>
  new Promise<CommandResult>((resolve) => {
    const [file, ...args] = argv
    if (file === undefined || file === '') {
      resolve({ ok: false, reason: 'spawn' })
      return
    }
    let settled = false
    const chunks: Buffer[] = []
    let size = 0
    const finish = (result: CommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: cleanEnv(),
      })
    } catch {
      resolve({ ok: false, reason: 'spawn' })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, reason: 'timeout' })
    }, opts.timeoutMs)
    child.on('error', () => finish({ ok: false, reason: 'spawn' }))
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > opts.maxStdoutBytes) {
        child.kill('SIGKILL')
        finish({ ok: false, reason: 'too_large' })
        return
      }
      chunks.push(chunk)
    })
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, stdout: Buffer.concat(chunks).toString('utf8') })
      else finish({ ok: false, reason: 'exit' })
    })
  })
