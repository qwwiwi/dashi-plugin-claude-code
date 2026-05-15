// Album buffer for Telegram media-group albums.
//
// Telegram delivers each photo/video/document of an album as a SEPARATE
// update, all sharing the same `media_group_id`. Without buffering, the
// agent would see one channel notification per item: the first photo
// would start a turn before the second item even arrives. This buffer
// collects items per-mgid for `flushMs` of silence, then fires `onFlush`
// with the full ordered list so the handler can emit ONE combined channel
// notification per album.
//
// Behaviour mirrors gateway.py:3154-3234 (`_buffer_media_group` +
// `_flush_media_group`, MEDIA_GROUP_FLUSH_SEC = 0.7s there; this plugin
// uses 2s by default per config.album.flush_ms — more forgiving for slow
// mobile uploads).
//
// Time + timers are injectable so unit tests can drive the buffer without
// touching real wall-clock or setTimeout. Use the `setTimer` / `clearTimer`
// factories from the test harness for deterministic flushes.

export interface Album<TMessage> {
  mediaGroupId: string
  /** In insertion order — Telegram delivers album items strictly in the
   * order the sender uploaded them. We never reorder. */
  messages: TMessage[]
  /** Wall-clock ms when the first message of this album was pushed. */
  firstAt: number
  /** Wall-clock ms when the most recent message of this album was pushed. */
  lastAt: number
}

export type TimerFactory = (cb: () => void, ms: number) => NodeJS.Timeout
export type TimerCancel = (handle: NodeJS.Timeout) => void

export interface AlbumBufferOptions {
  /** Silence window in ms. When no new message arrives for this long, the
   *  album flushes. Reset on every push to the same mgid. */
  flushMs: number
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number
  /** Injectable timer factory for tests. Defaults to setTimeout. */
  setTimer?: TimerFactory
  /** Injectable timer canceller for tests. Defaults to clearTimeout. */
  clearTimer?: TimerCancel
}

interface Entry<TMessage> {
  messages: TMessage[]
  firstAt: number
  lastAt: number
  timer: NodeJS.Timeout | null
  /** Captured at first push so flush can call back into the right handler.
   *  push() in the gateway is per-mgid; the first onFlush wins — subsequent
   *  pushes against the same mgid keep the original callback (the handler
   *  is stable per-album because the buffer key already discriminates). */
  onFlush: (album: Album<TMessage>) => void
}

export class AlbumBuffer<TMessage> {
  private readonly flushMs: number
  private readonly now: () => number
  private readonly setTimer: TimerFactory
  private readonly clearTimer: TimerCancel
  private readonly entries: Map<string, Entry<TMessage>> = new Map()

  constructor(options: AlbumBufferOptions) {
    this.flushMs = options.flushMs
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h))
  }

  /**
   * Append `message` to the buffer for `mediaGroupId`. On the first push
   * for a given mgid, create the entry and arm a flush timer at `flushMs`.
   * On subsequent pushes, append, refresh lastAt, and re-arm the timer —
   * so the album flushes only after `flushMs` of complete silence.
   *
   * `onFlush` is captured from the FIRST push for this mgid. Subsequent
   * pushes ignore their `onFlush` argument (the album is one logical unit;
   * the destination is stable).
   */
  push(
    mediaGroupId: string,
    message: TMessage,
    onFlush: (album: Album<TMessage>) => void,
  ): void {
    const ts = this.now()
    const existing = this.entries.get(mediaGroupId)
    if (existing) {
      existing.messages.push(message)
      existing.lastAt = ts
      if (existing.timer !== null) {
        this.clearTimer(existing.timer)
      }
      existing.timer = this.armTimer(mediaGroupId)
      return
    }
    const entry: Entry<TMessage> = {
      messages: [message],
      firstAt: ts,
      lastAt: ts,
      timer: null,
      onFlush,
    }
    this.entries.set(mediaGroupId, entry)
    entry.timer = this.armTimer(mediaGroupId)
  }

  /**
   * Force-flush a specific album. Cancels any pending timer, removes the
   * entry from the buffer, and returns the assembled Album. Does NOT call
   * `onFlush` — caller decides whether to dispatch (used by flushAll and
   * by callers that want the raw album payload).
   * Returns null if no entry exists for `mediaGroupId`.
   */
  flush(mediaGroupId: string): Album<TMessage> | null {
    const entry = this.entries.get(mediaGroupId)
    if (!entry) return null
    if (entry.timer !== null) {
      this.clearTimer(entry.timer)
      entry.timer = null
    }
    this.entries.delete(mediaGroupId)
    return {
      mediaGroupId,
      messages: entry.messages,
      firstAt: entry.firstAt,
      lastAt: entry.lastAt,
    }
  }

  /**
   * Flush every buffered album immediately. Cancels all timers, clears
   * internal state, and returns the assembled Albums (insertion order of
   * mgids). Intended for shutdown / drain — caller decides whether to
   * dispatch each one synchronously or skip.
   */
  flushAll(): Album<TMessage>[] {
    const out: Album<TMessage>[] = []
    for (const mgid of Array.from(this.entries.keys())) {
      const album = this.flush(mgid)
      if (album) out.push(album)
    }
    return out
  }

  // Internal: build and start a flush timer for `mediaGroupId`. When the
  // timer fires the entry (if still present) is removed and its onFlush
  // is invoked with the assembled Album. If push() re-armed the timer in
  // the meantime, the old handle has already been cancelled — this callback
  // belongs to the latest arm.
  private armTimer(mediaGroupId: string): NodeJS.Timeout {
    return this.setTimer(() => {
      const entry = this.entries.get(mediaGroupId)
      if (!entry) return
      this.entries.delete(mediaGroupId)
      entry.timer = null
      const album: Album<TMessage> = {
        mediaGroupId,
        messages: entry.messages,
        firstAt: entry.firstAt,
        lastAt: entry.lastAt,
      }
      try {
        entry.onFlush(album)
      } catch {
        // Swallow — buffer state is already cleared. Caller errors must
        // not leave the buffer in an inconsistent state for future mgids.
      }
    }, this.flushMs)
  }
}
