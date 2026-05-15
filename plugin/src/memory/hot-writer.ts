// Phase 8 / T2 — append to <workspace>/core/hot/recent.md.
//
// Ports gateway.py:1938-1987 (append_to_hot_memory) to TS. Python uses
// fcntl.LOCK_EX for cross-process safety; we run one plugin process per
// agent so an intra-process Mutex keyed on the absolute file path is
// enough. The same key serialises concurrent UserPromptSubmit/Stop
// bursts from 50+ chats without losing or interleaving entries.
//
// Emergency trim mirrors gateway.py exactly: keep last `trimKeepLines`
// lines, then advance to the first `### ` header so a partial entry
// isn't left at the top. Output is written to a sibling tmp file and
// rename()'d into place — same-dir guarantees an atomic move on the
// agent's workspace filesystem (no EXDEV across /tmp boundaries).

import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { lockFor } from './_mutex.js'

// Intra-process mutex serialisation lives in `_mutex.ts` (shared with
// verbose-writer). One Mutex per absolute path so different files don't
// block each other.

// ─────────────────────────────────────────────────────────────────────
// Public surface
// ─────────────────────────────────────────────────────────────────────

export interface AppendHotInput {
  path: string
  // Local-tz timestamp formatted as 'YYYY-MM-DD HH:MM'. Caller owns
  // formatting so a fake clock in tests stays deterministic.
  ts: string
  // Human-friendly capitalised agent name, e.g. 'Silvana'. Rendered as
  // `**${agentLabel}:** ...`.
  agentLabel: string
  sourceTag: string
  // ≤ maxBytes / 2 sanity; in practice ≤200 chars by caller. snippet()
  // below collapses newlines to spaces and slices to 200 chars.
  userSnippet: string
  agentSnippet: string
  maxBytes: number
  trimKeepLines: number
}

// Dependency-injection seam for the trim-path fs operations. Production
// uses node:fs/promises; tests can pass a partial override to force
// failure modes (e.g. rename throws EBUSY) and assert orphan cleanup.
export interface TrimFsDeps {
  writeFile: typeof writeFile
  rename: typeof rename
  unlink: typeof unlink
}
const defaultTrimDeps: TrimFsDeps = { writeFile, rename, unlink }

/**
 * Append a turn entry. Auto-mkdir's the parent directory on first write
 * so the file can land in a fresh workspace without manual setup. After
 * append, if the file exceeds `maxBytes`, emergency-trim to last
 * `trimKeepLines` lines (advanced to first `### ` header) via a
 * same-dir tmp + rename for atomicity.
 *
 * @param _trimDeps internal — test-only injection of fs ops for the
 *   trim path. Production callers must omit this.
 */
export async function appendHotEntry(
  input: AppendHotInput,
  _trimDeps: TrimFsDeps = defaultTrimDeps,
): Promise<void> {
  const entry =
    `\n### ${input.ts} [${input.sourceTag}]\n` +
    `**User:** ${input.userSnippet}\n` +
    `**${input.agentLabel}:** ${input.agentSnippet}\n`

  await lockFor(input.path).run(async () => {
    // mkdir-on-first-write so the writer doesn't crash on a workspace
    // that exists but has no core/hot/ subtree yet. recursive=true is
    // idempotent; EEXIST is swallowed by Node.
    await mkdir(dirname(input.path), { recursive: true })

    await appendFile(input.path, entry, 'utf8')
    const s = await stat(input.path)
    if (s.size <= input.maxBytes) return

    // Emergency trim — gateway.py:1971-1985 parity.
    const buf = await readFile(input.path, 'utf8')
    const all = buf.split('\n')
    let kept = all.slice(-input.trimKeepLines)
    for (let i = 0; i < kept.length; i++) {
      if (kept[i]!.startsWith('### ')) {
        kept = kept.slice(i)
        break
      }
    }
    const header = '# Hot memory -- last 24h rolling journal\n\n'
    // Same-dir tmp so rename() is a metadata-only move (no EXDEV when
    // workspace lives on a different filesystem than /tmp). PID + ms
    // disambiguate parallel trims in the unlikely case the mutex is
    // bypassed by an outside caller.
    const tmp = join(
      dirname(input.path),
      `.recent.md.tmp.${process.pid}.${Date.now()}`,
    )
    // Cleanup orphan tmp on rename failure (review MEDIUM). Pre-fix: if
    // writeFile succeeded but rename failed (EBUSY, EIO, kill between
    // awaits) the tmp would stay forever. After enough faulted trims the
    // agent's core/hot/ would accumulate stale .recent.md.tmp.* files.
    // unlink swallows ENOENT so a writeFile-side failure (no tmp on
    // disk) is a no-op.
    try {
      await _trimDeps.writeFile(tmp, header + kept.join('\n'), 'utf8')
      await _trimDeps.rename(tmp, input.path)
    } catch (err) {
      await _trimDeps.unlink(tmp).catch(() => {
        // tmp may not exist if writeFile threw first — fine.
      })
      throw err
    }
  })
}

/**
 * Collapse newlines to spaces and slice to `max` chars. Used for both
 * user and agent snippets so a multi-line prompt doesn't break the
 * `### header` / `**User:**` / `**Agent:**` four-line shape.
 */
export function snippet(s: string, max = 200): string {
  return (s || '').replace(/\n/g, ' ').slice(0, max)
}
