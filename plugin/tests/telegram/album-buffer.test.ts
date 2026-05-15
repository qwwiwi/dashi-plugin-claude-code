import { describe, expect, test } from 'bun:test'

import {
  AlbumBuffer,
  type Album,
  type TimerCancel,
  type TimerFactory,
} from '../../src/telegram/album-buffer.js'

// ─────────────────────────────────────────────────────────────────────
// Fake timer harness.
//
// AlbumBuffer is timer-driven: a flush only happens after `flushMs` of
// silence. Real timers in unit tests are flaky AND slow, so we drive an
// in-process clock via `setTimer` / `clearTimer` injection. `tick(ms)`
// advances the clock and fires every timer whose deadline has passed.
// ─────────────────────────────────────────────────────────────────────

interface FakeTimerHandle {
  id: number
  cb: () => void
  fireAt: number
  cancelled: boolean
}

function makeClock(): {
  now: () => number
  setTimer: TimerFactory
  clearTimer: TimerCancel
  tick: (ms: number) => void
  pending: () => number
} {
  let current = 0
  let nextId = 1
  const timers = new Map<number, FakeTimerHandle>()

  const now = () => current
  const setTimer: TimerFactory = (cb, ms) => {
    const id = nextId++
    const handle: FakeTimerHandle = { id, cb, fireAt: current + ms, cancelled: false }
    timers.set(id, handle)
    // The plugin code only treats the return value as opaque — we cast
    // through unknown so the structural NodeJS.Timeout requirement is
    // satisfied without pulling in real node:timers.
    return (id as unknown) as NodeJS.Timeout
  }
  const clearTimer: TimerCancel = (h) => {
    const id = (h as unknown) as number
    const handle = timers.get(id)
    if (handle) {
      handle.cancelled = true
      timers.delete(id)
    }
  }
  const tick = (ms: number): void => {
    const target = current + ms
    // Fire timers in deadline order, advancing current as we go. New
    // timers scheduled inside a callback are picked up on subsequent
    // iterations of the outer loop.
    for (;;) {
      const due = Array.from(timers.values())
        .filter((t) => !t.cancelled && t.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt)
      if (due.length === 0) break
      const next = due[0]!
      current = next.fireAt
      timers.delete(next.id)
      next.cb()
    }
    current = target
  }
  const pending = () => timers.size
  return { now, setTimer, clearTimer, tick, pending }
}

interface FakeMessage {
  id: number
  caption: string
}

function makeBuffer(flushMs = 2000): {
  buffer: AlbumBuffer<FakeMessage>
  clock: ReturnType<typeof makeClock>
  flushed: Album<FakeMessage>[]
} {
  const clock = makeClock()
  const flushed: Album<FakeMessage>[] = []
  const buffer = new AlbumBuffer<FakeMessage>({
    flushMs,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  return { buffer, clock, flushed }
}

describe('AlbumBuffer', () => {
  test('buffers messages with the same media_group_id', () => {
    const { buffer, clock, flushed } = makeBuffer(2000)
    buffer.push('mg1', { id: 1, caption: 'a' }, (album) => flushed.push(album))
    buffer.push('mg1', { id: 2, caption: 'b' }, (album) => flushed.push(album))
    buffer.push('mg1', { id: 3, caption: 'c' }, (album) => flushed.push(album))

    // No silence yet — nothing flushed.
    clock.tick(1000)
    expect(flushed).toHaveLength(0)

    // 2s of silence after the last push → flush.
    clock.tick(2000)
    expect(flushed).toHaveLength(1)
    expect(flushed[0]?.messages.map((m) => m.id)).toEqual([1, 2, 3])
    expect(flushed[0]?.mediaGroupId).toBe('mg1')
  })

  test('flushes once after two seconds of silence', () => {
    const { buffer, clock, flushed } = makeBuffer(2000)
    buffer.push('mg1', { id: 1, caption: '' }, (album) => flushed.push(album))

    clock.tick(1999) // one tick short of the silence window
    expect(flushed).toHaveLength(0)

    clock.tick(1)
    expect(flushed).toHaveLength(1)

    // Subsequent ticks must not double-fire.
    clock.tick(10_000)
    expect(flushed).toHaveLength(1)
  })

  test('preserves message order in flushed album', () => {
    const { buffer, clock, flushed } = makeBuffer(500)
    const ids = [10, 20, 30, 40, 50]
    for (const id of ids) {
      buffer.push('order-mg', { id, caption: `cap-${id}` }, (a) => flushed.push(a))
      clock.tick(100) // each push within the silence window
    }
    clock.tick(500)
    expect(flushed).toHaveLength(1)
    expect(flushed[0]?.messages.map((m) => m.id)).toEqual(ids)
    expect(flushed[0]?.messages.map((m) => m.caption)).toEqual([
      'cap-10',
      'cap-20',
      'cap-30',
      'cap-40',
      'cap-50',
    ])
  })

  test('merges non-empty captions with blank lines (handler-level contract: order preserved)', () => {
    // The actual blank-line merging happens in handlers.ts/sendAlbumNotification.
    // The buffer's job is to preserve message order and present every caption
    // so the handler can `.filter(c => c.length > 0).join('\n\n')`.
    const { buffer, clock, flushed } = makeBuffer(1000)
    buffer.push('cap-mg', { id: 1, caption: 'hello' }, (a) => flushed.push(a))
    buffer.push('cap-mg', { id: 2, caption: '' }, (a) => flushed.push(a))
    buffer.push('cap-mg', { id: 3, caption: 'world' }, (a) => flushed.push(a))
    clock.tick(1000)

    expect(flushed).toHaveLength(1)
    const captions = flushed[0]!.messages.map((m) => m.caption)
    expect(captions).toEqual(['hello', '', 'world'])
    // Handler does: captions.filter(c => c.length > 0).join('\n\n')
    const merged = captions.filter((c) => c.length > 0).join('\n\n')
    expect(merged).toBe('hello\n\nworld')
  })

  test('separates albums by media_group_id', () => {
    const { buffer, clock, flushed } = makeBuffer(1000)
    buffer.push('mg-a', { id: 1, caption: 'a1' }, (a) => flushed.push(a))
    buffer.push('mg-b', { id: 100, caption: 'b1' }, (a) => flushed.push(a))
    buffer.push('mg-a', { id: 2, caption: 'a2' }, (a) => flushed.push(a))
    buffer.push('mg-b', { id: 101, caption: 'b2' }, (a) => flushed.push(a))

    clock.tick(1000)
    // Both albums flush after 1s silence.
    expect(flushed).toHaveLength(2)
    const byMgid = new Map(flushed.map((a) => [a.mediaGroupId, a]))
    expect(byMgid.get('mg-a')?.messages.map((m) => m.id)).toEqual([1, 2])
    expect(byMgid.get('mg-b')?.messages.map((m) => m.id)).toEqual([100, 101])
  })

  test('flushAll returns and clears pending albums on shutdown', () => {
    const { buffer, clock } = makeBuffer(2000)
    const callbacks: Album<FakeMessage>[] = []
    buffer.push('mg-x', { id: 1, caption: 'x1' }, (a) => callbacks.push(a))
    buffer.push('mg-x', { id: 2, caption: 'x2' }, (a) => callbacks.push(a))
    buffer.push('mg-y', { id: 10, caption: 'y1' }, (a) => callbacks.push(a))

    const drained = buffer.flushAll()
    expect(drained).toHaveLength(2)
    const byMgid = new Map(drained.map((a) => [a.mediaGroupId, a]))
    expect(byMgid.get('mg-x')?.messages.map((m) => m.id)).toEqual([1, 2])
    expect(byMgid.get('mg-y')?.messages.map((m) => m.id)).toEqual([10])

    // flushAll does NOT call onFlush callbacks — caller decides delivery.
    expect(callbacks).toHaveLength(0)

    // Timers are cancelled — advancing the clock fires nothing.
    clock.tick(10_000)
    expect(callbacks).toHaveLength(0)

    // Pending timers gone.
    expect(clock.pending()).toBe(0)

    // Buffer state cleared — a fresh push for the same mgid starts a new album.
    buffer.push('mg-x', { id: 99, caption: 'fresh' }, (a) => callbacks.push(a))
    clock.tick(2000)
    expect(callbacks).toHaveLength(1)
    expect(callbacks[0]?.messages.map((m) => m.id)).toEqual([99])
  })

  test('push resets silence timer when new message arrives within window', () => {
    const { buffer, clock, flushed } = makeBuffer(2000)
    buffer.push('mg-reset', { id: 1, caption: '' }, (a) => flushed.push(a))

    // 1.5s in, push another message — silence window must reset.
    clock.tick(1500)
    expect(flushed).toHaveLength(0)
    buffer.push('mg-reset', { id: 2, caption: '' }, (a) => flushed.push(a))

    // 1.5s after the second push (= 3.0s wall-clock since first push) —
    // would have flushed at 2.0s if the timer had NOT reset. Verify silence.
    clock.tick(1500)
    expect(flushed).toHaveLength(0)

    // Push another, again within window.
    buffer.push('mg-reset', { id: 3, caption: '' }, (a) => flushed.push(a))
    clock.tick(1999)
    expect(flushed).toHaveLength(0)

    // Now the full 2s elapses past the last push → flush, in order.
    clock.tick(1)
    expect(flushed).toHaveLength(1)
    expect(flushed[0]?.messages.map((m) => m.id)).toEqual([1, 2, 3])
  })

  test('flush(mgid) force-flushes a specific album without firing onFlush', () => {
    const { buffer, clock, flushed } = makeBuffer(2000)
    buffer.push('mg-force', { id: 1, caption: 'x' }, (a) => flushed.push(a))
    buffer.push('mg-force', { id: 2, caption: 'y' }, (a) => flushed.push(a))

    const album = buffer.flush('mg-force')
    expect(album).not.toBeNull()
    expect(album!.messages.map((m) => m.id)).toEqual([1, 2])

    // onFlush callback is NOT invoked by flush() — caller takes the payload.
    expect(flushed).toHaveLength(0)

    // Timer cancelled.
    clock.tick(10_000)
    expect(flushed).toHaveLength(0)

    // Re-flushing the same mgid returns null.
    expect(buffer.flush('mg-force')).toBeNull()
  })

  test('flush(unknown) returns null', () => {
    const { buffer } = makeBuffer()
    expect(buffer.flush('never-existed')).toBeNull()
  })
})
