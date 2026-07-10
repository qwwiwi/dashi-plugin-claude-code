// POST /hooks/fallback-reply — DM fallback-reply route. Extracted verbatim
// from server.ts during the route-module split; no behaviour change.

import type { IncomingMessage, ServerResponse } from 'http'

import { redactToken, resolveAskGuardMode } from '../../config.js'
import { activeLeases, loadAutonomyState } from '../../autonomy/store.js'
import { analyzeAskDetailed } from '../../safety/ask-guard.js'
import { FallbackReplyRouteRequestSchema } from '../../schemas.js'
import type { WebhookDeps } from '../server.js'
import { authGate, chatIdAllowed, readJsonBody, reply } from './shared.js'

// Fallback-reply bodies carry one text up to Telegram's 4096-char cap plus a
// short chat_id. FIX 5 (2026-06-03): 4096 chars × up to 4 UTF-8 bytes + JSON
// overhead can exceed 16 KB, which would 413 BEFORE the schema validates the
// 4096-char text. 32 KB covers the worst-case multibyte body with headroom
// while still cheap to abuse-proof.
const FALLBACK_REPLY_BODY_LIMIT_BYTES = 32 * 1024

// 2026-06-03 (feature/dm-fallback-reply-hook): POST /hooks/fallback-reply —
// forward the DM turn's final assistant text to the warchief's Telegram when
// the turn ended WITHOUT an MCP reply()/edit_message() call. Auth: loopback
// origin + bearer (same fence as the react route). Defence in depth: chatId
// must be in the allowlist, so a leaked token still can't make the bot post
// into an arbitrary chat. Modeled on handleReact.
export async function handleFallbackReply(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookDeps,
  webhookToken: string | undefined,
): Promise<void> {
  const { config, log, sendMessage, statePaths } = deps

  if (!authGate(req, res, webhookToken)) return

  // Feature wiring gate: when no send capability was injected we answer 503
  // (not 404) so an operator can tell "wired but disabled" from "wrong route",
  // and the hook degrades to a no-op without retry storms.
  if (!sendMessage) {
    reply(res, 503, { status: 'fallback_reply_unavailable' })
    return
  }

  const parsed = await readJsonBody(
    req,
    res,
    log,
    FALLBACK_REPLY_BODY_LIMIT_BYTES,
    FallbackReplyRouteRequestSchema,
    'fallback-reply',
  )
  if (!parsed.ok) return
  const payload = parsed.value

  if (!chatIdAllowed(config, payload.chat_id)) {
    log.warn('fallback-reply chatId not in allowlist', { chat_id: payload.chat_id })
    reply(res, 403, { error: 'chatId not in allowlist' })
    return
  }

  // ── Ask-guard (autonomy M3, fix-loop #7) ────────────────────────────────
  // The DM Stop-hook forwards a turn's FINAL assistant text here when the turn
  // ended without an MCP reply — including when the `reply` tool was BLOCKED by
  // the choke point (the hook no longer counts an isError reply as delivered).
  // Without a guard here, a self-gating go-question would slip out through the
  // fallback, bypassing the reply-tool guard. So we run the SAME analysis:
  //   * block   → do NOT forward; log + answer 200 {status:'ask_guard_blocked'}
  //               (the hook does not dedup a non-'sent' status → no owner send).
  //   * advisory → forward unchanged + log (calibration-week observe-only).
  // Fail-open on ANY error — a guard fault must never drop a real fallback.
  try {
    const mode = resolveAskGuardMode(config, log)
    if (mode !== 'off') {
      const state = loadAutonomyState(statePaths, payload.chat_id, log)
      const leases = activeLeases(state, Date.now())
      if (leases.length > 0) {
        const analysis = analyzeAskDetailed(payload.text, { hasActiveLease: true })
        if (analysis.exemptReason === 'hard_gate_protected_only') {
          log.info('ask_guard exempt — hard-gate marker only in a protected zone', {
            code: 'ask_guard_exempt_protected_only',
            variant: 'fallback',
            chat_id: payload.chat_id,
            lease_id: leases[0]!.id,
          })
        }
        const finding = analysis.findings[0]
        if (finding !== undefined && mode === 'block') {
          log.info('ask_guard blocked a self-gating fallback reply (mandate active)', {
            code: 'ask_guard_block',
            variant: 'fallback',
            chat_id: payload.chat_id,
            lease_id: leases[0]!.id,
            pattern: finding.code,
          })
          reply(res, 200, { status: 'ask_guard_blocked' })
          return
        }
        if (finding !== undefined) {
          // advisory — the fallback still forwards; observe-only log.
          log.info('ask_guard advisory on a self-gating fallback reply (mandate active)', {
            code: 'ask_guard_advisory',
            variant: 'fallback',
            chat_id: payload.chat_id,
            lease_id: leases[0]!.id,
            pattern: finding.code,
          })
        }
      }
    }
  } catch (err) {
    try {
      log.warn('ask_guard (fallback) evaluation failed — failing open (forwarded unguarded)', {
        code: 'ask_guard_error',
        variant: 'fallback',
        chat_id: payload.chat_id,
        error: err instanceof Error ? redactToken(err.message) : String(err),
      })
    } catch {
      /* a logger fault must not drop a real fallback */
    }
  }

  try {
    await sendMessage(payload.chat_id, payload.text)
  } catch (err) {
    // A failed send must never wedge the hook. We log and answer 200 (not 5xx)
    // with an explicit {status:'send_failed'} so the hook can distinguish a
    // real delivery from a failure: it records dedup ONLY on {status:'sent'},
    // so a send that keeps failing is re-attempted on the next Stop fire
    // instead of being silently marked delivered.
    log.warn('fallback-reply sendMessage failed', {
      chat_id: payload.chat_id,
      error: err instanceof Error ? redactToken(err.message) : String(err),
    })
    reply(res, 200, { status: 'send_failed' })
    return
  }

  reply(res, 200, { status: 'sent' })
}
