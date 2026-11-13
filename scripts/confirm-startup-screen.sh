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
# (default ~/.local/state/dashi-startup-screen/locks), STARTUP_PAT_* (patterns).
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
#
# Screen kinds: ready, dev-channels, dev-channels-unrecognized, external-imports,
# trust-folder, bypass-permissions, login, update, other-dialog, unknown,
# no-session, tmux-missing.
#
# How the key is kept on the right screen:
#   - the target is resolved to a tmux pane id once; every look and the key go
#     to that id, so a renamed session or a changed active pane cannot redirect
#     the key;
#   - one confirmer per pane: a lock directory (mkdir is atomic) is held for
#     the whole run; a second confirmer exits 8 without pressing;
#   - the pane is looked at again immediately before the key, with no sleep in
#     between.
# RESIDUAL RISK (accepted, cannot be closed with tmux): capture-pane and
# send-keys are two separate tmux calls. If Claude Code replaces the dialog in
# the few milliseconds between the last look and the key, Enter lands on the
# new screen. The lock removes other confirmers from that window, not Claude
# Code itself or a human typing into the pane.
#
# Works with bash 3.2 (macOS) and newer. Needs tmux, sed, awk, grep, tr, find.
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
# ─────────────────────────────────────────────────────────────────────────────

TMUX_BIN="${TMUX_BIN:-tmux}"
TIMEOUT="${STARTUP_CONFIRM_TIMEOUT:-90}"
INTERVAL="${STARTUP_CONFIRM_INTERVAL:-2}"
MAX_PRESSES="${STARTUP_CONFIRM_MAX_PRESSES:-2}"
PRESS_PAUSE="${STARTUP_CONFIRM_PRESS_PAUSE:-3}"
LOCK_DIR="${STARTUP_CONFIRM_LOCK_DIR:-${XDG_STATE_HOME:-${HOME:-/tmp}/.local/state}/dashi-startup-screen/locks}"
# A lock older than this many minutes is stale even when its owner pid is alive
# (a hung run or a reused pid).
LOCK_STALE_MIN="${STARTUP_LOCK_STALE_MIN:-30}"
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
if ! is_whole "$TIMEOUT" || ! is_whole "$MAX_PRESSES" || ! is_whole "$LOCK_STALE_MIN"; then
  echo "confirm-startup-screen: --timeout and --max-presses must be whole numbers" >&2
  exit 2
fi
if ! is_seconds "$INTERVAL" || ! is_seconds "$PRESS_PAUSE"; then
  echo "confirm-startup-screen: --interval and --press-pause must be numbers of seconds" >&2
  exit 2
fi
# Force base 10: "08" would otherwise be read as a broken octal number.
TIMEOUT=$((10#$TIMEOUT))
MAX_PRESSES=$((10#$MAX_PRESSES))
LOCK_STALE_MIN=$((10#$LOCK_STALE_MIN))

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
# Portable (no flock on macOS): `mkdir` either creates the directory or fails,
# atomically. The directory holds a `pid` file with its owner.
# Stale rule: owner pid not running; or no pid file and the directory is older
# than a minute (owner died between mkdir and the write); or the directory is
# older than LOCK_STALE_MIN minutes. A stale lock is renamed away (atomic) and
# then removed, so two processes cannot both inherit it; ownership is checked
# again right before every key.
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
    rm -f "$LOCK_PATH/pid"
    rmdir "$LOCK_PATH" 2>/dev/null || true
  fi
  LOCK_PATH=''
}

trap lock_release EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# ─────────────────────────────────────────────────────────────────────────────

ESC="$(printf '\033')"
BEL="$(printf '\007')"
NBSP="$(printf '\302\240')"

# stdin: raw pane text. stdout: one flattened line.
flatten() {
  LC_ALL=C sed -E \
    -e "s/${ESC}\\[[0-9;?]*[ -/]*[@-~]//g" \
    -e "s/${ESC}\\][^${BEL}]*${BEL}//g" \
    -e "s/${NBSP}/ /g" \
    -e 's/(│|┃|║|╭|╮|╰|╯|─|━|═|┌|┐|└|┘|├|┤)/ /g' \
    | LC_ALL=C tr '\r\n\t' '   ' | LC_ALL=C tr -s ' '
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

presses=0
last_kind=''
started=$SECONDS
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
  # The deadline is checked on every iteration and before any key.
  left=$((TIMEOUT - (SECONDS - started)))
  if [ "$left" -le 0 ]; then break; fi
  pause="$INTERVAL"
  if [ "$KIND" = 'dev-channels' ]; then
    if ! lock_mine; then
      log "action=lock-lost result=nothing-pressed exit=8"
      exit 8
    fi
    # Look again and send the key right after it: nothing slow and no sleep
    # between this look and send-keys (see RESIDUAL RISK in the header).
    look
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
  nap "$pause" "$left"
done

if [ "$KIND" = 'dev-channels' ]; then code=3; else code="$(code_for_kind "$KIND")"; fi
log "action=timeout kind=$KIND presses=$presses exit=$code"
exit "$code"
