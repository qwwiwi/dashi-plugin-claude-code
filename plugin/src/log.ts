// Redacted structured logger.
// Format: [ISO-ts] [level] [name] message {ctx-json}
// Output goes to stderr by default so it doesn't poison the MCP stdio transport.
// An optional persistent file sink (createFileSink) tees the same redacted
// lines to disk — bun routes stderr to the MCP stdio socket, which is
// invisible in journald/tmux, so silent-degrade events (e.g. a failed
// multichat policy load) leave no durable trace without it.

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'fs'
import { dirname } from 'path'

import { redactToken } from './config.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void
  info(msg: string, ctx?: Record<string, unknown>): void
  warn(msg: string, ctx?: Record<string, unknown>): void
  error(msg: string, ctx?: Record<string, unknown>): void
}

// A minimal write target. Both `process.stderr` and the object returned by
// `createFileSink` satisfy this — the logger only ever calls `.write(line)`.
export interface LineSink {
  write(line: string): void
}

export interface CreateLoggerOptions {
  stream?: NodeJS.WritableStream
  // Exact-substring secrets to redact alongside the pattern-based ones
  // (Telegram bot token, Groq key, Bearer/query tokens). Useful for the
  // configured TELEGRAM_WEBHOOK_TOKEN which has no public pattern.
  secrets?: ReadonlyArray<string>
  // Optional persistent sink. When set, every emitted line is written to
  // BOTH `stream` (live stderr) and `fileSink` (durable disk log). The line
  // is already redacted by `formatLine` before either write, so the file
  // never receives a secret the stream wouldn't.
  fileSink?: LineSink
}

export interface FileSinkOptions {
  // Rotate once the file would exceed this many bytes. Default 5 MiB.
  maxBytes?: number
  // Keep this many rotated files (`<path>.1` … `<path>.<maxFiles>`).
  // Default 5. The oldest is unlinked on rotation.
  maxFiles?: number
  // File mode for the active log + rotated copies. Default 0o600 — channel
  // logs can contain chat content, so they stay owner-only like the audit
  // JSONLs (see channel/permissions.ts, webhook/server.ts).
  mode?: number
}

// createFileSink — append-based persistent log sink with size rotation.
//
// We deliberately use `appendFileSync` rather than a long-lived
// `createWriteStream`: it matches the existing audit-log pattern in the
// codebase, needs no shutdown flush, and loses nothing buffered when the
// process is OOM-killed (the P0.7 scenario this whole task exists for).
// Volume is low (one poller, human-paced chat), so sync append is fine.
//
// Rotation is best-effort and never throws — logging must never take down
// the channel. On any filesystem error the line is silently dropped from
// the file sink (it still reached stderr via the logger's primary stream).
export function createFileSink(path: string, opts: FileSinkOptions = {}): LineSink {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024
  const maxFiles = opts.maxFiles ?? 5
  const mode = opts.mode ?? 0o600

  // Ensure the directory exists once up front. store.ts already mkdirs the
  // default logs dir, but a custom `path` override may point elsewhere.
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    // best-effort
  }

  const rotate = (): void => {
    // Shift `<path>.<n>` → `<path>.<n+1>`, dropping the oldest, then move the
    // active file to `<path>.1`. maxFiles<=0 disables retention (truncate).
    try {
      if (maxFiles > 0) {
        const oldest = `${path}.${maxFiles}`
        if (existsSync(oldest)) unlinkSync(oldest)
        for (let i = maxFiles - 1; i >= 1; i--) {
          const src = `${path}.${i}`
          if (existsSync(src)) renameSync(src, `${path}.${i + 1}`)
        }
        renameSync(path, `${path}.1`)
      } else {
        unlinkSync(path)
      }
    } catch {
      // If rotation fails (e.g. file vanished mid-flight) we just keep
      // appending to whatever remains — never throw.
    }
  }

  return {
    write(line: string): void {
      try {
        let size = 0
        try {
          size = statSync(path).size
        } catch {
          size = 0 // file does not exist yet
        }
        if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
          rotate()
        }
        appendFileSync(path, line, { mode })
        // `mode` in appendFileSync only applies when the file is CREATED.
        // A pre-existing file (created earlier under a looser umask, or a
        // rotated copy) keeps its old perms — channel logs can hold chat
        // content, so enforce owner-only on every write. Best-effort:
        // chmod failure must never take the logger down.
        try {
          chmodSync(path, mode)
        } catch {
          // best-effort
        }
      } catch {
        // never let logging throw — the line already went to stderr
      }
    },
  }
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

function envLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? '').toLowerCase()
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw
  return 'info'
}

function formatLine(
  name: string,
  level: LogLevel,
  msg: string,
  ctx: Record<string, unknown> | undefined,
  secrets: ReadonlyArray<string>,
): string {
  const ts = new Date().toISOString()
  let body = `[${ts}] [${level}] [${name}] ${msg}`
  if (ctx && Object.keys(ctx).length > 0) {
    let serialized: string
    try {
      serialized = JSON.stringify(ctx)
    } catch (err) {
      serialized = `<unserializable:${err instanceof Error ? err.message : String(err)}>`
    }
    body += ` ${redactToken(serialized, secrets)}`
  }
  return redactToken(body, secrets) + '\n'
}

export function createLogger(name: string, opts: CreateLoggerOptions = {}): Logger {
  const stream: NodeJS.WritableStream = opts.stream ?? process.stderr
  const fileSink = opts.fileSink
  const threshold = LEVEL_ORDER[envLevel()]
  const secrets: ReadonlyArray<string> = opts.secrets ?? []
  const emit = (level: LogLevel, msg: string, ctx?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < threshold) return
    const line = formatLine(name, level, msg, ctx, secrets)
    try {
      stream.write(line)
    } catch {
      // never let logging throw
    }
    if (fileSink) {
      // createFileSink already swallows its own errors, but guard here too
      // so a non-file-sink LineSink can't take the logger down either.
      try {
        fileSink.write(line)
      } catch {
        // never let logging throw
      }
    }
  }
  return {
    debug: (msg, ctx) => emit('debug', msg, ctx),
    info: (msg, ctx) => emit('info', msg, ctx),
    warn: (msg, ctx) => emit('warn', msg, ctx),
    error: (msg, ctx) => emit('error', msg, ctx),
  }
}
