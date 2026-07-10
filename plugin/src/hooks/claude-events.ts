// Mapping from validated Claude hook payloads to the ActivityStatusEvent
// shape consumed by StatusManager. Keeping this module pure (no I/O) lets
// the webhook server stay thin: parse → guard → map → forward.
//
// We never reach into `tool_result`, `prompt`, or freeform Claude metadata
// from here — those are intentionally dropped before any string reaches
// Telegram or our logs.

import type { ClaudeHookPayload } from '../schemas.js'
import {
  TodoWriteInputSchema,
  TaskCreateInputSchema,
  TaskUpdateInputSchema,
  type TodoItem,
  type TaskCreateInput,
  type TaskUpdateInput,
} from '../schemas.js'
import type { Logger } from '../log.js'

// Tool-call lifecycle pair used by the rolling activity window. PreToolUse
// emits `tool_start`; PostToolUse emits `tool_end`. The renderer collapses
// matching pairs into a single rendered line and uses `tool_use_id` to
// resolve Agent done-summary updates.
//
// Multichat: every variant carries an optional `chatId` so StatusManager
// can route status updates to the correct Telegram chat. The id is sourced
// from the hook payload (`ClaudeHookCommonShape.chatId`) by `toActivityEvent`
// when present; for the legacy single-chat wiring it stays `undefined` and
// StatusManager falls back to its single-chat behaviour.
export interface ToolStartEvent {
  readonly kind: 'tool_start'
  readonly toolName: string
  readonly toolInput: Record<string, unknown>
  readonly toolUseId: string
  readonly chatId?: string
}

export interface ToolEndEvent {
  readonly kind: 'tool_end'
  readonly toolName: string
  readonly toolInput: Record<string, unknown>
  readonly toolUseId: string
  // Optional masked done-summary; renderer truncates to 30 chars (see
  // gateway.py:1855: dispatch "summary" cap) before display. We carry the
  // raw value so the renderer is the single mask point.
  readonly toolResult?: unknown
  readonly chatId?: string
}

// Phase events flip the status to `reasoning…` without recording a tool
// call. SessionStart also opens a status if none is active; Stop closes it.
export interface ReasoningEvent {
  readonly kind: 'reasoning'
  readonly chatId?: string
}

export interface SessionStartEvent {
  readonly kind: 'session_start'
  readonly chatId?: string
}

export interface SessionStopEvent {
  readonly kind: 'session_stop'
  readonly chatId?: string
}

export type ActivityStatusEvent =
  | ToolStartEvent
  | ToolEndEvent
  | ReasoningEvent
  | SessionStartEvent
  | SessionStopEvent

// ─────────────────────────────────────────────────────────────────────
// TodoWrite events — consumed by TaskMirror (separate rolling Telegram
// message showing Claude's milestone list). Deliberately NOT folded into
// ActivityStatusEvent: StatusManager / ProgressReporter must stay unaware
// of TodoWrite so the three rolling messages (status bubble, activity
// thread, todo list) keep independent lifecycles.
// ─────────────────────────────────────────────────────────────────────

// Every TaskMirror event carries the `sessionId` it belongs to. Harness task
// numbering restarts at #1 on every new session, so the mirror MUST namespace
// its snapshot by session — a task event whose sessionId differs from the
// current snapshot's is a new session and resets the surface. Sourced from the
// hook payload's `session_id` (always present per ClaudeHookCommonShape).
export interface TodoWriteEvent {
  readonly kind: 'todo_write'
  readonly sessionId: string
  readonly todos: ReadonlyArray<TodoItem>
  readonly chatId?: string
}

// TaskCreate / TaskUpdate hooks emitted by the newer Claude Code harness.
// Unlike TodoWrite (which carries the full list per call), these are
// incremental — TaskMirror accumulates them in an internal Map<taskId, TodoItem>
// and renders the synthesised snapshot. PreToolUse of TaskCreate fires before
// the harness assigns a real numeric id, so we pass `toolUseId` as the
// provisional handle and reconcile with the real id in the PostToolUse pass
// (Phase 2 — for now the provisional id stays).
export interface TaskCreateEvent {
  readonly kind: 'task_create'
  readonly sessionId: string
  readonly toolUseId: string
  readonly input: TaskCreateInput
  // Populated on PostToolUse when the harness has materialised the task.
  // Format: usually `Task #<n> created` — TaskMirror runs the same regex
  // extract as the warchief's terminal renderer. We map ONLY the PostToolUse
  // pass (see toTodoWriteEvent): a provisional PreToolUse create would race the
  // permission gate on the same event and, if rejected, leave a phantom task.
  readonly toolResult?: unknown
  readonly chatId?: string
}

export interface TaskUpdateEvent {
  readonly kind: 'task_update'
  readonly sessionId: string
  readonly toolUseId: string
  readonly input: TaskUpdateInput
  readonly chatId?: string
}

// Session lifecycle signals for the task surfaces. SessionStart resets the
// snapshot when the session id changes (a genuine new session) and preserves
// it otherwise (compact / resume keep the same id). SessionEnd — a REAL Claude
// Code hook, unlike Stop which is turn-end — finalizes the surface. Stop no
// longer maps to any TaskMirrorEvent: it must NOT finalize tasks.
export interface TaskSessionStartEvent {
  readonly kind: 'session_start'
  readonly sessionId: string
  // SessionStart fires for startup / resume / clear / compact. The mirror uses
  // `sessionId` (not source) as the reset key; source rides along for the HUD.
  readonly source?: 'startup' | 'resume' | 'clear' | 'compact'
  readonly chatId?: string
}

export interface TaskSessionEndEvent {
  readonly kind: 'session_end'
  readonly sessionId: string
  readonly reason?: string
  readonly chatId?: string
}

export type TaskMirrorEvent =
  | TodoWriteEvent
  | TaskCreateEvent
  | TaskUpdateEvent
  | TaskSessionStartEvent
  | TaskSessionEndEvent

// The subset of TaskMirrorEvent that mutates the task snapshot (as opposed to
// the session lifecycle signals). The context HUD's `onTodoEvent` consumes
// ONLY these; lifecycle events reach the HUD through its dedicated
// onSessionStart / onSessionEnd entry points instead.
export type TaskMutationEvent = TodoWriteEvent | TaskCreateEvent | TaskUpdateEvent

export function isTaskMutationEvent(event: TaskMirrorEvent): event is TaskMutationEvent {
  return (
    event.kind === 'todo_write' ||
    event.kind === 'task_create' ||
    event.kind === 'task_update'
  )
}

/**
 * Convert a validated Claude hook payload to an ActivityStatusEvent.
 *
 * `UserPromptSubmit` carries the user prompt text — we deliberately drop it
 * here so the prompt never reaches StatusManager (and through it Telegram).
 * The phase change to `reasoning` is the only signal that survives.
 *
 * Multichat: `payload.chatId` (required by `ClaudeHookCommonShape`) is
 * propagated to every emitted event so StatusManager can route updates to
 * the correct chat. The plugin's webhook handler also surfaces
 * `process.env.CHAT_ID` upstream when a hook fires inside a tmux session
 * that the master process spawned — but propagation from the payload is
 * the source of truth here. `exactOptionalPropertyTypes` requires the
 * property to be absent rather than `undefined`; the helper below
 * conditionally spreads it.
 */
export function toActivityEvent(payload: ClaudeHookPayload): ActivityStatusEvent {
  const chatIdProp =
    payload.chatId !== undefined && payload.chatId !== ''
      ? { chatId: payload.chatId }
      : {}
  switch (payload.hook_event_name) {
    case 'PreToolUse':
      return {
        kind: 'tool_start',
        toolName: payload.tool_name,
        toolInput: payload.tool_input,
        toolUseId: payload.tool_use_id,
        ...chatIdProp,
      }
    case 'PostToolUse': {
      const event: ToolEndEvent = {
        kind: 'tool_end',
        toolName: payload.tool_name,
        toolInput: payload.tool_input,
        toolUseId: payload.tool_use_id,
        ...chatIdProp,
      }
      // exactOptionalPropertyTypes: only attach `toolResult` if defined,
      // otherwise the property must be absent — `undefined` is not allowed.
      return payload.tool_result !== undefined
        ? { ...event, toolResult: payload.tool_result }
        : event
    }
    case 'Stop':
      return { kind: 'session_stop', ...chatIdProp }
    case 'SessionEnd':
      // Real session end also closes the transient status bubble.
      return { kind: 'session_stop', ...chatIdProp }
    case 'UserPromptSubmit':
      return { kind: 'reasoning', ...chatIdProp }
    case 'SessionStart':
      return { kind: 'session_start', ...chatIdProp }
  }
}

/**
 * Convert a validated Claude hook payload to a TaskMirrorEvent.
 *
 * Returns non-null ONLY for events the task surfaces care about:
 *   - SessionStart → `session_start` lifecycle event (carries source). The
 *     mirror resets its snapshot when the session id changes and preserves it
 *     on compact / resume of the same id.
 *   - SessionEnd → `session_end` lifecycle event. This is the REAL session end
 *     — the mirror finalizes here, never on Stop.
 *   - PostToolUse TodoWrite → `todo_write` (full-list snapshot).
 *   - PostToolUse TaskCreate → `task_create` with `toolResult`. We map ONLY
 *     the PostToolUse pass: a provisional PreToolUse create runs concurrently
 *     with the permission gate on the same event, so a rejected create would
 *     leave a phantom task in the mirror.
 *   - PostToolUse TaskUpdate → `task_update`.
 *
 * Stop returns null on purpose (it is turn-end, not session-end). Every other
 * hook event returns null so the caller can short-circuit.
 */
export function toTodoWriteEvent(
  payload: ClaudeHookPayload,
  log?: Logger,
): TaskMirrorEvent | null {
  // Same chatId propagation rule as toActivityEvent — the master
  // session's dispatcher passes the event to the right per-chat
  // TaskMirror instance.
  const chatIdProp =
    payload.chatId !== undefined && payload.chatId !== ''
      ? { chatId: payload.chatId }
      : {}
  // session_id is required on every hook payload (ClaudeHookCommonShape); the
  // mirror namespaces its snapshot by it so a new session starts a clean list.
  const sessionId = payload.session_id

  if (payload.hook_event_name === 'SessionStart') {
    const event: TaskSessionStartEvent = {
      kind: 'session_start',
      sessionId,
      ...(payload.source !== undefined ? { source: payload.source } : {}),
      ...chatIdProp,
    }
    return event
  }

  if (payload.hook_event_name === 'SessionEnd') {
    const event: TaskSessionEndEvent = {
      kind: 'session_end',
      sessionId,
      ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
      ...chatIdProp,
    }
    return event
  }

  if (payload.hook_event_name === 'PostToolUse' && payload.tool_name === 'TodoWrite') {
    const parsed = TodoWriteInputSchema.safeParse(payload.tool_input)
    if (!parsed.success) {
      log?.warn('TodoWrite tool_input failed schema validation (ignored)', {
        issues: parsed.error.issues.map((i) => i.message).slice(0, 5),
      })
      return null
    }
    return { kind: 'todo_write', sessionId, todos: parsed.data.todos, ...chatIdProp }
  }

  // TaskCreate -- PostToolUse ONLY. The harness has assigned the real id by
  // then (carried in `tool_result`) and the create has cleared the permission
  // gate, so we never record a task that a rejected PreToolUse would orphan.
  if (payload.hook_event_name === 'PostToolUse' && payload.tool_name === 'TaskCreate') {
    const parsed = TaskCreateInputSchema.safeParse(payload.tool_input)
    if (!parsed.success) {
      log?.warn('TaskCreate tool_input failed schema validation (ignored)', {
        issues: parsed.error.issues.map((i) => i.message).slice(0, 5),
      })
      return null
    }
    const event: TaskCreateEvent = {
      kind: 'task_create',
      sessionId,
      toolUseId: payload.tool_use_id,
      input: parsed.data,
      ...chatIdProp,
    }
    return payload.tool_result !== undefined
      ? { ...event, toolResult: payload.tool_result }
      : event
  }

  // TaskUpdate -- mutations carry the real taskId in tool_input. We fire on
  // PostToolUse only: PreToolUse status is what the call WANTS to set, the
  // harness can still reject, so we wait for the post-call confirmation.
  if (payload.hook_event_name === 'PostToolUse' && payload.tool_name === 'TaskUpdate') {
    const parsed = TaskUpdateInputSchema.safeParse(payload.tool_input)
    if (!parsed.success) {
      log?.warn('TaskUpdate tool_input failed schema validation (ignored)', {
        issues: parsed.error.issues.map((i) => i.message).slice(0, 5),
      })
      return null
    }
    return {
      kind: 'task_update',
      sessionId,
      toolUseId: payload.tool_use_id,
      input: parsed.data,
      ...chatIdProp,
    }
  }

  return null
}
