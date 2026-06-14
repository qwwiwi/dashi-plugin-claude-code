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
    // Operator downgrade of SPECIFIC built-in confirm rules (owner autonomy
    // policy 2026-06-09: cards only for what cannot be automated, e.g. sudo).
    // Entries must name exact BUILTIN_CONFIRM_BASH rules — a typo fails
    // validation loudly instead of silently disabling nothing.
    confirm_overrides: z
      .object({
        builtin_rules: z
          .array(z.string())
          .superRefine((rules, ctx) => {
            for (const r of rules) {
              if (!BUILTIN_CONFIRM_BASH.includes(r)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `unknown built-in confirm rule: ${JSON.stringify(r)} (must be one of: ${BUILTIN_CONFIRM_BASH.join(', ')})`,
                })
              }
            }
          }),
      })
      .strict()
      .optional(),
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
  /**
   * Built-in confirm rules the operator explicitly downgrades to the normal
   * policy flow (confirm -> allow -> default). Deny tiers and the
   * pipe-to-interpreter evasion confirm are NEVER overridable. A compound
   * command matching an overridden AND a non-overridden built-in rule still
   * confirms.
   */
  readonly confirm_overrides?: { readonly builtin_rules?: readonly string[] }
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
// Git execution-surface evasion (Codex High, 2026-06-09): a downgraded
// `git push` must not become a code-exec primitive. `git -c core.sshCommand=`,
// `-c credential.helper=`, `-c core.hooksPath=`, `-c core.fsmonitor=`,
// `--config-env=`, `--upload-pack`/`--receive-pack`, and writes that install
// or repoint git hooks all run attacker-controlled local programs while the
// visible command is still just "git push". These ALWAYS confirm and can
// never appear in confirm_overrides (separate matcher, not in the built-in
// substring list).
// ANY `git -c <...>` (or its long form `--config`/`--config-env`) confirms:
// quoting and include.path indirection make per-key matching leaky, and the
// owner has accepted that only a clean `git push` auto-allows (Codex High
// round 3 — tokenizing the shell is overkill; confirm-on-any-`-c` is the
// minimal safe patch).
//
// `-c` is matched CASE-SENSITIVELY (lowercase only). git's `-C <dir>` (change
// working directory) is a completely safe, extremely common flag that differs
// from `-c <cfg>` (config injection) ONLY by case. The classifier lowercases
// the command for substring matching, which collapsed `-C`→`-c` and raised a
// confirm card on every `git -C …` — the single biggest false-positive in the
// gate (2026-06-10). So gitExecSurface takes the RAW command and the `-c`
// regex below has NO `/i` flag; `git` itself stays case-insensitive via the
// explicit char classes, and the long forms keep `/i` (they are lowercase).
const GIT_DASH_C_RE = /[Gg][Ii][Tt]\b[^\n]*?\s-c(\s|=|["'])/
const GIT_CONFIG_LONG_RE = /\bgit\b[^\n]*?--config(\s|=|-env)/i
const GIT_FLAG_RE =
  /\bgit\b[^\n]*?(--config-env|--upload-pack|--receive-pack|--exec)\b/i
const GIT_HOOKS_WRITE_RE = /(\.git\/hooks\/|core\.hookspath)/i
// Git config/exec indirection via environment variables — these reroute how
// git push authenticates or which local program it runs, so a downgraded
// push must still confirm when any is set (Codex High round 2).
const GIT_ENV_INDIRECTION_RE =
  /\b(git_ssh|git_ssh_command|git_askpass|ssh_askpass|git_proxy_command|git_external_diff|git_config_global|git_config_system|git_config_count|git_config_key_[0-9]+|git_config_value_[0-9]+)\s*=/i

/**
 * Quote-aware split on top-level `|`/`&`/`;`/newline. Unlike segmentBash
 * (which may over-segment inside quotes — fine for the catastrophic backstop),
 * the git-exec-surface check needs BOTH directions safe:
 *   - `git show X | grep -c "Y"` must split at the pipe (else grep's `-c` is
 *     blamed on git — live false positive, 2026-06-09);
 *   - `git --work-tree="a|b" -c evil push` must NOT split inside the quotes
 *     (else the `-c` lands in a git-less segment and the check is evaded).
 * Returns null on unbalanced quoting — caller falls back to the conservative
 * whole-string scan (fail-closed).
 */
export function segmentBashQuoteAware(command: string): string[] | null {
  const segs: string[] = []
  let cur = ''
  let quote: "'" | '"' | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (quote === "'") {
      cur += ch
      if (ch === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (ch === '\\') {
        cur += ch + (command[i + 1] ?? '')
        i++
        continue
      }
      cur += ch
      if (ch === '"') quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '\\') {
      cur += ch + (command[i + 1] ?? '')
      i++
      continue
    }
    if (ch === '|' || ch === '&' || ch === ';' || ch === '\n') {
      segs.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (quote !== null) return null
  segs.push(cur)
  return segs.map((s) => s.trim()).filter((s) => s.length > 0)
}

/** Any git config/exec flag in a segment. `-c` is case-sensitive (see RE); the
 *  long forms are case-insensitive. Operates on the RAW (case-preserved) text. */
function gitFlagPresent(s: string): boolean {
  return GIT_DASH_C_RE.test(s) || GIT_CONFIG_LONG_RE.test(s) || GIT_FLAG_RE.test(s)
}

function gitExecSurface(rawCommand: string): boolean {
  const lower = rawCommand.toLowerCase()
  // Hook-path writes and env indirection are segment-independent and
  // case-insensitive (GIT_SSH_COMMAND= etc. are uppercase env vars).
  if (GIT_HOOKS_WRITE_RE.test(lower) || GIT_ENV_INDIRECTION_RE.test(lower)) return true
  // Fast path: if no config/exec flag appears ANYWHERE, no segmentation can
  // create one (segments are substrings) — definitively safe. Match on the RAW
  // command so `-c` keeps its case (`git -C` change-dir must NOT trip here).
  if (!gitFlagPresent(rawCommand)) return false
  // A flag matched somewhere. We only narrow to per-segment scanning (to
  // suppress a pipeline neighbour's flag, e.g. `git show X | grep -c Y`) when
  // there is NO shell indirection. Indirection ($var, $(...), `...`, arrays,
  // wrapper functions) can route argv INTO git from another segment (Codex
  // Critical: `g(){ git "$@"; }; g -c core.sshCommand=evil fetch`), so we fall
  // back to the whole-command scan — at least as strict as the pre-segment
  // behaviour. (Residual, pre-existing in that behaviour too: a flag that
  // appears textually BEFORE git via a variable — `c='-c …'; git $c` — is not
  // caught here; closing that needs real argv resolution, out of scope.)
  if (/[$`]/.test(rawCommand)) {
    return gitFlagPresent(rawCommand)
  }
  const segs = segmentBashQuoteAware(rawCommand)
  if (segs === null) return true // unbalanced quotes → fail-closed
  // Indirection-free, balanced: the flag can only belong to git if a
  // git-bearing segment literally carries it.
  return segs.some((s) => /\bgit\b/i.test(s) && gitFlagPresent(s))
}

// ── systemctl: verb-aware confirm (live FPs 2026-06-10) ─────────────────
//
// The blanket `systemctl` substring rule fired on `systemctl cat <unit>`
// (read-only diagnostics) and even on `grep -rn "systemctl" src/` (the word
// as a search pattern) — both raised real confirm cards. Only MUTATING
// systemd operations need the owner's tap; reads and mere mentions must
// flow. Like gitExecSurface this check is non-overridable: a mutating
// systemctl (service stop/restart — including the agent's own comms
// channel) always reaches the owner.
//
// Per `systemctl` token occurrence we look at the first non-flag token that
// follows — systemd's subcommand position (flags that take a DETACHED value,
// `-H host` / `--root /mnt`, consume that value so it can't be mistaken for
// the verb — Fable review 2026-06-10: `systemctl -H root@host restart x`
// must not slip through as a "mention"):
//   * read-only verb (status/cat/show/list-*/is-*…) → safe;
//   * `$`/backtick verb (variable indirection)       → confirm (fail-safe);
//   * any other verb-shaped word — mutating OR unknown → confirm (fail-safe
//     for future/unknown verbs);
//   * not verb-shaped (a path, a number, a pattern tail) → if flags were
//     skipped to get here this is invocation-shaped, confirm; otherwise a
//     textual mention (`grep -rn "systemctl" src/`), safe. A real invocation
//     needs a verb to mutate anything (`systemctl` alone just lists units).
// Occurrences are OR'ed — a read-only hit cannot mask a mutating sibling.
//
// Separator-aware (live FP round 2, 2026-06-10): a systemd verb is
// WHITESPACE-separated from `systemctl`. `grep -nE 'a|systemctl|launchctl' f`
// glued `launchctl` to `systemctl` with a `|` inside the quoted regex and the
// old whitespace+`|`+quote tokenizer read it as the verb → false card. We now
// require the char immediately after `systemctl` to be whitespace before
// parsing a verb; a glued `|`/quote/`.` marks pattern data, not argv. This
// keeps the genuine cases (`ssh host 'systemctl restart w'` — quote BEFORE
// systemctl, space AFTER → still confirms; detached value flags intact).
//
// Accepted residuals under the agent-mistake threat model (mirrors the
// gitExecSurface note): a verb arriving through a pipe
// (`echo "restart foo" | xargs systemctl`) is not resolved here; a
// flagless non-verb-shaped first argument (`systemctl ./restart`) reads as
// a mention — systemd itself rejects such argv, so nothing mutates; and a
// QUOTED command NAME (`'systemctl' restart w`) is indistinguishable, by
// local context alone, from a quoted search pattern (`grep 'systemctl' src/`)
// — catching the former would re-introduce the exact mention false positive
// this fix exists to kill. An agent never quotes its own command name, so we
// accept this over a flood of `grep 'systemctl'` cards (Codex Critical #1,
// consciously declined 2026-06-10 — the threat model is agent mistakes, not a
// shell-quoting adversary).
//
// MIGRATION (2026-06-10): the literal 'systemctl' entry left
// BUILTIN_CONFIRM_BASH, so a confirm_overrides list naming it now fails
// schema validation — delete that override; the verb-aware rule is
// non-overridable by design (like gitExecSurface).
const SYSTEMCTL_READONLY_VERBS = new Set([
  'status', 'cat', 'show', 'help',
  'is-active', 'is-enabled', 'is-failed', 'is-system-running',
  'list-units', 'list-unit-files', 'list-dependencies', 'list-timers',
  'list-sockets', 'list-jobs', 'list-machines', 'list-paths', 'list-automounts',
  'get-default', 'show-environment',
])
// Flags whose value is a SEPARATE token. Lowercased command collapses
// `-H` (--host) into `-h` (help) — treating `-h` as value-taking is safe in
// both readings (bare `systemctl -h` just ends with no verb → allow).
const SYSTEMCTL_VALUE_FLAGS = new Set([
  '-h', '-m', '-p', '-t', '-n', '-o', '-s',
  '--host', '--machine', '--root', '--property', '--type', '--lines',
  '--output', '--signal', '--kill-who', '--state', '--job-mode',
])
const SYSTEMCTL_FLAG_RE = /^--?[a-z0-9-]+(=.*)?$/
const SYSTEMCTL_VERB_LEAD_RE = /^[a-z][a-z-]*/
// Command-position occurrences of `systemctl` (optionally path-qualified like
// `/usr/bin/systemctl`), bounded by a shell separator / quote / start so a
// verb glued by `|` inside a regex alternation isn't read as argv. The
// trailing context (separator vs whitespace vs end) is inspected by the caller.
// NOTE the leading boundary deliberately excludes `=`: `FOO=systemctl restart`
// is a shell assignment of FOO followed by `restart`, not a systemctl call
// (Codex review 2026-06-10). `env FOO=x systemctl restart` still resolves via
// the space before `systemctl`. `=` stays in the TRAILING lookahead only as a
// generic separator.
const SYSTEMCTL_OCCURRENCE_RE =
  /(?:^|[\s"'`;|&()<>\\])(?:[^\s"'`;|&()<>=\\]*\/)?systemctl(?=[\s"'`;|&()<>=\\]|$)/g

function systemctlMutation(commandLower: string): boolean {
  if (!commandLower.includes('systemctl')) return false
  // Fold backslash line-continuations so `systemctl \<nl> restart` is one call.
  const cmd = commandLower.replace(/\\\r?\n/g, ' ')
  SYSTEMCTL_OCCURRENCE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SYSTEMCTL_OCCURRENCE_RE.exec(cmd)) !== null) {
    const after = cmd.slice(m.index + m[0].length)
    // A systemd verb is whitespace-separated from `systemctl`. End-of-string
    // (bare `systemctl`, lists units) or a glued non-space char (a `|` from a
    // regex alternation, a closing quote from `grep 'systemctl'`) means this
    // occurrence is read-only / a mention — not an invocation. Skip it.
    if (!/^\s/.test(after)) continue
    const tokens = after.trim().split(/\s+/).filter((t) => t.length > 0)
    let k = 0
    let sawFlag = false
    while (k < tokens.length) {
      const tok = tokens[k] as string
      if (SYSTEMCTL_VALUE_FLAGS.has(tok)) { sawFlag = true; k += 2; continue }
      if (SYSTEMCTL_FLAG_RE.test(tok)) { sawFlag = true; k++; continue }
      break
    }
    const vtok = tokens[k]
    if (vtok === undefined) continue // only flags, no verb (e.g. `-h`) — read-only
    // Strip surrounding quotes (`systemctl 'restart' x`) BEFORE the `$`
    // check, else `systemctl "$verb" unit` strips to `$verb` only after the
    // check and slips through as a mention (Codex review 2026-06-10).
    const normalizedVerb = vtok.replace(/^['"]+|['"]+$/g, '')
    if (normalizedVerb.startsWith('$')) return true // variable verb — cannot prove safe
    const verbMatch = normalizedVerb.match(SYSTEMCTL_VERB_LEAD_RE)
    if (verbMatch === null) {
      // Not verb-shaped (path `./restart`, number). Flags before it prove an
      // invocation → fail safe; otherwise a mention.
      if (sawFlag) return true
      continue
    }
    if (SYSTEMCTL_READONLY_VERBS.has(verbMatch[0])) continue
    return true // mutating OR unknown verb — fail safe to confirm
  }
  return false
}

// ── own comms channel — the ONE systemctl mutation that stays a hard brake ──
//
// Warchief 2026-06-14: zero confirm cards (he drives the session via send-keys),
// so a mutating systemctl on a NORMAL service runs silently. The single
// exception is the agent's OWN comms channel: stopping/restarting it severs the
// warchief's Telegram link to the agent mid-task. That is irreversible-in-the-
// moment, so it stays a HARD-DENY (it never showed a card anyway — it's a brake,
// not a prompt). Matches the channel systemd units and the gateway daemon by
// name, anywhere in a mutating systemctl invocation. The bare `gateway`
// alternative covers systemd shorthand (`systemctl stop gateway` ≡
// `gateway.service`) and instance units (`gateway@0.service`); the trailing
// `(?![a-z0-9_])` boundary keeps it from over-matching a different daemon whose
// name merely starts with "gateway" (e.g. `gatewayd`) — Codex review HIGH.
// `[a-z0-9_]+-gateway` (no `-` inside the prefix class) keeps the alternative
// linear — `[a-z0-9_-]*-gateway` is O(n²) on a long hyphen run (Opus review LOW).
const OWN_CHANNEL_UNIT_RE =
  /(?:channel-[a-z0-9_-]+|[a-z0-9_]+-gateway|gateway(?:@[a-z0-9_.:-]+)?(?:\.(?:service|py))?)(?![a-z0-9_-])/i

function mutatesOwnChannel(commandLower: string): boolean {
  return systemctlMutation(commandLower) && OWN_CHANNEL_UNIT_RE.test(commandLower)
}

// ── pipe-to-interpreter: STRUCTURAL network-source → exec detection ──────
//
// The RCE primitive we card is UNTRUSTED (network/decode) bytes reaching an
// interpreter as CODE — NOT mere token co-presence of a downloader and an
// interpreter name (2026-06-10 round 2: the old `DOWNLOADER && INTERPRETER`
// rule fired on grep PATTERNS (`grep "curl.*sh"`), heredoc/file CONTENT,
// two-step download-then-parse, `curl … | grep node`, and downloads fed to a
// fixed inline script — all benign ops work, Codex + Fable double audit).
//
// Detection runs on a quote/heredoc-masked, escape-aware copy of the command
// (a small shell-shaped scanner, NOT a full lexer), split into pipeline stages:
//   (R1) a NETWORK/decode source stage feeding an EXECUTOR in a LATER stage —
//        an interpreter HEAD (`curl … | sh`, `wget … | jq | bash`) or a
//        `>(sh)` / `<(sh)` process-substitution sink (`curl … | tee >(bash)`).
//        Exempt non-shell DATA sinks (`python3 -c '<literal>'`, `node -e …`):
//        downloaded stdin is then mere data, as trusted as
//        `python3 script.py < downloaded.json` — unless the inline literal
//        itself reads AND executes stdin (anti-bypass).
//   (R2) a substitution carrying a network source in CODE position inside an
//        exec sink: `eval/source/.` + any `$(curl)`/`<(curl)`/backtick;
//        a shell interpreter + any network substitution (`sh -c "$(curl)"`,
//        `bash <<<"$(curl)"`, `bash <(curl)`); a non-shell interpreter whose
//        SCRIPT argument is a network process-substitution (`python3 <(curl)`).
//        A network `$(curl)` passed as plain DATA argv to `python3 -c '<lit>'`
//        does NOT card.
//   (R3) `base64 -d` is folded into the source set (decoded bytes → interp).
//   (R4) any pipe to sudo (privilege escalation of piped data).
//
// Accepted residuals under the agent-mistake / prompt-injection threat model
// (NOT an adversarial operator hand-crafting bash — env -i isolation and the
// fail-closed default tier backstop that): `ssh host 'cmd' | bash` flows (ssh
// omitted from the source set); two-step download-then-exec (`curl -o x; sh x`);
// unquoted-heredoc bodies; a download-exec hidden as the CONTENT of a quoted
// literal (`echo "curl x | sh" | bash`); OBFUSCATED stdin-exec that dodges the
// marker set (`getattr(builtins,'ex'+'ec')(sys.stdin.read())`) — the identical
// hole exists for a plain local `python3 -c '<obfuscated>'`, which is allowed
// anyway, so the curl-fed variant adds no new exposure; exotic wrapper chains
// (`sudo -u u -g g …`) beyond the common sudo/env flag set.

const NET_SOURCE_RE = /\b(?:curl|wget|nc|ncat|socat)\b|\/dev\/tcp|\bbase64\s+(?:-d|--decode)\b/i
const INTERP_NAMES = 'sh|bash|zsh|ksh|dash|fish|python[0-9.]*|perl|ruby|node|php'
const INTERP_HEAD_RE = new RegExp(`^(?:${INTERP_NAMES})$`, 'i')
const EVAL_SOURCE_RE = /^(?:eval|source|\.)$/i
const EXEC_SINK_HEAD_RE = new RegExp(`^(?:${INTERP_NAMES}|eval|source|\\.)$`, 'i')
/** Network/decode source present in a substitution's inner text — its own
 *  quoted literals masked first, so `$(printf 'echo curl')` is NOT a source. */
function innerHasNetSource(inner: string): boolean {
  return NET_SOURCE_RE.test(maskQuotedLiterals(inner) ?? inner)
}

/** Length-preserving mask: quoted-delimiter heredoc BODIES become blanks (pure
 *  literal data — `<<'EOF' … EOF`). Newlines preserved so offsets stay aligned
 *  with the raw command. Unquoted heredocs are left intact (expansion applies;
 *  out of scope). */
function maskHeredocBodies(raw: string): string {
  return raw.replace(
    /(<<-?\s*)(['"])([\w.-]+)\2([^\n]*\n)([\s\S]*?\n)([ \t]*)(\3)(?=\s|$)/g,
    (_full, op, q, delim, openTail, body, indent, close) =>
      `${op}${q}${delim}${q}${openTail}${body.replace(/[^\n]/g, ' ')}${indent}${close}`,
  )
}

/** Index just past a balanced `$(…)`/`<(…)`/`>(…)` (when `s[i]` opens one) or a
 *  backtick run — quote- and escape-aware so a `)` inside a nested quote does
 *  not close the substitution early. If `s[i]` opens nothing, returns i+1. */
function skipSubstitution(s: string, i: number): number {
  const two = s.slice(i, i + 2)
  if (two === '$(' || two === '<(' || two === '>(') {
    let depth = 1
    let k = i + 2
    while (k < s.length && depth > 0) {
      const c = s[k]
      if (c === '\\') {
        k += 2
        continue
      }
      if (c === "'") {
        k++
        while (k < s.length && s[k] !== "'") k++
        k++
        continue
      }
      if (c === '"') {
        k++
        while (k < s.length && s[k] !== '"') k += s[k] === '\\' ? 2 : 1
        k++
        continue
      }
      if (c === '`') {
        k++
        while (k < s.length && s[k] !== '`') k++
        k++
        continue
      }
      if (c === '(') depth++
      else if (c === ')') depth--
      k++
    }
    return k
  }
  if (s[i] === '`') {
    let k = i + 1
    while (k < s.length && s[k] !== '`') k++
    return k + 1
  }
  return i + 1
}

/** Length-preserving mask of single/double-quoted literals → blanks, so a
 *  downloader/interpreter token that only appears inside a quoted string (a
 *  grep pattern, a here-string, file content) is NOT seen by the detector.
 *  Live `$(…)` and backtick substitutions inside double quotes are PRESERVED
 *  (the shell executes them — `sh -c "$(curl …)"` must stay visible to R2).
 *  Returns null on unbalanced quotes (caller falls back to the raw command). */
function maskQuotedLiterals(s: string): string | null {
  const out = s.split('')
  const n = s.length
  let i = 0
  while (i < n) {
    const ch = s[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === "'") {
      let j = i + 1
      while (j < n && s[j] !== "'") {
        out[j] = ' '
        j++
      }
      if (j >= n) return null
      i = j + 1
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < n && s[j] !== '"') {
        if (s[j] === '\\') {
          out[j] = ' '
          if (j + 1 < n) out[j + 1] = ' '
          j += 2
          continue
        }
        if (s[j] === '$' && s[j + 1] === '(') {
          j = skipSubstitution(s, j) // preserve the live substitution verbatim
          continue
        }
        if (s[j] === '`') {
          j = skipSubstitution(s, j)
          continue
        }
        out[j] = ' '
        j++
      }
      if (j >= n) return null
      i = j + 1
      continue
    }
    i++
  }
  return out.join('')
}

interface BashStage {
  raw: string
  masked: string
}

/** Quote-aware split of a masked command into pipelines (list elements broken
 *  on `;`/`&&`/`||`/`&`/newline) and stages within each pipeline (broken on a
 *  single `|`/`|&`). Separators inside `$(…)`/`(…)`/backticks or behind a
 *  backslash are NOT split on. Raw slices are taken at the same offsets (the
 *  mask is length-preserving). */
function splitPipelines(raw: string, masked: string): BashStage[][] {
  const pipelines: BashStage[][] = []
  let pipe: BashStage[] = []
  let stageStart = 0
  let depth = 0
  const n = masked.length
  const endStage = (end: number): void => {
    const m = masked.slice(stageStart, end)
    if (m.trim().length > 0) pipe.push({ raw: raw.slice(stageStart, end), masked: m })
  }
  const endPipe = (end: number): void => {
    endStage(end)
    if (pipe.length > 0) pipelines.push(pipe)
    pipe = []
  }
  let i = 0
  while (i < n) {
    const c = masked[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '`' || ((c === '$' || c === '<' || c === '>') && masked[i + 1] === '(')) {
      i = skipSubstitution(masked, i)
      continue
    }
    if (c === '(') {
      depth++
      i++
      continue
    }
    if (c === ')' && depth > 0) {
      depth--
      i++
      continue
    }
    if (depth > 0) {
      i++
      continue
    }
    if (c === '\n' || c === ';') {
      endPipe(i)
      stageStart = i + 1
      i++
      continue
    }
    if (c === '&') {
      // fd redirections (`2>&1`, `>&2`, `<&0`, `&>file`) are NOT separators.
      if (masked[i - 1] === '>' || masked[i - 1] === '<' || masked[i + 1] === '>') {
        i++
        continue
      }
      // `&&` boundary or a bare background `&` — both end the pipeline.
      endPipe(i)
      stageStart = masked[i + 1] === '&' ? i + 2 : i + 1
      i = stageStart
      continue
    }
    if (c === '|') {
      if (masked[i + 1] === '|') {
        endPipe(i)
        stageStart = i + 2
        i += 2
        continue
      }
      endStage(i)
      stageStart = masked[i + 1] === '&' ? i + 2 : i + 1
      i = stageStart
      continue
    }
    i++
  }
  endPipe(n)
  return pipelines
}

interface BashWord {
  masked: string
  raw: string
}

const ASSIGN_RE = /^[A-Za-z_]\w*=/
// Operands that name stdin as the program source — the downloaded bytes that
// reach fd 0 become the program (`bash /dev/stdin`, `python3 -`).
const STDIN_DEVICE_RE = /^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/

/** Remove shell quoting (surrounding/embedded quotes and quoting backslashes)
 *  from a single command word so `'bash'`, `"bash"`, `b'a'sh`, `\bash` all read
 *  as `bash`. Substitutions are left intact. */
function dequoteWord(word: string): string {
  let out = ''
  for (let i = 0; i < word.length; i += 1) {
    const c = word.charAt(i)
    if (c === '\\') {
      out += word.charAt(i + 1)
      i += 1
      continue
    }
    if (c === "'" || c === '"') continue
    out += c
  }
  return out
}

/** Split a stage into whitespace-separated WORDS, treating quoted runs and
 *  `$()`/`<()`/`>()`/backtick substitutions as atomic (embedded whitespace does
 *  not break a word). Operates on the masked text; each word's raw slice is
 *  taken at the same offsets (the mask is length-preserving). */
function tokenizeStage(st: BashStage): BashWord[] {
  const toks: BashWord[] = []
  const m = st.masked
  const n = m.length
  let i = 0
  while (i < n) {
    while (i < n && /\s/.test(m.charAt(i))) i += 1
    if (i >= n) break
    const start = i
    while (i < n && !/\s/.test(m.charAt(i))) {
      const c = m.charAt(i)
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === "'") {
        i += 1
        while (i < n && m.charAt(i) !== "'") i += 1
        i += 1
        continue
      }
      if (c === '"') {
        i += 1
        while (i < n && m.charAt(i) !== '"') i += m.charAt(i) === '\\' ? 2 : 1
        i += 1
        continue
      }
      if (c === '`' || ((c === '$' || c === '<' || c === '>') && m.charAt(i + 1) === '(')) {
        i = skipSubstitution(m, i)
        continue
      }
      i += 1
    }
    toks.push({ masked: m.slice(start, i), raw: st.raw.slice(start, i) })
  }
  return toks
}

// Wrappers that take a leading positional value (a duration/interval) before
// the wrapped command — must skip it to reach the real interpreter head.
const DURATION_WRAPPERS = new Set(['timeout', 'watch'])
// Wrapper option flags that consume a SEPARATE value word (`nice -n 10`,
// `timeout -s TERM`, `ionice -c 3`, `stdbuf -o L`, `doas -u root`) — skip the
// value too so the interpreter head is not read as `10`/`TERM`/`root`.
const WRAPPER_VALUE_FLAG_RE = /^-(?:n|s|k|c|i|o|e|u|g|p|R)$/

/** A stage's words plus the index of the command head, after skipping `VAR=val`
 *  assignments and command wrappers (`sudo`/`env`/`nohup`/`command`/`exec`/
 *  `timeout`/… — the same set the catastrophe path strips, so a wrapped
 *  interpreter like `timeout 30 bash` / `exec bash` / `command bash` is exposed)
 *  with their flags/values. Exotic wrapper combos are an accepted residual. */
function stageWords(st: BashStage): { toks: BashWord[]; headIdx: number } {
  const toks = tokenizeStage(st)
  let k = 0
  while (k < toks.length && ASSIGN_RE.test((toks[k] as BashWord).masked)) k += 1
  for (let guard = 0; guard < 8 && k < toks.length; guard += 1) {
    const name = dequoteWord((toks[k] as BashWord).raw).replace(/^.*\//, '').toLowerCase()
    if (name === 'sudo') {
      k += 1
      while (k < toks.length && /^-/.test((toks[k] as BashWord).masked)) {
        const takesValue = /^(?:-[ug]|--user|--group)$/.test((toks[k] as BashWord).masked)
        k += 1
        if (takesValue && k < toks.length) k += 1
      }
      continue
    }
    if (name === 'env') {
      k += 1
      while (k < toks.length && (/^-/.test((toks[k] as BashWord).masked) || ASSIGN_RE.test((toks[k] as BashWord).masked))) {
        const takesValue = /^-u$/.test((toks[k] as BashWord).masked)
        k += 1
        if (takesValue && k < toks.length) k += 1
      }
      continue
    }
    if (DURATION_WRAPPERS.has(name)) {
      k += 1
      while (k < toks.length && /^-/.test((toks[k] as BashWord).masked)) {
        const takesValue = WRAPPER_VALUE_FLAG_RE.test((toks[k] as BashWord).masked)
        k += 1
        if (takesValue && k < toks.length) k += 1
      }
      if (k < toks.length && /^[0-9.]+[smhd]?$/i.test(dequoteWord((toks[k] as BashWord).raw))) k += 1
      continue
    }
    if (COMMAND_WRAPPERS.has(name)) {
      k += 1
      while (k < toks.length && (/^-/.test((toks[k] as BashWord).masked) || ASSIGN_RE.test((toks[k] as BashWord).masked))) {
        const takesValue = WRAPPER_VALUE_FLAG_RE.test((toks[k] as BashWord).masked)
        k += 1
        if (takesValue && k < toks.length) k += 1
      }
      continue
    }
    break
  }
  return { toks, headIdx: k }
}

/** The command word at the head of a stage (wrappers stripped, dequoted, path
 *  removed — `'bash'`/`/bin/bash` → `bash`). `''` if there is no command word. */
function stageHead(st: BashStage): string {
  const { toks, headIdx } = stageWords(st)
  if (headIdx >= toks.length) return ''
  return dequoteWord((toks[headIdx] as BashWord).raw).replace(/^.*\//, '')
}

/** Substitutions (`$()`/`<()`/`>()`/backtick) in a masked string, paired with
 *  their RAW inner text (offsets align — the mask is length-preserving). */
function stageSubstitutions(masked: string, raw: string): { kind: string; rawInner: string }[] {
  const subs: { kind: string; rawInner: string }[] = []
  let i = 0
  const n = masked.length
  while (i < n) {
    if (masked[i] === '\\') {
      i += 2
      continue
    }
    const isParenSub = (masked[i] === '$' || masked[i] === '<' || masked[i] === '>') && masked[i + 1] === '('
    if (isParenSub || masked[i] === '`') {
      const end = skipSubstitution(masked, i)
      const kind = masked[i] === '`' ? '`' : masked.slice(i, i + 2)
      const innerStart = kind === '`' ? i + 1 : i + 2
      subs.push({ kind, rawInner: raw.slice(innerStart, end - 1) })
      i = end
      continue
    }
    i++
  }
  return subs
}

/** Does a word begin (after an optional opening quote) with a NETWORK
 *  substitution — `"$(curl)"`, `<(curl)`, `` `curl` ``? */
function wordOpensNetSub(word: BashWord): boolean {
  let p = 0
  if (word.masked.charAt(p) === '"' || word.masked.charAt(p) === "'") p += 1
  const opens = ((word.masked.charAt(p) === '$' || word.masked.charAt(p) === '<') && word.masked.charAt(p + 1) === '(') || word.masked.charAt(p) === '`'
  if (!opens) return false
  const end = skipSubstitution(word.masked, p)
  const innerStart = word.masked.charAt(p) === '`' ? p + 1 : p + 2
  return innerHasNetSource(word.raw.slice(innerStart, end - 1))
}

/** Per-interpreter flag spec (`null` if the head is not a known interpreter).
 *  `inlineShort`/`inlineLong` introduce inline program code; `valueShort`/
 *  `valueLong` consume the next word as an option value (NOT the program — so a
 *  following path is not mistaken for a script); `moduleShort` names a flag that
 *  itself supplies a local program (`python -m mod`). Keeps `node -r`(require) /
 *  `python -E`(env) / `perl -I`(incdir) from being read as inline code. */
interface InterpSpec {
  inlineShort: string
  inlineLong: string[]
  valueShort: string
  valueLong: string[]
  moduleShort: string
  isShell: boolean
}
function interpreterSpec(head: string): InterpSpec | null {
  const h = head.toLowerCase()
  if (/^(?:sh|bash|zsh|ksh|dash|fish)$/.test(h)) {
    return { inlineShort: 'c', inlineLong: [], valueShort: 'o', valueLong: ['rcfile', 'init-file'], moduleShort: '', isShell: true }
  }
  if (/^python[0-9.]*$/.test(h)) {
    return { inlineShort: 'c', inlineLong: [], valueShort: 'WXQ', valueLong: [], moduleShort: 'm', isShell: false }
  }
  if (h === 'perl') return { inlineShort: 'eE', inlineLong: [], valueShort: 'ImM', valueLong: [], moduleShort: '', isShell: false }
  if (h === 'ruby') return { inlineShort: 'e', inlineLong: [], valueShort: 'Ir', valueLong: ['require'], moduleShort: '', isShell: false }
  if (h === 'node') return { inlineShort: 'ep', inlineLong: ['eval', 'print'], valueShort: 'r', valueLong: ['require'], moduleShort: '', isShell: false }
  if (h === 'php') return { inlineShort: 'r', inlineLong: [], valueShort: 'd', valueLong: [], moduleShort: '', isShell: false }
  return null
}

/** The argument carried by an inline-code flag at operand `k`, given the
 *  interpreter `spec` — the attached remainder (`-c"$(x)"`, `--eval=…`, bundled
 *  `-xc…`) or the next word — when operand `k` IS such a flag; otherwise null. */
function inlineCodeArg(operands: BashWord[], k: number, spec: InterpSpec): BashWord | null {
  const w = operands[k] as BashWord
  const long = w.masked.match(/^--([A-Za-z][\w-]*)(=?)(.*)$/s)
  if (long) {
    if (!spec.inlineLong.includes((long[1] as string).toLowerCase())) return null
    const rest = long[3] as string
    if ((long[2] as string).length > 0 || rest.length > 0) {
      return { masked: rest, raw: w.raw.slice(w.masked.length - rest.length) }
    }
    return operands[k + 1] ?? null
  }
  const cluster = w.masked.match(/^-([A-Za-z]+)(.*)$/)
  if (!cluster) return null
  const letters = cluster[1] as string
  if (![...letters].some((ch) => spec.inlineShort.includes(ch))) return null
  const rest = cluster[2] as string
  if (rest.length > 0) {
    return { masked: rest, raw: w.raw.slice(w.masked.length - rest.length) }
  }
  return operands[k + 1] ?? null
}

/** Does the stage carry an inline-code flag (program supplied inline)? */
function hasInlineFlag(operands: BashWord[], spec: InterpSpec): boolean {
  return operands.some((_w, k) => inlineCodeArg(operands, k, spec) !== null)
}

/** Is ANY inline-code argument a NETWORK substitution? `python3 -c "$(curl)"`,
 *  `node -pe "$(curl)"`, `bash -o pipefail -c "$(curl)"` run the download AS
 *  code → card. A net sub passed as later argv (`python3 -c "<lit>" "$(curl)"`)
 *  is data → no match. Scans ALL operands (an option value before the real flag
 *  must not stop the search) and checks EACH inline flag's argument. */
function inlineCodeArgIsNet(operands: BashWord[], spec: InterpSpec): boolean {
  for (let k = 0; k < operands.length; k += 1) {
    const arg = inlineCodeArg(operands, k, spec)
    if (arg !== null && wordOpensNetSub(arg)) return true
  }
  return false
}

/** When an interpreter has NO inline-code flag, its PROGRAM comes from the first
 *  script operand or from stdin. Returns true when that program is network-
 *  sourced: a `<(net)` script-position operand (`bash <(curl)`), or stdin fed by
 *  a net here-string / input redirection when the program is read from stdin
 *  (`bash <<<"$(curl)"`, `bash < <(curl)`, `bash /dev/stdin < <(curl)`). A local
 *  script operand (`python3 app.py …`) means the program is local → false. */
function interpreterProgramFromNet(operands: BashWord[]): boolean {
  let stdinIsNet = false
  for (let k = 0; k < operands.length; k += 1) {
    const w = operands[k] as BashWord
    const m = w.masked
    // A process substitution in operand position is the script file.
    if (m.startsWith('<(')) return wordOpensNetSub(w)
    if (m.startsWith('>(')) continue
    // A redirection operator (attached target, or target in the next word).
    const rm = m.match(/^([0-9]*(?:<<<|<<|<|>>|>|&>|<&|>&))(.*)$/)
    if (rm) {
      const op = rm[1] as string
      const rest = rm[2] as string
      const isStdin = op === '<' || op === '<<<' || op === '0<'
      let target: BashWord | undefined
      if (rest.length > 0) {
        target = { masked: rest, raw: w.raw.slice(m.length - rest.length) }
      } else {
        target = operands[k + 1]
        if (target !== undefined) k += 1
      }
      if (isStdin && target !== undefined && wordOpensNetSub(target)) stdinIsNet = true
      continue
    }
    if (/^-/.test(m)) continue // a flag (non-inline — those are handled by the caller)
    // A stdin-device operand keeps the program on fd 0 (scan on for its source);
    // any other operand is a local script path → program is local.
    if (STDIN_DEVICE_RE.test(dequoteWord(w.raw))) continue
    return false
  }
  return stdinIsNet
}

/** Where does an interpreter stage read its PROGRAM from? `inline` (a `-c`/`-e`/…
 *  argument), `localscript` (a local file operand or `python -m mod`), or `stdin`
 *  (bare interpreter, a stdin-device operand, or `-`). Spec-aware so option
 *  VALUES (`node -r mod`, `python -W ignore`) are not mistaken for the script. */
function interpreterProgramKind(st: BashStage): 'inline' | 'localscript' | 'stdin' {
  const { toks, headIdx } = stageWords(st)
  if (headIdx >= toks.length) return 'stdin'
  const head = dequoteWord((toks[headIdx] as BashWord).raw).replace(/^.*\//, '')
  const spec = interpreterSpec(head)
  const operands = toks.slice(headIdx + 1)
  if (spec && hasInlineFlag(operands, spec)) return 'inline'
  for (let k = 0; k < operands.length; k += 1) {
    const w = operands[k] as BashWord
    const m = w.masked
    if (m.startsWith('<(') || m.startsWith('>(')) return 'localscript'
    const rm = m.match(/^([0-9]*(?:<<<|<<|<|>>|>|&>|<&|>&))(.*)$/)
    if (rm) {
      if ((rm[2] as string).length === 0) k += 1 // separate-word redirect target
      continue
    }
    const long = m.match(/^--([A-Za-z][\w-]*)(=?)/)
    if (long) {
      if (spec && spec.valueLong.includes((long[1] as string).toLowerCase()) && (long[2] as string).length === 0) k += 1
      continue
    }
    if (/^-/.test(m)) {
      const cm = m.match(/^-([A-Za-z]+)(.*)$/)
      if (cm && spec) {
        const letters = cm[1] as string
        if ([...letters].some((c) => spec.moduleShort.includes(c))) return 'localscript' // `-m mod` = local program
        const last = letters.charAt(letters.length - 1)
        if (spec.valueShort.includes(last) && (cm[2] as string).length === 0) k += 1 // value is the next word
      }
      continue
    }
    return STDIN_DEVICE_RE.test(dequoteWord(w.raw)) ? 'stdin' : 'localscript'
  }
  return 'stdin'
}

// An exec/eval marker applied DIRECTLY to stdin within the same call — the
// canonical `python3 -c "exec(sys.stdin.read())"`, `os.system(open(0).read())`,
// `node -e "eval(readFileSync(0))"`, `pickle.loads(sys.stdin…)`, `exec(input())`.
// The marker must PRECEDE the stdin reference within a short window so a benign
// JSON parse that merely references a key named `"system"` does not trip it.
const STDIN_REF_ALT =
  '(?:sys\\.stdin|process\\.stdin|\\bstdin\\b|\\binput\\s*\\(|\\bread(?:File)?(?:Sync)?\\s*\\(\\s*0|\\bopen\\s*\\(\\s*0|\\bfdopen\\s*\\(\\s*0|\\bos\\.read\\s*\\(\\s*0|/dev/stdin|<&?\\s*0\\b)'
const STDIN_EXEC_CI_RE = new RegExp(
  `\\b(?:eval|exec\\w*|execfile|system|popen|spawn\\w*|compile|__import__|importlib|runpy|pickle|marshal|runInThisContext|child_process)\\b[\\s\\S]{0,80}?${STDIN_REF_ALT}`,
  'i',
)
// The JS `Function` CONSTRUCTOR — case-SENSITIVE so the ordinary `function`
// keyword (`function p(x){…}`) is NOT read as a stdin-exec sink.
const STDIN_EXEC_FUNCTION_RE = new RegExp(`\\bFunction\\s*\\([\\s\\S]{0,80}?${STDIN_REF_ALT}`)
// Shell-level stdin execution inside a `-c` literal: `source`/`.` of a stdin
// device, or a nested interpreter reading its program from stdin
// (`bash /dev/stdin`, `sh -s`, `python3 -`). These run piped network bytes as
// code without any of the function-call markers above.
const STDIN_EXEC_SHELL_RE =
  /(?:\bsource\b|(?:^|[;|&(]|\b(?:then|do|else|elif)\s)\s*\.)\s+[^\n;|&]{0,40}(?:\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0|<&?\s*0\b)|\b(?:sh|bash|zsh|ksh|dash|fish|python[0-9.]*|perl|ruby|node|php)\s+(?:[^\n;|&]{0,30}\s)?(?:-s\b|-\s|-$|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)/i

/** Strip a single outer matching quote pair (the shell quoting of an inline-code
 *  argument), PRESERVING inner quotes so a printed string literal stays quoted
 *  (`'printf "%s" "curl|sh"'` → `printf "%s" "curl|sh"`, not bare code). */
function stripOuterQuotes(s: string): string {
  if (s.length >= 2) {
    const f = s.charAt(0)
    if ((f === "'" || f === '"') && s.charAt(s.length - 1) === f) return s.slice(1, -1)
  }
  return s
}

/** Does a single inline-code program read AND execute stdin? */
function codeExecsStdin(code: string): boolean {
  return STDIN_EXEC_CI_RE.test(code) || STDIN_EXEC_FUNCTION_RE.test(code) || STDIN_EXEC_SHELL_RE.test(code)
}

/** A shell inline literal that, parsed as shell, contains a stage whose head is
 *  an interpreter reading its PROGRAM from stdin — `bash -c 'bash'`,
 *  `bash -c 'exec bash'`, `bash -c 'bash <&0'`. That nested interpreter inherits
 *  the outer stage's (piped, network) fd 0 and runs it as code. */
function shellLiteralReadsStdin(code: string, depth: number): boolean {
  if (depth >= 3) return true // recursion cap → fail closed
  const masked = maskQuotedLiterals(maskHeredocBodies(code)) ?? code
  for (const stages of splitPipelines(code, masked)) {
    for (const st of stages) {
      if (st === undefined) continue
      if (INTERP_HEAD_RE.test(stageHead(st)) && interpreterProgramKind(st) === 'stdin') return true
    }
  }
  return false
}

/** An inline-code literal that itself reads AND executes stdin
 *  (`python3 -c "exec(sys.stdin.read())"`, `bash -c 'source /dev/stdin'`,
 *  `bash -c 'bash'`) — the piped download becomes code. Tested on the inline
 *  ARGUMENT (not the whole stage) so the outer `bash -c` prefix can't itself
 *  match; for shell interpreters the literal is also parsed as shell. */
function inlineExecsStdin(st: BashStage, depth = 0): boolean {
  const { toks, headIdx } = stageWords(st)
  if (headIdx >= toks.length) return false
  const head = dequoteWord((toks[headIdx] as BashWord).raw).replace(/^.*\//, '')
  const spec = interpreterSpec(head)
  if (spec === null) return false
  const operands = toks.slice(headIdx + 1)
  for (let k = 0; k < operands.length; k += 1) {
    const arg = inlineCodeArg(operands, k, spec)
    if (arg === null) continue
    const code = stripOuterQuotes(arg.raw)
    if (codeExecsStdin(code)) return true
    if (spec.isShell && shellLiteralReadsStdin(code, depth + 1)) return true
  }
  return false
}

/** Does an interpreter/eval stage execute a NETWORK substitution that sits in
 *  CODE position (R2)? Code position = eval/source argument; the inline-code
 *  argument (`python3 -c "$(curl)"`); a `<(net)` script operand; or stdin fed by
 *  a net here-string / input redirection when the program is read from stdin. A
 *  net sub passed as plain argv (`python3 -c "<lit>" "$(curl)"`) or as a data
 *  filename after a local script (`python3 app.py <(curl)`, `bash app.sh
 *  <<<"$(curl)"`) is DATA → no card. */
function stageExecutesNetSubstitution(st: BashStage): boolean {
  const { toks, headIdx } = stageWords(st)
  if (headIdx >= toks.length) return false
  const head = dequoteWord((toks[headIdx] as BashWord).raw).replace(/^.*\//, '')
  if (!EXEC_SINK_HEAD_RE.test(head)) return false
  const netSubs = stageSubstitutions(st.masked, st.raw).filter((s) => innerHasNetSource(s.rawInner))
  if (netSubs.length === 0) return false
  // eval / source / . execute every substitution argument.
  if (EVAL_SOURCE_RE.test(head)) return true
  const spec = interpreterSpec(head)
  if (spec === null) return false
  const operands = toks.slice(headIdx + 1)
  // With an inline-code flag the program is that argument; everything else is
  // data — card only if an inline argument itself is a network substitution.
  if (hasInlineFlag(operands, spec)) return inlineCodeArgIsNet(operands, spec)
  // No inline flag: program comes from a script operand or stdin.
  return interpreterProgramFromNet(operands)
}

/** Does a stage execute piped (network-sourced) bytes (R1)? Its head is an
 *  interpreter that reads its program from stdin (the pipe IS the program) or
 *  whose inline literal exec()s stdin; or it tees the stream into a `>(…)` /
 *  `<(…)` process substitution whose inner pipeline ends in an interpreter
 *  (`tee >(bash)`, `tee >(cat | bash)`). An interpreter running a LOCAL script
 *  or a benign inline literal treats the pipe as DATA → not an executor.
 *  Depth-guarded, failing CLOSED on an uninspected process sub at the cap. */
function stageExecutesPipedData(st: BashStage, depth = 0): boolean {
  if (INTERP_HEAD_RE.test(stageHead(st))) {
    const kind = interpreterProgramKind(st)
    if (kind === 'stdin') return true // the piped download is the program
    if (kind === 'inline' && inlineExecsStdin(st)) return true // -c literal exec()s stdin
  }
  const procSubs = stageSubstitutions(st.masked, st.raw).filter((s) => s.kind === '>(' || s.kind === '<(')
  if (procSubs.length === 0) return false
  if (depth >= 4) return true // uninspected process substitution at max depth → fail closed
  for (const sub of procSubs) {
    if (pipelineExecutesData(sub.rawInner, depth + 1)) return true
  }
  return false
}

/** Any stage of a (sub-)command executes piped data — used to recurse into
 *  process-substitution bodies. Depth cap fails safe to card. */
function pipelineExecutesData(text: string, depth: number): boolean {
  if (depth >= 5) return true
  const masked = maskQuotedLiterals(maskHeredocBodies(text)) ?? text
  for (const stages of splitPipelines(text, masked)) {
    for (const st of stages) {
      if (stageExecutesPipedData(st, depth)) return true
    }
  }
  return false
}

/** The first command word of a stage WITHOUT stripping a `sudo` wrapper — so a
 *  pipe INTO sudo (`echo x | sudo tee …`) is detectable (R4). */
function stageCommandWord(st: BashStage): string {
  const toks = tokenizeStage(st)
  let k = 0
  while (k < toks.length && ASSIGN_RE.test((toks[k] as BashWord).masked)) k += 1
  if (k >= toks.length) return ''
  return dequoteWord((toks[k] as BashWord).raw).replace(/^.*\//, '').toLowerCase()
}

/** A shell interpreter's `-c '<literal>'` argument is itself shell code — scan
 *  it recursively so `bash -c 'curl … | sh'` cards. (A net-substitution
 *  `-c "$(curl)"` is already caught by stageExecutesNetSubstitution.) */
function shellInlineExecutesEvasion(st: BashStage, depth: number): boolean {
  const { toks, headIdx } = stageWords(st)
  if (headIdx >= toks.length) return false
  const head = dequoteWord((toks[headIdx] as BashWord).raw).replace(/^.*\//, '')
  const spec = interpreterSpec(head)
  if (spec === null || !spec.isShell) return false
  const operands = toks.slice(headIdx + 1)
  for (let k = 0; k < operands.length; k += 1) {
    const arg = inlineCodeArg(operands, k, spec)
    // Strip only the OUTER shell quote — inner quotes stay so a printed string
    // literal (`printf "%s" "curl | sh"`) is not rescanned as bare code.
    if (arg !== null && bashEvasion(stripOuterQuotes(arg.raw), depth + 1)) return true
  }
  return false
}

function bashEvasion(rawCommand: string, depth: number): boolean {
  if (depth >= 3) return true // shell `-c` recursion cap → fail closed
  const masked = maskQuotedLiterals(maskHeredocBodies(rawCommand))
  // Unbalanced quotes → fail-closed: scan the raw command conservatively.
  const safe = masked ?? rawCommand
  for (const stages of splitPipelines(rawCommand, safe)) {
    // (R4) a non-first pipeline stage piped into sudo.
    for (let j = 1; j < stages.length; j++) {
      const st = stages[j]
      if (st !== undefined && stageCommandWord(st) === 'sudo') return true
    }
    // (R2) a network substitution executed in code position; (recursion) a shell
    //      `-c` literal that itself contains a download-exec.
    for (const st of stages) {
      if (st === undefined) continue
      if (stageExecutesNetSubstitution(st)) return true
      if (shellInlineExecutesEvasion(st, depth)) return true
    }
    // (R1) network/decode source reaching an executor in a LATER stage.
    for (let i = 0; i < stages.length; i++) {
      const src = stages[i]
      if (src === undefined || !NET_SOURCE_RE.test(src.masked)) continue
      for (let j = i + 1; j < stages.length; j++) {
        const sink = stages[j]
        if (sink !== undefined && stageExecutesPipedData(sink)) return true
      }
    }
  }
  return false
}

function bashConfirmEvasion(rawCommand: string): boolean {
  return bashEvasion(rawCommand, 0)
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
    // Token-start match, not bare substring: `kill ` must not fire inside
    // `skill ` / `overkill ` (live false positive: a heredoc mentioning
    // "material-builder skill + schema" raised a confirm card, 2026-06-09).
    // A word-ish char right before the pattern means we are inside a longer
    // token — applies only to patterns that start with a letter/digit, so
    // operator patterns like `.env` or `-rf ` keep substring semantics.
    if (/^[a-z0-9]/.test(pat)) {
      const escaped = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(?<![a-z0-9_-])${escaped}`).test(commandLower)
    }
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

/** All rules from the list that match — used by the built-in confirm tier so
 * an operator override of one rule cannot mask a sibling hit (e.g.
 * `git push; kill 1234` overriding only `git push` must still confirm). */
function matchAllBashRules(rules: readonly string[], commandLower: string): string[] {
  const hits: string[] = []
  for (const rule of rules) {
    if (bashMatch(rule, commandLower)) hits.push(rule)
  }
  return hits
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
    // Non-overridable HARD-DENY: a mutating systemctl on the agent's OWN comms
    // channel (channel-*/gateway) would sever the warchief's Telegram link to
    // the agent — blocked outright (warchief 2026-06-14: this is the one brake
    // kept; it never showed a card). Lives in the hard-deny pass (NOT step 4) so
    // a mixed command that also trips a confirm builtin (git-exec-surface, sudo,
    // pipe-interpreter) cannot downgrade this deny to confirm — Codex review HIGH.
    if (commandLower !== undefined && mutatesOwnChannel(commandLower)) {
      return { tier: 'deny', reason: 'mutating the agent own comms channel (systemctl) would sever the warchief link', matchedRule: 'builtin:deny:own-channel' }
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

  // 4. Built-in confirm bash — no operator-ALLOW short-circuit (Codex
  // Critical #3); the only relaxation is the explicit, validated
  // confirm_overrides list, and a command matching ANY non-overridden rule
  // still confirms. The evasion detector below is never overridable.
  if (commandLower !== undefined) {
    const overridden = policy.confirm_overrides?.builtin_rules ?? []
    const hits = matchAllBashRules(BUILTIN_CONFIRM_BASH, commandLower)
    const standing = hits.filter((h) => !overridden.includes(h))
    if (standing.length > 0) {
      return { tier: 'confirm', reason: `risky command needs confirmation: ${standing[0]}`, matchedRule: `builtin:confirm_bash:${standing[0]}` }
    }
    // Pass the RAW command (commandLower !== undefined ⇒ rawCommand defined):
    // the detector is quote/heredoc-aware and matches command names case-
    // insensitively itself, so lowercasing here would only re-introduce the
    // flag-case collapse (`-C`/`-c`) that bit gitExecSurface.
    if (bashConfirmEvasion(rawCommand!)) {
      return { tier: 'confirm', reason: 'pipe-to-interpreter download needs confirmation', matchedRule: 'builtin:confirm_bash:pipe-interpreter' }
    }
    // Non-overridable: git config/hook execution surfaces (a downgraded
    // `git push` must never become arbitrary local code execution). Pass the
    // RAW command (commandLower !== undefined ⇒ rawCommand defined) so the
    // case-sensitive `-c` check distinguishes `git -C` from `git -c`.
    if (gitExecSurface(rawCommand!)) {
      return { tier: 'confirm', reason: 'git config/hook execution surface needs confirmation', matchedRule: 'builtin:confirm_bash:git-exec-surface' }
    }
    // (own-channel systemctl hard-deny was hoisted into the step-2b hard-deny
    // pass above so a co-located confirm builtin can't downgrade it — Codex HIGH.)
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
