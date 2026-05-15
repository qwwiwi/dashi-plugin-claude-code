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
//   - Network / transient: backoff and retry indefinitely; attempt counter
//     resets after any successful getUpdates round.
//   - Handler errors NEVER stop polling. Each thrown handler goes to
//     dead-letter/updates/ and offset advances past the bad update.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import type { Bot } from 'grammy'
import { GrammyError, HttpError } from 'grammy'
import type { Update } from 'grammy/types'

import type { AppConfig, StatePaths } from '../config.js'
import type { Logger } from '../log.js'
import { readUpdateOffset, writeDeadLetter, writeUpdateOffset } from '../state/store.js'

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

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

export const tokenLock: TokenLock = {
  acquire(statePaths: StatePaths): boolean {
    if (existsSync(statePaths.pid)) {
      try {
        const raw = readFileSync(statePaths.pid, 'utf8').trim()
        const existing = Number.parseInt(raw, 10)
        if (Number.isFinite(existing) && existing !== process.pid && pidAlive(existing)) {
          return false
        }
        // Stale (dead pid or our own previous entry) — overwrite below.
      } catch {
        // Unreadable pid file — treat as stale, overwrite.
      }
    }
    writeFileSync(statePaths.pid, String(process.pid), { mode: 0o600 })
    return true
  },

  release(statePaths: StatePaths): void {
    if (!existsSync(statePaths.pid)) return
    try {
      const raw = readFileSync(statePaths.pid, 'utf8').trim()
      const owner = Number.parseInt(raw, 10)
      if (owner === process.pid) {
        rmSync(statePaths.pid)
      }
      // Foreign pid — leave it, not ours to delete.
    } catch {
      // Already gone or unreadable — nothing to do.
    }
  },
}

// ─────────────────────────────────────────────────────────────────────
// TelegramPoller
// ─────────────────────────────────────────────────────────────────────

interface ErrorClass {
  kind: 'conflict' | 'unauthorized' | 'transient' | 'fatal'
  message: string
  retriable: boolean
}

function classifyError(err: unknown): ErrorClass {
  if (err instanceof GrammyError) {
    if (err.error_code === 409) {
      return { kind: 'conflict', message: err.description, retriable: true }
    }
    if (err.error_code === 401) {
      return { kind: 'unauthorized', message: err.description, retriable: true }
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
  private stopping = false
  private offset: number | undefined
  private readonly stopCtl = new AbortController()
  private runningLoop: Promise<void> | undefined

  constructor(deps: PollerDeps, overrides?: { getUpdates?: GetUpdatesFn }) {
    this.deps = deps
    this.offset = readUpdateOffset(deps.statePaths)
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
    for (const update of updates) {
      try {
        await this.deps.onUpdate(update)
        handled++
      } catch (err) {
        errors++
        log.error('update handler threw — writing to dead-letter, advancing offset', {
          update_id: update.update_id,
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
      this.offset = update.update_id + 1
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

        for (const update of updates) {
          if (this.stopping) break
          try {
            await this.deps.onUpdate(update)
          } catch (err) {
            log.error('handler error — dead-letter, advancing offset', {
              update_id: update.update_id,
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
          this.offset = update.update_id + 1
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
            return
          }
          const delay = Math.min(1000 * attempt, BACKOFF_CAP_MS)
          log.warn('409 Conflict from getUpdates, backing off', {
            attempt: conflict401Counter,
            delay_ms: delay,
            description: cls.message,
          })
          await sleep(delay, this.stopCtl.signal)
          continue
        }

        if (cls.kind === 'unauthorized') {
          unauthorizedCounter++
          if (unauthorizedCounter >= MAX_401_ATTEMPTS) {
            log.error('401 Unauthorized — token rejected; exiting poller', {
              attempts: unauthorizedCounter,
            })
            return
          }
          const delay = Math.min(1000 * attempt, BACKOFF_CAP_MS)
          log.warn('401 Unauthorized from getUpdates, retrying briefly', {
            attempt: unauthorizedCounter,
            delay_ms: delay,
            description: cls.message,
          })
          await sleep(delay, this.stopCtl.signal)
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
        await sleep(delay, this.stopCtl.signal)
      }
    }
  }
}
