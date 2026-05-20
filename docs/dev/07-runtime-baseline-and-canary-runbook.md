# Runtime baseline and tmux canary runbook

Purpose: capture the local Orgrimmar gateway baseline and define the first safe tmux/channel canary path before any production Telegram token, launchd job, or live gateway file is changed.

This document is an execution artifact for the tmux-first migration. It does not contain secrets, token values, OAuth material, private keys, or full production configs.

## Hard boundaries

- Do not run old and new Telegram `getUpdates` consumers on the same production bot token.
- Do not unload, load, bootstrap, bootout, or mutate production launchd jobs without explicit operator approval.
- Do not edit `/Users/jasonqwwen/.claude-lab/shared/gateway/config.json` during canary work.
- Do not read or print token/key contents. Use token file existence and path shape only.
- Do not default to `--dangerously-skip-permissions`.
- Use a separate test bot token for the canary.
- Keep `ai.orgrimmar.gateway` as the rollback path until parity and billing evidence are recorded.

## Current local runtime baseline

### Documentation repo

- Repo: `qwwiwi-channel-telegram-Claude-code`
- Role: migration documentation and GoalBuddy control board.
- Implementation source: none in the repo at the start of this tranche.
- Primary migration plan: `docs/06-tmux-migration-goal-plan.md`
- Completion criteria: `docs/05-success-criteria.md`

### Current production gateway

- Live path: `/Users/jasonqwwen/.claude-lab/shared/gateway`
- Main file: `/Users/jasonqwwen/.claude-lab/shared/gateway/gateway.py`
- Size observed: 3,748 lines.
- Launchd plist: `/Users/jasonqwwen/Library/LaunchAgents/ai.orgrimmar.gateway.plist`
- Launchd label: `ai.orgrimmar.gateway`
- Program shape: `/opt/homebrew/bin/python3 /Users/jasonqwwen/.claude-lab/shared/gateway/gateway.py`
- Working directory: `/Users/jasonqwwen/.claude-lab/shared/gateway`
- Stdout/stderr: files under `/Users/jasonqwwen/.claude-lab/shared/gateway`
- KeepAlive: crash restart policy enabled.

### Current gateway behavior to preserve

The deployed gateway currently uses `claude -p` per turn, with stream-json output and session tracking through `--session-id` / `--resume`. It also uses `--permission-mode bypassPermissions`, which must not become the default in the tmux/channel path.

Parity surface observed in the deployed gateway:

- Telegram long-poll through `getUpdates`.
- Per-agent producer/consumer queues.
- Per-chat worker ordering.
- OOB commands: `/stop`, `/cancel`, `/status`, `/reset`, `/new`.
- Command path for `/compact`.
- Telegram HTML conversion and parse-error fallback.
- Long message splitting.
- Status/progress edits through `editMessageText`.
- Reactions and document sending.
- Media handling for voice/audio/video_note, photo, document, video, and sticker.
- Groq-backed voice transcription path.
- Album buffering by `media_group_id`.
- User allowlist and group allowlist.
- Group addressing by mention/name/reply.
- Optional `group_allow_all`.
- Topic routing.
- Reply context injection as untrusted metadata.
- Webhook endpoint at `POST /hooks/agent` with bearer auth and chat allowlist checks.
- Hot memory append.
- Verbose JSONL capture.
- OpenViking/L4 semantic push.
- Group context injection.
- Handoff/compact flows.

### Current enabled agent shape

Config summary, without secret values:

| Agent | Enabled | Workspace | Model | Token storage | Voice key file | Memory key file |
|---|---:|---|---|---|---|---|
| silvana | yes | `~/.claude-lab/silvana/.claude` | opus | file | yes | yes |
| kaelthas | yes | `~/.claude-lab/kaelthas/.claude` | opus | file | yes | yes |
| claude | yes | `~/.claude-lab/claude/.claude` | opus | file | yes | no |
| garrosh | yes | `~/.claude-lab/garrosh/.claude` | sonnet | file | yes | no |

Observed shared config shape:

- allowlisted users: 1
- allowlisted groups: 2
- webhook enabled
- default webhook host: loopback
- production Telegram token values were not read

### Existing channel prototype

- Path: `/Users/jasonqwwen/.claude-lab/shared/channels/orgrimmar-inbox`
- Files: `server.ts`, `package.json`, `bun.lock`
- Runtime: Bun + `@modelcontextprotocol/sdk`
- Capability: experimental `claude/channel`
- Transport: stdio
- Source: Firebase/orgbus inbox polling from `messages/inbox/${ORGRIMMAR_AGENT}`
- Tools: `reply_to_agent`, `clear_inbox`

This is useful as a small local Channels example, but it is not the Telegram migration runtime. It does not provide Telegram long-poll, durable Telegram queue, tmux supervision, permission relay, media/voice/albums, parity replay, or rollback.

## Toolchain baseline

Observed locally:

```text
claude --version -> 2.1.141 (Claude Code)
bun --version    -> 1.3.13
tmux -V          -> tmux 3.6a
pytest --version -> pytest 9.0.3
```

Important blocker: `claude --help | rg "channels|dangerously-load|permission|print|resume|session-id"` showed print/resume/session/permission flags, but did not show `channels` or `dangerously-load-development-channels`. Before a live canary, confirm whether channel flags are hidden, plugin-gated, renamed, or unavailable in the installed CLI.

## Safe verification commands

These commands are local/read-only or limited to this docs repo:

```bash
node /Users/jasonqwwen/.codex/plugins/cache/goalbuddy/goalbuddy/0.3.6/skills/goalbuddy/scripts/check-goal-state.mjs docs/goals/tmux-channel-migration/state.yaml
claude --version
claude --help | rg "channels|dangerously-load|permission|print|resume|session-id"
bun --version
tmux -V
pytest --version
```

Gateway tests can be run only from the deployed gateway path and should stay clear of production runtime files:

```bash
cd /Users/jasonqwwen/.claude-lab/shared/gateway
pytest tests/test_gateway_l4_http.py
```

The existing fixture imports `gateway.py` from a temporary cwd to avoid racing the live gateway working directory. Do not broaden this test run to runtime logs, token files, media, or state directories without a separate task.

## Parity baseline matrix

| Area | Current evidence | Required before Silvana cutover |
|---|---|---|
| Text DM | `gateway.py` `sendMessage`, markdown/HTML conversion, session resume | 50 text turns on test token, no drops, no duplicates |
| Group routing | group allowlist, mention/name/reply addressing | group mention/reply smoke and topic behavior if Silvana uses topics |
| Topic routing | `topic_routing` branch in producer | explicit topic test or documented not used for Silvana |
| Long answer split | Telegram chunking in send path | long answer split smoke with valid HTML fallback |
| Status/progress | lazy status message plus edit path | progress edits or deliberate MVP status equivalent |
| `/status` | command handler | command smoke |
| `/stop` | OOB producer path kills active subprocess | long-task stop smoke |
| `/reset` / `/new` | queued blocking handoff path | reset/new smoke and session state check |
| `/compact` | command path invokes compact prompt | compact smoke or scoped deferral |
| Media | photo/document/video/sticker refs | photo/document smoke before production token |
| Voice | Groq transcription path | voice smoke before production token |
| Albums | `media_group_id` buffer | required before all-agent cutover |
| Webhooks | `/hooks/agent` endpoint with auth and allowlist | webhook injection test with test chat only |
| Memory | hot memory, verbose JSONL, OpenViking/L4 push | preserve or explicitly defer per phase |
| Permissions | current path bypasses permissions | permission relay allow/deny/non-owner/stale-code tests |
| Rollback | current gateway remains launchd job | per-agent rollback under 5 minutes before token movement |

## Canary runbook

### Gate 0: confirm channel CLI availability

Do not start the canary until the local CLI can be proven to support the channel invocation shape.

Required evidence:

```bash
claude --version
claude --help | rg "channels|dangerously-load"
```

If help remains silent, use official Claude Code channel docs or a local plugin registry command to confirm the current syntax before any launchd/tmux work. Record the exact command that is expected to start a channel session.

Stop if channel flags cannot be confirmed.

### Gate 1: prepare test-only inputs

Use only a separate test bot token.

Required local facts:

- test token file path exists
- token contents are not printed
- test chat ID is known to the operator
- canary agent name does not collide with production agents
- tmux session name is non-production, for example `orgrimmar-canary`
- state/log paths are under a canary-specific directory

Do not use token files from:

- `~/.claude-lab/silvana/secrets/telegram-bot-token`
- `~/.claude-lab/kaelthas/secrets/telegram-bot-token`
- `~/.claude-lab/garrosh/secrets/telegram-bot-token`
- `~/.claude-lab/claude/secrets/telegram-bot-token`

### Gate 2: start tmux canary manually

This gate is intentionally manual until channel CLI syntax and test token handling are confirmed.

Expected supervisor behavior for the eventual `dashi-channel-supervisor`:

```text
dashi-channel-supervisor start canary
dashi-channel-supervisor status canary
dashi-channel-supervisor attach canary
dashi-channel-supervisor logs canary
dashi-channel-supervisor restart canary
dashi-channel-supervisor stop canary
```

Expected tmux properties:

- session exists before the first Telegram smoke test
- `tmux attach -t orgrimmar-canary` shows an interactive Claude Code session
- detach path is documented as `Ctrl-b d`
- metadata records session name, working directory, plugin path, start time, and log path
- no production launchd label is touched

### Gate 3: Telegram canary smoke

Use the test bot only.

Minimum smoke set:

- 20 consecutive text messages
- one long reply that requires Telegram splitting or a documented MVP deferral
- `/status`
- `/stop` against a deliberately long safe task
- restart supervisor and send another message
- verify no duplicate replies
- verify failed updates stay queued or are clearly logged

Stop if any smoke requires a production token or running a second consumer on a production token.

### Gate 4: permission relay design proof

Before production, the canary must prove permission handling without default blanket bypass:

- owner-only approval message
- 5-letter code
- allow
- deny
- stale-code rejection
- non-owner rejection
- audit log with request, decision, requester, and tool name

Project trust and MCP consent prompts are not solved by the permission relay. Required pre-flight remains:

```text
claude trust add <workspace>
pre-approve required MCP servers locally
verify OAuth/keychain access after reboot
```

### Gate 5: billing/classification evidence

Local tests cannot prove Anthropic billing classification.

Required before gateway decommission:

- Anthropic dashboard evidence after canary traffic, or
- written support confirmation for tmux/interactive channel classification, or
- post-2026-06-15 usage evidence that Telegram turns are not charged to SDK credits

Record evidence without screenshots or account data in this repo unless explicitly approved.

## First safe implementation target

The next implementation artifact should be a repo-local supervisor spec or scaffold that can be reviewed before touching live paths.

Recommended allowed files for that future Worker:

```text
docs/08-dashi-channel-supervisor-spec.md
```

Only after the operator approves a live canary should a task name exact allowed files outside this docs repo, such as a canary-only directory under `~/.claude-lab/shared/channels/`.
