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
// Fail-closed properties:
//   - unknown guest_query_id  → reject (never answered blind)
//   - consumed guest_query_id → reject (Telegram would refuse anyway;
//     we keep the tombstone until TTL so the error is clear, not cryptic)
//   - expired entry           → reject (Telegram queries go stale; we
//     mirror that with a conservative local TTL)
//
// In-memory only: a plugin restart drops pending queries. That is
// acceptable — the query would not survive the restart round-trip anyway,
// and persisting one-shot reply capabilities to disk would only widen the
// replay surface.

export interface GuestQueryEntry {
  guestQueryId: string
  callerUserId: string
  callerChatId: string | undefined
  messageText: string
  createdAtMs: number
  consumed: boolean
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
// queries: sweep() prunes expired entries on every mutation and the cap
// below drops the oldest entry when exceeded (the oldest is the most
// likely to already be stale on Telegram's side too).
const MAX_ENTRIES = 64

export class GuestQueryRegistry {
  private entries = new Map<string, GuestQueryEntry>()

  constructor(
    private readonly ttlMs: number = GUEST_QUERY_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  register(input: {
    guestQueryId: string
    callerUserId: string
    callerChatId?: string
    messageText: string
  }): void {
    this.sweep()
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    this.entries.set(input.guestQueryId, {
      guestQueryId: input.guestQueryId,
      callerUserId: input.callerUserId,
      callerChatId: input.callerChatId,
      messageText: input.messageText,
      createdAtMs: this.now(),
      consumed: false,
    })
  }

  // One-shot claim: marks the entry consumed atomically with the check so
  // two concurrent reply calls cannot both pass. The entry stays in the
  // map as a tombstone until TTL so the second caller gets 'consumed'
  // instead of the less-actionable 'unknown'. No sweep() here — the TTL
  // check below must SEE the stale entry to report the actionable
  // 'expired' (sweeping first would collapse it into 'unknown').
  claim(guestQueryId: string): GuestQueryClaim {
    const entry = this.entries.get(guestQueryId)
    if (entry === undefined) return { kind: 'unknown' }
    if (entry.consumed) return { kind: 'consumed' }
    if (this.now() - entry.createdAtMs > this.ttlMs) {
      this.entries.delete(guestQueryId)
      return { kind: 'expired' }
    }
    entry.consumed = true
    return { kind: 'ok', entry }
  }

  // Un-consume after a failed Telegram send so the agent may retry.
  // No-op for unknown ids (entry may have been swept meanwhile).
  release(guestQueryId: string): void {
    const entry = this.entries.get(guestQueryId)
    if (entry !== undefined) entry.consumed = false
  }

  pendingCount(): number {
    this.sweep()
    let n = 0
    for (const e of this.entries.values()) if (!e.consumed) n++
    return n
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [id, entry] of this.entries) {
      if (entry.createdAtMs < cutoff) this.entries.delete(id)
    }
  }
}
