# Canary smoke runbook

Live verification of the Agent47 Channel plugin against a dedicated test bot you own (referred to below as `<test-bot-id>`).

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

> ⚠ Pre-cutover (Python gateway.py) — applicable only if you are migrating from the legacy Python gateway plugin. After 2026-06-15 cutover, this section becomes legacy reference only. Skip if installing fresh.

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
   TELEGRAM_WORKSPACE_ROOT=/tmp/agent47-channel-canary-workspace \
   claude --dangerously-load-development-channels server:agent47-channel'
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

### Keystroke commands smoke (PR #81 / #83: `/keys`, `/cc`)

Rows K1–K4 cover the keystroke-injection commands. They require a resolvable tmux pane (a real agent session, not the test-bot canary launched without `$TMUX`). Run them against a live agent session in a private chat from an allow-listed user id.

| # | Test | Send | Expected |
|---|------|------|----------|
| K1 | `/keys` panel renders | "/keys" | Inline keypad reply: digit rows `[1..5]` `[6..0]`, `[✓ y][✗ n][⏎ enter][⎋ esc]`, arrows, `[⇥ tab][␣ space]`, plus `⌫ backspace` and `🧹 clear` |
| K2 | `/keys` tap injects one key | trigger a native Claude Code dialog, tap `1` | Exactly one keystroke lands in the pane (option 1 selected); panel is not consumed — still tappable |
| K3 | `/keys` unauthorized tap | tap a `kkey:` button from a non-allow-listed user id | "not authorized" toast only; no keystroke sent (check `logs/permissions.jsonl`) |
| K4 | `/cc` passthrough | "/cc compact" | `/compact` is typed into the session (Claude Code runs its own slash command); narrow charset rejects shell metacharacters |

Note: the former `/key <tokens>` text command was removed in favor of the `/keys` panel — only `/keys` and `/cc` exist now (see `src/commands/oob.ts` `KNOWN_COMMANDS`).

### Multichat-era smoke (PR #13, #22, #26)

Rows 16–25 cover features introduced after the initial canary baseline: the multichat router, per-chat tmux session pool, tmux mirror, task mirror, telegram-token redaction, and the HTML-by-default reply format. Each row depends on flags listed in the "Send" column — restart the tmux session after changing env. If the multichat router is not in your build, skip this entire section.

| # | Test | Send | Expected | Verify |
|---|------|------|----------|--------|
| 16 | MultichatRouter default-OFF | launch without `MULTICHAT_ENABLED`, send "ping" in DM from `<your-telegram-user-id>` | Legacy single-chat path handles the message; router is bypassed | `tmux capture-pane -t channel-canary-test -p -S -100 \| grep -E 'multichat_router=(off\|skipped)'` returns at least one line; reply arrives as usual |
| 17 | MultichatRouter enabled (group) | launch with `MULTICHAT_ENABLED=true` and an allowed group id, send "ping" in that group | Router dispatches to per-chat tmux session, response returns via outbox | `tmux ls \| grep channel-multichat-<chat-id>` shows the per-chat session; `ls ~/path/to/your/.claude-lab/shared/channel-runtime/canary/telegram/outbox/` has a fresh entry |
| 18 | TmuxSessionPool reuse | inside row 17's group, send a second message in the same chat within idle window | Pool finds existing `tmux has-session` and reuses the spawned session — no second spawn | `tmux capture-pane -t channel-canary-test -p -S -200 \| grep 'session_pool=reuse'` appears; total `channel-multichat-*` session count unchanged |
| 19 | TmuxSessionPool idle-kill | wait longer than `config.session.idle_kill_after_sec` after row 18, then send another message | Idle session is killed and a fresh one spawned; `outbox/dead-letter` and `outbox/mismatched` directories are preserved (not wiped) | `tmux ls \| grep channel-multichat-<chat-id>` shows a new pid; `ls ~/path/to/your/.claude-lab/shared/channel-runtime/canary/telegram/outbox/dead-letter/ ~/path/to/your/.claude-lab/shared/channel-runtime/canary/telegram/outbox/mismatched/` still lists prior entries |
| 20 | TmuxMirror enabled (DM) | with `TMUX_MIRROR_ENABLED=true`, send "посмотри файлы" in DM from `<your-telegram-user-id>` | Status updates stream and a pane mirror message appears mid-task | `tail -f ~/path/to/your/.claude-lab/shared/channel-runtime/canary/telegram/state/status.json` shows progressing phases; an edited mirror message exists in the chat |
| 21 | TmuxMirror not enabled (group) | repeat row 20 inside the multichat group | No mirror or status messages — only the final reply | `tail -f ~/path/to/your/.claude-lab/shared/channel-runtime/canary/telegram/logs/permissions.jsonl` shows no mirror writes; the group receives one reply, not a status stream |
| 22 | TaskMirror update | run a Claude task that uses TodoWrite / Task tools while connected from DM | Mirror message updates in-place as tasks transition states | `tmux capture-pane -t channel-canary-test -p -S -200 \| grep task_mirror=update` shows update events; the existing TG message is edited rather than reposted |
| 23 | safe-telegram-api redaction | have Claude reply with a string containing a fake Telegram token like `123456:ABC-DEF1234567890abcdefGHI` | Token is replaced with `[REDACTED]` before the message is sent to Telegram | `tail -n 50 ~/path/to/your/.claude-lab/shared/channel-runtime/canary/telegram/logs/outbound.jsonl \| grep -v '[REDACTED]' \| grep -E '[0-9]{6,}:[A-Za-z0-9_-]{30,}'` returns nothing; the chat message contains `[REDACTED]` |
| 24 | format=html default (PR #22) | trigger any reply whose content includes `**жирный**` markdown | Reply renders as bold in Telegram (HTML mode applied automatically) | Visually confirm bold in the Telegram client; `tmux capture-pane -t channel-canary-test -p -S -200 \| grep 'format=html'` shows the default |
| 25 | format=text override | ask Claude to reply with `format='text'` and content containing `**stars**` | Stars render literally — no bold, no markdown processing | Visually confirm literal `**stars**` in chat; outbound log shows `format=text` |

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

- Rows 1–15 (baseline) produce the expected behavior with no plugin crash.
- Rows 16–25 (multichat-era, conditional on PR #13/#22/#26 features being enabled) pass or are explicitly marked N/A.
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
