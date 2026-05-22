// Outbound rate-limit wrapper around TelegramApi.
//
// Goal: make Telegram's per-chat / per-bot rate limits invisible to callers.
// A burst of replies (e.g. a multi-part report) used to surface as a 429
// from Bot API with retry_after ≈ 300s — long enough that the warchief lost
// sight of what the agent was doing. This wrapper enforces pacing BEFORE
// the request leaves the process and transparently retries on 429.
//
// Layers (independent, all consulted on every text-send):
//   1. Per-chat token bucket (default: 1 msg/sec sustained, burst 3).
//      Same-chat ordering is preserved via a FIFO tail-promise chain — a
//      second sendMessage to the same chat awaits the first before checking
//      its bucket. Different chats run in parallel.
//   2. Global token bucket (default: 25 msg/sec, burst 25). Caps total
//      throughput across all chats under Telegram's 30/sec bot-wide limit.
//   3. 429 retry: on a grammY-shaped 429 (`error_code: 429`, optional
//      `parameters.retry_after`), sleep the requested seconds + a small
//      jitter and retry the SAME call. Bounded by `maxRetries` (default 2).
//
// Every Telegram-bound text / edit / reaction / delete call runs through the
// per-chat bucket + FIFO queue — including editMessageText and
// setMessageReaction. Leaving edits unpaced let a busy session's status
// bubbles + reactions trip Telegram's per-chat flood limit on their own.
// sendChatAction is the one exception: a "typing…" pulse is worthless once
// stale, so it is best-effort — dropped when the chat has no token, never
// queued or retried (queuing chat actions is pure flood pressure).
// downloadFile is inbound and untouched.
//
// Test seams: `opts.now` and `opts.sleep` replace the real clock and
// setTimeout-based sleep, so tests can run instantly with deterministic
// virtual time.

import type { Logger } from '../log.js'
import type {
  ChatAction,
  DownloadResult,
  EditOpts,
  SendDocumentOpts,
  SendMessageOpts,
  TelegramApi,
} from '../channel/tools.js'

interface TokenBucket {
  tokens: number
  capacity: number
  refillPerMs: number
  lastRefill: number
}

function makeBucket(capacity: number, refillPerSec: number, now: number): TokenBucket {
  return {
    tokens: capacity,
    capacity,
    refillPerMs: refillPerSec / 1000,
    lastRefill: now,
  }
}

function refill(b: TokenBucket, now: number): void {
  const dt = now - b.lastRefill
  if (dt <= 0) return
  b.tokens = Math.min(b.capacity, b.tokens + dt * b.refillPerMs)
  b.lastRefill = now
}

// ms to wait before consuming one token; 0 means available now.
function waitMs(b: TokenBucket, now: number): number {
  refill(b, now)
  if (b.tokens >= 1) return 0
  return Math.ceil((1 - b.tokens) / b.refillPerMs)
}

function consume(b: TokenBucket): void {
  b.tokens -= 1
}

interface ChatState {
  bucket: TokenBucket
  // FIFO tail: every enqueued op awaits this before checking the bucket.
  // Replaced with a fresh deferred at each enqueue. Errors do NOT propagate
  // (we use `.catch(() => {})` on the await) so one failed send cannot
  // permanently break the chain for a chat.
  //
  // HEAD-OF-LINE BLOCKING: a slow op (e.g. a 429 retry holding the lock)
  // delays all subsequent sends to the SAME chat. That's intentional —
  // ordering matters more than throughput for a conversational channel.
  // Different chats run in parallel (separate ChatState entries) so a stuck
  // chat does not affect others. Worst-case per-chat stall is bounded by
  // `maxRetries * MAX_RETRY_AFTER_S`.
  tail: Promise<void>
}

export interface RateLimitOptions {
  perChatRefillPerSec?: number
  perChatBurstCapacity?: number
  globalRefillPerSec?: number
  globalBurstCapacity?: number
  maxRetries?: number
  jitterMaxMs?: number
  /** Test seam: replace Date.now() for deterministic virtual time. */
  now?: () => number
  /** Test seam: replace setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>
}

interface Grammy429 {
  error_code: 429
  parameters?: { retry_after?: number }
}

// Cap retry_after so a giant or hostile-shaped value can't pin a chat's
// FIFO queue indefinitely. The cap must still be large enough to honour a
// real Telegram flood-wait (135s and 503s observed in prod): retrying
// BEFORE the window elapses is counted as continued flooding and extends
// the ban. The per-chat tail-promise chain blocks subsequent sends to the
// same chat until the in-flight op finishes, so worst-case stall =
// maxRetries × MAX_RETRY_AFTER_S. With defaults (2 × 900s) that is a
// 30-minute ceiling — reached only if Telegram re-bans on the retry, which
// the pacing above is designed to prevent.
const MAX_RETRY_AFTER_S = 900

function parse429(err: unknown): { retryAfter: number } | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as Grammy429
  if (e.error_code !== 429) return null
  const after = e.parameters?.retry_after
  // Telegram's retry_after is in seconds. Coerce to a sane positive integer
  // and clamp into [1, MAX_RETRY_AFTER_S].
  if (typeof after !== 'number' || !Number.isFinite(after) || after < 1) {
    return { retryAfter: 1 }
  }
  return { retryAfter: Math.min(MAX_RETRY_AFTER_S, Math.ceil(after)) }
}

export function createRateLimitedTelegramApi(
  raw: TelegramApi,
  log: Logger,
  opts: RateLimitOptions = {},
): TelegramApi {
  const cfg = {
    perChatRefillPerSec: opts.perChatRefillPerSec ?? 1,
    perChatBurstCapacity: opts.perChatBurstCapacity ?? 3,
    globalRefillPerSec: opts.globalRefillPerSec ?? 25,
    globalBurstCapacity: opts.globalBurstCapacity ?? 25,
    maxRetries: opts.maxRetries ?? 2,
    jitterMaxMs: opts.jitterMaxMs ?? 150,
  }
  const now = opts.now ?? ((): number => Date.now())
  const sleep =
    opts.sleep ??
    ((ms: number): Promise<void> =>
      ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)))

  const globalBucket = makeBucket(cfg.globalBurstCapacity, cfg.globalRefillPerSec, now())
  const chatState = new Map<string, ChatState>()

  function getChatState(chatId: string): ChatState {
    let s = chatState.get(chatId)
    if (!s) {
      s = {
        bucket: makeBucket(cfg.perChatBurstCapacity, cfg.perChatRefillPerSec, now()),
        tail: Promise.resolve(),
      }
      chatState.set(chatId, s)
    }
    return s
  }

  // Wait until both the per-chat and global buckets have a token, then
  // consume one from each. Caller is responsible for holding the per-chat
  // FIFO lock so two enqueues for the same chat can't race this check.
  async function waitForCapacity(state: ChatState): Promise<void> {
    // Loop because after waking from sleep, another global consumer may
    // have stolen the token we expected. Recompute and re-sleep if so.
    // In single-threaded JS this is rare but the loop keeps invariants
    // robust against future async interleaving.
    for (;;) {
      const t = now()
      const chatWait = waitMs(state.bucket, t)
      const globalWait = waitMs(globalBucket, t)
      const w = Math.max(chatWait, globalWait)
      if (w === 0) {
        consume(state.bucket)
        consume(globalBucket)
        return
      }
      await sleep(w)
    }
  }

  // `maxRetries` is the MAX NUMBER OF ATTEMPTS including the initial call.
  // Semantically: budget of how many times we hit Telegram for this op.
  // maxRetries=2 → up to 2 attempts (1 retry after the first failure).
  async function withRetry<T>(method: string, op: () => Promise<T>): Promise<T> {
    let attempt = 0
    let lastErr: unknown
    while (true) {
      attempt += 1
      try {
        return await op()
      } catch (err) {
        const r = parse429(err)
        if (r === null) throw err
        lastErr = err
        if (attempt >= cfg.maxRetries) break
        const jitter =
          cfg.jitterMaxMs > 0 ? Math.floor(Math.random() * cfg.jitterMaxMs) : 0
        const waitTotalMs = r.retryAfter * 1000 + jitter
        log.warn('telegram 429, backing off', {
          method,
          retry_after_s: r.retryAfter,
          attempt,
          wait_ms: waitTotalMs,
        })
        await sleep(waitTotalMs)
      }
    }
    throw lastErr
  }

  // Serialize per-chat outbound work: each new op awaits the previous op
  // (without inheriting its error), then runs under the rate-limit gate.
  async function enqueueSend<T>(chatId: string, op: () => Promise<T>): Promise<T> {
    const state = getChatState(chatId)
    const prev = state.tail
    let release!: () => void
    state.tail = new Promise<void>((r) => {
      release = r
    })
    try {
      await prev.catch(() => {})
      await waitForCapacity(state)
      return await withRetry('send', op)
    } finally {
      release()
    }
  }

  return {
    async sendMessage(
      chatId: string,
      text: string,
      sendOpts: SendMessageOpts,
    ): Promise<{ message_id: number }> {
      return enqueueSend(chatId, () => raw.sendMessage(chatId, text, sendOpts))
    },

    async editMessageText(
      chatId: string,
      messageId: number,
      text: string,
      editOpts: EditOpts,
    ): Promise<void> {
      // Paced through the per-chat bucket: status-bubble edits fire every
      // few seconds during a turn and used to bypass the limiter entirely.
      return enqueueSend(chatId, () =>
        raw.editMessageText(chatId, messageId, text, editOpts),
      )
    },

    async setMessageReaction(
      chatId: string,
      messageId: number,
      emoji: string,
    ): Promise<void> {
      return enqueueSend(chatId, () =>
        raw.setMessageReaction(chatId, messageId, emoji),
      )
    },

    async sendChatAction(chatId: string, action: ChatAction): Promise<void> {
      // Best-effort, fire-and-forget. A "typing…" pulse is worthless once
      // stale, so it is never queued or retried — queuing/retrying chat
      // actions is pure flood pressure. Drop it when either bucket is out
      // of tokens; swallow any error (a missed indicator is cosmetic).
      const state = getChatState(chatId)
      const t = now()
      if (waitMs(state.bucket, t) > 0 || waitMs(globalBucket, t) > 0) return
      consume(state.bucket)
      consume(globalBucket)
      try {
        await raw.sendChatAction(chatId, action)
      } catch {
        /* cosmetic — ignore (incl. 429) */
      }
    },

    async sendDocument(
      chatId: string,
      filePath: string,
      docOpts: SendDocumentOpts,
    ): Promise<{ message_id: number }> {
      return enqueueSend(chatId, () => raw.sendDocument(chatId, filePath, docOpts))
    },

    async sendPhoto(
      chatId: string,
      filePath: string,
      photoOpts: SendDocumentOpts,
    ): Promise<{ message_id: number }> {
      return enqueueSend(chatId, () => raw.sendPhoto(chatId, filePath, photoOpts))
    },

    async downloadFile(fileId: string, destDir: string): Promise<DownloadResult> {
      return raw.downloadFile(fileId, destDir)
    },

    async deleteMessage(chatId: string, messageId: number): Promise<void> {
      return withRetry('deleteMessage', () => raw.deleteMessage(chatId, messageId))
    },
  }
}
