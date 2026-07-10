// Reliable outbound wrapper around TelegramApi — bounded retry + dead-letter
// + last-outbound tracking (M4, 2026-07-10 communication audit).
//
// The audit found ~12 delivery failures/week (transient network / 5xx / 429)
// that silently dropped a reply and forced the owner to ping «Статус?». This
// wrapper makes delivery mechanical: it is the OUTERMOST send layer (caller →
// reliable → safe(redact/validate) → rateLimited(queue+429) → raw(grammY)), so
// EVERY caller send passes through one choke point.
//
// What it does, per send-ish method (sendMessage / editMessageText /
// sendDocument / sendPhoto — sendRichMessage is tracked but NOT retried, see
// its handler):
//   1. Retry on TRANSIENT failure (network error, 5xx, 429) up to `maxRetries`
//      (default 2) with backoff (1s, 5s). A 429 honours `retry_after` when it
//      is larger than the scheduled backoff, capped at 30s.
//   2. Non-transient 4xx (except 429) → NO retry (the body is bad, not the
//      link) — rethrown so the caller can recover (the reply tool's plain-text
//      retry on an HTML parse 400) or surface an honest tool error.
//   3. On TRANSIENT EXHAUSTION → write a dead-letter record (chat_id, method,
//      payload hash, error) and rethrow so the tool result is honest.
//      Deliberately NOT on permanent 4xx: those are routine (parse errors the
//      reply tool recovers, a deleted HUD pin the HUD recreates, a blocked
//      bot) — dead-lettering them would be noise and, worse, could race the
//      recovery. The dead-letter targets exactly the audit's transient drops.
//   4. On a SUCCESSFUL new-message send (not editMessageText) → stamp the
//      outbound-activity tracker so the heartbeat/dead-man know when the owner
//      last heard from us. editMessageText is excluded: pin edits don't ping.
//
// ISOLATION: pass-through methods that never carry an owner reply
// (setMessageReaction / sendChatAction / deleteMessage / downloadFile /
// answerGuestQuery) are forwarded verbatim — no retry, no dead-letter — so
// this layer only governs primary delivery and never changes their semantics.
//
// Test seams: `now` and `sleep` replace the clock + setTimeout so the retry
// backoff runs in virtual time with no real waits; `deadLetter` and
// `recordOutbound` are injected callbacks (server wires them to writeDeadLetter
// and the OutboundActivityTracker) so unit tests observe them without I/O.

import { createHash } from 'node:crypto'

import type { Logger } from '../log.js'
import type {
  AnswerGuestQueryOpts,
  ChatAction,
  DownloadResult,
  EditOpts,
  SendDocumentOpts,
  SendMessageOpts,
  SendRichMessageOpts,
  SendRichMessageResult,
  TelegramApi,
} from '../channel/tools.js'

// ─────────────────────────────────────────────────────────────────────
// Error classification.
// ─────────────────────────────────────────────────────────────────────

export type SendErrorClass =
  | { kind: 'permanent' }
  | { kind: 'transient' }
  | { kind: 'rate_limited'; retryAfterMs: number }

// Pull an HTTP-ish status code from the many shapes an error can take (grammY
// GrammyError.error_code, a fetch Response-ish .status/.statusCode).
function extractStatusCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const e = err as Record<string, unknown>
  if (typeof e.error_code === 'number') return e.error_code
  if (typeof e.status === 'number') return e.status
  if (typeof e.statusCode === 'number') return e.statusCode
  return undefined
}

function extractRetryAfterSec(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const e = err as { parameters?: { retry_after?: unknown }; retry_after?: unknown }
  const raw = e.parameters?.retry_after ?? e.retry_after
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw
  return undefined
}

function looksLikeNetworkError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { name?: unknown; message?: unknown; code?: unknown }
  const name = typeof e.name === 'string' ? e.name.toLowerCase() : ''
  // grammY wraps transport failures in HttpError; undici/node surface fetch
  // failures as TypeError('fetch failed') / AbortError, or a syscall code.
  if (name === 'httperror' || name === 'aborterror' || name === 'fetcherror') return true
  const code = typeof e.code === 'string' ? e.code.toUpperCase() : ''
  if (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EPIPE' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_SOCKET'
  ) {
    return true
  }
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : ''
  return (
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('connection')
  )
}

/**
 * Classify a send failure. 429 → rate_limited (with a clamped retry_after);
 * 5xx or a network-looking error → transient; every 4xx (except 429) and any
 * unreadable/plain error → permanent (no retry — retrying a bad body or a
 * genuine bug only wastes attempts and delays the honest error).
 *
 * `retryAfterCapMs` clamps a hostile / huge retry_after so one 429 can't stall
 * a send for minutes.
 */
export function classifySendError(err: unknown, retryAfterCapMs: number): SendErrorClass {
  const code = extractStatusCode(err)
  if (code === 429) {
    const sec = extractRetryAfterSec(err)
    const ms = sec !== undefined ? Math.min(retryAfterCapMs, Math.ceil(sec) * 1000) : 0
    return { kind: 'rate_limited', retryAfterMs: ms }
  }
  if (typeof code === 'number' && code >= 500 && code <= 599) return { kind: 'transient' }
  if (typeof code === 'number' && code >= 400 && code <= 499) return { kind: 'permanent' }
  // No HTTP code: a network/transport error is transient; anything else
  // (a plain Error — likely a programming bug) is permanent so we never
  // retry+dead-letter a non-delivery failure.
  if (looksLikeNetworkError(err)) return { kind: 'transient' }
  return { kind: 'permanent' }
}

// ─────────────────────────────────────────────────────────────────────
// Dead-letter record shape (the `value` written under the `outbound` bucket).
// ─────────────────────────────────────────────────────────────────────

export interface OutboundDeadLetter {
  method: string
  chat_id: string
  // sha256 (first 16 hex) of the payload body — enough to correlate without
  // ever writing the (possibly still-sensitive) message text to disk.
  payload_sha256: string
  payload_bytes: number
  attempts: number
  error: string
  error_class: SendErrorClass['kind']
}

function payloadHash(body: string): { sha: string; bytes: number } {
  const bytes = Buffer.byteLength(body, 'utf8')
  const sha = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16)
  return { sha, bytes }
}

// ─────────────────────────────────────────────────────────────────────
// Wrapper.
// ─────────────────────────────────────────────────────────────────────

export interface ReliableOptions {
  /** Max RETRIES after the first attempt (default 2 → up to 3 attempts). */
  maxRetries?: number
  /** Backoff before retry N (0-indexed). Default [1000, 5000] ms. */
  backoffsMs?: number[]
  /** Clamp for a 429 retry_after. Default 30_000 ms. */
  retryAfterCapMs?: number
  /** Test seam: replace Date.now(). */
  now?: () => number
  /** Test seam: replace setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>
  /** Write a dead-letter record (server wires writeDeadLetter(paths,'outbound',r)). */
  deadLetter?: (record: OutboundDeadLetter) => void
  /** Stamp the outbound-activity clock on a successful NEW-message send. */
  recordOutbound?: (chatId: string, atMs: number) => void
}

const DEFAULT_BACKOFFS_MS = [1000, 5000]
const DEFAULT_RETRY_AFTER_CAP_MS = 30_000

export function createReliableTelegramApi(
  raw: TelegramApi,
  log: Logger,
  opts: ReliableOptions = {},
): TelegramApi {
  const maxRetries = opts.maxRetries ?? 2
  const backoffs = opts.backoffsMs ?? DEFAULT_BACKOFFS_MS
  const retryAfterCapMs = opts.retryAfterCapMs ?? DEFAULT_RETRY_AFTER_CAP_MS
  const now = opts.now ?? ((): number => Date.now())
  const sleep =
    opts.sleep ??
    ((ms: number): Promise<void> =>
      ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)))

  // The retry engine. `op` performs one attempt; `describe` supplies the
  // dead-letter identity (method + chat + payload) used ONLY on transient
  // exhaustion. Permanent failures rethrow immediately (no retry, no
  // dead-letter). Returns the op's result on success.
  async function withRetry<T>(
    op: () => Promise<T>,
    describe: () => { method: string; chatId: string; body: string },
  ): Promise<T> {
    let attempt = 0
    for (;;) {
      attempt += 1
      try {
        return await op()
      } catch (err) {
        const cls = classifySendError(err, retryAfterCapMs)
        if (cls.kind === 'permanent') {
          // Bad body / genuine error — the caller recovers (reply-tool plain
          // retry) or surfaces it. No retry, no dead-letter.
          throw err
        }
        if (attempt > maxRetries) {
          // Transient exhaustion — quarantine + rethrow an honest error.
          const d = describe()
          const { sha, bytes } = payloadHash(d.body)
          const record: OutboundDeadLetter = {
            method: d.method,
            chat_id: d.chatId,
            payload_sha256: sha,
            payload_bytes: bytes,
            attempts: attempt,
            error: err instanceof Error ? err.message : String(err),
            error_class: cls.kind,
          }
          try {
            opts.deadLetter?.(record)
          } catch (dlErr) {
            log.warn('outbound dead-letter write failed (ignored)', {
              method: d.method,
              chat_id: d.chatId,
              error: dlErr instanceof Error ? dlErr.message : String(dlErr),
            })
          }
          log.warn('outbound send failed after retries — dead-lettered', {
            method: d.method,
            chat_id: d.chatId,
            attempts: attempt,
            error_class: cls.kind,
          })
          throw err
        }
        // Schedule the next attempt. 429 honours retry_after when larger than
        // the scheduled backoff; both are capped by retryAfterCapMs.
        const backoff = backoffs[attempt - 1] ?? backoffs[backoffs.length - 1] ?? 1000
        const wait =
          cls.kind === 'rate_limited'
            ? Math.min(retryAfterCapMs, Math.max(backoff, cls.retryAfterMs))
            : backoff
        const d = describe()
        log.warn('outbound send transient failure — retrying', {
          method: d.method,
          chat_id: d.chatId,
          attempt,
          error_class: cls.kind,
          wait_ms: wait,
        })
        await sleep(wait)
      }
    }
  }

  return {
    async sendMessage(chatId, text, sendOpts: SendMessageOpts): Promise<{ message_id: number }> {
      const res = await withRetry(
        () => raw.sendMessage(chatId, text, sendOpts),
        () => ({ method: 'sendMessage', chatId, body: text }),
      )
      opts.recordOutbound?.(chatId, now())
      return res
    },

    async sendRichMessage(
      chatId,
      rawMarkdown,
      richOpts: SendRichMessageOpts,
    ): Promise<SendRichMessageResult> {
      // NOT retried here (deliberately not in item 1's method list): a rich
      // send is non-idempotent and a transient error AFTER Telegram accepted it
      // would double-post on retry; the safe wrapper already rethrows rich
      // transients and 429s are handled by the rate-limiter's queue. We only
      // stamp the outbound clock on a REAL send (message_id) — a transparent
      // { fallback: true } means the HTML path (sendMessage) ships and stamps.
      const res = await raw.sendRichMessage(chatId, rawMarkdown, richOpts)
      if ('message_id' in res) opts.recordOutbound?.(chatId, now())
      return res
    },

    async editMessageText(chatId, messageId, text, editOpts: EditOpts): Promise<void> {
      // Retried like a send, but NOT stamped as outbound: an edit does not ping
      // and the pins re-edit every tick — counting them would starve the
      // heartbeat window forever.
      await withRetry(
        () => raw.editMessageText(chatId, messageId, text, editOpts),
        () => ({ method: 'editMessageText', chatId, body: text }),
      )
    },

    async sendDocument(chatId, filePath, docOpts: SendDocumentOpts): Promise<{ message_id: number }> {
      const res = await withRetry(
        () => raw.sendDocument(chatId, filePath, docOpts),
        () => ({ method: 'sendDocument', chatId, body: filePath }),
      )
      opts.recordOutbound?.(chatId, now())
      return res
    },

    async sendPhoto(chatId, filePath, photoOpts: SendDocumentOpts): Promise<{ message_id: number }> {
      const res = await withRetry(
        () => raw.sendPhoto(chatId, filePath, photoOpts),
        () => ({ method: 'sendPhoto', chatId, body: filePath }),
      )
      opts.recordOutbound?.(chatId, now())
      return res
    },

    // ─── pass-through (never carry an owner reply) ───────────────────────
    async setMessageReaction(chatId, messageId, emoji): Promise<void> {
      return raw.setMessageReaction(chatId, messageId, emoji)
    },
    async sendChatAction(chatId, action: ChatAction): Promise<void> {
      return raw.sendChatAction(chatId, action)
    },
    async downloadFile(fileId, destDir): Promise<DownloadResult> {
      return raw.downloadFile(fileId, destDir)
    },
    async deleteMessage(chatId, messageId): Promise<void> {
      return raw.deleteMessage(chatId, messageId)
    },
    async answerGuestQuery(guestQueryId, text, guestOpts: AnswerGuestQueryOpts): Promise<void> {
      return raw.answerGuestQuery(guestQueryId, text, guestOpts)
    },
  }
}
