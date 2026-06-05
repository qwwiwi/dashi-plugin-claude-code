# Migration steps: gateway → channel plugin

Ordered procedure. The doctor automates the checks; this is the human/agent
playbook around them. Commands are verbatim; substitute `<agent>`,
`<service-user>`, paths, and tokens.

> Concepts. **OLD** = Python daemon (`qwwiwi/jarvis-telegram-gateway`), spawns a
> new `claude -p` per message. **NEW** = Bun+TypeScript plugin, one live session,
> polls Telegram via `getUpdates`. Invariant: one process = one agent = one bot =
> one workspace. Migration deadline: **2026-06-15** (per-message spawn moves to a
> separate billing pool).

## 0. Pre-flight (the doctor checks most of these)

| Check | Command | Pass |
|---|---|---|
| OS | — | linux→systemd, macos→launchd |
| Claude Code ≥ 2.1 | `claude --version` | `2.1.x`+ (persistent welcome-accepts need `2.1.140+`) |
| Bun ≥ 1.3.14 | `bun --version` | `>= 1.3.14` |
| tmux | `which tmux` | found; **record the exact path** (it goes in the unit/plist) |
| Max login | `claude` then OAuth | login saved under the service user |
| Old gateway inventoried | see below | token, allowed ids, workspace, unit name recorded |
| Tokens on hand | — | `TELEGRAM_BOT_TOKEN`, your numeric id (`@userinfobot`), group id if any |
| **Workspace placement planned** | — | plugin goes under `<workspace>/.claude/...` |
| Backup taken | `tar czf` (below) | archive path recorded |
| Quiet window agreed | — | users warned, rollback understood |

Inventory the old gateway:
```bash
# Linux
sudo systemctl list-units --type=service | grep -iE "gateway|jarvis"
sudo systemctl cat <gateway-unit> | grep -E "EnvironmentFile|Environment|WorkingDirectory"
ps -ef | grep -E "python.*gateway|claude.*-p" | grep -v grep
```
Record four things: bot token, allowed user ids, old workspace path, unit name.

Backup before any change:
```bash
sudo tar czf /var/backups/pre-plugin-migration-$(date +%Y%m%d).tgz \
  ~/jarvis-telegram-gateway ~/.claude-lab \
  /etc/systemd/system/*gateway*.service /etc/dashi-plugin 2>/dev/null
```

**Workspace placement is load-bearing.** The plugin MUST live inside the agent
workspace so Claude Code's upward CWD search finds the project `CLAUDE.md`:
```
✓ ~/.claude-lab/<agent>/.claude/dashi-plugin-claude-code/plugin/
✗ ~/projects/dashi-plugin-claude-code/plugin/    (identity drift — bot answers as default Claude)
✗ /opt/dashi-plugin/plugin/
```

## 1–2. Clone the plugin INSIDE the workspace and build

```bash
mkdir -p ~/.claude-lab/<agent>/.claude
cd ~/.claude-lab/<agent>/.claude
git clone https://github.com/qwwiwi/dashi-plugin-claude-code.git
cd dashi-plugin-claude-code/plugin
bun install
bun run typecheck     # 0 errors
bun test tests/       # if core tests fail, STOP — broken checkout, do not continue
```

## 3. Carry over identity and config

```bash
cp <old-workspace>/CLAUDE.md   ~/.claude-lab/<agent>/.claude/
cp -a <old-workspace>/core     ~/.claude-lab/<agent>/.claude/
cp <old-workspace>/.mcp.json   ~/.claude-lab/<agent>/.claude/
```
Do **not** delete the old path (rollback needs it). Do **not** create a second
`CLAUDE.md` inside the plugin directory — the upward search would pick the nearer
one and kill identity.

## 4. channel.env (map the old variables)

Copy `examples/channel.env.example`. Linux →
`/etc/dashi-plugin/<agent>/channel.env` (`chown root:<group>`, `chmod 640`);
macOS → `~/.claude-lab/<agent>/secrets/channel.env` (`chmod 600`).

| Gateway (Python) | Plugin (channel.env) |
|---|---|
| `TELEGRAM_BOT_TOKEN` | `TELEGRAM_BOT_TOKEN` |
| `ALLOWED_USER_IDS` | `TELEGRAM_ALLOWED_USER_IDS` |
| `ALLOWED_GROUP_IDS` | `TELEGRAM_ALLOWED_CHAT_IDS` |
| `WORKSPACE_DIR` | `TELEGRAM_WORKSPACE_ROOT` (points at `<agent>/.claude/`) |
| `WEBHOOK_PORT` | `TELEGRAM_WEBHOOK_PORT` |
| (new) | `TELEGRAM_EXPECTED_BOT_ID` (digits before `:` in the token, anti-spoof) |
| (new) | `AGENT_ID` |

Multiple agents on one host → distinct `TELEGRAM_WEBHOOK_PORT`.

## 5. Supervisor unit with the correct CWD

The bypass flag in both is `--dangerously-load-development-channels server:dashi-channel`.

**Linux** `/etc/systemd/system/channel-<agent>.service` (from
`examples/systemd-unit.service.example`):
```ini
[Service]
Type=forking
User=<service-user>
EnvironmentFile=/etc/dashi-plugin/<agent>/channel.env
Environment=HOME=/home/<service-user>
Environment=PATH=/home/<service-user>/.bun/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=/home/<service-user>/.claude-lab/<agent>/.claude/dashi-plugin-claude-code/plugin
ExecStart=/usr/bin/tmux new-session -d -s channel-<agent> \
  claude --dangerously-load-development-channels server:dashi-channel
ExecStartPost=/bin/sh -c 'sleep 6 && /usr/bin/tmux send-keys -t channel-<agent> Enter && sleep 2 && /usr/bin/tmux send-keys -t channel-<agent> Enter'
ExecStop=/usr/bin/tmux kill-session -t channel-<agent>
Restart=on-failure
RestartSec=15s
```
`Type=forking` is required (`tmux new-session -d` forks). Activate:
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now channel-<agent>
sudo systemctl status channel-<agent> --no-pager -l
```

**macOS** `~/Library/LaunchAgents/com.dashi-plugin.channel-<agent>.plist` (from
`examples/launchd-plist.example.plist`). Secrets are sourced from the env file in
`ProgramArguments`, never inlined. `WorkingDirectory` = `.../plugin`,
`RunAtLoad=true`, `KeepAlive.Crashed=true`, logs to
`~/Library/Logs/dashi-plugin/`. Load:
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dashi-plugin.channel-<agent>.plist
launchctl kickstart gui/$(id -u)/com.dashi-plugin.channel-<agent>
```

## 6. Pass the two welcome prompts (first run)

1. "Allow external CLAUDE.md file imports?" → `1` (the `@-include`s target
   `<workspace>/core/*`, above CWD, so they read as external).
2. "--dangerously-load-development-channels is for local development only" → `1`.

`ExecStartPost`/plist send Enter automatically. If not, attach and press Enter:
```bash
tmux attach -t channel-<agent>     # Linux: sudo -u <service-user> tmux attach ...
```
Success line: `Listening for channel messages from: server:dashi-channel`.

Persistent fix (Claude Code `2.1.140+`) — capture the exact accepted keys from
`~/.claude/settings.json` after passing the prompts once, rather than guessing.

## 7. Cutover — order is critical (never two consumers on one token)

```bash
sudo systemctl stop <gateway-unit> && sudo systemctl disable <gateway-unit>
sleep 30                                  # let Telegram drop the old long-poll client
sudo systemctl restart channel-<agent>
tmux capture-pane -t channel-<agent> -p | tail -30   # welcome? press Enter
# send the bot a message — expect 👀 → ⚙️ → ✅ and a real reply
```
A `409 Conflict` here means both processes hold the token — see Problem 3.

## 8. Verify identity + memory parity

In tmux: `/memory` shows BOTH CLAUDE.md (global + project). In Telegram ask "who
are you?" — the answer must be the agent's name, not "I'm Claude, an AI assistant
made by Anthropic". If it's default Claude, `WorkingDirectory` is wrong (Problem 2).

## 9. Hooks (optional — status + memory)

```bash
bash <plugin>/scripts/install-hooks.sh \
  --settings ~/.claude/settings.json \
  --chat-id <your-telegram-chat-id> \
  --webhook-url http://127.0.0.1:8089/hooks/agent \
  --agent-id <agent>
# then restart the channel (externally — never self-restart)
```
This registers five hook events with marker `dashi-channel-hook`. The webhook
token is read from runtime env and is **never** written to settings.json.

## 10. Remove the gateway — after 7–14 days, not immediately

Snapshot, then remove the unit and the gateway dir. Keep the old workspace ~a
month longer.

## Rollback

```bash
sudo systemctl stop channel-<agent>
sleep 30
sudo systemctl start <gateway-unit>
# smoke in Telegram
```
Because cutover does not delete the old gateway or workspace, rollback is always
available. From backup: `sudo tar xzf /var/backups/pre-plugin-migration-<date>.tgz -C /`.

## Linux vs macOS cheat-sheet

| | Linux (systemd) | macOS (launchd) |
|---|---|---|
| Service file | `/etc/systemd/system/channel-<agent>.service` | `~/Library/LaunchAgents/com.dashi-plugin.channel-<agent>.plist` |
| Status | `systemctl status channel-<agent>` | `launchctl print gui/$(id -u)/com.dashi-plugin.channel-<agent>` |
| Restart | `systemctl restart channel-<agent>` | `launchctl kickstart -k gui/$(id -u)/com.dashi-plugin.channel-<agent>` |
| Stop | `systemctl stop channel-<agent>` | `launchctl kill SIGTERM gui/$(id -u)/com.dashi-plugin.channel-<agent>` |
| Logs | `journalctl -u channel-<agent> -n 50` | `tail ~/Library/Logs/dashi-plugin/channel-<agent>.{out,err}.log` |
| tmux path | `/usr/bin/tmux` | `/opt/homebrew/bin/tmux` (Apple Silicon) / `/usr/local/bin/tmux` (Intel) |
| Auto-start | `systemctl enable` (works headless) | `RunAtLoad=true` — only after GUI login (use `/Library/LaunchDaemons/` for pre-login) |
