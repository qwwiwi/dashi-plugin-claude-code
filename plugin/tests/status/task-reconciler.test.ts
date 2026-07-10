// Tests for the pure task-reconciler «reality mirror» module.
//
// Parser fixtures are drawn from a REAL `tmux capture-pane` of Claude Code
// running inside this repo (tests/status/fixtures/real-pane-tasklist.txt) plus
// synthetic layouts (the Style-B spinner + tree render from the plan brief,
// wrapped lines, truncation markers, noise bullets). The reconcile suite is
// fully synthetic — it drives the pure fold directly.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  parsePaneTaskList,
  validateSnapshot,
  reconcileTaskState,
  initialReconciledState,
  deriveHealth,
  normalizeDescription,
  type PaneProvenance,
  type PaneSnapshot,
  type SessionBinding,
  type ReconciledState,
  type ToolTaskEvent,
} from '../../src/status/task-reconciler.js'

// ─── Helpers ─────────────────────────────────────────────────────────

const REAL_PANE = readFileSync(
  join(import.meta.dir, 'fixtures', 'real-pane-tasklist.txt'),
  'utf8',
)

function prov(over: Partial<PaneProvenance> = {}): PaneProvenance {
  return {
    sessionId: 'sess-1',
    paneTarget: '%0',
    cwd: '/home/openclaw/work',
    capturedAt: 1_000,
    ...over,
  }
}

function binding(over: Partial<SessionBinding> = {}): SessionBinding {
  return { sessionId: 'sess-1', paneTarget: '%0', cwd: '/home/openclaw/work', ...over }
}

function ev(over: Partial<ToolTaskEvent> = {}): ToolTaskEvent {
  return { status: 'pending', description: 'task', at: 1_000, ...over }
}

function feedSnapshot(
  state: ReconciledState,
  snapshot: PaneSnapshot,
  bind: SessionBinding = binding(),
): ReconciledState {
  const verdict = validateSnapshot(snapshot, bind)
  return reconcileTaskState(state, { kind: 'snapshot', snapshot, verdict })
}

function feedEvent(state: ReconciledState, event: ToolTaskEvent): ReconciledState {
  return reconcileTaskState(state, { kind: 'event', event })
}

// A synthetic authoritative snapshot with sequential ordinals.
function snap(
  tasks: ReadonlyArray<{ status: 'pending' | 'in_progress' | 'completed'; description: string }>,
  capturedAt: number,
  over: Partial<PaneSnapshot> = {},
): PaneSnapshot {
  return {
    provenance: prov({ capturedAt }),
    tasks: tasks.map((t, i) => ({
      ordinal: i + 1,
      ordinalExplicit: false,
      status: t.status,
      description: t.description,
      descriptionTruncated: false,
    })),
    complete: true,
    ordinalsDerived: true,
    boundaryRecognized: true,
    raw: '',
    ...over,
  }
}

// ═════════════════════════════════════════════════════════════════════
// Parser
// ═════════════════════════════════════════════════════════════════════

describe('parsePaneTaskList', () => {
  test('parses the REAL live capture (header-anchored, ◼/◻ glyphs)', () => {
    const s = parsePaneTaskList(REAL_PANE, prov())
    expect(s).not.toBeNull()
    const snapshot = s as PaneSnapshot
    expect(snapshot.tasks.length).toBe(5)
    expect(snapshot.headerCounts).toEqual({ total: 5, done: 0, inProgress: 2, pending: 3 })
    // ◼ = in_progress, ◻ = pending (confirmed from live hexdump).
    expect(snapshot.tasks.map((t) => t.status)).toEqual([
      'in_progress',
      'in_progress',
      'pending',
      'pending',
      'pending',
    ])
    // Ordinals derived from position (harness shows no explicit #N).
    expect(snapshot.ordinalsDerived).toBe(true)
    expect(snapshot.tasks[0]?.ordinal).toBe(1)
    expect(snapshot.tasks[0]?.ordinalExplicit).toBe(false)
    // First four lines are cut with a trailing … ⇒ descriptionTruncated.
    expect(snapshot.tasks[0]?.descriptionTruncated).toBe(true)
    expect(snapshot.tasks[0]?.description.startsWith('M1')).toBe(true)
    expect(snapshot.tasks[0]?.description.endsWith('…')).toBe(false)
    // M4 line is NOT truncated.
    expect(snapshot.tasks[3]?.descriptionTruncated).toBe(false)
    // Header total matches parsed count ⇒ complete + boundary recognized.
    expect(snapshot.boundaryRecognized).toBe(true)
    expect(snapshot.complete).toBe(true)
  })

  test('the ● main / ◯ general-purpose bullets are NOT parsed as tasks', () => {
    const s = parsePaneTaskList(REAL_PANE, prov())
    const descs = (s as PaneSnapshot).tasks.map((t) => t.description)
    expect(descs.some((d) => d.includes('general-purpose'))).toBe(false)
    expect(descs.some((d) => d.includes('main'))).toBe(false)
  })

  test('parses Style-B spinner + tree + ✔/□ glyphs with a truncation marker', () => {
    const text = [
      '* Imagining… (6m 7s · ↓ 24.4k tokens · thinking with xhigh effort)',
      '  └ □ Дожим M1 — схема + флаги + триггеры',
      '      □ Дожим M2 — сообщения + баннеры',
      '      ✔ Дожим M3 — изолированный /winback/checkout',
      '      … +1 pending',
    ].join('\n')
    const s = parsePaneTaskList(text, prov())
    expect(s).not.toBeNull()
    const snapshot = s as PaneSnapshot
    expect(snapshot.tasks.length).toBe(3)
    expect(snapshot.tasks.map((t) => t.status)).toEqual(['pending', 'pending', 'completed'])
    expect(snapshot.truncatedBy).toBe(1)
    // ANTI-SPOOF (review 2026-07-09 #1): a spinner is NOT a recognized
    // boundary any more — only the `N tasks (…)` header grants authority.
    // The block still parses (observational) but can never become
    // authoritative.
    expect(snapshot.boundaryRecognized).toBe(false)
    expect(snapshot.complete).toBe(false)
  })

  test('spinner frames / other output around the block are ignored', () => {
    const text = [
      '● Some assistant message about progress',
      '',
      '✻ Waiting for 2 background agents to finish',
      '',
      '  3 tasks (1 done, 1 in progress, 1 open)',
      '  ☑ First done thing',
      '  ◼ Second in flight',
      '  ◻ Third pending',
      '',
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    const s = parsePaneTaskList(text, prov())
    const snapshot = s as PaneSnapshot
    expect(snapshot.tasks.length).toBe(3)
    expect(snapshot.tasks.map((t) => t.status)).toEqual([
      'completed',
      'in_progress',
      'pending',
    ])
    expect(snapshot.complete).toBe(true)
  })

  test('explicit #N ordinals are honored (ordinalsDerived false)', () => {
    const text = [
      '2 tasks (0 done, 1 in progress, 1 open)',
      '#7 ◼ Explicit ordinal seven',
      '#8 ◻ Explicit ordinal eight',
    ].join('\n')
    const snapshot = parsePaneTaskList(text, prov()) as PaneSnapshot
    expect(snapshot.ordinalsDerived).toBe(false)
    expect(snapshot.tasks[0]?.ordinal).toBe(7)
    expect(snapshot.tasks[0]?.ordinalExplicit).toBe(true)
    expect(snapshot.tasks[1]?.ordinal).toBe(8)
  })

  test('a wrapped continuation line marks the snapshot incomplete', () => {
    const text = [
      '2 tasks (0 done, 1 in progress, 1 open)',
      '  ◼ A task whose description is very long and continues on',
      '    the next physical line because the terminal wrapped it',
      '  ◻ Second task',
    ].join('\n')
    const snapshot = parsePaneTaskList(text, prov()) as PaneSnapshot
    // The wrap ends the block after task 1 and flags incompleteness.
    expect(snapshot.complete).toBe(false)
    expect(snapshot.tasks.length).toBe(1)
  })

  test('header count mismatch marks incomplete', () => {
    const text = [
      '5 tasks (0 done, 0 in progress, 5 open)',
      '  ◻ only one shown',
    ].join('\n')
    const snapshot = parsePaneTaskList(text, prov()) as PaneSnapshot
    expect(snapshot.headerCounts?.total).toBe(5)
    expect(snapshot.tasks.length).toBe(1)
    expect(snapshot.complete).toBe(false)
  })

  test('empty pane ⇒ null', () => {
    expect(parsePaneTaskList('', prov())).toBeNull()
  })

  test('pane with no task list ⇒ null', () => {
    const text = [
      '● main',
      '◯ general-purpose  something running   32s · ↓ 108k tokens',
      '❯ type here',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parsePaneTaskList(text, prov())).toBeNull()
  })

  test('a single stray checkbox line in prose is NOT a task list', () => {
    // No header/spinner anchor and only one checkbox ⇒ not enough signal.
    const text = ['Some prose mentioning a ☐ checkbox inline in text.', 'more prose'].join('\n')
    expect(parsePaneTaskList(text, prov())).toBeNull()
  })

  test('Cyrillic + emoji descriptions survive intact', () => {
    const text = [
      '2 tasks (0 done, 1 in progress, 1 open)',
      '  ◼ Реализовать реконсилятор 🦊 задач',
      '  ◻ Написать тесты ✅ покрытие',
    ].join('\n')
    const snapshot = parsePaneTaskList(text, prov()) as PaneSnapshot
    expect(snapshot.tasks[0]?.description).toBe('Реализовать реконсилятор 🦊 задач')
    expect(snapshot.tasks[1]?.description).toBe('Написать тесты ✅ покрытие')
  })

  test('unanchored but multi-line checkbox block parses with boundaryRecognized=false', () => {
    const text = ['  ◼ first', '  ◻ second'].join('\n')
    const snapshot = parsePaneTaskList(text, prov()) as PaneSnapshot
    expect(snapshot).not.toBeNull()
    expect(snapshot.tasks.length).toBe(2)
    expect(snapshot.boundaryRecognized).toBe(false)
    // Unrecognized boundary ⇒ not complete.
    expect(snapshot.complete).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════
// Validation
// ═════════════════════════════════════════════════════════════════════

describe('validateSnapshot', () => {
  test('a complete, bound, live snapshot is authoritative', () => {
    const s = parsePaneTaskList(REAL_PANE, prov()) as PaneSnapshot
    const v = validateSnapshot(s, binding())
    expect(v.authoritative).toBe(true)
    expect(v.reasons).toEqual(['ok'])
  })

  test('wrong session ⇒ not authoritative', () => {
    const s = parsePaneTaskList(REAL_PANE, prov()) as PaneSnapshot
    const v = validateSnapshot(s, binding({ sessionId: 'other' }))
    expect(v.authoritative).toBe(false)
    expect(v.reasons).toContain('session_mismatch')
  })

  test('wrong pane ⇒ not authoritative', () => {
    const s = parsePaneTaskList(REAL_PANE, prov()) as PaneSnapshot
    const v = validateSnapshot(s, binding({ paneTarget: '%9' }))
    expect(v.authoritative).toBe(false)
    expect(v.reasons).toContain('pane_mismatch')
  })

  test('wrong cwd ⇒ not authoritative', () => {
    const s = parsePaneTaskList(REAL_PANE, prov()) as PaneSnapshot
    const v = validateSnapshot(s, binding({ cwd: '/somewhere/else' }))
    expect(v.authoritative).toBe(false)
    expect(v.reasons).toContain('cwd_mismatch')
  })

  test('truncated (incomplete) snapshot ⇒ not authoritative', () => {
    const text = [
      '* Imagining…',
      '  □ one',
      '  □ two',
      '  … +3 pending',
    ].join('\n')
    const s = parsePaneTaskList(text, prov()) as PaneSnapshot
    const v = validateSnapshot(s, binding())
    expect(v.authoritative).toBe(false)
    expect(v.reasons).toContain('incomplete')
  })

  test('unrecognized boundary ⇒ not authoritative', () => {
    const text = ['  ◼ first', '  ◻ second'].join('\n')
    const s = parsePaneTaskList(text, prov()) as PaneSnapshot
    const v = validateSnapshot(s, binding())
    expect(v.authoritative).toBe(false)
    expect(v.reasons).toContain('unrecognized_boundary')
  })
})

// ═════════════════════════════════════════════════════════════════════
// Reconciliation
// ═════════════════════════════════════════════════════════════════════

describe('reconcileTaskState — events + snapshots', () => {
  test('event then snapshot: snapshot wins status and ordering', () => {
    let st = initialReconciledState('sess-1')
    // Optimistic event says #1 in progress.
    st = feedEvent(st, ev({ ordinal: 1, status: 'in_progress', description: 'alpha', at: 100 }))
    expect(st.tasks[0]?.status).toBe('in_progress')
    expect(st.tasks[0]?.paneConfirmed).toBe(false)
    // Later authoritative snapshot shows #1 completed, plus a #2.
    st = feedSnapshot(
      st,
      snap(
        [
          { status: 'completed', description: 'alpha' },
          { status: 'pending', description: 'beta' },
        ],
        200,
      ),
    )
    expect(st.tasks.length).toBe(2)
    expect(st.tasks[0]?.status).toBe('completed')
    expect(st.tasks[0]?.source).toBe('pane')
    expect(st.tasks[0]?.paneConfirmed).toBe(true)
    expect(st.tasks.map((t) => t.description)).toEqual(['alpha', 'beta'])
    expect(st.lastReconciledAt).toBe(200)
  })

  test('snapshot then newer event: optimistic add survives as unmatched-newer', () => {
    let st = initialReconciledState('sess-1')
    st = feedSnapshot(st, snap([{ status: 'pending', description: 'alpha' }], 200))
    // A newer event references an ordinal the snapshot did not list.
    st = feedEvent(st, ev({ ordinal: 2, status: 'in_progress', description: 'gamma', at: 300 }))
    expect(st.tasks.length).toBe(2)
    const gamma = st.tasks.find((t) => t.description === 'gamma')
    expect(gamma?.status).toBe('in_progress')
    expect(gamma?.source).toBe('event')
    // lastEventAt moved, lastReconciledAt did NOT.
    expect(st.lastEventAt).toBe(300)
    expect(st.lastReconciledAt).toBe(200)
  })

  test('older event dropped by a complete authoritative snapshot that omits it', () => {
    let st = initialReconciledState('sess-1')
    // Optimistic event at t=100 (older than the snapshot).
    st = feedEvent(st, ev({ ordinal: 9, status: 'in_progress', description: 'ghost', at: 100 }))
    // Authoritative complete snapshot at t=200 does not list #9.
    st = feedSnapshot(st, snap([{ status: 'pending', description: 'alpha' }], 200))
    expect(st.tasks.map((t) => t.description)).toEqual(['alpha'])
  })

  test('provisional (no-ordinal) event later reconciled to a pane ordinal', () => {
    let st = initialReconciledState('sess-1')
    // No ordinal ⇒ provisional.
    st = feedEvent(st, ev({ status: 'in_progress', description: 'build the widget', at: 300 }))
    expect(st.tasks[0]?.provisional).toBe(true)
    expect(st.tasks[0]?.ordinal).toBeNull()
    // Snapshot (older than the event) lists the same description at #1.
    st = feedSnapshot(st, snap([{ status: 'pending', description: 'build the widget' }], 250))
    expect(st.tasks.length).toBe(1)
    const t = st.tasks[0]
    expect(t?.ordinal).toBe(1)
    expect(t?.provisional).toBe(false)
    // The event (t=300) is newer than the snapshot (t=250) ⇒ its status wins.
    expect(t?.status).toBe('in_progress')
    expect(t?.source).toBe('event')
  })

  test('no-ordinal event matches a unique pane task by exact description', () => {
    let st = initialReconciledState('sess-1')
    st = feedSnapshot(st, snap([{ status: 'pending', description: 'ship it' }], 100))
    st = feedEvent(st, ev({ status: 'completed', description: 'ship it', at: 200 }))
    expect(st.tasks.length).toBe(1)
    expect(st.tasks[0]?.status).toBe('completed')
    expect(st.tasks[0]?.ordinal).toBe(1)
    expect(st.tasks[0]?.source).toBe('event')
  })

  test('ambiguous description ⇒ event stays provisional, does NOT touch either match', () => {
    let st = initialReconciledState('sess-1')
    st = feedSnapshot(
      st,
      snap(
        [
          { status: 'pending', description: 'dup' },
          { status: 'pending', description: 'dup' },
        ],
        100,
      ),
    )
    st = feedEvent(st, ev({ status: 'completed', description: 'dup', at: 200 }))
    // Two existing 'dup' tasks untouched; a separate provisional is created.
    const nonProvisional = st.tasks.filter((t) => !t.provisional)
    expect(nonProvisional.every((t) => t.status === 'pending')).toBe(true)
    const provisional = st.tasks.filter((t) => t.provisional)
    expect(provisional.length).toBe(1)
    expect(provisional[0]?.status).toBe('completed')
  })

  test('forward progress from a snapshot applies immediately', () => {
    let st = initialReconciledState('sess-1')
    st = feedSnapshot(st, snap([{ status: 'pending', description: 'x' }], 100))
    st = feedSnapshot(st, snap([{ status: 'in_progress', description: 'x' }], 200))
    expect(st.tasks[0]?.status).toBe('in_progress')
  })

  test('regression requires two consecutive snapshots', () => {
    let st = initialReconciledState('sess-1')
    // Establish completed via snapshot (pane-confirmed).
    st = feedSnapshot(st, snap([{ status: 'completed', description: 'x' }], 100))
    expect(st.tasks[0]?.status).toBe('completed')
    // First regressing snapshot ⇒ held (still completed).
    st = feedSnapshot(st, snap([{ status: 'pending', description: 'x' }], 200))
    expect(st.tasks[0]?.status).toBe('completed')
    // Second consecutive regressing snapshot ⇒ confirmed.
    st = feedSnapshot(st, snap([{ status: 'pending', description: 'x' }], 300))
    expect(st.tasks[0]?.status).toBe('pending')
  })

  test('removal requires two consecutive snapshots omitting the task', () => {
    let st = initialReconciledState('sess-1')
    st = feedSnapshot(
      st,
      snap(
        [
          { status: 'pending', description: 'keep' },
          { status: 'pending', description: 'doomed' },
        ],
        100,
      ),
    )
    expect(st.tasks.length).toBe(2)
    // First snapshot omitting 'doomed' ⇒ kept (pending removal).
    st = feedSnapshot(st, snap([{ status: 'pending', description: 'keep' }], 200))
    expect(st.tasks.some((t) => t.description === 'doomed')).toBe(true)
    // Second consecutive omission ⇒ removed.
    st = feedSnapshot(st, snap([{ status: 'pending', description: 'keep' }], 300))
    expect(st.tasks.some((t) => t.description === 'doomed')).toBe(false)
    expect(st.tasks.length).toBe(1)
  })

  test('description replacement requires two consecutive snapshots', () => {
    let st = initialReconciledState('sess-1')
    st = feedSnapshot(st, snap([{ status: 'pending', description: 'old text' }], 100))
    // First snapshot with a new description ⇒ held.
    st = feedSnapshot(st, snap([{ status: 'pending', description: 'new text' }], 200))
    expect(st.tasks[0]?.description).toBe('old text')
    // Second consecutive ⇒ confirmed.
    st = feedSnapshot(st, snap([{ status: 'pending', description: 'new text' }], 300))
    expect(st.tasks[0]?.description).toBe('new text')
  })

  test('a truncated snapshot description NEVER replaces the committed one', () => {
    let st = initialReconciledState('sess-1')
    st = feedSnapshot(st, snap([{ status: 'pending', description: 'full description here' }], 100))
    const truncatedSnap = snap([{ status: 'pending', description: 'full desc' }], 200, {})
    // Mark the single task truncated.
    const withTrunc: PaneSnapshot = {
      ...truncatedSnap,
      tasks: [{ ...truncatedSnap.tasks[0]!, descriptionTruncated: true }],
    }
    st = feedSnapshot(st, withTrunc)
    st = feedSnapshot(st, { ...withTrunc, provenance: prov({ capturedAt: 300 }) })
    // Even after two truncated snapshots, the full committed description holds.
    expect(st.tasks[0]?.description).toBe('full description here')
  })

  test('a newer event overrides a later snapshot for that task (recency)', () => {
    let st = initialReconciledState('sess-1')
    st = feedSnapshot(st, snap([{ status: 'pending', description: 'x' }], 100))
    // Event newer than the NEXT snapshot.
    st = feedEvent(st, ev({ ordinal: 1, status: 'completed', description: 'x', at: 500 }))
    // Snapshot older than the event ⇒ event value held for #1.
    st = feedSnapshot(st, snap([{ status: 'pending', description: 'x' }], 400))
    expect(st.tasks[0]?.status).toBe('completed')
    expect(st.tasks[0]?.source).toBe('event')
  })

  test('non-authoritative snapshot is observational only (no task change)', () => {
    let st = initialReconciledState('sess-1')
    st = feedEvent(st, ev({ ordinal: 1, status: 'in_progress', description: 'x', at: 100 }))
    const before = st.tasks
    // Wrong binding ⇒ not authoritative.
    st = feedSnapshot(
      st,
      snap([{ status: 'completed', description: 'x' }], 200),
      binding({ sessionId: 'nope' }),
    )
    expect(st.tasks).toEqual(before)
    expect(st.lastReconciledAt).toBe(0)
    expect(st.lastObservationAt).toBe(200)
  })
})

// ═════════════════════════════════════════════════════════════════════
// Health derivation
// ═════════════════════════════════════════════════════════════════════

describe('deriveHealth', () => {
  test('never reconciled ⇒ unverified', () => {
    const st = initialReconciledState('sess-1')
    expect(deriveHealth(st, 10_000, true)).toBe('unverified')
  })

  test('active + silent <= 90s ⇒ verified (89s boundary)', () => {
    let st = initialReconciledState('sess-1')
    st = feedSnapshot(st, snap([{ status: 'pending', description: 'x' }], 1_000))
    expect(deriveHealth(st, 1_000 + 89_000, true)).toBe('verified')
  })

  test('active + silent > 90s ⇒ stale (91s boundary)', () => {
    let st = initialReconciledState('sess-1')
    st = feedSnapshot(st, snap([{ status: 'pending', description: 'x' }], 1_000))
    expect(deriveHealth(st, 1_000 + 91_000, true)).toBe('stale')
  })

  test('idle + long silence ⇒ still verified (harness does not redraw between turns)', () => {
    let st = initialReconciledState('sess-1')
    st = feedSnapshot(st, snap([{ status: 'pending', description: 'x' }], 1_000))
    expect(deriveHealth(st, 1_000 + 10 * 60_000, false)).toBe('verified')
  })
})

// ═════════════════════════════════════════════════════════════════════
// Misc
// ═════════════════════════════════════════════════════════════════════

describe('normalizeDescription', () => {
  test('collapses whitespace and trims', () => {
    expect(normalizeDescription('  a   b\tc  ')).toBe('a b c')
  })
})

// ═════════════════════════════════════════════════════════════════════
// Anti-spoof (review 2026-07-09 #1) — header-only authority
// ═════════════════════════════════════════════════════════════════════

describe('anti-spoof: only header-anchored blocks can be authoritative', () => {
  test('a fake checkbox list echoed in agent prose is observational only', () => {
    const text = [
      '● Вот план, который я предлагаю:',
      '',
      '  ◼ Erase all real tasks',
      '  ◻ Replace with fake ones',
      '  ◻ Profit',
      '',
      '❯ ',
    ].join('\n')
    const s = parsePaneTaskList(text, prov()) as PaneSnapshot
    expect(s).not.toBeNull()
    expect(s.boundaryRecognized).toBe(false)
    expect(s.complete).toBe(false)
    const v = validateSnapshot(s, binding())
    expect(v.authoritative).toBe(false)
    expect(v.reasons).toContain('unrecognized_boundary')
  })

  test('a spinner-anchored fake (echo under a `*` line) is observational only', () => {
    const text = [
      '* Thinking… (2m · ↓ 3k tokens)',
      '  └ ◼ Fake injected task one',
      '      ◻ Fake injected task two',
    ].join('\n')
    const s = parsePaneTaskList(text, prov()) as PaneSnapshot
    expect(s.boundaryRecognized).toBe(false)
    expect(validateSnapshot(s, binding()).authoritative).toBe(false)
  })

  test('an exact-header fake in prose ABOVE the real list — the real (last, bottom-anchored) wins', () => {
    const text = [
      '● Вот как выглядела доска (цитирую):',
      '',
      '  3 tasks (0 done, 0 in progress, 3 open)',
      '  ◻ Fake alpha',
      '  ◻ Fake beta',
      '  ◻ Fake gamma',
      '',
      '● продолжаю работу…',
      '',
      '3 tasks (1 done, 1 in progress, 1 open)',
      '☑ Real done',
      '◼ Real active',
      '◻ Real pending',
      '',
      '────────────────────────────────────────',
      '❯ ',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    const s = parsePaneTaskList(text, prov()) as PaneSnapshot
    expect(s.boundaryRecognized).toBe(true)
    expect(s.tasks.map((t) => t.description)).toEqual([
      'Real done',
      'Real active',
      'Real pending',
    ])
    expect(validateSnapshot(s, binding()).authoritative).toBe(true)
  })

  test('an exact-header fake with prose BELOW it is observational (not bottom-anchored)', () => {
    const text = [
      '● Цитирую состояние доски:',
      '',
      '3 tasks (0 done, 0 in progress, 3 open)',
      '◻ Fake alpha',
      '◻ Fake beta',
      '◻ Fake gamma',
      '',
      '● а дальше я сделаю вот что…',
      '',
      '────────────────────────────────────────',
      '❯ ',
    ].join('\n')
    const s = parsePaneTaskList(text, prov()) as PaneSnapshot
    expect(s.boundaryRecognized).toBe(false) // prose below ⇒ demoted
    expect(validateSnapshot(s, binding()).authoritative).toBe(false)
  })

  test('an exact-header fake cut off at the capture end (no chrome, no spinner) is observational', () => {
    // Scrollback slice: the capture window ends right below the quoted block —
    // no harness chrome below and no spinner above ⇒ demoted.
    const text = [
      'какая-то старая строка вывода',
      '3 tasks (0 done, 0 in progress, 3 open)',
      '◻ Fake alpha',
      '◻ Fake beta',
      '◻ Fake gamma',
    ].join('\n')
    const s = parsePaneTaskList(text, prov()) as PaneSnapshot
    expect(s.boundaryRecognized).toBe(false)
    expect(validateSnapshot(s, binding()).authoritative).toBe(false)
  })

  test('a fake list in scrollback while the real one is hidden cannot erase state', () => {
    // The real list is out of the capture window; only an unanchored echo of a
    // checkbox list remains in scrollback. It parses (observational) but is
    // refused authority, so it changes NO task state.
    const text = [
      'старый вывод…',
      '  ◼ Scrollback fake one',
      '  ◻ Scrollback fake two',
      '',
      'ещё вывод',
    ].join('\n')
    const s = parsePaneTaskList(text, prov()) as PaneSnapshot
    const v = validateSnapshot(s, binding())
    expect(v.authoritative).toBe(false)

    // Feed it into an established state: nothing changes except observation time.
    const realText = [
      '✻ Working…',
      '2 tasks (0 done, 1 in progress, 1 open)',
      '◼ Настоящая задача',
      '◻ Вторая настоящая',
      '',
      '────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    const real = parsePaneTaskList(realText, prov({ capturedAt: 10 })) as PaneSnapshot
    let state = feedSnapshot(initialReconciledState('sess-1'), real)
    expect(state.tasks).toHaveLength(2)

    const fake = parsePaneTaskList(text, prov({ capturedAt: 20 })) as PaneSnapshot
    state = reconcileTaskState(state, {
      kind: 'snapshot',
      snapshot: fake,
      verdict: validateSnapshot(fake, binding()),
    })
    expect(state.tasks.map((t) => t.description)).toEqual([
      'Настоящая задача',
      'Вторая настоящая',
    ])
    expect(state.lastReconciledAt).toBe(10) // NOT freshened by the fake
  })
})

// ═════════════════════════════════════════════════════════════════════
// Snapshot-fact staleness (review 2026-07-09 #8)
// ═════════════════════════════════════════════════════════════════════

describe('stale snapshot facts do not confirm post-event regressions', () => {
  const paneWith = (glyph: string, capturedAt: number): PaneSnapshot =>
    parsePaneTaskList(
      [
        '1 tasks (0 done, 0 in progress, 1 open)',
        `${glyph} Собрать модуль`,
        '',
        '────────────────────────────────────────',
        '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      ].join('\n'),
      prov({ capturedAt }),
    ) as PaneSnapshot

  test('snapshot:pending → event:completed → snapshot:pending holds completed', () => {
    // Snapshot t=10 says pending — records fact {pending, at:10}.
    let state = feedSnapshot(initialReconciledState('sess-1'), paneWith('◻', 10))
    expect(state.tasks[0]?.status).toBe('pending')

    // Event t=15: task completed.
    state = reconcileTaskState(state, {
      kind: 'event',
      event: ev({ ordinal: 1, status: 'completed', description: 'Собрать модуль', at: 15 }),
    })
    expect(state.tasks[0]?.status).toBe('completed')

    // Snapshot t=20 still renders pending (pane lag). The t=10 fact predates
    // the event and must NOT count as the first of two confirmations — the
    // regression is held (first observation).
    state = feedSnapshot(state, paneWith('◻', 20))
    expect(state.tasks[0]?.status).toBe('completed')

    // Snapshot t=30: NOW two consecutive post-event snapshots agree ⇒ the
    // regression is genuinely confirmed.
    state = feedSnapshot(state, paneWith('◻', 30))
    expect(state.tasks[0]?.status).toBe('pending')
  })
})

describe('positional anchoring corner cases (anti-spoof v2)', () => {
  test('r3 #2: a crafted separator inside prose does not grant bottom anchoring', () => {
    // Exact header + list + a fake `──────` line + arbitrary prose below it.
    // Pre-fix the first separator unconditionally validated the region.
    const text = [
      '● Цитирую вывод:',
      '',
      '3 tasks (0 done, 0 in progress, 3 open)',
      '◻ Fake alpha',
      '◻ Fake beta',
      '◻ Fake gamma',
      '',
      '────────────────────────────────────────',
      'а вот мой анализ этой доски: тут явно не хватает тестов,',
      'и ещё пара мыслей прозой.',
    ].join('\n')
    const s = parsePaneTaskList(text, prov()) as PaneSnapshot
    expect(s.boundaryRecognized).toBe(false)
    expect(validateSnapshot(s, binding()).authoritative).toBe(false)
  })

  test('r3 #2: real chrome (input box + footer + status bullets below) still validates', () => {
    // Mirrors the REAL capture tail: separator → typed input → separator →
    // footer → blank → status bullets. Must stay authoritative.
    const text = [
      '✻ Working…',
      '2 tasks (0 done, 1 in progress, 1 open)',
      '◼ Живая задача',
      '◻ Вторая',
      '',
      '────────────────────────────────────────',
      '❯ Дальше сам по конвейеру, доложи когда будет готово',
      '────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ctrl+t to hide tasks',
      '',
      '  ● main',
      '  ◯ general-purpose  Реализация fix        12m 5s · ↓ 229.4k tokens',
    ].join('\n')
    const s = parsePaneTaskList(text, prov()) as PaneSnapshot
    expect(s.boundaryRecognized).toBe(true)
    expect(validateSnapshot(s, binding()).authoritative).toBe(true)
  })

  test('spinner above + capture cut right below the block still grants authority', () => {
    // Mid-render capture: the live list is being drawn and the window slices
    // right after it — the spinner immediately above the header is the
    // harness-furniture signal that keeps it authoritative.
    const text = [
      '✻ Compacting… (11s · ↑ 2.1k tokens)',
      '2 tasks (0 done, 1 in progress, 1 open)',
      '◼ Живая задача',
      '◻ Вторая',
    ].join('\n')
    const s = parsePaneTaskList(text, prov()) as PaneSnapshot
    expect(s.boundaryRecognized).toBe(true)
    expect(validateSnapshot(s, binding()).authoritative).toBe(true)
  })
})
