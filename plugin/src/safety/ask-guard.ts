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
  // «жду (го|отмашк…|твоего слова|подтвержден…|команд…|добро)»
  {
    code: 'ASK_WAIT_GO',
    re: new RegExp(
      `${B}жду\\s+(?:го|отмашк${LETTER}*|твоего\\s+слова|подтвержден${LETTER}*|команд${LETTER}*|добро)${A}`,
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
// `ден[ье]г` deliberately covers BOTH «деньги/деньгах/деньгами» (stem `деньг`)
// and the common genitive «денег» (as in «списание денег») — the bare `деньг`
// stem misses «денег», a false-negative that would let a real money-ask be
// intercepted as a self-gate.
const HARD_GATE_RE =
  /(?:ден[ье]г|платеж|биллинг|prod.?(?:баз[а-яё]*|бд|db)|миграци|rm -rf|force-push|деструктив|массов[а-яё]*\s+(?:отправк|рассылк)|model config|gateway|рестарт\s+(?:канала|gateway))/i

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

/**
 * Analyze `text` for self-gating permission-asks. Returns one finding per
 * distinct tier-1 pattern that fired, or an empty array when clean.
 *
 * Short-circuits (empty result) when:
 *   * `opts.hasActiveLease` is false — no lease, no enforcement;
 *   * the text is empty;
 *   * the text mentions a HARD-GATE action anywhere — such asks are always
 *     legitimate.
 *
 * PURE + stateless: identical input → identical output, which is what makes
 * the no-resend-valve guarantee hold in the reply path.
 */
export function analyzeAsk(text: string, opts: { hasActiveLease: boolean }): AskGuardFinding[] {
  if (!opts.hasActiveLease) return []
  if (text.length === 0) return []

  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  // Hard-gate exemption is judged on the WHOLE message (the spec: "if the SAME
  // text contains hard-gate markers"). A permission-ask that touches money /
  // prod / migrations etc. is legitimate no matter the lease.
  if (HARD_GATE_RE.test(normalized)) return []

  const lines = normalized.split('\n')
  const fenceMask = fenceProtectedLines(lines)

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
  return findings
}

const SCOPE_CLIP_CHARS = 80

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
 * sending). Tells the agent to act in-scope and report, and points at the
 * un-guarded AskUserQuestion card path for a genuine product question.
 */
export function askGuardBlockMessage(leaseId: string, scope: string): string {
  return (
    `ASK_GUARD: активен мандат ${leaseId} («${clip(scope, SCOPE_CLIP_CHARS)}»). ` +
    'Это in-scope вопрос-разрешение — действуй сам и доложи результат ' +
    '(«делаю X, скажи стоп если против»). Если это НАСТОЯЩИЙ продуктовый ' +
    'вопрос — отправь его карточкой AskUserQuestion (кнопки), этот путь не гардится.'
  )
}
