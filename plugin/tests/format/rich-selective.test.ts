// Unit tests for selective rich delivery + the two client-crash shields.
// Ported alongside the helpers from Hermes v0.20.6 (NousResearch/hermes-agent,
// plugins/platforms/telegram/adapter.py). Each test names the behaviour the
// upstream implementation guards, so a future edit that "simplifies" one of
// these regexes fails loudly instead of silently re-enabling a crash shape.

import { describe, expect, test } from 'bun:test'
import {
  needsRichRendering,
  hasDetailsMathCrashShape,
  hasCjkGarbleShape,
  richDeliveryAllowed,
} from '../../src/format/rich.js'

describe('needsRichRendering — the auto-enable rule', () => {
  test('ordinary prose does NOT ask for rich', () => {
    expect(needsRichRendering('Просто ответ, без таблиц и формул.')).toBe(false)
  })

  test('bold, links, inline code and fenced code stay on the HTML path', () => {
    const body = [
      '**жирный** и *курсив*, ссылка [сюда](https://example.com)',
      'инлайн `код` тоже',
      '```bash',
      'echo hello',
      '```',
    ].join('\n')
    expect(needsRichRendering(body)).toBe(false)
  })

  test('a GFM pipe table asks for rich', () => {
    const body = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    expect(needsRichRendering(body)).toBe(true)
  })

  test('an aligned table separator asks for rich', () => {
    expect(needsRichRendering('| x | y |\n|:---:|---:|\n| 1 | 2 |')).toBe(true)
  })

  test('a GFM task list asks for rich', () => {
    expect(needsRichRendering('- [ ] не сделано\n- [x] сделано')).toBe(true)
  })

  test('a collapsible block asks for rich', () => {
    expect(needsRichRendering('<details>\n<summary>что внутри</summary>\nтекст\n</details>')).toBe(true)
  })

  test('block math asks for rich', () => {
    expect(needsRichRendering('формула:\n$$E = mc^2$$')).toBe(true)
  })

  test('empty text asks for nothing', () => {
    expect(needsRichRendering('')).toBe(false)
  })

  test('a lone pipe character is not a table', () => {
    expect(needsRichRendering('запусти a | b в консоли')).toBe(false)
  })

  test('a horizontal rule is not a table separator', () => {
    expect(needsRichRendering('текст\n\n---\n\nещё текст')).toBe(false)
  })
})

describe('hasDetailsMathCrashShape — Telegram Desktop 6.9.1 crash shield', () => {
  test('math inside a collapsible block trips the shield', () => {
    const body = '<details><summary>вывод</summary>\n$$a^2 + b^2 = c^2$$\n</details>'
    expect(hasDetailsMathCrashShape(body)).toBe(true)
  })

  test('a LaTeX command inside a collapsible block trips the shield', () => {
    const body = '<details>\n\\frac{1}{2}\n</details>'
    expect(hasDetailsMathCrashShape(body)).toBe(true)
  })

  test('bracket math inside a collapsible block trips the shield', () => {
    expect(hasDetailsMathCrashShape('<details>\\[x=1\\]</details>')).toBe(true)
  })

  test('math OUTSIDE a collapsible block does not trip it', () => {
    expect(hasDetailsMathCrashShape('$$E = mc^2$$\n<details>обычный текст</details>')).toBe(false)
  })

  test('a collapsible block without math does not trip it', () => {
    expect(hasDetailsMathCrashShape('<details><summary>тут</summary>просто текст</details>')).toBe(false)
  })

  test('empty text does not trip it', () => {
    expect(hasDetailsMathCrashShape('')).toBe(false)
  })

  test('the scan is per-block: clean block first, math block second', () => {
    const body = '<details>чисто</details>\n<details>$$x$$</details>'
    expect(hasDetailsMathCrashShape(body)).toBe(true)
  })
})

describe('hasCjkGarbleShape — Mac/Desktop glyph-artifact shield', () => {
  test('Japanese trips the shield', () => {
    expect(hasCjkGarbleShape('こんにちは')).toBe(true)
  })

  test('Chinese trips the shield', () => {
    expect(hasCjkGarbleShape('你好世界')).toBe(true)
  })

  test('Korean trips the shield', () => {
    expect(hasCjkGarbleShape('안녕하세요')).toBe(true)
  })

  test('astral CJK extensions trip the shield', () => {
    expect(hasCjkGarbleShape('\u{20000}')).toBe(true)
  })

  test('Russian and Latin do NOT trip it', () => {
    expect(hasCjkGarbleShape('Обычный ответ, plain English too.')).toBe(false)
  })

  test('emoji do NOT trip it', () => {
    expect(hasCjkGarbleShape('готово 🏹 — всё на месте')).toBe(false)
  })

  test('empty text does not trip it', () => {
    expect(hasCjkGarbleShape('')).toBe(false)
  })
})

// ── Codex review fixes (2026-08-29) ──────────────────────────────────────
// Each test below pins a defect the review caught, so a later "cleanup" of
// these regexes fails loudly instead of quietly reopening the hole.

describe('review fixes', () => {
  test('GFM allows + as a task-list marker', () => {
    expect(needsRichRendering('+ [ ] задача')).toBe(true)
  })

  test('a table literal inside fenced code does NOT ask for rich', () => {
    const body = ['вот пример разметки:', '```markdown', '| a | b |', '| --- | --- |', '```'].join('\n')
    expect(needsRichRendering(body)).toBe(false)
  })

  test('a $$ literal inside fenced code does NOT ask for rich', () => {
    expect(needsRichRendering('```\n$$ не формула, а строка\n```')).toBe(false)
  })

  test('a details literal inside fenced code does NOT ask for rich', () => {
    expect(needsRichRendering('```html\n<details>\n```')).toBe(false)
  })

  test('a REAL table outside the fence still asks for rich', () => {
    const body = ['```', 'code', '```', '', '| a | b |', '| --- | --- |'].join('\n')
    expect(needsRichRendering(body)).toBe(true)
  })

  test('decomposed Hangul trips the CJK shield', () => {
    // U+1112 U+1161 U+11AB renders as «한» but is not a precomposed syllable.
    expect(hasCjkGarbleShape('한')).toBe(true)
  })

  test('Hangul compatibility jamo trips the CJK shield', () => {
    expect(hasCjkGarbleShape('ㄱ')).toBe(true)
  })

  test('Russian still does NOT trip the widened CJK shield', () => {
    expect(hasCjkGarbleShape('Проверка кириллицы и latin text')).toBe(false)
  })
})

// Fable review 2026-08-30, HIGH #2: the operator switches used to be
// open-coded on the DM path and simply absent on the group path, so a fleet
// kill switch silenced private chats while groups kept sending rich. The
// predicate below is now the single place both paths ask.
describe('richDeliveryAllowed — the operator gate', () => {
  test('enabled with an empty opt-out permits any chat', () => {
    expect(richDeliveryAllowed({ enabled: true, perChatOptOut: [] }, '-100123')).toBe(true)
  })

  test('the kill switch silences every chat, groups included', () => {
    expect(richDeliveryAllowed({ enabled: false, perChatOptOut: [] }, '-100123')).toBe(false)
    expect(richDeliveryAllowed({ enabled: false, perChatOptOut: [] }, '164795011')).toBe(false)
  })

  test('per-chat opt-out silences exactly that chat', () => {
    const policy = { enabled: true, perChatOptOut: ['-100123'] }
    expect(richDeliveryAllowed(policy, '-100123')).toBe(false)
    expect(richDeliveryAllowed(policy, '-100999')).toBe(true)
  })

  test('chat ids compare as strings — a numeric-looking id is not coerced', () => {
    expect(
      richDeliveryAllowed({ enabled: true, perChatOptOut: ['164795011'] }, '164795011'),
    ).toBe(false)
  })
})
