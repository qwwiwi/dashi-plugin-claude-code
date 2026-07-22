// Unit tests for the shared media-descriptor builders
// (src/telegram/media-descriptors.ts).
//
// These builders are the single source of truth reused by three call sites:
//   - own-message handlers (eager: photo download, voice transcribe)
//   - Guest Mode own media (eager)
//   - reply-target media (metadata only — never download/transcribe)
//
// The security-critical property under test: the metadata-only path emits
// NO local_path on photos and status='skipped' on voice (no Groq call), while
// the eager path enriches both.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  buildAnimationDescriptor,
  buildAudioDescriptor,
  buildOwnMediaDescriptors,
  buildPhotoDescriptor,
  buildPhotoMeta,
  buildReplyMediaDescriptors,
  buildVoiceDescriptor,
  buildVoiceMeta,
  type MediaSource,
  type PhotoDownloadDeps,
  type VoiceTranscribeDeps,
} from '../../src/telegram/media-descriptors.js'
import { renderMediaDescriptor, type BotApiForDownload } from '../../src/telegram/media.js'
import type { AppConfig } from '../../src/config.js'
import { createLogger } from '../../src/log.js'

const silentLog = createLogger('test', {
  stream: { write: () => true } as unknown as NodeJS.WritableStream,
})

const voiceConfig = {
  voice: { provider: 'groq', language: 'ru', model: 'whisper-large-v3-turbo' },
} as unknown as AppConfig

describe('buildAnimationDescriptor', () => {
  test('maps every field like video', () => {
    const md = buildAnimationDescriptor({
      file_id: 'A1',
      file_unique_id: 'u',
      width: 320,
      height: 240,
      duration: 3,
      file_name: 'g.mp4',
      mime_type: 'video/mp4',
      file_size: 4096,
    })
    expect(md).toHaveLength(1)
    expect(renderMediaDescriptor(md[0]!)).toBe(
      '<media kind="animation" file_id="A1" name="g.mp4" mime="video/mp4" size="4096" duration_sec="3" width="320" height="240" />',
    )
  })

  test('undefined → empty array', () => {
    expect(buildAnimationDescriptor(undefined)).toEqual([])
  })
})

describe('metadata-only builders (reply-target path)', () => {
  test('buildPhotoMeta picks largest size and omits local_path', () => {
    const md = buildPhotoMeta([
      { file_id: 'small', file_unique_id: 's', width: 90, height: 90 },
      { file_id: 'big', file_unique_id: 'b', width: 1280, height: 720, file_size: 500 },
    ])
    expect(md).toHaveLength(1)
    const rendered = renderMediaDescriptor(md[0]!)
    expect(rendered).toContain('file_id="big"')
    expect(rendered).not.toContain('local_path')
  })

  test('buildVoiceMeta emits transcription_status="skipped" and no transcript', () => {
    const md = buildVoiceMeta({ file_id: 'V1', file_unique_id: 'v', duration: 4 })
    const rendered = renderMediaDescriptor(md[0]!)
    expect(rendered).toContain('transcription_status="skipped"')
    expect(rendered).not.toContain('transcript=')
  })

  test('buildReplyMediaDescriptors on a photo yields metadata only — no local_path', () => {
    const src: MediaSource = {
      photo: [{ file_id: 'P1', file_unique_id: 'p', width: 100, height: 100 }],
    }
    const out = buildReplyMediaDescriptors(src).map(renderMediaDescriptor)
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('kind="photo"')
    expect(out[0]).toContain('file_id="P1"')
    expect(out[0]).not.toContain('local_path')
  })

  test('buildReplyMediaDescriptors on a document forwards metadata verbatim', () => {
    const out = buildReplyMediaDescriptors({
      document: { file_id: 'D1', file_unique_id: 'd', file_name: 'a.pdf', mime_type: 'application/pdf' },
    }).map(renderMediaDescriptor)
    expect(out[0]).toBe('<media kind="document" file_id="D1" name="a.pdf" mime="application/pdf" />')
  })

  test('buildReplyMediaDescriptors on empty source → empty', () => {
    expect(buildReplyMediaDescriptors({})).toEqual([])
  })

  test('buildReplyMediaDescriptors on a GIF de-dups the document twin — only animation', () => {
    // A GIF arrives with BOTH `animation` and a back-compat `document`; the
    // reply aggregator must emit the animation once and drop the twin.
    const out = buildReplyMediaDescriptors({
      animation: { file_id: 'A1', file_unique_id: 'a', width: 320, height: 240, duration: 3, file_name: 'g.mp4', mime_type: 'video/mp4' },
      document: { file_id: 'A1', file_unique_id: 'a', file_name: 'g.mp4', mime_type: 'video/mp4' },
    }).map(renderMediaDescriptor)
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('kind="animation"')
    expect(out.some((s) => s.includes('kind="document"'))).toBe(false)
  })
})

describe('buildPhotoDescriptor (eager)', () => {
  test('downloads the largest size and attaches local_path', async () => {
    // Stub bot.api.getFile + monkeypatch global fetch so downloadPhotoToInbox
    // writes a real temp file without touching the network.
    const botApi: BotApiForDownload = {
      api: {
        getFile: async (fileId: string) => ({
          file_id: fileId,
          file_unique_id: 'u',
          file_path: 'photos/file_1.jpg',
          file_size: 100,
        }),
      },
    }
    const inboxDir = mkdtempSync(join(tmpdir(), 'md-photo-'))
    const deps: PhotoDownloadDeps = { botApi, botToken: 'tok', inboxDir }

    const origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })) as unknown as typeof fetch
    try {
      const md = await buildPhotoDescriptor(
        [{ file_id: 'big', file_unique_id: 'b', width: 1280, height: 720, file_size: 100 }],
        deps,
      )
      expect(md).toHaveLength(1)
      expect(md[0]!.kind).toBe('photo')
      const rendered = renderMediaDescriptor(md[0]!)
      expect(rendered).toContain('local_path=')
      // The downloaded file actually exists on disk.
      const localPath = md[0]!.kind === 'photo' ? md[0]!.localPath : undefined
      expect(localPath).toBeDefined()
      expect(existsSync(localPath!)).toBe(true)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test('download failure → descriptor WITHOUT local_path (no throw)', async () => {
    const botApi: BotApiForDownload = {
      api: { getFile: async () => ({}) }, // no file_path → download yields undefined
    }
    const deps: PhotoDownloadDeps = { botApi, botToken: 'tok', inboxDir: '/nope' }
    const md = await buildPhotoDescriptor(
      [{ file_id: 'big', file_unique_id: 'b', width: 10, height: 10 }],
      deps,
    )
    expect(md).toHaveLength(1)
    expect(renderMediaDescriptor(md[0]!)).not.toContain('local_path')
  })
})

describe('buildVoiceDescriptor (eager)', () => {
  test('no GROQ key → transcription_status="missing_key" (attempted, no crash)', async () => {
    const deps: VoiceTranscribeDeps = {
      config: voiceConfig,
      env: {},
      downloadFile: async () => {
        throw new Error('should not download without a key')
      },
      log: silentLog,
    }
    const md = await buildVoiceDescriptor(
      { file_id: 'V1', file_unique_id: 'v', duration: 5 },
      deps,
    )
    expect(renderMediaDescriptor(md[0]!)).toContain('transcription_status="missing_key"')
  })
})

describe('buildOwnMediaDescriptors (eager aggregator)', () => {
  test('forwards non-photo/voice kinds unchanged', async () => {
    const deps = {
      photo: { botApi: { api: { getFile: async () => ({}) } }, botToken: 't', inboxDir: '/x' },
      voice: {
        config: voiceConfig,
        env: {},
        downloadFile: async () => ({ path: '/x', size: 1 }),
        log: silentLog,
      },
    }
    const out = await buildOwnMediaDescriptors(
      { audio: { file_id: 'AU1', file_unique_id: 'a', duration: 60, title: 'Song' } },
      deps as unknown as Parameters<typeof buildOwnMediaDescriptors>[1],
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual(buildAudioDescriptor({ file_id: 'AU1', file_unique_id: 'a', duration: 60, title: 'Song' })[0])
  })

  test('on a GIF de-dups the document twin — only animation, no double download', async () => {
    const deps = {
      photo: { botApi: { api: { getFile: async () => ({}) } }, botToken: 't', inboxDir: '/x' },
      voice: {
        config: voiceConfig,
        env: {},
        downloadFile: async () => ({ path: '/x', size: 1 }),
        log: silentLog,
      },
    }
    const out = (await buildOwnMediaDescriptors(
      {
        animation: { file_id: 'A1', file_unique_id: 'a', width: 320, height: 240, duration: 3 },
        document: { file_id: 'A1', file_unique_id: 'a', file_name: 'g.mp4', mime_type: 'video/mp4' },
      },
      deps as unknown as Parameters<typeof buildOwnMediaDescriptors>[1],
    )).map(renderMediaDescriptor)
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('kind="animation"')
  })
})
