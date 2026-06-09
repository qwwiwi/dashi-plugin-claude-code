import { describe, expect, test } from 'bun:test'

import { createPermissionGateUi, parsePgateCallback } from '../../src/telegram/permission-gate-ui.js'
import type { AppConfig } from '../../src/config.js'
import type { PermissionGateRelay, PendingPermissionGate } from '../../src/channel/permission-gate-relay.js'
import type { TelegramApi } from '../../src/channel/tools.js'

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never

// Minimal config — UI only reads permission_gate + permission_relay allowlists.
const config = {
  permission_gate: { enabled: true, timeout_ms: 120_000, allowed_user_ids: [164795011] },
  permission_relay: { enabled: true, allowed_user_ids: [164795011], bash_only_proof: true },
} as unknown as AppConfig

function makeTelegramApi() {
  const sent: { chatId: string; text: string }[] = []
  const edited: { chatId: string; messageId: number; text: string }[] = []
  const api = {
    async sendMessage(chatId: string, text: string) {
      sent.push({ chatId, text })
      return { message_id: 999 }
    },
    async editMessageText(chatId: string, messageId: number, text: string) {
      edited.push({ chatId, messageId, text })
    },
    async setMessageReaction() {},
    async sendChatAction() {},
  } as unknown as TelegramApi
  return { api, sent, edited }
}

// A controllable fake relay exposing just what the UI calls.
function makeFakeRelay(initial?: Partial<PendingPermissionGate>) {
  let pending: PendingPermissionGate | undefined = initial
    ? ({
        requestId: 'abcde',
        toolUseId: 'tu',
        sessionId: 's',
        toolName: 'Bash',
        preview: 'git push',
        reason: 'risky',
        createdAt: 0,
        expiresAt: 0,
        chatId: '164795011',
        telegramMessageId: undefined,
        _settled: false,
        _timer: null,
        _resolve: () => {},
        ...initial,
      } as PendingPermissionGate)
    : undefined
  const answered: { id: string; behavior: string }[] = []
  const relay = {
    submit: () => ({ requestId: undefined, result: Promise.resolve({ status: 'deny' as const }) }),
    answer: (id: string, behavior: 'allow' | 'deny') => {
      answered.push({ id, behavior })
      if (!pending) return 'idempotent' as const
      pending = undefined
      return behavior
    },
    expire: () => {},
    isPending: () => pending !== undefined,
    getPending: () => pending,
    setTelegramMessageId: (_id: string, mid: number) => {
      if (pending) pending.telegramMessageId = mid
    },
    pendingCount: () => (pending ? 1 : 0),
    listPendingIds: () => (pending ? [pending.requestId] : []),
  } as unknown as PermissionGateRelay
  return { relay, answered, getPending: () => pending }
}

describe('parsePgateCallback', () => {
  test('parses allow/deny', () => {
    expect(parsePgateCallback('pgate:allow:abcde')).toEqual({ behavior: 'allow', requestId: 'abcde' })
    expect(parsePgateCallback('pgate:deny:abcde')).toEqual({ behavior: 'deny', requestId: 'abcde' })
  })
  test('rejects foreign / malformed data', () => {
    expect(parsePgateCallback('perm:allow:abcde')).toBeNull()
    expect(parsePgateCallback('pgate:maybe:abcde')).toBeNull()
    expect(parsePgateCallback('pgate:allow:TOOLONGID')).toBeNull()
  })
})

describe('permission-gate UI', () => {
  test('sendPrompt sends an HTML card with the keyboard and stashes the message id', async () => {
    const { api, sent } = makeTelegramApi()
    const { relay, getPending } = makeFakeRelay({})
    const ui = createPermissionGateUi({ config, log, telegramApi: api, relay })
    await ui.sendPrompt('abcde')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('Bash')
    expect(getPending()?.telegramMessageId).toBe(999)
  })

  test('sendPrompt is a no-op when a keyboard was already sent (replay)', async () => {
    const { api, sent } = makeTelegramApi()
    const { relay } = makeFakeRelay({ telegramMessageId: 5 })
    const ui = createPermissionGateUi({ config, log, telegramApi: api, relay })
    await ui.sendPrompt('abcde')
    expect(sent).toHaveLength(0)
  })

  test('authorized allow tap resolves the relay and edits the card', async () => {
    const { api, edited } = makeTelegramApi()
    const { relay, answered } = makeFakeRelay({ telegramMessageId: 5 })
    const ui = createPermissionGateUi({ config, log, telegramApi: api, relay })
    let toast: string | undefined
    const handled = await ui.handlePgateCallback({
      callbackQuery: { data: 'pgate:allow:abcde', messageId: 5 },
      from: { id: 164795011 },
      answerCallbackQuery: async (arg) => { toast = arg?.text },
    })
    expect(handled).toBe(true)
    expect(answered).toEqual([{ id: 'abcde', behavior: 'allow' }])
    expect(edited[0]!.text).toContain('Разрешено')
    expect(toast).toBe('Разрешено')
  })

  test('tap from a stale keyboard (message-id mismatch) does NOT resolve the relay', async () => {
    const { api } = makeTelegramApi()
    const { relay, answered } = makeFakeRelay({ telegramMessageId: 5 })
    const ui = createPermissionGateUi({ config, log, telegramApi: api, relay })
    let toast: string | undefined
    await ui.handlePgateCallback({
      callbackQuery: { data: 'pgate:allow:abcde', messageId: 999 }, // != 5
      from: { id: 164795011 },
      answerCallbackQuery: async (arg) => { toast = arg?.text },
    })
    expect(answered).toHaveLength(0)
    expect(toast).toBe('Запрос уже закрыт')
  })

  test('tap with the matching message-id resolves normally', async () => {
    const { api } = makeTelegramApi()
    const { relay, answered } = makeFakeRelay({ telegramMessageId: 5 })
    const ui = createPermissionGateUi({ config, log, telegramApi: api, relay })
    await ui.handlePgateCallback({
      callbackQuery: { data: 'pgate:allow:abcde', messageId: 5 },
      from: { id: 164795011 },
      answerCallbackQuery: async () => {},
    })
    expect(answered).toEqual([{ id: 'abcde', behavior: 'allow' }])
  })

  test('unauthorized tap is rejected and does NOT resolve the relay', async () => {
    const { api } = makeTelegramApi()
    const { relay, answered } = makeFakeRelay({ telegramMessageId: 5 })
    const ui = createPermissionGateUi({ config, log, telegramApi: api, relay })
    let toast: string | undefined
    await ui.handlePgateCallback({
      callbackQuery: { data: 'pgate:allow:abcde', messageId: 5 },
      from: { id: 999 },
      answerCallbackQuery: async (arg) => { toast = arg?.text },
    })
    expect(answered).toHaveLength(0)
    expect(toast).toBe('Не авторизован')
  })

  test('tap with NO message-id is rejected when the request has a keyboard (required, not fallthrough)', async () => {
    const { api } = makeTelegramApi()
    const { relay, answered } = makeFakeRelay({ telegramMessageId: 5 })
    const ui = createPermissionGateUi({ config, log, telegramApi: api, relay })
    await ui.handlePgateCallback({
      callbackQuery: { data: 'pgate:allow:abcde' }, // no messageId
      from: { id: 164795011 },
      answerCallbackQuery: async () => {},
    })
    expect(answered).toHaveLength(0)
  })

  test('foreign callback data is not consumed', async () => {
    const { api } = makeTelegramApi()
    const { relay } = makeFakeRelay({})
    const ui = createPermissionGateUi({ config, log, telegramApi: api, relay })
    const handled = await ui.handlePgateCallback({
      callbackQuery: { data: 'ask:choose:abcde:0:1' },
      from: { id: 164795011 },
      answerCallbackQuery: async () => {},
    })
    expect(handled).toBe(false)
  })
})
