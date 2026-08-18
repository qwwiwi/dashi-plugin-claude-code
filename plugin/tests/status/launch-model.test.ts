// Tests for readLaunchModelId — the /proc walk that recovers the hosting Claude
// Code process's `--model` flag. The process tree is faked, so these never touch
// /proc and pass on any platform.

import { describe, expect, test } from 'bun:test'

import { readLaunchModelId } from '../../src/status/launch-model.js'

// Build fake readers from a {pid: {argv, ppid}} tree.
function tree(spec: Record<number, { argv?: readonly string[]; ppid?: number }>) {
  return {
    readCmdlineFn: (pid: number) => spec[pid]?.argv,
    readParentPidFn: (pid: number) => spec[pid]?.ppid,
  }
}

describe('readLaunchModelId', () => {
  test('finds the flag on the direct parent', () => {
    const t = tree({ 100: { argv: ['claude', '--model', 'claude-opus-5[1m]'] } })
    expect(readLaunchModelId({ startPid: 100, ...t })).toBe('claude-opus-5[1m]')
  })

  test('walks up past a wrapper that has no --model', () => {
    const t = tree({
      100: { argv: ['bun', 'src/server.ts'], ppid: 200 },
      200: { argv: ['/bin/bash', '-c', 'exec claude'], ppid: 300 },
      300: { argv: ['claude', '--model=claude-opus-5[1m]', '--permission-mode', 'bypassPermissions'] },
    })
    expect(readLaunchModelId({ startPid: 100, ...t })).toBe('claude-opus-5[1m]')
  })

  test('no --model anywhere in the chain → undefined', () => {
    const t = tree({
      100: { argv: ['bun', 'src/server.ts'], ppid: 200 },
      200: { argv: ['claude'] },
    })
    expect(readLaunchModelId({ startPid: 100, ...t })).toBeUndefined()
  })

  test('unreadable process (no /proc entry) → undefined, never throws', () => {
    const t = tree({})
    expect(readLaunchModelId({ startPid: 100, ...t })).toBeUndefined()
  })

  test('a reader that throws is contained', () => {
    expect(
      readLaunchModelId({
        startPid: 100,
        readCmdlineFn: () => {
          throw new Error('EACCES')
        },
        readParentPidFn: () => undefined,
      }),
    ).toBeUndefined()
  })

  test('stops at the ancestor limit instead of walking to init', () => {
    // Every pid points at the next one and none carries the flag.
    const t = {
      readCmdlineFn: () => ['bun', 'server.ts'],
      readParentPidFn: (pid: number) => pid + 1,
    }
    expect(readLaunchModelId({ startPid: 100, maxAncestors: 3, ...t })).toBeUndefined()
  })

  test('a parent cycle terminates', () => {
    const t = tree({
      100: { argv: ['bun'], ppid: 200 },
      200: { argv: ['bash'], ppid: 100 },
    })
    expect(readLaunchModelId({ startPid: 100, ...t })).toBeUndefined()
  })

  test('pid <= 1 is not walked', () => {
    const t = tree({ 1: { argv: ['claude', '--model', 'x[1m]'] } })
    expect(readLaunchModelId({ startPid: 1, ...t })).toBeUndefined()
  })
})
