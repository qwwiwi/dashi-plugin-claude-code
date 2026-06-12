import { describe, expect, test } from 'bun:test'

import { reminderForChat, renderContext } from '../../scripts/channel-reminder.js'

describe('reminderForChat', () => {
  test('positive (DM) chat id → strict reply-tool reminder', () => {
    const r = reminderForChat('164795011')
    expect(r).toContain('mcp__dashi-channel__reply')
    expect(r).toContain('MUST')
  })

  test('negative (group) chat id → outbox-aware reminder, no forced reply', () => {
    const r = reminderForChat('-1003784643974')
    expect(r).toContain('public/multichat')
    expect(r).toContain('outbox')
    // Must NOT order a manual reply call in groups (the outbox delivers).
    expect(r).not.toContain('MUST go through')
  })

  test('absent chat id → generic DM-safe reminder', () => {
    const r = reminderForChat(undefined)
    expect(r).toContain('Telegram')
    expect(r).toContain('reply tool')
  })

  test('blank/whitespace chat id → generic', () => {
    expect(reminderForChat('   ')).toBe(reminderForChat(undefined))
  })
})

describe('renderContext', () => {
  test('emits the exact UserPromptSubmit additionalContext envelope', () => {
    const out = JSON.parse(renderContext('hello'))
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'hello',
      },
    })
  })

  test('is single-line JSON (safe as sole stdout)', () => {
    expect(renderContext(reminderForChat('164795011')).includes('\n')).toBe(false)
  })
})
