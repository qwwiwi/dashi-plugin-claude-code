# dashi-channel

Custom Claude Code channel plugin для Orgrimmar Telegram agents. Замена Python `claude -p` gateway. Параллелен Anthropic Telegram plugin'у — наш fork с full Jarvis parity.

Этот README — plugin-scoped (как запускать из `plugin/`, env vars, hooks, multichat). Общий обзор архитектуры и сравнение с gateway — в корневом [../README.md](../README.md) и [../docs/01-what-is-this.md](../docs/01-what-is-this.md).

## Why this exists

Миграция Silvana / Kaelthas / Garrosh / Arthas / Claude с Python gateway.py на Claude Code Channels до `2026-06-15` billing cutover. См. [../DEPRECATION-PATH.md](../DEPRECATION-PATH.md).

## Status

Под активной разработкой. Последний смерженный PR: **#25** (`fix(status)`: suppress «Печатает…» bubble). Полный актуальный список — `gh pr list --state merged --limit 10` в этом репо. CI: `bun test` + `bun run typecheck` должны проходить чисто перед merge.

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

`bun run start` — это `bun run src/server.ts`. Standalone-режим удобен для быстрой проверки токена; production-режим — через `claude --dangerously-load-development-channels`, чтобы Claude Code сам держал runtime плагина.

## Hook integration (обязательно для прогресса в Telegram)

После того как плагин запущен и Claude Code сессия открыта, нужно установить агентские хуки в `~/.claude/settings.json` чтобы PreToolUse / PostToolUse / Stop / UserPromptSubmit / SessionStart events приходили обратно в плагин через webhook. Без этого шага `ProgressReporter`, `TaskMirror` и `ActivityRenderer` остаются молчаливыми.

```bash
bash plugin/scripts/install-hooks.sh \
  --settings ~/.claude/settings.json \
  --chat-id <your-telegram-chat-id> \
  --webhook-url http://127.0.0.1:8089/hooks/agent \
  --agent-id dashi-channel
```

Идемпотентно. Marker-based replacement — повторный запуск не дублирует записи. Чистит legacy markerless entries указывающие на наш `post-hook.ts`.

## Environment variables

Полный список — `plugin/src/config.ts` (`RuntimeEnvSchema`). Минимум:

| Var | Что делает |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot API token. **Обязательно.** |
| `TELEGRAM_STATE_DIR` | Корень runtime-state (логи, allowlist, pid, inbox). Default `~/.claude/channels/dashi-telegram-canary`. |
| `TELEGRAM_CONFIG_FILE` | Путь до `config.json`. Default — внутри `TELEGRAM_STATE_DIR`. |
| `TELEGRAM_EXPECTED_BOT_ID` | Защита от подмены: при несовпадении с `getMe()` плагин падает. |
| `TELEGRAM_ALLOWED_USER_IDS` | CSV — кто имеет право писать боту (legacy DM-режим). |
| `TELEGRAM_WORKSPACE_ROOT` | Корень agent workspace (где CLAUDE.md). |
| `TELEGRAM_WEBHOOK_HOST` / `TELEGRAM_WEBHOOK_PORT` / `TELEGRAM_WEBHOOK_TOKEN` | Bind для webhook-сервера хуков. |
| `TELEGRAM_MEMORY_*` | Memory hook config (см. секцию ниже). |
| `TELEGRAM_MULTICHAT_*` | Multichat router config (см. секцию ниже). |
| `GROQ_API_KEY` | Whisper transcription для голосовых (опционально). |

## Memory hooks (опционально)

Чтобы плагин писал turn'ы в `<workspace>/core/hot/recent.md` + `<workspace_parent>/logs/verbose-YYYY-MM-DD.jsonl` (cognee cron подхватит автоматически), добавь в `config.json`:

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

## Multichat router (опционально, default OFF)

`MultichatRouter` разводит входящие сообщения по нескольким per-chat tmux-сессиям `claude` (одна identity, разные чаты — DM вождя, рабочая группа, sandbox). По умолчанию выключен: legacy single-DM-режим продолжает работать без изменений.

Минимальный config:

```json
{
  "multichat": {
    "enabled": true,
    "workspace_dir": "/home/you/.claude-lab/myagent/.claude",
    "policy_path": "/home/you/.claude-lab/myagent/.claude/chats/policy.yaml",
    "state_dir": "/home/you/.claude-lab/myagent/.claude/state/multichat"
  }
}
```

Env overrides: `TELEGRAM_MULTICHAT_ENABLED`, `TELEGRAM_MULTICHAT_POLICY_PATH`, `TELEGRAM_MULTICHAT_STATE_DIR`, `TELEGRAM_MULTICHAT_WORKSPACE_DIR`.

`policy.yaml` (`MultichatPolicySchema` в `src/chats/policy-loader.ts`, strict Zod):

```yaml
version: 1
allowlist:
  chats: ["164795011", "-1003784643974"]   # chat_id строкой — отрицательные group id обязаны быть в кавычках
  users: ["164795011"]                       # кто вообще может писать
mention_allowlist: ["164795011"]             # кто может звать через @mention в группах
chats:
  "164795011":
    mode: private                             # private | public — выбирает поверхности (TmuxMirror, edit_message_progress)
    streaming: progress                       # progress | off
    tmux_mirror: true                         # включить TmuxMirror в этом чате
    edit_message_progress: true               # rolling editMessageText для ProgressReporter
    delivery: streamed                        # streamed | final_only
    persona_file: chats/personas/warchief.md  # per-chat persona overlay (относительно workspace_dir)
    handoff_file: core/hot/handoff.md
    system_reminder: "Это личный DM вождя."
    idle_ttl_ms: 1800000                      # 30 мин до выгрузки tmux-сессии (default)
    max_queue_depth: 1                        # сколько inbound сообщений можно поставить в очередь (default 1)
```

Per-chat persona-файл резолвится относительно `multichat.workspace_dir` — `PersonaManager` загружает его при первом сообщении и накладывает поверх единой Thrall identity. Никаких отдельных CLAUDE.md per chat не нужно.

Логи: `{state_dir}/chats/<chat_id>/{inbox,outbox,processing,dead-letter}/*.json` — JSON-pipe между плагином и tmux-сессией. Outbox dead-letter содержит сообщения которые не удалось отправить в Telegram даже после retry — оператор разбирает руками.

Failure mode: если `policy.yaml` невалидна, плагин логирует ошибку и деградирует в multichat-OFF (legacy single-DM). Это специально — лучше работать с одним чатом, чем падать целиком.

## Terminal mirror

`TmuxMirror` (PR #15) мирорит pane агентского tmux session в ОДНО rolling Telegram сообщение через `editMessageText`. Полезно когда оператор хочет видеть raw bash output без SSH доступа.

Default-OFF — opt-in через config:

```json
{
  "tmux_mirror": {
    "enabled": true,
    "pane_target": "channel-thrall:0.0",
    "poll_interval_ms": 5000,
    "line_count": 50,
    "mode": "latest_inbound_only",
    "max_lines": 14,
    "hide_segments": ["boot_banner", "inbound_warning", "footer_hints", "input_box"]
  }
}
```

Поведение:
- Polls `tmux capture-pane -p -t <pane_target> -S -<line_count>` каждые `poll_interval_ms`
- ANSI/CSI/OSC/DCS sequences стрипаются, control chars (кроме `\n`, `\t`) удаляются
- Текст пропускается через `redactSecrets` (тот же что в safe-telegram-api), затем HTML-escape, затем оборачивается в `<pre>`
- Hash-based dedup: identical poll → нет API call
- Edit «message to edit not found» (400 с подходящим description) → re-send. Прочие 4xx (403, 413 и т.д.) НЕ триггерят resend, чтобы не было storm
- `mode: latest_inbound_only` (default с PR #21) обрезает всё до последнего `← <channel>: …` preview — видно только то, что агент делает после последнего сообщения вождя
- `max_lines` cap (default 14, диапазон 4..100 или 0=off) — топ обрезается с маркером `… +N lines`
- `hide_segments` фильтрует boot banner, footer hints, input box и т.д.
- SIGINT/SIGTERM → попытка `deleteMessage` (best-effort cleanup)

OOB-управление: `/mirror on|off|status` (PR #17) — тогглит TmuxMirror runtime через Telegram-команду, без рестарта плагина. Регистрируется через `setMyCommands`, локализован на русский (PR #18). Доступность команды управляется `tmux_mirror` policy-флагом (в multichat-режиме — per chat).

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

Live smoke против `@testmyfirsttmuxbot` (15-row matrix, operator-driven): см. [`docs/canary-smoke.md`](docs/canary-smoke.md). Покрывает text, HTML chunking, reply anti-spoof, photo/document/voice/album, OOB (`/status`, `/help`, `/stop`, `/reset`, `/mirror`), permission relay (allow/deny), webhook путь. Включает rollback procedure на Python canary.

End-to-end Progress Reporter (после установки хуков):

```bash
TELEGRAM_HOOK_CHAT_ID=<chat_id> \
TELEGRAM_WEBHOOK_URL=http://127.0.0.1:<port>/hooks/agent \
TELEGRAM_WEBHOOK_TOKEN=<token> \
bash scripts/smoke-test-progress.sh --bot-id <expected_bot_id>
```

Прогоняет синтетические hook-event-ы (PreToolUse/PostToolUse для Bash и Edit, плюс Stop) через `post-hook.ts` → webhook → ProgressReporter. Печатает табличный pass/fail summary. См. [`docs/progress-reporter-setup.md`](docs/progress-reporter-setup.md) — установка в 3 шага, troubleshooting, что работает / чего ещё нет.

## Tests

- `bun test` — полный suite
- `bun test tests/memory/` — memory hooks
- `bun test tests/hooks/` — hooks + claude-events + install-hooks + post-hook
- `bun test tests/status/` — StatusManager, TmuxMirror, ProgressReporter, TaskMirror, ActivityRenderer
- `bun test tests/router/` — MultichatRouter, TmuxSessionPool, inbox-bridge
- `bun test tests/chats/` — PolicyLoader, PersonaManager
- `bun run typecheck` — `tsc --noEmit` strict
- `bash scripts/smoke-test-progress.sh` — end-to-end webhook + ProgressReporter check (см. секцию Smoke test выше)

Точные цифры (X файлов / Y assertions) меняются от PR к PR — смотрите CI на конкретном коммите.

## Architecture (per-agent process model)

Один plugin process = один Telegram бот = одна set of allowed chats. В legacy single-DM режиме — один workspace, один CLAUDE.md. В multichat-режиме — один workspace, одна Thrall identity, **N tmux-сессий** `claude` (по одной на чат) с per-chat persona overlay. State-dir изолирован через `TELEGRAM_STATE_DIR`. Все file-locking — внутри-процессное (`Mutex` per path), потому что single-writer invariant.

## Attribution

Fork оригинального Anthropic Telegram plugin с full Jarvis Gateway parity. Custom код под Apache 2.0 (наследовано от upstream). См. LICENSE.
