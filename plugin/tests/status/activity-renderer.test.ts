// Phase 7 / T2 — humanization + rolling activity render.

import { describe, expect, test } from 'bun:test'

import {
  buildActivityDetail,
  buildHumanizedActivityLine,
  humanizeTool,
  maskSecrets,
  renderActivityBlock,
  summarizeToolInput,
  type ActivitySnapshot,
} from '../../src/status/activity-renderer.js'

describe('maskSecrets', () => {
  test('masks IPv4 keeping first and last octet', () => {
    expect(maskSecrets('connect 10.2.3.44 done')).toBe('connect 10.***.***.44 done')
  })

  test('masks secret paths (direct ~/.foo/secrets/...)', () => {
    // Python regex `(~/?\.\w+/)secrets/\S+` matches a single dot-prefixed
    // segment immediately before `secrets/`. Deep paths (e.g.
    // `~/.claude-lab/silvana/secrets/...`) intentionally fall through to
    // the generic-long-token rule instead.
    expect(maskSecrets('~/.config/secrets/openviking.key')).toContain('secrets/***')
    expect(maskSecrets('~/.config/secrets/openviking.key')).not.toContain('openviking.key')
  })

  test('masks anchored secrets/<file> after path summarization (regression)', () => {
    // After lastTwoSegments collapse, an absolute path like
    // /Users/x/.claude-lab/silvana/secrets/openviking.key becomes
    // `secrets/openviking.key` — the legacy `~/.foo/secrets/...` rule no
    // longer matches. Broadened rule must mask the filename.
    expect(maskSecrets('read secrets/openviking.key')).toContain('secrets/***')
    expect(maskSecrets('read secrets/openviking.key')).not.toContain('openviking.key')
    // Bare leading form (no preceding space) — first char of string anchors too.
    expect(maskSecrets('secrets/foo.key')).toBe('secrets/***')
  })

  test('masks generic long tokens (≥24 chars)', () => {
    // PR-A1: after unifying maskSecrets through redactSecrets, the Bearer
    // rule (now part of the shared pipeline) hard-redacts the token when
    // it follows the literal word "bearer" — better than the legacy soft
    // partial-mask. Use a no-Bearer-prefix input to exercise the generic
    // long-token rule explicitly.
    const tok = `abcd${'x'.repeat(20)}wxyz`
    const masked = maskSecrets(`token= ${tok} ok`)
    expect(masked).not.toContain(tok)
    expect(masked).toContain('abcd***wxyz')
  })

  test('hard-redacts Bearer prefix token (regression: unified pipeline)', () => {
    // Documents the post-PR-A1 behaviour: "Bearer <opaque>" → "Bearer [REDACTED]".
    // Legacy maskSecrets only had the generic long-token rule and would have
    // produced `abcd***wxyz`. Unified pipeline is strictly more aggressive.
    const tok = `abcd${'x'.repeat(20)}wxyz`
    const masked = maskSecrets(`bearer ${tok} ok`)
    expect(masked).not.toContain(tok)
    // The redactor preserves the prefix label but the marker is upper-case
    // [REDACTED]. Match on the casing the redactor produces.
    expect(masked).toContain('bearer [REDACTED]')
  })

  test('does not mangle short identifiers', () => {
    expect(maskSecrets('short_id=foo')).toBe('short_id=foo')
  })

  test('masks Telegram bot token (generic-long covers the secret half)', () => {
    // Python order: IPv4 → secret-paths → generic-long → bot-token. The
    // generic-long rule consumes the alphanumeric run after the colon
    // before bot-token can match. Both behaviours mask the secret payload
    // (`AAH-fake_test_token...`) — verify the secret is gone, regardless
    // of which rule fired.
    const tok = '1234567890:AAH-fake_test_token_with_at_least_thirty_chars'
    const masked = maskSecrets(`Authorization: ${tok}`)
    expect(masked).not.toContain('AAH-fake_test_token')
    expect(masked).not.toContain('thirty_chars')
  })

  test('masks Supabase host project id', () => {
    const masked = maskSecrets('https://abcdefghij1234567890.supabase.co/rest/v1')
    expect(masked).not.toContain('abcdefghij1234567890.supabase.co')
    expect(masked).toContain('*****')
  })
})

describe('summarizeToolInput', () => {
  test('Read returns last two path segments', () => {
    expect(summarizeToolInput('Read', { file_path: '/a/b/c/server.ts' })).toBe('c/server.ts')
  })

  test('Read accepts `path` fallback and normalizes backslashes', () => {
    expect(summarizeToolInput('Read', { path: 'src\\\\foo\\\\bar.ts' })).toBe('foo/bar.ts')
  })

  test('Bash truncates to 40', () => {
    const long = 'a'.repeat(80)
    expect(summarizeToolInput('Bash', { command: long }).length).toBeLessThanOrEqual(40)
  })

  test('Grep wraps pattern in quotes (raw, render escapes)', () => {
    // summarizeToolInput returns the RAW logical content (no HTML escape).
    // Escaping happens exactly once in renderActivityBlock.
    expect(summarizeToolInput('Grep', { pattern: 'TODO' })).toBe('"TODO"')
  })

  test('Agent uses subagent_type', () => {
    expect(summarizeToolInput('Agent', { subagent_type: 'researcher' })).toBe('researcher')
  })

  test('WebFetch returns host', () => {
    expect(summarizeToolInput('WebFetch', { url: 'https://example.com/path?x=1' })).toBe('example.com')
  })

  test('Unknown tool produces bounded safe summary', () => {
    const out = summarizeToolInput('Hypothetical', { a: 'one', b: 2, c: false, d: 'longvalue' })
    expect(out.length).toBeLessThanOrEqual(40)
    expect(out).toContain('a=one')
  })

  test('Unknown tool with empty input returns empty string', () => {
    expect(summarizeToolInput('Hypothetical', {})).toBe('')
  })

  test('returns raw text (renderer escapes once)', () => {
    // No HTML escape here — render boundary is the only escape site.
    expect(summarizeToolInput('Bash', { command: '<script>' })).toBe('<script>')
  })
})

describe('humanizeTool', () => {
  test('Bash curl → calling API', () => {
    expect(humanizeTool('Bash', { command: 'curl https://x' })).toBe('calling API')
  })

  test('Bash git → git command', () => {
    expect(humanizeTool('Bash', { command: 'git status --short' })).toBe('git command')
  })

  test('Bash read-like → reading files', () => {
    expect(humanizeTool('Bash', { command: 'cat /etc/hosts' })).toBe('reading files')
  })

  test('Bash other → masked running:', () => {
    const out = humanizeTool('Bash', { command: 'echo helloworld' })
    expect(out).toContain('running:')
    expect(out).toContain('<code>')
  })

  test('Bash running: truncates to 60 and masks long token', () => {
    const tok = `abcd${'x'.repeat(20)}wxyz`
    const out = humanizeTool('Bash', { command: `echo ${tok}` }) ?? ''
    expect(out).not.toContain(tok)
  })

  test('Read returns basename only', () => {
    expect(humanizeTool('Read', { file_path: '/repo/a/b/server.ts' })).toBe('reading <code>server.ts</code>')
  })

  test('Read without file_path falls back', () => {
    expect(humanizeTool('Read', {})).toBe('reading file')
  })

  test('Write, Edit, MultiEdit return creating/editing labels', () => {
    expect(humanizeTool('Write', { file_path: '/x/y.txt' })).toBe('creating <code>y.txt</code>')
    expect(humanizeTool('Edit', { file_path: '/x/y.txt' })).toBe('editing <code>y.txt</code>')
    expect(humanizeTool('MultiEdit', { file_path: '/x/y.txt' })).toBe('editing <code>y.txt</code>')
  })

  test('Agent uses SUBAGENT_LABELS map', () => {
    expect(humanizeTool('Agent', { subagent_type: 'researcher' })).toBe(
      '<b>searching and verifying sources</b>',
    )
  })

  test('Agent unknown subagent_type falls back to "running X"', () => {
    expect(humanizeTool('Agent', { subagent_type: 'mystery' })).toBe('<b>running mystery</b>')
  })

  test('TodoWrite and unknown tools return null', () => {
    expect(humanizeTool('TodoWrite', { todos: [] })).toBeNull()
    expect(humanizeTool('Hypothetical', {})).toBeNull()
  })

  test('WebSearch wraps query in <i>', () => {
    expect(humanizeTool('WebSearch', { query: 'latest news' })).toBe(
      'web search: <i>latest news</i>',
    )
  })
})

describe('renderActivityBlock', () => {
  const baseStart = 1_000_000_000_000

  test('no calls, reasoning phase, 0s', () => {
    const snap: ActivitySnapshot = {
      startedAtMs: baseStart,
      calls: [],
      phase: 'reasoning',
    }
    const out = renderActivityBlock(snap, baseStart)
    expect(out).toContain('working -- 0s')
    expect(out).toContain('reasoning...')
    expect(out.startsWith('<pre>')).toBe(true)
    expect(out.endsWith('</pre>')).toBe(true)
  })

  test('renders last 5 calls with arrow prefix', () => {
    const snap: ActivitySnapshot = {
      startedAtMs: baseStart,
      calls: [
        { toolName: 'Read', detail: 'read a.ts' },
        { toolName: 'Read', detail: 'read b.ts' },
        { toolName: 'Bash', detail: 'bash bun test' },
      ],
      phase: 'tool',
    }
    const out = renderActivityBlock(snap, baseStart + 12_000)
    expect(out).toContain('working -- 12s')
    expect(out).toContain('▸ read a.ts')
    expect(out).toContain('▸ bash bun test')
  })

  test('rolling overflow shows +N earlier', () => {
    const snap: ActivitySnapshot = {
      startedAtMs: baseStart,
      calls: [
        { toolName: 'Bash', detail: 'bash one' },
        { toolName: 'Bash', detail: 'bash two' },
        { toolName: 'Bash', detail: 'bash three' },
        { toolName: 'Grep', detail: 'grep four' },
        { toolName: 'Read', detail: 'read five' },
        { toolName: 'Edit', detail: 'edit six' },
        { toolName: 'Bash', detail: 'bash seven' },
        { toolName: 'Bash', detail: 'bash eight' },
      ],
      phase: 'tool',
    }
    const out = renderActivityBlock(snap, baseStart + 25_000)
    expect(out).toContain('working -- 25s')
    expect(out).toContain('+3 earlier')
    expect(out).toContain('▸ bash eight')
    expect(out).not.toContain('bash one')
  })

  test('masks secrets in detail before render', () => {
    const tok = `abcd${'x'.repeat(20)}wxyz`
    const snap: ActivitySnapshot = {
      startedAtMs: baseStart,
      calls: [{ toolName: 'Bash', detail: `bash echo ${tok}` }],
      phase: 'tool',
    }
    const out = renderActivityBlock(snap, baseStart + 1_000)
    expect(out).not.toContain(tok)
  })

  test('escapes HTML in <pre> body', () => {
    const snap: ActivitySnapshot = {
      startedAtMs: baseStart,
      calls: [{ toolName: 'Bash', detail: 'bash <script>' }],
      phase: 'tool',
    }
    const out = renderActivityBlock(snap, baseStart)
    expect(out).toContain('&lt;script&gt;')
    expect(out).not.toContain('<script>')
  })
})

describe('buildActivityDetail', () => {
  test('lowercases tool name + summary', () => {
    expect(buildActivityDetail('Bash', { command: 'bun test' })).toBe('bash bun test')
  })

  test('omits summary if empty', () => {
    expect(buildActivityDetail('Read', {})).toBe('read')
  })
})

describe('secret-path leak after summarization (regression)', () => {
  test('Read of /Users/.../secrets/foo.key never reaches render unmasked', () => {
    const absPath = '/Users/jasonqwwen/.claude-lab/silvana/secrets/openviking.key'
    const detail = buildActivityDetail('Read', { file_path: absPath })
    // Buffer-level: filename must be masked at store time.
    expect(detail).not.toContain('openviking.key')
    expect(detail).toContain('secrets/***')
    const snap: ActivitySnapshot = {
      startedAtMs: 0,
      calls: [{ toolName: 'Read', detail }],
      phase: 'tool',
    }
    const out = renderActivityBlock(snap, 0)
    expect(out).not.toContain('openviking.key')
    expect(out).toContain('secrets/***')
  })
})

describe('humanized lines wired into render (M1)', () => {
  // Wiring test — renderer must surface humanizeTool output on lines that
  // carry a `humanized` HTML string, and fall back to the plain detail
  // path for tools that don't have a richer label (TodoWrite, unknown).

  test('Bash humanized line emits `running: <code>cmd</code>` inside <pre>', () => {
    const humanized = buildHumanizedActivityLine('Bash', { command: 'bun test' })
    expect(humanized).toBe('running: <code>bun test</code>')
    const snap: ActivitySnapshot = {
      startedAtMs: 0,
      calls: [{ toolName: 'Bash', detail: 'bash bun test', humanized }],
      phase: 'tool',
    }
    const out = renderActivityBlock(snap, 0)
    expect(out).toContain('▸ running: <code>bun test</code>')
    // Plain detail string is no longer the primary surface.
    expect(out).not.toContain('▸ bash bun test')
  })

  test('Agent humanized line uses SUBAGENT_LABELS map', () => {
    const humanized = buildHumanizedActivityLine('Agent', { subagent_type: 'researcher' })
    expect(humanized).toBe('<b>searching and verifying sources</b>')
    const snap: ActivitySnapshot = {
      startedAtMs: 0,
      calls: [{ toolName: 'Agent', detail: 'agent researcher', humanized }],
      phase: 'tool',
    }
    const out = renderActivityBlock(snap, 0)
    expect(out).toContain('▸ <b>searching and verifying sources</b>')
  })

  test('TodoWrite returns null → falls back to plain detail with single escape', () => {
    const humanized = buildHumanizedActivityLine('TodoWrite', { todos: [] })
    expect(humanized).toBeNull()
    const snap: ActivitySnapshot = {
      startedAtMs: 0,
      calls: [{ toolName: 'TodoWrite', detail: 'todowrite', humanized }],
      phase: 'tool',
    }
    const out = renderActivityBlock(snap, 0)
    expect(out).toContain('▸ todowrite')
  })

  test('Unknown tool returns null → falls back to plain detail', () => {
    const humanized = buildHumanizedActivityLine('Hypothetical', { a: 1 })
    expect(humanized).toBeNull()
    const snap: ActivitySnapshot = {
      startedAtMs: 0,
      calls: [{ toolName: 'Hypothetical', detail: 'hypothetical a=1', humanized }],
      phase: 'tool',
    }
    const out = renderActivityBlock(snap, 0)
    expect(out).toContain('▸ hypothetical a=1')
  })

  test('humanized line still masks long tokens after the fact', () => {
    // buildHumanizedActivityLine applies mask at construction. Render
    // re-masks defensively — verify a token added to humanized later still
    // gets eaten by the render pass.
    const tok = `abcd${'x'.repeat(20)}wxyz`
    const snap: ActivitySnapshot = {
      startedAtMs: 0,
      calls: [{ toolName: 'Bash', detail: '', humanized: `running: <code>${tok}</code>` }],
      phase: 'tool',
    }
    const out = renderActivityBlock(snap, 0)
    expect(out).not.toContain(tok)
    expect(out).toContain('abcd***wxyz')
  })
})

describe('renderActivityBlock 4096-char cap (M2)', () => {
  // Defensive — Telegram editMessageText rejects > 4096 chars. We cap the
  // inner body at 3900 to leave room for the wrapping `<pre>` tags + safety.

  test('50 long Bash calls truncate at line boundary with …+truncated marker', () => {
    const big = 'x'.repeat(60)
    const snap: ActivitySnapshot = {
      startedAtMs: 0,
      calls: Array.from({ length: 50 }, (_, i) => ({
        toolName: 'Bash',
        detail: `bash ${i.toString().padStart(3, '0')} ${big}`,
      })),
      phase: 'tool',
    }
    const out = renderActivityBlock(snap, 0)
    expect(out.length).toBeLessThanOrEqual(4096)
    // Truncation marker absent for short outputs — only present when we cut.
    // 50 × 60+ = 3000+; with rolling window of 5 we only render 5 → no
    // truncation in practice. Force a real overflow with humanized payload.
    // Use punctuation-broken filler so the generic long-token mask (which
    // chews ≥24-char `[A-Za-z0-9_-]` runs) doesn't collapse it.
    const filler = ('AB. '.repeat(400)).slice(0, 1500)
    const snap2: ActivitySnapshot = {
      startedAtMs: 0,
      calls: Array.from({ length: 5 }, (_, i) => ({
        toolName: 'Bash',
        detail: 'b',
        humanized: `running: <code>${filler}-${i}</code>`,
      })),
      phase: 'tool',
    }
    const out2 = renderActivityBlock(snap2, 0)
    expect(out2.length).toBeLessThanOrEqual(4096)
    expect(out2).toContain('…+truncated')
  })

  test('normal-length output gets no truncation marker', () => {
    const snap: ActivitySnapshot = {
      startedAtMs: 0,
      calls: [
        { toolName: 'Bash', detail: 'bash one' },
        { toolName: 'Bash', detail: 'bash two' },
      ],
      phase: 'tool',
    }
    const out = renderActivityBlock(snap, 0)
    expect(out).not.toContain('…+truncated')
  })
})

describe('IPv4 mask exemptions (M3)', () => {
  test('127.x.x.x loopback is NOT masked', () => {
    expect(maskSecrets('curl 127.0.0.1:8080')).toBe('curl 127.0.0.1:8080')
    expect(maskSecrets('hit 127.0.0.1/health')).toBe('hit 127.0.0.1/health')
  })

  test('0.x.x.x placeholder is NOT masked', () => {
    expect(maskSecrets('bind 0.0.0.0:80')).toBe('bind 0.0.0.0:80')
  })

  test('public IPv4 is shown in full; private ranges stay masked', () => {
    expect(maskSecrets('curl 8.8.8.8')).toBe('curl 8.8.8.8')
    expect(maskSecrets('connect 10.2.3.44 done')).toBe('connect 10.***.***.44 done')
  })

  test('::1 IPv6 loopback literal untouched (regex never matched it)', () => {
    expect(maskSecrets('hit [::1]:443')).toBe('hit [::1]:443')
  })

  test('localhost literal untouched', () => {
    expect(maskSecrets('http://localhost:8089')).toBe('http://localhost:8089')
  })
})

describe('full pipeline escape round-trip (regression)', () => {
  // Round-trip: mapper builds detail → renderer assembles <pre> body.
  // Critical bug pre-fix: summarize escaped once, render escaped again,
  // producing `&amp;quot;recordActivity&amp;quot;` instead of
  // `&quot;recordActivity&quot;`. This test feeds a Grep pattern containing
  // a quote through both stages and asserts single escape.
  test('Grep pattern "recordActivity" survives mapper→renderer as single escape', () => {
    const detail = buildActivityDetail('Grep', { pattern: 'recordActivity' })
    const snap: ActivitySnapshot = {
      startedAtMs: 0,
      calls: [{ toolName: 'Grep', detail }],
      phase: 'tool',
    }
    const out = renderActivityBlock(snap, 0)
    // Single escape produces &quot; — double escape produces &amp;quot;
    expect(out).toContain('&quot;recordActivity&quot;')
    expect(out).not.toContain('&amp;quot;')
    expect(out).not.toContain('&amp;amp;')
  })

  test('Bash <script> survives single-escape through full pipeline', () => {
    const detail = buildActivityDetail('Bash', { command: '<script>alert(1)</script>' })
    const snap: ActivitySnapshot = {
      startedAtMs: 0,
      calls: [{ toolName: 'Bash', detail }],
      phase: 'tool',
    }
    const out = renderActivityBlock(snap, 0)
    expect(out).toContain('&lt;script&gt;')
    expect(out).not.toContain('&amp;lt;')
    expect(out).not.toContain('<script>')
  })
})
