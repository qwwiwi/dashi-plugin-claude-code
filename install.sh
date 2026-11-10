#!/usr/bin/env bash
# One-command clone installation; never installs OS packages or escalates privileges.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
[[ -f "$REPO/scripts/lifecycle-common.sh" ]] || { echo 'Missing lifecycle helper' >&2; exit 1; }
source "$REPO/scripts/lifecycle-common.sh"
AGENT="${INSTALL_AGENT:-${AGENT_ID:-}}"; WORKSPACE="${TELEGRAM_WORKSPACE_ROOT:-}"
STATE_DIR="${TELEGRAM_STATE_DIR:-}"; SETTINGS=''; OWNER_ID="${TELEGRAM_OWNER_ID:-${TELEGRAM_ALLOWED_USER_IDS:-}}"
TOKEN="${TELEGRAM_BOT_TOKEN:-}"; DRY_RUN=0; START=0; NONINTERACTIVE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent|--workspace|--state-dir|--settings|--owner-id)
      [[ $# -ge 2 && -n "$2" ]] || fail 'Option requires a value'
      case "$1" in --agent) AGENT="$2";; --workspace) WORKSPACE="$2";; --state-dir) STATE_DIR="$2";; --settings) SETTINGS="$2";; --owner-id) OWNER_ID="$2";; esac; shift 2;;
    --dry-run) DRY_RUN=1; shift;; --start) START=1; shift;; --non-interactive) NONINTERACTIVE=1; shift;;
    -h|--help) echo 'Usage: ./install.sh [--agent NAME --workspace PATH --owner-id ID --state-dir PATH --settings PATH] [--non-interactive] [--dry-run] [--start]'; echo 'The bot token is never an argument (visible in ps and shell history): use the TELEGRAM_BOT_TOKEN env or the hidden prompt; TELEGRAM_OWNER_ID supplies the installer owner ID.'; exit 0;;
    --bot-token|--bot-token=*) fail 'The bot token is not accepted as an argument (visible in ps and shell history): set TELEGRAM_BOT_TOKEN or use the hidden prompt';;
    *) fail 'Unknown option (use --help)';;
  esac
done
if [[ "$NONINTERACTIVE" == 0 && -t 0 ]]; then
  [[ -n "$AGENT" ]] || read -r -p 'Agent name: ' AGENT
  [[ -n "$WORKSPACE" ]] || read -r -p 'Workspace (absolute path): ' WORKSPACE
  [[ -n "$OWNER_ID" ]] || read -r -p 'Telegram owner ID (numeric): ' OWNER_ID
  if [[ -z "$TOKEN" ]]; then read -r -s -p 'Telegram bot token (hidden): ' TOKEN; echo; fi
fi
[[ "$OWNER_ID" =~ ^[1-9][0-9]*$ && ${#OWNER_ID} -le 16 ]] || fail 'Telegram owner ID is required: --owner-id ID or TELEGRAM_OWNER_ID (positive numeric ID)'
[[ ${#OWNER_ID} -lt 16 || "$OWNER_ID" < 9007199254740992 ]] || fail 'Telegram owner ID exceeds the safe integer range'
[[ "$AGENT" =~ ^[a-z][a-z0-9_-]*$ ]] || fail 'Agent name must start with a lowercase letter and contain only a-z, 0-9, _ or -'
[[ -n "$WORKSPACE" ]] || fail 'Workspace path required: --workspace PATH'
absolute "$WORKSPACE"
# Token syntax prevents multiline/env injection; never include the rejected value in errors.
[[ "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] || fail 'Bot token required: hidden prompt or TELEGRAM_BOT_TOKEN'
STATE_DIR="${STATE_DIR:-$HOME/.claude/channels/$AGENT}"; SETTINGS="${SETTINGS:-$WORKSPACE/.claude/settings.json}"
absolute "$STATE_DIR"; absolute "$SETTINGS"
platform; prerequisites
for file in scripts/render-install.ts plugin/scripts/install-hooks.sh examples/config.example.json examples/channel.env.example skills/doctor-dashi-plugin/scripts/doctor.ts; do require_file "$REPO/$file"; done
ENV_FILE="$STATE_DIR/channel.env"; SESSION="channel-$AGENT"
if [[ "$DRY_RUN" == 1 ]]; then
  echo "DRY RUN: create workspace $WORKSPACE and private state $STATE_DIR"
  echo 'DRY RUN: render config and private mode-600 channel.env from examples; preserve existing config/env; timestamp backups before rewriting settings/service/wrapper/metadata'
  echo "DRY RUN: (cd $REPO/plugin && bun install)"
  echo "DRY RUN: plugin/scripts/install-hooks.sh --settings $SETTINGS --chat-id $OWNER_ID --agent-id $AGENT (standard plugin hooks only)"
  echo 'DRY RUN: render autonomous foreground tmux service (boot and crash recovery)'
else
  echo "Installing dependencies in $REPO/plugin"
  (cd "$REPO/plugin" && bun install)
  echo 'Rendering config/env and service from examples (credentials hidden)'
  INSTALL_AGENT="$AGENT" INSTALL_WORKSPACE="$WORKSPACE" INSTALL_STATE_DIR="$STATE_DIR" INSTALL_SETTINGS="$SETTINGS" INSTALL_PLATFORM="$PLATFORM" INSTALL_REPO="$REPO" INSTALL_HOME="$HOME" INSTALL_CLAUDE="$(command -v claude)" INSTALL_TMUX="$(command -v tmux)" INSTALL_BUN="$(command -v bun)" TELEGRAM_BOT_TOKEN="$TOKEN" TELEGRAM_OWNER_ID="$OWNER_ID" bun "$REPO/scripts/render-install.ts"
  unset TOKEN TELEGRAM_BOT_TOKEN
  read_context
  backup "$SETTINGS"
  echo 'Registering standard plugin hooks'
  TELEGRAM_STATE_DIR="$STATE_DIR" bash "$REPO/plugin/scripts/install-hooks.sh" --settings "$SETTINGS" --chat-id "$CHAT_ID" --webhook-url "$WEBHOOK_URL" --agent-id "$AGENT"
fi
if [[ "$PLATFORM" == Linux ]]; then
  echo 'Register the staged service and enable boot startup (requires sudo):'
  printf 'sudo install -m 644 %q %q\n' "$STATE_DIR/channel-$AGENT.service" "/etc/systemd/system/channel-$AGENT.service"
  echo 'sudo systemctl daemon-reload'
  printf 'sudo systemctl enable %q\n' "channel-$AGENT.service"
  if [[ "$START" == 1 ]]; then printf 'sudo systemctl start %q\n' "channel-$AGENT.service"; echo 'Run these sudo commands externally; no automatic privilege escalation.'; fi
else
  echo 'LaunchAgent rendered with RunAtLoad and crash recovery; starts at next GUI login after registration.'
  printf 'Register/start: launchctl bootstrap %q %q\n' "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.dashi-plugin.channel-$AGENT.plist"
  if [[ "$START" == 1 && "$DRY_RUN" == 0 ]]; then
    if inside_channel; then fail "Cannot start/restart own tmux session $SESSION; use an external terminal"; fi
    if launchctl print "gui/$(id -u)/com.dashi-plugin.channel-$AGENT" >/dev/null 2>&1; then launchctl kickstart -k "gui/$(id -u)/com.dashi-plugin.channel-$AGENT"
    else launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.dashi-plugin.channel-$AGENT.plist"; fi
  fi
fi
if [[ "$DRY_RUN" == 1 ]]; then echo 'DRY RUN: run doctor with explicit config/env/settings/session and print summary'
else run_doctor; fi
echo 'Next: authenticate Claude with claude /login if needed; start the service externally and verify a real Telegram DM.'
printf 'Inspect session: tmux attach -t %q\n' "$SESSION"
printf 'Update later: %q/update.sh --state-dir %q\n' "$REPO" "$STATE_DIR"
