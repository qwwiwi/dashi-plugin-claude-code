// Prompt construction for inbound Telegram messages.
//
// Ports the BEHAVIOR of gateway.py:2765-2821 (reply-injection with untrusted
// metadata wrapping) into a typed, side-effect-free module. The critical rule
// is anti-spoof: a reply is labeled "agent's previous message" ONLY when
// reply.from.id === bot.id. Using reply.from.is_bot would let any user spoof
// agent output by replying to ANY bot — see gateway-inventory surprise #2.
//
// All composition produces a single string used as the `content` field of an
// MCP channel notification. Reply bodies are wrapped in
//   <untrusted_metadata type="telegram_reply">{json}</untrusted_metadata>
// so Claude reads them as data, never as instructions — same defense as
// gateway.py's "[Replied message (untrusted metadata, for context only):]"
// block, but with an explicit XML-style tag for cleaner parsing.

export type BotIdentity = { id: number; username: string }

export interface TelegramReplyMessage {
  message_id: number
  from?: { id: number; is_bot: boolean; username?: string }
  text?: string
  caption?: string
  date: number
}

export type UntrustedReplyContext =
  | {
      sender: 'agent_previous_message'
      bot_id: number
      message_id: number
      body: string
      truncated: boolean
    }
  | {
      sender: 'other_bot'
      bot_username?: string
      message_id: number
      body: string
      truncated: boolean
    }
  | {
      sender: 'human'
      user_id?: number
      username?: string
      message_id: number
      body: string
      truncated: boolean
    }

export const REPLY_BODY_MAX = 1200

// Match identifier-style kind names — keeps the rendered tag safe to scan
// with a simple regex on the consumer side.
const KIND_RE = /^[a-z_][a-z0-9_]*$/

// Classify a reply message into an UntrustedReplyContext. Returns null when
// the reply has no usable body or no `from` (system messages are ignored —
// the agent already has the surrounding message, the reply adds no signal).
export function buildReplyContext(
  reply: TelegramReplyMessage,
  bot: BotIdentity,
): UntrustedReplyContext | null {
  // Reply body fallback chain mirrors gateway.py:2769 (text || caption).
  // T8 will extend this with media descriptors for photo/sticker/voice/video.
  const raw = reply.text ?? reply.caption ?? ''
  // Strip null bytes before measuring length, matching gateway.py:2812
  // ordering. \x00 escape keeps the source file ASCII-clean.
  const stripped = raw.replace(/\x00/g, '')
  if (stripped.length === 0) return null

  const truncated = stripped.length > REPLY_BODY_MAX
  const body = truncated ? stripped.slice(0, REPLY_BODY_MAX) : stripped

  // No `from` field — Telegram system messages (channel posts forwarded into
  // a group, anonymous admin actions). We can't classify the sender, so we
  // drop the reply context entirely rather than guess.
  if (!reply.from) return null

  // Anti-spoof: id comparison, not is_bot. reply.from.is_bot=true alone would
  // let a user reply to ANY bot and have the agent treat that message as its
  // own previous output. See gateway.py:2786-2793.
  //
  // Defence: bot.id===0 is the "identity not yet initialised" sentinel from
  // server.ts. We MUST NOT treat a reply.from.id===0 as the agent's previous
  // message (no Telegram user has id 0) and we MUST NOT classify any other
  // bot reply confidently in that pre-init window — server.ts now awaits
  // bot.init() before starting the poller/webhook, so this branch is a
  // belt-and-braces guard for tests and any future call site.
  if (bot.id === 0) return null
  if (reply.from.id === bot.id) {
    return {
      sender: 'agent_previous_message',
      bot_id: bot.id,
      message_id: reply.message_id,
      body,
      truncated,
    }
  }

  if (reply.from.is_bot === true) {
    const ctx: UntrustedReplyContext = {
      sender: 'other_bot',
      message_id: reply.message_id,
      body,
      truncated,
    }
    if (reply.from.username !== undefined) ctx.bot_username = reply.from.username
    return ctx
  }

  const human: UntrustedReplyContext = {
    sender: 'human',
    message_id: reply.message_id,
    body,
    truncated,
  }
  if (reply.from.id !== undefined) human.user_id = reply.from.id
  if (reply.from.username !== undefined) human.username = reply.from.username
  return human
}

// Wrap an arbitrary payload in a tagged metadata block. JSON inside is NOT
// HTML-escaped — Claude reads the block as a string-tagged region (similar
// to gateway.py's `[Replied message (untrusted metadata, for context only):]`
// prefix), not as HTML to render. The tag itself uses XML-style attributes
// so it's recognizable even when surrounded by free-form text.
export function renderUntrustedMetadata(
  kind: string,
  payload: Record<string, unknown>,
): string {
  if (!KIND_RE.test(kind)) {
    throw new Error(`renderUntrustedMetadata: invalid kind "${kind}"`)
  }
  const json = JSON.stringify(payload)
  return `<untrusted_metadata type="${kind}">\n${json}\n</untrusted_metadata>`
}

export interface PromptInput {
  // Primary user text (text, caption, or empty for media-only messages).
  text: string
  bot: BotIdentity
  // grammY's ctx.message.reply_to_message, when present.
  reply?: TelegramReplyMessage
  // Pre-rendered media descriptors from T8 (e.g. `<media type="photo" .../>`).
  // T7 just concatenates them above the text — T8 owns the rendering logic.
  mediaDescriptors?: string[]
}

// Compose the final channel content string. Order:
//   1. media descriptors (joined by \n) — context about attachments
//   2. primary text — what the user actually typed
//   3. <untrusted_metadata> reply block — quoted message, sender-classified
//
// No legacy "Replied message: ..." plain prefix. Gateway.py used a labeled
// JSON block (gateway.py:2817-2819); we tighten that to a proper tag so the
// boundary between trusted user text and untrusted quoted text is explicit.
export function buildChannelContent(input: PromptInput): string {
  const parts: string[] = []

  if (input.mediaDescriptors && input.mediaDescriptors.length > 0) {
    parts.push(input.mediaDescriptors.join('\n'))
  }

  if (input.text.length > 0) {
    parts.push(input.text)
  }

  if (input.reply) {
    const ctx = buildReplyContext(input.reply, input.bot)
    if (ctx !== null) {
      parts.push(renderUntrustedMetadata('telegram_reply', ctx))
    }
  }

  return parts.join('\n')
}
