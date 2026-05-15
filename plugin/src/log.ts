// Redacted structured logger.
// Format: [ISO-ts] [level] [name] message {ctx-json}
// Output goes to stderr by default so it doesn't poison the MCP stdio transport.

import { redactToken } from './config.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void
  info(msg: string, ctx?: Record<string, unknown>): void
  warn(msg: string, ctx?: Record<string, unknown>): void
  error(msg: string, ctx?: Record<string, unknown>): void
}

export interface CreateLoggerOptions {
  stream?: NodeJS.WritableStream
  // Exact-substring secrets to redact alongside the pattern-based ones
  // (Telegram bot token, Groq key, Bearer/query tokens). Useful for the
  // configured TELEGRAM_WEBHOOK_TOKEN which has no public pattern.
  secrets?: ReadonlyArray<string>
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
  const threshold = LEVEL_ORDER[envLevel()]
  const secrets: ReadonlyArray<string> = opts.secrets ?? []
  const emit = (level: LogLevel, msg: string, ctx?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < threshold) return
    try {
      stream.write(formatLine(name, level, msg, ctx, secrets))
    } catch {
      // never let logging throw
    }
  }
  return {
    debug: (msg, ctx) => emit('debug', msg, ctx),
    info: (msg, ctx) => emit('info', msg, ctx),
    warn: (msg, ctx) => emit('warn', msg, ctx),
    error: (msg, ctx) => emit('error', msg, ctx),
  }
}
