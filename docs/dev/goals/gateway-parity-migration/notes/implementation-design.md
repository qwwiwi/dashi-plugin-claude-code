# Gateway Parity Implementation Design

## Safety Envelope

- Keep the existing canary token single-consumer: do not start another poller while `orgrimmar-canary` owns the token.
- Keep production untouched: no production token files, launchd jobs, gateway config, or production tmux sessions.
- Make every gateway capability land as a tested local slice before any live canary smoke.
- Prefer small modules/helpers with focused tests over importing the whole reference `gateway.py`.
- Keep redaction tests in every slice that touches subprocess output, Telegram errors, or external API errors.

## Target Shape

The current canary bot is a single Python script. Keep that stable while extracting only when a slice needs it:

- `command` helpers: parse Telegram command heads, normalize aliases, and dispatch canary-safe local commands.
- `prompt_context` helpers: build text for Claude from text, captions, forwards, replies, group metadata, and media descriptors.
- `telegram_send` helpers: Markdown-to-Telegram HTML, chunking, parse-error fallback, reactions, and optional inline buttons.
- `media` helpers: download Telegram files into a bounded canary media root, describe image/document/video/sticker inputs, and wrap voice/audio/video_note transcription behind an injectable transcriber.
- `claude_session` helpers: persist per-chat session ids and invoke Claude with `--session-id` on first turn and `--resume` after that.
- `progress` helpers: consume stream-json or channel progress events, edit a status message, and collect produced file paths.
- `produced_files` helpers: send supported files via `sendDocument` only when resolved under the canary workspace.
- `routing` helpers: user allowlist, group allowlist, mention/name/reply addressing, and topic routing.
- `webhook` helpers: loopback-only injection endpoint with bearer auth and fake-client tests before live enablement.
- `memory` hooks: hot memory append first, then OpenViking semantic push through an injectable client.

## Slice Order

1. Command normalization: `/goat` -> `/goal` before Claude prompt construction. This is implemented as the first verified slice.
2. Canary command router: `/help` and `/status` without Claude spend; `/reset force` only for local canary state; document `/new`, `/compact`, and `/stop` as blocked until session/process ownership exists.
3. Prompt context: reply and forward metadata as injection-safe JSON blocks, plus group source labels.
4. Telegram send path: Markdown-to-HTML conversion, long-message chunking, reply-to original message, parse-error fallback.
5. Session persistence: per-chat SID files and `claude --resume` compatibility, with tests around first turn, resumed turn, and reset.
6. Streaming/progress: switch from `claude --print` to a stream-capable runner only after session tests pass.
7. Produced files: track written files from stream/channel events and send workspace-contained supported files through `sendDocument`.
8. Media and transcription: file download descriptors first, then fake-transcriber tests, then Groq-backed voice/audio/video_note only with key-file safety.
9. Group routing: allowlist, mention/name/reply addressing, topic routing, and group-safe system prompt.
10. Webhook and memory hooks: loopback webhook injection, hot memory append, OpenViking semantic push, then group logging.

## Smoke Gates

- Local unit tests must pass before any live canary smoke.
- Live smoke must use the already-running canary consumer or an operator-sent Telegram message; do not launch a second poller.
- Before replacing `orgrimmar-canary`, collect host evidence for Claude auth, tmux session command, and current one-consumer ownership.
- Smoke receipts should record the command tested, expected Telegram-visible behavior, and whether any secret-like text appeared.

## Next Active Task

The board is intentionally left active on `T004`: smoke-test or prepare a smoke-test handoff for the verified `/goat` alias without starting a second Telegram consumer.
