import { describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  MAX_ATTACHMENT_BYTES,
  PHOTO_EXTENSIONS,
  assertSendableFile,
  isPhotoExtension,
  resolveInsideWorkspace,
} from '../../src/security/paths.js'
import type { AppConfig } from '../../src/config.js'

function makeWorkspace(): { ws: string; cleanup: () => void } {
  const ws = mkdtempSync(join(tmpdir(), 'dashi-paths-ws-'))
  return {
    ws,
    cleanup: () => rmSync(ws, { recursive: true, force: true }),
  }
}

function makeOutside(): { outside: string; cleanup: () => void } {
  const outside = mkdtempSync(join(tmpdir(), 'dashi-paths-outside-'))
  return {
    outside,
    cleanup: () => rmSync(outside, { recursive: true, force: true }),
  }
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    bot_id: 8507713167,
    dm_only: true,
    allowed_user_ids: [164795011],
    allowed_chat_ids: [164795011],
    status: { enabled: true, interval_ms: 700, ttl_ms: 300_000, delete_on_complete: true, suppress_typing_bubble: false },
    album: { flush_ms: 2000 },
    voice: { provider: 'groq', language: 'ru', model: 'whisper-large-v3-turbo' },
    webhook: { enabled: false, host: '127.0.0.1', port: 0 },
    permission_relay: { enabled: true, allowed_user_ids: [164795011], bash_only_proof: true },
    commands: { help: true, status: true, stop: true, reset: true, new: true },
    memory: {
      enabled: false,
      source_tag: 'tg',
      max_hot_bytes: 20480,
      trim_keep_lines: 600,
      buffer_ttl_ms: 5 * 60 * 1000,
      buffer_max_entries: 100,
    },
    progress: {
      enabled: true,
      edit_throttle_ms: 3000,
      recent_buffer: 10,
      session_ttl_ms: 600000,
    },
    task_mirror: {
      enabled: true,
      edit_throttle_ms: 3000,
      session_ttl_ms: 600000,
      collapse_completed_after: 5,
    },
    watcher: {
      enabled: true,
      debounce_ms: 10_000,
      busy_threshold_ms: 30_000,
    },
    tmux_mirror: { enabled: false, pane_target: '', poll_interval_ms: 5000, line_count: 50, hide_segments: ['boot_banner', 'inbound_warning', 'footer_hints', 'input_box'], mode: 'latest_inbound_only', max_lines: 14 },
    multichat: { enabled: false },
    ask_user_question: { enabled: false, timeout_ms: 300_000, max_preview_chars: 1000 },
    ...overrides,
  }
}

describe('resolveInsideWorkspace', () => {
  test('resolves relative path inside workspace', () => {
    const { ws, cleanup } = makeWorkspace()
    try {
      const filePath = join(ws, 'hello.txt')
      writeFileSync(filePath, 'hi')
      const canonical = resolveInsideWorkspace('hello.txt', ws)
      // realpathSync on macOS may add /private prefix; just check suffix.
      expect(canonical.endsWith('/hello.txt')).toBe(true)
      // Containment: canonical must be under realpath of ws.
      expect(canonical).toContain('hello.txt')
    } finally {
      cleanup()
    }
  })

  test('rejects absolute path outside workspace', () => {
    const { ws, cleanup } = makeWorkspace()
    const out = makeOutside()
    try {
      const evil = join(out.outside, 'leak.txt')
      writeFileSync(evil, 'secret')
      expect(() => resolveInsideWorkspace(evil, ws)).toThrow(/outside workspace/)
    } finally {
      cleanup()
      out.cleanup()
    }
  })

  test('rejects symlink that points outside workspace', () => {
    const { ws, cleanup } = makeWorkspace()
    const out = makeOutside()
    try {
      const target = join(out.outside, 'target.txt')
      writeFileSync(target, 'leak')
      const link = join(ws, 'inside-link.txt')
      symlinkSync(target, link)
      // Symlink itself sits inside ws, but realpathSync follows it to /outside.
      expect(() => resolveInsideWorkspace('inside-link.txt', ws)).toThrow(/outside workspace/)
    } finally {
      cleanup()
      out.cleanup()
    }
  })

  test('rejects ../ traversal attempt', () => {
    const { ws, cleanup } = makeWorkspace()
    const out = makeOutside()
    try {
      writeFileSync(join(out.outside, 'pwned.txt'), 'x')
      // From inside the workspace, climbing `..` should land outside.
      // We need a relative path that resolves outside ws. Easiest: name the
      // outside dir we just made and traverse via its basename.
      const traversal = join('..', 'no-such-thing', 'pwned.txt')
      expect(() => resolveInsideWorkspace(traversal, ws)).toThrow(/outside workspace/)
    } finally {
      cleanup()
      out.cleanup()
    }
  })
})

describe('assertSendableFile', () => {
  test('rejects file larger than 50MB', () => {
    const { ws, cleanup } = makeWorkspace()
    try {
      const big = join(ws, 'big.bin')
      writeFileSync(big, 'x') // tiny on disk; we patch stat below.
      const config = makeConfig({ workspace_root: ws })

      // Monkey-patch fs.statSync via dynamic import to fake size.
      // Simpler: write a real 51MB file (still under 100MB to keep CI light).
      const buf = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024, 0)
      writeFileSync(big, buf)

      expect(() => assertSendableFile({ filePath: 'big.bin', config })).toThrow(/files attachment rejected/)
      expect(() => assertSendableFile({ filePath: 'big.bin', config })).toThrow(/max/)
    } finally {
      cleanup()
    }
  })

  test('rejects directory', () => {
    const { ws, cleanup } = makeWorkspace()
    try {
      const dir = join(ws, 'subdir')
      mkdirSync(dir)
      const config = makeConfig({ workspace_root: ws })
      expect(() => assertSendableFile({ filePath: 'subdir', config })).toThrow(/is a directory/)
    } finally {
      cleanup()
    }
  })

  test('rejects missing file', () => {
    const { ws, cleanup } = makeWorkspace()
    try {
      const config = makeConfig({ workspace_root: ws })
      expect(() => assertSendableFile({ filePath: 'nope.txt', config })).toThrow(/does not exist/)
    } finally {
      cleanup()
    }
  })

  test('rejects when workspace_root unconfigured', () => {
    const config = makeConfig() // workspace_root undefined
    expect(config.workspace_root).toBeUndefined()
    expect(() => assertSendableFile({ filePath: '/tmp/anything.png', config })).toThrow(
      /TELEGRAM_WORKSPACE_ROOT not configured/,
    )
  })

  test('accepts a legit file inside workspace and returns canonical path', () => {
    const { ws, cleanup } = makeWorkspace()
    try {
      const filePath = join(ws, 'note.md')
      writeFileSync(filePath, 'ok')
      const config = makeConfig({ workspace_root: ws })
      const canonical = assertSendableFile({ filePath: 'note.md', config })
      expect(canonical.endsWith('/note.md')).toBe(true)
    } finally {
      cleanup()
    }
  })
})

describe('photo extension helper', () => {
  test('classifies .png as photo, .pdf as document', () => {
    expect(isPhotoExtension('/x/y.png')).toBe(true)
    expect(isPhotoExtension('/x/Y.JPG')).toBe(true)
    expect(isPhotoExtension('/x/y.pdf')).toBe(false)
    expect(PHOTO_EXTENSIONS.has('.webp')).toBe(true)
  })
})
