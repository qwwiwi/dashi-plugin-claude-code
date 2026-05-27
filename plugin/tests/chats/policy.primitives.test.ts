// Tests for the shared chat-policy primitives added by TASK-1 of the
// Codex review fix cycle (2026-05-27): `assertValidChatId`,
// `getChatPolicyOrDeny`, `shouldStreamForChat`,
// `shouldMirrorTmuxForChat`.
//
// These primitives MUST be the single gate that router/status/mirror
// consult. The fail-closed semantics are load-bearing: any chat absent
// from a loaded policy is denied streaming and tmux mirroring, while
// the legacy single-DM case (`policy === null`) keeps the historical
// fail-open behaviour so existing deployments do not regress.
//
// Subsequent tasks (TASK-2/4/5) wire callers to these helpers; this
// suite locks the contract before that migration.

import { describe, expect, test } from 'bun:test'

import {
  assertValidChatId,
  getChatPolicyOrDeny,
  shouldMirrorTmuxForChat,
  shouldStreamForChat,
  type ChatPolicy,
  type MultichatPolicy,
} from '../../src/chats/policy-loader.js'

// Compact ChatPolicy fixture builder. Defaults match a private DM with
// streaming + mirror ON; tests override the two booleans we care about.
function makeChatPolicy(overrides: Partial<ChatPolicy> = {}): ChatPolicy {
  return {
    mode: 'private',
    streaming: 'progress',
    tmux_mirror: true,
    edit_message_progress: true,
    delivery: 'streamed',
    persona_file: 'persona.md',
    handoff_file: 'handoff.md',
    system_reminder: '',
    idle_ttl_ms: 1_800_000,
    max_queue_depth: 1,
    ...overrides,
  }
}

// Minimal MultichatPolicy fixture — only `chats` matters for the
// primitives we test; allowlists / mention_allowlist are validated by
// the loader test and ignored here.
function makePolicy(chats: Record<string, ChatPolicy>): MultichatPolicy {
  return {
    version: 1,
    allowlist: { chats: Object.keys(chats), users: [] },
    mention_allowlist: [],
    chats,
  }
}

describe('assertValidChatId', () => {
  test('accepts positive integer ids (DMs)', () => {
    expect(() => assertValidChatId('164795011')).not.toThrow()
    expect(() => assertValidChatId('1')).not.toThrow()
    expect(() => assertValidChatId('0')).not.toThrow()
  })

  test('accepts negative integer ids (groups/supergroups)', () => {
    expect(() => assertValidChatId('-1003784643974')).not.toThrow()
    expect(() => assertValidChatId('-1')).not.toThrow()
  })

  test('rejects non-numeric strings', () => {
    expect(() => assertValidChatId('abc')).toThrow(TypeError)
  })

  test('rejects empty string', () => {
    expect(() => assertValidChatId('')).toThrow(TypeError)
  })

  test('rejects path-traversal payloads', () => {
    expect(() => assertValidChatId('../x')).toThrow(TypeError)
    expect(() => assertValidChatId('../../etc/passwd')).toThrow(TypeError)
  })

  test('rejects shell-injection payloads', () => {
    expect(() => assertValidChatId('12; rm')).toThrow(TypeError)
    expect(() => assertValidChatId('1 && cat /etc/passwd')).toThrow(TypeError)
    expect(() => assertValidChatId('$(whoami)')).toThrow(TypeError)
  })

  test('rejects floating-point ids', () => {
    expect(() => assertValidChatId('1.5')).toThrow(TypeError)
    expect(() => assertValidChatId('-1.0')).toThrow(TypeError)
  })

  test('rejects ids with leading/trailing whitespace', () => {
    expect(() => assertValidChatId(' 123 ')).toThrow(TypeError)
    expect(() => assertValidChatId('123\n')).toThrow(TypeError)
  })

  test('rejects ids containing only a sign', () => {
    expect(() => assertValidChatId('-')).toThrow(TypeError)
  })

  test('truncates over-long payloads in the error message', () => {
    const huge = '!'.repeat(200)
    try {
      assertValidChatId(huge)
      throw new Error('expected throw')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Error must not echo the full 200-char payload verbatim.
      expect(msg.length).toBeLessThan(huge.length + 80)
      expect(msg).toContain('…')
    }
  })
})

describe('getChatPolicyOrDeny', () => {
  test('returns null when policy is null (multichat disabled)', () => {
    expect(getChatPolicyOrDeny(null, '164795011')).toBeNull()
    expect(getChatPolicyOrDeny(null, '-1003784643974')).toBeNull()
  })

  test('returns the chat policy entry when the chat is configured', () => {
    const dm = makeChatPolicy({ mode: 'private' })
    const group = makeChatPolicy({ mode: 'public', streaming: 'off' })
    const policy = makePolicy({
      '164795011': dm,
      '-1003784643974': group,
    })
    expect(getChatPolicyOrDeny(policy, '164795011')).toBe(dm)
    expect(getChatPolicyOrDeny(policy, '-1003784643974')).toBe(group)
  })

  test('returns null when the chat is missing from policy.chats', () => {
    const policy = makePolicy({
      '164795011': makeChatPolicy(),
    })
    expect(getChatPolicyOrDeny(policy, '-999')).toBeNull()
    expect(getChatPolicyOrDeny(policy, '42')).toBeNull()
  })

  test('throws on invalid chat id even when policy is null', () => {
    expect(() => getChatPolicyOrDeny(null, 'abc')).toThrow(TypeError)
    expect(() => getChatPolicyOrDeny(null, '')).toThrow(TypeError)
  })

  test('throws on invalid chat id even when policy is loaded', () => {
    const policy = makePolicy({ '1': makeChatPolicy() })
    expect(() => getChatPolicyOrDeny(policy, '../x')).toThrow(TypeError)
  })
})

describe('shouldStreamForChat', () => {
  test('null policy returns true (legacy single-DM mode)', () => {
    expect(shouldStreamForChat(null, '164795011')).toBe(true)
    expect(shouldStreamForChat(null, '-1003784643974')).toBe(true)
  })

  test('loaded policy with chat absent returns false (fail-closed)', () => {
    const policy = makePolicy({
      '164795011': makeChatPolicy({ streaming: 'progress' }),
    })
    expect(shouldStreamForChat(policy, '-1003784643974')).toBe(false)
    expect(shouldStreamForChat(policy, '42')).toBe(false)
  })

  test('chat configured with streaming=progress returns true', () => {
    const policy = makePolicy({
      '164795011': makeChatPolicy({ streaming: 'progress' }),
    })
    expect(shouldStreamForChat(policy, '164795011')).toBe(true)
  })

  test('chat configured with streaming=off returns false', () => {
    const policy = makePolicy({
      '-1003784643974': makeChatPolicy({ streaming: 'off' }),
    })
    expect(shouldStreamForChat(policy, '-1003784643974')).toBe(false)
  })

  test('throws on invalid chat id (defence in depth)', () => {
    const policy = makePolicy({ '1': makeChatPolicy() })
    expect(() => shouldStreamForChat(policy, 'abc')).toThrow(TypeError)
    expect(() => shouldStreamForChat(null, '../x')).toThrow(TypeError)
  })
})

describe('shouldMirrorTmuxForChat', () => {
  test('null policy returns true (legacy single-DM mode)', () => {
    expect(shouldMirrorTmuxForChat(null, '164795011')).toBe(true)
    expect(shouldMirrorTmuxForChat(null, '-1003784643974')).toBe(true)
  })

  test('loaded policy with chat absent returns false (fail-closed)', () => {
    const policy = makePolicy({
      '164795011': makeChatPolicy({ tmux_mirror: true }),
    })
    expect(shouldMirrorTmuxForChat(policy, '-1003784643974')).toBe(false)
    expect(shouldMirrorTmuxForChat(policy, '42')).toBe(false)
  })

  test('chat configured with tmux_mirror=true returns true', () => {
    const policy = makePolicy({
      '164795011': makeChatPolicy({ tmux_mirror: true }),
    })
    expect(shouldMirrorTmuxForChat(policy, '164795011')).toBe(true)
  })

  test('chat configured with tmux_mirror=false returns false', () => {
    const policy = makePolicy({
      '-1003784643974': makeChatPolicy({ tmux_mirror: false }),
    })
    expect(shouldMirrorTmuxForChat(policy, '-1003784643974')).toBe(false)
  })

  test('throws on invalid chat id (defence in depth)', () => {
    const policy = makePolicy({ '1': makeChatPolicy() })
    expect(() => shouldMirrorTmuxForChat(policy, 'abc')).toThrow(TypeError)
    expect(() => shouldMirrorTmuxForChat(null, '12; rm')).toThrow(TypeError)
  })
})
