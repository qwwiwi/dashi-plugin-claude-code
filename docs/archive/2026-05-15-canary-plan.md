> ARCHIVED 2026-05-27 — historical reference only.
> This was the initial canary port plan (PR #1-3 era). Superseded by the current state of plugin/ and docs/.

# Canary Gateway Channel Port Plan

Task: canary-gateway-full-parity
Generated: 2026-05-15
Target: test bot @testmyfirsttmuxbot only, bot id 8507713167

> For agentic workers: implement task-by-task. Keep every task runnable before moving on. Do not move any production Telegram token, launchd job, or gateway.py source in this iteration.

## Section 1 - Audit

### Official `refs/telegram-official/server.ts` inventory

The official plugin is a self-contained Bun MCP server using `@modelcontextprotocol/sdk`, `grammy`, and `zod`. It is licensed Apache-2.0 in `package.json:4`.

| Symbol / handler | Lines | One-line summary | Keep / change |
|---|---:|---|---|
| `STATE_DIR`, `ACCESS_FILE`, `APPROVED_DIR`, `.env` loading | `server.ts:26-43` | Resolves channel state dir and loads `TELEGRAM_BOT_TOKEN` from `~/.claude/channels/telegram/.env`, with real env taking precedence. | Keep pattern, change default state dir to the fork namespace. |
| Token required exit | `server.ts:42-52` | Exits early if no bot token is configured. | Keep, add expected test-bot id guard after `getMe`. |
| Stale poller pid replacement | `server.ts:53-69` | Writes `bot.pid` and attempts to terminate stale same-state-dir poller to avoid Telegram 409 conflicts. | Keep with state-dir isolation; never share state dir with production. |
| Process-level rejection/exception loggers | `server.ts:71-78` | Logs unhandled async failures so polling does not go silent. | Keep, route to structured logger too. |
| `PERMISSION_REPLY_RE` | `server.ts:80-84` | Parses `yes <id>` / `no <id>` permission decisions using the Claude Code 5-letter id alphabet. | Keep. |
| `PendingEntry`, `GroupPolicy`, `Access` | `server.ts:89-117` | Models pairing, groups, allowlists, and delivery settings. | Replace with strict Zod-derived types; Scope A is DM-only. |
| `defaultAccess()` | `server.ts:119-126` | Default policy is pairing with empty allowlists. | Rewrite default to static allowlist for user id `123456789`; no pairing this iteration. |
| `MAX_CHUNK_LIMIT`, `MAX_ATTACHMENT_BYTES` | `server.ts:128-129` | Telegram text/file hard limits. | Keep. |
| `assertSendable(f)` | `server.ts:131-145` | Blocks sending files from channel state dir except inbox. | Needs rewrite: hard requirement is workspace-relative allowlist from `gateway.py:2987-3016`. |
| `readAccessFile()` | `server.ts:147-170` | Reads `access.json`, fills defaults, renames corrupt file aside. | Rewrite with Zod validation and no pairing mutations by default. |
| Static mode boot snapshot | `server.ts:172-187` | Reads access once in `TELEGRAM_ACCESS_MODE=static`; pairing downgraded. | Keep concept, simplify because Scope A is static allowlist. |
| `loadAccess()` | `server.ts:189-191` | Returns boot access or rereads JSON each inbound message. | Keep shape with validated `allowlist.json`. |
| `assertAllowedChat(chat_id)` | `server.ts:193-200` | Outbound gate for reply/react/edit tools. | Keep, but gate DMs by allowed user id and forbid groups in Scope A. |
| `saveAccess(a)` | `server.ts:202-208` | Atomic JSON write. | Keep only for future pairing/admin files; Scope A config is static. |
| `pruneExpired(a)` | `server.ts:210-220` | Removes expired pairing entries. | Remove from runtime path for Scope A; pairing is not active. |
| `gate(ctx)` | `server.ts:222-285` | Inbound access gate for private chats, pairing, groups, and mention requirements. | Rewrite. It gates on `ctx.from.id`, not `chat.id`, and Scope A drops groups. |
| `dmCommandGate(ctx)` | `server.ts:287-298` | DM-only command gate without pairing side effects. | Keep concept, rewrite with static allowlist and Zod context. |
| `isMentioned(ctx)` | `server.ts:300-324` | Group mention detection via entities, reply username, and regex patterns. | Defer groups; current self-reply check by username is not acceptable for the gateway anti-spoof rule. |
| `checkApprovals()` interval | `server.ts:326-352` | Polls `approved/` files written by the access skill and sends confirmation. | Remove or leave dormant; no pairing in this iteration. |
| `chunk(text, limit, mode)` | `server.ts:354-376` | Splits long text by hard length or newline preference. | Replace with gateway-grade `splitMessage()` preserving HTML/code boundaries. |
| `PHOTO_EXTS` | `server.ts:378-380` | Chooses sendPhoto vs sendDocument for outbound files. | Keep behind workspace security check. |
| `new Server(...)` with `claude/channel` and `claude/channel/permission` | `server.ts:382-409` | Registers channel and permission capabilities plus system instructions. | Keep, rename server to `dashi-channel`, rewrite instructions for DM-only canary and untrusted metadata. |
| `pendingPermissions` | `server.ts:411-412` | Stores permission request details for callback expansion. | Keep, add TTL and owner-only decisions. |
| Permission request notification handler | `server.ts:418-443` | Receives Claude Code permission requests and sends Telegram approval buttons. | Keep, but send only to `permission_owner_user_ids`. |
| `ListToolsRequestSchema` handler | `server.ts:445-517` | Exposes `reply`, `react`, `download_attachment`, and `edit_message`. | Keep `reply`, `react`, `edit_message`; add/adjust `set_status`; Zod-validate all tool args. |
| `CallToolRequestSchema` handler | `server.ts:519-641` | Implements outbound tools, chunks replies, sends files, reactions, downloads, edits. | Rewrite into separate modules; no casts from unknown to concrete types. |
| `mcp.connect(new StdioServerTransport())` | `server.ts:643` | Connects MCP over stdio. | Keep. |
| `shutdown()` and signal hooks | `server.ts:648-665` | Removes pid file and stops Telegram polling when MCP/stdin closes. | Keep. |
| Orphan watchdog | `server.ts:667-677` | Polls parent process/stdin state and self-terminates if orphaned. | Keep. |
| `bot.command('start')` | `server.ts:684-693` | DM command for pairing instructions. | Rewrite to canary instructions without pairing. |
| `bot.command('help')` | `server.ts:695-703` | Basic help. | Replace with gateway-like OOB help for `/help /status /stop /reset /new`. |
| `bot.command('status')` | `server.ts:705-726` | Reports pairing state. | Rewrite to report bot id, allowed user, state dir, last update, and active status handle. |
| `bot.on('callback_query:data')` | `server.ts:728-785` | Handles permission buttons. | Keep with owner-only sender validation and TTL. |
| `bot.on('message:text')` | `server.ts:787-789` | Forwards plain text to `handleInbound`. | Keep, route through OOB detector and prompt builder. |
| `bot.on('message:photo')` | `server.ts:791-815` | Downloads largest photo after gate and sends `image_path` metadata. | Keep concept, add album buffering and `<media>` descriptor. |
| `bot.on('message:document')` | `server.ts:817-828` | Sends document metadata with file id, size, mime, safe name. | Keep descriptor path; lazy download remains tool-driven in Scope A. |
| `bot.on('message:voice')` | `server.ts:830-839` | Sends voice metadata. | Extend with optional Groq transcription stub. |
| `bot.on('message:audio')` | `server.ts:841-852` | Sends audio metadata. | Keep as descriptor only unless Groq key is present. |
| `bot.on('message:video')` | `server.ts:854-864` | Sends video descriptor. | Keep descriptor only. |
| `bot.on('message:video_note')` | `server.ts:866-873` | Sends video note descriptor. | Keep descriptor only. |
| `bot.on('message:sticker')` | `server.ts:875-883` | Sends sticker descriptor. | Keep descriptor only. |
| `AttachmentMeta` | `server.ts:885-891` | Minimal attachment metadata. | Replace with Zod-derived media descriptor union. |
| `safeName(s)` | `server.ts:893-898` | Sanitizes user-controlled filenames for channel metadata. | Keep and test. |
| `handleInbound(...)` | `server.ts:900-986` | Gate, permission text intercept, typing, ack reaction, image download, MCP channel notification. | Rewrite: split into gate, OOB, album, prompt, status, notification, dead-letter. |
| `bot.catch(...)` | `server.ts:988-992` | Keeps polling alive after handler errors. | Keep with dead-letter/log write. |
| Polling retry loop around `bot.start()` | `server.ts:994-1038` | Retries polling, handles 409 conflicts, sets commands and bot username. | Keep, add `getMe` bot id validation and stricter startup logging. |

### Gateway parity matrix

Statuses:
- Have: official plugin already provides usable base behavior.
- Missing: implement for Scope A.
- Rewrite: official or gateway behavior exists, but must be changed for safety or channel architecture.
- Defer: out of this iteration by chosen scope, but preserve extension seam.

| Gateway inventory area | Gateway refs | Official refs | Scope A plan status |
|---|---:|---:|---|
| Process model and long-poll consumer | `gateway.py:3237-3400` | `server.ts:994-1038` | Have with Grammy long-poll and pid guard. No Python threads. |
| One bot token, one consumer | `gateway.py:3237-3400` | `server.ts:53-69`, `994-1038` | Have, plus test-bot id guard. |
| File offset persistence | `gateway.py:20`, `3237-3281` | none explicit | Missing: write `update-offset` checkpoint for diagnostics; do not replace Grammy polling in Scope A. |
| User allowlist by sender id | `gateway.py:47-59`, `3318-3325` | `server.ts:227-285` | Rewrite: static DM-only allowlist for user `123456789`, gate by `from.id`. |
| Group allowlist/topics | `gateway.py:51-58`, `3327-3336` | `server.ts:269-281`, `300-324` | Defer. No groups in Scope A. |
| Mention/reply detection in groups | `gateway.py:753-793` | `server.ts:300-324` | Defer; current official reply check by username is not acceptable for anti-spoof. |
| Markdown to Telegram HTML | `gateway.py:261-410` | none; official supports MarkdownV2 only in tools | Missing: port gateway HTML converter to strict TS and tests. |
| Chunking and parse fallback | `gateway.py:514-562`, `490-511` | `server.ts:354-376`, `548-565` | Rewrite: gateway-grade chunking, HTML parse-error fallback, first chunk reply only. |
| Status/typing/progress | `gateway.py:565-569`, `1709-1928`, `2900-2929` | `server.ts:945-957`, `499-515` | Missing: local status manager with 700 ms edit interval. Tool-specific status is scaffolded because Channels do not expose stream-json tool events. |
| OOB commands | `gateway.py:1000-1239`, `3037-3133` | `server.ts:684-726` | Missing: implement `/help /status /stop /reset /new`; no `claude -p` handoff. |
| Media descriptors | `gateway.py:145-163`, `838-901` | `server.ts:791-883`, `885-898` | Rewrite: use `<media>` descriptors with Zod-safe metadata; photo may still download eagerly after gate. |
| Voice transcription | `gateway.py:166-180`, `904-931` | `server.ts:830-839` | Missing: optional Groq Whisper when key present; descriptor otherwise. |
| Album buffering | `gateway.py:3154-3234` | none | Missing: 2s buffer by `media_group_id`, ordered flush. |
| Reply and forward context | `gateway.py:184-194`, `2767-2821` | none | Needs rewrite with anti-spoof: `untrusted_metadata` JSON, self-reply only when `reply.from.id === bot_user_id`. |
| Webhook injection | `gateway.py:3506-3663` | none | Missing: scaffold `/hooks/agent` with bearer auth, loopback guard, allowlist `chatId`, and channel event `source="webhook"`. |
| Memory hooks | `gateway.py:1938-2262` | none | Defer; create module seam only. |
| `claude -p` invocation/session ids | `gateway.py:1280-1469` | channel architecture | Rewrite by deletion: runtime must not invoke `claude -p`. Session files are diagnostic/future-only. |
| Permission behavior | `gateway.py:1318-1319` | `server.ts:418-443`, `728-785`, `923-943` | Have base relay; rewrite owner-only, TTL, audit log. No dangerous skip-permissions default. |
| Reactions | `gateway.py:572-584`, `2973-2976` | `server.ts:475-486`, `590-596` | Have basic tool; response marker parsing deferred. |
| Edit-message support | `gateway.py:938-988` | `server.ts:499-515`, `615-627` | Have base; harden with Zod and HTML fallback. |
| sendDocument outbound | `gateway.py:645-713`, `2987-3016` | `server.ts:567-581` | Rewrite security: official blocks channel state only; new check must require workspace-relative path. Auto-send written files deferred. |
| Logging/dead-letter | `gateway.py:278-289`, `3506-3663` | stderr only | Missing: JSONL logs and dead-letter for failed channel notification/webhook parse. |
| Multi-agent isolation | `gateway.py:292-303` | `TELEGRAM_STATE_DIR` in `server.ts:26` | Defer multi-bot; keep one process per token state-dir shape. |

### Unsafe to copy from `gateway.py` as-is

- The `claude -p` subprocess path in `gateway.py:1280-1469` is the thing being removed. It also sets `--permission-mode bypassPermissions` at `gateway.py:1318-1319`, which is not allowed as a default in the channel runtime.
- `/reset`, `/new`, and `/compact` spawn additional `claude -p` subprocesses in `gateway.py:1060-1200`. Scope A must not port those mechanics. It can emit channel command metadata and clear local state, but compaction/handoff via `claude -p` is out.
- The Python thread model, `_ACTIVE_PROCS`, and idle stream-json heartbeat are coupled to subprocess stdout. Channels do not expose stream-json events to the plugin, so tool-progress parity needs a separate status tool/scaffold rather than a direct copy.
- The gateway parses raw Telegram dicts opportunistically. Scope A requires Zod validation for Telegram updates, env vars, config files, webhook bodies, and MCP tool args.
- Group logic such as `group_allow_all` plus media bypass (`gateway.py:3350-3355`) is risky outside the current production context. Scope A is DM-only and should not enable group bypasses.
- Reply context can only be copied as a security pattern, not as plain text. The non-negotiable part is `gateway.py:2786-2821`: self-reply is numeric bot id comparison and reply context is JSON-wrapped untrusted metadata.
- The gateway sendDocument auto-send path is only safe because it resolves each file under the agent workspace at `gateway.py:2987-3016`. The official plugin's `assertSendable()` at `server.ts:131-145` is insufficient for this run.
- OpenViking, Cognee, raw group logs, and hot memory writes have external side effects and PII implications. They need a separate run after the test-bot channel path is proven.

## Section 2 - Architecture decision

### Final scope

Choose Scope A - MVP DM-only with extension scaffolding.

The 2026-06-10 production-class deadline favors proving the billing-safe channel path with one complete, testable canary slice instead of dragging group/topic/memory parity into the first fork. Scope A keeps the official plugin's strongest assets - MCP channel plumbing, Telegram long-poll, reply/edit/react tools, and permission relay - while adding the gateway behaviors that matter for a realistic test bot: safe formatting, chunking, allowlist, media descriptors, albums, anti-spoof reply context, status edits, OOB commands, webhook injection, and tests. Scope B/C features become follow-up loop-coding runs after this one has a working tmux/Claude Code channel against @testmyfirsttmuxbot. The only Scope A expansion is security hardening for the official `reply.files` sendDocument path, because hard constraint 6 applies to any file-send flow we keep.

### Fork file/module layout

Create the fork under:

`/Users/jasonqwwen/qwwiwi-channel-telegram-Claude-code/plugin/`

| File | Purpose |
|---|---|
| `plugin/package.json` | Bun package, Apache-2.0 attribution, scripts: `start`, `test`, `typecheck`, `smoke:offline`. |
| `plugin/bun.lock` | Dependency lock generated by `bun install`. |
| `plugin/tsconfig.json` | Strict TypeScript, `noImplicitAny`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`. |
| `plugin/.mcp.json` | Development MCP server registration with server name `dashi-channel`. |
| `plugin/README.md` | Canary-only setup, test-bot warning, smoke commands, rollback note. |
| `plugin/.env.example` | Non-secret env example for test bot and state dir. |
| `plugin/server.ts` | Thin executable entrypoint: load config, construct server, start Telegram polling and optional webhook. |
| `plugin/src/config.ts` | Zod env/config parsing; test-bot id guard config; state-dir path resolution. |
| `plugin/src/schemas.ts` | Zod schemas for Telegram update subset, access JSON, webhook body, MCP tool args, permission notifications. |
| `plugin/src/types.ts` | Shared discriminated unions and branded ids derived from schemas. |
| `plugin/src/state.ts` | State-dir creation, atomic JSON writes, update-offset checkpoint, logs/dead-letter writers. |
| `plugin/src/access.ts` | DM-only sender allowlist gate by `from.id`, outbound chat gate, command gate. |
| `plugin/src/telegram.ts` | Grammy bot setup, bot id validation, safe Telegram API wrapper, parse-error detection. |
| `plugin/src/channel.ts` | MCP server construction, `claude/channel` notification sender, dead-letter on transport failure. |
| `plugin/src/format.ts` | `escapeHtml`, `escapeHtmlAttr`, `markdownToTelegramHtml`, `splitMessage`, safe text fallback. |
| `plugin/src/replyTool.ts` | `reply`, `react`, `edit_message`, optional `set_status` tool handlers with Zod inputs. |
| `plugin/src/security.ts` | Workspace-relative path resolution and sendDocument/sendPhoto file policy. |
| `plugin/src/prompt.ts` | Builds channel content/meta, reply `untrusted_metadata`, forward metadata, and user text envelope. |
| `plugin/src/media.ts` | Photo/document/voice/audio/video/sticker descriptors; optional Groq Whisper transcription. |
| `plugin/src/album.ts` | 2s media-group buffer keyed by `media_group_id`, ordered flush. |
| `plugin/src/oob.ts` | `/help /status /stop /reset /new` routing and local/direct responses. |
| `plugin/src/status.ts` | Status message lifecycle: send, edit every ~700 ms, dedupe, stop/delete before final reply. |
| `plugin/src/permissions.ts` | Claude Code permission relay with owner-only text/button decisions, TTL, audit log. |
| `plugin/src/webhook.ts` | Bun HTTP server for `GET /health` and `POST /hooks/agent` with Zod, bearer auth, allowlist. |
| `plugin/src/log.ts` | Small JSONL/stderr logger with secret masking for status/log fields. |
| `plugin/src/main.ts` | Wires config, state, bot, channel server, webhook, and shutdown hooks. |
| `plugin/tests/format.test.ts` | HTML escaping and markdown-to-HTML unit tests. |
| `plugin/tests/chunk.test.ts` | Message chunking and first-reply behavior tests. |
| `plugin/tests/access.test.ts` | DM allowlist gate tests. |
| `plugin/tests/album.test.ts` | Album buffer flush/order tests. |
| `plugin/tests/prompt.test.ts` | Prompt/media descriptor construction tests. |
| `plugin/tests/replyAntiSpoof.test.ts` | Reply-injection anti-spoof tests using `_bot_user_id`. |
| `plugin/tests/oob.test.ts` | OOB command routing tests. |
| `plugin/tests/status.test.ts` | Status interval/dedupe/final cleanup tests. |
| `plugin/tests/permissions.test.ts` | Permission request/decision tests. |
| `plugin/tests/security.test.ts` | Workspace-relative sendDocument guard tests. |
| `plugin/tests/webhook.test.ts` | Webhook schema/auth/allowlist tests. |
| `plugin/tests/fixtures/telegram.ts` | Runtime-valid Telegram update fixtures. |

### Data flow

```text
Telegram Bot API getUpdates
  |
  v
Grammy bot handlers in plugin/src/telegram.ts
  |
  v
Zod parse Telegram update subset
  |
  v
access.gateInbound(from.id, chat.type)
  |
  +--> drop non-allowlisted sender
  |
  +--> oob.routeCommand(/help /status /stop /reset /new)
  |       |
  |       +--> direct Telegram response or command channel event
  |
  +--> album.AlbumBuffer buffer/flush by media_group_id
          |
          v
prompt.buildChannelEvent()
  - text envelope
  - <untrusted_metadata>{...}</untrusted_metadata> for replies
  - <media ...> descriptors
  - meta: chat_id, message_id, user_id, source
          |
          v
status.start(chat_id, reply_to_message_id)
          |
          v
MCP notification: notifications/claude/channel
          |
          v
Claude Code interactive session in tmux
          |
          v
MCP tool call: reply / react / edit_message / set_status
          |
          v
replyTool validates args with Zod
          |
          v
format.markdownToTelegramHtml -> splitMessage -> Telegram API
          |
          v
status.stop/delete before final reply
```

Permission flow:

```text
Claude Code permission_request notification
  -> permissions.handlePermissionRequest()
  -> Telegram DM to owner user_id 123456789
  -> owner replies "yes abcde" or presses allow/deny button
  -> permissions.handleDecision()
  -> MCP notification: notifications/claude/channel/permission
```

Webhook scaffold:

```text
POST /hooks/agent
  -> Zod payload parse
  -> bearer token timing-safe check
  -> chatId in allowlist
  -> channel.notify({ content: message, meta: { source: "webhook", chat_id, agent_id } })
```

### `TELEGRAM_STATE_DIR` layout

Default for canary:

`~/.claude/channels/dashi-telegram-canary/`

```text
TELEGRAM_STATE_DIR/
  .env                         # optional local secret file, chmod 600, never committed
  allowlist.json               # static DM allowlist; starts with user id 123456789
  config.json                  # optional non-secret runtime config overrides
  bot.pid                      # single-consumer guard
  update-offset                # last observed Telegram update id checkpoint
  session-ids/
    chat-<chat_id>.json        # reserved chat/session correlation, no claude -p resume
  inbox/
    <timestamp>-<fileid>.<ext> # gated inbound photo/download files
  permission-requests.jsonl    # request, decision, expiry audit
  dead-letter/
    <timestamp>-<kind>.json    # failed channel notification, webhook parse, send failures
  logs/
    server-YYYY-MM-DD.jsonl    # structured runtime events
    smoke-YYYY-MM-DD.jsonl     # optional integration smoke transcript
```

`allowlist.json` Scope A shape:

```json
{
  "mode": "allowlist",
  "allow_user_ids": ["123456789"],
  "allow_chat_ids": ["123456789"],
  "permission_owner_user_ids": ["123456789"],
  "groups": {}
}
```

### Config

Environment variables:

| Env var | Required | Meaning |
|---|---:|---|
| `TELEGRAM_BOT_TOKEN` | yes unless token file | Test bot token. Must resolve to bot id `8507713167`. |
| `TELEGRAM_BOT_TOKEN_FILE` | no | File containing test bot token. Used when env should not contain the token. |
| `TELEGRAM_EXPECTED_BOT_ID` | yes in smoke | Startup guard; set to `8507713167` for @testmyfirsttmuxbot. |
| `TELEGRAM_STATE_DIR` | no | State root. Default `~/.claude/channels/dashi-telegram-canary`. |
| `DASHI_CHANNEL_CONFIG` | no | Path to optional JSON config. |
| `DASHI_AGENT_ID` | no | Canary agent id for logs/meta. Default `dashi-canary`. |
| `DASHI_WORKSPACE_ROOT` | yes for file replies | Absolute workspace root used by sendDocument security check. |
| `TELEGRAM_ALLOWED_USER_IDS` | no | Comma-separated override; default `123456789`. |
| `TELEGRAM_STATUS_INTERVAL_MS` | no | Default `700`. |
| `TELEGRAM_ALBUM_WINDOW_MS` | no | Default `2000`. |
| `TELEGRAM_TEXT_CHUNK_LIMIT` | no | Default `4000`, max `4096`. |
| `GROQ_API_KEY` | no | Enables voice/audio transcription. |
| `GROQ_API_KEY_FILE` | no | File fallback for Groq key. |
| `DASHI_WEBHOOK_PORT` | no | `0` or unset disables `/hooks/agent`. |
| `DASHI_WEBHOOK_HOST` | no | Default `127.0.0.1`; non-loopback requires token. |
| `DASHI_WEBHOOK_TOKEN` | required if webhook enabled | Bearer token for `/hooks/agent`. |
| `LOG_LEVEL` | no | `debug`, `info`, `warn`, `error`. Default `info`. |

Optional `config.json` keys, all Zod validated:

```json
{
  "agent_id": "dashi-canary",
  "workspace_root": "/Users/jasonqwwen/qwwiwi-channel-telegram-Claude-code",
  "expected_bot_id": 8507713167,
  "allowed_user_ids": [123456789],
  "allowed_chat_ids": [123456789],
  "permission_owner_user_ids": [123456789],
  "dm_only": true,
  "album_window_ms": 2000,
  "status_interval_ms": 700,
  "text_chunk_limit": 4000,
  "parse_mode": "HTML",
  "voice": {
    "provider": "groq",
    "model": "whisper-large-v3-turbo",
    "language": "ru",
    "enabled_when_key_present": true
  },
  "webhook": {
    "enabled": false,
    "host": "127.0.0.1",
    "port": 0,
    "token_env": "DASHI_WEBHOOK_TOKEN"
  }
}
```

## Section 3 - Implementation strategy

### T1 - Fork base into `plugin/` and verify Bun smoke

- [ ] **Files touched**
  - Create/copy: `plugin/server.ts`, `plugin/package.json`, `plugin/.mcp.json`, `plugin/README.md`, `plugin/.env.example`
  - Create: `plugin/tsconfig.json`, `plugin/src/main.ts`
  - Generate: `plugin/bun.lock`

- [ ] **Public interface**

```ts
// plugin/src/main.ts
export async function main(): Promise<void>
```

- [ ] **Dependencies**
  - None.

- [ ] **Acceptance criteria**
  - `cd plugin && bun install` completes.
  - `cd plugin && bun run typecheck` completes.
  - `cd plugin && bun test` completes with at least one smoke test.
  - `cd plugin && TELEGRAM_BOT_TOKEN= bun run start` exits with a clear token-required message.
  - `plugin/package.json` preserves official Apache-2.0 attribution and notes it is forked from Anthropic official Telegram channel plugin.

- [ ] **Estimated LOC**
  - Copy: about 1038 LOC official base.
  - New/change: about 80 LOC.

### T2 - Strict config, state, and Zod schemas

- [ ] **Files touched**
  - Create: `plugin/src/config.ts`, `plugin/src/schemas.ts`, `plugin/src/types.ts`, `plugin/src/state.ts`, `plugin/src/log.ts`
  - Modify: `plugin/src/main.ts`, `plugin/server.ts`
  - Test: `plugin/tests/config.test.ts`, `plugin/tests/fixtures/telegram.ts`

- [ ] **Public interface**

```ts
export const EnvSchema: z.ZodType<RuntimeEnv>
export const RuntimeConfigSchema: z.ZodType<RuntimeConfig>
export const TelegramMessageSchema: z.ZodType<TelegramMessage>
export const WebhookPayloadSchema: z.ZodType<WebhookPayload>

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>
export type TelegramMessage = z.infer<typeof TelegramMessageSchema>

export function loadRuntimeConfig(env: NodeJS.ProcessEnv, cwd: string): RuntimeConfig
export function ensureStateLayout(config: RuntimeConfig): void
export function writeUpdateOffset(stateDir: string, updateId: number): void
export function writeDeadLetter(stateDir: string, kind: string, payload: unknown): void
```

- [ ] **Dependencies**
  - T1.

- [ ] **Acceptance criteria**
  - Invalid env/config fails before polling starts.
  - `TELEGRAM_EXPECTED_BOT_ID` is parsed as number and defaults to `8507713167` only in canary config.
  - All file paths are absolute after config load.
  - `bun run typecheck` passes with strict mode and no explicit `any`.

- [ ] **Estimated LOC**
  - 180 LOC.

### T3 - DM-only allowlist gate and test-bot startup guard

- [ ] **Files touched**
  - Create: `plugin/src/access.ts`
  - Modify: `plugin/src/telegram.ts`, `plugin/src/main.ts`, `plugin/src/schemas.ts`
  - Test: `plugin/tests/access.test.ts`

- [ ] **Public interface**

```ts
export type GateDecision =
  | { kind: 'deliver'; senderId: string; chatId: string }
  | { kind: 'drop'; reason: 'not_private' | 'sender_not_allowed' | 'chat_not_allowed' | 'missing_sender' }

export function gateInbound(message: TelegramMessage, access: AccessConfig): GateDecision
export function assertOutboundChatAllowed(chatId: string, access: AccessConfig): void
export async function assertExpectedBot(api: TelegramApi, expectedBotId: number): Promise<BotIdentity>
```

- [ ] **Dependencies**
  - T2.

- [ ] **Acceptance criteria**
  - Gate uses `message.from.id`, not `message.chat.id`, for sender authorization.
  - Group/supergroup messages are dropped in Scope A even if sender is allowed.
  - Startup exits if `getMe().id !== 8507713167` when expected id is set.
  - Tests cover allowed DM, denied DM, allowed sender in disallowed group, missing `from`, and outbound chat gate.

- [ ] **Estimated LOC**
  - 110 LOC.

### T4 - Telegram HTML formatter, chunker, and parse fallback

- [ ] **Files touched**
  - Create: `plugin/src/format.ts`
  - Modify: `plugin/src/telegram.ts`, `plugin/src/replyTool.ts`
  - Test: `plugin/tests/format.test.ts`, `plugin/tests/chunk.test.ts`

- [ ] **Public interface**

```ts
export function escapeHtml(text: string): string
export function escapeHtmlAttr(text: string): string
export function markdownToTelegramHtml(markdown: string): string
export function splitMessage(text: string, maxChars?: number): string[]
export function isTelegramHtmlParseError(error: unknown): boolean
```

`splitMessage(text, maxChars = 4000)` must split on paragraph boundaries first, then single newline, then sentence/space, then hard cut. It must avoid splitting inside `<pre>...</pre>` and `<code>...</code>` when the block fits within the max size. If a single code/pre block exceeds max size, hard cut inside that block and preserve send order. The caller sets `reply_to_message_id` only on the first chunk.

- [ ] **Dependencies**
  - T2.

- [ ] **Acceptance criteria**
  - Tests port gateway behavior from `gateway.py:261-410` and `gateway.py:514-562`.
  - HTML parse error fallback resends plain text without `parse_mode`.
  - Tables become aligned `<pre>` blocks.
  - Snake_case is not italicized by underscore handling.

- [ ] **Estimated LOC**
  - 220 LOC.

### T5 - Secure reply/react/edit tools with workspace-relative file policy

- [ ] **Files touched**
  - Create: `plugin/src/replyTool.ts`, `plugin/src/security.ts`
  - Modify: `plugin/src/channel.ts`, `plugin/src/schemas.ts`, `plugin/src/telegram.ts`
  - Test: `plugin/tests/security.test.ts`, `plugin/tests/chunk.test.ts`

- [ ] **Public interface**

```ts
export const ReplyArgsSchema: z.ZodType<ReplyArgs>
export const ReactArgsSchema: z.ZodType<ReactArgs>
export const EditMessageArgsSchema: z.ZodType<EditMessageArgs>

export function resolveWorkspaceFile(filePath: string, workspaceRoot: string): string
export function assertWorkspaceRelative(filePath: string, workspaceRoot: string): void
export function createToolHandlers(deps: ToolDeps): ToolHandlers
```

`ReplyArgs` shape:

```ts
export type ReplyArgs = {
  chat_id: string
  text: string
  reply_to?: string
  files?: string[]
  format?: 'markdown' | 'html' | 'text'
}
```

- [ ] **Dependencies**
  - T3, T4.

- [ ] **Acceptance criteria**
  - `reply.files` rejects paths outside `DASHI_WORKSPACE_ROOT`, including symlink escapes.
  - Files over 50 MB are rejected before Telegram API call.
  - Text is sent before files; files thread under `reply_to` only if provided.
  - `reply`, `react`, and `edit_message` reject invalid tool args via Zod, not casts.
  - No auto-send of Claude-written files is added in Scope A.

- [ ] **Estimated LOC**
  - 180 LOC.

### T6 - Prompt construction and reply-injection anti-spoof

- [ ] **Files touched**
  - Create: `plugin/src/prompt.ts`
  - Modify: `plugin/src/channel.ts`, `plugin/src/telegram.ts`, `plugin/src/schemas.ts`
  - Test: `plugin/tests/prompt.test.ts`, `plugin/tests/replyAntiSpoof.test.ts`

- [ ] **Public interface**

```ts
export type BotIdentity = { id: number; username: string }

export type UntrustedReplyMetadata = {
  sender: 'agent_previous_message' | 'other_bot' | 'human' | 'unknown'
  sender_label: string
  body: string
  truncated: boolean
}

export function buildReplyMetadata(reply: TelegramMessage | undefined, bot: BotIdentity): UntrustedReplyMetadata | null
export function renderUntrustedMetadata(meta: UntrustedReplyMetadata): string
export function buildChannelEvent(input: BuildChannelEventInput): ChannelEvent
```

`renderUntrustedMetadata()` output:

```xml
<untrusted_metadata type="telegram_reply_context">{"sender":"other_bot","sender_label":"other bot","body":"...","truncated":false}</untrusted_metadata>
```

The replied message body must appear only inside JSON, never as plain instruction text.

- [ ] **Dependencies**
  - T2, T3.

- [ ] **Acceptance criteria**
  - Self-reply is true only when `reply.from.id === bot.id`; `is_bot: true` alone never labels it as agent output.
  - Other bots are labeled `other_bot`.
  - Human senders include name, optional username, and numeric id in `sender_label`.
  - Reply body is truncated to 1200 chars and null bytes are stripped, matching `gateway.py:2810-2821`.
  - Tests include the exact spoof case: reply to another bot's message with `is_bot: true`.

- [ ] **Estimated LOC**
  - 150 LOC.

### T7 - Media descriptors and optional Groq voice transcription

- [ ] **Files touched**
  - Create: `plugin/src/media.ts`
  - Modify: `plugin/src/prompt.ts`, `plugin/src/telegram.ts`, `plugin/src/schemas.ts`
  - Test: `plugin/tests/prompt.test.ts`

- [ ] **Public interface**

```ts
export type MediaDescriptor =
  | { kind: 'photo'; file_id: string; unique_id?: string; width?: number; height?: number; local_path?: string }
  | { kind: 'document'; file_id: string; name?: string; mime?: string; size?: number }
  | { kind: 'voice'; file_id: string; mime?: string; size?: number; transcript?: string; transcription_status: 'not_configured' | 'ok' | 'failed' }
  | { kind: 'audio' | 'video' | 'video_note' | 'sticker'; file_id: string; name?: string; mime?: string; size?: number }

export function describeMedia(message: TelegramMessage): MediaDescriptor[]
export function renderMediaDescriptor(media: MediaDescriptor): string
export async function maybeTranscribeVoice(media: MediaDescriptor, config: RuntimeConfig): Promise<MediaDescriptor>
```

Descriptor output:

```xml
<media kind="voice" file_id="..." transcription_status="not_configured">Voice message attached; Groq key not configured.</media>
```

- [ ] **Dependencies**
  - T6.

- [ ] **Acceptance criteria**
  - Photo/document/voice descriptors are included in channel content.
  - Voice with no Groq key produces descriptor, not failure.
  - Voice with Groq key calls a single injectable transcription client; tests use a fake client.
  - User-controlled filenames are sanitized like official `safeName()` at `server.ts:893-898`.

- [ ] **Estimated LOC**
  - 160 LOC.

### T8 - Album buffer with 2s ordered flush

- [ ] **Files touched**
  - Create: `plugin/src/album.ts`
  - Modify: `plugin/src/telegram.ts`, `plugin/src/main.ts`
  - Test: `plugin/tests/album.test.ts`

- [ ] **Public interface**

```ts
export type AlbumFlush = {
  mediaGroupId: string
  messages: TelegramMessage[]
  firstMessage: TelegramMessage
  mergedCaption: string
  messageIds: number[]
}

export class AlbumBuffer {
  constructor(options: { windowMs: number; onFlush: (flush: AlbumFlush) => Promise<void> | void; clock?: AlbumClock })
  push(message: TelegramMessage): 'buffered' | 'not_album'
  flush(mediaGroupId: string): Promise<void>
  flushAll(): Promise<void>
}
```

- [ ] **Dependencies**
  - T7.

- [ ] **Acceptance criteria**
  - Messages sharing `media_group_id` flush once after 2s of silence.
  - Flush order follows Telegram arrival order.
  - Captions merge with blank-line separators, matching gateway behavior at `gateway.py:3184-3193`.
  - Single non-album messages bypass the buffer immediately.

- [ ] **Estimated LOC**
  - 130 LOC.

### T9 - OOB command routing for `/help /status /stop /reset /new`

- [ ] **Files touched**
  - Create: `plugin/src/oob.ts`
  - Modify: `plugin/src/telegram.ts`, `plugin/src/channel.ts`, `plugin/src/state.ts`
  - Test: `plugin/tests/oob.test.ts`

- [ ] **Public interface**

```ts
export type OobCommand =
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'stop' }
  | { kind: 'reset'; force: boolean }
  | { kind: 'new' }

export function parseOobCommand(text: string, botUsername?: string): OobCommand | null
export async function handleOobCommand(command: OobCommand, ctx: OobContext): Promise<'handled'>
```

Behavior:
- `/help`: direct Telegram reply with canary command list.
- `/status`: direct Telegram reply with bot id, state dir, allowed user, last update id, webhook enabled/disabled, pending permission count.
- `/stop`: direct ack plus channel event with `meta.command = "stop_request"`. Immediate interruption is a known Channels API unknown because the plugin does not own a `claude -p` process.
- `/reset`: clear `session-ids/chat-<id>.json` and emit `meta.command = "reset_context_request"`.
- `/new`: emit `meta.command = "new_thread_request"` and create a fresh diagnostic session id file.

- [ ] **Dependencies**
  - T3, T6.

- [ ] **Acceptance criteria**
  - Command detection strips `@botusername`, matching `gateway.py:3362-3370`.
  - Commands never invoke `claude -p`.
  - Non-allowlisted senders cannot use commands.
  - `/stop` behavior is documented in `/status` as best-effort channel request until a public interrupt primitive is confirmed.

- [ ] **Estimated LOC**
  - 140 LOC.

### T10 - Status manager and final-reply cleanup

- [ ] **Files touched**
  - Create: `plugin/src/status.ts`
  - Modify: `plugin/src/replyTool.ts`, `plugin/src/telegram.ts`, `plugin/src/channel.ts`
  - Test: `plugin/tests/status.test.ts`

- [ ] **Public interface**

```ts
export type StatusPhase = 'typing' | 'thinking' | 'tool' | 'permission' | 'done' | 'failed'

export class StatusManager {
  constructor(deps: StatusDeps)
  start(chatId: string, replyToMessageId?: number): Promise<StatusHandle>
  update(chatId: string, phase: StatusPhase, detail?: string): Promise<void>
  stop(chatId: string, mode: 'delete' | 'mark_done'): Promise<void>
}
```

Scope A status strings:
- `typing`: `Печатает...`
- `thinking`: `Думает...`
- `tool`: `Инструмент: <tool>`
- `permission`: `Ждет разрешение: <tool>`

- [ ] **Dependencies**
  - T4, T5.

- [ ] **Acceptance criteria**
  - Status message starts after a gated inbound message.
  - Edit interval is about 700 ms, deduping identical text.
  - `reply` finalization deletes or marks done before sending final answer.
  - If Telegram edit fails with HTML parse error, fallback edits plain text.
  - Tool-specific updates can be driven by `set_status` tool and permission_request notifications; automatic stream-json tool detection is not claimed.

- [ ] **Estimated LOC**
  - 150 LOC.

### T11 - Owner-only permission relay proof

- [ ] **Files touched**
  - Create: `plugin/src/permissions.ts`
  - Modify: `plugin/src/channel.ts`, `plugin/src/telegram.ts`, `plugin/src/status.ts`, `plugin/src/schemas.ts`
  - Test: `plugin/tests/permissions.test.ts`

- [ ] **Public interface**

```ts
export type PermissionDecision = { request_id: string; behavior: 'allow' | 'deny'; decided_by: string }

export class PermissionRelay {
  constructor(deps: PermissionDeps)
  handleRequest(req: PermissionRequest): Promise<void>
  handleTextDecision(text: string, senderId: string): Promise<PermissionDecision | null>
  handleCallbackDecision(data: string, senderId: string): Promise<PermissionDecision | null>
  expireOld(nowMs: number): void
}
```

- [ ] **Dependencies**
  - T10.

- [ ] **Acceptance criteria**
  - MCP capability declares `claude/channel/permission`, matching research lines `RESEARCH.md:46-52`.
  - Only `permission_owner_user_ids` can decide requests; default is `123456789`.
  - Text decisions match `yes <id>` / `no <id>` and callback decisions match the same request id.
  - TTL expiry rejects stale decisions and writes audit JSONL.
  - Smoke proof includes a single Bash approval flow; no `--dangerously-skip-permissions` flag is introduced.

- [ ] **Estimated LOC**
  - 170 LOC.

### T12 - Webhook injection scaffold

- [ ] **Files touched**
  - Create: `plugin/src/webhook.ts`
  - Modify: `plugin/src/main.ts`, `plugin/src/channel.ts`, `plugin/src/schemas.ts`, `plugin/src/state.ts`
  - Test: `plugin/tests/webhook.test.ts`

- [ ] **Public interface**

```ts
export function startWebhookServer(config: RuntimeConfig, deps: WebhookDeps): WebhookServerHandle | null
export function validateWebhookAuth(header: string | null, expectedToken: string): boolean
export function buildWebhookChannelEvent(payload: WebhookPayload, config: RuntimeConfig): ChannelEvent
```

- [ ] **Dependencies**
  - T3, T6.

- [ ] **Acceptance criteria**
  - `GET /health` returns `{ "status": "ok", "agent": "<agent_id>" }`.
  - `POST /hooks/agent` enforces bearer token with timing-safe compare.
  - Body limit is 256 KB, matching `gateway.py:3544-3548`.
  - `chatId` must be in allowed DM chat ids; otherwise 403, matching `gateway.py:3565-3584`.
  - Event meta includes `source: "webhook"` and `agent_id`.
  - Non-loopback bind without token fails startup, matching `gateway.py:3626-3640`.

- [ ] **Estimated LOC**
  - 150 LOC.

### T13 - Telegram handler integration and dead-letter logging

- [ ] **Files touched**
  - Modify: `plugin/src/telegram.ts`, `plugin/src/main.ts`, `plugin/src/channel.ts`, `plugin/src/state.ts`, `plugin/src/log.ts`
  - Test: `plugin/tests/integrationOffline.test.ts`

- [ ] **Public interface**

```ts
export async function handleTelegramMessage(ctx: GrammyContext, deps: HandlerDeps): Promise<void>
export async function deliverChannelEvent(event: ChannelEvent, deps: ChannelDeps): Promise<void>
```

- [ ] **Dependencies**
  - T1 through T12.

- [ ] **Acceptance criteria**
  - Text/photo/document/voice messages route through the same validated handler.
  - Failed MCP notification writes a dead-letter file with safe redaction.
  - `update-offset` is updated after a Telegram update is accepted for processing.
  - Bot commands are registered for private chats: `help`, `status`, `stop`, `reset`, `new`.
  - `bun test` passes offline without a Telegram token.

- [ ] **Estimated LOC**
  - 160 LOC.

### T14 - Integration smoke against @testmyfirsttmuxbot

- [ ] **Files touched**
  - Create: `plugin/scripts/smoke-test.md`
  - Modify: `plugin/README.md`
  - Optional: write smoke transcript to `TELEGRAM_STATE_DIR/logs/smoke-YYYY-MM-DD.jsonl`

- [ ] **Public interface**
  - No exported TypeScript API. This is the operator runbook and proof artifact.

- [ ] **Dependencies**
  - T13.

- [ ] **Acceptance criteria**
  - Start in tmux with `claude --dangerously-load-development-channels server:dashi-channel`.
  - Send a DM from user `123456789` to @testmyfirsttmuxbot and receive a reply through the `reply` tool.
  - Send a denied DM from a non-allowlisted user if available, or replay fixture through offline handler.
  - Send a photo/document/voice sample and verify channel content contains `<media>` descriptors.
  - Send two photos as an album and verify one channel event after the 2s buffer.
  - Trigger a Bash permission request and approve once via Telegram owner reply.
  - Verify `bun test` and `bun run typecheck` pass immediately before smoke.
  - Verify no process command line contains `claude -p` for the channel plugin.

- [ ] **Estimated LOC**
  - 40 LOC docs/runbook.

## Section 4 - Test skeletons brief

### `plugin/tests/format.test.ts`

- `escapeHtml escapes ampersand before angle brackets`
- `escapeHtmlAttr also escapes double quotes`
- `markdownToTelegramHtml preserves allowed Telegram tags while escaping unknown tags`
- `markdownToTelegramHtml converts fenced code blocks without interpreting markdown inside`
- `markdownToTelegramHtml converts tables to aligned pre blocks`
- `markdownToTelegramHtml does not italicize snake_case identifiers`
- `isTelegramHtmlParseError recognizes Telegram entity parse failures`

### `plugin/tests/chunk.test.ts`

- `splitMessage returns one chunk under the limit`
- `splitMessage prefers paragraph boundary before newline`
- `splitMessage falls back to hard cut for one oversized word`
- `splitMessage does not split a fitting pre block`
- `reply sends reply_to only on the first chunk`
- `reply falls back to plain text when HTML parse fails`

### `plugin/tests/access.test.ts`

- `gateInbound delivers private DM from allowlisted sender id`
- `gateInbound drops private DM from unknown sender id`
- `gateInbound drops group message even from allowlisted sender in Scope A`
- `gateInbound drops message without from field`
- `assertOutboundChatAllowed allows only configured DM chat ids`
- `assertExpectedBot rejects non-test bot id`

### `plugin/tests/album.test.ts`

- `AlbumBuffer returns not_album for message without media_group_id`
- `AlbumBuffer buffers messages with same media_group_id`
- `AlbumBuffer flushes once after silence window`
- `AlbumBuffer preserves arrival order in flushed messages`
- `AlbumBuffer merges non-empty captions with blank line`
- `AlbumBuffer flushAll drains pending albums on shutdown`

### `plugin/tests/replyAntiSpoof.test.ts`

- `buildReplyMetadata labels self reply only when reply.from.id equals bot id`
- `buildReplyMetadata labels another bot as other_bot even when is_bot is true`
- `renderUntrustedMetadata places reply body only inside JSON`
- `buildReplyMetadata truncates body at 1200 chars and marks truncated`
- `buildReplyMetadata strips null bytes from replied body`
- `buildReplyMetadata labels human sender with username and numeric id`

### `plugin/tests/prompt.test.ts`

- `buildChannelEvent includes chat_id message_id user_id and source meta`
- `buildChannelEvent wraps reply context as untrusted_metadata before user message`
- `buildChannelEvent renders photo descriptor with local image path when downloaded`
- `buildChannelEvent renders document descriptor with safe filename mime and size`
- `buildChannelEvent renders voice descriptor when Groq key is absent`
- `maybeTranscribeVoice injects transcript when fake Groq client succeeds`
- `buildChannelEvent marks webhook source as webhook`

### `plugin/tests/oob.test.ts`

- `parseOobCommand recognizes command with bot username suffix`
- `handleOobCommand help sends direct Telegram response`
- `handleOobCommand status reports canary state without secrets`
- `handleOobCommand stop emits stop_request channel event and does not spawn claude`
- `handleOobCommand reset clears chat session diagnostic state`
- `handleOobCommand new emits new_thread_request channel event`

### `plugin/tests/status.test.ts`

- `StatusManager starts by sending typing status message`
- `StatusManager edits no more often than configured interval`
- `StatusManager dedupes identical status text`
- `StatusManager accepts tool status update via set_status`
- `StatusManager switches to permission status on permission request`
- `StatusManager stops status before final reply`
- `StatusManager falls back to plain text on edit parse error`

### `plugin/tests/permissions.test.ts`

- `PermissionRelay sends request only to owner user ids`
- `PermissionRelay accepts yes code from owner`
- `PermissionRelay accepts no code from owner`
- `PermissionRelay rejects decision from non-owner`
- `PermissionRelay rejects stale request after TTL`
- `PermissionRelay emits claude channel permission notification once`
- `PermissionRelay writes audit record for allow and deny`

### `plugin/tests/security.test.ts`

- `resolveWorkspaceFile resolves relative path under workspace root`
- `assertWorkspaceRelative rejects absolute path outside workspace root`
- `assertWorkspaceRelative rejects symlink escape outside workspace root`
- `assertWorkspaceRelative allows existing file under workspace root`
- `reply rejects file over Telegram document limit`
- `reply does not expose TELEGRAM_STATE_DIR files unless they are also inside workspace root`

### `plugin/tests/webhook.test.ts`

- `validateWebhookAuth accepts exact bearer token`
- `validateWebhookAuth rejects missing or wrong token`
- `webhook rejects payload over 256 KB`
- `webhook rejects chatId outside allowlist`
- `webhook rejects non-loopback bind without token`
- `buildWebhookChannelEvent sets source webhook and agent id`
- `webhook health returns ok without requiring Telegram token`

### `plugin/tests/integrationOffline.test.ts`

- `text fixture routes to one channel notification`
- `photo fixture starts status and includes media descriptor`
- `document fixture includes attachment metadata without downloading`
- `voice fixture uses descriptor when Groq key is absent`
- `permission text reply is intercepted before normal chat delivery`
- `failed channel notification writes dead-letter file`

## Section 5 - Risks and unknowns

### Gateway surprises that bite this iteration

1. Reply-injection anti-spoof is easy to regress. The official plugin has no reply-context prompt builder and its group reply mention check uses username at `server.ts:313-315`. Scope A must implement the gateway numeric `_bot_user_id` comparison from `gateway.py:2786-2793`.
2. Status/progress parity cannot be copied. Gateway status is fed by `claude -p --output-format stream-json` in `gateway.py:1407-1448`; channel plugins do not see Claude tool stream events. Scope A can provide status lifecycle, permission/tool scaffolding, and a `set_status` tool, but automatic tool names need reverse engineering or a future Claude Code hook.
3. `/stop` is not a direct port. Gateway kills `_ACTIVE_PROCS[(agent, chat_id)]`; the channel plugin does not own a subprocess. Scope A records and emits a stop request, but immediate cancellation needs a public Channels interrupt primitive or tmux-side supervisor integration.
4. `/reset` and `/new` in gateway use `claude -p` handoff prompts. Scope A must replace them with state cleanup and channel command metadata. Full handoff compaction belongs in a follow-up.
5. sendDocument security is stricter than the official plugin. The official code only blocks channel state files; the gateway requires workspace-relative resolution at `gateway.py:2992-2997`.
6. Album buffering is required even in DM-only. Without it, Telegram multi-photo sends create multiple Claude turns. The gateway uses 0.7s; Scope A uses the requested 2s window.
7. Voice in groups double-transcribes in production, but groups are out of Scope A. The voice module should not paint itself into a corner; group early transcription is a future extension point.
8. Webhook injection bypasses producer allowlist in gateway after its own auth/allowlist check. Scope A must keep the `chatId` allowlist check even with a valid bearer token.

### Official plugin unclear areas to reverse-engineer

- Whether `meta.source = "webhook"` is preserved as a channel attribute or conflicts with Claude Code's own `<channel source="dashi-channel">` source. T12 should test the emitted payload shape locally; if the attribute is reserved, use `origin="webhook"` plus `source_kind="webhook"` and document it.
- Whether Claude Code exposes any channel-side interruption/cancellation primitive. Research only confirms `notifications/claude/channel` and permission notifications. Do not invent an immediate `/stop` guarantee.
- How long Claude Code batches channel events while busy and how it orders album-flush events relative to normal DMs. `RESEARCH.md:38-39` says notifications are transport writes, not processing acks.
- Exact permission request payload stability. Research lines `RESEARCH.md:46-52` describe fields; keep Zod permissive enough to log unknown extra keys while rejecting missing required keys.
- Whether official plugin's zombie pid replacement can terminate an unrelated poller if two processes share `TELEGRAM_STATE_DIR`. The canary state dir must be unique.

### Likely fix-loop areas

- Telegram HTML edge cases around nested tags, long `<pre>` blocks, and parse fallback.
- Status message cleanup when Claude never calls `reply` or the MCP session disconnects mid-turn.
- Permission button callback behavior under Telegram clients that resend or edit callback messages.
- Groq voice transcription MIME/extension handling for Telegram `.oga` voice files.
- Webhook event source metadata if `source` is reserved by Channels.
- Offline tests that mock Grammy contexts too narrowly; use real-shaped fixture JSON and Zod parse every fixture.

## Section 6 - Ship checklist (Phase 6 inputs)

### Commands to run

Install and typecheck:

```sh
cd /Users/jasonqwwen/qwwiwi-channel-telegram-Claude-code/plugin
bun install
bun run typecheck
```

Run tests:

```sh
cd /Users/jasonqwwen/qwwiwi-channel-telegram-Claude-code/plugin
bun test
```

Prepare canary state:

```sh
mkdir -p "$HOME/.claude/channels/dashi-telegram-canary"
chmod 700 "$HOME/.claude/channels/dashi-telegram-canary"
cat > "$HOME/.claude/channels/dashi-telegram-canary/allowlist.json" <<'JSON'
{
  "mode": "allowlist",
  "allow_user_ids": ["123456789"],
  "allow_chat_ids": ["123456789"],
  "permission_owner_user_ids": ["123456789"],
  "groups": {}
}
JSON
```

Start Claude Code channel in tmux with the test bot only:

```sh
tmux new-session -d -s dashi-channel-canary
tmux send-keys -t dashi-channel-canary \
  'cd /Users/jasonqwwen/qwwiwi-channel-telegram-Claude-code/plugin && TELEGRAM_STATE_DIR=$HOME/.claude/channels/dashi-telegram-canary TELEGRAM_EXPECTED_BOT_ID=8507713167 DASHI_WORKSPACE_ROOT=/Users/jasonqwwen/qwwiwi-channel-telegram-Claude-code claude --dangerously-load-development-channels server:dashi-channel' C-m
```

Smoke against @testmyfirsttmuxbot:

1. DM from Telegram user `123456789`: `ping from channel canary`.
2. Verify `logs/server-YYYY-MM-DD.jsonl` records accepted update and channel notification.
3. Verify Claude replies through the `reply` tool and Telegram receives the answer.
4. Send `/status`; verify direct status response names bot id `8507713167` and no secrets.
5. Send a two-photo album; verify one channel event after about 2 seconds.
6. Send a voice message without `GROQ_API_KEY`; verify descriptor path, not failure.
7. Trigger one Bash permission request from Claude Code and approve with `yes <request_id>` from user `123456789`.
8. Run `ps -axo command | rg 'claude -p|dashi-channel|telegram'` and verify the channel path does not contain `claude -p`.

### Rollback

This iteration does not move production tokens. Rollback is therefore:

```sh
tmux send-keys -t dashi-channel-canary C-c
tmux kill-session -t dashi-channel-canary
rm -f "$HOME/.claude/channels/dashi-telegram-canary/bot.pid"
```

The existing Python canary bot and production gateway remain untouched. If the test bot gets stuck with Telegram 409 conflict, remove only the canary state-dir `bot.pid` after confirming no `bun server.ts` process is still polling that test token.

### Do not touch

- Do not touch production bot tokens for Silvana, Kaelthas, Garrosh, Arthas, or Claude.
- Do not unload, edit, or restart the production `ai.orgrimmar.gateway` launchd job.
- Do not edit `/Users/jasonqwwen/.claude-lab/shared/gateway/gateway.py`.
- Do not point the new plugin at any production bot token.
- Do not run old and new consumers on the same token.
- Do not add `--dangerously-skip-permissions` or `--permission-mode bypassPermissions` as a default.
- Do not perform production cutover in this run. Production token movement is a separate Phase 4/cutover run after this canary plan is implemented, tested, and approved.
