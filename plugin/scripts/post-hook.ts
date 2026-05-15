#!/usr/bin/env bun
// post-hook.ts — Claude Code hook → dashi-channel webhook proxy.
//
// Reads a Claude hook JSON envelope from stdin and POSTs it (with the chat
// id and bearer token from env) to the plugin's `/hooks/agent` endpoint.
//
// Hard invariants:
//   * Exit code 0 in ALL paths. Claude blocks the model if a hook exits non-
//     zero; visibility is best-effort, must never gate the agent.
//   * Stdout stays empty. Hooks that emit stdout get treated as additional
//     model context, so a `UserPromptSubmit` hook printing anything would
//     leak it back into the conversation.
//   * Stderr lines are redacted: never the bearer token, never the prompt
//     body, never the full tool input. One short message on failure paths
//     is the maximum.
//
// The helper does not write or read any files; configuration lives in env:
//   TELEGRAM_WEBHOOK_URL     e.g. http://127.0.0.1:8089/hooks/agent
//   TELEGRAM_WEBHOOK_TOKEN   bearer token configured on the plugin
//   TELEGRAM_HOOK_CHAT_ID    target Telegram chat id (string or numeric)
//   TELEGRAM_HOOK_AGENT_ID   optional agent id (defaults to no agentId)

export interface HookRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export interface BuildHookRequestInput {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly hook: Record<string, unknown>
}

export interface BuildHookRequestError {
  readonly kind: 'error'
  readonly reason: string
}

export type BuildHookRequestResult = HookRequest | BuildHookRequestError

/**
 * Pure builder so unit tests can verify the wire shape without a network.
 * Returns either a request blueprint or a structured `error` shape — never
 * throws. Callers are expected to log the redacted `reason` and exit 0.
 */
export function buildHookRequest(input: BuildHookRequestInput): BuildHookRequestResult {
  const url = input.env.TELEGRAM_WEBHOOK_URL
  const token = input.env.TELEGRAM_WEBHOOK_TOKEN
  const chatId = input.env.TELEGRAM_HOOK_CHAT_ID
  const agentId = input.env.TELEGRAM_HOOK_AGENT_ID

  if (!url) return { kind: 'error', reason: 'missing TELEGRAM_WEBHOOK_URL' }
  if (!token) return { kind: 'error', reason: 'missing TELEGRAM_WEBHOOK_TOKEN' }
  if (!chatId) return { kind: 'error', reason: 'missing TELEGRAM_HOOK_CHAT_ID' }

  // Validate the hook payload looks like a Claude hook envelope by checking
  // for at least `hook_event_name` and `session_id`. We don't re-validate
  // the full schema here — the server is the boundary.
  if (typeof input.hook.hook_event_name !== 'string') {
    return { kind: 'error', reason: 'hook payload missing hook_event_name' }
  }

  const merged: Record<string, unknown> = {
    chatId,
    ...(agentId ? { agentId } : {}),
    ...input.hook,
  }

  return {
    url,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(merged),
  }
}

// ─────────────────────────────────────────────────────────────────────
// Stdin reader. Bun supports `Bun.stdin.text()`, but we also accept the
// no-content case (some Claude hooks fire without stdin in dev).
// ─────────────────────────────────────────────────────────────────────

interface BunGlobal {
  readonly stdin?: { readonly text?: () => Promise<string> }
}

async function readStdin(): Promise<string> {
  try {
    // Bun exposes `Bun.stdin.text()`; the global type is opaque under Node
    // so we narrow through a local interface instead of an `unknown` cast
    // chain (review L1).
    const bun = (globalThis as { Bun?: BunGlobal }).Bun
    const fn = bun?.stdin?.text
    if (typeof fn === 'function') return await fn.call(bun?.stdin)
  } catch {
    /* fall through to Node-style fallback */
  }
  // Fallback for non-Bun runtimes (used in tests).
  return await new Promise<string>((resolve) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', () => resolve(''))
  })
}

// Short, secret-free warning line. Anything we emit MUST be redacted —
// never include bearer tokens, prompt body, tool_input keys, etc.
function warn(reason: string): void {
  // 80 char cap so a verbose error string can't tail-leak through a long
  // line. Stderr only — stdout is intentionally untouched.
  const safe = reason.length > 80 ? `${reason.slice(0, 77)}...` : reason
  process.stderr.write(`telegram-hook: ${safe}\n`)
}

async function main(): Promise<void> {
  let raw = ''
  try {
    raw = await readStdin()
  } catch {
    warn('stdin read failed')
    return
  }
  if (raw.trim().length === 0) {
    // No payload — nothing to forward, exit cleanly.
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    warn('stdin not valid JSON')
    return
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warn('stdin payload not an object')
    return
  }

  const req = buildHookRequest({
    env: process.env,
    hook: parsed as Record<string, unknown>,
  })
  if ('kind' in req && req.kind === 'error') {
    warn(req.reason)
    return
  }

  // Narrow to HookRequest after the discriminator check.
  const request = req as HookRequest
  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: { ...request.headers },
      body: request.body,
    })
    if (!response.ok) {
      // Don't log response body — could contain server-emitted Zod issues
      // that quote payload fields back.
      warn(`webhook responded ${response.status}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // grep out anything that looks like a token before logging.
    const redacted = msg.replace(/Bearer\s+\S+/gi, 'Bearer ***')
    warn(`webhook fetch failed: ${redacted}`)
  }
}

// Bun executes top-level await; we wrap so the script can also be imported
// by tests without running main(). Only run when executed directly.
const isMainModule = (() => {
  try {
    // Bun + Node both expose `import.meta.url` and (in CJS-compat layer)
    // `require.main === module`. We use a robust check: argv[1] basename
    // matches this file.
    const arg = process.argv[1] ?? ''
    return arg.endsWith('post-hook.ts') || arg.endsWith('post-hook.js')
  } catch {
    return false
  }
})()

if (isMainModule) {
  // Top-level await is supported in Bun; we explicitly catch so any unawaited
  // rejection still exits 0.
  await main().catch((err) => {
    warn(err instanceof Error ? err.message : 'unknown error')
  })
}
