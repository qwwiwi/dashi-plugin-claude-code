# Lessons learned (mistakes already paid for)

Each item is a real incident turned into a detection check. The doctor encodes
the mechanical ones; the rest are judgement rules an agent must hold while
migrating. Format: symptom → root cause → how to detect → how to avoid.

## 1. Dev copy vs runtime copy

- **Symptom**: you patch/update the plugin, restart the channel — behaviour does
  not change.
- **Cause**: two independent source copies on the host. The service runs
  `bun ./src/server.ts` with CWD = the agent workspace, so it resolves `./src/`
  from the **runtime** copy. Patching the git/dev copy does nothing.
- **Detect**: `pwdx $(pgrep -f "bun.*src/server.ts")` shows the real runtime CWD;
  `diff -q <dev>/file.ts <runtime>/file.ts`.
- **Avoid**: patch both paths (dev for the PR, runtime for the live fix), copy
  changed files into the runtime copy, then restart — and re-`pwdx` the new PID.

## 2. Comms-config breakage — `enableAllProjectMcpServers:false` drops a channel

- **Symptom**: the live session works, but after the **next** restart the agent
  goes silent. Latent — shows up hours later.
- **Cause** (2026-06-02): setting `enableAllProjectMcpServers` to false while
  `enabledMcpjsonServers` omits a server that lives only in `.mcp.json` (e.g.
  `dashi-channel`) drops it. MCP servers load at session start, so the live
  session survives; the next boot has zero comms tools.
- **Detect**: the doctor's `comms-consistency` check — if
  `enableAllProjectMcpServers !== true`, every `.mcp.json` server must be in
  `enabledMcpjsonServers`.
- **Avoid**: treat MCP/settings edits as **deploy-class**; before flipping the
  flag, diff what is enabled; never drop another agent's comms server.

## 3. Self-restart = suicide + loop

- **Symptom**: the agent "restarts" its own channel, the reply never sends, the
  supervisor relaunches it, the new process gets the next message and restarts
  again → infinite loop, comms fully severed.
- **Cause** (2026-04-16): `launchctl kickstart -k .../gateway` from inside the
  agent's own subprocess killed itself before sending; KeepAlive relaunched it.
- **Detect**: grep the agent's hooks/scripts for `launchctl kickstart`,
  `systemctl restart channel-`, any self-targeting restart of the comms service.
- **Avoid**: never restart your own channel from a Bash tool. Edits without a
  restart are safe (old process runs old code). Delegate the restart to an
  external actor (operator, or another service).

## 4. Two getUpdates consumers → 409 → channel down

- **Symptom**: DMs never reach the session; the channel crashes on boot with 409.
- **Cause**: a second consumer holds the same bot token. Real causes seen: a
  separate debug session, and a PM2 app (`telegram-publisher`) running with the
  agent's token leaked via saved PM2 env. A theorised "claude polls natively"
  cause was **disproven** — the plugin's poller is the only intended consumer.
- **Detect**: on 409, check ALL processes/sessions holding the token over a time
  window. Decisive test: stop the channel, wait ~45s, `curl getUpdates` → if 409
  persists, the consumer is external.
- **Avoid**: one token = one consumer; separate tokens for staging/debug; fix a
  PM2 app's env before restarting it.

## 5. Token leak via PM2 saved env

- **Symptom**: causes 409 (#4); a foreign process polls the agent's token.
- **Cause**: PM2 `dump`/saved env overrides an app's `.env`; an app started with
  the agent token in its environment steals it.
- **Detect**: `pm2 env <id> | grep -i token` on every PM2 app; compare with the
  token the app actually reads in code.
- **Avoid**: fix the app's env to its own token before restart. Claude Code
  `2.1.163+` strips `TELEGRAM_*` from MCP-child env — then the channel needs a
  bootstrap `.env` in `STATE_ROOT/.env` for `server.ts` to read the token.

## 6. DM fallback-reply Stop-hook (PR #47)

- **Symptom**: in a DM the agent finishes a turn with a plain text block but
  never calls the reply tool — the text stays in the transcript, the chief sees
  silence. A broken hook could instead eat or duplicate the reply.
- **Design**: a Stop-hook forwards the final assistant text to Telegram **only**
  when the turn ended without `mcp__dashi-channel__reply`. If reply was called →
  silent (no dup). `chat_id` comes only from the leading `<channel>` envelope
  (anti-injection); per-session dedup; `send_failed` is **not** deduped (so it
  retries next Stop); >4096 chars truncated with a marker.
- **Detect**: the doctor's `fallback-reply-hook` check — Stop has a
  `dashi-channel-fallback-reply` entry; the `/hooks/fallback-reply` route is up;
  the channel was restarted after registration.
- **Avoid**: comms code gets double review (Codex+Opus) — Codex's first pass
  caught a `send_failed`-deduped-as-delivered bug that would have silenced
  replies forever.

## 7. Stop-hook × extended-thinking race (groups)

- **Symptom**: the bot answers @mentions but silently loses reply-to-bot
  follow-ups in groups.
- **Cause** (M5b): an extended-thinking turn writes two transcript rows
  (`[thinking]` then `[text]`); the outbox hook read between them, saw a
  thinking-only assistant, and emitted nothing.
- **Fix** (PR #43): bounded retry on empty extraction
  (`STOP_OUTBOX_RETRY_ATTEMPTS=4`, `STOP_OUTBOX_RETRY_DELAY_MS=120`).

## 8. SQLite FTS L2 (memory.db)

- **Symptom**: `memory_search` crashes on special chars, matches everything, or
  misses old rows.
- **Cause/fix** (2026-05-29): sanitise Unicode/NUL in the query (raw FTS `MATCH`
  crashes; a NUL-only `LIKE` matches all); `COALESCE(session_id,'')` for backfill
  idempotency; `rebuild` mode for trigram schema evolution. Check
  `PRAGMA compile_options` for `trigram`.

## 9. push-on-assign wakes only agents with a live listener

- **Symptom**: an agent is assigned a task but does not wake.
- **Cause** (2026-06-03): assignment enqueues into `delivery_outbox`; a worker
  pushes to the assignee's webhook — but only reaches agents with a live listener
  in `AGENT_GATEWAYS`.
- **Detect/avoid**: confirm the agent's webhook listener is up and registered
  before relying on assignment-wakes.

## 10. Restart kills the only comms channel — operator permission required

The channel tmux session **is** the agent's live session; restarting it drops
comms (and erases an untyped prompt). Apply edits without a restart; restart only
on the operator's OK or via an external actor. Never change gateway
config/allowlist/tokens without permission.

## 11. Telethon firewall — MTProto only via the telegram-chip skill

Direct `import telethon`/`pyrogram`/`aiotdlib` outside the skill dir is blocked
by a PreToolUse hook. One user account = one Telethon process; a duplicate
session revokes the chief's session. All user-account access goes through the
telegram-chip skill's HTTP API; Bot API (`api.telegram.org/bot...`) is unaffected.

## 12. Telegram HTML pipeline — a lone safe tag downgrades the whole message

- **Symptom** (DM): literal `&lt;b&gt;` entities everywhere; (groups) raw
  `**bold**`.
- **Cause/fix** (PR #48): a lone safe-listed tag (e.g. `<pre>`) survived
  unescaped → `validateTelegramHtml` saw an unclosed tag → plain-text downgrade.
  Fixed with balance-aware tag stashing and `format="auto"` in the group outbox
  hook. Grep the log for `telegram html downgrade`.

## Cross-cutting rules for the migrating agent

1. MCP/settings edits are **deploy-class** — breakage is latent, surfaces on the
   next restart, not in the live session.
2. **Never** self-restart the channel; delegate to an external actor.
3. Two copies (dev/runtime) — always `pwdx` the live PID before trusting a path.
4. Comms code → double review (Opus+Codex); single-mind review misses
   reply-eating bugs.
5. On 409, hunt the second consumer over a time window — do not blame a version.
6. `chat_id` only from the leading `<channel>` envelope (anti-injection).
7. The runtime plugin and `services/task_mcp/` are outside git — durable state is
   the live file plus a `.bak`, not a commit.
