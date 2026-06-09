import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getStatePaths,
  loadConfig,
  redactToken,
  resolveAskUserQuestionAllowedUserIds,
  RuntimeEnvSchema,
} from '../src/config.js'

let stateDir: string

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'dashi-channel-config-'))
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

const FAKE_TOKEN = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    TELEGRAM_STATE_DIR: stateDir,
    ...overrides,
  }
}

describe('loadConfig', () => {
  test('loads default config when no file and no env overrides except token', () => {
    const cfg = loadConfig(env())
    expect(cfg.bot_id).toBe(8507713167)
    expect(cfg.allowed_user_ids).toEqual([164795011])
    expect(cfg.dm_only).toBe(true)
    expect(cfg.status.interval_ms).toBe(700)
    expect(cfg.album.flush_ms).toBe(2000)
    expect(cfg.voice.provider).toBe('groq')
    expect(cfg.webhook.enabled).toBe(false)
    expect(cfg.permission_relay.bash_only_proof).toBe(true)
  })

  test('parses CSV TELEGRAM_ALLOWED_USER_IDS into number array', () => {
    const cfg = loadConfig(env({ TELEGRAM_ALLOWED_USER_IDS: '111, 222 ,333' }))
    expect(cfg.allowed_user_ids).toEqual([111, 222, 333])
  })

  test('parses CSV TELEGRAM_ALLOWED_CHAT_IDS into mixed int/string array', () => {
    // Mix: positive int (user/private chat), negative int (supergroup),
    // @username (channel reference). All three are valid chat-id shapes
    // per the Bot API.
    const cfg = loadConfig(env({
      TELEGRAM_ALLOWED_CHAT_IDS: '111, -1001234567890 , @my_channel',
    }))
    expect(cfg.allowed_chat_ids).toEqual([111, -1001234567890, '@my_channel'])
  })

  test('TELEGRAM_ALLOWED_CHAT_IDS rejects zero and non-integers', () => {
    expect(() => loadConfig(env({ TELEGRAM_ALLOWED_CHAT_IDS: '0' })))
      .toThrow(/invalid chat id/i)
    expect(() => loadConfig(env({ TELEGRAM_ALLOWED_CHAT_IDS: 'abc' })))
      .toThrow(/invalid chat id/i)
  })

  test('TELEGRAM_ALLOWED_CHAT_IDS env wins over config.json', () => {
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      allowed_user_ids: [999],
      allowed_chat_ids: [999],
    }))
    const cfg = loadConfig(env({ TELEGRAM_ALLOWED_CHAT_IDS: '888,-100777' }))
    expect(cfg.allowed_chat_ids).toEqual([888, -100777])
  })

  test('env overrides win over config.json', () => {
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      bot_id: 11111,
      allowed_user_ids: [999],
      status: { interval_ms: 100 },
      album: { flush_ms: 500 },
    }))
    const cfg = loadConfig(env({
      TELEGRAM_EXPECTED_BOT_ID: '22222',
      TELEGRAM_ALLOWED_USER_IDS: '888',
      TELEGRAM_STATUS_INTERVAL_MS: '900',
      TELEGRAM_ALBUM_FLUSH_MS: '1500',
    }))
    expect(cfg.bot_id).toBe(22222)
    expect(cfg.allowed_user_ids).toEqual([888])
    expect(cfg.status.interval_ms).toBe(900)
    expect(cfg.album.flush_ms).toBe(1500)
  })

  test('rejects config with empty allowed_user_ids array', () => {
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      allowed_user_ids: [],
    }))
    expect(() => loadConfig(env())).toThrow(/allowed_user_ids|too_small|at least 1/i)
  })

  test('coerces string PORT env to number', () => {
    const cfg = loadConfig(env({ TELEGRAM_WEBHOOK_PORT: '9090', TELEGRAM_WEBHOOK_HOST: '0.0.0.0' }))
    expect(cfg.webhook.port).toBe(9090)
    expect(typeof cfg.webhook.port).toBe('number')
    expect(cfg.webhook.host).toBe('0.0.0.0')
  })

  test('redactToken replaces bot token shapes', () => {
    const msg = `error connecting with TELEGRAM_BOT_TOKEN=${FAKE_TOKEN} oops`
    const out = redactToken(msg)
    expect(out).not.toContain(FAKE_TOKEN)
    expect(out).toContain('[REDACTED]')
  })

  // Fix 4 — widened secret redaction.
  test('redactToken masks Groq API key pattern', () => {
    const groq = 'gsk_' + 'A'.repeat(50)
    const out = redactToken(`groq error: GROQ_API_KEY=${groq} failed`)
    expect(out).not.toContain(groq)
    expect(out).toContain('[REDACTED]')
  })

  test('redactToken masks Authorization: Bearer header value', () => {
    const bearer = 'abcdef1234567890ABCDEFGHIJK'
    const out = redactToken(`request failed with Authorization: Bearer ${bearer}`)
    expect(out).not.toContain(bearer)
    expect(out).toContain('Bearer [REDACTED]')
  })

  test('redactToken masks ?token= and &access_token= query params', () => {
    const tok = 'qS3cret_value_XYZ-987'
    const out1 = redactToken(`GET https://x.io/cb?token=${tok}&other=ok`)
    expect(out1).not.toContain(tok)
    const out2 = redactToken(`GET https://x.io/cb?a=1&access_token=${tok}`)
    expect(out2).not.toContain(tok)
  })

  test('redactToken masks caller-supplied exact substrings', () => {
    const webhook = 'wh_test_token_32_chars__________'
    const out = redactToken(`got header value ${webhook} in log`, [webhook])
    expect(out).not.toContain(webhook)
    expect(out).toContain('[REDACTED]')
  })

  test('redactToken ignores empty / too-short caller secrets', () => {
    // 3-char strings would match too many substrings — guard refuses them.
    const out = redactToken('the cat sat on the mat', ['', 'abc'])
    expect(out).toBe('the cat sat on the mat')
  })

  test('loadConfig throws Zod error without leaking token value', () => {
    // Use a config file that fails validation (negative port) to force a Zod throw
    // after env parsing has already accepted the token.
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      webhook: { port: -5 },
    }))
    let caught: unknown
    try {
      loadConfig(env())
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
    const message = caught instanceof Error ? caught.message : String(caught)
    expect(message).not.toContain(FAKE_TOKEN)
  })

  // M7: TELEGRAM_ACCESS_MODE=pairing must fail with a clear scope-aware error.
  test('loadConfig rejects TELEGRAM_ACCESS_MODE=pairing with a clear scope-aware message', () => {
    let caught: unknown
    try {
      loadConfig(env({ TELEGRAM_ACCESS_MODE: 'pairing' }))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
    const message = caught instanceof Error ? caught.message : String(caught)
    expect(message.toLowerCase()).toContain('pairing')
    expect(message).toMatch(/scope b|not supported|allowlist/i)
  })

  test('loadConfig accepts TELEGRAM_ACCESS_MODE=static', () => {
    const cfg = loadConfig(env({ TELEGRAM_ACCESS_MODE: 'static' }))
    expect(cfg.bot_id).toBe(8507713167)
  })

  test('loadConfig reads config.json values when no env override', () => {
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      bot_id: 77777777,
      allowed_user_ids: [42, 43],
      workspace_root: '/tmp/ws',
    }))
    const cfg = loadConfig(env())
    expect(cfg.bot_id).toBe(77777777)
    expect(cfg.allowed_user_ids).toEqual([42, 43])
    expect(cfg.workspace_root).toBe('/tmp/ws')
  })

  // ─── Phase 8 / T1: memory group ──────────────────────────────────────

  test('memory: defaults are off-by-default with sane field values', () => {
    const cfg = loadConfig(env())
    expect(cfg.memory.enabled).toBe(false)
    expect(cfg.memory.workspace_path).toBeUndefined()
    expect(cfg.memory.logs_path).toBeUndefined()
    expect(cfg.memory.source_tag).toBe('tg')
    expect(cfg.memory.max_hot_bytes).toBe(20480)
    expect(cfg.memory.trim_keep_lines).toBe(600)
    expect(cfg.memory.buffer_ttl_ms).toBe(5 * 60 * 1000)
    expect(cfg.memory.buffer_max_entries).toBe(100)
  })

  test('memory: enabled=true without workspace_path fails refine with explicit message', () => {
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      memory: { enabled: true },
    }))
    let caught: unknown
    try { loadConfig(env()) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(Error)
    const msg = (caught as Error).message
    expect(msg).toMatch(/memory\.workspace_path required when memory\.enabled=true/)
  })

  test('memory: enabled=true with workspace_path validates', () => {
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      memory: { enabled: true, workspace_path: '/tmp/agent-ws' },
    }))
    const cfg = loadConfig(env())
    expect(cfg.memory.enabled).toBe(true)
    expect(cfg.memory.workspace_path).toBe('/tmp/agent-ws')
  })

  test('memory: env TELEGRAM_MEMORY_* overrides file config', () => {
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      memory: { enabled: false, workspace_path: '/tmp/from-file', source_tag: 'old' },
    }))
    const cfg = loadConfig(env({
      TELEGRAM_MEMORY_ENABLED: 'true',
      TELEGRAM_MEMORY_WORKSPACE: '/tmp/from-env',
      TELEGRAM_MEMORY_LOGS_PATH: '/tmp/from-env-logs',
      TELEGRAM_MEMORY_SOURCE_TAG: 'tg',
      TELEGRAM_MEMORY_AGENT_LABEL: 'Silvana',
    }))
    expect(cfg.memory.enabled).toBe(true)
    expect(cfg.memory.workspace_path).toBe('/tmp/from-env')
    expect(cfg.memory.logs_path).toBe('/tmp/from-env-logs')
    expect(cfg.memory.source_tag).toBe('tg')
    expect(cfg.memory.agent_label).toBe('Silvana')
  })

  test('memory: TELEGRAM_MEMORY_ENABLED accepts 1/true/yes/on (case-insensitive); other values → false', () => {
    for (const truthy of ['1', 'true', 'TRUE', 'yes', 'On']) {
      const cfg = loadConfig(env({
        TELEGRAM_MEMORY_ENABLED: truthy,
        TELEGRAM_MEMORY_WORKSPACE: '/tmp/ws',
      }))
      expect(cfg.memory.enabled).toBe(true)
    }
    for (const falsy of ['0', 'false', 'no', 'off', '']) {
      const cfg = loadConfig(env({ TELEGRAM_MEMORY_ENABLED: falsy }))
      expect(cfg.memory.enabled).toBe(false)
    }
  })

  // ─── tmux_mirror schema (added 2026-05-22) ─────────────────────────

  test('tmux_mirror defaults: mode=latest_inbound_only, max_lines=14, hide_segments includes input_box', () => {
    const cfg = loadConfig(env())
    expect(cfg.tmux_mirror.mode).toBe('latest_inbound_only')
    expect(cfg.tmux_mirror.max_lines).toBe(14)
    expect(cfg.tmux_mirror.hide_segments).toContain('input_box')
    expect(cfg.tmux_mirror.hide_segments).toContain('boot_banner')
    expect(cfg.tmux_mirror.hide_segments).toContain('inbound_warning')
    expect(cfg.tmux_mirror.hide_segments).toContain('footer_hints')
  })

  test('tmux_mirror.max_lines rejects degenerate values 1..3 (Codex 2026-05-22 [medium])', () => {
    // Spec: 0 = disabled, otherwise 4..100. Smaller values render only
    // the marker plus a handful of lines — not useful.
    for (const bad of [1, 2, 3, -1, 101]) {
      writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
        tmux_mirror: { max_lines: bad },
      }))
      expect(() => loadConfig(env())).toThrow(/max_lines must be 0 \(disabled\) or an integer in 4..100/)
    }
  })

  test('tmux_mirror.max_lines accepts 0 (disabled) and 4..100', () => {
    for (const good of [0, 4, 14, 50, 100]) {
      writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
        tmux_mirror: { max_lines: good },
      }))
      const cfg = loadConfig(env())
      expect(cfg.tmux_mirror.max_lines).toBe(good)
    }
  })

  test('tmux_mirror.mode accepts both full_pane and latest_inbound_only', () => {
    for (const mode of ['full_pane', 'latest_inbound_only'] as const) {
      writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
        tmux_mirror: { mode },
      }))
      const cfg = loadConfig(env())
      expect(cfg.tmux_mirror.mode).toBe(mode)
    }
  })

  // ─── PRX-1 TASK-6: ask_user_question schema ────────────────────────

  test('ask_user_question: defaults are off-by-default with sane field values', () => {
    const cfg = loadConfig(env())
    expect(cfg.ask_user_question.enabled).toBe(false)
    expect(cfg.ask_user_question.timeout_ms).toBe(300_000)
    expect(cfg.ask_user_question.allowed_user_ids).toBeUndefined()
    expect(cfg.ask_user_question.max_preview_chars).toBe(1000)
  })

  test('ask_user_question: TELEGRAM_ASK_USER_QUESTION_ENABLED=1 → enabled=true', () => {
    const cfg = loadConfig(env({ TELEGRAM_ASK_USER_QUESTION_ENABLED: '1' }))
    expect(cfg.ask_user_question.enabled).toBe(true)
  })

  test('ask_user_question: TELEGRAM_ASK_USER_QUESTION_ENABLED accepts truthy strings', () => {
    for (const truthy of ['1', 'true', 'TRUE', 'yes', 'On']) {
      const cfg = loadConfig(env({ TELEGRAM_ASK_USER_QUESTION_ENABLED: truthy }))
      expect(cfg.ask_user_question.enabled).toBe(true)
    }
    for (const falsy of ['0', 'false', 'no', 'off', '']) {
      const cfg = loadConfig(env({ TELEGRAM_ASK_USER_QUESTION_ENABLED: falsy }))
      expect(cfg.ask_user_question.enabled).toBe(false)
    }
  })

  test('ask_user_question: TELEGRAM_ASK_USER_QUESTION_TIMEOUT_MS=180000 → timeout_ms=180000', () => {
    const cfg = loadConfig(env({ TELEGRAM_ASK_USER_QUESTION_TIMEOUT_MS: '180000' }))
    expect(cfg.ask_user_question.timeout_ms).toBe(180_000)
  })

  test('ask_user_question: TELEGRAM_ASK_USER_QUESTION_ALLOWED_USER_IDS parses CSV into number array', () => {
    const cfg = loadConfig(env({ TELEGRAM_ASK_USER_QUESTION_ALLOWED_USER_IDS: '164795011, 99999 ,42' }))
    expect(cfg.ask_user_question.allowed_user_ids).toEqual([164795011, 99999, 42])
  })

  test('ask_user_question: TELEGRAM_ASK_USER_QUESTION_MAX_PREVIEW_CHARS overrides default', () => {
    const cfg = loadConfig(env({ TELEGRAM_ASK_USER_QUESTION_MAX_PREVIEW_CHARS: '2048' }))
    expect(cfg.ask_user_question.max_preview_chars).toBe(2048)
  })

  test('ask_user_question: negative timeout in env throws Zod error', () => {
    let caught: unknown
    try {
      loadConfig(env({ TELEGRAM_ASK_USER_QUESTION_TIMEOUT_MS: '-1000' }))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    const msg = (caught as Error).message
    // Zod's `positive()` fails with "Number must be greater than 0" / too_small.
    // Token redaction may obscure the env var name in the path, so anchor on
    // the failure code/wording instead.
    expect(msg).toMatch(/too_small|greater than 0|positive/i)
  })

  test('ask_user_question: non-integer user id in CSV throws clear error', () => {
    let caught: unknown
    try {
      loadConfig(env({ TELEGRAM_ASK_USER_QUESTION_ALLOWED_USER_IDS: '164795011,abc' }))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    const msg = (caught as Error).message
    expect(msg).toMatch(/invalid user id|abc/i)
  })

  test('ask_user_question: negative timeout in config.json throws Zod error with path', () => {
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      ask_user_question: { timeout_ms: -5 },
    }))
    let caught: unknown
    try {
      loadConfig(env())
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    const msg = (caught as Error).message
    expect(msg).toMatch(/ask_user_question|timeout_ms|positive/i)
  })

  test('ask_user_question: env overrides win over config.json', () => {
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      ask_user_question: { enabled: false, timeout_ms: 60_000, max_preview_chars: 500 },
    }))
    const cfg = loadConfig(env({
      TELEGRAM_ASK_USER_QUESTION_ENABLED: 'true',
      TELEGRAM_ASK_USER_QUESTION_TIMEOUT_MS: '120000',
      TELEGRAM_ASK_USER_QUESTION_MAX_PREVIEW_CHARS: '1500',
    }))
    expect(cfg.ask_user_question.enabled).toBe(true)
    expect(cfg.ask_user_question.timeout_ms).toBe(120_000)
    expect(cfg.ask_user_question.max_preview_chars).toBe(1500)
  })

  test('ask_user_question: config.json values are loaded when no env override', () => {
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      ask_user_question: {
        enabled: true,
        timeout_ms: 600_000,
        allowed_user_ids: [42, 43],
        max_preview_chars: 2000,
      },
    }))
    const cfg = loadConfig(env())
    expect(cfg.ask_user_question.enabled).toBe(true)
    expect(cfg.ask_user_question.timeout_ms).toBe(600_000)
    expect(cfg.ask_user_question.allowed_user_ids).toEqual([42, 43])
    expect(cfg.ask_user_question.max_preview_chars).toBe(2000)
  })

  test('resolveAskUserQuestionAllowedUserIds: undefined → falls back to permission_relay.allowed_user_ids', () => {
    const cfg = loadConfig(env())
    expect(cfg.ask_user_question.allowed_user_ids).toBeUndefined()

    const calls: Array<{ msg: string; fields: Record<string, unknown> | undefined }> = []
    const logger = { info: (msg: string, fields?: Record<string, unknown>) => calls.push({ msg, fields }) }
    const resolved = resolveAskUserQuestionAllowedUserIds(cfg, logger)
    expect(resolved).toEqual(cfg.permission_relay.allowed_user_ids)
    expect(calls.length).toBe(1)
    expect(calls[0]!.msg).toMatch(/inheriting from permission_relay/)
    expect(calls[0]!.fields?.fallback).toBe(true)
  })

  test('resolveAskUserQuestionAllowedUserIds: explicit list is used and fallback log is not emitted', () => {
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      ask_user_question: { allowed_user_ids: [555, 666] },
    }))
    const cfg = loadConfig(env())
    expect(cfg.ask_user_question.allowed_user_ids).toEqual([555, 666])

    const calls: Array<{ msg: string; fields: Record<string, unknown> | undefined }> = []
    const logger = { info: (msg: string, fields?: Record<string, unknown>) => calls.push({ msg, fields }) }
    const resolved = resolveAskUserQuestionAllowedUserIds(cfg, logger)
    expect(resolved).toEqual([555, 666])
    expect(calls.length).toBe(1)
    expect(calls[0]!.fields?.fallback).toBe(false)
  })

  test('resolveAskUserQuestionAllowedUserIds: works without a logger argument', () => {
    const cfg = loadConfig(env())
    const resolved = resolveAskUserQuestionAllowedUserIds(cfg)
    expect(resolved).toEqual(cfg.permission_relay.allowed_user_ids)
  })

  test('paths.logs.ask_user_question resolves to ${state_dir}/logs/ask-user-question.jsonl', () => {
    const cfg = loadConfig(env())
    const parsedEnv = RuntimeEnvSchema.parse({
      TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
      TELEGRAM_STATE_DIR: stateDir,
    })
    const paths = getStatePaths(cfg, parsedEnv)
    expect(paths.logs.ask_user_question).toBe(join(stateDir, 'logs', 'ask-user-question.jsonl'))
  })
})

describe('single progress surface defaults (2026-06-09 duplicate-windows fix)', () => {
  // Mac mini migration: ProgressReporter + StatusManager both defaulted ON,
  // so a fresh install with hooks registered rendered two «working/running»
  // Telegram windows next to the tmux mirror. The owner wants exactly one
  // surface; the hook-driven reporters are now opt-in.
  test('progress reporter is disabled by default', () => {
    const cfg = loadConfig(env())
    expect(cfg.progress.enabled).toBe(false)
  })
  test('status manager is disabled by default', () => {
    const cfg = loadConfig(env())
    expect(cfg.status.enabled).toBe(false)
  })
  test('explicit config.json can still enable the reporters', () => {
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
      status: { enabled: true },
      progress: { enabled: true },
    }))
    const cfg = loadConfig(env())
    expect(cfg.status.enabled).toBe(true)
    expect(cfg.progress.enabled).toBe(true)
  })
})
