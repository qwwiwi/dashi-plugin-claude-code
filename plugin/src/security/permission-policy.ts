// Permission policy classifier for the Telegram-driven permission gate.
//
// CONTEXT
// -------
// The owner drives a tmux-resident Claude Code session from Telegram and is
// never at the terminal. Interactive permission prompts (Allow/Deny on Bash,
// Edit, …) render only in the pane and wedge the session. The fix is to run
// the session under `--permission-mode bypassPermissions` (no terminal
// prompt ever fires) and put a PreToolUse hook in front of every tool call
// as the *only* gate. This module is that gate's brain: a pure function that
// classifies one tool call into a tier:
//
//   * allow   — run silently, no human in the loop.
//   * deny    — block hard; never reaches the human (catastrophic / secret).
//   * confirm — route an Allow/Deny prompt to Telegram; the hook waits for
//               the owner's tap and maps it back to allow/deny.
//
// SECURITY POSTURE (Codex GPT-5.5 xhigh review, 2026-06-09)
// ---------------------------------------------------------
// Because bypassPermissions makes a policy mistake execute immediately, the
// classifier is hardened independently of the operator-supplied policy:
//   * A built-in hard-deny set always fires (secret files, credential reads,
//     filesystem-wipe / fork-bomb commands) and cannot be relaxed by config.
//   * Bash matching defends against interpreter evasion (curl|sh, bash -c,
//     base64 -d|sh, …), not just literal substrings.
//   * Paths are checked both raw and normalized (../ and trailing-dot
//     evasion) against glob rules; Write/Edit get a separate stricter list.
//   * Precedence is deny > confirm > allow > default_tier, and the whole
//     function is fail-closed: any malformed input degrades to `deny`.
//
// This module is intentionally I/O-free so it can be unit-tested exhaustively
// without spawning a session. The hook wrapper (scripts/permission-gate-hook.ts)
// owns stdin/stdout, the loopback POST, and the bounded-deadline wait.

import { resolve } from 'path'
import { z } from 'zod'

export type PermissionTier = 'allow' | 'deny' | 'confirm'

export interface PermissionVerdict {
  readonly tier: PermissionTier
  /** Human-readable, safe to surface to the owner / transcript. */
  readonly reason: string
  /** The rule that matched, for audit. `builtin:*` for baked-in rules. */
  readonly matchedRule: string
}

/** One tier's matchers. All fields optional; absent = matches nothing. */
export interface PolicyRules {
  /** fnmatch globs against the tool name (e.g. "mcp__dashi-gbrain-*"). */
  readonly tools?: readonly string[]
  /** fnmatch globs against file_path for Read/Edit/Write/NotebookEdit. */
  readonly read_paths?: readonly string[]
  /** fnmatch globs against file_path for Edit/Write/NotebookEdit only. */
  readonly write_paths?: readonly string[]
  /** substring (default) or fnmatch (when glob meta present) on Bash command. */
  readonly bash_patterns?: readonly string[]
}

export interface PolicyScope {
  readonly deny?: PolicyRules
  readonly confirm?: PolicyRules
  readonly allow?: PolicyRules
}

// Strict runtime schema for an operator-supplied policy (Codex high,
// 2026-06-09). The hook validates parsed YAML against this before trusting
// it; on any failure it discards the file and falls back to confirm-everything
// so a typo'd/hostile policy can never silently widen the allow surface.
// `.strict()` rejects unknown keys (e.g. a misspelled `allows:` that would
// otherwise be ignored and leave the intended rule un-applied).
const PolicyRulesSchema = z
  .object({
    tools: z.array(z.string()).optional(),
    read_paths: z.array(z.string()).optional(),
    write_paths: z.array(z.string()).optional(),
    bash_patterns: z.array(z.string()).optional(),
  })
  .strict()

const PolicyScopeSchema = z
  .object({
    deny: PolicyRulesSchema.optional(),
    confirm: PolicyRulesSchema.optional(),
    allow: PolicyRulesSchema.optional(),
  })
  .strict()

export const PermissionPolicySchema = z
  .object({
    // Optional doc/version marker — accepted and ignored so the shipped
    // example policy (which carries `version: 1`) passes strict validation
    // instead of being discarded into the confirm-everything fallback.
    version: z.number().optional(),
    default_tier: z.enum(['allow', 'confirm']).optional(),
    deny: PolicyRulesSchema.optional(),
    confirm: PolicyRulesSchema.optional(),
    allow: PolicyRulesSchema.optional(),
    scopes: z.record(z.string(), PolicyScopeSchema).optional(),
  })
  .strict()

export interface PermissionPolicy {
  /**
   * Tier for a tool call that matches no deny/confirm/allow rule.
   *   * "allow"   — Variant 1 (recommended): smooth flow, only the explicit
   *                 confirm/deny lists + built-in hard-deny gate the owner.
   *   * "confirm" — Variant 2: every unmatched mutating call asks Telegram;
   *                 read-only tools still auto-allow.
   * Defaults to "confirm" (fail-safe) when omitted or invalid.
   */
  readonly default_tier?: 'allow' | 'confirm'
  /** Global rules applied to every scope. */
  readonly deny?: PolicyRules
  readonly confirm?: PolicyRules
  readonly allow?: PolicyRules
  /** Per-scope (per-chat / "main") overrides, unioned with the globals. */
  readonly scopes?: Readonly<Record<string, PolicyScope>>
}

// Tools that cannot mutate state or exfiltrate data. Under default_tier
// "confirm" these still auto-allow so read-only work never blocks.
//
// WebSearch / WebFetch are deliberately NOT here (Codex high, 2026-06-09):
// a search query or fetched URL is an outbound channel that can exfiltrate
// context, so they must not be classified as inherently safe. They fall to
// default_tier (confirm under Variant 2) and can be operator-allowlisted.
const READ_ONLY_TOOLS = new Set<string>([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'TodoWrite',
])

// Tools that take a filesystem path we must policy-check.
const READ_PATH_TOOLS = new Set<string>(['Read', 'NotebookRead'])
const WRITE_PATH_TOOLS = new Set<string>(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

// ── Built-in hard rules (operator cannot relax) ─────────────────────────
//
// These fire before any operator policy. Secret/credential reads and writes,
// and catastrophic shell commands, are denied unconditionally.

const BUILTIN_DENY_PATHS: readonly string[] = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/.secrets/**',
  '**/secrets/**',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.ssh/**',
  '**/.aws/**',
  '**/.config/gcloud/**',
  '**/.claude/.credentials*',
  '**/.codex/auth*',
  '/proc/*/environ',
  '/proc/*/cmdline',
]

// Risky-but-legitimate shell that must reach the owner as a confirm when the
// operator policy hasn't already classified it. Substring match (lowercased).
// Interpreter/exfil evasion (curl|sh with any spacing) is handled separately
// by `bashConfirmEvasion` so a clever command can't silently auto-allow.
const BUILTIN_CONFIRM_BASH: readonly string[] = [
  'sudo ',
  'rm -rf ',
  'rm -fr ',
  'git push',
  'git reset --hard',
  'git clean -',
  'chmod -r',
  'chown -r',
  'systemctl',
  'kill ',
  'pkill',
  'docker ',
  'npm publish',
  'pip install',
  'apt install',
  'apt-get install',
]

// ── Catastrophic Bash detection (Codex Critical #4, 2026-06-09) ─────────
//
// Substring matching let `rm -r -f /`, `rm -rf -- /`, `dd … of=/dev/nvme0n1`
// and `wipefs -a /dev/sda` slip past the old literal list. We tokenize each
// top-level shell segment instead. This is a best-effort backstop, NOT the
// sole secret/destructive boundary (that is `env -i` isolation + this gate's
// fail-closed posture): a sufficiently obfuscated command (eval of a base64
// blob, variable-built paths) can still evade — those route through the
// built-in confirm tier or operator policy instead.

// Block-device families a destructive write must never target unconfirmed.
const BLOCK_DEVICE_RE = /\/dev\/(sd|nvme|vd|hd|disk|mmcblk|xvd|loop|dm-)/i

// Root / home targets that turn a recursive delete into a catastrophe.
// `\/+\*?` catches `/`, `//`, `///*` etc. (Codex high: `rm -rf //` evaded).
const ROOT_TARGET_RE = /^(\/+\*?|~\/?|\$\{?home\}?\/?|\/root\/?\*?|\/home\/?\*?|\.\/?\*)$/i

// Fork bomb, tolerant of internal spacing: `:(){ :|:& };:` and variants.
const FORK_BOMB_RE = /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;\s*:/

// Secret/credential references inside a Bash command (Codex Critical #2).
// Mirrors BUILTIN_DENY_PATHS for the Read/Write path tools: `cat .env`,
// `grep … ~/.aws/credentials`, `tar cz ~/.ssh`, `cat /proc/$$/environ` must
// hard-deny just like a Read of the same file. A leading boundary char keeps
// `environment`/`monkey.json`-style false positives out.
const SECRET_BASH_RES: readonly RegExp[] = [
  /(^|[\s'"=:(/<>|&;])\.env($|[\s'".)/<>|&;]|\.[a-z0-9_-]+)/i,
  /\.pem\b/i,
  /\.key\b/i,
  /(^|[\s'"=:(/<>|&;])\.?secrets?\//i,
  /\bid_rsa\b/i,
  /\bid_dsa\b/i,
  /\bid_ecdsa\b/i,
  /\bid_ed25519\b/i,
  /(^|[\s'"=:(/<>|&;])\.ssh($|[\s/'".)<>|&;])/i,
  /(^|[\s'"=:(/<>|&;])\.aws($|[\s/'".)<>|&;])/i,
  /\.config\/gcloud\b/i,
  /\.claude\/\.credentials/i,
  /\.codex\/auth/i,
  /\.credentials\b/i,
  // /proc env/cmdline exfil — numeric pid, $$/$PPID, self, thread-self.
  /\/proc\/(self|thread-self|[0-9]+|\$[a-z]*)\/(environ|cmdline)/i,
]

/** Split a command on top-level shell operators. Best-effort, not quote-aware:
 *  over-segmentation can only MISS a cross-segment catastrophe (acceptable for
 *  a backstop — catastrophic ops live in a single segment). */
function segmentBash(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n|\||&/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** True if any flag token carries `letter` (combined like -rf, or long form). */
function hasFlag(args: readonly string[], letter: string, longNames: readonly string[]): boolean {
  const l = letter.toLowerCase()
  for (const t of args) {
    if (!t.startsWith('-')) continue
    if (t.startsWith('--')) {
      if (longNames.includes(t.slice(2).toLowerCase())) return true
      continue
    }
    if (t.slice(1).toLowerCase().includes(l)) return true
  }
  return false
}

/** Non-flag operands of a segment, honoring `--` end-of-options. */
function operands(args: readonly string[]): string[] {
  const out: string[] = []
  let endOpts = false
  for (const a of args) {
    if (a === '--') { endOpts = true; continue }
    if (!endOpts && a.startsWith('-')) continue
    out.push(a)
  }
  return out
}

// Command prefixes that wrap the real command (`sudo rm -rf /`, `env … dd …`).
// We strip them — plus their flags and VAR=val env assignments — so the
// catastrophe check sees the actual command, not the wrapper.
const COMMAND_WRAPPERS = new Set([
  'sudo', 'doas', 'env', 'nice', 'nohup', 'command', 'builtin', 'exec', 'setsid', 'stdbuf', 'ionice',
])

function stripWrappers(tokens: readonly string[]): string[] {
  let rest = tokens.slice()
  // Bound the loop so a pathological all-wrapper line can't spin.
  for (let i = 0; i < 8 && rest.length > 0; i += 1) {
    const head = (rest[0]!.split('/').pop() ?? rest[0]!).toLowerCase()
    if (!COMMAND_WRAPPERS.has(head)) break
    rest = rest.slice(1)
    // Drop wrapper flags and env assignments (VAR=val) that precede the command.
    while (rest.length > 0 && (rest[0]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!))) {
      rest = rest.slice(1)
    }
  }
  return rest
}

function catastrophicSegment(seg: string): string | null {
  const rawTokens = seg.split(/\s+/).filter(Boolean)
  const tokens = stripWrappers(rawTokens)
  if (tokens.length === 0) return null
  const cmd = (tokens[0]!.split('/').pop() ?? tokens[0]!).toLowerCase()
  const args = tokens.slice(1)

  if (cmd === 'rm') {
    const recursive = hasFlag(args, 'r', ['recursive'])
    const force = hasFlag(args, 'f', ['force'])
    const noPreserve = args.some((a) => a.toLowerCase() === '--no-preserve-root')
    const hitsRoot = operands(args).some((t) => ROOT_TARGET_RE.test(t))
    if ((recursive && force && hitsRoot) || (noPreserve && (recursive || force))) {
      return `rm recursive-force on root target`
    }
  }

  if (cmd === 'dd' && args.some((a) => /^of=/i.test(a) && BLOCK_DEVICE_RE.test(a))) {
    return `dd to block device`
  }

  if (cmd.startsWith('mkfs')) return `mkfs filesystem create`
  if (cmd === 'wipefs') return `wipefs signature wipe`
  if (cmd === 'blkdiscard') return `blkdiscard`
  if (cmd === 'shred' && operands(args).some((p) => BLOCK_DEVICE_RE.test(p))) return `shred block device`

  // Writing a file onto a raw block device clobbers the disk (Codex high:
  // `cp image.iso /dev/sda`, `truncate -s0 /dev/sda`, `tee /dev/sda`).
  if ((cmd === 'cp' || cmd === 'mv' || cmd === 'tee' || cmd === 'truncate') && operands(args).some((p) => BLOCK_DEVICE_RE.test(p))) {
    return `${cmd} onto block device`
  }

  // `find <root> -delete` / `find <root> -exec rm …` recursively wipes a tree.
  if (cmd === 'find') {
    const hasDestructive = args.some((a) => a === '-delete' || a === '-exec' || a === '-execdir')
    const rootScope = operands(args).some((p) => ROOT_TARGET_RE.test(p))
    if (hasDestructive && rootScope) return `find destructive on root scope`
  }

  if (cmd === 'chmod' || cmd === 'chown') {
    const recursive = hasFlag(args, 'r', ['recursive'])
    // chmod/chown: first operand is mode/owner, the rest are paths.
    const paths = operands(args).slice(1)
    if (recursive && paths.some((p) => ROOT_TARGET_RE.test(p))) {
      return `${cmd} -R on root target`
    }
  }

  // Truncating-redirect onto a raw block device: `> /dev/sda`.
  if (/>\s*/.test(seg) && BLOCK_DEVICE_RE.test(seg) && /(^|[\s>])\/dev\//.test(seg)) {
    if (/>\s*\/dev\//.test(seg) && BLOCK_DEVICE_RE.test(seg)) return `redirect onto block device`
  }

  return null
}

/** Built-in catastrophic hard-deny over the whole command. Returns the matched
 *  rule label, or null. Fail-closed callers treat any non-null as deny. */
function builtinBashHardDeny(command: string): string | null {
  if (FORK_BOMB_RE.test(command)) return 'fork-bomb'
  for (const seg of segmentBash(command)) {
    const hit = catastrophicSegment(seg)
    if (hit) return hit
  }
  return null
}

/** Built-in secret-path hard-deny over a Bash command. */
function bashReferencesSecret(command: string): boolean {
  return SECRET_BASH_RES.some((re) => re.test(command))
}

/** Interpreter/exfil pipe evasion that must reach the owner as a confirm.
 *  Tolerant of spacing, absolute interpreter paths (`| /bin/bash`), wrapper
 *  prefixes (`| env bash`, `| sudo bash`), process/command substitution
 *  (`bash <(curl …)`, `sh -c "$(curl …)"`) and base64-decode-to-interpreter
 *  (Codex high — the old detector missed all of these). */
const INTERPRETER_RE = /\b(sh|bash|zsh|ksh|dash|fish|python[0-9.]*|perl|ruby|node|php)\b/
const DOWNLOADER_RE = /\b(curl|wget|fetch)\b/

function bashConfirmEvasion(commandLower: string): boolean {
  // Pipe to an interpreter, allowing sudo/env wrappers and absolute paths.
  if (/\|\s*(sudo\s+|env\s+)*(\/\S+\/)?(sh|bash|zsh|ksh|dash|fish|python[0-9.]*|perl|ruby|node|php)\b/.test(commandLower)) {
    return true
  }
  // Downloader + interpreter present anywhere in the command — covers pipes,
  // process substitution `<(curl …)`, and command substitution `$(curl …)`.
  if (DOWNLOADER_RE.test(commandLower) && INTERPRETER_RE.test(commandLower)) return true
  // base64 decode feeding an interpreter.
  if (/\bbase64\s+(-d|--decode)\b/.test(commandLower) && INTERPRETER_RE.test(commandLower)) return true
  // Pipe to sudo (privilege escalation of piped data).
  if (/\|\s*sudo\b/.test(commandLower)) return true
  return false
}

/**
 * Minimal glob matcher supporting `*`, `?`, and `**`.
 *   * `**` matches across path separators (any chars incl. `/`).
 *   * `*` matches any chars except `/`.
 *   * `?` matches a single non-`/` char.
 * Anchored full-string match. Used for both path and tool-name rules.
 */
export function globMatch(pattern: string, value: string): boolean {
  let re = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === undefined) continue
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches zero or more leading directories (so `**/.env`
        // also matches a bare `.env`); a trailing `**` matches anything.
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (ch === '?') {
      re += '[^/]'
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  re += '$'
  try {
    return new RegExp(re).test(value)
  } catch {
    return false
  }
}

function bashMatch(pattern: string, commandLower: string): boolean {
  const pat = pattern.toLowerCase()
  const hasMeta = pat.includes('*') || pat.includes('?')
  if (!hasMeta) {
    return commandLower.includes(pat)
  }
  // Bash commands routinely contain slashes (paths, URLs), so `*` must cross
  // `/` here — unlike path globs. Build an unanchored regex: `*`→`.*`,
  // `?`→`.`, everything else literal. Match anywhere in the command.
  let re = ''
  for (const ch of pat) {
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  try {
    return new RegExp(re).test(commandLower)
  } catch {
    return false
  }
}

/**
 * Candidate path forms to test: the raw string, and the form resolved
 * against `/` so `../` and `./` collapse. Both are matched so a glob rule
 * ending in `.env` catches `../../app/.env` regardless of how Claude
 * phrased the path.
 */
function pathCandidates(raw: string): string[] {
  const out = [raw]
  try {
    // resolve() against a fixed root normalizes ../ without touching disk.
    const normalized = resolve('/__root__', raw)
    if (normalized !== raw) out.push(normalized)
  } catch {
    /* keep raw only */
  }
  return out
}

function matchPathRules(rules: readonly string[] | undefined, candidates: string[]): string | undefined {
  if (!rules) return undefined
  for (const rule of rules) {
    if (typeof rule !== 'string') continue
    for (const cand of candidates) {
      if (globMatch(rule, cand)) return rule
    }
  }
  return undefined
}

function matchToolRules(rules: readonly string[] | undefined, toolName: string): string | undefined {
  if (!rules) return undefined
  for (const rule of rules) {
    if (typeof rule === 'string' && globMatch(rule, toolName)) return rule
  }
  return undefined
}

function matchBashRules(rules: readonly string[] | undefined, commandLower: string): string | undefined {
  if (!rules) return undefined
  for (const rule of rules) {
    if (typeof rule === 'string' && bashMatch(rule, commandLower)) return rule
  }
  return undefined
}

/** Merge global + scope rules for one tier (scope rules are additive). */
function mergeRules(global: PolicyRules | undefined, scope: PolicyRules | undefined): PolicyRules {
  return {
    tools: [...(global?.tools ?? []), ...(scope?.tools ?? [])],
    read_paths: [...(global?.read_paths ?? []), ...(scope?.read_paths ?? [])],
    write_paths: [...(global?.write_paths ?? []), ...(scope?.write_paths ?? [])],
    bash_patterns: [...(global?.bash_patterns ?? []), ...(scope?.bash_patterns ?? [])],
  }
}

/**
 * Does `rules` match this tool call? Returns the matched rule string, or
 * undefined. Path rules apply to path tools; write_paths only to write tools;
 * bash_patterns only to Bash; tools to everything.
 */
function rulesMatch(
  rules: PolicyRules,
  toolName: string,
  pathCands: string[] | undefined,
  commandLower: string | undefined,
): string | undefined {
  const tool = matchToolRules(rules.tools, toolName)
  if (tool) return `tools:${tool}`

  if (pathCands) {
    if (READ_PATH_TOOLS.has(toolName) || WRITE_PATH_TOOLS.has(toolName)) {
      const rp = matchPathRules(rules.read_paths, pathCands)
      if (rp) return `read_paths:${rp}`
    }
    if (WRITE_PATH_TOOLS.has(toolName)) {
      const wp = matchPathRules(rules.write_paths, pathCands)
      if (wp) return `write_paths:${wp}`
    }
  }

  if (commandLower !== undefined) {
    const bp = matchBashRules(rules.bash_patterns, commandLower)
    if (bp) return `bash_patterns:${bp}`
  }
  return undefined
}

function extractPath(toolInput: Record<string, unknown>): string | undefined {
  const fp = toolInput.file_path ?? toolInput.notebook_path
  return typeof fp === 'string' && fp.length > 0 ? fp : undefined
}

type CommandExtract =
  | { readonly kind: 'not_bash' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'ok'; readonly command: string }

// A Bash call MUST carry a non-empty string command. Anything else
// (missing field, wrong type, empty string) is malformed and — under
// bypassPermissions where there is no native prompt — must fail CLOSED to
// deny, never silently fall through to default_tier allow (Codex high:
// the old code returned '' here and an empty command auto-allowed).
function extractCommand(toolName: string, toolInput: Record<string, unknown>): CommandExtract {
  if (toolName !== 'Bash') return { kind: 'not_bash' }
  const cmd = toolInput.command
  if (typeof cmd !== 'string' || cmd.trim().length === 0) return { kind: 'malformed' }
  return { kind: 'ok', command: cmd }
}

const MAX_COMMAND_LEN = 100_000

export interface ClassifyInput {
  readonly toolName: unknown
  readonly toolInput: unknown
  readonly policy: PermissionPolicy
  /** Scope id (e.g. "main" or a chat id). Looked up in policy.scopes. */
  readonly scope?: string
}

/**
 * Classify one tool call. Pure, fail-closed.
 *
 * Order (Codex Critical #3 fix — built-in confirm now beats operator allow,
 * matching the deny > confirm > allow precedence the operator policy itself
 * obeys; an operator allow can no longer wave through sudo / git push / pipe-
 * to-interpreter):
 *   1. Validate shape — malformed tool name or malformed Bash → deny.
 *   2. Built-in hard-deny (secret paths, secret-bash, catastrophic bash) —
 *      operator cannot relax.
 *   3. Operator deny (global ∪ scope).
 *   4. Built-in confirm bash (interpreter/exfil/destructive) — UNCONDITIONAL.
 *   5. Operator confirm.
 *   6. Operator allow.
 *   7. default_tier (read-only tools always allow).
 */
export function classifyToolCall(input: ClassifyInput): PermissionVerdict {
  const { toolName, toolInput, policy, scope } = input

  if (typeof toolName !== 'string' || toolName.length === 0) {
    return { tier: 'deny', reason: 'malformed tool call: missing tool_name', matchedRule: 'builtin:malformed' }
  }
  const ti: Record<string, unknown> =
    toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput)
      ? (toolInput as Record<string, unknown>)
      : {}

  const rawPath = extractPath(ti)
  const pathCands = rawPath !== undefined ? pathCandidates(rawPath) : undefined

  // A write tool with no usable file_path is malformed — we cannot policy-check
  // the target, so under bypassPermissions it must fail closed to deny rather
  // than fall through to default_tier allow (Codex high, mirrors malformed Bash).
  if (WRITE_PATH_TOOLS.has(toolName) && rawPath === undefined) {
    return { tier: 'deny', reason: `malformed ${toolName} call: missing file_path`, matchedRule: 'builtin:malformed_path' }
  }

  // Bash command extraction is fail-closed: a Bash call with a missing/empty
  // command is malformed and denies (never falls through to default allow).
  const cmdEx = extractCommand(toolName, ti)
  if (cmdEx.kind === 'malformed') {
    return { tier: 'deny', reason: 'malformed Bash call: missing or empty command', matchedRule: 'builtin:malformed_bash' }
  }
  const rawCommand = cmdEx.kind === 'ok' ? cmdEx.command : undefined
  if (rawCommand !== undefined && rawCommand.length > MAX_COMMAND_LEN) {
    return { tier: 'deny', reason: 'bash command exceeds size cap', matchedRule: 'builtin:command-too-long' }
  }
  const commandLower = rawCommand !== undefined ? rawCommand.toLowerCase() : undefined

  // 2. Built-in hard-deny — secret paths (read & write tools).
  if (pathCands && (READ_PATH_TOOLS.has(toolName) || WRITE_PATH_TOOLS.has(toolName))) {
    const hit = matchPathRules(BUILTIN_DENY_PATHS, pathCands)
    if (hit) {
      return { tier: 'deny', reason: `secret/credential path blocked: ${hit}`, matchedRule: `builtin:deny_path:${hit}` }
    }
  }
  // 2b. Built-in hard-deny — Bash. Catastrophic commands AND secret-path
  // references (cat .env, grep ~/.aws/credentials, …) both hard-deny.
  if (rawCommand !== undefined) {
    const catastrophic = builtinBashHardDeny(rawCommand)
    if (catastrophic) {
      return { tier: 'deny', reason: `catastrophic command blocked: ${catastrophic}`, matchedRule: `builtin:deny_bash:${catastrophic}` }
    }
    if (bashReferencesSecret(rawCommand)) {
      return { tier: 'deny', reason: 'secret/credential reference in Bash command blocked', matchedRule: 'builtin:deny_bash_secret' }
    }
  }

  const scopeCfg = scope && policy.scopes ? policy.scopes[scope] : undefined
  const denyRules = mergeRules(policy.deny, scopeCfg?.deny)
  const confirmRules = mergeRules(policy.confirm, scopeCfg?.confirm)
  const allowRules = mergeRules(policy.allow, scopeCfg?.allow)

  // 3. Operator deny.
  const denyHit = rulesMatch(denyRules, toolName, pathCands, commandLower)
  if (denyHit) {
    return { tier: 'deny', reason: `policy deny (${denyHit})`, matchedRule: `deny:${denyHit}` }
  }

  // 4. Built-in confirm bash — UNCONDITIONAL (no operator-allow short-circuit).
  // Substring list + spacing-tolerant interpreter/exfil evasion detection.
  if (commandLower !== undefined) {
    const hit = matchBashRules(BUILTIN_CONFIRM_BASH, commandLower)
    if (hit) {
      return { tier: 'confirm', reason: `risky command needs confirmation: ${hit}`, matchedRule: `builtin:confirm_bash:${hit}` }
    }
    if (bashConfirmEvasion(commandLower)) {
      return { tier: 'confirm', reason: 'pipe-to-interpreter download needs confirmation', matchedRule: 'builtin:confirm_bash:pipe-interpreter' }
    }
  }

  // 5. Operator confirm.
  const confirmHit = rulesMatch(confirmRules, toolName, pathCands, commandLower)
  if (confirmHit) {
    return { tier: 'confirm', reason: `policy confirm (${confirmHit})`, matchedRule: `confirm:${confirmHit}` }
  }

  // 6. Operator allow.
  const allowHit = rulesMatch(allowRules, toolName, pathCands, commandLower)
  if (allowHit) {
    return { tier: 'allow', reason: `policy allow (${allowHit})`, matchedRule: `allow:${allowHit}` }
  }

  // 7. Default. Read-only tools always auto-allow.
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { tier: 'allow', reason: 'read-only tool', matchedRule: 'builtin:read_only' }
  }
  const def: PermissionTier = policy.default_tier === 'allow' ? 'allow' : 'confirm'
  return {
    tier: def,
    reason: def === 'allow' ? 'default_tier allow' : 'default_tier confirm (unmatched mutating tool)',
    matchedRule: `default:${def}`,
  }
}
