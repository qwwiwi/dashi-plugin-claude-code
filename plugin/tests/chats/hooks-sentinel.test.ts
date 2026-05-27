// Phase 5 / FIX-H — sentinel tests for the multichat hooks.
//
// The hooks (pre-tool-use.sh, session-start.sh) live in
// `plugin/src/chats/hooks/` and are wired into per-chat Claude Code
// sessions by the tmux session pool. They MUST be no-ops when the
// surrounding process is not a per-chat session — otherwise an
// operator who accidentally registers them into the MASTER Thrall
// workspace would lock the master session out of every Bash / Edit /
// Read call (pre-tool-use returns exit 2 = block when CHAT_ID is
// unset).
//
// The sentinel: if `MULTICHAT_STATE_DIR` is unset, the hook is not
// running inside a per-chat session — exit 0 (allow / no-op).
//
// These tests drive the real shell scripts via spawnSync so the
// fail-closed branch we intentionally KEEP (MULTICHAT_STATE_DIR set
// but CHAT_ID unset) is also exercised end-to-end.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const HOOKS_DIR = join(import.meta.dir, '..', '..', 'src', 'chats', 'hooks')
const PRE_HOOK = join(HOOKS_DIR, 'pre-tool-use.sh')
const SESSION_HOOK = join(HOOKS_DIR, 'session-start.sh')

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

// Spawn a hook script with a clean env (we strip the parent env to make
// the sentinel check meaningful — `bun test` itself might inherit a
// stray MULTICHAT_STATE_DIR).
function run(
  script: string,
  env: Record<string, string>,
  stdin: string = '',
): RunResult {
  const r = spawnSync('bash', [script], {
    input: stdin,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      ...env,
    },
  })
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  }
}

let workspace: string
let policyPath: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'multichat-hooks-'))
  const chatsDir = join(workspace, 'chats')
  mkdirSync(chatsDir, { recursive: true })
  policyPath = join(chatsDir, 'policy.yaml')
  // Minimal policy: chat "164795011" with one Bash deny pattern and
  // no path/MCP denies. Lets us assert allow vs deny on Bash calls.
  writeFileSync(
    policyPath,
    [
      'version: 1',
      'chats:',
      '  "164795011":',
      '    deny:',
      '      bash_patterns:',
      '        - "rm -rf /"',
      '      mcp_tools: []',
      '      read_paths: []',
      '',
    ].join('\n'),
    'utf8',
  )
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('pre-tool-use.sh — sentinel pass-through', () => {
  test('MULTICHAT_STATE_DIR unset + arbitrary tool input -> exit 0, empty stdout', () => {
    // Note: we explicitly do NOT set MULTICHAT_STATE_DIR, but we also
    // pass an obviously dangerous Bash payload to prove the hook is a
    // total no-op — not just a lenient allow.
    const tool = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    })
    const r = run(
      PRE_HOOK,
      { CLAUDE_WORKSPACE_DIR: workspace },
      tool,
    )
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
  })
})

describe('pre-tool-use.sh — multichat context fail-closed without CHAT_ID', () => {
  test('MULTICHAT_STATE_DIR set + CHAT_ID unset -> deny (exit 2)', () => {
    const tool = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    })
    const r = run(
      PRE_HOOK,
      {
        MULTICHAT_STATE_DIR: workspace,
        CLAUDE_WORKSPACE_DIR: workspace,
      },
      tool,
    )
    expect(r.code).toBe(2)
    // python json.dumps defaults to compact-ish formatting with spaces
    // after the separator. Match either `"decision": "block"` or
    // `"decision":"block"` defensively.
    expect(r.stdout).toMatch(/"decision":\s*"block"/)
    expect(r.stdout).toContain('CHAT_ID env var missing')
  })
})

describe('pre-tool-use.sh — multichat context with CHAT_ID', () => {
  test('allowed Bash command -> exit 0', () => {
    const tool = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
    })
    const r = run(
      PRE_HOOK,
      {
        MULTICHAT_STATE_DIR: workspace,
        CLAUDE_WORKSPACE_DIR: workspace,
        CHAT_ID: '164795011',
      },
      tool,
    )
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
  })

  test('denied Bash command (matches policy bash_patterns) -> exit 2', () => {
    const tool = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'sudo rm -rf / --no-preserve-root' },
    })
    const r = run(
      PRE_HOOK,
      {
        MULTICHAT_STATE_DIR: workspace,
        CLAUDE_WORKSPACE_DIR: workspace,
        CHAT_ID: '164795011',
      },
      tool,
    )
    expect(r.code).toBe(2)
    // python json.dumps defaults to compact-ish formatting with spaces
    // after the separator. Match either `"decision": "block"` or
    // `"decision":"block"` defensively.
    expect(r.stdout).toMatch(/"decision":\s*"block"/)
    expect(r.stdout).toContain('bash_patterns deny')
  })
})

describe('session-start.sh — sentinel pass-through', () => {
  test('MULTICHAT_STATE_DIR unset -> exit 0, no additionalContext emitted', () => {
    // Even if persona/policy exist, an unset MULTICHAT_STATE_DIR must
    // produce a clean exit with no JSON payload.
    mkdirSync(join(workspace, 'chats', '164795011'), { recursive: true })
    writeFileSync(
      join(workspace, 'chats', '164795011', 'persona.md'),
      'PERSONA SHOULD NOT LEAK',
      'utf8',
    )
    const r = run(SESSION_HOOK, {
      CLAUDE_WORKSPACE_DIR: workspace,
      CHAT_ID: '164795011',
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
  })
})

describe('session-start.sh — degraded-mode warning (Opus #16)', () => {
  // session-start was previously fail-open and silent when persona.md
  // was missing while pre-tool-use was fail-closed for the same state.
  // Result: Thrall would boot up cleanly and then every tool call would
  // be denied with no startup signal that the gate was broken. The fix
  // makes the inconsistency observable via additionalContext so the
  // session can route around the degradation on its first turn.

  test('MULTICHAT_STATE_DIR + CHAT_ID set + persona missing -> exit 0 + degraded-mode additionalContext', () => {
    // No persona.md, no chat dir. Policy.yaml is present (created by
    // beforeEach) but unused on this path.
    const r = run(SESSION_HOOK, {
      MULTICHAT_STATE_DIR: workspace,
      CLAUDE_WORKSPACE_DIR: workspace,
      CHAT_ID: '164795011',
    })
    expect(r.code).toBe(0)
    expect(r.stdout).not.toBe('')

    const payload = JSON.parse(r.stdout)
    expect(payload.hookSpecificOutput?.hookEventName).toBe('SessionStart')
    const ctx = payload.hookSpecificOutput?.additionalContext ?? ''
    expect(ctx).toContain('Persona file missing')
    expect(ctx).toContain('164795011')
    expect(ctx).toContain(
      join(workspace, 'chats', '164795011', 'persona.md'),
    )
    expect(ctx).toContain('degraded mode')
    // Mirror to stderr for the operator tailing logs.
    expect(r.stderr).toContain('persona file not found')
  })

  test('MULTICHAT_STATE_DIR + CHAT_ID set + persona present -> normal injection, no degraded warning', () => {
    mkdirSync(join(workspace, 'chats', '164795011'), { recursive: true })
    writeFileSync(
      join(workspace, 'chats', '164795011', 'persona.md'),
      'Ты Тралл, архитектор Оргриммара.',
      'utf8',
    )
    const r = run(SESSION_HOOK, {
      MULTICHAT_STATE_DIR: workspace,
      CLAUDE_WORKSPACE_DIR: workspace,
      CHAT_ID: '164795011',
    })
    expect(r.code).toBe(0)
    expect(r.stdout).not.toBe('')

    const payload = JSON.parse(r.stdout)
    const ctx = payload.hookSpecificOutput?.additionalContext ?? ''
    // Persona is loaded as-is; degraded marker must not appear.
    expect(ctx).toContain('Тралл')
    expect(ctx).not.toContain('degraded mode')
    expect(ctx).not.toContain('Persona file missing')
  })
})
