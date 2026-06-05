# Failure modes (Problems 1–10)

Every known way a migrated bot misbehaves: symptom → root cause → fix. Diagnose
**by architecture, not by symptom**: service status → tmux capture → identity →
only then the Telegram queue (Problem 4 is the trap that skips this order).

## Problem 1 — service "active" but Telegram is silent

- **Symptom**: `systemctl status` = `active (running)`, but the bot answers
  nothing — no reactions, no replies.
- **Cause**: Claude is stuck on one of the two welcome prompts; until passed, the
  plugin never activates and polling never starts. `active` only means the tmux
  process and the forked claude are alive — claude is blocked on a prompt.
- **Fix**: `tmux attach -t channel-<agent>` → Enter (and a second Enter if
  present) → detach `Ctrl-B D` → confirm `Listening for channel messages from:
  server:dashi-channel`. Prevent with the `ExecStartPost` double-Enter and the
  persistent accepts in settings.json.
- **Lesson**: "active" = "process alive", not "working".

## Problem 2 — agent answers as "default Claude" (identity drift)

- **Symptom**: "who are you?" → "I'm Claude, an AI assistant made by Anthropic".
- **Cause**: `WorkingDirectory=` is not inside the workspace, so the upward CWD
  search never found the project `CLAUDE.md` — only the global one loaded.
- **Fix**: correct `WorkingDirectory=` to a directory under which `CLAUDE.md`
  exists; `ls -la <workspace>/CLAUDE.md`; in tmux `/memory` must show both
  CLAUDE.md. After any `WorkingDirectory` change, ping "who are you?".
- **Lesson**: silent bug — the bot works sensibly, just without your identity.

## Problem 3 — `getUpdates conflict` (two sessions on one bot)

- **Symptom (logs)**: `409 Conflict: terminated by other getUpdates request`.
- **Cause**: the Bot API allows exactly one active `getUpdates` client per token;
  two processes with the same `TELEGRAM_BOT_TOKEN` steal each other's updates.
  Scenarios: old `gateway.py` still alive; staging+prod sharing a token; a
  forgotten local `bun run start`; a PM2 app with a leaked token.
- **Fix**: stop one consumer, wait 30–45s, restart the channel. Decisive test —
  stop the channel, wait, `curl getUpdates`; if 409 **persists** the second
  consumer is external; hunt it across a time window (`pgrep -af bun`,
  `pgrep -af bot.start`, `pm2 list` + `pm2 env <id>`), not a single snapshot.
- **Lesson**: do not theorise about a Claude version regression — find the second
  process.

## Problem 4 — polling vs webhook (a false trail)

- **Symptom**: bot silent; operator checks `getWebhookInfo` → `url_set: false`,
  concludes "webhook broken", loses 30 minutes.
- **Cause**: the plugin polls by default (`getUpdates`); the webhook port (8089)
  is only for Claude hooks, not Telegram. `url_set: false` is normal for polling.
- **Fix**: diagnose in order — `systemctl status` → tmux capture (welcome?) →
  identity (`/memory`) → only then the Telegram queue.
- **Lesson**: diagnose by architecture, not by symptom.

## Problem 5 — allowlist drops the message

- **Symptom**: `getUpdates pending=0` (plugin is draining), tmux active, but no
  reaction and no reply, no error in the log.
- **Cause**: `TELEGRAM_ALLOWED_USER_IDS`/`TELEGRAM_ALLOWED_CHAT_IDS` does not
  contain your id, so the plugin silently drops the update (by design). The code
  default `[164795011]` applies only when the env is empty.
- **Fix**: get your id from `@userinfobot`; set
  `TELEGRAM_ALLOWED_USER_IDS=<your_id>` (group ids look like `-100123456789`);
  restart. Right after start, send `/help` — silence on an out-of-band command
  means allowlist.

## Problem 6 — state loss on migration

- **Symptom**: bot starts blank, remembers no conversations, `recent.md` empty.
- **Cause**: `TELEGRAM_STATE_DIR` points at a recreated/moved/unmounted path. The
  dir holds `bot.pid`, `config.json`, `inbox/`, `logs/permissions.jsonl`, plus
  `<workspace>/core/hot/recent.md` if memory hooks are on.
- **Fix/prevent**: before moving, `stop` + tar-snapshot the workspace, state dir,
  and unit; after, verify `ls -la $TELEGRAM_STATE_DIR/{bot.pid,config.json,inbox,logs}`
  before starting. Never `rm -rf` the old workspace without a snapshot.

## Problem 7 — reactions but no reply (OAuth expired)

- **Symptom**: emoji reactions (👀) appear, but no text replies; service active.
- **Cause**: the Claude Code OAuth token expired; the plugin layer (reactions)
  still works, but claude returns `401` / "Please run /login".
- **Fix**: `tmux attach -t channel-<agent>` → `/login` → open URL → auth under
  Anthropic Max → detach. Prevent with a cron healthcheck that greps the tmux
  capture for `login`/`401`.
- **Lesson**: "active" ≠ "authenticated"; reactions without replies ⇒ check auth
  first.

## Problem 8 — agent self-destruction (`rm -rf` its own OAuth state) ⚠️

- **Symptom**: bot suddenly dies; status `activating (auto-restart)`, exit
  `0/SUCCESS`, restarting every 15s; `tmux capture-pane` → `no server running`.
- **Cause**: the agent used `sudo` to delete the directory holding its OAuth
  state (`~/.openclaw/` or `~/.claude/`). Real incident 2026-05-20: a "cleanup"
  removed root-owned subdirs along with OAuth + `.secrets/`.
- **Fix**: stop the service, run claude by hand with a TTY, `/login`, restore
  `.secrets` from a restic snapshot, restart.
- **Prevent (critical)**: permission rules — destructive sudo
  (`Bash(sudo rm:*)`, `Bash(sudo rm -rf:*)`, `Bash(rm -rf /home/*/.openclaw*)`,
  `Bash(rm -rf /home/*/.claude*)`) always in **deny**; blanket `Bash(sudo:*)` on
  a host with OAuth/secrets is a catastrophe.

## Problem 9 — tmux death loop

- **Symptom**: `activating (auto-restart)`, `status=0/SUCCESS`, ~15s restarts;
  `tmux capture-pane` → `no server running`.
- **Cause**: `Type=forking` expects the tmux server to persist, but it only lives
  while a window is open; claude in the pane dies (OAuth fail / wrong CWD /
  missing CLAUDE.md import / ENOENT on the plugin path) → window closes → session
  closes → tmux server stops → systemd sees "exited 0" → `Restart=on-failure`
  loops without fixing the cause.
- **Fix**: stop the service; run claude by hand from the unit's
  `WorkingDirectory` with the env sourced, read the real error, fix it, start.
  Add a watchdog cron checking `tmux has-session` separately from
  `systemctl is-active`.
- **Lesson**: "exit 0 SUCCESS" is misleading — check `tmux has-session`.

## Problem 10 — sudo deny baseline (what must always be blocked)

Even with broad sudo-allow, keep a baseline deny (deny beats allow):
`Bash(rm -rf /)`, `Bash(rm -rf ~)`, `Bash(rm -rf /home/*/.openclaw*)`,
`Bash(rm -rf /home/*/.claude*)`, `Bash(rm -rf /home/*/.secrets*)`,
`Bash(sudo rm -rf:*)`, `Bash(sudo userdel:*)`, `Bash(sudo chown -R:*)`,
`Bash(curl * | bash)`, `Bash(git push --force:*)`, `Bash(git reset --hard:*)`.
Smoke the permissions after install: destructive commands must be blocked,
`sudo systemctl restart X` may ask/allow.

## When nothing helps

```bash
journalctl -u channel-<agent> --since "1 hour ago" --no-pager -l   # Linux
tmux capture-pane -t channel-<agent> -p -S -200
ps -ef | grep bun | grep -v grep      # expect one `bun ./src/server.ts`
cat $TELEGRAM_STATE_DIR/logs/permissions.jsonl
cd <plugin> && bun test               # failing core tests ⇒ broken checkout, not env
```
