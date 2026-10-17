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
//      jitter and retry the SAME call. Bounded by `maxRetries` (default 3).
//      A retry_after above MAX_RETRY_AFTER_S is NOT slept on in-process: the
//      error surfaces immediately (sleeping 60s into a multi-hour ban only
//      queued more doomed attempts — incident 2026-10-16, ~7h ban).
//   4. Bot-wide flood gate: every 429 (any method) closes the gate until
//      now + the REAL retry_after (uncapped). While it is closed:
//        • `background` calls (mirror / status / progress edits, chat-action
//          pulses) are skipped WITHOUT hitting the API — they throw a local
//          429 whose retry_after is the remaining gate time, so callers'
//          flood-pause logic parks them until the gate opens;
//        • user-facing calls get exactly ONE attempt (no in-process retry).
//      Background calls are never 429-retried in-process either: they fail
//      fast so the caller pauses instead of holding a sleep.
//
// Methods that don't consume the send-bucket: editMessageText (Telegram's
// edit limits are far more lenient), setMessageReaction, sendChatAction,
// deleteMessage, downloadFile. They still get the 429 retry wrapper so a
// stray 429 on an edit can recover without the caller seeing it (unless the
// edit is `background`, see layer 4).
//
// Test seams: `opts.now` and `opts.sleep` replace the real clock and
// setTimeout-based sleep, so tests can run instantly with deterministic
// virtual time.

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

// Longest retry_after we are willing to SLEEP on in-process. The per-chat
// tail-promise chain blocks all subsequent sends to the same chat until the
// in-flight op finishes, so worst-case stall = maxRetries × MAX_RETRY_AFTER_S.
// A longer retry_after is not slept on at all: the caller sees the 429 at
// once and the flood gate (layer 4) holds background traffic for the REAL
// retry_after.
const MAX_RETRY_AFTER_S = 60
// Sanity ceiling for the flood gate only (a NaN-ish / absurd value must not
// silence the bot for weeks). Real Telegram bans observed: up to ~7h.
const MAX_FLOOD_GATE_S = 24 * 60 * 60

// `retryAfter` = REAL value (seconds, ≥1, ceiling MAX_FLOOD_GATE_S);
// callers decide whether it is short enough to sleep on in-process.
function parse429(err: unknown): { retryAfter: number } | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as Grammy429
  if (e.error_code !== 429) return null
  const after = e.parameters?.retry_after
  // Telegram's retry_after is in seconds. Coerce to a sane positive integer.
  if (typeof after !== 'number' || !Number.isFinite(after) || after < 1) {
    return { retryAfter: 1 }
  }
  return { retryAfter: Math.min(MAX_FLOOD_GATE_S, Math.ceil(after)) }
}

/** Marker on the locally-built 429 thrown while the flood gate is closed. */
export interface FloodGateError extends Error {
  error_code: 429
  description: string
  parameters: { retry_after: number }
  flood_gate: true
}

export function isFloodGateError(err: unknown): err is FloodGateError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { flood_gate?: unknown }).flood_gate === true
  )
}

function makeFloodGateError(method: string, remainingMs: number): FloodGateError {
  const retryAfter = Math.max(1, Math.ceil(remainingMs / 1000))
  const err = new Error(
    `Too Many Requests: flood gate closed, ${method} skipped locally (retry after ${retryAfter})`,
  ) as FloodGateError
  err.error_code = 429
  err.description = err.message
  err.parameters = { retry_after: retryAfter }
  err.flood_gate = true
  return err
}

type CallMode = 'normal' | 'background'

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
    maxRetries: opts.maxRetries ?? 3,
    jitterMaxMs: opts.jitterMaxMs ?? 150,
  }
  const now = opts.now ?? ((): number => Date.now())
  const sleep =
    opts.sleep ??
    ((ms: number): Promise<void> =>
      ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)))

  const globalBucket = makeBucket(cfg.globalBurstCapacity, cfg.globalRefillPerSec, now())
  const chatState = new Map<string, ChatState>()
  // Bot-wide flood gate (layer 4): epoch ms until which Telegram told us to
  // back off. 0 / past = open. Only ever extended, never shortened.
  let floodUntil = 0

  function noteFlood(method: string, retryAfterS: number): void {
    const until = now() + retryAfterS * 1000
    if (until > floodUntil) {
      floodUntil = until
      log.warn('telegram 429, flood gate closed', {
        method,
        retry_after_s: retryAfterS,
      })
    }
  }

  function gateRemainingMs(): number {
    return Math.max(0, floodUntil - now())
  }

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
  // maxRetries=3 → up to 3 attempts (2 retries after the first failure).
  //
  // Flood gate (layer 4): `background` calls are skipped outright while the
  // gate is closed and are never retried; `normal` calls made while the gate
  // is closed get a single attempt. Every 429 extends the gate.
  async function withRetry<T>(
    method: string,
    op: () => Promise<T>,
    mode: CallMode = 'normal',
  ): Promise<T> {
    const gated = gateRemainingMs()
    if (mode === 'background' && gated > 0) {
      throw makeFloodGateError(method, gated)
    }
    const maxAttempts = mode === 'background' || gated > 0 ? 1 : cfg.maxRetries
    let attempt = 0
    let lastErr: unknown
    while (true) {
      attempt += 1
      try {
        return await op()
      } catch (err) {
        const r = parse429(err)
        if (r === null) throw err
        noteFlood(method, r.retryAfter)
        lastErr = err
        if (attempt >= maxAttempts) break
        // A long ban is not slept on in-process — the caller sees the 429
        // now, and the gate keeps everything else off the API meanwhile.
        if (r.retryAfter > MAX_RETRY_AFTER_S) break
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
  async function enqueueSend<T>(
    chatId: string,
    op: () => Promise<T>,
    mode: CallMode = 'normal',
  ): Promise<T> {
    // Background sends never queue behind the per-chat FIFO while the gate
    // is closed — skip before taking a token.
    const gated = gateRemainingMs()
    if (mode === 'background' && gated > 0) {
      throw makeFloodGateError('send', gated)
    }
    const state = getChatState(chatId)
    const prev = state.tail
    let release!: () => void
    state.tail = new Promise<void>((r) => {
      release = r
    })
    try {
      await prev.catch(() => {})
      await waitForCapacity(state)
      return await withRetry('send', op, mode)
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
      return enqueueSend(
        chatId,
        () => raw.sendMessage(chatId, text, sendOpts),
        sendOpts.background === true ? 'background' : 'normal',
      )
    },

    // Rich messages consume the same per-chat send budget as a normal
    // sendMessage (one outbound bubble), so they route through the identical
    // FIFO + token-bucket + 429-retry path. Ordering with sibling sends to
    // the same chat is preserved.
    async editRichMessage(
      chatId: string,
      messageId: number,
      rawMarkdown: string,
    ) {
      // Edits target a message already on screen — they do not create a new
      // one, so they do not go through the per-chat send queue. Pass straight
      // through, exactly like editMessageText does.
      return raw.editRichMessage(chatId, messageId, rawMarkdown)
    },

    async sendRichMessage(
      chatId: string,
      rawMarkdown: string,
      richOpts: SendRichMessageOpts,
    ): Promise<SendRichMessageResult> {
      return enqueueSend(chatId, () => raw.sendRichMessage(chatId, rawMarkdown, richOpts))
    },

    async editMessageText(
      chatId: string,
      messageId: number,
      text: string,
      editOpts: EditOpts,
    ): Promise<void> {
      return withRetry(
        'editMessageText',
        () => raw.editMessageText(chatId, messageId, text, editOpts),
        editOpts.background === true ? 'background' : 'normal',
      )
    },

    async setMessageReaction(
      chatId: string,
      messageId: number,
      emoji: string,
    ): Promise<void> {
      return withRetry('setMessageReaction', () =>
        raw.setMessageReaction(chatId, messageId, emoji),
      )
    },

    async sendChatAction(chatId: string, action: ChatAction): Promise<void> {
      // Typing pulses are pure decoration — always background.
      return withRetry(
        'sendChatAction',
        () => raw.sendChatAction(chatId, action),
        'background',
      )
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

    async answerGuestQuery(
      guestQueryId: string,
      text: string,
      guestOpts: AnswerGuestQueryOpts,
    ): Promise<void> {
      // No per-chat FIFO: guest queries have no allowlisted chat id and are
      // one-shot by contract — there is never a second send to order after.
      // The 429-retry wrapper still applies (a retry of a FAILED call does
      // not double-answer; Telegram only consumes the query on success).
      return withRetry('answerGuestQuery', () =>
        raw.answerGuestQuery(guestQueryId, text, guestOpts),
      )
    },
  }
}
