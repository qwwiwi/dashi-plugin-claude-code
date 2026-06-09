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
import type { PermissionPolicy } from '../../src/security/permission-policy.js'

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
  test('non-PreToolUse → passthrough (empty stdout)', () => {
    const d = decideLocal({ envelope: { hook_event_name: 'PostToolUse' }, policy: ALLOW_POLICY, scope: 'main' })
    expect(d).toEqual({ action: 'emit', stdout: '' })
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
