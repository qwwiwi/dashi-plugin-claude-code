// Media descriptor + voice transcription tests.
//
// Covers:
//   - safeMediaName strips the same characters server.ts:safeName drops
//   - renderMediaDescriptor for every kind emits well-formed <media ... />
//   - attribute escaping handles quotes/<>/& without corrupting structure
//   - undefined attributes are omitted (no orphan `name=""` for example)
//   - maybeTranscribeVoice handles missing key without crashing
//   - maybeTranscribeVoice returns ok / failed paths with stub fetch
//   - GROQ_API_KEY is redacted in every error path

import { describe, expect, test } from 'bun:test'

import {
  maybeTranscribeVoice,
  renderMediaDescriptor,
  safeMediaName,
  type MediaDescriptor,
} from '../../src/telegram/media.js'
import type { AppConfig } from '../../src/config.js'

// Minimal AppConfig stub — only voice.* is touched by media.ts. Other
// fields stay structural so the type-check passes without recreating the
// full default tree.
const voiceConfig: AppConfig = {
  bot_id: 1,
  dm_only: true,
  allowed_user_ids: [1],
  allowed_chat_ids: [1],
  status: { enabled: true, interval_ms: 700, ttl_ms: 300_000, delete_on_complete: true, suppress_typing_bubble: false },
  album: { flush_ms: 2000 },
  voice: { provider: 'groq', language: 'ru', model: 'whisper-large-v3-turbo' },
  webhook: { enabled: false, host: '127.0.0.1', port: 0 },
  permission_relay: { enabled: true, allowed_user_ids: [1], bash_only_proof: true },
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
}

// ─────────────────────────────────────────────────────────────────────
// safeMediaName
// ─────────────────────────────────────────────────────────────────────

describe('safeMediaName', () => {
  test('strips dangerous chars from filename', () => {
    expect(safeMediaName('a<b>c[d]e;f\rg\nh')).toBe('a_b_c_d_e_f_g_h')
  })
  test('returns undefined for falsy', () => {
    expect(safeMediaName(undefined)).toBeUndefined()
    expect(safeMediaName('')).toBeUndefined()
  })
  test('keeps benign filenames unchanged', () => {
    expect(safeMediaName('report-2026-05-15.pdf')).toBe('report-2026-05-15.pdf')
  })
})

// ─────────────────────────────────────────────────────────────────────
// renderMediaDescriptor
// ─────────────────────────────────────────────────────────────────────

describe('renderMediaDescriptor', () => {
  test('builds photo tag with width/height/local_path', () => {
    const md: MediaDescriptor = {
      kind: 'photo',
      fileId: 'photoFile1',
      width: 1280,
      height: 720,
      localPath: '/abs/inbox/123-abc.jpg',
    }
    const out = renderMediaDescriptor(md)
    expect(out).toBe(
      '<media kind="photo" file_id="photoFile1" width="1280" height="720" local_path="/abs/inbox/123-abc.jpg" />',
    )
  })

  test('builds document tag with name/mime/size', () => {
    const md: MediaDescriptor = {
      kind: 'document',
      fileId: 'docF',
      name: 'foo.pdf',
      mime: 'application/pdf',
      size: 12345,
    }
    const out = renderMediaDescriptor(md)
    expect(out).toBe(
      '<media kind="document" file_id="docF" name="foo.pdf" mime="application/pdf" size="12345" />',
    )
  })

  test('builds voice tag with transcript when status=ok', () => {
    const md: MediaDescriptor = {
      kind: 'voice',
      fileId: 'voiceF',
      mime: 'audio/ogg',
      size: 12345,
      durationSec: 5,
      transcript: 'привет мой принц',
      transcriptionStatus: 'ok',
    }
    const out = renderMediaDescriptor(md)
    expect(out).toBe(
      '<media kind="voice" file_id="voiceF" mime="audio/ogg" size="12345" duration_sec="5" transcript="привет мой принц" transcription_status="ok" />',
    )
  })

  test('builds voice tag with transcription_status=missing_key when no key', () => {
    const md: MediaDescriptor = {
      kind: 'voice',
      fileId: 'voiceF2',
      durationSec: 5,
      transcriptionStatus: 'missing_key',
    }
    const out = renderMediaDescriptor(md)
    expect(out).toBe(
      '<media kind="voice" file_id="voiceF2" duration_sec="5" transcription_status="missing_key" />',
    )
    // No phantom transcript attribute.
    expect(out).not.toContain('transcript=')
  })

  test('builds video tag', () => {
    const md: MediaDescriptor = {
      kind: 'video',
      fileId: 'vF',
      mime: 'video/mp4',
      durationSec: 30,
      width: 640,
      height: 480,
    }
    const out = renderMediaDescriptor(md)
    expect(out).toContain('kind="video"')
    expect(out).toContain('width="640"')
    expect(out).toContain('height="480"')
    expect(out).toContain('duration_sec="30"')
  })

  test('builds sticker tag with emoji and set_name', () => {
    const md: MediaDescriptor = {
      kind: 'sticker',
      fileId: 'sF',
      emoji: '🔥',
      setName: 'orgrimmar_pack',
      size: 4096,
    }
    const out = renderMediaDescriptor(md)
    expect(out).toBe(
      '<media kind="sticker" file_id="sF" emoji="🔥" set_name="orgrimmar_pack" size="4096" />',
    )
  })

  test('builds video_note tag', () => {
    const md: MediaDescriptor = {
      kind: 'video_note',
      fileId: 'vnF',
      size: 1024,
      durationSec: 12,
    }
    expect(renderMediaDescriptor(md)).toBe(
      '<media kind="video_note" file_id="vnF" size="1024" duration_sec="12" />',
    )
  })

  test('omits undefined attributes', () => {
    const md: MediaDescriptor = {
      kind: 'document',
      fileId: 'd',
    }
    const out = renderMediaDescriptor(md)
    // Only kind + file_id should appear.
    expect(out).toBe('<media kind="document" file_id="d" />')
    expect(out).not.toContain('name=')
    expect(out).not.toContain('mime=')
    expect(out).not.toContain('size=')
  })

  test('escapes attribute values containing quotes and angle brackets', () => {
    const md: MediaDescriptor = {
      kind: 'document',
      fileId: 'd',
      name: 'evil".pdf',
      mime: 'application/x<script>',
    }
    const out = renderMediaDescriptor(md)
    // Quote is HTML-encoded so it never closes the attribute early.
    expect(out).toContain('name="evil&quot;.pdf"')
    expect(out).toContain('mime="application/x&lt;script&gt;"')
    // Outer structure intact — exactly one self-close.
    expect(out.match(/\/>/g)).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────
// maybeTranscribeVoice
// ─────────────────────────────────────────────────────────────────────

describe('maybeTranscribeVoice', () => {
  test('returns missing_key when GROQ_API_KEY absent', async () => {
    const r = await maybeTranscribeVoice(
      {
        fileId: 'v1',
        downloadFile: async () => {
          throw new Error('should not be called when key missing')
        },
      },
      voiceConfig,
      {},
    )
    expect(r.status).toBe('missing_key')
    expect(r.transcript).toBeUndefined()
  })

  test('returns skipped when file size exceeds 25MB', async () => {
    const r = await maybeTranscribeVoice(
      {
        fileId: 'big',
        size: 30 * 1024 * 1024,
        downloadFile: async () => {
          throw new Error('should not download when oversized')
        },
      },
      voiceConfig,
      { GROQ_API_KEY: 'gsk_test_key' },
    )
    expect(r.status).toBe('skipped')
    expect(r.errorMessage).toContain('file too large')
  })

  test('returns ok with stubbed groq fetch returning text', async () => {
    let fetchedUrl = ''
    let authHeader = ''
    const r = await maybeTranscribeVoice(
      {
        fileId: 'v',
        size: 1000,
        mime: 'audio/ogg',
        downloadFile: async () => ({ path: '/tmp/voice.ogg', size: 1000, mime: 'audio/ogg' }),
        readFile: async () => new Uint8Array([1, 2, 3, 4]),
        fetchImpl: (async (url: string | URL, init?: RequestInit) => {
          fetchedUrl = String(url)
          const headers = (init?.headers ?? {}) as Record<string, string>
          authHeader = headers.Authorization ?? ''
          return new Response('  hello world  ', { status: 200 })
        }) as unknown as typeof fetch,
      },
      voiceConfig,
      { GROQ_API_KEY: 'gsk_test_key_123' },
    )
    expect(r.status).toBe('ok')
    expect(r.transcript).toBe('hello world')
    expect(fetchedUrl).toContain('api.groq.com')
    expect(authHeader).toContain('Bearer ')
  })

  test('normalizes .oga filename to .ogg before upload (Groq rejects .oga)', async () => {
    let observedFilename = ''
    const r = await maybeTranscribeVoice(
      {
        fileId: 'v',
        size: 1000,
        mime: 'audio/ogg',
        downloadFile: async () => ({
          path: '/tmp/1778868174636-AgADD5kAAr_COEg.oga',
          size: 1000,
          mime: 'audio/ogg',
        }),
        readFile: async () => new Uint8Array([1, 2, 3, 4]),
        fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
          const body = init?.body as FormData
          const file = body.get('file') as File
          observedFilename = file.name
          return new Response('ok transcript', { status: 200 })
        }) as unknown as typeof fetch,
      },
      voiceConfig,
      { GROQ_API_KEY: 'gsk_test_key' },
    )
    expect(r.status).toBe('ok')
    expect(observedFilename).toMatch(/\.ogg$/)
    expect(observedFilename).not.toMatch(/\.oga$/)
  })

  test('returns failed on stubbed fetch error', async () => {
    const r = await maybeTranscribeVoice(
      {
        fileId: 'v',
        size: 1000,
        downloadFile: async () => ({ path: '/tmp/voice.ogg', size: 1000 }),
        readFile: async () => new Uint8Array([0]),
        fetchImpl: (async () => {
          throw new Error('network down')
        }) as unknown as typeof fetch,
      },
      voiceConfig,
      { GROQ_API_KEY: 'gsk_test_key' },
    )
    expect(r.status).toBe('failed')
    expect(r.errorMessage).toContain('network down')
  })

  test('returns failed with HTTP status on non-2xx response', async () => {
    const r = await maybeTranscribeVoice(
      {
        fileId: 'v',
        size: 1000,
        downloadFile: async () => ({ path: '/tmp/voice.ogg', size: 1000 }),
        readFile: async () => new Uint8Array([0]),
        fetchImpl: (async () =>
          new Response('rate limited', { status: 429 })) as unknown as typeof fetch,
      },
      voiceConfig,
      { GROQ_API_KEY: 'gsk_test_key' },
    )
    expect(r.status).toBe('failed')
    expect(r.errorMessage).toContain('429')
  })

  test('redacts GROQ_API_KEY in failure message', async () => {
    const secret = 'gsk_super_secret_token_AAAA1111'
    const r = await maybeTranscribeVoice(
      {
        fileId: 'v',
        size: 1000,
        downloadFile: async () => ({ path: '/tmp/voice.ogg', size: 1000 }),
        readFile: async () => new Uint8Array([0]),
        fetchImpl: (async () => {
          // Simulate a transport that echoes the auth header into the error
          // — exactly the leak class we are guarding against.
          throw new Error(`upstream rejected Bearer ${secret} at line 7`)
        }) as unknown as typeof fetch,
      },
      voiceConfig,
      { GROQ_API_KEY: secret },
    )
    expect(r.status).toBe('failed')
    expect(r.errorMessage).toBeDefined()
    expect(r.errorMessage).not.toContain(secret)
    expect(r.errorMessage).toContain('[REDACTED]')
  })

  test('redacts GROQ_API_KEY from non-OK response body', async () => {
    const secret = 'gsk_echo_back_BBBB2222'
    const r = await maybeTranscribeVoice(
      {
        fileId: 'v',
        size: 1000,
        downloadFile: async () => ({ path: '/tmp/voice.ogg', size: 1000 }),
        readFile: async () => new Uint8Array([0]),
        fetchImpl: (async () =>
          new Response(`bad auth header: Bearer ${secret}`, { status: 401 })) as unknown as typeof fetch,
      },
      voiceConfig,
      { GROQ_API_KEY: secret },
    )
    expect(r.status).toBe('failed')
    expect(r.errorMessage).not.toContain(secret)
  })

  test('returns skipped when voice provider disabled in config', async () => {
    const cfg: AppConfig = { ...voiceConfig, voice: { ...voiceConfig.voice, provider: 'none' } }
    const r = await maybeTranscribeVoice(
      {
        fileId: 'v',
        downloadFile: async () => {
          throw new Error('should not download when provider=none')
        },
      },
      cfg,
      { GROQ_API_KEY: 'gsk_test_key' },
    )
    expect(r.status).toBe('skipped')
  })
})
