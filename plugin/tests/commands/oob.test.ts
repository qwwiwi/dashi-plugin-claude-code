import { describe, expect, test } from 'bun:test'

import {
  handleOobCommand,
  parseOobCommand,
  type OobContext,
} from '../../src/commands/oob.js'
import type { AppConfig } from '../../src/config.js'
import type { Logger } from '../../src/log.js'
import type { TelegramApi } from '../../src/channel/tools.js'

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    bot_id: 8507713167,
    dm_only: true,
    allowed_user_ids: [164795011],
    allowed_chat_ids: [164795011],
    status: { enabled: true, interval_ms: 700, ttl_ms: 300_000, delete_on_complete: true, suppress_typing_bubble: false },
    album: { flush_ms: 2000 },
    voice: { provider: 'groq', language: 'ru', model: 'whisper-large-v3-turbo' },
    webhook: { enabled: false, host: '127.0.0.1', port: 0 },
    permission_relay: {
      enabled: true,
      allowed_user_ids: [164795011],
      bash_only_proof: true,
    },
    commands: { help: true, status: true, stop: true, reset: true, new: true },
    memory: {
      enabled: false,
      source_tag: 'tg',
      max_hot_bytes: 20480,
      trim_keep_lines: 600,
      buffer_ttl_ms: 5 * 60 * 1000,
      buffer_max_entries: 100,
    },
    progress: {
      enabled: true,
      edit_throttle_ms: 3000,
      recent_buffer: 10,
      session_ttl_ms: 600000,
    },
    task_mirror: {
      enabled: true,
      edit_throttle_ms: 3000,
      session_ttl_ms: 600000,
      collapse_completed_after: 5,
    },
    watcher: {
      enabled: true,
      debounce_ms: 10_000,
      busy_threshold_ms: 30_000,
    },
    tmux_mirror: { enabled: false, pane_target: '', socket_name: '', poll_interval_ms: 5000, line_count: 50, hide_segments: ['boot_banner', 'inbound_warning', 'footer_hints', 'input_box'], mode: 'latest_inbound_only', max_lines: 14 },
    multichat: { enabled: false },
    ask_user_question: { enabled: false, timeout_ms: 300_000, max_preview_chars: 1000 },
    permission_gate: { enabled: false, timeout_ms: 120_000 },
    ...overrides,
  }
}

function makeLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
}

function makeTelegramApi(): TelegramApi {
  // /help and /status tests don't actually invoke handleOobCommand's side
  // effects on the API — the result object carries replyToTelegram and the
  // caller (executeOobResult / handlers.ts) issues sendMessage. We stub
  // every method to throw if accidentally invoked.
  const fail = (name: string) => {
    return (): never => {
      throw new Error(`unexpected TelegramApi call: ${name}`)
    }
  }
  return {
    sendMessage: fail('sendMessage') as TelegramApi['sendMessage'],
    editMessageText: fail('editMessageText') as TelegramApi['editMessageText'],
    setMessageReaction: fail(
      'setMessageReaction',
    ) as TelegramApi['setMessageReaction'],
    sendChatAction: fail('sendChatAction') as TelegramApi['sendChatAction'],
    sendDocument: fail('sendDocument') as TelegramApi['sendDocument'],
    sendPhoto: fail('sendPhoto') as TelegramApi['sendPhoto'],
    downloadFile: fail('downloadFile') as TelegramApi['downloadFile'],
    deleteMessage: fail('deleteMessage') as TelegramApi['deleteMessage'],
    answerGuestQuery: fail('answerGuestQuery') as TelegramApi['answerGuestQuery'],
  }
}

function makeCtx(overrides: Partial<OobContext> = {}): OobContext {
  return {
    chatId: '164795011',
    senderId: '164795011',
    config: makeConfig(),
    telegramApi: makeTelegramApi(),
    log: makeLogger(),
    botId: 8507713167,
    stateDir: '/tmp/state',
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────
// parseOobCommand
// ─────────────────────────────────────────────────────────────────────

describe('parseOobCommand', () => {
  test('returns null on plain text', () => {
    expect(parseOobCommand('hello world')).toBeNull()
    expect(parseOobCommand('not a command')).toBeNull()
  })

  test('parses /help', () => {
    const r = parseOobCommand('/help')
    expect(r).not.toBeNull()
    expect(r!.name).toBe('help')
    expect(r!.args).toBe('')
    expect(r!.hasForceFlag).toBe(false)
  })

  test('parses /status@botname strips suffix', () => {
    const r = parseOobCommand('/status@dashicanarybot', 'dashicanarybot')
    expect(r).not.toBeNull()
    expect(r!.name).toBe('status')
  })

  test('parses /compact (now an intentional command)', () => {
    const r = parseOobCommand('/compact')
    expect(r).not.toBeNull()
    expect(r!.name).toBe('compact')
    expect(r!.args).toBe('')
  })

  test('parses /new', () => {
    const r = parseOobCommand('/new')
    expect(r).not.toBeNull()
    expect(r!.name).toBe('new')
  })

  test('/reset is no longer a known command', () => {
    expect(parseOobCommand('/reset')).toBeNull()
    expect(parseOobCommand('/reset force')).toBeNull()
  })

  test('parses unknown /foo as null; /halt still absent', () => {
    expect(parseOobCommand('/foo')).toBeNull()
    // /halt remains intentionally unimplemented.
    expect(parseOobCommand('/halt')).toBeNull()
  })

  test('parses /stop case-insensitively (/STOP)', () => {
    const r = parseOobCommand('/STOP')
    expect(r).not.toBeNull()
    expect(r!.name).toBe('stop')
  })
})

// ─────────────────────────────────────────────────────────────────────
// handleOobCommand
// ─────────────────────────────────────────────────────────────────────

describe('handleOobCommand', () => {
  test('/help returns HTML reply listing commands, no channel notify', async () => {
    const parsed = parseOobCommand('/help')!
    const result = await handleOobCommand(parsed, makeCtx())
    expect(result.handled).toBe(true)
    expect(result.command).toBe('help')
    expect(result.notifyChannel).toBeUndefined()
    expect(result.replyToTelegram).toBeDefined()
    const text = result.replyToTelegram!.text
    expect(result.replyToTelegram!.parseMode).toBe('HTML')
    // Lists the current control commands.
    expect(text).toContain('/help')
    expect(text).toContain('/status')
    expect(text).toContain('/stop')
    expect(text).toContain('/compact')
    expect(text).toContain('/new')
    // /reset was removed; /halt remains intentionally absent.
    expect(text).not.toContain('/reset')
    expect(text).not.toContain('/halt')
  })

  test('/status includes bot_id state_dir allowed_user', async () => {
    const parsed = parseOobCommand('/status')!
    const result = await handleOobCommand(
      parsed,
      makeCtx({
        botId: 8507713167,
        stateDir: '/var/lib/canary',
        senderId: '164795011',
      }),
    )
    expect(result.notifyChannel).toBeUndefined()
    expect(result.replyToTelegram).toBeDefined()
    const text = result.replyToTelegram!.text
    expect(text).toContain('8507713167')
    expect(text).toContain('/var/lib/canary')
    expect(text).toContain('164795011')
  })

  test('/status includes status_manager and webhook info when supplied', async () => {
    const parsed = parseOobCommand('/status')!
    const result = await handleOobCommand(
      parsed,
      makeCtx({
        statusManager: {
          isActive: (cid: string) => cid === '164795011',
          cancel: async () => {},
        },
        webhookStatus: () => ({ enabled: true, port: 8089 }),
        pollerStatus: () => ({ offset: 42 }),
      }),
    )
    const text = result.replyToTelegram!.text
    expect(text).toContain('active')
    expect(text).toContain('on:8089')
    expect(text).toContain('42')
  })

  test('/stop emits channel notification with meta.command=stop', async () => {
    const parsed = parseOobCommand('/stop')!
    const result = await handleOobCommand(parsed, makeCtx())
    expect(result.command).toBe('stop')
    expect(result.notifyChannel).toBeDefined()
    expect(result.notifyChannel!.meta.command).toBe('stop')
    expect(result.notifyChannel!.meta.chat_id).toBe('164795011')
    expect(result.notifyChannel!.meta.source).toBe('telegram')
    expect(result.replyToTelegram).toBeDefined()
  })

  test('/new renders a confirm card (buttons, no channel notify, no pane touched)', async () => {
    const parsed = parseOobCommand('/new')!
    const result = await handleOobCommand(parsed, makeCtx())
    expect(result.command).toBe('new')
    expect(result.notifyChannel).toBeUndefined()
    expect(result.replyToTelegram).toBeDefined()
    expect(result.replyToTelegram!.text).toContain('Новый диалог')
    // Confirm keyboard with newq:confirm(:nonce) / newq:cancel buttons.
    const kb = result.replyToTelegram!.inlineKeyboard
    expect(kb).toBeDefined()
    const datas = kb!.inline_keyboard.flat().map((b) => b.callback_data)
    expect(datas.some((d) => d !== undefined && d.startsWith('newq:confirm'))).toBe(true)
    expect(datas).toContain('newq:cancel')
  })
})

// ─────────────────────────────────────────────────────────────────────
// /compact — reliable control-command injection via sendControlCommand.
// We drive it with a scripted capture-pane + send-keys fake (same shapes as
// keys-control.test.ts) and assert the REAL-result → message mapping.
// ─────────────────────────────────────────────────────────────────────

const IDLE_PANE = [
  '╭────────────────────────────────╮',
  '│ >                              │',
  '╰────────────────────────────────╯',
  '  ? for shortcuts',
].join('\n')

const BUSY_PANE = [
  '✳ Working… (esc to interrupt)',
  '╭────────────────────────────────╮',
  '│ >                              │',
  '╰────────────────────────────────╯',
].join('\n')

const DIALOG_PANE = [
  '│ Do you want to proceed?        │',
  '│ ❯ 1. Yes                       │',
  '│   2. No                        │',
].join('\n')

const COMPACTING_PANE = [
  '❯ /compact',
  'Compacting conversation…',
  '╭────────────────────────────────╮',
  '│ >                              │',
  '╰────────────────────────────────╯',
].join('\n')

const NOT_SUBMITTED_PANE = [
  '╭────────────────────────────────╮',
  '│ > /compact                     │',
  '╰────────────────────────────────╯',
  '  ? for shortcuts',
].join('\n')

// Idle pane with a typed '/cmd' draft — the pre-Enter TOCTOU snapshot (FIX-3).
function typedPane(cmd: string): string {
  return [
    '╭────────────────────────────────╮',
    `│ > /${cmd}                        │`,
    '╰────────────────────────────────╯',
    '  ? for shortcuts',
  ].join('\n')
}

const noSleep = async (_ms: number): Promise<void> => {}

function compactCtx(panes: string[]): OobContext {
  let i = 0
  return makeCtx({
    tmuxKeys: {
      target: { paneTarget: '%1', socketPath: '/tmp/s' },
      exec: async () => ({ exitCode: 0, stderr: '' }),
      captureExec: async () => {
        const out = i < panes.length ? panes[i]! : (panes[panes.length - 1] ?? '')
        i++
        return { exitCode: 0, stdout: out, stderr: '' }
      },
      sleep: noSleep,
    },
  })
}

describe('/compact', () => {
  test('no tmux pane → «недоступно»', async () => {
    const parsed = parseOobCommand('/compact')!
    const result = await handleOobCommand(parsed, makeCtx())
    expect(result.command).toBe('compact')
    expect(result.replyToTelegram!.text).toContain('недоступно')
    expect(result.notifyChannel).toBeUndefined()
  })

  test('ok → «контекст сжимается»', async () => {
    const parsed = parseOobCommand('/compact')!
    const result = await handleOobCommand(
      parsed,
      compactCtx([IDLE_PANE, typedPane('compact'), COMPACTING_PANE]),
    )
    expect(result.replyToTelegram!.text).toContain('контекст сжимается')
  })

  test('busy (stays busy after interrupt) → busy message', async () => {
    const parsed = parseOobCommand('/compact')!
    const result = await handleOobCommand(parsed, compactCtx([BUSY_PANE, BUSY_PANE]))
    expect(result.replyToTelegram!.text).toContain('агент занят')
  })

  test('dialog → «ждёт ответа в диалоге»', async () => {
    const parsed = parseOobCommand('/compact')!
    const result = await handleOobCommand(parsed, compactCtx([DIALOG_PANE]))
    expect(result.replyToTelegram!.text).toContain('ждёт ответа в диалоге')
  })

  test('not-submitted → «не удалось отправить»', async () => {
    const parsed = parseOobCommand('/compact')!
    const result = await handleOobCommand(
      parsed,
      compactCtx([IDLE_PANE, NOT_SUBMITTED_PANE, NOT_SUBMITTED_PANE, NOT_SUBMITTED_PANE]),
    )
    expect(result.replyToTelegram!.text).toContain('не удалось отправить')
    expect(result.replyToTelegram!.text).toContain('not-submitted')
  })
})

// ─────────────────────────────────────────────────────────────────────
// /status — context-usage line (task 5). Fake transcript on disk + config
// window tokens; assert the formatted line and the «—» fallback.
// ─────────────────────────────────────────────────────────────────────

describe('/status context line', () => {
  test('renders «контекст: X/Y (Z%)» from a transcript', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'oob-status-'))
    const transcript = join(dir, 's.jsonl')
    // One main-thread assistant turn: input 100000 + cache_read 10000 = 110000.
    writeFileSync(
      transcript,
      JSON.stringify({
        isSidechain: false,
        message: { role: 'assistant', usage: { input_tokens: 100000, cache_read_input_tokens: 10000 } },
      }) + '\n',
    )
    const parsed = parseOobCommand('/status')!
    const result = await handleOobCommand(
      parsed,
      makeCtx({ transcriptPath: transcript, contextWindowTokens: 200000, modelName: 'opus' }),
    )
    const text = result.replyToTelegram!.text
    expect(text).toContain('контекст:')
    expect(text).toContain('110k / 200k (55%)')
    expect(text).toContain('model:')
    expect(text).toContain('opus')
  })

  test('no transcript path → «контекст: —»', async () => {
    const parsed = parseOobCommand('/status')!
    const result = await handleOobCommand(parsed, makeCtx())
    expect(result.replyToTelegram!.text).toContain('контекст: <code>—</code>')
  })
})

// ─────────────────────────────────────────────────────────────────────
// /mirror — toggles the TmuxMirror; falls back to «disabled» when no
// mirror instance is wired into the context. Subactions: on / off /
// status (default).
// ─────────────────────────────────────────────────────────────────────

function makeFakeMirror(): {
  control: NonNullable<OobContext['tmuxMirror']>
  log: { start: number; stop: number }
  state: { enabled: boolean; messageId?: number; lastPollAt?: number; lastError?: string }
} {
  const log = { start: 0, stop: 0 }
  const state: {
    enabled: boolean
    messageId?: number
    lastPollAt?: number
    lastError?: string
  } = { enabled: false }
  const control: NonNullable<OobContext['tmuxMirror']> = {
    async start() {
      log.start += 1
      state.enabled = true
      state.messageId = 999
      state.lastPollAt = Date.now()
    },
    async stop() {
      log.stop += 1
      state.enabled = false
      delete state.messageId
    },
    status() {
      const out: ReturnType<NonNullable<OobContext['tmuxMirror']>['status']> = {
        enabled: state.enabled,
      }
      if (state.messageId !== undefined) out.messageId = state.messageId
      if (state.lastPollAt !== undefined) out.lastPollAt = state.lastPollAt
      if (state.lastError !== undefined) out.lastError = state.lastError
      return out
    },
  }
  return { control, log, state }
}

describe('/mirror command', () => {
  test('/mirror parses with no args', () => {
    const r = parseOobCommand('/mirror')
    expect(r).not.toBeNull()
    expect(r!.name).toBe('mirror')
    expect(r!.args).toBe('')
  })

  test('/mirror on parses with args=on', () => {
    const r = parseOobCommand('/mirror on')
    expect(r!.name).toBe('mirror')
    expect(r!.args).toBe('on')
  })

  test('/mirror without configured mirror replies «отключено в конфиге»', async () => {
    const parsed = parseOobCommand('/mirror status')!
    const result = await handleOobCommand(parsed, makeCtx())
    expect(result.command).toBe('mirror')
    expect(result.replyToTelegram!.text).toContain('отключено в конфиге')
    expect(result.notifyChannel).toBeUndefined()
  })

  test('/mirror on calls start() and reports on', async () => {
    const mirror = makeFakeMirror()
    const parsed = parseOobCommand('/mirror on')!
    const result = await handleOobCommand(parsed, makeCtx({ tmuxMirror: mirror.control }))
    expect(mirror.log.start).toBe(1)
    expect(result.replyToTelegram!.text).toContain('on')
    expect(result.notifyChannel).toBeUndefined()
  })

  test('/mirror off calls stop() and reports off', async () => {
    const mirror = makeFakeMirror()
    // start first so stop has work to do.
    await mirror.control.start()
    const parsed = parseOobCommand('/mirror off')!
    const result = await handleOobCommand(parsed, makeCtx({ tmuxMirror: mirror.control }))
    expect(mirror.log.stop).toBe(1)
    expect(result.replyToTelegram!.text).toContain('off')
  })

  test('/mirror status reports enabled + message_id when active', async () => {
    const mirror = makeFakeMirror()
    await mirror.control.start()
    const parsed = parseOobCommand('/mirror status')!
    const result = await handleOobCommand(parsed, makeCtx({ tmuxMirror: mirror.control }))
    const text = result.replyToTelegram!.text
    expect(text).toContain('зеркало терминала — статус')
    expect(text).toContain('on')
    expect(text).toContain('999') // messageId
  })

  test('/mirror with unknown sub-action shows usage hint', async () => {
    const mirror = makeFakeMirror()
    const parsed = parseOobCommand('/mirror blabla')!
    const result = await handleOobCommand(parsed, makeCtx({ tmuxMirror: mirror.control }))
    expect(result.replyToTelegram!.text).toContain('usage:')
  })

  test('/mirror on swallows start() throws without crashing handler', async () => {
    const failingMirror: NonNullable<OobContext['tmuxMirror']> = {
      async start() {
        throw new Error('boom')
      },
      async stop() {
        /* no-op */
      },
      status() {
        return { enabled: false }
      },
    }
    const parsed = parseOobCommand('/mirror on')!
    // Must NOT throw.
    const result = await handleOobCommand(parsed, makeCtx({ tmuxMirror: failingMirror }))
    expect(result.command).toBe('mirror')
    expect(result.replyToTelegram!.text).toContain('on')
  })
})

// ─────────────────────────────────────────────────────────────────────
// /key was removed 2026-06-14 (redundant: the /keys tap panel covers it).
// /cc gained a bare-command button panel (2026-06-14).
// ─────────────────────────────────────────────────────────────────────

describe('/key removed', () => {
  test('/key is no longer a known OOB command', () => {
    const p = parseOobCommand('/key 2 enter')
    expect(p).toBeNull()
  })
})

describe('/cc panel', () => {
  test('bare /cc renders the command keyboard (no keystroke sent)', async () => {
    const parsed = parseOobCommand('/cc')
    if (!parsed) throw new Error('parse failed')
    const calls: string[][] = []
    const ctx = makeCtx()
    ctx.tmuxKeys = {
      target: { paneTarget: '%1' },
      exec: async (args) => {
        calls.push([...args])
        return { exitCode: 0, stderr: '' }
      },
    }
    const res = await handleOobCommand(parsed, ctx)
    expect(res.command).toBe('cc')
    expect(res.replyToTelegram?.inlineKeyboard).toBeDefined()
    expect(calls.length).toBe(0) // rendering the panel sends nothing
    expect(res.notifyChannel).toBeUndefined()
  })

  // IT2-6: typed `/cc clear` is destructive → posts the /new confirm card (with
  // newq:* buttons) and types NOTHING into the pane. Never a one-tap clear.
  test('/cc clear posts the confirm card, types NOTHING into the pane', async () => {
    const parsed = parseOobCommand('/cc clear')
    if (!parsed) throw new Error('parse failed')
    const calls: string[][] = []
    const ctx = makeCtx()
    ctx.tmuxKeys = {
      target: { paneTarget: '%1', socketPath: '/tmp/s' },
      exec: async (args) => {
        calls.push([...args])
        return { exitCode: 0, stderr: '' }
      },
      captureExec: async () => ({ exitCode: 0, stdout: IDLE_PANE, stderr: '' }),
      sleep: noSleep,
    }
    const res = await handleOobCommand(parsed, ctx)
    expect(res.command).toBe('cc')
    // A confirm card was returned (buttons), not a keystroke.
    expect(res.replyToTelegram!.text).toContain('Новый диалог')
    const kb = res.replyToTelegram!.inlineKeyboard
    expect(kb).toBeDefined()
    const datas = kb!.inline_keyboard.flat().map((b) => b.callback_data)
    expect(datas.some((d) => d !== undefined && d.startsWith('newq:confirm'))).toBe(true)
    expect(datas).toContain('newq:cancel')
    // Nothing typed into the pane at command time.
    expect(calls.length).toBe(0)
  })

  // FIX-6: typed `/cc compact` (argless control) routes through the RELIABLE
  // state-aware sender (probe → confirm), exactly like the ccmd: button.
  test('/cc compact routes through the reliable sender (probe + confirm)', async () => {
    const parsed = parseOobCommand('/cc compact')
    if (!parsed) throw new Error('parse failed')
    const calls: string[][] = []
    let i = 0
    const panes = [IDLE_PANE, typedPane('compact'), COMPACTING_PANE]
    const ctx = makeCtx()
    ctx.tmuxKeys = {
      target: { paneTarget: '%1', socketPath: '/tmp/s' },
      exec: async (args) => {
        calls.push([...args])
        return { exitCode: 0, stderr: '' }
      },
      captureExec: async () => {
        const out = i < panes.length ? panes[i]! : (panes[panes.length - 1] ?? '')
        i++
        return { exitCode: 0, stdout: out, stderr: '' }
      },
      sleep: noSleep,
    }
    const res = await handleOobCommand(parsed, ctx)
    expect(res.command).toBe('cc')
    expect(calls.some((c) => c.includes('/compact'))).toBe(true)
    expect(res.replyToTelegram!.text).toContain('отправлено в сессию')
  })

  // FIX-6: typed `/cc compact` into a DIALOG pane must NOT blind-fire — the
  // reliable sender refuses (a trailing Enter would approve the dialog).
  test('/cc compact into a dialog pane refuses, types NOTHING', async () => {
    const parsed = parseOobCommand('/cc compact')
    if (!parsed) throw new Error('parse failed')
    const calls: string[][] = []
    const ctx = makeCtx()
    ctx.tmuxKeys = {
      target: { paneTarget: '%1', socketPath: '/tmp/s' },
      exec: async (args) => {
        calls.push([...args])
        return { exitCode: 0, stderr: '' }
      },
      captureExec: async () => ({ exitCode: 0, stdout: DIALOG_PANE, stderr: '' }),
      sleep: noSleep,
    }
    const res = await handleOobCommand(parsed, ctx)
    expect(calls.length).toBe(0) // never typed into an open dialog
    expect(res.replyToTelegram!.text).toContain('ждёт ответа в диалоге')
  })

  // FIX-6: an ARGFUL `/cc <cmd>` (e.g. `model opus`) probes the pane and refuses
  // when it is not idle, before the blind sendSlashCommand.
  test('/cc model opus into a busy pane refuses (probe-before-send)', async () => {
    const parsed = parseOobCommand('/cc model opus')
    if (!parsed) throw new Error('parse failed')
    const calls: string[][] = []
    const ctx = makeCtx()
    ctx.tmuxKeys = {
      target: { paneTarget: '%1', socketPath: '/tmp/s' },
      exec: async (args) => {
        calls.push([...args])
        return { exitCode: 0, stderr: '' }
      },
      captureExec: async () => ({ exitCode: 0, stdout: BUSY_PANE, stderr: '' }),
      sleep: noSleep,
    }
    const res = await handleOobCommand(parsed, ctx)
    expect(calls.length).toBe(0) // did not blind-send into a busy pane
    expect(res.replyToTelegram!.text).toContain('сессия не готова')
  })

  // FIX-6: an argful `/cc <cmd>` into an IDLE pane still sends (probe passed).
  test('/cc model opus into an idle pane sends the command', async () => {
    const parsed = parseOobCommand('/cc model opus')
    if (!parsed) throw new Error('parse failed')
    const calls: string[][] = []
    const ctx = makeCtx()
    ctx.tmuxKeys = {
      target: { paneTarget: '%1', socketPath: '/tmp/s' },
      exec: async (args) => {
        calls.push([...args])
        return { exitCode: 0, stderr: '' }
      },
      captureExec: async () => ({ exitCode: 0, stdout: IDLE_PANE, stderr: '' }),
      sleep: noSleep,
    }
    const res = await handleOobCommand(parsed, ctx)
    expect(calls.some((c) => c.includes('/model opus'))).toBe(true)
    expect(res.replyToTelegram!.text).toContain('отправлено в сессию')
  })
})
