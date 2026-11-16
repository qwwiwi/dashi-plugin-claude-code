// #1914 — the inbound handlers surface formatting entities to the agent as a
// `<formatted format="html">` block after the plain text/caption.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Context } from 'grammy'

import {
  handleInboundDocument,
  handleInboundText,
  sendAlbumNotification,
  type AlbumEntry,
  type HandlerDeps,
} from '../../src/telegram/handlers.js'
import type { AppConfig, StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import type { TelegramApi } from '../../src/channel/tools.js'
import type { BotIdentity } from '../../src/prompt/build.js'

const silentLog = createLogger('test', {
  stream: { write: () => true } as unknown as NodeJS.WritableStream,
})

const OWNER = 164795011

function makeConfig(): AppConfig {
  return {
    bot_id: 8507713167,
    dm_only: true,
    allowed_user_ids: [OWNER],
    allowed_chat_ids: [OWNER],
    status: { enabled: false, interval_ms: 700, ttl_ms: 300_000, delete_on_complete: true, suppress_typing_bubble: false },
    album: { flush_ms: 2000 },
    voice: { provider: 'groq', language: 'ru', model: 'whisper-large-v3-turbo' },
    webhook: { enabled: false, host: '127.0.0.1', port: 0 },
    permission_relay: { enabled: false, allowed_user_ids: [], bash_only_proof: true },
    commands: { help: true, status: true, stop: true, reset: true, new: true },
    memory: { enabled: false, source_tag: 'tg', max_hot_bytes: 20480, trim_keep_lines: 600, buffer_ttl_ms: 300000, buffer_max_entries: 100 },
    progress: { enabled: false, edit_throttle_ms: 3000, recent_buffer: 10, session_ttl_ms: 600000 },
    task_mirror: { enabled: false, edit_throttle_ms: 3000, session_ttl_ms: 600000, collapse_completed_after: 5 },
    watcher: { enabled: false, debounce_ms: 10_000, busy_threshold_ms: 30_000 },
  } as unknown as AppConfig
}

function makeStatePaths(): StatePaths {
  const root = mkdtempSync(join(tmpdir(), 'dashi-entities-test-'))
  return {
    root,
    env: join(root, '.env'),
    config: join(root, 'config.json'),
    allowlist: join(root, 'allowlist.json'),
    pid: join(root, 'bot.pid'),
    lock: join(root, 'bot.lock'),
    updateOffset: join(root, 'update-offset'),
    inbox: join(root, 'inbox'),
    sessionIds: join(root, 'session-ids'),
    deadLetterUpdates: join(root, 'dead-letter', 'updates'),
    deadLetterWebhook: join(root, 'dead-letter', 'webhook'),
    deadLetterOutbound: join(root, 'dead-letter', 'outbound'),
    logs: {
      server: join(root, 'logs', 'server.log'),
      telegram: join(root, 'logs', 'telegram.log'),
      permissions: join(root, 'logs', 'permissions.jsonl'),
      webhook: join(root, 'logs', 'webhook.log'),
      ask_user_question: join(root, 'logs', 'ask-user-question.jsonl'),
      permission_gate: join(root, 'logs', 'permission-gate.jsonl'),
    },
  }
}

function makeDeps(): { deps: HandlerDeps; statePaths: StatePaths; contents: string[] } {
  const contents: string[] = []
  const server = {
    notification: async (msg: { method: string; params: { content: string } }): Promise<void> => {
      contents.push(msg.params.content)
    },
  }
  const fail = async (): Promise<never> => {
    throw new Error('unexpected api call')
  }
  const api = new Proxy({}, { get: () => fail }) as unknown as TelegramApi
  const statePaths = makeStatePaths()
  const bot: BotIdentity = { id: 8507713167, username: 'canarybot' }
  const deps: HandlerDeps = {
    server: server as unknown as HandlerDeps['server'],
    config: makeConfig(),
    statePaths,
    telegramApi: api,
    log: silentLog,
    bot,
    botApi: { api: {} } as unknown as HandlerDeps['botApi'],
    botToken: 'fake-token',
    env: {},
  }
  return { deps, statePaths, contents }
}

function dmCtx(message: Record<string, unknown>): Context {
  const chat = { id: OWNER, type: 'private' }
  const from = { id: OWNER, is_bot: false, first_name: 'V' }
  return { chat, from, message: { message_id: 7, date: 1700000000, chat, from, ...message } } as unknown as Context
}

describe('handleInboundText — formatting entities (#1914)', () => {
  test('bold/italic/spoiler post → plain text + formatted html block', async () => {
    const { deps, statePaths, contents } = makeDeps()
    const text = '🔥 Важно: скрыто'
    await handleInboundText(
      dmCtx({
        text,
        entities: [
          { type: 'bold', offset: 3, length: 5 },
          { type: 'italic', offset: 3, length: 6 },
          { type: 'spoiler', offset: 10, length: 6 },
        ],
      }),
      deps,
    )
    expect(contents).toEqual([
      `${text}\n<formatted format="html">\n🔥 <i><b>Важно</b>:</i> <tg-spoiler>скрыто</tg-spoiler>\n</formatted>`,
    ])
    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('forwarded post keeps its formatting (forward_origin + entities)', async () => {
    const { deps, statePaths, contents } = makeDeps()
    await handleInboundText(
      dmCtx({
        text: 'Пост Юли',
        entities: [{ type: 'bold', offset: 0, length: 4 }],
        forward_origin: { type: 'channel', date: 1700000000, chat: { id: -100, type: 'channel', title: 'c' }, message_id: 5 },
      }),
      deps,
    )
    expect(contents[0]).toBe('Пост Юли\n<formatted format="html">\n<b>Пост</b> Юли\n</formatted>')
    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('only mention/url entities → content identical to the plain text', async () => {
    const { deps, statePaths, contents } = makeDeps()
    const text = '@yulia see https://a.b/<x>'
    await handleInboundText(
      dmCtx({ text, entities: [{ type: 'mention', offset: 0, length: 6 }, { type: 'url', offset: 11, length: 15 }] }),
      deps,
    )
    expect(contents).toEqual([text])
    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('no entities → content identical to the plain text (no escaping)', async () => {
    const { deps, statePaths, contents } = makeDeps()
    await handleInboundText(dmCtx({ text: 'a < b & c' }), deps)
    expect(contents).toEqual(['a < b & c'])
    rmSync(statePaths.root, { recursive: true, force: true })
  })
})

describe('caption handlers — caption_entities (#1914)', () => {
  test('document caption with a link → formatted block after the caption', async () => {
    const { deps, statePaths, contents } = makeDeps()
    await handleInboundDocument(
      dmCtx({
        document: { file_id: 'doc-fid', file_name: 'a.pdf' },
        caption: 'Читать <тут>',
        caption_entities: [{ type: 'text_link', offset: 7, length: 5, url: 'https://t.me/a?x=1&y=2' }],
      }),
      deps,
    )
    expect(contents).toHaveLength(1)
    expect(contents[0]).toContain('Читать <тут>\n<formatted format="html">\n')
    expect(contents[0]).toContain('Читать <a href="https://t.me/a?x=1&amp;y=2">&lt;тут&gt;</a>\n</formatted>')
    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('caption without entities → no formatted block', async () => {
    const { deps, statePaths, contents } = makeDeps()
    await handleInboundDocument(dmCtx({ document: { file_id: 'doc-fid', file_name: 'a.pdf' }, caption: 'просто' }), deps)
    expect(contents[0]).not.toContain('<formatted')
    expect(contents[0]?.endsWith('просто')).toBe(true)
    rmSync(statePaths.root, { recursive: true, force: true })
  })
})

describe('sendAlbumNotification — merged captionHtml (#1914)', () => {
  const ids = { chatId: String(OWNER), senderId: String(OWNER), user: 'V', mediaGroupId: 'mg1', kind: 'photo' }
  const entry = (caption: string, captionHtml?: string): AlbumEntry => ({
    descriptors: [],
    mediaPaths: [],
    caption,
    ...(captionHtml !== undefined ? { captionHtml } : {}),
    messageId: 1,
    reply: undefined,
    addressedAtPush: true,
  })

  test('one formatted caption → block with html and escaped plain siblings', async () => {
    const { deps, statePaths, contents } = makeDeps()
    await sendAlbumNotification(
      { mediaGroupId: 'mg1', messages: [entry('a<b'), entry('Жир', '<b>Жир</b>'), entry('')], firstAt: 0, lastAt: 0 },
      ids,
      deps,
    )
    expect(contents).toEqual(['a<b\n\nЖир\n<formatted format="html">\na&lt;b\n\n<b>Жир</b>\n</formatted>'])
    rmSync(statePaths.root, { recursive: true, force: true })
  })

  test('no formatted captions (incl. pre-#1914 disk entries) → plain merge only', async () => {
    const { deps, statePaths, contents } = makeDeps()
    await sendAlbumNotification(
      { mediaGroupId: 'mg1', messages: [entry('one'), entry('two')], firstAt: 0, lastAt: 0 },
      ids,
      deps,
    )
    expect(contents).toEqual(['one\n\ntwo'])
    rmSync(statePaths.root, { recursive: true, force: true })
  })
})
