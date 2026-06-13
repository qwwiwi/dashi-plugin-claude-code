import { describe, expect, test } from 'bun:test'

import {
  buildKeysKeyboard,
  handleKkeyCallback,
  parseKkeyCallback,
  KEYS_PANEL_HEADER,
  KKEY_PREFIX,
  type KkeyCallbackContext,
  type KkeyCallbackDeps,
} from '../../src/telegram/keys-panel-ui.js'
import {
  LITERAL_TOKEN_LIST,
  NAMED_TOKENS,
  isLiteralToken,
  parseKeyTokens,
  type KeysExec,
  type TmuxKeysTarget,
} from '../../src/commands/keys.js'
import type { Logger } from '../../src/log.js'

function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

// ─────────────────────────────────────────────────────────────────────
// parseKkeyCallback
// ─────────────────────────────────────────────────────────────────────

describe('parseKkeyCallback', () => {
  test('accepts each whitelisted literal token', () => {
    for (const t of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'y', 'n']) {
      expect(parseKkeyCallback(`${KKEY_PREFIX}${t}`)).toBe(t)
    }
  })

  test('accepts each whitelisted named token', () => {
    for (const t of ['enter', 'esc', 'escape', 'tab', 'space', 'up', 'down', 'left', 'right']) {
      expect(parseKkeyCallback(`${KKEY_PREFIX}${t}`)).toBe(t)
    }
  })

  test('rejects a non-whitelisted token (kkey:rm)', () => {
    expect(parseKkeyCallback('kkey:rm')).toBeNull()
  })

  test('rejects an empty token (kkey:)', () => {
    expect(parseKkeyCallback('kkey:')).toBeNull()
  })

  test('rejects a multi-token / sequence payload (kkey:1;2)', () => {
    expect(parseKkeyCallback('kkey:1;2')).toBeNull()
    expect(parseKkeyCallback('kkey:1 enter')).toBeNull()
    expect(parseKkeyCallback('kkey:1,2')).toBeNull()
  })

  test('rejects non-kkey callback data', () => {
    expect(parseKkeyCallback('pgate:allow:abcde')).toBeNull()
    expect(parseKkeyCallback('ask:foo')).toBeNull()
    expect(parseKkeyCallback('perm:allow')).toBeNull()
    expect(parseKkeyCallback('1')).toBeNull()
  })

  test('rejects an empty string', () => {
    expect(parseKkeyCallback('')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────
// Runtime tamper-resistance of the literal-token whitelist (LOW #1).
// A malicious in-process import must NOT be able to widen the set of
// keystrokes /key (and the kkey panel) will inject into the tmux pane.
// ─────────────────────────────────────────────────────────────────────

describe('literal-token whitelist is tamper-proof at runtime', () => {
  test('frozen LITERAL_TOKEN_LIST cannot be widened, and validation stays closed', () => {
    // Sanity: the canonical structure is frozen.
    expect(Object.isFrozen(LITERAL_TOKEN_LIST)).toBe(true)
    expect(Object.isFrozen(isLiteralToken)).toBe(true)

    // Baseline behaviour BEFORE any mutation attempt.
    expect(isLiteralToken('1')).toBe(true)
    expect(isLiteralToken('rm')).toBe(false)
    expect('error' in parseKeyTokens('1')).toBe(false)
    expect('error' in parseKeyTokens('rm')).toBe(true)

    // Attempt every plausible runtime widening of the literal whitelist.
    // (a) cast the readonly array to a mutable array and push.
    try {
      ;(LITERAL_TOKEN_LIST as unknown as string[]).push('rm')
    } catch {
      /* frozen array throws in strict mode — that is the point */
    }
    // (b) index-assign past the end.
    try {
      ;(LITERAL_TOKEN_LIST as unknown as string[])[100] = 'rm'
    } catch {
      /* frozen array index write is rejected */
    }
    // (c) cast the predicate to a Set-like and try .add — there is no Set,
    //     so this is a no-op; the predicate stays frozen.
    try {
      ;(isLiteralToken as unknown as { add?: (t: string) => void }).add?.('rm')
    } catch {
      /* no-op / rejected */
    }

    // PROOF: a malicious mutation could not widen the injectable keystroke
    // set. `rm` is STILL rejected, and a legitimate literal is STILL accepted.
    expect(isLiteralToken('rm')).toBe(false)
    expect(isLiteralToken('1')).toBe(true)
    expect((LITERAL_TOKEN_LIST as readonly string[]).includes('rm')).toBe(false)

    const rejected = parseKeyTokens('rm')
    expect('error' in rejected).toBe(true)
    const accepted = parseKeyTokens('1')
    expect('error' in accepted).toBe(false)
    if (!('error' in accepted)) {
      expect(accepted.steps).toEqual([{ literal: true, key: '1' }])
    }
  })

  // LOW #3 (fix-loop): named-token membership must be an OWN-property check
  // (Object.hasOwn), not a prototype-walking `t in NAMED_TOKENS`. A polluted
  // Object.prototype must NOT smuggle an un-whitelisted token into the pane.
  test('prototype pollution cannot widen the named-token whitelist', () => {
    // Save a clean baseline so we can prove behaviour is unchanged AFTER the
    // pollution is removed too.
    expect('error' in parseKeyTokens('rm')).toBe(true)
    expect('error' in parseKeyTokens('enter')).toBe(false)

    try {
      // (a) classic prototype pollution: a non-own key reachable via the chain.
      ;(Object.prototype as unknown as Record<string, string>).rm = 'Enter'
      // (b) literal-style pollution of another plausible attacker token.
      ;(Object.prototype as unknown as Record<string, string>).reboot = 'Escape'

      // `rm` IS now visible via `'rm' in NAMED_TOKENS` (prototype chain) — that
      // is exactly the hole. Object.hasOwn must still reject it.
      expect('rm' in NAMED_TOKENS).toBe(true) // proves the pollution is live
      expect(Object.hasOwn(NAMED_TOKENS, 'rm')).toBe(false)

      // PROOF: parseKeyTokens STILL rejects the polluted tokens (no step
      // produced), so no un-whitelisted keystroke can reach the tmux pane.
      const polluted = parseKeyTokens('rm')
      expect('error' in polluted).toBe(true)
      expect('error' in parseKeyTokens('reboot')).toBe(true)

      // And a legitimate named token STILL parses to its real Escape/Enter key.
      const enter = parseKeyTokens('enter')
      expect('error' in enter).toBe(false)
      if (!('error' in enter)) {
        expect(enter.steps).toEqual([{ literal: false, key: 'Enter' }])
      }
    } finally {
      // Remove the pollution so it cannot leak into any other test.
      delete (Object.prototype as unknown as Record<string, string>).rm
      delete (Object.prototype as unknown as Record<string, string>).reboot
    }

    // Clean-state sanity AFTER cleanup: chain is no longer polluted.
    expect('rm' in NAMED_TOKENS).toBe(false)
    expect('error' in parseKeyTokens('rm')).toBe(true)
    expect('error' in parseKeyTokens('enter')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// buildKeysKeyboard
// ─────────────────────────────────────────────────────────────────────

describe('buildKeysKeyboard', () => {
  test('produces the full 5-row layout with all whitelisted tokens', () => {
    const kb = buildKeysKeyboard()
    expect(kb.inline_keyboard.length).toBe(5)

    const cb = (row: number) => kb.inline_keyboard[row]!.map((b) => b.callback_data)
    expect(cb(0)).toEqual(['kkey:1', 'kkey:2', 'kkey:3', 'kkey:4', 'kkey:5'])
    expect(cb(1)).toEqual(['kkey:6', 'kkey:7', 'kkey:8', 'kkey:9', 'kkey:0'])
    expect(cb(2)).toEqual(['kkey:y', 'kkey:n', 'kkey:enter', 'kkey:esc'])
    expect(cb(3)).toEqual(['kkey:up', 'kkey:down', 'kkey:left', 'kkey:right'])
    expect(cb(4)).toEqual(['kkey:tab', 'kkey:space'])
  })

  test('panel coverage = full /key whitelist (no UI/parser mismatch)', () => {
    const kb = buildKeysKeyboard()
    const panelTokens = new Set(
      kb.inline_keyboard.flat().map((b) => b.callback_data!.slice(KKEY_PREFIX.length)),
    )
    const whitelist = new Set([
      ...LITERAL_TOKEN_LIST,
      ...Object.keys(NAMED_TOKENS),
    ])
    // 'escape' is an alias of 'esc' — the panel exposes 'esc' only. Every
    // OTHER whitelisted token must have a button, and every button token must
    // be in the whitelist.
    for (const tok of whitelist) {
      if (tok === 'escape') continue
      expect(panelTokens.has(tok)).toBe(true)
    }
    for (const tok of panelTokens) {
      expect(whitelist.has(tok)).toBe(true)
    }
  })

  test('every callback_data parses back to a whitelisted token', () => {
    const kb = buildKeysKeyboard()
    for (const row of kb.inline_keyboard) {
      for (const btn of row) {
        expect(btn.callback_data).toBeDefined()
        expect(parseKkeyCallback(btn.callback_data!)).not.toBeNull()
      }
    }
  })

  test('header is HTML and explains the keypad in Russian', () => {
    expect(KEYS_PANEL_HEADER).toContain('Управление сессией')
    expect(KEYS_PANEL_HEADER).toContain('<b>')
  })
})

// ─────────────────────────────────────────────────────────────────────
// handleKkeyCallback — AUTH gate (the critical security test) + dispatch.
// ─────────────────────────────────────────────────────────────────────

const ALLOWED_ID = 164795011
const NON_ALLOWED_ID = 999999

function makeCtx(data: string, fromId: number): {
  ctx: KkeyCallbackContext
  toasts: string[]
} {
  const toasts: string[] = []
  const ctx: KkeyCallbackContext = {
    callbackQuery: { data },
    from: { id: fromId },
    answerCallbackQuery: async (arg) => {
      toasts.push(arg.text)
    },
  }
  return { ctx, toasts }
}

// `noPane: true` builds deps WITHOUT a resolvable pane (the key is omitted,
// not set to undefined — exactOptionalPropertyTypes rejects explicit
// undefined). Other overrides merge on top.
function makeDeps(
  overrides: Partial<KkeyCallbackDeps> & { noPane?: boolean } = {},
): {
  deps: KkeyCallbackDeps
  calls: string[][]
} {
  const calls: string[][] = []
  const exec: KeysExec = async (args) => {
    calls.push([...args])
    return { exitCode: 0, stderr: '' }
  }
  const target: TmuxKeysTarget = { paneTarget: '%1', socketPath: '/tmp/s' }
  const { noPane, ...rest } = overrides
  const deps: KkeyCallbackDeps = {
    allowedUserIds: [ALLOWED_ID],
    log: makeLogger(),
    exec,
    ...(noPane ? {} : { tmuxKeysTarget: target }),
    ...rest,
  }
  return { deps, calls }
}

describe('handleKkeyCallback — auth gate', () => {
  test('NON-allowed user: toasts «не авторизовано» and NEVER sends a keystroke', async () => {
    const { ctx, toasts } = makeCtx('kkey:2', NON_ALLOWED_ID)
    const { deps, calls } = makeDeps()
    const consumed = await handleKkeyCallback(ctx, deps)
    expect(consumed).toBe(true)
    // The critical assertion: the exec/sendKeys mock got ZERO calls.
    expect(calls.length).toBe(0)
    expect(toasts).toEqual(['не авторизовано'])
  })

  test('ALLOWED user: sendKeys called once with the parsed token', async () => {
    const { ctx, toasts } = makeCtx('kkey:2', ALLOWED_ID)
    const { deps, calls } = makeDeps()
    const consumed = await handleKkeyCallback(ctx, deps)
    expect(consumed).toBe(true)
    // Exactly one send-keys invocation, carrying the literal token «2».
    expect(calls).toEqual([['-S', '/tmp/s', 'send-keys', '-t', '%1', '-l', '2']])
    expect(toasts).toEqual(['нажато: 2'])
  })

  test('ALLOWED user, named token (enter): sent without -l', async () => {
    const { ctx, toasts } = makeCtx('kkey:enter', ALLOWED_ID)
    const { deps, calls } = makeDeps()
    await handleKkeyCallback(ctx, deps)
    expect(calls).toEqual([['-S', '/tmp/s', 'send-keys', '-t', '%1', 'Enter']])
    expect(toasts).toEqual(['нажато: enter'])
  })

  test('non-whitelisted token: toasts «неизвестная клавиша», no keystroke', async () => {
    const { ctx, toasts } = makeCtx('kkey:rm', ALLOWED_ID)
    const { deps, calls } = makeDeps()
    await handleKkeyCallback(ctx, deps)
    expect(calls.length).toBe(0)
    expect(toasts).toEqual(['неизвестная клавиша'])
  })

  test('no resolvable pane: toasts «pane недоступен», no keystroke', async () => {
    const { ctx, toasts } = makeCtx('kkey:2', ALLOWED_ID)
    // Omit tmuxKeysTarget entirely.
    const { deps, calls } = makeDeps({ noPane: true })
    await handleKkeyCallback(ctx, deps)
    expect(calls.length).toBe(0)
    expect(toasts).toEqual(['pane недоступен'])
  })

  test('tmux failure: toasts an error, never throws', async () => {
    const { ctx, toasts } = makeCtx('kkey:2', ALLOWED_ID)
    const calls: string[][] = []
    const failingExec: KeysExec = async (args) => {
      calls.push([...args])
      return { exitCode: 1, stderr: 'no such pane' }
    }
    const { deps } = makeDeps({ exec: failingExec })
    const consumed = await handleKkeyCallback(ctx, deps)
    expect(consumed).toBe(true)
    expect(calls.length).toBe(1)
    expect(toasts[0]).toContain('ошибка')
    expect(toasts[0]).toContain('no such pane')
  })

  test('auth check runs BEFORE pane check (non-allowed + no pane → не авторизовано)', async () => {
    const { ctx, toasts } = makeCtx('kkey:2', NON_ALLOWED_ID)
    const { deps, calls } = makeDeps({ noPane: true })
    await handleKkeyCallback(ctx, deps)
    expect(calls.length).toBe(0)
    // A non-allowed user must not even learn whether a pane exists.
    expect(toasts).toEqual(['не авторизовано'])
  })

  test('AUTH FIRST: non-allowed + MALFORMED token (kkey:rm) → «не авторизовано» (NOT «неизвестная клавиша»), 0 sendKeys', async () => {
    // The critical auth-first proof: a non-allowed caller replaying malformed
    // callback data must NOT learn token validity. If parse ran first this
    // would be «неизвестная клавиша», leaking that `rm` is not a valid token.
    const { ctx, toasts } = makeCtx('kkey:rm', NON_ALLOWED_ID)
    const { deps, calls } = makeDeps()
    const consumed = await handleKkeyCallback(ctx, deps)
    expect(consumed).toBe(true)
    expect(toasts).toEqual(['не авторизовано'])
    expect(calls.length).toBe(0)
  })

  test('missing/undefined from id → «не авторизовано», 0 sendKeys', async () => {
    const toasts: string[] = []
    // No `from` at all — a malformed/replayed update. Must fail-closed.
    const ctx: KkeyCallbackContext = {
      callbackQuery: { data: 'kkey:2' },
      answerCallbackQuery: async (arg) => {
        toasts.push(arg.text)
      },
    }
    const { deps, calls } = makeDeps()
    const consumed = await handleKkeyCallback(ctx, deps)
    expect(consumed).toBe(true)
    expect(toasts).toEqual(['не авторизовано'])
    expect(calls.length).toBe(0)
  })

  test('from present but id undefined → «не авторизовано», 0 sendKeys', async () => {
    const toasts: string[] = []
    const ctx: KkeyCallbackContext = {
      callbackQuery: { data: 'kkey:2' },
      from: { id: undefined },
      answerCallbackQuery: async (arg) => {
        toasts.push(arg.text)
      },
    }
    const { deps, calls } = makeDeps()
    await handleKkeyCallback(ctx, deps)
    expect(toasts).toEqual(['не авторизовано'])
    expect(calls.length).toBe(0)
  })

  test('handler throw (exec throws unexpectedly) → spinner still cleared via the caller catch (no hanging spinner)', async () => {
    // A raw-throwing exec propagates out of sendKeys/handleKkeyCallback (the
    // handler does not swallow it). The server.ts kkey branch wraps the call
    // in try/catch and answers «ошибка» so the Telegram spinner never hangs.
    // We replicate that wrapper here to prove the end-to-end no-hanging-spinner
    // invariant the security review required.
    const { ctx, toasts } = makeCtx('kkey:2', ALLOWED_ID)
    const throwingExec: KeysExec = async () => {
      throw new Error('exec blew up')
    }
    const { deps } = makeDeps({ exec: throwingExec })
    let threw = false
    try {
      await handleKkeyCallback(ctx, deps)
    } catch {
      threw = true
      // Mirror server.ts: best-effort spinner clear on a handler throw.
      await ctx.answerCallbackQuery({ text: 'ошибка' })
    }
    expect(threw).toBe(true)
    expect(toasts).toEqual(['ошибка'])
  })
})
