import { describe, expect, test } from 'bun:test'

import {
  registerOwnerScopedCommands,
  type CommandScopeApi,
  type CommandSpec,
} from '../../src/telegram/command-scope.js'
import type { Logger } from '../../src/log.js'

const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger

const CMDS: CommandSpec[] = [
  { command: 'help', description: 'справка' },
  { command: 'status', description: 'статус' },
]

// A fake bot.api that records every scope call.
function fakeApi(): {
  api: CommandScopeApi
  deletes: Array<{ scope?: { type: string } } | undefined>
  sets: Array<{ commands: readonly CommandSpec[]; scope: { type: string; chat_id: number | string } }>
} {
  const deletes: Array<{ scope?: { type: string } } | undefined> = []
  const sets: Array<{ commands: readonly CommandSpec[]; scope: { type: string; chat_id: number | string } }> = []
  const api: CommandScopeApi = {
    deleteMyCommands: async (options) => {
      deletes.push(options)
      return true
    },
    setMyCommands: async (commands, options) => {
      sets.push({ commands, scope: options.scope })
      return true
    },
  }
  return { api, deletes, sets }
}

describe('registerOwnerScopedCommands', () => {
  test('clears default + all_private_chats, then registers per owner chat', async () => {
    const { api, deletes, sets } = fakeApi()
    await registerOwnerScopedCommands(api, CMDS, [164795011], log)

    // Two deleteMyCommands: default (no arg) + all_private_chats.
    expect(deletes.length).toBe(2)
    expect(deletes[0]).toBeUndefined() // default scope = bare call
    expect(deletes[1]).toEqual({ scope: { type: 'all_private_chats' } })

    // One setMyCommands scoped to the owner chat.
    expect(sets.length).toBe(1)
    expect(sets[0]!.scope).toEqual({ type: 'chat', chat_id: 164795011 })
    expect(sets[0]!.commands.map((c) => c.command)).toEqual(['help', 'status'])
  })

  test('FIX-11: registers ONLY positive DM ids; skips group / @channel ids', async () => {
    const { api, sets } = fakeApi()
    // A negative group id and an @channel string must NOT get the owner menu
    // (that would expose it publicly). Only the positive DM ids register.
    await registerOwnerScopedCommands(api, CMDS, [111, -100222, '@chan', 222], log)
    expect(sets.map((s) => s.scope.chat_id)).toEqual([111, 222])
    for (const s of sets) expect(s.scope.type).toBe('chat')
  })

  test('FIX-11: a failure of the FIRST deleteMyCommands still runs the second', async () => {
    const deletes: Array<{ scope?: { type: string } } | undefined> = []
    const sets: Array<number | string> = []
    let call = 0
    const api: CommandScopeApi = {
      deleteMyCommands: async (options) => {
        call += 1
        deletes.push(options)
        if (call === 1) throw new Error('default-scope offline') // first fails
        return true
      },
      setMyCommands: async (_c, options) => {
        sets.push(options.scope.chat_id)
        return true
      },
    }
    await registerOwnerScopedCommands(api, CMDS, [164795011], log)
    // BOTH deletes were attempted (separate try/catch) despite the first throw.
    expect(deletes.length).toBe(2)
    expect(deletes[1]).toEqual({ scope: { type: 'all_private_chats' } })
    expect(sets).toEqual([164795011])
  })

  test('a per-chat setMyCommands failure does not abort the rest', async () => {
    const sets: Array<number | string> = []
    const api: CommandScopeApi = {
      deleteMyCommands: async () => true,
      setMyCommands: async (_c, options) => {
        if (options.scope.chat_id === 111) throw new Error('boom')
        sets.push(options.scope.chat_id)
        return true
      },
    }
    // Must not throw despite the first chat failing.
    await registerOwnerScopedCommands(api, CMDS, [111, 222], log)
    expect(sets).toEqual([222])
  })

  test('a deleteMyCommands failure still proceeds to register', async () => {
    const sets: Array<number | string> = []
    const api: CommandScopeApi = {
      deleteMyCommands: async () => {
        throw new Error('offline')
      },
      setMyCommands: async (_c, options) => {
        sets.push(options.scope.chat_id)
        return true
      },
    }
    await registerOwnerScopedCommands(api, CMDS, [164795011], log)
    expect(sets).toEqual([164795011])
  })
})
