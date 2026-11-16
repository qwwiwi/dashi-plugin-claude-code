// #1914 — inbound entities → Telegram-subset HTML (pure module).

import { describe, expect, test } from 'bun:test'

import {
  entitiesToHtml,
  hasFormattingEntities,
  withFormattedBlock,
  type InboundEntity,
} from '../../src/telegram/inbound-entities.js'

const e = (type: string, offset: number, length: number, extra: Partial<InboundEntity> = {}): InboundEntity => ({
  type,
  offset,
  length,
  ...extra,
})

describe('entitiesToHtml — each entity type', () => {
  const cases: Array<[string, InboundEntity, string]> = [
    ['bold', e('bold', 0, 3), '<b>abc</b> def'],
    ['italic', e('italic', 0, 3), '<i>abc</i> def'],
    ['underline', e('underline', 0, 3), '<u>abc</u> def'],
    ['strikethrough', e('strikethrough', 0, 3), '<s>abc</s> def'],
    ['spoiler', e('spoiler', 0, 3), '<tg-spoiler>abc</tg-spoiler> def'],
    ['code', e('code', 0, 3), '<code>abc</code> def'],
    ['pre without language', e('pre', 0, 3), '<pre>abc</pre> def'],
    ['pre with language', e('pre', 0, 3, { language: 'python' }), '<pre><code class="language-python">abc</code></pre> def'],
    ['text_link', e('text_link', 0, 3, { url: 'https://x.io/a?b=1&c=2' }), '<a href="https://x.io/a?b=1&amp;c=2">abc</a> def'],
    ['text_mention', e('text_mention', 0, 3, { user: { id: 42 } }), '<a href="tg://user?id=42">abc</a> def'],
    ['blockquote', e('blockquote', 0, 7), '<blockquote>abc def</blockquote>'],
    ['expandable_blockquote', e('expandable_blockquote', 0, 7), '<blockquote expandable>abc def</blockquote>'],
  ]
  for (const [name, ent, expected] of cases) {
    test(name, () => {
      expect(entitiesToHtml('abc def', [ent])).toBe(expected)
    })
  }

  test('custom_emoji → tg-emoji with emoji-id over a surrogate pair', () => {
    const text = 'hi 😀!'
    // '😀' is 2 UTF-16 units at offset 3
    expect(entitiesToHtml(text, [e('custom_emoji', 3, 2, { custom_emoji_id: '5368324170671202286' })])).toBe(
      'hi <tg-emoji emoji-id="5368324170671202286">😀</tg-emoji>!',
    )
  })

  test('custom_emoji with a non-numeric id is ignored (no injected attribute)', () => {
    expect(entitiesToHtml('x😀', [e('custom_emoji', 1, 2, { custom_emoji_id: '1" onclick="x' })])).toBe('x😀')
  })

  test('text_link without url is ignored', () => {
    expect(entitiesToHtml('abc', [e('text_link', 0, 3)])).toBe('abc')
  })
})

describe('entitiesToHtml — non-formatting entities stay text', () => {
  test('mention / hashtag / url / email / bot_command → text returned unchanged', () => {
    const text = '@yulia #post https://a.b/<x> a@b.c /start'
    const ents = [
      e('mention', 0, 6),
      e('hashtag', 7, 5),
      e('url', 13, 15),
      e('email', 29, 5),
      e('bot_command', 35, 6),
    ]
    expect(hasFormattingEntities(text, ents)).toBe(false)
    expect(entitiesToHtml(text, ents)).toBe(text)
  })

  test('mixed: mention inside bold keeps bold, mention text plain', () => {
    expect(entitiesToHtml('hi @yulia', [e('bold', 0, 9), e('mention', 3, 6)])).toBe('<b>hi @yulia</b>')
  })
})

describe('entitiesToHtml — backward compatibility', () => {
  test('undefined entities → text as is, no escaping', () => {
    expect(entitiesToHtml('a < b & c', undefined)).toBe('a < b & c')
  })
  test('empty entities → text as is, no escaping', () => {
    expect(entitiesToHtml('a < b & c', [])).toBe('a < b & c')
  })
  test('empty text → empty', () => {
    expect(entitiesToHtml('', [e('bold', 0, 1)])).toBe('')
  })
  test('zero-length / negative / out-of-range entities are ignored', () => {
    expect(entitiesToHtml('abc', [e('bold', 1, 0), e('italic', -5, 2), e('underline', 10, 3)])).toBe('abc')
  })
  test('entity running past the end is clamped', () => {
    expect(entitiesToHtml('abc', [e('bold', 1, 50)])).toBe('a<b>bc</b>')
  })
})

describe('entitiesToHtml — escaping', () => {
  test('<, > and & are escaped in text once any formatting is present; quotes stay', () => {
    expect(entitiesToHtml('a<b>&"c\'', [e('bold', 0, 1)])).toBe('<b>a</b>&lt;b&gt;&amp;"c\'')
  })
  test('href with quotes / angle brackets cannot break out of the attribute', () => {
    const url = 'https://x.io/"><script>alert(1)</script>\''
    expect(entitiesToHtml('go', [e('text_link', 0, 2, { url })])).toBe(
      '<a href="https://x.io/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&#39;">go</a>',
    )
  })
  test('pre language is escaped', () => {
    expect(entitiesToHtml('x', [e('pre', 0, 1, { language: 'a"><b' })])).toBe(
      '<pre><code class="language-a&quot;&gt;&lt;b">x</code></pre>',
    )
  })
  test('text inside code is escaped', () => {
    expect(entitiesToHtml('if a<b && c', [e('code', 0, 11)])).toBe('<code>if a&lt;b &amp;&amp; c</code>')
  })
  test('a literal </formatted> in user text is escaped (block boundary cannot be forged)', () => {
    const out = withFormattedBlock('x </formatted> y', 'x </formatted> y', [e('bold', 0, 1)])
    expect(out.match(/<\/formatted>/g)?.length).toBe(2) // one in plain text, one real closer
    expect(out).toContain('<b>x</b> &lt;/formatted&gt; y')
  })
})

describe('entitiesToHtml — UTF-16 offsets, emoji, surrogate pairs', () => {
  test('bold after emoji uses UTF-16 offsets', () => {
    // '🔥' = 2 units; 'Жирный' starts at 3
    const text = '🔥 Жирный текст'
    expect(entitiesToHtml(text, [e('bold', 3, 6)])).toBe('🔥 <b>Жирный</b> текст')
  })
  test('entity covering exactly an emoji', () => {
    expect(entitiesToHtml('a👍b', [e('spoiler', 1, 2)])).toBe('a<tg-spoiler>👍</tg-spoiler>b')
  })
  test('ZWJ family emoji (8 units) inside italic', () => {
    const fam = '👨‍👩‍👧' // 8 units: 3 surrogate pairs + 2 ZWJ
    const text = `x${fam}y`
    expect(fam.length).toBe(8)
    expect(entitiesToHtml(text, [e('italic', 1, fam.length)])).toBe(`x<i>${fam}</i>y`)
  })
  test('several emoji then entities', () => {
    const text = '😀😀 bold 😀 ital'
    // bold at 5..9, ital at 13..17
    expect(entitiesToHtml(text, [e('bold', 5, 4), e('italic', 13, 4)])).toBe('😀😀 <b>bold</b> 😀 <i>ital</i>')
  })
})

describe('entitiesToHtml — nesting and overlap', () => {
  test('nested bold > italic', () => {
    expect(entitiesToHtml('abcdef', [e('bold', 0, 6), e('italic', 2, 2)])).toBe('<b>ab<i>cd</i>ef</b>')
  })
  test('same range: Telegram order kept (first = outer)', () => {
    expect(entitiesToHtml('abc', [e('bold', 0, 3), e('italic', 0, 3)])).toBe('<b><i>abc</i></b>')
  })
  test('outer listed after inner still renders outer first', () => {
    expect(entitiesToHtml('abcdef', [e('italic', 2, 2), e('bold', 0, 6)])).toBe('<b>ab<i>cd</i>ef</b>')
  })
  test('partial overlap closes and re-opens to stay well-formed', () => {
    // bold 0..4, italic 2..6
    expect(entitiesToHtml('abcdef', [e('bold', 0, 4), e('italic', 2, 4)])).toBe('<b>ab<i>cd</i></b><i>ef</i>')
  })
  test('blockquote with bold, link and spoiler inside', () => {
    const text = 'Пост: читать тут, секрет'
    const out = entitiesToHtml(text, [
      e('blockquote', 0, text.length),
      e('bold', 0, 4),
      e('text_link', 6, 10, { url: 'https://t.me/x' }),
      e('spoiler', 18, 6),
    ])
    expect(out).toBe(
      '<blockquote><b>Пост</b>: <a href="https://t.me/x">читать тут</a>, <tg-spoiler>секрет</tg-spoiler></blockquote>',
    )
  })
  test('formatting inside code/pre is dropped (Telegram does not render it)', () => {
    expect(entitiesToHtml('abc', [e('pre', 0, 3), e('bold', 1, 1)])).toBe('<pre>abc</pre>')
  })
  test('bold wrapping code is kept', () => {
    expect(entitiesToHtml('x code y', [e('bold', 0, 8), e('code', 2, 4)])).toBe('<b>x <code>code</code> y</b>')
  })
  test('custom emoji inside a link', () => {
    expect(
      entitiesToHtml('go 😀', [e('text_link', 0, 5, { url: 'https://a.b' }), e('custom_emoji', 3, 2, { custom_emoji_id: '1' })]),
    ).toBe('<a href="https://a.b">go <tg-emoji emoji-id="1">😀</tg-emoji></a>')
  })
})

describe('withFormattedBlock', () => {
  test('no formatting → plain unchanged', () => {
    expect(withFormattedBlock('hi @x', 'hi @x', [e('mention', 3, 2)])).toBe('hi @x')
    expect(withFormattedBlock('a<b', 'a<b', undefined)).toBe('a<b')
  })
  test('formatting → plain first, then the html block', () => {
    expect(withFormattedBlock('Привет мир', 'Привет мир', [e('bold', 0, 6)])).toBe(
      'Привет мир\n<formatted format="html">\n<b>Привет</b> мир\n</formatted>',
    )
  })
  test('trimmed plain + raw source keeps offsets right', () => {
    expect(withFormattedBlock('ab', '  ab  ', [e('italic', 2, 2)])).toBe(
      'ab\n<formatted format="html">\n<i>ab</i>\n</formatted>',
    )
  })
})
