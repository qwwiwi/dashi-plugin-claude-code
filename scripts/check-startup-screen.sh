#!/bin/bash
# check-startup-screen.sh: one-shot check for agents stuck on a Claude Code
# startup dialog. Meant for a periodic job (launchd StartInterval, systemd
# timer, cron). It never sends keys: it only looks (through
# confirm-startup-screen.sh --classify) and raises ONE alert per incident.
#
# Usage:
#   check-startup-screen.sh [options] ["<agent> <socket> <target>" ...]
#
#   Each agent is one argument (quote it) or one line of the --config file:
#     <agent> -L <socket-name> <target>
#     <agent> -S <socket-path> <target>
#     <agent> default <target>            (tmux default socket)
#   Empty lines and lines starting with # are skipped.
#
#   --config FILE     agent list, one per line (default: $STARTUP_CHECK_CONFIG)
#   --threshold SEC   how long a dialog may show before the alert (default 120)
#   --state-dir DIR   where the per-agent first-seen files live
#                     (default: $STARTUP_CHECK_STATE_DIR or ~/.local/state/dashi-startup-screen)
#
# Alert: the command in STARTUP_ALERT_CMD runs through `sh -c` once per
# incident. It gets the agent name, the screen kind and the seconds as
# $1 $2 $3 and as STARTUP_ALERT_AGENT / STARTUP_ALERT_KIND /
# STARTUP_ALERT_SECONDS. A non-zero exit means "not delivered": the next run
# tries again. Without STARTUP_ALERT_CMD the alert is only a log line.
#
# State: <state-dir>/<agent>.startup-screen holds "<first-seen> <kind> <alerted>".
# It is removed as soon as the dialog is gone, so the next incident alerts again.
#
# Exit codes: 0 ok (alerts raised or not), 1 an alert command failed or an
# agent line was invalid, 2 usage error.
set -u

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIRM_SCRIPT="${STARTUP_CONFIRM_SCRIPT:-$SELF_DIR/confirm-startup-screen.sh}"
THRESHOLD="${STARTUP_CHECK_THRESHOLD:-120}"
STATE_DIR="${STARTUP_CHECK_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/dashi-startup-screen}"
CONFIG="${STARTUP_CHECK_CONFIG:-}"
AGENT_LINES=''
NEWLINE='
'

usage() {
  sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//' >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --config) [ $# -ge 2 ] || { usage; exit 2; }; CONFIG="$2"; shift 2 ;;
    --threshold) [ $# -ge 2 ] || { usage; exit 2; }; THRESHOLD="$2"; shift 2 ;;
    --state-dir) [ $# -ge 2 ] || { usage; exit 2; }; STATE_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "check-startup-screen: unknown option: $1" >&2; usage; exit 2 ;;
    *) AGENT_LINES="${AGENT_LINES}$1${NEWLINE}"; shift ;;
  esac
done
case "$THRESHOLD" in
  ''|*[!0-9]*) echo "check-startup-screen: --threshold must be a whole number" >&2; exit 2 ;;
esac
if [ -n "$CONFIG" ]; then
  if [ ! -r "$CONFIG" ]; then echo "check-startup-screen: cannot read config: $CONFIG" >&2; exit 2; fi
  AGENT_LINES="${AGENT_LINES}$(cat "$CONFIG")${NEWLINE}"
fi
if [ -z "${AGENT_LINES//[[:space:]]/}" ]; then usage; exit 2; fi
if [ ! -r "$CONFIRM_SCRIPT" ]; then
  echo "check-startup-screen: classifier not found: $CONFIRM_SCRIPT" >&2
  exit 2
fi
mkdir -p "$STATE_DIR" || exit 2

# STARTUP_CHECK_NOW overrides the clock (tests only).
NOW="${STARTUP_CHECK_NOW:-$(date +%s)}"

log() {
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') check-startup-screen $*" >&2
}

is_dialog_kind() {
  case "$1" in
    ready|unknown|no-session|'') return 1 ;;
    *) return 0 ;;
  esac
}

failures=0

check_agent() {
  local agent="$1" socket_flag="$2" socket_value="$3" target="$4"
  local state_file kind first_seen alerted seconds
  state_file="$STATE_DIR/$agent.startup-screen"
  if [ "$socket_flag" = default ]; then
    kind="$(/bin/bash "$CONFIRM_SCRIPT" --classify "$target" 2>/dev/null)"
  else
    kind="$(/bin/bash "$CONFIRM_SCRIPT" --classify "$socket_flag" "$socket_value" "$target" 2>/dev/null)"
  fi
  if ! is_dialog_kind "$kind"; then
    if [ -f "$state_file" ]; then
      rm -f "$state_file"
      log "agent=$agent action=cleared kind=${kind:-none}"
    fi
    return 0
  fi
  first_seen="$NOW"; alerted=0
  if [ -f "$state_file" ]; then
    read -r first_seen _ alerted < "$state_file" || true
    case "$first_seen" in ''|*[!0-9]*) first_seen="$NOW" ;; esac
    [ "$alerted" = 1 ] || alerted=0
  else
    log "agent=$agent action=first-seen kind=$kind"
  fi
  seconds=$((NOW - first_seen))
  if [ "$alerted" = 0 ] && [ "$seconds" -ge "$THRESHOLD" ]; then
    if [ -n "${STARTUP_ALERT_CMD:-}" ]; then
      if STARTUP_ALERT_AGENT="$agent" STARTUP_ALERT_KIND="$kind" STARTUP_ALERT_SECONDS="$seconds" \
        sh -c "$STARTUP_ALERT_CMD" startup-alert "$agent" "$kind" "$seconds"; then
        alerted=1
        log "agent=$agent action=alert kind=$kind seconds=$seconds delivered=yes"
      else
        failures=$((failures + 1))
        log "agent=$agent action=alert kind=$kind seconds=$seconds delivered=no"
      fi
    else
      alerted=1
      log "agent=$agent action=alert kind=$kind seconds=$seconds delivered=log-only"
    fi
  fi
  echo "$first_seen $kind $alerted" > "$state_file"
}

while IFS= read -r line; do
  set -f
  # shellcheck disable=SC2086  # intended word splitting of one agent line
  set -- $line
  set +f
  [ $# -eq 0 ] && continue
  case "$1" in '#'*) continue ;; esac
  agent="$1"
  case "$agent" in
    *[!A-Za-z0-9._-]*|.*)
      log "action=skip reason=bad-agent-name"; failures=$((failures + 1)); continue ;;
  esac
  if [ $# -eq 4 ] && { [ "$2" = -L ] || [ "$2" = -S ]; }; then
    check_agent "$agent" "$2" "$3" "$4"
  elif [ $# -eq 3 ] && [ "$2" = default ]; then
    check_agent "$agent" default '' "$3"
  else
    log "agent=$agent action=skip reason=bad-line"; failures=$((failures + 1))
  fi
done <<LINES
$AGENT_LINES
LINES

[ "$failures" -eq 0 ] || exit 1
exit 0
