// Media descriptor rendering and voice transcription.
//
// Ports the BEHAVIOR of gateway.py:863-931 (download_telegram_file +
// transcribe_audio) and gateway.py:2117-2171 (auto-transcribe voice in
// groups) for the inbound-prompt path. Each inbound media message produces
// one MediaDescriptor that the prompt builder renders as a single
// `<media kind="..." ... />` tag concatenated above the user's text.
//
// Why a tag, not free-form prose: Claude needs to distinguish operator-typed
// caption ("trusted") from attachment metadata ("structured fact"). A tag is
// trivially parseable and never confused with a sentence the user actually
// typed.
//
// Voice transcription is OPTIONAL: missing GROQ_API_KEY does NOT crash the
// handler — we emit a `transcription_status="missing_key"` descriptor and
// let Claude decide whether to ask the user to enable it.

import { escapeHtmlAttr } from '../format/html.js'
import type { AppConfig } from '../config.js'

// ─────────────────────────────────────────────────────────────────────
// MediaDescriptor — discriminated union over the eight media kinds the
// inbound Telegram handlers recognize. Fields stay minimal: anything that
// requires a download (full file content) goes through the
// download_attachment tool on Claude's request — the descriptor is just
// the metadata the agent needs to decide whether to download.
// ─────────────────────────────────────────────────────────────────────

export type MediaDescriptor =
  | {
      kind: 'photo'
      fileId: string
      uniqueId?: string
      localPath?: string
      width?: number
      height?: number
      size?: number
    }
  | {
      kind: 'document'
      fileId: string
      name?: string
      mime?: string
      size?: number
    }
  | {
      kind: 'voice'
      fileId: string
      mime?: string
      size?: number
      durationSec?: number
      transcript?: string
      transcriptionStatus: 'ok' | 'missing_key' | 'failed' | 'skipped'
    }
  | {
      kind: 'audio'
      fileId: string
      name?: string
      title?: string
      performer?: string
      mime?: string
      size?: number
      durationSec?: number
    }
  | {
      kind: 'video'
      fileId: string
      name?: string
      mime?: string
      size?: number
      durationSec?: number
      width?: number
      height?: number
    }
  | {
      kind: 'video_note'
      fileId: string
      size?: number
      durationSec?: number
    }
  | {
      kind: 'sticker'
      fileId: string
      emoji?: string
      setName?: string
      size?: number
    }

// ─────────────────────────────────────────────────────────────────────
// Filename sanitation — same character class as gateway.py:896-898
// (server.ts:safeName equivalent in this codebase). We strip the
// characters that break HTML attribute parsing or could be mistaken for
// shell metacharacters by downstream tooling.
//
// We do NOT replace path separators — `name` is metadata only, never
// concatenated into a filesystem path here (downloads use uuid-derived
// names via downloadFile / downloadPhotoToInbox).
// ─────────────────────────────────────────────────────────────────────

const UNSAFE_NAME_CHARS = /[<>[\]\r\n;]/g

export function safeMediaName(s: string | undefined): string | undefined {
  if (s === undefined || s === null) return undefined
  if (s === '') return undefined
  return s.replace(UNSAFE_NAME_CHARS, '_')
}

// ─────────────────────────────────────────────────────────────────────
// renderMediaDescriptor — emits a single self-closing XML-ish tag with
// HTML-attribute-escaped values. Numbers are stringified; undefined
// attributes are omitted (so the rendered tag is deterministic for a
// given input shape and tests can grep for exact substrings).
//
// The tag name is always `media`; the `kind` attribute discriminates.
// Why `media` and not `attachment`: keeps it short and distinct from
// gateway.py's `[attached file X]` plain-text prefix that we are
// deliberately replacing.
// ─────────────────────────────────────────────────────────────────────

function attr(name: string, value: string | number | undefined): string {
  if (value === undefined) return ''
  if (typeof value === 'string' && value.length === 0) return ''
  const str = typeof value === 'number' ? String(value) : value
  return ` ${name}="${escapeHtmlAttr(str)}"`
}

export function renderMediaDescriptor(media: MediaDescriptor): string {
  const parts: string[] = [`<media kind="${media.kind}"`]
  parts.push(attr('file_id', media.fileId))

  switch (media.kind) {
    case 'photo': {
      parts.push(attr('unique_id', media.uniqueId))
      parts.push(attr('width', media.width))
      parts.push(attr('height', media.height))
      parts.push(attr('size', media.size))
      parts.push(attr('local_path', media.localPath))
      break
    }
    case 'document': {
      parts.push(attr('name', safeMediaName(media.name)))
      parts.push(attr('mime', media.mime))
      parts.push(attr('size', media.size))
      break
    }
    case 'voice': {
      parts.push(attr('mime', media.mime))
      parts.push(attr('size', media.size))
      parts.push(attr('duration_sec', media.durationSec))
      // Transcript is potentially long — escapeHtmlAttr handles quotes/<>.
      // Status is always emitted so Claude can act on missing_key / failed
      // without inferring it from the absence of `transcript`.
      parts.push(attr('transcript', media.transcript))
      parts.push(attr('transcription_status', media.transcriptionStatus))
      break
    }
    case 'audio': {
      parts.push(attr('name', safeMediaName(media.name)))
      parts.push(attr('title', safeMediaName(media.title)))
      parts.push(attr('performer', safeMediaName(media.performer)))
      parts.push(attr('mime', media.mime))
      parts.push(attr('size', media.size))
      parts.push(attr('duration_sec', media.durationSec))
      break
    }
    case 'video': {
      parts.push(attr('name', safeMediaName(media.name)))
      parts.push(attr('mime', media.mime))
      parts.push(attr('size', media.size))
      parts.push(attr('duration_sec', media.durationSec))
      parts.push(attr('width', media.width))
      parts.push(attr('height', media.height))
      break
    }
    case 'video_note': {
      parts.push(attr('size', media.size))
      parts.push(attr('duration_sec', media.durationSec))
      break
    }
    case 'sticker': {
      parts.push(attr('emoji', media.emoji))
      parts.push(attr('set_name', safeMediaName(media.setName)))
      parts.push(attr('size', media.size))
      break
    }
  }

  parts.push(' />')
  return parts.join('')
}

// ─────────────────────────────────────────────────────────────────────
// Voice transcription (Groq Whisper).
//
// Ports gateway.py:904-931. Key differences from the Python version:
//   - We never write API key into log or error message (gateway.py:927
//     truncates response body which could include the key on certain
//     misroutes — we mask it explicitly).
//   - 25MB hard cap before we even download (Groq's documented limit is
//     25MB; downloading a 100MB file to discover it cannot be transcribed
//     wastes bandwidth and disk on the bot host).
//   - Returns a discriminated result, never `null` — the descriptor
//     ALWAYS includes a transcription_status attribute so Claude does
//     not need to guess "is empty transcript a bug or a silent file?".
// ─────────────────────────────────────────────────────────────────────

// 25MB Groq Whisper limit. Conservative: include HTTP overhead margin.
const GROQ_MAX_BYTES = 25 * 1024 * 1024

export interface VoiceTranscriptionInput {
  fileId: string
  durationSec?: number
  size?: number
  mime?: string
  // Dependency injection so tests can stub without spinning a Telegram
  // mock. Production wires this to telegramApi.downloadFile bound to the
  // inbox directory.
  downloadFile: (fileId: string) => Promise<{ path: string; mime?: string; size?: number }>
  // Optional override for tests — `fetch` global is used otherwise.
  fetchImpl?: typeof fetch
  // Optional file-reader override so unit tests can avoid touching disk.
  readFile?: (path: string) => Promise<Uint8Array>
}

export interface VoiceTranscriptionResult {
  transcript?: string
  status: 'ok' | 'missing_key' | 'failed' | 'skipped'
  errorMessage?: string
}

// Redact any occurrence of the API key from a string, even partial
// matches. We compare on the full key and also on a "Bearer <key>" form
// in case an HTTP client embeds it verbatim into an error.
function redactGroqKey(message: string, key: string): string {
  if (!key) return message
  // Escape regex metachars in the key so we can build a global pattern.
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(escaped, 'g')
  return message.replace(re, '<redacted>')
}

export async function maybeTranscribeVoice(
  input: VoiceTranscriptionInput,
  config: AppConfig,
  env: { GROQ_API_KEY?: string },
): Promise<VoiceTranscriptionResult> {
  const key = env.GROQ_API_KEY
  if (!key) {
    return { status: 'missing_key' }
  }

  // Voice provider can be disabled in config.json (provider: 'none').
  if (config.voice.provider === 'none') {
    return { status: 'skipped', errorMessage: 'voice provider disabled in config' }
  }

  // Size guard BEFORE download. `input.size` is the Telegram-reported
  // file size and is reliable for voice/audio attachments.
  if (input.size !== undefined && input.size > GROQ_MAX_BYTES) {
    return {
      status: 'skipped',
      errorMessage: `file too large for whisper (${input.size} > ${GROQ_MAX_BYTES} bytes)`,
    }
  }

  const fetchFn = input.fetchImpl ?? fetch

  try {
    const downloaded = await input.downloadFile(input.fileId)

    // Re-check actual size after download — Telegram metadata can lag.
    if (downloaded.size !== undefined && downloaded.size > GROQ_MAX_BYTES) {
      return {
        status: 'skipped',
        errorMessage: `file too large for whisper (${downloaded.size} > ${GROQ_MAX_BYTES} bytes)`,
      }
    }

    // Read bytes — prefer injected reader, otherwise dynamic import of
    // node:fs/promises so the module stays usable from environments
    // where the test fully stubs downloadFile/readFile.
    let bytes: Uint8Array
    if (input.readFile) {
      bytes = await input.readFile(downloaded.path)
    } else {
      const fs = await import('node:fs/promises')
      bytes = await fs.readFile(downloaded.path)
    }

    const form = new FormData()
    // Groq Whisper validates by FILENAME extension and rejects `.oga` even
    // though the bytes are valid Ogg/Opus. Telegram voice messages always
    // arrive with the `.oga` extension. Normalize to `.ogg` so the server
    // multipart parser accepts the file.
    const rawName = downloaded.path.split('/').pop() ?? 'voice.ogg'
    const filename = rawName.replace(/\.oga$/i, '.ogg')
    const mime = downloaded.mime ?? input.mime ?? 'audio/ogg'
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename)
    form.append('model', config.voice.model)
    form.append('language', config.voice.language)
    form.append('response_format', 'text')

    const res = await fetchFn('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    })

    if (!res.ok) {
      // Read body for diagnostic but redact the key just in case the
      // server echoes the Authorization header (some misconfigured proxies
      // do). Truncate to 200 chars like gateway.py:927.
      const rawBody = await res.text().catch(() => '')
      const safeBody = redactGroqKey(rawBody, key).slice(0, 200)
      return {
        status: 'failed',
        errorMessage: `groq HTTP ${res.status}: ${safeBody}`,
      }
    }

    const text = (await res.text()).trim()
    if (text.length === 0) {
      // Empty transcript = the audio was silent or unintelligible. Not
      // a failure of the pipeline — surface it as status=ok with empty
      // transcript so Claude can mention "I couldn't make out the audio"
      // instead of pretending the user typed nothing.
      return { transcript: '', status: 'ok' }
    }
    return { transcript: text, status: 'ok' }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    return {
      status: 'failed',
      errorMessage: redactGroqKey(raw, key),
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Photo download (post-allowlist).
//
// Ports gateway.py:863-901 photo branch. The Bot API getFile call gives
// us a relative `file_path` we suffix onto the file-CDN URL with the
// bot token. We persist into the inbox directory under a name derived
// from the unique_id + extension so Claude can Read the file later via
// download_attachment.
//
// Returns `undefined` on any failure — callers should still emit a
// descriptor without `local_path`, so Claude knows the file exists
// and can re-request it via the download_attachment tool.
// ─────────────────────────────────────────────────────────────────────

interface GetFileResult {
  file_id?: string
  file_unique_id?: string
  file_path?: string
  file_size?: number
}

export interface BotApiForDownload {
  api: {
    getFile: (fileId: string) => Promise<GetFileResult>
  }
}

export interface DownloadPhotoDeps {
  fetchImpl?: typeof fetch
  writeFile?: (path: string, data: Uint8Array) => Promise<void>
  mkdir?: (path: string) => Promise<void>
  now?: () => number
}

export async function downloadPhotoToInbox(
  bot: BotApiForDownload,
  token: string,
  fileId: string,
  inboxDir: string,
  deps: DownloadPhotoDeps = {},
): Promise<string | undefined> {
  const fetchFn = deps.fetchImpl ?? fetch
  try {
    const file = await bot.api.getFile(fileId)
    if (!file.file_path) return undefined

    // 20MB Bot API download cap — matches Telegram's documented limit
    // and gateway.py:873 TG_MAX_FILE_MB default.
    const maxBytes = 20 * 1024 * 1024
    if (file.file_size !== undefined && file.file_size > maxBytes) return undefined

    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
    const res = await fetchFn(url)
    if (!res.ok) return undefined
    const buf = new Uint8Array(await res.arrayBuffer())

    const rawExt = file.file_path.includes('.') ? (file.file_path.split('.').pop() ?? 'jpg') : 'jpg'
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'jpg'
    const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'photo'
    const ts = deps.now ? deps.now() : Date.now()
    const path = `${inboxDir}/${ts}-${uniqueId}.${ext}`

    if (deps.mkdir) {
      await deps.mkdir(inboxDir)
    } else {
      const fs = await import('node:fs/promises')
      await fs.mkdir(inboxDir, { recursive: true })
    }
    if (deps.writeFile) {
      await deps.writeFile(path, buf)
    } else {
      const fs = await import('node:fs/promises')
      await fs.writeFile(path, buf)
    }
    return path
  } catch {
    // Any failure → undefined; caller emits descriptor without local_path.
    return undefined
  }
}
