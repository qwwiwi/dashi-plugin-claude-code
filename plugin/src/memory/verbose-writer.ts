// Phase 8 / T3 — append a lossless turn record to
// <workspace_parent>/logs/verbose-YYYY-MM-DD.jsonl.
//
// Ports gateway.py:1990-2035 (append_to_verbose_jsonl). Records are
// JSON.stringify'd one-per-line for downstream Cognee cron ingest.
// Keys are constructed in the exact order Python writes them — TS V8
// preserves insertion order in JSON.stringify, so cognee parsers that
// rely on key order (some do, even though they shouldn't) see the same
// shape as the Python gateway.
//
// Mutex-serialised: `appendFile` is NOT atomic for buffers > PIPE_BUF
// (4 KB) on Darwin — concurrent multi-KB writes can interleave and
// corrupt JSONL. gateway.py uses `fcntl.LOCK_EX`; we reuse the same
// `lockFor(path)` primitive as hot-writer so a single per-file mutex
// serialises every append on the plugin process.

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { lockFor } from './_mutex.js'

export interface VerboseRecord {
  // UTC ISO 8601 timestamp; the YYYY-MM-DD prefix is also used to
  // derive the day-roll filename (slice(0,10)).
  ts: string
  // Claude session_id; null when the hook payload didn't carry one.
  sid: string | null
  // Source-tag (channel discriminator), e.g. 'tg'.
  ch: string
  // Full user text — no truncation (recent.md is the truncated mirror).
  user: string
  // Full agent text. Empty string when transcript could not be read.
  agent: string
  // Wall-clock duration of the turn in ms (from UserPromptSubmit buffer
  // to Stop hook). 0 when no prior UserPromptSubmit was buffered.
  dur_ms: number
  // 'completed' on a clean Stop hook; 'error' reserved for future use.
  status: 'completed' | 'error'
}

export interface AppendVerboseInput {
  // Absolute path to <workspace_parent>/logs/ (resolved by caller in T6).
  logsDir: string
  record: VerboseRecord
}

export async function appendVerbose(input: AppendVerboseInput): Promise<void> {
  // mkdir -p so the writer doesn't crash on a fresh workspace where
  // logs/ hasn't been created yet. Idempotent on existing dir.
  await mkdir(input.logsDir, { recursive: true })

  // Day-roll filename derived from the record's own UTC ts. Using
  // Date.now() formatted separately would race if the call straddled
  // UTC midnight (record ts = 23:59:59.999, fmtDay = 00:00:00.000 +1d).
  const day = input.record.ts.slice(0, 10) // 'YYYY-MM-DD'
  const path = join(input.logsDir, `verbose-${day}.jsonl`)

  // Construct the object literal in the order gateway.py writes the
  // dict: ts, sid, ch, user, agent, dur_ms, status. V8 preserves
  // insertion order in JSON.stringify so downstream cognee sees the
  // same column shape as the Python feed.
  const r = input.record
  const ordered = {
    ts: r.ts,
    sid: r.sid,
    ch: r.ch,
    user: r.user,
    agent: r.agent,
    dur_ms: r.dur_ms,
    status: r.status,
  }
  const line = JSON.stringify(ordered) + '\n'
  await lockFor(path).run(async () => {
    await appendFile(path, line, 'utf8')
  })
}
