// TmuxMirror — read-only «what is the agent doing right now» surface.
//
// Polls `tmux capture-pane` for a configured pane, strips ANSI/control
// sequences, runs the bytes through the same secret redactor used for
// Telegram-bound text, then re-renders the result into ONE rolling
// Telegram message via editMessageText. Identical poll output (same hash)
// is a no-op: we never spam Telegram when the pane is idle.
//
// Lifecycle:
//   start() — sets enabled=true, captures the pane, sends the initial
//     message, arms the internal interval.
//   onPoll() — public for tests; the interval also calls this. Captures,
//     diffs against the last hash, and either edits or skips.
//   stop()  — clears the interval, attempts to deleteMessage (best effort),
//     forgets the messageId so a future start() begins clean.
//
// Failure modes:
//   tmux exec fails (session gone, binary missing) → render an «unavailable»
//     state into the rolling message and keep polling. Self-heals on the
//     next successful capture.
//   editMessageText returns 4xx «message not found» → forget messageId so
//     the next poll re-sends. (Tests cover error_code 400.)
//   safe-telegram-api already applies a redactor on the outbound path, but
//     we run our own pass first so the queued payload is already redacted
//     by the time it sits in the rate-limit queue.
//
// What this module DOES NOT do (deliberate out-of-scope):
//   • Telegram → tmux keystroke injection (control surface, future PR).
//   • Voice transcription / screenshots.
//   • Multiple panes per session.

import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { promisify } from 'util'

import type { Logger } from '../log.js'
import type { TelegramApi } from '../channel/tools.js'
import {
  filterPane,
  capLines,
  DEFAULT_HIDDEN_SEGMENTS,
  type RenderMode,
  type SegmentType,
} from './tmux-pane-filter.js'

export interface TmuxExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

// Test seam: the production wrapper calls `tmux capture-pane`; tests
// inject a deterministic stub. Args are exactly the argv after the binary.
export type TmuxExec = (args: readonly string[]) => Promise<TmuxExecResult>

export interface TmuxMirrorOptions {
  api: TelegramApi
  log: Logger
  chatId: string
  // tmux target spec, e.g. `channel-thrall:0.0` (session:window.pane).
  paneTarget: string
  // Polling cadence. Tests usually drive `onPoll()` directly and pass a
  // long interval so the interval never fires within the test window.
  pollIntervalMs: number
  // -S argument to capture-pane: N most recent lines.
  lineCount: number
  // Optional: replace the default child-process driver. Default uses
  // execFile + promisify. Tests inject a function returning canned output.
  exec?: TmuxExec
  // Optional: replace redactSecrets pipeline. Default = identity (the
  // safe-telegram-api wrapper still redacts on the send path, so this
  // second pass is defence-in-depth). Wiring callers (server.ts) pass
  // the same redactor that the safe-telegram-api uses.
  redact?: (text: string) => string
  // Optional: clock override for status timestamps. Default Date.now.
  now?: () => number
  // Telegram body cap. Defaults to 4096 — the hard limit on sendMessage.
  maxBodyChars?: number
  // Optional: segment types to hide from the rendered mirror. When
  // omitted, `DEFAULT_HIDDEN_SEGMENTS` from tmux-pane-filter is used —
  // boot banner, inbound-injection warning, footer hints, AND the input
  // box — so the rolling message only carries semantically useful pane
  // content. Pass an empty array to disable filtering entirely (raw
  // pane mirror).
  hideSegments?: ReadonlyArray<SegmentType>
  // Optional: anchor mode for the mirror (see `RenderMode`). Default
  // `latest_inbound_only` — show only the activity that came AFTER the
  // warchief's last inbound message. Use `full_pane` for the legacy
  // whole-pane mirror (debugging or wide-terminal screenshots).
  mode?: RenderMode
  // Optional: cap on the number of lines surfaced into the rendered
  // body. Default 14 (≈70% of an iPhone Telegram screen at the moment).
  // Set to 0 to disable. Trimming removes from the top (oldest content)
  // and prepends a `… +N lines` marker; see `capLines`.
  maxLines?: number
}

export interface TmuxMirrorStatus {
  enabled: boolean
  messageId?: number
  lastHash?: string
  lastError?: string
  lastPollAt?: number
}

// Telegram HTML parse mode keeps `<pre>` formatting intact.
const HTML_OPTS = { parse_mode: 'HTML' as const }

// Debounce window for bump(). A burst of inbound messages within this
// window collapses to a single delete+resend, avoiding both Telegram
// rate-limit pressure and visible flicker for the warchief.
const BUMP_DEBOUNCE_MS = 1500
// Max time bump() will wait for a concurrent interval poll to release
// the inFlight slot before kicking its own poll anyway. 2s is well
// above a healthy poll round-trip (<200ms) but below the 5s tmux exec
// timeout, so a stuck poll won't strand the bump caller indefinitely.
const BUMP_WAIT_MAX_MS = 2000
const BUMP_WAIT_TICK_MS = 25

// Strip ANSI / vt control sequences and bare control characters. Keep
// newlines + tabs. Patterns:
//   • CSI:  ESC [ ... terminator-letter
//   • OSC:  ESC ] ... BEL  OR  ESC ] ... ST (ESC \)
//   • DCS/PM/APC/SOS: ESC (P|^|_|X) ... ST
//   • two-byte: ESC + single char in @-Z, \, -, _
// Stripping happens BEFORE htmlEscape so leftover characters can't blow up
// Telegram's HTML parser. ST is `ESC \`; we accept both BEL and ST as
// terminators for OSC since real terminals emit either.
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)|[P^_X][\s\S]*?\x1b\\|[@-Z\\\-_])/g
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '').replace(CTRL_RE, '')
}

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

// Default exec: spawn tmux and capture stdout/stderr. We never throw on
// non-zero exit so the caller can render the failure state instead of
// crashing the polling loop.
const execFileAsync = promisify(execFile)
async function defaultTmuxExec(args: readonly string[]): Promise<TmuxExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync('tmux', args as string[], {
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      timeout: 5000,
    })
    return { stdout, stderr, exitCode: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string }
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? 'tmux exec failed',
      exitCode: typeof e.code === 'number' ? e.code : 1,
    }
  }
}

// Render the body. Wraps content in a `<pre>` block, prepends a small
// header so it's clear what is being mirrored, and enforces the body cap
// by trimming from the TOP (oldest lines) — the warchief almost always
// cares about the most recent output.
function renderBody(rawPane: string, errorMsg: string | undefined, maxChars: number): string {
  const header = errorMsg
    ? `<b>terminal mirror</b> — <i>${htmlEscape(errorMsg)}</i>\n`
    : `<b>terminal mirror</b>\n`
  const footer = '' // reserved for future state lines
  const overhead = '<pre></pre>'.length
  const reserved = header.length + footer.length + overhead + 32 // safety
  const budget = Math.max(256, maxChars - reserved)

  let payload = htmlEscape(rawPane)
  let truncated = false
  if (payload.length > budget) {
    payload = payload.slice(payload.length - budget)
    // Try to break on the next newline so we don't slice mid-line.
    const nl = payload.indexOf('\n')
    if (nl >= 0 && nl < 200) {
      payload = payload.slice(nl + 1)
    }
    truncated = true
  }
  const prefix = truncated ? '… [truncated]\n' : ''
  return `${header}<pre>${prefix}${payload}</pre>${footer}`
}

export class TmuxMirror {
  private readonly api: TelegramApi
  private readonly log: Logger
  private readonly chatId: string
  private readonly paneTarget: string
  private readonly pollIntervalMs: number
  private readonly lineCount: number
  private readonly exec: TmuxExec
  private readonly redact: (text: string) => string
  private readonly now: () => number
  private readonly maxBodyChars: number
  private readonly hideSegments: ReadonlyArray<SegmentType>
  private readonly mode: RenderMode
  private readonly maxLines: number

  private timer: ReturnType<typeof setInterval> | null = null
  private enabled = false
  private messageId: number | undefined
  private lastHash: string | undefined
  private lastError: string | undefined
  private lastPollAt: number | undefined
  private lastBumpAt: number | undefined
  // In-flight guard: while a poll is processing (capture + send/edit),
  // overlapping calls return early. Combined with hash-dedup this keeps
  // Telegram traffic O(1) per pane change rather than O(N) per poll.
  private inFlight = false

  constructor(opts: TmuxMirrorOptions) {
    this.api = opts.api
    this.log = opts.log
    this.chatId = opts.chatId
    this.paneTarget = opts.paneTarget
    this.pollIntervalMs = opts.pollIntervalMs
    this.lineCount = opts.lineCount
    this.exec = opts.exec ?? defaultTmuxExec
    this.redact = opts.redact ?? ((s) => s)
    this.now = opts.now ?? ((): number => Date.now())
    this.maxBodyChars = opts.maxBodyChars ?? 4096
    this.hideSegments = opts.hideSegments ?? DEFAULT_HIDDEN_SEGMENTS
    this.mode = opts.mode ?? 'latest_inbound_only'
    this.maxLines = opts.maxLines ?? 14
  }

  // Pure rendering: turn a tmux exec result into the final body. Side
  // effects are confined to `this.lastError` so the caller can surface the
  // last failure reason via status() without re-parsing. Never throws —
  // a failing redact callback is caught and rendered as an error state.
  private buildRendered(result: TmuxExecResult): string {
    if (result.exitCode !== 0) {
      this.lastError = result.stderr.trim() || `tmux exited ${result.exitCode}`
      const errMsg = `tmux unavailable: ${this.lastError.slice(0, 200)}`
      return renderBody('(no output)', errMsg, this.maxBodyChars)
    }
    const cleaned = stripAnsi(result.stdout)
    // Drop banner / warning / footer / input-box BEFORE redaction — the
    // filter's anchors look at the raw textual structure (box corners,
    // specific phrases, U+2500 separators) and must not be perturbed by
    // token replacement. We also need the `latest_inbound_only` mode to
    // see the verbatim `← <channel>:` pivot line. Empty hide list +
    // `full_pane` mode short-circuits to raw cleaned text (raw mirror
    // debug path).
    const needsFilter = this.hideSegments.length > 0 || this.mode !== 'full_pane'
    let filtered = needsFilter
      ? filterPane(cleaned, { hide: this.hideSegments, mode: this.mode })
      : cleaned
    // Line cap runs AFTER the segment filter so the warchief's iPhone
    // sees a tidy ~14-line tail of the post-filter content, not a
    // 14-line slice of raw tmux output that includes hidden segments.
    // `capLines(_, 0)` is a no-op — keeps the existing 4096-char body
    // cap as the only safety net for callers that opt out.
    if (this.maxLines > 0) {
      filtered = capLines(filtered, this.maxLines)
    }
    // Telegram rejects `<pre></pre>` with no inner text as "message
    // text is empty" (400). If the filter (or line cap, or mode pivot)
    // consumed everything (idle pane / fresh session / over-aggressive
    // hide list), render a placeholder so the rolling message stays
    // visible and the self-heal path can still fire on next poll.
    if (filtered.trim() === '') {
      filtered = '(no visible output)'
    }
    let redacted: string
    try {
      redacted = this.redact(filtered)
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.log.warn('tmux mirror redact threw (rendered as error)', {
        error: this.lastError,
      })
      const errMsg = `redactor failed: ${this.lastError.slice(0, 200)}`
      return renderBody('(redacted suppressed)', errMsg, this.maxBodyChars)
    }
    this.lastError = undefined
    return renderBody(redacted, undefined, this.maxBodyChars)
  }

  status(): TmuxMirrorStatus {
    // Use conditional spread to honour `exactOptionalPropertyTypes: true`:
    // optional fields must be omitted when unset rather than explicitly
    // undefined.
    const out: TmuxMirrorStatus = { enabled: this.enabled }
    if (this.messageId !== undefined) out.messageId = this.messageId
    if (this.lastHash !== undefined) out.lastHash = this.lastHash
    if (this.lastError !== undefined) out.lastError = this.lastError
    if (this.lastPollAt !== undefined) out.lastPollAt = this.lastPollAt
    return out
  }

  async start(): Promise<void> {
    if (this.enabled) return
    this.enabled = true
    // First poll runs synchronously inside start() so the caller can
    // observe the initial message_id (and tests can assert on it without
    // waiting on the interval).
    await this.onPoll()
    // stop() could have been called while the first poll was awaiting.
    // Don't arm the interval in that case — it would just spin forever
    // bailing out at the enabled-check inside onPoll.
    if (!this.enabled) return
    this.timer = setInterval(() => {
      this.onPoll().catch((err: unknown) => {
        // Should never reach here — onPoll catches everything internally —
        // but guard the interval callback anyway so a bug here can't crash
        // the host process.
        this.log.warn('tmux mirror onPoll uncaught', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, this.pollIntervalMs)
  }

  // Drop the current rolling message and immediately re-send a fresh
  // one so the mirror is anchored at the bottom of the chat again.
  // Triggered by Telegram-side events (e.g. an incoming warchief
  // message scrolled the mirror up the conversation). The method is
  // idempotent on a disabled or empty mirror — both states are no-ops.
  //
  // Debounce: a burst of inbound messages (multi-part voice replies,
  // album bursts) would otherwise issue one delete+send per message
  // and hit safe-telegram-api's per-chat rate limit. We collapse calls
  // within BUMP_DEBOUNCE_MS to a single bump.
  //
  // Concurrency: if an interval poll is already in flight we wait a
  // bounded amount of time for it to finish before our forced poll
  // grabs the slot — otherwise the inFlight guard would silently
  // degrade bump() to "delete now, recreate on next interval tick",
  // breaking the «immediately re-send» contract (review 2026-05-20).
  async bump(): Promise<void> {
    if (!this.enabled) return
    // Debounce: skip if we just bumped. Note: we DO clear the inbound
    // signal even when skipping — the goal is just to coalesce.
    const t = this.now()
    if (this.lastBumpAt !== undefined && t - this.lastBumpAt < BUMP_DEBOUNCE_MS) {
      return
    }
    this.lastBumpAt = t

    if (this.messageId !== undefined) {
      const old = this.messageId
      this.messageId = undefined
      this.lastHash = undefined
      try {
        await this.api.deleteMessage(this.chatId, old)
      } catch (err) {
        // Best-effort — Telegram may have already removed it, or the
        // bot may lack permission in a group. We still want the resend.
        this.log.warn('tmux mirror bump delete failed (ignored)', {
          chat_id: this.chatId,
          message_id: old,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // stop() may have flipped `enabled` during the delete await; bail
    // before sending anything so we don't resurrect a disabled mirror.
    if (!this.enabled) return

    // Force the next poll to acquire the inFlight slot — wait briefly
    // for any concurrent interval poll to finish so our send goes
    // through. Bounded by BUMP_WAIT_MAX_MS to avoid hanging on a stuck
    // poll (e.g. tmux exec hanging for the full 5s timeout).
    const waitStart = this.now()
    while (this.inFlight && this.now() - waitStart < BUMP_WAIT_MAX_MS) {
      await new Promise<void>((r) => setTimeout(r, BUMP_WAIT_TICK_MS))
      if (!this.enabled) return
    }
    await this.onPoll()
  }

  async stop(): Promise<void> {
    this.enabled = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.messageId !== undefined) {
      try {
        await this.api.deleteMessage(this.chatId, this.messageId)
      } catch (err) {
        // Best-effort; deletion is cosmetic.
        this.log.warn('tmux mirror delete failed (ignored)', {
          chat_id: this.chatId,
          message_id: this.messageId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      this.messageId = undefined
    }
    this.lastHash = undefined
  }

  async onPoll(): Promise<void> {
    if (!this.enabled) return
    if (this.inFlight) return
    this.inFlight = true
    try {
      this.lastPollAt = this.now()
      const result = await this.exec([
        'capture-pane',
        '-p',
        '-t',
        this.paneTarget,
        '-S',
        `-${this.lineCount}`,
      ])
      // stop() may have flipped `enabled` while exec was awaiting. If so,
      // bail before producing any side effect (send / edit / state change).
      // Without this, a poll that started moments before stop() would
      // resurrect `messageId` and leave a ghost message in the chat.
      if (!this.enabled) return

      const rendered = this.buildRendered(result)
      const h = hash(rendered)
      if (h === this.lastHash) {
        // Identical body — skip the Telegram round-trip entirely.
        return
      }

      if (this.messageId === undefined) {
        try {
          const sent = await this.api.sendMessage(this.chatId, rendered, HTML_OPTS)
          // Late gate: stop() between the await and now would otherwise
          // leave us with a fresh messageId on a disabled mirror. Delete
          // the freshly-sent message to keep the contract.
          if (!this.enabled) {
            try {
              await this.api.deleteMessage(this.chatId, sent.message_id)
            } catch {
              /* best effort */
            }
            return
          }
          this.messageId = sent.message_id
          this.lastHash = h
        } catch (err) {
          this.log.warn('tmux mirror sendMessage failed (ignored)', {
            chat_id: this.chatId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        return
      }

      try {
        await this.api.editMessageText(this.chatId, this.messageId, rendered, HTML_OPTS)
        this.lastHash = h
      } catch (err) {
        // Recreate only when Telegram says "message to edit not found",
        // not on every 4xx. 400 + that description means the message
        // is gone; auth (401), forbidden (403), payload-too-large (413)
        // etc. must NOT trigger recreate — that would cause an infinite
        // resend storm on a permanent failure.
        const e = err as { error_code?: number; description?: string }
        const desc = (e.description ?? '').toLowerCase()
        const isMessageGone =
          (e.error_code === 400 || e.error_code === 404) &&
          (desc.includes('message to edit not found') ||
            desc.includes('message not found') ||
            desc.includes('message_id_invalid'))
        if (isMessageGone) {
          this.messageId = undefined
          this.lastHash = undefined
          this.log.info('tmux mirror message gone, will resend next poll', {
            chat_id: this.chatId,
            error_code: e.error_code,
          })
        } else {
          this.log.warn('tmux mirror editMessageText failed (ignored)', {
            chat_id: this.chatId,
            error_code: e.error_code,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    } finally {
      this.inFlight = false
    }
  }
}
