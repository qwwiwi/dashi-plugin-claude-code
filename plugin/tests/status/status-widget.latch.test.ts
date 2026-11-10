// Status card service: the uncertain-send latch (B1) and the stop lifecycle (B3).
//
// Persisted state machine: EMPTY / TRACKED / UNCERTAIN. A pending attempt is
// persisted BEFORE every send; only a confirmed non-delivery restores the
// earlier record, anything ambiguous keeps the latch until `/card`.

import { describe, expect, test } from 'bun:test'

import {
  CHAT,
  DRAIN_MS,
  STATE_A,
  STATE_B,
  deferred,
  httpError,
  latchedRecord,
  makeRig,
  ok,
  settle,
  sysError,
  trackedRecord,
  type TestRecord,
} from './helpers/widget-rig.js'

function isEmptyRecord(rec: TestRecord | undefined): boolean {
  return rec === undefined || (rec.messageId === null && rec.pending === null)
}

describe('B1: pending attempt is persisted before every send', () => {
  test('latch before dispatch: the pending record exists inside the API call', async () => {
    const rig = makeRig()
    let seen: TestRecord | undefined
    rig.sendImpl = async () => {
      seen = structuredClone(rig.record)
      rig.delivered += 1
      return { message_id: 500 }
    }
    rig.results.push(ok(STATE_A))
    await rig.svc.tick()
    expect(seen?.pending).toBeTruthy()
    expect(seen?.pending?.attemptId.length).toBeGreaterThan(8)
    expect(seen?.pending?.startedAt).toBe(rig.now)
    // Confirmed success: tracked, pending cleared.
    expect(rig.record).toEqual({ version: 1, chatId: CHAT, messageId: 500, pending: null })
  })

  test('delivered but the response is lost: two ticks deliver ONE card', async () => {
    const rig = makeRig()
    rig.sendImpl = async () => {
      rig.delivered += 1
      throw sysError('ECONNRESET', 'read ECONNRESET')
    }
    rig.results.push(ok(STATE_A), ok(STATE_A))
    await rig.svc.tick()
    await rig.svc.tick()
    expect(rig.delivered).toBe(1)
  })

  test('restart with a persisted pending attempt: zero automatic work', async () => {
    const rig = makeRig({ record: latchedRecord() })
    rig.results.push(ok(STATE_A))
    await rig.svc.tick()
    expect(rig.sends).toHaveLength(0)
    expect(rig.edits).toHaveLength(0)
    expect(rig.runs).toHaveLength(0)
  })

  test('restart after an ambiguous send keeps the latch', async () => {
    const rig = makeRig()
    rig.sendImpl = async () => {
      rig.delivered += 1
      throw sysError('ECONNRESET', 'read ECONNRESET')
    }
    rig.results.push(ok(STATE_A), ok(STATE_A))
    await rig.svc.tick()
    const restarted = rig.build()
    await restarted.tick()
    expect(rig.delivered).toBe(1)
    expect(rig.runs).toHaveLength(1)
  })

  test('no expiry: a year later the latch still blocks every automatic send', async () => {
    const rig = makeRig({ record: latchedRecord() })
    rig.now += 365 * 24 * 3600 * 1000
    rig.results.push(ok(STATE_A))
    await rig.svc.tick()
    expect(rig.sends).toHaveLength(0)
    expect(rig.runs).toHaveLength(0)
  })

  const uncertain: Array<[string, () => Promise<{ message_id: number }>]> = [
    ['HTTP 502', async () => Promise.reject(httpError(502, 'Bad Gateway'))],
    ['AbortError', async () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))],
    ['generic error', async () => Promise.reject(new Error('boom'))],
    ['malformed success without a message id', async () => ({}) as unknown as { message_id: number }],
    ['non-positive message id', async () => ({ message_id: 0 })],
  ]
  for (const [name, impl] of uncertain) {
    test(`${name} stays UNCERTAIN; the next tick sends nothing`, async () => {
      const rig = makeRig()
      rig.sendImpl = impl
      rig.results.push(ok(STATE_A), ok(STATE_A))
      await rig.svc.tick()
      expect(rig.record?.pending).toBeTruthy()
      const runsAfterFirst = rig.runs.length
      let calls = 0
      rig.sendImpl = async () => {
        calls += 1
        return { message_id: 1 }
      }
      await rig.svc.tick()
      expect(calls).toBe(0)
      expect(rig.runs).toHaveLength(runsAfterFirst)
    })
  }

  const rejected: Array<[string, () => Error | Promise<Error>]> = [
    ['connect failure (ECONNREFUSED)', () => sysError('ECONNREFUSED', 'connect ECONNREFUSED')],
    ['DNS failure (ENOTFOUND)', () => sysError('ENOTFOUND', 'getaddrinfo ENOTFOUND api.telegram.org')],
    ['HTTP 400', () => httpError(400, 'Bad Request: chat not found')],
    ['HTTP 403', () => httpError(403, 'Forbidden: bot was blocked')],
    ['HTTP 429', () => Object.assign(httpError(429, 'Too Many Requests'), { parameters: { retry_after: 3 } })],
    [
      'typed local validation refusal',
      async () => {
        const { WidgetPreSendError } = await import('../../src/safety/pre-send-error.js')
        return new WidgetPreSendError('chat_data looks like it contains a secret')
      },
    ],
  ]
  for (const [name, make] of rejected) {
    test(`confirmed non-delivery (${name}) restores the pre-attempt record`, async () => {
      const rig = makeRig()
      let seen: TestRecord | undefined
      const err = await make()
      rig.sendImpl = async () => {
        seen = structuredClone(rig.record)
        throw err
      }
      rig.results.push(ok(STATE_A), ok(STATE_A))
      await rig.svc.tick()
      expect(seen?.pending).toBeTruthy()
      expect(isEmptyRecord(rig.record)).toBe(true)
      // Not latched: the next tick tries again.
      let calls = 0
      rig.sendImpl = async () => {
        calls += 1
        return { message_id: 501 }
      }
      await rig.svc.tick()
      expect(calls).toBe(1)
    })
  }

  test('a rejected manual replacement restores the previous TRACKED record exactly', async () => {
    const rig = makeRig({ record: trackedRecord(4242) })
    let seen: TestRecord | undefined
    rig.sendImpl = async () => {
      seen = structuredClone(rig.record)
      throw httpError(400, 'Bad Request')
    }
    rig.results.push(ok(STATE_A))
    await rig.svc.sendFresh(CHAT)
    expect(seen?.pending).toBeTruthy()
    expect(seen?.messageId).toBe(4242)
    expect(rig.record).toEqual(trackedRecord(4242))
  })
})

describe('B1: /card is the explicit recovery', () => {
  test('manual recovery: pending is overwritten, success clears it, automation resumes', async () => {
    const rig = makeRig({ record: latchedRecord() })
    let seen: TestRecord | undefined
    rig.sendImpl = async () => {
      seen = structuredClone(rig.record)
      rig.delivered += 1
      return { message_id: 700 }
    }
    rig.results.push(ok(STATE_A), ok(STATE_B))
    const res = await rig.svc.sendFresh(CHAT)
    expect(res).toEqual({ ok: true })
    expect(seen?.pending).toBeTruthy()
    expect(seen?.pending?.attemptId).not.toBe('attempt-old')
    expect(rig.record).toEqual(trackedRecord(700))
    await rig.svc.tick()
    expect(rig.edits).toEqual([{ chatId: CHAT, messageId: 700, chatData: JSON.stringify(STATE_B) }])
  })

  test('the latch is overwritten atomically: no write ever clears it first', async () => {
    const rig = makeRig({ record: latchedRecord() })
    rig.results.push(ok(STATE_A))
    await rig.svc.sendFresh(CHAT)
    expect(rig.clears).toBe(0)
    expect(rig.saves.every((r) => r.pending !== null || r.messageId !== null)).toBe(true)
  })

  test('a failed manual recovery (400) restores the earlier uncertainty; automation stays blocked', async () => {
    const prior = latchedRecord()
    const rig = makeRig({ record: prior })
    rig.sendImpl = async () => {
      throw httpError(400, 'Bad Request')
    }
    rig.results.push(ok(STATE_A), ok(STATE_A))
    const res = await rig.svc.sendFresh(CHAT)
    expect(res.ok).toBe(false)
    expect(rig.record).toEqual(prior)
    const runs = rig.runs.length
    let calls = 0
    rig.sendImpl = async () => {
      calls += 1
      return { message_id: 1 }
    }
    await rig.svc.tick()
    expect(calls).toBe(0)
    expect(rig.runs).toHaveLength(runs)
  })

  test('an ambiguous manual replacement relatches and the reply says so', async () => {
    const rig = makeRig({ record: latchedRecord() })
    rig.sendImpl = async () => {
      throw sysError('ECONNRESET', 'read ECONNRESET')
    }
    rig.results.push(ok(STATE_A))
    const res = await rig.svc.sendFresh(CHAT)
    expect(res.ok).toBe(false)
    expect(res.ok === false && 'uncertain' in res && res.uncertain).toBe(true)
    expect(rig.record?.pending).toBeTruthy()
  })

  test('corrupt state blocks automation and is never read as empty; /card recovers', async () => {
    const rig = makeRig({ corrupt: true })
    rig.results.push(ok(STATE_A), ok(STATE_A))
    await rig.svc.tick()
    expect(rig.sends).toHaveLength(0)
    expect(rig.runs).toHaveLength(0)
    const res = await rig.svc.sendFresh(CHAT)
    expect(res).toEqual({ ok: true })
    expect(rig.record).toEqual(trackedRecord(500))
  })
})

describe('B1: persistence failures are never swallowed', () => {
  test('a failing pre-send write means the API is never called and automation is blocked', async () => {
    const rig = makeRig()
    rig.failSave = (rec) => rec.pending !== null
    rig.results.push(ok(STATE_A), ok(STATE_A))
    await rig.svc.tick()
    await rig.svc.tick()
    expect(rig.delivered).toBe(0)
    expect(rig.warns.concat(rig.errors).length).toBeGreaterThan(0)
  })

  test('delivered but the tracking write fails: a restart sends no replacement', async () => {
    const rig = makeRig()
    rig.failSave = (rec) => rec.pending === null && rec.messageId !== null
    rig.results.push(ok(STATE_A), ok(STATE_A))
    await rig.svc.tick()
    expect(rig.delivered).toBe(1)
    rig.failSave = undefined
    const restarted = rig.build()
    await restarted.tick()
    expect(rig.delivered).toBe(1)
  })

  test('a failing tracking write blocks further automatic work in the same process', async () => {
    const rig = makeRig()
    rig.failSave = (rec) => rec.pending === null && rec.messageId !== null
    rig.results.push(ok(STATE_A), ok(STATE_B))
    await rig.svc.tick()
    const runs = rig.runs.length
    await rig.svc.tick()
    expect(rig.runs).toHaveLength(runs)
    expect(rig.edits).toHaveLength(0)
  })
})

describe('B3: stop() is terminal', () => {
  test('stop while the producer runs: its signal is aborted and nothing is sent', async () => {
    const rig = makeRig()
    const gate = deferred<ReturnType<typeof ok>>()
    rig.runnerImpl = () => gate.promise
    const tickDone = rig.svc.tick()
    await settle()
    const stopP = rig.svc.stop()
    expect(rig.runs[0]?.opts.signal?.aborted).toBe(true)
    gate.resolve(ok(STATE_A))
    await tickDone
    await stopP
    expect(rig.sends).toHaveLength(0)
    expect(rig.edits).toHaveLength(0)
    expect(rig.record).toBeUndefined()
  })

  test('stop while the producer runs also prevents an edit of a tracked card', async () => {
    const rig = makeRig({ record: trackedRecord(4242) })
    const gate = deferred<ReturnType<typeof ok>>()
    rig.runnerImpl = () => gate.promise
    const tickDone = rig.svc.tick()
    await settle()
    const stopP = rig.svc.stop()
    gate.resolve(ok(STATE_A))
    await tickDone
    await stopP
    expect(rig.edits).toHaveLength(0)
  })

  test('queued /card and future requests settle as stopped without another producer run', async () => {
    const rig = makeRig()
    const gate = deferred<ReturnType<typeof ok>>()
    rig.runnerImpl = () => gate.promise
    const first = rig.svc.tick()
    await settle()
    const queued = rig.svc.sendFresh(CHAT)
    const queuedTick = rig.svc.tick()
    const stopP = rig.svc.stop()
    const queuedRes = await queued
    expect(queuedRes.ok).toBe(false)
    await queuedTick
    expect(rig.runs).toHaveLength(1)
    gate.resolve(ok(STATE_A))
    await first
    await stopP
    // Future requests.
    const later = await rig.svc.sendFresh(CHAT)
    expect(later.ok).toBe(false)
    await rig.svc.tick()
    expect(rig.runs).toHaveLength(1)
    expect(rig.sends).toHaveLength(0)
  })

  test('stop is idempotent: the same promise, one drain', async () => {
    const rig = makeRig()
    const a = rig.svc.stop()
    const b = rig.svc.stop()
    expect(a).toBe(b)
    expect(await a).toEqual({ drained: true })
  })

  test('start() never reopens a stopped instance', async () => {
    const rig = makeRig()
    await rig.svc.stop()
    rig.svc.start()
    rig.results.push(ok(STATE_A))
    await rig.fire()
    expect(rig.delays).toEqual([])
    expect(rig.sends).toHaveLength(0)
  })

  test('a send already invoked completes its persistence; stop waits for it', async () => {
    const rig = makeRig()
    const gate = deferred<{ message_id: number }>()
    rig.sendImpl = () => gate.promise
    rig.results.push(ok(STATE_A))
    const tickDone = rig.svc.tick()
    await settle()
    let stopped = false
    const stopP = Promise.resolve(rig.svc.stop()).then((r) => {
      stopped = true
      return r
    })
    await settle()
    expect(stopped).toBe(false)
    expect(rig.record?.pending).toBeTruthy()
    gate.resolve({ message_id: 900 })
    await tickDone
    expect(await stopP).toEqual({ drained: true })
    expect(rig.record).toEqual(trackedRecord(900))
  })

  test('drain deadline: stop reports undrained after 1500 ms and a restart stays latched', async () => {
    const rig = makeRig()
    const never = deferred<{ message_id: number }>()
    rig.sendImpl = () => never.promise
    rig.results.push(ok(STATE_A), ok(STATE_A))
    void rig.svc.tick()
    await settle()
    const stopP = Promise.resolve(rig.svc.stop())
    expect(rig.drainTimerSet()).toBe(true)
    rig.fireDrain()
    expect(await stopP).toEqual({ drained: false })
    expect(rig.record?.pending).toBeTruthy()
    rig.sendImpl = undefined
    const restarted = rig.build()
    await restarted.tick()
    expect(rig.sends).toHaveLength(0)
    expect(DRAIN_MS).toBe(1500)
  })

  test('a late completion after the deadline persists its own attempt but schedules nothing', async () => {
    const rig = makeRig()
    const late = deferred<{ message_id: number }>()
    rig.sendImpl = () => late.promise
    rig.results.push(ok(STATE_A), ok(STATE_B))
    const tickDone = rig.svc.tick()
    await settle()
    const stopP = Promise.resolve(rig.svc.stop())
    rig.fireDrain()
    await stopP
    late.resolve({ message_id: 950 })
    await tickDone
    expect(rig.record).toEqual(trackedRecord(950))
    expect(rig.delays).toEqual([])
    expect(rig.edits).toHaveLength(0)
  })
})
