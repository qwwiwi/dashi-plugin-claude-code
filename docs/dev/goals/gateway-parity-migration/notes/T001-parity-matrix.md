# T001 Parity Matrix

## Evidence Read

- Current qwwiwi canary bot: `scripts/dashi-telegram-canary-bot`
- Current canary tests: `tests/test_dashi_telegram_canary_bot.py`
- Current runbook: `docs/10-canary-telegram-smoke-bot.md`
- Current migration baseline: `docs/07-runtime-baseline-and-canary-runbook.md`
- Reference gateway README: `/Users/jasonqwwen/projects/jarvis-telegram-gateway/README.md`
- Reference gateway implementation: `/Users/jasonqwwen/projects/jarvis-telegram-gateway/gateway.py`

No token files, production launchd jobs, gateway configs, or live tmux pane contents were read.

## Feature Parity Matrix

| Capability | Reference gateway evidence | qwwiwi canary evidence | Current status | Migration note |
|---|---|---|---|---|
| Telegram long-poll | `gateway.py` producer uses `getUpdates`, per-agent offsets, queues | `TelegramClient.get_updates`, `run_once`, offset file | Partial | Canary has simple single-consumer polling and 409 conflict handling, not producer-consumer queueing. |
| Text DM replies | `process_update` invokes Claude and `send_message` replies to original message | `run_once` sends ACK or Claude fallback reply | Partial | Works for basic text, no reply-to, HTML, chunking, or session resume. |
| `/new` | `handle_command` handoff reset via `claude -p --resume` | No command handler | Missing | Requires session persistence and handoff design; not first slice. |
| `/reset` | `handle_command`; `/reset force` OOB in producer | No command handler | Missing | Force reset can be local later; non-force needs session/handoff. |
| `/status` | `handle_command` returns session and memory sizes | No command handler | Missing | Safe future local slice if scoped to canary offset/reply mode status. |
| `/stop` | OOB producer terminates active Claude subprocess | Current `claude --print` is synchronous inside `run_once`; no active process registry | Missing | Needs process ownership model; defer until worker/consumer split or async runner. |
| `/compact` | `handle_command` compacts hot to warm through `claude -p --resume` | No memory/session path | Missing | Depends on hot memory/session persistence. |
| `/help` | `handle_command` lists gateway commands and `setMyCommands` registers menu | No command handler | Missing | Safe local slice after command parser exists. |
| `/goat` as `/goal` | User-required canary behavior, not a reference feature | No normalization | Missing | Safe first implementation slice: normalize inbound command before Claude prompt. |
| Image/photo handling | `resolve_media_ref`, `download_telegram_file`, prompt `[Image: path]` | `update_text` only uses text/caption; non-text placeholder otherwise | Missing | Needs safe media download root and file cleanup policy. |
| Document/video/sticker handling | Downloads docs/videos/stickers; sticker cache descriptions | Caption or generic non-text placeholder only | Missing | Defer until media download module and tests. |
| Voice/audio/video_note transcription | Groq Whisper via `transcribe_audio`, early group transcription | No transcription | Missing | External Groq key dependency; defer until local interface can be tested with fake transcriber. |
| Forward context | `classify_source` and `[Forwarded from: ...]` prompt prefix | Not extracted | Missing | Safe prompt-builder slice after command normalization. |
| Reply context | Untrusted metadata JSON block from `reply_to_message` | Not extracted | Missing | Safe prompt-builder slice; include injection/truncation tests. |
| Message reactions | `setMessageReaction` eyes emoji before processing | No reaction calls | Missing | Requires Telegram method call; safe with fake client tests later. |
| Inline buttons/callbacks | `send_message_with_buttons`, callback dispatch, `allowed_updates` includes callback queries | `allowed_updates` only `["message"]` | Missing | Requires callback update routing. |
| User/group allowlist | `allowlist_user_ids`, `allowlist_group_ids` | Separate canary token only; no user/group allowlist in bot | Missing | Needs config surface without touching production config. |
| Mention/name/reply group addressing | `is_addressed_to_agent` with aliases and bot username | No group addressing | Missing | Should follow allowlist slice. |
| Per-topic routing | `topic_routing` in producer | None | Missing | Group routing extension. |
| Markdown to Telegram HTML | `markdown_to_telegram_html`, parse-error fallback, chunking | Plain `sendMessage` with no parse mode | Missing | Good local utility slice after command parser. |
| Long message chunking | `send_message` chunks at 4000 chars | No chunking | Missing | Pair with Markdown HTML send path. |
| `sendDocument` for produced files | `invoke_claude` tracks written files and `send_document` sends workspace-contained files | No file tracking | Missing | Depends on stream-json or channel output file event tracking. |
| Webhook injection | `POST /hooks/agent`, `/health`, bearer auth | None | Missing | Can be local-only later; do not expose without auth tests. |
| Hot memory | `append_to_hot_memory` | None | Missing | Needs workspace/memory root choice. |
| OpenViking/L4 hooks | `push_to_openviking`, group logging hooks | None | Missing | External dependency; test with fake HTTP/client first. |
| Streaming/progress modes | `stream-json`, `_StatusTracker`, partial/progress/off | `claude --print` only | Missing | Bigger runtime slice; likely after session persistence. |
| Session persistence | Stable per-chat SID, `--session-id` then `--resume` | No SID; every turn uses `claude --print` | Missing | High-value but requires careful canary state and CLI tests. |
| Secret redaction | `_mask_secrets`; token-file config encouraged | `redact_secret_like_text`; tests assert no token output | Partial | Preserve in every slice. |
| One-token-one-consumer signal | Producer architecture assumes one poller per token | 409 conflict returns code 4 and clear error | Present | Do not run live polling tests while tmux canary owns token. |

## Safe First Slice Decision Input

Recommended first implementation slice: command normalization that treats an inbound Telegram `/goat` command exactly as `/goal` before the Claude prompt is built.

Why this slice:

- It directly satisfies an explicit owner requirement.
- It is local and deterministic: fake Telegram updates and fake reply provider are enough.
- It does not require reading token files, using live Telegram, changing tmux, or touching production config.
- It creates a small command parsing seam needed for later `/help`, `/status`, `/reset force`, and `/stop` work.

Suggested acceptance tests:

- `/goat` is delivered to the reply provider as `/goal`.
- `/goat migrate parity` is delivered as `/goal migrate parity`.
- `/goat@SomeBot migrate parity` is delivered as `/goal migrate parity`.
- Captions using `/goat` normalize the same way.
- Non-command words containing `goat` do not change.
- Token redaction tests still pass.
