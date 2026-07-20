# TMUX Migration Goal Plan

## Goal

Переехать с текущего `jarvis-telegram-gateway -> claude -p` на tmux-first runtime так, чтобы Telegram-агенты Orgrimmar продолжили работать с тем же UX и тем же набором функций, но Claude Code запускался как живая интерактивная CLI-сессия внутри `tmux`.

Целевой результат:

- после cutover новый Telegram-трафик не использует `claude -p`;
- каждый агент работает в отдельной persistent `tmux`-сессии;
- текущий gateway остается rollback-путем до полного parity sign-off;
- функциональность gateway не деградирует: группы, allowlist, media, voice, albums, status/progress, commands, permissions, webhooks, memory flow;
- launchd используется только как supervisor, а не как no-TTY Claude runtime.

## Source Repositories Reviewed

| Repo | Что берем | Что не берем |
|------|-----------|--------------|
| `nielsgroen/claude-tmux` | идеи для dashboard, session list, status detection, live preview, attach/switch UX | не является gateway или supervisor |
| `obra/claude-session-driver` | worker launch pattern, tmux send safety, status scripts, hook events, approval flow, session registry | `--dangerously-skip-permissions` как default |
| `codeninja/oauth-cli-coder` | persistent OAuth CLI sessions, clean PTY wrapper ideas, provider-agnostic registry, session reuse | "stealth" framing and screen-scraping as core architecture |
| `hanxiao/claudecode-telegram` | Telegram -> tmux canary, pending flag, Stop hook transcript extraction, `/stop`, `/clear`, `/resume`, typing loop | global state files, no allowlist, no multi-agent routing, no Channel protocol |

## Primary Decision

Primary path: **launchd starts a supervisor; supervisor creates/reuses tmux; tmux runs `claude --channels ...`; Agent47 Channel plugin handles Telegram events through Claude Code Channels.**

This is stronger than the previous direct launchd plan:

- Claude Code runs inside a real pseudo-terminal from `tmux`;
- sessions are attachable for manual inspection;
- reboot recovery can still be automated by launchd;
- we avoid `claude -p` and Agent SDK paths for normal Telegram turns;
- if Anthropic classification is unclear, manual Terminal/tmux attach is available without changing gateway logic.

## Target Architecture

```text
Telegram Bot API
      |
      v
Agent47 Channel Plugin
  - getUpdates consumer
  - allowlist/group/topic routing
  - media/voice/document handling
  - durable event queue
  - permission relay
      |
      v
Claude Code channel capability
      |
      v
tmux session per agent
  - orgrimmar-silvana
  - orgrimmar-kaelthas
  - orgrimmar-garrosh
  - orgrimmar-arthas
  - orgrimmar-claude
      |
      v
Claude Code interactive CLI
```

Supervisor shape:

```text
launchd
  -> dashi-channel-supervisor
      -> tmux has-session -t orgrimmar-silvana
      -> tmux new-session -d -s orgrimmar-silvana
      -> claude --dangerously-load-development-channels plugin:agent47-channel@local --channels dashi-telegram
```

Important boundary: the plugin does not call Claude programmatically. It only delivers channel events to the running interactive Claude Code session.

## Non-Negotiable Constraints

1. **No functionality loss.** Cutover is blocked until current gateway behavior has parity tests.
2. **One bot token, one consumer.** Old gateway and new channel must never run `getUpdates` on the same token at the same time.
3. **No production default `--dangerously-skip-permissions`.** Permission relay and pre-trust replace blanket bypass.
4. **Rollback must be per-agent.** If Silvana fails, only Silvana rolls back; other agents are unaffected.
5. **Old gateway remains untouched until cutover.** Changes are additive until Phase 6.
6. **Canary uses a separate test bot token first.** Production tokens move only after smoke and parity gates.
7. **Anthropic classification must be verified.** Support confirmation or post-2026-06-15 usage evidence is required before decommission.

## Functional Parity Map

The new tmux/channel path must preserve these current gateway capabilities:

| Area | Required parity |
|------|-----------------|
| Auth | owner allowlist, group allowlist, bot isolation |
| Routing | per-agent token, groups, topics, reply context |
| Text | Telegram HTML formatting, message splitting, code blocks |
| Status | typing, progress edits, busy/idle/error states |
| Commands | `/status`, `/stop`, `/reset`, `/new`, `/compact`, health checks |
| Media | photo, document, video, sticker metadata |
| Voice | voice download, Groq Whisper transcription, attach transcript |
| Albums | media group buffering and ordered delivery |
| Permissions | Bash/Write/Edit approval via Telegram codes |
| Memory | hot memory append, learning/context injection, current local rules |
| Webhooks | `/hooks/agent` style wake-up and external injection |
| Observability | JSONL logs, per-agent logs, error trace, restart reason |
| Rollback | re-enable gateway consumer for one token in under 5 minutes |

## Implementation Plan

### Phase 0: Inventory and Freeze

Goal: establish the exact behavior that must survive migration.

Steps:

- Snapshot current deployed files:
  - `~/.claude-lab/shared/gateway/gateway.py`
  - `~/.claude-lab/shared/gateway/config.json`
  - launchd plist for current gateway
  - relevant logs for 24 hours
- Export current bot/token mapping without committing secrets.
- Build a parity checklist from real gateway behavior:
  - 20 text turns;
  - 10 group turns;
  - 5 voice turns;
  - 5 media/photo/document turns;
  - 3 album turns;
  - 5 command turns;
  - 5 permission-requiring tool turns.
- Record baseline latency:
  - Telegram update received;
  - Claude starts answering;
  - first visible status;
  - final answer sent.

Gate:

- baseline document exists;
- rollback command for current gateway is tested;
- no production token has been moved.

### Phase 1: tmux Runtime Canary

Goal: prove that a live Claude Code session inside tmux can run continuously and receive channel events.

Use a separate test bot token.

Build:

- `dashi-channel-supervisor` script:
  - create/reuse named tmux session;
  - start Claude Code inside the session;
  - write session metadata to disk;
  - expose `start`, `stop`, `restart`, `status`, `attach`, `logs`.
- Minimal local channel plugin:
  - accept a Telegram text update;
  - push it as a Claude channel event;
  - send one reply back to Telegram.

Borrowed patterns:

- from `claude-session-driver`: tmux launch/status scripts and hook event thinking;
- from `oauth-cli-coder`: persistent OAuth session handling and optional clean PTY wrapper;
- from `claudecode-telegram`: typing loop and pending-state idea for fallback tests.

Gate:

- `tmux attach -t orgrimmar-canary` shows a real Claude Code interactive session;
- canary bot answers 20 consecutive messages;
- restart supervisor recovers the session;
- Mac reboot test is either passed or scheduled before production cutover.

### Phase 2: Channel MVP for Silvana

Goal: one production-like agent path with minimal features, still on a test token.

Build:

- TypeScript/Bun Agent47 Channel plugin;
- Telegram long-poll consumer;
- owner allowlist;
- durable inbound queue;
- plain text reply;
- status messages;
- logs per update id;
- no media yet.

Gate:

- Silvana-style prompt and local `CLAUDE.md` context load correctly;
- 50 text turns pass;
- no dropped updates;
- no duplicate replies;
- average final reply latency is acceptable compared with old gateway.

### Phase 3: Gateway Parity Port

Goal: port the behavior that users actually depend on.

Implement in this order:

1. Message formatting:
   - Telegram HTML;
   - code block preservation;
   - safe splitting for long answers;
   - fallback to plain text on parse errors.
2. Commands:
   - `/status`;
   - `/stop`;
   - `/reset`;
   - `/new`;
   - `/compact`;
   - admin-only `/halt`.
3. Media:
   - photo;
   - document;
   - video metadata;
   - sticker metadata.
4. Voice:
   - download file;
   - send to Groq Whisper;
   - inject transcript into Claude turn.
5. Albums:
   - buffer by `media_group_id`;
   - wait 2 seconds;
   - deliver ordered bundle.
6. Groups/topics:
   - allowlisted group ids;
   - topic/thread mapping;
   - reply-to context.
7. Webhooks:
   - preserve current `/hooks/agent` behavior;
   - include source metadata;
   - never bypass allowlist.
8. Memory/context:
   - preserve hot memory append flow;
   - preserve local Silvana rules;
   - no writes to protected gateway files without explicit approval.

Gate:

- replay test passes against captured gateway updates;
- 90 percent of parity matrix passes before any production token movement;
- 100 percent pass for auth, routing, `/stop`, rollback, and permissions.

### Phase 4: Permission Relay and Pre-Trust

Goal: remove headless approval deadlocks without unsafe blanket permission bypass.

Build:

- `claude/channel/permission` handling;
- Telegram approval messages with 5-letter codes;
- owner-only decision acceptance;
- TTL 5 minutes;
- replay protection;
- audit log of request, decision, requester, tool name.

Pre-flight:

- trust all required project directories manually before production;
- approve required MCP servers manually before production;
- verify OAuth/keychain access after reboot;
- document the manual attach path:
  - `tmux attach -t orgrimmar-silvana`
  - resolve prompt;
  - detach with `Ctrl-b d`.

Gate:

- 10 Bash/Write/Edit approval roundtrips pass;
- denied permission is honored;
- stale approval code is rejected;
- non-owner approval is rejected.

### Phase 5: Shadow and Replay Testing

Goal: test without competing for production `getUpdates`.

Do not run old and new consumers on the same token.

Allowed shadow methods:

- replay sanitized gateway JSONL updates into Agent47 Channel;
- use a separate test token in the same test group;
- temporarily pause old gateway for a single low-risk token during a supervised window.

Gate:

- 100 real historical updates replay successfully;
- no unhandled update type crashes the plugin;
- failed update stays in durable queue with clear error;
- supervisor status reflects busy/idle/failure accurately.

### Phase 6: Per-Agent Cutover

Goal: move one bot token at a time with rollback ready.

Order:

1. Silvana
2. Kaelthas
3. Garrosh
4. Arthas
5. Claude

Per-agent runbook:

1. Announce maintenance window.
2. Stop old gateway consumer for that token.
3. Start `dashi-channel-supervisor start <agent>`.
4. Send Telegram smoke test:
   - text;
   - command `/status`;
   - `/stop` against a long task;
   - one media item;
   - one voice item;
   - one permission request.
5. Watch logs for 30 minutes.
6. Mark agent as channel-primary.

Rollback per agent:

1. `dashi-channel-supervisor stop <agent>`.
2. Re-enable old gateway consumer for that token.
3. Send smoke test through old gateway.
4. Preserve failed channel logs for root cause.

Gate:

- each agent runs 24 hours without critical regression before moving the next high-value agent;
- no dual-consumer incident occurs.

### Phase 7: Post-Cutover Hardening

Goal: make tmux/channel stable enough to retire the old gateway.

Add:

- tmux dashboard or status view inspired by `claude-tmux`;
- daily health report;
- stuck-session detector;
- log rotation;
- disk queue compaction;
- `launchctl` restart runbook;
- manual attach runbook;
- support packet for Anthropic classification question.

Gate:

- 7 days of stable operation;
- no critical missing gateway feature;
- Anthropic classification confidence is acceptable;
- prince approves gateway decommission.

### Phase 8: Decommission Old Gateway

Goal: remove `claude -p` Telegram dependency only after proof.

Steps:

- tag pre-decommission state;
- archive old gateway config;
- unload old gateway launchd job;
- keep rollback archive for 14 days;
- remove remaining Telegram `claude -p` paths from active launchd/crontab;
- update documentation.

Gate:

- grep on active hosts shows no Telegram path using `claude -p`;
- rollback archive exists;
- final smoke test passes for all agents.

## Test Matrix

| Test | Required before Silvana cutover | Required before all-agent cutover |
|------|---------------------------------|-----------------------------------|
| Text DM | yes | yes |
| Group mention/reply | yes | yes |
| Topic routing | if Silvana uses it | yes |
| Long answer split | yes | yes |
| Markdown/code HTML | yes | yes |
| `/status` | yes | yes |
| `/stop` | yes | yes |
| `/reset`/`/new` | yes | yes |
| `/compact` | yes | yes |
| Photo/document | yes | yes |
| Voice transcription | yes | yes |
| Album buffer | no | yes |
| Permission allow | yes | yes |
| Permission deny | yes | yes |
| Non-owner rejected | yes | yes |
| Reboot recovery | before production token | yes |
| Rollback under 5 min | yes | yes |

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Anthropic classifies tmux channel as SDK/programmatic | Max migration goal fails | support confirmation, usage monitoring, manual Terminal fallback |
| tmux session gets stuck in interactive prompt | agent stops replying | permission relay, pre-trust, status detector, manual attach runbook |
| dual `getUpdates` consumer | lost Telegram updates | per-token cutover only, lock file per bot token |
| media parity gap | user-facing regression | replay matrix, keep gateway rollback |
| global state collision across chats | wrong replies | per-agent/per-chat queue keys, no single global pending file |
| unsafe permissions | security regression | no default skip-permissions, owner-only approval codes |
| logs grow unbounded | disk pressure | log rotation in Phase 7 |
| tmux restart loses in-flight update | dropped user message | durable queue with ack after reply sent |

## Success Criteria

- 5/5 agents run through tmux-backed Claude Code sessions.
- 0 production Telegram turns use `claude -p` after cutover.
- Current gateway can be restored per-agent in under 5 minutes.
- All critical gateway features pass the parity matrix.
- No dual-consumer incidents occur during migration.
- Reboot recovery works without manual input, except documented trust/consent prompts that were pre-approved.
- Permission approvals work through Telegram without `--dangerously-skip-permissions`.
- Anthropic billing/classification risk is explicitly resolved before final gateway decommission.

## Recommended Build Order

1. Write `dashi-channel-supervisor` first.
2. Build canary channel with a test bot.
3. Port Silvana text path.
4. Add durable queue and logs.
5. Port commands and `/stop`.
6. Add permissions.
7. Port media/voice/albums.
8. Replay historical updates.
9. Cut over Silvana.
10. Cut over remaining agents one by one.

This order keeps the old gateway alive until the new tmux/channel path proves parity.
