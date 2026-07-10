// Autonomy M2 — /lease OOB command handler.
//
// Exercises handleOobCommand's `lease` case directly (the OOB auth gate is
// tested in tests/telegram/handlers.test.ts). Covers: grant + confirmation
// reply, ttl parsing, bare /lease listing, and idempotency by grantSourceId
// (`cmd:<chatId>:<messageId>`).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleOobCommand, parseOobCommand, type OobContext } from '../../src/commands/oob.js'
import { activeLeases, loadAutonomyState, revokeLease, updateAutonomyState } from '../../src/autonomy/store.js'
import type { AppConfig } from '../../src/config.js'
import type { Logger } from '../../src/log.js'
import type { TelegramApi } from '../../src/channel/tools.js'

const CHAT = '164795011'

function silentLog(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

// The lease handler never calls telegramApi (it returns replyToTelegram data);
// a throwing stub proves that.
function throwingApi(): TelegramApi {
  return new Proxy({} as TelegramApi, {
    get() {
      return async () => {
        throw new Error('telegramApi must not be called by handleLeaseCommand')
      }
    },
  })
}

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dashi-oob-lease-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function mkCtx(over: Partial<OobContext> = {}): OobContext {
  return {
    chatId: CHAT,
    senderId: CHAT,
    config: {} as unknown as AppConfig,
    telegramApi: throwingApi(),
    log: silentLog(),
    stateDir: root,
    messageId: 42,
    ...over,
  }
}

function parse(text: string) {
  const p = parseOobCommand(text)
  if (!p) throw new Error(`not an OOB command: ${text}`)
  return p
}

describe('/lease parsing wiring', () => {
  test('parseOobCommand recognises /lease as a known command', () => {
    expect(parse('/lease deploy').name).toBe('lease')
    expect(parse('/lease').name).toBe('lease')
    expect(parse('/lease@trallvibecoderbot x').name).toBe('lease')
  })
})

describe('/lease grant', () => {
  test('grants a lease and replies with id/scope/expiry', async () => {
    const res = await handleOobCommand(parse('/lease деплой стейджинга; ttl=48h'), mkCtx())
    expect(res.command).toBe('lease')
    const leases = activeLeases(loadAutonomyState({ root }, CHAT), Date.now())
    expect(leases.length).toBe(1)
    expect(leases[0]!.scope).toBe('деплой стейджинга')
    expect(leases[0]!.source).toBe('owner_cmd')
    expect(leases[0]!.grantSourceId).toBe(`cmd:${CHAT}:42`)
    const ttlH = (leases[0]!.expiresAtMs - leases[0]!.grantedAtMs) / 3_600_000
    expect(Math.round(ttlH)).toBe(48)
    const text = res.replyToTelegram!.text
    expect(text).toContain('мандат выдан')
    expect(text).toContain(leases[0]!.id)
    expect(text).toContain('деплой стейджинга')
  })

  test('default ttl 24h when unspecified', async () => {
    await handleOobCommand(parse('/lease catch the wave'), mkCtx())
    const l = activeLeases(loadAutonomyState({ root }, CHAT), Date.now())[0]!
    expect(Math.round((l.expiresAtMs - l.grantedAtMs) / 3_600_000)).toBe(24)
  })

  test('replayed command (same messageId) mints exactly one lease', async () => {
    await handleOobCommand(parse('/lease deploy'), mkCtx({ messageId: 7 }))
    const res2 = await handleOobCommand(parse('/lease deploy'), mkCtx({ messageId: 7 }))
    expect(loadAutonomyState({ root }, CHAT).leases.length).toBe(1)
    expect(res2.replyToTelegram!.text).toContain('мандат уже активен')
  })
})

describe('/lease bare — list active + usage', () => {
  test('empty registry → "нет активных мандатов" + usage', async () => {
    const res = await handleOobCommand(parse('/lease'), mkCtx())
    const text = res.replyToTelegram!.text
    expect(text).toContain('нет активных мандатов')
    expect(text).toContain('usage')
    // Bare command grants nothing.
    expect(loadAutonomyState({ root }, CHAT).leases.length).toBe(0)
  })

  test('lists an existing active lease', async () => {
    await handleOobCommand(parse('/lease деплой; ttl=12h'), mkCtx({ messageId: 1 }))
    const res = await handleOobCommand(parse('/lease'), mkCtx({ messageId: 2 }))
    const text = res.replyToTelegram!.text
    expect(text).toContain('деплой')
    expect(text).toContain('активные мандаты')
  })

  test('args that are only options with no scope → treated as bare (no grant)', async () => {
    const res = await handleOobCommand(parse('/lease ; ttl=48h'), mkCtx())
    expect(res.replyToTelegram!.text).toContain('нет активных мандатов')
    expect(loadAutonomyState({ root }, CHAT).leases.length).toBe(0)
  })
})

describe('/lease misconfig', () => {
  test('missing stateDir → graceful message, no throw', async () => {
    const ctx = mkCtx()
    delete (ctx as { stateDir?: string }).stateDir
    const res = await handleOobCommand(parse('/lease deploy'), ctx)
    expect(res.replyToTelegram!.text).toContain('недоступно')
  })
})

describe('/lease fail-closed grammar (fix-loop #3/#6)', () => {
  test('malformed trailing ttl → usage error, NO lease', async () => {
    for (const bad of ['/lease аудит; ttl=200h', '/lease аудит; ttl=0h', '/lease аудит; ttl=4.5h', '/lease аудит; ttl=abch']) {
      const res = await handleOobCommand(parse(bad), mkCtx())
      expect(res.replyToTelegram!.text).toContain('некорректный ttl')
      expect(res.replyToTelegram!.text).toContain('usage')
    }
    expect(loadAutonomyState({ root }, CHAT).leases.length).toBe(0)
  })

  test('non-option `;` belongs to the scope — no silent truncation, echoed in full', async () => {
    const res = await handleOobCommand(parse('/lease аудит; production'), mkCtx())
    const lease = activeLeases(loadAutonomyState({ root }, CHAT), Date.now())[0]!
    expect(lease.scope).toBe('аудит; production')
    // The confirmation echoes the EXACT granted scope.
    expect(res.replyToTelegram!.text).toContain('аудит; production')
  })

  test('scope over 400 code points → usage error, NO lease', async () => {
    const res = await handleOobCommand(parse(`/lease ${'x'.repeat(401)}`), mkCtx())
    expect(res.replyToTelegram!.text).toContain('400')
    expect(loadAutonomyState({ root }, CHAT).leases.length).toBe(0)
  })
})

describe('/lease duplicate against a TERMINAL lease states the real status (fix-loop #8)', () => {
  test('revoked lease → «ОТОЗВАН», not «уже активен»; no re-mint', async () => {
    await handleOobCommand(parse('/lease deploy'), mkCtx({ messageId: 5 }))
    // Revoke the minted lease through the store.
    const minted = loadAutonomyState({ root }, CHAT).leases[0]!
    await updateAutonomyState({ root }, CHAT, (state) => {
      const r = revokeLease(state, minted.id, Date.now(), 'owner', 'test')
      return { state: r.state, result: r.outcome }
    })
    // Replay the SAME command message.
    const res = await handleOobCommand(parse('/lease deploy'), mkCtx({ messageId: 5 }))
    expect(res.replyToTelegram!.text).toContain('ОТОЗВАН')
    expect(res.replyToTelegram!.text).not.toContain('уже активен')
    expect(loadAutonomyState({ root }, CHAT).leases.length).toBe(1) // no second lease
  })
})
