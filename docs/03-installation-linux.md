# Установка на Linux (systemd)

> **macOS пользователь?** → [03-installation-macos.md](03-installation-macos.md)
> **Не уверены какой OS выбрать?** → [03-installation.md](03-installation.md)

Этот документ описывает полную установку плагина под **systemd на Linux** (Ubuntu / Debian / RHEL) для production. Для разработки в одиночку (запуск из терминала вручную) достаточно Quick Start в [README.md](../README.md) — возвращайтесь сюда, когда захотите чтобы агент работал автономно.

**Перед чтением:** убедитесь что прочитали [02-where-to-place-plugin.md](02-where-to-place-plugin.md). Без понимания CWD дальнейшие шаги не имеют смысла.

---

## Требования

| Компонент | Версия | Зачем |
|---|---|---|
| Linux (Ubuntu 22.04+ / Debian 12+) | — | systemd, tmux |
| Claude Code | v2.1+ | Channels API (`claude/channel`) |
| Bun | 1.3.14+ | Runtime плагина |
| Node-совместимые tools | — | TypeScript checker, MCP SDK |
| tmux | 3.x | Чтобы Claude Code остался активен после старта systemd (Claude Code требует TTY) |
| systemd | — | Process supervisor |
| Service-user | непривилегированный | НЕ запускайте от root |

Anthropic Max subscription нужна для агента (Claude Code login). Установка плагина её не покрывает — это ваша подписка.

---

## Шаг 1. Service-user и workspace

Создайте непривилегированного пользователя для всех агентов (рекомендуется):

```bash
sudo useradd -m -s /bin/bash agentctl
sudo -u agentctl mkdir -p /home/agentctl/.claude-lab/myagent/.claude
```

Если уже есть подходящий пользователь — используйте его. Везде ниже подставляйте свои `<service-user>` и `<agent>`.

---

## Шаг 2. Установка Claude Code и Bun под этим пользователем

```bash
sudo -iu agentctl
# Bun
curl -fsSL https://bun.sh/install | bash

# Claude Code — официальный installer
# (см. актуальную инструкцию https://code.claude.com/docs/en/setup)
```

Проверка:

```bash
bun --version    # 1.3.14+
claude --version # 2.1.x
```

Залогиньтесь Claude Code в Anthropic Max интерактивно:

```bash
claude
# пройдите OAuth, после успеха exit
```

Login сохраняется в `~/.claude/` под этим пользователем.

---

## Шаг 3. Клонируйте плагин внутрь workspace

```bash
cd /home/agentctl/.claude-lab/myagent/.claude
git clone https://github.com/qwwiwi/dashi-plugin-claude-code.git
cd dashi-plugin-claude-code/plugin
bun install
bun run typecheck    # должно пройти без ошибок
bun test             # 425 pass
```

Если `bun test` падает — НЕ продолжайте. Откройте issue.

---

## Шаг 4. Создайте `CLAUDE.md` агента

Минимальный `CLAUDE.md` (`/home/agentctl/.claude-lab/myagent/.claude/CLAUDE.md`):

```markdown
# MyAgent

## Identity
Я — MyAgent, AI-помощник <вашего владельца>.
Язык общения — русский. Стиль: краткость > объяснений.

## Capabilities
- Отвечаю на сообщения в Telegram
- Использую инструменты Claude Code (Bash, Read, Write, etc.)
- Могу обращаться к MCP-серверам если они подключены

## Boundaries
- Не передаю секреты в чат
- Не запускаю rm -rf / DROP TABLE без подтверждения
- В случае ошибки — извещаю владельца, не маскирую
```

Полный пример с разделённой памятью (`@-include`) — изучите по аналогии существующих агентов в [github.com/qwwiwi/public-gbrain-agentos/tree/main/agent-template](https://github.com/qwwiwi/public-gbrain-agentos/tree/main/agent-template).

---

## Шаг 5. Telegram бот и channel.env

В Telegram у [@BotFather](https://t.me/BotFather) создайте нового бота, получите `bot_token`.

Скопируйте example env-файл:

```bash
sudo mkdir -p /etc/dashi-plugin/myagent
sudo cp /home/agentctl/.claude-lab/myagent/.claude/dashi-plugin-claude-code/examples/channel.env.example \
        /etc/dashi-plugin/myagent/channel.env
sudo chown root:agentctl /etc/dashi-plugin/myagent/channel.env
sudo chmod 640 /etc/dashi-plugin/myagent/channel.env
sudo $EDITOR /etc/dashi-plugin/myagent/channel.env
```

Заполните минимум:

```bash
TELEGRAM_BOT_TOKEN=123456789:AAH...
TELEGRAM_EXPECTED_BOT_ID=123456789
TELEGRAM_ALLOWED_USER_IDS=123456789    # ваш Telegram user ID
TELEGRAM_STATE_DIR=/home/agentctl/.claude-lab/shared/state/myagent/telegram
TELEGRAM_WORKSPACE_ROOT=/home/agentctl/.claude-lab/myagent/.claude
TELEGRAM_WEBHOOK_HOST=127.0.0.1
TELEGRAM_WEBHOOK_PORT=8089             # default port for hook receiver (Шаг 9)
AGENT_ID=myagent
```

Узнать свой `user_id` в Telegram — напишите [@userinfobot](https://t.me/userinfobot).

`TELEGRAM_EXPECTED_BOT_ID` — числовая часть до двоеточия в `TELEGRAM_BOT_TOKEN`. Используется plugin'ом для anti-spoof.

`TELEGRAM_WEBHOOK_PORT=8089` — порт, на котором плагин слушает Claude Code hooks (PreToolUse/PostToolUse/Stop/UserPromptSubmit/SessionStart). Меняйте только если у вас несколько агентов на одной машине и порт 8089 уже занят — тогда подставьте свободный (например 8090, 8091, …) и не забудьте передать его в `install-hooks.sh --webhook-url` (Шаг 9).

> **Telegram output formatting** (как агент пишет в чат — markdown/HTML, redactor) — см. [03-installation.md → Telegram output formatting](03-installation.md#telegram-output-formatting). OS-agnostic, поведение одинаковое на Linux и macOS.

---

## Шаг 6. systemd unit

Скопируйте example:

```bash
sudo cp /home/agentctl/.claude-lab/myagent/.claude/dashi-plugin-claude-code/examples/systemd-unit.service.example \
        /etc/systemd/system/channel-myagent.service
sudo $EDITOR /etc/systemd/system/channel-myagent.service
```

Подставьте свои значения для `User=`, `WorkingDirectory=`, `EnvironmentFile=`:

```ini
[Unit]
Description=Dashi Plugin Channel for myagent
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
User=agentctl
Group=agentctl
EnvironmentFile=/etc/dashi-plugin/myagent/channel.env
Environment=HOME=/home/agentctl
Environment=PATH=/home/agentctl/.bun/bin:/home/agentctl/.local/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=/home/agentctl/.claude-lab/myagent/.claude/dashi-plugin-claude-code/plugin
ExecStart=/usr/bin/tmux new-session -d -s channel-myagent \
  claude --dangerously-load-development-channels server:dashi-channel
ExecStartPost=/bin/sh -c 'sleep 6 && /usr/bin/tmux send-keys -t channel-myagent Enter'
ExecStop=/usr/bin/tmux kill-session -t channel-myagent
Restart=on-failure
RestartSec=15s

[Install]
WantedBy=multi-user.target
```

**КРИТИЧНО:** `WorkingDirectory=` указывает внутрь `plugin/`. Если опечатка — Claude Code не найдёт project CLAUDE.md и агент будет без identity. См. [02-where-to-place-plugin.md](02-where-to-place-plugin.md).

`Type=forking` нужен потому что `tmux new-session -d` форкается и возвращает управление.

`ExecStartPost` посылает `Enter` через 6 секунд — нужно для прохождения интерактивных welcome-промтов Claude Code (см. ниже).

Активируйте:

```bash
sudo systemctl daemon-reload
sudo systemctl enable channel-myagent
sudo systemctl start channel-myagent
sudo systemctl status channel-myagent --no-pager -l
```

Должен быть `active (running)`. Если падает — `journalctl -u channel-myagent --since "5 min ago"`.

---

## Шаг 7. Прохождение welcome-промтов

При **первом** запуске Claude Code задаст 2 интерактивных вопроса:

1. **«Allow external CLAUDE.md file imports?»** — если ваш `CLAUDE.md` использует `@-include`. Ответ: `1` (Yes).
2. **«--dangerously-load-development-channels»** — предупреждение про dev channels. Ответ: `1` (I am using this for local development).

`ExecStartPost` посылает один `Enter` через 6 секунд — это автоматизирует первый промт. Второй промт требует ещё одного Enter. Откройте tmux и нажмите вручную:

```bash
sudo -u agentctl tmux attach -t channel-myagent
# увидите второй промт — нажмите Enter
# detach: Ctrl-B затем D
```

После этого плагин стартует и в Telegram должен прийти `getUpdates` response. Напишите боту — должен ответить.

### Persistent welcome approvals (чтобы не нажимать Enter после каждого рестарта)

Welcome-промты показываются **при каждом** запуске Claude Code, включая `systemctl restart`. Это значит, после рестарта сервиса нужен человек с tmux чтобы пройти 2 промта.

**Решение** (требует Claude Code v2.1.140+):

В `~/.claude/settings.json` пользователя `agentctl` добавьте:

```json
{
  "hasTrustDialogAccepted": true,
  "dangerouslyLoadDevelopmentChannelsAccepted": true,
  "externalImportsAccepted": true
}
```

Точные ключи зависят от версии Claude Code — проверьте `~/.claude/settings.json` после первого ручного прохождения, скопируйте появившиеся ключи. После этого `systemctl restart` пройдёт без интерактива.

> **Известный gap:** на момент написания (Claude Code v2.1.143) часть промтов не сохраняется persistent. Workaround: держите `ExecStartPost` который шлёт несколько `Enter` подряд через `sleep`, и тестируйте `systemctl restart` чтобы убедиться.

---

## Шаг 8. Smoke test

Напишите боту в Telegram любое сообщение. Должны увидеть:

1. **Реакция 👀** на ваше сообщение (через ~1 сек)
2. **«печатает...»** в шапке чата
3. **Реакция ⚙️** когда агент начинает использовать инструменты
4. **Ответ** агента (текстом или файлом)
5. **Реакция ✅** на ваше сообщение по завершении

Если ничего не пришло — проверьте:

```bash
# 1. Сервис активен
sudo systemctl status channel-myagent

# 2. tmux показывает Claude Code на главном экране (не на welcome-промтах)
sudo -u agentctl tmux capture-pane -t channel-myagent -p -S -50 | tail -30
# должны увидеть "Listening for channel messages from: server:dashi-channel"

# 3. Telegram pending updates
TOKEN=$(grep TELEGRAM_BOT_TOKEN /etc/dashi-plugin/myagent/channel.env | cut -d= -f2-)
curl -s "https://api.telegram.org/bot${TOKEN}/getUpdates?limit=5&timeout=0" | jq .
```

Если что-то не так — [05-troubleshooting.md](05-troubleshooting.md).

---

## Шаг 9. Hook integration (опционально, для memory/status)

После того как плагин запущен и Claude Code сессия активна, установите hooks чтобы PreToolUse/PostToolUse/Stop/UserPromptSubmit/SessionStart events приходили обратно в плагин — без них Telegram статус будет показывать только начало/конец без промежуточных tool calls.

```bash
sudo -u agentctl bash /home/agentctl/.claude-lab/myagent/.claude/dashi-plugin-claude-code/plugin/scripts/install-hooks.sh \
  --settings /home/agentctl/.claude/settings.json \
  --chat-id <your-telegram-chat-id> \
  --webhook-url http://127.0.0.1:8089/hooks/agent \
  --agent-id myagent
```

Идемпотентно — повторный запуск не дублирует. Если ваш плагин слушает на другом порте (см. `TELEGRAM_WEBHOOK_PORT` в channel.env), укажите соответствующий `webhook-url`.

После `install-hooks` рестартните сервис: `sudo systemctl restart channel-myagent`.

---

## Шаг 10. Memory hooks (опционально)

Для long-term memory pipeline (запись turn'ов в `<workspace>/core/hot/recent.md` + `verbose-YYYY-MM-DD.jsonl`) — раздел [`plugin/README.md` → Memory hooks](../plugin/README.md#memory-hooks-phase-8-config).

Альтернатива: используйте gbrain ([qwwiwi/public-gbrain-agentos](https://github.com/qwwiwi/public-gbrain-agentos)) — там MCP-серверы для memory/recall/swarm.

---

## Логи и state канонические пути

Плагин и Claude Code пишут в три разных места — supervisor stderr/stdout, plugin state dir, tmux pane history. Когда что-то ломается, открывайте в этом порядке:

| Что | Где (Linux systemd) | Команда просмотра |
|---|---|---|
| Supervisor stderr/stdout (Claude Code + Bun) | journald, unit `channel-<agent>` | `journalctl -u channel-myagent -n 200 --no-pager` |
| Supervisor live tail | journald | `journalctl -u channel-myagent -f` |
| **`bot.pid`** (PID Bun процесса) | `${TELEGRAM_STATE_DIR}/bot.pid` | `cat /home/agentctl/.claude-lab/shared/state/myagent/telegram/bot.pid` |
| **`access.json`** (multichat allowlist runtime state) | `${TELEGRAM_STATE_DIR}/access.json` | `jq . /home/agentctl/.claude-lab/shared/state/myagent/telegram/access.json` |
| **`update-offset`** (Telegram getUpdates offset) | `${TELEGRAM_STATE_DIR}/update-offset` | `cat /home/agentctl/.claude-lab/shared/state/myagent/telegram/update-offset` |
| **`dead-letter/`** (сообщения, которые не удалось доставить) | `${TELEGRAM_STATE_DIR}/dead-letter/` | `ls -la /home/agentctl/.claude-lab/shared/state/myagent/telegram/dead-letter/` |
| **`permissions.jsonl`** (журнал allowlist-решений) | `${TELEGRAM_STATE_DIR}/logs/permissions.jsonl` | `tail -50 /home/agentctl/.claude-lab/shared/state/myagent/telegram/logs/permissions.jsonl` |
| Tmux pane history (живой terminal Claude Code) | tmux session `channel-<agent>` | `sudo -u agentctl tmux capture-pane -p -t channel-myagent -S -200` |
| Tmux attach (интерактивно) | tmux session | `sudo -u agentctl tmux attach -t channel-myagent` (detach Ctrl-B D) |
| Workspace memory (если memory hooks включены) | `<workspace>/core/hot/recent.md` + `<workspace>/../logs/verbose-YYYY-MM-DD.jsonl` | `tail -100 /home/agentctl/.claude-lab/myagent/.claude/core/hot/recent.md` |

`TELEGRAM_STATE_DIR` определяется в `channel.env` (Шаг 5). Если не задан — плагин падает на дефолт `/tmp/dashi-channel-state/<agent>/`, который **зачищается при reboot** — в production задавайте явно (рекомендуется `<shared>/state/<agent>/telegram/`).

> **Не путайте supervisor stdout и tmux pane:** journald хранит то, что Bun/Claude Code напечатали в stderr/stdout процесса (логи плагина). Tmux pane — это **сам интерактивный terminal Claude Code** с его UI (welcome-промты, спиннеры, ответы модели). Bug в плагине ищите в journald, identity / welcome / context drift — в tmux pane.

---

## Backup

Перед любым обновлением — снапшот:

```bash
sudo tar czf /var/backups/myagent-$(date +%Y%m%d-%H%M).tgz \
  /home/agentctl/.claude-lab/myagent \
  /etc/dashi-plugin/myagent \
  /etc/systemd/system/channel-myagent.service
```

Восстановление: `tar xzf <backup> -C /` + `sudo systemctl daemon-reload` + `systemctl restart`.

---

## Update плагина

```bash
sudo systemctl stop channel-myagent
cd /home/agentctl/.claude-lab/myagent/.claude/dashi-plugin-claude-code
sudo -u agentctl git pull
cd plugin
sudo -u agentctl bun install
sudo -u agentctl bun test
sudo systemctl start channel-myagent
```

Если `bun test` падает после `git pull` — откатитесь к предыдущему коммиту (`git reset --hard HEAD~1`) и откройте issue.

---

## Готово

Дальше — [05-troubleshooting.md](05-troubleshooting.md) когда что-то сломается, и [04-migration-from-gateway.md](04-migration-from-gateway.md) если переезжаете со старого `claude -p` gateway.
