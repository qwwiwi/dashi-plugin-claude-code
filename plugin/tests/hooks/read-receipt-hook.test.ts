// fix/eyes-on-read (2026-05-28) — unit tests for the read-receipt Stop hook.
// Pure functions only: no real network, no real session. Exercises channel
// parsing (escaped + raw forms), tail extraction + dedup, env-file fallback
// config resolution, and the dedup state log round-trip.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  parseChannelRefs,
  extractCurrentTurnRefs,
  resolveReactConfig,
  resolveStatePath,
  loadChannelEnvFile,
  parseEnvFile,
  loadSeen,
  refKey,
} from '../../scripts/read-receipt-hook.js'

describe('parseChannelRefs', () => {
  test('extracts telegram chat_id + message_id from raw form', () => {
    const text =
      '<channel source="agent47-channel" source="telegram" chat_id="164795011" user_id="164795011" ts="x" message_id="28045">hi</channel>'
    expect(parseChannelRefs(text)).toEqual([{ chat_id: '164795011', message_id: 28045 }])
  })

  test('extracts from JSON-escaped transcript form', () => {
    const line =
      '{"type":"user","message":{"content":"<channel source=\\"agent47-channel\\" source=\\"telegram\\" chat_id=\\"164795011\\" message_id=\\"28049\\">voice</channel>"}}'
    expect(parseChannelRefs(line)).toEqual([{ chat_id: '164795011', message_id: 28049 }])
  })

  test('supports negative chat_id (multichat group / supergroup)', () => {
    const text = '<channel source="telegram" chat_id="-1003784643974" message_id="42">grp</channel>'
    expect(parseChannelRefs(text)).toEqual([{ chat_id: '-1003784643974', message_id: 42 }])
  })

  test('ignores non-telegram channel blocks (orgrimmar-inbox)', () => {
    const text = '<channel source="orgrimmar-inbox" from="sa-silvana" type="task">body</channel>'
    expect(parseChannelRefs(text)).toEqual([])
  })

  test('skips a block missing message_id', () => {
    const text = '<channel source="telegram" chat_id="164795011">no id</channel>'
    expect(parseChannelRefs(text)).toEqual([])
  })

  test('extracts multiple blocks in one chunk', () => {
    const text =
      '<channel source="telegram" chat_id="1" message_id="10">a</channel>' +
      '<channel source="telegram" chat_id="2" message_id="20">b</channel>'
    expect(parseChannelRefs(text)).toEqual([
      { chat_id: '1', message_id: 10 },
      { chat_id: '2', message_id: 20 },
    ])
  })
})

describe('extractCurrentTurnRefs', () => {
  test('finds the inbound block even behind a long trailing tool/assistant output (Codex HIGH)', () => {
    const inbound = '<channel source="telegram" chat_id="1" message_id="99">read me</channel>'
    // Simulate a tool-heavy turn: 200 assistant/tool lines AFTER the inbound.
    const trailing = Array.from({ length: 200 }, (_, i) => `{"type":"assistant","i":${i}}`)
    const transcript = [inbound, ...trailing].join('\n')
    expect(extractCurrentTurnRefs(transcript)).toEqual([{ chat_id: '1', message_id: 99 }])
  })

  test('collects a contiguous batched multi-message turn, in order', () => {
    const transcript = [
      '{"type":"assistant","prev":"reply"}',
      '<channel source="telegram" chat_id="1" message_id="10">a</channel>',
      '<channel source="telegram" chat_id="1" message_id="11">b</channel>',
      '{"type":"assistant","cur":"reply"}',
    ].join('\n')
    expect(extractCurrentTurnRefs(transcript)).toEqual([
      { chat_id: '1', message_id: 10 },
      { chat_id: '1', message_id: 11 },
    ])
  })

  test('does NOT reach a previous turn behind a non-telegram line', () => {
    const transcript = [
      '<channel source="telegram" chat_id="1" message_id="1">old turn</channel>',
      '{"type":"assistant","reply":"to old"}',
      '<channel source="telegram" chat_id="1" message_id="2">current turn</channel>',
      '{"type":"assistant","reply":"to current"}',
    ].join('\n')
    expect(extractCurrentTurnRefs(transcript)).toEqual([{ chat_id: '1', message_id: 2 }])
  })

  test('dedups a repeated id within the inbound block', () => {
    const transcript = [
      '<channel source="telegram" chat_id="1" message_id="10">a</channel>',
      '<channel source="telegram" chat_id="1" message_id="10">a-dup</channel>',
    ].join('\n')
    expect(extractCurrentTurnRefs(transcript)).toEqual([{ chat_id: '1', message_id: 10 }])
  })

  test('empty transcript → no refs', () => {
    expect(extractCurrentTurnRefs('')).toEqual([])
  })
})

describe('resolveReactConfig (pure, env already merged)', () => {
  test('explicit url + token wins', () => {
    const cfg = resolveReactConfig({
      TELEGRAM_READ_RECEIPT_URL: 'http://127.0.0.1:8089/hooks/react',
      TELEGRAM_WEBHOOK_TOKEN: 'tok',
    })
    expect(cfg).toEqual({ url: 'http://127.0.0.1:8089/hooks/react', token: 'tok' })
  })

  test('builds url from host+port', () => {
    const cfg = resolveReactConfig({
      TELEGRAM_WEBHOOK_HOST: '127.0.0.1',
      TELEGRAM_WEBHOOK_PORT: '8093',
      TELEGRAM_WEBHOOK_TOKEN: 'filetok',
    })
    expect(cfg).toEqual({ url: 'http://127.0.0.1:8093/hooks/react', token: 'filetok' })
  })

  test('defaults host to 127.0.0.1 when only port present', () => {
    const cfg = resolveReactConfig({ TELEGRAM_WEBHOOK_PORT: '9001', TELEGRAM_WEBHOOK_TOKEN: 'e' })
    expect(cfg).toEqual({ url: 'http://127.0.0.1:9001/hooks/react', token: 'e' })
  })

  test('errors when token cannot be resolved', () => {
    const cfg = resolveReactConfig({})
    expect('kind' in cfg && cfg.kind === 'error').toBe(true)
  })

  test('errors when port missing and no explicit url', () => {
    const cfg = resolveReactConfig({ TELEGRAM_WEBHOOK_TOKEN: 'tok' })
    expect('kind' in cfg && cfg.kind === 'error').toBe(true)
  })
})

describe('loadChannelEnvFile (multichat env-i fallback)', () => {
  test('parses the named env file into vars', () => {
    const fakeFile =
      'TELEGRAM_WEBHOOK_HOST=127.0.0.1\nTELEGRAM_WEBHOOK_PORT=8093\nTELEGRAM_WEBHOOK_TOKEN=filetok\n'
    const vars = loadChannelEnvFile({ TELEGRAM_CHANNEL_ENV_FILE: '/fake/channel.env' }, () => fakeFile)
    expect(vars.TELEGRAM_WEBHOOK_PORT).toBe('8093')
    expect(vars.TELEGRAM_WEBHOOK_TOKEN).toBe('filetok')
  })

  test('no path set → empty (degrade to process env)', () => {
    expect(loadChannelEnvFile({})).toEqual({})
  })

  test('unreadable file → empty, never throws', () => {
    expect(
      loadChannelEnvFile({ TELEGRAM_CHANNEL_ENV_FILE: '/nope' }, () => {
        throw new Error('ENOENT')
      }),
    ).toEqual({})
  })

  test('merged env (file under process env) resolves config in a per-chat session', () => {
    // Simulates env -i: process env has no TELEGRAM_*, only the env-file path.
    const fileVars = loadChannelEnvFile(
      { TELEGRAM_CHANNEL_ENV_FILE: '/fake' },
      () => 'TELEGRAM_WEBHOOK_PORT=8093\nTELEGRAM_WEBHOOK_TOKEN=filetok\n',
    )
    const merged = { ...fileVars, MULTICHAT_STATE_DIR: '/mc/state' }
    expect(resolveReactConfig(merged)).toEqual({
      url: 'http://127.0.0.1:8093/hooks/react',
      token: 'filetok',
    })
  })
})

describe('parseEnvFile', () => {
  test('parses KEY=VALUE, strips quotes, skips comments/blanks', () => {
    const parsed = parseEnvFile('# comment\nA=1\nB="two"\nC=\'three\'\n\nD=has=eq\n')
    expect(parsed).toEqual({ A: '1', B: 'two', C: 'three', D: 'has=eq' })
  })
})

describe('resolveStatePath (per-session)', () => {
  test('explicit state path wins over state dir', () => {
    expect(
      resolveStatePath({ TELEGRAM_READ_RECEIPT_STATE: '/x/y.log', TELEGRAM_STATE_DIR: '/d' }, 's1'),
    ).toBe('/x/y.log')
  })
  test('derives a per-session file from state dir', () => {
    expect(resolveStatePath({ TELEGRAM_STATE_DIR: '/d' }, 'sess-1')).toBe(
      '/d/read-receipts/sess-1.log',
    )
  })
  test('falls back to MULTICHAT_STATE_DIR (per-chat env -i survivor)', () => {
    expect(resolveStatePath({ MULTICHAT_STATE_DIR: '/mc' }, 'abc')).toBe(
      '/mc/read-receipts/abc.log',
    )
  })
  test('TELEGRAM_STATE_DIR wins over MULTICHAT_STATE_DIR', () => {
    expect(resolveStatePath({ TELEGRAM_STATE_DIR: '/t', MULTICHAT_STATE_DIR: '/mc' }, 's')).toBe(
      '/t/read-receipts/s.log',
    )
  })
  test('sanitises a hostile session id', () => {
    expect(resolveStatePath({ TELEGRAM_STATE_DIR: '/d' }, '../../etc/passwd')).toBe(
      '/d/read-receipts/.._.._etc_passwd.log',
    )
  })
  test('no session id → shared fallback filename', () => {
    expect(resolveStatePath({ TELEGRAM_STATE_DIR: '/d' })).toBe('/d/read-receipts/read-receipts.log')
  })
  test('undefined when no base dir', () => {
    expect(resolveStatePath({}, 's1')).toBeUndefined()
  })
})

describe('loadSeen dedup log', () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  test('missing file → empty set', () => {
    dir = mkdtempSync(join(tmpdir(), 'rr-'))
    expect(loadSeen(join(dir, 'nope.log')).size).toBe(0)
  })
  test('reads keys, trims blanks', () => {
    const seen = loadSeen('/whatever', () => '1:10\n\n-1:20\n')
    expect(seen.has('1:10')).toBe(true)
    expect(seen.has('-1:20')).toBe(true)
    expect(seen.size).toBe(2)
  })
})

describe('refKey', () => {
  test('stable composite key', () => {
    expect(refKey({ chat_id: '-1003784643974', message_id: 7 })).toBe('-1003784643974:7')
  })
})
