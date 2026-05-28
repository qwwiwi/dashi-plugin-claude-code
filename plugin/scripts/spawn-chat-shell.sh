#!/bin/sh
# spawn-chat-shell.sh — per-chat tmux session launcher.
#
# TASK-6 FIX-A B2 (2026-05-27): tmux's `-e KEY=VAL` only OVERLAYS the
# enumerated keys on top of the tmux server's global environment table.
# That global table is populated from the FIRST tmux client's parent env
# and persists for the daemon's lifetime. Any sensitive variable
# (TELEGRAM_BOT_TOKEN, OPENAI_API_KEY, ...) that lived in the orchestrator
# at first connect is still inherited by every new shell unless we
# explicitly clear it.
#
# Defence: wrap the child shell launch in `env -i` so the spawned process
# starts with a COMPLETELY EMPTY environment, then re-export only the
# variables explicitly handed to us via tmux `-e KEY=VAL` flags
# (CHAT_ID, MULTICHAT_STATE_DIR, CLAUDE_WORKSPACE_DIR, PATH, HOME, USER,
# LANG, LC_ALL, LANGUAGE, TERM, SHELL, TZ, COLORTERM, XDG_*, optionally
# POLICY_PATH / PERSONA_PATH).
#
# This script is invoked by tmux as the new-session command. tmux has
# already populated the per-session env via `-e` flags before invoking
# us, so $CHAT_ID etc. are available. We simply propagate them through
# `env -i` to guarantee NOTHING extra leaks from the tmux server's
# global env table.
#
# Usage (set by tmux-session-pool.ts spawnInternal):
#   tmux new-session -d -s NAME \
#     -e CHAT_ID=... -e MULTICHAT_STATE_DIR=... -e CLAUDE_WORKSPACE_DIR=... \
#     -e PATH=... -e HOME=... ... -c CWD -- \
#     /abs/path/spawn-chat-shell.sh CLAUDE_BIN [extra args...]

set -eu

# First positional arg: claude binary (or any executable to exec).
# Remaining args (if any) are passed through.
CLAUDE_BIN="${1:?spawn-chat-shell.sh: missing CLAUDE_BIN argument}"
shift

# Build the explicit allowlist of env vars to forward. Use `:-` to
# default to empty when unset — `env -i` with `KEY=` exports an empty
# value, which is fine for optional keys. tmux will not have populated
# anything outside the keys we passed via `-e`, so this list mirrors
# what the pool actually sets.
#
# Required (every spawn):
#   CHAT_ID, MULTICHAT_STATE_DIR, CLAUDE_WORKSPACE_DIR, PATH
# Strongly recommended (set when present in parent allowlisted env):
#   HOME, USER, LANG, LC_ALL, LANGUAGE, TERM, SHELL, TZ, COLORTERM,
#   XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME
# Optional (hook bookkeeping, set when policy-loader / persona pipeline
# wants them; absent in MVP):
#   POLICY_PATH, PERSONA_PATH
#
# FIX (2026-05-28): forward TMUX and TMUX_PANE through the env -i wipe.
# tmux sets these on the new-session command's environment (verified:
# this wrapper, run as that command, sees TMUX_PANE=%N before we exec).
# The consumer is the deployed per-chat entrypoint hook (in the agent
# workspace at chats/hooks/multichat-entrypoint.sh — NOT shipped in this
# repo; wired via TmuxSessionPool.entrypointScript). Its background
# inbox-watcher reads $TMUX_PANE to know which pane to `tmux send-keys`
# inbound messages into. Without it the watcher self-disables
# ("TMUX_PANE not set, watcher disabled") and the per-chat session never
# consumes its inbox — the whole chat_id->session routing silently dies.
# This regressed on 2026-05-27 when FIX-A B2 (env -i) and FIX-A B3
# (removal of the bare `-e TMUX_PANE` arg) landed together: B3's premise
# that "tmux populates TMUX_PANE regardless" is false once B2 wipes it.
#
# Why BOTH, not just TMUX_PANE: send-keys by pane id alone works only
# when the server is on tmux's DEFAULT socket; forwarding TMUX keeps the
# watcher correct under a custom socket (`tmux -L`) too. Forwarding TMUX
# does not widen the trust boundary — a same-UID process already reaches
# the default socket, and TMUX_PANE alone is enough to target any pane
# on it. (Cross-pane isolation between chats is a separate concern, not
# something this env wipe ever provided.) Neither value is a credential:
# TMUX is a socket path, TMUX_PANE a pane id — token isolation intact.

exec env -i \
  CHAT_ID="${CHAT_ID:-}" \
  MULTICHAT_STATE_DIR="${MULTICHAT_STATE_DIR:-}" \
  CLAUDE_WORKSPACE_DIR="${CLAUDE_WORKSPACE_DIR:-}" \
  TMUX="${TMUX:-}" \
  TMUX_PANE="${TMUX_PANE:-}" \
  PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}" \
  HOME="${HOME:-}" \
  USER="${USER:-}" \
  LANG="${LANG:-}" \
  LC_ALL="${LC_ALL:-}" \
  LANGUAGE="${LANGUAGE:-}" \
  TERM="${TERM:-xterm-256color}" \
  SHELL="${SHELL:-/bin/sh}" \
  TZ="${TZ:-}" \
  COLORTERM="${COLORTERM:-}" \
  XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-}" \
  XDG_DATA_HOME="${XDG_DATA_HOME:-}" \
  XDG_CACHE_HOME="${XDG_CACHE_HOME:-}" \
  POLICY_PATH="${POLICY_PATH:-}" \
  PERSONA_PATH="${PERSONA_PATH:-}" \
  "$CLAUDE_BIN" "$@"
