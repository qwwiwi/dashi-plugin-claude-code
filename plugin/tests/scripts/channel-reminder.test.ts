import { describe, expect, test } from 'bun:test'

import {
  EMBEDDED_TOV_REMINDER,
  composeReminder,
  reminderForChat,
  renderContext,
  tovReminder,
} from '../../scripts/channel-reminder.js'

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

// Integration: run the hook as a real process and assert the executable
// contract (Codex/Fable review): exit 0, stdout = valid envelope only,
// stderr empty, private stdin never echoed, CHAT_ID never leaked.
import { spawnSync } from 'child_process'
import { join } from 'path'

const HOOK = join(import.meta.dir, '..', '..', 'scripts', 'channel-reminder.ts')

function runHook(chatId: string | undefined, stdin: string) {
  const env = { ...process.env }
  if (chatId === undefined) delete env.CHAT_ID
  else env.CHAT_ID = chatId
  return spawnSync('bun', [HOOK], { input: stdin, encoding: 'utf8', env })
}

describe('channel-reminder.ts — process contract', () => {
  test('DM: exit 0, stdout is the envelope only, stderr empty, no stdin/CHAT_ID leak', () => {
    const secret = 'PRIVATE-PROMPT-BODY-do-not-echo'
    const r = runHook('164795011', secret)
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    const parsed = JSON.parse(r.stdout)
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    expect(parsed.hookSpecificOutput.additionalContext).toContain('mcp__dashi-channel__reply')
    expect(r.stdout).not.toContain(secret)
    expect(r.stdout).not.toContain('164795011')
  })

  test('group CHAT_ID → outbox-aware envelope, exit 0', () => {
    const r = runHook('-1003784643974', 'hi')
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.hookSpecificOutput.additionalContext).toContain('outbox')
  })

  test('absent CHAT_ID → exit 0, generic envelope', () => {
    const r = runHook(undefined, 'hi')
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('Telegram')
  })
})

describe('tovReminder', () => {
  test('default (no env) returns the docs/TOV-reminder.md baseline', () => {
    const r = tovReminder({})
    expect(r).toBeDefined()
    expect(r).toContain('по-русски')
    expect(r).toContain('**Заголовок**')
    // Default path reads the committed file, which mirrors the embedded const.
    expect(r).toBe(EMBEDDED_TOV_REMINDER)
  })

  test('TOV_REMINDER_ENABLED=off disables the block', () => {
    expect(tovReminder({ TOV_REMINDER_ENABLED: 'off' })).toBeUndefined()
    expect(tovReminder({ TOV_REMINDER_ENABLED: '0' })).toBeUndefined()
    expect(tovReminder({ TOV_REMINDER_ENABLED: 'false' })).toBeUndefined()
  })

  test('unreadable TOV_REMINDER_PATH falls back to the embedded baseline', () => {
    const r = tovReminder({ TOV_REMINDER_PATH: '/no/such/file/xyz.md' })
    expect(r).toBe(EMBEDDED_TOV_REMINDER)
  })

  test('embedded baseline is a real 5-line block with no emoji', () => {
    expect(EMBEDDED_TOV_REMINDER.split('\n').length).toBe(5)
    // No emoji (basic surrogate-pair check).
    expect(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(EMBEDDED_TOV_REMINDER)).toBe(false)
  })
})

describe('composeReminder', () => {
  test('DM: channel discipline first, then TOV block', () => {
    const r = composeReminder({ CHAT_ID: '164795011' })
    expect(r).toContain('mcp__dashi-channel__reply')
    expect(r).toContain('по-русски')
    // Channel reminder precedes the TOV block.
    expect(r.indexOf('mcp__dashi-channel__reply')).toBeLessThan(r.indexOf('по-русски'))
  })

  test('TOV disabled → only the channel reminder', () => {
    const r = composeReminder({ CHAT_ID: '164795011', TOV_REMINDER_ENABLED: 'no' })
    expect(r).toBe(reminderForChat('164795011'))
  })

  test('added TOV context stays within ~10 lines', () => {
    const r = composeReminder({ CHAT_ID: '164795011' })
    const channelLines = reminderForChat('164795011').split('\n').length
    const added = r.split('\n').length - channelLines
    expect(added).toBeLessThanOrEqual(10)
  })
})
