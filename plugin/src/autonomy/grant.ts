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
// ─────────────────────────────────────────────────────────────────────

export const LEASE_DEFAULT_TTL_HOURS = 24
export const LEASE_MAX_TTL_HOURS = 72
const MS_PER_HOUR = 3_600_000

/**
 * Clamp a parsed ttl into policy: default 24h when absent/invalid, hard cap
 * 72h. A non-finite or ≤0 value falls back to the default (a request for
 * "0 hours" is a mistake, not a request for an instantly-dead mandate).
 */
export function clampTtlHours(parsed: number | undefined): number {
  if (parsed === undefined || !Number.isFinite(parsed) || parsed <= 0) {
    return LEASE_DEFAULT_TTL_HOURS
  }
  return Math.min(parsed, LEASE_MAX_TTL_HOURS)
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
  // Clamped ttl in hours (default 24, cap 72).
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

interface ScopeAndOptions {
  scope: string
  ttlHours: number
  supersede: boolean
}

// Parse the inner `<scope>[; ttl=Nh][; supersede]` grammar shared by the
// marker body and the `/lease` command args. Returns null when the scope
// segment is empty (a malformed marker → treated as a normal question).
function parseScopeAndOptions(inner: string): ScopeAndOptions | null {
  const segments = inner.split(';')
  const scope = (segments[0] ?? '').trim()
  if (scope.length === 0) return null

  let ttlParsed: number | undefined
  let supersede = false
  for (let i = 1; i < segments.length; i++) {
    const seg = (segments[i] ?? '').trim()
    if (seg.length === 0) continue
    const ttlMatch = /^ttl\s*=\s*([0-9]*\.?[0-9]+)\s*h$/i.exec(seg)
    if (ttlMatch) {
      ttlParsed = Number.parseFloat(ttlMatch[1] as string)
      continue
    }
    if (/^supersede$/i.test(seg)) {
      supersede = true
      continue
    }
    // Unknown option segment — ignore it, but the card is still a valid lease
    // request (we already have a non-empty scope).
  }
  return { scope, ttlHours: clampTtlHours(ttlParsed), supersede }
}

/**
 * Parse a `[LEASE: …]` marker at the START of a question. Returns null when
 * there is no marker or the scope is empty (both → render as a normal
 * question, mint no lease).
 */
export function parseLeaseMarker(questionText: string): ParsedLeaseMarker | null {
  const m = LEASE_MARKER_RE.exec(questionText)
  if (!m) return null
  const parsed = parseScopeAndOptions(m[1] ?? '')
  if (!parsed) return null
  const remainder = questionText.slice(m[0].length).trim()
  return {
    scope: parsed.scope,
    ttlHours: parsed.ttlHours,
    supersede: parsed.supersede,
    displayText: remainder.length > 0 ? remainder : parsed.scope,
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

/** Parse the args of a `/lease` command (the text AFTER the command word).
 *  An empty scope (bare command, or only options with no scope) → `bare`. */
export function parseLeaseCommandArgs(args: string): ParsedLeaseCommand {
  if (args.trim().length === 0) return { kind: 'bare' }
  const parsed = parseScopeAndOptions(args)
  // supersede is NOT part of the `/lease` grammar — a differing active lease
  // coexists (the owner can revoke via the MCP tool). We take scope + ttl only.
  if (!parsed) return { kind: 'bare' }
  return { kind: 'grant', scope: parsed.scope, ttlHours: parsed.ttlHours }
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
