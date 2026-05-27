# Установка на macOS (launchd)

> **Linux пользователь?** → [03-installation-linux.md](03-installation-linux.md)
> **Не уверены какой OS выбрать?** → [03-installation.md](03-installation.md)

Этот документ описывает установку плагина на macOS (Mac mini, MacBook, iMac) под управлением **launchd**. Для разработки в одиночку (запуск из терминала) достаточно Quick Start в [README.md](../README.md).

**Перед чтением:** убедитесь что прочитали [02-where-to-place-plugin.md](02-where-to-place-plugin.md). Без понимания CWD дальнейшие шаги не имеют смысла.

---

## Требования

| Компонент | Версия | Установка |
|---|---|---|
| macOS | 13 Ventura+ | — |
| Homebrew | свежий | `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` |
| Claude Code | v2.1+ | `brew install --cask claude-code` или скачать с code.claude.com |
| Bun | 1.3.14+ | `brew install oven-sh/bun/bun` |
| tmux | 3.x | `brew install tmux` |

Anthropic Max subscription нужна для агента (Claude.app login). Установка плагина её не покрывает — это ваша подписка.

> **Важное про single-user конвенцию macOS:** на Mac mini вы обычно работаете под одним основным пользователем (вашим GUI login). Создание отдельного `agentctl` user — overkill. В этой инструкции всё работает под **вашим основным user**. Если хотите изоляции — создайте отдельный macOS account через System Settings → Users & Groups → Add User (и адаптируйте пути).

---

## Шаг 1. Подготовка workspace

```bash
mkdir -p ~/.claude-lab/myagent/.claude
mkdir -p ~/.claude-lab/myagent/secrets
mkdir -p ~/.claude-lab/myagent/scripts
mkdir -p ~/.claude-lab/shared/state/myagent/telegram
mkdir -p ~/Library/Logs/dashi-plugin
```

На Mac mini нет `/home/` — пути начинаются с `/Users/<you>/`. Tilde `~` раскроется правильно.

---

## Шаг 2. Залогиньте Claude Code в Max

```bash
claude
# пройдите OAuth flow в браузере, после успеха exit
```

Login сохраняется в `~/.claude/` под вашим user.

---

## Шаг 3. Клонируйте плагин внутрь workspace

```bash
cd ~/.claude-lab/myagent/.claude
git clone https://github.com/qwwiwi/dashi-plugin-claude-code.git
cd dashi-plugin-claude-code/plugin
bun install
bun run typecheck    # должно пройти без ошибок
bun test             # 425 pass
```

Если `bun test` падает — НЕ продолжайте. Откройте issue.

---

## Шаг 4. Создайте `CLAUDE.md` агента

Минимальный `CLAUDE.md` (`~/.claude-lab/myagent/.claude/CLAUDE.md`):

```markdown
# MyAgent

## Identity
Я — MyAgent, AI-помощник <ваше имя>.
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

---

## Шаг 5. Telegram бот и channel.env

В Telegram у [@BotFather](https://t.me/BotFather) создайте нового бота, получите `bot_token`.

```bash
cp ~/.claude-lab/myagent/.claude/dashi-plugin-claude-code/examples/channel.env.example \
   ~/.claude-lab/myagent/secrets/channel.env
chmod 600 ~/.claude-lab/myagent/secrets/channel.env
$EDITOR ~/.claude-lab/myagent/secrets/channel.env
```

Заполните минимум (адаптировано под macOS пути):

```bash
TELEGRAM_BOT_TOKEN=123456789:AAH...
TELEGRAM_EXPECTED_BOT_ID=123456789
TELEGRAM_ALLOWED_USER_IDS=164795011
TELEGRAM_ALLOWED_CHAT_IDS=164795011
TELEGRAM_STATE_DIR=/Users/<you>/.claude-lab/shared/state/myagent/telegram
TELEGRAM_WORKSPACE_ROOT=/Users/<you>/.claude-lab/myagent/.claude
AGENT_ID=myagent
```

Узнать свой Telegram `user_id` — напишите [@userinfobot](https://t.me/userinfobot).

`TELEGRAM_EXPECTED_BOT_ID` — числовая часть до `:` в `TELEGRAM_BOT_TOKEN`. Используется для anti-spoof.

`chmod 600` — только вы можете читать. Не `640` как в Linux, потому что нет отдельной service-group.

---

## Шаг 6. Wrapper-скрипт и launchd plist

**Почему два файла, а не один inline `sh -c` в plist:** Claude Code требует TTY (поэтому tmux), а tmux-сессию нужно запустить **detached** (`new-session -d`), чтобы launchd не висел на foreground tmux client. При этом launchd должен супервизить **живой** PID — иначе KeepAlive/Restart работают неправильно. Прежний inline-вариант (`exec tmux new-session -d ...; sleep; send-keys`) был сломан: `exec` подменяет shell процессом tmux client, который сразу завершается с success после detach, и команды `sleep; send-keys` после `exec` никогда не запускаются. Wrapper-скрипт решает обе проблемы: source-ит env, стартует tmux, шлёт Enter в welcome-промты, и блокируется на polling пока tmux-сессия жива.

### 6.1. Wrapper-скрипт

Скопируйте example и подставьте свои значения:

```bash
cp ~/.claude-lab/myagent/.claude/dashi-plugin-claude-code/examples/launchd-wrapper.sh.example \
   ~/.claude-lab/myagent/scripts/launchd-wrapper.sh
chmod +x ~/.claude-lab/myagent/scripts/launchd-wrapper.sh
$EDITOR ~/.claude-lab/myagent/scripts/launchd-wrapper.sh
```

В скрипте замените `<you>` на ваш macOS username, `<agent>` на имя агента, и проверьте `TMUX_BIN` (Apple Silicon: `/opt/homebrew/bin/tmux`, Intel: `/usr/local/bin/tmux`).

Минимальный рабочий wrapper:

```sh
#!/bin/sh
set -eu

AGENT="myagent"
USER_HOME="/Users/<you>"
ENV_FILE="${USER_HOME}/.claude-lab/${AGENT}/secrets/channel.env"
TMUX_SESSION="channel-${AGENT}"
TMUX_BIN="/opt/homebrew/bin/tmux"
CLAUDE_CMD="claude --dangerously-load-development-channels server:dashi-channel"

log() { printf '[%s] launchd-wrapper: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

# Source secrets без коммита в plist
if [ -f "${ENV_FILE}" ]; then
  set -a; . "${ENV_FILE}"; set +a
else
  log "FATAL: env file not found: ${ENV_FILE}"
  exit 78
fi

# Кill stale session если предыдущий запуск не сделал cleanup
if "${TMUX_BIN}" has-session -t "${TMUX_SESSION}" 2>/dev/null; then
  "${TMUX_BIN}" kill-session -t "${TMUX_SESSION}" 2>/dev/null || true
fi

# EXPECTED_SHUTDOWN: ставится в 1 при operator-initiated stop (SIGTERM от launchctl)
# Используется ниже чтобы различить graceful stop и unexpected tmux death.
EXPECTED_SHUTDOWN=0

# Trap для graceful shutdown по SIGTERM от launchctl
cleanup() {
  EXPECTED_SHUTDOWN=1
  log "cleanup: killing tmux session (operator-initiated)"
  "${TMUX_BIN}" kill-session -t "${TMUX_SESSION}" 2>/dev/null || true
  exit 0
}
trap cleanup TERM INT

# Стартуем claude в detached tmux
"${TMUX_BIN}" new-session -d -s "${TMUX_SESSION}" "${CLAUDE_CMD}"

# Welcome-промты (фоном, безвредны если persistent approvals уже записаны)
(
  sleep 6
  "${TMUX_BIN}" send-keys -t "${TMUX_SESSION}" Enter 2>/dev/null || true
  sleep 2
  "${TMUX_BIN}" send-keys -t "${TMUX_SESSION}" Enter 2>/dev/null || true
) &

# Foreground supervisor: блокируемся пока tmux session жива
log "supervising tmux session '${TMUX_SESSION}' (pid wrapper=$$)"
while "${TMUX_BIN}" has-session -t "${TMUX_SESSION}" 2>/dev/null; do
  sleep 5
done

# Различаем operator-stop (exit 0, мы здесь не окажемся — cleanup сделал exit 0)
# и unexpected tmux death (exit 1 → launchd KeepAlive.SuccessfulExit=false respawn-ит).
if [ "${EXPECTED_SHUTDOWN}" = "1" ]; then
  log "tmux session ended (expected), wrapper exiting 0"
  exit 0
fi
log "tmux session died unexpectedly, wrapper exiting 1 (launchd will respawn)"
exit 1
```

**Exit-code matrix (важно для launchd):**

| Сценарий | EXPECTED_SHUTDOWN | Exit | Действие launchd |
|---|---|---|---|
| `launchctl kill SIGTERM` (operator stop) | 1 (trap) | 0 | НЕ respawn |
| Claude crash / kill-session / OOM | 0 | 1 | respawn через ThrottleInterval |
| Отсутствует `channel.env` | n/a | 78 | respawn (лечить env, не плагином) |

Полная версия с дополнительными комментариями — `examples/launchd-wrapper.sh.example`.

### 6.2. Plist (вызывает wrapper)

```bash
mkdir -p ~/Library/LaunchAgents
cp ~/.claude-lab/myagent/.claude/dashi-plugin-claude-code/examples/launchd-plist.example.plist \
   ~/Library/LaunchAgents/com.dashi-plugin.channel-myagent.plist
$EDITOR ~/Library/LaunchAgents/com.dashi-plugin.channel-myagent.plist
```

Замените все вхождения `<you>` на ваш macOS username, `myagent` на имя агента. Убедитесь что `WorkingDirectory` указывает внутрь `plugin/`.

Минимальный рабочий plist:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.dashi-plugin.channel-myagent</string>

    <key>ProgramArguments</key>
    <array>
        <string>/Users/&lt;you&gt;/.claude-lab/myagent/scripts/launchd-wrapper.sh</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/Users/&lt;you&gt;/.claude-lab/myagent/.claude/dashi-plugin-claude-code/plugin</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/Users/&lt;you&gt;</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/&lt;you&gt;/.bun/bin</string>
        <key>LANG</key>
        <string>en_US.UTF-8</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>15</integer>

    <key>ExitTimeOut</key>
    <integer>30</integer>

    <key>StandardOutPath</key>
    <string>/Users/&lt;you&gt;/Library/Logs/dashi-plugin/channel-myagent.out.log</string>

    <key>StandardErrorPath</key>
    <string>/Users/&lt;you&gt;/Library/Logs/dashi-plugin/channel-myagent.err.log</string>

    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
```

**Различия от systemd-варианта:**

- `ProgramArguments` — путь к wrapper-скрипту (один аргумент). Wrapper делает то, что в systemd делают `ExecStart` + `ExecStartPost` + `ExecStop` вместе.
- `EnvironmentVariables` — dict внутри plist для non-secret. Bot token и т.п. wrapper source-ит из `channel.env` (плeist читается любым процессом этого user).
- `KeepAlive.SuccessfulExit=false` — respawn только если предыдущий exit был НЕ 0. Wrapper выходит с exit 0 при operator-initiated stop (SIGTERM от `launchctl kill` → trap cleanup) и с exit 1 при unexpected tmux death (claude crash, manual `tmux kill-session`, OOM). Так launchd корректно различает: оператор остановил → НЕ респавнить; tmux умер сам по себе → респавнить через ThrottleInterval.
- `RunAtLoad=true` — запуск при загрузке plist (вход в систему GUI user).
- `ExitTimeOut=30` — даём wrapper-у 30 сек на trap-cleanup перед SIGKILL.
- `WorkingDirectory` — критично, как и в systemd. **Внутрь `plugin/`**.

> **Tmux путь:** Homebrew на Apple Silicon ставит в `/opt/homebrew/bin/tmux`, на Intel — в `/usr/local/bin/tmux`. Проверьте `which tmux` в обоих файлах (wrapper и `PATH` в plist).

> **Migration note (от `Crashed=true` к `SuccessfulExit=false`):** Если вы устанавливали плагин ДО этого изменения, ваш plist содержит `<key>Crashed</key><true/>`. Эта семантика **не покрывала** случай, когда wrapper детектил мёртвую tmux и сам выходил с exit 1 (не сигналом) — launchd считал это «штатным завершением» и НЕ перезапускал agent. После claude crash вы получали тихо лежащий сервис. Новая семантика `SuccessfulExit=false` респавнит на ЛЮБОМ non-zero exit. Чтобы мигрировать: замените блок `KeepAlive` в `~/Library/LaunchAgents/com.dashi-plugin.channel-myagent.plist` на новый, обновите wrapper из `examples/launchd-wrapper.sh.example`, затем `launchctl bootout ... && launchctl bootstrap ...` для перезагрузки plist.

---

## Шаг 7. Загрузка и старт

```bash
# Загрузить plist (даёт launchd о нём знать)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dashi-plugin.channel-myagent.plist

# Запустить (если RunAtLoad сработал — уже запущен)
launchctl kickstart gui/$(id -u)/com.dashi-plugin.channel-myagent

# Проверить статус
launchctl print gui/$(id -u)/com.dashi-plugin.channel-myagent | head -20
```

`state = running` и `pid = <число>` — успех.

---

## Шаг 8. Прохождение welcome-промтов

При **первом** запуске Claude Code задаст 2 интерактивных вопроса:

1. «Allow external CLAUDE.md file imports?» → `1` (Yes)
2. «--dangerously-load-development-channels» → `1` (I am using this for local development)

Plist через `tmux send-keys` отправит два Enter автоматически (см. ProgramArguments). Если что-то не сработало:

```bash
tmux attach -t channel-myagent
# увидите промт — нажмите Enter
# detach: Ctrl-B затем D
```

Должны увидеть строку `Listening for channel messages from: server:dashi-channel`.

### Persistent welcome approvals

В `~/.claude/settings.json` (под вашим user, не root):

```json
{
  "hasTrustDialogAccepted": true,
  "dangerouslyLoadDevelopmentChannelsAccepted": true,
  "externalImportsAccepted": true
}
```

Точные ключи зависят от версии Claude Code — проверьте `~/.claude/settings.json` после первого ручного прохождения, скопируйте появившиеся ключи.

---

## Шаг 9. Smoke test

Напишите боту в Telegram любое сообщение. Должны увидеть:

1. **Реакция 👀** на ваше сообщение (через ~1 сек)
2. **«печатает...»** в шапке чата
3. **Реакция ⚙️** когда агент начинает использовать инструменты
4. **Ответ** агента
5. **Реакция ✅** на ваше сообщение

Если ничего не пришло:

```bash
# 1. launchd состояние
launchctl print gui/$(id -u)/com.dashi-plugin.channel-myagent | head -30

# 2. tmux — не висит ли на welcome
tmux capture-pane -t channel-myagent -p -S -50 | tail -30

# 3. Логи
tail -50 ~/Library/Logs/dashi-plugin/channel-myagent.err.log
tail -50 ~/Library/Logs/dashi-plugin/channel-myagent.out.log

# 4. Telegram очередь
TOKEN=$(grep TELEGRAM_BOT_TOKEN ~/.claude-lab/myagent/secrets/channel.env | cut -d= -f2-)
curl -s "https://api.telegram.org/bot${TOKEN}/getUpdates?limit=5&timeout=0" | jq .
```

Если что-то не так — [05-troubleshooting.md](05-troubleshooting.md).

---

## Шаг 10. Hook integration (опционально)

```bash
bash ~/.claude-lab/myagent/.claude/dashi-plugin-claude-code/plugin/scripts/install-hooks.sh \
  --settings ~/.claude/settings.json \
  --chat-id <your-telegram-chat-id> \
  --webhook-url http://127.0.0.1:8089/hooks/agent \
  --agent-id myagent
launchctl kickstart -k gui/$(id -u)/com.dashi-plugin.channel-myagent
```

`kickstart -k` = принудительный рестарт (SIGTERM текущий процесс, перезапуск через launchd).

---

## Управление сервисом — команды

| Действие | Команда |
|---|---|
| Старт (вручную, если RunAtLoad не сработал) | `launchctl kickstart gui/$(id -u)/com.dashi-plugin.channel-myagent` |
| Принудительный рестарт | `launchctl kickstart -k gui/$(id -u)/com.dashi-plugin.channel-myagent` |
| Стоп (текущий запуск, plist остаётся загружен) | `launchctl kill SIGTERM gui/$(id -u)/com.dashi-plugin.channel-myagent` |
| Полностью убрать из launchd | `launchctl bootout gui/$(id -u)/com.dashi-plugin.channel-myagent` |
| Перезагрузить plist (после правки файла) | `launchctl bootout ... && launchctl bootstrap ...` |
| Статус | `launchctl print gui/$(id -u)/com.dashi-plugin.channel-myagent` |
| Логи stdout | `tail -f ~/Library/Logs/dashi-plugin/channel-myagent.out.log` |
| Логи stderr | `tail -f ~/Library/Logs/dashi-plugin/channel-myagent.err.log` |
| Tmux сессия | `tmux attach -t channel-myagent` (detach Ctrl-B D) |

> **Принципиальная разница vs systemd:** launchd plist работает в **GUI session** вашего user. Если вы logout из macOS (или Mac mini перезагрузился без auto-login) — агент **не запустится** пока вы не войдёте обратно. Для запуска до login — переместить plist в `/Library/LaunchDaemons/` (требует sudo + root ownership), но это уже другая модель (root daemon, не user agent).

---

## Mac mini «домашний сервер» — рекомендации

Если Mac mini стоит включённым 24/7 как сервер:

1. **Auto-login:** System Settings → Users & Groups → Login Options → Automatic login as `<you>` (так после reboot launchd сразу поднимет агентов)
2. **Prevent sleep:** `pmset -a sleep 0 displaysleep 1` (Mac не уйдёт в сон, экран потушится)
3. **Tailscale + ssh** для удалённого доступа без открытия портов наружу
4. **Time Machine** на внешний диск — снапшоты `~/.claude-lab/` сохраняются автоматически
5. **Не используйте FileVault** на головном диске если хотите чтобы агенты стартовали ДО ввода пароля (FileVault блокирует boot до auth)

---

## Backup

```bash
tar czf ~/Backups/myagent-$(date +%Y%m%d-%H%M).tgz \
  ~/.claude-lab/myagent \
  ~/Library/LaunchAgents/com.dashi-plugin.channel-myagent.plist
```

Восстановление: tar xzf, потом `launchctl bootstrap` (если был bootout).

---

## Update плагина

```bash
launchctl kill SIGTERM gui/$(id -u)/com.dashi-plugin.channel-myagent
cd ~/.claude-lab/myagent/.claude/dashi-plugin-claude-code
git pull
cd plugin
bun install
bun test
launchctl kickstart gui/$(id -u)/com.dashi-plugin.channel-myagent
```

Если `bun test` упал — `git reset --hard HEAD~1`.

---

## Готово

Дальше — [05-troubleshooting.md](05-troubleshooting.md) когда что-то сломается, и [04-migration-from-gateway.md](04-migration-from-gateway.md) если переезжаете со старого `claude -p` gateway.
