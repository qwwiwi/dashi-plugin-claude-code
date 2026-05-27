// Per-chat tmux session pool for the multichat router.
//
// Each chat that has passed gating gets exactly one long-lived tmux
// session running an interactive `claude` process. The pool owns:
//   * lifecycle (spawn, kill, watchdog idle-kill at policy.idle_ttl_ms)
//   * sessions.json persistence so we re-attach to live tmux sessions
//     after a plugin restart instead of orphaning them
//   * a per-chat mutex so two concurrent inbound messages for the same
//     chat never race spawn() — see PLAN.md section 1.E
//
// Architecture decisions baked in (PLAN.md section 2):
//   * One tmux session per chat (not N MCP transports). Communication is
//     file-based via inbox-bridge.ts — no Unix sockets.
//   * `spawn()` uses child_process.spawn (no shell) so chat ids and
//     paths cannot be injected through tmux command construction.
//   * sessions.json writes go through .tmp + rename for crash safety.
//   * loadSessions() prunes dead entries on startup via `tmux has-session`.
//
// Entrypoint contract: when {entrypointScript} is provided, tmux runs it
// as the session's foreground command. The script is expected to set up
// per-chat env (persona injection, hook config) and finally exec `claude`.
// When omitted (MVP), tmux runs `{claudeBinary}` directly — the
// SessionStart hook handles persona injection via CHAT_ID env.

import { spawn, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { MultichatPolicy } from '../chats/policy-loader.js'

// Resolve the spawn-chat-shell.sh wrapper relative to THIS module so
// it works regardless of cwd. The wrapper lives at
// `plugin/scripts/spawn-chat-shell.sh`; this file is at
// `plugin/src/router/tmux-session-pool.ts`, so `../../scripts/...`
// from the module's dir yields the right path in both source and
// compiled layouts (Bun preserves the relative structure).
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SPAWN_WRAPPER_PATH = resolve(
  MODULE_DIR,
  '..',
  '..',
  'scripts',
  'spawn-chat-shell.sh',
)

// Environment variables that, if present in the plugin's own env, must
// NEVER be inherited by the spawned `claude` tmux session. Telegram /
// Groq / gbrain credentials belong to the plugin orchestrator, not to
// the user-facing claude instance — leaking them gives a compromised
// session unintended escalation paths.
//
// TASK-6 fix (2026-05-27): the previous L7 implementation only WARNED
// when these were present and still passed the full parent env to
// tmux. We now build an explicit allowlist (TMUX_CHILD_ENV_ALLOWLIST)
// and pass ONLY those keys to the tmux session env, plus chat-specific
// vars via `-e`. The list below is the warn list for human-visible
// keys we know about; the FORBIDDEN_ENV_REGEX below catches anything
// matching a credential-shaped suffix even if it's not enumerated.
const SENSITIVE_ENV_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_TOKEN',
  'GROQ_API_KEY',
  'GBRAIN_BEARER',
  'GBRAIN_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const

// Strict allowlist of env keys forwarded into the per-chat tmux
// session. Anything NOT on this list is dropped — tmux's new-session
// receives a sanitized env via the spawning Node child_process AND
// the per-session env is rebuilt from `-e KEY=VAL` flags so no
// inherited variable leaks through tmux's global environment table.
//
// Rationale for each key:
//   PATH    — required to locate python3 (hooks) and the claude binary
//             if it was not pre-resolved by server.ts (H8). Without
//             PATH the child shell cannot start anything.
//   HOME    — claude reads ~/.claude/*, ~/.claude-lab/*, ssh keys, etc.
//             Hooks resolve workspace via ${HOME}/.claude-lab/... when
//             CLAUDE_WORKSPACE_DIR is unset; HOME is the canonical
//             fallback root for user data.
//   USER    — some tools (git, ssh) read $USER instead of getlogin().
//   LANG / LC_ALL — UTF-8 locale; without these claude / python emit
//             encoding errors on Cyrillic content.
//   TERM    — interactive claude renders TUI; without TERM the
//             readline + spinner code paths fall back to ASCII-only.
//   SHELL   — claude shells out to $SHELL for Bash tool calls. Falls
//             back to /bin/sh if missing, but that breaks user's
//             aliases/PATH munging in their normal shell.
//   TZ      — claude / date / log timestamps; absence forces UTC which
//             is fine but TZ is informational, not sensitive.
//
// CHAT_ID, MULTICHAT_STATE_DIR, CLAUDE_WORKSPACE_DIR, TMUX_PANE are
// set explicitly per-session in spawnInternal and are NOT inherited
// from the parent env — they always come from pool state.
const TMUX_CHILD_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'LANGUAGE',
  'TERM',
  'SHELL',
  'TZ',
  'COLORTERM',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
] as const

// Regex catching credential-shaped env keys. Applied even to allow-
// listed keys as a defence-in-depth — if someone accidentally adds
// `PATH_API_KEY` to the allowlist it still gets dropped.
//
// Prefix list (Opus MED-B #21, 2026-05-27): namespaces known to carry
// orchestrator credentials that must never reach user-visible claude
// sessions. Expanded from the original GBRAIN/OPENAI/ANTHROPIC/TELEGRAM
// set to cover the secondary providers we hit in EdgeLab + DCA + Edge
// Lab infra (AWS, Supabase, Stripe, GitHub, NPM).
//
// Suffix list: literal credential-shaped tail tokens.
//   * TOKEN / API_KEY / SECRET / PASSWORD / PRIVATE_KEY — original set.
//   * URL — added for `_URL$` matches only (DATABASE_URL, REDIS_URL,
//     MONGODB_URL, etc. typically embed credentials in the connection
//     string). We anchor the URL match on `_URL$` so plain `URL` /
//     `BASE_URL` strings (often non-credential) are not caught — the
//     trailing-segment requirement keeps the regex narrow.
//
// NOTE on prefix breadth: AWS_, SUPABASE_, STRIPE_, GITHUB_, NPM_ may
// catch a few non-secret keys (e.g. AWS_REGION, AWS_DEFAULT_REGION,
// SUPABASE_URL, GITHUB_REPOSITORY). That is intentional and acceptable:
// (1) those vars belong to orchestrator config, not the user-facing
// claude session; (2) the chat-side hook can re-export them from a
// dedicated allowlist if a workflow genuinely needs them; (3) leaking
// region/repo metadata is harmless compared to leaking the matching
// secret. Risk analysis is logged in the MED-B report.
const FORBIDDEN_ENV_REGEX =
  /^(?:GBRAIN_|OPENAI_|ANTHROPIC_|TELEGRAM_|AWS_|SUPABASE_|STRIPE_|GITHUB_|NPM_).*$|^.*(?:^|_)(?:TOKEN|API_KEY|SECRET|PASSWORD|PRIVATE_KEY)$|^.+_URL$/

/**
 * Build the sanitized env passed to a tmux child session.
 *
 * Returns:
 *   - `childEnv`: the env to set on the spawned `tmux` Node process.
 *     Restricted to the allowlist minus forbidden keys, so even tmux's
 *     own internal env (which the persistent tmux server keeps in its
 *     global environment table) cannot carry sensitive values from
 *     the plugin's process env.
 *   - `forbiddenSeen`: list of forbidden keys observed in `parentEnv`,
 *     for the caller to log a warning. Values are never returned —
 *     only key names.
 *
 * This is exported (named export) so the tests in
 * tests/router/tmux-session-pool.env.test.ts can exercise it without
 * having to spawn a real tmux process.
 */
export function buildSanitizedTmuxEnv(parentEnv: NodeJS.ProcessEnv): {
  childEnv: Record<string, string>
  forbiddenSeen: string[]
} {
  const childEnv: Record<string, string> = {}
  const forbiddenSeen: string[] = []

  for (const key of TMUX_CHILD_ENV_ALLOWLIST) {
    // Defence-in-depth: skip even allowlisted keys if their name
    // matches the credential regex. Should be impossible by design
    // but guarantees the regex is the final authority.
    if (FORBIDDEN_ENV_REGEX.test(key)) continue
    const val = parentEnv[key]
    if (val !== undefined && val !== '') {
      childEnv[key] = val
    }
  }

  // Audit pass: enumerate every key in the parent env and record
  // any forbidden hits (without values). Caller logs these so an
  // operator can spot a misconfigured systemd unit or sourced .env.
  //
  // Opus MED-B #22 (2026-05-27): iterate the parent env keys in
  // sorted order so `forbiddenSeen` is deterministic without the
  // caller having to re-sort for stable audit log assertions.
  for (const key of Object.keys(parentEnv).sort()) {
    if (FORBIDDEN_ENV_REGEX.test(key) && parentEnv[key] !== undefined && parentEnv[key] !== '') {
      forbiddenSeen.push(key)
    }
  }

  return { childEnv, forbiddenSeen }
}

// In-memory + persisted view of a live tmux session.
export type SessionHandle = {
  chatId: string
  sessionName: string
  spawnedAt: number
  lastMessageAt: number
}

// Minimal logger contract — matches the shape used by status-manager and
// tmux-mirror so callers can pass the same instance.
export interface PoolLogger {
  info(msg: string, ctx?: object): void
  warn(msg: string, ctx?: object): void
  error(msg: string, ctx?: object): void
}

export interface TmuxSessionPoolOptions {
  policy: MultichatPolicy
  // Root for plugin state. sessions.json lives at {stateDir}/sessions.json;
  // per-chat dirs live at {stateDir}/chats/{chatId}/{inbox,outbox}.
  stateDir: string
  // Workspace root used for persona-relative path resolution by hooks
  // and as the canonical CLAUDE_WORKSPACE_DIR exported into the tmux
  // session. Typically `~/.claude-lab/thrall/.claude`.
  workspaceDir: string
  // Working directory for the spawned claude process. When provided,
  // tmux runs `new-session -c {chatsBasePath}` so that claude picks up
  // the workspace `.claude/settings.json` located at
  // `{chatsBasePath}/.claude/settings.json` (this is where the
  // SessionStart / PreToolUse hooks are registered — C4 fix).
  //
  // Defaults to `{workspaceDir}/chats` when omitted.
  chatsBasePath?: string
  claudeBinary?: string
  // Optional wrapper script. When set, our spawn-chat-shell.sh wrapper
  // (which runs `env -i` and re-exports the allowlisted vars) execs
  // `{entrypointScript}` instead of `claude` directly. The script is
  // responsible for exec'ing claude with any extra env / flags. C1
  // fix: the wrapper runs the inbox -> pty injection loop in the
  // background and execs claude in the foreground.
  entrypointScript?: string
  // FIX-A B2 (2026-05-27): path to spawn-chat-shell.sh. Defaults to
  // the in-repo wrapper resolved relative to this module. Tests
  // override it to point at a captive script that records env vars
  // so the assertion `tmux global env leak is closed` is exercisable
  // without spawning a real claude process.
  spawnWrapperPath?: string
  logger: PoolLogger
}

type SessionsFile = {
  version: 1
  sessions: Record<string, Omit<SessionHandle, 'chatId'>>
}

const SESSIONS_FILE_VERSION = 1
const DEFAULT_WATCHDOG_INTERVAL_MS = 60_000

/**
 * Manages the per-chat-id tmux session lifecycle.
 *
 * Thread-safety: getOrSpawn is the only public method that touches the
 * sessions map under concurrent inbound traffic — it serialises via
 * `pendingSpawns` so two callers for the same chatId resolve to the
 * same SessionHandle. All other public methods are intended to be
 * called from the router's single event loop and do not race.
 */
export class TmuxSessionPool {
  private readonly policy: MultichatPolicy
  private readonly stateDir: string
  private readonly workspaceDir: string
  private readonly chatsBasePath: string
  private readonly claudeBinary: string
  private readonly entrypointScript: string | undefined
  private readonly spawnWrapperPath: string
  private readonly logger: PoolLogger
  private readonly sessionsFilePath: string

  // chatId -> live session metadata.
  private readonly sessions = new Map<string, SessionHandle>()

  // chatId -> in-flight spawn promise; subsequent callers await the
  // same promise instead of racing into duplicate tmux processes.
  private readonly pendingSpawns = new Map<string, Promise<SessionHandle>>()

  private watchdogHandle: ReturnType<typeof setInterval> | null = null

  constructor(opts: TmuxSessionPoolOptions) {
    this.policy = opts.policy
    this.stateDir = opts.stateDir
    this.workspaceDir = opts.workspaceDir
    // chatsBasePath is the cwd handed to tmux — claude's per-workspace
    // `.claude/settings.json` lookup is relative to cwd, so this MUST
    // point at the directory whose `.claude/` subdir contains our
    // hooks registration. Default mirrors the canonical Thrall layout
    // (`{workspace}/chats/.claude/settings.json`).
    this.chatsBasePath = opts.chatsBasePath ?? join(opts.workspaceDir, 'chats')
    this.claudeBinary = opts.claudeBinary ?? 'claude'
    this.entrypointScript = opts.entrypointScript
    this.spawnWrapperPath = opts.spawnWrapperPath ?? DEFAULT_SPAWN_WRAPPER_PATH
    this.logger = opts.logger
    this.sessionsFilePath = join(this.stateDir, 'sessions.json')

    // TASK-6 audit (2026-05-27): warn for known sensitive keys at
    // construction time so operators see a single boot-time log line
    // per misconfigured credential. The runtime sanitisation in
    // spawnInternal will drop these anyway — the warn is purely for
    // visibility (sysadmin should fix the systemd unit / shell rc).
    for (const varName of SENSITIVE_ENV_VARS) {
      if (process.env[varName] !== undefined && process.env[varName] !== '') {
        this.logger.warn('pool.sensitive_env_present', {
          var: varName,
          note: 'will be stripped from tmux child env; fix orchestrator env to silence this warning',
        })
      }
    }
  }

  /**
   * Return an alive session for `chatId`, spawning one if necessary.
   * Concurrent callers for the same chatId share the same in-flight
   * promise via {@link pendingSpawns}.
   *
   * FIX-E M1 (2026-05-27, Codex router #4): the entire "check existing
   * + probe isAlive + maybe spawn" path now lives INSIDE a pending
   * promise installed BEFORE the isAlive await. Without this, callers
   * A and B can both:
   *   1. read `pendingSpawns.get` → undefined
   *   2. read `sessions.get` → same stale handle
   *   3. await `isAlive(existing)` → false (dead)
   *   4. fall through to spawnInternal → TWO tmux sessions for one chat.
   * Step 3 is the race window — any await between the pendingSpawns
   * check and the pendingSpawns.set lets a second caller slip in. By
   * resolving the existing-vs-spawn decision inside the pending
   * promise body, caller B's `pendingSpawns.get` in step 1 returns
   * the same promise caller A installed and joins it.
   *
   * H10 fix (2026-05-23, retained context): pre-H10 the await sat
   * BETWEEN two Map reads. H10 split the reads but did not close the
   * underlying stale-handle race. FIX-E M1 supersedes H10 by moving
   * the await INSIDE the pending entry so the entire decision is
   * serialised per chat.
   */
  async getOrSpawn(chatId: string): Promise<SessionHandle> {
    // 1. Synchronous: is a resolve already in flight for this chat?
    //    Join it — no probe, no second pending entry.
    const pending = this.pendingSpawns.get(chatId)
    if (pending !== undefined) return pending

    // 2. Install the pending promise BEFORE any await. The promise
    //    body runs the existing-handle probe and falls back to spawn.
    //    Concurrent callers landing here in the same tick get the
    //    same promise from step 1 and cannot race past the await.
    const promise = this.resolveOrSpawn(chatId).finally(() => {
      this.pendingSpawns.delete(chatId)
    })
    this.pendingSpawns.set(chatId, promise)
    return promise
  }

  /**
   * Internal worker for {@link getOrSpawn}. Probes any existing
   * SessionHandle via `tmux has-session`; if alive, returns it
   * without spawning. Otherwise falls through to {@link spawnInternal}.
   *
   * Runs inside the pendingSpawns promise so the `await isAlive`
   * cannot race with a parallel caller — see the FIX-E M1 comment
   * on `getOrSpawn` for the failure mode this closes.
   */
  private async resolveOrSpawn(chatId: string): Promise<SessionHandle> {
    const existing = this.sessions.get(chatId)
    if (existing !== undefined && (await this.isAlive(existing.sessionName))) {
      return existing
    }
    return this.spawnInternal(chatId)
  }

  /**
   * Kill the tmux session for `chatId` (if any) and remove it from the
   * pool. Safe to call when no session exists.
   *
   * FIX-E M2 (2026-05-27, Codex router #5 + Opus #18): scrub the
   * volatile queue files ONLY, never the operator-facing quarantine
   * dirs. The pre-fix code did `rm -rf inbox/` and `rm -rf outbox/`
   * which destroyed `outbox/dead-letter/` (transient send failures
   * stashed for re-drive analysis), `outbox/mismatched/` (chat-id
   * mismatch quarantine carrying audit evidence), and any `albums/`
   * subtree owned by TASK-4. An idle-kill or operator-triggered kill
   * would then erase exactly the forensic state we kept for post-
   * mortem.
   *
   * New strategy — remove ONLY:
   *   * `inbox/*.json`           (pending inbox messages — never sent
   *                              to claude in this tmux generation,
   *                              ok to drop on idle-kill since the
   *                              router will re-deliver on respawn
   *                              if the original Telegram message is
   *                              still claimable; for op-kills the
   *                              user has already moved on)
   *   * `outbox/*.json`          (root-level pending claims that the
   *                              tmux side wrote but the router has
   *                              not yet rename-claimed into
   *                              processing/)
   *   * `outbox/processing/*`    (uncommitted claims — the previous
   *                              tmux generation is dead so we cannot
   *                              re-attempt confirm/reject for them;
   *                              log each one as warn before removal
   *                              so an operator sees what was lost)
   *
   * PRESERVE:
   *   * `outbox/dead-letter/`    (Telegram-send failures — operator
   *                              must inspect)
   *   * `outbox/mismatched/`     (chat-id mismatch audit trail —
   *                              tamper signal, never erase)
   *   * `albums/`                (TASK-4 territory; if present, leave
   *                              entirely alone)
   *   * any other unknown subdirectory (forward-compatible default)
   *
   * The router's outbox poller continues running in parallel; that is
   * fine because pollOutboxOnce treats a missing outbox dir as "no
   * messages" (readdir error → empty array) and the next dispatch()
   * will re-create the dirs via ensureChatStateDirs.
   */
  async kill(chatId: string): Promise<void> {
    const handle = this.sessions.get(chatId)
    if (handle === undefined) return
    try {
      await runTmux(['kill-session', '-t', handle.sessionName])
    } catch (err) {
      this.logger.warn('tmux kill-session failed', {
        chatId,
        sessionName: handle.sessionName,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    this.sessions.delete(chatId)

    // FIX-E M2: targeted cleanup. We unlink JSON files individually
    // rather than recursively wiping the parent dir so the quarantine
    // siblings (dead-letter/, mismatched/) and any albums/ subtree
    // survive untouched.
    await this.scrubVolatileQueueState(chatId).catch((cleanupErr: unknown) => {
      this.logger.warn('tmux kill: queue cleanup failed', {
        chatId,
        error:
          cleanupErr instanceof Error
            ? cleanupErr.message
            : String(cleanupErr),
      })
    })

    await this.atomicSaveSessions().catch((saveErr) => {
      this.logger.error('sessions.json save failed after kill', {
        chatId,
        error: saveErr instanceof Error ? saveErr.message : String(saveErr),
      })
    })
  }

  /**
   * FIX-E M2 helper: scrub the chat's volatile queue files while
   * preserving the operator-facing quarantine directories.
   *
   * The set of removed paths is:
   *   * `{chatStateDir}/inbox/*.json`           (and matching `*.tmp`)
   *   * `{chatStateDir}/outbox/*.json`          (root-level only;
   *                                             subdirs untouched)
   *   * `{chatStateDir}/outbox/processing/*`    (each file logged
   *                                             warn before unlink)
   *
   * Anything else — `outbox/dead-letter/`, `outbox/mismatched/`,
   * `albums/`, unknown future subdirs — is explicitly NOT touched.
   * The function is best-effort: individual unlink failures are
   * swallowed (a missing file from a concurrent dispatch is benign)
   * but a readdir failure on a parent dir is propagated so the
   * caller can log it under one wrapped warn line.
   */
  private async scrubVolatileQueueState(chatId: string): Promise<void> {
    const chatStateDir = join(this.stateDir, 'chats', chatId)
    const inboxDir = join(chatStateDir, 'inbox')
    const outboxDir = join(chatStateDir, 'outbox')
    const processingDir = join(outboxDir, 'processing')

    // 1. Inbox: drop committed `.json` + in-flight `.tmp` files.
    //    Use try/catch around readdir so a missing dir is a no-op.
    try {
      const entries = await readdir(inboxDir)
      for (const name of entries) {
        if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue
        await rm(join(inboxDir, name), { force: true }).catch(() => {})
      }
    } catch {
      // Inbox dir missing — first-ever kill or already scrubbed.
    }

    // 2. Outbox ROOT-LEVEL only: `.json` files awaiting rename-claim.
    //    Subdirectories (processing/, dead-letter/, mismatched/) MUST
    //    survive — they are handled in dedicated branches below.
    try {
      const entries = await readdir(outboxDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        if (!entry.name.endsWith('.json')) continue
        await rm(join(outboxDir, entry.name), { force: true }).catch(
          () => {},
        )
      }
    } catch {
      // Outbox dir missing — no work to do.
    }

    // 3. Processing: each file represents a claim the previous tmux
    //    generation owned but cannot complete (we just killed the
    //    session). Log warn before unlink so an operator sees the
    //    lost claims in their journal — they would otherwise linger
    //    in processing/ forever and trip the next sweep audit.
    try {
      const entries = await readdir(processingDir)
      for (const name of entries) {
        this.logger.warn(
          'tmux kill: dropping uncommitted outbox claim (session died before confirm/reject)',
          {
            chatId,
            file: name,
          },
        )
        await rm(join(processingDir, name), { force: true }).catch(() => {})
      }
    } catch {
      // Processing dir missing — no in-flight claims, nothing to log.
    }

    // dead-letter/, mismatched/, albums/ deliberately untouched.
  }

  /** True iff `tmux has-session -t {sessionName}` exits 0. */
  async isAlive(sessionName: string): Promise<boolean> {
    try {
      await runTmux(['has-session', '-t', sessionName])
      return true
    } catch {
      return false
    }
  }

  /** Mark the chat as having received a message just now. */
  touch(chatId: string): void {
    const handle = this.sessions.get(chatId)
    if (handle === undefined) return
    handle.lastMessageAt = Date.now()
    // Async-fire-and-forget — touch happens per message, blocking the
    // hot path on disk flush would add latency for no benefit.
    void this.atomicSaveSessions().catch((err) => {
      this.logger.warn('sessions.json save failed after touch', {
        chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /** Start the idle-kill watchdog. Idempotent. */
  startWatchdog(intervalMs: number = DEFAULT_WATCHDOG_INTERVAL_MS): void {
    if (this.watchdogHandle !== null) return
    this.watchdogHandle = setInterval(() => {
      this.runIdleCheck().catch((err) => {
        this.logger.error('watchdog idle check failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, intervalMs)
    // Don't keep the event loop alive solely for the watchdog —
    // server.ts owns shutdown via stopWatchdog().
    this.watchdogHandle.unref?.()
  }

  stopWatchdog(): void {
    if (this.watchdogHandle === null) return
    clearInterval(this.watchdogHandle)
    this.watchdogHandle = null
  }

  /**
   * Iterate live sessions, kill any whose idle time exceeds the
   * chat's policy.idle_ttl_ms (or the policy default if the chat is
   * absent from the policy — which would be a bug, but we still want
   * the pool to self-heal).
   */
  async runIdleCheck(): Promise<void> {
    const now = Date.now()
    const toKill: string[] = []
    for (const [chatId, handle] of this.sessions) {
      const chatPolicy = this.policy.chats[chatId]
      // 30min default mirrors policy-loader's Zod default.
      const ttl = chatPolicy?.idle_ttl_ms ?? 1_800_000
      const idle = now - handle.lastMessageAt
      if (idle > ttl) {
        this.logger.info('tmux session idle-kill', {
          chatId,
          sessionName: handle.sessionName,
          idleMs: idle,
          ttlMs: ttl,
        })
        toKill.push(chatId)
      }
    }
    for (const chatId of toKill) {
      await this.kill(chatId)
    }
  }

  /**
   * Load sessions.json from disk, then prune entries whose tmux
   * sessions are no longer alive. Call once at router startup before
   * accepting traffic.
   */
  async loadSessions(): Promise<void> {
    if (!existsSync(this.sessionsFilePath)) return
    let parsed: SessionsFile
    try {
      const raw = await readFile(this.sessionsFilePath, 'utf8')
      parsed = JSON.parse(raw) as SessionsFile
    } catch (err) {
      this.logger.warn('sessions.json unreadable; starting empty', {
        path: this.sessionsFilePath,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (parsed.version !== SESSIONS_FILE_VERSION) {
      this.logger.warn('sessions.json version mismatch; ignoring', {
        expected: SESSIONS_FILE_VERSION,
        got: parsed.version,
      })
      return
    }

    for (const [chatId, meta] of Object.entries(parsed.sessions)) {
      const handle: SessionHandle = { chatId, ...meta }
      if (await this.isAlive(handle.sessionName)) {
        this.sessions.set(chatId, handle)
      } else {
        this.logger.info('pruning dead tmux session from sessions.json', {
          chatId,
          sessionName: handle.sessionName,
        })
      }
    }
    // Persist the pruned set so next boot does not retry the same
    // dead sessions.
    await this.atomicSaveSessions()
  }

  // ─────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────

  private async spawnInternal(chatId: string): Promise<SessionHandle> {
    // C3 fix (2026-05-23): refuse to spawn for a chat without an
    // explicit ChatPolicy entry, even if it sits in allowlist.chats.
    // A missing policy entry means SessionStart can't load persona +
    // system_reminder, PreToolUse can't load deny rules — master Thrall
    // would launch without isolation. Hard error is better than a
    // silent persona-less spawn that leaks gbrain MCP into a public
    // group.
    if (!this.policy.chats[chatId]) {
      throw new Error(
        `tmux-session-pool: chat ${chatId} not found in policy.chats — ` +
          `refusing to spawn. Add a ChatPolicy entry to policy.yaml ` +
          `before allowing this chat.`,
      )
    }

    const sessionName = buildSessionName(chatId)

    // Guard against stale map entries pointing to a session that died
    // since the last touch.
    if (await this.isAlive(sessionName)) {
      const stamp = Date.now()
      const handle: SessionHandle = {
        chatId,
        sessionName,
        spawnedAt: stamp,
        lastMessageAt: stamp,
      }
      this.sessions.set(chatId, handle)
      await this.atomicSaveSessions()
      return handle
    }

    // C4 fix (2026-05-23): cwd MUST be chatsBasePath so claude's
    // workspace-settings lookup finds `{chatsBasePath}/.claude/
    // settings.json` (the file that registers SessionStart + PreToolUse
    // hooks). CLAUDE_WORKSPACE_DIR is still exported because the
    // SessionStart hook reads persona / policy via it — those files
    // live one level up at `{workspaceDir}/chats/{CHAT_ID}/...`.
    //
    // TASK-6 env-filter (2026-05-27, FIX-A B2): the previous design
    // relied on tmux `-e KEY=VAL` overlays alone. That is INSUFFICIENT:
    // tmux's persistent server keeps a global environment table seeded
    // from its first client connection and propagates ANY var from
    // that table into every new shell — `-e` only overlays the
    // enumerated keys on top, it does NOT clear unmentioned vars
    // already in the global table.
    //
    // The real fix is `env -i` at the moment the child shell starts:
    // wipe ALL inherited env, then re-export only the allowlisted
    // keys we explicitly want. We do this via the
    // `scripts/spawn-chat-shell.sh` wrapper (always used, never
    // bypassed — overrides this.entrypointScript when the caller
    // provided a script of their own, that script is invoked by our
    // wrapper after env -i).
    //
    // tmux is still given the per-session env via `-e KEY=VAL` so
    // wrapper-side `${CHAT_ID}` etc. are populated when the script
    // runs. The wrapper then transitively re-exports them through
    // `env -i` to the final `claude` exec.
    const { childEnv, forbiddenSeen } = buildSanitizedTmuxEnv(process.env)
    if (forbiddenSeen.length > 0) {
      // Log without values — key names only. Sorted for stable test
      // assertions and human-readable log output.
      this.logger.warn('pool.forbidden_env_dropped', {
        chatId,
        keys: [...forbiddenSeen].sort(),
        note: 'forbidden credential-shaped keys present in parent env; stripped from tmux child',
      })
    }

    // Per-session env passed via `-e KEY=VAL`. Order:
    //   1. Chat-specific vars (always-set, never inherited).
    //   2. Allowlisted vars from sanitized childEnv (PATH, HOME, ...).
    const args: string[] = [
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-e',
      `CHAT_ID=${chatId}`,
      '-e',
      `MULTICHAT_STATE_DIR=${this.stateDir}`,
      '-e',
      `CLAUDE_WORKSPACE_DIR=${this.workspaceDir}`,
    ]
    // Opus MED-B #22 (2026-05-27): sort childEnv entries by key before
    // emitting `-e KEY=VAL` pairs. `Object.entries` order is
    // implementation-defined (V8 honours insertion order for string
    // keys, but spec compliance should not be load-bearing). Stable
    // alphabetical ordering makes the argv log + the audit warn
    // (`pool.forbidden_env_dropped`) deterministic across runs and
    // platforms — tests assert exact argv subsequences without flake.
    for (const [key, val] of Object.entries(childEnv).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      args.push('-e', `${key}=${val}`)
    }
    // PATH baseline if the parent didn't have one (extremely unlikely
    // but keeps the session bootstrappable under systemd Environment=).
    if (childEnv.PATH === undefined) {
      args.push('-e', 'PATH=/usr/local/bin:/usr/bin:/bin')
    }
    // FIX-A B3 (2026-05-27): removed the bare `-e TMUX_PANE` arg pair
    // that lived here before. tmux's `-e` syntax requires `KEY=value`
    // — passing a bare key either errors out or eats the next token
    // as the value (silently breaking `-c`). tmux auto-populates
    // TMUX_PANE inside the pane regardless, so no defence-in-depth
    // case justifies the broken arg.
    //
    // FIX-A B2: hardwire the spawn-chat-shell.sh wrapper so the
    // child shell starts under `env -i` and cannot inherit tmux
    // server global-env leaks. The wrapper takes the claude binary
    // (or the operator's entrypointScript override) as its first
    // positional argument and execs it after the env wipe.
    args.push(
      '-c',
      this.chatsBasePath,
      this.spawnWrapperPath,
      this.entrypointScript ?? this.claudeBinary,
    )

    try {
      await runTmux(args, childEnv)
    } catch (err) {
      this.logger.error('tmux new-session failed', {
        chatId,
        sessionName,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }

    const stamp = Date.now()
    const handle: SessionHandle = {
      chatId,
      sessionName,
      spawnedAt: stamp,
      lastMessageAt: stamp,
    }
    this.sessions.set(chatId, handle)
    await this.atomicSaveSessions()

    this.logger.info('tmux session spawned', { chatId, sessionName })
    return handle
  }

  private async atomicSaveSessions(): Promise<void> {
    const payload: SessionsFile = {
      version: SESSIONS_FILE_VERSION,
      sessions: {},
    }
    for (const [chatId, handle] of this.sessions) {
      payload.sessions[chatId] = {
        sessionName: handle.sessionName,
        spawnedAt: handle.spawnedAt,
        lastMessageAt: handle.lastMessageAt,
      }
    }

    await mkdir(dirname(this.sessionsFilePath), { recursive: true })
    const tmp = `${this.sessionsFilePath}.tmp`
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, this.sessionsFilePath)
  }
}

// ──────────────────────────────────────────────────────────────────────
// Pure helpers (no class state)
// ──────────────────────────────────────────────────────────────────────

function buildSessionName(chatId: string): string {
  // tmux session names cannot contain `.` or `:`; chat ids are numeric
  // (group ids may start with `-`). The plain `multichat-{chatId}`
  // shape is safe for all current allowed chat ids.
  return `multichat-${chatId}`
}

/**
 * Spawn `tmux` with the given args.
 *
 * When `childEnv` is omitted (the default for housekeeping calls like
 * `has-session` / `kill-session`), tmux inherits the parent env — these
 * calls only talk to the existing tmux server and never start a new
 * user-visible shell, so inheritance is safe.
 *
 * When `childEnv` is provided (used by `spawnInternal` for
 * `new-session`), tmux is given a sanitized env. This is the
 * load-bearing path for chat isolation: tmux's persistent server
 * keeps a global environment table seeded from its first client
 * connection, so the new-session client must NOT carry sensitive
 * vars even though `-e` flags also rebuild the per-session env.
 * Two layers of defence — process env AND `-e` flags — close the
 * gap regardless of tmux server lifecycle ordering.
 */
function runTmux(
  args: readonly string[],
  childEnv?: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const opts: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(childEnv !== undefined ? { env: childEnv } : {}),
    }
    const child = spawn('tmux', args as string[], opts)
    let stderrBuf = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tmux ${args.join(' ')} exited ${code}: ${stderrBuf.trim()}`))
    })
  })
}
