// Ask-guard (autonomy M3) — the ENFORCEMENT analysis for owner-granted
// autonomy mandates.
//
// Context: M1 built a durable per-chat registry of owner-granted autonomy
// mandates (leases); M2 added the grant paths. This module is the pure,
// deterministic analysis behind M3: when the agent holds an ACTIVE lease for a
// chat and STILL writes a «жду го / дай добро»-style permission-ask to the
// owner, that ask is self-gating — the owner already handed over authority
// inside the lease's scope, so the agent must ACT (act-with-veto) instead of
// asking again. `analyzeAsk` recognises those narrow, high-precision patterns.
//
// Design (GPT-5.6 Sol architectural review — binding):
//   * NO resend-valve: an agent that re-sends the SAME blocked text must NOT
//     slip through (that would be a self-bypass). This module is stateless —
//     identical input yields an identical finding every time; the reply path
//     that consumes it therefore blocks a resend exactly as it blocked the
//     first send.
//   * The legal escape for a GENUINE product question is the AskUserQuestion
//     card path, which is NEVER routed through here — so a real decision the
//     owner must make still reaches him (as tappable buttons), only the
//     self-gating "may I proceed?" prose is intercepted.
//   * HARD-GATE EXEMPTION: a permission-ask that mentions a hard-gate action
//     (money, prod DB, migrations, destructive ops, model/gateway config, mass
//     sends…) is ALWAYS legitimate — those genuinely require the owner's word
//     regardless of any lease — so any such text yields NO finding.
//
// Style mirrors format-check.ts: fence-protected line scan, a small findings
// model, never throws by contract (the caller treats a throw as "no findings"
// and fails open). Like format-check it NEVER rewrites prose; unlike it, it
// carries the matched snippet so the reply path can log which pattern fired.

import { fenceProtectedLines } from '../format/rich.js'

export interface AskGuardFinding {
  // Machine code for the tier-1 pattern that matched (stable — surfaces in
  // logs). One finding per distinct code, even if a pattern matches twice.
  code: string
  // The matched snippet (clipped), for the structured log. NEVER the whole
  // message body — only the offending fragment.
  snippet: string
}

// A single cased letter class covering Cyrillic + Latin. The `i` flag on each
// pattern makes it match the upper-case forms too (and folds inside classes),
// so `[а-яёa-z]` behaves as "any Russian/English letter" for boundary checks.
// NB: JS `\w` does NOT match Cyrillic, which is why the spec's `\w*` becomes
// an explicit class here.
const LETTER = '[а-яёa-z]'
// Word boundaries that respect Cyrillic (`\b` is ASCII-only in JS). A keyword
// must not be glued to another letter on either side, so «жду городах» never
// matches «жду го» and «добросовестно» never matches «добро».
const B = `(?<!${LETTER})`
const A = `(?!${LETTER})`

// Optional quote wrapper around a bare «да» / «yes» token (plain, guillemet or
// typographic) — the spec's `"?да"?`.
const Q = '["«»“”]?'

// Tier-1 self-gating permission-ask patterns (narrow, high-precision, Russian).
// Case-insensitive; matched only OUTSIDE fenced code and blockquotes by the
// scanner below. Each is anchored on Cyrillic-aware boundaries so near-misses
// («жду результатов CI», «дай знать как посмотришь», «подтверждение доставки»,
// «жду завершения тестов») do NOT fire.
interface AskPattern {
  code: string
  re: RegExp
}

const TIER1: ReadonlyArray<AskPattern> = [
  // «жду (го|отмашк…|твоего слова|команд…|добро)». NB: «подтвержден…» is
  // NOT here — it moved to ASK_WAIT_CONFIRM below (fix-loop #4), which only
  // fires when the confirmation-wait is OWNER-directed, so a status-wait like
  // «жду подтверждения оплаты от провайдера» / «жду подтверждения вебхука»
  // no longer self-gates.
  {
    code: 'ASK_WAIT_GO',
    re: new RegExp(
      `${B}жду\\s+(?:го|отмашк${LETTER}*|твоего\\s+слова|команд${LETTER}*|добро)${A}`,
      'i',
    ),
  },
  // «жду подтверждени(е|я)» — fires ONLY when owner-directed (fix-loop #4,
  // Codex MED-4 / Fable MED-4; narrowed again in fix-loop #6). Two shapes fire:
  //   (A) owner-PREFIXED «жду тво[её]… подтверждения» — «твоего/твоё» before the
  //       noun makes it unambiguously owner-directed regardless of what trails,
  //       so it fires on the whole phrase (a money-flavoured trailer like
  //       «оплаты» is caught by the whole-text hard-gate exemption anyway).
  //   (B) no owner prefix «жду подтверждения …» + one of:
  //         • TERMINAL: optional non-comma sentence punctuation then end-of-line
  //           (a bare owner-wait that ENDS the clause), OR
  //         • COMMA + owner ref («жду подтверждения, вождь / твоё / от тебя»), OR
  //         • SPACE + owner ref («жду подтверждения от тебя / твоё / вождь»).
  // fix-loop #6 (Codex round-2): the OLD terminal branch accepted ANY comma
  // regardless of the following words, so a STATUS wait «жду подтверждения, что
  // CI завершился» self-gated by mistake. The comma now only satisfies the
  // lookahead when an owner ref follows it. «жду подтверждения <noun>» (оплаты /
  // завершения workflow / вебхука / статуса CI / от провайдера) still does NOT
  // fire. Same ASK_WAIT_GO code so the finding taxonomy stays stable.
  {
    code: 'ASK_WAIT_GO',
    re: new RegExp(
      `${B}жду\\s+(?:` +
        // (A) owner-prefixed — always owner-directed
        `тво[её]${LETTER}*\\s+подтвержден(?:и[еяю]|ья)${A}` +
        `|` +
        // (B) no prefix — needs a terminal-at-EOL / comma-owner / space-owner tail
        `подтвержден(?:и[еяю]|ья)(?=` +
          `\\s*[.!?…)]?\\s*$` +
          `|\\s*,\\s*(?:от\\s+тебя|тво[её]${LETTER}*|вожд${LETTER}*)` +
          `|\\s+(?:от\\s+тебя|тво[её]${LETTER}*|вожд${LETTER}*)(?!${LETTER})` +
        `)` +
      `)`,
      'i',
    ),
  },
  // «дай (го|добро|отмашку)»
  {
    code: 'ASK_GIVE_GO',
    re: new RegExp(`${B}дай\\s+(?:го|добро|отмашку)${A}`, 'i'),
  },
  // «скажи ("да"|го) [—] (и|тогда)? (я)? (запущу|начну|продолжу|сделаю)»
  {
    code: 'ASK_SAY_YES',
    re: new RegExp(
      `${B}скажи\\s+(?:${Q}да${Q}|го)\\s*[—–,-]?\\s*(?:и|тогда)?\\s*(?:я\\s+)?(?:запущу|начну|продолжу|сделаю)${A}`,
      'i',
    ),
  },
  // «подтверди(шь)? [,] (и|тогда)»
  {
    code: 'ASK_CONFIRM_THEN',
    re: new RegExp(`${B}подтверди(?:шь)?[,\\s]+(?:и|тогда)${A}`, 'i'),
  },
  // «нужно твоё "да"»
  {
    code: 'ASK_NEED_YES',
    re: new RegExp(`${B}нужно\\s+тво[её]\\s+${Q}да${Q}${A}`, 'i'),
  },
  // «могу (начинать|продолжать|запускать)?»
  {
    code: 'ASK_CAN_I',
    re: new RegExp(`${B}могу\\s+(?:начинать|продолжать|запускать)\\s*\\?`, 'i'),
  },
  // «жду (решения|твоего решения) (по|для)? (мержу|деплою|запуску)»
  {
    code: 'ASK_WAIT_DECISION',
    re: new RegExp(
      `${B}жду\\s+(?:тво[её]го\\s+)?решени[яе]\\s+(?:по|для)?\\s*(?:мержу|деплою|запуску)${A}`,
      'i',
    ),
  },
]

// Hard-gate markers — questions about these actions are ALWAYS legitimate
// (they need the owner's word regardless of any lease), so their presence
// anywhere in the SAME text suppresses every finding. Case-insensitive covers
// «БД»/«DB» and any cased Cyrillic.
//
// The vocabulary is deliberately BROAD (fix-loop #1, Codex BLOCK-1 / Fable
// HIGH-1 — safety-critical): a hard-gate ask that leaks through the guard is a
// far worse failure than an over-exemption (which merely delivers a benign
// reply). Conservative principle: WHEN UNCERTAIN, EXEMPT. The regex is tested
// against a ё→е-folded copy of the message (see `foldYo`), so «платёж» folds to
// «платеж» and matches the `платеж` stem without a separate ё-branch.
//
// `ден[ье]г` covers «деньги/деньгах» (stem `деньг`) AND the genitive «денег».
const HARD_GATE_RE = new RegExp(
  [
    // ── money / payments ──
    'ден[ье]г', // деньги / денег
    'оплат[а-яё]*', // оплата / оплаты / оплат / оплатить
    'платеж[а-яё]*', // платёж→платеж (folded) / платежный / платежи
    'биллинг',
    'billing',
    'payment',
    // ── prod DB / migrations (Latin `prod` AND Cyrillic «прод») ──
    '(?:prod|прод)[\\s.\\-]?(?:баз[а-яё]*|бд|db)', // prod бд / прод-базу
    'production\\s+database',
    'миграци[а-яё]*',
    'migrat', // migration / migrate
    'drop\\s+table',
    'truncate',
    'delete\\s+from',
    // ── destructive ──
    'rm\\s+-rf',
    'force-?push',
    'git\\s+reset\\s+--hard',
    'git\\s+clean',
    'удал[а-яё]*', // удалю / удаление / удалить (data deletion)
    'деструктив[а-яё]*',
    // ── mass sends ──
    'массов[а-яё]*', // массовая (рассылка/отправка/…)
    'рассылк[а-яё]*', // рассылка (inherently a mass send)
    'отправк[а-яё]*\\s+(?:по\\s+)?(?:баз|юзер|всем|пользовател)', // отправка по базе/юзерам/всем
    'mass\\s+send',
    'broadcast',
    // ── model / gateway / bot config + own-channel restarts ──
    'model\\s+config',
    'gateway',
    'конфиг\\s+(?:модел[а-яё]*|gateway)', // конфиг модели / конфиг gateway
    'рестарт\\s+(?:канала|gateway|бота)',
  ].join('|'),
  'i',
)

// Fold «ё»→«е» (both cases) on a COPY used only for the hard-gate test, so
// «платёж» matches the `платеж` stem. Never mutates the text scanned for
// tier-1 findings (that scan keeps ё so Cyrillic boundaries stay exact).
function foldYo(s: string): string {
  return s.replace(/ё/g, 'е').replace(/Ё/g, 'Е')
}

// A blockquote line (`>` prefix) — treated as protected like fenced code, so a
// quoted permission-ask (e.g. the agent echoing the owner) never fires.
const BLOCKQUOTE_RE = /^\s*>/

// Truncate on code points (not UTF-16 units) so a surrogate pair is never
// sliced — mirrors store.ts truncate.
function clip(s: string, maxChars: number): string {
  const cps = Array.from(s)
  if (cps.length <= maxChars) return s
  return `${cps.slice(0, Math.max(0, maxChars - 1)).join('')}…`
}

const SNIPPET_MAX_CHARS = 60

// Why a message was hard-gate exempted (fix-loop #2, Codex HIGH-3 / Fable
// LOW-5). `hard_gate` = the marker is in real prose. `hard_gate_protected_only`
// = the marker survives ONLY inside a fenced/quoted zone (the fence/quote-masked
// prose does NOT match) — STILL exempt (whole-text OR fails safe against
// over-blocking), but flagged so calibration week can see this class and decide
// whether a quoted hard-gate word is masking a genuine self-gate.
export type AskExemptReason = 'hard_gate' | 'hard_gate_protected_only'

export interface AskGuardAnalysis {
  // One finding per distinct tier-1 pattern that fired, or empty when clean or
  // exempt.
  findings: AskGuardFinding[]
  // Set ONLY when a hard-gate exemption suppressed the scan. Undefined for a
  // clean pass (findings may be non-empty) and for the no-lease/empty
  // short-circuits.
  exemptReason?: AskExemptReason
}

/**
 * Full analysis of `text` for self-gating permission-asks. PURE + stateless:
 * identical input → identical output, which is what makes the no-resend-valve
 * guarantee hold in the reply path.
 *
 * Short-circuits (empty findings, no exemptReason) when there is no active
 * lease or the text is empty.
 *
 * Hard-gate exemption is judged on the WHOLE message (the spec: "if the SAME
 * text contains hard-gate markers") so an over-exemption always fails safe —
 * but we ALSO recompute the marker on the fence/quote-masked prose to classify
 * whether the exemption came only from a protected zone (`exemptReason`).
 */
export function analyzeAskDetailed(
  text: string,
  opts: { hasActiveLease: boolean },
): AskGuardAnalysis {
  if (!opts.hasActiveLease) return { findings: [] }
  if (text.length === 0) return { findings: [] }

  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  const fenceMask = fenceProtectedLines(lines)

  // Whole-text hard-gate test (the authoritative, fail-safe check).
  if (HARD_GATE_RE.test(foldYo(normalized))) {
    // Recompute on prose with fenced/blockquoted lines stripped. If the marker
    // is gone, the exemption rested ONLY on a protected zone → distinct code.
    const prose = lines
      .filter((l, i) => !fenceMask[i] && !BLOCKQUOTE_RE.test(l as string))
      .join('\n')
    const reason: AskExemptReason = HARD_GATE_RE.test(foldYo(prose))
      ? 'hard_gate'
      : 'hard_gate_protected_only'
    return { findings: [], exemptReason: reason }
  }

  const findings: AskGuardFinding[] = []
  const seen = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    if (fenceMask[i]) continue
    const line = lines[i] as string
    if (BLOCKQUOTE_RE.test(line)) continue
    for (const p of TIER1) {
      if (seen.has(p.code)) continue
      const m = line.match(p.re)
      if (m !== null) {
        findings.push({ code: p.code, snippet: clip(m[0], SNIPPET_MAX_CHARS) })
        seen.add(p.code)
      }
    }
  }
  return { findings }
}

/**
 * Thin wrapper returning ONLY the findings array — the stable surface used by
 * unit tests and any caller that does not need the exemption classification.
 */
export function analyzeAsk(text: string, opts: { hasActiveLease: boolean }): AskGuardFinding[] {
  return analyzeAskDetailed(text, opts).findings
}

const SCOPE_CLIP_CHARS = 80

// Machine-readable marker that leads every block-mode refusal text
// (`askGuardBlockMessage`). It is the ONLY signal the DM Stop-hook uses to tell
// an ask-guard block (owner NOT reached → forward the fallback) apart from a
// generic reply error (ambiguous — may have been delivered → suppress to avoid
// a duplicate). Keep it stable and in sync with the hook that matches on it
// (scripts/fallback-reply-hook.ts).
export const ASK_GUARD_BLOCK_MARKER = 'ASK_GUARD'

/**
 * The advisory tool-result hint appended when the message IS sent (advisory
 * mode). Codes/anchor only — never any message text. Mirrors format-check's
 * `format_hint:` shape.
 */
export function askGuardAdvisoryHint(leaseId: string): string {
  return (
    `ask_guard_hint: ASK_GATE — активен мандат ${leaseId}; ` +
    'действуй act-with-veto («делаю X, скажи стоп»), не жди разрешения'
  )
}

/**
 * The block-mode refusal text (returned as an isError tool result WITHOUT
 * sending). fix-loop #3 (Codex HIGH-2 / Fable MED-2): the guard must NOT assert
 * that the ask is in-scope/authorized — it cannot know that. Instead it lays
 * out BOTH branches and lets the model self-check against the actual lease
 * scope(s):
 *   1) hard-gate → the AskUserQuestion card path (never guarded);
 *   2) covered by an active mandate's scope → act-with-veto and report.
 * All active lease scopes are listed (not just the soonest-expiry one) so the
 * model can match its intended action against the real granted text.
 */
export function askGuardBlockMessage(leaseId: string, scopes: readonly string[]): string {
  const scopeList =
    scopes.length > 0
      ? scopes.map((s) => `«${clip(s, SCOPE_CLIP_CHARS)}»`).join('; ')
      : '(scope не указан)'
  return (
    `${ASK_GUARD_BLOCK_MARKER} (мандат ${leaseId}): этот вопрос-разрешение НЕ отправлен. ` +
    '1) Если это деньги/prod-БД/деструктив/массовые отправки/конфиг модели или ' +
    'gateway — это hard-gate: отправь вопрос карточкой AskUserQuestion (кнопки), ' +
    'этот путь НЕ гейтится. ' +
    '2) Если действие покрыто scope активного мандата — действуй act-with-veto ' +
    '(«делаю X, скажи стоп если против») и доложи результат. ' +
    `Активные мандаты: ${scopeList}.`
  )
}
