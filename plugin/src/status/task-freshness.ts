// task-freshness — the «свежесть сверки» indicator shared by the two task
// surfaces (context HUD pin + TaskMirror message). PURE: no clock, no I/O.
//
// The TaskRealityMirror derives a `TaskFreshness` value from the reconciled
// state + turn-active window and hands it to each surface's render path. Both
// surfaces render the SAME header wording so the warchief reads one consistent
// «сверено / УСТАРЕЛИ / НЕ СВЕРЕНО / завершено» language everywhere.
//
// Bucketing matters for edit-churn: the label embeds a coarse relative age
// («меньше минуты» / «N мин»), so within one minute bucket the rendered text is
// byte-identical and the surface's existing hash-dedup suppresses the Telegram
// edit; crossing a bucket changes the text and lets the edit through. That is
// exactly the «edit only when content hash changes OR the age crosses a minute
// bucket» rule from the M3 brief — no extra throttle needed in the surfaces.

/** Discriminated freshness state. Ages are raw ms; the renderer buckets them. */
export type TaskFreshness =
  /** A valid pane snapshot confirms the list. `reconciledAgeMs` = now − lastReconciled. */
  | { readonly kind: 'fresh'; readonly reconciledAgeMs: number }
  /** Active turn, reconciliation failing > 90s. Shows both ages. */
  | { readonly kind: 'stale'; readonly reconciledAgeMs: number; readonly eventAgeMs: number }
  /** No valid pane snapshot has ever been reconciled — tool events only. */
  | { readonly kind: 'unverified' }
  /**
   * Session ended: frozen. `reconciledAtLabel` is a pre-formatted `HH:MM`
   * (UTC) string, or null when the session ended without any successful
   * reconciliation. No growing age — the label never changes after this.
   */
  | { readonly kind: 'ended'; readonly reconciledAtLabel: string | null }

/** The rendered two-part header: a bold label line + an optional italic subline. */
export interface FreshnessHeader {
  /** First line — replaces the surfaces' default `<b>Задачи</b>` label. */
  label: string
  /** Optional second line (stale ages / unverified subtitle). */
  sub?: string
}

/** Bucket a duration into coarse Russian relative age: «меньше минуты» / «N мин». */
export function bucketAge(ms: number): string {
  if (ms < 60_000) return 'меньше минуты'
  const mins = Math.floor(ms / 60_000)
  return `${mins} мин`
}

/** Format an epoch-ms instant as `HH:MM` in UTC (frozen session-end label). */
export function formatUtcHm(epochMs: number): string {
  const d = new Date(epochMs)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * Render the freshness state into a label (+ optional subline). Exact strings
 * are contractually stable (M3 brief §4) — tests assert on them verbatim.
 */
export function renderFreshnessHeader(f: TaskFreshness): FreshnessHeader {
  switch (f.kind) {
    case 'fresh': {
      const age = bucketAge(f.reconciledAgeMs)
      const phrase = f.reconciledAgeMs < 60_000 ? 'сверено меньше минуты назад' : `сверено ${age} назад`
      return { label: `<b>Задачи</b> · <i>${phrase}</i>` }
    }
    case 'stale':
      return {
        label: '<b>Задачи — ДАННЫЕ УСТАРЕЛИ</b>',
        sub: `<i>сверено ${bucketAge(f.reconciledAgeMs)} назад · событие ${bucketAge(f.eventAgeMs)} назад</i>`,
      }
    case 'unverified':
      return {
        label: '<b>Задачи — НЕ СВЕРЕНО</b>',
        sub: '<i>Показаны только события инструментов</i>',
      }
    case 'ended':
      return {
        label:
          f.reconciledAtLabel !== null
            ? `<b>Задачи</b> · <i>сессия завершена · сверено ${f.reconciledAtLabel} UTC</i>`
            : '<b>Задачи</b> · <i>сессия завершена</i>',
      }
  }
}
