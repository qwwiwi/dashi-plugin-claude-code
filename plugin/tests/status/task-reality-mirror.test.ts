// Integration tests for the M3 TaskRealityMirror wiring: pane capture → parse →
// validate → reconcile → push view, across the freshness variants (fresh /
// unverified / stale / idle / ended), coalescing, immediate-capture triggers,
// graceful no-tmux degradation, and the positional re-association pre-pass.
//
// All timers + the clock are injected (FakeClock) and the tmux exec is a stub,
// so the tests are deterministic and touch no real tmux / Telegram.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TaskRealityMirror,
  enforceEventRemovals,
  realignOrdinals,
  reconciledToTodos,
  numericOrdinal,
  type ReconciledView,
  type ReconciledViewSink,
} from '../../src/status/task-reality-mirror.js'
import type { TmuxExec, TmuxExecResult } from '../../src/status/pane-capture.js'
import type { Logger } from '../../src/log.js'
import type { TaskMirrorEvent } from '../../src/hooks/claude-events.js'
import {
  initialReconciledState,
  parsePaneTaskList,
  reconcileTaskState,
  validateSnapshot,
  type PaneProvenance,
  type SessionBinding,
} from '../../src/status/task-reconciler.js'

// ── fakes ─────────────────────────────────────────────────────────────

interface FakeTimer {
  id: number
  deadline: number
  cb: () => void
  fired: boolean
}
class FakeClock {
  now = 1_000_000 // start well past 0 so ages are positive
  next = 1
  timers: FakeTimer[] = []
  setTimer = (cb: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const t: FakeTimer = { id: this.next++, deadline: this.now + ms, cb, fired: false }
    this.timers.push(t)
    return t as unknown as ReturnType<typeof setTimeout>
  }
  clearTimer = (handle: ReturnType<typeof setTimeout>): void => {
    ;(handle as unknown as FakeTimer).fired = true
  }
  advance(ms: number): void {
    const deadline = this.now + ms
    for (;;) {
      const due = this.timers
        .filter((t) => !t.fired && t.deadline <= deadline)
        .sort((a, b) => a.deadline - b.deadline)[0]
      if (!due) break
      this.now = due.deadline
      due.fired = true
      due.cb()
    }
    this.now = deadline
  }
}

const nullLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger

// Let all pending microtasks (async doCapture) settle.
const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

interface FakeExec {
  exec: TmuxExec
  captureCount: number
}
// paneProvider yields the current pane text; captureOk toggles capture success.
function makeExec(
  paneProvider: () => string,
  opts: { cwd?: string; captureOk?: () => boolean } = {},
): FakeExec {
  const state: FakeExec = { exec: undefined as unknown as TmuxExec, captureCount: 0 }
  state.exec = async (args): Promise<TmuxExecResult> => {
    if (args.includes('capture-pane')) {
      state.captureCount++
      if (opts.captureOk && !opts.captureOk()) {
        return { stdout: '', stderr: 'no pane', exitCode: 1 }
      }
      return { stdout: paneProvider(), stderr: '', exitCode: 0 }
    }
    if (args.includes('display-message')) {
      return { stdout: `${opts.cwd ?? '/repo'}\n`, stderr: '', exitCode: 0 }
    }
    return { stdout: '', stderr: '', exitCode: 0 }
  }
  return state
}

function makeSink(): { sink: ReconciledViewSink; views: ReconciledView[] } {
  const views: ReconciledView[] = []
  const sink: ReconciledViewSink = {
    applyReconciledView: (_chatId, view) => {
      views.push(view)
    },
  }
  return { sink, views }
}

const CHAT = '164795011'

function makeMirror(exec: TmuxExec, clock: FakeClock, sink: ReconciledViewSink) {
  return new TaskRealityMirror({
    exec,
    capture: { paneTarget: 'p', lineCount: 200 },
    log: nullLog,
    sinks: [sink],
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
}

// Authoritative-shaped pane: spinner above the header + input-box chrome below
// (positional anti-spoof v2 requires the block bottom-anchored above the box).
const VALID_PANE = [
  '✻ работаю…',
  '3 tasks (1 done, 1 in progress, 1 open)',
  '☑ Собрать модуль',
  '◼ Написать тесты',
  '◻ Ревью',
  '',
  '────────────────────────────────────────',
  '❯ ',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

const NO_LIST_PANE = ['готово', '❯ '].join('\n')

const createEvent = (subject: string): TaskMirrorEvent => ({
  kind: 'task_create',
  sessionId: 's1',
  toolUseId: `tool-${subject}`,
  input: { subject },
})

// ── tests ─────────────────────────────────────────────────────────────

describe('pane → verified reconciled view', () => {
  test('a valid pane snapshot yields a fresh view with the real task list', async () => {
    const clock = new FakeClock()
    const fx = makeExec(() => VALID_PANE)
    const { sink, views } = makeSink()
    const rm = makeMirror(fx.exec, clock, sink)

    rm.onSessionStart(CHAT, { sessionId: 's1', cwd: '/repo' })
    await flush()

    const last = views.at(-1)!
    expect(last.freshness.kind).toBe('fresh')
    expect(last.todos.map((t) => t.content)).toEqual(['Собрать модуль', 'Написать тесты', 'Ревью'])
    expect(last.todos.map((t) => t.status)).toEqual(['completed', 'in_progress', 'pending'])
    expect(fx.captureCount).toBe(1) // immediate capture on SessionStart
  })
})

describe('unverified — tool events only', () => {
  test('no pane list → «unverified» with the event-derived list', async () => {
    const clock = new FakeClock()
    const fx = makeExec(() => NO_LIST_PANE)
    const { sink, views } = makeSink()
    const rm = makeMirror(fx.exec, clock, sink)

    rm.onSessionStart(CHAT, { sessionId: 's1', cwd: '/repo' })
    await flush()
    rm.onTaskEvent(CHAT, createEvent('Draft plan'), { cwd: '/repo' })
    await flush()

    const last = views.at(-1)!
    expect(last.freshness.kind).toBe('unverified')
    expect(last.todos.map((t) => t.content)).toEqual(['Draft plan'])
  })

  test('capture failure (no tmux) degrades gracefully to events-only', async () => {
    const clock = new FakeClock()
    const fx = makeExec(() => VALID_PANE, { captureOk: () => false })
    const { sink, views } = makeSink()
    const rm = makeMirror(fx.exec, clock, sink)

    rm.onSessionStart(CHAT, { sessionId: 's1', cwd: '/repo' })
    rm.onTaskEvent(CHAT, createEvent('Solo'), { cwd: '/repo' })
    await flush()

    const last = views.at(-1)!
    expect(last.freshness.kind).toBe('unverified')
    expect(last.todos.map((t) => t.content)).toEqual(['Solo'])
  })
})

describe('stale — active turn, reconciliation silent > 90s', () => {
  test('goes stale while a turn is active and the list stops reconciling', async () => {
    const clock = new FakeClock()
    let pane = VALID_PANE
    const fx = makeExec(() => pane)
    const { sink, views } = makeSink()
    const rm = makeMirror(fx.exec, clock, sink)

    rm.onSessionStart(CHAT, { sessionId: 's1', cwd: '/repo' })
    await flush()
    expect(views.at(-1)!.freshness.kind).toBe('fresh')

    rm.onUserPromptSubmit(CHAT, { sessionId: 's1', cwd: '/repo' })
    await flush()
    pane = NO_LIST_PANE // harness stops rendering a parseable list
    clock.advance(100_000) // > 90s of active work with no valid snapshot
    await flush()

    expect(views.at(-1)!.freshness.kind).toBe('stale')
  })
})

describe('idle rule — verified stays verified between turns', () => {
  test('after Stop, an absent list is NOT staleness (kept verified)', async () => {
    const clock = new FakeClock()
    let pane = VALID_PANE
    const fx = makeExec(() => pane)
    const { sink, views } = makeSink()
    const rm = makeMirror(fx.exec, clock, sink)

    rm.onUserPromptSubmit(CHAT, { sessionId: 's1', cwd: '/repo' })
    await flush()
    expect(views.at(-1)!.freshness.kind).toBe('fresh')

    rm.onStop(CHAT) // turn ends → idle
    await flush()
    pane = NO_LIST_PANE
    clock.advance(200_000) // long idle gap
    await flush()

    const last = views.at(-1)!
    expect(last.freshness.kind).toBe('fresh') // verified, NOT stale
    expect(last.todos).toHaveLength(3) // last valid snapshot retained
  })
})

describe('ended — frozen, timers stopped', () => {
  test('SessionEnd freezes the view and stops capturing', async () => {
    const clock = new FakeClock()
    const fx = makeExec(() => VALID_PANE)
    const { sink, views } = makeSink()
    const rm = makeMirror(fx.exec, clock, sink)

    rm.onSessionStart(CHAT, { sessionId: 's1', cwd: '/repo' })
    await flush()
    const beforeEnd = fx.captureCount

    rm.onSessionEnd(CHAT, { sessionId: 's1' })
    await flush()
    const ended = views.at(-1)!
    expect(ended.freshness.kind).toBe('ended')
    if (ended.freshness.kind === 'ended') {
      expect(ended.freshness.reconciledAtLabel).not.toBeNull()
    }

    clock.advance(60_000) // periodic timer must be disarmed
    await flush()
    expect(fx.captureCount).toBe(beforeEnd) // no further captures
  })
})

describe('coalescing — rapid triggers collapse to one capture', () => {
  test('three immediate triggers within the 5s window ⇒ one extra capture', async () => {
    const clock = new FakeClock()
    const fx = makeExec(() => VALID_PANE)
    const { sink } = makeSink()
    const rm = makeMirror(fx.exec, clock, sink)

    rm.onSessionStart(CHAT, { sessionId: 's1', cwd: '/repo' }) // capture #1 (immediate)
    await flush()
    expect(fx.captureCount).toBe(1)

    clock.advance(1_000)
    rm.onUserPromptSubmit(CHAT, { sessionId: 's1', cwd: '/repo' }) // schedules coalesce
    clock.advance(1_000)
    rm.onUserPromptSubmit(CHAT, { sessionId: 's1', cwd: '/repo' }) // coalesced (skip)
    clock.advance(1_000)
    rm.onUserPromptSubmit(CHAT, { sessionId: 's1', cwd: '/repo' }) // coalesced (skip)
    await flush()
    expect(fx.captureCount).toBe(1) // nothing captured yet — still within window

    clock.advance(5_000) // coalesce timer fires
    await flush()
    expect(fx.captureCount).toBe(2) // exactly one coalesced capture
  })
})

describe('session change resets state', () => {
  test('a new sessionId drops the prior reconciled tasks', async () => {
    const clock = new FakeClock()
    const fx = makeExec(() => VALID_PANE)
    const { sink, views } = makeSink()
    const rm = makeMirror(fx.exec, clock, sink)

    rm.onSessionStart(CHAT, { sessionId: 's1', cwd: '/repo' })
    await flush()
    expect(views.at(-1)!.todos).toHaveLength(3)

    // New session, pane not yet showing a list → clean unverified slate.
    const fx2 = makeExec(() => NO_LIST_PANE)
    ;(rm as unknown as { exec: TmuxExec }).exec = fx2.exec
    rm.onSessionStart(CHAT, { sessionId: 's2', cwd: '/repo' })
    await flush()
    const last = views.at(-1)!
    expect(last.sessionId).toBe('s2')
    expect(last.todos).toHaveLength(0)
    expect(last.freshness.kind).toBe('unverified')
  })
})

// ── positional re-association (§5) ──────────────────────────────────────

describe('realignOrdinals — positional-alias re-association', () => {
  const binding: SessionBinding = { sessionId: 's1', paneTarget: 'p', cwd: '/repo' }
  const prov = (capturedAt: number): PaneProvenance => ({
    sessionId: 's1',
    paneTarget: 'p',
    cwd: '/repo',
    capturedAt,
  })

  function snapshotOf(header: string, lines: string[], capturedAt: number) {
    // Positional anti-spoof v2: authoritative fixtures need harness chrome
    // below the block (input-box separator + footer).
    const chrome = ['', '────────────────────────────────────────', '  ⏵⏵ bypass permissions on']
    const snap = parsePaneTaskList([header, ...lines, ...chrome].join('\n'), prov(capturedAt))
    if (snap === null) throw new Error('fixture did not parse')
    return snap
  }

  // Review 2026-07-09 #7 — REVIEWERS DISAGREED, resolved by THIS test.
  // Required contract for [A#1,B#2,C#3] → [A#1,C#2]:
  //   • C is re-associated (same task identity, moved to #2) — the §5 goal;
  //   • B is DISPLACED to a vacated key, NOT stomped, so it survives snapshot 1
  //     as a first-omission candidate (two-snapshot anti-flap rule);
  //   • B is deleted only after snapshot 2 confirms the removal.
  // Codex was right about the original code (C stomped B's key ⇒ B deleted on
  // the FIRST snapshot); the fix moves B aside instead.
  test('shift with displacement: C re-keyed onto B\'s slot, B survives snapshot 1, dies on snapshot 2', () => {
    // First snapshot: A#1, B#2, C#3.
    const s1 = snapshotOf('3 tasks (1 done, 1 in progress, 1 open)', ['☑ Alpha', '◼ Beta', '◻ Gamma'], 10)
    let state = reconcileTaskState(initialReconciledState('s1'), {
      kind: 'snapshot',
      snapshot: s1,
      verdict: validateSnapshot(s1, binding),
    })
    // Beta (#2) is removed → Gamma shifts from #3 to #2.
    const s2 = snapshotOf('2 tasks (1 done, 0 in progress, 1 open)', ['☑ Alpha', '◻ Gamma'], 20)
    const aligned = realignOrdinals(state, s2)
    const gamma = aligned.tasks.find((t) => t.description === 'Gamma')!
    expect(gamma.ordinal).toBe(2) // re-keyed from #3 to the vacated #2
    expect(gamma.key).toBe('s1:#2')
    // Beta was displaced off #2 (not stomped) — it still exists on its own key.
    const betaAligned = aligned.tasks.find((t) => t.description === 'Beta')!
    expect(betaAligned.ordinal).not.toBe(2)

    // Snapshot 1 reconcile: Gamma preserved as the SAME task; Beta SURVIVES as
    // a first-omission candidate (anti-flap: removal needs TWO omissions).
    state = reconcileTaskState(aligned, {
      kind: 'snapshot',
      snapshot: s2,
      verdict: validateSnapshot(s2, binding),
    })
    expect(state.tasks.map((t) => t.description).sort()).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(state.tasks.find((t) => t.description === 'Gamma')!.paneConfirmed).toBe(true)

    // Snapshot 2 (same content): the SECOND consecutive omission deletes Beta.
    const s3 = snapshotOf('2 tasks (1 done, 0 in progress, 1 open)', ['☑ Alpha', '◻ Gamma'], 30)
    state = reconcileTaskState(realignOrdinals(state, s3), {
      kind: 'snapshot',
      snapshot: s3,
      verdict: validateSnapshot(s3, binding),
    })
    expect(state.tasks.map((t) => t.description).sort()).toEqual(['Alpha', 'Gamma'])
  })

  test('does not re-key when the old ordinal is still present (duplicate/swap, not a clean shift)', () => {
    const s1 = snapshotOf('2 tasks (0 done, 1 in progress, 1 open)', ['◼ Same', '◻ Other'], 10)
    const state = reconcileTaskState(initialReconciledState('s1'), {
      kind: 'snapshot',
      snapshot: s1,
      verdict: validateSnapshot(s1, binding),
    })
    // «Same» appears at BOTH #1 (still there) and a new #2 — not a move.
    const dup = snapshotOf('2 tasks (0 done, 2 in progress, 0 open)', ['◼ Same', '◼ Same'], 20)
    const aligned = realignOrdinals(state, dup)
    expect(aligned.tasks.find((t) => t.key === 's1:#1')!.description).toBe('Same')
  })
})

describe('pure helpers', () => {
  test('numericOrdinal', () => {
    expect(numericOrdinal('3')).toBe(3)
    expect(numericOrdinal('tool-abc')).toBeUndefined()
    expect(numericOrdinal('')).toBeUndefined()
  })
  test('reconciledToTodos appends … for a truncated description', () => {
    const s = [
      '1 tasks (0 done, 1 in progress, 0 open)',
      '◼ Very long task that got cut …',
      '',
      '────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on',
    ].join('\n')
    const snap = parsePaneTaskList(s, { sessionId: 's1', paneTarget: 'p', cwd: '/repo', capturedAt: 1 })!
    const state = reconcileTaskState(initialReconciledState('s1'), {
      kind: 'snapshot',
      snapshot: snap,
      verdict: validateSnapshot(snap, { sessionId: 's1', paneTarget: 'p', cwd: '/repo' }),
    })
    expect(reconciledToTodos(state)[0]!.content.endsWith('…')).toBe(true)
  })
})

describe('owner gate', () => {
  test('non-owner chat is a no-op', async () => {
    const clock = new FakeClock()
    const fx = makeExec(() => VALID_PANE)
    const { sink, views } = makeSink()
    const rm = new TaskRealityMirror({
      exec: fx.exec,
      capture: { paneTarget: 'p', lineCount: 200 },
      log: nullLog,
      sinks: [sink],
      isOwnerChat: (c) => c === 'owner',
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    rm.onSessionStart('stranger', { sessionId: 's1', cwd: '/repo' })
    await flush()
    expect(views).toHaveLength(0)
    expect(fx.captureCount).toBe(0)
  })
})

// ── review fix-loop 2026-07-09 ──────────────────────────────────────────

describe('#4 generation token — in-flight captures across a session change', () => {
  test('a capture started under s1 never commits into the s2 binding', async () => {
    const clock = new FakeClock()
    let resolveCapture: ((r: TmuxExecResult) => void) | null = null
    const exec: TmuxExec = async (args) => {
      if (args.includes('capture-pane')) {
        // First capture hangs until we resolve it manually.
        if (resolveCapture === null) {
          return await new Promise<TmuxExecResult>((r) => {
            resolveCapture = r
          })
        }
        return { stdout: NO_LIST_PANE, stderr: '', exitCode: 0 }
      }
      return { stdout: '/repo\n', stderr: '', exitCode: 0 }
    }
    const { sink, views } = makeSink()
    const rm = makeMirror(exec, clock, sink)

    rm.onSessionStart(CHAT, { sessionId: 's1', cwd: '/repo' }) // capture #1 pending
    await flush()
    expect(resolveCapture).not.toBeNull()

    // Session changes while the capture is in flight.
    rm.onSessionStart(CHAT, { sessionId: 's2', cwd: '/repo' })
    await flush()

    // The old capture finally returns a full s1-era task list.
    resolveCapture!({ stdout: VALID_PANE, stderr: '', exitCode: 0 })
    await flush()

    // Nothing from the stale capture leaked into s2.
    const last = views.at(-1)!
    expect(last.sessionId).toBe('s2')
    expect(last.todos).toHaveLength(0)
    expect(last.freshness.kind).toBe('unverified')
  })
})

describe('#5 TodoWrite as authoritative event snapshot (events-only degrade)', () => {
  const todoWrite = (todos: Array<{ id?: string; content: string; status: 'pending' | 'in_progress' | 'completed' }>): TaskMirrorEvent => ({
    kind: 'todo_write',
    sessionId: 's1',
    todos,
  })

  test('a task removed from the TodoWrite list disappears (no ghosts without tmux)', async () => {
    const clock = new FakeClock()
    const fx = makeExec(() => VALID_PANE, { captureOk: () => false }) // no pane at all
    const { sink, views } = makeSink()
    const rm = makeMirror(fx.exec, clock, sink)

    rm.onTaskEvent(CHAT, todoWrite([
      { id: 'a', content: 'Alpha', status: 'in_progress' },
      { id: 'b', content: 'Beta', status: 'pending' },
      { id: 'c', content: 'Gamma', status: 'pending' },
    ]), { cwd: '/repo' })
    await flush()
    expect(views.at(-1)!.todos.map((t) => t.content)).toEqual(['Alpha', 'Beta', 'Gamma'])

    clock.advance(1000)
    rm.onTaskEvent(CHAT, todoWrite([
      { id: 'a', content: 'Alpha', status: 'completed' },
      { id: 'c', content: 'Gamma', status: 'in_progress' },
    ]), { cwd: '/repo' })
    await flush()
    const last = views.at(-1)!
    expect(last.todos.map((t) => t.content)).toEqual(['Alpha', 'Gamma']) // Beta gone
    expect(last.todos.map((t) => t.status)).toEqual(['completed', 'in_progress'])
  })

  test('identical descriptions with distinct ids stay distinct tasks', async () => {
    const clock = new FakeClock()
    const fx = makeExec(() => NO_LIST_PANE)
    const { sink, views } = makeSink()
    const rm = makeMirror(fx.exec, clock, sink)

    rm.onTaskEvent(CHAT, todoWrite([
      { id: 'a', content: 'Проверить конфиг', status: 'pending' },
      { id: 'b', content: 'Проверить конфиг', status: 'in_progress' },
    ]), { cwd: '/repo' })
    await flush()
    const last = views.at(-1)!
    expect(last.todos).toHaveLength(2)
    expect(last.todos.map((t) => t.status).sort()).toEqual(['in_progress', 'pending'])
  })
})

describe('#6 hard TTL — a missed Stop cannot poll forever', () => {
  test('rec is evicted after ttl even with turnActive stuck true', async () => {
    const clock = new FakeClock()
    const fx = makeExec(() => VALID_PANE)
    const { sink, views } = makeSink()
    const rm = new TaskRealityMirror({
      exec: fx.exec,
      capture: { paneTarget: 'p', lineCount: 200 },
      log: nullLog,
      sinks: [sink],
      ttlMs: 60_000, // short TTL for the test
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })

    rm.onUserPromptSubmit(CHAT, { sessionId: 's1', cwd: '/repo' }) // turn opens…
    await flush()
    // …and Stop NEVER arrives. Ticks keep capturing until the hard TTL.
    clock.advance(30_000)
    await flush()
    const midCount = fx.captureCount
    expect(midCount).toBeGreaterThan(1) // still ticking inside the TTL

    clock.advance(120_000) // idle > ttl ⇒ eviction on the next tick
    await flush()
    const atEvict = fx.captureCount
    const viewsAtEvict = views.length

    clock.advance(300_000) // long after — no timers may fire any more
    await flush()
    expect(fx.captureCount).toBe(atEvict)
    expect(views.length).toBe(viewsAtEvict) // no more Telegram-bound pushes
  })
})

describe('#9 unresolved pane cwd ⇒ snapshot is observational', () => {
  test('display-message failure keeps the view unverified despite a perfect pane list', async () => {
    const clock = new FakeClock()
    const exec: TmuxExec = async (args) => {
      if (args.includes('capture-pane')) return { stdout: VALID_PANE, stderr: '', exitCode: 0 }
      // pane_current_path unobtainable
      return { stdout: '', stderr: 'no server', exitCode: 1 }
    }
    const { sink, views } = makeSink()
    const rm = makeMirror(exec, clock, sink)

    rm.onSessionStart(CHAT, { sessionId: 's1', cwd: '/repo' })
    await flush()
    const last = views.at(-1)!
    expect(last.freshness.kind).toBe('unverified') // NOT fresh
    expect(last.todos).toHaveLength(0) // observational: no task state committed
  })
})

describe('#2 session tombstones in the reality mirror', () => {
  test('late mutation from an ended session is dropped; resume un-tombstones', async () => {
    const clock = new FakeClock()
    const fx = makeExec(() => NO_LIST_PANE)
    const { sink, views } = makeSink()
    const rm = makeMirror(fx.exec, clock, sink)

    rm.onSessionStart(CHAT, { sessionId: 's1', cwd: '/repo' })
    rm.onSessionEnd(CHAT, { sessionId: 's1' })
    await flush()
    const countAfterEnd = views.length

    // Late straggler from s1 — dropped, no view pushed.
    rm.onTaskEvent(CHAT, createEvent('late ghost'), { cwd: '/repo' })
    await flush()
    expect(views.length).toBe(countAfterEnd)

    // Genuine RESUME of s1 legitimizes it again.
    rm.onSessionStart(CHAT, { sessionId: 's1', cwd: '/repo' })
    rm.onTaskEvent(CHAT, createEvent('resumed work'), { cwd: '/repo' })
    await flush()
    expect(views.at(-1)!.todos.map((t) => t.content)).toEqual(['resumed work'])
  })
})

// ── review fix-loop round 2 (2026-07-10) ────────────────────────────────

describe('#2v2 rollback guard — late SessionStart cannot displace an active session', () => {
  test('SessionStart for a tombstoned id while s2 is active is dropped', async () => {
    const clock = new FakeClock()
    const fx = makeExec(() => NO_LIST_PANE)
    const { sink, views } = makeSink()
    const rm = makeMirror(fx.exec, clock, sink)

    rm.onSessionStart(CHAT, { sessionId: 's1', cwd: '/repo' })
    rm.onSessionEnd(CHAT, { sessionId: 's1' }) // s1 tombstoned + evicted
    rm.onSessionStart(CHAT, { sessionId: 's2', cwd: '/repo' })
    rm.onTaskEvent(
      CHAT,
      { kind: 'task_create', sessionId: 's2', toolUseId: 't1', input: { subject: 'Работа s2' } },
      { cwd: '/repo' },
    )
    await flush()
    expect(views.at(-1)!.sessionId).toBe('s2')
    expect(views.at(-1)!.todos.map((t) => t.content)).toEqual(['Работа s2'])

    // Late REPLAYED SessionStart for dead s1: must NOT displace s2.
    rm.onSessionStart(CHAT, { sessionId: 's1', cwd: '/repo' })
    await flush()
    const last = views.at(-1)!
    expect(last.sessionId).toBe('s2')
    expect(last.todos.map((t) => t.content)).toEqual(['Работа s2'])

    // And s1 stays tombstoned — its mutations remain dropped.
    const count = views.length
    rm.onTaskEvent(
      CHAT,
      { kind: 'task_create', sessionId: 's1', toolUseId: 't2', input: { subject: 'призрак' } },
      { cwd: '/repo' },
    )
    await flush()
    expect(views.length).toBe(count)
  })
})

describe('#3 observation revision — same-session mutations invalidate in-flight captures', () => {
  test('a TodoWrite landing during cwd resolution discards the older pane text', async () => {
    const clock = new FakeClock()
    let releaseCwd: ((r: TmuxExecResult) => void) | null = null
    const exec: TmuxExec = async (args) => {
      if (args.includes('capture-pane')) {
        // Pane text fetched instantly — it still claims «Написать тесты» is in_progress.
        return { stdout: VALID_PANE, stderr: '', exitCode: 0 }
      }
      // display-message hangs until we release it.
      return await new Promise<TmuxExecResult>((r) => {
        releaseCwd = r
      })
    }
    const { sink, views } = makeSink()
    const rm = makeMirror(exec, clock, sink)

    rm.onSessionStart(CHAT, { sessionId: 's1', cwd: '/repo' }) // capture starts, hangs on cwd
    await flush()
    expect(releaseCwd).not.toBeNull()

    // While the capture is stuck: the harness reports «Написать тесты» done.
    rm.onTaskEvent(
      CHAT,
      {
        kind: 'todo_write',
        sessionId: 's1',
        todos: [
          { id: '1', content: 'Собрать модуль', status: 'completed' },
          { id: '2', content: 'Написать тесты', status: 'completed' },
          { id: '3', content: 'Ревью', status: 'in_progress' },
        ],
      },
      { cwd: '/repo' },
    )
    await flush()

    // The stale capture finally resolves — it must be DISCARDED wholesale.
    releaseCwd!({ stdout: '/repo\n', stderr: '', exitCode: 0 })
    await flush()

    const last = views.at(-1)!
    // Event truth stands: «Написать тесты» stays completed (the stale pane
    // said in_progress), and the view was never marked pane-fresh.
    const testsTask = last.todos.find((t) => t.content === 'Написать тесты')!
    expect(testsTask.status).toBe('completed')
    expect(last.freshness.kind).toBe('unverified')
  })
})

describe('#4 event-removal tombstones for pane-confirmed tasks', () => {
  const fullList = (): TaskMirrorEvent => ({
    kind: 'todo_write',
    sessionId: 's1',
    todos: [
      { id: '1', content: 'Собрать модуль', status: 'completed' },
      { id: '2', content: 'Написать тесты', status: 'in_progress' },
    ],
  })

  test('pane-confirm → TodoWrite omits → tmux dies → task is GONE (no ghost)', async () => {
    const clock = new FakeClock()
    let tmuxAlive = true
    const fx = makeExec(() => VALID_PANE, { captureOk: () => tmuxAlive })
    const { sink, views } = makeSink()
    const rm = makeMirror(fx.exec, clock, sink)

    rm.onSessionStart(CHAT, { sessionId: 's1', cwd: '/repo' }) // pane confirms 3 tasks
    await flush()
    expect(views.at(-1)!.todos).toHaveLength(3)

    tmuxAlive = false // tmux dies BEFORE the removal
    clock.advance(1000)
    rm.onTaskEvent(CHAT, fullList(), { cwd: '/repo' }) // «Ревью» omitted
    await flush()
    const afterRemove = views.at(-1)!
    expect(afterRemove.todos.map((t) => t.content)).toEqual(['Собрать модуль', 'Написать тесты'])

    // Ticks keep failing to capture — the tombstone must hold forever.
    clock.advance(60_000)
    await flush()
    const last = views.at(-1)!
    expect(last.todos.some((t) => t.content === 'Ревью')).toBe(false)
  })

  test('a NEWER pane snapshot may resurrect the removed task (pane is higher authority)', async () => {
    const clock = new FakeClock()
    const fx = makeExec(() => VALID_PANE)
    const { sink, views } = makeSink()
    const rm = makeMirror(fx.exec, clock, sink)

    rm.onSessionStart(CHAT, { sessionId: 's1', cwd: '/repo' })
    await flush()
    clock.advance(1000)
    rm.onTaskEvent(CHAT, fullList(), { cwd: '/repo' }) // «Ревью» removed by event
    await flush()
    expect(views.at(-1)!.todos.some((t) => t.content === 'Ревью')).toBe(false)

    // The pane STILL renders «Ревью» and a NEWER capture confirms it → back.
    clock.advance(30_000) // periodic tick captures again (capturedAt > removal)
    await flush()
    expect(views.at(-1)!.todos.some((t) => t.content === 'Ревью')).toBe(true)
  })

  test('enforceEventRemovals: a STALE pane snapshot may not resurrect', () => {
    const binding: SessionBinding = { sessionId: 's1', paneTarget: 'p', cwd: '/repo' }
    const text = [
      '1 tasks (0 done, 1 in progress, 0 open)',
      '◼ Старая задача',
      '',
      '────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on',
    ].join('\n')
    const snap = parsePaneTaskList(text, { sessionId: 's1', paneTarget: 'p', cwd: '/repo', capturedAt: 10 })!
    let state = reconcileTaskState(initialReconciledState('s1'), {
      kind: 'snapshot',
      snapshot: snap,
      verdict: validateSnapshot(snap, binding),
    })
    // TodoWrite at t=20 removed it (tombstone), but a stale pane (t=10) re-added it.
    const removed = new Map<string, number>([['s1:#1', 20]])
    state = enforceEventRemovals(state, removed, 10)
    expect(state.tasks).toHaveLength(0) // stale pane may not resurrect
    expect(removed.has('s1:#1')).toBe(true) // tombstone kept

    // A NEWER pane (t=30) clears the tombstone.
    const state2 = enforceEventRemovals(state, removed, 30)
    expect(removed.has('s1:#1')).toBe(false)
    expect(state2.tasks).toHaveLength(0) // (this newer pane omitted it — stays gone)
  })
})

describe('#7 hard-TTL eviction pushes a terminal «expired» view', () => {
  test('last view before silence is kind=expired', async () => {
    const clock = new FakeClock()
    const fx = makeExec(() => VALID_PANE)
    const { sink, views } = makeSink()
    const rm = new TaskRealityMirror({
      exec: fx.exec,
      capture: { paneTarget: 'p', lineCount: 200 },
      log: nullLog,
      sinks: [sink],
      ttlMs: 60_000,
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    rm.onUserPromptSubmit(CHAT, { sessionId: 's1', cwd: '/repo' })
    await flush()
    clock.advance(200_000) // way past the TTL — eviction tick fires
    await flush()
    const last = views.at(-1)!
    expect(last.freshness.kind).toBe('expired')
    expect(last.todos).toHaveLength(3) // frozen state, not wiped

    const countAtEvict = views.length
    clock.advance(300_000)
    await flush()
    expect(views.length).toBe(countAtEvict) // silence after the terminal push
  })
})

describe('#8 displacement chains — full permutation in one pass', () => {
  const binding: SessionBinding = { sessionId: 's1', paneTarget: 'p', cwd: '/repo' }
  const provAt = (capturedAt: number): PaneProvenance => ({
    sessionId: 's1',
    paneTarget: 'p',
    cwd: '/repo',
    capturedAt,
  })
  const chrome = ['', '────────────────────────────────────────', '  ⏵⏵ bypass permissions on']
  const snapOf = (header: string, lines: string[], at: number) =>
    parsePaneTaskList([header, ...lines, ...chrome].join('\n'), provAt(at))!

  test('[A,B,C,D]→[A,C,D]: C and D re-associate in ONE snapshot; B removal still needs two', () => {
    const s1 = snapOf('4 tasks (1 done, 1 in progress, 2 open)', ['☑ Alpha', '◼ Beta', '◻ Gamma', '◻ Delta'], 10)
    let state = reconcileTaskState(initialReconciledState('s1'), {
      kind: 'snapshot',
      snapshot: s1,
      verdict: validateSnapshot(s1, binding),
    })
    // B removed → C shifts 3→2, D shifts 4→3 (a CHAIN: pre-fix C was refused
    // because ordinal 3 was still present — it belongs to D's new slot).
    const s2 = snapOf('3 tasks (1 done, 0 in progress, 2 open)', ['☑ Alpha', '◻ Gamma', '◻ Delta'], 20)
    const aligned = realignOrdinals(state, s2)
    expect(aligned.tasks.find((t) => t.description === 'Gamma')!.ordinal).toBe(2)
    expect(aligned.tasks.find((t) => t.description === 'Delta')!.ordinal).toBe(3)
    // Beta displaced off #2, NOT stomped.
    expect(aligned.tasks.find((t) => t.description === 'Beta')!.ordinal).not.toBe(2)

    state = reconcileTaskState(aligned, {
      kind: 'snapshot',
      snapshot: s2,
      verdict: validateSnapshot(s2, binding),
    })
    // ONE snapshot: C, D converged onto their new keys; B survives (first omission).
    expect(state.tasks.find((t) => t.ordinal === 2)!.description).toBe('Gamma')
    expect(state.tasks.find((t) => t.ordinal === 3)!.description).toBe('Delta')
    expect(state.tasks.some((t) => t.description === 'Beta')).toBe(true)

    // An intervening ordinal-2 event now targets GAMMA (the task actually at
    // #2), not the displaced Beta (pre-fix it hit the wrong task).
    state = reconcileTaskState(state, {
      kind: 'event',
      event: { ordinal: 2, status: 'completed', description: 'Gamma', at: 25 },
    })
    expect(state.tasks.find((t) => t.description === 'Gamma')!.status).toBe('completed')
    expect(state.tasks.find((t) => t.description === 'Beta')!.status).toBe('in_progress')

    // Second consecutive omission deletes Beta.
    const s3 = snapOf('3 tasks (2 done, 0 in progress, 1 open)', ['☑ Alpha', '☑ Gamma', '◻ Delta'], 30)
    state = reconcileTaskState(realignOrdinals(state, s3), {
      kind: 'snapshot',
      snapshot: s3,
      verdict: validateSnapshot(s3, binding),
    })
    expect(state.tasks.some((t) => t.description === 'Beta')).toBe(false)
  })

  test('a genuine SWAP re-associates atomically (full permutation)', () => {
    const s1 = snapOf('2 tasks (0 done, 1 in progress, 1 open)', ['◼ Alpha', '◻ Beta'], 10)
    let state = reconcileTaskState(initialReconciledState('s1'), {
      kind: 'snapshot',
      snapshot: s1,
      verdict: validateSnapshot(s1, binding),
    })
    const s2 = snapOf('2 tasks (0 done, 1 in progress, 1 open)', ['◻ Beta', '◼ Alpha'], 20)
    const aligned = realignOrdinals(state, s2)
    expect(aligned.tasks.find((t) => t.description === 'Alpha')!.ordinal).toBe(2)
    expect(aligned.tasks.find((t) => t.description === 'Beta')!.ordinal).toBe(1)
    state = reconcileTaskState(aligned, {
      kind: 'snapshot',
      snapshot: s2,
      verdict: validateSnapshot(s2, binding),
    })
    expect(state.tasks).toHaveLength(2)
    expect(state.tasks.find((t) => t.ordinal === 1)!.description).toBe('Beta')
    expect(state.tasks.find((t) => t.ordinal === 2)!.description).toBe('Alpha')
  })
})

// ── review fix-loop round 3 (2026-07-10) ────────────────────────────────

const r3TmpDirs: string[] = []
function r3StateDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'task-reality-'))
  r3TmpDirs.push(d)
  return d
}
afterEach(() => {
  for (const d of r3TmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

describe('r3 #1 — reality-mirror epochs persist across a restart', () => {
  test('a late SessionStart for a pre-restart-ended session cannot displace restored s2', async () => {
    const dir = r3StateDir()
    const clock = new FakeClock()
    const fx = makeExec(() => NO_LIST_PANE)
    const mk = (): { rm: TaskRealityMirror; views: ReconciledView[] } => {
      const { sink, views } = makeSink()
      const rm = new TaskRealityMirror({
        exec: fx.exec,
        capture: { paneTarget: 'p', lineCount: 200 },
        log: nullLog,
        sinks: [sink],
        stateDir: dir,
        now: () => clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      })
      return { rm, views }
    }

    const first = mk()
    first.rm.onSessionStart(CHAT, { sessionId: 's1', cwd: '/repo' })
    first.rm.onSessionEnd(CHAT, { sessionId: 's1' }) // tombstoned + persisted
    first.rm.onSessionStart(CHAT, { sessionId: 's2', cwd: '/repo' }) // active=s2, persisted
    await flush()

    // «Restart»: fresh instance, same state dir. Pre-fix the epoch was
    // process-local — the late s1 SessionStart displaced restored s2.
    const second = mk()
    second.rm.onSessionStart(CHAT, { sessionId: 's1', cwd: '/repo' }) // late straggler
    await flush()
    expect(second.views).toHaveLength(0) // dropped — no view for dead s1

    // s1 mutations stay dropped; s2 flows normally.
    second.rm.onTaskEvent(
      CHAT,
      { kind: 'task_create', sessionId: 's1', toolUseId: 't1', input: { subject: 'призрак' } },
      { cwd: '/repo' },
    )
    await flush()
    expect(second.views).toHaveLength(0)

    second.rm.onTaskEvent(
      CHAT,
      { kind: 'task_create', sessionId: 's2', toolUseId: 't2', input: { subject: 'живое s2' } },
      { cwd: '/repo' },
    )
    await flush()
    expect(second.views.at(-1)!.sessionId).toBe('s2')
    expect(second.views.at(-1)!.todos.map((t) => t.content)).toEqual(['живое s2'])
  })
})

describe('r3 #3 — TodoWrite re-add clears the removal tombstone', () => {
  test('remove → re-add same key → same-millisecond snapshot: the task survives', async () => {
    const clock = new FakeClock()
    const fx = makeExec(() => VALID_PANE)
    const { sink, views } = makeSink()
    // coalesceWindowMs: 0 so triggered captures run immediately at the SAME
    // clock instant as the events — the equal-millisecond edge.
    const rm = new TaskRealityMirror({
      exec: fx.exec,
      capture: { paneTarget: 'p', lineCount: 200 },
      log: nullLog,
      sinks: [sink],
      coalesceWindowMs: 0,
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })

    rm.onSessionStart(CHAT, { sessionId: 's1', cwd: '/repo' }) // pane confirms 3 tasks
    await flush()
    expect(views.at(-1)!.todos).toHaveLength(3)

    // Same clock instant: TodoWrite removes «Ревью» (#3), then re-adds it.
    rm.onTaskEvent(
      CHAT,
      {
        kind: 'todo_write',
        sessionId: 's1',
        todos: [
          { id: '1', content: 'Собрать модуль', status: 'completed' },
          { id: '2', content: 'Написать тесты', status: 'in_progress' },
        ],
      },
      { cwd: '/repo' },
    )
    rm.onTaskEvent(
      CHAT,
      {
        kind: 'todo_write',
        sessionId: 's1',
        todos: [
          { id: '1', content: 'Собрать модуль', status: 'completed' },
          { id: '2', content: 'Написать тесты', status: 'in_progress' },
          { id: '3', content: 'Ревью', status: 'pending' },
        ],
      },
      { cwd: '/repo' },
    )
    await flush()

    // A capture at the SAME millisecond (capturedAt == removal at). Pre-fix
    // enforceEventRemovals deleted the valid re-addition (capturedAt > at is
    // false ⇒ stale-pane branch). Post-fix the re-add cleared the tombstone.
    rm.onStop(CHAT) // immediate capture (coalesce window is 0)
    await flush()
    const last = views.at(-1)!
    expect(last.todos.some((t) => t.content === 'Ревью')).toBe(true)
  })
})

describe('r3 #4 — descriptions duplicated in the SNAPSHOT do not participate', () => {
  test('committed [X#1, A#2] vs snapshot [A#1, A#2] → no remap of A', () => {
    const binding: SessionBinding = { sessionId: 's1', paneTarget: 'p', cwd: '/repo' }
    const provAt = (capturedAt: number): PaneProvenance => ({
      sessionId: 's1',
      paneTarget: 'p',
      cwd: '/repo',
      capturedAt,
    })
    const chrome = ['', '────────────────────────────────────────', '  ⏵⏵ bypass permissions on']
    const snapOf = (header: string, lines: string[], at: number) =>
      parsePaneTaskList([header, ...lines, ...chrome].join('\n'), provAt(at))!

    const s1 = snapOf('2 tasks (0 done, 1 in progress, 1 open)', ['◼ Задача X', '◻ Задача A'], 10)
    const state = reconcileTaskState(initialReconciledState('s1'), {
      kind: 'snapshot',
      snapshot: s1,
      verdict: validateSnapshot(s1, binding),
    })

    // Snapshot repeats «Задача A» twice — which copy corresponds to the
    // committed A#2 is ambiguous ⇒ NO remap; X#1 follows the omission rules.
    const dup = snapOf('2 tasks (0 done, 2 in progress, 0 open)', ['◼ Задача A', '◼ Задача A'], 20)
    const aligned = realignOrdinals(state, dup)
    expect(aligned.tasks.find((t) => t.description === 'Задача A')!.ordinal).toBe(2)
    expect(aligned.tasks.find((t) => t.description === 'Задача X')!.ordinal).toBe(1)

    // X survives snapshot 1 as a first-omission candidate (two-snapshot rule)…
    let next = reconcileTaskState(aligned, {
      kind: 'snapshot',
      snapshot: dup,
      verdict: validateSnapshot(dup, binding),
    })
    expect(next.tasks.some((t) => t.description === 'Задача X')).toBe(true)

    // …and is dropped by the SECOND consecutive omission.
    const dup2 = snapOf('2 tasks (0 done, 2 in progress, 0 open)', ['◼ Задача A', '◼ Задача A'], 30)
    next = reconcileTaskState(realignOrdinals(next, dup2), {
      kind: 'snapshot',
      snapshot: dup2,
      verdict: validateSnapshot(dup2, binding),
    })
    expect(next.tasks.some((t) => t.description === 'Задача X')).toBe(false)
  })
})
