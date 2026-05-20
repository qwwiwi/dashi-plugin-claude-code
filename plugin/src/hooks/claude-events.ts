// Mapping from validated Claude hook payloads to the ActivityStatusEvent
// shape consumed by StatusManager. Keeping this module pure (no I/O) lets
// the webhook server stay thin: parse → guard → map → forward.
//
// We never reach into `tool_result`, `prompt`, or freeform Claude metadata
// from here — those are intentionally dropped before any string reaches
// Telegram or our logs.

import type { ClaudeHookPayload } from '../schemas.js'
import { TodoWriteInputSchema, type TodoItem } from '../schemas.js'
import type { Logger } from '../log.js'

// Tool-call lifecycle pair used by the rolling activity window. PreToolUse
// emits `tool_start`; PostToolUse emits `tool_end`. The renderer collapses
// matching pairs into a single rendered line and uses `tool_use_id` to
// resolve Agent done-summary updates.
export interface ToolStartEvent {
  readonly kind: 'tool_start'
  readonly toolName: string
  readonly toolInput: Record<string, unknown>
  readonly toolUseId: string
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
}

// Phase events flip the status to `reasoning…` without recording a tool
// call. SessionStart also opens a status if none is active; Stop closes it.
export interface ReasoningEvent {
  readonly kind: 'reasoning'
}

export interface SessionStartEvent {
  readonly kind: 'session_start'
}

export interface SessionStopEvent {
  readonly kind: 'session_stop'
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

export interface TodoWriteEvent {
  readonly kind: 'todo_write'
  readonly todos: ReadonlyArray<TodoItem>
}

// Session-stop signal for TaskMirror specifically. Renamed from the
// ActivityStatusEvent variant so the TaskMirror dispatcher does not
// accidentally consume a non-todo Stop hook.
export interface TodoSessionStopEvent {
  readonly kind: 'todo_session_stop'
}

export type TaskMirrorEvent = TodoWriteEvent | TodoSessionStopEvent

/**
 * Convert a validated Claude hook payload to an ActivityStatusEvent.
 *
 * `UserPromptSubmit` carries the user prompt text — we deliberately drop it
 * here so the prompt never reaches StatusManager (and through it Telegram).
 * The phase change to `reasoning` is the only signal that survives.
 */
export function toActivityEvent(payload: ClaudeHookPayload): ActivityStatusEvent {
  switch (payload.hook_event_name) {
    case 'PreToolUse':
      return {
        kind: 'tool_start',
        toolName: payload.tool_name,
        toolInput: payload.tool_input,
        toolUseId: payload.tool_use_id,
      }
    case 'PostToolUse': {
      const event: ToolEndEvent = {
        kind: 'tool_end',
        toolName: payload.tool_name,
        toolInput: payload.tool_input,
        toolUseId: payload.tool_use_id,
      }
      // exactOptionalPropertyTypes: only attach `toolResult` if defined,
      // otherwise the property must be absent — `undefined` is not allowed.
      return payload.tool_result !== undefined
        ? { ...event, toolResult: payload.tool_result }
        : event
    }
    case 'Stop':
      return { kind: 'session_stop' }
    case 'UserPromptSubmit':
      return { kind: 'reasoning' }
    case 'SessionStart':
      return { kind: 'session_start' }
  }
}

/**
 * Convert a validated Claude hook payload to a TaskMirrorEvent.
 *
 * Returns non-null ONLY for events TaskMirror cares about:
 *   - PostToolUse with tool_name === 'TodoWrite' → parses tool_input via
 *     TodoWriteInputSchema. On parse failure, logs a warning and returns
 *     null (graceful degradation — the rolling activity thread still
 *     renders correctly because toActivityEvent handles the same payload
 *     independently).
 *   - Stop → returns `{ kind: 'todo_session_stop' }` so TaskMirror can
 *     finalize and evict its per-chat entry.
 *
 * Every other hook event returns null so the caller can short-circuit
 * before touching TaskMirror.
 */
export function toTodoWriteEvent(
  payload: ClaudeHookPayload,
  log?: Logger,
): TaskMirrorEvent | null {
  if (payload.hook_event_name === 'Stop') {
    return { kind: 'todo_session_stop' }
  }
  if (payload.hook_event_name === 'PostToolUse' && payload.tool_name === 'TodoWrite') {
    const parsed = TodoWriteInputSchema.safeParse(payload.tool_input)
    if (!parsed.success) {
      log?.warn('TodoWrite tool_input failed schema validation (ignored)', {
        issues: parsed.error.issues.map((i) => i.message).slice(0, 5),
      })
      return null
    }
    return { kind: 'todo_write', todos: parsed.data.todos }
  }
  return null
}
