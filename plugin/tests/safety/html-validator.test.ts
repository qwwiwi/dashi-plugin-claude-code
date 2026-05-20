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
    expect(r.text).toBe('hello world')
  })

  test('passes empty string', () => {
    const r = validateTelegramHtml('')
    expect(r.downgraded).toBe(false)
    expect(r.text).toBe('')
  })

  test('passes simple <b>bold</b>', () => {
    const r = validateTelegramHtml('<b>bold</b>')
    expect(r.downgraded).toBe(false)
    expect(r.text).toBe('<b>bold</b>')
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
    expect(r.text).not.toContain('<script>')
    // Body must be HTML-escaped so the literal `<script>` lands as &lt;script&gt;.
    expect(r.text).toContain('&lt;script&gt;')
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
    expect(r.text).not.toMatch(/<[a-zA-Z]/)
    expect(r.text).toContain('&amp;')
    expect(r.text).toContain('&lt;')
    expect(r.text).toContain('&gt;')
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

describe('validateTelegramHtml — per-tag attribute allowlist', () => {
  test('<a target="_blank" href="…"> downgrades with attribute-name reason', () => {
    const r = validateTelegramHtml('<a target="_blank" href="https://x.com">x</a>')
    expect(r.downgraded).toBe(true)
    expect(r.reason).toBe('disallowed attribute "target" on <a>')
  })

  test('<b class="x">y</b> downgrades because <b> takes no attributes', () => {
    const r = validateTelegramHtml('<b class="x">y</b>')
    expect(r.downgraded).toBe(true)
    expect(r.reason).toContain('disallowed attribute')
    expect(r.reason).toContain('"class"')
    expect(r.reason).toContain('<b>')
  })

  test('<a href="https://x.com">x</a> passes (only href allowed)', () => {
    const r = validateTelegramHtml('<a href="https://x.com">x</a>')
    expect(r.downgraded).toBe(false)
  })

  test('<a href="…" onclick="alert(1)">x</a> downgrades (onclick disallowed)', () => {
    const r = validateTelegramHtml('<a href="https://x.com" onclick="alert(1)">x</a>')
    expect(r.downgraded).toBe(true)
    expect(r.reason).toContain('"onclick"')
  })

  test('<code class="language-ts">x</code> passes (class allowed on code)', () => {
    const r = validateTelegramHtml('<code class="language-ts">x</code>')
    expect(r.downgraded).toBe(false)
  })

  test('<pre class="x">y</pre> downgrades (pre takes no attrs)', () => {
    const r = validateTelegramHtml('<pre class="x">y</pre>')
    expect(r.downgraded).toBe(true)
    expect(r.reason).toContain('disallowed attribute')
  })

  test('quoted > inside attribute value does not terminate the tag prematurely', () => {
    // <b> has no allowed attributes, so this must downgrade. Critically, the
    // parser must NOT escape via the literal `>` inside the quoted value —
    // i.e. it must classify the tag correctly (a single <b ...> tag with a
    // disallowed attr) rather than blow up into "unbalanced angle brackets"
    // or pass through unsanitised markup.
    const r = validateTelegramHtml('<b attr="</b>">x</b>')
    expect(r.downgraded).toBe(true)
    // No HTML escape leak — must escape literal '<' in downgraded body.
    expect(r.text).not.toMatch(/<b[^a-z]/i)
  })

  test('reasons NEVER include attribute VALUES, hrefs, or input fragments', () => {
    // Attribute name OK in reason, value NEVER.
    const cases: string[] = [
      '<a target="_blank" href="https://x.com">x</a>',
      '<a href="https://x.com" onclick="alert(1)">x</a>',
      '<b class="leaked-value-12345">y</b>',
      '<a href="javascript:dangerous_payload_should_not_log()">x</a>',
      '<script>secret_payload_xyz</script>',
      '<a>no-href</a>',
      '<b>unclosed',
      '<b>oops</i>',
    ]
    for (const c of cases) {
      const r = validateTelegramHtml(c)
      expect(r.downgraded).toBe(true)
      const reason = r.reason ?? ''
      // Attribute *values* must not appear.
      expect(reason).not.toContain('_blank')
      expect(reason).not.toContain('alert(1)')
      expect(reason).not.toContain('leaked-value-12345')
      expect(reason).not.toContain('dangerous_payload')
      expect(reason).not.toContain('secret_payload_xyz')
      expect(reason).not.toContain('javascript:')
      // No URL fragments — we never log hrefs.
      expect(reason).not.toMatch(/https?:\/\//)
    }
  })
})

describe('validateTelegramHtml — clean reason strings (M4)', () => {
  test('unsupported tag reason uses <tag> classification, no colon prefix', () => {
    const r = validateTelegramHtml('<div>x</div>')
    expect(r.downgraded).toBe(true)
    expect(r.reason).toBe('unsupported tag <div>')
  })

  test('mismatched closing tag reason has clean form', () => {
    const r = validateTelegramHtml('<b>x</i>')
    expect(r.downgraded).toBe(true)
    expect(r.reason).toBe('mismatched closing tag </i>')
  })

  test('unclosed tag reason has clean form', () => {
    const r = validateTelegramHtml('<b>x')
    expect(r.downgraded).toBe(true)
    expect(r.reason).toBe('unclosed tag <b>')
  })

  test('unsafe href reason is classification-only — no URL fragment', () => {
    const r = validateTelegramHtml('<a href="javascript:alert(1)">x</a>')
    expect(r.downgraded).toBe(true)
    expect(r.reason).toBe('unsafe href protocol on <a>')
    // Critically: the reason must NOT have a colon-separated payload.
    expect(r.reason).not.toContain('javascript')
    expect(r.reason).not.toContain('alert')
  })

  test('void tag closing form reason is clean', () => {
    const r = validateTelegramHtml('text</br>')
    expect(r.downgraded).toBe(true)
    expect(r.reason).toBe('void tag </br> has closing form')
    // Critically: no `: name` payload-leak shape.
    expect(r.reason).not.toMatch(/: \w+$/)
  })
})
