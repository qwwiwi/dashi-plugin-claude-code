//
// Webhook-only mode (DASHI_WEBHOOK_ONLY=1) starts tokenless: there is no
// grammY Bot, so the real TelegramApi chain (safe→rateLimited→raw) is not
// constructed. Downstream wiring (handlerDeps.telegramApi, StatusManager,
// ProgressReporter, TaskMirror) still expects a non-null TelegramApi, so we
// inject this fail-loud noop.
//
// In worker mode replies leave via the Stop-hook → outbox → driver, NOT via
// Telegram, and the inbound-turn path (/hooks/agent message variant) uses
// the MCP notification, not telegramApi — so the canary never calls this.
// The few features that WOULD reach telegramApi are structurally absent in
// webhook-only: the eyes-on-read/DM-fallback route capabilities are not
// passed to startWebhookServer (server.ts), and status/progress/multichat
// are off by config default. If any of those is enabled, the relevant
// surface is simply unavailable here.
//
// We throw (rather than silently no-op) so that a NEW, unguarded caller
// added in the future surfaces loudly in tests/dev instead of silently
// dropping a Telegram send.
import type { TelegramApi } from './tools.js'

const ERR = 'webhook-only mode: Telegram API unavailable (no bot token)'

export function createNoopTelegramApi(): TelegramApi {
  const fail = (): never => {
    throw new Error(ERR)
  }
  return {
    sendMessage: async () => fail(),
    editMessageText: async () => fail(),
    setMessageReaction: async () => fail(),
    sendChatAction: async () => fail(),
    sendDocument: async () => fail(),
    sendPhoto: async () => fail(),
    downloadFile: async () => fail(),
    deleteMessage: async () => fail(),
  }
}
