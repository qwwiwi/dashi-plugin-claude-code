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
# It is replaced atomically (temp file, then mv). A state file with a malformed
# first-seen value (not a plain decimal number, or in the future) is reset: the
# incident is timed from this run.
#
# Concurrency: read -> alert -> write of one agent runs under a per-agent lock
# (<state-dir>/<agent>.lock, a directory: mkdir is atomic, no flock on macOS).
# A run that finds the lock held skips that agent: the other run is handling
# it. Stale rule: owner pid not running, or no pid file and the lock is older
# than a minute, or the lock is older than STARTUP_LOCK_STALE_MIN minutes
# (default 30).
#
# Environment: TMUX_BIN (tmux executable, default "tmux" from PATH; launchd and
# non-interactive ssh have no Homebrew directory on PATH, set it there).
#
# Exit codes: 0 ok (alerts raised or not), 1 an alert command failed, the state
# could not be saved, a lock could not be taken or an agent line was invalid,
# 2 usage error, 3 tmux executable not found (nothing checked, state untouched).
set -u

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIRM_SCRIPT="${STARTUP_CONFIRM_SCRIPT:-$SELF_DIR/confirm-startup-screen.sh}"
THRESHOLD="${STARTUP_CHECK_THRESHOLD:-120}"
STATE_DIR="${STARTUP_CHECK_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/dashi-startup-screen}"
CONFIG="${STARTUP_CHECK_CONFIG:-}"
AGENT_LINES=''
NEWLINE='
'

TMUX_BIN="${TMUX_BIN:-tmux}"
LOCK_STALE_MIN="${STARTUP_LOCK_STALE_MIN:-30}"

usage() {
  # The comment block at the top of this file, without the leading "# ".
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0" >&2
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
# is_decimal VALUE: a plain decimal number that shell arithmetic reads as
# written (no leading zero: "08" is a broken octal number there), at most 12 digits.
is_decimal() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    0) return 0 ;;
    0*) return 1 ;;
  esac
  [ "${#1}" -le 12 ]
}
case "$THRESHOLD" in
  ''|*[!0-9]*) echo "check-startup-screen: --threshold must be a whole number" >&2; exit 2 ;;
esac
[ "${#THRESHOLD}" -le 9 ] || { echo "check-startup-screen: --threshold is too large" >&2; exit 2; }
THRESHOLD=$((10#$THRESHOLD))
case "$LOCK_STALE_MIN" in
  ''|*[!0-9]*|??????*) echo "check-startup-screen: STARTUP_LOCK_STALE_MIN must be a whole number" >&2; exit 2 ;;
esac
LOCK_STALE_MIN=$((10#$LOCK_STALE_MIN))
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
if ! is_decimal "$NOW"; then echo "check-startup-screen: bad clock value" >&2; exit 2; fi

log() {
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') check-startup-screen $*" >&2
}

# A missing tmux must not look like "no session" (which clears the state):
# launchd and non-interactive ssh have no Homebrew directory on PATH.
if ! command -v "$TMUX_BIN" >/dev/null 2>&1; then
  log "action=error reason=tmux-not-found hint=set-TMUX_BIN-or-PATH"
  exit 3
fi
export TMUX_BIN

# ─── Lock: one run per agent ─────────────────────────────────────────────────
# Same portable mkdir lock as in confirm-startup-screen.sh (kept in both files
# on purpose: each script installs as a single file).
LOCK_PATH=''

lock_owner() {
  local pid=''
  if [ -r "$1/pid" ]; then read -r pid < "$1/pid" 2>/dev/null || true; fi
  printf '%s' "$pid"
}

lock_is_stale() {
  local pid
  pid="$(lock_owner "$1")"
  case "$pid" in
    ''|*[!0-9]*)
      [ -n "$(find "$1" -maxdepth 0 -mmin +1 2>/dev/null)" ]
      return ;;
  esac
  if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
  [ -n "$(find "$1" -maxdepth 0 -mmin "+$LOCK_STALE_MIN" 2>/dev/null)" ]
}

# lock_take PATH: 0 taken, 1 held by a live owner, 2 cannot create.
lock_take() {
  local path="$1" old
  if ! mkdir "$path" 2>/dev/null; then
    [ -d "$path" ] || return 2
    lock_is_stale "$path" || return 1
    old="$path.stale.$$"
    mv "$path" "$old" 2>/dev/null || return 1
    rm -f "$old/pid"
    rmdir "$old" 2>/dev/null || true
    mkdir "$path" 2>/dev/null || return 1
  fi
  if ! echo "$$" > "$path/pid"; then
    rmdir "$path" 2>/dev/null || true
    return 2
  fi
  LOCK_PATH="$path"
  return 0
}

lock_mine() {
  [ -n "$LOCK_PATH" ] && [ "$(lock_owner "$LOCK_PATH")" = "$$" ]
}

lock_release() {
  if lock_mine; then
    rm -f "$LOCK_PATH/pid" 2>/dev/null
    rmdir "$LOCK_PATH" 2>/dev/null || true
  fi
  LOCK_PATH=''
}

trap lock_release EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# ─────────────────────────────────────────────────────────────────────────────

is_dialog_kind() {
  case "$1" in
    ready|unknown|no-session|tmux-missing|'') return 1 ;;
    *) return 0 ;;
  esac
}

failures=0

# save_state FILE CONTENT: atomic replace; status 1 when it could not be saved.
save_state() {
  local tmp="$1.tmp.$$"
  if ! echo "$2" > "$tmp" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null
    return 1
  fi
  if ! mv -f "$tmp" "$1" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null
    return 1
  fi
  return 0
}

# check_agent: takes the agent lock, runs the check under it, releases it.
check_agent() {
  local agent="$1" rc
  lock_take "$STATE_DIR/$agent.lock"
  rc=$?
  if [ "$rc" = 1 ]; then
    # Another run is between its read and its write for this agent.
    log "agent=$agent action=skip reason=locked"
    return 0
  elif [ "$rc" != 0 ]; then
    log "agent=$agent action=error reason=lock-failed"
    failures=$((failures + 1))
    return 0
  fi
  check_agent_locked "$@"
  lock_release
}

check_agent_locked() {
  local agent="$1" socket_flag="$2" socket_value="$3" target="$4"
  local state_file kind first_seen alerted seconds
  state_file="$STATE_DIR/$agent.startup-screen"
  if [ "$socket_flag" = default ]; then
    kind="$(/bin/bash "$CONFIRM_SCRIPT" --classify "$target" 2>/dev/null)"
  else
    kind="$(/bin/bash "$CONFIRM_SCRIPT" --classify "$socket_flag" "$socket_value" "$target" 2>/dev/null)"
  fi
  if [ "$kind" = tmux-missing ]; then
    log "agent=$agent action=error reason=tmux-not-found"
    failures=$((failures + 1))
    return 0
  fi
  if ! is_dialog_kind "$kind"; then
    if [ -f "$state_file" ]; then
      if rm -f "$state_file" 2>/dev/null; then
        log "agent=$agent action=cleared kind=${kind:-none}"
      else
        log "agent=$agent action=state-write-failed kind=${kind:-none}"
        failures=$((failures + 1))
      fi
    fi
    return 0
  fi
  first_seen="$NOW"; alerted=0
  if [ -f "$state_file" ]; then
    read -r first_seen _ alerted < "$state_file" || true
    if ! is_decimal "$first_seen" || [ "$first_seen" -gt "$NOW" ]; then
      # Malformed or future timestamp: start the incident over from this run.
      log "agent=$agent action=state-reset kind=$kind"
      first_seen="$NOW"; alerted=0
    fi
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
  # The lock can be lost only when it was taken over as stale (this run was
  # slower than STARTUP_LOCK_STALE_MIN): the new owner writes the state.
  if ! lock_mine; then
    log "agent=$agent action=state-write-failed reason=lock-lost"
    failures=$((failures + 1))
    return 0
  fi
  if ! save_state "$state_file" "$first_seen $kind $alerted"; then
    # Without the saved state the next run would alert again: make it visible.
    log "agent=$agent action=state-write-failed kind=$kind alerted=$alerted"
    failures=$((failures + 1))
  fi
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
