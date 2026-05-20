# dashi-channel

Custom Claude Code channel plugin для Orgrimmar Telegram agents. Замена Python `claude -p` gateway. Параллелен Anthropic Telegram plugin'у — наш fork с full Jarvis parity.

## Why this exists

Миграция Silvana / Kaelthas / Garrosh / Arthas / Claude с Python gateway.py на Claude Code Channels до `2026-06-15` billing cutover. См. root [README.md](../README.md) и [docs/01-context.md](../docs/01-context.md).

## Status (2026-05-15)

**Готов к production cutover.** 3 фазы merged в main:

- [PR #1](https://github.com/qwwiwi/qwwiwi-channel-telegram-Claude-code/pull/1) — base plugin (inbound, OOB, voice, media, albums, status, permissions, anti-spoof)
- [PR #2](https://github.com/qwwiwi/qwwiwi-channel-telegram-Claude-code/pull/2) — Jarvis hook parity (tool calls + reasoning видны в Telegram статусе)
- [PR #3](https://github.com/qwwiwi/qwwiwi-channel-telegram-Claude-code/pull/3) — Memory hook parity (recent.md + verbose.jsonl writers)

**Tests:** 425 pass / 0 fail / 2150 expect() across 27 files. `bun run typecheck` clean.

## Quick start

```bash
cd plugin/
bun install

# Direct mode (token from env):
TELEGRAM_BOT_TOKEN=... bun run start

# Via Claude Code with isolated state dir:
TELEGRAM_STATE_DIR=/tmp/dashi-channel-test \
  claude --dangerously-load-development-channels server:dashi-channel
```

## Hook integration (Phase 7 + Phase 8)

После того как плагин запущен и Claude Code сессия открыта, нужно установить агентские хуки в `~/.claude/settings.json` чтобы PreToolUse/PostToolUse/Stop/UserPromptSubmit/SessionStart events приходили обратно в плагин через webhook:

```bash
bash plugin/scripts/install-hooks.sh \
  --settings ~/.claude/settings.json \
  --chat-id <your-telegram-chat-id> \
  --webhook-url http://127.0.0.1:8089/hooks/agent \
  --agent-id dashi-channel
```

Идемпотентно. Marker-based replacement — повторный запуск не дублирует записи. Чистит legacy markerless entries указывающие на наш `post-hook.ts`.

## Memory hooks (Phase 8 config)

Чтобы плагин писал turn'ы в `<workspace>/core/hot/recent.md` + `<workspace_parent>/logs/verbose-YYYY-MM-DD.jsonl` (Cognee cron подхватит автоматически), добавь в config.json:

```json
{
  "memory": {
    "enabled": true,
    "workspace_path": "/Users/<you>/.claude-lab/<agent>/.claude",
    "agent_label": "Silvana",
    "source_tag": "tg"
  }
}
```

Env overrides: `TELEGRAM_MEMORY_ENABLED`, `TELEGRAM_MEMORY_WORKSPACE`, `TELEGRAM_MEMORY_LOGS_PATH`, `TELEGRAM_MEMORY_SOURCE_TAG`, `TELEGRAM_MEMORY_AGENT_LABEL`.

## Terminal mirror (PR #15)

`TmuxMirror` мирорит pane агентского tmux session в ОДНО rolling Telegram сообщение через `editMessageText`. Полезно когда оператор хочет видеть raw bash output без SSH доступа.

Default-OFF — opt-in через config:

```json
{
  "tmux_mirror": {
    "enabled": true,
    "pane_target": "channel-thrall:0.0",
    "poll_interval_ms": 5000,
    "line_count": 50
  }
}
```

Поведение:
- Polls `tmux capture-pane -p -t <pane_target> -S -<line_count>` каждые `poll_interval_ms`
- ANSI/CSI/OSC/DCS sequences стрипаются, control chars (кроме `\n`, `\t`) удаляются
- Текст пропускается через `redactSecrets` (тот же что в safe-telegram-api), затем HTML-escape, затем оборачивается в `<pre>`
- Hash-based dedup: identical poll → нет API call
- Edit «message to edit not found» (400 с подходящим description) → re-send. Прочие 4xx (403, 413 и т.д.) НЕ триггерят resend, чтобы не было storm
- Длинный pane обрезается с маркером «[truncated]» (cap 4096 chars)
- SIGINT/SIGTERM → попытка `deleteMessage` (best-effort cleanup)

Out of scope (отдельные PR'ы):
- `/mirror on|off|status` OOB команда — пока тогглится через config + рестарт
- Telegram → tmux `send-keys` (control surface, не view-only)
- Voice / screenshot capture

## WARNING

- НЕ использовать production bot токены здесь без явного OK принца. Production боты:
  - Silvana (`@fridayhumanbot`)
  - Kaelthas (`@kaelthasproducerbot`)
  - Garrosh (`@garroshsalebot`)
  - Arthas (own bot)
  - Claude (own bot)
- Тестовый бот: `@testmyfirsttmuxbot` (id `8507713167`).
- Production cutover — отдельный план, RED operation, требует явное «да, на prod» от принца.

## Smoke test

Local pre-flight (детерминистично, без сети):

```bash
./scripts/smoke-local
```

Запускает `bun install`, `bun run typecheck`, `bun test tests/`. Exit non-zero на первой ошибке.

Live smoke против `@testmyfirsttmuxbot` (15-row matrix, operator-driven): см. [`docs/canary-smoke.md`](docs/canary-smoke.md). Покрывает text, HTML chunking, reply anti-spoof, photo/document/voice/album, OOB (`/status`, `/help`, `/stop`, `/reset`), permission relay (allow/deny), webhook путь. Включает rollback procedure на Python canary.

End-to-end Progress Reporter (после установки хуков):

```bash
TELEGRAM_HOOK_CHAT_ID=<chat_id> \
TELEGRAM_WEBHOOK_URL=http://127.0.0.1:<port>/hooks/agent \
TELEGRAM_WEBHOOK_TOKEN=<token> \
bash scripts/smoke-test-progress.sh --bot-id <expected_bot_id>
```

Прогоняет 5 синтетических hook-event-ов (PreToolUse/PostToolUse для Bash и Edit, плюс Stop) через `post-hook.ts` → webhook → ProgressReporter. Печатает табличный pass/fail summary. См. [`docs/progress-reporter-setup.md`](docs/progress-reporter-setup.md) — установка в 3 шага, troubleshooting, что работает / чего ещё нет.

## Tests

- `bun test` — все 425 тестов
- `bun test tests/memory/` — Phase 8 (46 tests)
- `bun test tests/hooks/` — Phase 7 (hooks + claude-events + install-hooks + post-hook)
- `bun test tests/status/activity-renderer.test.ts` — Phase 7 humanization + secret masking + rolling render
- `bun run typecheck` — `tsc --noEmit` strict
- `bash scripts/smoke-test-progress.sh` — end-to-end webhook + ProgressReporter check (см. секцию Smoke test выше)

## Architecture (per-agent process model)

Один plugin process = один агент = один Telegram бот = один workspace. State-dir изолирован через `TELEGRAM_STATE_DIR`. Все file-locking — внутри-процессное (`Mutex` per path), потому что single-writer invariant.

## Attribution

Fork оригинального Anthropic Telegram plugin с full Jarvis Gateway parity. Custom код под Apache 2.0 (наследовано от upstream). См. LICENSE.
