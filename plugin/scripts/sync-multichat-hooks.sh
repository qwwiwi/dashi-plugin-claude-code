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

if [[ "${CHANGED}" -eq 1 ]]; then
  echo "done: hooks synced. Restart long-lived per-chat sessions to pick up SessionStart changes."
else
  echo "done: already in sync."
fi
