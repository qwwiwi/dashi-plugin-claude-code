// Context-window usage parser — read a Claude Code session transcript JSONL
// and compute how much of the model's context window is currently in use.
//
// Claude Code persists each session as `~/.claude/projects/<slug>/<sid>.jsonl`,
// one JSON object per line. Assistant turns carry `message.usage` with
// `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`
// and `output_tokens`. The live context size after a turn is:
//
//     input_tokens + cache_read_input_tokens + cache_creation_input_tokens
//
// (output_tokens is EXCLUDED — those are the freshly-generated tokens, they
// become part of the NEXT turn's input, not the current window occupancy.)
//
// Sidechain discriminator: Claude Code tags every transcript record with a
// top-level boolean `isSidechain`. Main-thread turns are `isSidechain: false`;
// subagent / Task-tool turns are `isSidechain: true`. A subagent runs in its
// own small context and its `usage` is unrelated to the main thread's window,
// so those lines MUST be skipped. We key on `isSidechain === true` (not on
// `parentUuid`/`userType`, which are present on main-thread lines too) because
// it is the single field whose sole purpose is exactly this main/sidechain
// split. Verified against real transcripts: main-thread assistant lines all
// carry `isSidechain: false`.
//
// All I/O errors are swallowed and surface as `null` — a status/HUD caller
// treats "no usable turn" as "unknown", never as a crash. Missing files,
// permission denied, malformed JSON, a half-written trailing line from the
// JSONL writer racing our read — none of them should throw.

import { open, type FileHandle } from 'node:fs/promises'

// NOT IN SCOPE (fast-follow): a single transcript line longer than TAIL_BYTES
// (256 KB) would be truncated at the head of the tail read and dropped as the
// "possibly-truncated first line", so a giant final turn could read as null.
// An adaptive-tail (grow the read until a full trailing line is captured) is
// tracked separately; 256 KB comfortably covers normal turns.
const TAIL_BYTES = 256 * 1024

export interface ContextUsage {
  usedTokens: number
  pct: number
}

// Coerce an unknown usage field to a non-negative finite integer, or null if
// it is absent / not a usable number. Missing cache fields are the caller's
// business (they default to 0); a missing/garbage `input_tokens` means the
// line is not a real billing turn and should be skipped.
function toNonNegNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Scan transcript lines BACKWARDS and return the context usage of the last
 * main-thread assistant turn that carries a `message.usage`.
 *
 * Unparseable lines (a JSONL-writer race can leave a truncated trailing line)
 * and sidechain lines are skipped, not fatal. Returns `null` when no usable
 * assistant turn is found.
 *
 * `used = input_tokens + (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0)`.
 * `pct = used / windowTokens` as a raw float — NOT clamped; formatting is the
 * caller's job. When `windowTokens <= 0`, `pct` is reported as 0 to avoid
 * Infinity/NaN while still returning the real `usedTokens`.
 */
export function computeContextUsage(
  lines: string[],
  windowTokens: number,
): ContextUsage | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === undefined || line.length === 0) continue

    // Per-line parse boundary: valid JSON of the wrong shape (null, a bare
    // array, a string) must skip, not escape and abort the whole scan.
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) continue

    const record = obj as { isSidechain?: unknown; message?: unknown }
    // Skip subagent/sidechain turns — their usage is a separate context.
    if (record.isSidechain === true) continue

    const message = record.message
    if (typeof message !== 'object' || message === null) continue
    const msg = message as { role?: unknown; usage?: unknown }
    if (msg.role !== 'assistant') continue

    const usage = msg.usage
    if (typeof usage !== 'object' || usage === null) continue
    const u = usage as {
      input_tokens?: unknown
      cache_read_input_tokens?: unknown
      cache_creation_input_tokens?: unknown
    }

    const input = toNonNegNumber(u.input_tokens)
    if (input === null) continue // usage without a real input count = not a usable turn

    const cacheRead = toNonNegNumber(u.cache_read_input_tokens) ?? 0
    const cacheCreation = toNonNegNumber(u.cache_creation_input_tokens) ?? 0

    const usedTokens = input + cacheRead + cacheCreation
    // FIX-13 (Fable L3): skip synthetic assistant turns whose usage sums to 0.
    // An API-error turn can persist a `usage` block of all-zeros; treating it as
    // the live window would flash the HUD to 0% mid-session. A real turn always
    // carries a non-zero input/cache footprint, so scan past a 0-sum turn to the
    // last genuine one.
    if (usedTokens === 0) continue
    const pct = windowTokens > 0 ? usedTokens / windowTokens : 0
    return { usedTokens, pct }
  }
  return null
}

/**
 * Read the TAIL of a transcript file (~256 KB) and compute context usage.
 *
 * Only the trailing bytes are read to keep memory bounded on multi-megabyte
 * transcripts. When we don't start at byte 0 the first line is likely
 * truncated mid-object, so it is dropped. Missing/unreadable file → `null`;
 * this function never throws.
 */
export async function readContextUsage(
  transcriptPath: string,
  windowTokens: number,
): Promise<ContextUsage | null> {
  let handle: FileHandle | undefined
  try {
    handle = await open(transcriptPath, 'r')
    const st = await handle.stat()
    if (st.size === 0) return null
    const len = Math.min(st.size, TAIL_BYTES)
    const start = st.size - len
    const buf = Buffer.alloc(len)
    // FIX-12 (Fable L1) + L13 (IT2-8): fill the buffer with a READ LOOP. A
    // single read() can return FEWER bytes than requested (the JSONL writer
    // racing our read, a shrinking file), which would DROP the newest tail
    // lines — exactly the ones we scan backwards for. Loop until `len` bytes or
    // EOF, then slice to the ACTUAL bytes read: a short final read leaves NUL
    // padding whose decoded bytes would corrupt the last line and make
    // JSON.parse fail silently.
    let totalRead = 0
    while (totalRead < len) {
      const { bytesRead } = await handle.read(buf, totalRead, len - totalRead, start + totalRead)
      if (bytesRead === 0) break // EOF — file shrank under us
      totalRead += bytesRead
    }
    const text = buf.subarray(0, totalRead).toString('utf8')

    const split = text.split('\n')
    // Drop the possibly-truncated first line when we didn't start at byte 0;
    // filter empties so a trailing newline doesn't produce an empty parse.
    const lines = (start > 0 ? split.slice(1) : split).filter((l) => l.length > 0)

    return computeContextUsage(lines, windowTokens)
  } catch {
    return null
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // close() race on an already-closed handle is harmless
      }
    }
  }
}

/**
 * Format usage as a compact human string, e.g. `114k / 200k (57%)`.
 *
 * Pure and separate from computation so the caller controls presentation.
 * Token counts are rounded to the nearest 1k; the percentage to an integer.
 * `windowTokens <= 0` yields a `0%` share to avoid Infinity/NaN.
 */
export function formatContextUsage(
  u: { usedTokens: number },
  windowTokens: number,
): string {
  const usedK = Math.round(u.usedTokens / 1000)
  const windowK = Math.round(windowTokens / 1000)
  const pct = windowTokens > 0 ? Math.round((u.usedTokens / windowTokens) * 100) : 0
  return `${usedK}k / ${windowK}k (${pct}%)`
}
