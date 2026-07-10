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

## [1.2.0] — 2026-07-10

### Added
- **Expandable task list in the pinned status card** (PR #100): the single
  pinned card can expand to show the full current task list; the task snapshot
  is reset on session start so a fresh session no longer inherits the previous
  one's tasks.
- **tmux-pane task reality mirror** (PR #104): a new `task-reality-mirror.ts`
  reconciler reads the harness's real task list from the tmux pane and feeds
  the pinned card that pane-verified view, so the pin reflects the session's
  actual tasks rather than only hook-derived events. Ships alongside narrower
  task feeders and task-lifecycle fixes.

### Changed
- **Telegram output formatting** (PR #105): newline preservation in the rich
  message path, a heading-affinity chunker that keeps a heading with the block
  it introduces, and a documented tone-of-voice contract
  ([plugin/docs/TOV.md](plugin/docs/TOV.md)).
- **Context HUD window is model-aware** (PRs #106, #107): the context-%
  denominator is now resolved from the session model instead of a fixed
  default — Fable-class models report their true 1M-token window, and the
  session model is read from the transcript so no manual override is needed.
  An explicit operator override is still available (config
  `context_window_tokens` / env `JARVIS_CONTEXT_WINDOW`) and always wins.

### Fixed
- **`classifyPane` recognizes the Claude Code v2.1.201 busy spinner** (PR #101)
  — the pane classifier no longer misreads a working session as idle on the
  newer harness build.
- **Zoom join-URL redaction exemption** (PR #102): a `pwd=` on a `zoom.us`
  join link is a public join passcode, not a secret, and is left intact; the
  exemption is tightened with a query-param allowlist (`pwd`, `uname`, `omn`)
  and a raw-NUL strip on input so the placeholder mechanism can't be spoofed.
- **Precise git-exec-surface gate detector** (PR #103): the permission gate
  no longer raises false confirmation cards for benign git usage while keeping
  its RCE protection intact.

### Removed
- **Repository hygiene and dead-code purge** (PR #108): `webhook/server.ts` is
  split into focused route modules, the unused `persona-manager.ts` is removed
  (per-chat persona overlay is applied by the `chats/hooks/session-start.sh`
  SessionStart hook), tracked build/junk artifacts are purged, and `.gitignore`
  is hardened.

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
