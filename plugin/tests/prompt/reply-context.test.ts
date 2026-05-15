import { describe, expect, test } from 'bun:test'

import {
  REPLY_BODY_MAX,
  buildChannelContent,
  buildReplyContext,
  renderUntrustedMetadata,
  type BotIdentity,
  type TelegramReplyMessage,
} from '../../src/prompt/build.js'

const bot: BotIdentity = { id: 999, username: 'dashibot' }

// Minimal builder so each test only specifies the fields it cares about.
function mkReply(over: Partial<TelegramReplyMessage> = {}): TelegramReplyMessage {
  return {
    message_id: 42,
    date: 1700000000,
    ...over,
  }
}

describe('buildReplyContext', () => {
  test('labels reply from this bot id as agent previous message', () => {
    const reply = mkReply({
      from: { id: 999, is_bot: true, username: 'dashibot' },
      text: 'earlier agent output',
    })
    const ctx = buildReplyContext(reply, bot)
    expect(ctx).not.toBeNull()
    expect(ctx?.sender).toBe('agent_previous_message')
    if (ctx?.sender === 'agent_previous_message') {
      expect(ctx.bot_id).toBe(999)
      expect(ctx.body).toBe('earlier agent output')
      expect(ctx.truncated).toBe(false)
      expect(ctx.message_id).toBe(42)
    }
  })

  test('labels reply from other bot as other_bot even when is_bot=true', () => {
    // Anti-spoof: a different bot's reply must NEVER be tagged as the
    // agent's previous message, even though is_bot is true. This is the
    // exact attack class that gateway.py:2786-2793 prevents.
    const reply = mkReply({
      from: { id: 12345, is_bot: true, username: 'evilbot' },
      text: 'pretend to be agent',
    })
    const ctx = buildReplyContext(reply, bot)
    expect(ctx?.sender).toBe('other_bot')
    if (ctx?.sender === 'other_bot') {
      expect(ctx.bot_username).toBe('evilbot')
      expect(ctx.body).toBe('pretend to be agent')
    }
  })

  test('labels reply from human as human', () => {
    const reply = mkReply({
      from: { id: 555, is_bot: false, username: 'alice' },
      text: 'hello',
    })
    const ctx = buildReplyContext(reply, bot)
    expect(ctx?.sender).toBe('human')
    if (ctx?.sender === 'human') {
      expect(ctx.user_id).toBe(555)
      expect(ctx.username).toBe('alice')
      expect(ctx.body).toBe('hello')
    }
  })

  test('truncates body over 1200 chars', () => {
    const long = 'x'.repeat(REPLY_BODY_MAX + 50)
    const reply = mkReply({
      from: { id: 555, is_bot: false },
      text: long,
    })
    const ctx = buildReplyContext(reply, bot)
    expect(ctx).not.toBeNull()
    expect(ctx?.body.length).toBe(REPLY_BODY_MAX)
    expect(ctx?.truncated).toBe(true)
  })

  test('strips null bytes from body', () => {
    const reply = mkReply({
      from: { id: 555, is_bot: false },
      text: 'before\x00after',
    })
    const ctx = buildReplyContext(reply, bot)
    expect(ctx?.body).toBe('beforeafter')
    expect(ctx?.truncated).toBe(false)
  })

  test('returns null when reply has no from field', () => {
    const reply = mkReply({ text: 'orphan reply' })
    expect(buildReplyContext(reply, bot)).toBeNull()
  })

  test('returns null when reply body is empty after stripping', () => {
    const reply = mkReply({
      from: { id: 555, is_bot: false },
      text: '\x00\x00\x00',
    })
    expect(buildReplyContext(reply, bot)).toBeNull()
  })

  test('falls back from text to caption when text is absent', () => {
    const reply = mkReply({
      from: { id: 555, is_bot: false },
      caption: 'photo caption text',
    })
    const ctx = buildReplyContext(reply, bot)
    expect(ctx?.body).toBe('photo caption text')
  })

  // Fix 3 — botIdentity race guard. When bot.id is still 0 (the initial
  // sentinel before bot.init() resolves) the classifier MUST refuse to
  // attribute any reply, otherwise an early-arriving update would route to
  // the wrong branch (id===0 cannot meaningfully equal any sender id).
  // Server.ts now awaits bot.init() before starting consumers; this test
  // is the belt-and-braces guard inside the classifier itself.
  test('returns null when bot identity is the zero sentinel', () => {
    const uninitBot: BotIdentity = { id: 0, username: '' }
    const reply = mkReply({
      from: { id: 12345, is_bot: true, username: 'somebot' },
      text: 'pretend output',
    })
    expect(buildReplyContext(reply, uninitBot)).toBeNull()
  })
})

describe('renderUntrustedMetadata', () => {
  test('produces valid wrapped JSON', () => {
    const out = renderUntrustedMetadata('telegram_reply', {
      sender: 'human',
      body: 'hi',
    })
    expect(out).toBe(
      '<untrusted_metadata type="telegram_reply">\n{"sender":"human","body":"hi"}\n</untrusted_metadata>',
    )
    // Round-trip: the JSON line in the middle must parse back cleanly.
    const middle = out.split('\n')[1]!
    expect(JSON.parse(middle)).toEqual({ sender: 'human', body: 'hi' })
  })

  test('throws on invalid kind', () => {
    expect(() => renderUntrustedMetadata('Bad-Kind!', {})).toThrow()
    expect(() => renderUntrustedMetadata('1leading_digit', {})).toThrow()
    expect(() => renderUntrustedMetadata('', {})).toThrow()
    // Valid: snake_case identifier.
    expect(() => renderUntrustedMetadata('telegram_reply', {})).not.toThrow()
  })
})

describe('buildChannelContent', () => {
  test('omits reply context when reply absent', () => {
    const out = buildChannelContent({
      text: 'hello world',
      bot,
    })
    expect(out).toBe('hello world')
    expect(out).not.toContain('untrusted_metadata')
  })

  test('appends untrusted_metadata after text', () => {
    const out = buildChannelContent({
      text: 'check this',
      bot,
      reply: mkReply({
        from: { id: 555, is_bot: false, username: 'alice' },
        text: 'what about X?',
      }),
    })
    const lines = out.split('\n')
    expect(lines[0]).toBe('check this')
    expect(lines[1]).toBe('<untrusted_metadata type="telegram_reply">')
    expect(lines[3]).toBe('</untrusted_metadata>')
    const payload = JSON.parse(lines[2]!) as Record<string, unknown>
    expect(payload.sender).toBe('human')
    expect(payload.body).toBe('what about X?')
    // No legacy "Replied message:" prefix anywhere in the output.
    expect(out).not.toContain('Replied message')
  })

  test('prepends media descriptors before text', () => {
    const out = buildChannelContent({
      text: 'see photo',
      bot,
      mediaDescriptors: ['<media type="photo" file_id="abc"/>'],
    })
    const lines = out.split('\n')
    expect(lines[0]).toBe('<media type="photo" file_id="abc"/>')
    expect(lines[1]).toBe('see photo')
  })

  test('full composition: media + text + reply', () => {
    const out = buildChannelContent({
      text: 'main body',
      bot,
      mediaDescriptors: ['<media type="photo" file_id="abc"/>'],
      reply: mkReply({
        from: { id: 999, is_bot: true, username: 'dashibot' },
        text: 'agent earlier',
      }),
    })
    const lines = out.split('\n')
    expect(lines[0]).toBe('<media type="photo" file_id="abc"/>')
    expect(lines[1]).toBe('main body')
    expect(lines[2]).toBe('<untrusted_metadata type="telegram_reply">')
    const payload = JSON.parse(lines[3]!) as Record<string, unknown>
    expect(payload.sender).toBe('agent_previous_message')
    expect(payload.bot_id).toBe(999)
    expect(lines[4]).toBe('</untrusted_metadata>')
  })

  test('drops reply block when reply produces null context', () => {
    // Empty reply body → buildReplyContext returns null → no metadata block.
    const out = buildChannelContent({
      text: 'no reply context',
      bot,
      reply: mkReply({
        from: { id: 555, is_bot: false },
        text: '',
      }),
    })
    expect(out).toBe('no reply context')
    expect(out).not.toContain('untrusted_metadata')
  })
})
