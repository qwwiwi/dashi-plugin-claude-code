// Rich-message capability latch.
//
// A tiny per-process holder of two kill-switches:
//   - sendDisabled  : flipped ON when a rich send fails with a `capability`
//                     class error (Telegram / this grammY build can't do
//                     sendRichMessage). Once latched, the safe wrapper
//                     short-circuits every subsequent rich attempt to the
//                     HTML fallback WITHOUT hitting Telegram again — so a
//                     missing method costs exactly one failed call per
//                     session, not one per reply.
//   - draftDisabled : reserved for M3 (streaming rich drafts). Declared now
//                     so the latch shape is stable; M1 never sets it.
//
// Process-local, mutable, not persisted: a restart re-probes capability,
// which is correct — Telegram may roll the method out between restarts.

export interface RichLatch {
  sendDisabled: boolean
  draftDisabled: boolean
  setSendDisabled(value: boolean): void
  setDraftDisabled(value: boolean): void
}

/**
 * Create a fresh rich latch with both switches OFF. One instance per
 * process is shared by the safe-telegram-api wrapper (writer on capability
 * failure) and the reply tool (reader to skip rich attempts cheaply).
 */
export function createRichLatch(): RichLatch {
  return {
    sendDisabled: false,
    draftDisabled: false,
    setSendDisabled(value: boolean): void {
      this.sendDisabled = value
    },
    setDraftDisabled(value: boolean): void {
      this.draftDisabled = value
    },
  }
}
