// tmux-pane-filter — segment classifier for the rolling terminal mirror.
//
// `tmux capture-pane` returns the entire visible region of the pane,
// including the Claude Code boot banner, the «Experimental · inbound
// messages» warning, footer hints (bypass-permissions reminder,
// auto-update failure, tmux focus-events note) and everything in between.
// The warchief asked us to surface only what is semantically meaningful
// (the channel-status marker, the live conversation, the input prompt)
// and hide the rest.
//
// Implementation strategy: a forward-only line scanner that classifies
// every chunk of the pane into exactly one of five segment types. The
// scanner is deterministic and linear in the number of lines — important
// because TmuxMirror polls every few seconds and the filter sits on the
// hot path. We do NOT use multi-line regular expressions (they are easy
// to make catastrophic-backtracking).
//
// Anchors are picked from the actual Claude Code v2.1.144 layout (the
// warchief sent screenshots on 2026-05-20). They are deliberately
// specific phrases — never a single keyword that could appear in a
// regular conversation — so false-positives in `conversation` text are
// extremely unlikely.

export type SegmentType =
  | 'boot_banner'
  | 'inbound_warning'
  | 'channel_status'
  | 'conversation'
  | 'footer_hints'

export interface PaneSegment {
  type: SegmentType
  text: string
}

export interface FilterOptions {
  // Segments to drop from the rendered output. Order does not matter; an
  // empty list disables filtering.
  hide?: ReadonlyArray<SegmentType> | ReadonlySet<SegmentType>
}

// Default hide-list. Mirrors the warchief's spec on 2026-05-20: hide the
// boot banner (splash + email + path), hide the inbound-injection
// warning, hide the footer hints (bypass-perms reminder, auto-update
// failure, tmux focus-events note). Keep channel_status + conversation
// (which includes the input prompt by design).
export const DEFAULT_HIDDEN_SEGMENTS: readonly SegmentType[] = [
  'boot_banner',
  'inbound_warning',
  'footer_hints',
]

// ─── Line-level anchors ──────────────────────────────────────────────

// Boot banner opens with a box-drawing top-left corner followed by the
// «Claude Code vX.Y.Z» title. We accept the Unicode corners (╭/┌) ONLY:
// the earlier draft also accepted `+` for ASCII degradation, but that
// matched unified-diff lines like `+ patched Claude Code v2 yesterday`
// in conversation, which mis-classified diff blocks as banner. Pure
// ASCII tmux output is rare enough that requiring a real corner glyph
// here is the safer trade-off.
const BANNER_OPEN_RE = /^\s*[╭┌].*Claude Code v\d/

// Banner closes on the matching bottom corner. Same Unicode-only
// rationale as the opener.
const BANNER_CLOSE_RE = /^\s*[╰└][─\-═]+.*[╯┘]\s*$/

// Banner inner row. Every line inside a Claude Code banner box starts
// with the left vertical border (│ or ASCII | / +). The opener is the
// strict gate; once we're inside, accepting `+` as a vertical fallback
// is harmless because we already committed to banner classification.
const BANNER_INNER_RE = /^\s*[│|+]/

// Inbound-warning opener. Anchored to line start + the exact «Experimental
// · inbound messages» phrase as emitted by Claude Code (U+00B7 middle
// dot; we also accept U+2022 bullet as a defensive fallback). The
// earlier draft matched anywhere in the line — that caused false
// positives when the warning text was quoted in conversation (this
// project actively discusses channel-injection). Line-start anchor +
// required separator glyph makes the false-positive surface vanishingly
// small.
const INBOUND_OPEN_RE = /^\s*Experimental\s*[·•]\s*inbound\s+messages?/i

// Inbound-warning closer. The block always ends with «to disable.» —
// optionally followed by trailing whitespace.
const INBOUND_CLOSE_RE = /\bto\s+disable\.?\s*$/

// Channel-status opener. Single specific phrase emitted by the gateway.
const CHANNEL_STATUS_OPEN_RE = /^\s*Listening for channel messages from:\s*$/

// A follow-up line that belongs to the channel-status block: lone
// `server:<name>` value. We accept up to two such lines after the
// opener so a future multi-server gateway still classifies cleanly.
const CHANNEL_STATUS_FOLLOW_RE = /^\s*server:\S/

// Footer-hint phrases. Picked because each is a complete, specific
// sentence — short tokens like «doctor» or «Auto-update» on their own
// would cause false positives in conversation text. All three patterns
// must remain word-anchored.
const FOOTER_LINE_RES: readonly RegExp[] = [
  /bypass permissions on\s*\(shift\+tab to cycle\)/i,
  /Auto-update failed\s*[·•]\s*Try claude doctor/i,
  /tmux focus-events off\s*[·•]\s*add /i,
]

function isFooterLine(line: string): boolean {
  return FOOTER_LINE_RES.some((re) => re.test(line))
}

// Conversation segments are built lazily — we accumulate until we hit
// one of the "boundary" anchors, then close out. This predicate tells us
// when to stop accumulating into `conversation` and re-dispatch.
function isBoundaryLine(line: string): boolean {
  return (
    BANNER_OPEN_RE.test(line) ||
    INBOUND_OPEN_RE.test(line) ||
    CHANNEL_STATUS_OPEN_RE.test(line) ||
    isFooterLine(line)
  )
}

// Cap on inbound-warning accumulation. If the «to disable.» closer is
// missing (truncated capture, locale change, future wording), we don't
// want the warning state to swallow the rest of the pane. Twelve lines
// is comfortably above the real block (~5 lines) and well below
// anything meaningful that follows.
const INBOUND_LINE_CAP = 12

// Cap on banner accumulation. Real banners are ~11 lines; we allow up to
// 40 to survive minor layout changes but no more, so a missing close
// corner can't hide an entire scrollback.
const BANNER_LINE_CAP = 40

// Trim trailing blank lines off a segment body so consecutive kept
// segments don't bloom into multi-blank-line gaps after one is dropped.
function trimTrailingBlanks(lines: string[]): string[] {
  let end = lines.length
  while (end > 0 && lines[end - 1]!.trim() === '') end -= 1
  return lines.slice(0, end)
}

function trimLeadingBlanks(lines: string[]): string[] {
  let start = 0
  while (start < lines.length && lines[start]!.trim() === '') start += 1
  return lines.slice(start)
}

function joinSegment(type: SegmentType, lines: string[]): PaneSegment | null {
  const trimmed = trimTrailingBlanks(trimLeadingBlanks(lines))
  if (trimmed.length === 0) return null
  return { type, text: trimmed.join('\n') }
}

// ─── Main scanner ────────────────────────────────────────────────────

export function segmentizePane(text: string): PaneSegment[] {
  if (text.length === 0) return []
  // Split on \n only; CR is stripped by stripAnsi upstream, but we
  // tolerate stray \r at end-of-line by trimming inside predicates.
  const lines = text.split('\n')
  const out: PaneSegment[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!

    // 1) Boot banner — bounded region between corner anchors.
    if (BANNER_OPEN_RE.test(line)) {
      const banner: string[] = [line]
      i += 1
      let closed = false
      let consumed = 0
      while (i < lines.length && consumed < BANNER_LINE_CAP) {
        const inner = lines[i]!
        // Defensive: another opener or a footer line before the close
        // corner means the banner is malformed — bail out so the outer
        // loop reclassifies this line.
        if (BANNER_OPEN_RE.test(inner) || isFooterLine(inner)) break
        // Strict: banner inner rows MUST look like banner content
        // (start with the left vertical border) or be the close corner.
        // Anything else means the capture truncated the close row —
        // back off so the rest of the pane is reclassified.
        const isClose = BANNER_CLOSE_RE.test(inner)
        if (!isClose && !BANNER_INNER_RE.test(inner)) break
        banner.push(inner)
        i += 1
        consumed += 1
        if (isClose) {
          closed = true
          break
        }
      }
      // Whether we closed cleanly or hit the cap, emit what we have.
      const seg = joinSegment('boot_banner', banner)
      if (seg !== null) out.push(seg)
      // If unclosed and we didn't bail on a boundary, the cap stopped
      // us — the next outer iteration will pick up from where we are.
      if (!closed) {
        // no-op; the outer while continues at the same `i`
      }
      continue
    }

    // 2) Footer hints — collect only the consecutive run of footer
    //    lines plus blank separators (Codex review 2026-05-20: the
    //    previous "absorbing tail from the first match" was wrong —
    //    tmux redraws can leave stale footer text *above* newer
    //    output, and the old logic dropped everything past it). Now,
    //    as soon as we hit a non-footer non-blank line, the footer
    //    segment closes and the outer loop reclassifies normally.
    if (isFooterLine(line)) {
      const footerLines: string[] = []
      while (i < lines.length) {
        const inner = lines[i]!
        if (isFooterLine(inner) || inner.trim() === '') {
          footerLines.push(inner)
          i += 1
        } else {
          break
        }
      }
      const seg = joinSegment('footer_hints', footerLines)
      if (seg !== null) out.push(seg)
      continue
    }

    // 3) Inbound warning — bounded by "to disable." or by the safety
    //    cap so a missing closer can't swallow the pane.
    if (INBOUND_OPEN_RE.test(line)) {
      const warn: string[] = [line]
      i += 1
      let consumed = 0
      while (i < lines.length && consumed < INBOUND_LINE_CAP) {
        const inner = lines[i]!
        // Boundary lines close the warning early — protects us against
        // a missing closer running into the next block.
        if (
          BANNER_OPEN_RE.test(inner) ||
          CHANNEL_STATUS_OPEN_RE.test(inner) ||
          isFooterLine(inner)
        ) {
          break
        }
        warn.push(inner)
        i += 1
        consumed += 1
        if (INBOUND_CLOSE_RE.test(inner)) break
      }
      const seg = joinSegment('inbound_warning', warn)
      if (seg !== null) out.push(seg)
      continue
    }

    // 4) Channel status — opener + up to two follow-up `server:` lines.
    if (CHANNEL_STATUS_OPEN_RE.test(line)) {
      const status: string[] = [line]
      i += 1
      let follow = 0
      while (i < lines.length && follow < 2) {
        const inner = lines[i]!
        if (CHANNEL_STATUS_FOLLOW_RE.test(inner)) {
          status.push(inner)
          i += 1
          follow += 1
        } else {
          break
        }
      }
      const seg = joinSegment('channel_status', status)
      if (seg !== null) out.push(seg)
      continue
    }

    // 5) Conversation (default). Accumulate until we hit a boundary or
    //    the end of input.
    const conv: string[] = []
    while (i < lines.length) {
      const inner = lines[i]!
      if (isBoundaryLine(inner)) break
      conv.push(inner)
      i += 1
    }
    const seg = joinSegment('conversation', conv)
    if (seg !== null) out.push(seg)
  }

  return out
}

// ─── Filter ─────────────────────────────────────────────────────────

function asSet(
  hide: ReadonlyArray<SegmentType> | ReadonlySet<SegmentType> | undefined,
): ReadonlySet<SegmentType> {
  if (hide === undefined) return new Set(DEFAULT_HIDDEN_SEGMENTS)
  if (hide instanceof Set) return hide
  return new Set(hide)
}

export function filterPane(text: string, opts?: FilterOptions): string {
  const hide = asSet(opts?.hide)
  const segs = segmentizePane(text)
  const kept = segs.filter((s) => !hide.has(s.type))
  if (kept.length === 0) return ''
  // Join with a blank line between segments to keep them visually
  // separated in the Telegram `<pre>` block. Each segment body is
  // already inner-trimmed.
  return kept.map((s) => s.text).join('\n\n')
}
