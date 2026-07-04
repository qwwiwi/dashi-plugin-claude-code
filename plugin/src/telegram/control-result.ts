// Shared Telegram-facing wording for a reliable control-command
// (`sendControlCommand`) FAILURE. The success text differs per command
// (/compact vs /new/clear), but the failure reasons — dialog open, pane busy,
// never submitted, raw tmux error — read the same everywhere, so both /compact
// (src/commands/oob.ts) and the /new confirm callback
// (src/telegram/newq-confirm-ui.ts) format them through this one helper.
//
// HTML parse mode. The `reason` is echoed verbatim inside <code> only for the
// non-submitted / tmux cases (a bounded enum, never user text).

import type { ControlCommandResult } from '../commands/keys.js'

// The failure arm of ControlCommandResult (`ok: false`) narrowed to its reason.
export type ControlFailureReason = Extract<ControlCommandResult, { ok: false }>['reason']

export function controlFailureMessage(reason: ControlFailureReason): string {
  switch (reason) {
    case 'busy':
      return '<b>не выполнено</b> — агент занят, не удалось прервать. Попробуй ещё раз через пару секунд.'
    case 'dialog':
      return '<b>не выполнено</b> — сессия ждёт ответа в диалоге. Ответь через /keys, потом повтори.'
    case 'unknown':
      return '<b>не выполнено</b> — не удалось определить состояние сессии. Попробуй ещё раз.'
    case 'not-submitted':
    case 'tmux':
      return `<b>не выполнено</b> — не удалось отправить (<code>${reason}</code>).`
  }
}
