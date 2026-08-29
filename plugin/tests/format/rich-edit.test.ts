// Wave 2: rich in-place EDIT — payload shape + the "not modified" contract.
// Ported from Hermes `_try_edit_rich` (v0.20.6). The two behaviours pinned
// here are the ones a naive reimplementation gets wrong:
//   1. the edit body carries NO topic routing (Telegram rejects it, and the
//      caller silently degrades to the table-flattening legacy path);
//   2. "message is not modified" is a SUCCESS, not a failure.

import { describe, expect, test } from 'bun:test'
import { buildRichEditPayload, isNotModifiedError } from '../../src/format/rich.js'

describe('buildRichEditPayload', () => {
  test('body is chat_id + message_id + rich_message.markdown, nothing else', () => {
    const body = buildRichEditPayload('| a | b |\n| --- | --- |', {
      chat_id: '164795011',
      message_id: 42,
    })
    expect(body).toEqual({
      chat_id: '164795011',
      message_id: 42,
      rich_message: { markdown: '| a | b |\n| --- | --- |' },
    })
  })

  test('carries no topic routing keys', () => {
    const body = buildRichEditPayload('x', { chat_id: '1', message_id: 2 })
    expect(Object.keys(body).sort()).toEqual(['chat_id', 'message_id', 'rich_message'])
  })

  test('markdown is passed through verbatim (redaction happens upstream)', () => {
    const md = '# Заголовок\n\n$$E=mc^2$$'
    expect(buildRichEditPayload(md, { chat_id: '1', message_id: 2 }).rich_message.markdown).toBe(md)
  })
})

describe('isNotModifiedError', () => {
  test('recognises the Bot API description', () => {
    expect(
      isNotModifiedError({
        error_code: 400,
        description: 'Bad Request: message is not modified',
      }),
    ).toBe(true)
  })

  test('recognises it on a plain Error', () => {
    expect(isNotModifiedError(new Error('400: message is not modified: ...'))).toBe(true)
  })

  test('recognises it from a bare string', () => {
    expect(isNotModifiedError('Message is not modified')).toBe(true)
  })

  test('is case-insensitive', () => {
    expect(isNotModifiedError({ description: 'MESSAGE IS NOT MODIFIED' })).toBe(true)
  })

  test('does NOT swallow an unrelated 400', () => {
    expect(
      isNotModifiedError({ error_code: 400, description: "Bad Request: can't parse entities" }),
    ).toBe(false)
  })

  test('does NOT swallow a capability error', () => {
    expect(
      isNotModifiedError({ error_code: 404, description: 'Not Found: method not found' }),
    ).toBe(false)
  })

  test('handles null and undefined', () => {
    expect(isNotModifiedError(null)).toBe(false)
    expect(isNotModifiedError(undefined)).toBe(false)
  })
})
