import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  renderAllow,
  renderDeny,
  loadPolicy,
  resolvePolicyPath,
  buildConfirmRequest,
  mapConfirmResponse,
  decideLocal,
  previewToolCall,
} from '../../scripts/permission-gate-hook.js'
import { parseSecretPathAllowlist, type PermissionPolicy } from '../../src/security/permission-policy.js'

const ALLOW_POLICY: PermissionPolicy = {
  default_tier: 'allow',
  confirm: { bash_patterns: ['deploy.sh'] },
}

describe('stdout rendering', () => {
  test('allow shape', () => {
    expect(JSON.parse(renderAllow())).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    })
  })
  test('deny carries reason', () => {
    const o = JSON.parse(renderDeny('nope'))
    expect(o.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(o.hookSpecificOutput.permissionDecisionReason).toBe('nope')
  })
})

describe('decideLocal', () => {
  test('non-PreToolUse event → deny (hook is PreToolUse-exclusive; fail-closed)', () => {
    const d = decideLocal({ envelope: { hook_event_name: 'PostToolUse' }, policy: ALLOW_POLICY, scope: 'main' })
    expect(d.action).toBe('emit')
    expect(JSON.parse(d.stdout!).hookSpecificOutput.permissionDecision).toBe('deny')
  })
  test('safe Read → emit allow', () => {
    const d = decideLocal({
      envelope: { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x/a.ts' } },
      policy: ALLOW_POLICY,
      scope: 'main',
    })
    expect(d.action).toBe('emit')
    expect(JSON.parse(d.stdout!).hookSpecificOutput.permissionDecision).toBe('allow')
  })
  test('secret read → emit deny (built-in)', () => {
    const d = decideLocal({
      envelope: { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x/.env' } },
      policy: ALLOW_POLICY,
      scope: 'main',
    })
    expect(JSON.parse(d.stdout!).hookSpecificOutput.permissionDecision).toBe('deny')
  })
  test('deploy.sh → confirm signal', () => {
    const d = decideLocal({
      envelope: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'bash deploy.sh' } },
      policy: ALLOW_POLICY,
      scope: 'main',
    })
    expect(d.action).toBe('confirm')
    expect(d.verdict?.tier).toBe('confirm')
  })
})

describe('secret-path allowlist wiring (DASHI_SECRET_PATH_ALLOWLIST)', () => {
  const keyPath = '/home/user/.claude-lab/agent/secrets/example.key'
  const envelope = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: `test -s ${keyPath}` },
  }

  test('decideLocal without an allowlist → deny', () => {
    const d = decideLocal({ envelope, policy: ALLOW_POLICY, scope: 'main' })
    expect(JSON.parse(d.stdout!).hookSpecificOutput.permissionDecision).toBe('deny')
  })
  test('decideLocal with the path allowlisted → allow', () => {
    const d = decideLocal({
      envelope,
      policy: ALLOW_POLICY,
      scope: 'main',
      secretPathAllowlist: parseSecretPathAllowlist(keyPath, '/home/user'),
    })
    expect(JSON.parse(d.stdout!).hookSpecificOutput.permissionDecision).toBe('allow')
  })

  async function runHook(extraEnv: Record<string, string>): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'perm-gate-allowlist-'))
    try {
      const policyPath = join(dir, 'permission-policy.yaml')
      writeFileSync(policyPath, 'default_tier: allow\n')
      const proc = Bun.spawn(['bun', join(import.meta.dir, '../../scripts/permission-gate-hook.ts')], {
        stdin: new TextEncoder().encode(JSON.stringify(envelope)),
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: '/home/user',
          TELEGRAM_PERMISSION_POLICY_PATH: policyPath,
          ...extraEnv,
        },
      })
      const out = await new Response(proc.stdout).text()
      await proc.exited
      return JSON.parse(out).hookSpecificOutput.permissionDecision as string
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('hook process: env unset → deny', async () => {
    expect(await runHook({})).toBe('deny')
  })
  test('hook process: env names the exact path → allow', async () => {
    expect(await runHook({ DASHI_SECRET_PATH_ALLOWLIST: keyPath })).toBe('allow')
  })
  test('hook process: env names a neighbour → deny', async () => {
    expect(await runHook({ DASHI_SECRET_PATH_ALLOWLIST: `${keyPath}.bak` })).toBe('deny')
  })
})

describe('previewToolCall', () => {
  test('Bash → command, truncated', () => {
    expect(previewToolCall('Bash', { command: 'ls -la' })).toBe('ls -la')
    expect(previewToolCall('Bash', { command: 'x'.repeat(999) }).length).toBe(400)
  })
  test('Edit → file_path', () => {
    expect(previewToolCall('Edit', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
  })
})

describe('loadPolicy', () => {
  test('valid YAML loads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgh-'))
    try {
      const p = join(dir, 'permission-policy.yaml')
      writeFileSync(p, 'default_tier: allow\nconfirm:\n  bash_patterns:\n    - deploy.sh\n')
      const { policy, warning } = loadPolicy(p)
      expect(warning).toBeUndefined()
      expect(policy.default_tier).toBe('allow')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('missing file → confirm fallback + warning', () => {
    const { policy, warning } = loadPolicy('/no/such/policy.yaml')
    expect(policy.default_tier).toBe('confirm')
    expect(warning).toContain('unreadable')
  })
  test('malformed YAML → fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgh-'))
    try {
      const p = join(dir, 'permission-policy.yaml')
      writeFileSync(p, ':\n  - [unbalanced')
      const { policy, warning } = loadPolicy(p)
      expect(policy.default_tier).toBe('confirm')
      expect(warning).toBeTruthy()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('schema-invalid policy (unknown key) → confirm fallback (Codex high)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgh-'))
    try {
      const p = join(dir, 'permission-policy.yaml')
      // `allows:` is a typo of `allow:` — strict schema rejects, so the whole
      // file is discarded rather than silently applying a partial policy.
      writeFileSync(p, 'default_tier: allow\nallows:\n  bash_patterns:\n    - rm\n')
      const { policy, warning } = loadPolicy(p)
      expect(policy.default_tier).toBe('confirm')
      expect(warning).toContain('schema invalid')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('shipped example policy (carries version: 1) validates and loads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgh-'))
    try {
      const p = join(dir, 'permission-policy.yaml')
      writeFileSync(p, 'version: 1\ndefault_tier: allow\nconfirm:\n  bash_patterns:\n    - deploy.sh\n')
      const { policy, warning } = loadPolicy(p)
      expect(warning).toBeUndefined()
      expect(policy.default_tier).toBe('allow')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('schema-invalid policy (wrong type) → confirm fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgh-'))
    try {
      const p = join(dir, 'permission-policy.yaml')
      writeFileSync(p, 'default_tier: maybe\n')
      const { policy, warning } = loadPolicy(p)
      expect(policy.default_tier).toBe('confirm')
      expect(warning).toContain('schema invalid')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('decideLocal fail-closed (Codex Critical #1 / high)', () => {
  test('malformed Bash (no command) → deny, never allow', () => {
    const d = decideLocal({
      envelope: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} },
      policy: ALLOW_POLICY,
      scope: 'main',
    })
    expect(d.action).toBe('emit')
    expect(JSON.parse(d.stdout!).hookSpecificOutput.permissionDecision).toBe('deny')
  })
  test('catastrophic Bash → deny even under default allow', () => {
    const d = decideLocal({
      envelope: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sudo rm -rf --no-preserve-root /' } },
      policy: ALLOW_POLICY,
      scope: 'main',
    })
    expect(JSON.parse(d.stdout!).hookSpecificOutput.permissionDecision).toBe('deny')
  })
  test('secret read via Bash → deny', () => {
    const d = decideLocal({
      envelope: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat .env' } },
      policy: ALLOW_POLICY,
      scope: 'main',
    })
    expect(JSON.parse(d.stdout!).hookSpecificOutput.permissionDecision).toBe('deny')
  })
  test('envelope with NO hook_event_name → deny (was passthrough fail-open)', () => {
    const d = decideLocal({
      envelope: { tool_name: 'Bash', tool_input: { command: 'rm x' } },
      policy: ALLOW_POLICY,
      scope: 'main',
    })
    expect(d.action).toBe('emit')
    expect(JSON.parse(d.stdout!).hookSpecificOutput.permissionDecision).toBe('deny')
  })
})

describe('resolvePolicyPath', () => {
  test('explicit env wins', () => {
    expect(resolvePolicyPath({ TELEGRAM_PERMISSION_POLICY_PATH: '/etc/p.yaml' })).toBe('/etc/p.yaml')
  })
  test('defaults under workspace/chats', () => {
    expect(resolvePolicyPath({ CLAUDE_WORKSPACE_DIR: '/ws' })).toBe('/ws/chats/permission-policy.yaml')
  })
})

describe('buildConfirmRequest', () => {
  const base = { sessionId: 's', toolUseId: 't', toolName: 'Bash', preview: 'deploy.sh', reason: 'risky' }
  test('missing token → deny', () => {
    const r = buildConfirmRequest({ ...base, env: { TELEGRAM_WEBHOOK_URL: 'http://127.0.0.1:8093' } })
    expect('kind' in r && r.kind).toBe('deny')
  })
  test('off-loopback URL → deny (no token exfil)', () => {
    const r = buildConfirmRequest({
      ...base,
      env: { TELEGRAM_WEBHOOK_URL: 'http://evil.example.com:8093', TELEGRAM_WEBHOOK_TOKEN: 'x' },
    })
    expect('kind' in r && r.kind).toBe('deny')
  })
  test('loopback origin → builds request to /hooks/permission/request', () => {
    const r = buildConfirmRequest({
      ...base,
      env: { TELEGRAM_WEBHOOK_URL: 'http://127.0.0.1:8093', TELEGRAM_WEBHOOK_TOKEN: 'secret' },
    })
    expect('url' in r).toBe(true)
    if ('url' in r) {
      expect(r.url).toBe('http://127.0.0.1:8093/hooks/permission/request')
      expect(r.headers.Authorization).toBe('Bearer secret')
      expect(JSON.parse(r.body).tool_name).toBe('Bash')
    }
  })
})

describe('mapConfirmResponse (fail-closed)', () => {
  test('allow', () => {
    expect(mapConfirmResponse({ status: 'allow' })).toEqual({ kind: 'allow' })
  })
  test('deny carries reason', () => {
    expect(mapConfirmResponse({ status: 'deny', reason: 'no' })).toEqual({ kind: 'deny', reason: 'no' })
  })
  test('timeout → deny', () => {
    expect(mapConfirmResponse({ status: 'timeout' }).kind).toBe('deny')
  })
  test('unknown status → deny', () => {
    expect(mapConfirmResponse({ status: 'weird' }).kind).toBe('deny')
    expect(mapConfirmResponse({}).kind).toBe('deny')
  })
})
