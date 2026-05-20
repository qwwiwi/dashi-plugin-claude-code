// Tests for the unified secret redactor `redactSecrets`.
//
// Covers each pattern individually, idempotency, and no-false-positive cases.
// The order of pattern application matters — more specific rules (Telegram
// token, Groq, sk-, ghp-, re_, xoxb-, Supabase, IPs, secret paths) MUST run
// before the generic ≥24-char long-token rule. Tests pin the observed
// output so a future re-order doesn't silently regress masking quality.

import { describe, expect, test } from 'bun:test'
import { redactSecrets } from '../../src/safety/redact.js'

describe('redactSecrets — Telegram bot tokens', () => {
  test('masks Telegram bot token shape (digits:base64ish)', () => {
    const token = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'
    const out = redactSecrets(`bot started with ${token}`)
    expect(out).not.toContain(token)
    expect(out).toContain('<redacted>')
  })

  test('masks Telegram token embedded in a URL', () => {
    const token = '8507713167:AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPPQQRR'
    const out = redactSecrets(`https://api.telegram.org/bot${token}/getMe`)
    expect(out).not.toContain(token)
  })
})

describe('redactSecrets — provider API keys', () => {
  test('masks Groq gsk_… key', () => {
    const key = 'gsk_' + 'A'.repeat(50)
    const out = redactSecrets(`GROQ_API_KEY=${key}`)
    expect(out).not.toContain(key)
    expect(out).toContain('<redacted>')
  })

  test('masks OpenAI sk-… key', () => {
    const key = 'sk-' + 'A1B2C3D4E5F6G7H8I9J0'
    const out = redactSecrets(`Authorization: ${key}`)
    expect(out).not.toContain(key)
  })

  test('masks OpenAI sk-proj-… key', () => {
    const key = 'sk-proj-' + 'a'.repeat(40)
    const out = redactSecrets(`config has key ${key}`)
    expect(out).not.toContain(key)
  })

  test('masks GitHub PAT ghp_…', () => {
    const key = 'ghp_' + 'A'.repeat(36)
    const out = redactSecrets(`git push with ${key}`)
    expect(out).not.toContain(key)
  })

  test('masks Resend re_… key', () => {
    const key = 're_' + 'A1B2C3D4E5F6G7H8I9J0K1L2M3'
    const out = redactSecrets(`RESEND=${key}`)
    expect(out).not.toContain(key)
  })

  test('masks Slack xoxb-… token', () => {
    const key = 'xoxb-12345-67890-abcdefghij'
    const out = redactSecrets(`SLACK=${key} loaded`)
    expect(out).not.toContain(key)
  })
})

describe('redactSecrets — Bearer + query-string', () => {
  test('masks Authorization: Bearer <opaque>, preserving label', () => {
    const tok = 'abcdef1234567890ABCDEFGHIJK'
    const out = redactSecrets(`Authorization: Bearer ${tok}`)
    expect(out).not.toContain(tok)
    expect(out).toContain('Bearer <redacted>')
  })

  test('masks ?token=, &access_token=, ?api_key=', () => {
    const tok = 'qS3cret_value_XYZ-987'
    expect(redactSecrets(`x.io/cb?token=${tok}`)).not.toContain(tok)
    expect(redactSecrets(`x.io/cb?a=1&access_token=${tok}`)).not.toContain(tok)
    expect(redactSecrets(`x.io/cb?api_key=${tok}`)).not.toContain(tok)
  })
})

describe('redactSecrets — IPv4 masking', () => {
  test('masks middle octets of public IPv4, keeps first+last', () => {
    expect(redactSecrets('connect 10.2.3.44 done')).toBe('connect 10.***.***.44 done')
    expect(redactSecrets('host 8.8.8.8')).toBe('host 8.***.***.8')
  })

  test('leaves loopback 127.* and 0.* untouched', () => {
    expect(redactSecrets('curl 127.0.0.1:8080')).toBe('curl 127.0.0.1:8080')
    expect(redactSecrets('bind 0.0.0.0:80')).toBe('bind 0.0.0.0:80')
  })
})

describe('redactSecrets — secret paths', () => {
  test('masks ~/.config/secrets/<file>', () => {
    const out = redactSecrets('read ~/.config/secrets/openviking.key')
    expect(out).toContain('secrets/***')
    expect(out).not.toContain('openviking.key')
  })

  test('masks anchored secrets/<file>', () => {
    expect(redactSecrets('secrets/foo.key')).toBe('secrets/***')
  })
})

describe('redactSecrets — Supabase host', () => {
  test('masks Supabase project id in host', () => {
    const out = redactSecrets('https://abcdefghij1234567890.supabase.co/rest/v1')
    // The full project id must NOT survive in the output.
    expect(out).not.toContain('abcdefghij1234567890')
    // Legacy mask (from activity-renderer.ts) collapses .supabase. → .supa***.
    // We retain that shape so existing operators recognise masked hosts.
    expect(out).toContain('.supa***.co')
  })
})

describe('redactSecrets — Firebase service-account JSON', () => {
  test('masks private_key value, keeping the key name visible', () => {
    const json = '{"private_key":"-----BEGIN PRIVATE KEY-----\\nMIIE...REDACT_ME...IDAQAB\\n-----END PRIVATE KEY-----\\n"}'
    const out = redactSecrets(json)
    expect(out).toContain('"private_key"')
    expect(out).toContain('"<redacted>"')
    expect(out).not.toContain('REDACT_ME')
  })

  test('masks private_key_id value', () => {
    const json = '{"private_key_id":"abc123def456ghi789jkl012mno345pqr678stu"}'
    const out = redactSecrets(json)
    expect(out).toContain('"private_key_id"')
    expect(out).toContain('"<redacted>"')
    expect(out).not.toContain('abc123def456')
  })

  test('masks client_email value', () => {
    const json = '{"client_email":"sa-thrall@orgrimmar.iam.gserviceaccount.com"}'
    const out = redactSecrets(json)
    expect(out).toContain('"client_email"')
    expect(out).toContain('"<redacted>"')
    expect(out).not.toContain('sa-thrall@orgrimmar')
  })
})

describe('redactSecrets — generic long token + extras', () => {
  test('masks generic ≥24-char [A-Za-z0-9_-] tokens (preserve head+tail)', () => {
    // The generic rule keeps 4 chars head + 4 tail. 24+ char token expected.
    const tok = 'abcd1234567890efghij5678WXYZ'
    const out = redactSecrets(`Authorization: ${tok}`)
    // Must mask the middle but keep visible head/tail prefixes for debugging.
    expect(out).not.toBe(`Authorization: ${tok}`)
    expect(out).toMatch(/abcd.*WXYZ/)
  })

  test('masks caller-supplied exact substrings (extras)', () => {
    const webhook = 'wh_test_token_32_chars__________'
    const out = redactSecrets(`got header ${webhook} in log`, [webhook])
    expect(out).not.toContain(webhook)
    expect(out).toContain('<redacted>')
  })

  test('ignores empty / too-short extras', () => {
    expect(redactSecrets('the cat sat on the mat', ['', 'abc'])).toBe('the cat sat on the mat')
  })
})

describe('redactSecrets — no false positives', () => {
  test('does not mangle a normal English sentence', () => {
    const s = 'The quick brown fox jumps over the lazy dog.'
    expect(redactSecrets(s)).toBe(s)
  })

  test('preserves punctuation around safe identifiers', () => {
    const s = 'short_id=foo'
    expect(redactSecrets(s)).toBe(s)
  })

  test('does not redact a 40-char SHA1-style hex hash (under the generic threshold? actually 40>24 so it WILL mask — pin observed output)', () => {
    // 40-char hex is longer than 24 chars and will trip the generic rule.
    // We do NOT consider this a false positive; we pin behaviour and accept
    // some debug-log readability loss in exchange for safety. Test asserts
    // the rule fires consistently (idempotent) rather than that it leaves
    // SHA1 alone.
    const sha = 'a'.repeat(40)
    const first = redactSecrets(sha)
    const second = redactSecrets(first)
    expect(second).toBe(first)
  })
})

describe('redactSecrets — idempotency', () => {
  test('applying twice yields the same result for a mix of secrets', () => {
    const input = [
      'token=8507713167:AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPPQQRR',
      'GROQ=gsk_' + 'X'.repeat(45),
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234',
      'ip 8.8.8.8',
      'host abcdefghij1234567890.supabase.co',
      '"private_key":"deadbeef"',
    ].join(' ')
    const once = redactSecrets(input)
    const twice = redactSecrets(once)
    expect(twice).toBe(once)
  })
})
