# dashi-plugin-claude-code

> **Read in your language:** English (this page) · [**Русская версия →**](README.ru.md)

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun_1.3+-f9f1e1.svg)](https://bun.sh)
[![Language: TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![Claude Code](https://img.shields.io/badge/Claude_Code-v2.1.80+-d97757.svg)](https://code.claude.com/docs/en/channels-reference)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#license-and-author)

**A Telegram → Claude Code channel plugin.** It turns an ordinary, live Claude Code session into a Telegram agent: the bot listens to one or more chats, replies inside the same session, and keeps all the work within your regular Anthropic Max subscription — with no separate SDK billing.

It replaces the deprecated `claude -p` gateway pattern (a Python daemon that spawned a fresh headless session for every message). Cutover deadline — **2026-06-15** (Anthropic is splitting billing; details in section [13](#13-why-migrate--the-2026-06-15-deadline)).

> **Migrating from the old gateway? There is now a doctor.** The read-only [`doctor-dashi-plugin`](skills/doctor-dashi-plugin/SKILL.md) skill diagnoses the whole cutover — workspace placement, hooks, MCP comms config, allowlist, and live-session health — and encodes every mistake we already paid for so you don't repeat them. Run `bun skills/doctor-dashi-plugin/scripts/doctor.ts --help`.

![Architecture — Telegram ↔ plugin ↔ Claude Code session](docs/assets/architecture-hero.svg)

One plugin process = one Telegram bot = one agent. By default it serves **a single DM chat** (legacy single-session mode). With `multichat.enabled` turned on, the same bot fans incoming messages out across several per-chat tmux sessions of one identity — see section [3](#3-multichat--how-it-works-and-why).

> **Status:** under active development. Latest merged PR — **#34** (the Stop hook writes the multichat reply to the outbox). Poller auto-reconnect — **#30**. Full list: `gh pr list --state merged --limit 15`. CI: `bun test` + `bun run typecheck` must pass clean before merge.

---

## Table of contents

1. [How the plugin works and why you need it](#1-how-the-plugin-works-and-why-you-need-it)
2. [Personal session + channel tmux, and how to add your user_id](#2-personal-session--channel-tmux-and-how-to-add-your-user_id)
3. [Multichat — how it works and why](#3-multichat--how-it-works-and-why)
4. [Plugin hooks](#4-plugin-hooks)
5. [Interactive commands: permission prompts (sudo) and AskUserQuestion](#5-interactive-commands-permission-prompts-sudo-and-askuserquestion)
6. [Terminal mirror — how it works and why](#6-terminal-mirror--how-it-works-and-why)
7. [Media, audio, and voice-message transcription](#7-media-audio-and-voice-message-transcription)
8. [Session auto-restart — so the link never drops](#8-session-auto-restart--so-the-link-never-drops)
9. [HTML filtering from terminal to Telegram](#9-html-filtering-from-terminal-to-telegram)
10. [Security — so data never leaks](#10-security--so-data-never-leaks)
11. [Telegram API rate limits](#11-telegram-api-rate-limits)
12. [Quick start and documentation](#12-quick-start-and-documentation)
13. [Why migrate — the 2026-06-15 deadline](#13-why-migrate--the-2026-06-15-deadline)

---

## 1. How the plugin works and why you need it

### Why

The old architecture (`jarvis-telegram-gateway`) is a Python daemon that ran `claude -p` (a headless Agent SDK session) for every Telegram message. Each turn = a new process, a fresh context load, and — after June 15, 2026 — **a separate SDK credit billed outside your Max subscription** (see section 13).

This plugin keeps **one live, interactive Claude Code session** and simply pushes channel messages into it. The session is classified as interactive → usage stays within your normal Max quota and does not grow with the number of Telegram messages. As a bonus, the session remembers context between messages instead of starting from scratch every time.

### How

It is a Claude Code **channel plugin** (Bun + TypeScript, grammY for Telegram, Zod for validation). The message flow:

1. `TelegramPoller` (`src/telegram/poller.ts`) pulls `getUpdates` (long polling) with a per-instance lock on `state_dir`, so two processes can't bring up the same bot.
2. Each incoming message passes the **allowlist gate** (`src/telegram/gate.ts`) — anyone not allowed is rejected *before* any processing.
3. Handlers (`src/telegram/handlers.ts`) assemble text + media into a channel message (`src/prompt/build.ts`) and push it into the Claude Code session.
4. Claude thinks, calls tools/MCP, and forms a reply.
5. The reply goes out to Telegram through `safe-telegram-api` (`src/safety/safe-telegram-api.ts`): secret redaction → HTML validation → 4000-char chunking → token-bucket rate limiter.

In parallel, three "progress surfaces" run (fed by hooks, see section 4):

| Subsystem | What it does |
|---|---|
| `StatusManager` | transient bubble: typing → thinking → name of the current tool |
| `ProgressReporter` | a separate rolling message with activity lines (PreToolUse/PostToolUse/Stop) via `editMessageText` |
| `TaskMirror` | a third rolling message — milestones from `TodoWrite` / `TaskCreate` / `TaskUpdate` |

Two ways to launch: a standalone Bun process (`bun start`, a quick token check) or production via `claude --dangerously-load-development-channels server:dashi-channel` (Claude Code itself hosts the plugin runtime). See section 12.

---

## 2. Personal session + channel tmux, and how to add your user_id

### Process model

In legacy mode the plugin lives inside a single Claude Code session, which is convenient to run inside a named **tmux session** (e.g. `channel-thrall`) — that way you can keep it permanently resident, reconnect over SSH without losing state, and mirror the pane to Telegram (section 6). One workspace, one `CLAUDE.md`, one bot, one DM chat.

### How to add your user_id (legacy single-DM)

Access is the single gate, and it is **mandatory**. Allowed users are set via the `TELEGRAM_ALLOWED_USER_IDS` variable:

```bash
# in channel.env (CSV, no spaces after commas, positive integers only)
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

The `config.json` equivalent:

```json
{ "allowed_user_ids": [123456789, 987654321] }
```

The parser (`src/config.ts`) validates every value as a positive integer and fails with a clear error on garbage. Env overrides `config.json`. In a DM, Telegram sets `chat.id == user.id`, so the gate checks both sender_id and chat_id (defence-in-depth, `src/telegram/gate.ts`).

**How to find your user_id:** message [@userinfobot](https://t.me/userinfobot) — it replies with your numeric id. For groups the id starts with `-100…`.

> Anti-spoof: a reply-to message is validated as belonging to your bot (`is_bot` + username), so forged reply metadata can't bypass the gate (`src/telegram/addressing.ts`). See section 10.

---

## 3. Multichat — how it works and why

![Multichat — one bot fans out across several per-chat tmux sessions](docs/assets/multichat.svg)

### Why

Sometimes you need to run several chats in parallel under the same identity: the operator's personal DM + a work group + a sandbox. One bot, one personality, different "rooms" with different rights and different privacy levels.

### How

`MultichatRouter` (`src/router/multichat-router.ts`, default **OFF**) routes incoming messages across several **per-chat tmux sessions** of `claude` via `TmuxSessionPool`. The plugin ↔ session link is a JSON pipe over a file-based inbox/outbox (`inbox-bridge.ts`). Hybrid routing (PR #33): the operator's DM goes to the host session (`channel-thrall`), groups go to their own per-chat sessions. The per-chat session's Stop hook writes the final reply to the outbox (PR #34), from which the plugin picks it up and sends it to Telegram.

Enable it with a flag in `config.json` (or `TELEGRAM_MULTICHAT_ENABLED=1`):

```json
{
  "multichat": {
    "enabled": true,
    "workspace_dir": "/home/you/.claude-lab/myagent/.claude",
    "policy_path": "/home/you/.claude-lab/myagent/.claude/chats/policy.yaml",
    "state_dir": "/home/you/.claude-lab/myagent/.claude/state/multichat"
  }
}
```

Chats are described in `policy.yaml` (strict Zod schema, `src/chats/policy-loader.ts` — a typo in a key fails the load loudly, not silently):

```yaml
version: 1
allowlist:
  chats: ["123456789", "-1001234567890"]   # chat_id as a string; negative group ids MUST be quoted
  users: ["123456789"]                       # who is allowed to write at all
mention_allowlist: ["123456789"]             # who may summon the bot via @mention in groups
chats:
  "123456789":
    mode: private                            # private | public — selects the available surfaces
    streaming: progress                      # progress | off
    tmux_mirror: true                        # TmuxMirror only in this chat
    edit_message_progress: true              # rolling editMessageText for ProgressReporter
    delivery: streamed                       # streamed | final_only
    persona_file: chats/personas/warchief.md # per-chat persona overlay (relative to workspace_dir)
    handoff_file: core/hot/handoff.md
    system_reminder: "This is the operator's personal DM. Full access."
    idle_ttl_ms: 1800000                     # 30 min before the tmux session is unloaded (default)
    max_queue_depth: 1                        # how many inbound messages may be queued (default 1)
  "-1001234567890":
    mode: public
    streaming: off
    tmux_mirror: false
    edit_message_progress: false
    delivery: final_only
    persona_file: chats/personas/intensive-agent-os.md
    system_reminder: "Public group. No internal logs or mirrors."
```

`PersonaManager` overlays a per-chat persona file on top of the single identity — no separate `CLAUDE.md` per chat is needed. Logs: `{state_dir}/chats/<chat_id>/{inbox,outbox,processing,dead-letter}/*.json`.

**Failure mode:** an invalid `policy.yaml` → the plugin logs the error and degrades to multichat-OFF (legacy single-DM). Better to work with one chat than to crash entirely.

**Privacy isolation:** `private` chats get all surfaces (TmuxMirror, progress-edit). `public` chats get only the final reply (`delivery: final_only`), no internal logs or mirrors. See section 10.

---

## 4. Plugin hooks

Progress in Telegram (`ProgressReporter`, `TaskMirror`, `StatusManager`) is fed by Claude Code hooks. Without installing the hooks these surfaces stay silent — you only get the final reply.

![Hooks — Claude Code event flows through post-hook and the webhook server to the progress surfaces](docs/assets/hooks.svg)

### Installation

```bash
bash plugin/scripts/install-hooks.sh \
  --settings ~/.claude/settings.json \
  --chat-id <your-Telegram-chat-id> \
  --webhook-url http://127.0.0.1:8089/hooks/agent \
  --agent-id dashi-channel
```

Idempotent: marker-based replacement (`"dashi-channel-hook"`) — re-running doesn't duplicate entries and cleans up legacy markerless ones. The script installs **five** events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` (for Pre/PostToolUse the matcher is `.*`, i.e. all tool calls).

### How it works

1. On every event, Claude Code runs `scripts/post-hook.ts` (reads the hook JSON from stdin).
2. `post-hook.ts` POSTs the payload to `TELEGRAM_WEBHOOK_URL` with an `Authorization: Bearer $TELEGRAM_WEBHOOK_TOKEN` header. **Stdout is always empty, exit is always 0** — the hook never blocks Claude and injects nothing into the model's context.
3. The plugin's webhook server (`src/webhook/server.ts`, `POST /hooks/agent`) verifies the bearer token (timing-safe), caps the body at 256 KB, checks the chatId allowlist, and runs Zod validation.
4. `src/hooks/claude-events.ts` maps the payload into internal events and routes them to three independent, best-effort surfaces: MemoryWriter, StatusManager/ProgressReporter, TaskMirror.

Event mapping:

| Hook event | Activity | TaskMirror |
|---|---|---|
| `PreToolUse` | `tool_start` | `task_create` (if TaskCreate) |
| `PostToolUse` | `tool_end` | `task_create` / `task_update` / `todo_write` |
| `UserPromptSubmit` | `reasoning` | — |
| `Stop` | `session_stop` | `todo_session_stop` |
| `SessionStart` | `session_start` | — |

> The bearer token is **never written to settings.json** — it's read from the `TELEGRAM_WEBHOOK_TOKEN` env var at the moment the hook runs. Webhook bind — `TELEGRAM_WEBHOOK_HOST` / `TELEGRAM_WEBHOOK_PORT` (default loopback). More in [`docs/progress-reporter-setup.md`](plugin/docs/progress-reporter-setup.md).

---

## 5. Interactive commands: permission prompts (sudo) and AskUserQuestion

When Claude hits an interactive prompt inside the session, the plugin surfaces it in Telegram and feeds the answer back — the operator drives the agent from the chat, no SSH needed.

### Permission relay (sudo and other sensitive tools)

`src/channel/permissions.ts` listens for `notifications/claude/channel/permission_request`. The flow:

1. Claude wants to run a sensitive tool (e.g. `sudo …`) → sends a request with `tool_name`, `description`, `input_preview`.
2. The plugin puts the request into `pending` (keyed by a 5-letter short-id) and sends a Telegram message with an inline keyboard `[See more] [✅ Allow] [❌ Deny]`.
3. The operator taps a button (or replies with the text `yes abcde` / `no abcde`). The responder is checked against `permission_relay.allowed_user_ids`.
4. The verdict goes back into the session via `notifications/claude/channel/permission` → Claude allows or blocks the tool.

Every decision is written to an audit JSONL (`statePaths.logs.permissions`). The short-id alphabet excludes the letter `l` (to avoid confusion with `1`/`i`).

### AskUserQuestion relay (PR #28)

The `AskUserQuestion` tool renders in Telegram as an inline keyboard (`src/channel/ask-user-question.ts` + `src/telegram/ask-user-question.ts`):

- A hook wrapper POSTs the question to `POST /hooks/ask-user-question/request` and waits for the answer.
- One question = one message with buttons. Callbacks: `ask:choose` (single), `ask:toggle` + `ask:done` (multi-select), `ask:other` (free text).
- The answer arrives at `POST /hooks/ask-user-question/answer`, bound by `chat_id` (protection against cross-chat injection) and by the responder allowlist.
- Timeout (default 5 min) → the relay returns `{ status: 'timeout' }`, and the hook falls back to the native CC UI.

Both `/hooks/ask-user-question/*` endpoints accept **loopback only** (127.0.0.1 / localhost / ::1) + a bearer token — so the question and the token never leak to an external host.

### OOB commands (slash commands in Telegram)

These are "out-of-band" commands for managing the plugin and the session — the plugin intercepts them and they don't reach Claude as a normal prompt (except those that deliberately relay a signal into the session). They're registered via `setMyCommands`, so they show up in Telegram's "/" menu and are localized to Russian (PR #18):

| Command | What it does | How to use |
|---|---|---|
| `/help` | Help — list of all commands | `/help` |
| `/status` | State snapshot: bot_id, state_dir, poller offset, webhook status, mirror state (message_id, last_poll, errors) | `/status` |
| `/stop` | Asks Claude to stop the current task. Cancels the active status bubble and sends a `/stop` signal into the session | `/stop` |
| `/reset force` | Resets the session state — the next message starts from a clean slate | `/reset` without the flag only re-asks; confirm with `/reset force` |
| `/new force` | Starts a new session | Same idea: `/new` re-asks, `/new force` does it |
| `/mirror on\|off\|status` | Turns the terminal mirror on/off without restarting the plugin (section 6) | `/mirror on` · `/mirror off` · `/mirror status` |

Behavior worth knowing:

- **`/stop` is best-effort.** The plugin passes a stop signal into the session, but it doesn't "kill" the process — Claude stops at the nearest safe point, not instantly.
- **`/reset` and `/new` require `force`.** Without the flag the command returns a hint ("add `force` to confirm") — protection against an accidental context reset.
- **The `@botname` suffix is stripped** — `/status@trallvibecoderbot` in a group works the same as `/status`.
- **Access.** Commands are only honored from allowed chats / allowed user_ids (the same allowlist, section 10) — an outsider in a public group can't reset your session.
- In multichat, `/mirror` availability is controlled by the `tmux_mirror` flag in `policy.yaml` per chat.

> Testing: automatic command parsing and routing is covered by `tests/commands/oob.test.ts` (23 assertions). A live run against a real bot — the operator smoke matrix [`plugin/docs/canary-smoke.md`](plugin/docs/canary-smoke.md) (rows `/status`, `/help`, `/stop`, `/reset`, `/new`, `/mirror`).

---

## 6. Terminal mirror — how it works and why

### Why

The operator wants to see the "raw" terminal output (bash, logs) of what the agent is doing right now — without SSH access to the machine. `TmuxMirror` (PR #15) mirrors the pane of a tmux session into **one rolling Telegram message** via `editMessageText`.

### How

Default **OFF**, opt-in via config (in multichat — via the `tmux_mirror` flag in policy, per chat):

```json
{
  "tmux_mirror": {
    "enabled": true,
    "pane_target": "channel-thrall:0.0",
    "poll_interval_ms": 5000,
    "line_count": 50,
    "mode": "latest_inbound_only",
    "max_lines": 14,
    "hide_segments": ["boot_banner", "inbound_warning", "footer_hints", "input_box"]
  }
}
```

Behavior:

- Polls `tmux capture-pane -p -t <pane_target> -S -<line_count>` every `poll_interval_ms`.
- ANSI/CSI/OSC/DCS sequences are stripped, control chars (except `\n`, `\t`) removed.
- The text passes through `redactSecrets` (section 10) → HTML-escape → wrapped in `<pre>`.
- Hash-based dedup: an identical poll → no API call.
- `mode: latest_inbound_only` (default since PR #21) trims everything up to the last `← <channel>:` preview — you only see what the agent is doing after the operator's last message.
- `max_lines` cap (default 14, range 4..100, 0=off) — the top is trimmed with a `… +N lines` marker.
- An edit `"message to edit not found"` → re-send; other 4xx do **not** trigger a resend (storm protection).
- SIGINT/SIGTERM → best-effort `deleteMessage`.

Runtime control: `/mirror on|off|status` without restarting the plugin.

> The mirror is **for the private DM only** (`mode: private`). In public groups it's turned off, so the internal "kitchen" doesn't leak.

---

## 7. Media, audio, and voice-message transcription

### Photos

After the allowlist gate, `handleInboundPhoto` **auto-downloads** the largest resolution into `{state_dir}/inbox/` (perms `0600`, name from `file_unique_id`, hard cap 20 MB) and injects it into the prompt as:

```
<media kind="photo" local_path="/abs/inbox/123-abc.jpg" width="…" height="…" />
```

The agent reads the file with a normal `Read` on the `local_path`. Albums (several photos at once) are buffered by `media_group_id` with a flush on silence (`album-buffer.ts`); each fragment is atomically written to disk before the in-memory update, with recovery on restart and a dead-letter for broken ones.

### Documents

A document is **not** downloaded immediately — it arrives as metadata:

```
<media kind="document" file_id="…" name="foo.pdf" mime="application/pdf" size="12345" />
```

When the agent needs the bytes, it calls the `download_attachment(file_id, chat_id)` tool → the plugin downloads it into the inbox and returns the absolute path (with the chat_id checked against the allowlist, protection against cross-chat leakage).

### Voice → transcription

`maybeTranscribeVoice` (`src/telegram/media.ts`) transcribes via **Groq Whisper** (an OpenAI-compatible endpoint):

- **What to use:** the `GROQ_API_KEY` variable. The model is `config.voice.model` (a working pick: `whisper-large-v3-turbo`), the language is `config.voice.language` (e.g. `ru`).
- Endpoint: `POST https://api.groq.com/openai/v1/audio/transcriptions`, `response_format=text`.
- Hard cap 25 MB (Groq's limit), checked against Telegram metadata **before** downloading.
- Telegram serves voice as `.oga` (Ogg/Opus) — Groq rejects that extension, so the file is renamed to `.ogg` before upload.
- The key is redacted from any error messages. Exceptions are not propagated — the descriptor always carries a status.

The result in the prompt:

```
<media kind="voice" mime="audio/ogg" duration_sec="5" transcript="hi operator" transcription_status="ok" />
```

Without `GROQ_API_KEY` → `transcription_status="missing_key"` (no error — Claude decides whether to ask you to enable it).

---

## 8. Session auto-restart — so the link never drops

The link holds at three levels, from the smallest glitch to a process crash:

**1. In-process poller auto-reconnect (PR #30).** On network failures / 5xx / disconnects, `TelegramPoller` reconnects itself with exponential backoff `1s → 2s → 4s → … → cap 60s` + jitter, and the counter resets on the first successful `getUpdates`. On `429` it honors `retry_after`; on `409 Conflict` (another consumer holds the token) it backs off for up to 8 attempts; on `401` up to 3. The process doesn't die in the meantime.

**2. Single-instance lock.** The lock file `{state_dir}/bot.pid` is created atomically (`O_EXCL`). A second process reads the PID, checks `process.kill(pid, 0)`, and refuses to start if the owner is alive — no "409 storm" from two pollers on one bot. A dead PID is cleaned up and the lock is reclaimed (up to 3 attempts).

**3. Process supervisor (restart of the whole process).**

- **Linux / systemd** (`examples/systemd-unit.service.example`): `Restart=on-failure`, `RestartSec=15s` — restart only on a non-zero exit (it won't loop on welcome prompts).
- **macOS / launchd** (`examples/launchd-plist.example.plist`): `KeepAlive.SuccessfulExit=false`, `ThrottleInterval=15`. The wrapper script `trap cleanup TERM INT` returns exit 0 on a clean operator stop and exit 1 on a crash — launchd respawns only crashes.

**4. Idle-respawn of tmux sessions (multichat).** The `TmuxSessionPool` watchdog (every 60s) kills sessions that have been idle longer than `idle_ttl_ms` (default 30 min) and brings them back on the next message. `sessions.json` stores the chat→tmux mapping and reconnects to live sessions when the plugin restarts, leaving no orphans.

---

## 9. HTML filtering from terminal to Telegram

So that Telegram receives nicely formatted text — not raw markdown or broken markup — the outbound path (`src/format/html.ts` + `src/safety/html-validator.ts` + `src/format/chunk.ts`) does the following:

**1. Markdown → Telegram HTML.** Telegram accepts a narrow set of tags: `b, strong, i, em, u, ins, s, strike, del, code, pre, a, br, blockquote, tg-spoiler`. The converter carefully "hides" code blocks, tables, inline code, `[text](url)` links, and already-valid HTML into placeholders **before** escaping, escapes the rest of the text (`&`, `<`, `>`), applies markdown transforms (headings → `<b>`, `**bold**`, `~~strike~~`, `*italic*` with word-boundary checks so it doesn't break `foo_bar`), and restores the placeholders.

**2. Pre-send validation.** `validateTelegramHtml()` tokenizes the result, catches unbalanced brackets, unknown/disallowed tags, invalid attributes (`<a href>` only `http/https/tg/mailto`). On any error — **downgrade to plain text** (escape the raw input without `parse_mode`), and the message still goes out. Only the reason is logged, not the body.

**3. ANSI strip (for the mirror).** Before sending, the pane is cleaned of ANSI/CSI/OSC/DCS sequences and control chars.

**4. Chunking at 4000 chars.** `splitForTelegram` cuts on boundaries: paragraph (`\n\n`) > line (`\n`) > hard cut. If a split lands inside `<pre>`/`<code>`, the tag is closed on the current chunk and reopened on the next (tag balance is tracked), and the `language-` class is preserved on the first chunk.

The `reply` default is `format='html'` (PR #22): markdown is auto-converted, auto-chunked, and bare `<`/`>`/`&` in regular text are safely escaped.

---

## 10. Security — so data never leaks

Defence is layered — several independent barriers:

![Security — layered defence-in-depth from inbound message to processed safely](docs/assets/security.svg)

**Allowlist gate (the first barrier).** Every incoming message is checked *before* processing (`src/telegram/gate.ts`): in a DM — sender_id ∈ `allowed_user_ids` (+ a defensive chat_id check); in groups (multichat) — chat ∈ `policy.allowlist.chats` AND sender ∈ `policy.allowlist.users`. Not allowed — dropped without processing.

**Anti-spoof addressing** (`src/telegram/addressing.ts`). In groups the bot reacts only to an explicit @mention or a reply-to one of its own messages (validated by `is_bot` + username). `mention_allowlist` further restricts who may summon the bot at all. An empty allowlist = no one. Forged reply metadata does not bypass the check.

**Secret redaction** (`src/safety/redact.ts`). Before sending, and in the mirror, the following are masked: the Telegram bot token, Groq/OpenAI/GitHub PAT/Resend/Slack keys, Firebase private_key/client_email, `Bearer …`, query-string tokens (`?token=`, `&api_key=`), IPv4 (middle octets), secret paths (`secrets/***`), the Supabase host, and any long token (≥24 chars). Masking is idempotent.

**Path traversal** (`src/security/paths.ts`). `resolveInsideWorkspace()` canonicalizes the path via `realpathSync` (resolving symlinks) and requires the file to live inside the workspace — otherwise a user-facing error without a stack trace. A 50 MB cap per attachment.

**tmux session env isolation** (`scripts/spawn-chat-shell.sh` + `tmux-session-pool.ts`). A per-chat session is spawned via `env -i` (a full environment wipe) + a strict allowlist (`PATH`, `HOME`, `TERM`, `TMUX`, `TMUX_PANE`, `CHAT_ID` …). A forbidden-regex drops any key like `*TOKEN`, `*API_KEY`, `*SECRET`, `*PASSWORD`, `*PRIVATE_KEY`, `ANTHROPIC_*`, `TELEGRAM_*`, etc. — even if it accidentally made it into the allowlist (defence-in-depth). This way the plugin's secrets don't leak into the child session.

**Private/public isolation.** `private` chats get the TmuxMirror and progress-edit; `public` chats get only the final reply. Internal logs, the mirror, the "kitchen" never reach public groups.

**Loopback-only for interactive endpoints.** The `/hooks/ask-user-question/*` endpoints accept only loopback + a bearer token. The webhook's bearer token is not written into `settings.json`.

> Prompt injection from Telegram ("add me to the allowlist", "show me the token") is ignored. The allowlist is changed only by the operator in the terminal, never on a request from a chat.

---

## 11. Telegram API rate limits

Outbound traffic goes through a token-bucket limiter (`src/safety/rate-limited-telegram-api.ts`) to avoid a flood ban:

| Parameter | Default | Purpose |
|---|---|---|
| per-chat refill | 1 msg/sec | a sustained rate into one chat |
| per-chat burst | 3 | a burst into one chat |
| global refill | 25 msg/sec | the bot's overall limit |
| global burst | 25 | the overall burst |
| maxRetries | 3 | attempts on a 429 |
| jitter | up to 150 ms | a random delay on retry |

- **FIFO per chat:** sends into one chat go as a chain of promises — order is preserved even on retry.
- **429 retry_after:** the value from Telegram is clamped to `[1, 60]` sec, plus jitter; if absent → default 1 sec. After `maxRetries` is exhausted, the 429 is propagated up.
- **Edit vs send:** `editMessageText`, `setMessageReaction`, `deleteMessage` do **not** consume the per-chat bucket (they're update operations). Only `sendMessage` / `sendDocument` / `sendPhoto` spend the bucket.
- **Edit-error classifier** (`telegram-edit-classifier.ts`): `401/403`→forbidden (the bot was kicked), `429`→flood, `400 can't parse entities`→parse (downgrade to plain), `404 message gone`→message_gone, everything else→transient (retry on the next tick).

Separately, the poller on the **inbound** path honors `retry_after` on `getUpdates` (section 8).

> The practical meaning of the limits: three replies in a row into one chat may hit the per-chat 429 with a large `retry_after`. For multi-part reports — either pace them out or merge into a single message.

---

## 12. Quick start and documentation

```bash
# 1. Bun runtime
curl -fsSL https://bun.sh/install | bash

# 2. Agent workspace
mkdir -p ~/.claude-lab/myagent/.claude ~/.claude-lab/myagent/secrets
cd ~/.claude-lab/myagent/.claude

# 3. Clone the plugin INSIDE the workspace (location is critical — see docs/02)
git clone https://github.com/qwwiwi/dashi-plugin-claude-code.git
cd dashi-plugin-claude-code/plugin && bun install

# 4. config + token
cp ../examples/channel.env.example ~/.claude-lab/myagent/secrets/channel.env
chmod 600 ~/.claude-lab/myagent/secrets/channel.env
$EDITOR ~/.claude-lab/myagent/secrets/channel.env   # TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, GROQ_API_KEY

# 5. Launch (production variant — Claude Code hosts the runtime)
set -a; . ~/.claude-lab/myagent/secrets/channel.env; set +a
claude --dangerously-load-development-channels server:dashi-channel

# 6. MANDATORY — install the hooks (otherwise there's no progress in Telegram)
bash scripts/install-hooks.sh --settings ~/.claude/settings.json \
  --chat-id <your-chat-id> --webhook-url http://127.0.0.1:8089/hooks/agent --agent-id dashi-channel

# 7. Migrating from the old gateway? Run the doctor before AND after cutover
bun skills/doctor-dashi-plugin/scripts/doctor.ts \
  --plugin-dir "$PWD" --settings ~/.claude/settings.json --session channel-myagent
```

On the first launch, Claude Code asks 2 interactive questions (allow external imports + dev channels) — **once**; answer `1` to both.

> **Migration doctor.** If you are moving an agent off the legacy gateway, the [`doctor-dashi-plugin`](skills/doctor-dashi-plugin/SKILL.md) skill diagnoses the whole cutover — toolchain floors, workspace placement (identity drift), settings/hook registration, MCP comms consistency, the Telegram allowlist, and live-session signals (welcome hang, expired auth, 409 conflict, crash loop). It is read-only — it never restarts a service or prints a secret — and it encodes every mistake we already paid for so you don't repeat them. Run `bun skills/doctor-dashi-plugin/scripts/doctor.ts --help`.

**Stack:** Bun 1.3+ / TypeScript strict, Claude Code v2.1.80+ ([Channels reference](https://code.claude.com/docs/en/channels-reference)), grammY 1.21+, Zod 3.23+, systemd/launchd supervisor.

| Doc | What's inside |
|---|---|
| [docs/01-what-is-this.md](docs/01-what-is-this.md) | Plugin vs Gateway — architecture and advantages |
| [docs/02-where-to-place-plugin.md](docs/02-where-to-place-plugin.md) | **The big one.** Where to place the directory so the session loads correctly (90% of problems) |
| [docs/03-installation.md](docs/03-installation.md) | systemd / launchd, EnvironmentFile, the welcome-prompt fix, smoke test |
| [docs/03-installation-linux.md](docs/03-installation-linux.md) · [macos](docs/03-installation-macos.md) | OS-specific unit/plist |
| [docs/04-migration-from-gateway.md](docs/04-migration-from-gateway.md) | Step-by-step migration from `jarvis-telegram-gateway`, with a rollback at each step |
| [skills/doctor-dashi-plugin/SKILL.md](skills/doctor-dashi-plugin/SKILL.md) | **Migration doctor** — read-only diagnostic skill that checks placement, hooks, comms config, allowlist, and live-session health before/after cutover |
| [docs/05-troubleshooting.md](docs/05-troubleshooting.md) | Common errors: symptom → root cause → fix |
| [docs/06-how-claude-loads-session.md](docs/06-how-claude-loads-session.md) | How Claude Code finds `CLAUDE.md`, CWD upward search, `@-include` |
| [plugin/docs/progress-reporter-setup.md](plugin/docs/progress-reporter-setup.md) | Installing the hooks in 3 steps + troubleshooting |
| [plugin/docs/canary-smoke.md](plugin/docs/canary-smoke.md) | A live smoke matrix against a test bot |

> Documentation is currently being translated to English. Sections still in Russian live alongside their English counterparts — contributions welcome (see [License and author](#license-and-author)).

---

## 13. Why migrate — the 2026-06-15 deadline

From June 15, 2026, Anthropic is splitting billing. `claude -p` (the Agent SDK) moves to a **separate, plan-dependent SDK credit**:

- Pro — $20/mo · Max 5× — $100/mo · Max 20× — $200/mo

Source: [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

The old gateway architecture (a Python daemon spawning `claude -p` on every Telegram turn) will burn SDK credit on every message after the cutover. This plugin keeps **one live, interactive session** (or a pool of per-chat tmux sessions in multichat) — usage stays within your normal Max quota and does not grow with the number of messages. The full plan — [DEPRECATION-PATH.md](DEPRECATION-PATH.md).

**Trade-offs:** one process = one bot (need 5 bots → 5 processes); a session restart = loss of the current context (but `core/hot/recent.md` keeps the tail); multichat = more memory and a mandatory, carefully written `policy.yaml`; you need Bun + Claude Code v2.1.80+ (not a Python-only host).

---

## Must-read (and don't skip)

If you're short on time — three docs solve 90% of the problems, in this order:

1. **[docs/02-where-to-place-plugin.md](docs/02-where-to-place-plugin.md) — read this FIRST.** Where to physically place the plugin directory so Claude Code loads the right session and `CLAUDE.md`. 90% of first-launch failures come from here. Don't skip it.
2. **[docs/03-installation.md](docs/03-installation.md)** (+ [linux](docs/03-installation-linux.md) / [macos](docs/03-installation-macos.md)) — production setup: systemd/launchd, EnvironmentFile, how to silence welcome prompts so the service doesn't loop. Without this the agent won't survive a reboot.
3. **[plugin/docs/progress-reporter-setup.md](plugin/docs/progress-reporter-setup.md)** — install the hooks in 3 steps. Without hooks there's no progress in Telegram (sections 4–5). The most common complaint, "the bot is silent while working," is cured here.

After that — as needed:

- **Migrating from the old gateway?** → [docs/04-migration-from-gateway.md](docs/04-migration-from-gateway.md) (step-by-step, with a rollback at each step) + [DEPRECATION-PATH.md](DEPRECATION-PATH.md) (timelines and why).
- **Something broke?** → [docs/05-troubleshooting.md](docs/05-troubleshooting.md) — a "symptom → root cause → fix" table.
- **Don't understand why the agent can't see its `CLAUDE.md`?** → [docs/06-how-claude-loads-session.md](docs/06-how-claude-loads-session.md) — CWD upward search, `@-include`, global vs project.
- **Before the first live run** → [plugin/docs/canary-smoke.md](plugin/docs/canary-smoke.md) — a smoke matrix against a test bot (text, media, OOB, permission relay, webhook).
- **Configuration parameters** — the single source of truth: `plugin/src/config.ts` (`RuntimeEnvSchema`) and `examples/config.example.json` + `examples/channel.env.example`.

Internal dev docs (PR history, review specs) are in [docs/dev/](docs/dev/) — optional reading.

---

## License and author

Apache 2.0 (see [LICENSE](LICENSE)). A fork of the idea behind Anthropic's Telegram plugin, with full Jarvis Gateway parity.

[@qwwiwi](https://github.com/qwwiwi) (Dashi Eshiev) · EdgeLab AI. Issues / PRs welcome; for migration — open an issue tagged `migration` with a description of your setup.
