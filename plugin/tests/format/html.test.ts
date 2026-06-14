import { describe, expect, test } from 'bun:test'

import {
  escapeHtml,
  escapeHtmlAttr,
  isTelegramHtmlParseError,
  markdownToTelegramHtml,
} from '../../src/format/html.js'
import { validateTelegramHtml } from '../../src/safety/html-validator.js'

describe('escapeHtml / escapeHtmlAttr', () => {
  test('escapes ampersand angle brackets in plain text', () => {
    const out = escapeHtml('a & b < c > d "quote"')
    expect(out).toBe('a &amp; b &lt; c &gt; d &quot;quote&quot;')
  })

  test('escapeHtmlAttr also escapes single quote', () => {
    expect(escapeHtmlAttr(`it's "fine" & <safe>`)).toBe(
      'it&#39;s &quot;fine&quot; &amp; &lt;safe&gt;',
    )
  })

  test('escapes ampersand before angle brackets to avoid double-escape', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })
})

describe('markdownToTelegramHtml', () => {
  test('preserves allowed Telegram HTML tags while escaping unsafe tags', () => {
    const md = 'hello <b>bold</b> and <script>alert(1)</script> bye'
    const html = markdownToTelegramHtml(md)
    // <b> survives verbatim
    expect(html).toContain('<b>bold</b>')
    // <script> is escaped — Telegram would reject it otherwise
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;/script&gt;')
    expect(html).not.toMatch(/<script>/)
  })

  test('converts fenced code blocks to pre code without formatting inside', () => {
    const md = '```python\nx = **not bold**\nprint("hi")\n```'
    const html = markdownToTelegramHtml(md)
    // Wrapped in <pre><code class="language-python">…</code></pre>
    expect(html).toContain('<pre><code class="language-python">')
    expect(html).toContain('</code></pre>')
    // The ** must NOT have become <b> inside the code block
    expect(html).toContain('**not bold**')
    expect(html).not.toContain('<b>not bold</b>')
    // Quotes inside python source are escaped
    expect(html).toContain('print(&quot;hi&quot;)')
  })

  test('fenced code block without language tag still wraps in pre code', () => {
    const md = '```\njust code & <stuff>\n```'
    const html = markdownToTelegramHtml(md)
    expect(html).toContain('<pre><code>')
    expect(html).toContain('just code &amp; &lt;stuff&gt;')
    expect(html).toContain('</code></pre>')
  })

  test('converts markdown tables to aligned pre blocks', () => {
    const md = [
      '| Name | Score |',
      '|------|-------|',
      '| alice | 100 |',
      '| bob | 7 |',
      '',
    ].join('\n')
    const html = markdownToTelegramHtml(md)
    expect(html).toContain('<pre>')
    expect(html).toContain('</pre>')
    // Separator row is dropped
    expect(html).not.toMatch(/-{3,}/)
    // Cells aligned: 'alice' (5 chars) padded same as 'Name ' (5 chars total width = max('Name','alice','bob') = 5)
    expect(html).toContain('Name')
    expect(html).toContain('alice')
    expect(html).toContain('bob')
    expect(html).toContain('100')
  })

  test('does not italicize snake_case identifiers', () => {
    const md = 'see config_file_path.py and foo_bar_baz for details'
    const html = markdownToTelegramHtml(md)
    expect(html).not.toContain('<i>')
    expect(html).toContain('config_file_path.py')
    expect(html).toContain('foo_bar_baz')
  })

  test('does italicize real *italic* and _italic_ markdown', () => {
    const html1 = markdownToTelegramHtml('this is *very* important')
    expect(html1).toContain('<i>very</i>')

    const html2 = markdownToTelegramHtml('this is _emphasized_ text')
    expect(html2).toContain('<i>emphasized</i>')
  })

  test('escapes link href attributes', () => {
    const md = '[click](https://example.com/?a=1&b=2)'
    const html = markdownToTelegramHtml(md)
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"')
    expect(html).toContain('>click</a>')
  })

  test('converts ** to <b>', () => {
    expect(markdownToTelegramHtml('this is **bold** here')).toContain('<b>bold</b>')
  })

  test('converts headings to <b>', () => {
    expect(markdownToTelegramHtml('# Title\nbody')).toContain('<b>Title</b>')
    expect(markdownToTelegramHtml('### Sub\nbody')).toContain('<b>Sub</b>')
  })

  test('handles empty string', () => {
    expect(markdownToTelegramHtml('')).toBe('')
  })

  // Balance-aware safe-tag stashing (2026-06-05): a lone safe tag in prose
  // must be escaped, not preserved — preserved-verbatim it reaches Telegram
  // as an unclosed tag and trips the validator's whole-message plain-text
  // downgrade, mangling every other tag into literal &lt;b&gt; text.
  describe('unbalanced safe tags', () => {
    test('lone <pre> in prose is escaped while markdown bold still converts', () => {
      const md = '**Жирный заголовок** и вопрос: ты видишь ДВА окна (два сообщения с <pre>) в личке?'
      const html = markdownToTelegramHtml(md)
      expect(html).toContain('<b>Жирный заголовок</b>')
      expect(html).toContain('&lt;pre&gt;')
      expect(html).not.toContain('(два сообщения с <pre>)')
      // The whole point: the rendered body must survive pre-send validation.
      expect(validateTelegramHtml(html).downgraded).toBe(false)
    })

    test('balanced agent-written pair still survives verbatim', () => {
      const html = markdownToTelegramHtml('see <pre>raw block</pre> and <b>bold</b>')
      expect(html).toContain('<pre>raw block</pre>')
      expect(html).toContain('<b>bold</b>')
      expect(validateTelegramHtml(html).downgraded).toBe(false)
    })

    test('mismatched closing tag is escaped, surrounding pair kept', () => {
      const html = markdownToTelegramHtml('<i>a</b>b</i> tail')
      expect(html).toContain('<i>a&lt;/b&gt;b</i>')
      expect(validateTelegramHtml(html).downgraded).toBe(false)
    })

    test('improperly nested tags are all escaped rather than shipped broken', () => {
      const html = markdownToTelegramHtml('<b>a<pre>b</b> c')
      expect(html).toContain('&lt;b&gt;a&lt;pre&gt;b&lt;/b&gt; c')
      expect(html).not.toContain('<b>')
      expect(validateTelegramHtml(html).downgraded).toBe(false)
    })

    test('void <br> is kept without a closing pair, </br> is escaped', () => {
      const html = markdownToTelegramHtml('line<br>break</br>')
      expect(html).toContain('line<br>break')
      expect(html).toContain('&lt;/br&gt;')
      expect(validateTelegramHtml(html).downgraded).toBe(false)
    })

    test('nested same-name pairs survive', () => {
      const html = markdownToTelegramHtml('<b>out <b>in</b> out</b>')
      expect(html).toContain('<b>out <b>in</b> out</b>')
      expect(validateTelegramHtml(html).downgraded).toBe(false)
    })
  })
})

describe('isTelegramHtmlParseError', () => {
  test('classifies Telegram parse entity errors for plain fallback', () => {
    const err1 = new Error("Bad Request: can't parse entities: Unexpected end tag at byte offset 42")
    expect(isTelegramHtmlParseError(err1)).toBe(true)

    // grammY-style nested description
    const err2 = { description: "can't parse entities: bad" }
    expect(isTelegramHtmlParseError(err2)).toBe(true)

    // Nested response.body
    const err3 = { response: { body: { description: 'unsupported start tag' } } }
    expect(isTelegramHtmlParseError(err3)).toBe(true)

    // Unrelated errors do NOT match
    expect(isTelegramHtmlParseError(new Error('chat not found'))).toBe(false)
    expect(isTelegramHtmlParseError({ description: 'rate limited' })).toBe(false)
    expect(isTelegramHtmlParseError(null)).toBe(false)
    expect(isTelegramHtmlParseError(undefined)).toBe(false)
    expect(isTelegramHtmlParseError(42)).toBe(false)
  })
})

describe('markdownToTelegramHtml — entity double-escape (2026-06-13)', () => {
  test('preserves already-valid HTML entities instead of double-escaping', () => {
    expect(markdownToTelegramHtml('4 &lt; 5 и a &gt; b')).toBe('4 &lt; 5 и a &gt; b')
    expect(markdownToTelegramHtml('Tom &amp; Jerry')).toBe('Tom &amp; Jerry')
    expect(markdownToTelegramHtml('&#39;quote&#39;')).toBe('&#39;quote&#39;')
  })

  test('still escapes a bare ampersand and bare angle brackets', () => {
    expect(markdownToTelegramHtml('R&D and AT&T')).toBe('R&amp;D and AT&amp;T')
    expect(markdownToTelegramHtml('a < b и c > d')).toBe('a &lt; b и c &gt; d')
  })
})
