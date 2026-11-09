// Types for scripts/status-widget-state.mjs (plain JS, no build step).

export interface MappedJob {
  id: string
  title: string
  state: 'r' | 'q' | 'd' | 'f' | 'b'
  pct: number
  model: string | undefined
  minutes: number | undefined
}

export interface CardState {
  m?: unknown[]
  j?: unknown[]
  l?: string
}

export const MAX_STATE_BYTES: number
export const CAPACITY: { groups: number; rows: number; jobs: number }

export function mapJobs(jobs: unknown, nowMs: number): MappedJob[]

export function buildCardState(input: {
  milestones: unknown
  jobs: unknown
  footer?: string
  nowMs: number
}): { state: CardState; json: string }

export function main(argv: string[]): string
