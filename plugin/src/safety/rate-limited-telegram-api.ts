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
//   3. 429 handling: on a grammY-shaped 429 (`error_code: 429`, optional
//      `parameters.retry_after`), a SHORT wait (<= MAX_RETRY_AFTER_S) is
//      slept off with a small jitter and the SAME call is retried, bounded
//      by `maxRetries` (default 3). A LONG wait is a bot-wide flood-wait
//      and is never retried — it throws TelegramFloodWaitError with the
//      real window. See MAX_RETRY_AFTER_S for why retrying makes it worse.
//   4. Flood-wait breaker: after a long wait is seen, every call is
//      rejected locally until the window expires, so no request can re-arm
//      the ban. See `sendBreaker`. The window is persisted through
//      `opts.floodWaitStore` so a process restart inside it does not forget
//      the ban and re-arm it with the first reply (Louis, 2026-09-18: 56483 s).
//   5. Every 429 (burst retry, flood-wait, local suppression) is reported
//      through `opts.onRateLimitEvent` with the Telegram METHOD name, so the
//      first call that earned a ban can be found afterwards instead of
//      guessed. server.ts wires this to logs/telegram-429.jsonl.
//
// Calls that are not part of TelegramApi (e.g. `setMyCommands` at startup)
// go through `withFloodGuard(method, op)` on the returned object so they get
// the same breaker + 429 handling instead of bypassing it.
//
// Methods that don't consume the send-bucket: editMessageText (Telegram's
// edit limits are far more lenient), setMessageReaction, sendChatAction,
// deleteMessage. They still get the send breaker and the 429 retry wrapper
// so a stray 429 on an edit can recover without the caller seeing it.
// downloadFile (getFile) has the 429 retry and a SEPARATE breaker: inbound
// voice and photos must keep working while the bot is banned from sending.
// Only the poller's getUpdates stays outside: it has its own retry_after
// handling (poller.ts, capped at 10 min) and must keep polling or the
// channel is deaf.
//
// Clock: `now` is epoch milliseconds (Date.now) — the persisted window is
// compared against it after a restart, so a monotonic clock would not do.
//
// Test seams: `opts.now` and `opts.sleep` replace the real clock and
// setTimeout-based sleep, so tests can run instantly with deterministic
// virtual time.

import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from 'fs'
import { dirname } from 'path'
import type { Logger } from '../log.js'
import type {
  AnswerGuestQueryOpts,
  ChatAction,
  DownloadResult,
  EditOpts,
  EditRichMessageResult,
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
  /**
   * Persists the flood-wait window across restarts. Loaded once at
   * construction; saved whenever a new (or longer) window is learned.
   * Omit for an in-memory breaker only (tests, ad-hoc tooling).
   */
  floodWaitStore?: FloodWaitStore
  /** Receives one event per 429-related decision. Must not throw. */
  onRateLimitEvent?: (event: RateLimitEvent) => void
}

/** What we remember about a flood-wait: enough to restore the breaker and to
 *  say afterwards which call earned it. */
export interface FloodWaitRecord {
  /** Epoch ms when the window closes. */
  until_ms: number
  /** Telegram method whose 429 opened (or extended) the window. */
  method: string
  retry_after_s: number
  /** ISO timestamp of the 429. */
  seen_at: string
  /**
   * Bot the window belongs to (numeric prefix of the token). A record from
   * a different bot in the same state dir is ignored on load.
   */
  bot_id?: string
}

export interface FloodWaitStore {
  /** Returns the last saved record, or null when none / unreadable. */
  load(): FloodWaitRecord | null
  /** Returns true only when the record is durably written. */
  save(record: FloodWaitRecord): boolean
}

// A save that failed (ENOSPC, permissions) is retried on the next 429-related
// event, but not more often than this — the failure will not fix itself in
// a millisecond and each attempt logs a warning.
const PERSIST_RETRY_MS = 30_000
// Suppressed requests inside a window are coalesced: one journal line and
// one warning per interval carrying the count, instead of one per call.
// A stuck agent can retry every few seconds for hours.
const SUPPRESSED_REPORT_INTERVAL_MS = 30_000
// The 429 journal is rotated once (to `<path>.1`) past this size.
const JOURNAL_ROTATE_BYTES = 5 * 1024 * 1024
// A failing file write is reported once per minute, not once per event.
const FS_WARN_INTERVAL_MS = 60_000

export type RateLimitEvent =
  | {
      kind: 'burst_retry'
      method: string
      chat_id?: string | undefined
      retry_after_s: number
      attempt: number
      wait_ms: number
    }
  | {
      kind: 'flood_wait'
      method: string
      chat_id?: string | undefined
      retry_after_s: number
      attempt: number
      window_opens_at: string
    }
  | {
      kind: 'suppressed'
      method: string
      chat_id?: string | undefined
      retry_after_s: number
      window_opens_at: string
      /** Suppressed calls this line stands for (coalesced per interval). */
      count: number
    }
  | {
      kind: 'restored'
      method: string
      retry_after_s: number
      window_opens_at: string
    }

export interface RateLimitedTelegramApi extends TelegramApi {
  /**
   * Run an arbitrary Bot API call under the flood-wait breaker and the 429
   * retry policy, without the per-chat send bucket. For calls that are not
   * on TelegramApi (startup `setMyCommands`, photo `getFile`, future
   * one-offs). `method` is the Telegram method name and ends up in the 429
   * log; `getFile` is routed to the download breaker, everything else to
   * the send breaker.
   */
  withFloodGuard<T>(method: string, op: () => Promise<T>): Promise<T>
}

// writeSync may write fewer bytes than asked; loop until the buffer is out.
function writeAllSync(fd: number, buf: Buffer): void {
  let off = 0
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off)
    if (n <= 0) throw new Error('short write')
    off += n
  }
}

// Warn about a failing file at most once per FS_WARN_INTERVAL_MS. A full or
// read-only disk would otherwise turn every 429 into a warning line.
function makeThrottledWarn(log: Logger, msg: string, path: string): (err: unknown) => void {
  let lastWarnMs = 0
  return (err: unknown): void => {
    const t = Date.now()
    if (t - lastWarnMs < FS_WARN_INTERVAL_MS) return
    lastWarnMs = t
    log.warn(msg, { path, error: err instanceof Error ? err.message : String(err) })
  }
}

export interface FileFloodWaitStoreOptions {
  /**
   * Bot the state belongs to (numeric prefix of the token). Stamped on save;
   * a record carrying a different bot_id is ignored on load, so swapping the
   * token inside the same TELEGRAM_STATE_DIR cannot inherit another bot's
   * ban. Omit to skip the check.
   */
  botId?: string | undefined
}

/**
 * File-backed FloodWaitStore. One small JSON file, written atomically
 * (tmp + fsync + rename, then a best-effort fsync of the directory) so a
 * crash mid-write cannot leave a half record. Guarantee: a `true` from
 * save() survives a process crash unconditionally; it survives power loss
 * when the filesystem honours directory fsync (ext4/xfs do) — where that
 * call fails it is ignored and the rename may be lost on power cut, which
 * is the same outcome as "no flood-wait known". A missing or corrupt file
 * reads as "no flood-wait known" — never as an error, the channel must
 * start regardless. Single writer by contract: the channel holds bot.pid,
 * so one process owns one state dir.
 */
export function createFileFloodWaitStore(
  path: string,
  log: Logger,
  storeOpts: FileFloodWaitStoreOptions = {},
): FloodWaitStore {
  const warnWrite = makeThrottledWarn(log, 'flood-wait state file write failed', path)
  return {
    load(): FloodWaitRecord | null {
      let raw: string
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        return null
      }
      try {
        const v = JSON.parse(raw) as Partial<FloodWaitRecord>
        if (
          typeof v !== 'object' ||
          v === null ||
          typeof v.until_ms !== 'number' ||
          !Number.isFinite(v.until_ms) ||
          typeof v.method !== 'string'
        ) {
          log.warn('flood-wait state file malformed, ignoring', { path })
          return null
        }
        const botId = typeof v.bot_id === 'string' ? v.bot_id : undefined
        if (storeOpts.botId !== undefined && botId !== undefined && botId !== storeOpts.botId) {
          log.warn('flood-wait state file belongs to another bot, ignoring', {
            path,
            file_bot_id: botId,
            bot_id: storeOpts.botId,
          })
          return null
        }
        return {
          until_ms: v.until_ms,
          method: v.method,
          retry_after_s:
            typeof v.retry_after_s === 'number' && Number.isFinite(v.retry_after_s)
              ? v.retry_after_s
              : 0,
          seen_at: typeof v.seen_at === 'string' ? v.seen_at : '',
          ...(botId !== undefined ? { bot_id: botId } : {}),
        }
      } catch (err) {
        log.warn('flood-wait state file unreadable, ignoring', {
          path,
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    },
    save(record: FloodWaitRecord): boolean {
      const stamped: FloodWaitRecord =
        storeOpts.botId !== undefined ? { ...record, bot_id: storeOpts.botId } : record
      const tmp = `${path}.tmp-${process.pid}`
      try {
        mkdirSync(dirname(path), { recursive: true })
        const fd = openSync(tmp, 'w', 0o600)
        try {
          writeAllSync(fd, Buffer.from(JSON.stringify(stamped) + '\n'))
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        renameSync(tmp, path)
        // The rename is durable only once the directory entry is flushed.
        // Not every filesystem allows fsync on a directory fd; treat that as
        // best-effort — the data file itself is already synced.
        try {
          const dfd = openSync(dirname(path), 'r')
          try {
            fsyncSync(dfd)
          } finally {
            closeSync(dfd)
          }
        } catch {
          // ignore: directory fsync unsupported here
        }
        return true
      } catch (err) {
        // Losing persistence is bad but must not turn a 429 into a crash.
        // The caller keeps the record dirty and retries later.
        warnWrite(err)
        return false
      }
    },
  }
}

/**
 * JSONL sink for RateLimitEvent: one line per event, `ts` first. Append-only
 * so a ban can be traced back to the exact method and time afterwards.
 * Rotated once to `<path>.1` past JOURNAL_ROTATE_BYTES; the previous `.1`
 * is dropped. Writes go to the file only — never to stdout, which is the
 * MCP transport.
 */
export function createJsonlRateLimitEventSink(
  path: string,
  log: Logger,
): (event: RateLimitEvent) => void {
  const warnWrite = makeThrottledWarn(log, 'telegram 429 log write failed', path)
  const warnRotate = makeThrottledWarn(log, 'telegram 429 log rotation failed', path)
  let dirReady = false
  return (event: RateLimitEvent): void => {
    try {
      if (!dirReady) {
        mkdirSync(dirname(path), { recursive: true })
        dirReady = true
      }
      // Rotation is best-effort and separate from the append: a rename that
      // keeps failing (EXDEV, permissions) must not blind the journal.
      try {
        if (statSync(path).size >= JOURNAL_ROTATE_BYTES) renameSync(path, `${path}.1`)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') warnRotate(err)
      }
      appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n', {
        mode: 0o600,
      })
    } catch (err) {
      warnWrite(err)
    }
  }
}

interface Grammy429 {
  error_code: 429
  parameters?: { retry_after?: number }
}

// Telegram's 429 comes in two flavours that need opposite handling:
//
//   • Burst hiccup — `retry_after` of a few seconds, caused by our own
//     pacing. Sleeping it off and retrying is correct and stays invisible
//     to the caller.
//   • Flood-wait — `retry_after` of minutes to HOURS, imposed on the bot
//     itself. Requests sent inside that window are not queued, they RE-ARM
//     the ban: on 2026-08-20 a 20191 s wait on richard's bot became
//     30710 s after two automatic retries — the retries alone bought ~3
//     extra hours of silence, and the message was dropped anyway.
//
// MAX_RETRY_AFTER_S is the line between the two. At or below it we retry
// as before. Above it we do NOT touch the API again: we fail fast and hand
// the caller a TelegramFloodWaitError carrying the true, unclamped wake-up
// time so it can resend once the window actually opens.
//
// This also keeps the per-chat FIFO tail short. The tail blocks every
// later send to the same chat until the in-flight op finishes, so the
// worst-case stall stays maxRetries × MAX_RETRY_AFTER_S (3 × 60s = 3 min).
const MAX_RETRY_AFTER_S = 60

/**
 * Thrown instead of retrying when Telegram reports a flood-wait longer than
 * MAX_RETRY_AFTER_S. `error_code` stays 429 so existing 429 checks keep
 * firing; `retryAfterS` / `windowOpensAtMs` carry the real window so the
 * caller can schedule a resend instead of guessing.
 */
export class TelegramFloodWaitError extends Error {
  readonly error_code = 429
  readonly retryAfterS: number
  readonly windowOpensAtMs: number

  constructor(method: string, retryAfterS: number, windowOpensAtMs: number, cause: unknown) {
    super(
      `Telegram flood-wait on ${method}: ${retryAfterS}s remaining, window opens ` +
        `${new Date(windowOpensAtMs).toISOString()}. Not retried — a retry inside ` +
        `the window extends the ban. Resend after that time.`,
      { cause },
    )
    this.name = 'TelegramFloodWaitError'
    this.retryAfterS = retryAfterS
    this.windowOpensAtMs = windowOpensAtMs
  }
}

function parse429(err: unknown): { retryAfter: number } | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as Grammy429
  if (e.error_code !== 429) return null
  const after = e.parameters?.retry_after
  // Telegram's retry_after is in seconds. Coerce to a sane positive integer.
  // Deliberately NOT clamped here: withRetry needs the true value to tell a
  // burst hiccup from a flood-wait, and to report the real window.
  if (typeof after !== 'number' || !Number.isFinite(after) || after < 1) {
    return { retryAfter: 1 }
  }
  return { retryAfter: Math.ceil(after) }
}

export function createRateLimitedTelegramApi(
  raw: TelegramApi,
  log: Logger,
  opts: RateLimitOptions = {},
): RateLimitedTelegramApi {
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

  // Circuit breaker for a bot-wide flood-wait. While one is in force every
  // further request RE-ARMS it rather than queueing behind it: on richard's
  // bot (2026-08-20) five reply attempts spread over 15 minutes each got the
  // identical `retry_after: 30710` back, so the window never came closer and
  // the agent would have stayed mute indefinitely. Once we learn a flood-wait
  // exists we therefore stop talking to Telegram altogether until it expires
  // and reject locally instead. That silence is what lets the ban run out.
  // 0 = no flood-wait known.
  //
  // Two independent breakers. `send` covers everything that talks TO chats
  // (messages, edits, reactions, actions, setMyCommands) and is the one
  // persisted across restarts. `download` covers getFile only: a ban on
  // sending must not make the agent deaf to the owner's voice notes and
  // photos for the whole window (Richard's review, 2026-09-18 — 15.7 h that
  // day), so getFile never reads or writes the send window. It still gets
  // its own breaker so a long 429 on getFile is not hammered either.
  interface Breaker {
    scope: 'send' | 'download'
    untilMs: number
  }
  const sendBreaker: Breaker = { scope: 'send', untilMs: 0 }
  const downloadBreaker: Breaker = { scope: 'download', untilMs: 0 }
  const store = opts.floodWaitStore
  const emit = (event: RateLimitEvent): void => {
    try {
      opts.onRateLimitEvent?.(event)
    } catch (err) {
      log.warn('rate-limit event sink threw', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Persistence is not fire-and-forget: the window the store last
  // acknowledged is tracked, and while memory is ahead of it (a save failed,
  // or threw) the record stays dirty. A NEW longer window is always written
  // at once — two in-flight requests can return different long 429s within
  // seconds and the longer one must win on disk too. Only RETRIES of a
  // failed save are throttled to PERSIST_RETRY_MS, and a retry is also
  // scheduled on a timer so the record lands even if no further request
  // ever comes. In-memory state always advances regardless.
  let persistedUntilMs = 0
  let lastPersistAttemptMs = -Infinity
  let pendingRecord: FloodWaitRecord | null = null
  let retryScheduled = false
  // Production timer is unref'd so a pending persist retry cannot hold the
  // process open at shutdown; tests inject `sleep` and drive it themselves.
  const retryTimer =
    opts.sleep ??
    ((ms: number): Promise<void> =>
      new Promise((r) => {
        const t = setTimeout(r, ms)
        t.unref?.()
      }))
  function trySave(record: FloodWaitRecord): boolean {
    lastPersistAttemptMs = now()
    try {
      return store?.save(record) === true
    } catch (err) {
      log.warn('flood-wait store save threw', {
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }
  function scheduleRetry(): void {
    if (retryScheduled) return
    retryScheduled = true
    const delay = Math.max(0, PERSIST_RETRY_MS - (now() - lastPersistAttemptMs))
    void retryTimer(delay).then(() => {
      retryScheduled = false
      persist(null)
    })
  }
  function persist(record: FloodWaitRecord | null): void {
    if (!store) return
    if (record) {
      // Newest window supersedes whatever was still pending.
      if (!pendingRecord || record.until_ms >= pendingRecord.until_ms) pendingRecord = record
    }
    if (!pendingRecord || pendingRecord.until_ms <= persistedUntilMs) {
      pendingRecord = null
      return
    }
    const isRetry = record === null
    if (isRetry && now() - lastPersistAttemptMs < PERSIST_RETRY_MS) {
      // Too soon to hit the disk again — but never drop the record: make
      // sure a timer will come back for it (idempotent).
      scheduleRetry()
      return
    }
    if (trySave(pendingRecord)) {
      persistedUntilMs = pendingRecord.until_ms
      pendingRecord = null
    } else {
      scheduleRetry()
    }
  }

  // Restore a window that outlived the previous process. Without this a
  // restart inside the ban forgets it, and the very next reply re-arms the
  // full window. An expired record is ignored (and left on disk; the next
  // flood-wait overwrites it). A store that throws on load is treated as
  // empty — the channel must start regardless.
  if (store) {
    let saved: FloodWaitRecord | null = null
    try {
      saved = store.load()
    } catch (err) {
      log.warn('flood-wait store load threw, starting without a window', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (saved && saved.until_ms > now()) {
      sendBreaker.untilMs = saved.until_ms
      persistedUntilMs = saved.until_ms
      const remainingS = Math.ceil((saved.until_ms - now()) / 1000)
      log.warn('telegram flood-wait restored from state, suppressing sends', {
        method: saved.method,
        retry_after_s: remainingS,
        window_opens_at: new Date(saved.until_ms).toISOString(),
        seen_at: saved.seen_at,
      })
      emit({
        kind: 'restored',
        method: saved.method,
        retry_after_s: remainingS,
        window_opens_at: new Date(saved.until_ms).toISOString(),
      })
    }
  }

  // Suppressed calls are coalesced per method and per window: the first one
  // in an interval is reported at once, the rest are counted and flushed
  // with the next report, when the window they belong to changes, or when
  // the breaker closes (first call that passes it). So no tail is lost and
  // no count leaks into a later window. chat_id is reported only when every
  // call in the aggregate came from the same chat.
  interface SuppressedAgg {
    scope: Breaker['scope']
    count: number
    lastReportMs: number
    chatId: string | undefined
    mixedChats: boolean
    windowUntilMs: number
  }
  const suppressedPending = new Map<string, SuppressedAgg>()
  function flushSuppressed(method: string, s: SuppressedAgg): void {
    if (s.count === 0) return
    const retryAfterS = Math.max(0, Math.ceil((s.windowUntilMs - now()) / 1000))
    const windowOpensAt = new Date(s.windowUntilMs).toISOString()
    const chatId = s.mixedChats ? undefined : s.chatId
    log.warn('telegram flood-wait in force, request suppressed', {
      method,
      retry_after_s: retryAfterS,
      window_opens_at: windowOpensAt,
      count: s.count,
    })
    emit({
      kind: 'suppressed',
      method,
      ...(chatId !== undefined ? { chat_id: chatId } : {}),
      retry_after_s: retryAfterS,
      window_opens_at: windowOpensAt,
      count: s.count,
    })
    s.count = 0
    s.chatId = undefined
    s.mixedChats = false
    s.lastReportMs = now()
  }
  function flushScopeSuppressed(scope: Breaker['scope']): void {
    for (const [method, s] of suppressedPending) {
      if (s.scope !== scope) continue
      flushSuppressed(method, s)
      suppressedPending.delete(method)
    }
  }
  function reportSuppressed(method: string, chatId: string | undefined, breaker: Breaker): void {
    let s = suppressedPending.get(method)
    if (s && s.windowUntilMs !== breaker.untilMs) {
      // The window was extended: close the old aggregate first.
      flushSuppressed(method, s)
      s = undefined
    }
    if (!s) {
      s = {
        scope: breaker.scope,
        count: 0,
        lastReportMs: -Infinity,
        chatId: undefined,
        mixedChats: false,
        windowUntilMs: breaker.untilMs,
      }
      suppressedPending.set(method, s)
    }
    if (s.count === 0) s.chatId = chatId
    else if (s.chatId !== chatId) s.mixedChats = true
    s.count += 1
    if (now() - s.lastReportMs >= SUPPRESSED_REPORT_INTERVAL_MS) flushSuppressed(method, s)
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
  async function withRetry<T>(
    method: string,
    op: () => Promise<T>,
    chatId?: string,
    breaker: Breaker = sendBreaker,
  ): Promise<T> {
    let attempt = 0
    let lastErr: unknown
    while (true) {
      attempt += 1
      const suppressedForMs = breaker.untilMs - now()
      if (suppressedForMs > 0) {
        // Breaker open — do not touch the API, it would only re-arm the ban.
        const retryAfterS = Math.ceil(suppressedForMs / 1000)
        reportSuppressed(method, chatId, breaker)
        // A send window that never reached disk gets another chance here.
        if (breaker === sendBreaker) persist(null)
        throw new TelegramFloodWaitError(method, retryAfterS, breaker.untilMs, lastErr)
      }
      // Breaker closed: whatever was counted during its window goes out now.
      if (suppressedPending.size > 0) flushScopeSuppressed(breaker.scope)
      try {
        return await op()
      } catch (err) {
        // A guarded op nested inside another guarded op: the inner wrapper
        // already handled the 429 and opened its breaker. Propagate as is —
        // re-parsing it as a 1 s burst would sleep and retry the outer op.
        if (err instanceof TelegramFloodWaitError) throw err
        const r = parse429(err)
        if (r === null) throw err
        lastErr = err
        if (r.retryAfter > MAX_RETRY_AFTER_S) {
          // Flood-wait, not a burst. Stop here — see MAX_RETRY_AFTER_S — and
          // open the breaker so nothing else re-arms it. Never shorten a
          // window we already know about.
          const windowOpensAtMs = now() + r.retryAfter * 1000
          const extended = windowOpensAtMs > breaker.untilMs
          breaker.untilMs = Math.max(breaker.untilMs, windowOpensAtMs)
          const windowOpensAt = new Date(windowOpensAtMs).toISOString()
          log.warn('telegram flood-wait, not retrying', {
            method,
            retry_after_s: r.retryAfter,
            attempt,
            window_opens_at: windowOpensAt,
          })
          emit({ kind: 'flood_wait', method, chat_id: chatId, retry_after_s: r.retryAfter, attempt, window_opens_at: windowOpensAt })
          // Only the send window is persisted: a getFile ban is not what
          // re-arms on restart, and it must never block sends after one.
          if (breaker === sendBreaker) {
            persist(
              extended
                ? {
                    until_ms: breaker.untilMs,
                    method,
                    retry_after_s: r.retryAfter,
                    seen_at: new Date(now()).toISOString(),
                  }
                : null,
            )
          }
          throw new TelegramFloodWaitError(method, r.retryAfter, breaker.untilMs, err)
        }
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
        emit({ kind: 'burst_retry', method, chat_id: chatId, retry_after_s: r.retryAfter, attempt, wait_ms: waitTotalMs })
        await sleep(waitTotalMs)
      }
    }
    throw lastErr
  }

  // Serialize per-chat outbound work: each new op awaits the previous op
  // (without inheriting its error), then runs under the rate-limit gate.
  async function enqueueSend<T>(
    chatId: string,
    method: string,
    op: () => Promise<T>,
  ): Promise<T> {
    const state = getChatState(chatId)
    const prev = state.tail
    let release!: () => void
    state.tail = new Promise<void>((r) => {
      release = r
    })
    try {
      await prev.catch(() => {})
      await waitForCapacity(state)
      return await withRetry(method, op, chatId)
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
      return enqueueSend(chatId, 'sendMessage', () => raw.sendMessage(chatId, text, sendOpts))
    },

    // Rich messages consume the same per-chat send budget as a normal
    // sendMessage (one outbound bubble), so they route through the identical
    // FIFO + token-bucket + 429-retry path. Ordering with sibling sends to
    // the same chat is preserved.
    async editRichMessage(
      chatId: string,
      messageId: number,
      rawMarkdown: string,
    ): Promise<EditRichMessageResult> {
      // Edits target a message already on screen — they do not create a new
      // one, so they do not go through the per-chat send queue. Same path as
      // editMessageText: send breaker + 429 retry, no bucket. Journalled
      // under its own name so a 429 earned by a rich edit is attributed to
      // it, not to a plain edit.
      return withRetry(
        'editRichMessage',
        () => raw.editRichMessage(chatId, messageId, rawMarkdown),
        chatId,
      )
    },

    async sendRichMessage(
      chatId: string,
      rawMarkdown: string,
      richOpts: SendRichMessageOpts,
    ): Promise<SendRichMessageResult> {
      return enqueueSend(chatId, 'sendRichMessage', () =>
        raw.sendRichMessage(chatId, rawMarkdown, richOpts),
      )
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
        chatId,
      )
    },

    async setMessageReaction(
      chatId: string,
      messageId: number,
      emoji: string,
    ): Promise<void> {
      return withRetry(
        'setMessageReaction',
        () => raw.setMessageReaction(chatId, messageId, emoji),
        chatId,
      )
    },

    async sendChatAction(chatId: string, action: ChatAction): Promise<void> {
      return withRetry('sendChatAction', () => raw.sendChatAction(chatId, action), chatId)
    },

    async sendDocument(
      chatId: string,
      filePath: string,
      docOpts: SendDocumentOpts,
    ): Promise<{ message_id: number }> {
      return enqueueSend(chatId, 'sendDocument', () => raw.sendDocument(chatId, filePath, docOpts))
    },

    async sendPhoto(
      chatId: string,
      filePath: string,
      photoOpts: SendDocumentOpts,
    ): Promise<{ message_id: number }> {
      return enqueueSend(chatId, 'sendPhoto', () => raw.sendPhoto(chatId, filePath, photoOpts))
    },

    async downloadFile(fileId: string, destDir: string): Promise<DownloadResult> {
      // getFile is a Bot API call, so it gets the 429 retry and a breaker —
      // its OWN one. A ban on sending must not stop inbound voice and photos.
      return withRetry('getFile', () => raw.downloadFile(fileId, destDir), undefined, downloadBreaker)
    },

    async deleteMessage(chatId: string, messageId: number): Promise<void> {
      return withRetry('deleteMessage', () => raw.deleteMessage(chatId, messageId), chatId)
    },

    async withFloodGuard<T>(method: string, op: () => Promise<T>): Promise<T> {
      return withRetry(method, op, undefined, method === 'getFile' ? downloadBreaker : sendBreaker)
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
