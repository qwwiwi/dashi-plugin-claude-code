# dashi-plugin-claude-code

> **Выберите язык:** [**English →**](README.md) · Русский (эта страница)

**Telegram → Claude Code channel plugin.** Превращает обычную, живую Claude Code сессию в Telegram-агента: бот слушает один или несколько чатов, отвечает в той же сессии, и оставляет всю работу внутри обычной Anthropic Max-подписки — без отдельного SDK-биллинга.

Это замена устаревшему `claude -p` gateway-паттерну (Python-демон, который спавнил новую headless-сессию на каждое сообщение). Cutover deadline — **2026-06-15** (Anthropic разделяет billing, подробности в разделе [13](#13-зачем-переезд--дедлайн-2026-06-15)).

![Архитектура — Telegram ↔ плагин ↔ сессия Claude Code](docs/assets/architecture-hero.svg)

Один процесс плагина = один Telegram-бот = один агент. По умолчанию обслуживается **один DM-чат** (legacy single-session режим). При включённом `multichat.enabled` тот же бот раскладывает входящие по нескольким per-chat tmux-сессиям одной identity — см. раздел [3](#3-multichat--как-работает-и-зачем).

> **Статус:** под активной разработкой. Актуальный смерженный PR — **#34** (Stop-хук пишет ответ multichat в outbox). Авто-реконнект поллера — **#30**. Полный список: `gh pr list --state merged --limit 15`. CI: `bun test` + `bun run typecheck` обязаны проходить чисто перед merge.

---

## Содержание

1. [Как работает плагин и зачем он нужен](#1-как-работает-плагин-и-зачем-он-нужен)
2. [Личная сессия + channel tmux, и как добавить свой user_id](#2-личная-сессия--channel-tmux-и-как-добавить-свой-user_id)
3. [Multichat — как работает и зачем](#3-multichat--как-работает-и-зачем)
4. [Hooks плагина](#4-hooks-плагина)
5. [Интерактивные команды и управление каналом: permission-prompt, AskUserQuestion, OOB slash-команды](#5-интерактивные-команды-и-управление-каналом-permission-prompt-askuserquestion-oob-slash-команды)
6. [Terminal mirror — как работает и зачем](#6-terminal-mirror--как-работает-и-зачем)
7. [Передача медиа, аудио и транскрибация голосовых](#7-передача-медиа-аудио-и-транскрибация-голосовых)
8. [Авторестарт сессии — чтобы связь не прерывалась](#8-авторестарт-сессии--чтобы-связь-не-прерывалась)
9. [HTML-фильтрация из терминала в Telegram](#9-html-фильтрация-из-терминала-в-telegram)
10. [Безопасность — чтобы данные не утекали](#10-безопасность--чтобы-данные-не-утекали)
11. [Rate limits Telegram API](#11-rate-limits-telegram-api)
12. [Быстрый старт и документация](#12-быстрый-старт-и-документация)
13. [Зачем переезд — дедлайн 2026-06-15](#13-зачем-переезд--дедлайн-2026-06-15)
14. [Мультиагент — флот агентов под одной подпиской](#14-мультиагент--флот-агентов-под-одной-подпиской)

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
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

Эквивалент в `config.json`:

```json
{ "allowed_user_ids": [123456789, 987654321] }
```

Парсер (`src/config.ts`) валидирует каждое значение как положительное целое и падает с понятной ошибкой на мусоре. Env перекрывает `config.json`. В DM Telegram ставит `chat.id == user.id`, поэтому gate проверяет и sender_id, и chat_id (defence-in-depth, `src/telegram/gate.ts`).

**Как узнать свой user_id:** напишите [@userinfobot](https://t.me/userinfobot) — он ответит числовым id. Для групп id начинается с `-100…`.

> Anti-spoof: reply-to сообщение валидируется как принадлежащее вашему боту (`is_bot` + username), поэтому подставными reply-метаданными gate не обойти (`src/telegram/addressing.ts`). См. раздел 10.

---

## 3. Multichat — как работает и зачем

![Multichat — один бот раскладывает входящие по нескольким per-chat tmux-сессиям](docs/assets/multichat.svg)

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
  chats: ["123456789", "-1001234567890"]   # chat_id строкой; отрицательные group id ОБЯЗАНЫ быть в кавычках
  users: ["123456789"]                       # кто вообще может писать
mention_allowlist: ["123456789"]             # кто может звать бота через @mention в группах
chats:
  "123456789":
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
  "-1001234567890":
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

![Hooks — событие Claude Code проходит через post-hook и webhook-сервер к поверхностям прогресса](docs/assets/hooks.svg)

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

## 5. Интерактивные команды и управление каналом: permission-prompt, AskUserQuestion, OOB slash-команды

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

### Команды управления каналом (OOB slash-команды)

Это «out-of-band» команды управления плагином и живой сессией из Telegram. Плагин перехватывает их *до* того, как они дойдут до Claude обычным промптом — поэтому `/status` не будит модель, а keystroke-команды (`/key`, `/keys`, `/cc`, `/stop`, `/reset`, `/new`) напрямую управляют tmux-pane сессии агента. Регистрируются через `setMyCommands`, поэтому видны в меню «/» Telegram (описания локализованы на русский, PR #18).

Полный авторитетный список — в коде: `plugin/src/commands/oob.ts` (`helpText()` + `BOT_COMMANDS` + union `OobCommandName`) и `plugin/src/commands/keys.ts` (whitelist токенов `/key` и passthrough `/cc`).

| Команда | Что делает | Использование / когда нужна |
|---|---|---|
| `/help` | Печатает список команд. Отвечает в Telegram, Claude **не** будит. | `/help` |
| `/status` | Снимок плагина и сессии: `bot_id`, `state_dir`, разрешённый пользователь, poller offset/ошибка, состояние status-manager, webhook on/off + порт. Только ответ, модель не будит. | `/status` |
| `/stop` | Прерывает текущую генерацию/tool Claude. Если pane резолвится — жмёт **Escape** в pane (реальное прерывание) и гасит bubble «печатает…»; иначе откатывается на сигнал `/stop`, который Claude увидит при следующем чтении канала. | `/stop` — когда агент ушёл не туда. |
| `/reset force` | Сбрасывает сессию. Если pane резолвится — печатает в сессию встроенный `/clear` Claude Code (чистый контекст); иначе транслирует сигнал сброса. Голый `/reset` лишь переспросит подтверждение. | `/reset force` — стереть контекст и начать заново. |
| `/new force` | «Новая сессия». Отдельного примитива new-session у Claude Code нет, поэтому это тот же `/clear`, что и `/reset force`. Голый `/new` лишь переспросит. | `/new force` |
| `/mirror on\|off\|status` | Тоггл зеркала терминала (раздел 6) в рантайме — без рестарта плагина. `status` (или голый `/mirror`) печатает enabled/off, message_id, возраст last-poll, last error. | `/mirror on` · `/mirror off` · `/mirror status` |
| `/key <токены>` | Жмёт одну или несколько **whitelisted** клавиш в tmux-pane агента — так вы **отвечаете на нативный диалог Claude Code** из Telegram. До 5 токенов за команду. | `/key 1` · `/key 3` · `/key y` · `/key esc` · `/key 2 enter` |
| `/keys` | Открывает панель инлайн-кнопок «в одно касание» — те же клавиши, что у `/key`, но тапом. Один тап = одна клавиша в сессию. | `/keys`, затем тап по кнопке. Простой способ ответить на диалог. |
| `/cc <команда>` | Прокидывает команду во **встроенные slash-команды Claude Code**, печатая её в сессию (`/compact`, `/model`, `/context`, кастомные скиллы, …). Узкий charset — никаких shell-метасимволов, shell-команду не собрать. | `/cc compact` · `/cc model opus` · `/cc context` |

#### Ответ на нативные диалоги подтверждения (главный сценарий)

Когда Claude Code упирается в нативный терминальный диалог — например permission-правило:

```
Permission rule Bash(rm:*) requires confirmation
  1. Yes
  2. Yes, and don't ask again
  3. No
```

— он блокируется в pane. **Зеркало терминала** (раздел 6) показывает этот диалог в Telegram, и вы отвечаете на него без SSH одним из двух способов:

- **`/keys`** → тап по кнопке. Панель — одна клавиша на тап, раскладка:
  - Ряд 1: `[1][2][3][4][5]` — выбор пунктов диалога
  - Ряд 2: `[6][7][8][9][0]`
  - Ряд 3: `[✓ y][✗ n][⏎ enter][⎋ esc]`
  - Ряд 4: `[↑ up][↓ down][← left][→ right]`
  - Ряд 5: `[⇥ tab][␣ space]`

  По этой же панели можно тапать многократно в многошаговом диалоге — она не «расходуется».
- **`/key <токены>`** → набрать клавишу: `/key 1` выбрать пункт 1, `/key 3` выбрать «No», `/key esc` отменить.

`/keys` — это ровно `/key` в виде тапаемых кнопок; обе инжектят один и тот же закрытый whitelist в pane.

**Принимаемые токены `/key` (полный whitelist):**

| Группа | Токены |
|---|---|
| Цифры | `0` `1` `2` `3` `4` `5` `6` `7` `8` `9` |
| Да / Нет | `y` `n` |
| Подтвердить / отмена | `enter` · `esc` (алиас `escape`) |
| Редактирование | `tab` · `space` |
| Стрелки | `up` · `down` · `left` · `right` |

Всё вне этого набора отвергается; лимит — **5 токенов** на `/key` (это ответ на диалог, а не язык макросов). Поскольку набор — закрытый whitelist без свободного текста, даже pane, выпавший из Claude в голый shell, нельзя заставить выполнить команду.

#### Поведение, которое важно знать

- **`/stop` — best-effort.** С pane шлёт настоящий Escape; без pane лишь транслирует сигнал, который Claude заметит при следующем чтении канала — процесс не убивает.
- **`/reset` и `/new` требуют `force`.** Голые `/reset` / `/new` возвращают подсказку («для подтверждения добавь `force`») — защита от случайного стирания контекста.
- **Суффикс `@botname` снимается** — `/status@yourbot` в группе работает так же, как `/status`.
- В multichat доступность `/mirror` управляется per-chat флагом `tmux_mirror` в `policy.yaml`.
- `/key`, `/keys`, `/cc` и pane-ветки `/stop`/`/reset`/`/new` требуют резолвимого tmux-pane. Без него (нет tmux-конфига / нет `$TMUX`) плагин отвечает, что pane недоступен.

> **Безопасность (fail-closed).** Каждая команда управления — и каждый тап кнопки `/keys` — слушается **только** в **личке (private chat)**, от Telegram **user id из allow-list** (`allowed_user_ids`), в чате из **chat allow-list** (`allowed_chat_ids`). Должны выполняться все три условия (defence-in-depth — см. `src/telegram/handlers.ts` и `kkey:`-авторизацию в `src/telegram/keys-panel-ui.ts`). В группах они **никогда** не работают и **никогда** не выполняются от неразрешённого пользователя — посторонний не сбросит вашу сессию и не нажмёт клавиши в вашем терминале. Неразрешённый тап получает лишь тост «не авторизовано», ни одна клавиша не отправляется.

> Тестирование: парсинг/роутинг команд покрыт `tests/commands/oob.test.ts`, панель кнопок — `tests/telegram/keys-panel.test.ts`. Живой прогон против реального бота — операторская smoke-матрица [`plugin/docs/canary-smoke.md`](plugin/docs/canary-smoke.md).

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

![Безопасность — эшелонированная защита от входящего сообщения до безопасной обработки](docs/assets/security.svg)

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

# 7. Переезжаете со старого gateway? Прогоните доктора ДО и ПОСЛЕ переключения
#    (на systemd-хосте — без флагов: юнит/env/сессию он найдёт сам)
bun skills/doctor-dashi-plugin/scripts/doctor.ts --plugin-dir "$PWD"
```

При первом запуске Claude Code задаст 2 интерактивных вопроса (allow external imports + dev channels) — **разово**, ответьте `1` на оба.

> **Доктор — обязательный инструмент переезда и дебага.** Read-only скилл [`doctor-dashi-plugin`](skills/doctor-dashi-plugin/SKILL.md) диагностирует весь мост: toolchain, размещение workspace (дрейф идентичности), dev-vs-runtime копию (учитывает несколько агентов на хосте), hooks с учётом профиля (mirror-конфигурация без feeder-хуков — корректна, доктор её не ругает), permission gate (ask-relay, policy-файл, `confirm_overrides` не может снимать `sudo`/`rm -rf`), мультичат (terminal mirror только в DM, покрытие per-chat policy), гигиену безопасности (webhook слушает ТОЛЬКО loopback — `0.0.0.0` это FAIL; env-файл с токеном не world-readable), консистентность MCP, allowlist, флот (`--fleet`) и живую сессию (welcome-hang, auth, 409, crash loop). Ничего не перезапускает, секретов не печатает. Коды выхода: `0` — нет FAIL, `1` — есть FAIL, `2` — usage.
>
> **Железное правило: миграцию и любую хирургию моста делайте из терминала Claude Code, НЕ через Telegram.** Эта работа меняет тот самый мост, который доставляет ваши Telegram-сообщения. Сломается на середине — Telegram замолчит, и канал, через который вы давали команды, исчезнет вместе с возможностью починить. Откройте терминальную сессию на хосте (`tmux attach -t channel-<agent>` для осмотра, отдельная `claude`-сессия для работы), внесите изменение, прогоните доктора, отправьте тестовое сообщение — и только потом уходите. Баги и ошибки чините так же: сначала доктор, потом reference по упавшему чеку.

**Stack:** Bun 1.3+ / TypeScript strict, Claude Code v2.1.80+ ([Channels reference](https://code.claude.com/docs/en/channels-reference)), grammY 1.21+, Zod 3.23+, supervisor systemd/launchd.

| Док | Что внутри |
|---|---|
| [docs/01-what-is-this.md](docs/01-what-is-this.md) | Plugin vs Gateway — архитектура и преимущества |
| [docs/02-where-to-place-plugin.md](docs/02-where-to-place-plugin.md) | **Главное.** Где разместить каталог, чтобы сессия грузилась правильно (90% проблем) |
| [docs/03-installation.md](docs/03-installation.md) | systemd / launchd, EnvironmentFile, фикс welcome-промтов, smoke test |
| [docs/03-installation-linux.md](docs/03-installation-linux.md) · [macos](docs/03-installation-macos.md) | OS-specific unit/plist |
| [docs/04-migration-from-gateway.md](docs/04-migration-from-gateway.md) | Пошаговая миграция с `jarvis-telegram-gateway`, откат на каждом шаге |
| [skills/doctor-dashi-plugin/SKILL.md](skills/doctor-dashi-plugin/SKILL.md) | **Доктор миграции** — read-only диагностика: размещение, hooks (профили), permission gate + policy, мультичат, webhook bind, гигиена токена, MCP, allowlist, флот, живая сессия |
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

## 14. Мультиагент — флот агентов под одной подпиской

### Что это

На одном хосте под одной подпиской Claude Code Max можно запустить N независимых агентов.

Каждый агент — долгоживущая интерактивная Claude-сессия со своими:

| Часть | Значение на агента |
|---|---|
| Терминал | tmux-сессия на выделенном tmux-сокете |
| Telegram | свой bot token и свой polling consumer |
| Identity | `CLAUDE.md` workspace'а |
| Plugin checkout | внутри workspace агента |
| Skills | локальные для workspace |
| Memory/state | свой state dir и config |

Проверено в production:

| Флот | Хост / агенты | Заметки |
|---|---|---|
| 2 агента | один VPS: `thrall`, `arthas` | cutover 2026-06-05, живой пример ниже |
| 5 агентов | `jarvis`, `koder`, `secretary`, `researcher`, `analyst` | webhook-порты `8089–8093` |

Главное: это не N API-клиентов. Это N интерактивных Claude Code сессий под одним OAuth-логином — usage остаётся внутри подписки Max (см. раздел 13).

### Архитектура

```text
один unix user
один Claude Code OAuth login
        |
        v
+----------------------------- host -----------------------------+
|                                                                |
|  systemd: channel-thrall.service                               |
|    Type=forking                                                |
|    tmux -L channel-thrall                                      |
|      claude session                                            |
|        --dangerously-load-development-channels server:dashi-channel
|        workspace: /srv/agents/thrall   (CLAUDE.md = identity)  |
|        plugin: /srv/agents/thrall/.claude/dashi-plugin-claude-code/plugin
|        env: /etc/dashi-plugin/thrall/channel.env               |
|        state: /var/lib/dashi-channel/thrall                    |
|        Telegram bot token A · TELEGRAM_WEBHOOK_PORT=8089       |
|        getUpdates poller A                                     |
|                                                                |
|  systemd: channel-arthas.service                               |
|    Type=forking                                                |
|    tmux -L channel-arthas                                      |
|      claude session                                            |
|        workspace: /srv/agents/arthas   (CLAUDE.md = identity)  |
|        plugin: /srv/agents/arthas/.claude/dashi-plugin-claude-code/plugin
|        env: /etc/dashi-plugin/arthas/channel.env               |
|        state: /var/lib/dashi-channel/arthas                    |
|        Telegram bot token B · TELEGRAM_WEBHOOK_PORT=8090       |
|        getUpdates poller B                                     |
+----------------------------------------------------------------+
```

У каждого агента свой `channel.env` (полный список — `examples/channel.env.example`):

```bash
TELEGRAM_BOT_TOKEN=123456:agent-specific-token
TELEGRAM_EXPECTED_BOT_ID=123456
TELEGRAM_ALLOWED_USER_IDS=<ваш числовой id>
TELEGRAM_ALLOWED_CHAT_IDS=<ваш числовой id>
TELEGRAM_WORKSPACE_ROOT=/srv/agents/arthas
AGENT_ID=arthas
TELEGRAM_STATE_DIR=/var/lib/dashi-channel/arthas
TELEGRAM_WEBHOOK_HOST=127.0.0.1
TELEGRAM_WEBHOOK_PORT=8090
TELEGRAM_WEBHOOK_TOKEN=<random hex>
```

И свой state config (`<state-dir>/config.json`):

```json
{
  "webhook": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 8090
  }
}
```

`TELEGRAM_WEBHOOK_HOST` / `TELEGRAM_WEBHOOK_PORT` только задают host/port. Сами по себе они webhook **не включают** — это инвариант (e) ниже.

### Пять инвариантов изоляции

Это не вкусовщина. Каждый пункт — реальный production-инцидент.

| Инвариант | Почему важно |
|---|---|
| (a) Hooks только per-workspace | Ставьте hooks в `<workspace>/.claude/settings.json` через `install-hooks.sh --settings`, никогда — в общий `~/.claude/settings.json`. Общий файл срабатывает в **каждой** Claude-сессии unix-юзера: read-receipt/fallback hooks одного агента отправят текст другого агента через чужого бота. Хуже того, settings-патчер дедуплицирует по одному маркеру на файл — общий файл способен держать hook только ОДНОГО агента: последний install побеждает, остальные молча ходят в чужой порт. См. раздел 4. |
| (b) Отдельный `TELEGRAM_WEBHOOK_PORT` | Каждому агенту — свой локальный HTTP-порт для hooks/mirror/read-receipts. |
| (c) Отдельный bot token | Telegram допускает одного `getUpdates`-консьюмера на токен. Общий токен = `409 Conflict`, один из ботов глохнет. |
| (d) Выделенный tmux-сокет | `tmux -L channel-<agent>` в `ExecStart`, `ExecStartPost` И `ExecStop`. Два `Type=forking` юнита на дефолтном сокете гонятся при одновременном старте: сессия второго оказывается внутри tmux-сервера и cgroup первого — systemd её теряет, а stop юнита A убивает агента B. Реальный инцидент: после ребута жив 1 из 4 агентов; с `-L` — 4 из 4. |
| (e) `webhook.enabled=true` в state config | Дефолт — `false`, env-переменные задают только host/port. Без `<state-dir>/config.json` с включённым webhook эндпоинты hooks/read-receipt/fallback молча мертвы, при этом бот продолжает отвечать через канал — сбивающий с толку частичный отказ. |

### Readiness: не доверяйте Enter по таймеру

На холодном старте welcome-промпт dev-channels может отрисоваться позже 8 секунд. Слепой `sleep 6 && tmux send-keys Enter` в `ExecStartPost` стреляет в пустоту, systemd помечает юнит готовым, а канал так и не начинает слушать.

Вместо этого — confirm-цикл: capture-pane каждые 3 секунды, Enter только когда промпт реально виден на экране, exit `0` только при появлении баннера канала. Тогда exit-код `ExecStartPost` равен реальной готовности.

```bash
#!/usr/bin/env bash
# /usr/local/bin/channel-confirm-arthas.sh
for i in $(seq 1 30); do
  pane="$(tmux -L channel-arthas capture-pane -pt channel-arthas 2>/dev/null || true)"
  if printf '%s' "$pane" | grep -q 'messages from server:dashi-channel inject\|Listening for channel messages'; then
    exit 0
  fi
  if printf '%s' "$pane" | grep -q 'Enter to confirm\|I am using this for local development\|Do you trust'; then
    tmux -L channel-arthas send-keys -t channel-arthas Enter
  fi
  sleep 3
done
exit 1
```

### Плюсы

| Плюс | Детали |
|---|---|
| Одна подписка | Весь флот работает на одной подписке Claude Code Max. Никаких per-message SDK-кредитов (раздел 13). |
| Настоящая изоляция | Identity, skills, память, bot token, state dir, tmux-сокет, workspace — всё per-agent. |
| Параллельная работа | Агенты одновременно ведут разные задачи. |
| Terminal mirror на каждого | У каждого агента свой миррор через `tmux_mirror.socket_name` (раздел 6). |
| Меньше blast radius | Падение или рестарт одного агента не трогает остальных. |

### Минусы и ограничения

| Ограничение | Детали |
|---|---|
| Общая квота подписки | Все сессии делят rate limits одной подписки. N занятых агентов сжигают квоту в N раз быстрее. |
| RAM | Каждая Claude-сессия держит память — считайте сотни MB на агента. |
| Общий unix user | `~/.claude` глобален для юзера. Hooks, identity, plugin checkout, state, skills — строго per-workspace. |
| Больше движущихся частей | N юнитов, N токенов, N портов, N сокетов, N state dirs. |
| Нет слоя оркестрации | Плагин даёт каждому агенту канал, а не координацию. Как агенты делят работу — решать вам. |

Замечания по безопасности из раздела 10 действуют для каждого агента флота.

### Живой пример: флот из двух агентов (thrall + arthas)

Реальная production-раскладка (только архитектура, без секретов):

| | `thrall` | `arthas` |
|---|---|---|
| Роль | архитектор / кодер — правая рука владельца | мониторинг + inbox-коллектор |
| Бот | свой бот, DM + групповой multichat (раздел 3) | свой бот, только DM (multichat выключен) |
| Юнит | `channel-thrall.service` | `channel-arthas.service` |
| tmux | сессия `channel-thrall` | сессия `channel-arthas` на сокете `-L channel-arthas` |
| Webhook | `127.0.0.1:8093` | `127.0.0.1:8103` |
| Workspace | `~/.claude-lab/thrall/.claude` | `~/.claude-lab/arthas/.claude` |
| Identity / skills | свой `CLAUDE.md`, свои `skills/` | свой `CLAUDE.md`, свои `skills/` |
| Terminal mirror | включён (раздел 6) | включён, через `tmux_mirror.socket_name` |

Оба работают под одним unix-юзером и одной подпиской Max. Координируются через общий task board и межагентскую шину сообщений — сознательно **вне** плагина (см. «нет слоя оркестрации» выше). `arthas` переехал со старого python-gateway 2026-06-05; первая попытка cutover автоматически откатилась и породила инварианты (d) и (e) — таблица выше оплачена инцидентами, а не теорией.

### Чек-лист: добавить агента #2..N

Дано: рабочая single-agent установка, новый агент `arthas`.

1. Создайте workspace и identity:

```bash
export AGENT=arthas
export WORKSPACE=/srv/agents/$AGENT
export STATE_DIR=/var/lib/dashi-channel/$AGENT
export PORT=8090

mkdir -p "$WORKSPACE/.claude" "$STATE_DIR"
$EDITOR "$WORKSPACE/CLAUDE.md"     # кто этот агент
```

2. Склонируйте плагин **внутрь** workspace агента (от этого зависит identity — раздел 1, docs/02):

```bash
cd "$WORKSPACE/.claude"
git clone https://github.com/qwwiwi/dashi-plugin-claude-code.git
cd dashi-plugin-claude-code/plugin
bun install
```

3. Создайте `channel.env` этого агента (свой токен, свой порт — инварианты (b), (c)):

```bash
sudo mkdir -p /etc/dashi-plugin/$AGENT
sudo cp examples/channel.env.example /etc/dashi-plugin/$AGENT/channel.env
sudo chmod 640 /etc/dashi-plugin/$AGENT/channel.env
sudo $EDITOR /etc/dashi-plugin/$AGENT/channel.env   # токен, порт, id, пути
```

4. Включите webhook в state config (инвариант (e)):

```bash
cat > "$STATE_DIR/config.json" <<EOF
{ "webhook": { "enabled": true, "host": "127.0.0.1", "port": $PORT } }
EOF
```

5. Поставьте hooks только в settings **этого агента** (инвариант (a)):

```bash
bash scripts/install-hooks.sh \
  --settings "$WORKSPACE/.claude/settings.json" \
  --chat-id <ваш числовой id> \
  --webhook-url "http://127.0.0.1:$PORT/hooks/agent" \
  --agent-id $AGENT
```

6. Создайте systemd-юнит с выделенным tmux-сокетом (инвариант (d)) — за основу возьмите `examples/systemd-unit.service.example` и добавьте `-L`:

```ini
[Unit]
Description=Dashi Channel agent arthas
After=network-online.target
Requires=network-online.target

[Service]
Type=forking
User=<service-user>
Environment=HOME=/home/<service-user>
Environment=PATH=/home/<service-user>/.bun/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=/srv/agents/arthas/.claude/dashi-plugin-claude-code/plugin
EnvironmentFile=/etc/dashi-plugin/arthas/channel.env
ExecStart=/usr/bin/tmux -L channel-arthas new-session -d -s channel-arthas 'claude --dangerously-load-development-channels server:dashi-channel'
ExecStartPost=/usr/local/bin/channel-confirm-arthas.sh
ExecStop=/usr/bin/tmux -L channel-arthas kill-session -t channel-arthas
Restart=on-failure
RestartSec=15

[Install]
WantedBy=multi-user.target
```

`ExecStartPost` — confirm-цикл из «Readiness» выше. Ключевое: `tmux -L channel-arthas` **везде**.

7. Если токен бота уже кто-то поллит (старый gateway, другой процесс) — cutover строго как single poller: сначала остановите старого консьюмера, подождите ~30 секунд, пока Telegram отпустит слот `getUpdates`, и только потом стартуйте новый юнит. Два консьюмера на одном токене = `409 Conflict`.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now channel-arthas.service
```

8. Прогоните доктора (из корня репо) и отправьте боту настоящее сообщение:

```bash
cd "$WORKSPACE/.claude/dashi-plugin-claude-code"
# на systemd-хосте доктор сам найдёт юнит, env и сессию; --fleet проверит
# изоляцию между агентами (порты, токены, сокеты, hooks)
bun skills/doctor-dashi-plugin/scripts/doctor.ts --plugin-dir "$PWD/plugin" --fleet \
  --user <ваш числовой id>
```

Контекст миграции: `docs/04-migration-from-gateway.md` и раздел 13.

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
