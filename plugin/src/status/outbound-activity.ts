// OutboundActivityTracker — the single in-memory record of "when did we last
// send the owner a NEW message on this chat".
//
// Why (2026-07-10 communication audit): the mechanical heartbeat (item 2) and
// the dead-man alert need one honest answer to "how long has the owner heard
// nothing?". The reliable-telegram-api wrapper is the choke point every
// outbound send flows through, so it stamps this tracker on each SUCCESSFUL
// NEW-message send (sendMessage / sendRichMessage / sendDocument / sendPhoto).
//
// Deliberately NOT stamped on editMessageText: an edit does not ping the user
// and the HUD/task-mirror re-edit their pins every ~20s — counting those as
// "outbound" would reset the heartbeat window on every tick and it would never
// fire. Only a fresh message the owner's device could surface counts.
//
// In-memory only (persistence not required — a restart resets the window,
// which is the safe direction: it delays a heartbeat rather than firing a
// spurious one). No timers, no I/O — a plain Map with a clock-injectable write.

/** Read side consumed by the heartbeat monitor. */
export interface OutboundActivityReader {
  /** Epoch-ms of the last new-message send to `chatId`, or undefined if none. */
  lastOutboundAt(chatId: string): number | undefined
}

/** Write side consumed by the reliable-telegram-api wrapper. */
export interface OutboundActivityRecorder {
  /** Stamp `chatId`'s last-outbound clock. Idempotent, monotonic-latest. */
  record(chatId: string, atMs: number): void
}

export class OutboundActivityTracker
  implements OutboundActivityReader, OutboundActivityRecorder
{
  private readonly lastAt = new Map<string, number>()

  record(chatId: string, atMs: number): void {
    // Monotonic-latest: never move the clock backwards (a late-completing send
    // must not undo a newer one's stamp).
    const prev = this.lastAt.get(chatId)
    if (prev === undefined || atMs > prev) this.lastAt.set(chatId, atMs)
  }

  lastOutboundAt(chatId: string): number | undefined {
    return this.lastAt.get(chatId)
  }
}
