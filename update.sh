#!/usr/bin/env bash
# Update a clean clone; never kill the channel carrying the current conversation.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
[[ -f "$REPO/scripts/lifecycle-common.sh" ]] || { echo 'Missing lifecycle helper' >&2; exit 1; }
source "$REPO/scripts/lifecycle-common.sh"
STATE_DIR="${TELEGRAM_STATE_DIR:-}"; SETTINGS=''; RESTART=0; DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-dir|--settings) [[ $# -ge 2 && -n "$2" ]] || fail 'Option requires a value'; if [[ "$1" == --state-dir ]]; then STATE_DIR="$2"; else SETTINGS="$2"; fi; shift 2;;
    --restart) RESTART=1; shift;; --dry-run) DRY_RUN=1; shift;;
    -h|--help) echo 'Usage: ./update.sh [--state-dir PATH --settings PATH] [--dry-run] [--restart]'; exit 0;;
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
cd "$REPO"
CURRENT="$(git rev-parse HEAD)"
CHANGES="$(git status --porcelain --untracked-files=all)"
if [[ -n "$CHANGES" ]]; then echo 'Refusing update: local changes:' >&2; echo "$CHANGES" >&2; exit 1; fi
read_context
if [[ "$RESTART" == 1 ]] && inside_channel; then restart_hint; fail "Refusing --restart inside tmux session $SESSION; run from an external terminal"; fi
if [[ "$DRY_RUN" == 1 ]]; then
  echo "DRY RUN: record current commit $CURRENT; timestamp backup config/env/settings/metadata/service"
  echo 'DRY RUN: baseline (cd plugin && bun test); git pull --ff-only; (cd plugin && bun install && bun test); re-run files with new failures once; rollback on confirmed new failures, runner or dependency failure'
  echo 'DRY RUN: re-register standard plugin/scripts/install-hooks.sh; doctor --check-latest summary'
  restart_hint
  exit 0
fi
require_file "$REPO/scripts/test-failure-baseline.ts"
# Keep reports outside the checkout: the initial clean-tree guard must remain meaningful.
TEST_REPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/channel-update.XXXXXXXX")"
trap 'rm -f "$TEST_REPORT_DIR/before.log" "$TEST_REPORT_DIR/after.log" "$TEST_REPORT_DIR/before.json" "$TEST_REPORT_DIR/after.json"; rmdir "$TEST_REPORT_DIR"' EXIT
capture_tests() {
  local phase="$1" label="$2" status=0
  (cd "$REPO/plugin" && NO_COLOR=1 FORCE_COLOR=0 bun test) >"$TEST_REPORT_DIR/$phase.log" 2>&1 || status=$?
  cat "$TEST_REPORT_DIR/$phase.log"
  bun "$REPO/scripts/test-failure-baseline.ts" snapshot "$TEST_REPORT_DIR/$phase.log" "$status" "$TEST_REPORT_DIR/$phase.json" "$label"
}
echo "Recorded commit: $CURRENT"
echo 'Running plugin tests before pull to record baseline failures'
capture_tests before Baseline || fail 'Baseline test runner unavailable; checkout was not updated'
for file in "$CONFIG_FILE" "$ENV_FILE" "$SETTINGS" "$STATE_DIR/install.json" "$SERVICE" "$STATE_DIR/channel-wrapper.sh" "$STATE_DIR/channel.mcp.json"; do backup "$file"; done
rollback() {
  echo "Update validation failed. Restoring recorded commit $CURRENT; configuration backups retained." >&2
  git reset --hard "$CURRENT"
  echo 'Restoring dependencies for the recorded revision (channel was not restarted).'
  (cd "$REPO/plugin" && bun install) || echo 'Dependency restoration failed; rerun bun install before restarting.' >&2
  exit 1
}
echo 'Updating checkout: git pull --ff-only'
git pull --ff-only
echo 'Installing plugin dependencies'
(cd "$REPO/plugin" && bun install) || rollback
echo 'Running plugin tests after pull and comparing failure names'
capture_tests after After-update || rollback
# The comparison re-runs only files with new failures before confirming a regression.
bun "$REPO/scripts/test-failure-baseline.ts" compare "$TEST_REPORT_DIR/before.json" "$TEST_REPORT_DIR/after.json" || rollback
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
