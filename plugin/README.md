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

## Read receipts (реакция 👀)

**Зачем.** Реакция `👀` на входящем сообщении — это сигнал «агент это **прочитал**». Главная её ценность в том, что вождь видит, какие сообщения уже дошли до агента и обработаны, а какие ещё нет — особенно для голосовых, файлов и фото, где иначе непонятно, «увидел» ли их агент вообще. Поэтому момент постановки реакции критичен: `👀` должна означать «прочитано агентом», а не «бот принял апдейт».

**Как это работает (детерминистски).** Реакция ставится НЕ в момент приёма апдейта ботом. Если так делать, при занятой сессии сообщение стоит в очереди, а глаза уже горят — сигнал врёт. Вместо этого:

1. Сообщение доходит до сессии Claude (через MCP-нотификацию в личке вождя или через per-chat сессию в мультичате) и попадает в её ход как блок `<channel source="telegram" ... chat_id="X" message_id="Y">`.
2. По событию `Stop` (конец хода) хук `scripts/read-receipt-hook.ts` читает транскрипт сессии, находит telegram-блоки, которые ход реально прочитал, и POST'ит их в роут плагина `POST /hooks/react`.
3. Роут (loopback + bearer + chat-allowlist) ставит `👀` единственным ботом.

Так `👀` = «прочитано агентом» одинаково для текста, голоса, фото — и в личке, и в мультичате (каждая per-chat сессия гоняет тот же Stop-хук против своего транскрипта). Хук берёт сообщения именно текущего хода (идёт по транскрипту с конца, пропуская хвост из ответа+тулов — длинный ход с кучей tool-вызовов не «теряет» входящее). Пер-сессионный дедуп-лог (`<state>/read-receipts/<session_id>.log`) гарантирует ровно одну реакцию на сообщение и исключает гонку между параллельными сессиями.

**Почему через env-файл (важно для мультичата).** Per-chat сессии стартуют под `env -i` со строгим allowlist (`src/router/tmux-session-pool.ts`), который вырезает ВСЕ `TELEGRAM_*`. Поэтому хук НЕ читает webhook-конфиг из `process.env` — он берёт `TELEGRAM_WEBHOOK_PORT/HOST/TOKEN` и `TELEGRAM_STATE_DIR` (для дедуп-лога) из env-файла, путь до которого вписан прямо в команду хука (shell-присваивание перед `bun` переживает `env -i`). Токен в `settings.json` НЕ пишется — только путь до файла. В per-chat сессии дедуп дополнительно умеет падать на `MULTICHAT_STATE_DIR` (он в allowlist).

**Регистрация хука** (в дополнение к `install-hooks.sh` выше) — добавь в `Stop` своего `settings.json` команду с путём до env-файла плагина:

```json
{
  "hooks": {
    "Stop": [
      {
        "marker": "dashi-channel-read-receipt",
        "hooks": [
          {
            "type": "command",
            "command": "TELEGRAM_CHANNEL_ENV_FILE='/abs/path/to/channel.env' bun '/abs/path/to/plugin/scripts/read-receipt-hook.ts'"
          }
        ]
      }
    ]
  }
}
```

Хук всегда exit 0 и не пишет в stdout — read receipt никогда не блокирует и не загрязняет контекст модели. Если роут недоступен (или реакция не вписана в деплой) — хук тихо ничего не делает.

## DM fallback reply (Stop hook → `/hooks/fallback-reply`)

**Зачем (2026-06-03).** Личка вождя (главная/launcher-сессия) отвечает ему через MCP-тул `mcp__dashi-channel__reply` — именно этот вызов доходит до Telegram, транскрипт сессии — нет. Если ход завершился БЕЗ вызова `reply()`/`edit_message()`, вождь получает тишину, хотя финальный ответ хода есть. Этот fallback закрывает разрыв.

**Как работает.** По событию `Stop` хук `scripts/fallback-reply-hook.ts` читает транскрипт текущего хода (идёт с конца до последнего настоящего user-промпта — та же логика, что в `src/chats/hooks/stop-to-outbox.py`) и:

1. Если ход вызвал `mcp__dashi-channel__reply` ИЛИ `mcp__dashi-channel__edit_message` — ответ уже дошёл до вождя → молчит (без дубля).
2. Если у хода нет финального assistant-текста (чистый tool/thinking-ход) → молчит.
3. Если ход не отвечал на Telegram-сообщение (в его user-промпте нет `<channel source="telegram" ... chat_id="...">`) → молчит. Этот же блок даёт `chat_id` назначения — не доверяя никакому chat_id из env.
4. Иначе POST'ит `{chat_id, text}` в `POST /hooks/fallback-reply`. Роут (loopback + bearer + chat-allowlist) шлёт текст единственным ботом через `sendMessage`.

Пер-сессионный дедуп (`<state>/fallback-reply/<session_id>.json`, по `session_id`+`transcript_path`+`dedupe_token`) гарантирует не более одного fallback на ход. Хук всегда exit 0 и не пишет в stdout. Это **DM-only**: per-chat мультичат-сессии уже автодоставляют ответ через `stop-to-outbox.py` + outbox — этот хук туда НЕ регистрируется.

**Регистрация хука** (в дополнение к `install-hooks.sh` и read-receipt выше) — добавь в `Stop` своего DM `settings.json` ещё одну команду с путём до env-файла плагина:

```json
{
  "hooks": {
    "Stop": [
      {
        "marker": "dashi-channel-fallback-reply",
        "hooks": [
          {
            "type": "command",
            "command": "TELEGRAM_CHANNEL_ENV_FILE='/abs/path/to/channel.env' bun '/abs/path/to/plugin/scripts/fallback-reply-hook.ts'"
          }
        ]
      }
    ]
  }
}
```

Если роут недоступен (или `sendMessage` не вписан в деплой — отвечает 503) — хук тихо ничего не делает.

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
| `TELEGRAM_CHANNEL_ENV_FILE` | Путь до env-файла плагина — read-receipt хук (`Stop`) берёт из него `WEBHOOK_PORT/HOST/TOKEN`, чтобы ставить `👀` даже из per-chat сессии с очищенным env. См. секцию «Read receipts». |
| `TELEGRAM_READ_RECEIPT_URL` | Явный URL роута `/hooks/react` (альтернатива выводу из `HOST`+`PORT`). |
| `TELEGRAM_READ_RECEIPT_STATE` | Явный путь до дедуп-лога (single-writer). По умолчанию — пер-сессионный `<state>/read-receipts/<session_id>.log` в `TELEGRAM_STATE_DIR` (или `MULTICHAT_STATE_DIR`). |
| `TELEGRAM_FALLBACK_REPLY_URL` | Явный URL роута `/hooks/fallback-reply` (альтернатива выводу из `HOST`+`PORT`). См. секцию «DM fallback reply». |
| `TELEGRAM_FALLBACK_REPLY_STATE` | Явный путь до дедуп-стейта fallback-хука. По умолчанию — пер-сессионный `<state>/fallback-reply/<session_id>.json`. |
| `FALLBACK_REPLY_RETRY_ATTEMPTS` / `FALLBACK_REPLY_RETRY_DELAY_MS` | Ограниченный retry на пустую экстракцию (гонка extended-thinking: [thinking] и [text] в двух строках). Defaults 4 / 120ms, оба клампятся сверху. |
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
  chats: ["123456789", "-1001234567890"]   # chat_id строкой — отрицательные group id обязаны быть в кавычках
  users: ["123456789"]                       # кто вообще может писать
mention_allowlist: ["123456789"]             # кто может звать через @mention в группах
chats:
  "123456789":
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
