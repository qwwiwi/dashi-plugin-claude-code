# dashi-plugin-claude-code

> **Выберите язык:** [**English →**](README.md) · Русский (эта страница)

**Telegram → Claude Code channel plugin.** Превращает обычную, живую Claude Code сессию в Telegram-агента: бот слушает один или несколько чатов, отвечает в той же сессии, и оставляет всю работу внутри обычной Anthropic Max-подписки — без отдельного SDK-биллинга.

Это замена устаревшему `claude -p` gateway-паттерну (Python-демон, который спавнил новую headless-сессию на каждое сообщение). Cutover deadline — **2026-06-15** (Anthropic разделяет billing, подробности в разделе [13](#13-зачем-переезд--дедлайн-2026-06-15)).

```
[ Telegram ]
     │
     ▼  getUpdates (long polling)
[ plugin (Bun + TypeScript) ]──── push channel message ───▶ [ Claude Code session ]
     ▲                                                              │
     │  reply / status / reactions / media                          │  thinking + tools + final answer
     └──────────────────────────────────────────────────────────────┘
```

Один процесс плагина = один Telegram-бот = один агент. По умолчанию обслуживается **один DM-чат** (legacy single-session режим). При включённом `multichat.enabled` тот же бот раскладывает входящие по нескольким per-chat tmux-сессиям одной identity — см. раздел [3](#3-multichat--как-работает-и-зачем).

> **Статус:** под активной разработкой. Актуальный смерженный PR — **#34** (Stop-хук пишет ответ multichat в outbox). Авто-реконнект поллера — **#30**. Полный список: `gh pr list --state merged --limit 15`. CI: `bun test` + `bun run typecheck` обязаны проходить чисто перед merge.

---

## Содержание

1. [Как работает плагин и зачем он нужен](#1-как-работает-плагин-и-зачем-он-нужен)
2. [Личная сессия + channel tmux, и как добавить свой user_id](#2-личная-сессия--channel-tmux-и-как-добавить-свой-user_id)
3. [Multichat — как работает и зачем](#3-multichat--как-работает-и-зачем)
4. [Hooks плагина](#4-hooks-плагина)
5. [Интерактивные команды: permission-prompt (sudo) и AskUserQuestion](#5-интерактивные-команды-permission-prompt-sudo-и-askuserquestion)
6. [Terminal mirror — как работает и зачем](#6-terminal-mirror--как-работает-и-зачем)
7. [Передача медиа, аудио и транскрибация голосовых](#7-передача-медиа-аудио-и-транскрибация-голосовых)
8. [Авторестарт сессии — чтобы связь не прерывалась](#8-авторестарт-сессии--чтобы-связь-не-прерывалась)
9. [HTML-фильтрация из терминала в Telegram](#9-html-фильтрация-из-терминала-в-telegram)
10. [Безопасность — чтобы данные не утекали](#10-безопасность--чтобы-данные-не-утекали)
11. [Rate limits Telegram API](#11-rate-limits-telegram-api)
12. [Быстрый старт и документация](#12-быстрый-старт-и-документация)
13. [Зачем переезд — дедлайн 2026-06-15](#13-зачем-переезд--дедлайн-2026-06-15)

---

## 1. Как работает плагин и зачем он нужен

### Зачем

Старая архитектура (`jarvis-telegram-gateway`) — это Python-демон, который на каждое сообщение из Telegram запускал `claude -p` (headless Agent SDK). Каждый turn = новый процесс, новая загрузка контекста, и — после 15 июня 2026 — **отдельный SDK-кредит мимо Max-подписки** (см. раздел 13).

Этот плагин держит **одну живую interactive Claude Code сессию** и просто пушит в неё channel-сообщения. Сессия классифицируется как interactive → расход остаётся в обычной Max-квоте и не растёт от количества сообщений в Telegram. Бонусом — сессия помнит контекст между сообщениями, а не стартует с нуля каждый раз.

### Как

Это Claude Code **channel plugin** (Bun + TypeScript, grammY для Telegram, Zod для валидации). Поток сообщения:

1. `TelegramPoller` (`src/telegram/poller.ts`) тянет `getUpdates` (long polling) с per-instance lock на `state_dir`, чтобы два процесса не подняли одного бота.
2. Входящее проходит **allowlist-gate** (`src/telegram/gate.ts`) — кто не разрешён, отбивается ДО любой обработки.
3. Хендлеры (`src/telegram/handlers.ts`) собирают текст + медиа в channel-сообщение (`src/prompt/build.ts`) и пушат его в Claude Code сессию.
4. Claude думает, вызывает tools/MCP, формирует ответ.
5. Ответ уходит в Telegram через `safe-telegram-api` (`src/safety/safe-telegram-api.ts`): redact секретов → HTML-валидация → 4000-char chunking → token-bucket rate limiter.

Параллельно работают три «поверхности прогресса» (питаются от hooks, см. раздел 4):

| Подсистема | Что делает |
|---|---|
| `StatusManager` | transient bubble: typing → thinking → имя текущего tool |
| `ProgressReporter` | отдельное rolling-сообщение со строками активности (PreToolUse/PostToolUse/Stop) через `editMessageText` |
| `TaskMirror` | третье rolling-сообщение — milestones из `TodoWrite` / `TaskCreate` / `TaskUpdate` |

Запуск — два варианта: standalone Bun-процесс (`bun start`, быстрая проверка токена) или production через `claude --dangerously-load-development-channels server:dashi-channel` (Claude Code сам держит runtime плагина). См. раздел 12.

---

## 2. Личная сессия + channel tmux, и как добавить свой user_id

### Модель процесса

В legacy-режиме плагин живёт внутри одной Claude Code сессии, которую удобно запускать в именованной **tmux-сессии** (например `channel-thrall`) — так её можно держать постоянно резидентной, переподключаться по SSH без потери состояния и мирорить pane в Telegram (раздел 6). Один workspace, один `CLAUDE.md`, один бот, один DM-чат.

### Как добавить свой user_id (legacy single-DM)

Доступ — единственный gate, и он **обязателен**. Разрешённые пользователи задаются переменной `TELEGRAM_ALLOWED_USER_IDS`:

```bash
# в channel.env (CSV, без пробелов после запятых, только положительные целые)
TELEGRAM_ALLOWED_USER_IDS=164795011,123456789
```

Эквивалент в `config.json`:

```json
{ "allowed_user_ids": [164795011, 123456789] }
```

Парсер (`src/config.ts`) валидирует каждое значение как положительное целое и падает с понятной ошибкой на мусоре. Env перекрывает `config.json`. В DM Telegram ставит `chat.id == user.id`, поэтому gate проверяет и sender_id, и chat_id (defence-in-depth, `src/telegram/gate.ts`).

**Как узнать свой user_id:** напишите [@userinfobot](https://t.me/userinfobot) — он ответит числовым id. Для групп id начинается с `-100…`.

> Anti-spoof: reply-to сообщение валидируется как принадлежащее вашему боту (`is_bot` + username), поэтому подставными reply-метаданными gate не обойти (`src/telegram/addressing.ts`). См. раздел 10.

---

## 3. Multichat — как работает и зачем

### Зачем

Иногда нужно вести параллельно несколько чатов одной и той же identity: личный DM вождя + рабочая группа + sandbox. Один бот, одна личность, разные «комнаты» с разными правами и разной приватностью.

### Как

`MultichatRouter` (`src/router/multichat-router.ts`, default **OFF**) разводит входящие по нескольким **per-chat tmux-сессиям** `claude` через `TmuxSessionPool`. Связь плагин ↔ сессия — JSON-pipe через файловый inbox/outbox (`inbox-bridge.ts`). Гибридный роутинг (PR #33): личка вождя идёт в host-сессию (`channel-thrall`), группы — в свои per-chat сессии. Stop-хук per-chat сессии пишет финальный ответ в outbox (PR #34), откуда плагин его забирает и шлёт в Telegram.

Включение — флаг в `config.json` (или `TELEGRAM_MULTICHAT_ENABLED=1`):

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

Чаты описываются в `policy.yaml` (strict Zod-схема, `src/chats/policy-loader.ts` — опечатка в ключе валит загрузку громко, не молча):

```yaml
version: 1
allowlist:
  chats: ["164795011", "-1003784643974"]   # chat_id строкой; отрицательные group id ОБЯЗАНЫ быть в кавычках
  users: ["164795011"]                       # кто вообще может писать
mention_allowlist: ["164795011"]             # кто может звать бота через @mention в группах
chats:
  "164795011":
    mode: private                            # private | public — выбирает доступные поверхности
    streaming: progress                      # progress | off
    tmux_mirror: true                        # TmuxMirror только в этом чате
    edit_message_progress: true              # rolling editMessageText для ProgressReporter
    delivery: streamed                       # streamed | final_only
    persona_file: chats/personas/warchief.md # per-chat persona overlay (относительно workspace_dir)
    handoff_file: core/hot/handoff.md
    system_reminder: "Это личный DM вождя. Полный доступ."
    idle_ttl_ms: 1800000                     # 30 мин до выгрузки tmux-сессии (default)
    max_queue_depth: 1                        # сколько inbound можно поставить в очередь (default 1)
  "-1003784643974":
    mode: public
    streaming: off
    tmux_mirror: false
    edit_message_progress: false
    delivery: final_only
    persona_file: chats/personas/intensive-agent-os.md
    system_reminder: "Публичная группа. Никаких внутренних логов и mirror'ов."
```

`PersonaManager` накладывает per-chat persona-файл поверх единой identity — никаких отдельных `CLAUDE.md` per chat не нужно. Логи: `{state_dir}/chats/<chat_id>/{inbox,outbox,processing,dead-letter}/*.json`.

**Failure mode:** невалидная `policy.yaml` → плагин логирует ошибку и деградирует в multichat-OFF (legacy single-DM). Лучше работать с одним чатом, чем упасть целиком.

**Изоляция приватности:** `private` чаты получают все поверхности (TmuxMirror, progress-edit). `public` — только финальный ответ (`delivery: final_only`), никаких внутренних логов и mirror'ов. См. раздел 10.

---

## 4. Hooks плагина

Прогресс в Telegram (`ProgressReporter`, `TaskMirror`, `StatusManager`) питается от Claude Code hooks. Без установки хуков эти поверхности молчат — приходит только финальный ответ.

### Установка

```bash
bash plugin/scripts/install-hooks.sh \
  --settings ~/.claude/settings.json \
  --chat-id <ваш-Telegram-chat-id> \
  --webhook-url http://127.0.0.1:8089/hooks/agent \
  --agent-id dashi-channel
```

Идемпотентно: marker-based replacement (`"dashi-channel-hook"`) — повторный запуск не дублирует записи и чистит legacy markerless entries. Скрипт ставит **пять** событий: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` (для Pre/PostToolUse — matcher `.*`, на все tool-вызовы).

### Как работает

1. Claude Code на каждом событии запускает `scripts/post-hook.ts` (читает JSON хука из stdin).
2. `post-hook.ts` POST'ит payload на `TELEGRAM_WEBHOOK_URL` с заголовком `Authorization: Bearer $TELEGRAM_WEBHOOK_TOKEN`. **Stdout всегда пустой, exit всегда 0** — хук никогда не блокирует Claude и ничего не подмешивает в контекст модели.
3. Webhook-сервер плагина (`src/webhook/server.ts`, `POST /hooks/agent`) проверяет bearer-токен (timing-safe), 256 KB cap на тело, chatId allowlist, и Zod-валидацию.
4. `src/hooks/claude-events.ts` маппит payload в внутренние события и роутит на три независимых, best-effort поверхности: MemoryWriter, StatusManager/ProgressReporter, TaskMirror.

Маппинг событий:

| Hook event | Activity | TaskMirror |
|---|---|---|
| `PreToolUse` | `tool_start` | `task_create` (если TaskCreate) |
| `PostToolUse` | `tool_end` | `task_create` / `task_update` / `todo_write` |
| `UserPromptSubmit` | `reasoning` | — |
| `Stop` | `session_stop` | `todo_session_stop` |
| `SessionStart` | `session_start` | — |

> Bearer-токен **никогда не пишется в settings.json** — берётся из env `TELEGRAM_WEBHOOK_TOKEN` в момент запуска хука. Webhook bind — `TELEGRAM_WEBHOOK_HOST` / `TELEGRAM_WEBHOOK_PORT` (default loopback). Подробнее — [`docs/progress-reporter-setup.md`](plugin/docs/progress-reporter-setup.md).

---

## 5. Интерактивные команды: permission-prompt (sudo) и AskUserQuestion

Когда Claude в сессии упирается в интерактивный вопрос, плагин выносит его в Telegram и возвращает ответ обратно — оператор управляет агентом из чата, без SSH.

### Permission relay (sudo и прочие чувствительные tools)

`src/channel/permissions.ts` слушает `notifications/claude/channel/permission_request`. Поток:

1. Claude хочет выполнить чувствительный tool (например `sudo …`) → шлёт request с `tool_name`, `description`, `input_preview`.
2. Плагин кладёт request в `pending` (ключ — 5-буквенный short-id) и шлёт в Telegram сообщение с инлайн-клавиатурой `[See more] [✅ Allow] [❌ Deny]`.
3. Оператор жмёт кнопку (или отвечает текстом `yes abcde` / `no abcde`). Ответчик проверяется по `permission_relay.allowed_user_ids`.
4. Вердикт уходит обратно в сессию через `notifications/claude/channel/permission` → Claude разрешает или блокирует tool.

Каждое решение пишется в audit-JSONL (`statePaths.logs.permissions`). Short-id-алфавит исключает букву `l` (чтобы не путать с `1`/`i`).

### AskUserQuestion relay (PR #28)

Tool `AskUserQuestion` рендерится в Telegram как инлайн-клавиатура (`src/channel/ask-user-question.ts` + `src/telegram/ask-user-question.ts`):

- Хук-обёртка POST'ит вопрос на `POST /hooks/ask-user-question/request` и ждёт ответа.
- Один вопрос = одно сообщение с кнопками. Callback'и: `ask:choose` (single), `ask:toggle` + `ask:done` (multi-select), `ask:other` (свободный текст).
- Ответ приходит на `POST /hooks/ask-user-question/answer`, привязка по `chat_id` (защита от cross-chat инъекции) и по allowlist ответчика.
- Timeout (default 5 мин) → relay отдаёт `{ status: 'timeout' }`, хук падает обратно на нативный CC UI.

Оба эндпоинта `/hooks/ask-user-question/*` принимают **только loopback** (127.0.0.1 / localhost / ::1) + bearer-токен — чтобы вопрос и токен не утекли на внешний хост.

### OOB-команды (slash-команды в Telegram)

Это «out-of-band» команды управления плагином и сессией — они перехватываются плагином и не доходят до Claude как обычный промпт (кроме тех, что специально транслируют сигнал в сессию). Регистрируются через `setMyCommands`, поэтому видны в меню «/» Telegram и локализованы на русский (PR #18):

| Команда | Что делает | Как пользоваться |
|---|---|---|
| `/help` | Справка — список всех команд | `/help` |
| `/status` | Снимок состояния: bot_id, state_dir, poller offset, статус webhook, состояние mirror (message_id, last_poll, ошибки) | `/status` |
| `/stop` | Просит Claude остановить текущую задачу. Отменяет активный status-bubble и шлёт сигнал `/stop` в сессию | `/stop` |
| `/reset force` | Сбрасывает состояние сессии — следующее сообщение начнёт с чистого листа | `/reset` без флага только переспросит; подтверждение — `/reset force` |
| `/new force` | Начинает новую сессию | Аналогично: `/new` переспросит, `/new force` выполнит |
| `/mirror on\|off\|status` | Включает/выключает terminal mirror без рестарта плагина (раздел 6) | `/mirror on` · `/mirror off` · `/mirror status` |

Поведение, которое важно знать:

- **`/stop` — best-effort.** Плагин передаёт сигнал остановки в сессию, но не «убивает» процесс — Claude останавливается на ближайшей безопасной точке, а не мгновенно.
- **`/reset` и `/new` требуют `force`.** Без флага команда возвращает подсказку («для подтверждения добавь `force`») — защита от случайного сброса контекста.
- **Суффикс `@botname` снимается** — `/status@trallvibecoderbot` в группе работает так же, как `/status`.
- **Доступ.** Команды слушаются только из разрешённых чатов/от разрешённых user_id (тот же allowlist, раздел 10) — в публичной группе посторонний не сбросит вашу сессию.
- В multichat доступность `/mirror` управляется флагом `tmux_mirror` в `policy.yaml` per chat.

> Тестирование: автоматический парсинг и роутинг команд покрыт `tests/commands/oob.test.ts` (23 assertions). Живой прогон против реального бота — операторская smoke-матрица [`plugin/docs/canary-smoke.md`](plugin/docs/canary-smoke.md) (строки `/status`, `/help`, `/stop`, `/reset`, `/new`, `/mirror`).

---

## 6. Terminal mirror — как работает и зачем

### Зачем

Оператор хочет видеть «сырой» вывод терминала (bash, логи) того, что агент делает прямо сейчас — без SSH-доступа к машине. `TmuxMirror` (PR #15) мирорит pane tmux-сессии в **одно rolling Telegram-сообщение** через `editMessageText`.

### Как

Default-**OFF**, opt-in через config (в multichat — через флаг `tmux_mirror` в policy, per chat):

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

- Polls `tmux capture-pane -p -t <pane_target> -S -<line_count>` каждые `poll_interval_ms`.
- ANSI/CSI/OSC/DCS sequences стрипаются, control-chars (кроме `\n`, `\t`) удаляются.
- Текст проходит `redactSecrets` (раздел 10) → HTML-escape → оборачивается в `<pre>`.
- Hash-based dedup: одинаковый poll → нет API-вызова.
- `mode: latest_inbound_only` (default с PR #21) обрезает всё до последнего `← <channel>:` preview — видно только что агент делает после последнего сообщения вождя.
- `max_lines` cap (default 14, диапазон 4..100, 0=off) — верх обрезается маркером `… +N lines`.
- Edit «message to edit not found» → re-send; прочие 4xx **не** триггерят resend (защита от storm).
- SIGINT/SIGTERM → best-effort `deleteMessage`.

Runtime-управление: `/mirror on|off|status` без рестарта плагина.

> Mirror — **только для приватного DM** (`mode: private`). В публичных группах он выключен, чтобы внутренняя «кухня» не светилась.

---

## 7. Передача медиа, аудио и транскрибация голосовых

### Фото

`handleInboundPhoto` после allowlist-gate **авто-скачивает** крупнейшее разрешение в `{state_dir}/inbox/` (права `0600`, имя из `file_unique_id`, hard-cap 20 MB) и инжектит в промпт как:

```
<media kind="photo" local_path="/abs/inbox/123-abc.jpg" width="…" height="…" />
```

Агент читает файл обычным `Read` по `local_path`. Альбомы (несколько фото за раз) буферизуются по `media_group_id` с flush по тишине (`album-buffer.ts`); каждый фрагмент атомарно пишется на диск до in-memory обновления, есть recovery при рестарте и dead-letter для битых.

### Документы

Документ **не** скачивается сразу — приходит метаданными:

```
<media kind="document" file_id="…" name="foo.pdf" mime="application/pdf" size="12345" />
```

Когда агенту нужны байты, он вызывает tool `download_attachment(file_id, chat_id)` → плагин качает в inbox и возвращает абсолютный путь (с проверкой chat_id по allowlist, защита от cross-chat утечки).

### Голосовые → транскрибация

`maybeTranscribeVoice` (`src/telegram/media.ts`) транскрибирует через **Groq Whisper** (OpenAI-совместимый endpoint):

- **Что использовать:** переменная `GROQ_API_KEY`. Модель — `config.voice.model` (рабочий выбор: `whisper-large-v3-turbo`), язык — `config.voice.language` (например `ru`).
- Endpoint: `POST https://api.groq.com/openai/v1/audio/transcriptions`, `response_format=text`.
- Hard-cap 25 MB (лимит Groq), проверяется по Telegram-метаданным **до** скачивания.
- Telegram отдаёт голос как `.oga` (Ogg/Opus) — Groq отвергает это расширение, поэтому файл переименовывается в `.ogg` перед загрузкой.
- Ключ редактится из любых сообщений об ошибках. Исключения не пробрасываются — дескриптор всегда несёт статус.

Результат в промпте:

```
<media kind="voice" mime="audio/ogg" duration_sec="5" transcript="привет мой вождь" transcription_status="ok" />
```

Без `GROQ_API_KEY` → `transcription_status="missing_key"` (без ошибки — Claude сам решает, попросить ли включить).

---

## 8. Авторестарт сессии — чтобы связь не прерывалась

Связь держится на трёх уровнях, от самого мелкого сбоя к падению процесса:

**1. In-process auto-reconnect поллера (PR #30).** При сетевых сбоях / 5xx / разрывах `TelegramPoller` сам переподключается с экспоненциальным backoff `1с → 2с → 4с → … → cap 60с` + jitter, счётчик сбрасывается на первом успешном `getUpdates`. На `429` honor'ится `retry_after`; на `409 Conflict` (другой consumer держит токен) — backoff до 8 попыток; на `401` — до 3. Процесс при этом не умирает.

**2. Single-instance lock.** Lock-файл `{state_dir}/bot.pid` создаётся атомарно (`O_EXCL`). Второй процесс читает PID, проверяет `process.kill(pid, 0)` и отказывается стартовать, если владелец жив — нет «409-шторма» от двух поллеров на одном боте. Мёртвый PID чистится и lock переберётся (до 3 попыток).

**3. Process supervisor (рестарт всего процесса).**

- **Linux / systemd** (`examples/systemd-unit.service.example`): `Restart=on-failure`, `RestartSec=15s` — рестарт только на ненулевом exit (не зацикливается на welcome-промтах).
- **macOS / launchd** (`examples/launchd-plist.example.plist`): `KeepAlive.SuccessfulExit=false`, `ThrottleInterval=15`. Wrapper-скрипт `trap cleanup TERM INT` отдаёт exit 0 при штатном стопе оператором и exit 1 при падении — launchd респавнит только падения.

**4. Idle-respawn tmux-сессий (multichat).** `TmuxSessionPool` watchdog (раз в 60с) гасит сессии, висящие дольше `idle_ttl_ms` (default 30 мин), и поднимает заново на следующем сообщении. `sessions.json` хранит маппинг chat→tmux и переподключается к живым сессиям при рестарте плагина, не оставляя сирот.

---

## 9. HTML-фильтрация из терминала в Telegram

Чтобы в Telegram приходил красивый форматированный текст, а не сырой markdown или поломанная разметка, исходящий путь (`src/format/html.ts` + `src/safety/html-validator.ts` + `src/format/chunk.ts`) делает:

**1. Markdown → Telegram HTML.** Telegram принимает узкий набор тегов: `b, strong, i, em, u, ins, s, strike, del, code, pre, a, br, blockquote, tg-spoiler`. Конвертер аккуратно «прячет» code-блоки, таблицы, инлайн-код, ссылки `[text](url)` и уже валидный HTML в плейсхолдеры **до** экранирования, экранирует остальной текст (`&`, `<`, `>`), применяет markdown-трансформы (заголовки → `<b>`, `**bold**`, `~~strike~~`, `*italic*` с word-boundary проверками чтобы не ломать `foo_bar`) и восстанавливает плейсхолдеры.

**2. Pre-send валидация.** `validateTelegramHtml()` токенизирует результат, ловит несбалансированные скобки, неизвестные/неразрешённые теги, неправильные атрибуты (`<a href>` только `http/https/tg/mailto`). При любой ошибке — **downgrade в plain text** (escape сырого ввода без `parse_mode`), сообщение всё равно уходит. В лог пишется только причина, не тело.

**3. ANSI-стрип (для mirror).** Pane перед отправкой чистится от ANSI/CSI/OSC/DCS sequences и control-chars.

**4. Chunking на 4000 символов.** `splitForTelegram` режет по границам: абзац (`\n\n`) > строка (`\n`) > жёсткий cut. Если split попадает внутрь `<pre>`/`<code>` — тег закрывается на текущем чанке и переоткрывается на следующем (баланс тегов отслеживается), `language-` класс сохраняется на первом чанке.

Дефолт `reply` — `format='html'` (PR #22): markdown авто-конвертится, авто-чанкится, а голые `<`/`>`/`&` в обычном тексте безопасно экранируются.

---

## 10. Безопасность — чтобы данные не утекали

Защита эшелонирована — несколько независимых барьеров:

**Allowlist-gate (первый барьер).** Любое входящее проверяется ДО обработки (`src/telegram/gate.ts`): в DM — sender_id ∈ `allowed_user_ids` (+ defensive chat_id); в группах (multichat) — chat ∈ `policy.allowlist.chats` И sender ∈ `policy.allowlist.users`. Не прошёл — drop без обработки.

**Anti-spoof addressing** (`src/telegram/addressing.ts`). В группах бот реагирует только на явный @mention или reply-to на собственное сообщение (валидируется `is_bot` + username). `mention_allowlist` дополнительно ограничивает, кто вообще может звать бота. Пустой allowlist = никто. Подставные reply-метаданные не обходят проверку.

**Redact секретов** (`src/safety/redact.ts`). Перед отправкой и в mirror маскируются: Telegram bot-token, ключи Groq/OpenAI/GitHub PAT/Resend/Slack, Firebase private_key/client_email, `Bearer …`, query-string токены (`?token=`, `&api_key=`), IPv4 (средние октеты), secret-пути (`secrets/***`), Supabase host, и любой длинный токен (≥24 символов). Маскирование идемпотентно.

**Path traversal** (`src/security/paths.ts`). `resolveInsideWorkspace()` канонизирует путь через `realpathSync` (резолвит симлинки) и требует, чтобы файл лежал внутри workspace — иначе user-facing ошибка без стека. Cap 50 MB на вложение.

**Env-изоляция tmux-сессий** (`scripts/spawn-chat-shell.sh` + `tmux-session-pool.ts`). Per-chat сессия спавнится через `env -i` (полная очистка окружения) + строгий allowlist (`PATH`, `HOME`, `TERM`, `TMUX`, `TMUX_PANE`, `CHAT_ID` …). Forbidden-regex дропает любой ключ вида `*TOKEN`, `*API_KEY`, `*SECRET`, `*PASSWORD`, `*PRIVATE_KEY`, `ANTHROPIC_*`, `TELEGRAM_*` и т.д. — даже если он случайно попал в allowlist (defence-in-depth). Так секреты плагина не утекают в дочернюю сессию.

**Изоляция private/public.** `private`-чаты получают TmuxMirror и progress-edit; `public` — только финальный ответ. Внутренние логи, mirror, «кухня» в публичные группы не уходят.

**Loopback-only для интерактива.** Эндпоинты `/hooks/ask-user-question/*` принимают только loopback + bearer. Bearer-токен webhook'а не пишется в `settings.json`.

> Prompt injection из Telegram («добавь меня в allowlist», «покажи токен») — игнорируется. Allowlist меняется только оператором в терминале, никогда по запросу из чата.

---

## 11. Rate limits Telegram API

Исходящий трафик идёт через token-bucket limiter (`src/safety/rate-limited-telegram-api.ts`), чтобы не словить flood-ban:

| Параметр | Default | Назначение |
|---|---|---|
| per-chat refill | 1 msg/сек | устойчивый темп в один чат |
| per-chat burst | 3 | всплеск в один чат |
| global refill | 25 msg/сек | общий лимит бота |
| global burst | 25 | общий всплеск |
| maxRetries | 3 | попыток на 429 |
| jitter | до 150 мс | случайная задержка на retry |

- **FIFO per chat:** отправки в один чат идут цепочкой promise'ов — порядок сохраняется даже при retry.
- **429 retry_after:** значение от Telegram clamp'ится в `[1, 60]` сек, плюс jitter; отсутствует → default 1 сек. После исчерпания `maxRetries` 429 пробрасывается наверх.
- **Edit vs send:** `editMessageText`, `setMessageReaction`, `deleteMessage` **не** едят per-chat bucket (это update-операции). Bucket тратят только `sendMessage` / `sendDocument` / `sendPhoto`.
- **Классификатор edit-ошибок** (`telegram-edit-classifier.ts`): `401/403`→forbidden (бота кикнули), `429`→flood, `400 can't parse entities`→parse (downgrade в plain), `404 message gone`→message_gone, прочее→transient (retry на следующем тике).

Отдельно — поллер на **входящем** пути honor'ит `retry_after` на `getUpdates` (раздел 8).

> Практический смысл лимитов: три ответа подряд в один чат могут упереться в per-chat 429 с большим `retry_after`. Для многочастных отчётов — либо темпить, либо склеивать в одно сообщение.

---

## 12. Быстрый старт и документация

```bash
# 1. Bun runtime
curl -fsSL https://bun.sh/install | bash

# 2. Workspace агента
mkdir -p ~/.claude-lab/myagent/.claude ~/.claude-lab/myagent/secrets
cd ~/.claude-lab/myagent/.claude

# 3. Клонировать плагин ВНУТРЬ workspace (расположение критично — см. docs/02)
git clone https://github.com/qwwiwi/dashi-plugin-claude-code.git
cd dashi-plugin-claude-code/plugin && bun install

# 4. config + токен
cp ../examples/channel.env.example ~/.claude-lab/myagent/secrets/channel.env
chmod 600 ~/.claude-lab/myagent/secrets/channel.env
$EDITOR ~/.claude-lab/myagent/secrets/channel.env   # TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, GROQ_API_KEY

# 5. Запуск (production-вариант — Claude Code держит runtime)
set -a; . ~/.claude-lab/myagent/secrets/channel.env; set +a
claude --dangerously-load-development-channels server:dashi-channel

# 6. ОБЯЗАТЕЛЬНО — установить hooks (иначе нет прогресса в Telegram)
bash scripts/install-hooks.sh --settings ~/.claude/settings.json \
  --chat-id <ваш-chat-id> --webhook-url http://127.0.0.1:8089/hooks/agent --agent-id dashi-channel
```

При первом запуске Claude Code задаст 2 интерактивных вопроса (allow external imports + dev channels) — **разово**, ответьте `1` на оба.

**Stack:** Bun 1.3+ / TypeScript strict, Claude Code v2.1.80+ ([Channels reference](https://code.claude.com/docs/en/channels-reference)), grammY 1.21+, Zod 3.23+, supervisor systemd/launchd.

| Док | Что внутри |
|---|---|
| [docs/01-what-is-this.md](docs/01-what-is-this.md) | Plugin vs Gateway — архитектура и преимущества |
| [docs/02-where-to-place-plugin.md](docs/02-where-to-place-plugin.md) | **Главное.** Где разместить каталог, чтобы сессия грузилась правильно (90% проблем) |
| [docs/03-installation.md](docs/03-installation.md) | systemd / launchd, EnvironmentFile, фикс welcome-промтов, smoke test |
| [docs/03-installation-linux.md](docs/03-installation-linux.md) · [macos](docs/03-installation-macos.md) | OS-specific unit/plist |
| [docs/04-migration-from-gateway.md](docs/04-migration-from-gateway.md) | Пошаговая миграция с `jarvis-telegram-gateway`, откат на каждом шаге |
| [docs/05-troubleshooting.md](docs/05-troubleshooting.md) | Типовые ошибки: симптом → корень → фикс |
| [docs/06-how-claude-loads-session.md](docs/06-how-claude-loads-session.md) | Как Claude Code находит `CLAUDE.md`, CWD upward search, `@-include` |
| [plugin/docs/progress-reporter-setup.md](plugin/docs/progress-reporter-setup.md) | Установка hooks в 3 шага + troubleshooting |
| [plugin/docs/canary-smoke.md](plugin/docs/canary-smoke.md) | Live smoke-матрица против тест-бота |

---

## 13. Зачем переезд — дедлайн 2026-06-15

С 15 июня 2026 Anthropic разделяет billing. `claude -p` (Agent SDK) уходит в **отдельный SDK-кредит, зависящий от плана**:

- Pro — $20/мес · Max 5× — $100/мес · Max 20× — $200/мес

Источник: [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

Старая gateway-архитектура (Python-демон спавнит `claude -p` на каждый Telegram-turn) после cutover жжёт SDK-кредит на каждое сообщение. Этот плагин держит **одну живую interactive сессию** (или пул per-chat tmux-сессий при multichat) — расход остаётся в обычной Max-квоте и не растёт от числа сообщений. Полный план — [DEPRECATION-PATH.md](DEPRECATION-PATH.md).

**Trade-offs:** один процесс = один бот (нужно 5 ботов → 5 процессов); рестарт сессии = потеря текущего контекста (но `core/hot/recent.md` хранит хвост); multichat = больше памяти и обязательная аккуратная `policy.yaml`; нужен Bun + Claude Code v2.1.80+ (не Python-only хост).

---

## Что прочитать обязательно (и не забыть)

Если времени мало — три дока решают 90% проблем, в этом порядке:

1. **[docs/02-where-to-place-plugin.md](docs/02-where-to-place-plugin.md) — читать ПЕРВЫМ.** Где физически разместить каталог плагина, чтобы Claude Code загрузил правильную сессию и `CLAUDE.md`. 90% сбоев первого запуска — отсюда. Не пропускать.
2. **[docs/03-installation.md](docs/03-installation.md)** (+ [linux](docs/03-installation-linux.md) / [macos](docs/03-installation-macos.md)) — production-setup: systemd/launchd, EnvironmentFile, как погасить welcome-промты, чтобы сервис не зацикливался. Без этого агент не переживёт reboot.
3. **[plugin/docs/progress-reporter-setup.md](plugin/docs/progress-reporter-setup.md)** — установка hooks в 3 шага. Без хуков нет прогресса в Telegram (разделы 4–5). Самая частая жалоба «бот молчит во время работы» лечится здесь.

Дальше — по ситуации:

- **Мигрируете со старого gateway?** → [docs/04-migration-from-gateway.md](docs/04-migration-from-gateway.md) (пошагово, с откатом на каждом шаге) + [DEPRECATION-PATH.md](DEPRECATION-PATH.md) (сроки и why).
- **Сломалось?** → [docs/05-troubleshooting.md](docs/05-troubleshooting.md) — таблица «симптом → корень → фикс».
- **Не понимаете, почему агент не видит свой `CLAUDE.md`?** → [docs/06-how-claude-loads-session.md](docs/06-how-claude-loads-session.md) — CWD upward search, `@-include`, global vs project.
- **Перед первым live-прогоном** → [plugin/docs/canary-smoke.md](plugin/docs/canary-smoke.md) — smoke-матрица против тест-бота (text, media, OOB, permission relay, webhook).
- **Параметры конфигурации** — единственный источник правды: `plugin/src/config.ts` (`RuntimeEnvSchema`) и `examples/config.example.json` + `examples/channel.env.example`.

Внутренние dev-доки (история PR, review-спеки) — в [docs/dev/](docs/dev/), читать необязательно.

---

## Лицензия и автор

Apache 2.0 (см. [LICENSE](LICENSE)). Fork идеи Anthropic Telegram plugin с полной Jarvis Gateway parity.

[@qwwiwi](https://github.com/qwwiwi) (Dashi Eshiev) · EdgeLab AI. Issues / PRs приветствуются; для миграции — issue с тегом `migration` и описанием setup.
