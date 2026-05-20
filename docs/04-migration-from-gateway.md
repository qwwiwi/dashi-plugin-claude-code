# Миграция с jarvis-telegram-gateway

Этот документ — для тех, у кого уже работает Python `claude -p` gateway (репо [qwwiwi/jarvis-telegram-gateway](https://github.com/qwwiwi/jarvis-telegram-gateway) или приватный fork [qwwiwi/gateway-dashis-agents](https://github.com/qwwiwi/gateway-dashis-agents)), и нужно переехать на плагин до **2026-06-15**.

После этой даты Anthropic разделяет billing: `claude -p` (Agent SDK) уходит в отдельный $200/мес pool, отдельный от Max. Любой `claude -p` spawn = расход из SDK pool. Старая gateway-архитектура перестанет быть экономичной.

> **Linux vs macOS:** этот документ написан для Linux/systemd (типичный VPS-кейс — Hetzner/Timeweb/etc). Если ваш старый gateway крутится на **Mac mini под launchd** — последовательность шагов та же, но команды управления другие:
> - `systemctl stop/start/restart` → `launchctl bootout / bootstrap / kickstart -k`
> - `journalctl -u <unit>` → `tail ~/Library/Logs/<...>/.log`
> - `/etc/systemd/system/*.service` → `~/Library/LaunchAgents/*.plist`
> - `/etc/dashi-plugin/` → `~/.claude-lab/<agent>/secrets/`
>
> Полная таблица соответствия — [05-troubleshooting.md → OS-specific команды](05-troubleshooting.md#os-specific-команды-linux-vs-macos). После прочтения этого migration guide → переходите к [03-installation-macos.md](03-installation-macos.md) для launchd-специфики установки нового плагина.

## Перед стартом

1. **Сделайте полный backup** — gateway процесс, workspace, секреты, systemd/launchd конфиги:
   ```bash
   sudo tar czf /var/backups/pre-plugin-migration-$(date +%Y%m%d).tgz \
     ~/jarvis-telegram-gateway \
     ~/.claude-lab \
     /etc/systemd/system/*gateway*.service \
     /etc/dashi-plugin
   ```

2. **Освободите окно тишины.** Миграция занимает ~30-60 минут на одного агента, в течение этого времени бот не отвечает пользователям. Предупредите всех кто пользуется ботом.

3. **Подготовьте rollback заранее.** Знайте как откатиться (см. секцию «Откат» в конце).

---

## Шаг 1. Inventory текущего setup

Выясните что у вас работает сейчас:

```bash
# Какой systemd unit запускает gateway?
sudo systemctl list-units --type=service | grep -iE "gateway|jarvis"

# Какой токен он использует?
sudo systemctl cat <gateway-unit> | grep -E "EnvironmentFile|Environment"
# затем cat этого env-файла (НЕ выводя в Telegram!)

# Какой Python-скрипт спавнит claude -p?
ps -ef | grep -E "python.*gateway|claude.*-p" | grep -v grep

# Где лежит workspace?
sudo systemctl cat <gateway-unit> | grep -E "WorkingDirectory|--workspace|--add-dir"
```

Запишите 4 вещи:
- Bot token (`TELEGRAM_BOT_TOKEN`)
- Allowed user IDs (`TELEGRAM_ALLOWED_USER_IDS` или эквивалент)
- Workspace path (старый, гдe gateway запускал `claude -p`)
- Name systemd unit'а (`<gateway-unit-name>`)

---

## Шаг 2. Установите плагин **рядом** (не вместо)

Старый gateway пока продолжает работать. Плагин ставим параллельно с тестовым ботом или с тем же ботом но через ВРЕМЕННО off на gateway.

Полная установка — [03-installation.md](03-installation.md). Здесь — только различия.

### Если переезжаете с одного и того же бот-токеном

```bash
# Скопируйте env с того же токена
sudo cp /etc/dashi-plugin/<agent>/channel.env.from-gateway /etc/dashi-plugin/<agent>/channel.env
sudo $EDITOR /etc/dashi-plugin/<agent>/channel.env

# Адаптируйте имена переменных — см. таблицу маппинга ниже
```

Маппинг env-переменных:

| Gateway (Python) | Plugin (channel.env) | Примечание |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `TELEGRAM_BOT_TOKEN` | Без изменений |
| `ALLOWED_USER_IDS` | `TELEGRAM_ALLOWED_USER_IDS` | Префикс `TELEGRAM_` |
| `ALLOWED_GROUP_IDS` | `TELEGRAM_ALLOWED_CHAT_IDS` | Имя сменилось |
| `WORKSPACE_DIR` | `TELEGRAM_WORKSPACE_ROOT` | Указывает на ваш `<agent>/.claude/` |
| `LOG_DIR` | `TELEGRAM_STATE_DIR` + `logs/` | State-каталог теперь шире |
| `WEBHOOK_PORT` | `TELEGRAM_WEBHOOK_PORT` | Префикс `TELEGRAM_` |
| (нет) | `TELEGRAM_EXPECTED_BOT_ID` | НОВОЕ — anti-spoof. Числовая часть `TELEGRAM_BOT_TOKEN` до `:` |
| (нет) | `AGENT_ID` | НОВОЕ — для маршрутизации (`alice`, `bob`, etc.) |

### Если используете отдельный test bot для миграции

Создайте новый бот у [@BotFather](https://t.me/BotFather), пропишите его токен в `channel.env`. Тестируйте плагин на нём в полной изоляции от production gateway. Когда уверены — поменяете токен на production в одной транзакции (см. Шаг 4).

---

## Шаг 3. Перенос workspace и CLAUDE.md

Старый gateway работал из своего рабочего каталога. Плагин **обязан** запускаться из workspace агента, см. [02-where-to-place-plugin.md](02-where-to-place-plugin.md).

```bash
# Если старого workspace ещё нет в каноническом месте:
sudo -u <service-user> mkdir -p /home/<service-user>/.claude-lab/<agent>/.claude

# Перенос CLAUDE.md
sudo cp <старый-workspace>/CLAUDE.md /home/<service-user>/.claude-lab/<agent>/.claude/
sudo chown -R <service-user>:<service-user> /home/<service-user>/.claude-lab/<agent>

# Перенос core/ (если есть)
sudo cp -a <старый-workspace>/core /home/<service-user>/.claude-lab/<agent>/.claude/

# Перенос .mcp.json (если есть)
sudo cp <старый-workspace>/.mcp.json /home/<service-user>/.claude-lab/<agent>/.claude/
```

Откат: ничего не удалили из старого пути — gateway по-прежнему может его читать.

---

## Шаг 4. Cutover

Когда плагин протестирован (написали боту, получили ответ, identity ок) — выключаем gateway и переводим production на плагин.

**Порядок критичен** — нельзя оставлять оба процесса слушать один токен (см. [05-troubleshooting.md → Проблема 3](05-troubleshooting.md#проблема-3-getupdates-conflict--две-сессии-слушают-одного-бота)):

```bash
# 1. STOP старого gateway
sudo systemctl stop <gateway-unit>
sudo systemctl disable <gateway-unit>

# 2. Подождите 30 сек — Telegram сбросит сторону "старого" клиента
sleep 30

# 3. START нового плагина (если ещё не запущен)
sudo systemctl restart channel-<agent>

# 4. Проверьте tmux на welcome-промты, нажмите Enter если есть
sudo -u <service-user> tmux capture-pane -t channel-<agent> -p | tail -30
# если welcome — sudo -u <service-user> tmux attach + Enter

# 5. Smoke в Telegram — напишите боту, должен ответить
```

---

## Шаг 5. Verify identity и memory parity

Самая частая ошибка после миграции: бот отвечает, но как «default Claude» без identity (см. [05 → Проблема 2](05-troubleshooting.md#проблема-2-identity-drift--агент-отвечает-как-default-claude)).

Чек-лист:

```bash
# 1. Через tmux
sudo -u <service-user> tmux attach -t channel-<agent>
# /memory  — должны быть оба CLAUDE.md (глобальный + project)

# 2. Через бота
# Напишите: «Кто ты? Откуда твои инструкции?»
# Должен ответить именем агента + ссылкой на CLAUDE.md path
```

Если identity нет — `WorkingDirectory=` в systemd указывает не туда. Поправьте, `daemon-reload`, `restart`.

---

## Шаг 6. Hook integration (если использовали в gateway)

Старый gateway мог писать turn'ы в `recent.md` через свой механизм. Плагин делает это через Claude Code hooks. Установите их:

```bash
sudo -u <service-user> bash /home/<service-user>/.claude-lab/<agent>/.claude/dashi-plugin-claude-code/plugin/scripts/install-hooks.sh \
  --settings /home/<service-user>/.claude/settings.json \
  --chat-id <your-chat-id> \
  --webhook-url http://127.0.0.1:8089/hooks/agent \
  --agent-id <agent>
sudo systemctl restart channel-<agent>
```

Проверьте что после нескольких сообщений `<workspace>/core/hot/recent.md` пополняется.

---

## Шаг 7. Удаление gateway (через 7-14 дней)

**Не удаляйте сразу.** Дайте плагину 1-2 недели поработать в production. Если за это время не было критичных багов — удалите gateway:

```bash
# Backup ещё раз перед удалением
sudo tar czf /var/backups/gateway-final-$(date +%Y%m%d).tgz \
  ~/jarvis-telegram-gateway \
  /etc/systemd/system/<gateway-unit>.service

# Удаление
sudo rm /etc/systemd/system/<gateway-unit>.service
sudo systemctl daemon-reload
sudo rm -rf ~/jarvis-telegram-gateway
```

Старый workspace (если он отдельный от нового) — оставьте ещё на месяц, для подстраховки.

---

## Откат

Если плагин сломался и нужно срочно вернуть gateway:

```bash
# 1. Stop плагин
sudo systemctl stop channel-<agent>

# 2. Подождите 30 сек
sleep 30

# 3. Start gateway
sudo systemctl start <gateway-unit>

# 4. Smoke в Telegram
```

Backup восстановление:

```bash
sudo tar xzf /var/backups/pre-plugin-migration-<date>.tgz -C /
sudo systemctl daemon-reload
sudo systemctl restart <gateway-unit>
```

---

## Чек-лист миграции

- [ ] Backup сделан, путь записан
- [ ] Inventory старого setup (токен, allowed_ids, workspace, unit name)
- [ ] Service-user готов
- [ ] Claude Code v2.1+ и Bun 1.3+ установлены
- [ ] Плагин склонирован внутрь `~/.claude-lab/<agent>/.claude/`
- [ ] `bun test` прошёл
- [ ] `channel.env` создан с правильным маппингом env-переменных
- [ ] `CLAUDE.md`, `core/`, `.mcp.json` перенесены в workspace
- [ ] systemd unit написан, `WorkingDirectory=` внутрь plugin/
- [ ] (опционально) `~/.claude/settings.json` имеет `hasTrustDialogAccepted: true`
- [ ] Cutover: gateway stopped → 30s wait → plugin started
- [ ] Welcome-промты пройдены через tmux
- [ ] Smoke ping в Telegram прошёл
- [ ] Identity verify через `/memory` или ping
- [ ] Hooks установлены, после нескольких turn'ов `recent.md` пополняется
- [ ] План удаления старого gateway — через 7-14 дней

После 2026-06-15 миграция вынужденная — старый gateway станет дорогим. Лучше переехать в мае-начале июня.
