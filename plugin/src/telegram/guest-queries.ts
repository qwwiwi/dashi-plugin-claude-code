// Guest-query registry (Guest Mode, Bot API 10.0, 2026-07-04).
//
// A guest_message update carries a one-shot `guest_query_id`: the bot may
// answer it exactly once via answerGuestQuery, and only queries created by
// an ALLOWLISTED caller ever enter this registry (the handler gates before
// registering). The `reply` tool then authorizes a guest answer purely by
// registry membership — it deliberately does NOT consult the chat
// allowlist, because the originating chat is by definition one the bot is
// not a member of.
//
// Entry lifecycle (dual review 2026-07-04, Codex #1/#2 + Fable #1/#7):
//   pending  --claim-->  inflight  --confirm-->  answered (tombstone)
//                          |  ^
//                   release|  |claim refused ('consumed')
//                          v  |
//                        pending
//
// Fail-closed properties:
//   - unknown guest_query_id       → reject (never answered blind)
//   - inflight/answered id         → reject 'consumed' (kept as tombstone
//     until TTL so the error is clear, not cryptic)
//   - expired entry                → reject (Telegram queries go stale; we
//     mirror that with a conservative local TTL)
//   - duplicate register of a known id → NO-OP. Telegram redelivers
//     updates (poller restart, offset replay); re-registering must never
//     resurrect a consumed query into a second answer (Codex #1) nor
//     evict an innocent entry when the map is at cap (Fable #1).
//   - cap eviction never touches an INFLIGHT entry — evicting one would
//     turn a post-failure release() into a no-op and strand the retry
//     (Codex #2). Victim preference: oldest answered tombstone, then
//     oldest pending; if literally everything is inflight, registration
//     is refused (register returns false; caller logs and drops).
//
// In-memory only: a plugin restart drops pending queries. That is
// acceptable — the query would not survive the restart round-trip anyway,
// and persisting one-shot reply capabilities to disk would only widen the
// replay surface.

export type GuestQueryState = 'pending' | 'inflight' | 'answered'

export interface GuestQueryEntry {
  guestQueryId: string
  callerUserId: string
  callerChatId: string | undefined
  messageText: string
  createdAtMs: number
  state: GuestQueryState
}

export type GuestQueryClaim =
  | { kind: 'ok'; entry: GuestQueryEntry }
  | { kind: 'unknown' }
  | { kind: 'consumed' }
  | { kind: 'expired' }

// Telegram does not document the guest-query lifetime; callback queries
// live for a few minutes and inline results for about an hour. 15 minutes
// is long enough for a real Claude turn and short enough to bound replay.
export const GUEST_QUERY_TTL_MS = 15 * 60 * 1000

// Registry never grows unbounded even under a flood of allowlisted
// queries: sweep() prunes expired entries on register/pendingCount and the
// cap below evicts a non-inflight victim when a NEW id would exceed it.
const MAX_ENTRIES = 64

export class GuestQueryRegistry {
  private entries = new Map<string, GuestQueryEntry>()

  constructor(
    private readonly ttlMs: number = GUEST_QUERY_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Register a fresh guest query. Returns false when the entry could not
   * be admitted (cap reached and every resident entry is inflight) — the
   * caller must drop the update instead of assuming it is answerable.
   * A duplicate id (Telegram redelivery) is a successful NO-OP: the
   * existing entry, whatever its state, stays authoritative.
   */
  register(input: {
    guestQueryId: string
    callerUserId: string
    callerChatId?: string
    messageText: string
  }): boolean {
    this.sweep()
    const existing = this.entries.get(input.guestQueryId)
    if (existing !== undefined) return true

    if (this.entries.size >= MAX_ENTRIES && !this.evictOne()) {
      return false
    }
    this.entries.set(input.guestQueryId, {
      guestQueryId: input.guestQueryId,
      callerUserId: input.callerUserId,
      callerChatId: input.callerChatId,
      messageText: input.messageText,
      createdAtMs: this.now(),
      state: 'pending',
    })
    return true
  }

  // One-shot claim: pending → inflight atomically with the check, so two
  // concurrent reply calls cannot both pass. Inflight/answered entries
  // stay in the map as tombstones until TTL so the second caller gets
  // 'consumed' instead of the less-actionable 'unknown'. No sweep() here —
  // the TTL check below must SEE the stale entry to report the actionable
  // 'expired' (sweeping first would collapse it into 'unknown').
  claim(guestQueryId: string): GuestQueryClaim {
    const entry = this.entries.get(guestQueryId)
    if (entry === undefined) return { kind: 'unknown' }
    if (entry.state !== 'pending') return { kind: 'consumed' }
    if (this.now() - entry.createdAtMs > this.ttlMs) {
      this.entries.delete(guestQueryId)
      return { kind: 'expired' }
    }
    entry.state = 'inflight'
    return { kind: 'ok', entry }
  }

  // Mark an inflight entry as definitively answered (send succeeded).
  // The tombstone stays until TTL so a repeat reply reads 'consumed'.
  confirm(guestQueryId: string): void {
    const entry = this.entries.get(guestQueryId)
    if (entry !== undefined && entry.state === 'inflight') entry.state = 'answered'
  }

  // Un-consume after a failed Telegram send so the agent may retry.
  // Only inflight→pending: an 'answered' entry must never re-open.
  // No-op for unknown ids (entry may have been swept meanwhile).
  release(guestQueryId: string): void {
    const entry = this.entries.get(guestQueryId)
    if (entry !== undefined && entry.state === 'inflight') entry.state = 'pending'
  }

  pendingCount(): number {
    this.sweep()
    let n = 0
    for (const e of this.entries.values()) if (e.state === 'pending') n++
    return n
  }

  // Pick and delete a cap-eviction victim: oldest answered tombstone
  // first (its one answer is already delivered — nothing to strand),
  // then oldest pending (stale-most by Map insertion order, which is
  // reliable here because register() never re-inserts existing keys).
  // Inflight entries are untouchable. Returns false when nothing could
  // be evicted.
  private evictOne(): boolean {
    for (const wanted of ['answered', 'pending'] as const) {
      for (const [id, entry] of this.entries) {
        if (entry.state === wanted) {
          this.entries.delete(id)
          return true
        }
      }
    }
    return false
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [id, entry] of this.entries) {
      if (entry.createdAtMs < cutoff) this.entries.delete(id)
    }
  }
}
