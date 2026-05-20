// Tests for the pre-send Telegram HTML validator.
//
// The validator inspects user-/agent-authored HTML before we hand it to
// telegramApi.sendMessage(parse_mode='HTML'). If the markup is invalid
// (unsupported tag, mismatched tag, unsafe href, unclosed tag), it
// downgrades by stripping all tags and escaping the body — better a
// plain reply than a 400 Bad Request from Telegram that drops the answer.

import { describe, expect, test } from 'bun:test'
import { validateTelegramHtml } from '../../src/safety/html-validator.js'

describe('validateTelegramHtml — valid passes', () => {
  test('passes plain text untouched', () => {
    const r = validateTelegramHtml('hello world')
    expect(r.downgraded).toBe(false)
    expect(r.html).toBe('hello world')
  })

  test('passes empty string', () => {
    const r = validateTelegramHtml('')
    expect(r.downgraded).toBe(false)
    expect(r.html).toBe('')
  })

  test('passes simple <b>bold</b>', () => {
    const r = validateTelegramHtml('<b>bold</b>')
    expect(r.downgraded).toBe(false)
    expect(r.html).toBe('<b>bold</b>')
  })

  test('passes nested <pre><code>…</code></pre>', () => {
    const r = validateTelegramHtml('<pre><code>x</code></pre>')
    expect(r.downgraded).toBe(false)
  })

  test('passes <a href="https://…">link</a>', () => {
    const r = validateTelegramHtml('<a href="https://example.com">link</a>')
    expect(r.downgraded).toBe(false)
  })

  test('passes <a href="tg://user?id=1">tg link</a>', () => {
    const r = validateTelegramHtml('<a href="tg://user?id=1">tg link</a>')
    expect(r.downgraded).toBe(false)
  })

  test('passes self-closing <br/>', () => {
    const r = validateTelegramHtml('one<br/>two')
    expect(r.downgraded).toBe(false)
  })

  test('passes bare <br>', () => {
    const r = validateTelegramHtml('one<br>two')
    expect(r.downgraded).toBe(false)
  })

  test('passes <blockquote>q</blockquote>', () => {
    const r = validateTelegramHtml('<blockquote>quote</blockquote>')
    expect(r.downgraded).toBe(false)
  })
})

describe('validateTelegramHtml — invalid downgrades', () => {
  test('unsupported <script> tag → downgrade + escape', () => {
    const r = validateTelegramHtml('<script>alert(1)</script>')
    expect(r.downgraded).toBe(true)
    expect(r.html).not.toContain('<script>')
    // Body must be HTML-escaped so the literal `<script>` lands as &lt;script&gt;.
    expect(r.html).toContain('&lt;script&gt;')
  })

  test('unsupported <div> downgrades', () => {
    const r = validateTelegramHtml('<div>x</div>')
    expect(r.downgraded).toBe(true)
  })

  test('mismatched tags downgrade', () => {
    const r = validateTelegramHtml('<b>oops</i>')
    expect(r.downgraded).toBe(true)
  })

  test('unclosed tag downgrades', () => {
    const r = validateTelegramHtml('<b>oops')
    expect(r.downgraded).toBe(true)
  })

  test('unsafe href (javascript:) downgrades', () => {
    const r = validateTelegramHtml('<a href="javascript:alert(1)">x</a>')
    expect(r.downgraded).toBe(true)
  })

  test('unsafe href (data:) downgrades', () => {
    const r = validateTelegramHtml('<a href="data:text/html,foo">x</a>')
    expect(r.downgraded).toBe(true)
  })

  test('<a> without href downgrades', () => {
    const r = validateTelegramHtml('<a>x</a>')
    expect(r.downgraded).toBe(true)
  })

  test('downgraded body escapes raw < and > and &', () => {
    const r = validateTelegramHtml('<script>1 < 2 & 3 > 0</script>')
    expect(r.downgraded).toBe(true)
    // No tag survives, ampersand/lt/gt all escaped.
    expect(r.html).not.toMatch(/<[a-zA-Z]/)
    expect(r.html).toContain('&amp;')
    expect(r.html).toContain('&lt;')
    expect(r.html).toContain('&gt;')
  })

  test('never throws on malformed input', () => {
    // Pathological inputs we want to survive without throwing.
    const cases = [
      '<',
      '>',
      '<<<>>>',
      '<a',
      '<a href',
      '<a href="',
      '<a href="x',
      '<<b>>><</b>',
      'unmatched <b><b><b><b><b><b>',
    ]
    for (const c of cases) {
      expect(() => validateTelegramHtml(c)).not.toThrow()
    }
  })

  test('reason is populated when downgraded', () => {
    const r = validateTelegramHtml('<div>x</div>')
    expect(r.downgraded).toBe(true)
    expect(r.reason).toBeDefined()
    expect(typeof r.reason).toBe('string')
    expect(r.reason!.length).toBeGreaterThan(0)
  })
})
