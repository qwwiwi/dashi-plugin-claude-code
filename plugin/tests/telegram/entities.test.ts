import { describe, expect, test } from 'bun:test'

import { textWithEntities } from '../../src/telegram/entities.js'

describe('textWithEntities', () => {
  test('returns empty string for undefined message', () => {
    expect(textWithEntities(undefined)).toBe('')
  })

  test('returns text unchanged when there are no entities', () => {
    expect(textWithEntities({ text: 'hello world' })).toBe('hello world')
  })

  test('expands a single text_link into a Markdown link', () => {
    const msg = {
      text: 'see here',
      entities: [{ type: 'text_link', offset: 4, length: 4, url: 'https://example.com/x' }],
    }
    expect(textWithEntities(msg)).toBe('see [here](https://example.com/x)')
  })

  test('ignores non-link entities (bold etc.)', () => {
    const msg = {
      text: 'bold text',
      entities: [{ type: 'bold', offset: 0, length: 4 }],
    }
    expect(textWithEntities(msg)).toBe('bold text')
  })

  test('expands multiple text_links with correct offsets', () => {
    const msg = {
      text: 'a B c D',
      entities: [
        { type: 'text_link', offset: 2, length: 1, url: 'https://one' },
        { type: 'text_link', offset: 6, length: 1, url: 'https://two' },
      ],
    }
    expect(textWithEntities(msg)).toBe('a [B](https://one) c [D](https://two)')
  })

  test('uses caption + caption_entities for media messages', () => {
    const msg = {
      caption: 'photo link',
      caption_entities: [{ type: 'text_link', offset: 6, length: 4, url: 'https://img' }],
    }
    expect(textWithEntities(msg)).toBe('photo [link](https://img)')
  })
})
