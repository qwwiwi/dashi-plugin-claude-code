// Pins the contract behind the 2026-07-23 archivist channel crash fix
// (bug-archivist-channel-crash.md): stdin loss alone must NOT be treated
// as fatal orphaning. Only a real ppid change (reparented to init) is.
import { describe, expect, test } from 'bun:test'

import { classifyWatchdogState } from '../src/process-watchdog.js'

describe('classifyWatchdogState', () => {
  test('alive: ppid unchanged, stdin intact', () => {
    expect(
      classifyWatchdogState({
        ppid: 100,
        bootPpid: 100,
        platform: 'linux',
        stdinDestroyed: false,
        stdinReadableEnded: false,
      }),
    ).toBe('alive')
  })

  test('stdio-lost: stdin ended, ppid unchanged — the archivist crash scenario', () => {
    expect(
      classifyWatchdogState({
        ppid: 100,
        bootPpid: 100,
        platform: 'linux',
        stdinDestroyed: false,
        stdinReadableEnded: true,
      }),
    ).toBe('stdio-lost')
  })

  test('stdio-lost: stdin destroyed, ppid unchanged', () => {
    expect(
      classifyWatchdogState({
        ppid: 100,
        bootPpid: 100,
        platform: 'linux',
        stdinDestroyed: true,
        stdinReadableEnded: false,
      }),
    ).toBe('stdio-lost')
  })

  test('orphaned: ppid changed (reparented to init), stdin intact', () => {
    expect(
      classifyWatchdogState({
        ppid: 1,
        bootPpid: 100,
        platform: 'linux',
        stdinDestroyed: false,
        stdinReadableEnded: false,
      }),
    ).toBe('orphaned')
  })

  test('orphaned takes precedence over stdio-lost when both conditions hold', () => {
    expect(
      classifyWatchdogState({
        ppid: 1,
        bootPpid: 100,
        platform: 'linux',
        stdinDestroyed: true,
        stdinReadableEnded: true,
      }),
    ).toBe('orphaned')
  })

  test('win32: ppid changes are never treated as orphaning', () => {
    expect(
      classifyWatchdogState({
        ppid: 1,
        bootPpid: 100,
        platform: 'win32',
        stdinDestroyed: false,
        stdinReadableEnded: false,
      }),
    ).toBe('alive')
  })

  test('win32: stdin loss is still detected', () => {
    expect(
      classifyWatchdogState({
        ppid: 1,
        bootPpid: 100,
        platform: 'win32',
        stdinDestroyed: true,
        stdinReadableEnded: false,
      }),
    ).toBe('stdio-lost')
  })
})
