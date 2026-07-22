// Shared media-descriptor builders.
//
// Each inbound Telegram message field (photo, document, voice, …) maps to a
// MediaDescriptor via one of the pure functions below. These were extracted
// verbatim from the per-kind `handleInboundXxx` closures in handlers.ts so a
// single implementation serves THREE call sites without divergence:
//
//   1. DM / group own-message handlers (eager): photo downloads to the inbox,
//      voice is transcribed via Groq. The caller is allowlisted, so eager
//      side effects are safe.
//   2. Guest Mode own-message (eager): the guest CALLER is allowlisted, so the
//      guest's OWN attachment is handled exactly like a DM attachment.
//   3. Reply-target media (metadata only): the reply author is NOT the
//      allowlisted caller, so we NEVER download a reply photo or transcribe a
//      reply voice — we only surface the file_id + <media> descriptor so the
//      agent can decide whether to fetch it via download_attachment.
//
// The photo/voice builders take OPTIONAL side-effect deps: when present they
// enrich (local_path / transcript), when absent they emit metadata only. All
// other kinds are pure metadata in every path.

import type {
  Animation,
  Audio,
  Document,
  PhotoSize,
  Sticker,
  Video,
  VideoNote,
  Voice,
} from 'grammy/types'

import type { AppConfig } from '../config.js'
import type { Logger } from '../log.js'
import {
  downloadPhotoToInbox,
  maybeTranscribeVoice,
  type BotApiForDownload,
  type MediaDescriptor,
} from './media.js'

// ─────────────────────────────────────────────────────────────────────
// Per-kind builders. Each returns a 0-or-1 element array so callers can
// concatenate uniformly (an empty array when the field is absent).
// ─────────────────────────────────────────────────────────────────────

// Photo — metadata only (no download). Picks the largest size; Telegram's
// photo array is sorted ascending by resolution.
export function buildPhotoMeta(photo: PhotoSize[] | undefined): MediaDescriptor[] {
  if (!photo || photo.length === 0) return []
  const largest = photo[photo.length - 1]
  if (!largest) return []
  const md: MediaDescriptor = {
    kind: 'photo',
    fileId: largest.file_id,
    ...(largest.file_unique_id !== undefined ? { uniqueId: largest.file_unique_id } : {}),
    ...(largest.width !== undefined ? { width: largest.width } : {}),
    ...(largest.height !== undefined ? { height: largest.height } : {}),
    ...(largest.file_size !== undefined ? { size: largest.file_size } : {}),
  }
  return [md]
}

export interface PhotoDownloadDeps {
  botApi: BotApiForDownload
  botToken: string
  inboxDir: string
}

// Photo — eager: downloads the largest size to the inbox and attaches
// local_path. Behaviour-identical to the original handleInboundPhoto closure.
// Download failure yields a descriptor WITHOUT local_path (the agent can
// re-fetch via download_attachment).
export async function buildPhotoDescriptor(
  photo: PhotoSize[] | undefined,
  deps: PhotoDownloadDeps,
): Promise<MediaDescriptor[]> {
  const metas = buildPhotoMeta(photo)
  const md = metas[0]
  if (md === undefined || md.kind !== 'photo') return metas
  const localPath = await downloadPhotoToInbox(
    deps.botApi,
    deps.botToken,
    md.fileId,
    deps.inboxDir,
  )
  if (localPath !== undefined) md.localPath = localPath
  return [md]
}

export function buildDocumentDescriptor(doc: Document | undefined): MediaDescriptor[] {
  if (!doc) return []
  const md: MediaDescriptor = {
    kind: 'document',
    fileId: doc.file_id,
    ...(doc.file_name !== undefined ? { name: doc.file_name } : {}),
    ...(doc.mime_type !== undefined ? { mime: doc.mime_type } : {}),
    ...(doc.file_size !== undefined ? { size: doc.file_size } : {}),
  }
  return [md]
}

// Voice — metadata only (no Groq call). Status is `skipped`: we did not
// transcribe (this is the reply-target path, where the author is not
// allowlisted). The status is always present so the agent never has to
// guess whether an absent transcript is a bug or a deliberate skip.
export function buildVoiceMeta(voice: Voice | undefined): MediaDescriptor[] {
  if (!voice) return []
  const md: MediaDescriptor = {
    kind: 'voice',
    fileId: voice.file_id,
    ...(voice.mime_type !== undefined ? { mime: voice.mime_type } : {}),
    ...(voice.file_size !== undefined ? { size: voice.file_size } : {}),
    ...(voice.duration !== undefined ? { durationSec: voice.duration } : {}),
    transcriptionStatus: 'skipped',
  }
  return [md]
}

export interface VoiceTranscribeDeps {
  config: AppConfig
  env: { GROQ_API_KEY?: string }
  downloadFile: (fileId: string) => Promise<{ path: string; mime?: string; size?: number }>
  log: Logger
}

// Voice — eager: transcribes via Groq (maybeTranscribeVoice never throws).
// Behaviour-identical to the original handleInboundVoice closure.
export async function buildVoiceDescriptor(
  voice: Voice | undefined,
  deps: VoiceTranscribeDeps,
): Promise<MediaDescriptor[]> {
  if (!voice) return []
  const transcription = await maybeTranscribeVoice(
    {
      fileId: voice.file_id,
      ...(voice.duration !== undefined ? { durationSec: voice.duration } : {}),
      ...(voice.file_size !== undefined ? { size: voice.file_size } : {}),
      ...(voice.mime_type !== undefined ? { mime: voice.mime_type } : {}),
      downloadFile: deps.downloadFile,
    },
    deps.config,
    deps.env,
  )
  if (transcription.status === 'failed' || transcription.status === 'skipped') {
    deps.log.warn('voice transcription failed', {
      status: transcription.status,
      error: transcription.errorMessage,
    })
  }
  const md: MediaDescriptor = {
    kind: 'voice',
    fileId: voice.file_id,
    ...(voice.mime_type !== undefined ? { mime: voice.mime_type } : {}),
    ...(voice.file_size !== undefined ? { size: voice.file_size } : {}),
    ...(voice.duration !== undefined ? { durationSec: voice.duration } : {}),
    ...(transcription.transcript !== undefined ? { transcript: transcription.transcript } : {}),
    transcriptionStatus: transcription.status,
  }
  return [md]
}

export function buildAudioDescriptor(audio: Audio | undefined): MediaDescriptor[] {
  if (!audio) return []
  const md: MediaDescriptor = {
    kind: 'audio',
    fileId: audio.file_id,
    ...(audio.file_name !== undefined ? { name: audio.file_name } : {}),
    ...(audio.title !== undefined ? { title: audio.title } : {}),
    ...(audio.performer !== undefined ? { performer: audio.performer } : {}),
    ...(audio.mime_type !== undefined ? { mime: audio.mime_type } : {}),
    ...(audio.file_size !== undefined ? { size: audio.file_size } : {}),
    ...(audio.duration !== undefined ? { durationSec: audio.duration } : {}),
  }
  return [md]
}

export function buildVideoDescriptor(video: Video | undefined): MediaDescriptor[] {
  if (!video) return []
  const md: MediaDescriptor = {
    kind: 'video',
    fileId: video.file_id,
    ...(video.file_name !== undefined ? { name: video.file_name } : {}),
    ...(video.mime_type !== undefined ? { mime: video.mime_type } : {}),
    ...(video.file_size !== undefined ? { size: video.file_size } : {}),
    ...(video.duration !== undefined ? { durationSec: video.duration } : {}),
    ...(video.width !== undefined ? { width: video.width } : {}),
    ...(video.height !== undefined ? { height: video.height } : {}),
  }
  return [md]
}

export function buildVideoNoteDescriptor(note: VideoNote | undefined): MediaDescriptor[] {
  if (!note) return []
  const md: MediaDescriptor = {
    kind: 'video_note',
    fileId: note.file_id,
    ...(note.file_size !== undefined ? { size: note.file_size } : {}),
    ...(note.duration !== undefined ? { durationSec: note.duration } : {}),
  }
  return [md]
}

export function buildStickerDescriptor(sticker: Sticker | undefined): MediaDescriptor[] {
  if (!sticker) return []
  const md: MediaDescriptor = {
    kind: 'sticker',
    fileId: sticker.file_id,
    ...(sticker.emoji !== undefined ? { emoji: sticker.emoji } : {}),
    ...(sticker.set_name !== undefined ? { setName: sticker.set_name } : {}),
    ...(sticker.file_size !== undefined ? { size: sticker.file_size } : {}),
  }
  return [md]
}

export function buildAnimationDescriptor(anim: Animation | undefined): MediaDescriptor[] {
  if (!anim) return []
  const md: MediaDescriptor = {
    kind: 'animation',
    fileId: anim.file_id,
    ...(anim.file_name !== undefined ? { name: anim.file_name } : {}),
    ...(anim.mime_type !== undefined ? { mime: anim.mime_type } : {}),
    ...(anim.file_size !== undefined ? { size: anim.file_size } : {}),
    ...(anim.duration !== undefined ? { durationSec: anim.duration } : {}),
    ...(anim.width !== undefined ? { width: anim.width } : {}),
    ...(anim.height !== undefined ? { height: anim.height } : {}),
  }
  return [md]
}

// ─────────────────────────────────────────────────────────────────────
// Aggregators over a message-like object. A single Telegram message
// carries exactly one media kind, but iterating all fields keeps the
// caller free of per-kind branching and is cheap (each builder short-
// circuits on an absent field).
// ─────────────────────────────────────────────────────────────────────

export interface MediaSource {
  photo?: PhotoSize[]
  document?: Document
  voice?: Voice
  audio?: Audio
  video?: Video
  video_note?: VideoNote
  sticker?: Sticker
  animation?: Animation
}

export interface EagerMediaDeps {
  photo: PhotoDownloadDeps
  voice: VoiceTranscribeDeps
}

// Eager aggregator — own-message path (DM / guest caller). Photo downloads,
// voice transcribes; everything else is metadata.
export async function buildOwnMediaDescriptors(
  src: MediaSource,
  deps: EagerMediaDeps,
): Promise<MediaDescriptor[]> {
  const out: MediaDescriptor[] = []
  out.push(...(await buildPhotoDescriptor(src.photo, deps.photo)))
  // A GIF carries BOTH `animation` and a back-compat `document` twin. When
  // `animation` is present, skip the duplicate document so the GIF renders
  // (and downloads) once, not twice (Codex Low, GIF de-dup).
  out.push(...buildDocumentDescriptor(src.animation ? undefined : src.document))
  out.push(...(await buildVoiceDescriptor(src.voice, deps.voice)))
  out.push(...buildAudioDescriptor(src.audio))
  out.push(...buildVideoDescriptor(src.video))
  out.push(...buildVideoNoteDescriptor(src.video_note))
  out.push(...buildStickerDescriptor(src.sticker))
  out.push(...buildAnimationDescriptor(src.animation))
  return out
}

// Metadata-only aggregator — reply-target path. NEVER downloads or
// transcribes: the reply author is not the allowlisted caller. Synchronous
// so it can run inside the sync adaptReply() coercion.
export function buildReplyMediaDescriptors(src: MediaSource): MediaDescriptor[] {
  return [
    ...buildPhotoMeta(src.photo),
    // GIF de-dup: `animation` supersedes its back-compat `document` twin.
    ...buildDocumentDescriptor(src.animation ? undefined : src.document),
    ...buildVoiceMeta(src.voice),
    ...buildAudioDescriptor(src.audio),
    ...buildVideoDescriptor(src.video),
    ...buildVideoNoteDescriptor(src.video_note),
    ...buildStickerDescriptor(src.sticker),
    ...buildAnimationDescriptor(src.animation),
  ]
}
