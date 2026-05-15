// Workspace-relative outbound file safety.
//
// Mirrors gateway.py:2987-3007: any file we send out via reply.files must
// resolve to a real path inside TELEGRAM_WORKSPACE_ROOT. This blocks
// `../` traversal, absolute-path escapes, and symlinks that point outside
// the workspace — agents can only ship files from their own sandbox.
//
// The official server.ts uses a 50MB cap (assertSendable, server.ts:128-145)
// — we keep parity with that limit.
//
// Throws clear, user-facing errors that the reply tool surfaces verbatim
// (no stack traces leak through).

import { existsSync, realpathSync, statSync } from 'fs'
import { resolve, sep, extname } from 'path'

import type { AppConfig } from '../config.js'

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

// Extensions that send as photos (inline preview in Telegram) instead of
// documents. Kept here so tools.ts and any future caller share one truth.
export const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

export function isPhotoExtension(filePath: string): boolean {
  return PHOTO_EXTENSIONS.has(extname(filePath).toLowerCase())
}

// resolveInsideWorkspace
//
// Canonicalises both `filePath` (resolved against `workspaceRoot` if
// relative) and `workspaceRoot` via realpathSync. Throws if:
//   - workspaceRoot itself does not exist on disk
//   - the file does not exist on disk
//   - the canonical file path is not contained in the canonical workspace
//
// Containment uses `canonicalWorkspace + path.sep` as a prefix so that
// `/ws-evil/foo` cannot masquerade as inside `/ws`.
export function resolveInsideWorkspace(filePath: string, workspaceRoot: string): string {
  let canonicalWorkspace: string
  try {
    canonicalWorkspace = realpathSync(workspaceRoot)
  } catch (err) {
    throw new Error(
      `refusing to send file outside workspace: workspace root unreadable (${
        err instanceof Error ? err.message : String(err)
      })`,
    )
  }

  // Resolve relative paths against the canonical workspace, not process CWD.
  // Mirror gateway.py: `(workspace / raw).resolve() if not raw.is_absolute() else raw.resolve()`.
  const joined = resolve(canonicalWorkspace, filePath)

  let canonicalFile: string
  try {
    canonicalFile = realpathSync(joined)
  } catch {
    throw new Error(`refusing to send file outside workspace: ${filePath} (file does not exist)`)
  }

  const prefix = canonicalWorkspace.endsWith(sep) ? canonicalWorkspace : canonicalWorkspace + sep
  if (canonicalFile !== canonicalWorkspace && !canonicalFile.startsWith(prefix)) {
    throw new Error(`refusing to send file outside workspace: ${filePath}`)
  }

  if (!existsSync(canonicalFile)) {
    // Belt-and-braces: realpathSync succeeded but the file was deleted
    // between resolution and the existsSync check.
    throw new Error(`refusing to send file outside workspace: ${filePath} (file does not exist)`)
  }

  return canonicalFile
}

export interface SendableFileChecks {
  filePath: string
  config: AppConfig
}

// assertSendableFile
//
// Full gate for reply.files entries:
//   1. workspace_root configured (else clear error)
//   2. path resolves inside workspace (no escapes)
//   3. target is a regular file (not a directory)
//   4. size <= MAX_ATTACHMENT_BYTES
// Returns the canonical resolved path; callers should use this when
// invoking Telegram sendDocument/sendPhoto so we ship the canonical file,
// not the user-supplied path.
export function assertSendableFile({ filePath, config }: SendableFileChecks): string {
  if (config.workspace_root === undefined) {
    throw new Error('files attachment rejected: TELEGRAM_WORKSPACE_ROOT not configured')
  }

  const canonical = resolveInsideWorkspace(filePath, config.workspace_root)

  let st: ReturnType<typeof statSync>
  try {
    st = statSync(canonical)
  } catch (err) {
    throw new Error(
      `files attachment rejected: ${filePath} not readable (${
        err instanceof Error ? err.message : String(err)
      })`,
    )
  }

  if (st.isDirectory()) {
    throw new Error(`files attachment rejected: ${filePath} is a directory`)
  }

  if (st.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `files attachment rejected: ${filePath} is ${(st.size / 1024 / 1024).toFixed(1)}MB (max ${
        MAX_ATTACHMENT_BYTES / 1024 / 1024
      }MB)`,
    )
  }

  return canonical
}
