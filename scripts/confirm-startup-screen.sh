#!/bin/bash
# confirm-startup-screen.sh: content-aware confirm of the Claude Code
# "Loading development channels" startup screen inside a tmux pane.
#
# Rule: never send blind input. The only key this script ever sends is Enter,
# and only while the pane shows the dev-channels warning with option 1 (the
# "local development" one) under the cursor. Every other screen is only
# classified and reported.
#
# Usage:
#   confirm-startup-screen.sh [-L socket-name | -S socket-path] [options] <target>
#
#   <target>            tmux target (session, session:window.pane, %pane-id)
#   -L NAME / -S PATH   tmux socket, passed to tmux as is (default socket if absent)
#   --timeout SEC       how long to watch the pane (default 90)
#   --interval SEC      pause between looks (default 2)
#   --max-presses N     Enter presses at most (default 2)
#   --press-pause SEC   pause after a press before looking again (default 3)
#   --log FILE          append the log lines to FILE too
#   --classify          look once, print the screen kind to stdout, press nothing
#   --dry-run           same as --classify
#
# Exit codes:
#   0   session is at the normal prompt, or the screen went away after our Enter
#   2   usage error
#   3   dev-channels screen still showing after --max-presses presses
#   4   dev-channels warning in a shape we do not recognise: nothing pressed
#   5   another startup dialog is showing: nothing pressed
#   6   nothing recognised within the timeout: nothing pressed
#   7   tmux session/pane not reachable
#   10  (--classify only) dev-channels screen that WOULD be confirmed
#
# Screen kinds: ready, dev-channels, dev-channels-unrecognized, external-imports,
# trust-folder, bypass-permissions, login, update, other-dialog, unknown, no-session.
#
# Works with bash 3.2 (macOS) and newer. Needs tmux, sed, awk, grep, tr.
set -u

# ─── Patterns ────────────────────────────────────────────────────────────────
# Extended regular expressions, matched case-insensitively against the pane
# text after it was flattened: ANSI escapes and box-drawing characters removed,
# all whitespace (including line breaks) squeezed to single spaces. So a phrase
# matches even when the dialog wraps it over two lines.
# Each one can be overridden by an environment variable of the same name.
#
# NOTE: the defaults are reconstructed from documentation, not from a capture
# of every Claude Code version. After capturing a real screen, check it with
# `--classify` and adjust here.

# The dev-channels warning itself (any one alternative is enough).
: "${STARTUP_PAT_DEVCH_WARNING:=Loading development channels|dangerously-load-development-channels is for local development}"
# Label of option 1, the choice we are allowed to confirm.
: "${STARTUP_PAT_DEVCH_OPTION:=I am using this for local development}"
# The hint that says Enter confirms the highlighted option.
: "${STARTUP_PAT_CONFIRM_HINT:=Enter to confirm}"
# What may follow that hint up to the end of the pane. Anything else below the
# dialog means the pane is not just this dialog.
: "${STARTUP_PAT_DEVCH_TRAILER:=^( |·|•|\\||/|Esc to cancel)*\$}"
# Selection cursor drawn in front of the highlighted option.
: "${STARTUP_PAT_CURSOR:=❯|›|▶|→|>}"
# Normal working session (channel banner, input box footer).
: "${STARTUP_PAT_READY:=Listening for channel messages|messages from server:[A-Za-z0-9_-]+ inject|bypass permissions on|\\? for shortcuts}"
# Other startup dialogs: reported, never answered.
: "${STARTUP_PAT_EXTERNAL_IMPORTS:=external CLAUDE\\.md file imports}"
: "${STARTUP_PAT_TRUST:=Do you trust the files|trust this folder|Is this a project you created or one you trust}"
: "${STARTUP_PAT_BYPASS:=Bypass Permissions mode}"
: "${STARTUP_PAT_LOGIN:=Select login method|Paste code here|Please run /login|Invalid API key}"
: "${STARTUP_PAT_UPDATE:=Update available|Auto-update failed|new version is available}"
# Any other selection dialog.
: "${STARTUP_PAT_DIALOG:=Enter to confirm|Enter to select|Esc to cancel|Press Enter to continue}"
# ─────────────────────────────────────────────────────────────────────────────

TMUX_BIN="${TMUX_BIN:-tmux}"
TIMEOUT="${STARTUP_CONFIRM_TIMEOUT:-90}"
INTERVAL="${STARTUP_CONFIRM_INTERVAL:-2}"
MAX_PRESSES="${STARTUP_CONFIRM_MAX_PRESSES:-2}"
PRESS_PAUSE="${STARTUP_CONFIRM_PRESS_PAUSE:-3}"
LOG_FILE=''
CLASSIFY_ONLY=0
TARGET=''
SOCKET_FLAG=''
SOCKET_VALUE=''

usage() {
  sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//' >&2
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
case "$TIMEOUT$MAX_PRESSES" in
  *[!0-9]*) echo "confirm-startup-screen: --timeout and --max-presses must be whole numbers" >&2; exit 2 ;;
esac

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

tmux_cmd() {
  if [ -n "$SOCKET_FLAG" ]; then
    "$TMUX_BIN" "$SOCKET_FLAG" "$SOCKET_VALUE" "$@"
  else
    "$TMUX_BIN" "$@"
  fi
}

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

KIND='unknown'
MATCHED='none'

# classify RAW_PANE: sets KIND and MATCHED (the NAME of the pattern that decided).
classify() {
  local flat tail after_option trailer selected
  flat="$(printf '%s' "$1" | flatten)"
  KIND='unknown'; MATCHED='none'
  if [ -z "${flat// /}" ]; then return 0; fi
  # A working session wins over everything: its conversation may quote dialogs.
  if has "$flat" "$STARTUP_PAT_READY"; then KIND='ready'; MATCHED='STARTUP_PAT_READY'; return 0; fi
  if has "$flat" "$STARTUP_PAT_DEVCH_WARNING" || has "$flat" "$STARTUP_PAT_DEVCH_OPTION"; then
    KIND='dev-channels-unrecognized'; MATCHED='STARTUP_PAT_DEVCH_WARNING'
    selected="(${STARTUP_PAT_CURSOR}) ?1[.)] ?(${STARTUP_PAT_DEVCH_OPTION})"
    # Shape: warning, then "<cursor> 1. <local development>", no cursor on
    # another option, no third option, then the confirm hint, then nothing.
    tail="$(after_last "$flat" "$STARTUP_PAT_DEVCH_WARNING")" || return 0
    after_option="$(after_last "$tail" "$selected")" || return 0
    if has "$tail" "(${STARTUP_PAT_CURSOR}) ?[2-9][.)]"; then return 0; fi
    if has "$after_option" '(^| )[3-9][.)] '; then return 0; fi
    trailer="$(after_last "$after_option" "$STARTUP_PAT_CONFIRM_HINT")" || return 0
    if ! has "$trailer" "$STARTUP_PAT_DEVCH_TRAILER"; then return 0; fi
    KIND='dev-channels'; MATCHED='STARTUP_PAT_DEVCH_OPTION'
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

# look: capture the pane and classify it.
look() {
  local pane
  if pane="$(tmux_cmd capture-pane -p -t "$TARGET" 2>/dev/null)"; then
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
  look
  log "action=classify kind=$KIND matched=$MATCHED"
  echo "$KIND"
  exit "$(code_for_kind "$KIND")"
fi

presses=0
last_kind=''
started=$SECONDS
while :; do
  look
  if [ "$KIND" != "$last_kind" ]; then
    log "action=seen kind=$KIND matched=$MATCHED"
    last_kind="$KIND"
  fi
  case "$KIND" in
    ready)
      log "action=done result=ready presses=$presses"
      exit 0 ;;
    dev-channels)
      if [ "$presses" -ge "$MAX_PRESSES" ]; then
        log "action=give-up result=screen-persists presses=$presses"
        exit 3
      fi
      # Look again right before the key, so a screen that changed in between gets no input.
      look
      if [ "$KIND" = 'dev-channels' ]; then
        if ! tmux_cmd send-keys -t "$TARGET" Enter 2>/dev/null; then
          log "action=press-failed result=no-session"
          exit 7
        fi
        presses=$((presses + 1))
        log "action=press key=Enter n=$presses kind=dev-channels matched=$MATCHED"
        sleep "$PRESS_PAUSE"
      fi
      continue ;;
    unknown)
      if [ "$presses" -gt 0 ]; then
        log "action=done result=screen-gone presses=$presses"
        exit 0
      fi ;;
  esac
  if [ $((SECONDS - started)) -ge "$TIMEOUT" ]; then break; fi
  sleep "$INTERVAL"
done

code="$(code_for_kind "$KIND")"
log "action=timeout kind=$KIND presses=$presses exit=$code"
exit "$code"
