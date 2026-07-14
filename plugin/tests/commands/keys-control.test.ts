import { describe, expect, test } from 'bun:test'

import {
  capturePane,
  classifyPane,
  sendControlCommand,
  sendSlashCommand,
  type KeysCaptureExec,
  type KeysExec,
} from '../../src/commands/keys.js'

// ─── Canned pane snapshots (Claude Code TUI v2.1.200 shapes) ─────────────

const IDLE = [
  'assistant said something useful',
  '╭────────────────────────────────╮',
  '│ >                              │',
  '╰────────────────────────────────╯',
  '  ? for shortcuts',
].join('\n')

const BUSY = [
  '● Running a tool…',
  '✳ Working… (esc to interrupt)',
  '╭────────────────────────────────╮',
  '│ >                              │',
  '╰────────────────────────────────╯',
].join('\n')

const DIALOG = [
  '╭─ Bash command ─────────────────╮',
  '│ rm -rf /tmp/x                  │',
  '│                                │',
  '│ Do you want to proceed?        │',
  '│ ❯ 1. Yes                       │',
  '│   2. No                        │',
  '╰────────────────────────────────╯',
].join('\n')

// A dialog that ALSO shows the busy interrupt hint — classifyPane must still
// call it a dialog (dialog is checked before busy).
const DIALOG_WITH_INTERRUPT = [
  '✳ Working… (esc to interrupt)',
  '│ Do you want to proceed?        │',
  '│ ❯ 1. Yes                       │',
].join('\n')

const UNKNOWN = 'openclaw@mac ~ % raw shell prompt, no TUI markers'

// After /clear (v2.1.200): a fresh `❯ /clear` echo, the transcript collapses to
// the welcome banner, and the idle footer returns. NOTE: there is NO
// "Ctrl+Y to paste" line in this build — the clear-success signal is the fresh
// `❯ /clear` echo (+ the transcript collapse), never a paste hint.
const CLEARED = [
  '❯ /clear',
  '✻ Welcome back to Claude Code',
  '╭────────────────────────────────╮',
  '│ >                              │',
  '╰────────────────────────────────╯',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// After /compact accepted: echoed command + Compacting banner, composer empty.
const COMPACTING = [
  '❯ /compact',
  'Compacting conversation…',
  '╭────────────────────────────────╮',
  '│ >                              │',
  '╰────────────────────────────────╯',
].join('\n')

// The command was typed but never submitted — it still sits in the composer.
const NOT_SUBMITTED = [
  '╭────────────────────────────────╮',
  '│ > /clear                       │',
  '╰────────────────────────────────╯',
  '  ? for shortcuts',
].join('\n')

// Idle pane with a typed '/cmd' draft in the composer — the pre-Enter TOCTOU
// snapshot (FIX-3) that sendControlCommand re-captures right before Enter.
function typed(cmd: string): string {
  return [
    'assistant said something useful',
    '╭────────────────────────────────╮',
    `│ > /${cmd}                        │`,
    '╰────────────────────────────────╯',
    '  ? for shortcuts',
  ].join('\n')
}

// ─── Fakes: no real tmux, scripted capture-pane outputs + recorded sends ──

const noSleep = async (_ms: number): Promise<void> => {}

function scriptedSend(): { calls: string[][]; exec: KeysExec } {
  const calls: string[][] = []
  const exec: KeysExec = async (args) => {
    calls.push([...args])
    return { exitCode: 0, stderr: '' }
  }
  return { calls, exec }
}

// Returns each scripted snapshot in order; once the script is exhausted it
// repeats the last one (so polling loops don't have to be counted exactly).
function scriptedCapture(outputs: string[]): { calls: string[][]; exec: KeysCaptureExec } {
  const calls: string[][] = []
  let i = 0
  const exec: KeysCaptureExec = async (args) => {
    calls.push([...args])
    const out = i < outputs.length ? outputs[i]! : (outputs[outputs.length - 1] ?? '')
    i++
    return { exitCode: 0, stdout: out, stderr: '' }
  }
  return { calls, exec }
}

// ─── classifyPane (pure) ─────────────────────────────────────────────────

describe('classifyPane', () => {
  test('idle / busy / dialog / unknown are labelled correctly', () => {
    expect(classifyPane(IDLE)).toBe('idle')
    expect(classifyPane(BUSY)).toBe('busy')
    expect(classifyPane(DIALOG)).toBe('dialog')
    expect(classifyPane(UNKNOWN)).toBe('unknown')
  })

  test('dialog wins over busy when both hints are present', () => {
    expect(classifyPane(DIALOG_WITH_INTERRUPT)).toBe('dialog')
  })

  test('idle needs a composer hint AND no interrupt hint', () => {
    expect(classifyPane('? for shortcuts')).toBe('idle')
    expect(classifyPane('shift+tab to cycle')).toBe('idle')
    // interrupt hint present ⇒ never idle
    expect(classifyPane('? for shortcuts\n✳ Working… (esc to interrupt)')).toBe('busy')
  })

  test('empty capture (failed capture-pane) → unknown, never idle', () => {
    expect(classifyPane('')).toBe('unknown')
  })

  // v2.1.201 (regression 2026-07-06): the busy footer dropped "esc to interrupt"
  // in favour of a spinner line "✢ … (Nm Ns · ↓ Nk tokens)". Without matching it
  // a busy pane classified as 'unknown' and the compact button refused.
  test('v2.1.201 spinner (no "esc to interrupt") is still busy', () => {
    expect(classifyPane('✢ Триггерю… (6m 7s · ↓ 14.5k tokens)')).toBe('busy')
    expect(classifyPane('✶ Working… (12s · ↓ 800 tokens)')).toBe('busy')
    expect(classifyPane('· Cogitating… (1m 3s · ↑ 2.1k tokens)')).toBe('busy')
    // the spinner tail must NOT make a plain idle/bypass footer read as busy
    expect(classifyPane('⏵⏵ bypass permissions on (shift+tab to cycle)')).toBe('idle')
  })

  // Multi-agent composer (newest Claude Code build): the idle footer dropped
  // both "shift+tab to cycle" and "? for shortcuts" in favour of a composer
  // affordance line ending in "… · ← for agents · ↓ to manage". Without matching
  // its stable tail markers the idle pane classified as 'unknown' and the compact
  // button refused ("не удалось определить состояние сессии").
  test('multi-agent composer footer (no shift+tab / ? for shortcuts) is idle', () => {
    expect(
      classifyPane('⏵⏵ bypass permissions on · 2 shells · ← for agents · ↓ to manage'),
    ).toBe('idle')
    // the bare structural tail (both affordances + glyphs, in order) also matches
    expect(classifyPane('← for agents · ↓ to manage')).toBe('idle')
  })

  // Codex fix-loop (2026-07-14): the tail is matched STRUCTURALLY (one regex over
  // both ordered affordances + their glyphs) rather than by loose `for agents` /
  // `to manage` substrings. Generic bottom-chrome text that merely CONTAINS those
  // words — help/error/partial-render — must NOT read as idle, or the reliable
  // compact path would blind-Enter a non-idle pane. These two cases returned
  // 'idle' against the pre-fix-loop loose-substring HEAD (a proven regression);
  // they must now be 'unknown'.
  test('generic "for agents" / "to manage" text without the structural tail is not idle', () => {
    expect(classifyPane('Use /agents for agents to collaborate')).toBe('unknown')
    expect(classifyPane('Press ↓ to manage settings')).toBe('unknown')
  })

  test('multi-agent footer WITH interrupt hint stays busy (busy wins)', () => {
    expect(
      classifyPane(
        '⏵⏵ bypass permissions on · 2 shells · esc to interrupt · ← for agents · ↓ to manage',
      ),
    ).toBe('busy')
  })

  // The new markers are still bottom-chrome anchored: a scrolled-up transcript
  // merely QUOTING "to manage" / "for agents" must not override a clean idle
  // composer sitting at the bottom of the capture.
  test('multi-agent markers quoted far above do not override bottom chrome', () => {
    const geom = [
      'note: the composer says "← for agents" and "↓ to manage" now',
      'filler line 2',
      'filler line 3',
      'filler line 4',
      'filler line 5',
      'filler line 6',
      'filler line 7',
      'filler line 8',
      'filler line 9',
      'filler line 10',
      'filler line 11',
      'filler line 12',
      '╭────────────────────────────────╮',
      '│ >                              │',
      '╰────────────────────────────────╯',
      '  ? for shortcuts',
    ].join('\n')
    expect(classifyPane(geom)).toBe('idle')
  })

  // FIX-5 (Fable M3): markers are anchored to the BOTTOM UI chrome, so the
  // agent's own transcript quoting "Do you want to proceed?" / "esc to
  // interrupt" (this very plugin discusses these strings) far above the
  // composer is NOT misread as live pane state.
  test('transcript far above that QUOTES chrome text is not misread', () => {
    const geom = [
      'The plugin discusses: Do you want to proceed?',
      'and also the string: esc to interrupt — quoted here',
      'filler line 3',
      'filler line 4',
      'filler line 5',
      'filler line 6',
      'filler line 7',
      'filler line 8',
      'filler line 9',
      'filler line 10',
      'filler line 11',
      'filler line 12',
      '╭────────────────────────────────╮',
      '│ >                              │',
      '╰────────────────────────────────╯',
      '  ? for shortcuts',
    ].join('\n')
    // Bottom chrome is a clean idle composer → idle, NOT dialog/busy.
    expect(classifyPane(geom)).toBe('idle')
  })
})

// ─── capturePane ─────────────────────────────────────────────────────────

describe('capturePane', () => {
  test('returns stdout and issues the right capture-pane args', async () => {
    const cap = scriptedCapture([IDLE])
    const out = await capturePane({ paneTarget: '%7', socketPath: '/tmp/s' }, cap.exec)
    expect(out).toBe(IDLE)
    expect(cap.calls).toEqual([['-S', '/tmp/s', 'capture-pane', '-p', '-t', '%7']])
  })

  test('returns empty string on tmux failure', async () => {
    const exec: KeysCaptureExec = async () => ({ exitCode: 1, stdout: '', stderr: 'no pane' })
    const out = await capturePane({ paneTarget: '%9' }, exec)
    expect(out).toBe('')
  })
})

// ─── sendControlCommand ──────────────────────────────────────────────────

describe('sendControlCommand', () => {
  const target = { paneTarget: '%7', socketPath: '/tmp/s' } as const

  test('idle → 3-shot fires in exact order, confirm sees cleared → ok', async () => {
    const send = scriptedSend()
    // probe → pre-Enter re-check (FIX-3) → confirm.
    const cap = scriptedCapture([IDLE, typed('clear'), CLEARED])
    const r = await sendControlCommand(target, 'clear', {
      sleep: noSleep,
      exec: send.exec,
      captureExec: cap.exec,
    })
    expect(r).toEqual({ ok: true })
    expect(send.calls).toEqual([
      ['-S', '/tmp/s', 'send-keys', '-t', '%7', 'C-u'],
      ['-S', '/tmp/s', 'send-keys', '-t', '%7', '-l', '/clear'],
      ['-S', '/tmp/s', 'send-keys', '-t', '%7', 'Enter'],
    ])
  })

  test('dialog → {ok:false, reason:dialog} and sends NOTHING', async () => {
    const send = scriptedSend()
    const cap = scriptedCapture([DIALOG])
    const r = await sendControlCommand(target, 'clear', {
      interruptIfBusy: true,
      sleep: noSleep,
      exec: send.exec,
      captureExec: cap.exec,
    })
    expect(r).toEqual({ ok: false, reason: 'dialog' })
    expect(send.calls).toEqual([]) // not one send-key issued
  })

  test('busy then idle-after-Escape → Escape sent, then 3-shot → ok', async () => {
    const send = scriptedSend()
    const cap = scriptedCapture([BUSY, IDLE, typed('clear'), CLEARED])
    const r = await sendControlCommand(target, 'clear', {
      interruptIfBusy: true,
      sleep: noSleep,
      exec: send.exec,
      captureExec: cap.exec,
    })
    expect(r).toEqual({ ok: true })
    expect(send.calls).toEqual([
      ['-S', '/tmp/s', 'send-keys', '-t', '%7', 'Escape'],
      ['-S', '/tmp/s', 'send-keys', '-t', '%7', 'C-u'],
      ['-S', '/tmp/s', 'send-keys', '-t', '%7', '-l', '/clear'],
      ['-S', '/tmp/s', 'send-keys', '-t', '%7', 'Enter'],
    ])
  })

  test('busy stays busy after Escape → {ok:false, reason:busy}', async () => {
    const send = scriptedSend()
    const cap = scriptedCapture([BUSY, BUSY])
    const r = await sendControlCommand(target, 'clear', {
      interruptIfBusy: true,
      sleep: noSleep,
      exec: send.exec,
      captureExec: cap.exec,
    })
    expect(r).toEqual({ ok: false, reason: 'busy' })
    expect(send.calls).toEqual([['-S', '/tmp/s', 'send-keys', '-t', '%7', 'Escape']])
  })

  test('busy without interruptIfBusy → busy, sends nothing', async () => {
    const send = scriptedSend()
    const cap = scriptedCapture([BUSY])
    const r = await sendControlCommand(target, 'clear', {
      sleep: noSleep,
      exec: send.exec,
      captureExec: cap.exec,
    })
    expect(r).toEqual({ ok: false, reason: 'busy' })
    expect(send.calls).toEqual([])
  })

  // FIX-1 (both reviews): a pane we cannot POSITIVELY identify as idle must
  // never receive a blind send. An unrecognised screen classifies as unknown.
  test('unknown pane at probe → zero send-keys, {ok:false, reason:unknown}', async () => {
    const send = scriptedSend()
    const cap = scriptedCapture([UNKNOWN])
    const r = await sendControlCommand(target, 'clear', {
      interruptIfBusy: true,
      sleep: noSleep,
      exec: send.exec,
      captureExec: cap.exec,
    })
    expect(r).toEqual({ ok: false, reason: 'unknown' })
    expect(send.calls).toEqual([]) // never send into an unknown pane
  })

  // FIX-1: a FAILED capture-pane returns '' → unknown → refuse (not idle).
  test('failed capture-pane (empty) → refuses with reason unknown, sends nothing', async () => {
    const send = scriptedSend()
    const failCapture: KeysCaptureExec = async () => ({ exitCode: 1, stdout: '', stderr: 'boom' })
    const r = await sendControlCommand(target, 'clear', {
      sleep: noSleep,
      exec: send.exec,
      captureExec: failCapture,
    })
    expect(r).toEqual({ ok: false, reason: 'unknown' })
    expect(send.calls).toEqual([])
  })

  // FIX-3 (both reviews): a dialog surfaced between typing the draft and Enter.
  // The pre-Enter re-check must abort — NEVER press Enter (it would approve the
  // dialog) — clear the draft and refuse.
  test('idle at probe, dialog at pre-Enter re-check → no Enter, refused dialog', async () => {
    const send = scriptedSend()
    const cap = scriptedCapture([IDLE, DIALOG])
    const r = await sendControlCommand(target, 'clear', {
      sleep: noSleep,
      exec: send.exec,
      captureExec: cap.exec,
    })
    expect(r).toEqual({ ok: false, reason: 'dialog' })
    // Enter was NEVER sent; the typed draft was wiped with a C-u.
    expect(send.calls.some((c) => c.includes('Enter'))).toBe(false)
    expect(send.calls).toEqual([
      ['-S', '/tmp/s', 'send-keys', '-t', '%7', 'C-u'],
      ['-S', '/tmp/s', 'send-keys', '-t', '%7', '-l', '/clear'],
      ['-S', '/tmp/s', 'send-keys', '-t', '%7', 'C-u'],
    ])
  })

  test('composer still shows /clear after send → {ok:false, reason:not-submitted}', async () => {
    const send = scriptedSend()
    const cap = scriptedCapture([IDLE, NOT_SUBMITTED, NOT_SUBMITTED, NOT_SUBMITTED, NOT_SUBMITTED])
    const r = await sendControlCommand(target, 'clear', {
      sleep: noSleep,
      exec: send.exec,
      captureExec: cap.exec,
    })
    expect(r).toEqual({ ok: false, reason: 'not-submitted' })
    // the 3-shot was still attempted (the failure is in confirm, not send)
    expect(send.calls).toEqual([
      ['-S', '/tmp/s', 'send-keys', '-t', '%7', 'C-u'],
      ['-S', '/tmp/s', 'send-keys', '-t', '%7', '-l', '/clear'],
      ['-S', '/tmp/s', 'send-keys', '-t', '%7', 'Enter'],
    ])
  })

  // Coordinator (v2.1.200): on an ALREADY-CLEAR / already-short session neither
  // the `❯ /clear` occurrence count NOR the transcript line-count can move, yet
  // the clear DID run. The reliable sender only Enters a verified '/clear' draft
  // in an idle pane, so an empty composer + idle footer + a visible `❯ /clear`
  // echo is a confident success — prefer OK over a false not-submitted (which
  // would have made /clear and /new look broken on a fresh session).
  test('clear on an already-clear session → ok via echo+idle fallback (no false not-submitted)', async () => {
    const send = scriptedSend()
    const alreadyClearDraft = [
      '❯ /clear',
      '✻ Welcome back to Claude Code',
      '╭────────────────────────────────╮',
      '│ > /clear                       │',
      '╰────────────────────────────────╯',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    // baseline already carries the `❯ /clear` echo; the confirm snap is the SAME
    // already-clear view (count unchanged, transcript unchanged), composer empty.
    const cap = scriptedCapture([CLEARED, alreadyClearDraft, CLEARED, CLEARED, CLEARED])
    const r = await sendControlCommand(target, 'clear', {
      sleep: noSleep,
      exec: send.exec,
      captureExec: cap.exec,
    })
    expect(r).toEqual({ ok: true })
  })

  test('compact confirms via a FRESH Compacting marker', async () => {
    const send = scriptedSend()
    const cap = scriptedCapture([IDLE, typed('compact'), COMPACTING])
    const r = await sendControlCommand(target, 'compact', {
      sleep: noSleep,
      exec: send.exec,
      captureExec: cap.exec,
    })
    expect(r).toEqual({ ok: true })
    expect(send.calls[1]).toEqual(['-S', '/tmp/s', 'send-keys', '-t', '%7', '-l', '/compact'])
  })

  test('invalid command name throws (reuses SLASH_NAME_RE)', async () => {
    const send = scriptedSend()
    const cap = scriptedCapture([IDLE])
    await expect(
      sendControlCommand(target, 'bad name!', {
        sleep: noSleep,
        exec: send.exec,
        captureExec: cap.exec,
      }),
    ).rejects.toThrow()
    expect(send.calls).toEqual([])
  })

  // ─── IT2-2: fresh OCCURRENCE-COUNT delta (not a stale boolean) ─────────────

  // A back-to-back /compact: the PROBE baseline already carries a stale
  // `❯ /compact` + `Compacting…` (from the previous run) in the bottom chrome.
  // The old present/absent boolean would read the marker as "already there" and
  // report not-submitted; the occurrence-count delta sees a SECOND occurrence
  // appear after Enter → ok.
  const STALE_COMPACT_IDLE = [
    '❯ /compact',
    'Compacting conversation…',
    '╭────────────────────────────────╮',
    '│ >                              │',
    '╰────────────────────────────────╯',
    '  ? for shortcuts',
  ].join('\n')
  const STALE_COMPACT_DRAFT = [
    '❯ /compact',
    'Compacting conversation…',
    '╭────────────────────────────────╮',
    '│ > /compact                     │',
    '╰────────────────────────────────╯',
    '  ? for shortcuts',
  ].join('\n')
  const TWO_COMPACT = [
    '❯ /compact',
    'Compacting conversation…',
    '❯ /compact',
    'Compacting conversation…',
    '╭────────────────────────────────╮',
    '│ >                              │',
    '╰────────────────────────────────╯',
  ].join('\n')

  test('IT2-2: back-to-back compact (stale marker pre-send + FRESH occurrence) → ok', async () => {
    const send = scriptedSend()
    const cap = scriptedCapture([STALE_COMPACT_IDLE, STALE_COMPACT_DRAFT, TWO_COMPACT])
    const r = await sendControlCommand(target, 'compact', {
      sleep: noSleep,
      exec: send.exec,
      captureExec: cap.exec,
    })
    expect(r).toEqual({ ok: true })
    expect(send.calls.some((c) => c.includes('/compact'))).toBe(true)
  })

  test('IT2-2: genuinely-not-fired (marker count unchanged) → not-submitted', async () => {
    const send = scriptedSend()
    // Baseline has the stale markers; after Enter the SAME view persists (no new
    // occurrence) → count does not increase → refuse.
    const cap = scriptedCapture([
      STALE_COMPACT_IDLE,
      STALE_COMPACT_DRAFT,
      STALE_COMPACT_IDLE,
      STALE_COMPACT_IDLE,
      STALE_COMPACT_IDLE,
      STALE_COMPACT_IDLE,
    ])
    const r = await sendControlCommand(target, 'compact', {
      sleep: noSleep,
      exec: send.exec,
      captureExec: cap.exec,
    })
    expect(r).toEqual({ ok: false, reason: 'not-submitted' })
  })

  // ─── IT2-3: pre-Enter re-check aborts ONLY on busy/dialog ──────────────────

  // Typing '/compact' opens Claude Code's autocomplete popup, which REPLACES the
  // idle footer hints → classifyPane === 'unknown'. The pre-Enter gate must NOT
  // refuse on unknown (that would kill every control send); as long as the draft
  // is visible and the pane is not busy/dialog it presses Enter.
  const POPUP_WITH_DRAFT = [
    '╭────────────────────────────────╮',
    '│ > /compact                     │',
    '╰────────────────────────────────╯',
    '  /compact       Compact the conversation',
    '  /compact-full  Full compaction',
  ].join('\n')

  test('IT2-3: autocomplete popup (unknown) but draft visible → sends Enter, ok', async () => {
    // Sanity: the popup snapshot really does classify as unknown (not idle).
    expect(classifyPane(POPUP_WITH_DRAFT)).toBe('unknown')
    const send = scriptedSend()
    const cap = scriptedCapture([IDLE, POPUP_WITH_DRAFT, COMPACTING])
    const r = await sendControlCommand(target, 'compact', {
      sleep: noSleep,
      exec: send.exec,
      captureExec: cap.exec,
    })
    expect(r).toEqual({ ok: true })
    expect(send.calls.some((c) => c.includes('Enter'))).toBe(true)
  })

  test('IT2-3: busy surfaces at pre-Enter re-check → no Enter, refused busy', async () => {
    const send = scriptedSend()
    const cap = scriptedCapture([IDLE, BUSY])
    const r = await sendControlCommand(target, 'compact', {
      sleep: noSleep,
      exec: send.exec,
      captureExec: cap.exec,
    })
    expect(r).toEqual({ ok: false, reason: 'busy' })
    expect(send.calls.some((c) => c.includes('Enter'))).toBe(false)
    // The typed draft was wiped (C-u) — never left submittable.
    expect(send.calls).toEqual([
      ['-S', '/tmp/s', 'send-keys', '-t', '%7', 'C-u'],
      ['-S', '/tmp/s', 'send-keys', '-t', '%7', '-l', '/compact'],
      ['-S', '/tmp/s', 'send-keys', '-t', '%7', 'C-u'],
    ])
  })

  test('IT2-3: draft never appears in the window → not-submitted (no Enter)', async () => {
    const send = scriptedSend()
    // Pane stays a bare idle composer (no draft ever renders) across the poll.
    const cap = scriptedCapture([IDLE, IDLE, IDLE, IDLE])
    const r = await sendControlCommand(target, 'compact', {
      sleep: noSleep,
      exec: send.exec,
      captureExec: cap.exec,
    })
    expect(r).toEqual({ ok: false, reason: 'not-submitted' })
    expect(send.calls.some((c) => c.includes('Enter'))).toBe(false)
  })

  // ─── IT2-7: sendSlashCommand also serializes through the pane chain ─────────

  // A typed argful /cc (sendSlashCommand) racing a control /compact must NOT
  // interleave keystrokes. When serialized, each op emits a clean [C-u, literal,
  // Enter] triple, so the two literal sends are exactly 3 positions apart
  // (literal, Enter, C-u, literal). Interleaving would place them closer.
  test('IT2-7: sendSlashCommand + sendControlCommand on one pane serialize (no interleave)', async () => {
    const calls: string[][] = []
    const exec: KeysExec = async (args) => {
      await Promise.resolve() // yield so a non-serialized impl WOULD interleave
      calls.push([...args])
      return { exitCode: 0, stderr: '' }
    }
    const cap = scriptedCapture([IDLE, typed('compact'), COMPACTING])
    const mixTarget = { paneTarget: '%mix', socketPath: '/tmp/s' } as const
    await Promise.all([
      sendControlCommand(mixTarget, 'compact', { sleep: noSleep, exec, captureExec: cap.exec }),
      sendSlashCommand(mixTarget, { name: 'context', rest: '' }, exec),
    ])
    const ctxIdx = calls.findIndex((c) => c.includes('/context'))
    const compactIdx = calls.findIndex((c) => c.includes('/compact'))
    expect(ctxIdx).toBeGreaterThanOrEqual(0)
    expect(compactIdx).toBeGreaterThanOrEqual(0)
    // Serialized ⇒ the two literal sends are separated by exactly Enter + C-u.
    expect(Math.abs(ctxIdx - compactIdx)).toBe(3)
    // And exactly two Enters (one per op), never fewer (a lost/merged submit).
    expect(calls.filter((c) => c.includes('Enter')).length).toBe(2)
  })

  // FIX-4 (both reviews): two concurrent control sends into the SAME pane must
  // serialize — their keystrokes must never interleave. We prove ordering by
  // recording the send stream of two overlapping calls and asserting the second
  // call's C-u never lands before the first call's Enter.
  test('concurrent sends to the same pane are serialized (no interleave)', async () => {
    const calls: string[][] = []
    const exec: KeysExec = async (args) => {
      // Yield to the event loop so a non-serialized impl WOULD interleave.
      await Promise.resolve()
      calls.push([...args])
      return { exitCode: 0, stderr: '' }
    }
    const cap1 = scriptedCapture([IDLE, typed('compact'), COMPACTING])
    const cap2 = scriptedCapture([IDLE, typed('compact'), COMPACTING])
    const serialTarget = { paneTarget: '%serial', socketPath: '/tmp/s' } as const
    await Promise.all([
      sendControlCommand(serialTarget, 'compact', { sleep: noSleep, exec, captureExec: cap1.exec }),
      sendControlCommand(serialTarget, 'compact', { sleep: noSleep, exec, captureExec: cap2.exec }),
    ])
    // The full 3-shot of the first call (C-u, -l, Enter) precedes the second.
    const enterIdxs = calls.map((c, i) => (c.includes('Enter') ? i : -1)).filter((i) => i >= 0)
    const cuIdxs = calls.map((c, i) => (c.includes('C-u') ? i : -1)).filter((i) => i >= 0)
    // Exactly two of each (one per call), and the first Enter comes before the
    // second C-u — i.e. call #2 did not start typing until call #1 submitted.
    expect(enterIdxs.length).toBe(2)
    expect(cuIdxs.length).toBe(2)
    expect(enterIdxs[0]!).toBeLessThan(cuIdxs[1]!)
  })
})
