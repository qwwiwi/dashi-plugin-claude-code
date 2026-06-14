import { describe, expect, test } from 'bun:test'

import {
  isForwardableCallback,
  buildCallbackInboundMessage,
} from '../../src/telegram/callback-forward.js'

describe('isForwardableCallback', () => {
  test('false for ask: and perm: (already handled)', () => {
    expect(isForwardableCallback('ask:opt:abcde:0:1')).toBe(false)
    expect(isForwardableCallback('perm:allow:abcde')).toBe(false)
  })
  test('false for empty data', () => {
    expect(isForwardableCallback('')).toBe(false)
  })
  test('true for a medicine reminder callback', () => {
    expect(isForwardableCallback('taken::course::55ba6618')).toBe(true)
    expect(isForwardableCallback('snooze::course::55ba6618')).toBe(true)
  })
})

describe('buildCallbackInboundMessage', () => {
  test('wraps callback data as a synthetic inbound message', () => {
    const msg = buildCallbackInboundMessage({
      data: 'taken::course::55ba6618',
      chatId: '1134075676',
      userId: '1134075676',
      user: 'viktor',
      timestamp: '2026-06-14T05:00:00.000Z',
      messageId: '4242',
    })
    expect(msg).toEqual({
      text: '[inline-button] taken::course::55ba6618',
      chat_id: '1134075676',
      user_id: '1134075676',
      user: 'viktor',
      timestamp: '2026-06-14T05:00:00.000Z',
      message_id: '4242',
    })
  })
  test('omits message_id when absent', () => {
    const msg = buildCallbackInboundMessage({
      data: 'skipped::course::x',
      chatId: '1', userId: '1', user: 'u', timestamp: 't',
    })
    expect('message_id' in msg).toBe(false)
  })
})
