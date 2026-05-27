# Progress Reporter — установка и smoke-test

Этот гайд позволяет за пару кликов включить в своём агенте «rolling activity card» — одно сообщение в Telegram, которое обновляется по мере исполнения tool-calls (`Bash`, `Edit`, `Write`, ...) и в конце сессии превращается в финальное `done -- Ns`.

Это **вариант A** из брейншторма UX 2026-05-20. С тех пор зашиплены: ProgressReporter (PR #5/8), TaskMirror (PR #11), фильтр шумных tool-ов и финализация Stop (PR #12), per-chat изоляция в multichat-режиме (PR #13).

---

## Что должно работать после установки

| # | Фича | Где смотреть |
|---|---|---|
| 1 | Webhook сервер плагина слушает локально на `127.0.0.1:<port>/hooks/agent` | `/health` GET → `{"status":"ok"}` |
| 2 | Claude Code шлёт каждое событие `PreToolUse`/`PostToolUse`/`Stop` на этот endpoint | hooks в `settings.json` с marker `dashi-channel-hook` |
| 3 | `ProgressReporter` редактирует одно Telegram-сообщение per chat по мере событий | визуально в чате с ботом |
| 4 | `Stop` финализирует сообщение строкой `done -- Ns` | визуально |
| 5 | Бэкенд игнорирует ошибки и не блокирует агента | хук всегда выходит с `0`, агент продолжает работу даже если webhook упал |
| 6 | Шумные read-only tools (`Read`, `Grep`, `Glob`, `ToolSearch`) не показываются в карточке, только Bash/Edit/Write/Task* и mutating MCP-вызовы | строка `▸` появляется только для значимых tool-ов |
| 7 | `TaskMirror` отдельным сообщением показывает progress по TodoWrite-плану (если агент пользуется TodoWrite) | отдельное сообщение, обновляется в реальном времени |

Конфиг ключевых параметров — в `<state_dir>/config.json` блок `"progress": { ... }`: `edit_throttle_ms`, `recent_buffer`, `session_ttl_ms`, `noisy_tools` (override default-листа), `enabled`.

---

## Зависимости

- `bun >= 1.0`
- Запущенный экземпляр dashi-channel плагина (например через `channel-thrall.service` systemd unit)
- `TELEGRAM_WEBHOOK_TOKEN`, `TELEGRAM_WEBHOOK_HOST`, `TELEGRAM_WEBHOOK_PORT`, `TELEGRAM_BOT_TOKEN` в env плагина (обычно в `channel.env`)
- В конфиге плагина (`<state_dir>/config.json`) — блок `"webhook": { "enabled": true, "host": "127.0.0.1", "port": <port> }`

---

## Установка в 3 шага

### 1. Получить параметры

```bash
# Какой токен у webhook
TOKEN=$(grep '^TELEGRAM_WEBHOOK_TOKEN=' ~/.claude-lab/<agent>/secrets/channel.env | cut -d= -f2)

# Какой URL слушает webhook
URL="http://127.0.0.1:8093/hooks/agent"   # подставь свой port

# Chat ID (твой Telegram user id — узнать у @userinfobot)
CHAT_ID="<your-telegram-user-id>"
```

### 2. Запатчить settings.json

Скрипт `plugin/scripts/install-hooks.sh` идемпотентно добавляет 5 хуков (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop) и НЕ записывает токен в settings.json:

```bash
bash plugin/scripts/install-hooks.sh \
  --settings ~/.claude-lab/<agent>/.claude/settings.json \
  --chat-id $CHAT_ID \
  --webhook-url $URL \
  --agent-id dashi-channel
```

Результат: в settings.json появятся entries с `"marker": "dashi-channel-hook"`. Прогон скрипта повторно — заменит существующие entries, не задублирует.

### 3. Рестартнуть агента

Хуки читаются Claude Code только при старте сессии:

```bash
sudo systemctl restart channel-<agent>.service
```

После рестарта любой tool-call в новой сессии начнёт рисовать карточку в Telegram.

---

## Smoke-test

```bash
TELEGRAM_HOOK_CHAT_ID=$CHAT_ID \
TELEGRAM_WEBHOOK_URL=$URL \
TELEGRAM_WEBHOOK_TOKEN=$TOKEN \
bash plugin/scripts/smoke-test-progress.sh --bot-id <expected_bot_id>
```

Скрипт проверит:
- env переменные выставлены
- `bun` на PATH
- `/health` отвечает
- `bot_id` соответствует ожидаемому (опционально)
- post-hook.ts успешно отправляет PreToolUse Bash, PostToolUse Bash, PreToolUse Edit, PostToolUse Edit, Stop
- в settings.json присутствует marker `dashi-channel-hook` минимум 5 раз

Выход:
- `0` — все проверки прошли
- `1` — хотя бы один critical check упал (token, URL, webhook response)
- `2` — usage / config error

Флаг `--quiet` показывает только финальную таблицу.

Ручная проверка после smoke-test: открой Telegram, должно прийти сообщение вида:

```
<pre>working -- 0s

▸ Bash · ls -la /tmp
▸ editing smoke.md

done -- Ns</pre>
```

Если сообщение не пришло — смотри в лог плагина (`<state_dir>/logs/server.log`) на предмет `progress reporter ... failed`.

---

## Troubleshooting

| Симптом | Причина | Что делать |
|---|---|---|
| `webhook responded 400` | post-hook.ts отправил невалидный envelope | проверь что Claude Code посылает `transcript_path`, `cwd`, `session_id` — это поля от Claude Code, генерируются автоматически |
| `webhook responded 401` | bearer token не совпадает | проверь `TELEGRAM_WEBHOOK_TOKEN` в env агента vs `channel.env` плагина |
| `webhook responded 403` | chat_id не в allowlist | добавь `chat_id` в `config.json` плагина → `allowed_chat_ids` |
| Сообщение в TG не приходит | `config.progress.enabled = false` | поставь `true` в `<state_dir>/config.json` → `progress: { enabled: true }` |
| Сообщение приходит, но всегда новое (не редактируется) | session_ttl_ms экспайрил | events отправляются с разрывом > `session_ttl_ms` (default 10m) — это by design |
| Все события для одного tool сливаются в одну карточку, новая сессия их не сбрасывает | `Stop` hook не доходит до webhook | проверь что Stop hook есть в settings.json с marker `dashi-channel-hook` |

---

## Архитектурная схема

```
Claude Code (любой agent)
   |
   v
hooks (settings.json)  ──[stdin envelope]──>  post-hook.ts
                                                  |
                                                  v
                                       POST /hooks/agent (Bearer + JSON)
                                                  |
                                                  v
                                       dashi-channel plugin (bun)
                                              |       |        |
                                              v       v        v
                                        Memory  Status  ProgressReporter
                                                          |
                                                          v
                                               edit_message (Telegram)
```

`ProgressReporter` — стейтмашина: per-chat ровно одно сообщение, throttle через `edit_throttle_ms`, single-flight queue, TTL eviction, финал на Stop.
