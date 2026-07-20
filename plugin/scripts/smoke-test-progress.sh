#!/usr/bin/env bash
# smoke-test-progress.sh -- End-to-end check for the rolling activity card.
#
# Sends a synthetic PreToolUse/PostToolUse/Stop sequence into the local
# webhook endpoint and prints a pass/skip/fail table.
#
# Required env (or pass via flags):
#   TELEGRAM_WEBHOOK_URL    e.g. http://127.0.0.1:8093/hooks/agent
#   TELEGRAM_WEBHOOK_TOKEN  bearer token configured on the plugin
#   TELEGRAM_HOOK_CHAT_ID   target chat id (numeric string)
#
# Optional flags:
#   --bot-id 1234567   Expect /health to report this bot_id (sanity check)
#   --no-stop          Skip the final Stop event (leave the card "in progress")
#   --quiet            Only print the summary table at the end
#
# Exit codes:
#   0 -- all critical checks passed
#   1 -- at least one critical check failed (token, URL, webhook response)
#   2 -- usage / config error
#
# Usage examples:
#   TELEGRAM_HOOK_CHAT_ID=164795011 \
#   TELEGRAM_WEBHOOK_URL=http://127.0.0.1:8093/hooks/agent \
#   TELEGRAM_WEBHOOK_TOKEN=... \
#   bash scripts/smoke-test-progress.sh
#
#   bash scripts/smoke-test-progress.sh --quiet

set -uo pipefail

QUIET=0
NO_STOP=0
EXPECT_BOT_ID=""

while [ $# -gt 0 ]; do
  case "$1" in
    --bot-id)   EXPECT_BOT_ID="$2"; shift 2;;
    --no-stop)  NO_STOP=1; shift;;
    --quiet)    QUIET=1; shift;;
    -h|--help)
      sed -n 's/^# \{0,1\}//p' "$0" | head -n 30
      exit 0;;
    *)
      echo "smoke-test-progress.sh: unknown arg '$1'" >&2
      exit 2;;
  esac
done

URL="${TELEGRAM_WEBHOOK_URL:-}"
TOKEN="${TELEGRAM_WEBHOOK_TOKEN:-}"
CHAT="${TELEGRAM_HOOK_CHAT_ID:-}"
AGENT="${TELEGRAM_HOOK_AGENT_ID:-agent47-channel}"
HELPER_DEFAULT="$(cd "$(dirname "$0")" && pwd)/post-hook.ts"
HELPER="${POST_HOOK_HELPER:-$HELPER_DEFAULT}"

# Results table: name | status | note
results=()

record() {
  local name="$1" status="$2" note="${3:-}"
  results+=("$name|$status|$note")
  if [ "$QUIET" -eq 0 ]; then
    printf '%-40s [%s] %s\n' "$name" "$status" "$note"
  fi
}

# ─────────────────────────────────────────────────────────────────────
# 1. Pre-flight checks
# ─────────────────────────────────────────────────────────────────────

if [ -z "$URL" ]; then
  record "env TELEGRAM_WEBHOOK_URL" "fail" "not set"
  echo "Missing TELEGRAM_WEBHOOK_URL. Aborting." >&2
  exit 2
fi
record "env TELEGRAM_WEBHOOK_URL" "ok" "$URL"

if [ -z "$TOKEN" ]; then
  record "env TELEGRAM_WEBHOOK_TOKEN" "fail" "not set"
  echo "Missing TELEGRAM_WEBHOOK_TOKEN. Aborting." >&2
  exit 2
fi
record "env TELEGRAM_WEBHOOK_TOKEN" "ok" "redacted"

if [ -z "$CHAT" ]; then
  record "env TELEGRAM_HOOK_CHAT_ID" "fail" "not set"
  echo "Missing TELEGRAM_HOOK_CHAT_ID. Aborting." >&2
  exit 2
fi
record "env TELEGRAM_HOOK_CHAT_ID" "ok" "$CHAT"

if [ ! -f "$HELPER" ]; then
  record "helper post-hook.ts present" "fail" "$HELPER"
  exit 2
fi
record "helper post-hook.ts present" "ok" "$HELPER"

if ! command -v bun >/dev/null 2>&1; then
  record "bun on PATH" "fail" "install bun >= 1.0"
  exit 2
fi
record "bun on PATH" "ok" "$(bun --version 2>/dev/null)"

# Derive /health URL from /hooks/agent URL.
HEALTH_URL="${URL%/hooks/agent}/health"

# ─────────────────────────────────────────────────────────────────────
# 2. Webhook /health
# ─────────────────────────────────────────────────────────────────────

HEALTH_JSON="$(curl -sS --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
HEALTH_STATUS_FIELD="$(printf '%s' "$HEALTH_JSON" | grep -oE '"status"[[:space:]]*:[[:space:]]*"[a-z]+"' | head -n1)"
if [ -z "$HEALTH_STATUS_FIELD" ]; then
  record "webhook /health" "fail" "no response from $HEALTH_URL"
  exit 1
fi
record "webhook /health" "ok" "$HEALTH_STATUS_FIELD"

if [ -n "$EXPECT_BOT_ID" ]; then
  if echo "$HEALTH_JSON" | grep -q "\"bot_id\":$EXPECT_BOT_ID"; then
    record "bot_id match" "ok" "$EXPECT_BOT_ID"
  else
    record "bot_id match" "fail" "expected $EXPECT_BOT_ID"
  fi
fi

# ─────────────────────────────────────────────────────────────────────
# 3. Synthesise hook envelopes and fire them through post-hook.ts
# ─────────────────────────────────────────────────────────────────────

SESSION_ID="smoke-$(date +%s)-$$"
CWD_VAL="$(pwd)"
TRANSCRIPT_VAL="/tmp/smoke-${SESSION_ID}.transcript.json"
TUID1="tu-${SESSION_ID}-1"
TUID2="tu-${SESSION_ID}-2"

fire_event() {
  local name="$1" payload="$2"
  local out
  if ! out=$(printf '%s' "$payload" | \
      TELEGRAM_HOOK_CHAT_ID="$CHAT" \
      TELEGRAM_HOOK_AGENT_ID="$AGENT" \
      TELEGRAM_WEBHOOK_URL="$URL" \
      TELEGRAM_WEBHOOK_TOKEN="$TOKEN" \
      bun "$HELPER" 2>&1); then
    record "$name" "fail" "$(printf '%s' "$out" | head -c 120)"
    return 1
  fi
  if printf '%s' "$out" | grep -q "telegram-hook: webhook responded"; then
    record "$name" "fail" "$(printf '%s' "$out" | head -c 120)"
    return 1
  fi
  record "$name" "ok"
  return 0
}

ok_count=0
fail_count=0

pre_bash=$(cat <<EOF
{"hook_event_name":"PreToolUse","session_id":"$SESSION_ID","transcript_path":"$TRANSCRIPT_VAL","cwd":"$CWD_VAL","tool_name":"Bash","tool_use_id":"$TUID1","tool_input":{"command":"ls -la /tmp"}}
EOF
)
post_bash=$(cat <<EOF
{"hook_event_name":"PostToolUse","session_id":"$SESSION_ID","transcript_path":"$TRANSCRIPT_VAL","cwd":"$CWD_VAL","tool_name":"Bash","tool_use_id":"$TUID1","tool_input":{"command":"ls -la /tmp"}}
EOF
)
pre_edit=$(cat <<EOF
{"hook_event_name":"PreToolUse","session_id":"$SESSION_ID","transcript_path":"$TRANSCRIPT_VAL","cwd":"$CWD_VAL","tool_name":"Edit","tool_use_id":"$TUID2","tool_input":{"file_path":"/tmp/smoke.md","old_string":"a","new_string":"b"}}
EOF
)
post_edit=$(cat <<EOF
{"hook_event_name":"PostToolUse","session_id":"$SESSION_ID","transcript_path":"$TRANSCRIPT_VAL","cwd":"$CWD_VAL","tool_name":"Edit","tool_use_id":"$TUID2","tool_input":{"file_path":"/tmp/smoke.md","old_string":"a","new_string":"b"}}
EOF
)
stop_event=$(cat <<EOF
{"hook_event_name":"Stop","session_id":"$SESSION_ID","transcript_path":"$TRANSCRIPT_VAL","cwd":"$CWD_VAL"}
EOF
)

fire_event "PreToolUse  Bash" "$pre_bash"   && ok_count=$((ok_count+1)) || fail_count=$((fail_count+1))
sleep 1
fire_event "PostToolUse Bash" "$post_bash"  && ok_count=$((ok_count+1)) || fail_count=$((fail_count+1))
sleep 1
fire_event "PreToolUse  Edit" "$pre_edit"   && ok_count=$((ok_count+1)) || fail_count=$((fail_count+1))
sleep 1
fire_event "PostToolUse Edit" "$post_edit"  && ok_count=$((ok_count+1)) || fail_count=$((fail_count+1))

if [ "$NO_STOP" -eq 0 ]; then
  sleep 1
  fire_event "Stop"              "$stop_event" && ok_count=$((ok_count+1)) || fail_count=$((fail_count+1))
else
  record "Stop" "skip" "--no-stop"
fi

# ─────────────────────────────────────────────────────────────────────
# 4. Per-agent settings.json sanity (does NOT require live session)
# ─────────────────────────────────────────────────────────────────────

SETTINGS="${CLAUDE_SETTINGS_FILE:-$HOME/.claude-lab/thrall/.claude/settings.json}"
if [ -f "$SETTINGS" ]; then
  has_marker=$(grep -c '"marker": "agent47-channel-hook"' "$SETTINGS" 2>/dev/null || echo 0)
  if [ "$has_marker" -ge 5 ]; then
    record "settings.json hooks installed" "ok" "$has_marker entries"
  elif [ "$has_marker" -gt 0 ]; then
    record "settings.json hooks installed" "warn" "$has_marker / 5 entries"
  else
    record "settings.json hooks installed" "fail" "no agent47-channel-hook marker -- run install-hooks.sh"
  fi
else
  record "settings.json hooks installed" "skip" "$SETTINGS not found"
fi

# ─────────────────────────────────────────────────────────────────────
# 5. Summary
# ─────────────────────────────────────────────────────────────────────

echo
echo "================== smoke-test-progress.sh summary =================="
printf '%-40s %-8s %s\n' "CHECK" "STATUS" "NOTE"
printf '%-40s %-8s %s\n' "----------------------------------------" "--------" "----"
for row in "${results[@]}"; do
  IFS='|' read -r name status note <<< "$row"
  printf '%-40s [%-4s]  %s\n' "$name" "$status" "$note"
done
echo "===================================================================="
echo "events: $ok_count ok, $fail_count failed"
echo
echo "Manual verification: open Telegram chat $CHAT and confirm a"
echo "  <pre>working -- Ns ... done -- Ns</pre> block appeared with"
echo "  two recent tool lines (Bash + Edit)."

if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
exit 0
