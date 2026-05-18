# Canary Telegram bot status

Recorded on 2026-05-14 PDT after the operator approved live testing with a separate canary Telegram bot token. Updated after the canary was switched from ACK mode to Claude fallback mode.

## Current migration stage

The migration is in the canary runtime smoke-test stage with a repo-local fallback bridge running.

Implemented and verified:

- repo-local canary supervisor scaffold: `scripts/dashi-channel-supervisor`;
- repo-local Telegram canary smoke runner: `scripts/dashi-telegram-canary-bot`;
- canary-only Claude fallback mode: `scripts/dashi-telegram-canary-bot --reply-mode claude --claude-max-budget-usd 0.20`;
- canary token stored outside git under the local runtime secret path;
- `tmux` session `orgrimmar-canary` started for the canary runner;
- Telegram API smoke poll succeeded before the tmux start;
- production token files, launchd jobs, gateway config, and production tmux sessions remain untouched.

Still not complete:

- the true Claude Code channel path is not running;
- channel flags are hidden from `claude --help`; parser probes accept `--channels` and `--dangerously-load-development-channels`, but live true-channel startup is not proven yet;
- sandboxed Claude auth/tmux checks may fail, but host-level checks verified Claude auth and host tmux access for the canary replacement;
- the fallback bridge is not the final billing-safe Claude channel plugin;
- no production agent has been cut over;
- billing classification, permission relay, parity, and rollback evidence remain open.

## Running canary process

The canary runner is launched in tmux with the token read only from the secret file:

```bash
tmux new-session -d -s orgrimmar-canary -c /Users/jasonqwwen/qwwiwi-channel-telegram-Claude-code 'env DASHI_CHANNEL_RUNTIME_ROOT=/Users/jasonqwwen/.claude-lab/shared/channel-runtime PYTHONUNBUFFERED=1 scripts/dashi-telegram-canary-bot --reply-mode claude --claude-max-budget-usd 0.20 --poll-timeout 20'
```

The command line does not contain the token value.

## Operator test

Send any message to the separate canary Telegram bot. Expected reply:

```text
<Claude-generated reply to the Telegram message>
```

The reply should not start with `dashi canary ack`. If Claude Code is unavailable, the bot sends a redacted `Claude fallback unavailable` message instead of leaking secrets.

## Canary-only Claude fallback bridge

The fallback bridge is implemented for canary testing only. It calls Claude Code through:

```bash
claude --print --max-budget-usd 0.20 -- '<redacted prompt built from the Telegram message>'
```

The command is invoked with an argument list, not through a shell, and the Telegram token is read only from the canary secret file. If Claude is unavailable, the bot sends a redacted `Claude fallback unavailable` message instead of an ACK.

The safe host-level replacement sequence used for the canary was:

```bash
tmux kill-session -t orgrimmar-canary
tmux new-session -d -s orgrimmar-canary -c /Users/jasonqwwen/qwwiwi-channel-telegram-Claude-code 'env DASHI_CHANNEL_RUNTIME_ROOT=/Users/jasonqwwen/.claude-lab/shared/channel-runtime PYTHONUNBUFFERED=1 scripts/dashi-telegram-canary-bot --reply-mode claude --claude-max-budget-usd 0.20 --poll-timeout 20'
```

Host-level verification before and after replacement:

```bash
claude auth status
claude --print --max-budget-usd 0.20 -- 'Respond with exactly: fallback-auth-probe'
tmux ls
tmux list-panes -t orgrimmar-canary -F '#{pane_current_command} #{pane_start_command}'
```

The `0.01` and `0.05` Claude probe budgets were too low for Claude Code CLI. `0.20` returned `fallback-auth-probe` and is the live canary limit.

## Inspection commands

```bash
DASHI_CHANNEL_RUNTIME_ROOT=/Users/jasonqwwen/.claude-lab/shared/channel-runtime scripts/dashi-channel-supervisor status canary --json
DASHI_CHANNEL_RUNTIME_ROOT=/Users/jasonqwwen/.claude-lab/shared/channel-runtime scripts/dashi-channel-supervisor logs canary
tmux capture-pane -t orgrimmar-canary -p -S -20
```

In Codex sandboxed shells, direct `tmux ls` may fail with `Operation not permitted`. Run it with host-level permission when checking the live tmux socket.

## Stop command

```bash
tmux kill-session -t orgrimmar-canary
```

Use this only for the canary tmux session. It does not affect production launchd jobs or production Telegram consumers.
