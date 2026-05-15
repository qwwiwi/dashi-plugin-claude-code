// Phase 8 / T6 — MemoryWriter facade.
//
// One instance per plugin process (one agent = one workspace).
// onHook(payload) is the single entry point called from the
// /hooks/agent webhook branch. UserPromptSubmit buffers the prompt
// by chatId; Stop reads the buffer + tail-reads the transcript for
// the assistant text + appends one entry each to recent.md and
// verbose-YYYY-MM-DD.jsonl.
//
// All errors are swallowed — the webhook still returns 200 so Claude
// hooks don't back-pressure on a memory outage. The webhook branch
// wraps onHook() in its own try/catch + log.warn so even an unhandled
// throw here cannot block the HTTP response.

import { join } from 'node:path'

import type { Logger } from '../log.js'
import type { ClaudeHookPayload } from '../schemas.js'
import { appendHotEntry, snippet } from './hot-writer.js'
import { appendVerbose, type VerboseRecord } from './verbose-writer.js'
import { PromptBuffer } from './prompt-buffer.js'
import { readLastAssistantText } from './transcript-reader.js'

export interface MemoryConfig {
  // <agent-workspace> root. recent.md lands at workspace/core/hot/recent.md.
  workspacePath: string
  // Pre-resolved logs dir (T7 derives <workspace_parent>/logs as the
  // default when config.memory.logs_path is unset).
  logsPath: string
  sourceTag: string
  // Human-friendly capitalised name (e.g. 'Silvana', 'Kaelthas').
  agentLabel: string
  maxHotBytes: number
  trimKeepLines: number
  bufferTtlMs: number
  bufferMaxEntries: number
}

export class MemoryWriter {
  private readonly buffer: PromptBuffer

  constructor(
    private readonly cfg: MemoryConfig,
    private readonly log: Logger,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.buffer = new PromptBuffer(cfg.bufferTtlMs, cfg.bufferMaxEntries, now)
  }

  /** Dispatch on hook_event_name. Other hook kinds are no-ops. */
  async onHook(payload: ClaudeHookPayload): Promise<void> {
    if (payload.hook_event_name === 'UserPromptSubmit') {
      this.buffer.set(
        String(payload.chatId),
        typeof payload.prompt === 'string' ? payload.prompt : '',
        payload.session_id ?? null,
      )
      return
    }
    if (payload.hook_event_name === 'Stop') {
      await this.onStop(payload)
    }
  }

  private async onStop(
    payload: ClaudeHookPayload & { hook_event_name: 'Stop' },
  ): Promise<void> {
    const chatId = String(payload.chatId)
    const buffered = this.buffer.take(chatId)
    const userText = buffered?.prompt ?? '(no prompt)'
    if (!buffered) {
      // Stop without a prior UserPromptSubmit can happen on resume/clear
      // hooks, restart races, or when the buffer expired. We never drop
      // the entry — '(no prompt)' is the gateway.py parity behaviour.
      this.log.warn('[memory] Stop without buffered prompt', {
        chatId,
        session_id: payload.session_id,
      })
    }

    let agentText = ''
    if (typeof payload.transcript_path === 'string' && payload.transcript_path) {
      const t = await readLastAssistantText(payload.transcript_path)
      if (t) agentText = t
    }

    const ts = formatLocalTs(new Date(this.now()))
    const hotPath = join(this.cfg.workspacePath, 'core', 'hot', 'recent.md')
    await appendHotEntry({
      path: hotPath,
      ts,
      agentLabel: this.cfg.agentLabel,
      sourceTag: this.cfg.sourceTag,
      userSnippet: snippet(userText),
      // gateway.py:1950 uses '(inline)' as the agent fallback when no
      // response text was captured. We mirror that to keep recent.md
      // diff-able between the two implementations.
      agentSnippet: snippet(agentText || '(inline)'),
      maxBytes: this.cfg.maxHotBytes,
      trimKeepLines: this.cfg.trimKeepLines,
    })

    const record: VerboseRecord = {
      ts: new Date(this.now()).toISOString(),
      sid: payload.session_id ?? null,
      ch: this.cfg.sourceTag,
      user: userText,
      agent: agentText,
      dur_ms: buffered ? this.now() - buffered.ts : 0,
      status: 'completed',
    }
    await appendVerbose({ logsDir: this.cfg.logsPath, record })
  }
}

/**
 * Format a Date as 'YYYY-MM-DD HH:MM' in local time. Matches Python's
 * `time.strftime("%Y-%m-%d %H:%M")` in gateway.py:1948.
 */
function formatLocalTs(d: Date): string {
  const p = (n: number): string => n.toString().padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  )
}
