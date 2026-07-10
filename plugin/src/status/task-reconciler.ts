// task-reconciler — pure «reality mirror» for the Claude Code task list.
//
// Claude Code (the harness) renders its live task list directly in the tmux
// pane while it works: a header line plus one checkbox line per task, e.g.
//
//     5 tasks (0 done, 2 in progress, 3 open)
//     ◼ M1 — feeders + lifecycle fixes …
//     ◼ M2 — task-reconciler: pane parser + merge …
//     ◻ M3 — integration …
//     ◻ M4 — dual review …
//     ◻ M5 — context-HUD real window limit …
//
// An older/alternate harness layout renders the list under a spinner with a
// tree prefix and a truncation marker:
//
//     * Imagining… (6m 7s · ↓ 24.4k tokens · thinking with xhigh effort)
//       └ □ Task one
//           □ Task two
//           ✔ Task three
//           … +1 pending
//
// This module is a SELF-CONTAINED pure layer — no I/O, no timers, no Telegram.
// It (1) parses that pane text into an ordered task snapshot, (2) decides
// whether the snapshot is authoritative for a given session binding, and
// (3) reconciles the harness snapshot with the plugin's own tool-event stream
// using an anti-flap merge. A later milestone wires it into TmuxMirror / the
// context HUD; nothing here reaches out to those surfaces.
//
// Ground truth for the glyphs and header wording was captured live from
// `tmux capture-pane` of Claude Code running in this repo (see
// tests/status/fixtures/real-pane-tasklist.txt). The Style-B variant matches
// the layout in the plan brief.

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

/** Where a captured pane snapshot came from — the identity we bind against. */
export interface PaneProvenance {
  /** Claude session id that owns the pane we captured. */
  sessionId: string
  /** tmux pane target the capture was taken from (e.g. `%0`). */
  paneTarget: string
  /** `pane_current_path` at capture time. */
  cwd: string
  /** Epoch ms when the capture was taken. */
  capturedAt: number
}

/** A single task parsed from the pane task list. */
export interface ParsedTask {
  /** 1-based position in the visible list, or the explicit `#N` when present. */
  ordinal: number
  /** true when `ordinal` came from a literal `#N`, false when derived from position. */
  ordinalExplicit: boolean
  status: TaskStatus
  description: string
  /** true when the rendered line was cut off (trailing `…`) so the text is partial. */
  descriptionTruncated: boolean
}

/** Counts parsed from a `N tasks (A done, B in progress, C open)` header. */
export interface HeaderCounts {
  total: number
  done: number
  inProgress: number
  pending: number
}

/** Immutable result of parsing one pane capture. */
export interface PaneSnapshot {
  provenance: PaneProvenance
  tasks: ReadonlyArray<ParsedTask>
  /**
   * true only when the block is fully trustworthy: a recognized top boundary
   * (header or spinner), no list-level truncation, no unattributable wrapped
   * lines, and (when a header is present) the header total matches the parsed
   * task count.
   */
  complete: boolean
  /** true when at least one ordinal was derived from position rather than an explicit `#N`. */
  ordinalsDerived: boolean
  /** true when a header / spinner anchored the top of the block. */
  boundaryRecognized: boolean
  /** Present when the block carried a `N tasks (…)` header. */
  headerCounts?: HeaderCounts
  /** Present when a `… +N pending` / `+N ещё` truncation marker was seen. */
  truncatedBy?: number
  /** The raw block text, for debugging / logging. */
  raw: string
}

/** The authoritative live binding a snapshot must match to be trusted. */
export interface SessionBinding {
  sessionId: string
  paneTarget: string
  cwd: string
}

export type VerdictReason =
  | 'ok'
  | 'session_mismatch'
  | 'pane_mismatch'
  | 'cwd_mismatch'
  | 'unrecognized_boundary'
  | 'incomplete'

/** Outcome of {@link validateSnapshot}. Non-authoritative ⇒ observational only. */
export interface SnapshotVerdict {
  authoritative: boolean
  reasons: ReadonlyArray<VerdictReason>
}

/** A task fact observed from the plugin's own tool-event stream (TaskCreate/Update/TodoWrite). */
export interface ToolTaskEvent {
  /** Harness ordinal when known (e.g. parsed from `Task #N`); omit when unknown. */
  ordinal?: number
  status: TaskStatus
  description: string
  /** Epoch ms the event was observed. */
  at: number
}

/** A reconciled task — the merged view of pane truth + optimistic events. */
export interface ReconciledTask {
  /** Canonical key `${sessionId}:#${ordinal}`, or a provisional `${sessionId}:~${desc}`. */
  key: string
  /** Harness ordinal, or null for a provisional event not yet matched to the pane. */
  ordinal: number | null
  status: TaskStatus
  description: string
  descriptionTruncated: boolean
  /** Last source that set this task's status. */
  source: 'pane' | 'event'
  /** true while this task is an unmatched, event-only optimistic guess. */
  provisional: boolean
  /** true once a valid pane snapshot has ever confirmed this task. */
  paneConfirmed: boolean
  /** Epoch ms this task's status/description last changed. */
  updatedAt: number
}

/** Snapshot fingerprint kept for the two-consecutive-snapshot anti-flap rule. */
export interface SnapshotFacts {
  status: TaskStatus
  description: string
  descriptionTruncated: boolean
  /**
   * capturedAt of the snapshot that recorded this fact. A fact only CONFIRMS
   * a change (regression / description swap) when it is at least as new as the
   * committed task's own updatedAt — a fact captured BEFORE an intervening
   * event is stale and must not count as the first of two consecutive
   * confirmations (review 2026-07-09, Codex Med: snapshot:pending →
   * event:completed → snapshot:pending must NOT regress immediately).
   */
  at: number
}

/** The full reconciled state for one session. Treat as immutable between calls. */
export interface ReconciledState {
  sessionId: string
  tasks: ReadonlyArray<ReconciledTask>
  /** Last time ANY tool event was applied. Never freshened by a snapshot. */
  lastEventAt: number
  /** Last time a VALID pane snapshot was applied. Never freshened by an event. */
  lastReconciledAt: number
  /** Last time any snapshot (valid or not) was observed. */
  lastObservationAt: number
  /** Canonical-key → facts from the last VALID snapshot (for removal/regression confirmation). */
  prevSnapshotFacts: ReadonlyMap<string, SnapshotFacts>
}

export type Observation =
  | { readonly kind: 'snapshot'; readonly snapshot: PaneSnapshot; readonly verdict: SnapshotVerdict }
  | { readonly kind: 'event'; readonly event: ToolTaskEvent }

export type ReconciliationHealth = 'verified' | 'unverified' | 'stale'

// ─────────────────────────────────────────────────────────────────────
// Glyph tables (captured live + plan brief)
// ─────────────────────────────────────────────────────────────────────

// Task checkbox glyphs, mapped to status. Deliberately squares + checkmarks
// only — the harness draws subagent / assistant bullets with CIRCLES
// (● U+25CF, ◯ U+25EF), which must NEVER be read as tasks.
const STATUS_BY_GLYPH: Readonly<Record<string, TaskStatus>> = {
  // pending
  '◻': 'pending', // ◻ white medium square (live)
  '□': 'pending', // □ white square (Style-B)
  '☐': 'pending', // ☐ ballot box
  '▫': 'pending', // ▫ white small square
  // in progress
  '◼': 'in_progress', // ◼ black medium square (live)
  '■': 'in_progress', // ■ black square
  '◐': 'in_progress', // ◐ half circle (harness variant per brief)
  '◾': 'in_progress', // ◾ black medium small square
  // completed
  '☑': 'completed', // ☑ ballot box with check
  '✔': 'completed', // ✔ heavy check (Style-B)
  '✓': 'completed', // ✓ check
  '✅': 'completed', // ✅ white heavy check
}

// One checkbox line. Groups: (1) indent, (2) optional explicit `#N`, (3) glyph,
// (4) rest of line. Optional leading tree prefix (└/├/│) is stripped.
const TASK_LINE_RE =
  /^(\s*)(?:[└├│╰╭]\s+)?(?:#(\d+)\s+)?([◻□☐▫◼■◐◾☑✔✓✅])\s+(.*)$/u

// `N tasks (A done, B in progress, C open|pending)` header — the live top anchor.
const HEADER_RE =
  /^\s*(\d+)\s+tasks?\s*\(\s*(\d+)\s+done\s*,\s*(\d+)\s+in\s+progress\s*,\s*(\d+)\s+(?:open|pending)\s*\)\s*$/i

// List-level truncation marker: `… +N pending`, `… +N`, `+N ещё`, `... +N more`.
const TRUNCATION_RE = /^\s*(?:[…]|\.\.\.)?\s*\+(\d+)\b/u

// Spinner / thinking line — the Style-B top anchor. Starts with a spinner glyph
// (or `*`) and carries an ellipsis or a timing / token hint.
const SPINNER_RE =
  /^\s*[*✱✳✶✷✸✻✽❋·]\s+\S/u

// Trailing-ellipsis test: the harness cuts an over-wide line with a trailing `…`.
const TRAILING_ELLIPSIS_RE = /[…]\s*$/u

// ─────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────

interface RawTaskLine {
  lineIndex: number
  indent: number
  ordinalExplicit: number | null
  status: TaskStatus
  description: string
  descriptionTruncated: boolean
}

function classifyTaskLine(line: string, lineIndex: number): RawTaskLine | null {
  const m = TASK_LINE_RE.exec(line)
  if (m === null) return null
  const glyph = m[3] as string
  const status = STATUS_BY_GLYPH[glyph]
  if (status === undefined) return null
  const indent = (m[1] ?? '').length
  const explicit = m[2] !== undefined ? Number.parseInt(m[2], 10) : null
  const rawRest = m[4] ?? ''
  const descriptionTruncated = TRAILING_ELLIPSIS_RE.test(rawRest)
  const description = rawRest.replace(TRAILING_ELLIPSIS_RE, '').trimEnd()
  return {
    lineIndex,
    indent,
    ordinalExplicit: explicit,
    status,
    description,
    descriptionTruncated,
  }
}

interface RawBlock {
  first: number
  taskLines: RawTaskLine[]
  truncatedBy: number | null
  /** an interior line we could not attribute (a wrap) ⇒ incomplete. */
  hasUnattributedLine: boolean
  /** Exclusive index of the first line NOT consumed by this block. */
  end: number
}

/**
 * Collect maximal contiguous runs of task lines. A run continues across task
 * lines; a truncation marker closes it (and records N); a wrap-continuation
 * (indented non-task, non-marker, non-noise line) closes it AND flags it
 * incomplete; anything else (blank, dedented, noise) closes it cleanly.
 */
function collectBlocks(lines: ReadonlyArray<string>): RawBlock[] {
  const blocks: RawBlock[] = []
  let i = 0
  while (i < lines.length) {
    const first = classifyTaskLine(lines[i] ?? '', i)
    if (first === null) {
      i += 1
      continue
    }
    const block: RawBlock = {
      first: i,
      taskLines: [first],
      truncatedBy: null,
      hasUnattributedLine: false,
      end: i + 1,
    }
    const glyphIndent = first.indent
    i += 1
    while (i < lines.length) {
      const line = lines[i] ?? ''
      const task = classifyTaskLine(line, i)
      if (task !== null) {
        block.taskLines.push(task)
        i += 1
        continue
      }
      const trunc = TRUNCATION_RE.exec(line)
      if (trunc !== null) {
        block.truncatedBy = Number.parseInt(trunc[1] as string, 10)
        i += 1
        break
      }
      if (line.trim() === '') break // blank ⇒ clean end
      // A non-task, non-blank line indented at least as deep as the checkbox
      // column, that is not recognized noise, is a wrapped continuation we
      // cannot attribute ⇒ the snapshot is incomplete.
      const indent = line.length - line.trimStart().length
      if (indent >= glyphIndent && !isNoiseLine(line)) {
        block.hasUnattributedLine = true
      }
      break
    }
    // `i` now points at the first line NOT consumed by this block (a truncation
    // marker was consumed; the breaking blank/wrap/dedent line was not).
    block.end = i
    blocks.push(block)
  }
  return blocks
}

// Recognized non-task lines that can legitimately abut a task block without
// implying a wrap: footers, subagent bullets, assistant bullets, spinners,
// headers, box separators, tips.
const NOISE_RES: readonly RegExp[] = [
  /^\s*[●◯○◉]\s/u, // ● ◯ ○ ◉ bullets (assistant / subagent / git)
  /^\s*⏵⏵/u, // ⏵⏵ bypass-permissions footer
  /^\s*[─━]{10,}/u, // ──── input-box separator
  /^\s*(?:[└├]\s+)?Tip:/iu, // Tip lines
  /^\s*Listening for channel messages/iu,
  HEADER_RE,
  SPINNER_RE,
]

function isNoiseLine(line: string): boolean {
  return NOISE_RES.some((re) => re.test(line))
}

/** Nearest non-blank line above `idx`, or null. */
function precedingNonBlank(lines: ReadonlyArray<string>, idx: number): string | null {
  const k = precedingNonBlankIdx(lines, idx)
  return k >= 0 ? (lines[k] ?? '') : null
}

/** Index of the nearest non-blank line above `idx`, or -1. */
function precedingNonBlankIdx(lines: ReadonlyArray<string>, idx: number): number {
  for (let k = idx - 1; k >= 0; k -= 1) {
    const line = lines[k] ?? ''
    if (line.trim() !== '') return k
  }
  return -1
}

// ─── positional anchoring (anti-spoof v2, review 2026-07-10 #1) ────────
//
// Harness chrome: the input-box separator and the ⏵⏵ footer. Once one of
// these appears below the task block, everything under it (input box content,
// subagent-status bullets ● / ◯, hints) is harness furniture by construction —
// the live task list ALWAYS renders directly above the input box.
const CHROME_START_RES: readonly RegExp[] = [
  /^\s*[─━]{10,}/u, // ──── input-box separator
  /^\s*⏵⏵/u, // ⏵⏵ bypass-permissions footer
]

// Furniture-lite: lines that may legitimately sit between the live task block
// and the input box WITHOUT implying prose. Deliberately EXCLUDES assistant /
// subagent bullets (● ◯ ○ ◉) and free text — those mark conversation content,
// which never renders below the live list.
const FURNITURE_LITE_RES: readonly RegExp[] = [
  SPINNER_RE,
  /^\s*(?:[└├]\s+)?Tip:/iu,
  /^\s*Listening for channel messages/iu,
]

function isFurnitureLite(line: string): boolean {
  if (line.trim() === '') return true
  if (TRUNCATION_RE.test(line)) return true
  if (classifyTaskLine(line, 0) !== null) return true
  return FURNITURE_LITE_RES.some((re) => re.test(line))
}

interface BottomRegionVerdict {
  /** No prose between the block and the capture end / harness chrome. */
  clean: boolean
  /** An input-box separator or ⏵⏵ footer was seen below the block. */
  sawChrome: boolean
}

/**
 * Scan the lines BELOW a block (from `end` to capture end). The region is
 * `clean` when only furniture-lite lines appear up to the first harness-chrome
 * line (separator / footer); everything below that first chrome line is the
 * input box + status area and is accepted unconditionally. Any prose line
 * (assistant bullet, free text) before chrome ⇒ not clean.
 */
function scanBottomRegion(lines: ReadonlyArray<string>, end: number): BottomRegionVerdict {
  for (let k = end; k < lines.length; k += 1) {
    const line = lines[k] ?? ''
    if (CHROME_START_RES.some((re) => re.test(line))) {
      return { clean: true, sawChrome: true }
    }
    if (!isFurnitureLite(line)) {
      return { clean: false, sawChrome: false }
    }
  }
  return { clean: true, sawChrome: false }
}

/**
 * Parse the pane text into a task snapshot, or null when no task list is
 * present. When several blocks exist, the freshest (last) block wins: a
 * HEADER-anchored block is preferred; failing that, the last block of >= 2
 * task lines is accepted with `boundaryRecognized = false`.
 *
 * ANTI-SPOOF (review 2026-07-09 + v2 2026-07-10): boundary recognition
 * (⇒ authority-eligibility) requires ALL of:
 *   1. a `N tasks (A done, B in progress, C open)` HEADER above the block —
 *      spinner lines never anchor (trivially reproduced in prose);
 *   2. the block is the LAST header-anchored block in the capture (a quoted
 *      list echoed in prose sits ABOVE the live list, which the harness
 *      always renders directly above the input box);
 *   3. POSITIONAL bottom anchoring: nothing but furniture (blank lines,
 *      task/truncation lines, spinner/Tip lines) between the block and the
 *      first piece of harness chrome (input-box `────` separator / `⏵⏵`
 *      footer) or the capture end — any prose below the block demotes it;
 *   4. harness-furniture presence: a spinner line immediately above the
 *      header OR harness chrome below the block. A block cut off at the very
 *      end of the capture with neither is scrollback, not the live list.
 * A block failing 2-4 still parses (observational: it feeds reconciliation
 * health) but carries `boundaryRecognized=false` ⇒ {@link validateSnapshot}
 * refuses authority (`unrecognized_boundary`).
 *
 * RESIDUAL RISK (documented per review 2026-07-10 #1): pane authority is
 * still pane-CONTENT trust. An adversary who gets the agent to print an
 * EXACT header + checkbox list as its very last output — sitting immediately
 * above the input box while no real list is rendered (idle between turns) —
 * satisfies 1-4 and gains authority until the next real render. Bounds on
 * the damage: tool events retain per-task recency authority (a newer event
 * beats any snapshot), removals/regressions need TWO consecutive confirming
 * snapshots, and the next genuine task render reclaims the bottom slot.
 * Eliminating the residue entirely would require out-of-band ground truth
 * (harness API), which does not exist today.
 *
 * `text` is assumed already ANSI-stripped by the capture layer, but we are
 * defensive: classification is line-oriented and never assumes clean input.
 */
export function parsePaneTaskList(text: string, provenance: PaneProvenance): PaneSnapshot | null {
  if (text.length === 0) return null
  const lines = text.split('\n')
  const blocks = collectBlocks(lines)
  if (blocks.length === 0) return null

  // Resolve the anchor for each block and pick the freshest usable one.
  let chosen: RawBlock | null = null
  let chosenHeader: HeaderCounts | null = null
  let chosenAnchored = false
  for (const block of blocks) {
    const above = precedingNonBlank(lines, block.first)
    let header: HeaderCounts | null = null
    let anchored = false
    if (above !== null) {
      const hm = HEADER_RE.exec(above)
      if (hm !== null) {
        header = {
          total: Number.parseInt(hm[1] as string, 10),
          done: Number.parseInt(hm[2] as string, 10),
          inProgress: Number.parseInt(hm[3] as string, 10),
          pending: Number.parseInt(hm[4] as string, 10),
        }
        anchored = true
      }
      // SPINNER_RE deliberately does NOT anchor (anti-spoof, see docstring).
      // Spinner blocks fall through to the multi-line observational fallback.
    }
    // Prefer header-anchored blocks; else accept a multi-line block (including
    // spinner-anchored Style-B renders) as an observational fallback.
    const usable = anchored || block.taskLines.length >= 2
    if (!usable) continue
    // Freshest wins: any later usable block replaces an earlier one, but an
    // anchored block is never overridden by a later unanchored fallback.
    if (chosen === null || anchored || !chosenAnchored) {
      chosen = block
      chosenHeader = header
      chosenAnchored = anchored
    }
  }
  if (chosen === null) return null

  // Positional anchoring (anti-spoof v2, conditions 2-4 in the docstring).
  // The selection loop above already guarantees condition 2 (later header
  // blocks replace earlier ones, so `chosen` anchored ⇒ last header block).
  if (chosenAnchored) {
    const region = scanBottomRegion(lines, chosen.end)
    const headerIdx = precedingNonBlankIdx(lines, chosen.first)
    const aboveHeader =
      headerIdx >= 0 ? precedingNonBlank(lines, headerIdx) : null
    const spinnerAboveHeader = aboveHeader !== null && SPINNER_RE.test(aboveHeader)
    const positional = region.clean && (region.sawChrome || spinnerAboveHeader)
    if (!positional) {
      // Demote: parses (observational) but never gains authority.
      chosenAnchored = false
    }
  }

  const tasks: ParsedTask[] = []
  let ordinalsDerived = false
  chosen.taskLines.forEach((raw, idx) => {
    const explicit = raw.ordinalExplicit !== null
    if (!explicit) ordinalsDerived = true
    tasks.push({
      ordinal: explicit ? (raw.ordinalExplicit as number) : idx + 1,
      ordinalExplicit: explicit,
      status: raw.status,
      description: raw.description,
      descriptionTruncated: raw.descriptionTruncated,
    })
  })

  const truncatedBy = chosen.truncatedBy
  const headerMismatch = chosenHeader !== null && chosenHeader.total !== tasks.length
  const complete =
    chosenAnchored &&
    truncatedBy === null &&
    !chosen.hasUnattributedLine &&
    !headerMismatch

  const rawBlockLines = lines.slice(chosen.first, chosen.first + chosen.taskLines.length)

  const snapshot: PaneSnapshot = {
    provenance,
    tasks,
    complete,
    ordinalsDerived,
    boundaryRecognized: chosenAnchored,
    raw: rawBlockLines.join('\n'),
    ...(chosenHeader !== null ? { headerCounts: chosenHeader } : {}),
    ...(truncatedBy !== null ? { truncatedBy } : {}),
  }
  return snapshot
}

// ─────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────

/**
 * Decide whether a snapshot is authoritative for the live session binding.
 *
 * A snapshot is authoritative ONLY when it matches the (sessionId, pane, cwd)
 * binding, has a recognized top boundary, and is complete (no truncation, no
 * unattributed wrap, header count consistent). The remaining clause from the
 * design — "newer than the event it would override" — is a recency question
 * that depends on live event timestamps, so it is enforced per-task inside
 * {@link reconcileTaskState}, not here. A non-authoritative snapshot is
 * observational only: it influences reconciliation health but changes no task.
 */
export function validateSnapshot(
  snapshot: PaneSnapshot,
  binding: SessionBinding,
): SnapshotVerdict {
  const reasons: VerdictReason[] = []
  if (snapshot.provenance.sessionId !== binding.sessionId) reasons.push('session_mismatch')
  if (snapshot.provenance.paneTarget !== binding.paneTarget) reasons.push('pane_mismatch')
  if (snapshot.provenance.cwd !== binding.cwd) reasons.push('cwd_mismatch')
  if (!snapshot.boundaryRecognized) reasons.push('unrecognized_boundary')
  if (!snapshot.complete) reasons.push('incomplete')
  if (reasons.length === 0) return { authoritative: true, reasons: ['ok'] }
  return { authoritative: false, reasons }
}

// ─────────────────────────────────────────────────────────────────────
// Reconciliation
// ─────────────────────────────────────────────────────────────────────

const STALE_MS = 90_000

function statusRank(status: TaskStatus): number {
  switch (status) {
    case 'pending':
      return 0
    case 'in_progress':
      return 1
    case 'completed':
      return 2
  }
}

function canonicalKey(sessionId: string, ordinal: number): string {
  return `${sessionId}:#${ordinal}`
}

function provisionalKey(sessionId: string, description: string): string {
  return `${sessionId}:~${normalizeDescription(description)}`
}

/** Collapse internal whitespace and trim — the ONLY normalization used for description matching. */
export function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, ' ').trim()
}

/** A fresh, empty reconciled state for a session. */
export function initialReconciledState(sessionId: string): ReconciledState {
  return {
    sessionId,
    tasks: [],
    lastEventAt: 0,
    lastReconciledAt: 0,
    lastObservationAt: 0,
    prevSnapshotFacts: new Map(),
  }
}

/**
 * Fold one observation into the reconciled state, returning a new state.
 * Pure: never mutates `current`. Events are optimistic; valid pane snapshots
 * are authoritative but anti-flap (removal / regression / description swaps
 * need two consecutive confirming snapshots).
 */
export function reconcileTaskState(
  current: ReconciledState,
  observation: Observation,
): ReconciledState {
  if (observation.kind === 'event') {
    return applyEvent(current, observation.event)
  }
  return applySnapshot(current, observation.snapshot, observation.verdict)
}

function cloneTask(task: ReconciledTask): ReconciledTask {
  return { ...task }
}

function applyEvent(current: ReconciledState, event: ToolTaskEvent): ReconciledState {
  const tasks = current.tasks.map(cloneTask)
  const lastEventAt = Math.max(current.lastEventAt, event.at)

  if (event.ordinal !== undefined) {
    const key = canonicalKey(current.sessionId, event.ordinal)
    const existing = tasks.find((t) => t.key === key)
    if (existing !== undefined) {
      // Optimistic: a newer-or-equal event wins in either direction.
      if (event.at >= existing.updatedAt) {
        existing.status = event.status
        existing.description = event.description
        existing.descriptionTruncated = false
        existing.source = 'event'
        existing.provisional = false
        existing.updatedAt = event.at
      }
    } else {
      tasks.push({
        key,
        ordinal: event.ordinal,
        status: event.status,
        description: event.description,
        descriptionTruncated: false,
        source: 'event',
        provisional: false,
        paneConfirmed: false,
        updatedAt: event.at,
      })
    }
    return { ...current, tasks, lastEventAt }
  }

  // No ordinal: try to attach to an existing pane task by UNIQUE exact
  // normalized description; otherwise keep it provisional.
  const norm = normalizeDescription(event.description)
  const matches = tasks.filter(
    (t) =>
      !t.provisional &&
      !t.descriptionTruncated &&
      normalizeDescription(t.description) === norm,
  )
  if (matches.length === 1) {
    const target = matches[0] as ReconciledTask
    if (event.at >= target.updatedAt) {
      target.status = event.status
      target.source = 'event'
      target.updatedAt = event.at
    }
    return { ...current, tasks, lastEventAt }
  }

  // Provisional upsert keyed by normalized description (repeat events coalesce).
  const pKey = provisionalKey(current.sessionId, event.description)
  const prov = tasks.find((t) => t.key === pKey)
  if (prov !== undefined) {
    if (event.at >= prov.updatedAt) {
      prov.status = event.status
      prov.description = event.description
      prov.updatedAt = event.at
    }
  } else {
    tasks.push({
      key: pKey,
      ordinal: null,
      status: event.status,
      description: event.description,
      descriptionTruncated: false,
      source: 'event',
      provisional: true,
      paneConfirmed: false,
      updatedAt: event.at,
    })
  }
  return { ...current, tasks, lastEventAt }
}

function uniqueProvisionalMatch(
  provisionals: ReadonlyArray<ReconciledTask>,
  description: string,
): ReconciledTask | null {
  const norm = normalizeDescription(description)
  const hits = provisionals.filter((p) => normalizeDescription(p.description) === norm)
  return hits.length === 1 ? (hits[0] as ReconciledTask) : null
}

function applySnapshot(
  current: ReconciledState,
  snapshot: PaneSnapshot,
  verdict: SnapshotVerdict,
): ReconciledState {
  const lastObservationAt = Math.max(current.lastObservationAt, snapshot.provenance.capturedAt)
  if (!verdict.authoritative) {
    // Observational only — health signal moves, task state does not.
    return { ...current, lastObservationAt }
  }

  const snapCap = snapshot.provenance.capturedAt
  const prev = current.prevSnapshotFacts
  const committed = current.tasks.map(cloneTask)
  const byKey = new Map(committed.map((t) => [t.key, t]))
  const provisionals = committed.filter((t) => t.ordinal === null)
  const absorbedKeys = new Set<string>()
  const consumedKeys = new Set<string>() // canonical keys placed into the snapshot section

  const ordered: ReconciledTask[] = []

  for (const sTask of snapshot.tasks) {
    const key = canonicalKey(current.sessionId, sTask.ordinal)
    consumedKeys.add(key)
    let base = byKey.get(key)
    if (base === undefined) {
      const p = uniqueProvisionalMatch(
        provisionals.filter((pr) => !absorbedKeys.has(pr.key)),
        sTask.description,
      )
      if (p !== null) {
        base = p
        absorbedKeys.add(p.key)
      }
    }

    ordered.push(mergeSnapshotTask(key, sTask, base, prev, snapCap))
  }

  // Tasks the snapshot omitted. Decide keep (append) vs drop.
  const tail: ReconciledTask[] = []
  for (const task of committed) {
    if (consumedKeys.has(task.key)) continue
    if (absorbedKeys.has(task.key)) continue

    if (task.updatedAt > snapCap) {
      // Newer than the authoritative snapshot ⇒ unmatched newer event, keep.
      tail.push(task)
      continue
    }
    if (!task.paneConfirmed) {
      // Event-only optimistic guess a complete snapshot did not confirm ⇒ drop.
      continue
    }
    // Pane-confirmed task now omitted: removal needs two consecutive omissions.
    if (prev.has(task.key)) {
      // Previous valid snapshot still had it ⇒ first omission ⇒ keep pending.
      tail.push(task)
    }
    // else: previous snapshot omitted it too ⇒ second consecutive omission ⇒ drop.
  }

  const tasks = [...ordered, ...tail]

  const prevSnapshotFacts = new Map<string, SnapshotFacts>()
  for (const sTask of snapshot.tasks) {
    prevSnapshotFacts.set(canonicalKey(current.sessionId, sTask.ordinal), {
      status: sTask.status,
      description: sTask.description,
      descriptionTruncated: sTask.descriptionTruncated,
      at: snapCap,
    })
  }

  return {
    ...current,
    tasks,
    lastReconciledAt: snapCap,
    lastObservationAt,
    prevSnapshotFacts,
  }
}

function mergeSnapshotTask(
  key: string,
  sTask: ParsedTask,
  base: ReconciledTask | undefined,
  prev: ReadonlyMap<string, SnapshotFacts>,
  snapCap: number,
): ReconciledTask {
  // Addition: nothing committed at this key.
  if (base === undefined) {
    return {
      key,
      ordinal: sTask.ordinal,
      status: sTask.status,
      description: sTask.description,
      descriptionTruncated: sTask.descriptionTruncated,
      source: 'pane',
      provisional: false,
      paneConfirmed: true,
      updatedAt: snapCap,
    }
  }

  // A newer event wins over the snapshot for this task (recency clause).
  if (base.updatedAt > snapCap) {
    return {
      ...base,
      key,
      ordinal: sTask.ordinal,
      source: 'event',
      provisional: false,
      paneConfirmed: true,
    }
  }

  const prevFacts = prev.get(key)
  const rankS = statusRank(sTask.status)
  const rankB = statusRank(base.status)

  // A previous-snapshot fact may only CONFIRM a change when it is at least as
  // new as the committed task's own updatedAt. A fact captured BEFORE an
  // intervening event is stale: snapshot:pending → event:completed →
  // snapshot:pending must hold `completed` (first observation of the
  // regression), not regress immediately (review 2026-07-09, Codex Med).
  const prevFactsCurrent =
    prevFacts !== undefined && prevFacts.at >= base.updatedAt ? prevFacts : undefined

  // Status resolution.
  let status: TaskStatus
  if (rankS >= rankB) {
    // Forward progress or same status ⇒ apply immediately.
    status = sTask.status
  } else if (!base.paneConfirmed) {
    // Base is an absorbed provisional / event-only older guess ⇒ reality wins.
    status = sTask.status
  } else if (prevFactsCurrent !== undefined && prevFactsCurrent.status === sTask.status) {
    // Two consecutive post-event snapshots agree on the regression ⇒ confirmed.
    status = sTask.status
  } else {
    // First observation of the regression ⇒ hold the higher committed status.
    status = base.status
  }

  // Description resolution.
  const sameDesc = normalizeDescription(sTask.description) === normalizeDescription(base.description)
  let description = base.description
  let descriptionTruncated = base.descriptionTruncated
  if (!sameDesc && !sTask.descriptionTruncated) {
    if (!base.paneConfirmed) {
      // Absorbed provisional / event-only ⇒ snapshot owns the description.
      description = sTask.description
      descriptionTruncated = false
    } else if (
      prevFactsCurrent !== undefined &&
      !prevFactsCurrent.descriptionTruncated &&
      normalizeDescription(prevFactsCurrent.description) === normalizeDescription(sTask.description)
    ) {
      // Two consecutive post-event snapshots agree on the new description ⇒ confirmed.
      description = sTask.description
      descriptionTruncated = false
    }
    // else: hold the committed description until a second confirming snapshot.
  }

  return {
    key,
    ordinal: sTask.ordinal,
    status,
    description,
    descriptionTruncated,
    source: 'pane',
    provisional: false,
    paneConfirmed: true,
    updatedAt: snapCap,
  }
}

// ─────────────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────────────

/**
 * Derive a freshness signal for the pin.
 *
 * - `unverified` — no valid pane snapshot has ever been reconciled (state, if
 *   any, is optimistic events only).
 * - `stale` — active work is ongoing AND reconciliation has been silent for
 *   more than 90s (the harness should be redrawing the list but we haven't
 *   seen a valid one).
 * - `verified` — otherwise. Critically, when the session is idle (no active
 *   turn) the last valid snapshot stays `verified` regardless of age: the
 *   harness does not redraw the task list between turns, so silence there is
 *   normal and must NOT read as stale.
 */
export function deriveHealth(
  state: ReconciledState,
  now: number,
  sessionActive: boolean,
): ReconciliationHealth {
  if (state.lastReconciledAt <= 0) return 'unverified'
  if (sessionActive && now - state.lastReconciledAt > STALE_MS) return 'stale'
  return 'verified'
}
