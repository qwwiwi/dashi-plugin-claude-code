import { describe, expect, test } from 'bun:test'

import { SessionInfoStore } from '../../src/status/session-info.js'

describe('SessionInfoStore', () => {
  test('records transcript + session id, reads back via latest', () => {
    const s = new SessionInfoStore()
    s.record(undefined, { transcriptPath: '/t/a.jsonl', sessionId: 'sid-1' })
    expect(s.get()).toEqual({ transcriptPath: '/t/a.jsonl', sessionId: 'sid-1' })
  })

  test('model from SessionStart survives a later event that omits it', () => {
    const s = new SessionInfoStore()
    s.record('164795011', { transcriptPath: '/t/a.jsonl', sessionId: 'sid-1', model: 'opus' })
    // A later PreToolUse hook carries transcript + session but NO model.
    s.record('164795011', { transcriptPath: '/t/a.jsonl', sessionId: 'sid-1' })
    expect(s.get('164795011')).toEqual({
      transcriptPath: '/t/a.jsonl',
      sessionId: 'sid-1',
      model: 'opus',
    })
  })

  test('per-chat isolation; a keyed get NEVER bleeds another chat (FIX-10)', () => {
    const s = new SessionInfoStore()
    s.record('chatA', { transcriptPath: '/t/A.jsonl', sessionId: 'A' })
    s.record('chatB', { transcriptPath: '/t/B.jsonl', sessionId: 'B', model: 'sonnet' })
    expect(s.get('chatA').transcriptPath).toBe('/t/A.jsonl')
    expect(s.get('chatB').transcriptPath).toBe('/t/B.jsonl')
    // FIX-10: an UNKNOWN chatId returns {} — it must NOT bleed the global
    // `latest` (chatB's session) into a chat that never recorded anything.
    expect(s.get('chatC')).toEqual({})
    // No-arg get() still uses latest (legacy single-DM caller).
    expect(s.get().transcriptPath).toBe('/t/B.jsonl')
  })

  test('FIX-10: /status in the DM never shows a GROUP session', () => {
    const s = new SessionInfoStore()
    // A busy group session records last…
    s.record('-1009999', { transcriptPath: '/t/group.jsonl', sessionId: 'g', model: 'sonnet' })
    // …but the owner DM never recorded → its keyed get must be empty, not the
    // group's transcript.
    expect(s.get('164795011')).toEqual({})
  })

  test('empty fields do not overwrite previous values', () => {
    const s = new SessionInfoStore()
    s.record('c', { transcriptPath: '/t/x.jsonl', sessionId: 'x', model: 'opus' })
    s.record('c', { transcriptPath: '', sessionId: '', model: '' })
    expect(s.get('c')).toEqual({ transcriptPath: '/t/x.jsonl', sessionId: 'x', model: 'opus' })
  })

  test('empty store returns an empty object (never null)', () => {
    const s = new SessionInfoStore()
    expect(s.get()).toEqual({})
    expect(s.get('nope')).toEqual({})
  })

  test('blank chatId updates only the latest slot, not a per-chat entry', () => {
    const s = new SessionInfoStore()
    s.record('c', { transcriptPath: '/t/c.jsonl', sessionId: 'c' })
    s.record('', { transcriptPath: '/t/latest.jsonl', sessionId: 'l' })
    // per-chat 'c' unchanged
    expect(s.get('c').transcriptPath).toBe('/t/c.jsonl')
    // latest reflects the blank-chat record
    expect(s.get().transcriptPath).toBe('/t/latest.jsonl')
  })
})
