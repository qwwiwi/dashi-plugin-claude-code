// src/autonomy/grant.ts
//
// Autonomy M2 — the ONLY two authenticated lease-GRANT paths.
//
// SECURITY INVARIANT (do not weaken): nothing the agent can call — no MCP
// tool, no hook script — may create a lease. A lease is minted only by:
//   1. the AskUserQuestion tap handler (telegram/ask-user-question.ts), when
//      the OWNER taps an affirmative option on a `[LEASE: …]` card, and
//   2. the `/lease` owner command (commands/oob.ts).
// Both call `grantLease` below, and both run ONLY behind the owner allowlist
// (resolveAskUserQuestionAllowedUserIds / config.allowed_user_ids). The M1
// `autonomy` MCP tool deliberately has no grant action; this module is the
// grant surface that lives OUTSIDE the agent's reach.
//
// This file holds the pure marker/label/command parsers (unit-tested in
// isolation) plus the thin `grantLease` orchestrator that routes the parsed
// intent through the serialized store writer (updateAutonomyState).

import {
  type AutonomyLease,
  type AutonomyPaths,
  type LeaseGrantOutcome,
  type LeaseSource,
  applyLeaseGrant,
  updateAutonomyState,
} from './store.js'
import type { Logger } from '../log.js'

// ─────────────────────────────────────────────────────────────────────
// TTL policy — shared by the marker and the `/lease` command.
//
// FAIL-CLOSED grammar (M2 fix-loop #3, Codex HIGH): the default of 24h
// applies ONLY when the ttl is entirely absent. A ttl segment that is PRESENT
// but malformed — 0, negative, float, NaN, >72, non-ASCII digits, garbage,
// inner whitespace — makes the whole grant INVALID (marker → the card is a
// normal question, not grant-capable; /lease → usage error, no grant).
// Accepted values: ASCII integer 1..72 in the exact form `ttl=<int>h`.
// ─────────────────────────────────────────────────────────────────────

export const LEASE_DEFAULT_TTL_HOURS = 24
export const LEASE_MAX_TTL_HOURS = 72
// Hygiene cap (fix-loop #8): a scope longer than this is INVALID, fail-closed.
// It is NOT clipped-and-granted: «rendered ≠ granted» must never happen, and a
// scope that cannot be rendered fully grants nothing.
export const LEASE_SCOPE_MAX_CODEPOINTS = 400
const MS_PER_HOUR = 3_600_000

// A segment that LOOKS like a ttl option (starts with `ttl=`, whitespace
// around `=` tolerated for DETECTION only). Detection is deliberately broader
// than validation: an option-like segment that fails the strict form must
// fail the grant — never fall through as scope text, never be defaulted.
const TTL_LOOKS_LIKE_RE = /^ttl\s*=/i
// The strict accepted form: literal lowercase `ttl=<int>h`, 1-2 ASCII digits,
// no inner spaces, no case variants (fix-loop-2 #7: `TTL=12H` is INVALID —
// detection stays case-insensitive so the variant fails the grant instead of
// silently becoming scope text).
const TTL_STRICT_RE = /^ttl=([0-9]{1,2})h$/

// Strict ttl segment parse: integer 1..72 → hours; anything else → null.
function parseTtlSegment(segment: string): number | null {
  const m = TTL_STRICT_RE.exec(segment)
  if (!m) return null
  const n = Number.parseInt(m[1] as string, 10)
  if (!Number.isInteger(n) || n < 1 || n > LEASE_MAX_TTL_HOURS) return null
  return n
}

// Code-point length (an astral-plane scope must not slip past the cap via
// UTF-16 unit counting).
function codePointLength(s: string): number {
  return Array.from(s).length
}

// Charset fail-closed (fix-loop-2 #6): a scope containing control (Cc — incl.
// newlines/tabs) or format (Cf — incl. bidi RLO/LRO/PDF, zero-width joiners)
// code points is INVALID. Bidi controls can visually REORDER the rendered
// consent text so what the owner reads differs from the granted bytes even
// though the digest matches — reject the whole grant instead.
const SCOPE_FORBIDDEN_RE = /[\p{Cc}\p{Cf}]/u

function scopeCharsetInvalid(scope: string): boolean {
  return SCOPE_FORBIDDEN_RE.test(scope)
}

/**
 * Cheap PREFIX test: does this question text START with something that looks
 * like a lease marker? Presentation-only helper for the honesty surfaces
 * («маркер некорректен» note, «intent утерян» closed-card line). It NEVER
 * influences granting — grants read only the persisted canonical intent
 * (ask-intents.ts, fix-loop-2 #1).
 */
export function looksLikeLeaseMarker(questionText: string): boolean {
  return /^\s*\[lease:/i.test(questionText)
}

// ─────────────────────────────────────────────────────────────────────
// Affirmative option labels. EXACT match (case-insensitive, trimmed) against
// this closed list — never a substring/heuristic, so «Нет, не сейчас» or
// «Да позже уточню» never trips a grant. Any non-affirmative label (including
// «Другое» free text) mints NO lease.
// ─────────────────────────────────────────────────────────────────────

const AFFIRMATIVE_LABELS: ReadonlySet<string> = new Set(
  ['Да', 'Да, весь трейн', 'Да, разрешаю', 'Yes'].map((s) => s.toLowerCase()),
)

export function isAffirmativeLabel(label: string): boolean {
  return AFFIRMATIVE_LABELS.has(label.trim().toLowerCase())
}

// ─────────────────────────────────────────────────────────────────────
// Marker parsing. A lease-request card is an agent-authored question whose
// text BEGINS with `[LEASE: <scope>]`, optionally `[LEASE: <scope>; ttl=<N>h]`
// and/or `; supersede`. The marker is parsed AND stripped from what the owner
// sees (the display text).
// ─────────────────────────────────────────────────────────────────────

export interface ParsedLeaseMarker {
  // Verbatim scope text (never paraphrased) — the grant's scope + digest anchor.
  scope: string
  // Validated ttl in hours (default 24 only when the segment is absent).
  ttlHours: number
  // `; supersede` present → revoke a differing active lease before granting.
  supersede: boolean
  // What Telegram renders (marker stripped). Falls back to the scope text when
  // the marker was the whole question, so the owner always sees SOMETHING.
  displayText: string
}

// Matches a leading `[LEASE: …]` (case-insensitive on the LEASE keyword),
// capturing the inner text up to the FIRST closing bracket. Leading whitespace
// is tolerated so an indented question still parses.
const LEASE_MARKER_RE = /^\s*\[lease:\s*([^\]]*)\]/i

/**
 * Parse a `[LEASE: …]` marker at the START of a question. Returns null — the
 * card is a NORMAL question, not grant-capable, and the raw text (marker
 * included) is what the owner sees — when ANY of these hold (fail-closed,
 * fix-loop #3/#8):
 *   * no marker, or the marker is not at the very start;
 *   * empty scope;
 *   * scope longer than LEASE_SCOPE_MAX_CODEPOINTS;
 *   * a ttl segment present but not a strict `ttl=<int 1..72>h`;
 *   * duplicate ttl / duplicate supersede segments;
 *   * ANY unknown or empty option segment (the marker grammar is closed:
 *     after the scope only `ttl=<int>h` and `supersede` are legal — a scope
 *     containing `;` is therefore invalid inside a marker rather than being
 *     silently truncated at the first `;`).
 */
export function parseLeaseMarker(questionText: string): ParsedLeaseMarker | null {
  const m = LEASE_MARKER_RE.exec(questionText)
  if (!m) return null
  const inner = m[1] ?? ''
  const segments = inner.split(';')
  const scope = (segments[0] ?? '').trim()
  if (scope.length === 0) return null
  if (codePointLength(scope) > LEASE_SCOPE_MAX_CODEPOINTS) return null
  if (scopeCharsetInvalid(scope)) return null // Cc/Cf incl. bidi controls — fail-closed

  let ttl: number | undefined
  let supersede = false
  for (let i = 1; i < segments.length; i++) {
    const seg = (segments[i] ?? '').trim()
    if (TTL_LOOKS_LIKE_RE.test(seg)) {
      if (ttl !== undefined) return null // duplicate ttl — ambiguous, invalid
      const v = parseTtlSegment(seg)
      if (v === null) return null // malformed ttl — INVALID, never defaulted
      ttl = v
      continue
    }
    if (/^supersede$/i.test(seg)) {
      if (supersede) return null // duplicate — invalid
      supersede = true
      continue
    }
    // Unknown or empty segment — the whole marker is invalid (fail-closed).
    return null
  }
  const remainder = questionText.slice(m[0].length).trim()
  return {
    scope,
    ttlHours: ttl ?? LEASE_DEFAULT_TTL_HOURS,
    supersede,
    displayText: remainder.length > 0 ? remainder : scope,
  }
}

/** The owner-facing question text with any lease marker stripped. Identity for
 *  a non-lease question. Used by the Telegram renderers so the owner never
 *  sees the raw `[LEASE: …]` plumbing. */
export function stripLeaseMarkerForDisplay(questionText: string): string {
  const parsed = parseLeaseMarker(questionText)
  return parsed ? parsed.displayText : questionText
}

// ─────────────────────────────────────────────────────────────────────
// `/lease` command args parsing.
// ─────────────────────────────────────────────────────────────────────

export type ParsedLeaseCommand =
  // Bare `/lease` (no scope) → list active leases + usage, grant nothing.
  | { kind: 'bare' }
  // `/lease <scope>` or `/lease <scope>; ttl=48h` → grant.
  | { kind: 'grant'; scope: string; ttlHours: number }
  // Present-but-malformed option / over-long scope → usage error, NO grant
  // (fail-closed, fix-loop #3/#6/#8).
  | { kind: 'invalid'; reason: 'ttl' | 'scope_too_long' | 'scope_charset' }

/**
 * Parse the args of a `/lease` command (the text AFTER the command word).
 *
 * Grammar (fix-loop #6, Codex MED — no silent scope truncation): ONLY a
 * TRAILING segment matching the strict `ttl=<int>h` form is treated as an
 * option. Every other `;` belongs to the scope text verbatim — so
 * `/lease аудит; production` grants the scope «аудит; production», never a
 * silently-truncated «аудит». A trailing segment that LOOKS option-like
 * (`ttl=…`) but is malformed → `invalid` (usage error), consistent with the
 * marker's fail-closed ttl grammar. `supersede` is NOT part of the `/lease`
 * grammar — differing active leases coexist (revoke via the MCP tool).
 */
export function parseLeaseCommandArgs(args: string): ParsedLeaseCommand {
  const trimmed = args.trim()
  if (trimmed.length === 0) return { kind: 'bare' }

  let scope = trimmed
  let ttl: number | undefined
  const lastSemi = trimmed.lastIndexOf(';')
  if (lastSemi !== -1) {
    const trailing = trimmed.slice(lastSemi + 1).trim()
    if (TTL_LOOKS_LIKE_RE.test(trailing)) {
      const v = parseTtlSegment(trailing)
      if (v === null) return { kind: 'invalid', reason: 'ttl' }
      ttl = v
      scope = trimmed.slice(0, lastSemi).trim()
    }
  }
  if (scope.length === 0) return { kind: 'bare' }
  if (codePointLength(scope) > LEASE_SCOPE_MAX_CODEPOINTS) {
    return { kind: 'invalid', reason: 'scope_too_long' }
  }
  if (scopeCharsetInvalid(scope)) {
    return { kind: 'invalid', reason: 'scope_charset' }
  }
  return { kind: 'grant', scope, ttlHours: ttl ?? LEASE_DEFAULT_TTL_HOURS }
}

// ─────────────────────────────────────────────────────────────────────
// grantLease — the single orchestrator both authenticated paths call.
// ─────────────────────────────────────────────────────────────────────

export interface GrantLeaseInput {
  scope: string
  ttlHours: number
  source: LeaseSource
  // Idempotency key: a stable string per grant intent (`ask:<reqId>:<qIdx>` or
  // `cmd:<chatId>:<msgId>`). A replay carrying the same key mints no second
  // lease (store-level guard in applyLeaseGrant).
  grantSourceId: string
  grantorMessageId?: number
  supersede?: boolean
}

export type GrantLeaseResult =
  | { kind: 'ok'; outcome: LeaseGrantOutcome; lease?: AutonomyLease }
  | { kind: 'writer_conflict' }
  | { kind: 'version_unsupported' }

/**
 * Mint (or idempotently return) a lease for `chatId`, routing through the
 * serialized store writer. Callers are the two authenticated grant surfaces
 * ONLY — see the security invariant at the top of this file.
 */
export async function grantLease(
  paths: AutonomyPaths,
  chatId: string,
  input: GrantLeaseInput,
  log?: Logger,
  nowMs: number = Date.now(),
): Promise<GrantLeaseResult> {
  const expiresAtMs = nowMs + input.ttlHours * MS_PER_HOUR
  const upd = await updateAutonomyState(
    paths,
    chatId,
    (state) => {
      const r = applyLeaseGrant(
        state,
        {
          scope: input.scope,
          expiresAtMs,
          source: input.source,
          grantSourceId: input.grantSourceId,
          chatId,
          ...(input.grantorMessageId !== undefined ? { grantorMessageId: input.grantorMessageId } : {}),
          ...(input.supersede !== undefined ? { supersede: input.supersede } : {}),
        },
        nowMs,
      )
      return { state: r.state, result: { outcome: r.outcome, lease: r.lease } }
    },
    log,
    nowMs,
  )
  if (upd.kind === 'writer_conflict') return { kind: 'writer_conflict' }
  if (upd.kind === 'version_unsupported') return { kind: 'version_unsupported' }
  return {
    kind: 'ok',
    outcome: upd.result.outcome,
    ...(upd.result.lease !== undefined ? { lease: upd.result.lease } : {}),
  }
}
