// End-to-end tests for the multichat Stop → outbox bridge hook
// (src/chats/hooks/stop-to-outbox.py).
//
// The hook is the interactive-mode analog of capturing the headless
// `result` event: on turn-end it extracts the latest assistant text from
// the per-chat `claude` session transcript and writes an OutboxMessage
// JSON the router drains to Telegram. We exercise the real python3 hook
// by spawning it with a fixture transcript and a temp MULTICHAT_STATE_DIR,
// then assert on the file(s) that land in the router's outbox path
// `{MULTICHAT_STATE_DIR}/chats/{CHAT_ID}/outbox/`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const HOOK = join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'chats',
  'hooks',
  'stop-to-outbox.py',
)

const CHAT_ID = '164795011'

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

let stateDir: string

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'stop-to-outbox-'))
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

// Build a JSONL transcript line for an assistant message with the given
// content blocks.
function assistantLine(blocks: Array<Record<string, unknown>>): string {
  return JSON.stringify({ message: { role: 'assistant', content: blocks } })
}

function userLine(text: string): string {
  return JSON.stringify({
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
}

function writeTranscript(lines: string[]): string {
  const p = join(stateDir, 'transcript.jsonl')
  writeFileSync(p, lines.join('\n') + '\n', 'utf8')
  return p
}

function run(
  env: Record<string, string>,
  stdinPayload: Record<string, unknown>,
): RunResult {
  const r = spawnSync('python3', [HOOK], {
    input: JSON.stringify(stdinPayload),
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
  })
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  }
}

function outboxDir(): string {
  return join(stateDir, 'chats', CHAT_ID, 'outbox')
}

// List only the `.json` outbox files the router would consume (ignore
// processing/ etc. subdirs and any .tmp).
function listOutboxJson(): string[] {
  try {
    return readdirSync(outboxDir()).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
}

function readOutboxPayload(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(outboxDir(), name), 'utf8'))
}

describe('stop-to-outbox.py — extraction', () => {
  test('extracts latest assistant text and writes one outbox .json', () => {
    const transcript = writeTranscript([
      userLine('привет'),
      assistantLine([{ type: 'text', text: 'old answer' }]),
      userLine('второй вопрос'),
      assistantLine([{ type: 'text', text: 'final answer' }]),
    ])
    const r = run(
      { CHAT_ID, MULTICHAT_STATE_DIR: stateDir },
      { transcript_path: transcript, session_id: 's1' },
    )
    expect(r.code).toBe(0)
    const files = listOutboxJson()
    expect(files.length).toBe(1)
    const payload = readOutboxPayload(files[0]!)
    expect(payload.text).toBe('final answer')
    expect(payload.chat_id).toBe(CHAT_ID)
    expect(payload.format).toBe('text')
    expect(typeof payload.timestamp).toBe('string')
    expect((payload.timestamp as string).length).toBeGreaterThan(0)
  })

  test('joins multiple text blocks in one assistant message with newline', () => {
    const transcript = writeTranscript([
      assistantLine([
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ]),
    ])
    const r = run(
      { CHAT_ID, MULTICHAT_STATE_DIR: stateDir },
      { transcript_path: transcript, session_id: 's1' },
    )
    expect(r.code).toBe(0)
    const files = listOutboxJson()
    expect(files.length).toBe(1)
    expect(readOutboxPayload(files[0]!).text).toBe('line one\nline two')
  })

  test('delivers current-turn text even when the turn ENDS on a tool_use', () => {
    // Production bug (2026-05-28): the agent answered with text, then ran a
    // tool (Write/gbrain/Bash) as the LAST action of the same turn. The old
    // "most-recent message is tool-only -> None" rule dropped the answer the
    // turn already produced, so the group chat never received the reply.
    // The reply text belongs to the current turn (after the last real user
    // prompt) so it MUST be delivered regardless of a trailing tool_use.
    const transcript = writeTranscript([
      userLine('упакуй задачу в md'),
      assistantLine([{ type: 'text', text: 'Файл готов, держи.' }]),
      assistantLine([
        { type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: '/tmp/x.md' } },
      ]),
      JSON.stringify({
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }],
        },
      }),
      assistantLine([
        { type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'ls' } },
      ]),
    ])
    const r = run(
      { CHAT_ID, MULTICHAT_STATE_DIR: stateDir },
      { transcript_path: transcript, session_id: 's1' },
    )
    expect(r.code).toBe(0)
    const files = listOutboxJson()
    expect(files.length).toBe(1)
    expect(readOutboxPayload(files[0]!).text).toBe('Файл готов, держи.')
  })

  test('does NOT resurface text from BEFORE the current user prompt', () => {
    // Stale-resend guard (the original concern): text answered in a previous
    // turn must not leak into the current turn's delivery. The current turn
    // (after "новый вопрос") is tool-only, so nothing is delivered.
    const transcript = writeTranscript([
      userLine('старый вопрос'),
      assistantLine([{ type: 'text', text: 'старый ответ' }]),
      userLine('новый вопрос'),
      assistantLine([
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
      ]),
    ])
    const r = run(
      { CHAT_ID, MULTICHAT_STATE_DIR: stateDir },
      { transcript_path: transcript, session_id: 's1' },
    )
    expect(r.code).toBe(0)
    expect(listOutboxJson().length).toBe(0)
  })

  test('a media-only user prompt is a turn boundary (no stale resend)', () => {
    // Codex review [medium]: a prompt whose content is media-only (no text
    // block) must still stop the backward walk, so a previous turn's answer is
    // never resurfaced when the current (media-prompt) turn is tool-only.
    const transcript = writeTranscript([
      userLine('старый вопрос'),
      assistantLine([{ type: 'text', text: 'старый ответ' }]),
      JSON.stringify({
        message: {
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', data: 'AAAA' } }],
        },
      }),
      assistantLine([
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
      ]),
    ])
    const r = run(
      { CHAT_ID, MULTICHAT_STATE_DIR: stateDir },
      { transcript_path: transcript, session_id: 's1' },
    )
    expect(r.code).toBe(0)
    expect(listOutboxJson().length).toBe(0)
  })

  test('pure tool-only turn with no text -> no delivery', () => {
    const transcript = writeTranscript([
      userLine('запусти ls'),
      assistantLine([
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
      ]),
    ])
    const r = run(
      { CHAT_ID, MULTICHAT_STATE_DIR: stateDir },
      { transcript_path: transcript, session_id: 's1' },
    )
    expect(r.code).toBe(0)
    expect(listOutboxJson().length).toBe(0)
  })

  test('delivers the final text that FOLLOWS a tool_use within the turn', () => {
    // tool_use earlier in the turn, then the final text reply — the most
    // recent assistant message has text, so it is delivered.
    const transcript = writeTranscript([
      assistantLine([
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
      ]),
      JSON.stringify({
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }],
        },
      }),
      assistantLine([{ type: 'text', text: 'final answer' }]),
    ])
    const r = run(
      { CHAT_ID, MULTICHAT_STATE_DIR: stateDir },
      { transcript_path: transcript, session_id: 's1' },
    )
    expect(r.code).toBe(0)
    const files = listOutboxJson()
    expect(files.length).toBe(1)
    expect(readOutboxPayload(files[0]!).text).toBe('final answer')
  })

  test('tail-reads past the window: drops truncated leading line, still extracts', () => {
    // A leading assistant line larger than TAIL_BYTES (1 MiB) forces the tail
    // read to start mid-file (start > 0), so its first in-window line is a
    // truncated JSON fragment that must be dropped without aborting extraction
    // of the final line.
    const huge = 'x'.repeat(1200 * 1024)
    const transcript = writeTranscript([
      assistantLine([{ type: 'text', text: huge }]),
      assistantLine([{ type: 'text', text: 'tail answer' }]),
    ])
    const r = run(
      { CHAT_ID, MULTICHAT_STATE_DIR: stateDir },
      { transcript_path: transcript, session_id: 's1' },
    )
    expect(r.code).toBe(0)
    const files = listOutboxJson()
    expect(files.length).toBe(1)
    expect(readOutboxPayload(files[0]!).text).toBe('tail answer')
  })

  test('ignores invalid JSON lines and still extracts valid assistant text', () => {
    const transcript = writeTranscript([
      'this is not json',
      assistantLine([{ type: 'text', text: 'good answer' }]),
      '{ broken json',
    ])
    const r = run(
      { CHAT_ID, MULTICHAT_STATE_DIR: stateDir },
      { transcript_path: transcript, session_id: 's1' },
    )
    expect(r.code).toBe(0)
    const files = listOutboxJson()
    expect(files.length).toBe(1)
    expect(readOutboxPayload(files[0]!).text).toBe('good answer')
  })

  test('chat_id comes from env, NOT from a chat_id field in the transcript', () => {
    const transcript = writeTranscript([
      JSON.stringify({
        chat_id: '-999999999',
        message: {
          role: 'assistant',
          chat_id: '-999999999',
          content: [{ type: 'text', text: 'answer', chat_id: '-999999999' }],
        },
      }),
    ])
    const r = run(
      { CHAT_ID, MULTICHAT_STATE_DIR: stateDir },
      { transcript_path: transcript, session_id: 's1' },
    )
    expect(r.code).toBe(0)
    const files = listOutboxJson()
    expect(files.length).toBe(1)
    expect(readOutboxPayload(files[0]!).chat_id).toBe(CHAT_ID)
  })

  test('only a .json file lands in outbox (no leftover .tmp)', () => {
    const transcript = writeTranscript([
      assistantLine([{ type: 'text', text: 'answer' }]),
    ])
    run(
      { CHAT_ID, MULTICHAT_STATE_DIR: stateDir },
      { transcript_path: transcript, session_id: 's1' },
    )
    const all = readdirSync(outboxDir())
    expect(all.every((f) => f.endsWith('.json'))).toBe(true)
    expect(all.some((f) => f.endsWith('.tmp'))).toBe(false)
    expect(all.filter((f) => f.endsWith('.json')).length).toBe(1)
  })
})

describe('stop-to-outbox.py — diagnostic log (STOP_OUTBOX_DEBUG)', () => {
  function debugLogPath(): string {
    return join(stateDir, 'chats', CHAT_ID, '.hook-state', 'stop-outbox-debug.log')
  }

  test('off by default: no debug log written', () => {
    const transcript = writeTranscript([
      userLine('вопрос'),
      assistantLine([{ type: 'text', text: 'ответ' }]),
    ])
    run(
      { CHAT_ID, MULTICHAT_STATE_DIR: stateDir },
      { transcript_path: transcript, session_id: 's1' },
    )
    expect(() => readFileSync(debugLogPath(), 'utf8')).toThrow()
  })

  test('on: records fired + written for a delivered turn', () => {
    const transcript = writeTranscript([
      userLine('вопрос'),
      assistantLine([{ type: 'text', text: 'ответ' }]),
    ])
    run(
      { CHAT_ID, MULTICHAT_STATE_DIR: stateDir, STOP_OUTBOX_DEBUG: '1' },
      { transcript_path: transcript, session_id: 's1' },
    )
    const lines = readFileSync(debugLogPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const decisions = lines.map((l) => l.decision)
    expect(decisions).toContain('fired')
    expect(decisions).toContain('written')
  })

  test('on: records no_text for a tool-only turn', () => {
    const transcript = writeTranscript([
      userLine('запусти ls'),
      assistantLine([
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
      ]),
    ])
    run(
      { CHAT_ID, MULTICHAT_STATE_DIR: stateDir, STOP_OUTBOX_DEBUG: '1' },
      { transcript_path: transcript, session_id: 's1' },
    )
    const decisions = readFileSync(debugLogPath(), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l).decision)
    expect(decisions).toContain('fired')
    expect(decisions).toContain('no_text')
    expect(listOutboxJson().length).toBe(0)
  })
})

describe('stop-to-outbox.py — no-write paths (fail-safe, exit 0)', () => {
  test('blank/whitespace-only assistant text -> no outbox file', () => {
    const transcript = writeTranscript([
      assistantLine([{ type: 'text', text: '   \n\t  ' }]),
    ])
    const r = run(
      { CHAT_ID, MULTICHAT_STATE_DIR: stateDir },
      { transcript_path: transcript, session_id: 's1' },
    )
    expect(r.code).toBe(0)
    expect(listOutboxJson().length).toBe(0)
  })

  test('missing transcript file -> no file, exit 0', () => {
    const r = run(
      { CHAT_ID, MULTICHAT_STATE_DIR: stateDir },
      { transcript_path: join(stateDir, 'does-not-exist.jsonl'), session_id: 's1' },
    )
    expect(r.code).toBe(0)
    expect(listOutboxJson().length).toBe(0)
  })

  test('missing/empty transcript_path in payload -> no file, exit 0', () => {
    const rMissing = run(
      { CHAT_ID, MULTICHAT_STATE_DIR: stateDir },
      { session_id: 's1' },
    )
    expect(rMissing.code).toBe(0)
    expect(listOutboxJson().length).toBe(0)

    const rEmpty = run(
      { CHAT_ID, MULTICHAT_STATE_DIR: stateDir },
      { transcript_path: '', session_id: 's1' },
    )
    expect(rEmpty.code).toBe(0)
    expect(listOutboxJson().length).toBe(0)
  })

  test('missing CHAT_ID -> no file, exit 0', () => {
    const transcript = writeTranscript([
      assistantLine([{ type: 'text', text: 'answer' }]),
    ])
    const r = run(
      { MULTICHAT_STATE_DIR: stateDir },
      { transcript_path: transcript, session_id: 's1' },
    )
    expect(r.code).toBe(0)
    // CHAT_ID unset => no chat dir created at all.
    expect(listOutboxJson().length).toBe(0)
  })

  test('missing MULTICHAT_STATE_DIR -> no file, exit 0', () => {
    const transcript = writeTranscript([
      assistantLine([{ type: 'text', text: 'answer' }]),
    ])
    // Strip any inherited MULTICHAT_STATE_DIR so the env var is truly absent.
    const r = run(
      { CHAT_ID, MULTICHAT_STATE_DIR: '' },
      { transcript_path: transcript, session_id: 's1' },
    )
    expect(r.code).toBe(0)
    expect(listOutboxJson().length).toBe(0)
  })

  test('malformed CHAT_ID (path traversal) -> no write, exit 0', () => {
    const transcript = writeTranscript([
      assistantLine([{ type: 'text', text: 'answer' }]),
    ])
    for (const bad of ['../../etc', 'abc', '12/34', '..']) {
      const r = run(
        { CHAT_ID: bad, MULTICHAT_STATE_DIR: stateDir },
        { transcript_path: transcript, session_id: 's1' },
      )
      expect(r.code).toBe(0)
    }
    // No chat dir for the legit CHAT_ID, and no traversal artifacts.
    expect(listOutboxJson().length).toBe(0)
  })
})

describe('stop-to-outbox.py — dedupe on repeated Stop', () => {
  // A transcript line carrying a uuid (Claude Code emits one per entry).
  function assistantLineWithUuid(
    uuid: string,
    blocks: Array<Record<string, unknown>>,
  ): string {
    return JSON.stringify({ uuid, message: { role: 'assistant', content: blocks } })
  }

  test('identical text in two DIFFERENT turns (distinct uuid) -> both delivered', () => {
    // Regression guard: dedupe must key on the turn (uuid), not the text —
    // otherwise a legitimate repeated "Готово." would be silently dropped.
    const transcriptPath = join(stateDir, 'transcript.jsonl')
    writeFileSync(
      transcriptPath,
      assistantLineWithUuid('u1', [{ type: 'text', text: 'Готово.' }]) + '\n',
      'utf8',
    )
    const payload = { transcript_path: transcriptPath, session_id: 's1' }

    const r1 = run({ CHAT_ID, MULTICHAT_STATE_DIR: stateDir }, payload)
    expect(r1.code).toBe(0)
    expect(listOutboxJson().length).toBe(1)

    // New turn, SAME text, DIFFERENT uuid -> must deliver again.
    writeFileSync(
      transcriptPath,
      assistantLineWithUuid('u1', [{ type: 'text', text: 'Готово.' }]) +
        '\n' +
        assistantLineWithUuid('u2', [{ type: 'text', text: 'Готово.' }]) +
        '\n',
      'utf8',
    )
    const r2 = run({ CHAT_ID, MULTICHAT_STATE_DIR: stateDir }, payload)
    expect(r2.code).toBe(0)
    expect(listOutboxJson().length).toBe(2)
  })

  test('same turn (same uuid) re-fires -> deduped to one file', () => {
    const transcriptPath = join(stateDir, 'transcript.jsonl')
    writeFileSync(
      transcriptPath,
      assistantLineWithUuid('u1', [{ type: 'text', text: 'answer' }]) + '\n',
      'utf8',
    )
    const payload = { transcript_path: transcriptPath, session_id: 's1' }
    run({ CHAT_ID, MULTICHAT_STATE_DIR: stateDir }, payload)
    run({ CHAT_ID, MULTICHAT_STATE_DIR: stateDir }, payload)
    expect(listOutboxJson().length).toBe(1)
  })

  test('identical payload twice -> exactly one file; changed text -> a second', () => {
    const transcriptPath = join(stateDir, 'transcript.jsonl')
    writeFileSync(
      transcriptPath,
      assistantLine([{ type: 'text', text: 'first answer' }]) + '\n',
      'utf8',
    )
    const payload = { transcript_path: transcriptPath, session_id: 's1' }

    const r1 = run({ CHAT_ID, MULTICHAT_STATE_DIR: stateDir }, payload)
    expect(r1.code).toBe(0)
    expect(listOutboxJson().length).toBe(1)

    // Second identical Stop fire: deduped, still one file.
    const r2 = run({ CHAT_ID, MULTICHAT_STATE_DIR: stateDir }, payload)
    expect(r2.code).toBe(0)
    expect(listOutboxJson().length).toBe(1)

    // Append a newer assistant turn; same session/transcript path but the
    // extracted final text changed -> hash differs -> a second file appears.
    writeFileSync(
      transcriptPath,
      assistantLine([{ type: 'text', text: 'first answer' }]) +
        '\n' +
        assistantLine([{ type: 'text', text: 'second answer' }]) +
        '\n',
      'utf8',
    )
    const r3 = run({ CHAT_ID, MULTICHAT_STATE_DIR: stateDir }, payload)
    expect(r3.code).toBe(0)
    const files = listOutboxJson()
    expect(files.length).toBe(2)
    const texts = files.map((f) => readOutboxPayload(f).text).sort()
    expect(texts).toEqual(['first answer', 'second answer'])
  })
})
