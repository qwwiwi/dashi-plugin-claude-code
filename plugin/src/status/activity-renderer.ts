// Activity renderer — ports gateway.py:1506-1612 (humanize/summarize/mask)
// and gateway.py:1761-1784 (rolling activity window).
//
// All output destined for Telegram (or any log) flows through `maskSecrets`
// at the last possible moment. Callers may pass tool input verbatim — the
// only public exits are pre-masked strings.

import { escapeHtml } from '../format/html.js'
import { redactSecrets } from '../safety/redact.js'

// gateway.py:1476-1487 — mirrors SUBAGENT_LABELS.
const SUBAGENT_LABELS: Record<string, string> = {
  researcher: 'searching and verifying sources',
  'content-writer': 'writing draft',
  'content-orchestrator': 'preparing content',
  'firebase-auditor': 'auditing data',
  'code-reviewer': 'code review',
  'general-purpose': 'running research',
  Explore: 'exploring structure',
  Plan: 'building plan',
  'statusline-setup': 'setting up status',
  'claude-code-guide': 'checking docs',
}

// Tool input is always an opaque record from Claude; helpers read explicit
// keys only. We never embed the entire object.
type ToolInput = Record<string, unknown>

function strField(input: ToolInput, key: string): string {
  const v = input[key]
  return typeof v === 'string' ? v : ''
}

function lastTwoSegments(rawPath: string): string {
  if (!rawPath) return ''
  const normalized = rawPath.replace(/\\/g, '/')
  const parts = normalized.split('/').filter((p) => p.length > 0)
  if (parts.length >= 2) {
    return parts.slice(-2).join('/')
  }
  // Match gateway.py:1512 fall-through: when rsplit yields < 2 parts, use
  // the raw normalized path.
  return normalized
}

function basename(rawPath: string): string {
  if (!rawPath) return ''
  const normalized = rawPath.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts[parts.length - 1] ?? ''
}

// ─────────────────────────────────────────────────────────────────────
// Secret masking
// ─────────────────────────────────────────────────────────────────────

/**
 * Mask IPs, secret paths, long tokens, Telegram bot tokens, Supabase hosts.
 *
 * Thin wrapper over the unified `redactSecrets` (src/safety/redact.ts).
 * The legacy rule set (IPv4 mid-octet, ~/.foo/secrets/<file>, anchored
 * `secrets/<file>`, generic ≥24-char token, partial Telegram token shape,
 * Supabase host) is preserved verbatim in `redactSecrets`; the unified
 * module adds further provider patterns (sk-, ghp_, re_, xoxb-, Resend,
 * Slack, Firebase JSON) which are strict supersets of what activity
 * lines might contain — they cannot expand or relax the legacy output.
 *
 * The function name is kept for back-compat with status-manager.ts and
 * downstream tests.
 */
export function maskSecrets(input: string): string {
  return redactSecrets(input)
}

// ─────────────────────────────────────────────────────────────────────
// Summarize tool input — produces the short text used in activity lines.
// ─────────────────────────────────────────────────────────────────────

/**
 * Compact description of a tool invocation for the rolling activity window.
 * Returns the RAW (unescaped) logical content, capped at 40 chars
 * (gateway.py:1506-1536). HTML escape happens exactly once at render time
 * in `renderActivityBlock` — applying it here too would double-escape Grep
 * patterns ("recordActivity" → `&amp;quot;...&amp;quot;`).
 */
export function summarizeToolInput(toolName: string, toolInput: ToolInput): string {
  let s: string

  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit': {
      const fp = strField(toolInput, 'file_path') || strField(toolInput, 'path')
      s = lastTwoSegments(fp)
      break
    }
    case 'Bash': {
      s = strField(toolInput, 'command').slice(0, 40)
      break
    }
    case 'Grep':
    case 'Glob': {
      const pattern = strField(toolInput, 'pattern')
      s = pattern ? `"${pattern}"` : ''
      break
    }
    case 'Agent': {
      s =
        strField(toolInput, 'subagent_type') ||
        strField(toolInput, 'description')
      break
    }
    case 'WebFetch': {
      const url = strField(toolInput, 'url')
      try {
        s = new URL(url).host || url.slice(0, 40)
      } catch {
        s = url.slice(0, 40)
      }
      break
    }
    case 'WebSearch': {
      s = strField(toolInput, 'query').slice(0, 40)
      break
    }
    default: {
      // Unknown tools — produce a safe, bounded summary. Never embed the raw
      // object via JSON.stringify because nested objects can be huge.
      s = ''
      const keys = Object.keys(toolInput)
      if (keys.length > 0) {
        // Use Python `str(dict)`-style summary length cap (gateway.py:1535
        // does `str(tinput)[:30]`). We emit a stable shape that doesn't leak
        // raw values for objects.
        const parts: string[] = []
        for (const k of keys.slice(0, 4)) {
          const v = toolInput[k]
          let valueStr: string
          if (typeof v === 'string') valueStr = v
          else if (typeof v === 'number' || typeof v === 'boolean') valueStr = String(v)
          else valueStr = typeof v
          parts.push(`${k}=${valueStr}`)
        }
        s = parts.join(', ').slice(0, 30)
      }
      break
    }
  }

  return s.slice(0, 40)
}

// ─────────────────────────────────────────────────────────────────────
// Humanize tool — compact HTML status line (gateway.py:1571-1612).
// Returns `null` for TodoWrite and unknown tools so callers can skip.
// ─────────────────────────────────────────────────────────────────────

function codeBlock(s: string): string {
  return `<code>${escapeHtml(s)}</code>`
}

export function humanizeTool(toolName: string, toolInput: ToolInput): string | null {
  switch (toolName) {
    case 'Agent': {
      const sub = strField(toolInput, 'subagent_type') || '?'
      const label = SUBAGENT_LABELS[sub] ?? `running ${sub}`
      const labelHtml = `<b>${escapeHtml(label)}</b>`
      // gateway.py:_render_dispatches — a running subagent showed its task
      // description ("> exploring structure -- Find UIS client …") so the
      // operator sees WHAT the agent was dispatched to do, not just its
      // label. Restored 2026-06-14 (operator-preferred verbose card).
      const desc = strField(toolInput, 'description').slice(0, 60)
      return desc ? `${labelHtml} -- ${escapeHtml(desc)}` : labelHtml
    }
    case 'Bash': {
      const cmd = strField(toolInput, 'command').trim()
      if (cmd.startsWith('curl')) return 'calling API'
      if (cmd.startsWith('git')) return 'git command'
      if (
        cmd.startsWith('cat ') ||
        cmd.startsWith('tail ') ||
        cmd.startsWith('head ') ||
        cmd.startsWith('ls ') ||
        cmd.startsWith('grep ')
      ) {
        return 'reading files'
      }
      // gateway.py:1585 — mask cmd[:60] BEFORE wrapping in <code>.
      return `running: ${codeBlock(maskSecrets(cmd.slice(0, 60)))}`
    }
    case 'Read': {
      const name = basename(strField(toolInput, 'file_path'))
      return name ? `reading ${codeBlock(name)}` : 'reading file'
    }
    case 'Write': {
      const name = basename(strField(toolInput, 'file_path'))
      return name ? `creating ${codeBlock(name)}` : 'creating file'
    }
    case 'Edit':
    case 'MultiEdit': {
      const name = basename(strField(toolInput, 'file_path'))
      return name ? `editing ${codeBlock(name)}` : 'editing file'
    }
    case 'Glob': {
      const p = strField(toolInput, 'pattern')
      return p ? `searching files: ${codeBlock(p.slice(0, 40))}` : 'searching files'
    }
    case 'Grep': {
      const p = strField(toolInput, 'pattern')
      return p ? `searching code: ${codeBlock(p.slice(0, 40))}` : 'searching code'
    }
    case 'WebFetch': {
      const url = strField(toolInput, 'url')
      return `fetching web: ${codeBlock(url.slice(0, 60))}`
    }
    case 'WebSearch': {
      const q = strField(toolInput, 'query')
      return `web search: <i>${escapeHtml(q.slice(0, 60))}</i>`
    }
    case 'TodoWrite':
      return null
    default:
      return null
  }
}

// ─────────────────────────────────────────────────────────────────────
// Rolling activity window — ActivitySnapshot + render
// ─────────────────────────────────────────────────────────────────────

export interface ActivityCall {
  readonly toolName: string
  readonly detail: string
  // Pre-rendered humanized HTML for the line (e.g. `reading <code>foo.ts</code>`)
  // or `null`/absent when the tool doesn't have a richer label (TodoWrite,
  // unknown). The HTML is already secret-masked + escape-safe — its internal
  // `<code>` and `<b>` tags are emitted verbatim inside the `<pre>` body,
  // while non-tag content was passed through `escapeHtml` at construction.
  // Optional so legacy callers (test fixtures) without humanized can build
  // ActivityCall literals; renderer treats `undefined` the same as `null`.
  readonly humanized?: string | null
}

export interface ActivitySnapshot {
  readonly startedAtMs: number
  readonly calls: ReadonlyArray<ActivityCall>
  readonly phase: 'reasoning' | 'tool'
}

const ACTIVITY_WINDOW = 5

// Telegram editMessageText rejects messages > 4096 chars. Cap the inner
// `<pre>` body well below that limit (room for the wrapping tags + safety
// margin in case maskSecrets or escape expands a line).
const PRE_BODY_MAX_CHARS = 3900

/**
 * Render the full `<pre>working -- Ns\n\n[reasoning…]\n\n▸ …</pre>` block.
 * Ports `_render`/`_render_activity` from gateway.py:1740-1784.
 *
 * Lines are escaped individually so a humanized line (which carries safe
 * inline HTML like `<code>foo.ts</code>`) lands verbatim while plain-detail
 * lines and the timer header get standard escaping. Body is capped at
 * `PRE_BODY_MAX_CHARS` so a runaway summary can never blow past Telegram's
 * 4096-char editMessageText limit (review M2).
 */
export function renderActivityBlock(
  snapshot: ActivitySnapshot,
  nowMs: number,
): string {
  const elapsedSec = Math.max(0, Math.floor((nowMs - snapshot.startedAtMs) / 1000))
  const lines: string[] = [escapeHtml(`working -- ${elapsedSec}s`)]

  if (snapshot.phase === 'reasoning') {
    lines.push('')
    lines.push(escapeHtml('reasoning...'))
  }

  if (snapshot.calls.length > 0) {
    lines.push('')
    const total = snapshot.calls.length
    const window = Math.min(ACTIVITY_WINDOW, total)
    const recent = snapshot.calls.slice(total - window)
    // gateway.py:_render_activity — header carries the running total ("steps
    // (N total):"); the last `window` calls follow. The total count is what
    // replaces the older "+N earlier" collapse line. Restored 2026-06-14
    // (operator-preferred verbose card).
    lines.push(escapeHtml(`steps (${total} total):`))
    for (const call of recent) {
      if (call.humanized) {
        // Humanized string is already HTML-safe: inner identifiers were
        // escaped at construction (see humanizeTool), inline tags are
        // intentional. Re-mask defensively against any post-store mutation.
        lines.push(`▸ ${maskSecretsPreserveTags(call.humanized)}`)
      } else {
        // Plain detail — single escape at render boundary so a Grep pattern
        // like `"recordActivity"` lands as `&quot;recordActivity&quot;` once,
        // not twice (review §1).
        lines.push(escapeHtml(`▸ ${maskSecrets(call.detail)}`))
      }
    }
  }

  let body = lines.join('\n').trim()
  if (body.length > PRE_BODY_MAX_CHARS) {
    // Truncate at a line boundary so we don't split an HTML entity.
    const truncated = body.slice(0, PRE_BODY_MAX_CHARS)
    const lastNl = truncated.lastIndexOf('\n')
    const head = lastNl > 0 ? truncated.slice(0, lastNl) : truncated
    body = `${head}\n…+truncated`
  }
  return `<pre>${body}</pre>`
}

/**
 * Re-mask a humanized HTML line without disturbing the inline tags. The
 * masking rules only touch IPs, secret paths, long tokens, Telegram bot
 * tokens, and Supabase hosts — none of those overlap with the `<code>`/`<b>`
 * tag bodies emitted by humanizeTool (we already mask path/cmd content
 * before wrapping). So a plain pass is safe; this is kept as a separate
 * function for clarity and to localize future changes if a mask rule ever
 * threatens an HTML tag.
 */
function maskSecretsPreserveTags(html: string): string {
  return maskSecrets(html)
}

/**
 * Combine summarizeToolInput with the lowercase tool name to produce the
 * detail string stored on `ActivityCall.detail`. Masking happens here —
 * AFTER path summarization (which can collapse `/abs/.../secrets/foo.key`
 * to `secrets/foo.key`) and BEFORE the value lands in the activity buffer.
 * Renderer re-masks defensively but the buffer should never hold raw
 * secret-shaped strings (review §4).
 */
export function buildActivityDetail(toolName: string, toolInput: ToolInput): string {
  const summary = summarizeToolInput(toolName, toolInput)
  const lower = toolName.toLowerCase()
  const detail = summary ? `${lower} ${summary}` : lower
  return maskSecrets(detail)
}

/**
 * Build the pre-rendered humanized HTML line for `ActivityCall.humanized`.
 * Returns null for TodoWrite/unknown so the renderer falls back to the
 * plain `detail` path. The string already contains escaped content + safe
 * inline tags (e.g. `<code>`, `<b>`) — masking is applied at the end so
 * the buffer never holds a raw token.
 */
export function buildHumanizedActivityLine(
  toolName: string,
  toolInput: ToolInput,
): string | null {
  const raw = humanizeTool(toolName, toolInput)
  if (raw === null) return null
  return maskSecrets(raw)
}
