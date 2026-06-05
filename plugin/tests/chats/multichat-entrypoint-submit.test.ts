// Tests for the verified-submit injection logic in
// src/chats/hooks/multichat-entrypoint.sh (FIX 2026-06-05).
//
// Production bug: the first message of a fresh per-chat spawn landed in
// the Claude Code composer but its trailing Enter never submitted (TUI
// boot race + paste-burst grouping). The fix is a readiness gate +
// bracketed paste + an Enter-only verify loop. We exercise the real bash
// helpers by sourcing the script with MULTICHAT_ENTRYPOINT_TEST_ONLY=1
// and a stub `tmux` on PATH that logs every invocation and serves
// scripted capture-pane output, then assert on the tmux call log.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SCRIPT = join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'chats',
  'hooks',
  'multichat-entrypoint.sh',
)

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'entrypoint-submit-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// Install a stub tmux into {dir}/bin. capture-pane output is read from
// {dir}/pane-N.txt where N starts at 1 and advances after each
// capture-pane call (sticking to the last file) — lets a test script the
// pane evolving over time. Every invocation is appended to {dir}/tmux.log.
function installStubTmux(): void {
  const stub = `#!/usr/bin/env bash
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
echo "$@" >> "$DIR/tmux.log"
if [[ "$1" == "load-buffer" && -n "\${TMUX_STUB_FAIL_LOAD:-}" ]]; then
  exit 1
fi
if [[ "$1" == "capture-pane" ]]; then
  n=$(cat "$DIR/capture-count" 2>/dev/null || echo 0)
  n=$((n + 1))
  echo "$n" > "$DIR/capture-count"
  f="$DIR/pane-$n.txt"
  while [[ ! -f "$f" && $n -gt 1 ]]; do n=$((n - 1)); f="$DIR/pane-$n.txt"; done
  cat "$f" 2>/dev/null || true
fi
if [[ "$1" == "load-buffer" ]]; then
  cat > "$DIR/loaded-buffer.txt"
fi
exit 0
`
  spawnSync('mkdir', ['-p', join(dir, 'bin')])
  writeFileSync(join(dir, 'bin', 'tmux'), stub)
  chmodSync(join(dir, 'bin', 'tmux'), 0o755)
}

// Run a bash snippet with the script's helpers sourced, the stub tmux
// first on PATH, and fast test timings.
function runHelpers(
  snippet: string,
  extraEnv: Record<string, string> = {},
): {
  code: number
  stdout: string
  stderr: string
} {
  const res = spawnSync(
    'bash',
    [
      '-c',
      `set -uo pipefail
MULTICHAT_ENTRYPOINT_TEST_ONLY=1 source "${SCRIPT}"
PANE='%1'
CHAT_ID='test-chat'
${snippet}`,
    ],
    {
      env: {
        ...process.env,
        PATH: `${join(dir, 'bin')}:${process.env['PATH'] ?? ''}`,
        MULTICHAT_READY_POLL_INTERVAL: '0.01',
        MULTICHAT_READY_POLL_MAX: '5',
        MULTICHAT_PASTE_SETTLE: '0.01',
        MULTICHAT_SUBMIT_RETRY_DELAY: '0.01',
        MULTICHAT_SUBMIT_RETRY_FACTOR: '1.0',
        MULTICHAT_SUBMIT_RETRY_MAX: '3',
        ...extraEnv,
      },
      encoding: 'utf8',
      timeout: 15_000,
    },
  )
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

function tmuxLog(): string[] {
  try {
    return readFileSync(join(dir, 'tmux.log'), 'utf8').trim().split('\n')
  } catch {
    return []
  }
}

const READY_PANE = '❯ \n⏵⏵ bypass permissions on (shift+tab to cycle)\n'
const GENERATING_PANE = '✻ Reticulating…\n❯ \nesc to interrupt\n'

describe('submit_prompt', () => {
  test('happy path: ready pane → single paste, single Enter, exit 0', () => {
    installStubTmux()
    writeFileSync(join(dir, 'pane-1.txt'), READY_PANE)
    // After the first Enter the turn is generating.
    writeFileSync(join(dir, 'pane-3.txt'), GENERATING_PANE)

    const res = runHelpers(`submit_prompt 'hello from telegram, long enough'`)

    expect(res.code).toBe(0)
    const log = tmuxLog()
    expect(log.filter((l) => l.startsWith('load-buffer')).length).toBe(1)
    expect(log.filter((l) => l.startsWith('paste-buffer')).length).toBe(1)
    expect(log.filter((l) => l === 'send-keys -t %1 Enter').length).toBe(1)
    // Bracketed paste requested.
    expect(log.find((l) => l.startsWith('paste-buffer'))).toContain('-p')
    // Body delivered via buffer, exactly once, without trailing newline.
    expect(readFileSync(join(dir, 'loaded-buffer.txt'), 'utf8')).toBe(
      'hello from telegram, long enough',
    )
  })

  test('readiness gate: paste waits until ❯ appears', () => {
    installStubTmux()
    // Boot banner (no ❯) for the first two captures, then ready, then
    // generating after Enter.
    writeFileSync(join(dir, 'pane-1.txt'), 'Welcome back!\nLoading MCP…\n')
    writeFileSync(join(dir, 'pane-3.txt'), READY_PANE)
    writeFileSync(join(dir, 'pane-5.txt'), GENERATING_PANE)

    const res = runHelpers(`submit_prompt 'message during boot race here'`)

    expect(res.code).toBe(0)
    const log = tmuxLog()
    // At least 3 captures happened BEFORE the paste (gate polled).
    const pasteIdx = log.findIndex((l) => l.startsWith('paste-buffer'))
    const capturesBefore = log
      .slice(0, pasteIdx)
      .filter((l) => l.startsWith('capture-pane')).length
    expect(capturesBefore).toBeGreaterThanOrEqual(3)
  })

  test('swallowed Enter: retries Enter only, never re-pastes', () => {
    installStubTmux()
    // Ready, then the fingerprint stays visible in the composer (Enter
    // swallowed) for one verify round, then generation starts.
    const stuck = `❯ stuck message that did not submit yet\n`
    writeFileSync(join(dir, 'pane-1.txt'), READY_PANE)
    writeFileSync(join(dir, 'pane-3.txt'), stuck)
    writeFileSync(join(dir, 'pane-5.txt'), GENERATING_PANE)

    const res = runHelpers(
      `submit_prompt 'stuck message that did not submit yet'`,
    )

    expect(res.code).toBe(0)
    const log = tmuxLog()
    expect(log.filter((l) => l.startsWith('paste-buffer')).length).toBe(1)
    expect(
      log.filter((l) => l === 'send-keys -t %1 Enter').length,
    ).toBeGreaterThanOrEqual(2)
  })

  test('never confirmed: exits 1 after max attempts, body pasted once', () => {
    installStubTmux()
    // Composer keeps showing the fingerprint forever, no generation.
    writeFileSync(
      join(dir, 'pane-1.txt'),
      `❯ permanently stuck composer text\n⏵⏵ bypass permissions on\n`,
    )

    const res = runHelpers(`submit_prompt 'permanently stuck composer text'`)

    expect(res.code).toBe(1)
    expect(res.stderr).toContain('submit not confirmed')
    const log = tmuxLog()
    expect(log.filter((l) => l.startsWith('load-buffer')).length).toBe(1)
    // MULTICHAT_SUBMIT_RETRY_MAX=3 → exactly 3 Enters.
    expect(log.filter((l) => l === 'send-keys -t %1 Enter').length).toBe(3)
  })

  test('fingerprint vanished counts as submitted (fast turn)', () => {
    installStubTmux()
    writeFileSync(join(dir, 'pane-1.txt'), READY_PANE)
    // After Enter: no "esc to interrupt" (turn already finished), and the
    // composer no longer shows the message.
    writeFileSync(join(dir, 'pane-3.txt'), `❯ \nanswer rendered above\n`)

    const res = runHelpers(`submit_prompt 'fast turn message goes here ok'`)

    expect(res.code).toBe(0)
    expect(
      tmuxLog().filter((l) => l === 'send-keys -t %1 Enter').length,
    ).toBe(1)
  })

  test('load-buffer failure: exit 1, no paste, no Enter', () => {
    installStubTmux()
    writeFileSync(join(dir, 'pane-1.txt'), READY_PANE)

    const res = runHelpers(`submit_prompt 'a message that will not load'`, {
      TMUX_STUB_FAIL_LOAD: '1',
    })

    expect(res.code).toBe(1)
    expect(res.stderr).toContain('load-buffer failed')
    const log = tmuxLog()
    expect(log.filter((l) => l.startsWith('paste-buffer')).length).toBe(0)
    expect(log.filter((l) => l === 'send-keys -t %1 Enter').length).toBe(0)
  })

  test('pre-existing generation: interrupt footer is NOT trusted as success', () => {
    installStubTmux()
    // Generating already before the paste (previous turn in flight) and
    // the fingerprint stays visible after Enter — must retry, not
    // false-succeed off the old turn's footer.
    const stuckWhileGenerating = `✻ Reticulating…\n❯ queued message sitting in composer\nesc to interrupt\n`
    writeFileSync(join(dir, 'pane-1.txt'), READY_PANE.replace('\n', '\nesc to interrupt\n'))
    writeFileSync(join(dir, 'pane-3.txt'), stuckWhileGenerating)
    // Eventually the composer clears (queued submit accepted).
    writeFileSync(join(dir, 'pane-5.txt'), `✻ Reticulating…\n❯ \nesc to interrupt\n`)

    const res = runHelpers(
      `submit_prompt 'queued message sitting in composer'`,
    )

    expect(res.code).toBe(0)
    expect(
      tmuxLog().filter((l) => l === 'send-keys -t %1 Enter').length,
    ).toBeGreaterThanOrEqual(2)
  })

  test('cyrillic fingerprint survives 60-char truncation (UTF-8 safe)', () => {
    installStubTmux()
    const ru =
      '[from @dashieshiev] Проверь пожалуйста последние коммиты плагина и скажи решили ли мы все фиксы по репорту ученика'
    writeFileSync(join(dir, 'pane-1.txt'), READY_PANE)
    // Fingerprint (first 60 chars) still visible → not submitted → retry;
    // a byte-split fingerprint would never match and false-succeed on the
    // first Enter instead.
    writeFileSync(join(dir, 'pane-3.txt'), `❯ ${ru}\n`)
    writeFileSync(join(dir, 'pane-5.txt'), GENERATING_PANE)

    const res = runHelpers(`submit_prompt '${ru}'`)

    expect(res.code).toBe(0)
    expect(
      tmuxLog().filter((l) => l === 'send-keys -t %1 Enter').length,
    ).toBeGreaterThanOrEqual(2)
  })

  test('short body without fingerprint: single Enter, assume success', () => {
    installStubTmux()
    writeFileSync(join(dir, 'pane-1.txt'), READY_PANE)

    const res = runHelpers(`submit_prompt 'да'`)

    expect(res.code).toBe(0)
    expect(
      tmuxLog().filter((l) => l === 'send-keys -t %1 Enter').length,
    ).toBe(1)
  })
})

describe('process_inbox', () => {
  test('unconfirmed submit moves file to submit-unconfirmed-, no requeue', () => {
    installStubTmux()
    // Permanently stuck composer → submit_prompt fails.
    writeFileSync(
      join(dir, 'pane-1.txt'),
      `❯ [from @telegram] stuck forever in composer\n`,
    )
    const inbox = join(dir, 'inbox')
    const processed = join(inbox, '.processed')
    spawnSync('mkdir', ['-p', processed])
    writeFileSync(
      join(inbox, '100-aa.json'),
      JSON.stringify({ text: 'stuck forever in composer', user: 'telegram' }),
    )

    const res = runHelpers(
      `INBOX='${inbox}'; PROCESSED='${processed}'; process_inbox`,
    )

    expect(res.code).toBe(0)
    const ls = spawnSync('ls', [processed], { encoding: 'utf8' })
    expect(ls.stdout).toContain('submit-unconfirmed-100-aa.json')
    const inboxLs = spawnSync('ls', [inbox], { encoding: 'utf8' })
    expect(inboxLs.stdout).not.toContain('100-aa.json\n')
  })

  test('confirmed submit moves file to .processed/ unprefixed', () => {
    installStubTmux()
    writeFileSync(join(dir, 'pane-1.txt'), READY_PANE)
    writeFileSync(join(dir, 'pane-3.txt'), GENERATING_PANE)
    const inbox = join(dir, 'inbox')
    const processed = join(inbox, '.processed')
    spawnSync('mkdir', ['-p', processed])
    writeFileSync(
      join(inbox, '200-bb.json'),
      JSON.stringify({ text: 'a normal message that submits', user: 'dashi' }),
    )

    const res = runHelpers(
      `INBOX='${inbox}'; PROCESSED='${processed}'; process_inbox`,
    )

    expect(res.code).toBe(0)
    const ls = spawnSync('ls', [processed], { encoding: 'utf8' })
    expect(ls.stdout).toContain('200-bb.json')
    expect(ls.stdout).not.toContain('submit-unconfirmed-200-bb.json')
  })
})
