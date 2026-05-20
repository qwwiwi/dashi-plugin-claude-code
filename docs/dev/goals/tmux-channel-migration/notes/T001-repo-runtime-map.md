# T001 Repo And Runtime Map

## Scope

Read-only Scout pass over the migration docs, current repo, related local repos, deployed gateway runtime path, existing channel prototype, launchd surfaces, and local verification commands.

Secrets were not intentionally read or recorded. Evidence below uses paths, counts, command names, and structural facts.

## Repo Map

- `qwwiwi-channel-telegram-Claude-code`: documentation/control repo. Contains migration docs and GoalBuddy control files only; no implementation source beyond generated HTML artifacts.
- `/Users/jasonqwwen/projects/jarvis-telegram-gateway`: public/generic gateway repo. Contains `gateway.py`, `requirements.txt`, and README. `gateway.py` is 3,472 lines.
- `/Users/jasonqwwen/.claude-lab/shared/gateway`: deployed/live gateway path. Contains `gateway.py`, `config.json`, shell maintenance scripts, logs/state/media directories, and tests. `gateway.py` is 3,748 lines.
- `/Users/jasonqwwen/.claude-lab/shared/channels/orgrimmar-inbox`: existing Bun/TypeScript MCP channel prototype. Contains `server.ts`, `package.json`, and `bun.lock`; no `.git` repository.
- `/Users/jasonqwwen/projects/agents-edgelab`: Tyrande/Hermes repo. README describes Hermes Agent on `165.245.219.131` with MiniMax and `hermes gateway start`.
- `/Users/jasonqwwen/Library/LaunchAgents`: production launchd surfaces include Orgrimmar gateway, gateway healthcheck/logrotate, multiple Silvana/Kaelthas/Garrosh cron jobs, and OpenClaw gateway.

## Current Gateway Evidence

- Active Orgrimmar launchd job path: `/Users/jasonqwwen/Library/LaunchAgents/ai.orgrimmar.gateway.plist`.
- Orgrimmar gateway launchd shape:
  - label: `ai.orgrimmar.gateway`
  - program: `/opt/homebrew/bin/python3`
  - argument: `/Users/jasonqwwen/.claude-lab/shared/gateway/gateway.py`
  - working directory: `/Users/jasonqwwen/.claude-lab/shared/gateway`
  - `RunAtLoad`: true
  - `KeepAlive`: crashed/successful-exit policy
  - stdout/stderr in the shared gateway directory
- Gateway config summary from `config.json`:
  - enabled agents: `silvana`, `kaelthas`, `claude`, `garrosh`
  - all enabled agents use token files, not inline Telegram tokens
  - allowlist user count: 1
  - allowlist group count: 2
  - webhook enabled on loopback default
  - Silvana/Kaelthas have Groq and OpenViking key files; Claude/Garrosh have Groq key files
- Secret file names exist under agent `secrets/` directories, including Telegram bot token files, but contents were not read.

## Gateway Behavior To Preserve

Evidence from `/Users/jasonqwwen/.claude-lab/shared/gateway/gateway.py`:

- Claude invocation is currently `claude -p` with `--output-format stream-json`, `--input-format text`, `--verbose`, `--permission-mode bypassPermissions`, and session tracking through `--session-id` / `--resume`.
- Per-agent Telegram long-poll uses `getUpdates`; producer/consumer architecture separates out-of-band commands from regular turns.
- OOB commands include `/stop`, `/cancel`, `/status`, `/reset`, and `/new`; `/compact` is handled in command path.
- Supports Telegram HTML conversion, long-message splitting, `sendMessage`, `editMessageText`, `deleteMessage`, reactions, and `sendDocument`.
- Supports media references for voice/audio/video_note, photo, document, video, and sticker; voice transcription uses Groq path from config.
- Albums are buffered by `media_group_id` with a flush timer before a single combined update is queued.
- Group and routing behavior includes user allowlist, group allowlist, group `group_allow_all`, topic routing, bot mention/name/reply addressing, and reply context injection.
- Webhook endpoint is `POST /hooks/agent`; it requires bearer auth and validates target chat against allowlists.
- Memory paths include hot memory append, verbose JSONL capture, OpenViking/L4 semantic push, group context injection, and compact/handoff flows.
- Tests currently present: `/Users/jasonqwwen/.claude-lab/shared/gateway/tests/test_gateway_l4_http.py` with 404 lines of L4 HTTP parity coverage. Fixture imports gateway in a temp cwd to avoid racing live state.

## Existing Channel Prototype Evidence

`/Users/jasonqwwen/.claude-lab/shared/channels/orgrimmar-inbox/server.ts` is a Bun MCP server with:

- `@modelcontextprotocol/sdk` stdio transport.
- experimental `claude/channel` capability.
- Firebase/orgbus inbox polling from `messages/inbox/${ORGRIMMAR_AGENT}`.
- channel notifications through `notifications/claude/channel`.
- tools `reply_to_agent` and `clear_inbox`.
- agent-name validation, message-id validation, reply rate limit, initial sync behavior, seen-id cap, and orphan watchdog.

Gaps against tmux/Telegram migration:

- It is an inter-agent Firebase inbox channel, not a Telegram `getUpdates` channel.
- No tmux supervisor or launchd wrapper exists here.
- No Telegram token consumer, durable Telegram queue, permission relay, media/voice/albums, parity replay, or per-agent rollback runbook.
- It is not in a git repo, so implementation changes there would need explicit ownership/backup discipline.

## Local Toolchain

- `claude --version`: `2.1.141 (Claude Code)`.
- `bun --version`: `1.3.13`.
- `tmux -V`: `tmux 3.6a`.
- `pytest --version` in shared gateway: `pytest 9.0.3`.
- `claude --help | rg "channels|dangerously-load|permission|print|resume|session-id"` shows print/resume/session/permission flags but did not show `channels` or `dangerously-load-development-channels`. This is a pre-flight risk: either the flags are hidden, moved, plugin-gated, or unavailable in this installed CLI build.

## Verification Command Candidates

Safe local/read-only:

- `node /Users/jasonqwwen/.codex/plugins/cache/goalbuddy/goalbuddy/0.3.6/skills/goalbuddy/scripts/check-goal-state.mjs docs/goals/tmux-channel-migration/state.yaml`
- `claude --version`
- `claude --help | rg "channels|dangerously-load|permission|print|resume|session-id"`
- `bun --version`
- `tmux -V`
- `pytest --version`
- `pytest tests/test_gateway_l4_http.py` from `/Users/jasonqwwen/.claude-lab/shared/gateway`

Useful but should be bounded:

- `bun --version` and static TypeScript checks for any new channel/supervisor artifact.
- `tmux has-session -t <test-session>` / `tmux new-session -d -s <test-session> ...` only for a clearly non-production canary session and test token path.
- `launchctl print gui/$UID/<label>` read-only status checks only; no load/unload/bootstrap/bootout without operator approval.

Production-gated:

- Any Telegram `getUpdates` call using production token files.
- Any `launchctl load`, `launchctl unload`, `bootstrap`, `bootout`, or production plist mutation.
- Any current gateway `config.json` mutation.
- Any Anthropic dashboard/support billing proof.

## Risk And Approval Gates

- One token, one consumer: production gateway remains active, so no new production Telegram consumer can start.
- `claude --help` did not confirm the documented channel CLI flags locally.
- Current gateway uses `--permission-mode bypassPermissions`; target path explicitly rejects default blanket bypass and needs a relay/pre-trust design.
- Deployed shared gateway has extensive dirty runtime state and logs; avoid broad git operations there.
- Existing Orgrimmar channel prototype is outside the current repo and not under git.
- Production billing classification cannot be proven locally.
- At least one unrelated launchd plist contains inline secret-like environment variables; do not print plist contents broadly.

## Ranked Safe First Worker Packages

1. **Add a local migration baseline artifact in this docs repo.**
   - Why: reduces migration risk immediately without touching production, tokens, launchd, or private runtime files.
   - Scope: create a concise baseline/runbook under `docs/` that captures the current gateway parity surface, local paths, verification commands, pre-flight blockers, and first canary gates.
   - Verification: markdown lint if available; otherwise `rg`/`sed` sanity plus GoalBuddy checker.

2. **Create a scaffolded tmux supervisor design/artifact in this docs repo.**
   - Why: advances Phase 1 shape while avoiding writes to live shared channel/gateway paths.
   - Scope: document command contract (`start|stop|restart|status|attach|logs`), session names, metadata path, rollback gates, and no-production-token policy.
   - Verification: shell snippets remain illustrative or use `shellcheck` only if script is created.

3. **Add tests/documentation for CLI pre-flight detection.**
   - Why: the local CLI did not show channel flags, which blocks canary execution.
   - Scope: document and/or script a redacted pre-flight check that records version, help flag presence, Bun, tmux, and pytest availability.
   - Verification: run the script locally; ensure it prints no secrets and does not touch services.

4. **Work in `/Users/jasonqwwen/.claude-lab/shared/channels/orgrimmar-inbox` only after explicit allowed_files include that path.**
   - Why: it already uses `claude/channel`, but it is not a Telegram runtime and is not in git.
   - Stop if: any change requires credentials, orgbus live writes, Telegram tokens, or production session start.

5. **Live gateway parity tests only after a bounded task permits `/Users/jasonqwwen/.claude-lab/shared/gateway/tests` and avoids runtime dirs.**
   - Why: deployed gateway tests exist, but the working tree is noisy and live-adjacent.
   - Stop if: importing or tests attempt to mutate live gateway working directory.
