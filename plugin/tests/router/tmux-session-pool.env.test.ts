// TASK-6 tests (2026-05-27) — sanitized per-chat tmux env.
//
// We exercise two layers:
//   1. `buildSanitizedTmuxEnv` — pure helper, exhaustive coverage of
//      the allowlist + FORBIDDEN_ENV_REGEX filter without spawning
//      any child process.
//   2. `TmuxSessionPool.getOrSpawn` end-to-end — uses a fake `tmux`
//      binary on PATH that dumps invocation args + child env to a
//      file. Confirms (a) sensitive vars are not forwarded via `-e`
//      flags, (b) sensitive vars are not in the tmux child process'
//      own env, (c) the allowlisted keys ARE forwarded.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { MultichatPolicy } from '../../src/chats/policy-loader.js'
import {
  buildSanitizedTmuxEnv,
  TmuxSessionPool,
  type PoolLogger,
} from '../../src/router/tmux-session-pool.js'

// Resolve the in-repo wrapper script so the leak-closure test can
// invoke it directly. Path is relative to this test file:
// plugin/tests/router/<this> → plugin/scripts/spawn-chat-shell.sh.
const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const SPAWN_WRAPPER = resolve(TEST_DIR, '..', '..', 'scripts', 'spawn-chat-shell.sh')

// ──────────────────────────────────────────────────────────────────────
// Pure helper: buildSanitizedTmuxEnv
// ──────────────────────────────────────────────────────────────────────

describe('buildSanitizedTmuxEnv', () => {
  test('drops TELEGRAM_BOT_TOKEN / OPENAI_API_KEY / GBRAIN_SECRET', () => {
    const parent = {
      PATH: '/usr/bin',
      HOME: '/home/test',
      TELEGRAM_BOT_TOKEN: 'redacted-tg',
      OPENAI_API_KEY: 'sk-redacted',
      GBRAIN_SECRET: 'redacted-gb',
    }
    const { childEnv, forbiddenSeen } = buildSanitizedTmuxEnv(parent)
    expect(childEnv.TELEGRAM_BOT_TOKEN).toBeUndefined()
    expect(childEnv.OPENAI_API_KEY).toBeUndefined()
    expect(childEnv.GBRAIN_SECRET).toBeUndefined()
    expect(forbiddenSeen.sort()).toEqual(
      ['GBRAIN_SECRET', 'OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN'].sort(),
    )
  })

  test('keeps PATH, HOME, USER, LANG, TERM, SHELL, TZ from allowlist', () => {
    const parent = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/test',
      USER: 'test',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      SHELL: '/bin/bash',
      TZ: 'UTC',
    }
    const { childEnv } = buildSanitizedTmuxEnv(parent)
    expect(childEnv.PATH).toBe('/usr/bin:/bin')
    expect(childEnv.HOME).toBe('/home/test')
    expect(childEnv.USER).toBe('test')
    expect(childEnv.LANG).toBe('en_US.UTF-8')
    expect(childEnv.LC_ALL).toBe('en_US.UTF-8')
    expect(childEnv.TERM).toBe('xterm-256color')
    expect(childEnv.SHELL).toBe('/bin/bash')
    expect(childEnv.TZ).toBe('UTC')
  })

  test('drops arbitrary non-allowlisted keys (HOSTNAME, FOO_BAR)', () => {
    const parent = {
      PATH: '/usr/bin',
      HOSTNAME: 'thrall',
      FOO_BAR: 'baz',
      SOMETHING_ELSE: 'value',
    }
    const { childEnv } = buildSanitizedTmuxEnv(parent)
    expect(childEnv.HOSTNAME).toBeUndefined()
    expect(childEnv.FOO_BAR).toBeUndefined()
    expect(childEnv.SOMETHING_ELSE).toBeUndefined()
  })

  test('regex catches *_TOKEN / *_API_KEY / *_SECRET / *_PASSWORD', () => {
    const parent = {
      PATH: '/usr/bin',
      MY_TOKEN: 'x',
      SERVICE_API_KEY: 'x',
      DB_PASSWORD: 'x',
      AUTH_SECRET: 'x',
      SOMETHING_PRIVATE_KEY: 'x',
    }
    const { forbiddenSeen } = buildSanitizedTmuxEnv(parent)
    expect(forbiddenSeen.sort()).toEqual(
      [
        'AUTH_SECRET',
        'DB_PASSWORD',
        'MY_TOKEN',
        'SERVICE_API_KEY',
        'SOMETHING_PRIVATE_KEY',
      ].sort(),
    )
  })

  test('regex catches GBRAIN_* / OPENAI_* / ANTHROPIC_* / TELEGRAM_* prefixes', () => {
    const parent = {
      PATH: '/usr/bin',
      GBRAIN_BEARER: 'x',
      GBRAIN_FOO: 'x',
      OPENAI_ORG: 'x',
      ANTHROPIC_BASE_URL: 'x',
      TELEGRAM_CHAT: 'x',
    }
    const { forbiddenSeen } = buildSanitizedTmuxEnv(parent)
    expect(forbiddenSeen.sort()).toEqual(
      [
        'ANTHROPIC_BASE_URL',
        'GBRAIN_BEARER',
        'GBRAIN_FOO',
        'OPENAI_ORG',
        'TELEGRAM_CHAT',
      ].sort(),
    )
  })

  // ──────────────────────────────────────────────────────────────────
  // Opus MED-B #21 (2026-05-27): broadened regex coverage. Each secret
  // family below MUST be caught by FORBIDDEN_ENV_REGEX even though it
  // does not match a *_TOKEN / *_API_KEY / *_SECRET suffix. These tests
  // failed against the pre-MED-B regex (which only had the GBRAIN/
  // OPENAI/ANTHROPIC/TELEGRAM prefix list) and pass after the prefix +
  // suffix broadening was applied.
  // ──────────────────────────────────────────────────────────────────

  test('MED-B #21: catches AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY', () => {
    const parent = {
      PATH: '/usr/bin',
      AWS_ACCESS_KEY_ID: 'AKIATESTREDACTED',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-redacted',
    }
    const { childEnv, forbiddenSeen } = buildSanitizedTmuxEnv(parent)
    expect(childEnv.AWS_ACCESS_KEY_ID).toBeUndefined()
    expect(childEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(forbiddenSeen).toContain('AWS_ACCESS_KEY_ID')
    expect(forbiddenSeen).toContain('AWS_SECRET_ACCESS_KEY')
  })

  test('MED-B #21: catches NPM_TOKEN', () => {
    const parent = { PATH: '/usr/bin', NPM_TOKEN: 'npm-x' }
    const { childEnv, forbiddenSeen } = buildSanitizedTmuxEnv(parent)
    expect(childEnv.NPM_TOKEN).toBeUndefined()
    expect(forbiddenSeen).toContain('NPM_TOKEN')
  })

  test('MED-B #21: catches SUPABASE_KEY + SUPABASE_SERVICE_ROLE_KEY', () => {
    const parent = {
      PATH: '/usr/bin',
      SUPABASE_KEY: 'sb-key',
      SUPABASE_SERVICE_ROLE_KEY: 'sb-role',
    }
    const { childEnv, forbiddenSeen } = buildSanitizedTmuxEnv(parent)
    expect(childEnv.SUPABASE_KEY).toBeUndefined()
    expect(childEnv.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined()
    expect(forbiddenSeen).toContain('SUPABASE_KEY')
    expect(forbiddenSeen).toContain('SUPABASE_SERVICE_ROLE_KEY')
  })

  test('MED-B #21: catches DATABASE_URL via _URL$ suffix', () => {
    const parent = {
      PATH: '/usr/bin',
      DATABASE_URL: 'postgres://user:pass@host/db',
      REDIS_URL: 'redis://:secret@redis/0',
    }
    const { childEnv, forbiddenSeen } = buildSanitizedTmuxEnv(parent)
    expect(childEnv.DATABASE_URL).toBeUndefined()
    expect(childEnv.REDIS_URL).toBeUndefined()
    expect(forbiddenSeen).toContain('DATABASE_URL')
    expect(forbiddenSeen).toContain('REDIS_URL')
  })

  test('MED-B #21: catches STRIPE_API_KEY (already by suffix) and STRIPE_* prefix', () => {
    const parent = {
      PATH: '/usr/bin',
      STRIPE_API_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
      STRIPE_FOO: 'arbitrary', // prefix-only — caught by STRIPE_ prefix
    }
    const { childEnv, forbiddenSeen } = buildSanitizedTmuxEnv(parent)
    expect(childEnv.STRIPE_API_KEY).toBeUndefined()
    expect(childEnv.STRIPE_WEBHOOK_SECRET).toBeUndefined()
    expect(childEnv.STRIPE_FOO).toBeUndefined()
    expect(forbiddenSeen).toContain('STRIPE_API_KEY')
    expect(forbiddenSeen).toContain('STRIPE_WEBHOOK_SECRET')
    expect(forbiddenSeen).toContain('STRIPE_FOO')
  })

  test('MED-B #21: catches GITHUB_TOKEN + arbitrary GITHUB_* prefix', () => {
    const parent = {
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'ghp_x',
      GITHUB_REPOSITORY: 'qwwiwi/repo', // prefix sweep (acceptable risk)
    }
    const { childEnv, forbiddenSeen } = buildSanitizedTmuxEnv(parent)
    expect(childEnv.GITHUB_TOKEN).toBeUndefined()
    expect(childEnv.GITHUB_REPOSITORY).toBeUndefined()
    expect(forbiddenSeen).toContain('GITHUB_TOKEN')
    expect(forbiddenSeen).toContain('GITHUB_REPOSITORY')
  })

  test('MED-B #21: _URL$ suffix does NOT catch bare URL or BASE_URL without underscore prefix', () => {
    // `URL` alone or `BASE_URL` alone should match `^.+_URL$` only if a
    // non-empty prefix precedes the `_URL`. `BASE_URL` does match
    // (`BASE` is the non-empty prefix), but a plain `URL` does NOT
    // because there is no `_URL` boundary. We do not allowlist either
    // — the test documents the regex behaviour, not desirability.
    const parent = {
      PATH: '/usr/bin',
      URL: 'https://example.com', // not caught (no `_URL` suffix structure)
      BASE_URL: 'https://api.example.com', // caught — matches `^.+_URL$`
    }
    const { forbiddenSeen } = buildSanitizedTmuxEnv(parent)
    expect(forbiddenSeen).not.toContain('URL')
    expect(forbiddenSeen).toContain('BASE_URL')
  })

  test('MED-B #21: legitimate non-secret keys NOT caught (HOSTNAME, HOME, USER, TERM)', () => {
    // Regression guard — the broadened regex must not accidentally
    // hit plain shell metadata keys.
    const parent = {
      PATH: '/usr/bin',
      HOSTNAME: 'thrall',
      HOME: '/home/test',
      USER: 'test',
      TERM: 'xterm',
      SHELL: '/bin/bash',
      LANG: 'en_US.UTF-8',
    }
    const { forbiddenSeen } = buildSanitizedTmuxEnv(parent)
    expect(forbiddenSeen).toEqual([])
  })

  test('empty-string values are dropped (not forwarded as "" )', () => {
    const parent = {
      PATH: '',
      HOME: '/home/test',
    }
    const { childEnv } = buildSanitizedTmuxEnv(parent)
    expect(childEnv.PATH).toBeUndefined()
    expect(childEnv.HOME).toBe('/home/test')
  })

  test('undefined values are dropped', () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      // HOME intentionally absent (undefined)
    }
    const { childEnv } = buildSanitizedTmuxEnv(parent)
    expect(childEnv.PATH).toBe('/usr/bin')
    expect(childEnv.HOME).toBeUndefined()
  })
})

// ──────────────────────────────────────────────────────────────────────
// End-to-end: TmuxSessionPool with a fake `tmux` on PATH
// ──────────────────────────────────────────────────────────────────────
//
// The fake records (a) its argv via `printf` to argv.log and (b) its
// own env via `env` to env.log. By prepending the fake's directory to
// PATH we force the pool to invoke our fake instead of system tmux.

interface FakeTmuxFixture {
  tmpDir: string
  fakeDir: string
  argvLog: string
  envLog: string
  stateDir: string
}

function setupFakeTmux(): FakeTmuxFixture {
  const tmpDir = mkdtempSync(join(tmpdir(), 'tmux-pool-env-test-'))
  const fakeDir = join(tmpDir, 'bin')
  const argvLog = join(tmpDir, 'argv.log')
  const envLog = join(tmpDir, 'env.log')
  const stateDir = join(tmpDir, 'state')

  // Fake tmux: on `has-session` exits non-zero so the pool always
  // thinks the session is dead (forces the spawn path). On every
  // other invocation dumps argv + env to log files and exits 0.
  //
  // We invoke /bin/sh as the bang line for portability; the fake
  // runs synchronously and writes deterministic content.
  const fakeScript = `#!/bin/sh
# Fake tmux for tmux-session-pool.env.test.ts
# Args: $@  /  Env dumped via 'env' builtin to ENV_LOG.
ARGV_LOG="${argvLog}"
ENV_LOG="${envLog}"

if [ "$1" = "has-session" ]; then
  exit 1
fi

# Append a record for each new-session invocation.
printf -- '--- argv ---\\n' >> "$ARGV_LOG"
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "$ARGV_LOG"
done

printf -- '--- env ---\\n' >> "$ENV_LOG"
env >> "$ENV_LOG"

exit 0
`
  // Create fakeDir and the fake binary.
  // We use Bun's writeFileSync + chmod for sync setup.
  // (Test file is run by bun-test, sync APIs are fine for setup.)
  // eslint-disable-next-line no-restricted-syntax
  // ──────────────────────────────────────────────────────────────
  // Note: mkdtempSync gave us tmpDir; the bin subdir we make here.
  // ──────────────────────────────────────────────────────────────
  // Using node:fs sync API via top-level import.
  // (See imports section.)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs')
  fs.mkdirSync(fakeDir, { recursive: true })
  fs.mkdirSync(stateDir, { recursive: true })
  const fakePath = join(fakeDir, 'tmux')
  writeFileSync(fakePath, fakeScript)
  chmodSync(fakePath, 0o755)

  return { tmpDir, fakeDir, argvLog, envLog, stateDir }
}

function cleanupFakeTmux(fx: FakeTmuxFixture): void {
  try {
    rmSync(fx.tmpDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

function nopLogger(): PoolLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  }
}

function makePolicy(chatId: string): MultichatPolicy {
  // Minimum viable policy entry — pool only reads chats[chatId] for
  // existence + idle_ttl_ms. SessionStart hook does the heavy lifting.
  return {
    chats: {
      [chatId]: {
        // Cast-safe: structurally compatible with ChatPolicy. We avoid
        // importing the Zod type to keep this test isolated from
        // policy-loader schema churn.
        idle_ttl_ms: 1_800_000,
      } as MultichatPolicy['chats'][string],
    },
  } as MultichatPolicy
}

describe('TmuxSessionPool end-to-end env sanitization', () => {
  let fixture: FakeTmuxFixture | undefined
  let originalPath: string | undefined

  beforeEach(() => {
    fixture = setupFakeTmux()
    originalPath = process.env.PATH
    process.env.PATH = `${fixture.fakeDir}:${originalPath ?? ''}`
  })

  afterEach(() => {
    if (originalPath !== undefined) {
      process.env.PATH = originalPath
    } else {
      delete process.env.PATH
    }
    // Restore any forbidden test vars we set.
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.OPENAI_API_KEY
    delete process.env.GBRAIN_SECRET
    delete process.env.MULTICHAT_TEST_ALLOWLIST_KEY
    if (fixture !== undefined) cleanupFakeTmux(fixture)
  })

  test('forbidden vars do NOT appear in tmux -e flags or child env', async () => {
    if (fixture === undefined) throw new Error('fixture missing')
    process.env.TELEGRAM_BOT_TOKEN = 'tg-redacted-12345'
    process.env.OPENAI_API_KEY = 'sk-openai-redacted'
    process.env.GBRAIN_SECRET = 'gbrain-redacted'

    const pool = new TmuxSessionPool({
      policy: makePolicy('99999'),
      stateDir: fixture.stateDir,
      workspaceDir: '/tmp/ws',
      chatsBasePath: '/tmp/ws/chats',
      claudeBinary: 'claude',
      logger: nopLogger(),
    })

    await pool.getOrSpawn('99999')

    const argv = readFileSync(fixture.argvLog, 'utf8')
    const env = readFileSync(fixture.envLog, 'utf8')

    // Token VALUES must never appear anywhere — neither as `-e` flag
    // arg nor in the tmux child process env.
    expect(argv).not.toContain('tg-redacted-12345')
    expect(argv).not.toContain('sk-openai-redacted')
    expect(argv).not.toContain('gbrain-redacted')
    expect(env).not.toContain('tg-redacted-12345')
    expect(env).not.toContain('sk-openai-redacted')
    expect(env).not.toContain('gbrain-redacted')

    // Key NAMES must not appear in `-e KEY=VAL` flags either.
    expect(argv).not.toContain('TELEGRAM_BOT_TOKEN=')
    expect(argv).not.toContain('OPENAI_API_KEY=')
    expect(argv).not.toContain('GBRAIN_SECRET=')

    // Key names must not be present in the tmux child env either.
    // (env output is one KEY=VAL per line.)
    expect(env).not.toMatch(/^TELEGRAM_BOT_TOKEN=/m)
    expect(env).not.toMatch(/^OPENAI_API_KEY=/m)
    expect(env).not.toMatch(/^GBRAIN_SECRET=/m)
  })

  test('allowlisted vars (PATH, HOME, USER) DO reach the tmux child env', async () => {
    if (fixture === undefined) throw new Error('fixture missing')

    const pool = new TmuxSessionPool({
      policy: makePolicy('123'),
      stateDir: fixture.stateDir,
      workspaceDir: '/tmp/ws',
      chatsBasePath: '/tmp/ws/chats',
      claudeBinary: 'claude',
      logger: nopLogger(),
    })

    await pool.getOrSpawn('123')

    const argv = readFileSync(fixture.argvLog, 'utf8')
    const env = readFileSync(fixture.envLog, 'utf8')

    // PATH is forwarded via -e (so tmux's per-session env has it).
    expect(argv).toContain('PATH=')
    // PATH also reaches the tmux process env itself.
    expect(env).toMatch(/^PATH=/m)

    // HOME, USER, TERM — at least HOME / USER are virtually always set
    // in the test runner environment, so assert their presence.
    if (process.env.HOME !== undefined) {
      expect(argv).toContain(`HOME=${process.env.HOME}`)
      expect(env).toMatch(/^HOME=/m)
    }
    if (process.env.USER !== undefined && process.env.USER !== '') {
      expect(argv).toContain(`USER=${process.env.USER}`)
      expect(env).toMatch(/^USER=/m)
    }
  })

  test('chat-specific vars (CHAT_ID, MULTICHAT_STATE_DIR, CLAUDE_WORKSPACE_DIR) are forwarded via -e', async () => {
    if (fixture === undefined) throw new Error('fixture missing')

    const pool = new TmuxSessionPool({
      policy: makePolicy('-100'),
      stateDir: fixture.stateDir,
      workspaceDir: '/tmp/ws',
      chatsBasePath: '/tmp/ws/chats',
      claudeBinary: 'claude',
      logger: nopLogger(),
    })

    await pool.getOrSpawn('-100')

    const argv = readFileSync(fixture.argvLog, 'utf8')
    expect(argv).toContain('CHAT_ID=-100')
    expect(argv).toContain(`MULTICHAT_STATE_DIR=${fixture.stateDir}`)
    expect(argv).toContain('CLAUDE_WORKSPACE_DIR=/tmp/ws')
  })

  test('non-allowlisted but non-forbidden key (HOSTNAME) is dropped', async () => {
    if (fixture === undefined) throw new Error('fixture missing')
    // HOSTNAME is commonly set by the shell but is not on our
    // allowlist — verify it's dropped from the tmux child env.
    process.env.HOSTNAME = 'thrall-test-host'

    const pool = new TmuxSessionPool({
      policy: makePolicy('555'),
      stateDir: fixture.stateDir,
      workspaceDir: '/tmp/ws',
      chatsBasePath: '/tmp/ws/chats',
      claudeBinary: 'claude',
      logger: nopLogger(),
    })

    await pool.getOrSpawn('555')

    const env = readFileSync(fixture.envLog, 'utf8')
    // HOSTNAME must not appear in the tmux child process env.
    expect(env).not.toMatch(/^HOSTNAME=thrall-test-host$/m)
    // And not in -e flags either.
    const argv = readFileSync(fixture.argvLog, 'utf8')
    expect(argv).not.toContain('HOSTNAME=thrall-test-host')
  })

  // ──────────────────────────────────────────────────────────────────
  // FIX-A regression suite (2026-05-27)
  // ──────────────────────────────────────────────────────────────────

  test('FIX-A B3: tmux argv does NOT contain a bare `-e TMUX_PANE` arg pair', async () => {
    if (fixture === undefined) throw new Error('fixture missing')

    const pool = new TmuxSessionPool({
      policy: makePolicy('444'),
      stateDir: fixture.stateDir,
      workspaceDir: '/tmp/ws',
      chatsBasePath: '/tmp/ws/chats',
      claudeBinary: 'claude',
      logger: nopLogger(),
    })

    await pool.getOrSpawn('444')

    const lines = readFileSync(fixture.argvLog, 'utf8').split('\n')
    // `-e TMUX_PANE` would appear as two consecutive lines: `-e` then
    // `TMUX_PANE`. tmux's `-e` requires `KEY=value` syntax — a bare
    // KEY either errors or eats the next token (silently breaking
    // `-c`). The pool must NEVER emit this pattern.
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i] === '-e' && lines[i + 1] === 'TMUX_PANE') {
        throw new Error(
          `tmux argv contains bare \`-e TMUX_PANE\` at index ${i} ` +
            `(see FIX-A B3). Argv: ${JSON.stringify(lines)}`,
        )
      }
    }
    // Sanity: the POOL must not forward TMUX_PANE via a tmux `-e` flag —
    // it has no valid pane id at spawn time. The pane id is recovered
    // inside the pane by spawn-chat-shell.sh, which reads $TMUX_PANE
    // (set by tmux on the new-session command) and forwards it across
    // its `env -i` wipe. See the standalone wrapper test below.
    expect(readFileSync(fixture.argvLog, 'utf8')).not.toContain('TMUX_PANE=')
  })

  test('FIX-A B2: tmux new-session command is the spawn-chat-shell.sh wrapper followed by the claude binary', async () => {
    if (fixture === undefined) throw new Error('fixture missing')

    const pool = new TmuxSessionPool({
      policy: makePolicy('777'),
      stateDir: fixture.stateDir,
      workspaceDir: '/tmp/ws',
      chatsBasePath: '/tmp/ws/chats',
      claudeBinary: 'claude',
      logger: nopLogger(),
    })

    await pool.getOrSpawn('777')

    const lines = readFileSync(fixture.argvLog, 'utf8')
      .split('\n')
      .filter((l) => l !== '' && l !== '--- argv ---')

    const wrapperIdx = lines.findIndex((l) => l.endsWith('/spawn-chat-shell.sh'))
    expect(wrapperIdx).toBeGreaterThan(0)
    // Immediately preceded by `-c CWD` — confirms `-c` was not eaten
    // by a leftover bare `-e` (B3 regression check).
    expect(lines[wrapperIdx - 2]).toBe('-c')
    expect(lines[wrapperIdx - 1]).toBe('/tmp/ws/chats')
    // Wrapper's first positional arg is the claude binary.
    expect(lines[wrapperIdx + 1]).toBe('claude')
  })

  test('FIX-A B2 entrypointScript override: wrapper still runs first, override is its first arg', async () => {
    if (fixture === undefined) throw new Error('fixture missing')

    const pool = new TmuxSessionPool({
      policy: makePolicy('888'),
      stateDir: fixture.stateDir,
      workspaceDir: '/tmp/ws',
      chatsBasePath: '/tmp/ws/chats',
      claudeBinary: 'claude',
      entrypointScript: '/opt/custom-entrypoint.sh',
      logger: nopLogger(),
    })

    await pool.getOrSpawn('888')

    const lines = readFileSync(fixture.argvLog, 'utf8')
      .split('\n')
      .filter((l) => l !== '' && l !== '--- argv ---')

    const wrapperIdx = lines.findIndex((l) => l.endsWith('/spawn-chat-shell.sh'))
    expect(wrapperIdx).toBeGreaterThan(0)
    // entrypointScript takes precedence over claudeBinary as the
    // wrapper's exec target.
    expect(lines[wrapperIdx + 1]).toBe('/opt/custom-entrypoint.sh')
  })
})

// ────────────────────────────────────────────────────────────────────
// FIX-A B2: standalone wrapper script leak-closure test
// ────────────────────────────────────────────────────────────────────
//
// Simulates a tmux global env table containing TELEGRAM_BOT_TOKEN by
// invoking the wrapper directly with a polluted parent env. The
// wrapper must NOT propagate the leaked var to the child it execs.
// We use `/usr/bin/env` as the wrapper's exec target so the child
// dumps its final env to stdout for inspection.

describe('spawn-chat-shell.sh standalone leak closure (FIX-A B2)', () => {
  test('TELEGRAM_BOT_TOKEN leaked via parent env does NOT survive `env -i` re-export', () => {
    const result = spawnSync(
      SPAWN_WRAPPER,
      ['/usr/bin/env'],
      {
        env: {
          // Allowlisted — wrapper SHOULD propagate these.
          PATH: '/usr/local/bin:/usr/bin:/bin',
          HOME: '/home/test',
          USER: 'test',
          CHAT_ID: '12345',
          MULTICHAT_STATE_DIR: '/tmp/state',
          CLAUDE_WORKSPACE_DIR: '/tmp/ws',
          // Simulated tmux global-env leak — wrapper MUST drop these.
          TELEGRAM_BOT_TOKEN: 'leaked-tg-token-DO-NOT-PROPAGATE',
          OPENAI_API_KEY: 'leaked-openai-key-DO-NOT-PROPAGATE',
          GBRAIN_BEARER: 'leaked-gbrain-bearer-DO-NOT-PROPAGATE',
          ANTHROPIC_API_KEY: 'leaked-anthropic-key-DO-NOT-PROPAGATE',
          // Random non-allowlisted, non-credential key — also dropped.
          HOSTNAME: 'leaked-hostname',
        },
        encoding: 'utf8',
      },
    )

    expect(result.status).toBe(0)
    const childEnv = result.stdout

    // Leaked credentials MUST NOT appear in the child env, by value
    // or by key name.
    expect(childEnv).not.toContain('leaked-tg-token-DO-NOT-PROPAGATE')
    expect(childEnv).not.toContain('leaked-openai-key-DO-NOT-PROPAGATE')
    expect(childEnv).not.toContain('leaked-gbrain-bearer-DO-NOT-PROPAGATE')
    expect(childEnv).not.toContain('leaked-anthropic-key-DO-NOT-PROPAGATE')
    expect(childEnv).not.toMatch(/^TELEGRAM_BOT_TOKEN=/m)
    expect(childEnv).not.toMatch(/^OPENAI_API_KEY=/m)
    expect(childEnv).not.toMatch(/^GBRAIN_BEARER=/m)
    expect(childEnv).not.toMatch(/^ANTHROPIC_API_KEY=/m)

    // Non-allowlisted shell var also dropped.
    expect(childEnv).not.toMatch(/^HOSTNAME=leaked-hostname$/m)

    // Allowlisted vars SURVIVE — the wrapper must still pass them
    // through so claude can launch and per-chat config works.
    expect(childEnv).toMatch(/^PATH=\/usr\/local\/bin:\/usr\/bin:\/bin$/m)
    expect(childEnv).toMatch(/^HOME=\/home\/test$/m)
    expect(childEnv).toMatch(/^USER=test$/m)
    expect(childEnv).toMatch(/^CHAT_ID=12345$/m)
    expect(childEnv).toMatch(/^MULTICHAT_STATE_DIR=\/tmp\/state$/m)
    expect(childEnv).toMatch(/^CLAUDE_WORKSPACE_DIR=\/tmp\/ws$/m)
  })

  test('TMUX and TMUX_PANE ARE forwarded across `env -i` (watcher routing fix, 2026-05-28)', () => {
    // Regression guard: multichat-entrypoint.sh's inbox-watcher reads
    // $TMUX_PANE to target its pane with `tmux send-keys`. tmux sets
    // TMUX_PANE on the new-session command; the wrapper's `env -i` must
    // forward it (and TMUX) or the watcher self-disables and the
    // chat_id→session routing silently dies. Neither value is a
    // credential, so forwarding them does not weaken FIX-A B2 isolation.
    const result = spawnSync(SPAWN_WRAPPER, ['/usr/bin/env'], {
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: '/home/test',
        CHAT_ID: '12345',
        MULTICHAT_STATE_DIR: '/tmp/state',
        CLAUDE_WORKSPACE_DIR: '/tmp/ws',
        // Values tmux would have set on the pane process.
        TMUX: '/tmp/tmux-1000/default,4242,7',
        TMUX_PANE: '%7',
        // A leaked credential in the same env must STILL be dropped —
        // forwarding the pane locators must not widen the allowlist.
        TELEGRAM_BOT_TOKEN: 'leaked-token-DO-NOT-PROPAGATE',
      },
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    const childEnv = result.stdout
    expect(childEnv).toMatch(/^TMUX_PANE=%7$/m)
    expect(childEnv).toMatch(/^TMUX=\/tmp\/tmux-1000\/default,4242,7$/m)
    // Isolation guarantee unchanged: the credential is still gone.
    expect(childEnv).not.toContain('leaked-token-DO-NOT-PROPAGATE')
    expect(childEnv).not.toMatch(/^TELEGRAM_BOT_TOKEN=/m)
  })

  test('wrapper exits non-zero if no CLAUDE_BIN argument given', () => {
    const result = spawnSync(SPAWN_WRAPPER, [], {
      env: { PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    })
    // `set -u` + parameter expansion `${1:?...}` exits non-zero.
    expect(result.status).not.toBe(0)
  })
})
