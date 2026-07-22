# Changelog

All notable changes to the dashi-channel plugin are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning:
[Semantic Versioning](https://semver.org). The single source of truth for the
current version is `.claude-plugin/plugin.json`; `plugin/package.json` is kept
in lockstep (enforced by `plugin/tests/version-sync.test.ts`), and the MCP
server identity reads `package.json` at runtime. Release process:
`docs/RELEASING.md`.

Versions before 1.0.0 were not tracked — the project shipped ~60 merged PRs
between 2026-05-14 and 2026-06-14 without a version discipline. 1.0.0
retroactively marks the state of `main` on 2026-06-14.

## [1.3.0] — 2026-07-22

### Added
- **Guest Mode media parity.** A guest `@`-mention now delivers inbound media
  at DM parity: the mention's own photo (eager-downloaded to the inbox), voice
  (transcribed), and document/audio/video/video_note/sticker/animation (as
  `file_id` `<media>` descriptors), plus the replied-to message's media surfaced
  as **metadata-only** `<media>` tags inside the `<untrusted_metadata>` reply
  block. Previously the guest path was text-only and dropped a media-only
  mention with no caption.
- **`download_attachment` works in guest/foreign chats.** When called with a
  `guest_query_id`, it authorizes via a **non-consuming** registry check
  (`GuestQueryRegistry.hasActiveEntry` — matches a still-live entry created by
  an allowlisted caller, with a chat-id origin guard) instead of the chat
  allowlist. It never widens the legacy allowlist path (no `guest_query_id` =
  unchanged `assertAllowedChat`), and the check does not consume the one-shot
  reply.
- **Animation (GIF)** as a first-class media kind on both the DM and guest
  paths (previously a GIF surfaced only as its back-compat `document` twin).

### Changed
- Reply-target media is **never eager-downloaded or transcribed** — the replied-to
  author is not the allowlisted caller, so reply media stays metadata-only for
  every kind. The mention's own media (from the allowlisted caller) is still
  eager.
- Per-kind media descriptor builders extracted into `src/telegram/media-descriptors.ts`
  (single source of truth, reused by the DM own-message, guest own-message, and
  all reply paths). Pure refactor — no behavior change on existing paths.

### Fixed
- GIF de-dup: a GIF carries both `animation` and a compatibility `document`; the
  media aggregators now emit it once (as `animation`), not twice.
- A reply to a caption-less photo/voice/document no longer swallows the entire
  reply-context block — the `<untrusted_metadata>` reply is emitted with its
  media even when the reply itself has no text.

## [1.2.1] — 2026-07-21

### Changed
- **`plugin/.mcp.json` ships only the `dashi-channel` server.** The four
  `dashi-gbrain-*` HTTP servers pointed at the author's private shared-memory
  host (`mcp.orgrimmar.xyz`), which issues no public tokens — fresh installs
  saw a permanent auth warning and agents wasted time probing an unreachable
  service. Shared-memory MCP entries now live in
  `examples/mcp.gbrain.example.json` as an opt-in template: self-host your own
  brain (https://github.com/qwwiwi/public-gbrain-agentos), point the template
  at YOUR host and merge it in. `.env.example` comment updated to match.

## [1.2.0] — 2026-07-10

### Added
- **Expandable task list in the pinned status card** (PR #100): the single
  pinned card can expand to show the full current task list.
- **tmux-pane task reality mirror** (PR #104): a new `task-reality-mirror.ts`
  reconciler reconciles the pinned task list with the state detected in the
  tmux pane, so the pin reflects the session's actual tasks rather than only
  hook-derived events. Ships alongside narrower task feeders.
- **Tone-of-voice contract document** (PR #105): a new
  [plugin/docs/TOV.md](plugin/docs/TOV.md) documents the output tone-of-voice
  contract.

### Changed
- **Telegram output formatting** (PR #105): newline preservation in the rich
  message path and a heading-affinity chunker that keeps a heading with the
  block it introduces.
- **Context HUD window is model-aware** (PRs #106, #107): the context-%
  denominator is now resolved from the session model instead of a fixed
  default — Fable-class models report their true 1M-token window, and the
  session model is read from the transcript so no manual override is needed.
  An explicit operator override is still available and always wins over the
  per-model table; precedence is config `context_window_tokens` > env
  `JARVIS_CONTEXT_WINDOW` > per-model table.
- **`webhook/server.ts` split into route modules** (PR #108): the webhook
  server is refactored into focused route modules — a move-only refactor with
  no behavior change.
- **`.gitignore` hardened** (PR #108): the ignore rules are tightened so
  build/junk artifacts are no longer tracked.

### Fixed
- **`classifyPane` recognizes the Claude Code v2.1.201 busy spinner** (PR #101)
  — the pane classifier no longer misreads a working session as idle on the
  newer harness build.
- **Session task snapshot reset on session start** (PR #100): the pinned task
  snapshot is reset when a new session starts, so a fresh session no longer
  inherits the previous one's tasks.
- **Task pin session-lifecycle fixes** (PR #104): Stop is treated as
  end-of-turn, not end-of-session, so tasks are no longer finalized or cleared
  on Stop; task snapshots are namespaced by session id (reset on a session
  change, preserved across compaction); a phantom `PreToolUse` task feeder that
  raced the permission gate is removed; and the snapshot TTL only evicts
  orphaned sessions, never the active one.
- **Zoom join-URL redaction exemption** (PR #102): the `pwd=` parameter is
  intentionally preserved in recognized `zoom.us` join URLs so shared meeting
  links stay usable; the exemption is scoped by a query-param allowlist (`pwd`,
  `uname`, `omn`), with a raw-NUL strip on input to mitigate placeholder
  spoofing.
- **Precise git-exec-surface gate detector** (PR #103): the permission gate
  no longer raises false confirmation cards for benign git usage while keeping
  its RCE protection intact.

### Removed
- **Dead code and tracked-junk purge** (PR #108): the unused
  `persona-manager.ts` is removed (the per-chat persona overlay is applied by
  the `chats/hooks/session-start.sh` SessionStart hook), and tracked build/junk
  artifacts are purged from the index.

## [1.1.0] — 2026-07-04

### Added
- **Rich messages** (PR #86): DM replies auto-upgrade to Telegram Bot API 10.1
  `sendRichMessage` — raw markdown rendered server-side (tables, headings,
  task-lists, math, `<details>`, footnotes), 32 KB in a single message.
  Transparent HTML fallback, session capability latch, killswitch
  `TELEGRAM_RICH_MESSAGES=0`, per-chat opt-out.
- **Guest Mode** (PR #96): one-shot @-mention answers in chats the bot is not
  a member of, via `answerGuestQuery`; fail-closed allowlist gate on the
  caller's user id.
- **Context HUD + state-aware controls** (PR #94): pinned context-% HUD,
  reliable `/compact`, `/new`, `/status` driven through the TUI, owner-scoped
  command menu, AskUserQuestion relayed as Telegram inline buttons.
- **Single pinned status card** (PR #95): one pinned message combining
  context %, mode, and task list, re-anchored above the tmux mirror on every
  inbound message; service bubbles auto-deleted.

### Fixed
- HUD dialog no longer renders a stray second button row (PR #97).

## [1.0.0] — 2026-06-14

Retroactive baseline — first stable state, in production for the whole agent
fleet (silvana, kaelthas, garrosh, arthas). Highlights accumulated since
2026-05-14:

- Telegram DM bridge: inbound injection into a tmux-hosted Claude Code
  session, `reply`/`edit_message`/`react`/`download_attachment` MCP tools.
- Multichat: public group/supergroup sessions with an outbox delivery path.
- Permission gate + relay: sensitive tool calls confirmed via Telegram.
- Confirm-panel keys (PRs #79–#84): one-tap button keypad for native TUI
  dialogs, OOB slash commands, backspace/passthrough handling.
- Terminal mirror, voice-message transcription, photo/document intake.
- Secret redaction on every outbound path; bot-token scrubbing.
- `doctor` self-diagnostics (fleet checks, bridge checks, socket checks).
- Session auto-restart watchdog.
