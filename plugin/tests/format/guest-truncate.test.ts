// truncateHtmlBalanced / htmlToPlainText / boundPlain (#861 review, B1).

import { describe, expect, test } from 'bun:test'

import { boundPlain, htmlToPlainText, truncateHtmlBalanced } from '../../src/format/guest-layout.js'
import { validateTelegramHtml } from '../../src/safety/html-validator.js'
import { urlCarriesSecret } from '../../src/safety/redact.js'

describe('truncateHtmlBalanced', () => {
  test('well-formed input that fits is unchanged', () => {
    const html = '<b>жирный</b> &amp; <a href="https://example.com/?a=1&amp;b=2">ссылка</a><br>'
    expect(truncateHtmlBalanced(html, 4096)).toBe(html)
  })

  test('closes every open tag and stays within max', () => {
    const html = '<blockquote expandable><b><i>' + 'я'.repeat(100) + '</i></b></blockquote>'
    const out = truncateHtmlBalanced(html, 50)
    expect(out.length).toBeLessThanOrEqual(50)
    expect(out.endsWith('</i></b></blockquote>')).toBe(true)
    expect(validateTelegramHtml(out).downgraded).toBe(false)
  })

  test('never cuts inside a tag or an entity', () => {
    const html = 'aaaa<a href="https://example.com/long/path">x</a>'
    for (let max = 0; max <= html.length; max++) {
      const out = truncateHtmlBalanced(html, max)
      expect(out.length).toBeLessThanOrEqual(max)
      expect(validateTelegramHtml(out).downgraded).toBe(false)
    }
    const ent = 'ab&amp;cd'
    for (let max = 0; max <= ent.length; max++) {
      const out = truncateHtmlBalanced(ent, max)
      expect(out).not.toMatch(/&[a-z]*$/)
    }
  })

  test('does not split a surrogate pair', () => {
    const out = truncateHtmlBalanced('a😀b', 2)
    expect(out).toBe('a')
  })

  test('drops a half-written trailing tag', () => {
    expect(truncateHtmlBalanced('text <a href="https://exa', 4096)).toBe('text ')
  })
})

describe('htmlToPlainText / boundPlain', () => {
  test('strips tags and decodes entities (no literal &lt;)', () => {
    expect(htmlToPlainText('<b>a</b> &lt;x&gt; &amp; <a href="https://e.com">l</a><br>z')).toBe('a <x> & l\nz')
  })
  test('a lone less-than in text survives', () => {
    expect(htmlToPlainText('если a < b и c > d')).toBe('если a < b и c > d')
  })
  test('boundPlain cuts on a code point boundary', () => {
    expect(boundPlain('a😀', 2)).toBe('a')
    expect(boundPlain('abc', 5)).toBe('abc')
  })
})

describe('urlCarriesSecret', () => {
  test('flags percent-encoded key names and known secrets, passes clean urls', () => {
    expect(urlCarriesSecret('https://example.com/?%74oken=fake-short-secret')).toBe(true)
    expect(urlCarriesSecret(`https://example.com/?v=${encodeURIComponent('Zq9/known+extra=secret')}`, ['Zq9/known+extra=secret'])).toBe(true)
    expect(urlCarriesSecret('https://t.me/somebot?start=ask')).toBe(false)
    expect(urlCarriesSecret('https://example.com/%zz')).toBe(false)
  })
})
