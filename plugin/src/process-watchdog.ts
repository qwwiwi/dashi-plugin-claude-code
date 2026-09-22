// Classifies why server.ts's orphan/stdin watchdog interval might fire.
// Kept as a pure function so it is unit-testable — server.ts is a binary
// entry point with side effects at import time and can't be imported in
// tests (see tests/server.pid.test.ts).
//
// BUG (2026-07-23, archivist channel crash — bug-archivist-channel-crash.md):
// stdin ending/closing used to be treated as equivalent to true orphaning
// (parent process died) and triggered a full shutdown(), taking the
// Telegram poller/webhook/memory-writer down with it. Empirically, Claude
// Code can sever just the MCP stdio pipe to one server while its own
// process stays alive and every other MCP connection keeps working — a
// live idle process died ~85-125s after start with ppid unchanged, no
// signal, no OOM, no uncaught exception anywhere. Only real reparenting to
// init means the parent is actually gone and shutdown() is warranted;
// losing stdin alone should just disable the tool-call interface.
export type WatchdogState = 'alive' | 'stdio-lost' | 'orphaned'

export interface WatchdogInput {
  ppid: number
  bootPpid: number
  platform: NodeJS.Platform
  stdinDestroyed: boolean
  stdinReadableEnded: boolean
}

export function classifyWatchdogState(input: WatchdogInput): WatchdogState {
  const trueOrphan = input.platform !== 'win32' && input.ppid !== input.bootPpid
  if (trueOrphan) return 'orphaned'
  if (input.stdinDestroyed || input.stdinReadableEnded) return 'stdio-lost'
  return 'alive'
}
