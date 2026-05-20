// Out-of-band (OOB) commands handled by the plugin BEFORE a channel
// notification is sent to Claude. Mirrors gateway.py:_OOB_COMMANDS +
// _handle_oob_command + handle_command (status/help/reset/new branches).
//
// Scope A commands: /help, /status, /stop, /reset, /new.
// Explicitly NOT included: /compact, /halt (Scope B per PLAN.md T10).
//
// Parsing rules (gateway.py:3037-3046 + 3366-3370):
//   - Must start with `/`.
//   - Optional `@botname` suffix is stripped when it matches our bot's
//     username (case-insensitive).
//   - Command word is lowercased.
//   - Trailing `force` token in args sets hasForceFlag (for /reset force,
//     /new force).
//
// Handling notes:
//   - /help and /status reply directly to Telegram and DO NOT wake Claude
//     (no channel notification). Status is a snapshot of plugin-side state
//     only — Claude session lives in the host process and we don't poke it.
//   - /stop, /reset force, /new force ack the user AND emit a channel
//     notification with meta.command=<name>. The plugin can't truly
//     interrupt Claude (no public API for that yet); /help documents this
//     limitation.
//   - /reset and /new without `force` return a short reply asking for the
//     flag, no channel notification.

import type { AppConfig } from '../config.js'
import type { Logger } from '../log.js'
import type { TelegramApi } from '../channel/tools.js'
import { sendChannelNotification, type ChannelEvent } from '../channel/notify.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

export type OobCommandName = 'help' | 'status' | 'stop' | 'reset' | 'new' | 'mirror'

const KNOWN_COMMANDS = new Set<OobCommandName>([
  'help',
  'status',
  'stop',
  'reset',
  'new',
  'mirror',
])

// Sub-actions for /mirror. We accept the bare command (= same as `status`),
// plus on/off/status explicit args. Unknown sub-actions render the help line.
export type MirrorAction = 'on' | 'off' | 'status'

export interface ParsedOobCommand {
  name: OobCommandName
  rawText: string
  args: string
  hasForceFlag: boolean
}

// Parse a leading `/cmd[@botname] args...` token. Returns null if the text
// is not an OOB command (plain text, unknown command, no leading slash).
export function parseOobCommand(
  text: string,
  botUsername?: string,
): ParsedOobCommand | null {
  if (typeof text !== 'string' || text.length === 0) return null
  const trimmed = text.replace(/^\s+/, '')
  if (!trimmed.startsWith('/')) return null

  // Split on first whitespace run. parts[0] = "/word[@bot]", rest = args.
  const wsIdx = trimmed.search(/\s/)
  const head = wsIdx === -1 ? trimmed : trimmed.slice(0, wsIdx)
  const args = wsIdx === -1 ? '' : trimmed.slice(wsIdx + 1).trim()

  // Strip leading slash, optional @botname suffix.
  let word = head.slice(1)
  const atIdx = word.indexOf('@')
  if (atIdx !== -1) {
    const suffix = word.slice(atIdx + 1)
    word = word.slice(0, atIdx)
    // gateway.py strips ANY @suffix without verifying the bot identity, so we
    // mirror that here. botUsername is accepted for future tightening, but
    // not enforced — stripping any suffix matches gateway.py:3044-3045.
    void suffix
    void botUsername
  }

  const lower = word.toLowerCase() as OobCommandName
  if (!KNOWN_COMMANDS.has(lower)) return null

  const hasForceFlag = /^\s*force\s*$/i.test(args)

  return {
    name: lower,
    rawText: text,
    args,
    hasForceFlag,
  }
}

// ─────────────────────────────────────────────────────────────────────
// Handler context and result shape.
// ─────────────────────────────────────────────────────────────────────

// Minimal surface of TmuxMirror that the OOB layer needs. Decoupled from
// the concrete class so tests don't need to spin up the full mirror.
export interface TmuxMirrorControl {
  start(): Promise<void>
  stop(): Promise<void>
  status(): {
    enabled: boolean
    messageId?: number
    lastError?: string
    lastPollAt?: number
  }
}

export interface OobContext {
  chatId: string
  senderId: string
  config: AppConfig
  telegramApi: TelegramApi
  log: Logger
  // For /status, pulled lazily so handler stays decoupled from the
  // status manager (T11) and poller/webhook plumbing (T13).
  pollerStatus?: () => { offset: number | undefined; lastError?: string }
  statusManager?: {
    isActive: (chatId: string) => boolean
    cancel: (chatId: string, reason: string) => Promise<void>
  }
  webhookStatus?: () => { enabled: boolean; port: number }
  // /mirror control — undefined when tmux_mirror.enabled=false at startup.
  // The handler then replies «mirror disabled in config».
  tmuxMirror?: TmuxMirrorControl
  // Identity bits surfaced by /status.
  botId?: number
  stateDir?: string
}

export interface OobResult {
  handled: true
  command: OobCommandName
  notifyChannel?: { content: string; meta: Record<string, string> }
  replyToTelegram?: { text: string; parseMode?: 'HTML' }
}

// ─────────────────────────────────────────────────────────────────────
// /help text. Lists ONLY Scope A commands. Do not add /compact, /halt
// here — they belong to Scope B and grep checks enforce their absence.
// ─────────────────────────────────────────────────────────────────────

function helpText(): string {
  return (
    '<b>команды</b>\n\n'
    + '<code>/help</code> — эта справка\n'
    + '<code>/status</code> — снимок плагина и сессии\n'
    + '<code>/stop</code> — попросить Claude остановить текущую задачу\n'
    + '<code>/reset force</code> — сбросить состояние сессии (подтверди флагом <code>force</code>)\n'
    + '<code>/new force</code> — начать новую сессию (подтверди флагом <code>force</code>)\n'
    + '<code>/mirror on|off|status</code> — управлять зеркалом терминала (tmux, обновляется в реальном времени)\n\n'
    + '<i>примечание: /stop — best-effort: плагин передаёт сигнал остановки через '
    + 'канал, но не может гарантировать прерывание посреди вызова инструмента.</i>'
  )
}

// Public so server.ts can feed the SAME list to bot.api.setMyCommands and
// Telegram autocomplete stays in sync with what the parser actually accepts.
export interface BotCommandSpec {
  command: string
  description: string
}
export const BOT_COMMANDS: ReadonlyArray<BotCommandSpec> = [
  { command: 'help', description: 'справка по командам' },
  { command: 'status', description: 'снимок плагина и сессии' },
  { command: 'stop', description: 'попросить Claude остановиться' },
  { command: 'reset', description: 'сбросить сессию (нужен force)' },
  { command: 'new', description: 'начать новую сессию (нужен force)' },
  { command: 'mirror', description: 'зеркало терминала: on | off | status' },
]

function statusText(ctx: OobContext): string {
  const lines: string[] = ['<b>статус</b>']
  if (ctx.botId !== undefined) {
    lines.push(`bot_id: <code>${escapeHtml(String(ctx.botId))}</code>`)
  }
  if (ctx.stateDir) {
    lines.push(`state_dir: <code>${escapeHtml(ctx.stateDir)}</code>`)
  }
  lines.push(`allowed_user: <code>${escapeHtml(ctx.senderId)}</code>`)

  if (ctx.pollerStatus) {
    const ps = ctx.pollerStatus()
    const off = ps.offset === undefined ? '—' : String(ps.offset)
    lines.push(`update_offset: <code>${escapeHtml(off)}</code>`)
    if (ps.lastError) {
      lines.push(`poller_error: <code>${escapeHtml(ps.lastError)}</code>`)
    }
  }

  if (ctx.statusManager) {
    const active = ctx.statusManager.isActive(ctx.chatId) ? 'active' : 'idle'
    lines.push(`status_manager: <code>${active}</code>`)
  }

  if (ctx.webhookStatus) {
    const ws = ctx.webhookStatus()
    const w = ws.enabled ? `on:${ws.port}` : 'off'
    lines.push(`webhook: <code>${w}</code>`)
  }

  return lines.join('\n')
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

// ─────────────────────────────────────────────────────────────────────
// Main dispatcher. Pure data — caller actually issues sendMessage and
// channel notification calls based on the OobResult. This keeps the
// function trivially testable.
// ─────────────────────────────────────────────────────────────────────

export async function handleOobCommand(
  parsed: ParsedOobCommand,
  ctx: OobContext,
): Promise<OobResult> {
  const baseMeta: Record<string, string> = {
    source: 'telegram',
    chat_id: ctx.chatId,
    user_id: ctx.senderId,
    ts: new Date().toISOString(),
    command: parsed.name,
  }

  switch (parsed.name) {
    case 'help': {
      ctx.log.info('oob /help', { chat_id: ctx.chatId })
      return {
        handled: true,
        command: 'help',
        replyToTelegram: { text: helpText(), parseMode: 'HTML' },
      }
    }

    case 'status': {
      ctx.log.info('oob /status', { chat_id: ctx.chatId })
      return {
        handled: true,
        command: 'status',
        replyToTelegram: { text: statusText(ctx), parseMode: 'HTML' },
      }
    }

    case 'stop': {
      ctx.log.info('oob /stop', { chat_id: ctx.chatId })
      // Cancel any active status — the user explicitly asked to halt, so
      // leaving "Печатает..." pulsing while we wait for Claude to notice
      // the channel event would be confusing. Best-effort: errors in cancel
      // are swallowed inside the manager.
      if (ctx.statusManager && ctx.statusManager.isActive(ctx.chatId)) {
        try {
          await ctx.statusManager.cancel(ctx.chatId, 'user stop')
        } catch (err) {
          ctx.log.warn('oob /stop status cancel failed', {
            chat_id: ctx.chatId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      return {
        handled: true,
        command: 'stop',
        replyToTelegram: {
          text: '<b>stop</b> — запрос принят. Claude увидит сигнал остановки при следующем чтении канала.',
          parseMode: 'HTML',
        },
        notifyChannel: {
          content: '/stop',
          meta: baseMeta,
        },
      }
    }

    case 'reset': {
      if (!parsed.hasForceFlag) {
        return {
          handled: true,
          command: 'reset',
          replyToTelegram: {
            text: 'Для подтверждения добавь <code>force</code>: <code>/reset force</code>',
            parseMode: 'HTML',
          },
        }
      }
      ctx.log.info('oob /reset force', { chat_id: ctx.chatId })
      return {
        handled: true,
        command: 'reset',
        replyToTelegram: {
          text: '<b>сессия сброшена (force)</b>\n\nследующее сообщение начнёт новую сессию',
          parseMode: 'HTML',
        },
        notifyChannel: { content: '/reset force', meta: baseMeta },
      }
    }

    case 'new': {
      if (!parsed.hasForceFlag) {
        return {
          handled: true,
          command: 'new',
          replyToTelegram: {
            text: 'Для подтверждения добавь <code>force</code>: <code>/new force</code>',
            parseMode: 'HTML',
          },
        }
      }
      ctx.log.info('oob /new force', { chat_id: ctx.chatId })
      return {
        handled: true,
        command: 'new',
        replyToTelegram: {
          text: '<b>новая сессия</b>\n\nследующее сообщение начнёт новую сессию',
          parseMode: 'HTML',
        },
        notifyChannel: { content: '/new force', meta: baseMeta },
      }
    }

    case 'mirror': {
      // Sub-action lives in `args`. Empty args → behave like `status`.
      const action = parsed.args.trim().toLowerCase()
      const mirror = ctx.tmuxMirror
      if (!mirror) {
        return {
          handled: true,
          command: 'mirror',
          replyToTelegram: {
            text:
              '<b>зеркало терминала</b> — отключено в конфиге\n\n'
              + 'Установи <code>tmux_mirror.enabled = true</code> и перезапусти плагин.',
            parseMode: 'HTML',
          },
        }
      }
      if (action === 'on') {
        ctx.log.info('oob /mirror on', { chat_id: ctx.chatId })
        try {
          await mirror.start()
        } catch (err) {
          ctx.log.warn('oob /mirror on start failed', {
            chat_id: ctx.chatId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        return {
          handled: true,
          command: 'mirror',
          replyToTelegram: {
            text: '<b>зеркало терминала</b> — <code>on</code>',
            parseMode: 'HTML',
          },
        }
      }
      if (action === 'off') {
        ctx.log.info('oob /mirror off', { chat_id: ctx.chatId })
        try {
          await mirror.stop()
        } catch (err) {
          ctx.log.warn('oob /mirror off stop failed', {
            chat_id: ctx.chatId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        return {
          handled: true,
          command: 'mirror',
          replyToTelegram: {
            text: '<b>зеркало терминала</b> — <code>off</code>',
            parseMode: 'HTML',
          },
        }
      }
      // Default / explicit `status` — read-only snapshot.
      const s = mirror.status()
      const lines = [
        '<b>зеркало терминала — статус</b>',
        `enabled: <code>${s.enabled ? 'on' : 'off'}</code>`,
      ]
      if (s.messageId !== undefined) lines.push(`message_id: <code>${s.messageId}</code>`)
      if (s.lastPollAt !== undefined) {
        const age = Math.max(0, Math.floor((Date.now() - s.lastPollAt) / 1000))
        lines.push(`last poll: <code>${age}s ago</code>`)
      }
      if (s.lastError) lines.push(`last error: <code>${s.lastError.slice(0, 200)}</code>`)
      if (action !== '' && action !== 'status') {
        lines.push('', '<i>usage: /mirror on | off | status</i>')
      }
      return {
        handled: true,
        command: 'mirror',
        replyToTelegram: {
          text: lines.join('\n'),
          parseMode: 'HTML',
        },
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Convenience side-effect runner used by handlers.ts. Keeps the wiring
// in one place: send the Telegram reply (if any) and emit the channel
// notification (if any). Errors during the Telegram send are logged but
// never thrown — a /help send-failure must not crash the update loop.
// ─────────────────────────────────────────────────────────────────────

export async function executeOobResult(
  result: OobResult,
  ctx: OobContext,
  server: Server,
): Promise<void> {
  if (result.replyToTelegram) {
    try {
      await ctx.telegramApi.sendMessage(ctx.chatId, result.replyToTelegram.text, {
        ...(result.replyToTelegram.parseMode !== undefined
          ? { parse_mode: result.replyToTelegram.parseMode }
          : {}),
      })
    } catch (err) {
      ctx.log.warn('oob reply send failed', {
        command: result.command,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (result.notifyChannel) {
    const event: ChannelEvent = {
      content: result.notifyChannel.content,
      meta: result.notifyChannel.meta,
    }
    await sendChannelNotification(server, event, ctx.log)
  }
}
