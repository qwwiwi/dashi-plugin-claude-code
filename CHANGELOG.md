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
