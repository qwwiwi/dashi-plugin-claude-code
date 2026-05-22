// Tests for the tmux-pane segment filter. The filter sits between the raw
// `tmux capture-pane` output (after stripAnsi) and the Telegram renderer:
// it classifies each chunk of the pane into one of a handful of segment
// types and drops the ones the warchief doesn't want to see in the
// rolling mirror message.
//
// Fixtures are crafted from real captures of Claude Code running inside
// tmux (the warchief sent two screenshots on 2026-05-20 showing the boot
// banner, the channel-status block, the experimental-inbound warning, the
// input prompt, and the footer hints). We do NOT depend on tmux at test
// time — the fixtures are inline strings.

import { describe, expect, test } from 'bun:test'

import {
  segmentizePane,
  filterPane,
  capLines,
  DEFAULT_HIDDEN_SEGMENTS,
  type SegmentType,
} from '../../src/status/tmux-pane-filter.js'

// ─── Fixtures ────────────────────────────────────────────────────────

const BOOT_BANNER = [
  '╭─── Claude Code v2.1.144 ─────────────────────────────────────────────────────╮',
  '│                                                    │ Tips for getting        │',
  '│                 Welcome back Dashi!                │ started                 │',
  '│                                                    │ Run /init to create a … │',
  '│                       ▐▛███▜▌                      │ ─────────────────────── │',
  '│                      ▝▜█████▛▘                     │ What\'s new              │',
  '│                        ▘▘ ▝▝                       │ Added `claude agents -… │',
  '│       Opus 4.7 (1M context) · Claude Max ·         │ Added `agent_id` and `… │',
  '│       grenkalove@gmail.com\'s Organization          │ Status line JSON input… │',
  '│ ~/.claude-lab/thrall/.claude/jarvis-channel/plugin │ /release-notes for more │',
  '╰──────────────────────────────────────────────────────────────────────────────╯',
].join('\n')

const CHANNEL_STATUS = [
  'Listening for channel messages from:',
  ' server:dashi-channel',
].join('\n')

const INBOUND_WARNING = [
  ' Experimental · inbound messages will be pushed',
  'into this session, this carries',
  '  prompt injection risks. Restart Claude',
  'Code without',
  '  --dangerously-disable-channels to disable.',
].join('\n')

const CONVERSATION = [
  '> Что у нас по EdgeLab?',
  '',
  '● Сделано. Порядок восстановлен.',
  '  Статус: 25 записей, 549780 RUB.',
].join('\n')

const INPUT_PROMPT_BOX = [
  '────────────────────────────────────────────────────────────────────────────────',
  '>                                                                              ',
  '────────────────────────────────────────────────────────────────────────────────',
].join('\n')

const FOOTER_HINTS = [
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
  '  ✗ Auto-update failed · Try claude doctor or npm i -g @anthropic-ai/claude-code',
  '  tmux focus-events off · add \'set -g focus-events on\' to ~/.tmux.conf',
].join('\n')

const FULL_PANE = [
  BOOT_BANNER,
  '',
  '',
  CHANNEL_STATUS,
  INBOUND_WARNING,
  '',
  CONVERSATION,
  '',
  INPUT_PROMPT_BOX,
  FOOTER_HINTS,
].join('\n')

// ─── Helpers ─────────────────────────────────────────────────────────

function typesOf(text: string): SegmentType[] {
  return segmentizePane(text).map((s) => s.type)
}

// ─── segmentizePane: type classification ─────────────────────────────

describe('segmentizePane — classification', () => {
  test('isolates boot banner between ╭─Claude Code v…─╮ and ╰─…─╯', () => {
    const segs = segmentizePane(BOOT_BANNER)
    expect(segs.length).toBe(1)
    expect(segs[0]?.type).toBe('boot_banner')
    expect(segs[0]?.text).toContain('Claude Code v2.1.144')
    expect(segs[0]?.text).toContain('grenkalove@gmail.com')
  })

  test('captures «Listening for channel messages from:» + server line as channel_status', () => {
    const segs = segmentizePane(CHANNEL_STATUS)
    expect(segs.length).toBe(1)
    expect(segs[0]?.type).toBe('channel_status')
    expect(segs[0]?.text).toContain('Listening for channel messages from:')
    expect(segs[0]?.text).toContain('server:dashi-channel')
  })

  test('captures Experimental-inbound block until «to disable.»', () => {
    const segs = segmentizePane(INBOUND_WARNING)
    expect(segs.length).toBe(1)
    expect(segs[0]?.type).toBe('inbound_warning')
    expect(segs[0]?.text).toContain('Experimental')
    expect(segs[0]?.text).toContain('to disable.')
  })

  test('arbitrary text falls through as conversation', () => {
    const segs = segmentizePane(CONVERSATION)
    expect(segs.length).toBe(1)
    expect(segs[0]?.type).toBe('conversation')
    expect(segs[0]?.text).toContain('EdgeLab')
  })

  test('footer hints (bypass permissions / Auto-update / tmux focus-events) collapse into one footer_hints segment', () => {
    const segs = segmentizePane(FOOTER_HINTS)
    expect(segs.length).toBe(1)
    expect(segs[0]?.type).toBe('footer_hints')
    expect(segs[0]?.text).toContain('bypass permissions')
    expect(segs[0]?.text).toContain('Auto-update failed')
    expect(segs[0]?.text).toContain('tmux focus-events')
  })

  test('full pane: types appear in the canonical order', () => {
    const types = typesOf(FULL_PANE)
    // The exact list (no extraneous segments, no swapped order).
    // `input_box` was promoted from "lives inside conversation" to its
    // own segment on 2026-05-22 — see scanner branch 6 in the filter.
    expect(types).toEqual([
      'boot_banner',
      'channel_status',
      'inbound_warning',
      'conversation',
      'input_box',
      'footer_hints',
    ])
  })

  test('empty input → empty segment list', () => {
    expect(segmentizePane('')).toEqual([])
    expect(segmentizePane('   \n\n  \n').length).toBe(0)
  })

  test('pane with only conversation → single conversation segment', () => {
    const text = 'just some agent output\nsecond line\n'
    const segs = segmentizePane(text)
    expect(segs.length).toBe(1)
    expect(segs[0]?.type).toBe('conversation')
  })

  test('input prompt box (─ line + > line + ─ line) classifies as input_box', () => {
    // 2026-05-22: input box was promoted to its own segment so the
    // warchief's mirror can hide it. A conversation line that follows
    // («> hello», not all-whitespace after >) breaks out of the box.
    const segs = segmentizePane(INPUT_PROMPT_BOX + '\n> hello\n')
    const types = segs.map((s) => s.type)
    expect(types).toContain('input_box')
    expect(types).toContain('conversation')
    expect(types).not.toContain('footer_hints')
  })
})

// ─── filterPane: hide-list application ───────────────────────────────

describe('filterPane — applies hide-list', () => {
  test('default hide-list drops boot_banner / inbound_warning / footer_hints, keeps the rest', () => {
    const out = filterPane(FULL_PANE)
    // Hidden:
    expect(out).not.toContain('Claude Code v2.1.144')
    expect(out).not.toContain('Welcome back Dashi')
    expect(out).not.toContain('grenkalove@gmail.com')
    expect(out).not.toContain('Experimental · inbound messages')
    expect(out).not.toContain('prompt injection risks')
    expect(out).not.toContain('bypass permissions')
    expect(out).not.toContain('Auto-update failed')
    expect(out).not.toContain('tmux focus-events')
    // Kept:
    expect(out).toContain('Listening for channel messages from:')
    expect(out).toContain('server:dashi-channel')
    expect(out).toContain('EdgeLab')
    expect(out).toContain('Сделано. Порядок восстановлен.')
  })

  test('DEFAULT_HIDDEN_SEGMENTS lists the four groups we hide by default', () => {
    // 2026-05-22: `input_box` joined the default hide list — the
    // warchief's iPhone mirror should not surface the prompt area.
    expect(new Set(DEFAULT_HIDDEN_SEGMENTS)).toEqual(
      new Set<SegmentType>([
        'boot_banner',
        'inbound_warning',
        'footer_hints',
        'input_box',
      ]),
    )
  })

  test('empty hide-list returns full pane content (no filtering)', () => {
    const out = filterPane(FULL_PANE, { hide: [] })
    expect(out).toContain('Claude Code v2.1.144')
    expect(out).toContain('bypass permissions')
    expect(out).toContain('Experimental')
  })

  test('hiding everything yields empty string', () => {
    const out = filterPane(FULL_PANE, {
      hide: [
        'boot_banner',
        'inbound_warning',
        'channel_status',
        'conversation',
        'footer_hints',
        'input_box',
        'inbound_preview',
      ],
    })
    expect(out.trim()).toBe('')
  })

  test('non-default hide-list (e.g. only footer) leaves everything else visible', () => {
    const out = filterPane(FULL_PANE, { hide: ['footer_hints'] })
    expect(out).toContain('Claude Code v2.1.144')
    expect(out).toContain('Experimental')
    expect(out).toContain('Listening for channel messages from:')
    expect(out).not.toContain('bypass permissions')
    expect(out).not.toContain('Auto-update failed')
  })

  test('preserves relative order of kept segments', () => {
    const out = filterPane(FULL_PANE)
    const channelIdx = out.indexOf('Listening for channel messages from:')
    const convIdx = out.indexOf('EdgeLab')
    expect(channelIdx).toBeGreaterThanOrEqual(0)
    expect(convIdx).toBeGreaterThan(channelIdx)
  })
})

// ─── Robustness — adversarial inputs ─────────────────────────────────

describe('segmentizePane — robustness', () => {
  test('unterminated boot banner (missing ╰─ row) does not eat the whole pane', () => {
    // If the banner-close line is missing (truncated capture), we must
    // still close the banner segment at some sensible boundary so the
    // rest of the pane is classified normally — otherwise a single missing
    // line would hide ALL subsequent output.
    const partial = BOOT_BANNER.split('\n').slice(0, 4).join('\n') // top half only
    const tail = '\n' + CONVERSATION + '\n' + FOOTER_HINTS
    const segs = segmentizePane(partial + tail)
    const types = segs.map((s) => s.type)
    expect(types).toContain('conversation')
    expect(types).toContain('footer_hints')
  })

  test('footer pattern not at the bottom is still classified', () => {
    // Real captures sometimes show «Auto-update failed» as the only footer
    // line. We accept any of the three footer signals on its own.
    const text =
      'some agent output\n\n  ✗ Auto-update failed · Try claude doctor\n'
    const segs = segmentizePane(text)
    const types = segs.map((s) => s.type)
    expect(types).toContain('footer_hints')
  })

  test('inbound warning without the closing "to disable." is bounded by safety cap', () => {
    // If someone removes the trailing line, the warning state must not
    // swallow the rest of the pane. Cap is INBOUND_LINE_CAP=12 lines.
    const broken = ' Experimental · inbound messages\n' + 'noise line\n'.repeat(40) + CONVERSATION
    const types = typesOf(broken)
    // The warning is closed and the conversation classified.
    expect(types).toContain('conversation')
  })

  test('channel_status block sandwiched by other content is preserved', () => {
    const text = CONVERSATION + '\n\n' + CHANNEL_STATUS + '\n\n' + CONVERSATION
    const types = typesOf(text)
    expect(types).toContain('channel_status')
    expect(types.filter((t) => t === 'conversation').length).toBeGreaterThanOrEqual(1)
  })

  // ─── False-positive guards from 2026-05-20 cross-review ──────────────

  test('unified-diff conversation mentioning Claude Code v2 is NOT classified as banner', () => {
    // Regression: BANNER_OPEN_RE used to accept ASCII `+` as a corner
    // glyph, which matched every diff-addition line discussing this
    // plugin in chat. Stripped the leading-+ alternative; here we
    // verify the false positive is gone.
    const text = [
      '> Patch notes:',
      '+ patched Claude Code v2.1.144 to filter banner',
      '+ added bump() method',
      '+ pushed PR',
      '— still TODO: tests',
    ].join('\n')
    const segs = segmentizePane(text)
    expect(segs.length).toBeGreaterThan(0)
    for (const s of segs) {
      expect(s.type).not.toBe('boot_banner')
    }
  })

  test('conversation quoting «Experimental inbound message» is NOT classified as inbound_warning', () => {
    // Regression: INBOUND_OPEN_RE used to match anywhere in the line,
    // which hid the next 12 lines whenever someone discussed the
    // injection warning in chat. The opener is now anchored to line
    // start + the middle-dot phrase.
    const text = [
      '> The Experimental feature for inbound message routing was added.',
      'I think we should rename the flag.',
      'Also: the Claude Code "inbound messages" hint is misleading.',
    ].join('\n')
    const segs = segmentizePane(text)
    for (const s of segs) {
      expect(s.type).not.toBe('inbound_warning')
    }
    expect(segs.map((s) => s.type)).toContain('conversation')
  })

  test('real inbound warning (line-start + Experimental · inbound) IS still classified', () => {
    // The strict opener must not over-fit — the genuine banner shape
    // must still be detected. Without leading whitespace too.
    const segs = segmentizePane('Experimental · inbound messages will be pushed\nfollow line\n to disable.')
    expect(segs[0]?.type).toBe('inbound_warning')
  })

  test('footer signal mid-pane does NOT absorb subsequent conversation', () => {
    // Regression: footer used to be an absorbing tail — first match
    // dropped everything after it. tmux redraws sometimes leave a
    // stale «bypass permissions» line above newer output; the new
    // logic closes the footer segment on the first non-footer line.
    const text = [
      'fresh agent output',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
      'more agent output AFTER the stale footer line',
      'final assistant turn',
    ].join('\n')
    const segs = segmentizePane(text)
    const types = segs.map((s) => s.type)
    // Two conversation segments (before and after the footer) + one
    // footer in the middle.
    expect(types).toEqual(['conversation', 'footer_hints', 'conversation'])
    const trailingConv = segs[segs.length - 1]
    expect(trailingConv?.text).toContain('final assistant turn')
  })

  test('reasonable performance on a 10 000-line pane (<200ms)', () => {
    // Worst-case capture-pane could surface a long scrollback; the filter
    // must remain linear and not stall the polling loop. We do not assert
    // a strict ms count (CI noise) — just that it completes well under
    // the polling cadence (5s by default).
    const big = (CONVERSATION + '\n').repeat(2000) // ~ 10k lines
    const t0 = Date.now()
    const out = filterPane(big)
    const dt = Date.now() - t0
    expect(out.length).toBeGreaterThan(0)
    expect(dt).toBeLessThan(2000)
  })
})

// ─── input_box segment (added 2026-05-22) ────────────────────────────

describe('segmentizePane — input_box', () => {
  test('separator + > cursor + separator classifies as one input_box segment', () => {
    const segs = segmentizePane(INPUT_PROMPT_BOX)
    expect(segs.length).toBe(1)
    expect(segs[0]?.type).toBe('input_box')
    expect(segs[0]?.text).toContain('─')
  })

  test('separator + ❯ (U+276F) + separator classifies as input_box', () => {
    // Claude Code v2.1.144 emits U+276F as the cursor glyph; the legacy
    // ASCII `>` and the new ❯ must both classify as cursor lines.
    const box = [
      '────────────────────────────────────────',
      '❯                                       ',
      '────────────────────────────────────────',
    ].join('\n')
    const segs = segmentizePane(box)
    expect(segs.length).toBe(1)
    expect(segs[0]?.type).toBe('input_box')
  })

  test('input_box absorbs interleaved blank lines between separators and cursor', () => {
    const box = [
      '────────────────────────────────────────',
      '',
      '❯                                       ',
      '',
      '────────────────────────────────────────',
    ].join('\n')
    const segs = segmentizePane(box)
    expect(segs.length).toBe(1)
    expect(segs[0]?.type).toBe('input_box')
  })

  test('input_box closes on the first non-matching line; later conversation survives', () => {
    const text = [
      INPUT_PROMPT_BOX,
      '',
      '● Conversation line that must NOT be eaten by the box',
    ].join('\n')
    const types = segmentizePane(text).map((s) => s.type)
    expect(types).toEqual(['input_box', 'conversation'])
  })

  test('short ── inline (under 20 chars) is NOT an input_box', () => {
    // A diff line or a heading like «section ──» must stay in
    // conversation; the 20-glyph threshold rules that out.
    const text = [
      '+ section ──── short separator',
      '● another bullet',
    ].join('\n')
    const types = segmentizePane(text).map((s) => s.type)
    expect(types).toEqual(['conversation'])
  })

  test('conversation line «> Что у нас по EdgeLab?» is NOT a cursor (text after >)', () => {
    // The cursor anchor is `^\s*[>❯]\s*$` — line must be empty after
    // the cursor glyph. A quoted reply like `> Что у нас` has content
    // after `>` and stays in conversation. The lone separator above it
    // lacks a cursor confirmation (Codex 2026-05-22 [high] fix), so it
    // reclassifies as conversation rather than a fake input_box.
    const text = [
      '────────────────────────────────────────',
      '> Что у нас по EdgeLab?',
    ].join('\n')
    const segs = segmentizePane(text)
    const types = segs.map((s) => s.type)
    expect(types).not.toContain('input_box')
    expect(types).toContain('conversation')
    const conv = segs.find((s) => s.type === 'conversation' && s.text.includes('Что у нас'))
    expect(conv).toBeDefined()
  })

  test('standalone long ── line without cursor is NOT an input_box (markdown divider)', () => {
    // Codex review 2026-05-22 [high]: a long ── separator in tool
    // output (a markdown divider, a help-dump rule) must not vanish
    // from the mirror. Reclassified as conversation when the block
    // contains no cursor line.
    const text = [
      '● Some tool output',
      '────────────────────────────────────────',
      '● Continued output below the divider',
    ].join('\n')
    const types = segmentizePane(text).map((s) => s.type)
    expect(types).not.toContain('input_box')
    expect(types.every((t) => t === 'conversation')).toBe(true)
  })

  test('input_box stops at the 10-line cap (including opener) so a stray real box does not swallow scrollback', () => {
    // 8 separators + cursor + 20 more separators — the cap fires
    // before the trailing run is absorbed. Cursor is present so the
    // block IS classified as input_box. After the cap, remaining
    // separators end up reclassified individually (no cursor) as
    // conversation.
    const lines: string[] = []
    for (let k = 0; k < 8; k += 1) lines.push('────────────────────────────────────────')
    lines.push('❯                                       ')
    for (let k = 0; k < 20; k += 1) lines.push('────────────────────────────────────────')
    lines.push('● later content')
    const segs = segmentizePane(lines.join('\n'))
    const boxSegs = segs.filter((s) => s.type === 'input_box')
    expect(boxSegs.length).toBeGreaterThanOrEqual(1)
    // Cap is inclusive of opener — at most 10 lines per input_box.
    const firstBox = boxSegs[0]!.text.split('\n')
    expect(firstBox.length).toBeLessThanOrEqual(10)
    expect(segs.some((s) => s.type === 'conversation' && s.text.includes('later content'))).toBe(true)
  })
})

// ─── inbound_preview segment (added 2026-05-22) ──────────────────────

describe('segmentizePane — inbound_preview', () => {
  test('«← dashi-channel: …» line is a single-line inbound_preview segment', () => {
    const text = '← dashi-channel: <media kind="voice" file_id="AwAC***SpDA"'
    const segs = segmentizePane(text)
    expect(segs.length).toBe(1)
    expect(segs[0]?.type).toBe('inbound_preview')
    expect(segs[0]?.text).toContain('dashi-channel')
  })

  test('indented or quoted «← …» does NOT classify as inbound_preview', () => {
    // Anchor requires `^← ` at column zero — a quoted line with
    // leading whitespace stays in conversation. Same for diff lines.
    const text = [
      '  ← github: oops quoted in conversation',
      '+ ← diff: added by patch',
    ].join('\n')
    const segs = segmentizePane(text)
    const types = segs.map((s) => s.type)
    expect(types).not.toContain('inbound_preview')
    expect(types).toEqual(['conversation'])
  })

  test('uppercase / mixed-case channel name does NOT classify as inbound_preview', () => {
    // Codex review 2026-05-22 [medium]: the original `\S+:` form was
    // too loose — a tool printing «← GitHub: …» or «← Some Channel: …»
    // would hijack the latest_inbound_only pivot. Channel names must
    // now start with a lowercase ASCII letter and contain only
    // [a-z0-9_-].
    const text = [
      '← GitHub: issue title',
      '← Some Channel: free text label',
      '← 1bad: starts with digit',
    ].join('\n')
    const types = segmentizePane(text).map((s) => s.type)
    expect(types).not.toContain('inbound_preview')
  })

  test('multiple inbound previews in a row each get their own segment', () => {
    const text = [
      '← dashi-channel: msg one',
      '← dashi-channel: msg two',
      '● conversation between two messages',
      '← dashi-channel: msg three',
    ].join('\n')
    const types = segmentizePane(text).map((s) => s.type)
    expect(types).toEqual([
      'inbound_preview',
      'inbound_preview',
      'conversation',
      'inbound_preview',
    ])
  })
})

// ─── Tip footer line (added 2026-05-22) ──────────────────────────────

describe('segmentizePane — Tip footer', () => {
  test('«Tip: Use /btw …» is hidden as a footer_hints segment', () => {
    const text = 'Tip: Use /btw to ask a quick side question without interrupting Claude\'s current work'
    const segs = segmentizePane(text)
    expect(segs.length).toBe(1)
    expect(segs[0]?.type).toBe('footer_hints')
  })

  test('conversation phrase «Tip: try X» is NOT classified as footer', () => {
    // Anchor requires `Use /` literal — generic «Tip:» without `/`
    // command suffix must stay in conversation.
    const text = 'Tip: try indexing before that join, it cut p99 by 4x.'
    const segs = segmentizePane(text)
    expect(segs.length).toBe(1)
    expect(segs[0]?.type).toBe('conversation')
  })
})

// ─── filterPane mode='latest_inbound_only' ───────────────────────────

describe('filterPane — mode latest_inbound_only', () => {
  test('drops every segment up to AND INCLUDING the last inbound preview', () => {
    const text = [
      '● Earlier conversation about EdgeLab',
      '← dashi-channel: first voice from warchief',
      '● Reply to first voice',
      '← dashi-channel: second voice from warchief',
      '● Reply still in progress',
    ].join('\n')
    const out = filterPane(text, { hide: [], mode: 'latest_inbound_only' })
    // Nothing from before the second preview should leak.
    expect(out).not.toContain('Earlier conversation')
    expect(out).not.toContain('first voice')
    expect(out).not.toContain('Reply to first voice')
    expect(out).not.toContain('second voice') // anchor itself dropped
    // Only the activity AFTER the last preview remains.
    expect(out).toContain('Reply still in progress')
  })

  test('falls back to full_pane when no inbound preview is present', () => {
    const text = [
      '● Conversation without any inbound preview',
      '● Another line',
    ].join('\n')
    const out = filterPane(text, { hide: [], mode: 'latest_inbound_only' })
    expect(out).toContain('Conversation without any inbound preview')
    expect(out).toContain('Another line')
  })

  test('mode applies BEFORE hide list so hide cannot erase the anchor', () => {
    // Even if a misconfigured caller tries to hide inbound_preview,
    // the pivot still finds it (mode runs first), then hide drops it.
    const text = [
      '● Old turn',
      '← dashi-channel: PIVOT_LINE',
      '● New turn',
    ].join('\n')
    const out = filterPane(text, {
      hide: ['inbound_preview'],
      mode: 'latest_inbound_only',
    })
    expect(out).not.toContain('Old turn')
    expect(out).not.toContain('PIVOT_LINE')
    expect(out).toContain('New turn')
  })

  test('default mode is full_pane (backwards-compatible with existing callers)', () => {
    // No `mode` arg → existing behaviour preserved.
    const text = [
      '● Earlier turn',
      '← dashi-channel: preview',
      '● Later turn',
    ].join('\n')
    const out = filterPane(text, { hide: [] })
    expect(out).toContain('Earlier turn')
    expect(out).toContain('preview')
    expect(out).toContain('Later turn')
  })
})

// ─── capLines (added 2026-05-22) ─────────────────────────────────────

describe('capLines', () => {
  test('returns input unchanged when line count ≤ maxLines', () => {
    const text = ['a', 'b', 'c'].join('\n')
    expect(capLines(text, 3)).toBe(text)
    expect(capLines(text, 10)).toBe(text)
  })

  test('truncates from the TOP and prepends `… +N lines` marker', () => {
    const text = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n')
    const out = capLines(text, 3)
    const lines = out.split('\n')
    expect(lines.length).toBe(3)
    expect(lines[0]).toMatch(/^… \+\d+ lines$/)
    // Tail preserved: last `maxLines - 1` lines from input.
    expect(lines[1]).toBe('l4')
    expect(lines[2]).toBe('l5')
    // Dropped count is `inputLen - (maxLines - 1)` = 5 - 2 = 3.
    expect(lines[0]).toBe('… +3 lines')
  })

  test('maxLines = 0 disables capping', () => {
    const text = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n')
    expect(capLines(text, 0)).toBe(text)
  })

  test('empty input returns empty', () => {
    expect(capLines('', 5)).toBe('')
  })

  test('negative maxLines is a no-op (defensive)', () => {
    const text = 'a\nb\nc'
    expect(capLines(text, -1)).toBe(text)
  })
})
