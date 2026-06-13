// /key — deterministic keystrokes from Telegram into the agent's tmux pane.
//
// Problem (warchief, 2026-06-12): Claude Code's NATIVE interactive dialogs
// (permission rules like `Bash(rm:*) requires confirmation`, model switch
// prompts, trust dialogs) render in the terminal. The tmux mirror SHOWS them
// in Telegram, but there was no way to ANSWER one remotely — the session sat
// blocked until someone reached the real terminal.
//
// /key sends an explicit, WHITELISTED keystroke sequence to the pane:
//   /key 2          → press «2» (select dialog option 2)
//   /key 1 enter    → press «1», then Enter
//   /key esc        → cancel the dialog
//
// Security model:
//   - Reaches this code only via the OOB gate in handlers.ts: private chat
//     + allowed_user_ids + allowed_chat_ids. Group chats never get here.
//   - Tokens are a closed whitelist (digits, y/n, enter/esc/tab/space,
//     arrows). Arbitrary text is rejected, so /key cannot be used to type
//     shell commands into a pane that dropped out of Claude into a shell.
//   - Max 5 tokens per command — a dialog answer, not a macro language.

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// Literal characters are sent with `send-keys -l` (no name lookup);
// named keys are sent without -l so tmux resolves Enter/Escape/arrows.
// Exported so the /keys inline-button panel (telegram/keys-panel-ui.ts)
// derives its accepted token set from THESE structures — a single whitelist
// shared by the `/key` text command and the tap keypad.
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
} as const)

export const MAX_KEY_TOKENS = 5

export interface ParsedKeys {
  // In tmux send-keys argument form, one entry per keystroke.
  steps: Array<{ literal: boolean; key: string }>
}

// Parse "/key 2 enter" args into validated steps. Returns an error string
// (for the Telegram reply) when any token is outside the whitelist.
export function parseKeyTokens(args: string): ParsedKeys | { error: string } {
  const tokens = args.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) {
    return { error: 'usage: /key <1-9|0|y|n|enter|esc|tab|space|up|down|left|right> …' }
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
      return { error: `неизвестная клавиша: ${t} — разрешены цифры, y/n, enter, esc, tab, space, стрелки` }
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
export async function sendSlashCommand(
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
export async function sendNamedKey(
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
