// /keys — deterministic keystrokes from Telegram into the agent's tmux pane.
//
// Problem (warchief, 2026-06-12): Claude Code's NATIVE interactive dialogs
// (permission rules like `Bash(rm:*) requires confirmation`, model switch
// prompts, trust dialogs) render in the terminal. The tmux mirror SHOWS them
// in Telegram, but there was no way to ANSWER one remotely — the session sat
// blocked until someone reached the real terminal.
//
// The /keys tap keypad sends an explicit, WHITELISTED keystroke to the pane:
//   tap «2»            → press «2» (select dialog option 2)
//   tap «1» then «⏎»   → press «1», then Enter
//   tap «⎋ esc»        → cancel the dialog
// (The earlier `/key <tokens>` text command was removed in favour of this
// panel; the token parser below is the shared whitelist it taps into.)
//
// Security model:
//   - Reaches this code only via the /keys panel's `kkey:` callback (auth in
//     server.ts + keys-panel-ui.ts): private chat + allowed_user_ids +
//     allowed_chat_ids. Group chats never get here.
//   - Tokens are a closed whitelist (digits, y/n, enter/esc/tab/space,
//     arrows). Arbitrary text is rejected, so the keypad cannot be used to type
//     shell commands into a pane that dropped out of Claude into a shell.
//   - Max 5 tokens per parsed call — a dialog answer, not a macro language.

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// Literal characters are sent with `send-keys -l` (no name lookup);
// named keys are sent without -l so tmux resolves Enter/Escape/arrows.
// Exported so the /keys inline-button panel (telegram/keys-panel-ui.ts)
// derives its accepted token set from THESE structures — the single whitelist
// the tap keypad injects into the pane.
//
// RUNTIME TAMPER-RESISTANCE (the whole point — this is a pane-injection
// security surface):
//   - `LITERAL_TOKEN_LIST` is a `Object.freeze`d array. Freezing an ARRAY
//     genuinely blocks `push`/index-assignment/`length` mutation at runtime,
//     so its `.includes()` membership cannot be widened — this is the single
//     source of truth literal-token validation checks against.
//   - `NAMED_TOKENS` is a `Object.freeze`d plain object. Freezing an object
//     blocks adding/reassigning own properties at runtime, so its own keys
//     cannot be widened. Membership is checked with `Object.hasOwn` (NOT a
//     bare `t in NAMED_TOKENS`) so a polluted `Object.prototype` cannot smuggle
//     an un-whitelisted token through the prototype chain.
//   - We deliberately do NOT export a `Set` of literal tokens. A `Set`'s
//     contents live in internal slots, so `Object.freeze(new Set(...))` does
//     NOT stop `.add('rm')` — an importer could cast the `ReadonlySet` back to
//     `Set` and widen the injectable keystroke set. The frozen array + the
//     `isLiteralToken` predicate below close that hole.

// Canonical literal-token list (readonly tuple, frozen at runtime). Digits
// 0-9 + y/n. SINGLE SOURCE OF TRUTH — literal-token validation and the panel
// both derive from this exact frozen array.
export const LITERAL_TOKEN_LIST = Object.freeze([
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'y', 'n',
] as const)

// Immutable literal-token predicate. Membership is checked against the FROZEN
// `LITERAL_TOKEN_LIST` (whose `.includes` cannot be widened at runtime), so
// there is no mutable `Set` an importer could cast-and-`.add()` to inject a
// new keystroke. The function itself is frozen so it cannot be monkey-patched.
export const isLiteralToken: (t: string) => boolean = Object.freeze(
  (t: string): boolean => (LITERAL_TOKEN_LIST as readonly string[]).includes(t),
)

// Canonical named-token map (frozen at runtime). lower-case token → tmux key
// name. `esc` and `escape` are intentional ALIASES for the same Escape key —
// the /keys panel surfaces `esc` only (both parse identically). Freezing a
// plain object hard-stops adding/reassigning own properties; membership is
// tested with `Object.hasOwn` (not a prototype-walking `in`) so the frozen own
// keys are the genuine, immutable whitelist at runtime.
export const NAMED_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  enter: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'Space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  // Input-field editing for the /keys panel. `backspace` deletes ONE char to
  // the left; `clear` (Ctrl-U) erases the whole input line at once. Both are
  // control keys — they can only DELETE in the input field, never inject text,
  // so they don't widen the pane-injection surface. C-u is the same line-clear
  // already used by sendSlashCommand below.
  backspace: 'BSpace',
  clear: 'C-u',
} as const)

export const MAX_KEY_TOKENS = 5

export interface ParsedKeys {
  // In tmux send-keys argument form, one entry per keystroke.
  steps: Array<{ literal: boolean; key: string }>
}

// Parse keypad token args (e.g. "2 enter") into validated steps. Returns an
// error string (for the Telegram reply) when any token is outside the whitelist.
export function parseKeyTokens(args: string): ParsedKeys | { error: string } {
  const tokens = args.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) {
    return { error: 'нет клавиши: <1-9|0|y|n|enter|esc|tab|space|up|down|left|right|backspace|clear> …' }
  }
  if (tokens.length > MAX_KEY_TOKENS) {
    return { error: `слишком много нажатий за раз (максимум ${MAX_KEY_TOKENS})` }
  }
  const steps: ParsedKeys['steps'] = []
  for (const t of tokens) {
    // Validate against the FROZEN list (not a mutable Set) so a runtime
    // `(structure as Set).add('rm')` cannot widen the injectable keystrokes.
    if (isLiteralToken(t)) {
      steps.push({ literal: true, key: t })
    } else if (Object.hasOwn(NAMED_TOKENS, t)) {
      // OWN-property check (not `t in NAMED_TOKENS`): a bare `in` walks the
      // prototype chain, so `Object.prototype.rm = 'Enter'` would make
      // `parseKeyTokens('rm')` accept an un-whitelisted token (prototype
      // pollution). `Object.hasOwn` only sees the frozen own keys, closing it.
      steps.push({ literal: false, key: NAMED_TOKENS[t]! })
    } else {
      return { error: `неизвестная клавиша: ${t} — разрешены цифры, y/n, enter, esc, tab, space, стрелки, backspace, clear` }
    }
  }
  return { steps }
}

export interface TmuxKeysTarget {
  paneTarget: string
  // `-L name` (socket under the default tmux dir) — used when the pane comes
  // from explicit plugin config.
  socketName?: string
  // `-S /path/to/socket` (absolute socket path) — used when the pane is
  // resolved from the plugin's own $TMUX env (we live inside the session).
  socketPath?: string
}

export type KeysExec = (args: readonly string[]) => Promise<{ exitCode: number; stderr: string }>

async function defaultKeysExec(args: readonly string[]): Promise<{ exitCode: number; stderr: string }> {
  try {
    const { stderr } = await execFileAsync('tmux', args as string[], {
      encoding: 'utf8',
      timeout: 5000,
    })
    return { exitCode: 0, stderr }
  } catch (err) {
    const e = err as { stderr?: string; code?: number; message?: string }
    return {
      exitCode: typeof e.code === 'number' ? e.code : 1,
      stderr: e.stderr ?? e.message ?? 'tmux exec failed',
    }
  }
}

// Send the validated steps to the pane, one send-keys call per step (mixing
// -l and named keys in a single call is error-prone). Stops on first failure.
export async function sendKeys(
  target: TmuxKeysTarget,
  parsed: ParsedKeys,
  exec: KeysExec = defaultKeysExec,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const socketArgs = target.socketPath
    ? ['-S', target.socketPath]
    : target.socketName
      ? ['-L', target.socketName]
      : []
  for (const step of parsed.steps) {
    const args = [
      ...socketArgs,
      'send-keys',
      '-t',
      target.paneTarget,
      ...(step.literal ? ['-l'] : []),
      step.key,
    ]
    const res = await exec(args)
    if (res.exitCode !== 0) {
      return { ok: false, error: res.stderr.slice(0, 200) || `tmux exited ${res.exitCode}` }
    }
  }
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────────────
// /cc — passthrough to Claude Code's own slash commands (/compact, /clear,
// /model, /context, custom skills, …) by typing them into the agent pane.
// ─────────────────────────────────────────────────────────────────────

// Slash-command NAME: a leading letter then letters/digits/colon/dash.
// Colon allows plugin-namespaced commands (e.g. superpowers:brainstorm).
export const SLASH_NAME_RE = /^[a-z][a-z0-9:-]{0,40}$/
// ARGS: a deliberately narrow set — alphanumerics, space, and a few path/flag
// punctuation marks. NO shell metacharacters ($ ` ; | & > < ( ) { } " ' \\),
// so even if the pane were at a shell prompt the text can't compose a command.
export const SLASH_ARGS_RE = /^[A-Za-z0-9 ._:/@=-]{0,200}$/

export interface ParsedCc {
  name: string
  rest: string
}

export function parseCcCommand(args: string): ParsedCc | { error: string } {
  const trimmed = args.trim()
  if (trimmed.length === 0) {
    return { error: 'usage: /cc <команда> [аргументы] — напр. /cc compact, /cc model opus' }
  }
  // Explicit newline reject (Codex/Fable review): the charset already excludes
  // \r\n, but a bare-anchored regex CAN match before a trailing newline in JS,
  // so reject up front to make the single-line invariant obvious and robust.
  if (/[\r\n]/.test(trimmed)) {
    return { error: 'аргументы не должны содержать переводов строки' }
  }
  const wsIdx = trimmed.search(/\s/)
  const rawName = wsIdx === -1 ? trimmed : trimmed.slice(0, wsIdx)
  const name = rawName.toLowerCase().replace(/^\//, '')
  const rest = wsIdx === -1 ? '' : trimmed.slice(wsIdx + 1).trim()
  if (!SLASH_NAME_RE.test(name)) {
    return { error: `недопустимое имя команды: ${rawName}` }
  }
  if (!SLASH_ARGS_RE.test(rest)) {
    return { error: 'аргументы содержат недопустимые символы (разрешены буквы, цифры, . _ : / @ = -)' }
  }
  return { name, rest }
}

// Type `/<name> [rest]` into the pane and submit with Enter. Clears the input
// line first (C-u) so a leftover draft can't corrupt the command — the same
// hygiene used when driving another agent's pane by hand.
//
// IT2-7: funnelled through the SAME per-pane serialization chain as
// sendControlCommand (via runOnPaneChain, defined below) so an argful /cc, a
// /keys tap, or /stop cannot interleave its keystrokes with an in-flight control
// 3-shot. The raw body lives in `sendSlashCommandInner`; the export is the
// chained wrapper. Return contract is unchanged.
export function sendSlashCommand(
  target: TmuxKeysTarget,
  parsed: ParsedCc,
  exec: KeysExec = defaultKeysExec,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return runOnPaneChain(target, () => sendSlashCommandInner(target, parsed, exec))
}

async function sendSlashCommandInner(
  target: TmuxKeysTarget,
  parsed: ParsedCc,
  exec: KeysExec = defaultKeysExec,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const socketArgs = target.socketPath
    ? ['-S', target.socketPath]
    : target.socketName
      ? ['-L', target.socketName]
      : []
  const text = parsed.rest ? `/${parsed.name} ${parsed.rest}` : `/${parsed.name}`
  // `text` always starts with '/', so it can never be parsed as a tmux flag.
  const steps: Array<readonly string[]> = [
    [...socketArgs, 'send-keys', '-t', target.paneTarget, 'C-u'],
    [...socketArgs, 'send-keys', '-t', target.paneTarget, '-l', text],
    [...socketArgs, 'send-keys', '-t', target.paneTarget, 'Enter'],
  ]
  for (const args of steps) {
    const res = await exec(args)
    if (res.exitCode !== 0) {
      return { ok: false, error: res.stderr.slice(0, 200) || `tmux exited ${res.exitCode}` }
    }
  }
  return { ok: true }
}

// Send a single named key (Escape, Enter, …) to the pane — used by /stop to
// interrupt Claude, and reusable by other control commands.
//
// IT2-7: the export is serialized through the per-pane chain (runOnPaneChain) so
// a /stop Escape can't land between an in-flight control 3-shot's keystrokes.
// The raw body is `sendNamedKeyInner`; sendControlCommandInner calls the INNER
// form directly (it already holds the pane chain — re-chaining would deadlock).
export function sendNamedKey(
  target: TmuxKeysTarget,
  key: string,
  exec: KeysExec = defaultKeysExec,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return runOnPaneChain(target, () => sendNamedKeyInner(target, key, exec))
}

async function sendNamedKeyInner(
  target: TmuxKeysTarget,
  key: string,
  exec: KeysExec = defaultKeysExec,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const socketArgs = target.socketPath
    ? ['-S', target.socketPath]
    : target.socketName
      ? ['-L', target.socketName]
      : []
  const res = await exec([...socketArgs, 'send-keys', '-t', target.paneTarget, key])
  if (res.exitCode !== 0) {
    return { ok: false, error: res.stderr.slice(0, 200) || `tmux exited ${res.exitCode}` }
  }
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────────────
// /clear, /compact & friends — RELIABLE control-command injection.
//
// Problem (warchief, 2026-07-01, verified empirically): the 3-shot
// `sendSlashCommand` above (C-u / -l '/cmd' / Enter) is correct ONLY when the
// pane is IDLE. It fails in two states:
//   - BUSY: Claude Code QUEUES text typed while it is working; the command
//     sits in the queue and runs ~25s later (or is silently dropped).
//   - DIALOG: a native permission/confirm dialog is open; the trailing Enter
//     APPROVES THE DIALOG and the typed command is lost.
// Fix: PROBE the pane state before sending, then CONFIRM the command actually
// fired afterwards. Never blind-Enter into a busy pane or an open dialog.
//
// Additive — `sendSlashCommand` stays for argful /cc passthrough (idle only).
// Everything here is driven by `capture-pane`, whose stdout the send-only
// `KeysExec` deliberately drops, so a dedicated capture exec type is needed.

// A capture-capable exec: like `KeysExec` but KEEPS stdout, which `capture-pane`
// needs. Kept SEPARATE from `KeysExec` so the send-only path can never grow a
// stdout dependency, and so tests can script pane snapshots independently of the
// send-keys fake.
export type KeysCaptureExec = (
  args: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

async function defaultKeysCaptureExec(
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('tmux', args as string[], {
      encoding: 'utf8',
      timeout: 5000,
    })
    return { exitCode: 0, stdout, stderr }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string }
    return {
      exitCode: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? 'tmux exec failed',
    }
  }
}

// Snapshot the pane's visible text (`capture-pane -p`). Returns '' on ANY tmux
// failure — callers classify '' as 'unknown' (never idle), so a failed capture
// can never be mistaken for a safe-to-send idle pane.
export async function capturePane(
  target: TmuxKeysTarget,
  exec: KeysCaptureExec = defaultKeysCaptureExec,
): Promise<string> {
  const socketArgs = target.socketPath
    ? ['-S', target.socketPath]
    : target.socketName
      ? ['-L', target.socketName]
      : []
  const res = await exec([...socketArgs, 'capture-pane', '-p', '-t', target.paneTarget])
  if (res.exitCode !== 0) return ''
  return res.stdout
}

export type PaneState = 'idle' | 'busy' | 'dialog' | 'unknown'

// Number of trailing lines that constitute the LIVE UI chrome (the composer box
// + footer hints + the status/spinner line just above the box). We match the
// pane-state markers ONLY within this bottom region so the agent's OWN
// transcript — which can literally contain strings like "esc to interrupt" or
// "Do you want to proceed?" (this very plugin discusses them) — scrolls ABOVE
// the chrome and can never be misread as live pane state (FIX-5, Fable M3).
//
// Fail-safe bias: a marker that quotes chrome text in the last few transcript
// lines yields a FALSE busy/dialog, which only makes us REFUSE to send (safe),
// never a false idle (which would blind-send). 12 lines comfortably spans a
// tall permission dialog box while excluding scrolled-up history.
const BOTTOM_CHROME_LINES = 12

// The bottom UI chrome region of a capture (geometry anchor for classifyPane,
// the queued-check and the fired-marker count). Exported-internal helper; PURE.
//
// IT2-4: strip trailing whitespace-only lines BEFORE taking the last N. When a
// taller render shrinks (a dialog box closed, a compaction finished) tmux can
// leave blank rows padding the bottom of the capture; without trimming them the
// real chrome markers get pushed OUT of the last-N window and we go blind to the
// live pane state (a false 'unknown'/'idle'). Trimming the blank tail keeps the
// markers inside the window. classifyPane, the queued-check and firedMarkerCount
// all read through this trimmed region.
function bottomChrome(text: string): string {
  const lines = text.split('\n')
  let end = lines.length
  while (end > 0 && lines[end - 1]!.trim().length === 0) end--
  const trimmed = lines.slice(0, end)
  if (trimmed.length <= BOTTOM_CHROME_LINES) return trimmed.join('\n')
  return trimmed.slice(trimmed.length - BOTTOM_CHROME_LINES).join('\n')
}

// Classify a pane snapshot by string-matching Claude Code TUI v2.1.200 markers,
// anchored to the bottom UI chrome (FIX-5). PURE (no I/O) so it is trivially
// unit-testable against canned captures.
//
// Idle footer is MODE-DEPENDENT (verified on the live pane, v2.1.200): Manual
// mode shows `? for shortcuts`; bypass / accept-edits / plan modes show
// `⏵⏵ … (shift+tab to cycle)` — which PERSISTS on line 1 even while the slash
// autocomplete popup is open. We OR both markers so idle is recognised in every
// mode.
//
// Ordering is load-bearing: DIALOG is checked BEFORE BUSY, because a native
// permission dialog can ALSO render an "esc to interrupt" hint while a tool runs
// behind it — but a dialog needs an explicit answer, never a blind Enter, so
// dialog must win. Dialog markers (`Do you want to proceed?`, `❯ 1.`,
// `Esc to cancel`) confirmed exact on v2.1.200 — the folder-trust dialog uses
// `❯ 1. Yes…` + `Esc to cancel` (no "Do you want to proceed?"), still caught.
//
// Callers MUST treat 'unknown' as NOT-idle: if we cannot POSITIVELY identify an
// idle composer, we never blind-Enter (the trailing Enter of a slash command
// could otherwise approve a prompt we failed to recognise). Geometry-detection
// failure (empty capture, no recognisable chrome) → 'unknown' → refuse.
export function classifyPane(text: string): PaneState {
  const chrome = bottomChrome(text)
  if (
    chrome.includes('Do you want to proceed?') ||
    chrome.includes('❯ 1.') ||
    chrome.includes('Esc to cancel')
  ) {
    return 'dialog'
  }
  // v2.1.200 busy footer printed "esc to interrupt". v2.1.201 replaced it with a
  // spinner line "✢ … (Nm Ns · ↓ Nk tokens)" that no longer prints that phrase,
  // so a busy pane classified as 'unknown' and compact refused (regression
  // 2026-07-06, foreshadowed by the radar's claude-code v2.1.201 bump). Detect
  // BOTH markers; the spinner's "· ↓/↑ … tokens)" tail never appears idle/dialog.
  if (
    chrome.includes('esc to interrupt') ||
    /·\s*[↓↑][\s\d.,]*k?\s*tokens?\)/i.test(chrome)
  ) {
    return 'busy'
  }
  if (
    (chrome.includes('shift+tab to cycle') || chrome.includes('? for shortcuts')) &&
    !chrome.includes('esc to interrupt')
  ) {
    return 'idle'
  }
  return 'unknown'
}

// Real timer sleep. Tests inject an instant no-op so the confirm-fire poll does
// not actually wait ~1.5s.
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export interface ControlCommandOpts {
  // Interrupt a BUSY pane (Escape, wait, re-probe) before sending. When false
  // (default) a busy pane is left untouched and reported as busy.
  interruptIfBusy?: boolean
  // Delay primitive — injected as an instant no-op in tests.
  sleep?: (ms: number) => Promise<void>
  // Send-only exec (send-keys). Defaults to the real tmux exec.
  exec?: KeysExec
  // Capture-capable exec (capture-pane). Defaults to the real tmux exec.
  captureExec?: KeysCaptureExec
}

// Discriminated union: either it fired, or it did not — with the precise reason
// so the caller can tell the user WHY (dialog open, pane busy, never submitted,
// a raw tmux failure, or an UNKNOWN pane we refused to blind-send into).
//
// `unknown` (FIX-1, both reviews): a failed capture-pane returns '' and an
// unrecognised screen both classify as `unknown`. We NEVER send into an
// unknown pane — a blind Enter could approve a dialog we failed to recognise —
// so the caller sees an explicit `unknown` reason rather than a silent send.
export type ControlCommandResult =
  | { ok: true }
  | { ok: false; reason: 'dialog' | 'busy' | 'not-submitted' | 'tmux' | 'unknown' }

// The composer text region = the lines framed by the LAST two horizontal box
// rules (the input box borders). We check THIS region — not the whole capture —
// for a leftover '/'+name, so a transcript ECHO of the submitted command
// (rendered OUTSIDE the box) is never mistaken for an un-submitted draft.
function composerRegion(text: string): string {
  const lines = text.split('\n')
  const ruleIdx: number[] = []
  for (let i = 0; i < lines.length; i++) {
    // A box border: 3+ consecutive ─ (U+2500) or a long ASCII dash run.
    if (/─{3,}/.test(lines[i]!) || /-{5,}/.test(lines[i]!)) ruleIdx.push(i)
  }
  if (ruleIdx.length === 0) return text // no box drawn — be conservative
  const last = ruleIdx[ruleIdx.length - 1]!
  const prev = ruleIdx.length >= 2 ? ruleIdx[ruleIdx.length - 2]! : -1
  return lines.slice(prev + 1, last).join('\n')
}

// Count non-overlapping occurrences of `needle` in `haystack`. PURE. Empty
// needle → 0 (never matches, so it can't spuriously certify a fire).
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

// Positive "it actually ran" marker strings per command. Scoped to the bottom UI
// chrome (FIX-5) by the caller so a transcript far above that quotes
// "Compacting" is not misread. For `compact` we track BOTH the
// `Compacting conversation…` banner AND the `❯ /compact` echo — a fresh compact
// always prints at least the echo, so summing them makes a genuine fire reliably
// ADD to the count even when a prior run's banner is still on screen.
//
// CRITICAL (coordinator smoke-test, v2.1.200): `Ctrl+Y to paste` does NOT render
// after /clear in this build — using it as the clear marker made /clear and /new
// ALWAYS report not-submitted even on success. /clear success is the fresh
// `❯ /clear` echo (plus the transcript collapse handled in confirmedFired).
function firedMarkers(name: string): readonly string[] {
  if (name === 'clear') {
    // /clear echoes an accepted `❯ /clear` into the (now-collapsed) transcript.
    return ['❯ /clear']
  }
  if (name === 'compact') {
    return ['Compacting', `❯ /${name}`]
  }
  // Generic: Claude Code echoes an accepted slash command into the transcript
  // as `❯ /name`. (Distinct from the dialog option marker `❯ 1.`.)
  return [`❯ /${name}`]
}

// IT2-2: the total occurrence count of a command's fired-markers WITHIN the
// bottom UI chrome. Success is judged by an INCREASE of this count vs the
// pre-send baseline (a fresh occurrence), never by mere presence — a stale
// marker already on screen no longer certifies a fire.
function firedMarkerCount(name: string, text: string): number {
  const chrome = bottomChrome(text)
  let total = 0
  for (const m of firedMarkers(name)) total += countOccurrences(chrome, m)
  return total
}

// Transcript region = everything ABOVE the composer box (before its top rule).
// Used only to detect that /clear visibly WIPED the conversation.
function transcriptRegion(text: string): string {
  const lines = text.split('\n')
  const ruleIdx: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/─{3,}/.test(lines[i]!) || /-{5,}/.test(lines[i]!)) ruleIdx.push(i)
  }
  if (ruleIdx.length < 2) return ''
  const boxTop = ruleIdx[ruleIdx.length - 2]!
  return lines.slice(0, boxTop).join('\n')
}

function nonEmptyLineCount(text: string): number {
  return text.split('\n').filter((l) => l.trim().length > 0).length
}

// FIX-2 / IT2-2 (both reviews): a merely-PRESENT positive marker is not proof of
// success — a marker left over from a PREVIOUS command (a stale "Compacting…",
// "Ctrl+Y to paste", or "❯ /name") would otherwise certify a command that never
// fired (a false NEGATIVE the other way: it made a real fire read as
// not-submitted, and broke back-to-back compacts). Require a FRESH OCCURRENCE:
// the marker count within the bottom chrome must INCREASE vs the PRE-SEND
// baseline. A stale marker leaves the count unchanged (refuse); a genuine
// (even back-to-back) fire adds a new occurrence on top (accept). For /clear we
// ALSO accept a visibly collapsed transcript (the old conversation wiped) as
// proof it ran, covering the case where a stale paste-hint was already on screen
// and the count cannot move.
function confirmedFired(name: string, snap: string, baseline: string): boolean {
  // Primary: a FRESH occurrence of the command's marker in the bottom chrome.
  if (firedMarkerCount(name, snap) > firedMarkerCount(name, baseline)) return true
  if (name === 'clear') {
    // /clear success #2: the conversation visibly COLLAPSED (fewer transcript
    // lines than before) — the wipe landed.
    if (nonEmptyLineCount(transcriptRegion(snap)) < nonEmptyLineCount(transcriptRegion(baseline))) {
      return true
    }
    // /clear success #3 (coordinator, v2.1.200): on an ALREADY-SHORT / already-
    // clear session neither the count nor the transcript can move, yet the clear
    // did run. The reliable sender only pressed Enter on a VERIFIED `/clear` draft
    // in an idle pane, so an empty composer (the caller already checked that) with
    // the `❯ /clear` echo on screen AND an idle footer back is a confident
    // success — prefer it over a false not-submitted.
    if (bottomChrome(snap).includes('❯ /clear') && classifyPane(snap) === 'idle') {
      return true
    }
  }
  return false
}

// FIX-4 (both reviews): per-pane serialization. This code drives the user's
// ONLY communication channel by injecting keystrokes; two concurrent control
// sends into the SAME pane (e.g. a HUD «Сжать» tap racing a typed /compact)
// could interleave C-u / text / Enter and corrupt the command — or worse,
// let one call's Enter land on another's half-typed draft. IT2-7: EVERY pane
// write — sendControlCommand, sendSlashCommand, sendNamedKey — chains through
// this per-target promise (runOnPaneChain) so they run strictly one-at-a-time.
// Keyed by socket+pane so distinct panes stay independent. The stored chain is
// the SETTLED (never-rejecting) tail, so a failed/throwing call never poisons the
// next one.
const paneChains = new Map<string, Promise<void>>()

// IT2-7: run `fn` strictly after any in-flight pane operation for the SAME
// target, and make the next caller wait for `fn`. The single per-pane
// serialization primitive shared by sendControlCommand, sendSlashCommand and
// sendNamedKey so their keystrokes can never interleave. The stored chain tail
// is the SETTLED (never-rejecting) promise, so a throwing/failing op never
// poisons the next one. NOT re-entrant: an op already running inside the chain
// must call the *Inner form directly, never re-enter through here (it would
// deadlock waiting on its own tail).
function runOnPaneChain<T>(target: TmuxKeysTarget, fn: () => Promise<T>): Promise<T> {
  const key = paneKey(target)
  const prior = paneChains.get(key) ?? Promise.resolve()
  // Chain on the prior tail (which never rejects) so an earlier failure can't
  // skip this call's body.
  const result = prior.then(fn)
  const settled: Promise<void> = result.then(
    () => undefined,
    () => undefined,
  )
  paneChains.set(key, settled)
  // Opportunistic cleanup: drop the entry once WE are the tail and have settled.
  void settled.then(() => {
    if (paneChains.get(key) === settled) paneChains.delete(key)
  })
  return result
}

function paneKey(target: TmuxKeysTarget): string {
  return `${target.socketPath ?? ''} ${target.socketName ?? ''} ${target.paneTarget}`
}

// Reliable control-command injection: probe → (optionally interrupt) → send →
// CONFIRM, serialized per pane. `name` must pass `SLASH_NAME_RE` — the SAME
// closed slash-name whitelist `sendSlashCommand` uses. Control commands here
// take NO args (/clear, /compact, …).
export function sendControlCommand(
  target: TmuxKeysTarget,
  name: string,
  opts: ControlCommandOpts = {},
): Promise<ControlCommandResult> {
  return runOnPaneChain(target, () => sendControlCommandInner(target, name, opts))
}

async function sendControlCommandInner(
  target: TmuxKeysTarget,
  name: string,
  opts: ControlCommandOpts,
): Promise<ControlCommandResult> {
  // Reuse the frozen slash-name whitelist. A name outside it is a programming
  // error (callers validate via `parseCcCommand` first), so fail loudly rather
  // than smuggle an unvalidated token toward the pane.
  if (!SLASH_NAME_RE.test(name)) {
    throw new RangeError(`sendControlCommand: invalid command name «${name}»`)
  }
  const exec = opts.exec ?? defaultKeysExec
  const captureExec = opts.captureExec ?? defaultKeysCaptureExec
  const sleep = opts.sleep ?? realSleep
  const interruptIfBusy = opts.interruptIfBusy ?? false

  const socketArgs = target.socketPath
    ? ['-S', target.socketPath]
    : target.socketName
      ? ['-L', target.socketName]
      : []

  // a. Probe pane state. This snapshot is ALSO the PRE-SEND baseline (FIX-2) —
  //    the fired-marker check below requires a FRESH transition against it.
  let baseline = await capturePane(target, captureExec)
  let state = classifyPane(baseline)

  // b. Dialog open → send NOTHING (the trailing Enter would approve it).
  if (state === 'dialog') {
    return { ok: false, reason: 'dialog' }
  }

  // c. Busy → either interrupt (Escape, wait, re-probe) or refuse.
  if (state === 'busy') {
    if (!interruptIfBusy) {
      return { ok: false, reason: 'busy' }
    }
    // IT2-7: call the INNER (unchained) form — we already hold the pane chain,
    // so re-entering runOnPaneChain here would deadlock on our own tail.
    const esc = await sendNamedKeyInner(target, 'Escape', exec)
    if (!esc.ok) return { ok: false, reason: 'tmux' }
    await sleep(350)
    baseline = await capturePane(target, captureExec)
    state = classifyPane(baseline)
    if (state === 'busy') {
      return { ok: false, reason: 'busy' }
    }
    if (state === 'dialog') {
      // Interrupting surfaced a confirm dialog — never type a command into it.
      return { ok: false, reason: 'dialog' }
    }
  }

  // FIX-1 (both reviews): require a POSITIVE idle before sending. A failed
  // capture ('' → unknown) or any unrecognised screen must NEVER fall through
  // to the 3-shot — a blind Enter could approve a dialog we failed to classify.
  if (state !== 'idle') {
    return { ok: false, reason: 'unknown' }
  }

  // d. 3-shot: clear the line, type '/'+name, (settle) then submit with Enter.
  const text = `/${name}`
  // `text` always starts with '/', so it can never be parsed as a tmux flag.
  const preEnter: Array<readonly string[]> = [
    [...socketArgs, 'send-keys', '-t', target.paneTarget, 'C-u'],
    [...socketArgs, 'send-keys', '-t', target.paneTarget, '-l', text],
  ]
  for (const args of preEnter) {
    const res = await exec(args)
    if (res.exitCode !== 0) return { ok: false, reason: 'tmux' }
  }
  await sleep(120) // let the TUI render the typed text before Enter

  // FIX-3 + IT2-3 (both reviews): TOCTOU guard, refined. Between typing the draft
  // and pressing Enter a native dialog / busy state can surface — those are the
  // DANGEROUS states (a trailing Enter would approve a dialog or queue behind a
  // running tool), so we ABORT on them (wipe the draft, refuse). But typing a
  // slash command ALSO opens Claude Code's autocomplete popup, which can REPLACE
  // the idle footer hints → classifyPane === 'unknown'; a slow paint can also
  // hide the draft transiently. Refusing on unknown/absent here would kill every
  // control send. So we poll a short window (~600ms) for the composer to actually
  // show our '/name' draft, and as long as the pane is NOT busy/dialog we press
  // Enter once the draft is visible. Only if the draft never appears do we refuse
  // (not-submitted).
  let draftReady = false
  for (let attempt = 0; attempt < 3; attempt++) {
    const snap = await capturePane(target, captureExec)
    const st = classifyPane(snap)
    if (st === 'dialog' || st === 'busy') {
      // A dangerous state surfaced in the settle window — never Enter. Wipe the
      // draft so it can't be submitted by a later keystroke.
      await exec([...socketArgs, 'send-keys', '-t', target.paneTarget, 'C-u'])
      return { ok: false, reason: st }
    }
    if (composerRegion(snap).includes(text)) {
      draftReady = true
      break
    }
    if (attempt < 2) await sleep(250)
  }
  if (!draftReady) {
    await exec([...socketArgs, 'send-keys', '-t', target.paneTarget, 'C-u'])
    return { ok: false, reason: 'not-submitted' }
  }

  const enter = await exec([...socketArgs, 'send-keys', '-t', target.paneTarget, 'Enter'])
  if (enter.exitCode !== 0) return { ok: false, reason: 'tmux' }

  // e. Confirm-fire: poll for the fired signal. IT2-2: capture IMMEDIATELY after
  //    Enter (a fresh marker often lands right away), then a few short intervals
  //    to cover a slow render — waiting a full 500ms first needlessly delayed the
  //    ok. Success requires ALL of: composer emptied (the region above the last
  //    rule no longer holds '/'+name) AND not queued ('Press up to edit queued
  //    messages' absent WITHIN the bottom chrome, so a stale/scrolled quote of it
  //    can't false-fail) AND a FRESH command-specific fired OCCURRENCE vs the
  //    pre-send baseline (a stale marker never certifies success).
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(400)
    const snap = await capturePane(target, captureExec)
    const composerEmptied = !composerRegion(snap).includes(text)
    const queued = bottomChrome(snap).includes('Press up to edit queued messages')
    if (composerEmptied && !queued && confirmedFired(name, snap, baseline)) {
      return { ok: true }
    }
  }
  return { ok: false, reason: 'not-submitted' }
}
