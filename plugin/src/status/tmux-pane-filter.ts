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
  | 'input_box'
  | 'inbound_preview'

// Render mode: `full_pane` keeps all non-hidden segments as today.
// `latest_inbound_only` (introduced 2026-05-22 for the iPhone mirror)
// anchors on the last inbound preview line that Claude Code emits when
// the dashi-channel MCP pushes a notification (`← <channel>: …`). All
// segments before AND the anchor itself are dropped — only what came
// AFTER the warchief's last message remains. If no preview is present
// (fresh session) the mode degrades to `full_pane`.
export type RenderMode = 'full_pane' | 'latest_inbound_only'

export interface PaneSegment {
  type: SegmentType
  text: string
}

export interface FilterOptions {
  // Segments to drop from the rendered output. Order does not matter; an
  // empty list disables filtering.
  hide?: ReadonlyArray<SegmentType> | ReadonlySet<SegmentType>
  // Anchor mode (see `RenderMode`). Default `full_pane` so existing
  // callers / tests keep their behaviour. The Telegram mirror passes
  // `latest_inbound_only` explicitly.
  mode?: RenderMode
}

// Default hide-list. Mirrors the warchief's spec on 2026-05-20 + 05-22:
// boot banner (splash + email + path), inbound-injection warning,
// footer hints (bypass-perms reminder, auto-update failure, tmux
// focus-events note, /btw tip) AND the input box (the bordered prompt
// area at the bottom of the pane — long ─ separators + ❯/> cursor).
// `inbound_preview` is intentionally kept visible by default: it is the
// anchor for `latest_inbound_only` mode and must survive the segmentize
// pass even when callers drop it from the rendered output later.
export const DEFAULT_HIDDEN_SEGMENTS: readonly SegmentType[] = [
  'boot_banner',
  'inbound_warning',
  'footer_hints',
  'input_box',
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
// would cause false positives in conversation text. All patterns
// must remain word-anchored.
//
// 2026-05-22: added the «Tip: Use /…» footer line. Claude Code v2.1.144
// renders rotating tips below the input box (e.g. «Tip: Use /btw to ask
// a quick side question without interrupting Claude's current work»);
// they slipped past the previous footer set because the original three
// phrases were specific to the bypass-permissions / auto-update /
// focus-events lines. The Tip pattern is line-start anchored and
// requires `Use /` literally — a conversation phrase like «Tip: try X»
// or «Tip: use indexes» will NOT match.
const FOOTER_LINE_RES: readonly RegExp[] = [
  /bypass permissions on\s*\(shift\+tab to cycle\)/i,
  /Auto-update failed\s*[·•]\s*Try claude doctor/i,
  /tmux focus-events off\s*[·•]\s*add /i,
  /^\s*Tip:\s+Use\s*\//i,
]

// ─── Input box + inbound-preview anchors ────────────────────────────

// Inbound preview: Claude Code emits one such line when an MCP channel
// (e.g. dashi-channel) pushes a notification mid-session — `← <name>:
// <preview>`. The arrow is U+2190; the channel name is a kebab-case
// identifier in our world (`dashi-channel`, `orgrimmar-inbox`, etc.).
//
// Codex review 2026-05-22 flagged the earlier `\S+:` form as too loose
// — a tool that prints «← github: issue title» at column zero would
// hijack the `latest_inbound_only` pivot and hide everything before
// it. We now require:
//   • leading `← ` (U+2190 + space) at column zero (no indent / diff)
//   • channel name starts with a lowercase ASCII letter
//   • channel name is lowercase letters / digits / `-_` only
//   • terminated by a literal `:`
// This matches every real MCP channel id we emit and rules out
// «← Some Channel: …», «← Foo Bar:» and other free-text imposters.
const INBOUND_PREVIEW_RE = /^← [a-z][a-z0-9_-]*:/

// Input separator. Claude Code v2 renders the bottom input area as a
// pair of long U+2500 ── horizontals bracketing a `❯` (U+276F) or `>`
// cursor line. We require at least 20 separator glyphs on a line so a
// short ── used inline (e.g. «section ──» in a tool output) does not
// accidentally open an input box.
const INPUT_SEPARATOR_RE = /^─{20,}\s*$/

// Cursor line inside the input box. Accepts both `❯` (current Claude
// Code v2.1.144 cursor glyph) and the legacy `>` ASCII fallback.
// Critically, the line must be EMPTY after the cursor: matching just
// `>` or `❯` would false-positive on conversation text like
// «> Что у нас по EdgeLab?» (a quoted reply). Trailing whitespace is
// fine — the cursor pads with spaces to the column count.
const INPUT_PROMPT_RE = /^\s*[>❯]\s*$/

// Cap on input box accumulation. Real boxes are 3 lines (sep + prompt
// + sep), sometimes padded with one or two blanks. Ten lines INCLUDING
// the opener gives generous headroom for future multi-line input UI
// without letting a stray separator swallow the rest of the pane.
// (Codex review 2026-05-22 flagged the earlier "10 after the opener"
// off-by-one: the opener was pushed before the counter started, so the
// effective cap was 11. The scanner now counts the opener too.)
const INPUT_BOX_LINE_CAP = 10

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
    isFooterLine(line) ||
    INBOUND_PREVIEW_RE.test(line) ||
    INPUT_SEPARATOR_RE.test(line)
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

    // 5) Inbound preview — single-line segment. Emitted by Claude Code
    //    when an MCP channel pushes a notification. Kept as its own
    //    segment type so `latest_inbound_only` mode can pivot on it
    //    without re-scanning the text downstream.
    if (INBOUND_PREVIEW_RE.test(line)) {
      out.push({ type: 'inbound_preview', text: line })
      i += 1
      continue
    }

    // 6) Input box — separator-anchored. Opens on a long ── line, then
    //    greedily collects separators, blank lines, and cursor lines
    //    (`>` or `❯` followed only by whitespace). Closes on the first
    //    non-matching line so a stray separator inside tool output can
    //    only consume the matching tail, not the rest of the pane.
    //    Capped at INPUT_BOX_LINE_CAP (counting the opener) for the
    //    same safety reason as BANNER_LINE_CAP / INBOUND_LINE_CAP.
    //
    //    Codex review 2026-05-22 [high]: a STANDALONE long ── line in
    //    tool output (a markdown divider, a separator in a help dump)
    //    must not be hidden as an input box. We now require at least
    //    one cursor line in the collected block — without that
    //    confirmation we emit the lines as a conversation segment
    //    instead, so legitimate dividers remain visible.
    if (INPUT_SEPARATOR_RE.test(line)) {
      const box: string[] = [line]
      i += 1
      let consumed = 1 // opener already counted
      let hasCursor = false
      while (i < lines.length && consumed < INPUT_BOX_LINE_CAP) {
        const inner = lines[i]!
        const isSep = INPUT_SEPARATOR_RE.test(inner)
        const isPrompt = INPUT_PROMPT_RE.test(inner)
        const isBlank = inner.trim() === ''
        if (!isSep && !isPrompt && !isBlank) break
        if (isPrompt) hasCursor = true
        box.push(inner)
        i += 1
        consumed += 1
      }
      // Reclassify when the block lacks a cursor — almost certainly a
      // standalone divider in tool output rather than a real prompt.
      const type: SegmentType = hasCursor ? 'input_box' : 'conversation'
      const seg = joinSegment(type, box)
      if (seg !== null) out.push(seg)
      continue
    }

    // 7) Conversation (default). Accumulate until we hit a boundary or
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
  const mode: RenderMode = opts?.mode ?? 'full_pane'
  let segs = segmentizePane(text)
  // Mode is applied BEFORE the hide list. If hide were applied first,
  // an aggressive config that hides `inbound_preview` would erase the
  // anchor and turn `latest_inbound_only` into a silent no-op. Order
  // matters: pivot first, then drop.
  if (mode === 'latest_inbound_only') {
    let lastIdx = -1
    for (let k = segs.length - 1; k >= 0; k -= 1) {
      if (segs[k]!.type === 'inbound_preview') {
        lastIdx = k
        break
      }
    }
    // Fresh session with no preview line at all → degrade to full_pane.
    if (lastIdx >= 0) {
      // Drop the anchor itself AND every segment before it. The mirror
      // wants only what happened AFTER the warchief's last message, so
      // the preview (which echoes that message) is not part of "after".
      segs = segs.slice(lastIdx + 1)
    }
  }
  const kept = segs.filter((s) => !hide.has(s.type))
  if (kept.length === 0) return ''
  // Join with a blank line between segments to keep them visually
  // separated in the Telegram `<pre>` block. Each segment body is
  // already inner-trimmed.
  return kept.map((s) => s.text).join('\n\n')
}

// ─── Line cap ───────────────────────────────────────────────────────

// capLines — keep at most `maxLines` lines, truncating from the TOP
// (oldest content) so the rendered tail stays visible. When the input
// is taller than the cap, the first kept line is replaced with a
// `… +N lines` marker; the marker counts toward `maxLines`, so the
// returned string has at most `maxLines` lines on any input.
//
// `maxLines === 0` disables capping (caller wants full filtered text).
// `maxLines === 1` is degenerate but well-defined: returns only the
// marker, no tail.
export function capLines(text: string, maxLines: number): string {
  if (maxLines <= 0) return text
  if (text.length === 0) return text
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  // Reserve 1 line for the marker; the rest goes to the tail.
  const keep = Math.max(0, maxLines - 1)
  const dropped = lines.length - keep
  const tail = lines.slice(lines.length - keep)
  const marker = `… +${dropped} lines`
  return [marker, ...tail].join('\n')
}
