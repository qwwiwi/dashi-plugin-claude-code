// Phase 7 / T1 — schema + ActivityStatusEvent mapping tests.

import { describe, expect, test } from 'bun:test'

import {
  WebhookPayloadSchema,
  ClaudeHookPayloadSchema,
  WebhookMessagePayloadSchema,
  type WebhookPayload,
} from '../../src/schemas.js'
import { toActivityEvent, toTodoWriteEvent } from '../../src/hooks/claude-events.js'

function parse(value: unknown): WebhookPayload {
  return WebhookPayloadSchema.parse(value)
}

describe('WebhookPayloadSchema — message variant unchanged', () => {
  test('accepts {message, chatId}', () => {
    const p = parse({ message: 'hi', chatId: 164795011 })
    expect(p.kind).toBe('message')
    if (p.kind !== 'message') throw new Error('unreachable')
    expect(p.message).toBe('hi')
    expect(p.chatId).toBe('164795011')
    expect(p.agentId).toBeUndefined()
  })

  test('rejects empty message', () => {
    expect(() => parse({ message: '', chatId: 1 })).toThrow()
  })

  test('rejects payload missing both message and hook_event_name', () => {
    expect(() => parse({ chatId: 1 })).toThrow()
  })

  test('legacy direct schema still works', () => {
    const p = WebhookMessagePayloadSchema.parse({ message: 'x', chatId: 1 })
    expect(p.message).toBe('x')
    expect(p.chatId).toBe('1')
  })
})

describe('WebhookPayloadSchema — Claude hook variant', () => {
  const baseCommon = {
    chatId: 164795011,
    session_id: 'abc123',
    transcript_path: '/Users/.../session.jsonl',
    cwd: '/Users/project',
    permission_mode: 'default',
  } as const

  test('PreToolUse round-trips and tags kind=claude_hook', () => {
    const p = parse({
      ...baseCommon,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_01',
      tool_input: { command: 'bun test', description: 'Run tests' },
    })
    expect(p.kind).toBe('claude_hook')
    if (p.kind !== 'claude_hook') throw new Error('unreachable')
    expect(p.hook_event_name).toBe('PreToolUse')
    expect(p.chatId).toBe('164795011')
    if (p.hook_event_name !== 'PreToolUse') throw new Error('unreachable')
    expect(p.tool_name).toBe('Bash')
    expect(p.tool_use_id).toBe('toolu_01')
    expect(p.tool_input.command).toBe('bun test')
  })

  test('PostToolUse with tool_result accepted', () => {
    const p = parse({
      ...baseCommon,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_01',
      tool_input: { command: 'bun test' },
      tool_result: '245 pass',
    })
    expect(p.kind).toBe('claude_hook')
    if (p.kind !== 'claude_hook' || p.hook_event_name !== 'PostToolUse') {
      throw new Error('unreachable')
    }
    expect(p.tool_result).toBe('245 pass')
  })

  test('Stop accepts effort and ignores unknown fields via passthrough', () => {
    const p = parse({
      ...baseCommon,
      hook_event_name: 'Stop',
      effort: { level: 'medium' },
      stop_hook_active: false,
    })
    expect(p.kind).toBe('claude_hook')
    if (p.kind !== 'claude_hook' || p.hook_event_name !== 'Stop') {
      throw new Error('unreachable')
    }
    expect(p.effort).toEqual({ level: 'medium' })
  })

  test('UserPromptSubmit requires prompt but renderer must drop it', () => {
    const p = parse({
      ...baseCommon,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Write a function',
    })
    expect(p.kind).toBe('claude_hook')
    // Verify the activity-event mapping does not leak prompt text.
    if (p.kind !== 'claude_hook') throw new Error('unreachable')
    const event = toActivityEvent(p)
    expect(event.kind).toBe('reasoning')
    expect(JSON.stringify(event)).not.toContain('Write a function')
  })

  test('SessionStart accepts source/model and permission_mode optional', () => {
    const p = parse({
      chatId: 164795011,
      session_id: 'abc',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/tmp',
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'claude-sonnet-4-6',
    })
    expect(p.kind).toBe('claude_hook')
    if (p.kind !== 'claude_hook' || p.hook_event_name !== 'SessionStart') {
      throw new Error('unreachable')
    }
    expect(p.source).toBe('startup')
    expect(p.model).toBe('claude-sonnet-4-6')
  })

  test('SessionEnd parses with optional reason (real session-end hook)', () => {
    const p = parse({
      ...baseCommon,
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    })
    expect(p.kind).toBe('claude_hook')
    if (p.kind !== 'claude_hook' || p.hook_event_name !== 'SessionEnd') {
      throw new Error('unreachable')
    }
    expect(p.reason).toBe('clear')
  })

  test('rejects missing chatId on hook payload', () => {
    expect(() =>
      parse({
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '/t',
        cwd: '/',
        tool_name: 'Bash',
        tool_use_id: 'u',
        tool_input: {},
      }),
    ).toThrow()
  })

  test('rejects unknown hook_event_name', () => {
    expect(() =>
      parse({
        ...baseCommon,
        hook_event_name: 'PreCompact',
        session_id: 's',
      }),
    ).toThrow()
  })

  test('rejects non-object tool_input', () => {
    expect(() =>
      parse({
        ...baseCommon,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: 'u1',
        tool_input: 'not-an-object',
      }),
    ).toThrow()
  })

  test('accepts numeric or string chatId, both transform to string', () => {
    const p1 = ClaudeHookPayloadSchema.parse({
      chatId: '12345',
      session_id: 's',
      transcript_path: '/t',
      cwd: '/',
      hook_event_name: 'Stop',
    })
    expect(p1.chatId).toBe('12345')
    const p2 = ClaudeHookPayloadSchema.parse({
      chatId: 12345,
      session_id: 's',
      transcript_path: '/t',
      cwd: '/',
      hook_event_name: 'Stop',
    })
    expect(p2.chatId).toBe('12345')
  })
})

describe('toActivityEvent mapping', () => {
  test('PreToolUse → tool_start carries name/id/input only', () => {
    const event = toActivityEvent({
      chatId: '1',
      session_id: 's',
      transcript_path: '/t',
      cwd: '/',
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_use_id: 'u1',
      tool_input: { file_path: '/repo/a.ts' },
    })
    expect(event.kind).toBe('tool_start')
    if (event.kind !== 'tool_start') throw new Error('unreachable')
    expect(event.toolName).toBe('Read')
    expect(event.toolUseId).toBe('u1')
    expect(event.toolInput.file_path).toBe('/repo/a.ts')
  })

  test('PostToolUse without tool_result omits the field entirely', () => {
    const event = toActivityEvent({
      chatId: '1',
      session_id: 's',
      transcript_path: '/t',
      cwd: '/',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_use_id: 'u1',
      tool_input: { command: 'ls' },
    })
    expect(event.kind).toBe('tool_end')
    if (event.kind !== 'tool_end') throw new Error('unreachable')
    expect('toolResult' in event).toBe(false)
  })

  test('Stop → session_stop', () => {
    const event = toActivityEvent({
      chatId: '1',
      session_id: 's',
      transcript_path: '/t',
      cwd: '/',
      hook_event_name: 'Stop',
    })
    expect(event.kind).toBe('session_stop')
  })

  test('SessionStart → session_start', () => {
    const event = toActivityEvent({
      chatId: '1',
      session_id: 's',
      transcript_path: '/t',
      cwd: '/',
      hook_event_name: 'SessionStart',
    })
    expect(event.kind).toBe('session_start')
  })

  test('SessionEnd → session_stop (closes the transient bubble)', () => {
    const event = toActivityEvent({
      chatId: '1',
      session_id: 's',
      transcript_path: '/t',
      cwd: '/',
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    })
    expect(event.kind).toBe('session_stop')
  })
})

describe('toTodoWriteEvent mapping', () => {
  const common = {
    chatId: '1',
    session_id: 's',
    transcript_path: '/t',
    cwd: '/',
  } as const

  test('PreToolUse TaskCreate → null (provisional create is NOT mapped; avoids phantom)', () => {
    // The PreToolUse create races the permission gate on the same event; a
    // rejected create would leave a phantom task. Only PostToolUse is mapped.
    const event = toTodoWriteEvent({
      ...common,
      hook_event_name: 'PreToolUse',
      tool_name: 'TaskCreate',
      tool_use_id: 'tu-create-1',
      tool_input: { subject: 'Implement X', description: 'why', activeForm: 'Implementing X' },
    })
    expect(event).toBeNull()
  })

  test('PostToolUse TaskCreate → task_create event with toolResult + sessionId', () => {
    const event = toTodoWriteEvent({
      ...common,
      hook_event_name: 'PostToolUse',
      tool_name: 'TaskCreate',
      tool_use_id: 'tu-create-1',
      tool_input: { subject: 'Implement X' },
      tool_result: 'Task #7 created successfully',
    })
    expect(event?.kind).toBe('task_create')
    if (event?.kind !== 'task_create') throw new Error('unreachable')
    expect(event.toolResult).toBe('Task #7 created successfully')
    expect(event.sessionId).toBe('s')
  })

  test('PostToolUse TaskUpdate → task_update event with coerced string taskId + sessionId', () => {
    const event = toTodoWriteEvent({
      ...common,
      hook_event_name: 'PostToolUse',
      tool_name: 'TaskUpdate',
      tool_use_id: 'tu-update-1',
      // Pass numeric taskId to exercise the union+transform path in the schema.
      tool_input: { taskId: 7, status: 'in_progress' },
    })
    expect(event?.kind).toBe('task_update')
    if (event?.kind !== 'task_update') throw new Error('unreachable')
    expect(event.input.taskId).toBe('7')
    expect(event.input.status).toBe('in_progress')
    expect(event.sessionId).toBe('s')
  })

  test('SessionStart → session_start lifecycle event (carries source + sessionId)', () => {
    const event = toTodoWriteEvent({
      ...common,
      hook_event_name: 'SessionStart',
      source: 'compact',
    })
    expect(event?.kind).toBe('session_start')
    if (event?.kind !== 'session_start') throw new Error('unreachable')
    expect(event.sessionId).toBe('s')
    expect(event.source).toBe('compact')
  })

  test('SessionEnd → session_end lifecycle event', () => {
    const event = toTodoWriteEvent({
      ...common,
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    })
    expect(event?.kind).toBe('session_end')
    if (event?.kind !== 'session_end') throw new Error('unreachable')
    expect(event.sessionId).toBe('s')
    expect(event.reason).toBe('clear')
  })

  test('Stop → null (turn-end, never finalizes the task surface)', () => {
    const event = toTodoWriteEvent({
      ...common,
      hook_event_name: 'Stop',
    })
    expect(event).toBeNull()
  })

  test('PostToolUse TodoWrite → todo_write carries sessionId', () => {
    const event = toTodoWriteEvent({
      ...common,
      hook_event_name: 'PostToolUse',
      tool_name: 'TodoWrite',
      tool_use_id: 'tu-todo',
      tool_input: { todos: [{ content: 'a', status: 'pending' }] },
    })
    expect(event?.kind).toBe('todo_write')
    if (event?.kind !== 'todo_write') throw new Error('unreachable')
    expect(event.sessionId).toBe('s')
  })

  test('PreToolUse TaskUpdate → null (we only mirror PostToolUse for updates)', () => {
    const event = toTodoWriteEvent({
      ...common,
      hook_event_name: 'PreToolUse',
      tool_name: 'TaskUpdate',
      tool_use_id: 'tu-update-1',
      tool_input: { taskId: '7', status: 'in_progress' },
    })
    expect(event).toBeNull()
  })

  test('non-Task tools still return null (Bash, Edit, etc.)', () => {
    const event = toTodoWriteEvent({
      ...common,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'tu-bash-1',
      tool_input: { command: 'ls' },
    })
    expect(event).toBeNull()
  })
})
