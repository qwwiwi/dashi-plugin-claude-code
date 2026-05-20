// TaskMirror — third rolling Telegram message per chat. Where StatusManager
// owns the transient «Печатает.../🔧 tool» bubble and ProgressReporter owns
// the per-tool activity thread, TaskMirror owns a separate persistent message
// that mirrors Claude's TodoWrite milestone list: in-progress / pending /
// completed items.
//
// The three surfaces NEVER share state — each Map entry is keyed on chatId
// inside its own class. This isolation is intentional: an operator can flip
// any of (status.enabled / progress.enabled / task_mirror.enabled) without
// disturbing the others.
//
// Architectural mirror of ProgressReporter (see plan §2.1):
//   * Single-slot queue per chat — `flushPromise !== null` guards in-flight
//     ops. Multiple TodoWrite events while a flush runs overwrite
//     `desiredText`; only the freshest snapshot ever publishes.
//   * Throttle via `edit_throttle_ms`. First send bypasses throttle, subsequent
//     edits within the window defer onto a single timer slot.
//   * Idempotency: same rendered text → no Telegram round-trip.
//   * TTL eviction on `session_ttl_ms` of idleness — protects against lost
//     `session_stop` hooks the way ProgressReporter does.
//   * `recordEvent` is fire-and-forget; top-level try/catch swallows every
//     throw so the webhook 200 path is never blocked.

import type { AppConfig } from '../config.js'
import type { Logger } from '../log.js'
import type { TaskMirrorEvent } from '../hooks/claude-events.js'
import type { TodoItem } from '../schemas.js'
import type { TelegramApiForProgress } from './telegram-api.js'
import { escapeHtml } from '../format/html.js'

// Telegram editMessageText cap (4096 chars). Default render budget below it
// — the spec asks for ~3500-char headroom (see plan §3 file 4).
const DEFAULT_MAX_CHARS = 3500
const TRUNCATE_MARGIN = 100 // safety cushion below MAX_CHARS for tail strings

// Status icons. Unicode glyphs match the plan §2.3 spec.
const ICONS = {
  in_progress: '◐',
  pending: '◻',
  completed: '☑',
} as const

// HTML used as parse_mode for both send and edit — same as ProgressReporter.
const HTML_OPTS = { parse_mode: 'HTML' as const }

export interface TaskMirrorDeps {
  telegramApi: TelegramApiForProgress
  config: AppConfig
  log: Logger
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout
  clearTimer?: (handle: NodeJS.Timeout) => void
}

// Per-chat lifecycle entry. Field-for-field parallel to ChatProgressEntry,
// only `calls[]` is replaced with `todos[]` (latest snapshot, not a window).
interface ChatTaskEntry {
  chatId: string
  messageId?: number
  startedAtMs: number
  // Updated on every recordEvent. Used by TTL eviction in getOrCreate.
  lastActivityMs: number
  // Latest TodoWrite snapshot from Claude. Replaced wholesale on each event
  // — TodoWrite is itself the full list, so we never merge incrementally.
  todos: ReadonlyArray<TodoItem>
  // Incremental task map for the TaskCreate/TaskUpdate path (newer Claude Code
  // harness). Key is the harness taskId once reconciled from `toolResult`, or
  // the provisional `toolUseId` until then. `todos` is rebuilt from this map
  // after every mutation so `scheduleFlush` keeps using the existing renderer.
  // Insertion-order Map keeps the visual ordering stable across renders.
  taskMap: Map<string, TodoItem>
  // Last text we actually sent / edited. Idempotency gate.
  lastRenderedText?: string
  // Timestamp of the last successful send or edit. Used for throttle.
  lastEditAtMs: number
  // Newest snapshot text waiting to be published. Multiple events overwrite
  // so only the freshest view ever lands on Telegram.
  desiredText?: string
  // Single-slot scheduler: non-null while a Telegram op is in flight.
  flushPromise: Promise<void> | null
  // Single-slot throttle timer. Non-null while waiting for the throttle
  // window to elapse before publishing.
  pendingTimer: NodeJS.Timeout | null
  // True once todo_session_stop has been processed. Idempotency guard.
  stopped: boolean
}

// Extract the harness-assigned task id from a TaskCreate PostToolUse
// `tool_result`. The harness emits `Task #<n> created successfully...`; we
// pull out the first `#<digits>` token. Returns null if the shape doesn't
// match — caller falls back to the provisional `toolUseId`.
function parseCreatedTaskId(toolResult: unknown): string | null {
  if (typeof toolResult !== 'string') return null
  const match = toolResult.match(/#(\d+)/)
  return match ? (match[1] ?? null) : null
}

export class TaskMirror {
  private readonly telegramApi: TelegramApiForProgress
  private readonly config: AppConfig
  private readonly log: Logger
  private readonly now: () => number
  private readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout
  private readonly clearTimer: (handle: NodeJS.Timeout) => void
  private readonly chats: Map<string, ChatTaskEntry>

  constructor(deps: TaskMirrorDeps) {
    this.telegramApi = deps.telegramApi
    this.config = deps.config
    this.log = deps.log
    this.now = deps.now ?? (() => Date.now())
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))
    this.chats = new Map()
  }

  /**
   * Main entry point. Called by the webhook handler for every Claude hook
   * that mapped to a TaskMirrorEvent. Never throws — top-level try/catch
   * swallows any failure so the webhook 200 path stays open.
   *
   * Three input shapes:
   *   - `todo_write`: full list snapshot (legacy TodoWrite tool). Replaces
   *     `todos` wholesale AND clears `taskMap` so a mid-session switch from
   *     TodoWrite to TaskCreate/Update starts cleanly.
   *   - `task_create` / `task_update`: incremental events from the newer
   *     TaskCreate/TaskUpdate tools. Mutate `taskMap`, then synthesise the
   *     `todos` array from it.
   *   - `todo_session_stop`: terminal signal, handled separately.
   */
  async recordEvent(chatId: string, event: TaskMirrorEvent): Promise<void> {
    if (!this.config.task_mirror.enabled) return
    try {
      if (event.kind === 'todo_session_stop') {
        await this.handleStop(chatId)
        return
      }
      const entry = this.getOrCreate(chatId)
      if (entry.stopped) return
      entry.lastActivityMs = this.now()

      switch (event.kind) {
        case 'todo_write':
          // Replace the snapshot wholesale. TodoWrite payloads ARE the full list.
          entry.taskMap.clear()
          entry.todos = event.todos
          break
        case 'task_create':
          this.applyTaskCreate(entry, event)
          entry.todos = Array.from(entry.taskMap.values())
          break
        case 'task_update':
          this.applyTaskUpdate(entry, event)
          entry.todos = Array.from(entry.taskMap.values())
          break
      }
      this.scheduleFlush(entry)
    } catch (err) {
      this.log.warn('task mirror recordEvent failed (ignored)', {
        chat_id: chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * TaskCreate handler. PreToolUse adds the task to `taskMap` keyed on
   * `toolUseId` (provisional id, always present). The follow-up PostToolUse
   * carries `toolResult`; if we can parse a real `#<n>` id we re-key the
   * entry so subsequent `TaskUpdate` events (which use the real id) can find
   * it. Two arrivals are idempotent — a TaskCreate that has already been
   * recorded under its provisional id and a matching PostToolUse with the
   * same toolUseId find the entry and reconcile without duplicating.
   *
   * Note: the harness convention is `Task #N created successfully` — see
   * TaskCreate tool description. `parseCreatedTaskId` extracts the first
   * `#<digits>` substring and returns null on shape mismatch.
   */
  private applyTaskCreate(
    entry: ChatTaskEntry,
    event: Extract<TaskMirrorEvent, { kind: 'task_create' }>,
  ): void {
    const realId =
      event.toolResult !== undefined ? parseCreatedTaskId(event.toolResult) : null
    const provisionalId = event.toolUseId
    const provisional = entry.taskMap.get(provisionalId)
    const item: TodoItem = {
      id: realId ?? provisional?.id ?? provisionalId,
      content: event.input.subject,
      status: provisional?.status ?? 'pending',
      ...(event.input.activeForm !== undefined
        ? { activeForm: event.input.activeForm }
        : provisional?.activeForm !== undefined
          ? { activeForm: provisional.activeForm }
          : {}),
    }
    // Drop the provisional entry, insert under the canonical id. This re-keys
    // the Map without dropping anything else; insertion-order semantics mean
    // the task moves to the tail on reconciliation, which is the right place
    // visually (most recently activated).
    entry.taskMap.delete(provisionalId)
    if (realId !== null && realId !== provisionalId) {
      entry.taskMap.delete(realId)
    }
    entry.taskMap.set(item.id ?? provisionalId, item)
  }

  /**
   * TaskUpdate handler. `taskId` from the harness is always a string after
   * the schema coerce. If the entry exists, mutate in place; if not (e.g.
   * TaskMirror missed the TaskCreate due to a webhook drop), synthesise a
   * minimal placeholder so the list stays consistent.
   */
  private applyTaskUpdate(
    entry: ChatTaskEntry,
    event: Extract<TaskMirrorEvent, { kind: 'task_update' }>,
  ): void {
    const id = event.input.taskId
    // Drop 'deleted' before constructing the TodoItem -- the rendered TodoItem
    // type accepts only pending/in_progress/completed, and the schema-coerced
    // 'deleted' value would not narrow correctly otherwise.
    if (event.input.status === 'deleted') {
      entry.taskMap.delete(id)
      return
    }
    const existing = entry.taskMap.get(id)
    const status = event.input.status ?? existing?.status ?? 'pending'
    const next: TodoItem = {
      id,
      content: event.input.subject ?? existing?.content ?? `task ${id}`,
      status,
      ...(event.input.activeForm !== undefined
        ? { activeForm: event.input.activeForm }
        : existing?.activeForm !== undefined
          ? { activeForm: existing.activeForm }
          : {}),
    }
    entry.taskMap.set(id, next)
  }

  /**
   * Test-only drain — same contract as ProgressReporter._idleForTests.
   */
  async _idleForTests(chatId: string): Promise<void> {
    for (let i = 0; i < 16; i++) {
      const entry = this.chats.get(chatId)
      if (!entry || entry.flushPromise === null) return
      try {
        await entry.flushPromise
      } catch {
        /* already logged */
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────

  private getOrCreate(chatId: string): ChatTaskEntry {
    const existing = this.chats.get(chatId)
    if (existing) {
      const idle = this.now() - existing.lastActivityMs
      if (idle > this.config.task_mirror.session_ttl_ms) {
        this.log.debug('task mirror entry TTL expired, starting fresh thread', {
          chat_id: chatId,
          idle_ms: idle,
        })
        this.chats.delete(chatId)
      } else {
        return existing
      }
    }
    const entry: ChatTaskEntry = {
      chatId,
      startedAtMs: this.now(),
      lastActivityMs: this.now(),
      todos: [],
      taskMap: new Map(),
      lastEditAtMs: 0,
      flushPromise: null,
      pendingTimer: null,
      stopped: false,
    }
    this.chats.set(chatId, entry)
    return entry
  }

  /**
   * Render the current snapshot and schedule a flush. Idempotent — if a
   * flush is already in flight or a timer is armed, just update
   * `desiredText` and return.
   */
  private scheduleFlush(entry: ChatTaskEntry): void {
    if (entry.stopped) return
    const text = this.safeRender(entry.todos)
    if (!text || text === entry.lastRenderedText) return
    entry.desiredText = text

    if (entry.flushPromise !== null || entry.pendingTimer !== null) return

    const isFirstSend = entry.messageId === undefined
    const elapsed = this.now() - entry.lastEditAtMs
    const wait = isFirstSend
      ? 0
      : Math.max(0, this.config.task_mirror.edit_throttle_ms - elapsed)

    if (wait > 0) {
      entry.pendingTimer = this.setTimer(() => {
        entry.pendingTimer = null
        this.startFlush(entry)
      }, wait)
    } else {
      this.startFlush(entry)
    }
  }

  private startFlush(entry: ChatTaskEntry): void {
    if (entry.stopped) return
    if (entry.flushPromise !== null) return
    const text = entry.desiredText
    if (text === undefined || text === entry.lastRenderedText) return
    delete entry.desiredText

    entry.flushPromise = this.executeFlush(entry, text).finally(() => {
      entry.flushPromise = null
      if (
        !entry.stopped &&
        entry.desiredText !== undefined &&
        entry.desiredText !== entry.lastRenderedText
      ) {
        this.scheduleFlush(entry)
      }
    })
  }

  private async executeFlush(entry: ChatTaskEntry, text: string): Promise<void> {
    if (entry.messageId === undefined) {
      try {
        const sent = await this.telegramApi.sendMessage(entry.chatId, text, HTML_OPTS)
        if (!entry.stopped) {
          entry.messageId = sent.message_id
          entry.lastRenderedText = text
          entry.lastEditAtMs = this.now()
        } else {
          this.log.warn('task mirror send completed after stop (orphan)', {
            chat_id: entry.chatId,
            message_id: sent.message_id,
          })
        }
      } catch (err) {
        this.log.warn('task mirror sendMessage failed (ignored)', {
          chat_id: entry.chatId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }
    try {
      await this.telegramApi.editMessageText(entry.chatId, entry.messageId, text, HTML_OPTS)
      if (!entry.stopped) {
        entry.lastRenderedText = text
        entry.lastEditAtMs = this.now()
      }
    } catch (err) {
      this.log.warn('task mirror editMessageText failed (ignored)', {
        chat_id: entry.chatId,
        message_id: entry.messageId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Eviction handler — mirrors ProgressReporter.handleStop. Cancels timers,
   * awaits any in-flight flush, posts a final edit (if a message exists)
   * with the latest snapshot AND a «сессия завершена» marker line, then
   * deletes the entry.
   *
   * Why the marker: without it, if the last TodoWrite snapshot was already
   * rendered the idempotency gate (`text === lastRenderedText`) skips the
   * final edit — the warchief never sees a visual «session ended» signal.
   * Appending a non-empty marker line guarantees the final text differs.
   */
  private async handleStop(chatId: string): Promise<void> {
    const entry = this.chats.get(chatId)
    if (!entry || entry.stopped) return
    entry.stopped = true

    if (entry.pendingTimer !== null) {
      this.clearTimer(entry.pendingTimer)
      entry.pendingTimer = null
    }

    if (entry.flushPromise !== null) {
      try {
        await entry.flushPromise
      } catch {
        /* already logged */
      }
    }

    if (entry.messageId !== undefined) {
      const text = this.renderFinal(entry)
      if (text && text !== entry.lastRenderedText) {
        try {
          await this.telegramApi.editMessageText(entry.chatId, entry.messageId, text, HTML_OPTS)
          entry.lastRenderedText = text
        } catch (err) {
          this.log.warn('task mirror final edit failed (ignored)', {
            chat_id: entry.chatId,
            message_id: entry.messageId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    this.chats.delete(chatId)
  }

  /**
   * Final-edit body: current snapshot + «сессия завершена» marker. The
   * marker ALWAYS differs from any intermediate render so idempotency
   * never skips this edit (otherwise the warchief might never see a
   * session-end signal). Same DEFAULT_MAX_CHARS budget applies — if the
   * snapshot already pushes against the cap, the marker still fits inside
   * the safety margin renderTodoList reserves.
   */
  private renderFinal(entry: ChatTaskEntry): string {
    const block = this.safeRender(entry.todos)
    if (!block) return ''
    return `${block}\n<i>сессия завершена</i>`
  }

  private safeRender(todos: ReadonlyArray<TodoItem>): string {
    try {
      return renderTodoList(todos, this.config.task_mirror.collapse_completed_after)
    } catch (err) {
      this.log.warn('task mirror render failed (ignored)', {
        error: err instanceof Error ? err.message : String(err),
      })
      return ''
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Renderer (exported for tests)
// ─────────────────────────────────────────────────────────────────────

/**
 * Render a TodoWrite snapshot as Telegram-friendly HTML. Section order:
 *   1. Header — bold «Задачи» + counts.
 *   2. In-progress items — icon ◐.
 *   3. Pending items — icon ◻.
 *   4. Last `collapseCompletedAfter` completed items — icon ☑.
 *   5. Tail line if more completed exist: `<i>+M завершено ранее</i>`.
 *
 * Edge cases:
 *   - Empty list: `<i>задач нет</i>` (don't delete the message).
 *   - Total length cap at ~DEFAULT_MAX_CHARS: pending list truncates first,
 *     then completed, with `<i>+N ещё…</i>` tail.
 *
 * Every dynamic string passes through `escapeHtml` so user-supplied todo
 * content can't break out of the message.
 */
export function renderTodoList(
  todos: ReadonlyArray<TodoItem>,
  collapseCompletedAfter: number,
  maxChars: number = DEFAULT_MAX_CHARS,
): string {
  if (todos.length === 0) {
    return '<b>Задачи</b>\n<i>задач нет</i>'
  }

  let doneCount = 0
  let inProgressCount = 0
  let pendingCount = 0
  const inProgress: TodoItem[] = []
  const pending: TodoItem[] = []
  const completed: TodoItem[] = []
  for (const t of todos) {
    switch (t.status) {
      case 'in_progress':
        inProgressCount++
        inProgress.push(t)
        break
      case 'pending':
        pendingCount++
        pending.push(t)
        break
      case 'completed':
        doneCount++
        completed.push(t)
        break
    }
  }

  const header = '<b>Задачи</b>'
  const counts = `${doneCount} done / ${inProgressCount} in progress / ${pendingCount} pending`

  // Show only the last N completed items; older ones collapse into a tail
  // notice. `collapseCompletedAfter=0` means «hide all completed» — render
  // none, then the tail says how many were hidden.
  const visibleCompleted = collapseCompletedAfter > 0
    ? completed.slice(-collapseCompletedAfter)
    : []
  const hiddenCompletedCount = completed.length - visibleCompleted.length

  const lines: string[] = [header, counts, '']
  for (const t of inProgress) lines.push(`${ICONS.in_progress} ${escapeTodoLine(t)}`)
  for (const t of pending) lines.push(`${ICONS.pending} ${escapeTodoLine(t)}`)
  if (hiddenCompletedCount > 0) {
    lines.push(`<i>+${hiddenCompletedCount} завершено ранее</i>`)
  }
  for (const t of visibleCompleted) lines.push(`${ICONS.completed} ${escapeTodoLine(t)}`)

  let body = lines.join('\n')
  if (body.length <= maxChars) return body

  // Over budget. Truncation pass: drop trailing pending lines first, then
  // completed. Always keep header + counts + at least the in-progress block.
  const safeBudget = maxChars - TRUNCATE_MARGIN
  // Header block (header + counts + blank line) is mandatory.
  const headerBlock = [header, counts, ''].join('\n')
  const inProgressBlock = inProgress
    .map((t) => `${ICONS.in_progress} ${escapeTodoLine(t)}`)
    .join('\n')
  let used = headerBlock.length + (inProgressBlock.length > 0 ? 1 + inProgressBlock.length : 0)
  const out: string[] = [headerBlock]
  if (inProgressBlock.length > 0) out.push(inProgressBlock)

  // Add pending lines one by one until budget runs out.
  let droppedPending = 0
  const pendingLines = pending.map((t) => `${ICONS.pending} ${escapeTodoLine(t)}`)
  const pendingKept: string[] = []
  for (const line of pendingLines) {
    // +1 for the joining newline.
    if (used + 1 + line.length > safeBudget) {
      droppedPending = pendingLines.length - pendingKept.length
      break
    }
    pendingKept.push(line)
    used += 1 + line.length
  }
  if (pendingKept.length > 0) out.push(pendingKept.join('\n'))
  if (droppedPending > 0) {
    const tail = `<i>+${droppedPending} ещё…</i>`
    out.push(tail)
    used += 1 + tail.length
  }

  // Completed: respect collapse rule first, then truncate visible block.
  let droppedCompleted = hiddenCompletedCount
  if (hiddenCompletedCount > 0) {
    const tail = `<i>+${hiddenCompletedCount} завершено ранее</i>`
    if (used + 1 + tail.length <= safeBudget) {
      out.push(tail)
      used += 1 + tail.length
    }
  }
  const completedLines = visibleCompleted.map(
    (t) => `${ICONS.completed} ${escapeTodoLine(t)}`,
  )
  const completedKept: string[] = []
  for (const line of completedLines) {
    if (used + 1 + line.length > safeBudget) {
      droppedCompleted += completedLines.length - completedKept.length
      break
    }
    completedKept.push(line)
    used += 1 + line.length
  }
  if (completedKept.length > 0) out.push(completedKept.join('\n'))
  if (droppedCompleted > hiddenCompletedCount) {
    const extraDropped = droppedCompleted - hiddenCompletedCount
    const tail = `<i>+${extraDropped} ещё…</i>`
    out.push(tail)
  }

  return out.join('\n')
}

function escapeTodoLine(todo: TodoItem): string {
  // Prefer `activeForm` for in-progress items (Claude convention is
  // gerund — «Reading file» vs «Read file»), otherwise show `content`.
  const raw = todo.status === 'in_progress' && todo.activeForm
    ? todo.activeForm
    : todo.content
  return escapeHtml(raw)
}
