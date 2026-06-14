#!/usr/bin/env bash
# sync-multichat-hooks.sh — deploy multichat per-chat hooks from the repo to
# the live hooks directory the per-chat sessions actually execute.
#
# Why this exists (2026-06-10): the multichat file-send feature was committed
# to src/chats/hooks/ but the deployed copies under
# ~/.claude-lab/thrall/.claude/chats/hooks/ were never synced, so a live chat
# session neither learned the [[file: …]] marker (stale session-start.sh) nor
# could the Stop hook extract it (stale stop-to-outbox.py). Hook sync is part
# of EVERY multichat activation — run this script instead of copying by hand.
#
# Behavior:
#   * Backs up each deployed file as <name>.bak.<timestamp> before overwrite.
#   * Verifies the copy with diff and exits non-zero on any mismatch.
#   * Restores per-chat skill discovery: symlinks <workspace>/chats/.claude/skills
#     -> ../../skills so the multichat "project" sees the agent's real skills
#     (a per-chat session's CWD is <workspace>/chats with its own .claude/, so
#     Claude Code looks for skills under chats/.claude/skills, which otherwise
#     does not exist — the agent loses every project skill in group chats).
#   * Registers multichat-hot-memory.sh in chats/.claude/settings.json
#     SessionStart (idempotent) so per-chat sessions get the hot memory layer
#     (handoff/recent), not just the persona.
#   * Takes effect immediately for Stop/PreToolUse (hooks exec from disk per
#     event). SessionStart context (e.g. the file-marker capability note) only
#     reaches a session at spawn — restart long-lived per-chat tmux sessions
#     (tmux kill-session -t multichat-<chat_id>; the router respawns on the
#     next inbound message).
#
# Usage:
#   scripts/sync-multichat-hooks.sh [--deploy-dir /abs/path]
# Default deploy dir: ~/.claude-lab/thrall/.claude/chats/hooks

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_HOOKS="${SCRIPT_DIR}/../src/chats/hooks"
DEPLOY_DIR="${HOME}/.claude-lab/thrall/.claude/chats/hooks"

if [[ "${1:-}" == "--deploy-dir" ]]; then
  DEPLOY_DIR="${2:?--deploy-dir requires a path}"
fi

HOOK_FILES=(
  stop-to-outbox.py
  session-start.sh
  pre-tool-use.sh
  multichat-entrypoint.sh
  multichat-hot-memory.sh
)

if [[ ! -d "${REPO_HOOKS}" ]]; then
  echo "sync-multichat-hooks: repo hooks dir not found: ${REPO_HOOKS}" >&2
  exit 1
fi
if [[ ! -d "${DEPLOY_DIR}" ]]; then
  echo "sync-multichat-hooks: deploy dir not found: ${DEPLOY_DIR}" >&2
  exit 1
fi

TS="$(date +%Y%m%d-%H%M%S)"
CHANGED=0

for f in "${HOOK_FILES[@]}"; do
  src="${REPO_HOOKS}/${f}"
  dst="${DEPLOY_DIR}/${f}"
  if [[ ! -f "${src}" ]]; then
    echo "sync-multichat-hooks: missing in repo, skipping: ${f}" >&2
    continue
  fi
  if [[ -f "${dst}" ]] && diff -q "${src}" "${dst}" >/dev/null; then
    echo "unchanged ${f}"
    continue
  fi
  if [[ -f "${dst}" ]]; then
    cp -p "${dst}" "${dst}.bak.${TS}"
    echo "backup    ${f} -> ${f}.bak.${TS}"
  fi
  cp -p "${src}" "${dst}"
  echo "deployed  ${f}"
  CHANGED=1
done

# Verify: every repo hook must now match its deployed copy.
for f in "${HOOK_FILES[@]}"; do
  src="${REPO_HOOKS}/${f}"
  [[ -f "${src}" ]] || continue
  if ! diff -q "${src}" "${DEPLOY_DIR}/${f}" >/dev/null; then
    echo "sync-multichat-hooks: VERIFY FAILED for ${f}" >&2
    exit 1
  fi
done

# ── Per-chat project wiring ────────────────────────────────────────────────
# DEPLOY_DIR is <workspace>/chats/hooks, so the multichat "project" config dir
# is its sibling <workspace>/chats/.claude. Both steps below are idempotent.
CHATS_CLAUDE="$(dirname "${DEPLOY_DIR}")/.claude"

# 1. Skill discovery: symlink chats/.claude/skills -> ../../skills so the
#    per-chat session (whose project root is chats/) finds the agent's real
#    skills at <workspace>/skills instead of an empty/absent dir.
if [[ -d "${CHATS_CLAUDE}" ]]; then
  if [[ -e "${CHATS_CLAUDE}/skills" || -L "${CHATS_CLAUDE}/skills" ]]; then
    echo "unchanged skills symlink (${CHATS_CLAUDE}/skills)"
  elif [[ -d "$(dirname "${CHATS_CLAUDE}")/../skills" ]]; then
    ln -s ../../skills "${CHATS_CLAUDE}/skills"
    echo "linked    skills -> ../../skills (${CHATS_CLAUDE}/skills)"
    CHANGED=1
  else
    echo "sync-multichat-hooks: no <workspace>/skills dir; skipping skills symlink" >&2
  fi

  # 2. Register multichat-hot-memory.sh in chats/.claude/settings.json
  #    SessionStart (idempotent). The persona hook (session-start.sh) stays
  #    untouched; this is an additive second SessionStart hook.
  SETTINGS="${CHATS_CLAUDE}/settings.json"
  if [[ -f "${SETTINGS}" ]] && command -v python3 >/dev/null 2>&1; then
    if python3 - "${SETTINGS}" "${DEPLOY_DIR}/multichat-hot-memory.sh" <<'PY'
import json, sys
settings_path, hook_cmd = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(settings_path))
except Exception:
    print("SKIPPED: settings.json unreadable/malformed — "
          "register multichat-hot-memory.sh in SessionStart by hand")
    raise SystemExit(0)
ss = d.setdefault("hooks", {}).setdefault("SessionStart", [])
if not ss:
    ss.append({"matcher": "", "hooks": []})
arr = ss[0].setdefault("hooks", [])
if any(h.get("command", "").endswith("multichat-hot-memory.sh") for h in arr):
    print("ALREADY")
else:
    arr.append({"type": "command", "command": hook_cmd, "timeout": 8000})
    json.dump(d, open(settings_path, "w"), ensure_ascii=False, indent=2)
    print("REGISTERED")
PY
    then :; fi
  fi
else
  echo "sync-multichat-hooks: no ${CHATS_CLAUDE}; skipping skills symlink + hook registration" >&2
fi

if [[ "${CHANGED}" -eq 1 ]]; then
  echo "done: hooks synced. Restart long-lived per-chat sessions to pick up SessionStart changes."
else
  echo "done: already in sync."
fi
