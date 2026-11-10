# Установка на Linux (systemd)

## Быстрая установка

От непривилегированного пользователя агента установите `claude`, Bun, `tmux` и Git,
пройдите вход командой `claude`, затем:

```bash
mkdir -p ~/.claude-lab/myagent/.claude
cd ~/.claude-lab/myagent/.claude
git clone https://github.com/qwwiwi/dashi-plugin-claude-code.git
cd dashi-plugin-claude-code
./install.sh
# Обновление из этого же каталога:
./update.sh
```

Установщик проверит зависимости, спросит имя агента, workspace, токен бота
(ввод скрыт) и положительный числовой Telegram user ID. Без ID установка не
завершится. Токен хранится только в приватном `channel.env` с правами `600`.
Установщик запускает `bun install`, ставит обычные hooks плагина, создаёт config
и systemd unit с автономным профилем, затем показывает сводку doctor.
Перед заменой файлов создаются копии с датой. `--dry-run` ничего не записывает.

Без `--start` сервис не запускается. Unit сначала сохраняется в каталоге состояния
(по умолчанию `~/.claude/channels/myagent/channel-myagent.service`). Установщик
печатает команды с вашими путями; для стандартного имени и пути это:

```bash
sudo install -m 644 "$HOME/.claude/channels/myagent/channel-myagent.service" /etc/systemd/system/channel-myagent.service
sudo systemctl daemon-reload
sudo systemctl enable channel-myagent.service
# Запуск, когда готовы:
sudo systemctl start channel-myagent.service
```

`--start` печатает команды для включения и запуска через `sudo`; установщик сам
не повышает права. Включённый unit запускается после загрузки ОС и перезапускает
агента после сбоя (`Restart=`).

Для автоматизации: `--agent NAME --workspace PATH --owner-id ID --non-interactive`;
токен передайте через `TELEGRAM_BOT_TOKEN`, ID можно через `TELEGRAM_OWNER_ID`.
Флаг `--bot-token TOKEN` тоже есть, но env не оставляет токен в истории команд.
Доступны `--state-dir PATH`, `--settings PATH`, `--start`, `--dry-run`.
`./update.sh` сохраняет config/settings, отказывается от грязного checkout,
обновляет код через `--ff-only`, запускает тесты и обновляет hooks. Рестарт только
вручную по напечатанной команде либо с `--restart` из отдельного терминала;
из tmux-сессии обновляемого Telegram-канала рестарт запрещён. Update также принимает
`--dry-run`, `--state-dir PATH`, `--settings PATH`.

Для `update.sh` нужен `install.json` от установщика/renderer. Старую ручную
установку сначала перенесите в выбранный state-каталог (приватный env и config),
затем повторите `./install.sh --state-dir PATH` с теми же agent/workspace/owner:
config/env сохранятся. До запуска проверьте doctor. При нескольких агентах
или своём пути используйте `./update.sh --state-dir PATH`.

При обновлении старой установки до рестарта задайте свой `allowed_user_ids`
в используемом `config.json` или `TELEGRAM_ALLOWED_USER_IDS=123456789` в окружении
канала: прежнего встроенного ID больше нет, отсутствие владельца блокирует запуск.
`TELEGRAM_OWNER_ID` — вход установщика, не замена runtime-настройки.
Тесты плагина/установщика: `cd plugin && bun test`; doctor из корня:
`bun test skills/doctor-dashi-plugin/scripts/doctor.test.ts`. Ручной путь — ниже.

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

## Autonomy
- Выполняю обычную работу самостоятельно, без запросов подтверждения

## Boundaries
- Никогда не вывожу и не коммичу секреты
- Разрушительное удаление и force-push — только по явному указанию владельца
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

## Шаг 6. Wrapper и systemd unit

Вместо ручной замены shell-экранированных placeholders используйте отдельный
renderer. Он не устанавливает зависимости и hooks, не регистрирует и не запускает
сервис: эти действия остаются отдельными шагами. Он берёт текущие шаблоны
`examples/launchd-wrapper.sh.example` (общий wrapper для обеих ОС) и
`examples/systemd-unit.service.example`, создаёт config, MCP config и `install.json`.
Существующие config/env сохраняются; перед заменой wrapper/unit делаются копии
с датой. Нужны заполненный env из шага 5 и установленный Bun.

```bash
# Выполняйте под пользователем агента, не root; замените myagent своим именем.
export INSTALL_AGENT=myagent
export INSTALL_WORKSPACE="$HOME/.claude-lab/myagent/.claude"
export INSTALL_REPO="$INSTALL_WORKSPACE/dashi-plugin-claude-code"
export INSTALL_STATE_DIR="$HOME/.claude-lab/shared/state/myagent/telegram"
export INSTALL_SETTINGS="$HOME/.claude/settings.json"
export INSTALL_PLATFORM=Linux
export INSTALL_HOME="$HOME"
export INSTALL_CLAUDE="$(command -v claude)"
export INSTALL_TMUX="$(command -v tmux)"
export INSTALL_BUN="$(command -v bun)"
mkdir -p "$INSTALL_STATE_DIR"
# Существующий приватный env сохраняется; для новой установки копируем из шага 5.
if [[ ! -f "$INSTALL_STATE_DIR/channel.env" ]]; then
  install -m 600 "/etc/dashi-plugin/myagent/channel.env" "$INSTALL_STATE_DIR/channel.env"
fi
read -r -p 'Telegram owner ID (numeric): ' TELEGRAM_OWNER_ID
export TELEGRAM_OWNER_ID
bun "$INSTALL_REPO/scripts/render-install.ts"
```

Проверьте в приватном `$INSTALL_STATE_DIR/channel.env`, что `TELEGRAM_STATE_DIR`
равен этому каталогу, а `TELEGRAM_WORKSPACE_ROOT` — workspace из команды выше.
Если задан `TELEGRAM_CONFIG_FILE`, укажите `$INSTALL_STATE_DIR/config.json`
и поместите используемый config в этот файл. Перед ручной правкой сделайте
копию файла с датой. Owner ID должен быть разрешён существующими config/env;
несоответствие renderer отклонит.

Результат: `$INSTALL_STATE_DIR/channel-wrapper.sh` и
`$INSTALL_STATE_DIR/channel-myagent.service`. В unit используются `Type=simple`,
`ExecStart=<полный путь к wrapper>`, `Restart=on-failure`, `RestartSec=15s`.
Wrapper остаётся foreground-процессом, отслеживает detached tmux-сессию и
выходит с кодом 1 при её неожиданном завершении — systemd видит сбой и
перезапускает агента. SIGTERM от systemd останавливает tmux и завершает wrapper
с кодом 0. Проверка `tmux has-session` сама по себе не подтверждает готовность бота.

`WorkingDirectory` сервиса — `plugin/`; реальный CWD Claude Code — workspace
(`tmux new-session -c`). MCP config содержит абсолютные пути, а команда внутри
pane читает приватный env заново, даже если tmux server существовал раньше.
По умолчанию используется `--permission-mode bypassPermissions`. Для подтверждений
уберите этот флаг из `CLAUDE_CMD` в сгенерированном wrapper; permission gate
подключается отдельно через `install-hooks.sh --permission-gate` и
`permission_gate.enabled=true`.

Установите подготовленный unit и включите автозапуск:

```bash
sudo install -m 644 "$INSTALL_STATE_DIR/channel-myagent.service" /etc/systemd/system/channel-myagent.service
sudo systemctl daemon-reload
sudo systemctl enable channel-myagent.service
sudo systemctl start channel-myagent.service
sudo systemctl status channel-myagent.service --no-pager -l
```

При замене уже установленного unit сначала сохраните его копию с датой.
Ожидается `active (running)`; ошибки смотрите через
`journalctl -u channel-myagent.service --since "5 min ago"`. Enable запускает
сервис после загрузки ОС; crash restart обеспечивает foreground-wrapper.

---

## Шаг 7. Прохождение welcome-промтов

При **первом** запуске Claude Code задаст 2 интерактивных вопроса:

1. **«Allow external CLAUDE.md file imports?»** — если ваш `CLAUDE.md` использует `@-include`. Ответ: `1` (Yes).
2. **«--dangerously-load-development-channels»** — предупреждение про dev channels. Ответ: `1` (I am using this for local development).

Wrapper отправляет Enter через 6 секунд и ещё раз через 2 секунды. Если welcome-промт появился позже, откройте tmux и подтвердите вручную:

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

> **Проверка готовности:** задержки welcome-промтов зависят от версии Claude Code. После старта проверьте pane и реальный ответ на DM; активный wrapper ещё не означает готовый Telegram-канал.

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
