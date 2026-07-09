// Observe-only Telegram formatting checker (TOV lint, 2026-07-09).
//
// Computes cheap, deterministic RULE-CODE metrics over an outgoing message
// body so the reply tool can hand the agent a non-blocking hint about likely
// readability problems on the phone. It NEVER rewrites prose and NEVER logs
// or returns the message text — only rule codes + counts.
//
// Rule codes (kept short and stable — they surface in logs and the tool
// result hint):
//   P450      — a paragraph (block between blank lines) longer than 450
//               VISIBLE chars (markdown markers stripped). TOV rule 6.
//   HEAD_NB   — a heading line (`**Заголовок**` alone, or `# …`) NOT
//               surrounded by blank lines. TOV rule 5.
//   SOFTLIST  — a run of 3+ consecutive plain-prose lines joined by single
//               newlines (list-like text that reads as a merged block unless
//               hard-broken). TOV rule 7.
//
// The soft-break DEFECT this flags is the same one hardenSoftBreaks() fixes
// deterministically on the rich path; here we only report it (the HTML path
// keeps newlines literal, so SOFTLIST is advisory, not a bug there).

const PARAGRAPH_MAX_VISIBLE = 450

// A line that begins a markdown block construct (mirrors rich.ts scope).
const BLOCK_START_RE =
  /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|\||```|~~~|(?:[-*_])\s*(?:[-*_])\s*(?:[-*_]))/

// A line that renders as a heading: an ATX `#` heading, or a whole line that
// is a single bold span (`**…**`) — the shape the TOV recommends.
const HEADING_LINE_RE = /^\s*(?:#{1,6}\s+\S|\*\*[^*]+\*\*\s*$)/

export interface FormatFinding {
  code: string
  count: number
}

/** Approximate the on-screen length of a line by stripping the markdown
 *  markers that do not render as glyphs. Deliberately rough — this drives a
 *  soft advisory threshold, not a hard limit. */
function visibleLength(text: string): number {
  return text
    .replace(/```[\s\S]*?```/g, '') // fenced code contributes little prose
    .replace(/`([^`]*)`/g, '$1') // inline code → its content
    .replace(/\*\*|~~|\*|_|#/g, '') // bold/italic/strike/heading markers
    .replace(/\\(?=\n|$)/g, '') // trailing hard-break backslashes
    .length
}

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

/** Plain prose = non-blank line that is not a markdown block start. */
function isProse(line: string): boolean {
  return !isBlank(line) && !BLOCK_START_RE.test(line)
}

/**
 * Analyze `text` and return the rule codes that fired, each with a count.
 * Empty array = clean. Never throws; the reply path treats a failure as
 * "no findings" so a checker bug can never gate a send.
 */
export function analyzeFormat(text: string): FormatFinding[] {
  const findings: FormatFinding[] = []
  if (text.length === 0) return findings

  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  // P450 — oversized paragraphs. A paragraph is a run of text between blank
  // lines; fenced code blocks are exempt (code is not prose).
  const paragraphs = normalized.split(/\n\s*\n/)
  let longParas = 0
  for (const para of paragraphs) {
    if (/^\s*```/.test(para.trimStart())) continue // fenced block — skip
    if (visibleLength(para) > PARAGRAPH_MAX_VISIBLE) longParas++
  }
  if (longParas > 0) findings.push({ code: 'P450', count: longParas })

  // Line-level scan for HEAD_NB and SOFTLIST, fence-aware.
  const lines = normalized.split('\n')
  let inFence = false
  let headNoBlank = 0
  let softRuns = 0
  let proseRun = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const isFenceDelim = /^\s*(?:```|~~~)/.test(line)
    if (isFenceDelim) {
      inFence = !inFence
      proseRun = 0
      continue
    }
    if (inFence) {
      proseRun = 0
      continue
    }

    // HEAD_NB: heading not fully wrapped in blank lines.
    if (HEADING_LINE_RE.test(line)) {
      const prev = i > 0 ? lines[i - 1] : undefined
      const next = i < lines.length - 1 ? lines[i + 1] : undefined
      const blankBefore = prev === undefined || isBlank(prev)
      const blankAfter = next === undefined || isBlank(next)
      if (!blankBefore || !blankAfter) headNoBlank++
    }

    // SOFTLIST: count runs of 3+ consecutive plain-prose lines. A heading or
    // block-start line (already excluded from isProse) breaks the run.
    if (isProse(line)) {
      proseRun++
      if (proseRun === 3) softRuns++ // count the run once when it reaches 3
    } else {
      proseRun = 0
    }
  }
  if (headNoBlank > 0) findings.push({ code: 'HEAD_NB', count: headNoBlank })
  if (softRuns > 0) findings.push({ code: 'SOFTLIST', count: softRuns })

  return findings
}

/**
 * Render findings into a one-line hint for the tool result, or '' when clean.
 * Codes + counts only — never any message text.
 */
export function formatHint(findings: ReadonlyArray<FormatFinding>): string {
  if (findings.length === 0) return ''
  const codes = findings.map((f) => `${f.code}=${f.count}`).join(', ')
  return `format_hint: ${codes} (advisory; see docs/TOV.md — no action required if intentional)`
}
