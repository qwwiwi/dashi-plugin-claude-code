//
// Webhook-only mode (DASHI_WEBHOOK_ONLY=1) starts tokenless: there is no
// grammY Bot, so the real TelegramApi chain (safe→rateLimited→raw) is not
// constructed. Downstream wiring (handlerDeps.telegramApi, StatusManager)
// still expects a non-null TelegramApi, so we inject this fail-loud noop.
// In worker mode replies go out via the Stop-hook → outbox → driver, NOT
// via Telegram, so no method here should ever be called. If one is, we
// throw rather than silently no-op — an unexpected Telegram send in
// webhook-only mode is a bug worth surfacing.
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
