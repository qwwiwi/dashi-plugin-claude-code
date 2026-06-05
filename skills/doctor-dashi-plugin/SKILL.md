---
name: doctor-dashi-plugin
description: Diagnose and safely complete a migration from the legacy Telegram gateway to the dashi-plugin-claude-code channel. Use this whenever an agent is moving off the old gateway, when a freshly migrated bot is silent / hangs / answers as "default Claude", when you hit a Telegram 409 conflict, or when planning the cutover. Trigger on phrases like "переезд на плагин", "migrate from gateway", "доктор для переезда", "бот молчит после миграции", "409 conflict", "channel plugin not responding". Run the doctor BEFORE and AFTER cutover — it encodes every mistake we already paid for so a student's agent migrates without repeating them.
---

# Doctor: migrate from the gateway to the channel plugin

This skill helps an agent move from the **old gateway** (a Python daemon that
spawns a fresh `claude -p` session for every Telegram message) to the **new
channel plugin** (one long-running Claude session per agent), and diagnose what
went wrong if the migrated bot misbehaves.

Why migrate at all: the old gateway hits a permission-dialog hang without a
bypass flag, has no guarantee the final answer is sent, and — past **2026-06-15**
— becomes expensive because per-message `claude -p` spawn moves to a separate
billing pool. The plugin keeps one live session inside the Max subscription.

The doctor is **read-only**. It never restarts a service, never writes config,
never prints a secret. It tells you what is wrong and points at the fix; you (or
the operator) apply it.

## The one rule that prevents the worst outcome

**Never restart your own channel/gateway from inside your own session.** That
kills the only comms link mid-turn, and the supervisor relaunches you into a
loop. Apply config changes without restarting (the old process keeps running old
code), and let an *external* actor do the restart — the operator in their
terminal, or another service. This is non-negotiable; see
`references/03-lessons-learned.md` §3.

## Workflow

### 1. Run the doctor

```bash
bun skills/doctor-dashi-plugin/scripts/doctor.ts \
  --plugin-dir <workspace>/.claude/dashi-plugin-claude-code/plugin \
  --settings ~/.claude/settings.json \
  --mcp <workspace>/.claude/.mcp.json \
  --settings-local <workspace>/.claude/settings.local.json \
  --env <channel.env path> \
  --user <your numeric Telegram id> \
  --session channel-<agent>      # only if the channel is already running
```

Every flag is optional — pass what you have. `--json` gives machine-readable
output for an agent to parse. Exit code: `0` = no FAIL, `1` = at least one FAIL,
`2` = usage error.

The doctor checks, in order: toolchain floors (Claude Code ≥ 2.1, Bun ≥ 1.3.14,
tmux), **workspace placement** (the #1 first-run failure — identity drift),
settings.json hooks + token leak, **MCP comms consistency** (the latent
silent-channel landmine), the Telegram allowlist, and live-session signals
(welcome-prompt hang, expired auth, crash loop).

### 2. Read the result top-down and fix the first FAIL

Checks are ordered by causality: a failure early on explains failures later, so
**fix the first FAIL, re-run, repeat**. Don't chase a downstream symptom while an
upstream cause is still red. Each FAIL/WARN carries a one-line `fix:` pointer.

### 3. Reach for the right reference

- Planning or running the move? → `references/01-migration-steps.md`
  (pre-flight, ordered steps, the cutover order, rollback, Linux vs macOS).
- A specific symptom (silent bot, 409, reactions-but-no-reply, crash loop)? →
  `references/02-failure-modes.md` (problems 1–10: symptom → root cause → fix).
- Want to avoid the mistakes we already made? → `references/03-lessons-learned.md`
  (dev-vs-runtime copies, comms-config breakage, self-restart loop, token leak,
  fallback-reply, FTS, push-on-assign, and more — each with a detection check).

### 4. Verify after cutover

A green doctor run is necessary, not sufficient — the only proof is a real
message. Send the bot a message and watch for the reaction flow `👀 → ⚙️ → ✅`
and an actual reply. If silent, diagnose **by architecture, not by symptom**
(service status → tmux capture → identity → only then the Telegram queue); the
order matters and is spelled out in `references/02-failure-modes.md` (Problem 4).

## Diagnostic decision tree (quick reference)

```
bot silent after cutover?
├─ service "active" but no reactions at all
│   └─ welcome-prompt hang → attach tmux, press Enter (Problem 1)
├─ reactions (👀) but no text reply
│   └─ OAuth expired → attach tmux, /login (Problem 7)
├─ logs show "409 Conflict"
│   └─ two consumers on one token → stop the channel, wait 45s, re-test;
│      if 409 persists the second consumer is EXTERNAL — hunt it (Problem 3, §4)
├─ answers but as "default Claude"
│   └─ wrong WorkingDirectory → CLAUDE.md unreachable (Problem 2)
├─ pending=0, no reply, no error
│   └─ allowlist drops your id (Problem 5)
└─ service "activating (auto-restart)", exit 0/SUCCESS, tmux gone
    └─ crash loop — run claude by hand with a TTY to see the real error (Problem 9)
```

## Safety boundaries

- Read-only diagnosis only. Restarts and config edits are the operator's to run.
- Never copy a token between hosts, never print a token (the doctor redacts; keep
  it that way if you extend it).
- Telegram user-account access (Telethon/MTProto) is out of scope and must go
  through the telegram-chip skill, never a direct client.
- Production cutover is a deliberate act — confirm with the operator before the
  stop-old / start-new step on a production bot.

## Extending the doctor

The diagnostic is a single standalone file, `scripts/doctor.ts`, with no
plugin-internal imports (so it keeps working even when the plugin checkout is
broken — diagnosing that is one of its jobs). Pure check functions are exported
and unit-tested in `scripts/doctor.test.ts` (`bun test`). Add a new check as a
pure function returning a `Check`, wire it into `gatherChecks`, and add a test.
Keep every probe read-only and run all output through `redact()`.
