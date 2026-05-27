// Durable Telegram long-poller.
//
// Replaces the legacy bot.start() retry loop from refs/telegram-official.
// Differences from grammY's built-in polling:
//   1. We own the offset cursor: read from disk before polling, persist
//      AFTER each successful handler (or dead-letter write). Survives
//      crashes between updates without re-delivering already-handled ones.
//   2. We dispatch through an injectable onUpdate hook so tests can stub
//      grammY entirely. In server.ts, onUpdate delegates to bot.handleUpdate.
//   3. Token-lock (bot.pid) is acquired BEFORE polling — second instance
//      with same token bails out cleanly instead of hitting 409 storms.
//
// Error policy:
//   - 409 Conflict: backoff Math.min(1000*attempt, 15000); after 8 attempts
//     give up (another consumer holds the token — operator action required).
//   - 401 Unauthorized: backoff briefly, give up after 3 attempts (token
//     revoked — no point retrying).
//   - 429 Too Many Requests: honour Telegram's `parameters.retry_after`
//     (seconds); sleep that long + 100..500ms jitter, capped at 600s. Falls
//     back to linear backoff when the field is missing.
//   - Network / transient: backoff and retry indefinitely; attempt counter
//     resets after any successful getUpdates round.
//   - Handler errors NEVER stop polling. Each thrown handler goes to
//     dead-letter/updates/ and offset advances past the bad update.

import { constants as fsConstants, closeSync, openSync, readFileSync, rmSync, unlinkSync, writeSync } from 'fs'
import type { Bot } from 'grammy'
import { GrammyError, HttpError } from 'grammy'
import type { Update } from 'grammy/types'

import type { AppConfig, StatePaths } from '../config.js'
import type { Logger } from '../log.js'
import { TelegramUpdateSchema } from '../schemas.js'
import { readUpdateOffset, writeDeadLetter, writeUpdateOffset } from '../state/store.js'

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

/**
 * Thrown by the poller loop when retry budget for a fatal-class error is
 * exhausted (409 Conflict — another consumer owns the token; 401 Unauthorized
 * — token revoked). server.ts's start() wrapper catches this and triggers
 * shutdown — otherwise the MCP server would stay alive with no active
 * Telegram consumer, silently dropping every inbound update.
 */
export class PollerFatalError extends Error {
  readonly kind: 'conflict' | 'unauthorized'
  readonly attempts: number
  constructor(kind: 'conflict' | 'unauthorized', message: string, attempts: number) {
    super(message)
    this.name = 'PollerFatalError'
    this.kind = kind
    this.attempts = attempts
  }
}

export interface PollerDeps {
  bot: Bot
  config: AppConfig
  statePaths: StatePaths
  log: Logger
  onUpdate: (update: Update) => Promise<void>
}

export interface PollResult {
  handled: number
  errors: number
  offsetAfter: number | undefined
}

// Minimal subset of bot.api.getUpdates we rely on. Lets tests inject a
// fake without spinning up a real Bot. Keep this narrow — anything else
// the poller needs from grammY goes through deps.bot.handleUpdate via
// onUpdate.
type GetUpdatesFn = (params: {
  offset?: number
  timeout: number
  allowed_updates?: ReadonlyArray<Exclude<keyof Update, 'update_id'>>
}) => Promise<Update[]>

const LONG_POLL_TIMEOUT_SEC = 25
const MAX_409_ATTEMPTS = 8
const MAX_401_ATTEMPTS = 3
const BACKOFF_CAP_MS = 15_000
// Cap honour-retry_after at 10 minutes. If Telegram asks for longer the
// answer is "operator action" rather than "sleep for hours".
const FLOOD_BACKOFF_CAP_MS = 600_000
const FLOOD_JITTER_MIN_MS = 100
const FLOOD_JITTER_MAX_MS = 500

// Update types we want from Telegram. Anything else is silently dropped
// by the API. Mirrors the grammY default plus what canary handlers use.
const ALLOWED_UPDATES: ReadonlyArray<Exclude<keyof Update, 'update_id'>> = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'callback_query',
]

// ─────────────────────────────────────────────────────────────────────
// Token lock: bot.pid file with PID liveness check.
// ─────────────────────────────────────────────────────────────────────

export interface TokenLock {
  acquire(statePaths: StatePaths): boolean
  release(statePaths: StatePaths): void
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 1) return false
  try {
    // Signal 0 sends no signal but throws ESRCH if pid is gone, EPERM if
    // alive but owned by another user. Either way EPERM means alive.
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPERM') return true
    return false
  }
}

// Try to atomically create `path` with `O_WRONLY|O_CREAT|O_EXCL` ('wx') and
// write `pid` into it. Returns true on success, false if the file already
// exists (EEXIST). Any other error is rethrown — disk/perm issues must not
// be silently treated as "lock acquired".
function tryExclusiveCreate(path: string, pid: number): boolean {
  let fd: number
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
  try {
    writeSync(fd, String(pid))
  } finally {
    closeSync(fd)
  }
  return true
}

// FIX-B: Replace stale via unlink + O_EXCL retry loop instead of
// renameSync(tmp, path). renameSync is atomic but DOES NOT fail when the
// target exists — two processes that both observed the same dead pid would
// each rename their own tmp file over the lock and BOTH return true.
//
// The unlink + O_EXCL pattern narrows the race to a tight CAS-like window:
//   1. unlinkSync(path) — may ENOENT if a competitor already unlinked; that
//      is fine.
//   2. tryExclusiveCreate(path, pid) — exactly one process wins O_EXCL; the
//      other sees EEXIST and must re-inspect (someone else now holds the
//      lock, and if THAT pid is alive we refuse).
//
// Bounded by MAX_REPLACE_ATTEMPTS=3: after 3 EEXIST collisions we give up
// and return false instead of livelocking. In practice 1 attempt is enough;
// 3 is generous slack for pathological scheduling.
const MAX_REPLACE_ATTEMPTS = 3

// Filesystem seams. Production passes real fs functions; tests inject
// interleaving stubs to drive the hard-race scenario deterministically.
export interface AcquireHooks {
  tryExclusiveCreate: (path: string, pid: number) => boolean
  readPidFile: (path: string) => number
  unlinkLock: (path: string) => void
  pidAlive: (pid: number) => boolean
  selfPid: number
}

const realHooks: AcquireHooks = {
  tryExclusiveCreate,
  readPidFile(path: string): number {
    try {
      const raw = readFileSync(path, 'utf8').trim()
      return Number.parseInt(raw, 10)
    } catch {
      return NaN
    }
  },
  unlinkLock(path: string): void {
    try {
      unlinkSync(path)
    } catch (err) {
      // ENOENT: a competitor already unlinked it — fine, fall through to
      // tryExclusiveCreate which will either succeed or report EEXIST.
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      throw err
    }
  },
  pidAlive,
  get selfPid(): number {
    return process.pid
  },
}

// Core acquire algorithm, parameterised over fs hooks for testability.
// Returns true iff WE hold the lock (file contains our pid) on return.
export function acquireWithHooks(statePaths: StatePaths, hooks: AcquireHooks): boolean {
  // Fast path: no lock file at all → atomically create it. The 'wx' flag
  // guarantees that two competing acquire() calls cannot both succeed:
  // exactly one openSync returns a fd, the other gets EEXIST.
  if (hooks.tryExclusiveCreate(statePaths.pid, hooks.selfPid)) return true

  for (let attempt = 0; attempt < MAX_REPLACE_ATTEMPTS; attempt++) {
    const existing = hooks.readPidFile(statePaths.pid)

    // Our own pid (re-acquire in the same process) → no-op success: we
    // already hold the lock.
    if (Number.isFinite(existing) && existing === hooks.selfPid) {
      return true
    }
    // Live foreign pid → refuse.
    if (Number.isFinite(existing) && hooks.pidAlive(existing)) {
      return false
    }

    // Stale (dead pid or unparseable). Unlink and try to claim.
    try {
      hooks.unlinkLock(statePaths.pid)
    } catch (err) {
      // Permission or other IO error on unlink — we can't prove we own
      // anything; bail safely.
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        // Already gone; fall through to tryExclusiveCreate.
      } else {
        return false
      }
    }

    if (hooks.tryExclusiveCreate(statePaths.pid, hooks.selfPid)) return true
    // EEXIST: another process beat us to the create. Re-inspect: if its
    // pid is alive we refuse; if it's also stale we try again, up to
    // MAX_REPLACE_ATTEMPTS.
  }

  // All retries exhausted — give up. Refusing here is safe: another
  // process either holds the lock or is racing us so aggressively that
  // we cannot prove ownership.
  return false
}

export const tokenLock: TokenLock = {
  acquire(statePaths: StatePaths): boolean {
    return acquireWithHooks(statePaths, realHooks)
  },

  release(statePaths: StatePaths): void {
    try {
      const raw = readFileSync(statePaths.pid, 'utf8').trim()
      const owner = Number.parseInt(raw, 10)
      if (owner === process.pid) {
        rmSync(statePaths.pid)
      }
      // Foreign pid -- leave it, not ours to delete.
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return // Already gone -- nothing to do.
      // Unreadable for another reason -- swallow; release is best-effort.
    }
  },
}

// ─────────────────────────────────────────────────────────────────────
// TelegramPoller
// ─────────────────────────────────────────────────────────────────────

interface ErrorClass {
  kind: 'conflict' | 'unauthorized' | 'flood' | 'transient' | 'fatal'
  message: string
  retriable: boolean
  // Populated only for 'flood': Telegram's parameters.retry_after, in
  // seconds. May be undefined when Telegram omitted the hint and we still
  // got a 429 -- caller falls back to linear backoff.
  retryAfterSec?: number
}

function classifyError(err: unknown): ErrorClass {
  if (err instanceof GrammyError) {
    if (err.error_code === 409) {
      return { kind: 'conflict', message: err.description, retriable: true }
    }
    if (err.error_code === 401) {
      return { kind: 'unauthorized', message: err.description, retriable: true }
    }
    if (err.error_code === 429) {
      const raw = err.parameters?.retry_after
      const retryAfterSec =
        typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined
      const cls: ErrorClass = {
        kind: 'flood',
        message: `429 ${err.description}`,
        retriable: true,
      }
      if (retryAfterSec !== undefined) cls.retryAfterSec = retryAfterSec
      return cls
    }
    return { kind: 'transient', message: `${err.error_code} ${err.description}`, retriable: true }
  }
  if (err instanceof HttpError) {
    return { kind: 'transient', message: err.message, retriable: true }
  }
  if (err instanceof Error) {
    // Network errors carry .code (ETIMEDOUT/ECONNRESET/ENOTFOUND/EAI_AGAIN).
    return { kind: 'transient', message: err.message, retriable: true }
  }
  return { kind: 'fatal', message: String(err), retriable: false }
}

// Compute the actual sleep duration for a 429 response. Adds 100..500ms
// jitter so concurrent retries don't dogpile, caps at FLOOD_BACKOFF_CAP_MS.
// When `retryAfterSec` is undefined (Telegram omitted the hint), falls back
// to the existing linear backoff so behaviour is purely additive.
function floodSleepMs(
  retryAfterSec: number | undefined,
  attempt: number,
  rng: () => number = Math.random,
): number {
  const jitter =
    FLOOD_JITTER_MIN_MS + Math.floor(rng() * (FLOOD_JITTER_MAX_MS - FLOOD_JITTER_MIN_MS))
  if (retryAfterSec !== undefined) {
    const base = Math.max(0, retryAfterSec) * 1000
    return Math.min(base + jitter, FLOOD_BACKOFF_CAP_MS)
  }
  return Math.min(1000 * Math.max(1, attempt), BACKOFF_CAP_MS)
}

/**
 * Validate one update from the wire against `TelegramUpdateSchema`. Returns
 * either {ok: true, update_id} so the caller can advance the offset, or
 * {ok: false, update_id?} when validation fails — in which case the caller
 * MUST dead-letter the raw update and advance past it (returning to poll
 * again would loop on the same malformed payload forever).
 */
function validateUpdate(
  raw: unknown,
): { ok: true; update_id: number } | { ok: false; error: string; update_id: number | undefined } {
  const parsed = TelegramUpdateSchema.safeParse(raw)
  if (parsed.success) {
    return { ok: true, update_id: parsed.data.update_id }
  }
  // Best-effort: pull update_id off the raw object for offset bookkeeping
  // even when the rest of the shape is bad. If we can't, the caller will
  // skip the update entirely (offset stays put — next poll moves on).
  let probedId: number | undefined
  if (raw && typeof raw === 'object' && 'update_id' in raw) {
    const v = (raw as Record<string, unknown>).update_id
    if (typeof v === 'number' && Number.isFinite(v)) probedId = v
  }
  return { ok: false, error: parsed.error.message, update_id: probedId }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class TelegramPoller {
  private readonly deps: PollerDeps
  private readonly getUpdates: GetUpdatesFn
  private readonly sleepFn: (ms: number, signal: AbortSignal) => Promise<void>
  private stopping = false
  private offset: number | undefined
  private readonly stopCtl = new AbortController()
  private runningLoop: Promise<void> | undefined

  constructor(
    deps: PollerDeps,
    overrides?: {
      getUpdates?: GetUpdatesFn
      // Test seam: replace the backoff sleep so retry-loop tests don't pay
      // real wall-clock time (1+2+…+7s adds 28s to the 409 fatal test).
      sleep?: (ms: number, signal: AbortSignal) => Promise<void>
    },
  ) {
    this.deps = deps
    this.offset = readUpdateOffset(deps.statePaths)
    this.sleepFn = overrides?.sleep ?? sleep
    // Default: real grammY API. Test seam: override.
    this.getUpdates = overrides?.getUpdates
      ?? ((params): Promise<Update[]> => {
        // grammY's getUpdates signature accepts a single options object;
        // we shape ours to match.
        const options: {
          offset?: number
          timeout: number
          allowed_updates?: ReadonlyArray<Exclude<keyof Update, 'update_id'>>
        } = { timeout: params.timeout }
        if (params.offset !== undefined) options.offset = params.offset
        if (params.allowed_updates !== undefined) options.allowed_updates = params.allowed_updates
        return deps.bot.api.getUpdates(options)
      })
  }

  /**
   * Validate the bot token via getMe (also a cheap health-check before
   * entering the long-poll loop) and start the polling loop. Resolves
   * when stop() is called and the loop exits, or when fatal errors
   * exceed retry budgets.
   */
  async start(): Promise<void> {
    const { bot, config, log } = this.deps

    // 1. getMe sanity check — verify token is valid and bot_id matches.
    //    grammY's bot.init() does the same getMe internally; we call it
    //    explicitly so we can compare ids before any handler fires.
    if (!bot.isInited()) {
      await bot.init()
    }
    const me = bot.botInfo
    if (me.id !== config.bot_id) {
      throw new Error(
        `telegram bot_id mismatch: token belongs to ${me.id}, config expects ${config.bot_id}`,
      )
    }
    log.info('poller bot identity verified', { id: me.id, username: me.username })

    // 2. Enter the polling loop. We track the loop promise so stop()
    //    can await it.
    this.runningLoop = this.loop()
    await this.runningLoop
  }

  /**
   * Signal the loop to exit. Safe to call multiple times. Returns when
   * the loop has actually stopped.
   */
  async stop(): Promise<void> {
    this.stopping = true
    if (!this.stopCtl.signal.aborted) {
      this.stopCtl.abort()
    }
    if (this.runningLoop) {
      try {
        await this.runningLoop
      } catch {
        // start() already logged; stop() is best-effort.
      }
    }
  }

  /**
   * Test helper: run exactly one getUpdates round and dispatch the
   * returned updates. Does NOT apply backoff or retry — caller (start
   * loop) is responsible for that.
   */
  async pollOnce(): Promise<PollResult> {
    const { log } = this.deps

    const getUpdatesParams: {
      offset?: number
      timeout: number
      allowed_updates: ReadonlyArray<Exclude<keyof Update, 'update_id'>>
    } = { timeout: 0, allowed_updates: ALLOWED_UPDATES }
    if (this.offset !== undefined) getUpdatesParams.offset = this.offset

    const updates = await this.getUpdates(getUpdatesParams)

    let handled = 0
    let errors = 0
    for (const update of updates as unknown[]) {
      const v = validateUpdate(update)
      if (!v.ok) {
        errors++
        log.error('update failed Zod validation — dead-letter, advancing offset', {
          update_id: v.update_id,
          error: v.error,
        })
        try {
          writeDeadLetter(this.deps.statePaths, 'updates', {
            update,
            error: `invalid update schema: ${v.error}`,
          })
        } catch (dlErr) {
          log.error('dead-letter write failed', {
            error: dlErr instanceof Error ? dlErr.message : String(dlErr),
          })
        }
        if (v.update_id !== undefined) {
          this.offset = v.update_id + 1
          writeUpdateOffset(this.deps.statePaths, this.offset)
        }
        continue
      }
      try {
        await this.deps.onUpdate(update as Update)
        handled++
      } catch (err) {
        errors++
        log.error('update handler threw — writing to dead-letter, advancing offset', {
          update_id: v.update_id,
          error: err instanceof Error ? err.message : String(err),
        })
        try {
          writeDeadLetter(this.deps.statePaths, 'updates', {
            update,
            error: err instanceof Error ? err.message : String(err),
          })
        } catch (dlErr) {
          log.error('dead-letter write failed', {
            error: dlErr instanceof Error ? dlErr.message : String(dlErr),
          })
        }
      }
      // ALWAYS advance offset, even on handler error. Otherwise a single
      // bad update poisons the queue forever.
      this.offset = v.update_id + 1
      writeUpdateOffset(this.deps.statePaths, this.offset)
    }

    return { handled, errors, offsetAfter: this.offset }
  }

  // ─────────────────────────────────────────────────────────────────
  // Internal loop
  // ─────────────────────────────────────────────────────────────────

  private async loop(): Promise<void> {
    const { log } = this.deps
    let attempt = 0
    let conflict401Counter = 0
    let unauthorizedCounter = 0
    // Track sequential 429s separately from `attempt` so the linear-backoff
    // fallback only kicks in when Telegram omits `retry_after`. Counter
    // resets on any successful getUpdates round below.
    let floodCounter = 0

    while (!this.stopping) {
      try {
        const getUpdatesParams: {
          offset?: number
          timeout: number
          allowed_updates: ReadonlyArray<Exclude<keyof Update, 'update_id'>>
        } = {
          timeout: LONG_POLL_TIMEOUT_SEC,
          allowed_updates: ALLOWED_UPDATES,
        }
        if (this.offset !== undefined) getUpdatesParams.offset = this.offset

        const updates = await this.getUpdates(getUpdatesParams)

        // Success — reset error counters.
        attempt = 0
        conflict401Counter = 0
        unauthorizedCounter = 0
        floodCounter = 0

        for (const update of updates as unknown[]) {
          if (this.stopping) break
          const v = validateUpdate(update)
          if (!v.ok) {
            log.error('update failed Zod validation — dead-letter, advancing offset', {
              update_id: v.update_id,
              error: v.error,
            })
            try {
              writeDeadLetter(this.deps.statePaths, 'updates', {
                update,
                error: `invalid update schema: ${v.error}`,
              })
            } catch (dlErr) {
              log.error('dead-letter write failed', {
                error: dlErr instanceof Error ? dlErr.message : String(dlErr),
              })
            }
            if (v.update_id !== undefined) {
              this.offset = v.update_id + 1
              writeUpdateOffset(this.deps.statePaths, this.offset)
            }
            continue
          }
          try {
            await this.deps.onUpdate(update as Update)
          } catch (err) {
            log.error('handler error — dead-letter, advancing offset', {
              update_id: v.update_id,
              error: err instanceof Error ? err.message : String(err),
            })
            try {
              writeDeadLetter(this.deps.statePaths, 'updates', {
                update,
                error: err instanceof Error ? err.message : String(err),
              })
            } catch (dlErr) {
              log.error('dead-letter write failed', {
                error: dlErr instanceof Error ? dlErr.message : String(dlErr),
              })
            }
          }
          this.offset = v.update_id + 1
          writeUpdateOffset(this.deps.statePaths, this.offset)
        }
      } catch (err) {
        if (this.stopping) return
        const cls = classifyError(err)
        attempt++

        if (cls.kind === 'conflict') {
          conflict401Counter++
          if (conflict401Counter >= MAX_409_ATTEMPTS) {
            log.error('409 Conflict persists — another poller owns the token; giving up', {
              attempts: conflict401Counter,
            })
            // Throw so server.ts's start() wrapper triggers shutdown. Returning
            // would leave the MCP server alive with no active consumer.
            throw new PollerFatalError(
              'conflict',
              `409 Conflict persisted across ${conflict401Counter} attempts: ${cls.message}`,
              conflict401Counter,
            )
          }
          const delay = Math.min(1000 * attempt, BACKOFF_CAP_MS)
          log.warn('409 Conflict from getUpdates, backing off', {
            attempt: conflict401Counter,
            delay_ms: delay,
            description: cls.message,
          })
          await this.sleepFn(delay, this.stopCtl.signal)
          continue
        }

        if (cls.kind === 'unauthorized') {
          unauthorizedCounter++
          if (unauthorizedCounter >= MAX_401_ATTEMPTS) {
            log.error('401 Unauthorized — token rejected; exiting poller', {
              attempts: unauthorizedCounter,
            })
            // Throw so server.ts shuts down rather than running as a zombie
            // MCP server with a revoked token.
            throw new PollerFatalError(
              'unauthorized',
              `401 Unauthorized after ${unauthorizedCounter} attempts: ${cls.message}`,
              unauthorizedCounter,
            )
          }
          const delay = Math.min(1000 * attempt, BACKOFF_CAP_MS)
          log.warn('401 Unauthorized from getUpdates, retrying briefly', {
            attempt: unauthorizedCounter,
            delay_ms: delay,
            description: cls.message,
          })
          await this.sleepFn(delay, this.stopCtl.signal)
          continue
        }

        if (cls.kind === 'flood') {
          floodCounter++
          const delay = floodSleepMs(cls.retryAfterSec, floodCounter)
          log.warn('429 Too Many Requests from getUpdates, honouring retry_after', {
            attempt: floodCounter,
            delay_ms: delay,
            retry_after_sec: cls.retryAfterSec,
            description: cls.message,
          })
          await this.sleepFn(delay, this.stopCtl.signal)
          continue
        }

        if (cls.kind === 'fatal') {
          log.error('fatal poller error; exiting', { error: cls.message })
          return
        }

        // Transient network / Telegram 5xx: backoff and retry forever.
        const delay = Math.min(1000 * attempt, BACKOFF_CAP_MS)
        log.warn('transient poller error, retrying', {
          attempt,
          delay_ms: delay,
          error: cls.message,
        })
        await this.sleepFn(delay, this.stopCtl.signal)
      }
    }
  }
}
