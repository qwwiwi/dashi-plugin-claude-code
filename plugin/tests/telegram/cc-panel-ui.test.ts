import { describe, expect, test } from 'bun:test'

import {
  CC_PANEL_COMMANDS,
  CCMD_PREFIX,
  buildCcKeyboard,
  handleCcmdCallback,
  parseCcmdCallback,
  type CcmdCallbackContext,
  type CcmdCallbackDeps,
} from '../../src/telegram/cc-panel-ui.js'
import type { Logger } from '../../src/log.js'

const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger
const ALLOWED = [164795011]
const PANE = { paneTarget: '%1', socketPath: '/tmp/s' }

function makeCtx(data: string, fromId: number | undefined): {
  ctx: CcmdCallbackContext
  answers: string[]
} {
  const answers: string[] = []
  const ctx: CcmdCallbackContext = {
    callbackQuery: { data },
    from: { id: fromId },
    answerCallbackQuery: async (arg) => {
      answers.push(arg.text)
    },
  }
  return { ctx, answers }
}

function capturingExec(): { calls: string[][]; deps: CcmdCallbackDeps } {
  const calls: string[][] = []
  const deps: CcmdCallbackDeps = {
    allowedUserIds: ALLOWED,
    tmuxKeysTarget: PANE,
    log,
    exec: async (args) => {
      calls.push([...args])
      return { exitCode: 0, stderr: '' }
    },
  }
  return { calls, deps }
}

describe('parseCcmdCallback', () => {
  test('accepts a whitelisted command', () => {
    expect(parseCcmdCallback(`${CCMD_PREFIX}compact`)).toBe('compact')
    expect(parseCcmdCallback(`${CCMD_PREFIX}model`)).toBe('model')
  })

  test('rejects unknown command, wrong prefix, empty, non-string', () => {
    expect(parseCcmdCallback(`${CCMD_PREFIX}rm`)).toBeNull()
    expect(parseCcmdCallback(`${CCMD_PREFIX}compact extra`)).toBeNull()
    expect(parseCcmdCallback('kkey:1')).toBeNull()
    expect(parseCcmdCallback(`${CCMD_PREFIX}`)).toBeNull()
    expect(parseCcmdCallback(`${CCMD_PREFIX}__proto__`)).toBeNull()
    expect(parseCcmdCallback(`${CCMD_PREFIX}constructor`)).toBeNull()
    expect(parseCcmdCallback(`${CCMD_PREFIX}toString`)).toBeNull()
    expect(parseCcmdCallback(`${CCMD_PREFIX}Compact`)).toBeNull()
    expect(parseCcmdCallback(`${CCMD_PREFIX}compact `)).toBeNull()
    // @ts-expect-error runtime guard for non-string
    expect(parseCcmdCallback(undefined)).toBeNull()
  })
})

describe('buildCcKeyboard', () => {
  test('exposes exactly the whitelisted commands as ccmd: callbacks', () => {
    const kb = buildCcKeyboard()
    const datas = kb.inline_keyboard.flat().map((b) => b.callback_data)
    expect(datas.sort()).toEqual(
      CC_PANEL_COMMANDS.map((c) => `${CCMD_PREFIX}${c.name}`).sort(),
    )
  })
})

describe('handleCcmdCallback', () => {
  test('unauthorized user id: toast, NO command typed', async () => {
    const { calls, deps } = capturingExec()
    const { ctx, answers } = makeCtx(`${CCMD_PREFIX}compact`, 999)
    await handleCcmdCallback(ctx, deps)
    expect(calls.length).toBe(0)
    expect(answers[0]).toContain('не авторизовано')
  })

  test('missing id is unauthorized (fail-closed)', async () => {
    const { calls, deps } = capturingExec()
    const { ctx, answers } = makeCtx(`${CCMD_PREFIX}compact`, undefined)
    await handleCcmdCallback(ctx, deps)
    expect(calls.length).toBe(0)
    expect(answers[0]).toContain('не авторизовано')
  })

  test('authorized + valid command types /<name> into pane', async () => {
    const { calls, deps } = capturingExec()
    const { ctx, answers } = makeCtx(`${CCMD_PREFIX}compact`, ALLOWED[0]!)
    await handleCcmdCallback(ctx, deps)
    // sendSlashCommand: C-u clear, then literal text, then Enter
    expect(calls.some((c) => c.includes('/compact'))).toBe(true)
    expect(calls.some((c) => c.includes('C-u'))).toBe(true)
    expect(answers[0]).toContain('выполнено')
  })

  test('authorized + unknown command: toast, NO command typed', async () => {
    const { calls, deps } = capturingExec()
    const { ctx, answers } = makeCtx(`${CCMD_PREFIX}reboot`, ALLOWED[0]!)
    await handleCcmdCallback(ctx, deps)
    expect(calls.length).toBe(0)
    expect(answers[0]).toContain('неизвестная команда')
  })

  test('no pane resolvable: toast, NO command typed', async () => {
    const calls: string[][] = []
    const deps: CcmdCallbackDeps = {
      allowedUserIds: ALLOWED,
      log,
      exec: async (args) => {
        calls.push([...args])
        return { exitCode: 0, stderr: '' }
      },
    }
    const { ctx, answers } = makeCtx(`${CCMD_PREFIX}compact`, ALLOWED[0]!)
    await handleCcmdCallback(ctx, deps)
    expect(calls.length).toBe(0)
    expect(answers[0]).toContain('pane недоступен')
  })
})
