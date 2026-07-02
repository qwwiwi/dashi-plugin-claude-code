import { describe, expect, test } from 'bun:test'
import {
  createAskUserQuestionRelay,
  type AskUserQuestionRelay,
  type SubmitInput,
} from '../../src/channel/ask-user-question.js'
import {
  SHORT_ID_RE,
  generateShortId,
  generateUniqueShortId,
  setShortIdRandomSource,
} from '../../src/channel/short-id.js'
import type { Logger } from '../../src/log.js'

function silentLog(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
}

function mkRelay(overrides: { now?: () => number; defaultTimeoutMs?: number; completedTtlMs?: number } = {}): AskUserQuestionRelay {
  const deps: {
    log: Logger
    now?: () => number
    defaultTimeoutMs?: number
    completedTtlMs?: number
  } = { log: silentLog() }
  if (overrides.now !== undefined) deps.now = overrides.now
  if (overrides.defaultTimeoutMs !== undefined) deps.defaultTimeoutMs = overrides.defaultTimeoutMs
  if (overrides.completedTtlMs !== undefined) deps.completedTtlMs = overrides.completedTtlMs
  return createAskUserQuestionRelay(deps)
}

function singleQ(): SubmitInput {
  return {
    toolUseId: 'toolu_single_1',
    sessionId: 'sess_a',
    chatId: '164795011',
    questions: [
      {
        question: 'Pick a stack',
        options: [
          { label: 'React' },
          { label: 'Vue' },
          { label: 'Svelte' },
        ],
      },
    ],
  }
}

function multiQ(): SubmitInput {
  return {
    toolUseId: 'toolu_multi_1',
    sessionId: 'sess_b',
    chatId: '164795011',
    questions: [
      {
        question: 'Q1: Color?',
        options: [{ label: 'Red' }, { label: 'Blue' }],
      },
      {
        question: 'Q2: Size?',
        options: [{ label: 'S' }, { label: 'M' }, { label: 'L' }],
      },
    ],
  }
}

function multiSelectQ(): SubmitInput {
  return {
    toolUseId: 'toolu_msel_1',
    sessionId: 'sess_c',
    chatId: '164795011',
    questions: [
      {
        question: 'Pick frameworks',
        multiSelect: true,
        options: [
          { label: 'React' },
          { label: 'Vue' },
          { label: 'Svelte' },
        ],
      },
    ],
  }
}

describe('short-id', () => {
  test('generateShortId yields a 5-letter id from a-z minus l', () => {
    for (let i = 0; i < 200; i++) {
      const id = generateShortId()
      expect(id).toMatch(SHORT_ID_RE)
      expect(id.length).toBe(5)
      expect(id).not.toMatch(/l/)
      expect(id).toBe(id.toLowerCase())
    }
  })

  test('1000 samples produce high uniqueness (no clustering bug)', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(generateShortId())
    // 25^5 = 9.7M — collisions in 1k draws are astronomically unlikely.
    // Tolerate one or two just in case of CI flake; >980 unique catches
    // a serious entropy bug.
    expect(seen.size).toBeGreaterThan(980)
  })

  test('generateUniqueShortId avoids collisions with existing set', () => {
    const existing = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const id = generateUniqueShortId(existing)
      expect(existing.has(id)).toBe(false)
      existing.add(id)
    }
    expect(existing.size).toBe(50)
  })

  test('generateUniqueShortId accepts a predicate function (FIX-T3 F2)', () => {
    // Phase 5 FIX-T3 F2: composability test — caller can pass a free
    // function combining multiple existence sources (e.g. pending +
    // completedIds). The helper must respect it.
    const taken = new Set<string>(['abcde', 'fghij', 'kmnop'])
    for (let i = 0; i < 50; i++) {
      const id = generateUniqueShortId((candidate) => taken.has(candidate))
      expect(taken.has(id)).toBe(false)
      taken.add(id)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// FIX-T3 F1: submit() returns { requestId, result } synchronously.
// All tests below dereference the new shape — `submit().result` is the
// Promise that used to be the bare return value.
// ─────────────────────────────────────────────────────────────────────

describe('submit() — return contract (FIX-T3 F1)', () => {
  test('fresh submit yields a non-empty requestId matching SHORT_ID_RE', () => {
    const relay = mkRelay()
    const handle = relay.submit(singleQ())
    expect(handle.requestId).toBeDefined()
    expect(typeof handle.requestId).toBe('string')
    expect(handle.requestId!).toMatch(SHORT_ID_RE)
    // requestId is synchronously discoverable from submit() — no need to
    // call listPendingIds().
    expect(relay.listPendingIds()).toEqual([handle.requestId!])
    // Cleanup
    relay.expire(handle.requestId!)
  })

  test('result is a Promise that resolves to the verdict', async () => {
    const relay = mkRelay()
    const { requestId, result } = relay.submit(singleQ())
    expect(result).toBeInstanceOf(Promise)
    relay.answerChoice(requestId!, 0, 0)
    const verdict = await result
    expect(verdict.status).toBe('answered')
    expect(verdict.requestId).toBe(requestId)
  })

  test('pass_through path: no chatId → requestId undefined, sync result', async () => {
    const relay = mkRelay()
    const { chatId: _omit, ...rest } = singleQ()
    const { requestId, result } = relay.submit(rest)
    expect(requestId).toBeUndefined()
    const verdict = await result
    expect(verdict.status).toBe('pass_through')
  })

  test('empty-questions path: requestId undefined, sync answered', async () => {
    const relay = mkRelay()
    const { requestId, result } = relay.submit({
      toolUseId: 'toolu_zero',
      sessionId: 'sess_z',
      chatId: '164795011',
      questions: [],
    })
    expect(requestId).toBeUndefined()
    const verdict = await result
    expect(verdict.status).toBe('answered')
    expect(verdict.updatedInput).toEqual({ questions: [], answers: {} })
  })
})

describe('submit() — single-select single question', () => {
  test('answerChoice resolves with updatedInput in answered shape', async () => {
    const relay = mkRelay()
    const { requestId, result } = relay.submit(singleQ())
    expect(relay.pendingCount()).toBe(1)
    expect(requestId).toMatch(SHORT_ID_RE)
    const reqId = requestId!

    relay.answerChoice(reqId, 0, 1) // pick "Vue"

    const verdict = await result
    expect(verdict.status).toBe('answered')
    expect(verdict.requestId).toBe(reqId)
    expect(verdict.toolUseId).toBe('toolu_single_1')
    expect(verdict.updatedInput).toEqual({
      questions: singleQ().questions,
      answers: { 'Pick a stack': 'Vue' },
    })
    expect(relay.pendingCount()).toBe(0)
  })

  test('answerOther records free-form text and resolves', async () => {
    const relay = mkRelay()
    const { requestId, result } = relay.submit(singleQ())
    relay.answerOther(requestId!, 0, '  SolidJS  ')
    const verdict = await result
    expect(verdict.status).toBe('answered')
    expect(verdict.updatedInput?.answers).toEqual({ 'Pick a stack': 'SolidJS' })
  })

  test('out-of-range optionIndex does not advance or resolve', async () => {
    const relay = mkRelay({ defaultTimeoutMs: 50 })
    const { requestId, result } = relay.submit(singleQ())
    relay.answerChoice(requestId!, 0, 99) // out of range — should be ignored
    expect(relay.isPending(requestId!)).toBe(true)
    // Let timeout fire to clean up so the test doesn't hang.
    const verdict = await result
    expect(verdict.status).toBe('timeout')
  })
})

describe('submit() — multi-question sequential', () => {
  test('answers accumulate across answerChoice calls', async () => {
    const relay = mkRelay()
    const { requestId, result } = relay.submit(multiQ())
    const reqId = requestId!

    relay.answerChoice(reqId, 0, 1) // Q1 → Blue
    expect(relay.isPending(reqId)).toBe(true)
    const mid = relay.getPending(reqId)!
    expect(mid.currentIndex).toBe(1)
    expect(mid.answers).toEqual({ 'Q1: Color?': 'Blue' })

    relay.answerChoice(reqId, 1, 2) // Q2 → L
    const verdict = await result
    expect(verdict.status).toBe('answered')
    expect(verdict.updatedInput?.answers).toEqual({
      'Q1: Color?': 'Blue',
      'Q2: Size?': 'L',
    })
    expect(relay.pendingCount()).toBe(0)
  })

  test('stale questionIndex callback is dropped', async () => {
    const relay = mkRelay({ defaultTimeoutMs: 50 })
    const { requestId, result } = relay.submit(multiQ())
    const reqId = requestId!
    relay.answerChoice(reqId, 0, 0) // Q1 → Red
    // Late-arriving callback claiming to be for Q1 (currentIndex is now 1).
    relay.answerChoice(reqId, 0, 1)
    expect(relay.getPending(reqId)!.currentIndex).toBe(1)
    expect(relay.getPending(reqId)!.answers).toEqual({ 'Q1: Color?': 'Red' })
    // Cleanup
    relay.expire(reqId)
    await result
  })
})

describe('submit() — multiSelect', () => {
  test('toggle/toggle/done accumulates joined labels', async () => {
    const relay = mkRelay()
    const { requestId, result } = relay.submit(multiSelectQ())
    const reqId = requestId!

    relay.toggle(reqId, 0, 0) // +React
    relay.toggle(reqId, 0, 2) // +Svelte
    expect(relay.getPending(reqId)!.multiSelectInFlight).toEqual(['React', 'Svelte'])

    relay.done(reqId, 0)
    const verdict = await result
    expect(verdict.status).toBe('answered')
    expect(verdict.updatedInput?.answers).toEqual({ 'Pick frameworks': 'React, Svelte' })
  })

  test('double-toggle of same option removes it', async () => {
    const relay = mkRelay()
    const { requestId, result } = relay.submit(multiSelectQ())
    const reqId = requestId!

    relay.toggle(reqId, 0, 0) // +React
    relay.toggle(reqId, 0, 1) // +Vue
    relay.toggle(reqId, 0, 0) // -React
    expect(relay.getPending(reqId)!.multiSelectInFlight).toEqual(['Vue'])

    relay.done(reqId, 0)
    const verdict = await result
    expect(verdict.updatedInput?.answers).toEqual({ 'Pick frameworks': 'Vue' })
  })

  test('done on multiSelect with empty selection is ignored', async () => {
    const relay = mkRelay({ defaultTimeoutMs: 30 })
    const { requestId, result } = relay.submit(multiSelectQ())
    const reqId = requestId!
    relay.done(reqId, 0) // no items selected — must NOT resolve
    expect(relay.isPending(reqId)).toBe(true)
    // Now select something and finish.
    relay.toggle(reqId, 0, 1)
    relay.done(reqId, 0)
    const verdict = await result
    expect(verdict.updatedInput?.answers).toEqual({ 'Pick frameworks': 'Vue' })
  })

  test('answerOther on multiSelect appends to in-flight list', async () => {
    const relay = mkRelay()
    const { requestId, result } = relay.submit(multiSelectQ())
    const reqId = requestId!
    relay.toggle(reqId, 0, 0) // +React
    relay.answerOther(reqId, 0, 'SolidJS') // +SolidJS
    relay.done(reqId, 0)
    const verdict = await result
    expect(verdict.updatedInput?.answers).toEqual({ 'Pick frameworks': 'React, SolidJS' })
  })

  test('answerChoice on multiSelect routes to toggle', async () => {
    const relay = mkRelay()
    const { requestId, result } = relay.submit(multiSelectQ())
    const reqId = requestId!
    relay.answerChoice(reqId, 0, 0) // route-via-choice — must toggle, not advance
    expect(relay.isPending(reqId)).toBe(true)
    expect(relay.getPending(reqId)!.multiSelectInFlight).toEqual(['React'])
    relay.done(reqId, 0)
    const verdict = await result
    expect(verdict.updatedInput?.answers).toEqual({ 'Pick frameworks': 'React' })
  })
})

// ─────────────────────────────────────────────────────────────────────
// AskAnswerOutcome (Codex HIGH 2026-07-02) — the answer methods report
// applied/advanced/final SYNCHRONOUSLY at mutation time so the UI never
// infers finality from getPending() after an await (timeout race).
// ─────────────────────────────────────────────────────────────────────

describe('AskAnswerOutcome contract', () => {
  test('single-select: non-final advance vs final answer', () => {
    const relay = mkRelay()
    const { requestId } = relay.submit({
      toolUseId: 'toolu_oc_1',
      sessionId: 'sess',
      chatId: '164795011',
      questions: [
        { question: 'Q1', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Q2', options: [{ label: 'C' }] },
      ],
    })
    const reqId = requestId!
    expect(relay.answerChoice(reqId, 0, 0)).toEqual({ applied: true, advanced: true, final: false })
    expect(relay.answerChoice(reqId, 1, 0)).toEqual({ applied: true, advanced: true, final: true })
  })

  test('multiSelect: accumulate (choice-as-toggle / other) then final done', () => {
    const relay = mkRelay()
    const { requestId } = relay.submit(multiSelectQ())
    const reqId = requestId!
    // choice-as-toggle safety net + Other free-text accumulate — applied, not advanced.
    expect(relay.answerChoice(reqId, 0, 0)).toEqual({ applied: true, advanced: false, final: false })
    expect(relay.answerOther(reqId, 0, 'SolidJS')).toEqual({ applied: true, advanced: false, final: false })
    // Commit — final (single question).
    expect(relay.done(reqId, 0)).toEqual({ applied: true, advanced: true, final: true })
  })

  test('no-op paths report applied=false', () => {
    const relay = mkRelay()
    const { requestId } = relay.submit(singleQ())
    const reqId = requestId!
    expect(relay.answerChoice('zzzzz', 0, 0)).toEqual({ applied: false, advanced: false, final: false }) // unknown id
    expect(relay.answerChoice(reqId, 5, 0)).toEqual({ applied: false, advanced: false, final: false }) // stale index
    expect(relay.answerChoice(reqId, 0, 99)).toEqual({ applied: false, advanced: false, final: false }) // opt out of range
    expect(relay.answerOther(reqId, 0, '   ')).toEqual({ applied: false, advanced: false, final: false }) // empty text
    expect(relay.done(reqId, 0)).toEqual({ applied: false, advanced: false, final: false }) // done on non-multiselect
    expect(relay.isPending(reqId)).toBe(true)
    relay.expire(reqId, 'test cleanup')
  })

  test('answer after settle reports applied=false (timeout raced the tap)', async () => {
    const relay = mkRelay({ defaultTimeoutMs: 15 })
    const { requestId, result } = relay.submit(singleQ())
    const reqId = requestId!
    const verdict = await result // internal timeout settles it
    expect(verdict.status).toBe('timeout')
    expect(relay.answerChoice(reqId, 0, 0)).toEqual({ applied: false, advanced: false, final: false })
  })
})

describe('timeout + expire', () => {
  test('timeout fires → status=timeout, map cleaned up', async () => {
    const relay = mkRelay({ defaultTimeoutMs: 20 })
    const { result } = relay.submit(singleQ())
    expect(relay.pendingCount()).toBe(1)
    const verdict = await result
    expect(verdict.status).toBe('timeout')
    expect(verdict.reason).toContain('20ms')
    expect(relay.pendingCount()).toBe(0)
  })

  test('expire() resolves with status=timeout and the given reason', async () => {
    const relay = mkRelay({ defaultTimeoutMs: 60_000 })
    const { requestId, result } = relay.submit(singleQ())
    relay.expire(requestId!, 'session disconnected')
    const verdict = await result
    expect(verdict.status).toBe('timeout')
    expect(verdict.reason).toBe('session disconnected')
    expect(relay.pendingCount()).toBe(0)
  })

  test('expire() with no reason uses a default explicit-expire string', async () => {
    const relay = mkRelay({ defaultTimeoutMs: 60_000 })
    const { requestId, result } = relay.submit(singleQ())
    relay.expire(requestId!)
    const verdict = await result
    expect(verdict.status).toBe('timeout')
    expect(verdict.reason).toBe('explicit expire')
  })

  test('duplicate answerChoice on already-resolved request → no-op, no error', async () => {
    const relay = mkRelay()
    const { requestId, result } = relay.submit(singleQ())
    const reqId = requestId!
    relay.answerChoice(reqId, 0, 0)
    const verdict = await result
    expect(verdict.status).toBe('answered')
    // Second call on already-settled request must not throw.
    expect(() => relay.answerChoice(reqId, 0, 1)).not.toThrow()
    expect(() => relay.answerOther(reqId, 0, 'other')).not.toThrow()
    expect(() => relay.toggle(reqId, 0, 0)).not.toThrow()
    expect(() => relay.done(reqId, 0)).not.toThrow()
    expect(() => relay.expire(reqId)).not.toThrow()
  })
})

describe('race: timeout vs answerChoice', () => {
  test('answerChoice during timer wins; timer no-op', async () => {
    const relay = mkRelay({ defaultTimeoutMs: 1000 })
    const { requestId, result } = relay.submit(singleQ())
    const reqId = requestId!
    // Answer immediately — well before the timer fires.
    relay.answerChoice(reqId, 0, 1)
    const verdict = await result
    expect(verdict.status).toBe('answered')
    // Wait past the original timeout window. If the timer wasn't
    // cleared, a stray settle would log an error — but the Promise is
    // already resolved, so any extra settle is silently ignored by
    // settle()'s `_settled` guard. We verify state is stable.
    await new Promise((r) => setTimeout(r, 30))
    expect(relay.pendingCount()).toBe(0)
  })
})

describe('pass_through and edge cases', () => {
  test('submit without chatId returns pass_through immediately', async () => {
    const relay = mkRelay()
    const { chatId: _omit, ...rest } = singleQ()
    const { requestId, result } = relay.submit(rest)
    expect(requestId).toBeUndefined()
    const verdict = await result
    expect(verdict.status).toBe('pass_through')
    expect(verdict.toolUseId).toBe('toolu_single_1')
    expect(relay.pendingCount()).toBe(0)
  })

  test('submit with empty questions resolves answered with empty answers', async () => {
    const relay = mkRelay()
    const { requestId, result } = relay.submit({
      toolUseId: 'toolu_empty_1',
      sessionId: 'sess_x',
      chatId: '164795011',
      questions: [],
    })
    expect(requestId).toBeUndefined()
    const verdict = await result
    expect(verdict.status).toBe('answered')
    expect(verdict.updatedInput).toEqual({ questions: [], answers: {} })
  })
})

describe('idempotency: toolUseId replay', () => {
  test('second submit with same toolUseId while live → same Promise + same requestId', async () => {
    const relay = mkRelay()
    const h1 = relay.submit(singleQ())
    const h2 = relay.submit(singleQ())
    // Both submits attach to the same live request → same Promise, same id.
    expect(h2.result).toBe(h1.result)
    expect(h2.requestId).toBe(h1.requestId)
    expect(relay.pendingCount()).toBe(1)
    relay.answerChoice(h1.requestId!, 0, 0)
    const [r1, r2] = await Promise.all([h1.result, h2.result])
    expect(r1.status).toBe('answered')
    expect(r2.status).toBe('answered')
    expect(r1).toBe(r2)
  })

  test('resubmit with same toolUseId after settle → cached terminal result (FIX-T2 F5 contract)', async () => {
    const relay = mkRelay({ completedTtlMs: 60_000 })
    const h1 = relay.submit(singleQ())
    const reqId = h1.requestId!
    relay.answerChoice(reqId, 0, 2) // Svelte
    const first = await h1.result
    expect(first.status).toBe('answered')

    // Submit-replay returns the cached terminal result UNCHANGED (FIX-T2's
    // one-line fix). Status stays 'answered' so the hook wrapper treats
    // the retry transparently.
    const h2 = relay.submit(singleQ())
    expect(h2.requestId).toBeUndefined() // already settled — no wiring left to do
    const second = await h2.result
    expect(second.status).toBe('answered')
    expect(second.toolUseId).toBe('toolu_single_1')
    expect(second.updatedInput?.answers).toEqual({ 'Pick a stack': 'Svelte' })
    expect(second.requestId).toBe(reqId)
  })

  test('completed-cache TTL expiry releases the toolUseId for fresh submits', async () => {
    let clock = 1_000_000
    const relay = mkRelay({
      now: () => clock,
      defaultTimeoutMs: 60_000,
      completedTtlMs: 100,
    })
    const h1 = relay.submit(singleQ())
    const reqId1 = h1.requestId!
    relay.answerChoice(reqId1, 0, 0)
    await h1.result

    // Advance past TTL. Note: real timer for the live request fires on
    // wall-clock, but the resolved request has no timer — only the
    // cache TTL gate uses `now()`.
    clock += 200

    const h2 = relay.submit(singleQ())
    // Fresh request, fresh id.
    expect(h2.requestId).toBeDefined()
    expect(h2.requestId).not.toBe(reqId1)
    relay.answerChoice(h2.requestId!, 0, 1)
    const verdict = await h2.result
    expect(verdict.status).toBe('answered')
  })
})

// ─────────────────────────────────────────────────────────────────────
// FIX-T3 F2: ID generation must check completedIds + pending.
// We force a collision by injecting a deterministic RNG that yields the
// same byte stream twice in a row. The first submit takes the id; after
// settle it lives in completedIds for the TTL window; the second submit
// MUST regenerate (the new combined predicate rejects the duplicate).
// ─────────────────────────────────────────────────────────────────────

describe('ID generation collision (FIX-T3 F2)', () => {
  test('completedIds member is not reused for fresh submits', async () => {
    // Force the deterministic RNG to emit the SAME alphabet indices on
    // every draw — generateShortId then always produces the same 5-letter
    // id ('abcde'). We use that to verify the relay rejects a candidate
    // already in completedIds and ALSO that it gives up after a bounded
    // number of attempts (the safety net inside generateUniqueShortId).
    //
    // Test plan:
    //   1. First submit consumes the 'abcde' id and settles → 'abcde'
    //      lands in completedIds for the TTL window.
    //   2. Second submit (different toolUseId so toolUseId replay
    //      doesn't fire) MUST NOT receive 'abcde'. With a stuck RNG the
    //      ONLY honest outcome is `generateUniqueShortId` throwing after
    //      32 attempts (it cannot pick anything else). The relay's
    //      submit() propagates that throw to the caller.
    //
    // This is the cleanest signal that the predicate now includes
    // completedIds: pre-fix the relay would happily return 'abcde'
    // again, mis-routing any stale Telegram callback for the OLD request
    // into the new pending record.
    const stuckRng = {
      getRandomValues<T extends ArrayBufferView | null>(buf: T): T {
        if (buf === null) return buf
        const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        // All zeros → alphabet[0] = 'a' for every position. The shortId
        // generator therefore always yields 'aaaaa'.
        u8.fill(0)
        return buf
      },
    }
    setShortIdRandomSource(stuckRng)
    try {
      const relay = mkRelay({ completedTtlMs: 60_000 })
      // First submit: minted 'aaaaa'.
      const h1 = relay.submit(singleQ())
      expect(h1.requestId).toBe('aaaaa')
      // Settle so 'aaaaa' lands in completedIds.
      relay.answerChoice(h1.requestId!, 0, 0)
      await h1.result
      expect(relay.isPending('aaaaa')).toBe(false)

      // Second submit MUST NOT reuse 'aaaaa'. With the stuck RNG the only
      // path to refusing 'aaaaa' is to exhaust the attempt budget and
      // throw — that's the proof we wanted.
      const freshInput: SubmitInput = { ...singleQ(), toolUseId: 'toolu_fresh_2' }
      expect(() => relay.submit(freshInput)).toThrow(/failed to generate unique id/)
    } finally {
      setShortIdRandomSource(null)
    }
  })

  test('completedIds clears on TTL → id can be reissued', async () => {
    // Companion to the above: once the TTL fires and the cache entry is
    // pruned, the id becomes a valid candidate again. Otherwise we'd
    // bleed unique ids forever.
    let clock = 1_000_000
    const stuckRng = {
      getRandomValues<T extends ArrayBufferView | null>(buf: T): T {
        if (buf === null) return buf
        const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        u8.fill(0)
        return buf
      },
    }
    setShortIdRandomSource(stuckRng)
    try {
      const relay = mkRelay({
        now: () => clock,
        defaultTimeoutMs: 60_000,
        completedTtlMs: 100,
      })
      const h1 = relay.submit(singleQ())
      expect(h1.requestId).toBe('aaaaa')
      relay.answerChoice(h1.requestId!, 0, 0)
      await h1.result

      // Advance past TTL so pruneCompleted releases 'aaaaa'.
      clock += 200
      const freshInput: SubmitInput = { ...singleQ(), toolUseId: 'toolu_fresh_3' }
      const h2 = relay.submit(freshInput)
      // Now 'aaaaa' is fair game again.
      expect(h2.requestId).toBe('aaaaa')
      relay.expire(h2.requestId!)
      await h2.result
    } finally {
      setShortIdRandomSource(null)
    }
  })
})

describe('peek + setTelegramMessageId', () => {
  test('getPending exposes chatId + currentIndex for the UX layer', () => {
    const relay = mkRelay()
    const { requestId } = relay.submit(multiQ())
    const snap = relay.getPending(requestId!)
    expect(snap?.chatId).toBe('164795011')
    expect(snap?.currentIndex).toBe(0)
    expect(snap?.questions.length).toBe(2)
    relay.expire(requestId!)
  })

  test('setTelegramMessageId stashes id and clears on advance', async () => {
    const relay = mkRelay()
    const { requestId, result } = relay.submit(multiQ())
    const reqId = requestId!
    relay.setTelegramMessageId(reqId, 42)
    expect(relay.getPending(reqId)?.telegramMessageId).toBe(42)
    relay.answerChoice(reqId, 0, 0)
    expect(relay.getPending(reqId)?.telegramMessageId).toBeUndefined()
    relay.expire(reqId)
    await result
  })

  test('setTelegramMessageId on unknown id is a silent no-op', () => {
    const relay = mkRelay()
    expect(() => relay.setTelegramMessageId('zzzzz', 1)).not.toThrow()
  })
})
