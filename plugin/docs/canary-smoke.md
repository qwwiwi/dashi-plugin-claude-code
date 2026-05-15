# Canary smoke runbook

Live verification of the Dashi Channel plugin against test bot `@testmyfirsttmuxbot` (id `8507713167`).

This runbook is for the human operator (prince at the keyboard). The plugin runs as a Claude Code development channel; tests rely on real Telegram messages sent from user `164795011`.

## Pre-flight (run once)

```bash
cd /Users/jasonqwwen/qwwiwi-channel-telegram-Claude-code/plugin
~/.bun/bin/bun install
~/.bun/bin/bun run typecheck
~/.bun/bin/bun test tests/
```

Expected: zero typecheck errors, 212+ tests pass.

Shortcut: `./scripts/smoke-local` runs all three steps and prints the launch hint.

## Stop the Python canary (one token, one consumer)

Telegram delivers each update to exactly one long-poll consumer. Before launching the channel plugin, stop the Python ACK canary so the bot token is free.

```bash
# Confirm Python canary is up
tmux ls | grep orgrimmar-canary || echo "no canary tmux session"

# Stop it
tmux kill-session -t orgrimmar-canary 2>/dev/null || true

# Verify no leftover python process holding the token
pgrep -af dashi-telegram-canary-bot || echo "clean"
```

Do NOT touch the production tmux sessions: `orgrimmar-silvana`, `orgrimmar-kaelthas`, `orgrimmar-garrosh`, `orgrimmar-arthas`, `orgrimmar-claude`. Those run the Python `claude -p` gateway against production tokens and stay up during canary work.

## Launch the channel plugin

```bash
tmux new-session -d -s orgrimmar-canary-channel \
  -c /Users/jasonqwwen/qwwiwi-channel-telegram-Claude-code/plugin \
  'TELEGRAM_BOT_TOKEN=$(cat ~/.claude-lab/shared/channel-runtime/canary/secrets/telegram-bot-token) \
   TELEGRAM_STATE_DIR=/Users/jasonqwwen/.claude-lab/shared/channel-runtime/canary/telegram \
   TELEGRAM_WORKSPACE_ROOT=/tmp/dashi-channel-canary-workspace \
   claude --dangerously-load-development-channels server:dashi-channel'
```

Verify the session is alive:

```bash
tmux ls | grep orgrimmar-canary-channel
tmux capture-pane -t orgrimmar-canary-channel -p -S -50
```

Expected: Claude Code prints channel-connected line; plugin stderr shows `telegram channel up, bot_id=8507713167`.

## Smoke matrix

Each test sends a Telegram DM from user `164795011` to `@testmyfirsttmuxbot` and verifies the plugin response. Run them sequentially; do not parallelize.

| # | Test | Send | Expected |
|---|------|------|----------|
| 1 | Plain text | "привет" | Claude replies through reply tool |
| 2 | Long answer (HTML chunking) | "напиши большой markdown post про typescript" | Multiple chunks, valid HTML formatting |
| 3 | Reply-to anti-spoof | reply to a bot message with "что ты сказал?" | Claude's prompt contains `<untrusted_metadata type="telegram_reply">` with `sender="agent_previous_message"` |
| 4 | Photo | send a photo | Claude reads inbox path |
| 5 | Document | send a PDF | Channel meta has `attachment_kind=document` |
| 6 | Voice (with GROQ_API_KEY) | send voice message | Transcript in `<media>` tag |
| 7 | Voice (without GROQ_API_KEY) | send voice message | `transcription_status=missing_key` |
| 8 | Album | send 3 photos in album | Single channel notification with `album_size=3` |
| 9 | /status | "/status" | HTML reply listing bot_id, state_dir, workspace, uptime |
| 10 | /help | "/help" | HTML reply listing OOB commands |
| 11 | /stop during long task | start a long task, then "/stop" | Status canceled, ack reply |
| 12 | /reset force | "/reset force" | Ack reply + channel notify `meta.command=reset` |
| 13 | Permission allow (Bash) | trigger Bash via Claude, then press Allow button | Bash runs |
| 14 | Permission deny | trigger Bash, press Deny | Bash refused |
| 15 | Webhook (if enabled) | `curl -X POST http://127.0.0.1:8089/hooks/agent -H 'Authorization: Bearer <TELEGRAM_WEBHOOK_TOKEN>' -d '{...}'` | `meta.source=webhook` in Claude context |

For tests 6/7, toggle by exporting `GROQ_API_KEY` before launch or leaving it unset. Restart the tmux session after changing env.

For test 15, only run if the canary launch includes `TELEGRAM_WEBHOOK_PORT` and `TELEGRAM_WEBHOOK_TOKEN`.

## Inspection commands

```bash
# Live tail of plugin stderr
tmux capture-pane -t orgrimmar-canary-channel -p -S -200

# Permission audit log
tail -f ~/.claude-lab/shared/channel-runtime/canary/telegram/logs/permissions.jsonl

# Dead-letter queue
ls -la ~/.claude-lab/shared/channel-runtime/canary/telegram/dead-letter/updates/

# Status snapshot (read-only)
cat ~/.claude-lab/shared/channel-runtime/canary/telegram/state/status.json 2>/dev/null
```

## Pass criteria

- All 15 rows produce the expected behavior with no plugin crash.
- `permissions.jsonl` shows one `allow` entry for test 13 and one `deny` for test 14.
- Dead-letter queue empty (or contains only deliberate failures).
- No production bot received traffic during the run (check production tmux capture).

If any row fails: stop the plugin, snapshot logs to `loop-coding-runs/2026-05-15-canary-gateway-full-parity/T15-smoke-evidence/`, file the issue against the relevant T-task, and roll back to the Python canary.

## Rollback to Python canary

```bash
# Stop channel plugin
tmux kill-session -t orgrimmar-canary-channel

# Restart Python ACK canary
tmux new-session -d -s orgrimmar-canary \
  -c /Users/jasonqwwen/qwwiwi-channel-telegram-Claude-code \
  'env DASHI_CHANNEL_RUNTIME_ROOT=/Users/jasonqwwen/.claude-lab/shared/channel-runtime PYTHONUNBUFFERED=1 \
   scripts/dashi-telegram-canary-bot --reply-mode claude --claude-max-budget-usd 0.20 --poll-timeout 20'

# Verify
tmux capture-pane -t orgrimmar-canary -p -S -30
```

Rollback should take under 30 seconds and is the standard recovery path for any plugin regression.

## Do NOT touch

- Production tokens for `sa-silvana`, `sa-kaelthas`, `sa-garrosh`, `sa-arthas`, `sa-claude`
- `~/.claude-lab/shared/gateway/gateway.py`
- `~/.claude-lab/shared/gateway/config.json`
- any `ai.orgrimmar.gateway` launchd job
- production tmux sessions (`orgrimmar-silvana`, `orgrimmar-kaelthas`, `orgrimmar-garrosh`, `orgrimmar-arthas`, `orgrimmar-claude`)

Phase 4 production cutover requires explicit prince approval and proven rollback. Until then, the canary smoke is the only live exercise of this plugin.
