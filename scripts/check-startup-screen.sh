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
# The command gets an empty stdin and STARTUP_ALERT_TIMEOUT seconds (default
# 30): after that its whole process group is killed and the alert counts as
# not delivered. A command that moved itself into another session (setsid, a
# daemon) is out of reach and may still deliver late.
#
# State: <state-dir>/<agent>.startup-screen holds "<first-seen> <kind> <alerted>".
# It is removed as soon as the dialog is gone, so the next incident alerts again.
# It is replaced atomically (temp file, then mv). A state file with a malformed
# first-seen value (not a plain decimal number, or in the future) is reset: the
# incident is timed from this run.
#
# Concurrency: read -> alert -> write of one agent runs under a per-agent lock
# (<state-dir>/<agent>.lock, see "lock functions" below). A run that finds the
# lock held skips that agent: the other run is handling it. A lock is taken
# over only from an owner that is provably gone (no such process, or the pid
# now belongs to a process with another start time), never because of its age.
# The owner is bounded instead: the look at the pane may take
# STARTUP_CHECK_CLASSIFY_TIMEOUT seconds (default 20), the alert command
# STARTUP_ALERT_TIMEOUT. A lock that is still held after STARTUP_LOCK_WARN_MIN
# minutes (default 10; a stopped run) is reported and makes this run exit 1;
# it is not taken.
#
# Environment: TMUX_BIN (tmux executable, default "tmux" from PATH; launchd and
# non-interactive ssh have no Homebrew directory on PATH, set it there).
#
# Exit codes: 0 ok (alerts raised or not), 1 an alert command failed or was
# killed at its time limit, the look at a pane did not end in time, the state
# could not be saved, a lock could not be taken or is held for too long, or an
# agent line was invalid, 2 usage error, 3 tmux executable not found (nothing
# checked, state untouched).
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
ALERT_TIMEOUT="${STARTUP_ALERT_TIMEOUT:-30}"
CLASSIFY_TIMEOUT="${STARTUP_CHECK_CLASSIFY_TIMEOUT:-20}"
LOCK_WARN_MIN="${STARTUP_LOCK_WARN_MIN:-10}"

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
# is_limit VALUE: a whole number from 1 to 99999.
is_limit() {
  case "$1" in ''|*[!0-9]*|??????*) return 1 ;; esac
  [ "$((10#$1))" -ge 1 ]
}
if ! is_limit "$ALERT_TIMEOUT" || ! is_limit "$CLASSIFY_TIMEOUT" || ! is_limit "$LOCK_WARN_MIN"; then
  echo "check-startup-screen: STARTUP_ALERT_TIMEOUT, STARTUP_CHECK_CLASSIFY_TIMEOUT and STARTUP_LOCK_WARN_MIN must be whole numbers from 1" >&2
  exit 2
fi
ALERT_TIMEOUT=$((10#$ALERT_TIMEOUT))
CLASSIFY_TIMEOUT=$((10#$CLASSIFY_TIMEOUT))
LOCK_WARN_MIN=$((10#$LOCK_WARN_MIN))
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
# >>> lock functions (the same text in confirm-startup-screen.sh and check-startup-screen.sh) >>>
# Model: docs/07-startup-screen-confirm.md, section "Locking model". No flock
# (absent on macOS), bash 3.2, BSD and GNU tools.
#
# A lock is a directory that is only a container. Ownership is the file `held`
# in it: one line "<pid> <token> <process identity>". The record is written to
# tmp.<token> first and published with a hard link (`ln` is atomic and never
# replaces an existing name), so there is one owner and the record is complete
# from its first moment: no "locked but owner not written yet" state.
#
# A lock is abandoned ONLY when that is provable: the pid does not exist (or is
# a zombie), or it exists with another start time (pid reuse), or the record
# is garbled (a live owner never has one). Age never makes a lock abandoned,
# and an identity that cannot be compared counts as "held".
#
# Recovery: a record may be removed only by the one process that created
# bury.<token of that record> (hard link again). It reads `held` again and
# removes it only when it still carries that token, so the record of a new
# owner cannot be removed, also when several processes recover at once.
LOCK_PATH=''   # lock directory whose `held` record is ours
LOCK_TOKEN=''  # token of this run
LOCK_TMP=''    # our record file, before it is published
LR_PID=''      # lock_read result: pid, token, process identity
LR_TOKEN=''
LR_ID=''

# lock_proc_id PID: print the identity of a running process (its start time).
# Status 1: no such process, or a zombie. Status 0 without output: cannot tell.
lock_proc_id() {
  local pid="$1" line rest boot out
  if [ -r "/proc/$pid/stat" ] && [ -r /proc/sys/kernel/random/boot_id ]; then
    # Linux: start time in clock ticks since boot plus the boot id. `ps -o
    # lstart=` of procps may differ by a second between two calls.
    read -r line < "/proc/$pid/stat" 2>/dev/null || return 1
    rest="${line##*) }"
    set -f
    # shellcheck disable=SC2086  # intended word splitting of the stat fields
    set -- $rest
    set +f
    if [ "${1:-}" = Z ]; then return 1; fi
    case "${20:-}" in ''|*[!0-9]*) return 0 ;; esac
    read -r boot < /proc/sys/kernel/random/boot_id 2>/dev/null || return 0
    printf 'proc:%s:%s' "$boot" "${20}"
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null && [ -z "$(ps -o pid= -p "$pid" 2>/dev/null)" ]; then return 1; fi
  out="$(LC_ALL=C TZ=UTC ps -o stat= -o lstart= -p "$pid" 2>/dev/null)"
  set -f
  # shellcheck disable=SC2086  # intended word splitting: state, then the date words
  set -- $out
  set +f
  if [ $# -lt 2 ]; then return 0; fi
  case "$1" in Z*) return 1 ;; esac
  shift
  out="$*"
  printf 'ps:%s' "${out// /_}"
}

# lock_read FILE: read a record into LR_PID, LR_TOKEN, LR_ID.
# Status 0 readable, 1 garbled (LR_TOKEN is then "unreadable"), 2 no such file.
lock_read() {
  LR_PID=''; LR_TOKEN=''; LR_ID=''
  [ -f "$1" ] || return 2
  read -r LR_PID LR_TOKEN LR_ID < "$1" 2>/dev/null || true
  case "$LR_PID" in ''|0*|*[!0-9]*|??????????*) LR_TOKEN='unreadable'; return 1 ;; esac
  case "$LR_TOKEN" in ''|unreadable|*[!A-Za-z0-9-]*) LR_TOKEN='unreadable'; return 1 ;; esac
  case "$LR_ID" in ''|*[[:space:]]*) LR_TOKEN='unreadable'; return 1 ;; esac
  return 0
}

# lock_abandoned: judge the record in LR_*. Status 0 only when its owner is
# provably gone; 1 when the owner is alive or that cannot be told.
lock_abandoned() {
  local now
  if [ "$LR_TOKEN" = unreadable ]; then return 0; fi
  now="$(lock_proc_id "$LR_PID")" || return 0
  if [ -z "$now" ]; then return 1; fi
  # Compare only identities obtained the same way (proc: with proc:, ps: with ps:).
  if [ "${now%%:*}" != "${LR_ID%%:*}" ]; then return 1; fi
  [ "$now" != "$LR_ID" ]
}

# lock_bury DIR FILE DEPTH: remove the abandoned record in FILE, which was just
# read into LR_*. Status 0 when this process had the right to remove it.
lock_bury() {
  local dir="$1" file="$2" depth="$3" token="$LR_TOKEN" marker
  marker="$dir/bury.$token"
  if ! ln "$LOCK_TMP" "$marker" 2>/dev/null; then
    # Another process is removing this record. When that process died half-way,
    # its marker is a record of a dead owner too: remove it the same way, and
    # let the next attempt start over.
    if [ "$depth" -ge 2 ]; then return 1; fi
    lock_read "$marker"
    if [ $? -eq 2 ]; then return 1; fi
    lock_abandoned || return 1
    lock_bury "$dir" "$marker" $((depth + 1))
    return 1
  fi
  # Nobody else can remove a record with this token now, and its owner is gone:
  # between this read and the rm the file cannot change.
  lock_read "$file"
  if [ "$LR_TOKEN" = "$token" ]; then rm -f "$file" 2>/dev/null; fi
  rm -f "$marker" 2>/dev/null
  return 0
}

lock_mine() {
  [ -n "$LOCK_PATH" ] && lock_read "$LOCK_PATH/held" && [ "$LR_TOKEN" = "$LOCK_TOKEN" ]
}

# lock_take DIR: 0 taken, 1 held by a live owner, 2 the lock cannot be used.
lock_take() {
  local dir="$1" id try=0 rc
  id="$(lock_proc_id "$$")" || return 2
  if [ -z "$id" ]; then return 2; fi
  LOCK_TOKEN="$$-$(date +%s)-$RANDOM$RANDOM"
  LOCK_TMP="$dir/tmp.$LOCK_TOKEN"
  # A releasing owner removes the empty container: create it again and retry.
  while :; do
    mkdir -p "$dir" 2>/dev/null
    if printf '%s %s %s\n' "$$" "$LOCK_TOKEN" "$id" 2>/dev/null > "$LOCK_TMP"; then break; fi
    try=$((try + 1))
    if [ "$try" -ge 3 ]; then LOCK_TMP=''; return 2; fi
  done
  try=0
  while [ "$try" -lt 4 ]; do
    try=$((try + 1))
    if ln "$LOCK_TMP" "$dir/held" 2>/dev/null; then
      LOCK_PATH="$dir"
      if lock_mine; then
        rm -f "$LOCK_TMP" 2>/dev/null
        LOCK_TMP=''
        return 0
      fi
      LOCK_PATH=''
      break
    fi
    lock_read "$dir/held"
    rc=$?
    if [ "$rc" -eq 2 ]; then
      # Released a moment ago: try again. Anything that is not a file: give up.
      if [ -e "$dir/held" ]; then break; fi
      continue
    fi
    if ! lock_abandoned; then
      rm -f "$LOCK_TMP" 2>/dev/null
      LOCK_TMP=''
      return 1
    fi
    lock_bury "$dir" "$dir/held" 0
  done
  rm -f "$LOCK_TMP" 2>/dev/null
  LOCK_TMP=''
  # Still a record there: its owner, or the process recovering it, has the lock.
  if [ -f "$dir/held" ]; then return 1; fi
  return 2
}

lock_release() {
  if lock_mine; then
    rm -f "$LOCK_PATH/held" 2>/dev/null
    rmdir "$LOCK_PATH" 2>/dev/null || true
  fi
  if [ -n "$LOCK_TMP" ]; then rm -f "$LOCK_TMP" 2>/dev/null; fi
  LOCK_PATH=''
  LOCK_TMP=''
}
# <<< lock functions <<<
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

# run_bounded SECONDS COMMAND...: run COMMAND with an empty stdin for at most
# SECONDS. Status: the command's own, or 124 when it was killed at the limit.
# The command runs in its own process group (job control is on only while it
# is started), so the kill reaches what it started as well. A timer process
# does the killing; this shell just waits for the command.
run_bounded() {
  local limit="$1" pid timer rc began=$SECONDS
  shift
  set -m
  "$@" </dev/null &
  pid=$!
  set +m
  (
    nap=''
    # shellcheck disable=SC2046  # the pids of this subshell's own sleeps
    trap 'kill $nap $(jobs -p) 2>/dev/null; exit 0' TERM
    sleep "$limit" & nap=$!; wait "$nap"
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    sleep 1 & nap=$!; wait "$nap"
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
  ) </dev/null >/dev/null 2>&1 &
  timer=$!
  wait "$pid" 2>/dev/null
  rc=$?
  kill -TERM "$timer" 2>/dev/null
  wait "$timer" 2>/dev/null
  # Ended by a signal once the limit was reached: that was the timer.
  if [ "$rc" -gt 128 ] && [ $((SECONDS - began)) -ge "$limit" ]; then return 124; fi
  return "$rc"
}

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
    # Another run is between its read and its write for this agent. Its steps
    # are bounded, so a lock this old means a stopped run: say so, loudly, but
    # never take a lock from a live owner.
    if [ -n "$(find "$STATE_DIR/$agent.lock/held" -mmin "+$LOCK_WARN_MIN" 2>/dev/null)" ]; then
      log "agent=$agent action=skip reason=lock-held-too-long minutes=$LOCK_WARN_MIN"
      failures=$((failures + 1))
      return 0
    fi
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
  local state_file kind first_seen alerted seconds rc
  state_file="$STATE_DIR/$agent.startup-screen"
  if [ "$socket_flag" = default ]; then
    kind="$(run_bounded "$CLASSIFY_TIMEOUT" /bin/bash "$CONFIRM_SCRIPT" --classify "$target" 2>/dev/null)"
  else
    kind="$(run_bounded "$CLASSIFY_TIMEOUT" /bin/bash "$CONFIRM_SCRIPT" --classify "$socket_flag" "$socket_value" "$target" 2>/dev/null)"
  fi
  rc=$?
  if [ "$rc" = 124 ]; then
    # tmux did not answer: nothing is known about the pane, the state stays.
    log "agent=$agent action=error reason=classify-timeout seconds=$CLASSIFY_TIMEOUT"
    failures=$((failures + 1))
    return 0
  elif [ "$rc" -gt 128 ]; then
    # The look was ended by a signal: nothing is known either.
    log "agent=$agent action=error reason=classify-killed"
    failures=$((failures + 1))
    return 0
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
      STARTUP_ALERT_AGENT="$agent" STARTUP_ALERT_KIND="$kind" STARTUP_ALERT_SECONDS="$seconds" \
        run_bounded "$ALERT_TIMEOUT" sh -c "$STARTUP_ALERT_CMD" startup-alert "$agent" "$kind" "$seconds"
      rc=$?
      if [ "$rc" = 0 ]; then
        alerted=1
        log "agent=$agent action=alert kind=$kind seconds=$seconds delivered=yes"
      elif [ "$rc" = 124 ]; then
        # Killed at the time limit: not delivered, the next run tries again.
        failures=$((failures + 1))
        log "agent=$agent action=alert kind=$kind seconds=$seconds delivered=no reason=alert-timeout limit=$ALERT_TIMEOUT"
      else
        failures=$((failures + 1))
        log "agent=$agent action=alert kind=$kind seconds=$seconds delivered=no"
      fi
    else
      alerted=1
      log "agent=$agent action=alert kind=$kind seconds=$seconds delivered=log-only"
    fi
  fi
  # A live owner does not lose its lock; this guards the state file against
  # a lock directory that was removed by hand in the meantime.
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
