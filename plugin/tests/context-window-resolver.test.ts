// Tests for the model → context-window resolver (config.ts). Covers the family
// table, the [1m] marker, the unknown/absent fallback, and the operator
// override chain (config key + JARVIS_CONTEXT_WINDOW env), which must win over
// model auto-detection so a wrong table guess is always correctable.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  MODEL_CONTEXT_WINDOWS,
  resolveContextWindowForModel,
  resolveContextWindowOverride,
  resolveContextWindowTokens,
  type AppConfig,
} from '../src/config.js'

// Minimal AppConfig stub — only the field the resolver reads.
function cfg(context_window_tokens?: number): AppConfig {
  return { context_window_tokens } as unknown as AppConfig
}

describe('resolveContextWindowForModel — family table', () => {
  test('fable → 1M', () => {
    expect(resolveContextWindowForModel('claude-fable-5')).toBe(1_000_000)
    expect(resolveContextWindowForModel('some-fable-variant')).toBe(1_000_000)
  })

  test('opus 4.x (any minor) → 200k', () => {
    expect(resolveContextWindowForModel('claude-opus-4-8')).toBe(200_000)
    expect(resolveContextWindowForModel('claude-opus-4-6')).toBe(200_000)
    expect(resolveContextWindowForModel('claude-opus-4')).toBe(200_000)
  })

  test('sonnet-5 and sonnet-4 → 200k', () => {
    expect(resolveContextWindowForModel('claude-sonnet-5')).toBe(200_000)
    expect(resolveContextWindowForModel('claude-sonnet-4-5')).toBe(200_000)
  })

  test('haiku → 200k', () => {
    expect(resolveContextWindowForModel('claude-haiku-4')).toBe(200_000)
  })

  test('case-insensitive substring match', () => {
    expect(resolveContextWindowForModel('CLAUDE-FABLE-5')).toBe(1_000_000)
  })

  test('the exported table is the source of the numbers', () => {
    const fable = MODEL_CONTEXT_WINDOWS.find((r) => r.match === 'fable')
    expect(fable?.windowTokens).toBe(1_000_000)
  })
})

describe('resolveContextWindowForModel — [1m] marker', () => {
  test('bracketed [1m] marker → 1M even on an otherwise-200k family', () => {
    // Opus-1M must NOT be under-reported as 200k.
    expect(resolveContextWindowForModel('claude-opus-4-8[1m]')).toBe(1_000_000)
  })

  test('standalone 1m token → 1M', () => {
    expect(resolveContextWindowForModel('claude-opus-4-1m')).toBe(1_000_000)
  })

  test('does not trip on unrelated ids containing "1m" mid-word', () => {
    // "31million" style — the token is not word-boundaried, so no false 1M.
    expect(resolveContextWindowForModel('claude-opus-4-31mega')).toBe(200_000)
  })
})

describe('resolveContextWindowForModel — fallback', () => {
  test('unknown model → default 200k', () => {
    expect(resolveContextWindowForModel('gpt-5')).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS)
    expect(resolveContextWindowForModel('gpt-5')).toBe(200_000)
  })

  test('absent/empty model → fallback, never 0', () => {
    expect(resolveContextWindowForModel(undefined)).toBe(200_000)
    expect(resolveContextWindowForModel('')).toBe(200_000)
  })

  test('custom fallback honored for unknown model', () => {
    expect(resolveContextWindowForModel('gpt-5', { fallback: 128_000 })).toBe(128_000)
  })

  test('invalid fallback (<=0) coerced to the 200k default', () => {
    expect(resolveContextWindowForModel('gpt-5', { fallback: 0 })).toBe(200_000)
    expect(resolveContextWindowForModel('gpt-5', { fallback: -5 })).toBe(200_000)
  })
})

describe('resolveContextWindowForModel — override wins', () => {
  test('override beats a known-family model', () => {
    expect(resolveContextWindowForModel('claude-fable-5', { override: 500_000 })).toBe(500_000)
  })

  test('override beats the [1m] marker', () => {
    expect(resolveContextWindowForModel('claude-opus-4-8[1m]', { override: 300_000 })).toBe(300_000)
  })

  test('invalid override (<=0 / NaN) is ignored, model table applies', () => {
    expect(resolveContextWindowForModel('claude-fable-5', { override: 0 })).toBe(1_000_000)
    expect(resolveContextWindowForModel('claude-fable-5', { override: Number.NaN })).toBe(1_000_000)
  })

  test('override is floored', () => {
    expect(resolveContextWindowForModel('gpt-5', { override: 250_000.9 })).toBe(250_000)
  })
})

describe('resolveContextWindowOverride — config + env chain', () => {
  const KEY = 'JARVIS_CONTEXT_WINDOW'
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env[KEY]
    delete process.env[KEY]
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
  })

  test('config value present → returned', () => {
    expect(resolveContextWindowOverride(cfg(750_000))).toBe(750_000)
  })

  test('config absent, no env → undefined', () => {
    expect(resolveContextWindowOverride(cfg(undefined))).toBeUndefined()
  })

  test('env var used when config absent', () => {
    process.env[KEY] = '1000000'
    expect(resolveContextWindowOverride(cfg(undefined))).toBe(1_000_000)
  })

  test('config wins over env', () => {
    process.env[KEY] = '1000000'
    expect(resolveContextWindowOverride(cfg(200_000))).toBe(200_000)
  })

  test('invalid env (non-numeric / <=0) ignored → undefined', () => {
    process.env[KEY] = 'lots'
    expect(resolveContextWindowOverride(cfg(undefined))).toBeUndefined()
    process.env[KEY] = '0'
    expect(resolveContextWindowOverride(cfg(undefined))).toBeUndefined()
  })

  test('resolveContextWindowTokens applies the 200k default when nothing set', () => {
    expect(resolveContextWindowTokens(cfg(undefined))).toBe(200_000)
  })

  test('resolveContextWindowTokens honors the env override', () => {
    process.env[KEY] = '1000000'
    expect(resolveContextWindowTokens(cfg(undefined))).toBe(1_000_000)
  })
})
