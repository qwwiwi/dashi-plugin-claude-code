// src/autonomy/ask-intents.ts
//
// Durable per-chat store of CANONICAL lease-grant intents attached to pending
// AskUserQuestion cards (M2 fix-loop-2 #1, Codex CRITICAL).
//
// Why this exists: the ask relay keeps pending cards in memory only, and the
// first fix-loop's intent snapshot was an in-memory map re-derived by a
// parser. After a process restart (or a deploy that CHANGES the parser) the
// owner-visible scope and the granted scope could diverge. This file is the
// single durable source of truth: the intent is parsed ONCE at card creation,
// persisted here, and the open render, the closed render and the tap-grant
// path read ONLY this record — never a re-parse of the question text. A card
// whose persisted intent is absent (legacy record, save failure, recovery
// failure) is NOT grant-capable, period.
//
// Persistence: one JSON file per chat, `ask-lease-intents-<chatKey>.json`, in
// the same state root as the autonomy registry, written with the SAME atomic
// discipline (atomicWriteInRoot). Single writer: the plugin server process's
// ask UI. Entries are pruned by age on every save (cards live minutes; the
// TTL is generous) and hard-capped as a safety valve. Loads never throw.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  atomicWriteInRoot,
  canonicalChatKey,
  type AutonomyPaths,
} from './store.js'
import type { Logger } from '../log.js'

// The canonical parsed grant intent of one card question. `displayText` is
// persisted alongside the grant fields so the renderers need NO re-parse for
// the marker-stripped question either — every owner-facing surface reads the
// same record the grant will use.
export interface PersistedLeaseIntent {
  scope: string
  ttlHours: number
  supersede: boolean
  scopeDigest: string
  displayText: string
  createdAtMs: number
}

interface AskIntentsFile {
  version: 1
  intents: Record<string, PersistedLeaseIntent>
}

// Cards live at most the relay timeout (minutes). 24h is a generous ceiling
// that still guarantees strays never accumulate.
export const ASK_INTENT_TTL_MS = 24 * 3_600_000
// Safety valve — one chat cannot realistically have more concurrent cards.
export const ASK_INTENT_MAX_ENTRIES = 50

// Filename (relative to the state root) of the per-chat intents file.
export function askIntentsFilename(chatId: string): string {
  return `ask-lease-intents-${canonicalChatKey(chatId)}.json`
}

function loadFile(paths: AutonomyPaths, chatId: string): AskIntentsFile {
  const empty: AskIntentsFile = { version: 1, intents: {} }
  let raw: string
  try {
    raw = readFileSync(join(paths.root, askIntentsFilename(chatId)), 'utf8')
  } catch {
    return empty // missing file on first use — expected
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty
    const obj = parsed as Record<string, unknown>
    if (typeof obj.intents !== 'object' || obj.intents === null || Array.isArray(obj.intents)) {
      return empty
    }
    const out: AskIntentsFile = { version: 1, intents: {} }
    for (const [key, rawIntent] of Object.entries(obj.intents as Record<string, unknown>)) {
      const intent = coerceIntent(rawIntent)
      if (intent !== undefined) out.intents[key] = intent
    }
    return out
  } catch {
    return empty // corrupt — fail-closed (cards become non-grant-capable)
  }
}

function coerceIntent(raw: unknown): PersistedLeaseIntent | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.scope !== 'string' || o.scope.length === 0) return undefined
  if (typeof o.ttlHours !== 'number' || !Number.isFinite(o.ttlHours)) return undefined
  if (typeof o.scopeDigest !== 'string' || o.scopeDigest.length === 0) return undefined
  if (typeof o.createdAtMs !== 'number' || !Number.isFinite(o.createdAtMs)) return undefined
  return {
    scope: o.scope,
    ttlHours: o.ttlHours,
    supersede: o.supersede === true,
    scopeDigest: o.scopeDigest,
    displayText: typeof o.displayText === 'string' && o.displayText.length > 0 ? o.displayText : o.scope,
    createdAtMs: o.createdAtMs,
  }
}

function saveFile(paths: AutonomyPaths, chatId: string, file: AskIntentsFile): void {
  atomicWriteInRoot(paths, askIntentsFilename(chatId), JSON.stringify(file, null, 2))
}

// Age-prune + hard-cap the entries map (oldest evicted first).
function pruneIntents(
  intents: Record<string, PersistedLeaseIntent>,
  nowMs: number,
): Record<string, PersistedLeaseIntent> {
  const entries = Object.entries(intents).filter(
    ([, v]) => nowMs - v.createdAtMs <= ASK_INTENT_TTL_MS,
  )
  entries.sort((a, b) => a[1].createdAtMs - b[1].createdAtMs)
  const kept = entries.slice(Math.max(0, entries.length - ASK_INTENT_MAX_ENTRIES))
  return Object.fromEntries(kept)
}

/**
 * Persist the canonical intent for a card question (key `<requestId>:<qIdx>`).
 * Returns true only when the record is durably on disk — the caller treats a
 * false as «card NOT grant-capable» (fail-closed: a card must never render a
 * mandate block whose intent would not survive a restart).
 */
export function saveLeaseIntent(
  paths: AutonomyPaths,
  chatId: string,
  key: string,
  intent: PersistedLeaseIntent,
  log?: Logger,
): boolean {
  try {
    const file = loadFile(paths, chatId)
    file.intents = pruneIntents(file.intents, intent.createdAtMs)
    file.intents[key] = intent
    saveFile(paths, chatId, file)
    return true
  } catch (err) {
    if (log) {
      log.warn('ask lease intent persist failed — card will not be grant-capable', {
        chat_id: chatId,
        key,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return false
  }
}

/** Read the persisted intent for a card question. Never throws. */
export function loadLeaseIntent(
  paths: AutonomyPaths,
  chatId: string,
  key: string,
): PersistedLeaseIntent | undefined {
  try {
    return loadFile(paths, chatId).intents[key]
  } catch {
    return undefined
  }
}

/** Best-effort removal after the card settles / the grant completed. */
export function deleteLeaseIntent(
  paths: AutonomyPaths,
  chatId: string,
  key: string,
  log?: Logger,
): void {
  try {
    const file = loadFile(paths, chatId)
    if (!(key in file.intents)) return
    delete file.intents[key]
    saveFile(paths, chatId, file)
  } catch (err) {
    if (log) {
      log.debug('ask lease intent delete failed (ignored)', {
        chat_id: chatId,
        key,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
