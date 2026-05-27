# Canary smoke runbook

Live verification of the Dashi Channel plugin against a dedicated test bot you own (referred to below as `<test-bot-id>`).

This runbook is for the human operator at the keyboard. The plugin runs as a Claude Code development channel; tests rely on real Telegram messages sent from your own user account, referred to below as `<your-telegram-user-id>` (your numeric Telegram user id — find it via [@userinfobot](https://t.me/userinfobot)).

> Use a separate test bot — never run the canary against a production bot token. Production traffic must stay on the production deployment.

## Pre-flight (run once)

```bash
cd ~/path/to/your/.claude-lab/dashi-plugin-claude-code/plugin
~/.bun/bin/bun install
~/.bun/bin/bun run typecheck
~/.bun/bin/bun test tests/
```

Expected: zero typecheck errors, 212+ tests pass.

Shortcut: `./scripts/smoke-local` runs all three steps and prints the launch hint.

## Stop any pre-cutover Python canary (one token, one consumer)

Telegram delivers each update to exactly one long-poll consumer. Before launching the channel plugin, stop any other process consuming this bot's updates so the bot token is free.

> Pre-cutover (Python `gateway.py`) — applicable only if you are migrating from the legacy Python gateway; skip this section if you are installing fresh.

```bash
# Confirm any pre-cutover Python canary is up
tmux ls | grep channel-canary || echo "no canary tmux session"

# Stop it
tmux kill-session -t channel-canary 2>/dev/null || true

# Verify no leftover python process holding the token
pgrep -af dashi-telegram-canary-bot || echo "clean"
```

Do NOT touch any other production tmux sessions you operate (for example `channel-<your-agent>` sessions running production bot tokens). Those should stay up during canary work.

## Launch the channel plugin

```bash
tmux new-session -d -s channel-canary-test \
  -c ~/path/to/your/.claude-lab/dashi-plugin-claude-code/plugin \
  'TELEGRAM_BOT_TOKEN=$(cat ~/.claude-lab/shared/channel-runtime/canary/secrets/telegram-bot-token) \
   TELEGRAM_STATE_DIR=~/path/to/your/.claude-lab/shared/channel-runtime/canary/telegram \
   TELEGRAM_WORKSPACE_ROOT=/tmp/dashi-channel-canary-workspace \
   claude --dangerously-load-development-channels server:dashi-channel'
```

Verify the session is alive:

```bash
tmux ls | grep channel-canary-test
tmux capture-pane -t channel-canary-test -p -S -50
```

Expected: Claude Code prints channel-connected line; plugin stderr shows `telegram channel up, bot_id=<test-bot-id>`.

## Smoke matrix

Each test sends a Telegram DM from your test account (`<your-telegram-user-id>`) to your test bot and verifies the plugin response. Run them sequentially; do not parallelize.

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
tmux capture-pane -t channel-canary-test -p -S -200

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
- No production bot received traffic during the run (check any production tmux capture for your own deployment).

If any row fails: stop the plugin, snapshot logs to a dated evidence folder under `loop-coding-runs/<date>-canary/T15-smoke-evidence/`, file an issue against the relevant T-task, and roll back to the previous known-good launcher.

## Rollback to the pre-cutover Python canary

> Applicable only if you are migrating from the legacy Python gateway. Skip this section if you are installing fresh.

```bash
# Stop channel plugin
tmux kill-session -t channel-canary-test

# Restart pre-cutover Python ACK canary
tmux new-session -d -s channel-canary \
  -c ~/path/to/your/.claude-lab/dashi-plugin-claude-code \
  'env DASHI_CHANNEL_RUNTIME_ROOT=~/path/to/your/.claude-lab/shared/channel-runtime PYTHONUNBUFFERED=1 \
   scripts/dashi-telegram-canary-bot --reply-mode claude --claude-max-budget-usd 0.20 --poll-timeout 20'

# Verify
tmux capture-pane -t channel-canary -p -S -30
```

Rollback should take under 30 seconds and is the standard recovery path for any plugin regression.

## Do NOT touch

- Production bot tokens for any of your operator deployments
- The legacy Python gateway path (`~/path/to/your/.claude-lab/shared/gateway/`) and its `config.json`
- any production launchd / systemd job that runs the legacy gateway
- production tmux sessions (anything matching `channel-<your-agent>` that is running a production bot token)

Production cutover requires explicit operator approval and a proven rollback path. Until then, the canary smoke described here is the only live exercise of this plugin.
