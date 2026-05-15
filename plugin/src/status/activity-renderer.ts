// Activity renderer — ports gateway.py:1506-1612 (humanize/summarize/mask)
// and gateway.py:1761-1784 (rolling activity window).
//
// All output destined for Telegram (or any log) flows through `maskSecrets`
// at the last possible moment. Callers may pass tool input verbatim — the
// only public exits are pre-masked strings.

import { escapeHtml } from '../format/html.js'

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
 * Port of `_mask_secrets` from gateway.py:1539-1563. Order matters — the
 * generic long-token rule would chew through IPs and Supabase hosts if it
 * ran first.
 */
export function maskSecrets(input: string): string {
  let s = input
  // IPv4 — keep first/last octet so debugging stays possible.
  s = s.replace(
    /\b(\d{1,3})\.\d{1,3}\.\d{1,3}\.(\d{1,3})\b/g,
    '$1.***.***.$2',
  )
  // Secret paths under ~/.foo/secrets/...  (legacy tilde-anchored form)
  s = s.replace(/(~\/?\.\w+\/)secrets\/\S+/g, '$1secrets/***')
  // Anchored `secrets/<file>` — catches summarized last-two-segments output
  // (e.g. `/Users/x/.claude-lab/silvana/secrets/openviking.key` collapses to
  // `secrets/openviking.key`). Without this the secret filename slips
  // through summarize → render. Pattern matches at string start or after a
  // path separator so unrelated occurrences (`my-secrets/x`) are unaffected.
  s = s.replace(/(^|[\s/])secrets\/\S+/g, '$1secrets/***')
  // Generic long tokens (≥24 chars of [A-Za-z0-9_-]).
  s = s.replace(
    /\b([A-Za-z0-9_-]{4})[A-Za-z0-9_-]{16,}([A-Za-z0-9_-]{4})\b/g,
    '$1***$2',
  )
  // Telegram bot tokens: NNN…:AAxx… → NNN***:AA***
  s = s.replace(
    /\b(\d{3})\d{7,}:(AA\w{2})\w+/g,
    '$1***:$2***',
  )
  // Supabase host: <projectid>.supabase.co — mask the project id segment.
  s = s.replace(/[a-z0-9]{10,}\.supabase\.co/g, (host) => {
    const parts = host.split('.')
    if (parts.length === 0) return host
    const first = parts[0] ?? ''
    if (first.length > 8) {
      parts[0] = `${first.slice(0, 4)}*****${first.slice(-4)}`
    }
    if (parts.length > 1) {
      const idx = parts.length - 2
      const seg = parts[idx] ?? ''
      if (seg.length > 5) {
        parts[idx] = `${seg.slice(0, 4)}***`
      }
    }
    return parts.join('.')
  })
  return s
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
      return `<b>${escapeHtml(label)}</b>`
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
}

export interface ActivitySnapshot {
  readonly startedAtMs: number
  readonly calls: ReadonlyArray<ActivityCall>
  readonly phase: 'reasoning' | 'tool'
}

const ACTIVITY_WINDOW = 5

/**
 * Render the full `<pre>working -- Ns\n\n[reasoning…]\n\n▸ …</pre>` block.
 * Ports `_render`/`_render_activity` from gateway.py:1740-1784. The whole
 * body is HTML-escaped once (inside <pre>) so callers can hand the result
 * straight to Telegram with `parse_mode=HTML`.
 */
export function renderActivityBlock(
  snapshot: ActivitySnapshot,
  nowMs: number,
): string {
  const elapsedSec = Math.max(0, Math.floor((nowMs - snapshot.startedAtMs) / 1000))
  const lines: string[] = [`working -- ${elapsedSec}s`]

  if (snapshot.phase === 'reasoning') {
    lines.push('')
    lines.push('reasoning...')
  }

  if (snapshot.calls.length > 0) {
    lines.push('')
    const total = snapshot.calls.length
    const window = Math.min(ACTIVITY_WINDOW, total)
    const recent = snapshot.calls.slice(total - window)
    if (total > recent.length) {
      lines.push(`▸ ... +${total - recent.length} earlier`)
    }
    for (const call of recent) {
      // detail may already be the humanized string; mask again to be safe.
      // The Python pipeline also re-masks at render time (gateway.py:1782).
      lines.push(`▸ ${maskSecrets(call.detail)}`)
    }
  }

  const body = lines.join('\n').trim()
  return `<pre>${escapeHtml(body)}</pre>`
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
