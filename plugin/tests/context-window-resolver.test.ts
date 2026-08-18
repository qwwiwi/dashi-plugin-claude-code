// Tests for the model → context-window resolver (config.ts). Covers the family
// table, the [1m] marker, the unknown/absent fallback, and the operator
// override chain (config key + JARVIS_CONTEXT_WINDOW env), which must win over
// model auto-detection so a wrong table guess is always correctable.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  MODEL_CONTEXT_WINDOWS,
  parseLaunchModelFlag,
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

  test('case-insensitive match', () => {
    expect(resolveContextWindowForModel('CLAUDE-FABLE-5')).toBe(1_000_000)
  })

  test('family matches only on token boundaries — no mid-word false positive', () => {
    // 'claude-unfabled-5' contains 'fable' as a raw substring but is NOT a
    // Fable model — must fall through to the 200k default (codex LOW).
    expect(resolveContextWindowForModel('claude-unfabled-5')).toBe(200_000)
    // The real forms still match.
    expect(resolveContextWindowForModel('claude-fable-5')).toBe(1_000_000)
    expect(resolveContextWindowForModel('fable')).toBe(1_000_000)
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

  test('fractional override 0.5 never yields a 0 window — floor happens BEFORE validation', () => {
    // Old order (validate `> 0` then floor) let 0.5 slip through and floor to
    // 0, giving a zero denominator (codex MED). Must be treated as invalid.
    expect(resolveContextWindowForModel('claude-fable-5', { override: 0.5 })).toBe(1_000_000)
    expect(resolveContextWindowForModel('gpt-5', { override: 0.5 })).toBe(200_000)
    // Same rule on fallback: a fractional-below-1 fallback coerces to 200k.
    expect(resolveContextWindowForModel('gpt-5', { fallback: 0.5 })).toBe(200_000)
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

  test('invalid config value (0) falls through to a valid env override', () => {
    // config context_window_tokens: 0 must NOT suppress JARVIS_CONTEXT_WINDOW —
    // an unusable config value falls through to the env check (codex MED).
    process.env[KEY] = '1000000'
    expect(resolveContextWindowOverride(cfg(0))).toBe(1_000_000)
    // And with no env either, an invalid config value means «no override».
    delete process.env[KEY]
    expect(resolveContextWindowOverride(cfg(0))).toBeUndefined()
  })

  test('resolveContextWindowTokens applies the 200k default when nothing set', () => {
    expect(resolveContextWindowTokens(cfg(undefined))).toBe(200_000)
  })

  test('resolveContextWindowTokens honors the env override', () => {
    process.env[KEY] = '1000000'
    expect(resolveContextWindowTokens(cfg(undefined))).toBe(1_000_000)
  })
})

// --- Launch-flag marker (2026-08-18) ---------------------------------------
// Claude Code launched as `--model claude-opus-5[1m]` writes a BARE
// `"model":"claude-opus-5"` into the transcript, so the marker survives only in
// the CLI argv. Without it the HUD showed 200k for a 1M session.

describe('parseLaunchModelFlag', () => {
  test('reads --model <id> and --model=<id>', () => {
    expect(parseLaunchModelFlag(['claude', '--model', 'claude-opus-5[1m]'])).toBe(
      'claude-opus-5[1m]',
    )
    expect(parseLaunchModelFlag(['claude', '--model=claude-opus-5[1m]'])).toBe(
      'claude-opus-5[1m]',
    )
  })

  test('absent / valueless flag → undefined', () => {
    expect(parseLaunchModelFlag(['claude', '--permission-mode', 'bypassPermissions'])).toBeUndefined()
    expect(parseLaunchModelFlag(['claude', '--model'])).toBeUndefined()
    // A following flag is not a value.
    expect(parseLaunchModelFlag(['claude', '--model', '--verbose'])).toBeUndefined()
    expect(parseLaunchModelFlag(['claude', '--model='])).toBeUndefined()
  })

  test('last occurrence wins (CLI flag semantics)', () => {
    expect(parseLaunchModelFlag(['claude', '--model', 'a', '--model', 'b'])).toBe('b')
    // codex LOW: a later MALFORMED --model still overrides the earlier value.
    expect(parseLaunchModelFlag(['claude', '--model', 'a', '--model='])).toBeUndefined()
    expect(parseLaunchModelFlag(['claude', '--model', 'a', '--model', '--verbose'])).toBeUndefined()
  })

  test('option parsing stops at `--`', () => {
    expect(parseLaunchModelFlag(['claude', '--', '--model', 'positional'])).toBeUndefined()
    expect(parseLaunchModelFlag(['claude', '--model', 'a', '--', '--model', 'b'])).toBe('a')
    // codex control round claimed a valueless `--model` SWALLOWS the following
    // `--`; it does not — the branch never advances the index itself, so the
    // terminator is seen on the next iteration. Pinned as a regression test.
    expect(parseLaunchModelFlag(['claude', '--model', '--', '--model', 'b'])).toBeUndefined()
  })
})

describe('resolveContextWindowForModel — launch flag', () => {
  test('bare transcript id + [1m] launch flag for the SAME model → 1M', () => {
    expect(
      resolveContextWindowForModel('claude-opus-5', { launchModel: 'claude-opus-5[1m]' }),
    ).toBe(1_000_000)
    // Case-insensitive, and the real tmux argv form.
    expect(
      resolveContextWindowForModel('CLAUDE-OPUS-5', { launchModel: 'claude-opus-5[1m]' }),
    ).toBe(1_000_000)
  })

  test('launch flag WITHOUT the marker changes nothing', () => {
    expect(
      resolveContextWindowForModel('claude-opus-5', { launchModel: 'claude-opus-5' }),
    ).toBe(200_000)
  })

  // codex HIGH 2026-08-18: a family match in either direction let a short alias
  // claim 1M for every model of that family. Exact id equality only.
  test('a short alias launch flag does NOT prove 1M for a concrete id', () => {
    expect(resolveContextWindowForModel('claude-opus-5', { launchModel: 'opus[1m]' })).toBe(200_000)
    expect(resolveContextWindowForModel('opus', { launchModel: 'claude-opus-5[1m]' })).toBe(200_000)
  })

  test('a DIFFERENT model now serving does not inherit the launch window', () => {
    // Mid-session /model switch: launched opus-5[1m], sonnet is serving.
    expect(
      resolveContextWindowForModel('claude-sonnet-5', { launchModel: 'claude-opus-5[1m]' }),
    ).toBe(200_000)
    expect(
      resolveContextWindowForModel('claude-opus-4-6', { launchModel: 'claude-opus-5[1m]' }),
    ).toBe(200_000)
  })

  test('operator override still wins over the launch flag', () => {
    expect(
      resolveContextWindowForModel('claude-opus-5', {
        launchModel: 'claude-opus-5[1m]',
        override: 300_000,
      }),
    ).toBe(300_000)
  })

  test('absent model with a [1m] launch flag stays on the fallback', () => {
    expect(
      resolveContextWindowForModel(undefined, { launchModel: 'claude-opus-5[1m]' }),
    ).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS)
  })
})
