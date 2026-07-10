// Tests for the ask-guard (autonomy M3) — the pure, stateless analysis that
// intercepts self-gating «жду го / дай добро»-style permission-asks when the
// agent holds an ACTIVE owner-granted autonomy mandate (lease) for a chat.
//
// The analysis (analyzeAsk) is pure: identical input → identical findings, which
// is what makes the no-resend-valve guarantee hold on the reply path. These
// tests cover the tier-1 pattern hits, the hard-gate suppression, the
// fence/blockquote/quote exclusions, the no-lease short-circuit, boundary
// near-misses that must NOT fire, and the two message builders.

import { describe, expect, test } from 'bun:test'

import {
  analyzeAsk,
  askGuardAdvisoryHint,
  askGuardBlockMessage,
} from '../../src/safety/ask-guard.js'

const LEASE = true as const

describe('analyzeAsk — no-lease short-circuit', () => {
  test('returns empty when no active lease, even for a blatant ask', () => {
    expect(analyzeAsk('жду го, мой вождь', { hasActiveLease: false })).toEqual([])
  })

  test('returns empty for empty text (with lease)', () => {
    expect(analyzeAsk('', { hasActiveLease: LEASE })).toEqual([])
  })

  test('returns empty for benign prose (with lease)', () => {
    expect(analyzeAsk('Готово, мой вождь. Код чист.', { hasActiveLease: LEASE })).toEqual([])
  })
})

describe('analyzeAsk — tier-1 pattern hits', () => {
  test('«жду го» fires ASK_WAIT_GO', () => {
    const f = analyzeAsk('жду го', { hasActiveLease: LEASE })
    expect(f.map((x) => x.code)).toContain('ASK_WAIT_GO')
  })

  test('«жду твоего слова» fires ASK_WAIT_GO', () => {
    const f = analyzeAsk('Готов начать, жду твоего слова.', { hasActiveLease: LEASE })
    expect(f.map((x) => x.code)).toContain('ASK_WAIT_GO')
  })

  test('«жду отмашки» fires ASK_WAIT_GO', () => {
    const f = analyzeAsk('Всё собрано, жду отмашки на мерж.', { hasActiveLease: LEASE })
    expect(f.map((x) => x.code)).toContain('ASK_WAIT_GO')
  })

  test('«жду подтверждения» fires ASK_WAIT_GO', () => {
    const f = analyzeAsk('жду подтверждения от тебя', { hasActiveLease: LEASE })
    expect(f.map((x) => x.code)).toContain('ASK_WAIT_GO')
  })

  test('«жду команды» fires ASK_WAIT_GO', () => {
    const f = analyzeAsk('жду команды, вождь', { hasActiveLease: LEASE })
    expect(f.map((x) => x.code)).toContain('ASK_WAIT_GO')
  })

  test('«дай добро» fires ASK_GIVE_GO', () => {
    const f = analyzeAsk('Дай добро — и я задеплою.', { hasActiveLease: LEASE })
    expect(f.map((x) => x.code)).toContain('ASK_GIVE_GO')
  })

  test('«дай го» fires ASK_GIVE_GO', () => {
    const f = analyzeAsk('дай го', { hasActiveLease: LEASE })
    expect(f.map((x) => x.code)).toContain('ASK_GIVE_GO')
  })

  test('«дай отмашку» fires ASK_GIVE_GO', () => {
    const f = analyzeAsk('дай отмашку', { hasActiveLease: LEASE })
    expect(f.map((x) => x.code)).toContain('ASK_GIVE_GO')
  })

  test('«скажи да — и я запущу» fires ASK_SAY_YES', () => {
    const f = analyzeAsk('скажи да — и я запущу пайплайн', { hasActiveLease: LEASE })
    expect(f.map((x) => x.code)).toContain('ASK_SAY_YES')
  })

  test('«скажи го, тогда продолжу» fires ASK_SAY_YES', () => {
    const f = analyzeAsk('скажи го, тогда продолжу', { hasActiveLease: LEASE })
    expect(f.map((x) => x.code)).toContain('ASK_SAY_YES')
  })

  test('«подтверди, и начну» fires ASK_CONFIRM_THEN', () => {
    const f = analyzeAsk('подтверди, и начну сборку', { hasActiveLease: LEASE })
    expect(f.map((x) => x.code)).toContain('ASK_CONFIRM_THEN')
  })

  test('«подтвердишь тогда» fires ASK_CONFIRM_THEN', () => {
    const f = analyzeAsk('подтвердишь тогда стартую', { hasActiveLease: LEASE })
    expect(f.map((x) => x.code)).toContain('ASK_CONFIRM_THEN')
  })

  test('«нужно твоё да» fires ASK_NEED_YES', () => {
    const f = analyzeAsk('Для мержа нужно твоё да.', { hasActiveLease: LEASE })
    expect(f.map((x) => x.code)).toContain('ASK_NEED_YES')
  })

  test('«нужно твоё «да»» (guillemets) fires ASK_NEED_YES', () => {
    const f = analyzeAsk('нужно твоё «да»', { hasActiveLease: LEASE })
    expect(f.map((x) => x.code)).toContain('ASK_NEED_YES')
  })

  test('«могу продолжать?» fires ASK_CAN_I', () => {
    const f = analyzeAsk('могу продолжать?', { hasActiveLease: LEASE })
    expect(f.map((x) => x.code)).toContain('ASK_CAN_I')
  })

  test('«могу начинать?» fires ASK_CAN_I', () => {
    const f = analyzeAsk('Всё готово. могу начинать?', { hasActiveLease: LEASE })
    expect(f.map((x) => x.code)).toContain('ASK_CAN_I')
  })

  test('«жду решения по мержу» fires ASK_WAIT_DECISION', () => {
    const f = analyzeAsk('жду решения по мержу', { hasActiveLease: LEASE })
    expect(f.map((x) => x.code)).toContain('ASK_WAIT_DECISION')
  })

  test('«жду твоего решения по деплою» fires ASK_WAIT_DECISION', () => {
    const f = analyzeAsk('жду твоего решения по деплою', { hasActiveLease: LEASE })
    expect(f.map((x) => x.code)).toContain('ASK_WAIT_DECISION')
  })

  test('case-insensitive: «ЖДУ ГО» still fires', () => {
    const f = analyzeAsk('ЖДУ ГО', { hasActiveLease: LEASE })
    expect(f.map((x) => x.code)).toContain('ASK_WAIT_GO')
  })
})

describe('analyzeAsk — findings shape', () => {
  test('carries a clipped snippet of the offending fragment, not the whole body', () => {
    const body = 'Огромный контекст перед этим. '.repeat(5) + 'жду го'
    const f = analyzeAsk(body, { hasActiveLease: LEASE })
    expect(f.length).toBeGreaterThan(0)
    const snip = f[0]!.snippet
    expect(snip.length).toBeLessThanOrEqual(60)
    expect(snip.toLowerCase()).toContain('жду го')
    // Never the whole message.
    expect(snip.length).toBeLessThan(body.length)
  })

  test('dedupes by code — one finding per distinct pattern even on repeats', () => {
    const f = analyzeAsk('жду го\nи ещё раз жду го', { hasActiveLease: LEASE })
    const waitGo = f.filter((x) => x.code === 'ASK_WAIT_GO')
    expect(waitGo.length).toBe(1)
  })

  test('multiple distinct patterns yield multiple findings', () => {
    const f = analyzeAsk('дай добро.\nмогу продолжать?', { hasActiveLease: LEASE })
    const codes = new Set(f.map((x) => x.code))
    expect(codes.has('ASK_GIVE_GO')).toBe(true)
    expect(codes.has('ASK_CAN_I')).toBe(true)
  })
})

describe('analyzeAsk — hard-gate suppression', () => {
  test('«деньги» in the same text suppresses all findings', () => {
    expect(analyzeAsk('жду го на списание денег', { hasActiveLease: LEASE })).toEqual([])
  })

  test('«миграци» suppresses', () => {
    expect(analyzeAsk('дай добро, применяю миграцию на прод', { hasActiveLease: LEASE })).toEqual([])
  })

  test('«платеж» suppresses', () => {
    expect(analyzeAsk('могу продолжать? это платежный конфиг', { hasActiveLease: LEASE })).toEqual([])
  })

  test('«prod бд» suppresses', () => {
    expect(analyzeAsk('жду отмашки на запись в prod бд', { hasActiveLease: LEASE })).toEqual([])
  })

  test('«rm -rf» suppresses', () => {
    expect(analyzeAsk('дай го на rm -rf каталога', { hasActiveLease: LEASE })).toEqual([])
  })

  test('«force-push» suppresses', () => {
    expect(analyzeAsk('подтверди, и сделаю force-push', { hasActiveLease: LEASE })).toEqual([])
  })

  test('«массовая рассылка» suppresses', () => {
    expect(analyzeAsk('жду го на массовую рассылку юзерам', { hasActiveLease: LEASE })).toEqual([])
  })

  test('«деструктив» suppresses', () => {
    expect(analyzeAsk('дай добро — операция деструктивная', { hasActiveLease: LEASE })).toEqual([])
  })

  test('«gateway» suppresses', () => {
    expect(analyzeAsk('могу продолжать? нужен рестарт gateway', { hasActiveLease: LEASE })).toEqual([])
  })

  test('«биллинг» suppresses', () => {
    expect(analyzeAsk('жду твоего слова по биллингу', { hasActiveLease: LEASE })).toEqual([])
  })

  test('hard-gate marker is judged over the WHOLE message, across lines', () => {
    const body = 'жду го\n\nконтекст: это меняет платежный конфиг'
    expect(analyzeAsk(body, { hasActiveLease: LEASE })).toEqual([])
  })
})

describe('analyzeAsk — fenced-code exclusion', () => {
  test('an ask INSIDE a ``` fence never fires', () => {
    const body = '```\nжду го\n```'
    expect(analyzeAsk(body, { hasActiveLease: LEASE })).toEqual([])
  })

  test('prose ask outside the fence still fires while fenced copy is ignored', () => {
    const body = '```\nдай добро\n```\nмогу продолжать?'
    const f = analyzeAsk(body, { hasActiveLease: LEASE })
    const codes = new Set(f.map((x) => x.code))
    expect(codes.has('ASK_CAN_I')).toBe(true)
    // The fenced «дай добро» must NOT contribute.
    expect(codes.has('ASK_GIVE_GO')).toBe(false)
  })
})

describe('analyzeAsk — blockquote / quoted-line exclusion', () => {
  test('a «>»-quoted ask never fires', () => {
    expect(analyzeAsk('> жду го', { hasActiveLease: LEASE })).toEqual([])
  })

  test('quoting the owner then acting: only the non-quoted line is scanned', () => {
    const body = '> ты просил: жду го\nделаю сам, доложу.'
    expect(analyzeAsk(body, { hasActiveLease: LEASE })).toEqual([])
  })
})

describe('analyzeAsk — boundary near-misses do NOT fire', () => {
  test('«жду городах» does not match «жду го»', () => {
    expect(analyzeAsk('жду городах новых фич', { hasActiveLease: LEASE })).toEqual([])
  })

  test('«добросовестно» does not match «добро»', () => {
    expect(analyzeAsk('делаю добросовестно и в срок', { hasActiveLease: LEASE })).toEqual([])
  })

  test('«жду результатов CI» does not fire', () => {
    expect(analyzeAsk('жду результатов CI перед мержем', { hasActiveLease: LEASE })).toEqual([])
  })

  test('«жду завершения тестов» does not fire', () => {
    expect(analyzeAsk('жду завершения тестов, доложу', { hasActiveLease: LEASE })).toEqual([])
  })

  test('«подтверждение доставки» (noun) does not fire ASK_CONFIRM_THEN', () => {
    expect(analyzeAsk('пришло подтверждение доставки платежа', { hasActiveLease: LEASE })).toEqual([])
  })
})

describe('analyzeAsk — never throws (fails open by contract)', () => {
  test('handles CRLF and lone CR without throwing', () => {
    expect(() => analyzeAsk('жду го\r\nещё\rтекст', { hasActiveLease: LEASE })).not.toThrow()
  })

  test('handles a very long single line', () => {
    const body = 'слово '.repeat(5000) + 'жду го'
    expect(() => analyzeAsk(body, { hasActiveLease: LEASE })).not.toThrow()
  })
})

describe('askGuardAdvisoryHint / askGuardBlockMessage', () => {
  test('advisory hint carries the lease id and the act-with-veto nudge, no message text', () => {
    const hint = askGuardAdvisoryHint('L-20260710-abcd1234')
    expect(hint).toContain('ask_guard_hint')
    expect(hint).toContain('L-20260710-abcd1234')
    expect(hint.toLowerCase()).toContain('act-with-veto')
  })

  test('block message names the lease, the scope, and the AskUserQuestion escape', () => {
    const msg = askGuardBlockMessage('L-20260710-abcd1234', 'реализуй M3 ask-guard по порядку')
    expect(msg).toContain('ASK_GUARD')
    expect(msg).toContain('L-20260710-abcd1234')
    expect(msg).toContain('реализуй M3 ask-guard')
    expect(msg).toContain('AskUserQuestion')
  })

  test('block message clips an over-long scope', () => {
    const longScope = 'очень длинный скоуп '.repeat(20)
    const msg = askGuardBlockMessage('L-1', longScope)
    // The full scope must not be echoed verbatim (it is clipped to ~80 cps).
    expect(msg).toContain('…')
    expect(msg.length).toBeLessThan(longScope.length + 200)
  })
})
