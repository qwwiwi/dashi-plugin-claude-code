// Unit tests for the pure rich-message helpers (no I/O).
//   - richErrorClass: each classification branch
//   - contentFitsRichLimits: boundary at RICH_MESSAGE_MAX_CHARS
//   - buildRichMessagePayload: body shape

import { describe, expect, test } from 'bun:test'
import {
  RICH_MESSAGE_MAX_CHARS,
  buildRichMessagePayload,
  contentFitsRichLimits,
  richErrorClass,
} from '../../src/format/rich.js'

describe('RICH_MESSAGE_MAX_CHARS', () => {
  test('is the Bot API 10.1 rich-message cap (32768)', () => {
    expect(RICH_MESSAGE_MAX_CHARS).toBe(32768)
  })
})

describe('richErrorClass', () => {
  test('HTTP 404 → capability', () => {
    expect(richErrorClass({ error_code: 404, description: 'Not Found' })).toBe('capability')
  })

  test('"method not found" message → capability', () => {
    expect(richErrorClass(new Error('Bad Request: method not found'))).toBe('capability')
  })

  test('"unsupported" message → capability', () => {
    expect(richErrorClass({ description: 'method is unsupported by this build' })).toBe('capability')
  })

  test('"not implemented" message → capability', () => {
    expect(richErrorClass(new Error('sendRichMessage is not implemented'))).toBe('capability')
  })

  test('400 BadRequest (non-size) → parser', () => {
    expect(
      richErrorClass({ error_code: 400, description: "Bad Request: can't parse entities" }),
    ).toBe('parser')
  })

  test('400 "message is too long" → oversize', () => {
    expect(
      richErrorClass({ error_code: 400, description: 'Bad Request: message is too long' }),
    ).toBe('oversize')
  })

  test('400 "entities too long" → oversize', () => {
    expect(
      richErrorClass({ error_code: 400, description: 'Bad Request: entities too long' }),
    ).toBe('oversize')
  })

  test('500 server error → transient', () => {
    expect(richErrorClass({ error_code: 500, description: 'Internal Server Error' })).toBe('transient')
  })

  test('429 rate limit → transient (rate-limit wrapper owns retries)', () => {
    expect(richErrorClass({ error_code: 429, parameters: { retry_after: 5 } })).toBe('transient')
  })

  test('network-ish error with no code → transient', () => {
    expect(richErrorClass(new Error('fetch failed: ECONNRESET'))).toBe('transient')
  })

  test('null / non-object → transient', () => {
    expect(richErrorClass(null)).toBe('transient')
    expect(richErrorClass(undefined)).toBe('transient')
    expect(richErrorClass(42)).toBe('transient')
  })

  test('reads `status` (fetch-Response shape) for 404 → capability', () => {
    expect(richErrorClass({ status: 404 })).toBe('capability')
  })
})

describe('contentFitsRichLimits', () => {
  test('empty string fits', () => {
    expect(contentFitsRichLimits('')).toBe(true)
  })

  test('exactly RICH_MESSAGE_MAX_CHARS bytes fits (boundary)', () => {
    const atLimit = 'a'.repeat(RICH_MESSAGE_MAX_CHARS)
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(RICH_MESSAGE_MAX_CHARS)
    expect(contentFitsRichLimits(atLimit)).toBe(true)
  })

  test('one byte over the limit does NOT fit', () => {
    const overLimit = 'a'.repeat(RICH_MESSAGE_MAX_CHARS + 1)
    expect(contentFitsRichLimits(overLimit)).toBe(false)
  })

  test('measures UTF-8 bytes, not code units (Cyrillic counts double)', () => {
    // Each Cyrillic char is 2 bytes in UTF-8. Half-the-cap+1 chars ⇒ over.
    const halfPlusOne = 'я'.repeat(RICH_MESSAGE_MAX_CHARS / 2 + 1)
    // .length (UTF-16 code units) is under the char cap …
    expect(halfPlusOne.length).toBeLessThan(RICH_MESSAGE_MAX_CHARS)
    // … but the byte length is over, so it must NOT fit.
    expect(contentFitsRichLimits(halfPlusOne)).toBe(false)
  })

  test('Cyrillic payload exactly at the byte limit fits', () => {
    const exactly = 'я'.repeat(RICH_MESSAGE_MAX_CHARS / 2)
    expect(Buffer.byteLength(exactly, 'utf8')).toBe(RICH_MESSAGE_MAX_CHARS)
    expect(contentFitsRichLimits(exactly)).toBe(true)
  })
})

describe('buildRichMessagePayload', () => {
  test('builds chat_id + markdown body without threading', () => {
    const body = buildRichMessagePayload('# Title\n\n| a | b |', { chat_id: '164795011' })
    expect(body).toEqual({
      chat_id: '164795011',
      rich_message: { markdown: '# Title\n\n| a | b |' },
    })
    // No reply_parameters when reply_to_message_id is omitted.
    expect(body.reply_parameters).toBeUndefined()
  })

  test('adds reply_parameters when reply_to_message_id is set', () => {
    const body = buildRichMessagePayload('hello', {
      chat_id: '164795011',
      reply_to_message_id: 777,
    })
    expect(body).toEqual({
      chat_id: '164795011',
      rich_message: { markdown: 'hello' },
      reply_parameters: { message_id: 777 },
    })
  })

  test('does not mutate / pre-process the markdown (redaction happens upstream)', () => {
    const raw = 'secret token sk-abcdefghijklmnopqrstuvwxyz123456'
    const body = buildRichMessagePayload(raw, { chat_id: '1' })
    // Pure builder: passes the body through verbatim. Redaction is the safe
    // wrapper's job, BEFORE this builder is reached.
    expect(body.rich_message.markdown).toBe(raw)
  })
})
