// Tests for the unified secret redactor `redactSecrets`.
//
// Covers each pattern individually, idempotency, and no-false-positive cases.
// The order of pattern application matters — more specific rules (Telegram
// token, Groq, sk-, ghp-, re_, xoxb-, Supabase, IPs, secret paths) MUST run
// before the generic ≥24-char long-token rule. Tests pin the observed
// output so a future re-order doesn't silently regress masking quality.

import { describe, expect, test } from 'bun:test'
import { redactSecrets } from '../../src/safety/redact.js'
import { validateTelegramHtml } from '../../src/safety/html-validator.js'

describe('redactSecrets — Telegram bot tokens', () => {
  test('masks Telegram bot token shape (digits:base64ish)', () => {
    const token = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'
    const out = redactSecrets(`bot started with ${token}`)
    expect(out).not.toContain(token)
    expect(out).toContain('[REDACTED]')
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
    expect(out).toContain('[REDACTED]')
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
    expect(out).toContain('Bearer [REDACTED]')
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
    expect(out).toContain('"[REDACTED]"')
    expect(out).not.toContain('REDACT_ME')
  })

  test('masks private_key_id value', () => {
    const json = '{"private_key_id":"abc123def456ghi789jkl012mno345pqr678stu"}'
    const out = redactSecrets(json)
    expect(out).toContain('"private_key_id"')
    expect(out).toContain('"[REDACTED]"')
    expect(out).not.toContain('abc123def456')
  })

  test('masks client_email value', () => {
    const json = '{"client_email":"sa-thrall@orgrimmar.iam.gserviceaccount.com"}'
    const out = redactSecrets(json)
    expect(out).toContain('"client_email"')
    expect(out).toContain('"[REDACTED]"')
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
    expect(out).toContain('[REDACTED]')
  })

  test('ignores empty / too-short extras', () => {
    expect(redactSecrets('the cat sat on the mat', ['', 'abc'])).toBe('the cat sat on the mat')
  })
})

describe('redactSecrets — URL exemption for the generic long-token rule', () => {
  // 2026-06-05: the generic rule masked repo slugs inside GitHub links
  // (`dashi-plugin-claude-code` → `dash***code`), producing dead URLs the
  // warchief could not open. Long path segments inside http(s) URLs are
  // exempt from the GENERIC rule only — every specific rule still fires.

  test('GitHub PR link with a long repo slug survives intact', () => {
    const url = 'https://github.com/qwwiwi/dashi-plugin-claude-code/pull/49'
    expect(redactSecrets(`PR готов: ${url}`)).toBe(`PR готов: ${url}`)
  })

  test('commit-SHA URL survives intact', () => {
    const url =
      'https://github.com/qwwiwi/dashi-plugin-claude-code/commit/' +
      'a'.repeat(40)
    expect(redactSecrets(url)).toBe(url)
  })

  test('the same long token OUTSIDE a URL is still masked', () => {
    const out = redactSecrets(
      'slug dashi-plugin-claude-code and https://github.com/qwwiwi/dashi-plugin-claude-code',
    )
    // Plain-text occurrence masked…
    expect(out).toContain('dash***code and')
    // …URL occurrence intact.
    expect(out).toContain(
      'https://github.com/qwwiwi/dashi-plugin-claude-code',
    )
  })

  test('?token= query param inside a URL is STILL redacted', () => {
    const out = redactSecrets(
      'https://example.com/hook?token=supersecretvalue123456',
    )
    expect(out).not.toContain('supersecretvalue123456')
    expect(out).toContain('?token=')
  })

  test('Telegram bot token inside a URL is STILL redacted', () => {
    const out = redactSecrets(
      'https://api.telegram.org/bot8507713167:AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPPQQRR/sendMessage',
    )
    expect(out).not.toContain('AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPPQQRR')
  })

  test('GitHub PAT inside a URL is STILL redacted', () => {
    const out = redactSecrets(
      `https://ghp_${'Z'.repeat(36)}@github.com/qwwiwi/repo.git`,
    )
    expect(out).not.toContain('Z'.repeat(36))
  })

  test('extras (exact-substring secrets) inside a URL are STILL redacted', () => {
    const secret = 'wh_exact_secret_value_42'
    const out = redactSecrets(`https://example.com/hook/${secret}`, [secret])
    expect(out).not.toContain(secret)
  })

  test('URL exemption is idempotent', () => {
    const input =
      'see https://github.com/qwwiwi/dashi-plugin-claude-code/pull/49 and token abcd1234567890efghij5678WXYZ'
    const once = redactSecrets(input)
    const twice = redactSecrets(once)
    expect(twice).toBe(once)
  })

  // ── Codex security review (2026-06-05): URL-borne secret shapes the
  //    exemption must NOT leak ─────────────────────────────────────────

  test('basic-auth password in URL userinfo is redacted, user kept', () => {
    const out = redactSecrets(
      'https://deploy:hunter2secret@registry.example.com/v2/',
    )
    expect(out).not.toContain('hunter2secret')
    expect(out).toContain('https://deploy:')
    expect(out).toContain('@registry.example.com')
  })

  test('JWT inside a URL path/fragment is redacted', () => {
    const jwt = `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(12)}`
    const out = redactSecrets(
      `https://app.example.com/callback#access_token=${jwt} and bare ${jwt}`,
    )
    expect(out).not.toContain(jwt)
  })

  test('signed-URL params (sig / X-Amz-Signature) are redacted', () => {
    const out = redactSecrets(
      'https://bucket.s3.amazonaws.com/file?X-Amz-Signature=deadbeefcafe123456&sig=abc123def456',
    )
    expect(out).not.toContain('deadbeefcafe123456')
    expect(out).not.toContain('abc123def456')
  })

  test('fragment access_token is redacted', () => {
    const out = redactSecrets(
      'https://app.example.com/cb#access_token=secrettokenvalue&state=xyz',
    )
    expect(out).not.toContain('secrettokenvalue')
  })

  test('Discord and Slack webhook path tokens are redacted', () => {
    const out = redactSecrets(
      [
        'https://discord.com/api/webhooks/123456789/AbCdEf-Gh_IjKlMnOpQrStUvWxYz123',
        'https://hooks.slack.com/services/T0001/B0001/XXXXXXXXXXXXXXXXXXXXXXXX',
      ].join(' '),
    )
    expect(out).not.toContain('AbCdEf-Gh_IjKlMnOpQrStUvWxYz123')
    expect(out).not.toContain('XXXXXXXXXXXXXXXXXXXXXXXX')
    // Host + route stay visible for debugging.
    expect(out).toContain('discord.com/api/webhooks/123456789/')
    expect(out).toContain('hooks.slack.com/services/')
  })

  test('comma cannot glue a secret into the exempt URL range', () => {
    const secret = 'SECRET_0123456789012345678901234567'
    const out = redactSecrets(`https://github.com/org/repo,${secret}`)
    expect(out).not.toContain(secret)
    expect(out).toContain('https://github.com/org/repo')
  })

  test('trailing punctuation does not extend the exemption', () => {
    // URL ends with "." — the next long token after whitespace is NOT
    // part of the link and must still be masked.
    const out = redactSecrets(
      'https://github.com/qwwiwi/dashi-plugin-claude-code/pull/49. Token abcd1234567890efghij5678WXYZ',
    )
    expect(out).toContain('dashi-plugin-claude-code/pull/49.')
    expect(out).toContain('abcd***WXYZ')
  })

  test('URL-borne secret redaction is idempotent', () => {
    const jwt = `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(12)}`
    const input = [
      'https://deploy:hunter2secret@host.example.com/x',
      `https://app.example.com/cb#access_token=${jwt}`,
      'https://discord.com/api/webhooks/42/tok_enva_lue123456789',
      'https://github.com/qwwiwi/dashi-plugin-claude-code/pull/49,SECRET_0123456789012345678901234567',
    ].join(' ')
    const once = redactSecrets(input)
    const twice = redactSecrets(once)
    expect(twice).toBe(once)
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

describe('redactSecrets — HTML-neutral marker', () => {
  // Codex L1: the canonical placeholder must not introduce angle brackets,
  // because redacted output is then handed to the Telegram HTML validator.
  // If the marker were '[REDACTED]', a perfectly valid <b>…</b> body would
  // suddenly contain an unknown tag and trip the validator, downgrading
  // the message to plain text.

  test('marker contains no < or > characters', () => {
    const out = redactSecrets('sk-proj-' + 'a'.repeat(40))
    expect(out).not.toContain('<')
    expect(out).not.toContain('>')
    expect(out).toContain('[REDACTED]')
  })

  test('redacted body inside <b>…</b> still passes Telegram HTML validation', () => {
    const tok = 'sk-proj-abc123def456ghi789jklmno'
    const redacted = redactSecrets(`<b>${tok}</b>`)
    // After redaction, the body is `<b>[REDACTED]</b>` — that must pass
    // validation cleanly so the operator's bold-tag isn't wasted by a
    // downgrade caused by the redactor's own marker.
    const validated = validateTelegramHtml(redacted)
    expect(validated.downgraded).toBe(false)
  })

  test('Bearer redaction preserves the prefix shape with the new marker', () => {
    const tok = 'abcdefghijklmnopqrstuvwxyz1234'
    const out = redactSecrets(`Authorization: Bearer ${tok}`)
    expect(out).toContain('Bearer [REDACTED]')
  })

  test('Firebase JSON keys also use the new marker', () => {
    const json = '{"private_key":"deadbeef"}'
    const out = redactSecrets(json)
    expect(out).toContain('"[REDACTED]"')
    // Legacy '<redacted>' marker must be fully retired.
    expect(out).not.toContain('<redacted>')
  })

  test('extras substring uses the new marker too', () => {
    const webhook = 'wh_test_token_32_chars__________'
    const out = redactSecrets(`got header ${webhook} in log`, [webhook])
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain('<redacted>')
  })
})
