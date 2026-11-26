#!/usr/bin/env bash
# Update a clean clone; never kill the channel carrying the current conversation.
set -euo pipefail
# Update never needs the bot token: drop it before any external command (dirname, claude, bun).
unset TELEGRAM_BOT_TOKEN
REPO="$(cd "$(dirname "$0")" && pwd)"
[[ -f "$REPO/scripts/lifecycle-common.sh" ]] || { echo 'Missing lifecycle helper' >&2; exit 1; }
source "$REPO/scripts/lifecycle-common.sh"
STATE_DIR="${TELEGRAM_STATE_DIR:-}"; SETTINGS=''; RESTART=0; DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-dir|--settings) [[ $# -ge 2 && -n "$2" ]] || fail 'Option requires a value'; if [[ "$1" == --state-dir ]]; then STATE_DIR="$2"; else SETTINGS="$2"; fi; shift 2;;
    --restart) RESTART=1; shift;; --dry-run) DRY_RUN=1; shift;;
    -h|--help) echo 'Usage: ./update.sh [--state-dir PATH --settings PATH] [--dry-run] [--restart]'; echo 'Refuses to start if the checkout has any uncommitted change (tracked edits or untracked files). If dependency install or tests fail after the pull, it runs git reset --hard to the recorded commit: tracked files only; untracked and ignored files are never deleted.'; echo 'Refuses to start if the channel has no explicit owner (allowed_user_ids in config.json or TELEGRAM_ALLOWED_USER_IDS); the pulled code is checked again before tests and any restart (rollback on refusal); it never writes the ID itself.'; echo 'Run it as the account that owns the installation (the service user): the owner check executes the channel env file and refuses any other account, root included. Restart with a separate sudo command.'; exit 0;;
    *) fail 'Unknown option (use --help)';;
  esac
done
# A clone may serve several agents: require an unambiguous recorded installation.
if [[ -z "$STATE_DIR" ]]; then
  matches=()
  for candidate in "$HOME"/.claude/channels/*/install.json; do [[ ! -f "$candidate" ]] || matches+=("${candidate%/install.json}"); done
  [[ ${#matches[@]} == 1 ]] || fail 'Select the installation with --state-dir PATH or TELEGRAM_STATE_DIR'
  STATE_DIR="${matches[0]}"
fi
absolute "$STATE_DIR"; platform; prerequisites
# Since #157 the runtime refuses to start without an explicit owner: ask the installed code's own
# loadConfig under the launcher env and stop before switching code or restarting.
PROBE="$REPO/plugin/scripts/config-probe.ts"
require_file "$PROBE"
bun "$PROBE" --state-dir "$STATE_DIR" || exit 1
cd "$REPO"
CURRENT="$(git rev-parse HEAD)"
CHANGES="$(git status --porcelain --untracked-files=all)"
if [[ -n "$CHANGES" ]]; then echo 'Refusing update: local changes:' >&2; echo "$CHANGES" >&2; exit 1; fi
read_context
if [[ "$RESTART" == 1 ]] && inside_channel; then restart_hint; fail "Refusing --restart inside tmux session $SESSION; run from an external terminal"; fi
if [[ "$DRY_RUN" == 1 ]]; then
  echo "DRY RUN: record current commit $CURRENT; timestamp backup settings/metadata/service/wrapper/mcp (never channel.env)"
  echo 'DRY RUN: git pull --ff-only; (cd plugin && bun install && owner/config probe of the new code && bun test with TELEGRAM_* cleared); rollback to recorded commit if dependencies, probe or tests fail'
  echo 'DRY RUN: re-register standard plugin/scripts/install-hooks.sh; doctor --check-latest summary'
  restart_hint
  exit 0
fi
# channel.env and config.json are never rewritten by update: no backup (the env file holds the plaintext token).
for file in "$SETTINGS" "$STATE_DIR/install.json" "$SERVICE" "$STATE_DIR/channel-wrapper.sh" "$STATE_DIR/channel.mcp.json"; do backup "$file"; done
echo "Recorded commit: $CURRENT"
echo 'Updating checkout: git pull --ff-only'
git pull --ff-only
rollback() {
  echo "Update validation failed. Restoring recorded commit $CURRENT; configuration backups retained." >&2
  git reset --hard "$CURRENT"
  echo 'Restoring dependencies for the recorded revision (channel was not restarted).'
  (cd "$REPO/plugin" && bun install) || echo 'Dependency restoration failed; rerun bun install before restarting.' >&2
  exit 1
}
echo 'Installing and testing plugin dependencies'
# Tests must never see live TELEGRAM_* settings (real state dir, webhook): run them with all of those cleared.
CLEAR_TELEGRAM=(); while IFS= read -r name; do CLEAR_TELEGRAM+=(-u "$name"); done < <(compgen -e | grep '^TELEGRAM_' || true)
# The pulled code decides whether the channel would start: probe it before tests, hooks and any restart.
(cd "$REPO/plugin" && bun install && require_file "$PROBE" && bun "$PROBE" --state-dir "$STATE_DIR" && env ${CLEAR_TELEGRAM[@]+"${CLEAR_TELEGRAM[@]}"} bun test) || rollback
require_file "$REPO/plugin/scripts/install-hooks.sh"
echo 'Re-registering standard plugin hooks'
TELEGRAM_STATE_DIR="$STATE_DIR" bash "$REPO/plugin/scripts/install-hooks.sh" --settings "$SETTINGS" --chat-id "$CHAT_ID" --webhook-url "$WEBHOOK_URL" --agent-id "$AGENT"
run_doctor latest
restart_hint
if [[ "$RESTART" == 1 ]]; then
  # Check again after tests: never sever an active conversation.
  if inside_channel; then fail "Refusing restart inside tmux session $SESSION"; fi
  if [[ "$PLATFORM" == Linux ]]; then
    if [[ "$(id -u)" == 0 ]]; then systemctl restart "channel-$AGENT.service"
    else echo 'Run the printed sudo restart command externally; no automatic privilege escalation.'; fi
  else launchctl kickstart -k "gui/$(id -u)/com.dashi-plugin.channel-$AGENT"; fi
fi
echo 'Update validated. Verify a real Telegram DM after the external restart.'
