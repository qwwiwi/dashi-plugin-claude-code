// Last stage of the server shutdown: wait for every asynchronous step (poller,
// webhook listener, status card drain), then stop the bot and exit. A step
// that rejects never skips the bot stop or the exit. The caller keeps its own
// hard deadline (a timer that exits regardless), so nothing here can hang the
// process for good.

export interface ShutdownSequenceOptions {
  steps: ReadonlyArray<Promise<unknown>>
  stopBot: () => unknown
  exit: () => void
}

export async function runShutdownSequence(opts: ShutdownSequenceOptions): Promise<void> {
  try {
    await Promise.allSettled(opts.steps)
    await Promise.resolve(opts.stopBot())
  } finally {
    opts.exit()
  }
}
