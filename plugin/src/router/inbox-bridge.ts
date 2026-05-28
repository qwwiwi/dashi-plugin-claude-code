// File-based inbox/outbox bridge between the plugin (Telegram side)
// and the per-chat tmux-resident `claude` sessions.
//
// Layout under {stateDir}/chats/{chatId}/:
//   inbox/                  — plugin writes; tmux session reads + deletes
//   outbox/                 — tmux session writes; plugin polls
//   outbox/processing/      — claimed-but-not-yet-confirmed messages (H2)
//   outbox/dead-letter/     — messages whose Telegram send failed (H2)
//
// Atomicity contract: writers create a `.tmp` sibling and `rename()`
// it into the final filename. Readers therefore never observe a
// half-written JSON (rename is atomic on the same filesystem). This
// is the same pattern used by `src/memory/hot-writer.ts`.
//
// Two-phase outbox delivery (H2 fix, 2026-05-23): pollOutboxOnce used
// to read + delete each file in one pass; a transient Telegram error
// after delete = message lost forever. The new flow is claim → send →
// confirm/reject:
//   1. claim:   rename {outbox}/{file}.json -> {outbox}/processing/{file}.json
//   2. caller sends to Telegram
//   3a. confirm (success): unlink {outbox}/processing/{file}.json
//   3b. reject (failure):  rename to {outbox}/dead-letter/{ts}-{file}.json
//                          (with a `.fail.json` sidecar carrying retry meta)
// Corrupt JSON also goes to dead-letter so the loop never re-reads it.
//
// Filenames are `{timestamp}-{rand4hex}.json` — lexicographic order
// equals time order at millisecond resolution, which is sufficient
// for the outbox poller's "deliver in arrival order" requirement.

import { randomBytes } from 'node:crypto'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'

import { assertValidChatId } from '../chats/policy-loader.js'

// M11 (2026-05-23): per-chat state directories and the JSON files
// inside them carry user prompts and bot replies (potentially with
// PII / private context). The plugin runs as the openclaw user; we
// constrain dirs to 0o700 and files to 0o600 so a coincidental
// other-user on the host cannot read inbox/outbox payloads.
//
// We use explicit mkdir({mode}) rather than relying on umask because
// the plugin's umask is inherited from systemd / shell and can be
// anything — 0o022 by default, but we cannot rely on it.
const STATE_DIR_MODE = 0o700
const STATE_FILE_MODE = 0o600

// Inbound DTO — Telegram message normalized for the tmux session to
// consume. `reply_context` is the untrusted-metadata wrap built by
// `prompt/build.ts` (when the user replied to another message);
// `media_paths` lists absolute paths to already-downloaded media.
export type InboundMessage = {
  text: string
  chat_id: string
  user_id: string
  user: string
  reply_context?: string
  media_paths?: string[]
  timestamp: string
  // Telegram message_id (stringified) of the triggering message — the one
  // that summoned the bot (an @mention or reply-to-bot in a group). The
  // router stores it per chat and, for public chats, threads the outbound
  // reply as a quote-reply to it (reply_to_message_id). Omitted for legacy
  // writers / messages where no id was available.
  message_id?: string
}

// Outbound DTO — what the tmux session emits back to the plugin.
// `reply_to` is a Telegram message_id (as string) when the reply
// should be a quote-reply; omitted otherwise.
//
// FIX-F (2026-05-27, Opus router #14): `format` controls how the
// router maps the payload to a Telegram `parse_mode` at send time.
//   * 'html'      → parse_mode='HTML'      (matches PR #22 default —
//                   the tmux session is expected to write Telegram-
//                   subset HTML; plain text is safe because Telegram
//                   tolerates `<`/`>`/`&` in non-tag positions)
//   * 'markdown'  → parse_mode='MarkdownV2'(caller escapes per Telegram
//                   MarkdownV2 rules — same contract as the channel
//                   reply tool's 'markdownv2' format)
//   * 'text'      → parse_mode omitted    (literal text, no markup)
// Default 'html' matches PR #22's channel reply tool default so a
// tmux-side writer that omits the field gets HTML rendering — i.e. a
// `<b>bold</b>` payload now renders bold instead of literal text.
//
// Caveat: a legacy writer who emits raw markdown like `**bold**` AND
// omits `format` will now be parsed as HTML — Telegram will render
// the `**` as literal asterisks (not bold). Writers MUST set
// `format: 'markdown'` explicitly to get MarkdownV2 rendering, or
// `format: 'text'` to bypass markup entirely. We accept this risk
// because the only known in-tree writer path is the channel reply
// tool itself (PR #22), which uses 'html' by default and converts
// markdown→HTML before shipping.
export const OutboxMessageFormatSchema = z
  .enum(['html', 'markdown', 'text'])
  .default('html')
export type OutboxMessageFormat = z.infer<typeof OutboxMessageFormatSchema>

export const OutboxMessageSchema = z.object({
  text: z.string().min(1),
  chat_id: z.string().min(1),
  reply_to: z.string().optional(),
  timestamp: z.string().min(1),
  format: OutboxMessageFormatSchema,
})
export type OutboxMessage = z.infer<typeof OutboxMessageSchema>

const INBOX_SUBDIR = 'inbox'
const OUTBOX_SUBDIR = 'outbox'
const OUTBOX_PROCESSING_SUBDIR = 'processing'
const OUTBOX_DEAD_LETTER_SUBDIR = 'dead-letter'
// TASK-5 bug 2 (2026-05-27): subdirectory for outbox claims whose
// `claim.message.chat_id` did not match the owning chat directory.
// Kept separate from `dead-letter/` (transient send failures) so an
// operator can distinguish "Telegram refused this message" from
// "tmux session wrote into the wrong chat's outbox". The latter is
// a tampering / bug signal that must NEVER auto-redrive.
const OUTBOX_MISMATCHED_SUBDIR = 'mismatched'

function chatStateRoot(chatId: string, stateDir: string): string {
  return join(stateDir, 'chats', chatId)
}

function outboxRoot(chatId: string, stateDir: string): string {
  return join(chatStateRoot(chatId, stateDir), OUTBOX_SUBDIR)
}

function outboxProcessingDir(chatId: string, stateDir: string): string {
  return join(outboxRoot(chatId, stateDir), OUTBOX_PROCESSING_SUBDIR)
}

function outboxDeadLetterDir(chatId: string, stateDir: string): string {
  return join(outboxRoot(chatId, stateDir), OUTBOX_DEAD_LETTER_SUBDIR)
}

/**
 * A successfully-claimed outbox message: the file has been moved into
 * `outbox/processing/` and is now owned by the caller, who MUST either
 * {@link confirmOutboxClaim} (delete on success) or
 * {@link rejectOutboxClaim} (move to dead-letter on failure).
 *
 * Forgetting to do either is a bug — the message will linger in
 * processing/ forever and trip the next operator audit.
 */
export interface OutboxClaim {
  message: OutboxMessage
  // Absolute path of the file inside `outbox/processing/`. The caller
  // hands this back to confirm/reject; the bridge does not keep any
  // in-memory bookkeeping (file system IS the queue).
  processingPath: string
  // Original outbox filename, retained so dead-letter paths can keep
  // the same chronological prefix.
  originalName: string
}

function buildFilename(): string {
  // Date.now() is sortable to ms; rand4hex breaks ties when two writes
  // land in the same millisecond. 4 hex chars = 65536 slots, plenty
  // for the per-chat write rate (at most a few per second).
  const stamp = Date.now()
  const rand = randomBytes(2).toString('hex')
  return `${stamp}-${rand}.json`
}

/**
 * Ensure the inbox and outbox directories for a chat exist, including
 * the `outbox/processing/` and `outbox/dead-letter/` subdirectories
 * required by the two-phase delivery scheme (H2).
 *
 * Idempotent — safe to call before every write or once at session
 * spawn. Uses `recursive: true` so missing parent directories
 * (`{stateDir}/chats`) are also created.
 *
 * @param chatId stringified Telegram chat id
 * @param stateDir plugin state root (e.g. `TELEGRAM_STATE_DIR`)
 */
export async function ensureChatStateDirs(
  chatId: string,
  stateDir: string,
): Promise<void> {
  // TASK-5 bug 4 (2026-05-27): centralized chatId validation. A chatId
  // that does not match `/^-?\d+$/` would otherwise reach `path.join`
  // and could traverse outside `{stateDir}/chats/` (e.g. `../`) or
  // poison tmux session names. Fail loud — the dispatch boundary
  // catches the throw and converts it to a log + drop.
  assertValidChatId(chatId)
  const root = chatStateRoot(chatId, stateDir)
  // M11: tighten perms on every mkdir. `recursive: true` will create
  // missing parents but only applies `mode` to the LEAF directory in
  // some Node versions, so we explicitly chmod each level we own.
  // mkdir is idempotent; chmod afterwards normalises any pre-existing
  // dir that was created under a laxer umask.
  await mkdir(join(root, INBOX_SUBDIR), { recursive: true, mode: STATE_DIR_MODE })
  await mkdir(join(root, OUTBOX_SUBDIR), { recursive: true, mode: STATE_DIR_MODE })
  await mkdir(outboxProcessingDir(chatId, stateDir), {
    recursive: true,
    mode: STATE_DIR_MODE,
  })
  await mkdir(outboxDeadLetterDir(chatId, stateDir), {
    recursive: true,
    mode: STATE_DIR_MODE,
  })
  // Best-effort tighten on the chat root + queue dirs in case they
  // pre-existed with looser perms. Failures are non-fatal — the
  // operator can fix manually; we don't want to crash dispatch.
  for (const dir of [
    root,
    join(root, INBOX_SUBDIR),
    join(root, OUTBOX_SUBDIR),
    outboxProcessingDir(chatId, stateDir),
    outboxDeadLetterDir(chatId, stateDir),
  ]) {
    await chmod(dir, STATE_DIR_MODE).catch(() => {})
  }
}

/**
 * Atomically write an inbound message to the chat's inbox directory.
 *
 * Writes JSON to `inbox/{filename}.tmp` first, then renames to the
 * final `inbox/{filename}` so a watcher on the tmux side never reads
 * a partial JSON. On rename failure the tmp file is unlinked (best
 * effort) to avoid accumulating orphans.
 *
 * Caller must have run {@link ensureChatStateDirs} for this chat at
 * least once during the process lifetime.
 *
 * @param chatId stringified Telegram chat id
 * @param message inbound DTO (will be JSON.stringify'd)
 * @param stateDir plugin state root
 * @returns absolute path of the committed file (after rename)
 */
export async function writeToInbox(
  chatId: string,
  message: InboundMessage,
  stateDir: string,
): Promise<string> {
  // TASK-5 bug 4 (2026-05-27): validate chatId before it reaches
  // `path.join`. Defence in depth — `ensureChatStateDirs` should have
  // already caught a malformed id, but writeToInbox may be invoked
  // directly by tests / future callers.
  assertValidChatId(chatId)
  const inboxDir = join(chatStateRoot(chatId, stateDir), INBOX_SUBDIR)
  const filename = buildFilename()
  const finalPath = join(inboxDir, filename)
  const tmpPath = `${finalPath}.tmp`

  const body = JSON.stringify(message)
  // M11: lock down file mode at creation time. {mode} on writeFile
  // is the open(2) mode parameter, which is masked by the process
  // umask — but we follow up with chmod inside the try block so the
  // final perm is exactly 0o600 regardless of umask.
  await writeFile(tmpPath, body, { encoding: 'utf8', mode: STATE_FILE_MODE })
  try {
    await chmod(tmpPath, STATE_FILE_MODE).catch(() => {})
    await rename(tmpPath, finalPath)
  } catch (renameErr) {
    // Cleanup orphan tmp so the inbox dir does not accumulate
    // partial writes after disk/EXDEV/EBUSY failures.
    await unlink(tmpPath).catch(() => {})
    throw renameErr
  }
  return finalPath
}

/**
 * Drain the outbox directory once with two-phase delivery semantics
 * (H2 fix): every readable file is **claimed** by renaming it into
 * `outbox/processing/`, parsed, and returned as an {@link OutboxClaim}.
 * The caller MUST eventually call {@link confirmOutboxClaim} (success)
 * or {@link rejectOutboxClaim} (failure) for each claim so the file
 * does not linger in processing/ forever.
 *
 * Files are read in lexicographic order (which equals time order
 * because filenames are `{Date.now()}-{rand}.json`). Atomic rename
 * acts as a per-file lock — a second poller cannot re-claim the same
 * file. Corrupt JSON is immediately moved to dead-letter so a poisoned
 * payload never re-enters the poll loop.
 *
 * Intended to be called from a `setInterval` (e.g. 200ms cadence) or
 * a `fs.watch` callback. The caller is responsible for sending the
 * returned messages to Telegram in array order and resolving each
 * claim afterwards.
 *
 * @param chatId stringified Telegram chat id
 * @param stateDir plugin state root
 * @returns claimed outbox messages, oldest first; empty array if none
 */
export async function pollOutboxOnce(
  chatId: string,
  stateDir: string,
): Promise<OutboxClaim[]> {
  // TASK-5 bug 4 (2026-05-27): validate chatId. The outbox loop in
  // multichat-router runs on a setInterval where a buggy caller could
  // accidentally pass a non-string or a tampered id; assertion here
  // is the last line of defence before `path.join` builds an FS path.
  assertValidChatId(chatId)
  const outboxDir = outboxRoot(chatId, stateDir)
  const processingDir = outboxProcessingDir(chatId, stateDir)
  const deadLetterDir = outboxDeadLetterDir(chatId, stateDir)

  let entries: string[]
  try {
    entries = await readdir(outboxDir)
  } catch {
    // Dir not yet created — no messages, no panic.
    return []
  }

  // Ignore subdirs (processing/, dead-letter/) and in-flight `.tmp`
  // writes. Only consume committed `.json` files that live at the
  // root of outbox/.
  const committed = entries
    .filter((name) => name.endsWith('.json'))
    .sort()
  const claims: OutboxClaim[] = []

  for (const name of committed) {
    const srcPath = join(outboxDir, name)
    const processingPath = join(processingDir, name)

    // Claim by rename. If the rename fails (e.g. another poller already
    // grabbed the file, or src disappeared between readdir and rename),
    // skip silently — same-filesystem rename failure here is benign.
    try {
      await rename(srcPath, processingPath)
    } catch {
      continue
    }

    let parsed: OutboxMessage
    try {
      const raw = await readFile(processingPath, 'utf8')
      // FIX-F (2026-05-27, Opus router #14): Zod parse instead of an
      // unchecked `as OutboxMessage` cast. Two payoffs:
      //   1. A malformed file (missing chat_id, wrong types) lands in
      //      dead-letter with a precise schema error instead of crashing
      //      downstream sendMessage on `undefined.chat_id`.
      //   2. The `format` field gets the `.default('html')` applied so
      //      every tuple downstream sees a populated format and we never
      //      branch on `format === undefined`.
      const json = JSON.parse(raw) as unknown
      parsed = OutboxMessageSchema.parse(json)
    } catch (err) {
      // Corrupt or unreadable JSON — dead-letter immediately so the
      // poller never sees this file again. We carry the reason as a
      // sidecar `.fail.json` to aid post-mortem.
      const reason = err instanceof Error ? err.message : String(err)
      await deadLetterFile(processingPath, name, deadLetterDir, {
        reason: `parse_failed: ${reason}`,
        failedAt: new Date().toISOString(),
      }).catch(() => {
        // Best effort — if dead-letter rename also fails (FS full?)
        // unlink the processing file so the loop can move on.
        return unlink(processingPath).catch(() => {})
      })
      continue
    }

    claims.push({ message: parsed, processingPath, originalName: name })
  }

  return claims
}

/**
 * Mark a claimed outbox message as successfully delivered: remove the
 * file from `outbox/processing/`. Idempotent — unlinking a missing
 * file is swallowed so a double-confirm does not throw.
 *
 * @param claim the claim returned by {@link pollOutboxOnce}
 */
export async function confirmOutboxClaim(claim: OutboxClaim): Promise<void> {
  await unlink(claim.processingPath).catch(() => {})
}

/**
 * TASK-5 bug 2 (2026-05-27): quarantine a claim whose embedded
 * `claim.message.chat_id` did not match the chat directory that owned
 * the file. Moves the processing file to `outbox/mismatched/` with a
 * `.mismatch.json` sidecar that records both the expected (directory)
 * chat id and the actual (payload) chat id. NEVER auto-redrives —
 * an operator must inspect because mismatched claims indicate either
 * a buggy tmux session, a directory-traversal attempt, or memory
 * corruption.
 *
 * Falls back to `unlink` if the dead-letter sibling lookup fails so
 * the file does not stick in `processing/` and block the poll loop.
 *
 * Opus MED-B #15 (2026-05-27): chatIdFromProcessingPath gives us a
 * defence-in-depth sanity check that the claim's processingPath
 * carries a valid integer chat id at the expected layout slot. If it
 * does not, the path was constructed outside our canonical layout
 * (programmer error, tampering, or callable injected with a path from
 * a future feature) and we MUST NOT touch the filesystem under that
 * path — fall back to unlink (best-effort) so the file is removed
 * from processing/ and the poll loop is not wedged.
 *
 * @param claim the claim returned by {@link pollOutboxOnce}
 * @param mismatch metadata describing the chat id discrepancy
 */
export async function quarantineMismatchedClaim(
  claim: OutboxClaim,
  mismatch: { expectedChatId: string; actualChatId: string },
): Promise<void> {
  // MED-B #15: assert the embedded chatId looks legitimate before we
  // build sibling paths off it. A failure here means the processing
  // path was constructed outside our layout — unlink and bail.
  const claimChatId = chatIdFromProcessingPath(claim.processingPath)
  if (claimChatId === null) {
    await unlink(claim.processingPath).catch(() => {})
    return
  }
  try {
    assertValidChatId(claimChatId)
  } catch {
    // The path embeds a non-numeric chat id — refuse to operate under
    // it; the file is removed so the poll loop can move on.
    await unlink(claim.processingPath).catch(() => {})
    return
  }

  // Compute the chat-local outbox root via the well-known relative
  // layout: processing/ and mismatched/ are siblings under outbox/.
  const mismatchedDir = join(
    claim.processingPath,
    '..',
    '..',
    OUTBOX_MISMATCHED_SUBDIR,
  )
  try {
    await mkdir(mismatchedDir, { recursive: true, mode: STATE_DIR_MODE })
    const ts = Date.now()
    const target = join(mismatchedDir, `${ts}-${claim.originalName}`)
    await rename(claim.processingPath, target)
    await chmod(target, STATE_FILE_MODE).catch(() => {})

    const sidecarPath = `${target}.mismatch.json`
    const sidecarTmp = `${sidecarPath}.tmp`
    const meta = {
      reason: 'outbox_chat_mismatch',
      expectedChatId: mismatch.expectedChatId,
      actualChatId: mismatch.actualChatId,
      quarantinedAt: new Date().toISOString(),
    }
    await writeFile(sidecarTmp, JSON.stringify(meta), {
      encoding: 'utf8',
      mode: STATE_FILE_MODE,
    }).catch(() => {})
    await chmod(sidecarTmp, STATE_FILE_MODE).catch(() => {})
    await rename(sidecarTmp, sidecarPath).catch(() => {
      return unlink(sidecarTmp).catch(() => {})
    })
  } catch {
    // Last resort — unlink so the file does not block the poll loop.
    await unlink(claim.processingPath).catch(() => {})
  }
}

/**
 * Mark a claimed outbox message as failed: move it to
 * `outbox/dead-letter/{timestamp}-{originalName}` and drop a sidecar
 * `.fail.json` with the failure reason and retry metadata.
 *
 * `failure.reason` is the human-readable error (Telegram API string,
 * "rate_limited", etc.); `failure.retryCount` lets future workers
 * implement a redrive scan without re-parsing the file.
 *
 * @param claim the claim returned by {@link pollOutboxOnce}
 * @param failure metadata describing why the send failed
 */
export async function rejectOutboxClaim(
  claim: OutboxClaim,
  failure: { reason: string; retryCount?: number },
): Promise<void> {
  const claimChatId = chatIdFromProcessingPath(claim.processingPath)
  if (claimChatId === null) {
    // Defensive — should never happen because pollOutboxOnce hands
    // back a path it just built. Fall back to unlink so the file
    // does not stick in processing/.
    await unlink(claim.processingPath).catch(() => {})
    return
  }
  // Opus MED-B #15 (2026-05-27): defence-in-depth — the helper
  // confirmed the layout shape; assertValidChatId confirms the
  // embedded id is a strict signed-integer string. A failure means
  // the processing path was assembled around a tampered or
  // hand-crafted chat id; refuse to build sibling dead-letter paths
  // off it and fall back to unlink so the file does not block the
  // poll loop.
  try {
    assertValidChatId(claimChatId)
  } catch {
    await unlink(claim.processingPath).catch(() => {})
    return
  }
  const deadLetterDir = join(
    claim.processingPath,
    '..',
    '..',
    OUTBOX_DEAD_LETTER_SUBDIR,
  )
  await deadLetterFile(claim.processingPath, claim.originalName, deadLetterDir, {
    reason: failure.reason,
    failedAt: new Date().toISOString(),
    ...(failure.retryCount !== undefined ? { retryCount: failure.retryCount } : {}),
  }).catch(() => {
    // Last resort — unlink so the poll loop is not blocked by a
    // perpetual "stuck in processing/" file.
    return unlink(claim.processingPath).catch(() => {})
  })
}

// ──────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Move a processing-claim file to dead-letter with a sidecar metadata
 * JSON. `originalName` keeps the chronological prefix; we add a
 * second timestamp (rejection time) so multiple failures of the same
 * original do not collide.
 */
async function deadLetterFile(
  processingPath: string,
  originalName: string,
  deadLetterDir: string,
  meta: { reason: string; failedAt: string; retryCount?: number },
): Promise<void> {
  await mkdir(deadLetterDir, { recursive: true, mode: STATE_DIR_MODE })
  const ts = Date.now()
  const target = join(deadLetterDir, `${ts}-${originalName}`)
  await rename(processingPath, target)
  await chmod(target, STATE_FILE_MODE).catch(() => {})

  const sidecarPath = `${target}.fail.json`
  const sidecarTmp = `${sidecarPath}.tmp`
  await writeFile(sidecarTmp, JSON.stringify(meta), {
    encoding: 'utf8',
    mode: STATE_FILE_MODE,
  }).catch(() => {})
  await chmod(sidecarTmp, STATE_FILE_MODE).catch(() => {})
  await rename(sidecarTmp, sidecarPath).catch(() => {
    return unlink(sidecarTmp).catch(() => {})
  })
}

/**
 * Best-effort extraction of the chatId from a processing-path so we
 * can derive the dead-letter directory. Returns null if the path does
 * not match the canonical `{stateDir}/chats/{chatId}/outbox/processing/{file}`
 * layout — callers fall back to unlink in that case.
 */
function chatIdFromProcessingPath(processingPath: string): string | null {
  // .../chats/{chatId}/outbox/processing/{file}.json
  //                                       ^ basename
  // We don't actually need the chatId for the dead-letter rename — the
  // sibling lookup `../../dead-letter/` is enough — but we keep this
  // helper as a sanity check that the layout has not drifted.
  const parts = processingPath.split(/[/\\]/)
  const procIdx = parts.lastIndexOf(OUTBOX_PROCESSING_SUBDIR)
  if (procIdx < 4) return null
  const outboxIdx = procIdx - 1
  if (parts[outboxIdx] !== OUTBOX_SUBDIR) return null
  const chatId = parts[outboxIdx - 1]
  return chatId !== undefined && chatId !== '' ? chatId : null
}

// Re-export the basename helper so router tests can build expected
// processing paths without re-implementing the layout.
export { basename as outboxBasename }
