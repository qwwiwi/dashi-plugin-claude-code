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
    --agent|--workspace|--state-dir|--settings|--owner-id|--bot-token)
      [[ $# -ge 2 && -n "$2" ]] || fail 'Option requires a value'
      case "$1" in --agent) AGENT="$2";; --workspace) WORKSPACE="$2";; --state-dir) STATE_DIR="$2";; --settings) SETTINGS="$2";; --owner-id) OWNER_ID="$2";; --bot-token) TOKEN="$2";; esac; shift 2;;
    --dry-run) DRY_RUN=1; shift;; --start) START=1; shift;; --non-interactive) NONINTERACTIVE=1; shift;;
    -h|--help) echo 'Usage: ./install.sh [--agent NAME --workspace PATH --owner-id ID --state-dir PATH --settings PATH] [--bot-token TOKEN] [--non-interactive] [--dry-run] [--start]'; echo 'Prefer TELEGRAM_BOT_TOKEN env or the hidden prompt; TELEGRAM_OWNER_ID supplies the installer owner ID.'; exit 0;;
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
SERVICE_KIND=system; SERVICE="$STATE_DIR/channel-$AGENT.service"
SYSTEMCTL=(systemctl)
if [[ "$PLATFORM" == Linux ]]; then
  SERVICE="/etc/systemd/system/channel-$AGENT.service"
  if [[ "$(id -u)" != 0 ]]; then
    SERVICE_KIND=user; SERVICE="$HOME/.config/systemd/user/channel-$AGENT.service"
    SYSTEMCTL+=(--user)
  fi
fi
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
  INSTALL_AGENT="$AGENT" INSTALL_WORKSPACE="$WORKSPACE" INSTALL_STATE_DIR="$STATE_DIR" INSTALL_SETTINGS="$SETTINGS" INSTALL_PLATFORM="$PLATFORM" INSTALL_SERVICE_KIND="$SERVICE_KIND" INSTALL_SERVICE_FILE="$SERVICE" INSTALL_REPO="$REPO" INSTALL_HOME="$HOME" INSTALL_CLAUDE="$(command -v claude)" INSTALL_TMUX="$(command -v tmux)" INSTALL_BUN="$(command -v bun)" TELEGRAM_BOT_TOKEN="$TOKEN" TELEGRAM_OWNER_ID="$OWNER_ID" bun "$REPO/scripts/render-install.ts"
  unset TOKEN TELEGRAM_BOT_TOKEN
  read_context
  backup "$SETTINGS"
  echo 'Registering standard plugin hooks'
  TELEGRAM_STATE_DIR="$STATE_DIR" bash "$REPO/plugin/scripts/install-hooks.sh" --settings "$SETTINGS" --chat-id "$CHAT_ID" --webhook-url "$WEBHOOK_URL" --agent-id "$AGENT"
fi
if [[ "$PLATFORM" == Linux ]]; then
  print_registration() {
    [[ "$SERVICE_KIND" != user ]] || printf 'mkdir -p %q\n' "${SERVICE%/*}"
    printf 'install -m 644 %q %q\n' "$STATE_DIR/channel-$AGENT.service" "$SERVICE"
    printf '%s daemon-reload\n' "${SYSTEMCTL[*]}"
    printf '%s enable %q\n' "${SYSTEMCTL[*]}" "channel-$AGENT.service"
    [[ "$START" != 1 ]] || printf '%s start %q\n' "${SYSTEMCTL[*]}" "channel-$AGENT.service"
  }
  if [[ "$DRY_RUN" == 1 ]]; then
    echo "DRY RUN: install $SERVICE_KIND unit at $SERVICE (back up any existing unit first)"
    print_registration
    if [[ "$SERVICE_KIND" == user ]]; then
      echo 'DRY RUN: check user lingering; if not enabled, the service will not survive logout until this human step:'
      printf 'sudo loginctl enable-linger %q\n' "$(id -un)"
    fi
  else
    if [[ "$START" == 1 ]] && inside_channel; then fail "Cannot start/restart own tmux session $SESSION; use an external terminal"; fi
    if [[ "$SERVICE_KIND" == user ]]; then
      if [[ "$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || true)" != yes ]]; then
        echo 'User lingering is not confirmed enabled: the service will not survive logout until you run this one human step:'
        printf 'sudo loginctl enable-linger %q\n' "$(id -un)"
      fi
      if ! systemctl --user show-environment >/dev/null 2>&1; then
        echo 'User service manager unavailable (no user bus). Run these commands from a user login session:' >&2
        print_registration
        echo 'INSTALL INCOMPLETE: service was not registered or started; restore the user bus and rerun install.sh.' >&2
        exit 1
      fi
      mkdir -p "${SERVICE%/*}"
    fi
    backup "$SERVICE"
    install -m 644 "$STATE_DIR/channel-$AGENT.service" "$SERVICE"
    "${SYSTEMCTL[@]}" daemon-reload || fail 'Service daemon-reload failed; service registration is incomplete'
    "${SYSTEMCTL[@]}" enable "channel-$AGENT.service" || fail 'Service enable failed; service registration is incomplete'
    if [[ "$START" == 1 ]]; then
      "${SYSTEMCTL[@]}" start "channel-$AGENT.service" || fail 'Service start failed; inspect systemctl status and the service journal'
      echo "Registered, enabled and started $SERVICE_KIND service channel-$AGENT.service"
    else
      printf 'Service registered and enabled. Start now: %s start %q\n' "${SYSTEMCTL[*]}" "channel-$AGENT.service"
    fi
  fi
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
echo 'Next: authenticate Claude with claude /login if needed; verify a real Telegram DM after service startup.'
printf 'Inspect session: tmux attach -t %q\n' "$SESSION"
printf 'Update later: %q/update.sh --state-dir %q\n' "$REPO" "$STATE_DIR"
