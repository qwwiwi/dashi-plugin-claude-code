// Context HUD (wave 3B) — a single PINNED Telegram message in the owner's chat
// that shows how full the model's context window is (a 10-segment unicode bar +
// percentage) plus one action button: «Сжать» (/compact). It is the
// KAI-style always-visible indicator, refreshed
// after every turn from the SessionStart / Stop hook events — there are NO
// timers or polling; the HUD only moves when a hook fires.
//
// CRITICAL isolation invariant: the plugin is the user's ONLY channel, so a
// broken HUD must NEVER break message delivery. Every HUD operation
// (send / pin / edit / persist) is best-effort — wrapped in try/catch, swallowed
// and logged, NEVER thrown back into the hook/reply path. The public methods
// (`onSessionStart`, `onStop`, `updateNow`) therefore resolve to `void` and can
// be fired with `void hud.onStop(chatId)` from the hook dispatcher without any
// error handling at the call site.
//
// Owner-only: the HUD acts solely for the owner's chat(s) (allowed chat / user
// ids). A group / multichat non-owner chat never gets a HUD.
//
// Persistence: the HUD's Telegram message_id is stored per chat in a small JSON
// file under the plugin state dir. On a plugin restart we re-use (and re-pin)
// that message instead of spamming a fresh one; if the user deleted it we
// recreate it exactly once.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveContextWindowForModel } from '../config.js'
import { classifyEditError } from '../safety/telegram-edit-classifier.js'
import {
  formatWindowTokens,
  readContextUsage as realReadContextUsage,
  type ContextUsage,
} from './context-usage.js'
import { applyTaskCreateToMap, applyTaskUpdateToMap } from './task-mirror.js'
import { renderFreshnessHeader, type TaskFreshness } from './task-freshness.js'
import type { TaskMirrorEvent } from '../hooks/claude-events.js'
import type { TodoItem } from '../schemas.js'
import type { EditOpts, InlineKeyboardLike, SendMessageOpts } from '../channel/tools.js'
import type { Logger } from '../log.js'

// The callback prefix for the HUD's callbacks (compact button + legacy new
// from stale pre-removal markup). Distinct from kkey:/ccmd:/
// newq:/pgate:/ask: by construction so it never collides in the shared
// bot.on('callback_query:data') router.
export const HUD_PREFIX = 'hud:'

// ─────────────────────────────────────────────────────────────────────
// Pure rendering helper (unit-tested in isolation).
// ─────────────────────────────────────────────────────────────────────

const BAR_SEGMENTS = 10
const BAR_FILLED = '▰'
const BAR_EMPTY = '▱'

// bump() debounce window — collapses inbound-message bursts (multi-part voice,
// albums) into a single delete+resend. Mirrors TmuxMirror.BUMP_DEBOUNCE_MS.
const HUD_BUMP_DEBOUNCE_MS = 1500

// Escape the model string for HTML parse mode. Model ids ("claude-opus-4-8")
// carry no markup, but escape defensively so a surprising value can never break
// the HUD's entity parsing (the safe wrapper would then downgrade it silently).
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Build the HUD's inline keyboard. Static (never changes) so the edit path can
// re-send the same markup on every refresh and let Telegram no-op it.
// «Новый диалог» removed per prince directive 2026-07-04 — clearing context is
// too destructive for a one-tap pinned button; /new stays as the command path.
// The hud:new callback handler is kept so a stale pinned card (pre-removal
// markup) still resolves to the confirm flow instead of a dead tap.
export function buildHudKeyboard(): InlineKeyboardLike {
  return {
    inline_keyboard: [
      [{ text: '🗜 Сжать', callback_data: `${HUD_PREFIX}compact` }],
    ],
  }
}

// Work-status view rendered under the context line (status-pin wave, 2026-07-04).
export interface HudWorkView {
  todos: ReadonlyArray<TodoItem>
  permissionMode?: string
  // M3 reality mirror: when present, the «Задачи» header carries a freshness
  // indicator («сверено … / ДАННЫЕ УСТАРЕЛИ / НЕ СВЕРЕНО / сессия завершена»).
  freshness?: TaskFreshness
}

// Caps for the tasks section. The HUD is a compact pinned card, not the full
// TaskMirror body: all in-progress items, a handful of pending, the last
// couple of completed. Item text is truncated on the RAW string BEFORE
// escaping so an entity can never be sliced in half.
const TASKS_MAX_PENDING = 5
const TASKS_MAX_DONE = 2
const TASK_LINE_CHARS = 80
// Total section budget (post-escape chars). Keeps the card far under the
// 4096 sendMessage cap even with many in-progress items and markup-heavy
// subjects (escaping expands & → &amp; AFTER the per-line cut) — review
// 2026-07-04 LOW #3.
const TASKS_MAX_CHARS = 1500

const TASK_ICONS = {
  in_progress: '◐',
  pending: '◻',
  completed: '☑',
} as const

function taskLine(todo: TodoItem): string {
  const raw = todo.status === 'in_progress' && todo.activeForm
    ? todo.activeForm
    : todo.content
  // Truncate on CODE POINTS (Array.from), not UTF-16 units — a .slice cut
  // can split a surrogate pair and render U+FFFD (review 2026-07-04 LOW #4).
  const cps = Array.from(raw)
  const cut = cps.length > TASK_LINE_CHARS ? `${cps.slice(0, TASK_LINE_CHARS - 1).join('')}…` : raw
  return `${TASK_ICONS[todo.status]} ${escapeHtml(cut)}`
}

/**
 * Render the compact «Задачи» section for the status pin: a 10-segment
 * done/total bar + in-progress / pending / last-completed lines.
 * Empty todos → empty string (the HUD omits the section entirely).
 * PURE — exported for unit tests.
 */
export function renderStatusTasks(
  todos: ReadonlyArray<TodoItem>,
  freshness?: TaskFreshness,
): string {
  if (todos.length === 0) return ''
  const inProgress = todos.filter((t) => t.status === 'in_progress')
  const pending = todos.filter((t) => t.status === 'pending')
  const completed = todos.filter((t) => t.status === 'completed')
  const total = todos.length
  const done = completed.length

  const filled = Math.max(0, Math.min(BAR_SEGMENTS, Math.round((done / total) * BAR_SEGMENTS)))
  const bar = BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_SEGMENTS - filled)

  // The header (bar + count) stays OUTSIDE the collapsible quote so progress is
  // always visible when collapsed; the per-task detail goes INSIDE an
  // <blockquote expandable>, so the pin reads «progress — tap to expand the list».
  // M3: when a freshness indicator is supplied the bold «Задачи» label is
  // replaced by the freshness label (+ optional subline), so the pin shows how
  // recently the list was reconciled against the real pane.
  const fh = freshness !== undefined ? renderFreshnessHeader(freshness) : { label: '<b>Задачи</b>' }
  const header = `${fh.label} ${bar} ${done}/${total}`
  const subLine = 'sub' in fh && fh.sub !== undefined ? `\n${fh.sub}` : ''

  const detail: string[] = []
  for (const t of inProgress) detail.push(taskLine(t))
  for (const t of pending.slice(0, TASKS_MAX_PENDING)) detail.push(taskLine(t))
  if (pending.length > TASKS_MAX_PENDING) {
    detail.push(`<i>+${pending.length - TASKS_MAX_PENDING} ещё…</i>`)
  }
  const visibleDone = completed.slice(-TASKS_MAX_DONE)
  const hiddenDone = completed.length - visibleDone.length
  if (hiddenDone > 0) detail.push(`<i>+${hiddenDone} завершено ранее</i>`)
  for (const t of visibleDone) detail.push(taskLine(t))

  // Total-budget pass: the per-category caps bound pending/completed but not
  // in-progress, and escaping expands after the per-line cut. The header is
  // always kept (counted first); drop overflowing detail lines, mark the cut.
  const out: string[] = []
  let used = header.length + subLine.length
  let dropped = 0
  for (const line of detail) {
    if (used + 1 + line.length <= TASKS_MAX_CHARS) {
      out.push(line)
      used += 1 + line.length
    } else {
      dropped++
    }
  }
  if (dropped > 0) out.push(`<i>+${dropped} строк скрыто</i>`)

  if (out.length === 0) return `${header}${subLine}`
  return `${header}${subLine}\n<blockquote expandable>${out.join('\n')}</blockquote>`
}

// «план» is the only mode worth naming; every other Claude Code permission
// mode (default / acceptEdits / bypassPermissions) is just «выполнение».
function modeLabel(permissionMode: string): string {
  return permissionMode === 'plan' ? 'план' : 'выполнение'
}

/**
 * Render the HUD text + keyboard from a context-usage reading.
 *
 * text (HTML): `🧠 <b>Контекст</b>: <bar> <pct>% (<used>k / <window>k)` where
 * `<bar>` is a 10-segment meter (`▰` filled / `▱` empty) proportional to the
 * clamped percentage. An optional second line shows the model when known.
 * A null usage (no transcript / no usable turn yet) renders `🧠 <b>Контекст</b>: —`.
 *
 * With a `work` view the card grows a mode line («режим: план» /
 * «выполнение», only when the permission mode is known) and a compact
 * «Задачи» section (renderStatusTasks) — the combined status pin the
 * warchief asked for on 2026-07-04: ONE pinned message = context + work.
 *
 * PURE — no I/O, no clock — so it is trivially unit-testable against fixed inputs.
 */
export function renderHud(
  usage: { usedTokens: number } | null,
  windowTokens: number,
  model?: string,
  work?: HudWorkView,
): { text: string; keyboard: InlineKeyboardLike } {
  const keyboard = buildHudKeyboard()
  const modelLine = model !== undefined && model.length > 0 ? `\n<i>${escapeHtml(model)}</i>` : ''
  const modeLine =
    work?.permissionMode !== undefined && work.permissionMode.length > 0
      ? `\n<i>режим: ${modeLabel(work.permissionMode)}</i>`
      : ''
  const tasksBlock = work !== undefined ? renderStatusTasks(work.todos, work.freshness) : ''
  const tasksSection = tasksBlock.length > 0 ? `\n\n${tasksBlock}` : ''
  const tail = `${modelLine}${modeLine}${tasksSection}`

  if (usage === null) {
    return { text: `🧠 <b>Контекст</b>: —${tail}`, keyboard }
  }

  const windowLabel = formatWindowTokens(windowTokens)
  const usedK = Math.round(usage.usedTokens / 1000)
  const rawPct = windowTokens > 0 ? (usage.usedTokens / windowTokens) * 100 : 0
  // Clamp to 0..100 for BOTH the bar and the displayed percentage so an
  // over-full window (used > window) reads as a saturated 100%, never >100%.
  const pct = Math.max(0, Math.min(100, Math.round(rawPct)))
  const filled = Math.max(0, Math.min(BAR_SEGMENTS, Math.round(pct / 10)))
  const bar = BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_SEGMENTS - filled)

  const text = `🧠 <b>Контекст</b>: ${bar} ${pct}% (${usedK}k / ${windowLabel})${tail}`
  return { text, keyboard }
}

// ─────────────────────────────────────────────────────────────────────
// Manager.
// ─────────────────────────────────────────────────────────────────────

// Narrow structural surface the HUD needs from the safe-wrapped TelegramApi.
// `sendMessage` / `editMessageText` are satisfied by the safe-wrapped api
// (redaction + HTML validation + rate limiting). `pinChatMessage` carries no
// user text; the composition root adapts it from grammY. Kept narrow (the
// StatusManagerForWebhook / SessionInfoRecorder pattern) so tests pass a tiny
// fake and the HUD never imports grammY.
export interface HudTelegramApi {
  sendMessage(chatId: string, text: string, opts: SendMessageOpts): Promise<{ message_id: number }>
  editMessageText(chatId: string, messageId: number, text: string, opts: EditOpts): Promise<void>
  pinChatMessage(chatId: string, messageId: number, opts: { disable_notification?: boolean }): Promise<void>
  // bump() re-anchoring (status-pin wave): delete the old card (deleting a
  // pinned message also removes its pin), unpin as the fallback when delete
  // is refused (bots cannot delete own messages older than 48h). Both carry
  // no user text — adapted from grammY at the composition root like pin.
  deleteMessage(chatId: string, messageId: number): Promise<void>
  unpinChatMessage(chatId: string, messageId: number): Promise<void>
}

// Read-only view of the SessionInfoStore the HUD consumes. Satisfied by
// `SessionInfoStore.get`.
export interface SessionInfoReader {
  get(chatId?: string): {
    transcriptPath?: string
    sessionId?: string
    model?: string
    permissionMode?: string
  }
}

// Injectable transcript reader — defaults to the real `readContextUsage`. Tests
// pass a fake so they never touch the filesystem.
export type ReadContextUsageFn = (
  transcriptPath: string,
  windowTokens: number,
) => Promise<ContextUsage | null>

export interface ContextHudOptions {
  api: HudTelegramApi
  log: Logger
  sessionInfo: SessionInfoReader
  // Fallback context window (tokens) used when the session model is unknown or
  // absent — the model-unaware default (resolveContextWindowTokens).
  windowTokens: number
  // Explicit operator override (config context_window_tokens / JARVIS_CONTEXT_WINDOW),
  // or undefined when unset. When present it wins over per-model auto-detection
  // (resolveContextWindowForModel); when absent the model table drives the
  // window so a Fable-5 session reports its true 1M window. Optional so the many
  // test literals that predate it keep compiling.
  windowOverride?: number | undefined
  // Owner chat(s) — the ONLY chats the HUD acts in. Stringified for comparison
  // against the hook payload's chatId.
  ownerChatIds: ReadonlyArray<string | number>
  // Plugin state dir; the HUD writes `context-hud-<chatId>.json` here.
  stateDir: string
  // Feature flag (resolveHudEnabled). When false every method is a no-op.
  enabled: boolean
  // Injected for tests; defaults to the real transcript reader.
  readContextUsage?: ReadContextUsageFn
}

interface EnsuredMessage {
  id: number
  created: boolean
}

export class ContextHud {
  private readonly api: HudTelegramApi
  private readonly log: Logger
  private readonly sessionInfo: SessionInfoReader
  private readonly windowTokens: number
  private readonly windowOverride?: number | undefined
  private readonly owner: ReadonlySet<string>
  private readonly stateDir: string
  private readonly enabled: boolean
  private readonly readUsage: ReadContextUsageFn
  // In-memory message-id cache per chat (mirrors the on-disk persistence).
  private readonly messageIds = new Map<string, number>()
  // Latest work-status view per chat (todos synthesised from TodoWrite /
  // TaskCreate / TaskUpdate hook events). Kept ACROSS turns — a Stop hook
  // does not clear it, so the pinned card keeps showing «что сделали» until
  // the next task replaces the snapshot.
  private readonly work = new Map<string, { todos: ReadonlyArray<TodoItem>; taskMap: Map<string, TodoItem> }>()
  // M3 reality mirror: the reconciled view (real pane-verified list + freshness)
  // per chat. When present it SUPERSEDES the event-only `work` snapshot in the
  // render — the pin then reflects the harness's real task list. Fed by
  // TaskRealityMirror.applyReconciledView; the raw onTodoEvent path is bypassed
  // when the reconciler is wired (server.ts), so the two never fight.
  private readonly reconciled = new Map<string, { todos: ReadonlyArray<TodoItem>; freshness: TaskFreshness }>()
  // Per-chat session id, tracked from SessionStart + task events. Used to decide
  // when to CLEAR the task snapshot: a genuine session change clears it; a
  // compact (same id) preserves it. SessionStart fires for startup / resume /
  // clear / compact, so source alone can't tell «new session» from «compacted
  // same session» — the id does. KEPT across SessionEnd (review 2026-07-09 #2):
  // deleting it on end made the next startup's sessionChanged=false, so a
  // brand-new session inherited the dead session's task snapshot.
  private readonly sessionIds = new Map<string, string>()
  // Per-chat tombstones of ENDED session ids (bounded). A late task event
  // naming an ended session is dropped — pre-fix it cleared the active
  // session's work and adopted the dead id. SessionStart with the same id
  // (resume) un-tombstones. The reconciler's applyReconciledView is exempt:
  // it manages its own lifecycle and must be able to deliver the frozen
  // «сессия завершена» view right after SessionEnd.
  private readonly endedSessions = new Map<string, Set<string>>()
  // Dedup for reconciler-driven refreshes: hash of the last applied reconciled
  // «Задачи» render per chat. The reconciler ticks every 20s; when neither the
  // tasks nor the bucketed freshness label changed, skipping the refresh keeps
  // editMessageText traffic at zero instead of a no-op edit per tick.
  private readonly lastReconciledRender = new Map<string, string>()
  // Chats whose persisted epoch state has been restored this process lifetime.
  private readonly epochsRestored = new Set<string>()
  // bump() debounce per chat — a burst of inbound messages collapses to one
  // delete+resend (same rationale as TmuxMirror.BUMP_DEBOUNCE_MS).
  private readonly lastBumpAt = new Map<string, number>()
  // FIX-9 (both reviews): per-chat serialization. A concurrent SessionStart +
  // Stop (both firing before the first send persists an id) would each see an
  // empty cache and sendFresh → TWO pinned HUDs. Chaining every HUD operation
  // for a chat through this per-chat promise means the second waits for the
  // first to cache/persist the id, then edits it in place. Stored tail is the
  // SETTLED (never-rejecting) promise so a thrown op can't poison the chain.
  private readonly chatLocks = new Map<string, Promise<void>>()

  constructor(opts: ContextHudOptions) {
    this.api = opts.api
    this.log = opts.log
    this.sessionInfo = opts.sessionInfo
    this.windowTokens = opts.windowTokens
    this.windowOverride = opts.windowOverride
    this.owner = new Set(opts.ownerChatIds.map((id) => String(id)))
    this.stateDir = opts.stateDir
    this.enabled = opts.enabled
    this.readUsage = opts.readContextUsage ?? realReadContextUsage
  }

  // FIX-8 (both reviews): an owner chat is a configured owner id that is ALSO a
  // DM (positive numeric chat id). A group/supergroup id is negative and can
  // never own the pinned HUD — the HUD carries destructive buttons and must
  // NEVER be created or pinned in a public group, even if a group id somehow
  // slipped into the owner set. `ownerChatIds` is derived from resolveOwnerChatIds
  // (owner_chat_ids / allowed_user_ids), never allowed_chat_ids.
  private isOwner(chatId: string): boolean {
    if (!this.owner.has(chatId)) return false
    const n = Number(chatId)
    return Number.isInteger(n) && n > 0
  }

  // Serialize an operation per chat (FIX-9). The returned promise resolves when
  // THIS op completes; the next call for the same chat waits for it. `fn`
  // already swallows its own errors, so the chain never rejects.
  private runSerialized(chatId: string, fn: () => Promise<void>): Promise<void> {
    const prior = this.chatLocks.get(chatId) ?? Promise.resolve()
    const result = prior.then(fn, fn)
    const settled: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    )
    this.chatLocks.set(chatId, settled)
    void settled.then(() => {
      if (this.chatLocks.get(chatId) === settled) this.chatLocks.delete(chatId)
    })
    return result
  }

  // SessionStart: ensure the HUD message exists and is pinned, then refresh it.
  // The whole method is best-effort — it never throws. Serialized per chat.
  //
  // Task snapshot handling: SessionStart fires for startup, resume, clear AND
  // compact. A compact keeps the SAME session id, so clearing the task list on
  // every SessionStart would wipe the milestones the warchief is watching every
  // time the context is auto-compacted. We therefore clear ONLY on a genuine
  // session change (new id) or an explicit `source === 'clear'`; a compact with
  // the same id preserves the snapshot.
  onSessionStart(chatId: string, opts: { sessionId?: string; source?: string } = {}): Promise<void> {
    if (!this.enabled || !this.isOwner(chatId)) return Promise.resolve()
    const { sessionId, source } = opts
    this.restoreEpochs(chatId)
    const prev = this.sessionIds.get(chatId)
    // Rollback guard (review 2026-07-10 #2): a SessionStart naming an ENDED id
    // while a DIFFERENT session is tracked is a late/replayed straggler — it
    // must NOT displace the active session or clear its snapshot. Resume of an
    // ended id is valid only when no different session is tracked.
    if (
      sessionId !== undefined &&
      prev !== undefined &&
      prev !== sessionId &&
      this.endedSessions.get(chatId)?.has(sessionId) === true
    ) {
      return Promise.resolve()
    }
    const sessionChanged = sessionId !== undefined && prev !== undefined && prev !== sessionId
    if (source === 'clear' || sessionChanged) {
      // Genuine reset: drop the prior snapshot so the pin never shows stale
      // milestones (renderStatusTasks returns '' for an empty list → the
      // section is omitted until fresh TodoWrite/TaskCreate events arrive).
      this.work.delete(chatId)
      // M3: also drop the reconciled view; TaskRealityMirror re-pushes a fresh
      // «НЕ СВЕРЕНО» view for the new session immediately after.
      this.reconciled.delete(chatId)
      this.lastReconciledRender.delete(chatId)
    }
    // Compact / resume / first-ever start (same or unknown id) preserve the
    // snapshot. Track the latest known id for the next comparison. A resume
    // of an ENDED session legitimizes it again (drop the tombstone).
    if (sessionId !== undefined) {
      this.sessionIds.set(chatId, sessionId)
      this.endedSessions.get(chatId)?.delete(sessionId)
      this.persistEpoch(chatId)
    }
    return this.runSerialized(chatId, async () => {
      try {
        const { text, keyboard } = await this.renderCurrent(chatId)
        const ensured = await this.ensureMessage(chatId, text, keyboard)
        if (ensured === undefined) return
        // A freshly-sent message already carries current content AND was pinned
        // inside sendFresh — nothing more to do. A pre-existing message (reused
        // from the in-memory cache or the persisted file across a plugin restart)
        // must be (re)pinned so it stays stuck to the top, then refreshed.
        if (!ensured.created) {
          await this.pin(chatId, ensured.id)
          await this.edit(chatId, ensured.id, text, keyboard)
        }
      } catch (err) {
        this.log.warn('context hud onSessionStart failed (ignored)', {
          chat_id: chatId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }

  // Stop / end-of-turn: refresh the percentage. Stop carries model /
  // permission_mode for the pinned card but must NOT finalize task state. No
  // pin (that is SessionStart's job); updateNow self-heals a deleted message.
  async onStop(chatId: string): Promise<void> {
    await this.updateNow(chatId)
  }

  // SessionEnd (the REAL session end, unlike Stop): refresh the pinned card.
  // We keep the last task snapshot visible (the next SessionStart with a new id
  // clears it) and KEEP the tracked session id (review 2026-07-09 #2:
  // forgetting it made the next startup's sessionChanged=false, so a brand-new
  // session showed the dead session's tasks). The ended id is tombstoned so a
  // late task event naming it is dropped instead of clearing the active state.
  async onSessionEnd(chatId: string, opts: { sessionId?: string } = {}): Promise<void> {
    if (!this.enabled || !this.isOwner(chatId)) return
    this.restoreEpochs(chatId)
    const { sessionId } = opts
    const prev = this.sessionIds.get(chatId)
    if (sessionId !== undefined) {
      // Tombstone even a late end for a session we've moved past — its
      // stragglers must be dropped too. Bound 64 oldest-first (review
      // 2026-07-10 #2), persisted so tombstones survive a restart.
      let set = this.endedSessions.get(chatId)
      if (set === undefined) {
        set = new Set()
        this.endedSessions.set(chatId, set)
      }
      set.delete(sessionId)
      set.add(sessionId)
      while (set.size > 64) {
        const oldest = set.values().next().value
        if (oldest === undefined) break
        set.delete(oldest)
      }
      this.persistEpoch(chatId)
    }
    // Ignore a late SessionEnd for a session we've already moved past.
    if (sessionId !== undefined && prev !== undefined && prev !== sessionId) return
    await this.updateNow(chatId)
  }

  // Todo events (TodoWrite / TaskCreate / TaskUpdate, mapped by
  // toTodoWriteEvent in the webhook) — update the work view and refresh the
  // card in place. Session lifecycle events are handled by onSessionStart /
  // onSessionEnd, not here; if one slips through it is ignored.
  //
  // A task event whose sessionId differs from the tracked one signals a new
  // session (we may have missed SessionStart) — reset the stale snapshot and
  // adopt the new id so the pin never blends two sessions' task lists.
  onTodoEvent(chatId: string, event: TaskMirrorEvent): Promise<void> {
    if (!this.enabled || !this.isOwner(chatId)) return Promise.resolve()
    if (event.kind === 'session_start' || event.kind === 'session_end') {
      return Promise.resolve()
    }
    this.restoreEpochs(chatId)
    // Drop late stragglers from an ENDED session — they must not clear the
    // active session's snapshot or resurrect the dead id (review 2026-07-09 #2).
    if (this.endedSessions.get(chatId)?.has(event.sessionId) === true) {
      return Promise.resolve()
    }
    const prev = this.sessionIds.get(chatId)
    if (prev !== undefined && prev !== event.sessionId) {
      this.work.delete(chatId)
    }
    this.sessionIds.set(chatId, event.sessionId)
    let state = this.work.get(chatId)
    if (state === undefined) {
      state = { todos: [], taskMap: new Map<string, TodoItem>() }
      this.work.set(chatId, state)
    }
    switch (event.kind) {
      case 'todo_write':
        // TodoWrite payloads ARE the full list — replace wholesale and drop
        // the incremental map so a mid-session tool switch starts clean.
        state.taskMap.clear()
        state.todos = event.todos
        break
      case 'task_create':
        applyTaskCreateToMap(state.taskMap, event)
        state.todos = Array.from(state.taskMap.values())
        break
      case 'task_update':
        applyTaskUpdateToMap(state.taskMap, event)
        state.todos = Array.from(state.taskMap.values())
        break
    }
    return this.updateNow(chatId)
  }

  // M3 reality mirror: adopt the reconciled (pane-verified) task view + its
  // freshness indicator and refresh the pin in place. This SUPERSEDES the
  // event-only `work` snapshot in the render, so the pin reflects the harness's
  // real task list even when the agent skipped the task tools. Best-effort +
  // serialized like every other HUD op; gates on owner + enabled.
  applyReconciledView(
    chatId: string,
    view: { sessionId: string; todos: ReadonlyArray<TodoItem>; freshness: TaskFreshness },
  ): Promise<void> {
    if (!this.enabled || !this.isOwner(chatId)) return Promise.resolve()
    this.reconciled.set(chatId, { todos: view.todos, freshness: view.freshness })
    // Keep the tracked session id coherent so a later onSessionStart correctly
    // detects a genuine change.
    this.sessionIds.set(chatId, view.sessionId)
    // Reconciler-tick dedup: the mirror ticks every 20s and the freshness label
    // is minute-bucketed, so most ticks change NOTHING in the rendered section.
    // Skip the whole refresh when the rendered «Задачи» section is identical to
    // the previously applied one — no editMessageText per tick.
    const renderKey = `${view.sessionId}|${renderStatusTasks(view.todos, view.freshness)}`
    if (this.lastReconciledRender.get(chatId) === renderKey) return Promise.resolve()
    this.lastReconciledRender.set(chatId, renderKey)
    return this.updateNow(chatId)
  }

  // Re-anchor the pinned card at the BOTTOM of the chat (just above the tmux
  // mirror — the handlers fire this BEFORE TmuxMirror.bump on every inbound
  // owner message). Deletes the old message — which also removes its pin, so
  // the one-pin invariant holds — and sends+pins a fresh one. When Telegram
  // refuses the delete (bots cannot delete own messages older than 48h) we
  // fall back to unpinChatMessage so two pins can never coexist. Debounced
  // and serialized per chat; best-effort like every other HUD op.
  bump(chatId: string): Promise<void> {
    if (!this.enabled || !this.isOwner(chatId)) return Promise.resolve()
    const now = Date.now()
    const last = this.lastBumpAt.get(chatId)
    if (last !== undefined && now - last < HUD_BUMP_DEBOUNCE_MS) return Promise.resolve()
    this.lastBumpAt.set(chatId, now)
    return this.runSerialized(chatId, async () => {
      try {
        const { text, keyboard } = await this.renderCurrent(chatId)
        const old = this.messageIds.get(chatId) ?? this.loadPersisted(chatId)
        if (old !== undefined) {
          this.messageIds.delete(chatId)
          // `retired` = the old card can no longer hold a pin (deleted, or
          // unpinned in place). Only a retired old card may be replaced —
          // otherwise sending a fresh pinned card could yield TWO pins
          // (codex review 2026-07-04, HIGH #1).
          let retired = false
          try {
            await this.api.deleteMessage(chatId, old)
            retired = true
            // Deliberate persistence cleanup (codex MED #3): the persisted id
            // now points at a deleted message. Drop it so a crash between
            // here and sendFresh can't resurrect the stale id later.
            this.clearPersisted(chatId)
          } catch (err) {
            this.log.warn('context hud bump delete failed (will unpin instead)', {
              chat_id: chatId,
              message_id: old,
              error: err instanceof Error ? err.message : String(err),
            })
          }
          if (!retired) {
            try {
              await this.api.unpinChatMessage(chatId, old)
              retired = true
            } catch (err) {
              this.log.warn('context hud bump unpin failed (ignored)', {
                chat_id: chatId,
                message_id: old,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }
          if (!retired) {
            // BOTH legs failed — the old card may still be pinned somewhere.
            // Bail out and keep pointing at it: a stale position beats a
            // second pinned card (the one-pin invariant is the warchief's
            // hard requirement). The next bump retries the whole sequence.
            this.messageIds.set(chatId, old)
            return
          }
        }
        // sendFresh persists the new id (overwriting the stale one) and pins.
        await this.sendFresh(chatId, text, keyboard)
      } catch (err) {
        this.log.warn('context hud bump failed (ignored)', {
          chat_id: chatId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }

  // Read the latest usage and reconcile the HUD message. Best-effort: never
  // throws. Creates the message if none exists yet (e.g. Stop before any
  // SessionStart), otherwise edits it in place. Serialized per chat.
  updateNow(chatId: string): Promise<void> {
    if (!this.enabled || !this.isOwner(chatId)) return Promise.resolve()
    return this.runSerialized(chatId, async () => {
      try {
        const { text, keyboard } = await this.renderCurrent(chatId)
        const ensured = await this.ensureMessage(chatId, text, keyboard)
        // No message and send failed → swallow. Freshly created → already current.
        if (ensured === undefined || ensured.created) return
        await this.edit(chatId, ensured.id, text, keyboard)
      } catch (err) {
        this.log.warn('context hud updateNow failed (ignored)', {
          chat_id: chatId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }

  // ─── internals ────────────────────────────────────────────────────

  // Render the HUD for the chat's CURRENT session facts. Reads the transcript
  // (best-effort — a null usage renders «Контекст: —»).
  private async renderCurrent(
    chatId: string,
  ): Promise<{ text: string; keyboard: InlineKeyboardLike }> {
    const info = this.sessionInfo.get(chatId)
    // Read the transcript FIRST — it carries the true `message.model` id that
    // Claude Code hook payloads do NOT (empirically verified 2026-07-10: no
    // `model` key on SessionStart/Stop hooks). The window passed here only
    // affects usage.pct, which renderHud recomputes from usedTokens and never
    // consumes — so a provisional fallback window is safe.
    let usage: ContextUsage | null = null
    if (info.transcriptPath !== undefined && info.transcriptPath.length > 0) {
      try {
        usage = await this.readUsage(info.transcriptPath, this.windowTokens)
      } catch {
        // readContextUsage already swallows I/O; guard the injected fn too.
        usage = null
      }
    }
    // Model-aware window. Precedence: explicit operator override > hook-provided
    // model (info.model, still honored if a future harness adds one) >
    // transcript-derived model (message.model) > configured default. So a
    // Fable-5 session reports its 1M window instead of the 200k default even
    // though no hook carries the model. Recomputed each render so a mid-session
    // model switch is picked up.
    const model = info.model ?? usage?.model
    const windowTokens = resolveContextWindowForModel(model, {
      override: this.windowOverride,
      fallback: this.windowTokens,
    })
    // M3: the reconciled (pane-verified) view wins over the event-only snapshot.
    const rv = this.reconciled.get(chatId)
    const permissionMode =
      info.permissionMode !== undefined && info.permissionMode.length > 0
        ? { permissionMode: info.permissionMode }
        : {}
    const work: HudWorkView = rv !== undefined
      ? { todos: rv.todos, freshness: rv.freshness, ...permissionMode }
      : { todos: this.work.get(chatId)?.todos ?? [], ...permissionMode }
    return renderHud(usage, windowTokens, model, work)
  }

  // Resolve the HUD message id for a chat: in-memory cache → persisted file →
  // send a fresh one. Returns `created:true` only when a new message was sent.
  private async ensureMessage(
    chatId: string,
    text: string,
    keyboard: InlineKeyboardLike,
  ): Promise<EnsuredMessage | undefined> {
    const mem = this.messageIds.get(chatId)
    if (mem !== undefined) return { id: mem, created: false }

    const disk = this.loadPersisted(chatId)
    if (disk !== undefined) {
      this.messageIds.set(chatId, disk)
      return { id: disk, created: false }
    }

    const created = await this.sendFresh(chatId, text, keyboard)
    if (created === undefined) return undefined
    return { id: created, created: true }
  }

  // Send a brand-new HUD message, persist its id, and pin it. All best-effort;
  // returns the new id or undefined when the send itself failed.
  private async sendFresh(
    chatId: string,
    text: string,
    keyboard: InlineKeyboardLike,
  ): Promise<number | undefined> {
    let messageId: number
    try {
      const sent = await this.api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      })
      messageId = sent.message_id
    } catch (err) {
      this.log.warn('context hud send failed (ignored)', {
        chat_id: chatId,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
    this.messageIds.set(chatId, messageId)
    this.persist(chatId, messageId)
    await this.pin(chatId, messageId)
    return messageId
  }

  // Edit the existing HUD message. Classifies Telegram errors:
  //   • "not modified" → benign no-op (same pct rounding as last time)
  //   • message deleted (400) → recreate + repin ONCE (sendFresh, no re-edit,
  //     so there is no recreate loop)
  //   • anything else → swallow + log
  private async edit(
    chatId: string,
    messageId: number,
    text: string,
    keyboard: InlineKeyboardLike,
  ): Promise<void> {
    try {
      await this.api.editMessageText(chatId, messageId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      })
    } catch (err) {
      const cls = classifyEditError(err)
      if (cls.kind === 'benign') return
      if (cls.kind === 'message_gone') {
        // The user deleted the HUD. Drop the stale id and recreate exactly
        // once — sendFresh persists + pins the replacement and does NOT call
        // back into edit, so a permanently-gone message can't spin a loop.
        this.messageIds.delete(chatId)
        await this.sendFresh(chatId, text, keyboard)
        return
      }
      this.log.warn('context hud edit failed (ignored)', {
        chat_id: chatId,
        kind: cls.kind,
        description: 'description' in cls ? cls.description : undefined,
      })
    }
  }

  // Pin the HUD message silently. Best-effort — a pin failure (already pinned,
  // lost permission, message gone) must never break a HUD refresh.
  private async pin(chatId: string, messageId: number): Promise<void> {
    try {
      await this.api.pinChatMessage(chatId, messageId, { disable_notification: true })
    } catch (err) {
      this.log.warn('context hud pin failed (ignored)', {
        chat_id: chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ─── persistence ──────────────────────────────────────────────────

  private persistPath(chatId: string): string {
    // chatId is a numeric string (possibly negative for supergroups); sanitize
    // defensively so a surprising value can never escape the state dir.
    const safe = chatId.replace(/[^0-9A-Za-z_-]/g, '_')
    return join(this.stateDir, `context-hud-${safe}.json`)
  }

  // Remove the persisted id after a successful delete — a file pointing at a
  // deleted message is worse than no file (bump/updateNow would edit a ghost).
  private clearPersisted(chatId: string): void {
    try {
      rmSync(this.persistPath(chatId), { force: true })
    } catch (err) {
      this.log.warn('context hud clearPersisted failed (ignored)', {
        chat_id: chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Full persisted shape (schema-versioned; v2 adds the epoch block).
  private loadPersistedFull(chatId: string): {
    messageId?: number
    epoch?: { active?: string; ended?: ReadonlyArray<string> }
  } {
    try {
      const raw = readFileSync(this.persistPath(chatId), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
      const obj = parsed as Record<string, unknown>
      const out: { messageId?: number; epoch?: { active?: string; ended?: ReadonlyArray<string> } } = {}
      const id = obj.message_id
      if (typeof id === 'number' && Number.isInteger(id) && id > 0) out.messageId = id
      if (typeof obj.epoch === 'object' && obj.epoch !== null && !Array.isArray(obj.epoch)) {
        const e = obj.epoch as Record<string, unknown>
        const active = typeof e.active === 'string' && e.active.length > 0 ? e.active : undefined
        const ended = Array.isArray(e.ended)
          ? e.ended.filter((s): s is string => typeof s === 'string' && s.length > 0).slice(-64)
          : undefined
        out.epoch = {
          ...(active !== undefined ? { active } : {}),
          ...(ended !== undefined ? { ended } : {}),
        }
      }
      return out
    } catch {
      return {} // missing file / malformed JSON → nothing persisted
    }
  }

  private loadPersisted(chatId: string): number | undefined {
    return this.loadPersistedFull(chatId).messageId
  }

  // Restore persisted epoch state (tracked session + ended tombstones) ONCE
  // per chat (review 2026-07-10 #2: HUD epoch state was runtime-only, so a
  // restart forgot every tombstone and a dead session's stragglers could
  // clear the active snapshot). Runtime state is never clobbered.
  private restoreEpochs(chatId: string): void {
    if (this.epochsRestored.has(chatId)) return
    this.epochsRestored.add(chatId)
    const epoch = this.loadPersistedFull(chatId).epoch
    if (epoch === undefined) return
    if (epoch.active !== undefined && !this.sessionIds.has(chatId)) {
      this.sessionIds.set(chatId, epoch.active)
    }
    if (epoch.ended !== undefined && !this.endedSessions.has(chatId)) {
      this.endedSessions.set(chatId, new Set(epoch.ended))
    }
  }

  private writePersisted(chatId: string, messageId: number | undefined): void {
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      const active = this.sessionIds.get(chatId)
      const ended = this.endedSessions.get(chatId)
      const body = {
        v: 2,
        ...(messageId !== undefined ? { message_id: messageId } : {}),
        epoch: {
          ...(active !== undefined ? { active } : {}),
          ...(ended !== undefined && ended.size > 0 ? { ended: [...ended] } : {}),
        },
      }
      writeFileSync(this.persistPath(chatId), JSON.stringify(body), { mode: 0o600 })
    } catch (err) {
      this.log.warn('context hud persist failed (ignored)', {
        chat_id: chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private persist(chatId: string, messageId: number): void {
    this.writePersisted(chatId, messageId)
  }

  // Refresh ONLY the epoch block, preserving the persisted message id.
  private persistEpoch(chatId: string): void {
    const messageId = this.messageIds.get(chatId) ?? this.loadPersistedFull(chatId).messageId
    this.writePersisted(chatId, messageId)
  }
}

// ─────────────────────────────────────────────────────────────────────
// Callback handler for the HUD's callbacks (hud:compact — the card's only
// button — plus legacy hud:new from stale pre-removal markup).
//
// Fail-closed auth FIRST (config.allowed_user_ids — the SAME allowlist that
// guards every other session-driving control), then parse, then act:
//   • hud:compact → answer «Сжимаю…» and drive the reliable /compact injection
//     (probe → interrupt-if-busy → send → confirm). On failure, best-effort
//     toast the reason. The next Stop refreshes the HUD percentage.
//   • hud:new → reuse the wave-3A /new confirm flow: post the SAME confirm card
//     whose `newq:confirm` / `newq:cancel` buttons the existing router already
//     handles, so a destructive clear ALWAYS confirms. Never clears directly.
// ─────────────────────────────────────────────────────────────────────

import {
  sendControlCommand,
  type ControlCommandResult,
  type TmuxKeysTarget,
} from '../commands/keys.js'
import { buildNewConfirmCard, isOwnerDmChat, type ControlSender } from '../telegram/newq-confirm-ui.js'

export type HudAction = 'compact' | 'new'

// Parse a `hud:<action>` callback_data string. Returns the validated action or
// null (non-hud prefix or unknown action) — null callers toast and do NOTHING.
export function parseHudCallback(data: string): HudAction | null {
  if (typeof data !== 'string') return null
  if (!data.startsWith(HUD_PREFIX)) return null
  const action = data.slice(HUD_PREFIX.length)
  return action === 'compact' || action === 'new' ? action : null
}

// The failure arm of ControlCommandResult (`ok: false`) narrowed to its reason.
type ControlFailureReason = Extract<ControlCommandResult, { ok: false }>['reason']

// Short toast for a failed /compact injection. The reason is a bounded enum,
// never user text.
function compactFailureToast(reason: ControlFailureReason): string {
  switch (reason) {
    case 'busy':
      return 'агент занят, попробуй ещё раз'
    case 'dialog':
      return 'сессия ждёт ответа в диалоге'
    case 'unknown':
      return 'не удалось определить состояние'
    case 'not-submitted':
    case 'tmux':
      return 'не удалось отправить'
  }
}

export interface HudCallbackContext {
  callbackQuery: { data: string }
  from?: { id?: number | undefined }
  // The chat the tap came from — where the /new confirm card is posted.
  chatId: string
  answerCallbackQuery(arg?: { text: string }): Promise<void>
}

export interface HudCallbackDeps {
  allowedUserIds: readonly number[]
  tmuxKeysTarget?: TmuxKeysTarget
  log: Logger
  // Post the /new confirm card (buildNewConfirmCard) as a FRESH message so the
  // pinned HUD is left intact. Wired in server.ts to the safe-wrapped api.
  sendConfirmCard: (chatId: string, text: string, keyboard: InlineKeyboardLike) => Promise<void>
  // Injected for tests; defaults to the real reliable sender.
  sendControl?: ControlSender
  // FIX-8 (both reviews): the OWNER DM chat ids (resolveOwnerChatIds). The HUD's
  // control buttons drive the single global tmux pane = the MAIN DM session, so
  // a tap from ANY other chat (a group where a stray HUD was somehow pinned)
  // must be refused. When omitted (legacy/tests) the check is skipped.
  ownerChatIds?: readonly (number | string)[]
}

// Dispatch a `hud:*` callback. Always answers the callback query and returns
// true when it consumed the event. NEVER drives the pane / clears for a
// non-allowed user id.
export async function handleHudCallback(
  ctx: HudCallbackContext,
  deps: HudCallbackDeps,
): Promise<boolean> {
  // AUTH FIRST — before parsing or touching the pane. A missing/non-number id
  // is unauthorized (fail-closed).
  const fromId = ctx.from?.id
  if (typeof fromId !== 'number' || !deps.allowedUserIds.includes(fromId)) {
    deps.log.warn('hud unauthorized tap', {
      user_id: fromId,
      data: ctx.callbackQuery.data,
    })
    await ctx.answerCallbackQuery({ text: 'не авторизовано' })
    return true
  }

  // FIX-8: a HUD tap only drives the pane from the OWNER DM. A tap whose chat is
  // not the owner DM (a group where a stray HUD surfaced) is refused — the
  // control buttons act on the single global DM session, never a group.
  if (!isOwnerDmChat(ctx.chatId, deps.ownerChatIds)) {
    deps.log.warn('hud tap from non-owner chat refused', {
      chat_id: ctx.chatId,
      user_id: fromId,
    })
    await ctx.answerCallbackQuery({ text: 'недоступно в этом чате' })
    return true
  }

  const action = parseHudCallback(ctx.callbackQuery.data)
  if (action === null) {
    await ctx.answerCallbackQuery({ text: 'неизвестное действие' })
    return true
  }

  if (action === 'new') {
    // Reuse the wave-3A confirm-then-clear flow: post the SAME card. Its
    // `newq:*` buttons are handled by the existing router branch, which drives
    // the reliable /clear. We never clear directly here.
    await ctx.answerCallbackQuery()
    const card = buildNewConfirmCard()
    try {
      await deps.sendConfirmCard(ctx.chatId, card.text, card.inlineKeyboard)
    } catch (err) {
      deps.log.warn('hud new confirm-card send failed (ignored)', {
        chat_id: ctx.chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  // action === 'compact'
  if (deps.tmuxKeysTarget === undefined) {
    await ctx.answerCallbackQuery({ text: 'pane недоступен' })
    return true
  }
  await ctx.answerCallbackQuery({ text: 'Сжимаю…' })
  const send = deps.sendControl ?? sendControlCommand
  const result = await send(deps.tmuxKeysTarget, 'compact', { interruptIfBusy: true })
  if (!result.ok) {
    // L10 (IT2-8): a SECOND answerCallbackQuery on the same query id is DROPPED by
    // Telegram, so the failure was invisible. Surface it VISIBLY with a fresh
    // short message (empty keyboard) instead — the warchief must see that «Сжать»
    // did not fire. Best-effort: a failed send must never throw out of the HUD.
    const notice = `🗜 <b>Сжать</b> — ${compactFailureToast(result.reason)}`
    try {
      await deps.sendConfirmCard(ctx.chatId, notice, { inline_keyboard: [] })
    } catch (err) {
      deps.log.warn('hud compact failure notice send failed (ignored)', {
        chat_id: ctx.chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return true
}
