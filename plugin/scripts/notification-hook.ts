#!/usr/bin/env bun
// notification-hook.ts — Claude Code Notification hook → dashi-channel webhook.
//
// Claude Code fires a `Notification` hook when the CLI raises a native
// notification the operator would normally read in the terminal (permission
// prompts under permission-mode=default, idle_prompt after 60s of inactivity,
// elicitation_dialog from MCP servers asking for input, auth_success on
// completed OAuth flows). Under `--permission-mode bypassPermissions` most
// permission prompts are skipped by the PreToolUse permission-gate, but
// idle/elicitation/auth notifications still surface here and would otherwise
// vanish into the tmux pane the operator never opens.
//
// This hook forwards the `message` field to the plugin's `/hooks/notification`
// endpoint, which formats it as a Telegram message («⚠️ <agent> ждёт: <body>»)
// so the operator sees it in the same chat they already use.
//
// Hard invariants (same as post-hook.ts):
//   * Exit 0 in ALL paths. A Notification hook must never gate the CLI.
//   * Stdout stays empty (Claude treats hook stdout as additional context).
//   * Stderr lines are redacted, one short line max.
//
// Env:
//   TELEGRAM_WEBHOOK_URL     e.g. http://127.0.0.1:8092/hooks/notification
//   TELEGRAM_WEBHOOK_TOKEN   bearer token configured on the plugin
//   TELEGRAM_HOOK_CHAT_ID    target Telegram chat id
//   TELEGRAM_HOOK_AGENT_ID   optional agent id (used for the label)

export interface NotificationRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export interface BuildNotificationRequestInput {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly hook: Record<string, unknown>
}

export interface BuildNotificationRequestError {
  readonly kind: 'error'
  readonly reason: string
}

export type BuildNotificationRequestResult =
  | NotificationRequest
  | BuildNotificationRequestError

/**
 * Pure builder. Returns a request blueprint or a structured error — never
 * throws. Payload only contains fields we forward on: chat_id, agent_id,
 * session_id, message. We deliberately drop transcript_path and cwd — they
 * are noise for the operator and could leak host layout in the fallback log.
 */
export function buildNotificationRequest(
  input: BuildNotificationRequestInput,
): BuildNotificationRequestResult {
  const url = input.env.TELEGRAM_WEBHOOK_URL
  const token = input.env.TELEGRAM_WEBHOOK_TOKEN
  const chatId = input.env.TELEGRAM_HOOK_CHAT_ID
  const agentId = input.env.TELEGRAM_HOOK_AGENT_ID

  if (!url) return { kind: 'error', reason: 'missing TELEGRAM_WEBHOOK_URL' }
  if (!token) return { kind: 'error', reason: 'missing TELEGRAM_WEBHOOK_TOKEN' }
  if (!chatId) return { kind: 'error', reason: 'missing TELEGRAM_HOOK_CHAT_ID' }

  if (input.hook.hook_event_name !== 'Notification') {
    return { kind: 'error', reason: 'hook payload is not Notification' }
  }
  const message = input.hook.message
  if (typeof message !== 'string' || message.length === 0) {
    return { kind: 'error', reason: 'Notification payload missing message' }
  }
  const sessionId = typeof input.hook.session_id === 'string' ? input.hook.session_id : ''

  const body = {
    chat_id: chatId,
    agent_id: agentId ?? '',
    session_id: sessionId,
    message,
  }

  return {
    url,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  }
}

interface BunGlobal {
  readonly stdin?: { readonly text?: () => Promise<string> }
}

async function readStdin(): Promise<string> {
  try {
    const bun = (globalThis as { Bun?: BunGlobal }).Bun
    const fn = bun?.stdin?.text
    if (typeof fn === 'function') return await fn.call(bun?.stdin)
  } catch {
    /* fall through */
  }
  return await new Promise<string>((resolve) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', () => resolve(''))
  })
}

function warn(reason: string): void {
  const safe = reason.length > 80 ? `${reason.slice(0, 77)}...` : reason
  process.stderr.write(`notification-hook: ${safe}\n`)
}

async function main(): Promise<void> {
  let raw = ''
  try {
    raw = await readStdin()
  } catch {
    warn('stdin read failed')
    return
  }
  if (raw.trim().length === 0) return

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

  const req = buildNotificationRequest({
    env: process.env,
    hook: parsed as Record<string, unknown>,
  })
  if ('kind' in req && req.kind === 'error') {
    warn(req.reason)
    return
  }

  const request = req as NotificationRequest
  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: { ...request.headers },
      body: request.body,
    })
    if (!response.ok) warn(`webhook responded ${response.status}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const redacted = msg.replace(/Bearer\s+\S+/gi, 'Bearer ***')
    warn(`webhook fetch failed: ${redacted}`)
  }
}

const isMainModule = (() => {
  try {
    const arg = process.argv[1] ?? ''
    return arg.endsWith('notification-hook.ts') || arg.endsWith('notification-hook.js')
  } catch {
    return false
  }
})()

if (isMainModule) {
  await main().catch((err) => {
    warn(err instanceof Error ? err.message : 'unknown error')
  })
}
