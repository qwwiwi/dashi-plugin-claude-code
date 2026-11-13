#!/bin/bash
# confirm-startup-screen.sh: content-aware confirm of the Claude Code
# "Loading development channels" startup screen inside a tmux pane.
#
# Rule: never send blind input. The only key this script ever sends is Enter,
# and only while the pane shows exactly ONE dialog: the dev-channels warning
# with option 1 (the "local development" one) under the cursor. Every other
# screen, and any pane that holds more than that one dialog, is only
# classified and reported.
#
# Usage:
#   confirm-startup-screen.sh [-L socket-name | -S socket-path] [options] <target>
#
#   <target>            tmux target (session, session:window.pane, %pane-id)
#   -L NAME / -S PATH   tmux socket, passed to tmux as is (default socket if absent)
#   --timeout SEC       how long to watch the pane (default 90; 0 = one look, no key)
#   --interval SEC      pause between looks (default 2)
#   --max-presses N     Enter presses at most (default 2)
#   --press-pause SEC   pause after a press before looking again (default 3)
#   --log FILE          append the log lines to FILE too
#   --classify          look once, print the screen kind to stdout, press nothing
#   --dry-run           same as --classify
#
# Environment: TMUX_BIN (tmux executable, default "tmux" from PATH; launchd and
# non-interactive ssh do not have Homebrew on PATH, so set it to an absolute
# path there), STARTUP_CONFIRM_DISABLE=1 (off switch), STARTUP_CONFIRM_LOCK_DIR
# (default ~/.local/state/dashi-startup-screen/locks), STARTUP_CONFIRM_HARD_MARGIN
# (seconds after --timeout at which the run is ended from outside, default 30),
# STARTUP_PAT_* (patterns).
#
# Exit codes:
#   0   session is at the normal prompt, or the dialog went away after our Enter
#       (the second case is not proof of readiness: the pane then shows
#       something this script does not classify)
#   2   usage error
#   3   dev-channels screen still showing: after --max-presses presses, or the
#       time ran out before a key could be sent
#   4   dev-channels warning in a shape we do not recognise, or together with
#       anything that looks like a second dialog: nothing pressed
#   5   another startup dialog is showing (trust folder, login, logged-out
#       session, update, ...): nothing pressed
#   6   nothing recognised within the timeout: nothing pressed
#   7   tmux session/pane not reachable
#   8   another confirmer holds the lock of this pane (or the lock could not be
#       taken): nothing pressed by this run
#   9   tmux executable not found (TMUX_BIN / PATH)
#   10  (--classify only) dev-channels screen that WOULD be confirmed
#   11  hard ceiling: the run was still alive --timeout + STARTUP_CONFIRM_HARD_MARGIN
#       seconds after its start (a tmux call that never answered) and was ended
#       by its own watchdog: nothing pressed after the deadline, lock released
#
# Screen kinds: ready, dev-channels, dev-channels-unrecognized, external-imports,
# trust-folder, bypass-permissions, login, update, other-dialog, unknown,
# no-session, tmux-missing.
#
# How the key is kept on the right screen:
#   - the target is resolved to a tmux pane id once; every look and the key go
#     to that id, so a renamed session or a changed active pane cannot redirect
#     the key;
#   - one confirmer per pane: a lock (see "lock functions" below) is held for
#     the whole run; a second confirmer exits 8 without pressing. A lock is
#     taken over only from an owner that is provably gone, never because of
#     its age; the owner itself is bounded by --timeout and the hard ceiling;
#   - the pane is looked at again immediately before the key, with no sleep in
#     between.
# RESIDUAL RISK (accepted, cannot be closed with tmux): capture-pane and
# send-keys are two separate tmux calls. If Claude Code replaces the dialog in
# the few milliseconds between the last look and the key, Enter lands on the
# new screen. The lock removes other confirmers from that window, not Claude
# Code itself or a human typing into the pane.
#
# Works with bash 3.2 (macOS) and newer. Needs tmux, sed, awk, grep, tr, ps, ln.
set -u

# ─── Patterns ────────────────────────────────────────────────────────────────
# Extended regular expressions, matched case-insensitively against the pane
# text after it was flattened: ANSI escapes and box-drawing characters removed,
# all whitespace (including line breaks) squeezed to single spaces. So a phrase
# matches even when the dialog wraps it over two lines.
# Each one can be overridden by an environment variable of the same name.
#
# NOTE: the dev-channels, trust-folder, ready and logged-out defaults were
# checked against real captures of Claude Code 2.1.323 (see
# tests/fixtures/startup-screen/). The other dialogs are reconstructed from
# documentation. After capturing a new screen, check it with `--classify` and
# adjust here.

# The dev-channels warning itself (any one alternative is enough). The bare
# flag name is deliberately not enough: it also sits on the shell command line.
: "${STARTUP_PAT_DEVCH_WARNING:=Loading development channels|dangerously-load-development-channels is for local (channel )?development}"
# Label of option 1, the choice we are allowed to confirm.
: "${STARTUP_PAT_DEVCH_OPTION:=I am using this for local development}"
# The hint that says Enter confirms the highlighted option.
: "${STARTUP_PAT_CONFIRM_HINT:=Enter to confirm}"
# What may follow that hint up to the end of the pane. Anything else below the
# dialog means the pane is not just this dialog.
: "${STARTUP_PAT_DEVCH_TRAILER:=^( |·|•|\\||/|Esc to cancel)*\$}"
# Selection cursor drawn in front of the highlighted option.
: "${STARTUP_PAT_CURSOR:=❯|›|▶|→|>}"
# A logged-out session shows the normal prompt and this line: it wins over ready.
: "${STARTUP_PAT_LOGGED_OUT:=Not logged in|Please run /login}"
# Normal working session (channel banner, mode footer).
: "${STARTUP_PAT_READY:=Listening for channel messages|messages from server:[A-Za-z0-9_-]+ inject|bypass permissions on}"
# Other startup dialogs: reported, never answered.
: "${STARTUP_PAT_EXTERNAL_IMPORTS:=external CLAUDE\\.md file imports}"
: "${STARTUP_PAT_TRUST:=Do you trust the files|trust this folder|Is this a project you created or one you trust}"
: "${STARTUP_PAT_BYPASS:=Bypass Permissions mode}"
: "${STARTUP_PAT_LOGIN:=Select login method|Paste code here|Please run /login|Not logged in|Invalid API key}"
: "${STARTUP_PAT_UPDATE:=Update available|Auto-update failed|new version is available}"
# Footers of selection dialogs that are not the dev-channels one.
: "${STARTUP_PAT_OTHER_HINT:=Enter to select|Press Enter to continue}"
# Any other selection dialog.
: "${STARTUP_PAT_DIALOG:=Enter to confirm|Enter to select|Esc to cancel|Press Enter to continue}"
# A line ABOVE the dev-channels warning that starts with a selection cursor
# (after optional spaces): a dialog is drawn there. A shell prompt that ends in
# $ % # and a `>` inside a shell line do not match; a prompt drawn with one of
# these glyphs does, and then nothing is pressed (set this pattern to adapt).
: "${STARTUP_PAT_ABOVE_CURSOR:=^ *(❯|›|▶|→|>)}"
# ─────────────────────────────────────────────────────────────────────────────

TMUX_BIN="${TMUX_BIN:-tmux}"
TIMEOUT="${STARTUP_CONFIRM_TIMEOUT:-90}"
INTERVAL="${STARTUP_CONFIRM_INTERVAL:-2}"
MAX_PRESSES="${STARTUP_CONFIRM_MAX_PRESSES:-2}"
PRESS_PAUSE="${STARTUP_CONFIRM_PRESS_PAUSE:-3}"
LOCK_DIR="${STARTUP_CONFIRM_LOCK_DIR:-${XDG_STATE_HOME:-${HOME:-/tmp}/.local/state}/dashi-startup-screen/locks}"
# The run is ended from outside this many seconds after --timeout ran out.
HARD_MARGIN="${STARTUP_CONFIRM_HARD_MARGIN:-30}"
LOG_FILE=''
CLASSIFY_ONLY=0
TARGET=''
SOCKET_FLAG=''
SOCKET_VALUE=''

usage() {
  # The comment block at the top of this file, without the leading "# ".
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    -L|-S)
      [ $# -ge 2 ] || { usage; exit 2; }
      SOCKET_FLAG="$1"; SOCKET_VALUE="$2"; shift 2 ;;
    --timeout) [ $# -ge 2 ] || { usage; exit 2; }; TIMEOUT="$2"; shift 2 ;;
    --interval) [ $# -ge 2 ] || { usage; exit 2; }; INTERVAL="$2"; shift 2 ;;
    --max-presses) [ $# -ge 2 ] || { usage; exit 2; }; MAX_PRESSES="$2"; shift 2 ;;
    --press-pause) [ $# -ge 2 ] || { usage; exit 2; }; PRESS_PAUSE="$2"; shift 2 ;;
    --log) [ $# -ge 2 ] || { usage; exit 2; }; LOG_FILE="$2"; shift 2 ;;
    --classify|--dry-run) CLASSIFY_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "confirm-startup-screen: unknown option: $1" >&2; usage; exit 2 ;;
    *)
      if [ -n "$TARGET" ]; then echo "confirm-startup-screen: more than one target" >&2; exit 2; fi
      TARGET="$1"; shift ;;
  esac
done
if [ -z "$TARGET" ]; then usage; exit 2; fi

# is_whole VALUE: digits only, at most 9 of them (safe for shell arithmetic).
is_whole() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "${#1}" -le 9 ]
}
# is_seconds VALUE: digits with an optional decimal fraction.
is_seconds() {
  case "$1" in
    ''|.*|*.|*.*.*|*[!0-9.]*) return 1 ;;
  esac
  [ "${#1}" -le 12 ]
}
if ! is_whole "$TIMEOUT" || ! is_whole "$MAX_PRESSES"; then
  echo "confirm-startup-screen: --timeout and --max-presses must be whole numbers" >&2
  exit 2
fi
if ! is_whole "$HARD_MARGIN"; then
  echo "confirm-startup-screen: STARTUP_CONFIRM_HARD_MARGIN must be a whole number" >&2
  exit 2
fi
if ! is_seconds "$INTERVAL" || ! is_seconds "$PRESS_PAUSE"; then
  echo "confirm-startup-screen: --interval and --press-pause must be numbers of seconds" >&2
  exit 2
fi
# Force base 10: "08" would otherwise be read as a broken octal number.
TIMEOUT=$((10#$TIMEOUT))
MAX_PRESSES=$((10#$MAX_PRESSES))
HARD_MARGIN=$((10#$HARD_MARGIN))

log() {
  # One line per action. Never pass pane text here: only kinds and pattern names.
  local line
  line="$(date -u '+%Y-%m-%dT%H:%M:%SZ') confirm-startup-screen target=$TARGET $*"
  echo "$line" >&2
  if [ -n "$LOG_FILE" ]; then echo "$line" >> "$LOG_FILE" 2>/dev/null || true; fi
}

# Off switch: keep the wrapper line in place and disable through the environment.
if [ "${STARTUP_CONFIRM_DISABLE:-0}" = 1 ]; then
  log "action=disabled"
  exit 0
fi

# A missing tmux must not look like a missing session: launchd and
# non-interactive ssh have no Homebrew directory on PATH.
if ! command -v "$TMUX_BIN" >/dev/null 2>&1; then
  log "action=error result=tmux-not-found hint=set-TMUX_BIN-or-PATH"
  if [ "$CLASSIFY_ONLY" = 1 ]; then echo 'tmux-missing'; fi
  exit 9
fi

tmux_cmd() {
  if [ -n "$SOCKET_FLAG" ]; then
    "$TMUX_BIN" "$SOCKET_FLAG" "$SOCKET_VALUE" "$@"
  else
    "$TMUX_BIN" "$@"
  fi
}

# ─── Lock: one confirmer per pane ────────────────────────────────────────────
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

# ─── Deadline and hard ceiling: a live owner cannot hold the lock forever ────
# bash 3.2 has only a whole-second clock, and the loop below cannot interrupt a
# tmux call that never answers. So a watchdog process keeps the time:
#   - at TIMEOUT seconds it sends SIGALRM: the handler sets DEADLINE_HIT, and
#     bash runs it right after the command that was running (a slow look),
#     before the next one. No key is sent once it is set;
#   - at TIMEOUT + HARD_MARGIN seconds it sends SIGUSR1 (exit 11, lock
#     released); a second later it ends every process this run is blocked in;
#     two seconds later it sends SIGKILL, after which the lock has no owner
#     and the next run recovers it.
WATCHDOG_PID=''
DEADLINE_HIT=0

start_watchdog() {
  local main="$$" main_id
  main_id="$(lock_proc_id "$$")" || return 0
  if [ -z "$main_id" ]; then return 0; fi
  (
    nap=''
    # shellcheck disable=SC2046  # the pids of this subshell's own sleeps
    trap 'kill $nap $(jobs -p) 2>/dev/null; exit 0' TERM
    # wait_for SEC: a sleep that the TERM handler can end at once.
    wait_for() { sleep "$1" & nap=$!; wait "$nap"; }
    # Never signal a pid that is no longer this run.
    still_main() { [ "$(lock_proc_id "$main")" = "$main_id" ]; }
    wait_for "$TIMEOUT"
    still_main || exit 0
    kill -ALRM "$main" 2>/dev/null
    wait_for "$HARD_MARGIN"
    still_main || exit 0
    kill -USR1 "$main" 2>/dev/null
    wait_for 1
    still_main || exit 0
    # This process and what it starts ignore TERM from here on; everything
    # else below the run (the tmux call it waits for) is ended.
    trap '' TERM
    for child in $(ps -A -o pid= -o ppid= 2>/dev/null | awk -v root="$main" '
      { parent[$1] = $2 }
      END {
        inside[root] = 1; grew = 1
        while (grew) {
          grew = 0
          for (p in parent) if (!(p in inside) && (parent[p] in inside)) { inside[p] = 1; grew = 1 }
        }
        for (p in inside) if (p != root) print p
      }'); do
      kill -TERM "$child" 2>/dev/null
    done
    sleep 2
    still_main || exit 0
    kill -KILL "$main" 2>/dev/null
  ) </dev/null >/dev/null 2>&1 &
  WATCHDOG_PID=$!
}

cleanup() {
  if [ -n "$WATCHDOG_PID" ]; then kill -TERM "$WATCHDOG_PID" 2>/dev/null; fi
  WATCHDOG_PID=''
  lock_release
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'DEADLINE_HIT=1' ALRM
trap 'log "action=hard-ceiling result=stopped exit=11"; exit 11' USR1
# ─────────────────────────────────────────────────────────────────────────────

ESC="$(printf '\033')"
BEL="$(printf '\007')"
NBSP="$(printf '\302\240')"

# stdin: raw pane text. stdout: the same lines without ANSI escapes and
# box-drawing characters.
clean_lines() {
  LC_ALL=C sed -E \
    -e "s/${ESC}\\[[0-9;?]*[ -/]*[@-~]//g" \
    -e "s/${ESC}\\][^${BEL}]*${BEL}//g" \
    -e "s/${NBSP}/ /g" \
    -e 's/(│|┃|║|╭|╮|╰|╯|─|━|═|┌|┐|└|┘|├|┤)/ /g' \
    | LC_ALL=C tr '\r\t' '  '
}

# stdin: raw pane text. stdout: one flattened line.
flatten() {
  clean_lines | LC_ALL=C tr '\n' ' ' | LC_ALL=C tr -s ' '
}

# has TEXT REGEX: case-insensitive extended match.
has() {
  printf '%s' "$1" | LC_ALL=C grep -Eiq -e "$2"
}

# after_last TEXT REGEX: print what follows the last match; status 1 when no match.
after_last() {
  AL_TEXT="$1" AL_PAT="$2" LC_ALL=C awk 'BEGIN {
    text = ENVIRON["AL_TEXT"]; low = tolower(text); pat = tolower(ENVIRON["AL_PAT"])
    found = 0; offset = 0
    while (match(low, pat) && RLENGTH > 0) {
      found = 1
      offset += RSTART + RLENGTH - 1
      low = substr(low, RSTART + RLENGTH)
    }
    if (!found) exit 1
    printf "%s", substr(text, offset + 1)
  }'
}

# from_first TEXT REGEX: print the text from its first match on; status 1 when no match.
from_first() {
  FF_TEXT="$1" FF_PAT="$2" LC_ALL=C awk 'BEGIN {
    text = ENVIRON["FF_TEXT"]
    if (!match(tolower(text), tolower(ENVIRON["FF_PAT"]))) exit 1
    printf "%s", substr(text, RSTART)
  }'
}

# count_matches TEXT REGEX: print the number of non-overlapping matches.
count_matches() {
  CM_TEXT="$1" CM_PAT="$2" LC_ALL=C awk 'BEGIN {
    low = tolower(ENVIRON["CM_TEXT"]); pat = tolower(ENVIRON["CM_PAT"]); n = 0
    while (match(low, pat) && RLENGTH > 0) {
      n++
      low = substr(low, RSTART + RLENGTH)
    }
    print n
  }'
}

# dialog_above RAW_PANE WARNING_REGEX: status 0 when the part of the pane above
# the line where the first warning text starts holds a selection cursor at the
# start of a line or a dialog footer phrase. Status 1: only plain text there.
dialog_above() {
  printf '%s\n' "$1" | clean_lines \
    | DA_WARNING="$2" DA_CURSOR="$STARTUP_PAT_ABOVE_CURSOR" DA_FOOTER="$STARTUP_PAT_DIALOG" LC_ALL=C awk '
      { line[NR] = $0 }
      END {
        warning = tolower(ENVIRON["DA_WARNING"]); footer = tolower(ENVIRON["DA_FOOTER"])
        cursor = ENVIRON["DA_CURSOR"]
        # Flatten line by line (as flatten does) and remember where each line starts.
        flat = ""; first = 0
        for (i = 1; i <= NR; i++) {
          piece = tolower(line[i])
          gsub(/[ \t]+/, " ", piece); sub(/^ /, "", piece); sub(/ $/, "", piece)
          begins[i] = length(flat) + 1
          if (piece == "") continue
          if (flat != "") { flat = flat " "; begins[i] = length(flat) + 1 }
          flat = flat piece
          if (match(flat, warning)) { first = RSTART; break }
        }
        if (!first) exit 1
        # The warning may be wrapped: it starts on the last line that begins at or before it.
        top = i
        while (top > 1 && begins[top] > first) top--
        above = substr(flat, 1, begins[top] - 1)
        if (footer != "" && match(above, footer)) exit 0
        for (j = 1; j < top; j++) if (cursor != "" && match(line[j], cursor)) exit 0
        exit 1
      }'
}

KIND='unknown'
MATCHED='none'

# competing_dialog FLAT: status 0 and MATCHED set when the pane text holds the
# marker of any dialog other than dev-channels.
competing_dialog() {
  if has "$1" "$STARTUP_PAT_TRUST"; then MATCHED='STARTUP_PAT_TRUST'; return 0; fi
  if has "$1" "$STARTUP_PAT_EXTERNAL_IMPORTS"; then MATCHED='STARTUP_PAT_EXTERNAL_IMPORTS'; return 0; fi
  if has "$1" "$STARTUP_PAT_BYPASS"; then MATCHED='STARTUP_PAT_BYPASS'; return 0; fi
  if has "$1" "$STARTUP_PAT_LOGIN"; then MATCHED='STARTUP_PAT_LOGIN'; return 0; fi
  if has "$1" "$STARTUP_PAT_UPDATE"; then MATCHED='STARTUP_PAT_UPDATE'; return 0; fi
  if has "$1" "$STARTUP_PAT_OTHER_HINT"; then MATCHED='STARTUP_PAT_OTHER_HINT'; return 0; fi
  return 1
}

# classify RAW_PANE: sets KIND and MATCHED (the NAME of the pattern that decided).
classify() {
  local flat dialog after_option trailer selected
  flat="$(printf '%s' "$1" | flatten)"
  KIND='unknown'; MATCHED='none'
  if [ -z "${flat// /}" ]; then return 0; fi
  # A logged-out session draws the normal prompt too, but it is not working.
  if has "$flat" "$STARTUP_PAT_LOGGED_OUT"; then KIND='login'; MATCHED='STARTUP_PAT_LOGGED_OUT'; return 0; fi
  # A working session wins over every dialog: its conversation may quote dialogs.
  if has "$flat" "$STARTUP_PAT_READY"; then KIND='ready'; MATCHED='STARTUP_PAT_READY'; return 0; fi
  if has "$flat" "$STARTUP_PAT_DEVCH_WARNING" || has "$flat" "$STARTUP_PAT_DEVCH_OPTION"; then
    # Pressable only when the pane holds exactly ONE dialog and it is this one.
    # Every check below fails closed: dev-channels-unrecognized, nothing pressed.
    KIND='dev-channels-unrecognized'; MATCHED='STARTUP_PAT_DEVCH_WARNING'
    # 1. No marker of any other dialog anywhere in the pane.
    if competing_dialog "$flat"; then return 0; fi
    # 2. Exactly one confirm hint and exactly one highlighted numbered option
    #    in the whole pane (two of either means two dialogs).
    MATCHED='STARTUP_PAT_CONFIRM_HINT'
    [ "$(count_matches "$flat" "$STARTUP_PAT_CONFIRM_HINT")" = 1 ] || return 0
    MATCHED='STARTUP_PAT_CURSOR'
    [ "$(count_matches "$flat" "(${STARTUP_PAT_CURSOR}) ?[0-9][.)]")" = 1 ] || return 0
    # 3. The dialog is everything from the first warning text to the end of
    #    the pane. Text ABOVE it (shell command line, login notices) is not
    #    part of it; inside it there is exactly one cursor glyph.
    dialog="$(from_first "$flat" "$STARTUP_PAT_DEVCH_WARNING")" || { MATCHED='STARTUP_PAT_DEVCH_WARNING'; return 0; }
    [ "$(count_matches "$dialog" "$STARTUP_PAT_CURSOR")" = 1 ] || return 0
    #    Above it only plain text is allowed: a line that starts with a
    #    selection cursor, or a dialog footer phrase, is another dialog.
    MATCHED='STARTUP_PAT_ABOVE_CURSOR'
    if dialog_above "$1" "$STARTUP_PAT_DEVCH_WARNING"; then return 0; fi
    # 4. Shape: "<cursor> 1. <local development>", no third option, then the
    #    confirm hint, then nothing but the cancel hint.
    MATCHED='STARTUP_PAT_DEVCH_OPTION'
    selected="(${STARTUP_PAT_CURSOR}) ?1[.)] ?(${STARTUP_PAT_DEVCH_OPTION})"
    after_option="$(after_last "$dialog" "$selected")" || return 0
    if has "$after_option" '(^| )[3-9][.)] '; then return 0; fi
    trailer="$(after_last "$after_option" "$STARTUP_PAT_CONFIRM_HINT")" || { MATCHED='STARTUP_PAT_CONFIRM_HINT'; return 0; }
    if ! has "$trailer" "$STARTUP_PAT_DEVCH_TRAILER"; then MATCHED='STARTUP_PAT_DEVCH_TRAILER'; return 0; fi
    KIND='dev-channels'
    return 0
  fi
  if has "$flat" "$STARTUP_PAT_EXTERNAL_IMPORTS"; then KIND='external-imports'; MATCHED='STARTUP_PAT_EXTERNAL_IMPORTS'; return 0; fi
  if has "$flat" "$STARTUP_PAT_TRUST"; then KIND='trust-folder'; MATCHED='STARTUP_PAT_TRUST'; return 0; fi
  if has "$flat" "$STARTUP_PAT_BYPASS"; then KIND='bypass-permissions'; MATCHED='STARTUP_PAT_BYPASS'; return 0; fi
  if has "$flat" "$STARTUP_PAT_LOGIN"; then KIND='login'; MATCHED='STARTUP_PAT_LOGIN'; return 0; fi
  if has "$flat" "$STARTUP_PAT_UPDATE"; then KIND='update'; MATCHED='STARTUP_PAT_UPDATE'; return 0; fi
  if has "$flat" "$STARTUP_PAT_DIALOG"; then KIND='other-dialog'; MATCHED='STARTUP_PAT_DIALOG'; return 0; fi
  return 0
}

# The pane id (%N) the target resolved to. Set once, used for every look and key.
PANE_ID=''

# resolve_pane: status 0 when PANE_ID is known.
resolve_pane() {
  local id
  [ -z "$PANE_ID" ] || return 0
  id="$(tmux_cmd display-message -p -t "$TARGET" '#{pane_id}' 2>/dev/null)" || return 1
  case "$id" in
    %*) ;;
    *) return 1 ;;
  esac
  case "${id#%}" in ''|*[!0-9]*) return 1 ;; esac
  PANE_ID="$id"
  return 0
}

# look: capture the pinned pane and classify it.
look() {
  local pane
  if ! resolve_pane; then KIND='no-session'; MATCHED='none'; return 0; fi
  if pane="$(tmux_cmd capture-pane -p -t "$PANE_ID" 2>/dev/null)"; then
    classify "$pane"
  else
    KIND='no-session'; MATCHED='none'
  fi
}

code_for_kind() {
  case "$1" in
    ready) echo 0 ;;
    dev-channels) echo 10 ;;
    dev-channels-unrecognized) echo 4 ;;
    unknown) echo 6 ;;
    no-session) echo 7 ;;
    *) echo 5 ;;
  esac
}

if [ "$CLASSIFY_ONLY" = 1 ]; then
  # Read-only: takes no lock, so the periodic check can run next to a confirmer.
  look
  log "action=classify kind=$KIND matched=$MATCHED"
  echo "$KIND"
  exit "$(code_for_kind "$KIND")"
fi

# take_pane_lock: exits 8 unless this run now owns the lock of PANE_ID.
take_pane_lock() {
  local key rc
  key="$(printf '%s' "${SOCKET_FLAG}${SOCKET_VALUE}_${PANE_ID}" | LC_ALL=C tr -c 'A-Za-z0-9._-' '_')"
  mkdir -p "$LOCK_DIR" 2>/dev/null || true
  lock_take "$LOCK_DIR/$key.lock"
  rc=$?
  if [ "$rc" = 1 ]; then
    log "action=lock-held result=nothing-pressed exit=8"
    exit 8
  elif [ "$rc" != 0 ]; then
    log "action=lock-failed result=nothing-pressed exit=8"
    exit 8
  fi
}

# nap WANTED LEFT: sleep for the smaller of the two.
nap() {
  local t
  t="$(NAP_A="$1" NAP_B="$2" awk 'BEGIN { a = ENVIRON["NAP_A"] + 0; b = ENVIRON["NAP_B"] + 0; t = (a < b) ? a : b; print t }')"
  sleep "$t"
}

# time_left: whole seconds until the deadline, in LEFT; 0: it has passed.
# With the watchdog the deadline is its SIGALRM; the whole-second clock, which
# can be up to a second early or late, only backs it up: it ends the run when
# it is a full second past the deadline.
LEFT=0
time_left() {
  LEFT=$((TIMEOUT - (SECONDS - started)))
  if [ "$TIMEOUT" -eq 0 ] || [ "$DEADLINE_HIT" = 1 ]; then
    LEFT=0
  elif [ -n "$WATCHDOG_PID" ]; then
    if [ "$LEFT" -lt 0 ]; then LEFT=0; elif [ "$LEFT" -eq 0 ]; then LEFT=1; fi
  elif [ "$LEFT" -lt 0 ]; then
    LEFT=0
  fi
}

presses=0
last_kind=''
started=$SECONDS
start_watchdog
while :; do
  # The lock comes before the first look at the pane.
  if [ -z "$LOCK_PATH" ] && resolve_pane; then take_pane_lock; fi
  look
  if [ "$KIND" != "$last_kind" ]; then
    log "action=seen kind=$KIND matched=$MATCHED"
    last_kind="$KIND"
  fi
  case "$KIND" in
    ready)
      log "action=done result=ready presses=$presses"
      exit 0 ;;
    unknown)
      if [ "$presses" -gt 0 ]; then
        log "action=done result=screen-gone presses=$presses"
        exit 0
      fi ;;
    dev-channels)
      if [ "$presses" -ge "$MAX_PRESSES" ]; then
        log "action=give-up result=screen-persists presses=$presses"
        exit 3
      fi ;;
  esac
  # The deadline is computed again after EVERY look: a look can be slow.
  time_left
  if [ "$LEFT" -le 0 ]; then break; fi
  pause="$INTERVAL"
  if [ "$KIND" = 'dev-channels' ]; then
    if ! lock_mine; then
      log "action=lock-lost result=nothing-pressed exit=8"
      exit 8
    fi
    # Look again and send the key right after it: nothing slow and no sleep
    # between this look and send-keys (see RESIDUAL RISK in the header).
    look
    # That look may have taken long: no key once the deadline has passed.
    time_left
    if [ "$LEFT" -le 0 ]; then break; fi
    if [ "$KIND" = 'dev-channels' ]; then
      if ! tmux_cmd send-keys -t "$PANE_ID" Enter 2>/dev/null; then
        log "action=press-failed result=no-session"
        exit 7
      fi
      presses=$((presses + 1))
      log "action=press key=Enter n=$presses kind=dev-channels matched=$MATCHED"
      pause="$PRESS_PAUSE"
    fi
  fi
  # LEFT is at least 1 here. After a press the pane is looked at once more
  # even when the deadline passes meanwhile: the deadline forbids keys, not looks.
  nap "$pause" "$LEFT"
done

if [ "$KIND" = 'dev-channels' ]; then code=3; else code="$(code_for_kind "$KIND")"; fi
log "action=timeout kind=$KIND presses=$presses exit=$code"
exit "$code"
