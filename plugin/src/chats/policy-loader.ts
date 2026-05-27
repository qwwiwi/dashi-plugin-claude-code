// Policy loader for the multichat router. Parses `chats/policy.yaml`
// from a base directory, validates against a Zod schema in strict mode
// (unknown fields raise ZodError), and exposes typed accessors.
//
// Schema design rationale:
//   * `.strict()` on ChatPolicySchema catches typos before they become
//     silent misconfiguration (Zod's default strip would mask them).
//   * Chat-id keys are stringified — negative group ids must stay
//     quoted in YAML so they survive numeric coercion.
//   * Defaults for `idle_ttl_ms` (30 min) and `max_queue_depth` (1)
//     match the values declared in PLAN.md section 2 / 7 so a missing
//     entry in policy.yaml is interpreted identically across modules.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { JSON_SCHEMA, load as parseYaml } from 'js-yaml'
import { z } from 'zod'

// Per-chat deny rules. All three lists are optional; when omitted the
// pre-tool-use hook applies no restrictions for that category.
// `read_paths` and `mcp_tools` use glob (fnmatch) semantics in the hook;
// `bash_patterns` is matched as substring (case-insensitive) so the
// hook does not have to guess command word boundaries.
export const DenyRulesSchema = z
  .object({
    read_paths: z.array(z.string()).optional(),
    mcp_tools: z.array(z.string()).optional(),
    bash_patterns: z.array(z.string()).optional(),
  })
  .strict()

// One chat's policy. `.strict()` is critical — a typo in a YAML key
// (e.g. `streming` instead of `streaming`) will throw at load time
// rather than silently default to the wrong behaviour.
export const ChatPolicySchema = z
  .object({
    mode: z.enum(['private', 'public']),
    streaming: z.enum(['progress', 'off']),
    tmux_mirror: z.boolean(),
    edit_message_progress: z.boolean(),
    delivery: z.enum(['streamed', 'final_only']),
    persona_file: z.string().min(1),
    handoff_file: z.string().min(1),
    deny: DenyRulesSchema.optional(),
    system_reminder: z.string(),
    idle_ttl_ms: z.number().int().positive().default(1_800_000),
    max_queue_depth: z.number().int().positive().default(1),
  })
  .strict()

// Top-level policy.yaml shape. `version` is locked to 1 — a future
// breaking change should bump it and add a migration path.
export const MultichatPolicySchema = z
  .object({
    version: z.literal(1),
    allowlist: z
      .object({
        chats: z.array(z.string().min(1)),
        users: z.array(z.string().min(1)),
      })
      .strict(),
    mention_allowlist: z.array(z.string().min(1)),
    chats: z.record(z.string().min(1), ChatPolicySchema),
  })
  .strict()

export type DenyRules = z.infer<typeof DenyRulesSchema>
export type ChatPolicy = z.infer<typeof ChatPolicySchema>
export type MultichatPolicy = z.infer<typeof MultichatPolicySchema>

/**
 * Load and validate `policy.yaml` from a base directory.
 *
 * Reads `{basePath}/policy.yaml`, parses with js-yaml, and validates
 * against {@link MultichatPolicySchema}. Throws on missing file (the
 * caller decides whether multichat is required), invalid YAML
 * (YAMLException), or schema violation (ZodError). No error swallowing
 * here — callers must decide policy-vs-fatal.
 *
 * For callers that need to point at an EXACT file path (env-var
 * override `TELEGRAM_MULTICHAT_POLICY_PATH=/etc/edge/policy.yaml`) use
 * {@link loadPolicyFromPath} instead; this `loadPolicy` variant exists
 * for the default-derive case (workspace_dir → `<dir>/policy.yaml`).
 *
 * @param basePath directory containing `policy.yaml` (typically
 *   `~/.claude-lab/thrall/.claude/chats`)
 * @returns validated, fully-typed multichat policy
 */
export function loadPolicy(basePath: string): MultichatPolicy {
  return loadPolicyFromPath(join(basePath, 'policy.yaml'))
}

/**
 * Load and validate a policy YAML from an EXACT absolute file path.
 *
 * FIX-G / M3 (Codex review 2026-05-27 #4): server.ts used to treat the
 * `TELEGRAM_MULTICHAT_POLICY_PATH` env var as a directory hint
 * (basename was stripped before being handed to `loadPolicy`), so a
 * value like `/etc/edge/my-policy.yaml` was silently reduced to
 * `/etc/edge/policy.yaml`. The variable name implies a file path; we
 * now honour that contract.
 *
 * Resolution rule (owned by the caller in server.ts):
 *   1. env `TELEGRAM_MULTICHAT_POLICY_PATH` is set → exact file path
 *   2. `config.multichat.policy_path` is set       → exact file path
 *   3. otherwise                                   → `<workspace_dir>/chats/policy.yaml`
 *
 * Validation rules here mirror {@link loadPolicy}: refuse to load a
 * world-writable file, force JSON_SCHEMA on the YAML parser, validate
 * against {@link MultichatPolicySchema} strict mode.
 *
 * @param absolutePath full file path to the policy YAML
 * @returns validated, fully-typed multichat policy
 */
export function loadPolicyFromPath(absolutePath: string): MultichatPolicy {
  // M12 fix (2026-05-23): refuse to load a world-writable policy file.
  // policy.yaml is the source of truth for allowlists, persona files,
  // and deny rules — a world-writable mode (others-write bit set)
  // means any local user can rewrite the gate. We do NOT enforce
  // group-writable: in some deploys the file is owned by a deploy
  // group and that is fine. We also do not check ownership against
  // process.getuid(): the plugin may run under a service account
  // distinct from the file's owner (e.g. systemd DynamicUser=).
  //
  // statSync throws ENOENT to the caller via readFileSync's own
  // throw later, so we tolerate stat failures here (the next
  // readFileSync will produce a more useful error message).
  try {
    const st = statSync(absolutePath)
    const worldWritable = (st.mode & 0o002) !== 0
    if (worldWritable) {
      throw new Error(
        `policy.yaml is world-writable (mode ${(st.mode & 0o777).toString(8)}) at ${absolutePath} — refusing to load. ` +
          `Run \`chmod o-w ${absolutePath}\` and retry.`,
      )
    }
  } catch (err) {
    // Only rethrow our own perms-error; let readFileSync below
    // surface "file not found" etc. with its native message.
    if (err instanceof Error && err.message.includes('world-writable')) {
      throw err
    }
  }

  const raw = readFileSync(absolutePath, 'utf8')
  // H9 fix (2026-05-23): force JSON_SCHEMA so the parser only emits
  // JSON-compatible types (plain objects, arrays, strings, numbers,
  // booleans, null). js-yaml's DEFAULT_SCHEMA tolerates Date, RegExp,
  // and custom tags — none of which a policy file should ever produce,
  // and any of which could be a vector for prototype pollution or type
  // confusion if policy.yaml is ever influenced by an attacker.
  const parsed = parseYaml(raw, { schema: JSON_SCHEMA })
  return MultichatPolicySchema.parse(parsed)
}

/**
 * Look up a chat's policy by stringified chat id.
 *
 * Returns `null` when the chat is not declared in policy.yaml — the
 * caller must treat this as "chat not configured" (typically a hard
 * drop in the gate). Group chat ids are negative, so always pass the
 * id as a string (e.g. `"-1003784643974"`).
 *
 * @param policy loaded multichat policy
 * @param chatId stringified Telegram chat id
 * @returns the chat's policy, or `null` if not configured
 */
export function getChatPolicy(
  policy: MultichatPolicy,
  chatId: string,
): ChatPolicy | null {
  const entry = policy.chats[chatId]
  return entry ?? null
}

// ──────────────────────────────────────────────────────────────────────
// Shared chat-policy primitives (Codex review 2026-05-27, TASK-1)
//
// The codex audit found that status-manager, tmux-mirror, multichat
// router, persona resolver, and inbox-bridge all had subtly different
// answers to "does this chat exist in policy?" — some fail-open (legacy
// DM still streams when policy is undefined), some assume positive
// integers, none validate the chat id shape against a strict regex.
//
// These helpers consolidate the decision: ONE place that knows what a
// chat id looks like, ONE place that knows whether a chat is configured,
// and ONE place that produces fail-CLOSED booleans for behavioural
// flags. Callers in TASK-2/4/5 will migrate one by one — this task
// only adds the exports.
// ──────────────────────────────────────────────────────────────────────

// Telegram chat ids are signed 64-bit integers. Private chats / users
// expose positive ids; supergroups, groups, and channels use negative
// ids (the "-100..." prefix on supergroups is part of the value, not a
// separator). We restrict input to `/^-?\d+$/` so any non-numeric,
// path-traversal, shell-metachar, or floating-point id is rejected up
// front before it can reach `path.join`, `tmux new-session -s`, or
// `policy.chats[…]` index lookup.
const CHAT_ID_PATTERN = /^-?\d+$/

// Opus MED-B #20 (2026-05-27): hard cap on chat id length. A signed
// 64-bit integer is at most 20 characters including the optional `-`
// sign. We cap at 32 to leave headroom for any future Telegram-side
// schema change (BigInt extension?) while still rejecting the 4 KB
// "smuggle a payload as a chat id" abuse case the MED-B audit flagged.
const MAX_CHAT_ID_LENGTH = 32

/**
 * Throw if `chatId` is not a strict signed-integer string.
 *
 * Used by the router dispatch path, the inbox-bridge file layout, the
 * tmux pool spawn (where chat ids become tmux session names), and the
 * persona manager. A chat id that does not match the pattern indicates
 * either a programmer error (passed a number instead of a string,
 * accidentally trimmed a leading `-`) or an attempted injection
 * (`"../some/path"`, `"1; rm -rf /"`, `"$(whoami)"`). Both deserve a
 * hard fail, not silent coercion.
 *
 * Opus MED-B #20 (2026-05-27): three additional guards layered on top
 * of the regex:
 *   1. Length cap at {@link MAX_CHAT_ID_LENGTH} — a 4 KB digit string
 *      is syntactically valid for `/^-?\d+$/` but pathologically large
 *      and indicates a smuggling attempt or runaway concat bug.
 *   2. Reject the degenerate "-0" — distinct path namespace from "0"
 *      that Telegram never emits; closing it keeps lookups canonical.
 *   3. Reject leading-zero values other than literal "0" (e.g. "01",
 *      "-007") — Telegram chat ids never carry leading zeroes; allowing
 *      them would split the keyspace and let two valid-looking strings
 *      collide on disk after normalisation.
 *
 * @param chatId the value to validate
 * @throws TypeError when chatId is not a string matching `/^-?\d+$/`
 */
export function assertValidChatId(chatId: string): void {
  if (typeof chatId !== 'string') {
    throw new TypeError(
      `invalid chat id: expected string, got ${typeof chatId}`,
    )
  }
  if (chatId.length > MAX_CHAT_ID_LENGTH) {
    // Echo only the length and a short prefix — never the whole
    // payload, so a malicious 4 KB string cannot blow up the log line.
    throw new TypeError(
      `invalid chat id: length ${chatId.length} exceeds cap ${MAX_CHAT_ID_LENGTH} ` +
        `(prefix=${JSON.stringify(chatId.slice(0, 16))}…)`,
    )
  }
  if (!CHAT_ID_PATTERN.test(chatId)) {
    // Truncate echoed value so a malicious payload can't blow up a
    // log line; 64 chars is enough to recognise the shape in audits.
    const sample = chatId.length > 64 ? `${chatId.slice(0, 64)}…` : chatId
    throw new TypeError(
      `invalid chat id ${JSON.stringify(sample)}: must match /^-?\\d+$/`,
    )
  }
  // MED-B #20: reject "-0" specifically — regex accepts it but it is a
  // distinct path namespace that collides with "0" after FS
  // normalisation on case-insensitive filesystems or after a
  // path.normalize pass.
  if (chatId === '-0') {
    throw new TypeError(
      `invalid chat id "-0": negative-zero is not a Telegram chat id`,
    )
  }
  // MED-B #20: reject leading-zero values like "01", "-007". The
  // regex accepts them but Telegram never emits leading zeroes, and
  // their existence would mean two distinct strings ("1" and "01") map
  // to the same logical chat after parseInt normalisation downstream.
  // Allowed forms: "0", "1", "12345", "-1", "-1003784643974".
  // Disallowed: "01", "00", "-01", "-0123".
  const body = chatId.startsWith('-') ? chatId.slice(1) : chatId
  if (body.length > 1 && body.startsWith('0')) {
    throw new TypeError(
      `invalid chat id ${JSON.stringify(chatId)}: leading zeroes not permitted`,
    )
  }
}

/**
 * Return the chat-specific policy entry, or `null` if the chat is not
 * configured (or no multichat policy is loaded at all). The caller is
 * expected to treat `null` as **DENY** — no fallback to defaults, no
 * implicit allow.
 *
 * This is the multichat-aware companion to {@link getChatPolicy}:
 * `getChatPolicy(policy, id)` requires a non-null policy, whereas this
 * helper accepts `policy === null` (legacy single-DM deployments where
 * the multichat router is disabled). In that legacy case the answer is
 * still `null` — fail-closed callers (router gate) will refuse to
 * dispatch, while fail-open callers ({@link shouldStreamForChat}) use
 * the null-policy signal to preserve legacy DM behaviour explicitly.
 *
 * @param policy loaded multichat policy, or `null` when multichat
 *   is disabled
 * @param chatId stringified Telegram chat id (validated)
 * @returns the chat's policy entry, or `null` when not configured
 */
export function getChatPolicyOrDeny(
  policy: MultichatPolicy | null,
  chatId: string,
): ChatPolicy | null {
  assertValidChatId(chatId)
  if (policy === null) return null
  const entry = policy.chats[chatId]
  return entry ?? null
}

/**
 * Fail-CLOSED streaming gate for a chat.
 *
 * Semantics:
 *   * `policy === null` (legacy single-DM mode, multichat disabled):
 *     return `true`. Preserves the pre-multichat behaviour where the
 *     warchief's DM always streams progress.
 *   * `policy` loaded but chat absent from `policy.chats[…]`:
 *     return `false`. No fallback to a global default — an unlisted
 *     chat MUST NOT receive interim "Печатает.../tool" edits even if
 *     somebody bypassed the gate (defence in depth).
 *   * Chat present with `streaming: 'progress'`: return `true`.
 *   * Chat present with `streaming: 'off'`: return `false`.
 *
 * Used by status-manager (in TASK-2) and tmux-mirror to decide whether
 * a given chat should see streaming/mirror artefacts.
 *
 * @param policy loaded multichat policy, or `null` when multichat
 *   is disabled (legacy DM mode)
 * @param chatId stringified Telegram chat id (validated)
 * @returns `true` when interim progress edits should be sent
 */
export function shouldStreamForChat(
  policy: MultichatPolicy | null,
  chatId: string,
): boolean {
  assertValidChatId(chatId)
  if (policy === null) return true
  const entry = policy.chats[chatId]
  if (entry === undefined) return false
  return entry.streaming === 'progress'
}

/**
 * Fail-CLOSED tmux-mirror gate for a chat.
 *
 * Identical fail-closed semantics to {@link shouldStreamForChat} but
 * driven by the `tmux_mirror` boolean rather than `streaming`. Public
 * group chats with no entry in policy get `false` — the pane mirror
 * leaks tool calls, file paths, and reasoning chunks that must never
 * surface outside the warchief's DM.
 *
 * Used by tmux-mirror.ts (in TASK-2).
 *
 * @param policy loaded multichat policy, or `null` when multichat
 *   is disabled (legacy DM mode)
 * @param chatId stringified Telegram chat id (validated)
 * @returns `true` when the rolling tmux pane mirror should run
 */
export function shouldMirrorTmuxForChat(
  policy: MultichatPolicy | null,
  chatId: string,
): boolean {
  assertValidChatId(chatId)
  if (policy === null) return true
  const entry = policy.chats[chatId]
  if (entry === undefined) return false
  return entry.tmux_mirror === true
}
