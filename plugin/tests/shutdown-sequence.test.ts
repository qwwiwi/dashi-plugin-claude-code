// Server shutdown must wait for the status card drain together with the other
// shutdown steps (inside the existing hard deadline), before the bot stops.

import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

interface Seq {
  runShutdownSequence: (o: { steps: Array<Promise<unknown>>; stopBot: () => unknown; exit: () => void }) => Promise<void>
}

async function load(): Promise<Seq> {
  return (await import('../src/shutdown-sequence.js')) as unknown as Seq
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('shutdown sequence', () => {
  test('exit is not called before the widget drain settles', async () => {
    const { runShutdownSequence } = await load()
    const order: string[] = []
    const widget = deferred<{ drained: boolean }>()
    const done = runShutdownSequence({
      steps: [Promise.resolve(), Promise.resolve(), widget.promise],
      stopBot: () => order.push('bot'),
      exit: () => order.push('exit'),
    })
    await tick()
    expect(order).toEqual([])
    widget.resolve({ drained: true })
    await done
    expect(order).toEqual(['bot', 'exit'])
  })

  test('a rejected step does not skip the bot stop or the exit', async () => {
    const { runShutdownSequence } = await load()
    const order: string[] = []
    await runShutdownSequence({
      steps: [Promise.reject(new Error('poller failed'))],
      stopBot: () => order.push('bot'),
      exit: () => order.push('exit'),
    })
    expect(order).toEqual(['bot', 'exit'])
  })

  test('server.ts hands the widget stop promise to the sequence', () => {
    const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/runShutdownSequence\(/)
    expect(src).toMatch(/=\s*statusWidget\?\.stop\(\)/)
  })
})
