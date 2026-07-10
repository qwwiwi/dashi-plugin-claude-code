// Unit tests for the pure rich-message helpers (no I/O).
//   - richErrorClass: each classification branch
//   - contentFitsRichLimits: boundary at RICH_MESSAGE_MAX_CHARS
//   - buildRichMessagePayload: body shape

import { describe, expect, test } from 'bun:test'
import {
  RICH_MESSAGE_MAX_CHARS,
  buildRichMessagePayload,
  contentFitsRichLimits,
  fenceProtectedLines,
  hardenSoftBreaks,
  richErrorClass,
} from '../../src/format/rich.js'
import { redactSecrets } from '../../src/safety/redact.js'

describe('hardenSoftBreaks', () => {
  test('promotes a lone soft break between two prose lines to a hard break', () => {
    // The reported bug: «M1 — …\nM2 — …» merged into one line by CommonMark.
    const out = hardenSoftBreaks('M1 — сделал X\nM2 — сделал Y')
    expect(out).toBe('M1 — сделал X\\\nM2 — сделал Y')
  })

  test('hardens each break in a 3+ line list-like run', () => {
    const out = hardenSoftBreaks('M1 — a\nM2 — b\nM3 — c')
    expect(out).toBe('M1 — a\\\nM2 — b\\\nM3 — c')
  })

  test('leaves paragraph breaks (\\n\\n) untouched', () => {
    const text = 'Первый абзац.\n\nВторой абзац.'
    expect(hardenSoftBreaks(text)).toBe(text)
  })

  test('bold heading with blank lines around is untouched', () => {
    const text = 'Итог.\n\n**Заголовок**\n\nТело ответа.'
    expect(hardenSoftBreaks(text)).toBe(text)
  })

  test('does not harden markdown list items (they already break)', () => {
    const text = '- пункт один\n- пункт два\n- пункт три'
    expect(hardenSoftBreaks(text)).toBe(text)
  })

  test('does not harden numbered list items', () => {
    const text = '1. первый\n2. второй\n3. третий'
    expect(hardenSoftBreaks(text)).toBe(text)
  })

  test('fenced code block passes through byte-identical', () => {
    const text = 'Смотри код:\n\n```js\nconst a = 1\nconst b = 2\n```\n\nГотово.'
    expect(hardenSoftBreaks(text)).toBe(text)
  })

  test('list-like text INSIDE a fence is not hardened', () => {
    const text = '```\nM1 — a\nM2 — b\n```'
    expect(hardenSoftBreaks(text)).toBe(text)
  })

  // ── CommonMark fence matching (review fix 2026-07-09) ──────────────────

  test('``` inside an open ~~~ fence is content, not a closer — byte-identity', () => {
    // Repro from Codex review: the old any-delimiter toggle treated the ```
    // line as a close and injected backslashes into the shell code below it.
    const text = '~~~\nM1 — a\n```\necho one\necho two\n~~~'
    expect(hardenSoftBreaks(text)).toBe(text)
  })

  test('closing fence shorter than the opener does not close — byte-identity', () => {
    const text = '````\ncode line one\n```\nstill code\n````'
    expect(hardenSoftBreaks(text)).toBe(text)
  })

  test('a would-be closer with trailing text does not close the fence', () => {
    const text = '```\ncode\n``` not a closer\nmore code\n```'
    expect(hardenSoftBreaks(text)).toBe(text)
  })

  test('prose after a properly closed fence is hardened again', () => {
    const out = hardenSoftBreaks('```\ncode\n```\nПервая строка\nВторая строка')
    expect(out).toBe('```\ncode\n```\nПервая строка\\\nВторая строка')
  })

  test('inline code content is preserved; break after it still hardens', () => {
    const out = hardenSoftBreaks('Запусти `npm test` сейчас\nПотом смотри лог')
    expect(out).toBe('Запусти `npm test` сейчас\\\nПотом смотри лог')
    expect(out).toContain('`npm test`')
  })

  test('table block passes through byte-identical', () => {
    const text = '| A | B |\n|---|---|\n| 1 | 2 |'
    expect(hardenSoftBreaks(text)).toBe(text)
  })

  test('CRLF is normalized to LF', () => {
    expect(hardenSoftBreaks('a\r\nb')).toBe('a\\\nb')
  })

  test('is idempotent — a line already ending in a hard break is not doubled', () => {
    const once = hardenSoftBreaks('M1 — a\nM2 — b')
    expect(hardenSoftBreaks(once)).toBe(once)
  })

  test('leaves a line already ending in two spaces alone', () => {
    const text = 'M1 — a  \nM2 — b'
    expect(hardenSoftBreaks(text)).toBe(text)
  })

  test('empty string returns empty', () => {
    expect(hardenSoftBreaks('')).toBe('')
  })

  test('a break into a heading line is not hardened', () => {
    // prose line followed directly by an ATX heading — heading already breaks.
    const text = 'вступление\n# Заголовок'
    expect(hardenSoftBreaks(text)).toBe(text)
  })

  test('Cyrillic multi-line prose run all hardened', () => {
    const out = hardenSoftBreaks('Первое дело\nВторое дело\nТретье дело')
    expect(out).toBe('Первое дело\\\nВторое дело\\\nТретье дело')
  })
})

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

describe('fenceProtectedLines', () => {
  test('marks delimiter and inner lines, matching closer by char and length', () => {
    const lines = ['prose', '~~~', 'code', '```', 'more', '~~~', 'after']
    const mask = fenceProtectedLines(lines)
    // ``` inside the ~~~ fence is content; only the final ~~~ closes.
    expect(mask).toEqual([false, true, true, true, true, true, false])
  })

  test('unclosed fence protects to the end of input', () => {
    expect(fenceProtectedLines(['```', 'a', 'b'])).toEqual([true, true, true])
  })

  test('closer must be at least as long as the opener', () => {
    const mask = fenceProtectedLines(['````', 'x', '```', 'y', '````', 'z'])
    expect(mask).toEqual([true, true, true, true, true, false])
  })
})

describe('hardenSoftBreaks × redaction (pipeline-order regression)', () => {
  // The reply path normalizes BEFORE the safe wrapper redacts. These tests
  // pin the property that makes that order safe: every redaction rule is
  // single-line (character classes never match \n), so hardening — which
  // only appends a backslash at end-of-line — commutes with redaction.

  test('single-line secret in multi-line prose: harden→redact == redact→harden, secret gone', () => {
    const secret = 'gsk_' + 'A'.repeat(44)
    const text = `строка перед\nтокен ${secret} внутри прозы\nстрока после`
    const hardenThenRedact = redactSecrets(hardenSoftBreaks(text))
    const redactThenHarden = hardenSoftBreaks(redactSecrets(text))
    expect(hardenThenRedact).toBe(redactThenHarden)
    expect(hardenThenRedact).not.toContain(secret)
  })

  test('extra-secret on its own prose line survives hardening and still redacts', () => {
    const extra = 'SUPERSECRET-VALUE-123'
    const text = `первая строка\nключ ${extra} тут\nтретья строка`
    const out = redactSecrets(hardenSoftBreaks(text), [extra])
    expect(out).not.toContain(extra)
    // Hard breaks are still present after redaction.
    expect(out).toContain('\\\n')
  })

  test('secret-like token split across two lines: identical (non-)redaction with and without hardening', () => {
    // No single rule can match across \n (all patterns are single-line), so a
    // token fragment per line is treated the same on both orders.
    const text = 'gsk_' + 'A'.repeat(10) + '\n' + 'B'.repeat(10)
    const hardenThenRedact = redactSecrets(hardenSoftBreaks(text))
    const redactThenHarden = hardenSoftBreaks(redactSecrets(text))
    expect(hardenThenRedact).toBe(redactThenHarden)
  })
})
