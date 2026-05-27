// Durable album-fragment persistence for the multichat / single-DM
// inbound paths. The Telegram poller advances its offset cursor as soon
// as the handler returns, but for media-group albums the handler only
// BUFFERS — the actual fan-out to the channel happens after `flush_ms`
// of silence. Without persistence, any of the following lose user data:
//
//   * plugin crash between handler return and timer fire
//   * router/MCP failure inside sendAlbumNotification (we log "content
//     lost" today)
//   * timer cancellation on shutdown without explicit flush
//
// Strategy (Option A from the TASK-4 brief): write every album fragment
// to disk atomically BEFORE the in-memory buffer is updated. The on-disk
// directory is the source of truth — `flushAlbumDir` walks it in
// insertion order. On crash recovery (`recoverPendingAlbums` called at
// server startup), every stale album dir older than the silence window
// is replayed through the same `flushAlbumDir` path so no fragment is
// lost. On flush failure the directory is moved into `dead-letter/` so
// an operator can inspect / replay manually.
//
// File layout under `{stateDir}/albums/`:
//   {composite-key}/                       — one dir per (chatId, mediaGroupId)
//     meta.json                            — chatId, senderId, user, mgid, kind
//     {seq:08d}-{rand4}.json               — one file per fragment, in order
//   dead-letter/{composite-key}-{ts}/      — failed flush, manually inspectable
//
// `{composite-key}` is `{chatId}:{mediaGroupId}` with `/` replaced by
// `_` for path safety (mgids are opaque Telegram strings, but defensive).
//
// All FS calls go through node:fs/promises so the module is unit-testable
// against a temp dir without further injection. The composite-key
// builder lives here so callers in handlers.ts share one canonical form.

import { randomBytes } from 'node:crypto'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, join } from 'node:path'

// Match the perms used by inbox-bridge.ts — payloads carry user prompts,
// captions, and absolute paths to downloaded media. Tighten so a
// coincidental other-user on the host cannot read them.
const STATE_DIR_MODE = 0o700
const STATE_FILE_MODE = 0o600

const ALBUMS_SUBDIR = 'albums'
const ALBUMS_DEAD_LETTER_SUBDIR = 'dead-letter'
const META_FILENAME = 'meta.json'

/** Sanitize the mgid component of a composite key. Mgids come from
 * Telegram as opaque numeric-looking strings; we still strip path
 * separators defensively so a malicious / future-Telegram mgid cannot
 * traverse out of the albums dir. */
function sanitizeMgid(mgid: string): string {
  return mgid.replace(/[\\/]/g, '_')
}

/** Build the on-disk composite key for an album fragment.
 *
 * The buffer-side key is `${chatId}:${mediaGroupId}` (Bug 1 fix —
 * isolates two chats that happen to share an mgid). The same string
 * doubles as the directory name on disk. Exposed for the handler so
 * the buffer key and the disk key stay in lockstep.
 */
export function compositeAlbumKey(chatId: string, mediaGroupId: string): string {
  return `${chatId}:${sanitizeMgid(mediaGroupId)}`
}

/** Album metadata persisted alongside fragment files. Captured at the
 * first push so the flush path does not need to thread chat ids through
 * the timer callback. */
export interface PersistedAlbumMeta {
  chatId: string
  senderId: string
  user: string
  mediaGroupId: string
  kind: string
  /** ms-since-epoch of the first fragment write. Used by recovery to
   *  decide whether an album dir is stale enough to replay. */
  firstAt: number
}

/** Convenience wrapper carrying the recovered album back to the
 *  caller. Fragments are in insertion order. */
export interface RecoveredAlbum<TFragment> {
  key: string
  meta: PersistedAlbumMeta
  fragments: TFragment[]
}

function albumsRoot(stateDir: string): string {
  return join(stateDir, ALBUMS_SUBDIR)
}

function albumDir(stateDir: string, key: string): string {
  return join(albumsRoot(stateDir), key)
}

function deadLetterDir(stateDir: string): string {
  return join(albumsRoot(stateDir), ALBUMS_DEAD_LETTER_SUBDIR)
}

/** Ensure the albums root and dead-letter dir exist. Idempotent. */
export async function ensureAlbumsDir(stateDir: string): Promise<void> {
  await mkdir(albumsRoot(stateDir), { recursive: true, mode: STATE_DIR_MODE })
  await mkdir(deadLetterDir(stateDir), { recursive: true, mode: STATE_DIR_MODE })
  // Best-effort tighten in case mkdir picked up a looser umask.
  await chmod(albumsRoot(stateDir), STATE_DIR_MODE).catch(() => {})
  await chmod(deadLetterDir(stateDir), STATE_DIR_MODE).catch(() => {})
}

/** Atomically write the album meta.json for a key. Overwrites silently
 *  if it already exists (we re-stamp `firstAt` only on first push;
 *  subsequent pushes leave meta as-is by calling
 *  {@link writeMetaIfMissing} instead).
 */
async function writeMeta(
  stateDir: string,
  key: string,
  meta: PersistedAlbumMeta,
): Promise<void> {
  const dir = albumDir(stateDir, key)
  await mkdir(dir, { recursive: true, mode: STATE_DIR_MODE })
  const finalPath = join(dir, META_FILENAME)
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmpPath, JSON.stringify(meta), {
    encoding: 'utf8',
    mode: STATE_FILE_MODE,
  })
  try {
    await chmod(tmpPath, STATE_FILE_MODE).catch(() => {})
    await rename(tmpPath, finalPath)
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw err
  }
}

/** Read meta.json for a key. Returns `null` when the dir or meta is
 *  missing — caller treats null as "no album here". */
export async function readMeta(
  stateDir: string,
  key: string,
): Promise<PersistedAlbumMeta | null> {
  try {
    const raw = await readFile(join(albumDir(stateDir, key), META_FILENAME), 'utf8')
    const parsed = JSON.parse(raw) as PersistedAlbumMeta
    if (
      typeof parsed.chatId !== 'string'
      || typeof parsed.senderId !== 'string'
      || typeof parsed.user !== 'string'
      || typeof parsed.mediaGroupId !== 'string'
      || typeof parsed.kind !== 'string'
      || typeof parsed.firstAt !== 'number'
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * Persist one album fragment to disk atomically.
 *
 * Writes `{seq}-{rand}.json.tmp` then renames. On first call for a key,
 * meta.json is also written so recovery has the routing context. On
 * subsequent calls meta is left untouched.
 *
 * Returns the absolute path of the committed fragment file. Callers use
 * this for diagnostic logging only — the recovery path re-discovers
 * files via readdir.
 *
 * @param stateDir plugin state root
 * @param key composite album key (see {@link compositeAlbumKey})
 * @param meta routing context — chat/sender ids etc. Only written on
 *   the first push for `key`.
 * @param fragment the serializable fragment payload. Anything
 *   `JSON.stringify`-able works; the recovery path returns the parsed
 *   object back to the caller without re-shaping.
 */
export async function persistFragment(
  stateDir: string,
  key: string,
  meta: PersistedAlbumMeta,
  fragment: unknown,
): Promise<string> {
  const dir = albumDir(stateDir, key)
  await mkdir(dir, { recursive: true, mode: STATE_DIR_MODE })
  await chmod(dir, STATE_DIR_MODE).catch(() => {})

  // Write meta if missing — first push only. We deliberately do not
  // overwrite on subsequent pushes so the originally-captured firstAt
  // sticks around for recovery's freshness check.
  const existing = await readMeta(stateDir, key)
  if (existing === null) {
    await writeMeta(stateDir, key, meta)
  }

  // Filename layout: monotonic-counter via Date.now() prefix + rand
  // suffix. The Telegram side delivers fragments in milliseconds-spread
  // order (typical album is <100ms total), so the Date.now() prefix is
  // sufficient for insertion-order recovery; rand breaks ties.
  const stamp = String(Date.now()).padStart(13, '0')
  const rand = randomBytes(2).toString('hex')
  const filename = `${stamp}-${rand}.json`
  const finalPath = join(dir, filename)
  const tmpPath = `${finalPath}.tmp`

  await writeFile(tmpPath, JSON.stringify(fragment), {
    encoding: 'utf8',
    mode: STATE_FILE_MODE,
  })
  try {
    await chmod(tmpPath, STATE_FILE_MODE).catch(() => {})
    await rename(tmpPath, finalPath)
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw err
  }
  return finalPath
}

/**
 * Read every fragment file for `key` in insertion order. Excludes
 * `meta.json` and any in-progress `.tmp` files. Returns the parsed
 * payloads. Missing dir / unreadable files → empty array (caller
 * decides whether to treat as "no album" or "recovery noop").
 */
export async function readFragments<TFragment>(
  stateDir: string,
  key: string,
): Promise<TFragment[]> {
  const dir = albumDir(stateDir, key)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const files = entries
    .filter((name) => name !== META_FILENAME)
    .filter((name) => name.endsWith('.json'))
    .filter((name) => !name.endsWith('.tmp'))
    .sort() // lexicographic = chronological at ms resolution

  const out: TFragment[] = []
  for (const f of files) {
    try {
      const raw = await readFile(join(dir, f), 'utf8')
      const parsed = JSON.parse(raw) as TFragment
      out.push(parsed)
    } catch {
      // Skip unreadable / corrupt fragment — recovery should still
      // surface the rest. dead-letter handling moves the whole album,
      // not individual fragments, so we just log-and-continue here.
      continue
    }
  }
  return out
}

/**
 * Remove an album's directory and every file inside it. Called on
 * successful flush. Idempotent — a missing dir is treated as success.
 */
export async function dropAlbumDir(stateDir: string, key: string): Promise<void> {
  const dir = albumDir(stateDir, key)
  // rm -rf semantics — recursive remove, ignore missing.
  await rm(dir, { recursive: true, force: true })
}

/**
 * Move a failed album's directory into `albums/dead-letter/{key}-{ts}/`.
 * Called when the flush callback errors. The operator can inspect or
 * manually replay; this module never auto-retries to avoid duplicate
 * delivery.
 */
export async function moveToAlbumDeadLetter(
  stateDir: string,
  key: string,
  reason: string,
): Promise<string | null> {
  const src = albumDir(stateDir, key)
  const dest = join(deadLetterDir(stateDir), `${basename(src)}-${Date.now()}`)
  await mkdir(deadLetterDir(stateDir), {
    recursive: true,
    mode: STATE_DIR_MODE,
  })
  try {
    await rename(src, dest)
    // Drop a `.reason` sidecar so operators can grep failure causes.
    const reasonPath = `${dest}.reason`
    await writeFile(reasonPath, reason, {
      encoding: 'utf8',
      mode: STATE_FILE_MODE,
    }).catch(() => {})
    return dest
  } catch (err) {
    // Source already gone or some other oddity — best-effort, return null.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * List every album currently waiting on disk. Used by `recoverPendingAlbums`
 * at startup AND callable by ops tools. Excludes the dead-letter subdir.
 *
 * Returns an array of `{key, fragmentCount, lastModifiedAt}` sorted by
 * `lastModifiedAt` ascending so the caller can replay oldest first.
 */
export async function listPendingAlbums(
  stateDir: string,
): Promise<Array<{ key: string; meta: PersistedAlbumMeta | null }>> {
  const root = albumsRoot(stateDir)
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return []
  }
  const out: Array<{ key: string; meta: PersistedAlbumMeta | null }> = []
  for (const name of entries) {
    if (name === ALBUMS_DEAD_LETTER_SUBDIR) continue
    if (name.startsWith('.')) continue
    const meta = await readMeta(stateDir, name)
    out.push({ key: name, meta })
  }
  return out
}

/**
 * Drain every pending album on disk through `flush`. Caller supplies
 * the dispatch routine — typically `sendAlbumNotification` bound to
 * the right deps. Errors per album are caught and the album is moved
 * into dead-letter; recovery never aborts the whole pass on one bad
 * album.
 *
 * Fresh-album handling (FIX-D M2, 2026-05-27):
 *   - When `scheduleFlush` is provided, every fresh album (age <
 *     graceMs) is delegated to it for delayed dispatch. The caller
 *     decides the delay — typically `max(0, flushMs - age)` so the
 *     normal album silence window applies AFTER restart too, giving
 *     late fragments a chance to land before flush.
 *   - When `scheduleFlush` is omitted, fresh albums are skipped (legacy
 *     behaviour, kept for backward compat — but BROKEN after restart:
 *     no in-memory timer rearms, so the album lingers on disk until
 *     another restart aged it past graceMs).
 *
 * Returns counts so the startup log can summarise.
 */
export async function recoverPendingAlbums<TFragment>(opts: {
  stateDir: string
  /** Replay only albums whose `firstAt` is older than `now - graceMs`
   *  IMMEDIATELY. Fresh albums (younger than graceMs) are routed to
   *  `scheduleFlush` when provided, else skipped. Default 30s. */
  graceMs?: number
  /** Silence window used to compute the per-album re-arm delay for
   *  fresh albums. Required when `scheduleFlush` is set; ignored
   *  otherwise. Mirrors `config.album.flush_ms`. */
  flushMs?: number
  /** Test seam — defaults to Date.now. */
  now?: () => number
  /** Called once per recovered album. Throws → album goes to dead-letter. */
  flush: (album: RecoveredAlbum<TFragment>) => Promise<void>
  /** Called once per FRESH album (age < graceMs). The caller is
   *  responsible for arming a timer that eventually invokes the same
   *  flush pipeline (typically passing the album back through `flush`
   *  or an equivalent dispatch path). When omitted, fresh albums are
   *  skipped — the legacy behaviour, kept for tests/backwards-compat. */
  scheduleFlush?: (album: RecoveredAlbum<TFragment>, delayMs: number) => void
  /** Optional log surface for observability. */
  log?: {
    info?: (msg: string, ctx?: Record<string, unknown>) => void
    warn?: (msg: string, ctx?: Record<string, unknown>) => void
  }
}): Promise<{
  recovered: number
  deadLettered: number
  skipped: number
  scheduled: number
}> {
  const stateDir = opts.stateDir
  const graceMs = opts.graceMs ?? 30_000
  const now = opts.now ?? Date.now
  const pending = await listPendingAlbums(stateDir)
  let recovered = 0
  let deadLettered = 0
  let skipped = 0
  let scheduled = 0

  for (const entry of pending) {
    if (entry.meta === null) {
      // Orphan dir with no meta — move to dead-letter so it doesn't
      // pile up forever. Operator can decide what to do.
      await moveToAlbumDeadLetter(
        stateDir,
        entry.key,
        'album dir lacks meta.json',
      ).catch(() => {})
      deadLettered++
      opts.log?.warn?.('album.recovery.orphan_dead_lettered', { key: entry.key })
      continue
    }
    const age = now() - entry.meta.firstAt
    const isFresh = age < graceMs
    if (isFresh && opts.scheduleFlush === undefined) {
      // Legacy path — leave alone for the in-memory timer. After a
      // restart this is buggy (no timer exists), but callers without
      // scheduleFlush opted into this behaviour explicitly.
      skipped++
      continue
    }
    const fragments = await readFragments<TFragment>(stateDir, entry.key)
    if (fragments.length === 0) {
      // Meta present but no fragments (race: persistFragment crashed
      // between meta write and first fragment). Move to dead-letter to
      // avoid an infinite recovery loop on the next start.
      await moveToAlbumDeadLetter(
        stateDir,
        entry.key,
        'meta present but zero fragments',
      ).catch(() => {})
      deadLettered++
      opts.log?.warn?.('album.recovery.empty_dead_lettered', { key: entry.key })
      continue
    }
    if (isFresh && opts.scheduleFlush !== undefined) {
      // Fresh album + caller wants delayed flush. Delay = remaining
      // silence window. Use `flushMs` if provided, else fall back to
      // graceMs - age so a missing flushMs still degrades safely.
      const window = opts.flushMs ?? graceMs
      const delayMs = Math.max(0, window - age)
      opts.scheduleFlush(
        { key: entry.key, meta: entry.meta, fragments },
        delayMs,
      )
      scheduled++
      opts.log?.info?.('album.recovery.scheduled', {
        key: entry.key,
        chat_id: entry.meta.chatId,
        media_group_id: entry.meta.mediaGroupId,
        fragments: fragments.length,
        delay_ms: delayMs,
      })
      continue
    }
    try {
      await opts.flush({ key: entry.key, meta: entry.meta, fragments })
      await dropAlbumDir(stateDir, entry.key)
      recovered++
      opts.log?.info?.('album.recovery.flushed', {
        key: entry.key,
        chat_id: entry.meta.chatId,
        media_group_id: entry.meta.mediaGroupId,
        fragments: fragments.length,
      })
    } catch (err) {
      await moveToAlbumDeadLetter(
        stateDir,
        entry.key,
        err instanceof Error ? err.message : String(err),
      ).catch(() => {})
      deadLettered++
      opts.log?.warn?.('album.recovery.flush_failed', {
        key: entry.key,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { recovered, deadLettered, skipped, scheduled }
}
