// Reliable outbound wrapper around TelegramApi — bounded retry + dead-letter
// + last-outbound tracking (M4, 2026-07-10 communication audit; hardened in
// fix-loop 1 after the Codex/Fable dual review).
//
// The audit found ~12 delivery failures/week (transient network / 5xx / 429)
// that silently dropped a reply and forced the owner to ping «Статус?». This
// wrapper makes delivery mechanical: it is the OUTERMOST send layer (caller →
// reliable → safe(redact/validate) → rateLimited(queue+429) → raw(grammY)), so
// EVERY caller send passes through one choke point.
//
// ── LOSS vs DUPLICATE (the fix-loop-1 CRITICAL) ──────────────────────
// A failed send is only safely retryable when we can PROVE Telegram never
// received it. Errors therefore classify into:
//   • pre_send   — delivery provably did NOT happen: the connection was never
//                  established (ECONNREFUSED, ENOTFOUND, EAI_AGAIN / DNS,
//                  connect-phase timeouts). Retrying can never duplicate.
//   • ambiguous  — the request MAY have reached Telegram before the failure
//                  (ECONNRESET, ETIMEDOUT, socket hang up, generic «fetch
//                  failed», 5xx — the API may have processed the send and died
//                  answering). Retrying a NON-IDEMPOTENT method here risks the
//                  owner seeing the same message twice.
// Policy: non-idempotent methods (sendMessage / sendDocument / sendPhoto)
// retry ONLY pre_send; on ambiguous they dead-letter + rethrow immediately —
// we prefer a LOUD possible-loss (honest tool error, quarantined record, the
// agent can decide to resend) over a SILENT duplicate (spammy, confusing, and
// unfixable after the fact). Idempotent editMessageText retries BOTH classes
// (re-editing to the same content is harmless; Telegram's «message is not
// modified» response is normalized to success).
//
// 429 (rate_limited) is NEVER retried here (fix-loop-1 #2): the INNER
// rate-limited layer already owns 429s (3 attempts, retry_after ≤60s each) —
// by the time one escapes to this layer ~3 minutes of backoff are already
// burned, and looping the whole inner stack again would amplify the stall to
// ~10 minutes of head-of-line blocking. Escaped 429 → immediate dead-letter +
// rethrow.
//
// On a transient failure we don't retry, or on pre_send exhaustion → write a
// dead-letter record (chat_id, method, payload hash, error) under the
// `outbound` bucket and rethrow so the tool result is honest. Permanent 4xx
// (except 429) are NOT dead-lettered: those are routine (parse errors the
// reply tool recovers, a deleted HUD pin the HUD recreates, a blocked bot) —
// quarantining them would be noise racing the recovery.
//
// On a SUCCESSFUL new-message send (not editMessageText) the wrapper stamps
// the outbound-activity tracker so the heartbeat/dead-man know when the owner
// last heard from us. `SendMessageOpts.skipOutboundStamp` opts a call OUT of
// the stamp — used by INTERNAL surfaces (context-HUD self-heal, heartbeat
// nudges) whose sends must not silently reset the heartbeat silence window.
// ALL post-success bookkeeping (stamp) and dead-letter writes are wrapped in
// try/catch: a delivered message must NEVER turn into a tool error because a
// callback threw (fix-loop-1 #5).
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
  | { kind: 'pre_send' }
  | { kind: 'ambiguous' }
  | { kind: 'rate_limited'; retryAfterMs: number }

/** The transient classes a dead-letter record can carry. */
export type OutboundErrorClass = 'pre_send' | 'ambiguous' | 'rate_limited'

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

// Syscall-level error codes, checked on the error itself and one level into
// `cause` / `error` (grammY HttpError stores the transport failure in .error;
// undici uses .cause).
function extractSyscallCodes(err: unknown): string[] {
  const out: string[] = []
  const grab = (o: unknown): void => {
    if (typeof o !== 'object' || o === null) return
    const c = (o as { code?: unknown }).code
    if (typeof c === 'string' && c.length > 0) out.push(c.toUpperCase())
  }
  grab(err)
  if (typeof err === 'object' && err !== null) {
    const e = err as { cause?: unknown; error?: unknown }
    grab(e.cause)
    grab(e.error)
  }
  return out
}

// Lowercased message text, gathered from the error and one nesting level.
function extractMessage(err: unknown): string {
  if (typeof err === 'string') return err.toLowerCase()
  if (typeof err !== 'object' || err === null) return ''
  const e = err as Record<string, unknown>
  const parts: string[] = []
  if (typeof e.description === 'string') parts.push(e.description)
  if (typeof e.message === 'string') parts.push(e.message)
  for (const key of ['cause', 'error'] as const) {
    const nested = e[key]
    if (typeof nested === 'object' && nested !== null) {
      const m = (nested as { message?: unknown }).message
      if (typeof m === 'string') parts.push(m)
    }
  }
  return parts.join(' ').toLowerCase()
}

// Connection provably never established → the request never left us.
const PRE_SEND_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
])
// Connection existed (or state unknown) when it died → Telegram may have
// already processed the request.
const AMBIGUOUS_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_SOCKET',
])

/**
 * Classify a send failure (see the module header for the loss-vs-duplicate
 * policy each class drives):
 *   429                        → rate_limited (never retried here);
 *   5xx                        → ambiguous (the API may have processed it);
 *   other 4xx                  → permanent (bad body / auth — no retry);
 *   connect-phase syscall/DNS  → pre_send (provably not delivered);
 *   reset / timeout / hang-up  → ambiguous;
 *   anything unreadable        → permanent (likely a programming bug — never
 *                                retry or dead-letter a non-delivery failure).
 * NOTE: deliberately NO loose `includes('connection')` match (fix-loop-1 #1) —
 * any Error merely mentioning the word must not become retryable.
 *
 * `retryAfterCapMs` clamps a hostile / huge retry_after in the recorded value.
 */
export function classifySendError(err: unknown, retryAfterCapMs: number): SendErrorClass {
  const code = extractStatusCode(err)
  if (code === 429) {
    const sec = extractRetryAfterSec(err)
    const ms = sec !== undefined ? Math.min(retryAfterCapMs, Math.ceil(sec) * 1000) : 0
    return { kind: 'rate_limited', retryAfterMs: ms }
  }
  if (typeof code === 'number' && code >= 500 && code <= 599) return { kind: 'ambiguous' }
  if (typeof code === 'number' && code >= 400 && code <= 499) return { kind: 'permanent' }

  const sys = extractSyscallCodes(err)
  if (sys.some((c) => PRE_SEND_CODES.has(c))) return { kind: 'pre_send' }
  if (sys.some((c) => AMBIGUOUS_CODES.has(c))) return { kind: 'ambiguous' }

  const msg = extractMessage(err)
  if (
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('eai_again') ||
    msg.includes('getaddrinfo')
  ) {
    return { kind: 'pre_send' }
  }
  if (
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed') ||
    msg.includes('network')
  ) {
    return { kind: 'ambiguous' }
  }
  // Transport-wrapper names without a readable code/message detail: the HTTP
  // exchange failed at an unknown phase — cannot prove pre-send.
  if (typeof err === 'object' && err !== null) {
    const name = (err as { name?: unknown }).name
    if (typeof name === 'string') {
      const n = name.toLowerCase()
      if (n === 'httperror' || n === 'aborterror' || n === 'fetcherror') {
        return { kind: 'ambiguous' }
      }
    }
  }
  return { kind: 'permanent' }
}

// Telegram's «message is not modified» on editMessageText: the remote content
// ALREADY equals what we tried to write — for an idempotent edit that IS
// success (fix-loop-1 #1). Same phrase check classifyEditError leads with.
function isNotModifiedError(err: unknown): boolean {
  return extractMessage(err).includes('message is not modified')
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
  error_class: OutboundErrorClass
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
  /** Clamp for a recorded 429 retry_after. Default 30_000 ms. */
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

  // Post-success bookkeeping — MUST be swallowed (fix-loop-1 #5): the message
  // is already delivered; a throwing tracker cannot be allowed to turn that
  // delivery into a tool error (which could push the agent into a duplicate
  // resend — the exact failure mode this layer exists to kill).
  function stampOutbound(chatId: string): void {
    try {
      opts.recordOutbound?.(chatId, now())
    } catch (err) {
      log.warn('outbound activity stamp failed (ignored)', {
        chat_id: chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function writeDeadLetterRecord(
    d: { method: string; chatId: string; body: string },
    attempts: number,
    err: unknown,
    errorClass: OutboundErrorClass,
  ): void {
    const { sha, bytes } = payloadHash(d.body)
    const record: OutboundDeadLetter = {
      method: d.method,
      chat_id: d.chatId,
      payload_sha256: sha,
      payload_bytes: bytes,
      attempts,
      error: err instanceof Error ? err.message : String(err),
      error_class: errorClass,
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
    log.warn('outbound send failed — dead-lettered', {
      method: d.method,
      chat_id: d.chatId,
      attempts,
      error_class: errorClass,
    })
  }

  // The retry engine. `idempotent` selects the retry policy (see module
  // header): non-idempotent ops retry ONLY pre_send; idempotent ops (edits)
  // also retry ambiguous. rate_limited is never retried (fix-loop-1 #2).
  // Permanent failures rethrow immediately (no retry, no dead-letter);
  // non-retried / exhausted transients dead-letter + rethrow honestly.
  async function withRetry<T>(
    idempotent: boolean,
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
        const retryable =
          cls.kind === 'pre_send' || (idempotent && cls.kind === 'ambiguous')
        if (!retryable || attempt > maxRetries) {
          writeDeadLetterRecord(describe(), attempt, err, cls.kind)
          throw err
        }
        const wait = backoffs[attempt - 1] ?? backoffs[backoffs.length - 1] ?? 1000
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
      // Strip the wrapper-only flag so it never travels downstream (the safe
      // wrapper spreads opts; grammY must never see a foreign field).
      const { skipOutboundStamp, ...rest } = sendOpts
      const res = await withRetry(
        false,
        () => raw.sendMessage(chatId, text, rest),
        () => ({ method: 'sendMessage', chatId, body: text }),
      )
      if (skipOutboundStamp !== true) stampOutbound(chatId)
      return res
    },

    async sendRichMessage(
      chatId,
      rawMarkdown,
      richOpts: SendRichMessageOpts,
    ): Promise<SendRichMessageResult> {
      // NOT retried (deliberately not in item 1's method list): a rich send is
      // non-idempotent and its transient errors are ambiguous by nature; the
      // safe wrapper already rethrows rich transients and 429s are handled by
      // the rate-limiter's queue. We only stamp the outbound clock on a REAL
      // send (message_id) — a transparent { fallback: true } means the HTML
      // path (sendMessage) ships and stamps.
      const res = await raw.sendRichMessage(chatId, rawMarkdown, richOpts)
      if ('message_id' in res) stampOutbound(chatId)
      return res
    },

    async editMessageText(chatId, messageId, text, editOpts: EditOpts): Promise<void> {
      // IDEMPOTENT: re-editing to the same content is harmless, so both
      // pre_send AND ambiguous retry. «message is not modified» — thrown when
      // a retry follows a delivered-but-unanswered first attempt — IS success.
      // NOT stamped as outbound: an edit does not ping and the pins re-edit
      // every tick — counting them would starve the heartbeat window forever.
      try {
        await withRetry(
          true,
          () => raw.editMessageText(chatId, messageId, text, editOpts),
          () => ({ method: 'editMessageText', chatId, body: text }),
        )
      } catch (err) {
        if (isNotModifiedError(err)) return
        throw err
      }
    },

    async sendDocument(chatId, filePath, docOpts: SendDocumentOpts): Promise<{ message_id: number }> {
      const res = await withRetry(
        false,
        () => raw.sendDocument(chatId, filePath, docOpts),
        () => ({ method: 'sendDocument', chatId, body: filePath }),
      )
      stampOutbound(chatId)
      return res
    },

    async sendPhoto(chatId, filePath, photoOpts: SendDocumentOpts): Promise<{ message_id: number }> {
      const res = await withRetry(
        false,
        () => raw.sendPhoto(chatId, filePath, photoOpts),
        () => ({ method: 'sendPhoto', chatId, body: filePath }),
      )
      stampOutbound(chatId)
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
