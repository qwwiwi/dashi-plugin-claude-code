#!/usr/bin/env bash
# Shared nonsecret orchestration for the clone lifecycle entrypoints.
set -euo pipefail

fail() { echo "Error: $*" >&2; exit 1; }
backup() {
  local target="$1" dest serial=0
  if [[ -e "$target" ]]; then
    dest="${target}.bak.$(date -u +%Y%m%dT%H%M%S).$$"
    while [[ -e "$dest" ]]; do serial=$((serial + 1)); dest="${dest}.${serial}"; done
    echo "Backup: $target -> $dest"
    cp -p "$target" "$dest"
    # A copy of the private env holds the plaintext bot token: never leave it readable by others.
    if [[ "$(basename "$target")" == channel.env ]]; then chmod 600 "$dest"; fi
  fi
}
require_file() { [[ -f "$1" ]] || fail "Missing required file: $1"; }
# Version parsing tolerates Claude's '(Claude Code)' suffix.
version_at_least() {
  local version="$1" major="$2" minor="$3" patch="$4" a b c
  [[ "$version" =~ ([0-9]+)\.([0-9]+)\.([0-9]+) ]] || return 1
  a="${BASH_REMATCH[1]}"; b="${BASH_REMATCH[2]}"; c="${BASH_REMATCH[3]}"
  (( 10#$a > major || (10#$a == major && 10#$b > minor) || (10#$a == major && 10#$b == minor && 10#$c >= patch) ))
}
prerequisites() {
  local missing=0 tool hint
  for tool in claude bun tmux git; do
    case "$tool" in
      claude) hint='curl -fsSL https://claude.ai/install.sh | bash';;
      bun) hint='curl -fsSL https://bun.sh/install | bash';;
      tmux) if [[ "$PLATFORM" == Darwin ]]; then hint='brew install tmux'; else hint='sudo apt-get update && sudo apt-get install tmux (Debian/Ubuntu)'; fi;;
      git) if [[ "$PLATFORM" == Darwin ]]; then hint='xcode-select --install'; else hint='sudo apt-get update && sudo apt-get install git (Debian/Ubuntu)'; fi;;
    esac
    if ! command -v "$tool" >/dev/null 2>&1; then echo "Missing $tool. Install: $hint" >&2; missing=1; fi
  done
  [[ "$missing" == 0 ]] || exit 1
  version_at_least "$(claude --version)" 2 1 0 || fail 'Claude >=2.1.0 required by doctor (README recommends >=2.1.80). Upgrade: claude update'
  version_at_least "$(bun --version)" 1 3 9 || fail 'Bun >=1.3.9 required. Upgrade: bun upgrade'
  tmux -V >/dev/null || fail 'tmux cannot run. Install tmux using your package manager.'
  git --version >/dev/null || fail 'git cannot run. Install git using your package manager.'
  echo 'Prerequisites OK: Claude >=2.1.0, Bun >=1.3.9, tmux, git'
}
platform() {
  PLATFORM="$(uname -s)"
  [[ "$PLATFORM" == Linux || "$PLATFORM" == Darwin ]] || fail 'Only Linux and macOS are supported'
}
absolute() { [[ "$1" == /* && "$1" != *$'\n'* && "$1" != *$'\r'* ]] || fail 'Paths must be absolute and contain no newlines'; }
read_context() {
  local context
  require_file "$STATE_DIR/install.json"
  context="$(bun "$REPO/scripts/lifecycle-context.ts" "$STATE_DIR" "$SETTINGS")" || fail 'Cannot read installation context; rerun install.sh with explicit inputs'
  { IFS= read -r AGENT; IFS= read -r WORKSPACE; IFS= read -r SETTINGS; IFS= read -r ENV_FILE; IFS= read -r SERVICE; IFS= read -r SESSION; IFS= read -r OWNER_ID; IFS= read -r WEBHOOK_URL; IFS= read -r CONFIG_FILE; IFS= read -r CHAT_ID; } <<< "$context"
}
run_doctor() {
  local latest="${1:-}"
  local args=("$REPO/skills/doctor-dashi-plugin/scripts/doctor.ts" --plugin-dir "$REPO/plugin" --settings "$SETTINGS" --mcp "$STATE_DIR/channel.mcp.json" --env "$ENV_FILE" --env-loader shell --user "$OWNER_ID" --chat "$CHAT_ID" --session "$SESSION" --no-autodetect)
  [[ -z "$latest" ]] || args+=(--check-latest)
  echo 'Running doctor (read-only; readiness may require starting/authenticating the channel)'
  if ! bun "${args[@]}"; then echo 'Doctor reported FAIL or incomplete coverage. Follow the summary actions, then rerun doctor after starting the channel.'; fi
}
restart_hint() {
  if [[ "$PLATFORM" == Linux ]]; then printf 'Restart from an external terminal: sudo systemctl restart %q\n' "channel-$AGENT.service"
  else printf 'Restart from an external terminal: launchctl kickstart -k %q\n' "gui/$(id -u)/com.dashi-plugin.channel-$AGENT"; fi
}
inside_channel() {
  [[ -n "${TMUX:-}" ]] || return 1
  local current
  current="$(tmux display-message -p '#S' 2>/dev/null)" || return 0
  [[ "$current" == "$SESSION" ]]
}
