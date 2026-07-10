// M4: ContextHud.setHeartbeatSuffix — the no-ping «работаю: …» pin heartbeat.
// Verifies the suffix is appended as the final line, cleared on null, escaped
// for HTML, and idempotent (no churn when unchanged).

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ContextHud, type HudTelegramApi, type SessionInfoReader } from '../../src/status/context-hud.js'
import type { EditOpts, InlineKeyboardLike, SendMessageOpts } from '../../src/channel/tools.js'
import type { Logger } from '../../src/log.js'

const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger
const OWNER = '164795011'

const dirs: string[] = []
function stateDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'hud-hb-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

class FakeApi implements HudTelegramApi {
  sent: Array<{ text: string }> = []
  edited: Array<{ text: string }> = []
  nextId = 100
  async sendMessage(_c: string, text: string, _o: SendMessageOpts): Promise<{ message_id: number }> {
    this.sent.push({ text })
    return { message_id: this.nextId++ }
  }
  async editMessageText(_c: string, _m: number, text: string, _o: EditOpts): Promise<void> {
    this.edited.push({ text })
  }
  async pinChatMessage(): Promise<void> {}
  async deleteMessage(): Promise<void> {}
  async unpinChatMessage(): Promise<void> {}
}

const session: SessionInfoReader = { get: () => ({ transcriptPath: '/t/a.jsonl', model: 'opus' }) }

function makeHud(api: HudTelegramApi, enabled = true): ContextHud {
  return new ContextHud({
    api,
    log,
    sessionInfo: session,
    windowTokens: 200_000,
    ownerChatIds: [OWNER],
    stateDir: stateDir(),
    enabled,
    readContextUsage: async () => ({ usedTokens: 100_000, pct: 0.5 }),
  })
}

const _kb: InlineKeyboardLike = { inline_keyboard: [] }
void _kb

describe('setHeartbeatSuffix', () => {
  test('appends the suffix as the final line of the pin', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.setHeartbeatSuffix(OWNER, 'работаю: сборка · 12:00')
    // No message existed → the fresh send carries the suffix.
    expect(api.sent.length).toBe(1)
    const text = api.sent[0]?.text ?? ''
    expect(text).toContain('🧠 <b>Контекст</b>:')
    expect(text.endsWith('<i>работаю: сборка · 12:00</i>')).toBe(true)
  })

  test('clears the suffix on null', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.setHeartbeatSuffix(OWNER, 'работаю: x · 12:00') // send #1 (with suffix)
    await hud.setHeartbeatSuffix(OWNER, null) // edit — suffix gone
    const lastEdit = api.edited.at(-1)?.text ?? ''
    expect(lastEdit).not.toContain('работаю')
  })

  test('escapes HTML in the task text', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.setHeartbeatSuffix(OWNER, 'работаю: <b>x</b> · 12:00')
    const text = api.sent[0]?.text ?? ''
    expect(text).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(text).not.toContain('<b>x</b>')
  })

  test('idempotent — setting the same suffix twice does not churn', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.setHeartbeatSuffix(OWNER, 'работаю: y · 12:00') // send
    const editsAfterFirst = api.edited.length
    await hud.setHeartbeatSuffix(OWNER, 'работаю: y · 12:00') // same → no-op
    expect(api.edited.length).toBe(editsAfterFirst)
  })

  test('disabled HUD → no-op', async () => {
    const api = new FakeApi()
    const hud = makeHud(api, false)
    await hud.setHeartbeatSuffix(OWNER, 'работаю: z · 12:00')
    expect(api.sent.length).toBe(0)
  })

  test('non-owner chat → no-op', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.setHeartbeatSuffix('-100999', 'работаю: q · 12:00')
    expect(api.sent.length).toBe(0)
  })
})
