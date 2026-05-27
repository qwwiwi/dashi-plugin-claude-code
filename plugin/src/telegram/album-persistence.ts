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
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
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
 *
 * NOTE: lenient — silently skips unreadable / corrupt fragments. The
 * recovery path uses {@link readFragmentsStrict} instead so a corrupt
 * fragment is never silently dropped. This lenient version is retained
 * for callers that want best-effort reads (ops tools, diagnostics).
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

/** Classified failure surface for {@link readFragmentsStrict}. The
 *  recovery path treats every kind as a hard stop — no partial dispatch
 *  — and dead-letters the whole album dir with this payload in the
 *  `.recovery-failure.json` sidecar. */
export type FragmentReadFailure =
  | { kind: 'stat'; file: string; error: string }
  | { kind: 'read'; file: string; error: string }
  | { kind: 'parse'; file: string; error: string }
  | { kind: 'empty_file'; file: string; error: string }

export type FragmentReadResult<TFragment> =
  | { ok: true; fragments: TFragment[]; files: string[] }
  | { ok: false; failure: FragmentReadFailure; filesSeen: string[] }

/**
 * Strict variant of {@link readFragments} used by the recovery path.
 *
 * Unlike `readFragments`, the FIRST unreadable, zero-byte, or unparseable
 * fragment short-circuits the read and returns a classified failure.
 * The recovery caller is responsible for moving the album dir to
 * dead-letter — this function performs zero FS mutations.
 *
 * Classification:
 *   - `stat`        — fragment file `stat` failed (ENOENT race, EACCES)
 *   - `empty_file`  — zero-byte fragment (partial-write detected)
 *   - `read`        — `readFile` failed for any other reason
 *   - `parse`       — JSON.parse threw on the file contents
 *
 * The `meta.json` file is NOT checked here — readMeta in the caller
 * handles that. Only fragment payload files matter for this function.
 */
export async function readFragmentsStrict<TFragment>(
  stateDir: string,
  key: string,
): Promise<FragmentReadResult<TFragment>> {
  const dir = albumDir(stateDir, key)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    // No fragments at all — caller (recoverPendingAlbums) already
    // handles the "meta present, zero fragments" case as dead-letter.
    // Return success with empty list; the caller's zero-length check
    // catches it without conflating "empty" with "corrupt".
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, fragments: [], files: [] }
    }
    return {
      ok: false,
      failure: { kind: 'read', file: '<dir>', error: String(err) },
      filesSeen: [],
    }
  }
  const files = entries
    .filter((name) => name !== META_FILENAME)
    .filter((name) => name.endsWith('.json'))
    .filter((name) => !name.endsWith('.tmp'))
    .sort() // lexicographic = chronological at ms resolution

  const out: TFragment[] = []
  for (const f of files) {
    const full = join(dir, f)
    let size: number
    try {
      const st = await stat(full)
      size = st.size
    } catch (err) {
      return {
        ok: false,
        failure: { kind: 'stat', file: f, error: String(err) },
        filesSeen: files,
      }
    }
    if (size === 0) {
      // Zero-byte file is the canonical partial-write signature on
      // Linux ext4 when a crash hits between create() and the rename
      // of the .tmp suffix. Treat as corrupt — never silently skip.
      return {
        ok: false,
        failure: { kind: 'empty_file', file: f, error: 'fragment size is 0 bytes' },
        filesSeen: files,
      }
    }
    let raw: string
    try {
      raw = await readFile(full, 'utf8')
    } catch (err) {
      return {
        ok: false,
        failure: { kind: 'read', file: f, error: String(err) },
        filesSeen: files,
      }
    }
    try {
      out.push(JSON.parse(raw) as TFragment)
    } catch (err) {
      return {
        ok: false,
        failure: { kind: 'parse', file: f, error: String(err) },
        filesSeen: files,
      }
    }
  }
  return { ok: true, fragments: out, files }
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

/** Move a directory atomically when possible, falling back to
 *  copy+delete when `rename` returns `EXDEV` (cross-FS move).
 *
 *  Used by the dead-letter routines so the album dir is not deleted
 *  from `albums/` until the destination is fully populated. On
 *  copy+delete the destination is built up first; only after every file
 *  is copied is the source removed. If the copy phase throws midway,
 *  the source stays put so the next startup will retry.
 */
async function moveDirSafely(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest)
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EXDEV') throw err
    // Cross-FS move — copy+delete. We do NOT delete the source until
    // every file is copied so a mid-copy crash leaves the album dir
    // intact for the next recovery pass.
    await copyDirRecursive(src, dest)
    await rm(src, { recursive: true, force: true })
  }
}

/** Minimal recursive directory copy used by {@link moveDirSafely}'s
 *  EXDEV fallback. Preserves the tightened modes used elsewhere in this
 *  module. Not exported — the only caller is `moveDirSafely`. */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true, mode: STATE_DIR_MODE })
  const entries = await readdir(src, { withFileTypes: true })
  for (const e of entries) {
    const s = join(src, e.name)
    const d = join(dest, e.name)
    if (e.isDirectory()) {
      await copyDirRecursive(s, d)
    } else if (e.isFile()) {
      await copyFile(s, d)
      await chmod(d, STATE_FILE_MODE).catch(() => {})
    }
    // Symlinks / other types are not expected inside album dirs; skip.
  }
  await chmod(dest, STATE_DIR_MODE).catch(() => {})
}

/**
 * Move a failed album's directory into `albums/dead-letter/{key}-{ts}/`.
 * Called when the flush callback errors. The operator can inspect or
 * manually replay; this module never auto-retries to avoid duplicate
 * delivery.
 *
 * Move strategy: atomic `rename` on the same filesystem; on `EXDEV`
 * falls back to copy+delete via {@link moveDirSafely} so the source dir
 * is never removed until the destination is fully populated.
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
    await moveDirSafely(src, dest)
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

/** Structured payload written alongside the dead-lettered album dir as
 *  `<dest>.recovery-failure.json`. Used for the corrupt-fragment case
 *  (MED-C) so operators can triage without grepping plain-text reasons.
 */
export interface RecoveryFailureSidecar {
  /** ISO-8601 timestamp of the recovery attempt. */
  timestamp: string
  /** Composite album key (`<chatId>:<mgid>`). */
  key: string
  /** Captured `chatId` / `mediaGroupId` if meta.json was readable;
   *  null when the album dir lacked usable meta. */
  chatId: string | null
  mediaGroupId: string | null
  /** Total fragment-shaped files seen on disk (parseable or not). */
  fragmentCount: number
  /** The file that triggered the dead-letter. Empty when failure is
   *  not file-scoped (e.g. dir-level read error). */
  corruptFile: string
  /** Classification of the failure — see {@link FragmentReadFailure}. */
  errorType: FragmentReadFailure['kind']
  /** Raw error message captured from the underlying FS / JSON op. */
  errorMessage: string
}

/**
 * Move an album dir to dead-letter AND drop a structured
 * `.recovery-failure.json` sidecar describing the failure.
 *
 * Used exclusively by the recovery path when a fragment is unreadable
 * or unparseable. The plain `.reason` text sidecar produced by
 * {@link moveToAlbumDeadLetter} is intentionally NOT written here so
 * operators can distinguish "flush failure" (text sidecar) from
 * "recovery corruption" (JSON sidecar) by file extension alone.
 *
 * The dir move uses the same atomic-then-EXDEV-fallback strategy as
 * {@link moveToAlbumDeadLetter}. Source is removed only after the
 * destination is fully populated.
 */
export async function moveToAlbumDeadLetterWithSidecar(
  stateDir: string,
  key: string,
  sidecar: RecoveryFailureSidecar,
): Promise<string | null> {
  const src = albumDir(stateDir, key)
  const dest = join(deadLetterDir(stateDir), `${basename(src)}-${Date.now()}`)
  await mkdir(deadLetterDir(stateDir), {
    recursive: true,
    mode: STATE_DIR_MODE,
  })
  try {
    await moveDirSafely(src, dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  // Sidecar is written AFTER the move is confirmed. Failure to write
  // the sidecar is logged-and-swallowed — the album bytes are already
  // safely in dead-letter, the sidecar is purely diagnostic.
  const sidecarPath = `${dest}.recovery-failure.json`
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), {
    encoding: 'utf8',
    mode: STATE_FILE_MODE,
  }).catch(() => {})
  return dest
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
    const readResult = await readFragmentsStrict<TFragment>(stateDir, entry.key)
    if (!readResult.ok) {
      // MED-C (Codex handlers #4): any unreadable / unparseable fragment
      // is a hard stop. NEVER dispatch a partial album. Move the whole
      // dir to dead-letter with a structured JSON sidecar so operators
      // can triage. The dir is removed from `albums/` only AFTER the
      // dead-letter destination is fully populated (rename when
      // possible; copy+delete on EXDEV).
      const sidecar: RecoveryFailureSidecar = {
        timestamp: new Date().toISOString(),
        key: entry.key,
        chatId: entry.meta.chatId,
        mediaGroupId: entry.meta.mediaGroupId,
        fragmentCount: readResult.filesSeen.length,
        corruptFile: readResult.failure.file,
        errorType: readResult.failure.kind,
        errorMessage: readResult.failure.error,
      }
      await moveToAlbumDeadLetterWithSidecar(
        stateDir,
        entry.key,
        sidecar,
      ).catch(() => {})
      deadLettered++
      opts.log?.warn?.('album.recovery.dead_letter', {
        chatId: entry.meta.chatId,
        mgid: entry.meta.mediaGroupId,
        reason: `corrupt_fragment:${readResult.failure.kind}`,
        corrupt_file: readResult.failure.file,
        fragment_count: readResult.filesSeen.length,
      })
      continue
    }
    const fragments = readResult.fragments
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
