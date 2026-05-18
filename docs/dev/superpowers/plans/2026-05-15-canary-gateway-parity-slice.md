# Canary Gateway Parity Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the running canary Telegram bot materially closer to Jarvis gateway behavior without exposing secrets or starting a second Telegram consumer.

**Architecture:** Keep the current single-file canary runner, but add focused helpers around command routing, Telegram send formatting, prompt context, media descriptors, and Claude session persistence. External services stay behind optional interfaces and fail closed.

**Tech Stack:** Python standard library, Telegram Bot HTTP API through `urllib`, Claude Code CLI, `unittest`.

---

### Task 1: Gateway Commands

**Files:**
- Modify: `scripts/dashi-telegram-canary-bot`
- Test: `tests/test_dashi_telegram_canary_bot.py`

- [ ] Write failing tests for `/help`, `/status`, `/reset force`, `/new force`, `/compact`, and `/stop` command handling.
- [ ] Run `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tests.test_dashi_telegram_canary_bot -v` and confirm the new tests fail.
- [ ] Add command parsing and a local canary-safe command router. `/help` and `/status` respond without Claude spend; `/reset force` and `/new force` delete canary session files; `/stop` reports sync-runner limitations; `/compact` reports whether a session exists.
- [ ] Re-run the targeted test file and confirm it passes.

### Task 2: Telegram Send Path

**Files:**
- Modify: `scripts/dashi-telegram-canary-bot`
- Test: `tests/test_dashi_telegram_canary_bot.py`

- [ ] Write failing tests for Markdown-to-HTML conversion, 4000-character chunking, first-chunk reply-to, and HTML parse fallback to plain text.
- [ ] Run the targeted test file and confirm failures.
- [ ] Extend `TelegramClient.send_message` to support `reply_to_message_id`, HTML parse mode, chunking, and parse-error fallback.
- [ ] Re-run the targeted test file and confirm it passes.

### Task 3: Prompt Context And Media Descriptors

**Files:**
- Modify: `scripts/dashi-telegram-canary-bot`
- Test: `tests/test_dashi_telegram_canary_bot.py`

- [ ] Write failing tests showing forwarded messages, reply context, photos, documents, stickers, video, voice, audio, and video notes are represented in the Claude prompt text.
- [ ] Run the targeted test file and confirm failures.
- [ ] Add source classification, reply/forward context extraction, and media descriptor construction. Voice/audio/video_note use an optional transcriber interface and otherwise produce a clear descriptor.
- [ ] Re-run the targeted test file and confirm it passes.

### Task 4: Claude Session Persistence

**Files:**
- Modify: `scripts/dashi-telegram-canary-bot`
- Test: `tests/test_dashi_telegram_canary_bot.py`

- [ ] Write failing tests for first-turn `--session-id`, second-turn `--resume`, and reset removing session state.
- [ ] Run the targeted test file and confirm failures.
- [ ] Persist a UUID per chat under the canary runtime root. Use `--session-id` for the first successful turn and `--resume` for subsequent turns.
- [ ] Re-run the targeted test file and the full suite.

### Task 5: GoalBuddy, Commit, Push, Live Reload

**Files:**
- Modify: `docs/goals/gateway-parity-migration/state.yaml`

- [ ] Update the active GoalBuddy task with what is implemented and what remains blocked or external.
- [ ] Run `git diff --check`.
- [ ] Run the GoalBuddy checker.
- [ ] Commit and push.
- [ ] Reload the existing `orgrimmar-canary` tmux session with the same command only after tests pass.
