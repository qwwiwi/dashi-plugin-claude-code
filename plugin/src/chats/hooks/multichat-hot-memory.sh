#!/usr/bin/env bash
# multichat-hot-memory.sh — SessionStart hook for per-chat (multichat) sessions.
#
# Why this exists (2026-06-14): a per-chat tmux session has its CWD at
# `<workspace>/chats`, which carries its own `<workspace>/chats/.claude/`.
# Claude Code therefore treats `chats/` as the project root, so the session
# loads NONE of the agent's project skills (they live in `<workspace>/skills`,
# not `<workspace>/chats/.claude/skills`) and gets no memory boot — only the
# per-chat persona from session-start.sh. The agent ends up "dumber" in group
# chats than in its DM. This hook restores the HOT memory layer: it refreshes
# handoff.md from recent.md (best-effort, agent-specific) and injects it as
# SessionStart `additionalContext`. The companion skills symlink (created by
# scripts/sync-multichat-hooks.sh) restores skill discovery.
#
# Reliability note: injecting via additionalContext is deliberate — relying on
# CLAUDE.md's `@include core/hot/handoff.md` is timing-dependent (the include
# is read when CLAUDE.md loads, which can race a separate refresh hook).
#
# Failure modes (never block the session):
#   * MULTICHAT_STATE_DIR unset  -> exit 0 silently (master session; not ours).
#   * python3 missing            -> exit 0.
#   * CLAUDE_WORKSPACE_DIR unset  -> exit 0 (cannot locate hot memory).
#   * handoff unreadable / empty -> exit 0 (no injection).
set -uo pipefail

# Multichat-only: the master/host session never sets MULTICHAT_STATE_DIR, so
# this guard keeps the master session free of per-chat hot-memory injection.
[[ -z "${MULTICHAT_STATE_DIR:-}" ]] && exit 0
command -v python3 >/dev/null 2>&1 || exit 0

WS="${CLAUDE_WORKSPACE_DIR:-}"
[[ -z "${WS}" ]] && exit 0
HANDOFF="${WS}/core/hot/handoff.md"

# Best-effort refresh handoff.md from recent.md (last 10). The refresher is an
# agent-specific hook at `<agent>/hooks/inject-hot-context.sh` (WS is
# `<agent>/.claude`, so its parent is `<agent>`). Absent/failed -> we still
# inject whatever handoff.md already holds. Never fatal.
AGENT_HOME="$(dirname "${WS}")"
AGENT_NAME="$(basename "${AGENT_HOME}")"
INJECT="${AGENT_HOME}/hooks/inject-hot-context.sh"
[[ -x "${INJECT}" ]] && bash "${INJECT}" "${AGENT_NAME}" 10 >/dev/null 2>&1 || true

HANDOFF_PATH="${HANDOFF}" python3 - <<'PY' || exit 0
import json, os
p = os.environ.get("HANDOFF_PATH", "")
try:
    hot = open(p, encoding="utf-8").read()
except Exception:
    raise SystemExit(0)
if not hot.strip():
    raise SystemExit(0)
ctx = "## HOT MEMORY (recent, last 10)\n\n" + hot
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart",
      "additionalContext": ctx}}, ensure_ascii=False))
PY
