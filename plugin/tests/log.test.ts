import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { createFileSink, createLogger } from '../src/log.js'
import { AppConfigSchema, DEFAULT_LOG_MAX_BYTES, DEFAULT_LOG_MAX_FILES, loadConfig, resolveFileSink } from '../src/config.js'
import { chmodSync } from 'fs'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'jarvis-logsink-'))
}

describe('createFileSink', () => {
  test('appends written lines to the target file', () => {
    const dir = tmpDir()
    try {
      const path = join(dir, 'server.log')
      const sink = createFileSink(path)
      sink.write('line one\n')
      sink.write('line two\n')
      expect(readFileSync(path, 'utf8')).toBe('line one\nline two\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('creates the parent directory if missing', () => {
    const dir = tmpDir()
    try {
      const path = join(dir, 'nested', 'deeper', 'server.log')
      const sink = createFileSink(path)
      sink.write('x\n')
      expect(existsSync(path)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rotates when the file would exceed maxBytes', () => {
    const dir = tmpDir()
    try {
      const path = join(dir, 'server.log')
      const sink = createFileSink(path, { maxBytes: 20, maxFiles: 2 })
      sink.write('0123456789\n') // 11 bytes — fits
      sink.write('abcdefghij\n') // would push to 22 > 20 → rotate first
      // Active file now holds only the second line; the first rolled to .1
      expect(readFileSync(path, 'utf8')).toBe('abcdefghij\n')
      expect(readFileSync(`${path}.1`, 'utf8')).toBe('0123456789\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('drops the oldest rotated file beyond maxFiles', () => {
    const dir = tmpDir()
    try {
      const path = join(dir, 'server.log')
      const sink = createFileSink(path, { maxBytes: 5, maxFiles: 1 })
      sink.write('aaaa\n') // 5 bytes
      sink.write('bbbb\n') // rotate: aaaa → .1
      sink.write('cccc\n') // rotate: .1 dropped, bbbb → .1
      expect(readFileSync(path, 'utf8')).toBe('cccc\n')
      expect(readFileSync(`${path}.1`, 'utf8')).toBe('bbbb\n')
      expect(existsSync(`${path}.2`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('writes the active file with owner-only mode (0o600)', () => {
    const dir = tmpDir()
    try {
      const path = join(dir, 'server.log')
      createFileSink(path).write('secretish\n')
      // mask to permission bits
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('re-enforces 0o600 on a pre-existing world-readable file (MEDIUM-1)', () => {
    const dir = tmpDir()
    try {
      const path = join(dir, 'server.log')
      // File exists with loose perms before the sink ever writes.
      writeFileSync(path, 'old\n')
      chmodSync(path, 0o644)
      createFileSink(path).write('new\n')
      expect(statSync(path).mode & 0o777).toBe(0o600)
      // Existing content preserved (append, not truncate).
      expect(readFileSync(path, 'utf8')).toBe('old\nnew\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('does not rotate when the line lands exactly on maxBytes', () => {
    const dir = tmpDir()
    try {
      const path = join(dir, 'server.log')
      const sink = createFileSink(path, { maxBytes: 10, maxFiles: 2 })
      sink.write('123456789\n') // 10 bytes — fits, no rotation yet
      expect(existsSync(`${path}.1`)).toBe(false)
      expect(readFileSync(path, 'utf8')).toBe('123456789\n')
      // size(10) + 1 byte > 10 → next write rotates
      sink.write('x\n')
      expect(readFileSync(`${path}.1`, 'utf8')).toBe('123456789\n')
      expect(readFileSync(path, 'utf8')).toBe('x\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('counts multibyte (cyrillic / emoji) by byte length, not char count', () => {
    const dir = tmpDir()
    try {
      const path = join(dir, 'server.log')
      // 'привет' is 6 chars but 12 bytes in UTF-8.
      const line = 'привет\n' // 12 + 1 = 13 bytes
      const sink = createFileSink(path, { maxBytes: 15, maxFiles: 2 })
      sink.write(line) // 13 bytes, fits
      sink.write('👀\n') // emoji 4 bytes + 1 → would push past 15 → rotate
      expect(readFileSync(`${path}.1`, 'utf8')).toBe(line)
      expect(readFileSync(path, 'utf8')).toBe('👀\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('maxFiles=0 truncates with no retention copies', () => {
    const dir = tmpDir()
    try {
      const path = join(dir, 'server.log')
      const sink = createFileSink(path, { maxBytes: 5, maxFiles: 0 })
      sink.write('aaaa\n') // 5 bytes
      sink.write('bbbb\n') // rotate: no retention → old file unlinked
      expect(readFileSync(path, 'utf8')).toBe('bbbb\n')
      expect(existsSync(`${path}.1`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('keeps appending correctly across several rotations', () => {
    const dir = tmpDir()
    try {
      const path = join(dir, 'server.log')
      const sink = createFileSink(path, { maxBytes: 5, maxFiles: 3 })
      for (const s of ['aaaa\n', 'bbbb\n', 'cccc\n', 'dddd\n']) sink.write(s)
      expect(readFileSync(path, 'utf8')).toBe('dddd\n')
      expect(readFileSync(`${path}.1`, 'utf8')).toBe('cccc\n')
      expect(readFileSync(`${path}.2`, 'utf8')).toBe('bbbb\n')
      expect(readFileSync(`${path}.3`, 'utf8')).toBe('aaaa\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('never throws on an unwritable path', () => {
    // A path whose parent is an existing *file* cannot be mkdir'd or written.
    const dir = tmpDir()
    try {
      const blocker = join(dir, 'blocker')
      writeFileSync(blocker, 'i am a file')
      const sink = createFileSink(join(blocker, 'server.log'))
      expect(() => sink.write('x\n')).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('createLogger fileSink integration', () => {
  test('tees redacted lines to both stream and file sink', () => {
    const dir = tmpDir()
    try {
      const path = join(dir, 'server.log')
      const captured: string[] = []
      const stream = { write: (s: string) => { captured.push(s); return true } } as unknown as NodeJS.WritableStream
      const log = createLogger('test', {
        stream,
        fileSink: createFileSink(path),
        secrets: ['supersecret-token'],
      })
      log.info('hello', { token: 'supersecret-token', n: 1 })

      const fileContent = readFileSync(path, 'utf8')
      // Same content reached both sinks.
      expect(captured.join('')).toBe(fileContent)
      // Redaction applied before the file write — the secret is gone.
      expect(fileContent).not.toContain('supersecret-token')
      expect(fileContent).toContain('[info]')
      expect(fileContent).toContain('hello')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('without a fileSink, nothing is written to disk', () => {
    const captured: string[] = []
    const stream = { write: (s: string) => { captured.push(s); return true } } as unknown as NodeJS.WritableStream
    const log = createLogger('test', { stream })
    log.warn('no sink here')
    expect(captured.join('')).toContain('no sink here')
  })

  test('a throwing fileSink never takes the logger down', () => {
    const captured: string[] = []
    const stream = { write: (s: string) => { captured.push(s); return true } } as unknown as NodeJS.WritableStream
    const badSink = { write: () => { throw new Error('disk on fire') } }
    const log = createLogger('test', { stream, fileSink: badSink })
    expect(() => log.error('still alive')).not.toThrow()
    expect(captured.join('')).toContain('still alive')
  })
})

describe('resolveFileSink', () => {
  test('defaults to enabled with shared default limits when block omitted', () => {
    const config = loadConfig({ TELEGRAM_BOT_TOKEN: 'x' })
    expect(config.logging).toBeUndefined()
    const resolved = resolveFileSink(config)
    expect(resolved).toEqual({
      enabled: true,
      maxBytes: DEFAULT_LOG_MAX_BYTES,
      maxFiles: DEFAULT_LOG_MAX_FILES,
    })
  })

  test('TELEGRAM_LOG_FILE_SINK=0 disables the sink', () => {
    const config = loadConfig({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_LOG_FILE_SINK: '0' })
    expect(resolveFileSink(config).enabled).toBe(false)
  })

  test('TELEGRAM_LOG_FILE_PATH overrides the path', () => {
    const config = loadConfig({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_LOG_FILE_PATH: '/tmp/custom.log' })
    expect(resolveFileSink(config).path).toBe('/tmp/custom.log')
  })

  test('partial config.json block gets inner Zod schema defaults', () => {
    // A config.json that sets only `enabled` — Zod must fill max_bytes /
    // max_files from the inner defaults (the SAME constants resolveFileSink
    // uses), proving the two default paths cannot drift.
    const config = AppConfigSchema.parse({ logging: { file_sink: { enabled: true } } })
    const resolved = resolveFileSink(config)
    expect(resolved.enabled).toBe(true)
    expect(resolved.maxBytes).toBe(DEFAULT_LOG_MAX_BYTES)
    expect(resolved.maxFiles).toBe(DEFAULT_LOG_MAX_FILES)
  })

  test('explicit limits in the parsed block win over defaults', () => {
    const config = AppConfigSchema.parse({
      logging: { file_sink: { enabled: true, max_bytes: 1234, max_files: 2 } },
    })
    const resolved = resolveFileSink(config)
    expect(resolved.maxBytes).toBe(1234)
    expect(resolved.maxFiles).toBe(2)
  })
})
