// Phase 8 — shared intra-process async mutex.
//
// Extracted from hot-writer.ts so verbose-writer can share the exact same
// primitive without duplicating the class. Underscore prefix marks this
// module as internal to the memory/ barrel; callers outside memory/ should
// not import it directly.

/**
 * Async mutex. Each instance serialises async callers — `run()` awaits
 * the previous holder before invoking `fn` and only releases when `fn`
 * settles (success or throw).
 */
export class Mutex {
  private p: Promise<void> = Promise.resolve()
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.p
    let release!: () => void
    this.p = new Promise<void>((r) => {
      release = r
    })
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

/**
 * In-process async mutex registry keyed by absolute file path.
 * Single-writer-per-process invariant: the map grows only when callers
 * pass distinct paths (in production, exactly one per plugin process).
 * Tests using mkdtemp may grow the map within a single run — acceptable
 * because test processes are short-lived.
 */
const locks = new Map<string, Mutex>()

export function lockFor(path: string): Mutex {
  let m = locks.get(path)
  if (!m) {
    m = new Mutex()
    locks.set(path, m)
  }
  return m
}
