// M4 (fix-loop 1): ContextHud.setHeartbeatSuffix — the no-ping «работаю: …»
// pin heartbeat. EDIT-ONLY semantics (fix-loop-1 #6): the heartbeat may only
// edit an EXISTING pin — with no pin it is a strict no-op (never creates a
// message), and a message_gone edit stands down without recreating. Also
// verifies the suffix renders as the final line, clears on null, escapes
// HTML, and is idempotent.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ContextHud, type HudTelegramApi, type SessionInfoReader } from '../../src/status/context-hud.js'
import type { EditOpts, SendMessageOpts } from '../../src/channel/tools.js'
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

function grammyGone(): Error {
  const e = new Error('Bad Request: message to edit not found') as Error & {
    error_code: number
    description: string
  }
  e.error_code = 400
  e.description = 'Bad Request: message to edit not found'
  return e
}

class FakeApi implements HudTelegramApi {
  sent: Array<{ text: string }> = []
  edited: Array<{ text: string }> = []
  nextId = 100
  editError: unknown
  async sendMessage(_c: string, text: string, _o: SendMessageOpts): Promise<{ message_id: number }> {
    this.sent.push({ text })
    return { message_id: this.nextId++ }
  }
  async editMessageText(_c: string, _m: number, text: string, _o: EditOpts): Promise<void> {
    if (this.editError) throw this.editError
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

// Create the pin the lifecycle way (SessionStart sends + pins the card).
async function withPin(api: FakeApi): Promise<ContextHud> {
  const hud = makeHud(api)
  await hud.onSessionStart(OWNER, { sessionId: 's1' })
  expect(api.sent.length).toBe(1) // the pinned card
  return hud
}

describe('setHeartbeatSuffix (edit-only)', () => {
  test('NO pin exists → strict no-op: never creates a message (fix-loop-1 #6)', async () => {
    const api = new FakeApi()
    const hud = makeHud(api)
    await hud.setHeartbeatSuffix(OWNER, 'работаю: сборка · 12:00')
    expect(api.sent.length).toBe(0)
    expect(api.edited.length).toBe(0)
  })

  test('edits the existing pin — suffix is the final line', async () => {
    const api = new FakeApi()
    const hud = await withPin(api)
    await hud.setHeartbeatSuffix(OWNER, 'работаю: сборка · 12:00')
    expect(api.sent.length).toBe(1) // STILL only the lifecycle send
    const text = api.edited.at(-1)?.text ?? ''
    expect(text).toContain('🧠 <b>Контекст</b>:')
    expect(text.endsWith('<i>работаю: сборка · 12:00</i>')).toBe(true)
  })

  test('clears the suffix on null', async () => {
    const api = new FakeApi()
    const hud = await withPin(api)
    await hud.setHeartbeatSuffix(OWNER, 'работаю: x · 12:00')
    await hud.setHeartbeatSuffix(OWNER, null)
    const lastEdit = api.edited.at(-1)?.text ?? ''
    expect(lastEdit).not.toContain('работаю')
  })

  test('escapes HTML in the task text', async () => {
    const api = new FakeApi()
    const hud = await withPin(api)
    await hud.setHeartbeatSuffix(OWNER, 'работаю: <b>x</b> · 12:00')
    const text = api.edited.at(-1)?.text ?? ''
    expect(text).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(text).not.toContain('<b>x</b>')
  })

  test('idempotent — setting the same suffix twice does not churn', async () => {
    const api = new FakeApi()
    const hud = await withPin(api)
    await hud.setHeartbeatSuffix(OWNER, 'работаю: y · 12:00')
    const editsAfterFirst = api.edited.length
    await hud.setHeartbeatSuffix(OWNER, 'работаю: y · 12:00') // same → no-op
    expect(api.edited.length).toBe(editsAfterFirst)
  })

  test('message_gone during the heartbeat edit → stand down, NO recreate', async () => {
    const api = new FakeApi()
    const hud = await withPin(api)
    api.editError = grammyGone()
    await hud.setHeartbeatSuffix(OWNER, 'работаю: z · 12:00')
    // The self-heal path (updateNow/edit) would have sent a fresh card here —
    // the heartbeat path must NOT (only the lifecycle send exists).
    expect(api.sent.length).toBe(1)
    // The stale id was dropped — a follow-up heartbeat is a strict no-op.
    api.editError = undefined
    const editsBefore = api.edited.length
    await hud.setHeartbeatSuffix(OWNER, 'работаю: z · 12:05')
    expect(api.sent.length).toBe(1)
    expect(api.edited.length).toBe(editsBefore)
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
