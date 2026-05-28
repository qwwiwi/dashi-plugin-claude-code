// MultichatRouter — orchestrator for the per-chat tmux session fleet.
//
// Wires together the pieces that Batches 1 and 2 produced:
//   * gate / addressing (handlers.ts decides what reaches us)
//   * MultichatPolicy (defines allowlist + per-chat behaviour)
//   * TmuxSessionPool (spawns and supervises per-chat `claude` tmux sessions)
//   * inbox-bridge (file-based JSON pipe to the tmux side)
//   * Telegram API (egress for outbox messages produced by the tmux side)
//
// dispatch() is the single entry point for inbound traffic; start()/stop()
// manage the background pollers and the session pool watchdog. The router
// never owns the bot or its rate-limit queue — egress goes through the
// existing TelegramApi instance so safe-telegram-api still applies its
// per-chat throttle and redactor pipeline.
//
// Outbox loop design (H2 fix, 2026-05-23):
//   Per-chat setInterval (200 ms cadence) that drains the outbox via
//   pollOutboxOnce — now a two-phase claim/confirm/reject protocol so a
//   transient Telegram send error no longer destroys the message.
//   pollOutboxOnce rename-locks each file into `outbox/processing/`;
//   we send to Telegram and then call either confirmOutboxClaim
//   (success — unlink processing file) or rejectOutboxClaim (failure —
//   move to `outbox/dead-letter/` with a `.fail.json` sidecar). Files
//   are consumed in arrival order. The interval is `unref`'d so it
//   does not keep the process alive when server.ts shuts down without
//   an explicit stop() — defence in depth.

import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import type { TelegramApi } from '../channel/tools.js'
import type { Logger } from '../log.js'
import {
  assertValidChatId,
  getChatPolicyOrDeny,
  type MultichatPolicy,
} from '../chats/policy-loader.js'
import {
  confirmOutboxClaim,
  ensureChatStateDirs,
  pollOutboxOnce,
  quarantineMismatchedClaim,
  rejectOutboxClaim,
  writeToInbox,
  type InboundMessage,
  type OutboxClaim,
} from './inbox-bridge.js'
import type { TmuxSessionPool } from './tmux-session-pool.js'

// Telegram surface the router actually touches: sendMessage for outbox
// replies and sendChatAction for the group typing indicator (M7).
// editMessageText is owned by StatusManager / TmuxMirror, not this path.
// Keep the type narrow so unit tests can stub a minimal surface.
export interface MultichatTelegramApi {
  sendMessage: TelegramApi['sendMessage']
  sendChatAction: TelegramApi['sendChatAction']
}

export interface RouterDeps {
  policy: MultichatPolicy
  pool: TmuxSessionPool
  // State root for inbox/outbox dirs and sessions.json. Must match the
  // value passed to TmuxSessionPool to keep both sides talking to the
  // same per-chat directory.
  stateDir: string
  // Workspace root that owns `chats/{chatId}/persona.md`. Reserved for
  // future router-side persona resolution; today the SessionStart hook
  // reads it inside the tmux session via CHAT_ID env.
  workspaceDir: string
  telegramApi: MultichatTelegramApi
  logger: Logger
}

// Default polling cadence. 200ms gives sub-second perceived latency
// for replies without hammering the disk (one readdir per chat).
// Matches PLAN.md section 2 ("setInterval(200ms)").
const DEFAULT_OUTBOX_POLL_INTERVAL_MS = 200
// M7 typing indicator. Telegram clears a chat action ~5s after it is sent, so
// re-send every 4s to keep the "typing…" status alive while the per-chat
// session works. TYPING_MAX_TICKS caps the loop (~2 min) so a session that
// never produces an outbox reply cannot leave the indicator spinning forever.
const TYPING_INTERVAL_MS = 4000
const TYPING_MAX_TICKS = 30

/**
 * Parse a Telegram message_id string into a positive, safe-integer number.
 * Stricter than parseInt (Codex review 2026-05-28 [low]): requires all
 * digits so partial garbage like "123abc" is rejected, and rejects values
 * outside the JS safe-integer range. Returns undefined when invalid.
 */
function parseMessageId(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0) return undefined
  return n
}

// Per-chat outbox loop bookkeeping. fs.watch is intentionally NOT used
// today — Node's watcher behaviour differs across platforms (linux
// inotify vs macOS FSEvents) and the 200ms poll is well within latency
// budget. The struct keeps a `watcher` slot for a future PR.
interface OutboxLoopHandle {
  interval: ReturnType<typeof setInterval>
}

export class MultichatRouter {
  private readonly policy: MultichatPolicy
  private readonly pool: TmuxSessionPool
  private readonly stateDir: string
  // Workspace root surfaced for callers that need to derive the
  // chats base path (e.g. for persona resolution outside the tmux
  // session). Accessed only through `chatsBasePath()` — direct
  // field access would couple consumers to the implementation.
  private readonly workspaceDir: string
  private readonly telegramApi: MultichatTelegramApi
  private readonly logger: Logger
  // chatId -> outbox loop handle. Presence in the map means polling is
  // active; absence means we are not draining this chat's outbox yet.
  private readonly outboxLoops = new Map<string, OutboxLoopHandle>()
  // TASK-5 bug 3 (2026-05-27): per-chat in-flight drain guard. The
  // outbox tick is a `setInterval(200ms)`; if a Telegram send is slow
  // (rate-limit backoff, network stall), the next tick would otherwise
  // re-enter drainOutbox and reorder/duplicate sends. The set is keyed
  // by chatId — an entry means "a drain pass is currently running for
  // this chat, skip the next tick". We use a Set rather than a counter
  // because re-entrancy is binary here: either we are draining or we
  // are not. The set is per-chat (not global) so drains in different
  // chats still run concurrently.
  private readonly draining = new Set<string>()
  // FIX-E M3 (2026-05-27, Codex router #6): per-chat dispatch mutex.
  // The map value is the tail of a promise chain — each runDispatch()
  // call appends its work onto the chain so the queue-depth check +
  // writeToInbox pair runs atomically per chat. Without this two
  // concurrent dispatch() calls can both readdir() → see 0 pending →
  // both writeToInbox(), violating max_queue_depth=1 with two files.
  //
  // The chain is per-chat, not global, so dispatch() to different
  // chats stays parallel — total throughput is unchanged. Entries
  // self-clean: a chain whose tail resolves and is still the live
  // map value is removed in finally(), so an idle chat does not
  // hold a Map entry forever.
  //
  // We use a separate map from `draining` because the two cover
  // different sides of the queue: `draining` serialises the OUTBOX
  // (tmux → Telegram), `dispatchLocks` serialises the INBOX
  // (Telegram → tmux). Conflating them would force outbound sends
  // to wait on inbound writes for the same chat — unnecessary
  // latency.
  private readonly dispatchLocks = new Map<string, Promise<void>>()
  // M7 (2026-05-28): per-chat quote-reply target. On dispatch we record the
  // triggering message_id (the @mention / reply-to-bot that summoned us in a
  // public group); deliverClaim consumes it ONCE to thread the first outbound
  // reply as reply_to_message_id, then deletes it so a later un-prompted
  // outbox message is not mis-threaded.
  private readonly pendingReplyTo = new Map<string, string>()
  // M7: per-chat typing-indicator loop. Presence means "typing is being shown
  // for this chat". sendChatAction('typing') is re-sent every ~4s (Telegram
  // clears the status after 5s); stopped when the reply is delivered or after
  // an idle cap so a session that never replies cannot leave it spinning.
  private readonly typingTimers = new Map<
    string,
    ReturnType<typeof setInterval>
  >()
  private started = false

  constructor(deps: RouterDeps) {
    this.policy = deps.policy
    this.pool = deps.pool
    this.stateDir = deps.stateDir
    this.workspaceDir = deps.workspaceDir
    this.telegramApi = deps.telegramApi
    this.logger = deps.logger
  }

  /**
   * Start the router: rehydrate the session pool from disk, arm the
   * watchdog, and spin up outbox loops for every session that survived
   * the load. Idempotent — repeated calls are no-ops after the first.
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    await this.pool.loadSessions()
    this.pool.startWatchdog()

    // Re-arm outbox pollers for sessions that survived a plugin restart.
    // We rely on the policy.allowlist.chats to enumerate known chat ids;
    // sessions.json only records what was once spawned, but the policy
    // is the source of truth for "this chat is configured at all".
    for (const chatId of this.policy.allowlist.chats) {
      this.startOutboxLoop(chatId)
    }

    this.logger.info('multichat router started', {
      chats: this.policy.allowlist.chats.length,
    })
  }

  /**
   * Stop background activity owned by the router. tmux sessions are
   * deliberately NOT killed — they stay alive across plugin restarts so
   * the next start() reattaches without losing conversation context.
   */
  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false

    for (const chatId of Array.from(this.outboxLoops.keys())) {
      this.stopOutboxLoop(chatId)
    }
    // M7: tear down any live typing-indicator loops so timers don't leak
    // across stop()/start() cycles (and the process can exit cleanly).
    for (const chatId of Array.from(this.typingTimers.keys())) {
      this.stopTypingLoop(chatId)
    }
    this.pendingReplyTo.clear()
    this.pool.stopWatchdog()
    // FIX-E M3: clear any lingering dispatch chain heads. The values
    // are promise chains — Node will GC them once their owning
    // callers release; clearing the Map only prevents stale
    // references from holding onto memory across stop()/start()
    // cycles in tests.
    this.dispatchLocks.clear()

    this.logger.info('multichat router stopped')
  }

  /**
   * Absolute path to the directory that holds per-chat persona files.
   *
   * Equivalent to `{workspaceDir}/chats`. Exposed so callers that need
   * to resolve personas outside the tmux session (e.g. an admin tool
   * or future SessionStart hook variant) can read the same path the
   * router was constructed with.
   */
  getChatsBasePath(): string {
    return chatsBasePath(this.workspaceDir)
  }

  /**
   * Route an inbound message into the per-chat tmux session.
   *
   * Flow (in order — H5 spawn-order fix 2026-05-23, TASK-5 bug 1
   * unified gate 2026-05-27):
   *   1. Validate chat_id shape (defence in depth, TASK-5 bug 4).
   *   2. Unified policy gate — BOTH user_id in allowlist.users AND
   *      a non-null `getChatPolicyOrDeny(policy, chat_id)` must pass.
   *      Resolved BEFORE any filesystem mutation so a chat that the
   *      pool will refuse to spawn does not accumulate inbox files
   *      and dirs on disk (TASK-5 bug 1 — HIGH #7 in Codex review).
   *   3. Ensure the per-chat inbox/outbox directories exist.
   *   4. Atomically write the inbound JSON to the inbox.
   *   5. Spawn-or-attach the chat's tmux session — the entrypoint
   *      watcher drains the inbox on first poll, so the inbox must
   *      already contain this message before the wrapper starts.
   *   6. Update lastMessageAt so the watchdog does not idle-kill.
   *   7. Arm the outbox poller if it is not already running.
   */
  async dispatch(input: InboundMessage): Promise<void> {
    // 1. Chat-id shape gate (TASK-5 bug 4). Reject anything that
    //    does not match `/^-?\d+$/` BEFORE the value reaches
    //    path.join, tmux session names, or policy.chats[…] lookup.
    //    A throw here means a buggy/hostile caller fed us a path
    //    traversal payload or non-string — drop the message,
    //    structured log, do NOT crash the poller above us.
    try {
      assertValidChatId(input.chat_id)
    } catch (err) {
      this.logger.warn('router.dispatch.invalid_chat_id', {
        chat_id: typeof input.chat_id === 'string'
          ? input.chat_id.slice(0, 64)
          : String(input.chat_id),
        user_id: input.user_id,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    // 2. Unified policy gate (TASK-5 bug 1, supersedes the prior
    //    DM/group split). The previous split allowed a DM in
    //    `allowlist.users` to flow through ensureChatStateDirs +
    //    writeToInbox even when `policy.chats[chat_id]` was missing —
    //    pool.spawnInternal would then refuse to spawn (C3) and the
    //    message would sit in the inbox forever. The fix:
    //
    //      * BOTH `allowlist.users` includes user_id, AND
    //      * `getChatPolicyOrDeny(policy, chat_id)` returns non-null.
    //
    //    Resolution happens here, before any FS mutation. Any deny
    //    path returns a single structured warn log with both signals
    //    so an operator can diagnose which clause tripped.
    //
    //    Note: `getChatPolicyOrDeny` accepts `policy: MultichatPolicy
    //    | null`. The router only constructs itself with a loaded
    //    policy (server.ts gates on `multichatPolicy !== undefined`),
    //    so the null branch is unreachable here — but using the
    //    multichat-aware helper keeps a single source of truth for
    //    "is this chat configured?" across router, status-manager,
    //    tmux-mirror, persona-manager. Legacy single-DM mode never
    //    runs through this router.
    const userAllowed = this.policy.allowlist.users.includes(input.user_id)
    const chatPolicy = getChatPolicyOrDeny(this.policy, input.chat_id)
    const chatAllowed = this.policy.allowlist.chats.includes(input.chat_id)

    if (chatPolicy === null || !userAllowed) {
      this.logger.warn('router.dispatch.denied', {
        chat_id: input.chat_id,
        user_id: input.user_id,
        user_in_allowlist: userAllowed,
        has_chat_policy: chatPolicy !== null,
        chat_in_allowlist: chatAllowed,
        // isPrivate stays informational — the gate no longer branches
        // on it, but the field helps operators understand which kind
        // of traffic was refused (TG private vs group/supergroup).
        is_private: input.chat_id === input.user_id,
      })
      return
    }

    // 3. Ensure dirs FIRST (H5). The pool's entrypoint wrapper drains
    //    the inbox on its initial pass — if we spawn before the inbox
    //    exists, the wrapper logs and exits its initial drain on an
    //    empty dir, then waits for inotify which would race against
    //    the first writeToInbox.
    try {
      await ensureChatStateDirs(input.chat_id, this.stateDir)
    } catch (err) {
      this.logger.error('router.dispatch.ensure_dirs_failed', {
        chat_id: input.chat_id,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    // 3b. M10 fix (2026-05-23): enforce `policy.chats[*].max_queue_depth`.
    //     If the inbox is already at or above the cap, drop the
    //     oldest pending message(s) before writing the new one. Default
    //     cap is 1 (matches policy-loader's Zod default and PLAN.md §7
    //     — "one message in flight per chat").
    //
    //     Rationale for drop-oldest (rather than drop-newest or
    //     reject):
    //       * newest carries the user's freshest intent — discarding it
    //         feels like the bot ignored them outright.
    //       * rejecting the dispatch would require a Telegram error
    //         reply, which complicates the gate path and risks
    //         re-entrancy.
    //       * dropping the oldest gives "we're catching up, latest
    //         wins" semantics that match how a human would behave
    //         under a backlog.
    //
    //     `chatPolicy` was already looked up above for the gate check;
    //     reuse it. For DMs without a per-chat policy entry, fall back
    //     to the same default (1) so the global guarantee holds.
    //
    //     FIX-E M3 (2026-05-27, Codex router #6): the queue-depth
    //     check + writeToInbox pair runs INSIDE `runDispatch(chatId,
    //     ...)` so two concurrent dispatch() calls for the same chat
    //     serialise. Without serialisation both could readdir() → see
    //     0 pending → both writeToInbox(), violating the cap with
    //     two files. The mutex is per-chat — dispatch() to other
    //     chats stays parallel. `writeToInbox`'s return value is
    //     intentionally discarded: callers only care about success
    //     vs failure (boolean), not the file path.
    const maxDepth = chatPolicy?.max_queue_depth ?? 1
    const inboxDir = join(this.stateDir, 'chats', input.chat_id, 'inbox')
    const writeOk = await this.runDispatch(input.chat_id, async () => {
      try {
        const inboxEntries = await readdir(inboxDir).catch(() => [])
        // Only .json files count toward the queue depth — `.tmp`
        // writers are mid-rename and will appear as committed files
        // in the next poll, but they are not yet "pending" from the
        // watcher's POV.
        const pending = inboxEntries
          .filter((name) => name.endsWith('.json') && !name.endsWith('.tmp'))
          .sort() // timestamp-prefixed → oldest first
        while (pending.length >= maxDepth) {
          const oldest = pending.shift()
          if (oldest === undefined) break
          const oldestPath = join(inboxDir, oldest)
          await unlink(oldestPath).catch((unlinkErr: unknown) => {
            this.logger.warn('router.dispatch.queue_overflow.drop_failed', {
              chat_id: input.chat_id,
              file: oldest,
              error:
                unlinkErr instanceof Error
                  ? unlinkErr.message
                  : String(unlinkErr),
            })
          })
          this.logger.warn('router.dispatch.queue_overflow.dropped_oldest', {
            chat_id: input.chat_id,
            dropped: oldest,
            max_depth: maxDepth,
          })
        }
      } catch (err) {
        // Cap enforcement is best-effort — a readdir failure must not
        // block delivery of the fresh inbound. Continue to writeToInbox.
        this.logger.warn('router.dispatch.queue_overflow.check_failed', {
          chat_id: input.chat_id,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // 4. Atomic inbox write BEFORE spawn (H5). The .tmp + rename
      //    pattern means a partial JSON is never visible to the
      //    watcher, even if it polls between our write and rename.
      try {
        await writeToInbox(input.chat_id, input, this.stateDir)
      } catch (err) {
        this.logger.error('router.dispatch.inbox_write_failed', {
          chat_id: input.chat_id,
          error: err instanceof Error ? err.message : String(err),
        })
        return false
      }
      return true
    })

    if (!writeOk) return

    // 5. Spawn-or-attach AFTER the inbox is populated (H5). The pool
    //    serialises concurrent callers for the same chat via its
    //    pendingSpawns mutex, so a burst of inbound messages cannot
    //    race into duplicate tmux sessions. spawnInternal also
    //    enforces the chat-in-policy invariant (C3).
    try {
      await this.pool.getOrSpawn(input.chat_id)
    } catch (err) {
      this.logger.error('router.dispatch.spawn_failed', {
        chat_id: input.chat_id,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    // 6. Mark activity for the idle-kill watchdog.
    this.pool.touch(input.chat_id)

    // 7. Arm outbox poll if missing. Idempotent.
    this.startOutboxLoop(input.chat_id)

    // 8. M7 — group liveness. Only public (group) chats: in a DM the
    //    in-process StatusManager already drives the typing bubble, and
    //    reply-to-mention is meaningless. A message only reaches dispatch
    //    for a public chat if it was addressed (mention / reply-to-bot per
    //    handlers' gate), so threading the reply to it == reply-on-mention.
    if (chatPolicy.mode === 'public') {
      if (input.message_id !== undefined) {
        this.pendingReplyTo.set(input.chat_id, input.message_id)
      }
      this.startTypingLoop(input.chat_id)
    }

    this.logger.debug?.('router.dispatch.ok', {
      chat_id: input.chat_id,
      user_id: input.user_id,
    })
  }

  /**
   * FIX-E M3 helper (2026-05-27, Codex router #6): per-chat dispatch
   * mutex. Chains `work` onto the tail promise stored at
   * `dispatchLocks.get(chatId)` and returns the new tail's value.
   * Two parallel callers for the same chat get serialised — caller B
   * sees caller A's promise as the prior tail and awaits it before
   * running its own `work()`.
   *
   * Failure semantics: `work()` is wrapped so a throw becomes a
   * `return false` from the caller-visible boolean. The chain itself
   * stays resolved (never rejected) so a failed dispatch does NOT
   * poison subsequent calls — the per-chat lock keeps flowing.
   *
   * Self-cleanup: when the tail resolves AND `dispatchLocks.get(chatId)`
   * still points at this exact promise (i.e. no further caller has
   * appended), delete the entry. This stops idle chats from holding
   * Map entries forever after their burst is done.
   *
   * Note on perf: the mutex adds at most one `await` (the prior tail)
   * to the dispatch fast path. Under normal load — one inbound at a
   * time per chat — the prior tail has already resolved and the
   * extra await collapses to a microtask. Burst load (multiple
   * Telegram messages in the same tick for one chat) is bounded by
   * the Telegram inbound rate (~30 msg/s per bot) and is exactly
   * the case where serialisation is required to preserve the
   * queue-depth cap.
   */
  private async runDispatch<T>(
    chatId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const prior = this.dispatchLocks.get(chatId) ?? Promise.resolve()
    // Chain: wait for prior to settle (success OR failure — we don't
    // want a prior throw to dominoes through), then run work().
    let result!: T
    let workError: unknown = null
    const next = prior.then(
      async () => {
        try {
          result = await work()
        } catch (err) {
          // Capture the error so we can re-throw to the caller AFTER
          // releasing the lock — but keep the chain resolved so the
          // next call is not poisoned.
          workError = err
        }
      },
      // prior rejected (shouldn't happen — we swallow inside work
      // wrapper — but defence-in-depth): swallow so the chain stays
      // alive.
      () => undefined,
    )
    this.dispatchLocks.set(chatId, next)
    try {
      await next
      if (workError !== null) {
        throw workError
      }
      return result
    } finally {
      // Self-cleanup: only drop the entry if we are still the tail.
      // A caller that appended after us has already replaced the
      // value with their own next; leaving it alone keeps the chain
      // intact.
      if (this.dispatchLocks.get(chatId) === next) {
        this.dispatchLocks.delete(chatId)
      }
    }
  }

  // ───── outbox loop internals ─────

  /**
   * Begin polling the chat's outbox. No-op when a loop is already
   * armed for this chat. The chatId is validated up front; an invalid
   * id is logged and silently skipped (the chat was already denied at
   * dispatch, so a poll loop here is a programmer error in start()).
   */
  /**
   * M7: start (or no-op if already running) the group typing indicator for a
   * chat. Sends `sendChatAction('typing')` immediately, then every
   * `TYPING_INTERVAL_MS` until {@link stopTypingLoop} is called (reply
   * delivered) or `TYPING_MAX_TICKS` is reached (session never replied).
   * Send errors are swallowed — a failed chat action must never affect
   * delivery or crash the interval. The timer is `unref`'d so it never keeps
   * the process alive on its own.
   */
  private startTypingLoop(chatId: string): void {
    if (this.typingTimers.has(chatId)) return
    const send = (): void => {
      void Promise.resolve(this.telegramApi.sendChatAction(chatId, 'typing')).catch(
        (err: unknown) => {
          this.logger.debug?.('router.typing.send_failed', {
            chat_id: chatId,
            error: err instanceof Error ? err.message : String(err),
          })
        },
      )
    }
    send()
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
      if (ticks >= TYPING_MAX_TICKS) {
        this.logger.debug?.('router.typing.capped', { chat_id: chatId })
        this.stopTypingLoop(chatId)
        // Codex review [medium]: the session never produced a reply this
        // turn — drop the stale pending reply target too, so it cannot
        // mis-thread a much-later un-prompted outbox message.
        this.pendingReplyTo.delete(chatId)
        return
      }
      send()
    }, TYPING_INTERVAL_MS)
    timer.unref?.()
    this.typingTimers.set(chatId, timer)
  }

  /** M7: stop the typing indicator for a chat. No-op when none is running. */
  private stopTypingLoop(chatId: string): void {
    const timer = this.typingTimers.get(chatId)
    if (timer === undefined) return
    clearInterval(timer)
    this.typingTimers.delete(chatId)
  }

  private startOutboxLoop(chatId: string): void {
    // TASK-5 bug 4 (2026-05-27): assertValidChatId at the outbox-loop
    // entry point. start() iterates `policy.allowlist.chats`, which
    // a future malformed policy.yaml could populate with bad ids.
    // Failing here drops the chat from polling without crashing
    // unrelated loops.
    try {
      assertValidChatId(chatId)
    } catch (err) {
      this.logger.warn('router.outbox.invalid_chat_id', {
        chat_id: typeof chatId === 'string' ? chatId.slice(0, 64) : String(chatId),
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (this.outboxLoops.has(chatId)) return
    const interval = setInterval(() => {
      // TASK-5 bug 3 (2026-05-27): per-chat in-flight guard. If the
      // previous tick is still running drainOutbox (slow sendMessage
      // due to Telegram rate-limit backoff, slow disk, etc.), the
      // next tick must be a no-op — otherwise two concurrent drain
      // passes could race rename() on the same processing file and
      // duplicate or reorder sends. The guard is binary per chat;
      // drains in different chats remain independent.
      if (this.draining.has(chatId)) {
        this.logger.debug?.('router.outbox.tick_skipped_inflight', {
          chat_id: chatId,
        })
        return
      }
      this.draining.add(chatId)
      this.drainOutbox(chatId)
        .catch((err: unknown) => {
          // drainOutbox catches its own errors; this is belt-and-braces
          // so an unforeseen throw cannot crash the interval callback
          // and silently stop polling.
          this.logger.warn('router.outbox.uncaught', {
            chat_id: chatId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
        .finally(() => {
          // Always release the guard so a faulty drainOutbox call
          // does not wedge the chat into a perpetual "in-flight"
          // state — better to risk one reorder than to freeze the
          // chat's outbox forever.
          this.draining.delete(chatId)
        })
    }, DEFAULT_OUTBOX_POLL_INTERVAL_MS)
    // Do not keep the event loop alive solely for an outbox poller —
    // server.ts owns shutdown via stop().
    interval.unref?.()
    this.outboxLoops.set(chatId, { interval })
    this.logger.debug?.('router.outbox.started', { chat_id: chatId })
  }

  /**
   * Tear down a chat's outbox loop. No-op when no loop is armed.
   */
  private stopOutboxLoop(chatId: string): void {
    const handle = this.outboxLoops.get(chatId)
    if (handle === undefined) return
    clearInterval(handle.interval)
    this.outboxLoops.delete(chatId)
    // TASK-5 bug 3 (2026-05-27): release any lingering in-flight
    // guard on teardown — keeps the Set tidy for re-arm scenarios
    // (test fixtures repeatedly start/stop the router).
    this.draining.delete(chatId)
    this.logger.debug?.('router.outbox.stopped', { chat_id: chatId })
  }

  /**
   * Single drain pass with two-phase delivery (H2):
   *
   * 1. pollOutboxOnce returns claims, each one is a file that has
   *    already been moved into `outbox/processing/`.
   * 2. For every claim we attempt sendMessage. On success we confirm
   *    (unlink processing/), on failure we reject (move to
   *    dead-letter/ with sidecar).
   *
   * Send failures are logged at warn level so an operator notices
   * dead-lettered messages — but they do NOT break the loop, the
   * remaining claims still get processed.
   */
  private async drainOutbox(chatId: string): Promise<void> {
    let claims: OutboxClaim[]
    try {
      claims = await pollOutboxOnce(chatId, this.stateDir)
    } catch (err) {
      this.logger.warn('router.outbox.poll_failed', {
        chat_id: chatId,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (claims.length === 0) return

    for (const claim of claims) {
      await this.deliverClaim(chatId, claim)
    }
  }

  /**
   * Send one claimed outbox message to Telegram and resolve the claim
   * (confirm on success, reject on failure). `reply_to` is a
   * stringified Telegram message_id — convert via parseInt with NaN
   * guard so a bogus payload becomes a dead-letter rather than a
   * loop-killing throw.
   *
   * TASK-5 bug 2 (2026-05-27): before any Telegram send we assert
   * `claim.message.chat_id === chatId` (the outbox directory that
   * owned the file). A mismatch means the tmux session writing into
   * this directory emitted a payload addressed to a DIFFERENT chat —
   * either a buggy persona, a stale conversation context, or an
   * attempted cross-chat exfil. We never send the message; we
   * quarantine the file into `outbox/mismatched/` with both
   * expected/actual chat ids in a sidecar, and emit a structured log
   * line carrying `outbox_chat_mismatch=true` so an operator can
   * grep for it.
   */
  private async deliverClaim(
    chatId: string,
    claim: OutboxClaim,
  ): Promise<void> {
    const message = claim.message
    // TASK-5 bug 2 (2026-05-27): chat-id consistency check. The
    // claim file lives under `outbox/processing/` of `chatId`'s
    // directory, but the payload carries its own `chat_id`. The two
    // MUST match — otherwise a session running in chat A could
    // deliver content under chat B's identity (misrouting,
    // potential PII leak, or a vector for prompt-injection-induced
    // exfil). Quarantine; do NOT send.
    if (message.chat_id !== chatId) {
      this.logger.error('router.outbox.chat_mismatch', {
        chat_id: chatId,
        actual_chat_id: message.chat_id,
        original: claim.originalName,
        outbox_chat_mismatch: true,
      })
      await quarantineMismatchedClaim(claim, {
        expectedChatId: chatId,
        actualChatId: message.chat_id,
      }).catch((quarErr: unknown) => {
        this.logger.error('router.outbox.quarantine_failed', {
          chat_id: chatId,
          actual_chat_id: message.chat_id,
          original: claim.originalName,
          error:
            quarErr instanceof Error ? quarErr.message : String(quarErr),
        })
      })
      return
    }

    const opts: { reply_to_message_id?: number; parse_mode?: 'HTML' | 'MarkdownV2' } = {}
    if (message.reply_to !== undefined) {
      const parsed = Number.parseInt(message.reply_to, 10)
      if (Number.isFinite(parsed) && parsed > 0) {
        opts.reply_to_message_id = parsed
      } else {
        this.logger.warn('router.outbox.bad_reply_to', {
          chat_id: chatId,
          reply_to: message.reply_to,
        })
      }
    } else {
      // M7: the session did not set an explicit reply_to. Thread the FIRST
      // outbound reply to the mention that summoned us (only ever populated
      // for public chats — see dispatch step 8). Consume it so a follow-up
      // un-prompted outbox message is not mis-threaded.
      //
      // Semantics are per-chat "latest mention" (Codex review 2026-05-28
      // [high]): if a second addressed message arrives before the first
      // reply drains, its id overwrites the pending one, so the reply
      // threads to the most recent question. Precise per-turn threading
      // would require piping message_id through the tmux session/outbox;
      // for a quote-reply UX nicety the latest-mention behaviour is the
      // accepted trade-off. max_queue_depth=1 keeps one turn in flight in
      // the common case.
      const pending = this.pendingReplyTo.get(chatId)
      if (pending !== undefined) {
        this.pendingReplyTo.delete(chatId)
        const id = parseMessageId(pending)
        if (id !== undefined) {
          opts.reply_to_message_id = id
        }
      }
    }

    // M7: a reply is leaving for this chat — the agent is no longer "typing".
    this.stopTypingLoop(chatId)
    // FIX-F (2026-05-27, Opus router #14): map OutboxMessage.format to
    // the Telegram parse_mode. The Zod schema in inbox-bridge.ts
    // populates `format` with the default 'html' when the writer omits
    // it, so this branch always sees a concrete value. Pre-fix, the
    // router never set parse_mode and `<b>bold</b>` / `**bold**` payloads
    // were delivered as literal text — regressing PR #22 which made
    // 'html' the default for the channel reply tool.
    //
    // We deliberately do NOT call markdownToTelegramHtml here: the
    // outbox writer (the tmux-side reply tool) owns text shape — the
    // router is a thin transport. A writer that wants markdown→HTML
    // conversion must do it before the outbox file lands; this mirrors
    // how the in-process channel reply tool calls markdownToTelegramHtml
    // before pushing to sendMessage.
    if (message.format === 'html') {
      opts.parse_mode = 'HTML'
    } else if (message.format === 'markdown') {
      opts.parse_mode = 'MarkdownV2'
    }
    // format === 'text' → omit parse_mode entirely.
    try {
      await this.telegramApi.sendMessage(chatId, message.text, opts)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.logger.warn('router.outbox.send_failed', {
        chat_id: chatId,
        error: reason,
        original: claim.originalName,
      })
      await rejectOutboxClaim(claim, { reason }).catch((rejectErr: unknown) => {
        this.logger.error('router.outbox.dead_letter_failed', {
          chat_id: chatId,
          original: claim.originalName,
          error:
            rejectErr instanceof Error ? rejectErr.message : String(rejectErr),
        })
      })
      return
    }
    await confirmOutboxClaim(claim).catch((confirmErr: unknown) => {
      // Confirm failure means the file lingers in processing/ but the
      // Telegram message already went out — log so an operator can
      // sweep stale processing files. NEVER retry the send: that would
      // duplicate the user-visible message.
      this.logger.warn('router.outbox.confirm_failed', {
        chat_id: chatId,
        original: claim.originalName,
        error:
          confirmErr instanceof Error ? confirmErr.message : String(confirmErr),
      })
    })
  }
}

// Re-export workspaceDir alias for callers that want to read this
// router's view of the chats base path without importing fs internals.
// Keeps the field private while exposing a derived path consumers can
// pass to `resolvePersona`.
export function chatsBasePath(workspaceDir: string): string {
  return `${workspaceDir}/chats`
}
