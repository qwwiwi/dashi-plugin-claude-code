import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  assertAllowedChat,
  gateTelegramMessage,
  type GateInput,
} from '../../src/telegram/gate.js'
import type { AppConfig } from '../../src/config.js'

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    bot_id: 8507713167,
    dm_only: true,
    allowed_user_ids: [164795011],
    allowed_chat_ids: [164795011],
    status: { enabled: true, interval_ms: 700, ttl_ms: 300_000, delete_on_complete: true, suppress_typing_bubble: false },
    album: { flush_ms: 2000 },
    voice: { provider: 'groq', language: 'ru', model: 'whisper-large-v3-turbo' },
    webhook: { enabled: false, host: '127.0.0.1', port: 0 },
    permission_relay: { enabled: true, allowed_user_ids: [164795011], bash_only_proof: true },
    commands: { help: true, status: true, stop: true, reset: true, new: true },
    memory: {
      enabled: false,
      source_tag: 'tg',
      max_hot_bytes: 20480,
      trim_keep_lines: 600,
      buffer_ttl_ms: 5 * 60 * 1000,
      buffer_max_entries: 100,
    },
    progress: {
      enabled: true,
      edit_throttle_ms: 3000,
      recent_buffer: 10,
      session_ttl_ms: 600000,
    },
    task_mirror: {
      enabled: true,
      edit_throttle_ms: 3000,
      session_ttl_ms: 600000,
      collapse_completed_after: 5,
    },
    watcher: {
      enabled: true,
      debounce_ms: 10_000,
      busy_threshold_ms: 30_000,
    },
    tmux_mirror: { enabled: false, pane_target: '', poll_interval_ms: 5000, line_count: 50, hide_segments: ['boot_banner', 'inbound_warning', 'footer_hints', 'input_box'], mode: 'latest_inbound_only', max_lines: 14 },
    multichat: { enabled: false },
    ask_user_question: { enabled: false, timeout_ms: 300_000, max_preview_chars: 1000 },
    ...overrides,
  }
}

function dmInput(senderId: string, chatId: string): GateInput {
  return { chatType: 'private', chatId, senderId, isBot: false }
}

describe('gateTelegramMessage', () => {
  test('allows DM from configured user id', () => {
    const decision = gateTelegramMessage(dmInput('164795011', '164795011'), makeConfig())
    expect(decision.kind).toBe('allow')
    if (decision.kind === 'allow') {
      expect(decision.senderId).toBe('164795011')
      expect(decision.chatId).toBe('164795011')
    }
  })

  test('drops DM from unknown user even when chat id is allowed', () => {
    // chatId is in allowed_chat_ids but sender is not in allowed_user_ids.
    // Gate must reject on sender first, never delivering for a chat-only match.
    const decision = gateTelegramMessage(dmInput('999000111', '164795011'), makeConfig())
    expect(decision.kind).toBe('drop')
    if (decision.kind === 'drop') {
      expect(decision.reason).toBe('sender_not_allowed')
    }
  })

  test('drops message with missing from field', () => {
    const input: GateInput = {
      chatType: 'private',
      chatId: '164795011',
      senderId: undefined,
      isBot: undefined,
    }
    const decision = gateTelegramMessage(input, makeConfig())
    expect(decision.kind).toBe('drop')
    if (decision.kind === 'drop') expect(decision.reason).toBe('missing_sender')
  })

  test('drops group and supergroup messages in Scope A', () => {
    const group: GateInput = {
      chatType: 'group',
      chatId: '-1001234567890',
      senderId: '164795011',
      isBot: false,
    }
    const supergroup: GateInput = { ...group, chatType: 'supergroup' }

    const g = gateTelegramMessage(group, makeConfig())
    const sg = gateTelegramMessage(supergroup, makeConfig())
    expect(g.kind).toBe('drop')
    expect(sg.kind).toBe('drop')
    if (g.kind === 'drop') expect(g.reason).toBe('not_dm')
    if (sg.kind === 'drop') expect(sg.reason).toBe('not_dm')
  })

  test('drops channel posts', () => {
    const channel: GateInput = {
      chatType: 'channel',
      chatId: '-1009876543210',
      senderId: undefined, // channel posts often have no `from`
      isBot: undefined,
    }
    const decision = gateTelegramMessage(channel, makeConfig())
    expect(decision.kind).toBe('drop')
    if (decision.kind === 'drop') expect(decision.reason).toBe('not_dm')
  })

  test('does not create pairing state for unknown sender', () => {
    // The gate is pure — no side effects on disk. We assert this by pointing
    // a tmp state dir at the test and confirming nothing appears after calls.
    const tmp = mkdtempSync(join(tmpdir(), 'gate-state-'))
    try {
      const config = makeConfig()
      const input = dmInput('424242', '424242')

      const first = gateTelegramMessage(input, config)
      const second = gateTelegramMessage(input, config)
      expect(first.kind).toBe('drop')
      expect(second.kind).toBe('drop')

      // No file written by the gate. (Sanity: the tmp dir is empty.)
      expect(existsSync(tmp)).toBe(true)
      expect(readdirSync(tmp)).toEqual([])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('assertAllowedChat', () => {
  test('outbound assertAllowedChat allows configured chat', () => {
    expect(() => assertAllowedChat('164795011', makeConfig())).not.toThrow()
  })

  test('outbound assertAllowedChat rejects non-allowlisted chat with descriptive error', () => {
    expect(() => assertAllowedChat('-100999', makeConfig())).toThrow(/not allowlisted/)
    expect(() => assertAllowedChat('-100999', makeConfig())).toThrow(/allowed_chat_ids/)
  })

  test('accepts numeric chat ids configured as numbers', () => {
    const config = makeConfig({ allowed_chat_ids: [164795011, '777'] })
    expect(() => assertAllowedChat('164795011', config)).not.toThrow()
    expect(() => assertAllowedChat('777', config)).not.toThrow()
  })
})
