# Установка на macOS (launchd)

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
Установщик запускает `bun install`, ставит обычные hooks плагина, создаёт config,
launchd plist и wrapper с автономным профилем, затем показывает сводку doctor.
Перед заменой файлов создаются копии с датой. `--dry-run` ничего не записывает.

Без `--start` plist только записывается в
`~/Library/LaunchAgents/com.dashi-plugin.channel-myagent.plist` и не загружается
в launchd. Для регистрации и первого запуска выполните установщик с `--start`
либо его напечатанную команду:

```bash
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.dashi-plugin.channel-myagent.plist"
```

После регистрации `RunAtLoad` запускает агента при входе GUI-пользователя,
`KeepAlive` перезапускает после сбоя. Это LaunchAgent пользователя: после
перезагрузки нужен вход в его macOS account. Wrapper и приватный `channel.env`
находятся в каталоге состояния (по умолчанию `~/.claude/channels/myagent/`).

Для автоматизации: `--agent NAME --workspace PATH --owner-id ID --non-interactive`;
токен передайте через `TELEGRAM_BOT_TOKEN`, ID можно через `TELEGRAM_OWNER_ID`.
Флага `--bot-token` нет: токен в argv виден в `ps` и остаётся в истории команд, установщик его отклоняет.
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

## Autonomy
- Выполняю обычную работу самостоятельно, без запросов подтверждения

## Boundaries
- Никогда не вывожу и не коммичу секреты
- Разрушительное удаление и force-push — только по явному указанию владельца
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
TELEGRAM_ALLOWED_USER_IDS=123456789
TELEGRAM_ALLOWED_CHAT_IDS=123456789
TELEGRAM_STATE_DIR=/Users/<you>/.claude-lab/shared/state/myagent/telegram
TELEGRAM_WORKSPACE_ROOT=/Users/<you>/.claude-lab/myagent/.claude
TELEGRAM_WEBHOOK_HOST=127.0.0.1
TELEGRAM_WEBHOOK_PORT=8089             # default port for hook receiver (Шаг 10)
AGENT_ID=myagent
```

Узнать свой Telegram `user_id` — напишите [@userinfobot](https://t.me/userinfobot).

`TELEGRAM_EXPECTED_BOT_ID` — числовая часть до `:` в `TELEGRAM_BOT_TOKEN`. Используется для anti-spoof.

`TELEGRAM_WEBHOOK_PORT=8089` — порт, на котором плагин слушает Claude Code hooks (PreToolUse/PostToolUse/Stop/UserPromptSubmit/SessionStart). Меняйте только если у вас несколько агентов на одной машине и порт 8089 уже занят — тогда подставьте свободный (например 8090, 8091, …) и не забудьте передать его в `install-hooks.sh --webhook-url` (Шаг 10).

`chmod 600` — только вы можете читать. Не `640` как в Linux, потому что нет отдельной service-group.

> **Telegram output formatting** (как агент пишет в чат — markdown/HTML, redactor) — см. [03-installation.md → Telegram output formatting](03-installation.md#telegram-output-formatting). OS-agnostic, поведение одинаковое на Linux и macOS.

---

## Шаг 6. Wrapper и launchd plist

Launchd должен наблюдать живой foreground-процесс. Общий wrapper из
`examples/launchd-wrapper.sh.example` запускает detached tmux, отслеживает его
сессию и выходит с кодом 1 при её неожиданном завершении. SIGTERM от launchd
останавливает tmux и завершает wrapper с кодом 0.

Текущие шаблоны используют placeholders `<env-file-shell>`, `<session-shell>`,
`<tmux-shell>`, `<workspace-shell>`, `<claude-command-shell>` в wrapper и
`<agent>`, `<wrapper>`, `<plugin-dir>`, `<home>`, `<path>`, `<state-dir>` в plist.
В них требуется разное экранирование shell/XML. Renderer подставляет их безопасно;
не копируйте неотрендеренный шаблон непосредственно в LaunchAgents.
Он не устанавливает зависимости и hooks и не загружает plist в launchd.

```bash
# Выполняйте под пользователем агента, не root; замените myagent своим именем.
export INSTALL_AGENT=myagent
export INSTALL_WORKSPACE="$HOME/.claude-lab/myagent/.claude"
export INSTALL_REPO="$INSTALL_WORKSPACE/dashi-plugin-claude-code"
export INSTALL_STATE_DIR="$HOME/.claude-lab/shared/state/myagent/telegram"
export INSTALL_SETTINGS="$HOME/.claude/settings.json"
export INSTALL_PLATFORM=Darwin
export INSTALL_HOME="$HOME"
export INSTALL_CLAUDE="$(command -v claude)"
export INSTALL_TMUX="$(command -v tmux)"
export INSTALL_BUN="$(command -v bun)"
mkdir -p "$INSTALL_STATE_DIR"
# Существующий приватный env сохраняется; для новой установки копируем из шага 5.
if [[ ! -f "$INSTALL_STATE_DIR/channel.env" ]]; then
  install -m 600 "$HOME/.claude-lab/myagent/secrets/channel.env" "$INSTALL_STATE_DIR/channel.env"
fi
read -r -p 'Telegram owner ID (numeric): ' TELEGRAM_OWNER_ID
export TELEGRAM_OWNER_ID
bun "$INSTALL_REPO/scripts/render-install.ts"
```

Существующие config/env сохраняются; перед заменой wrapper/plist делаются копии
с датой. Проверьте в приватном `$INSTALL_STATE_DIR/channel.env`, что
`TELEGRAM_STATE_DIR` равен этому каталогу, `TELEGRAM_WORKSPACE_ROOT` — workspace
из команды выше. Если задан `TELEGRAM_CONFIG_FILE`, укажите `$INSTALL_STATE_DIR/config.json`
и поместите используемый config в этот файл.
Перед ручной правкой сделайте копию файла с датой. Owner ID должен быть разрешён
существующими config/env; несоответствие renderer отклонит.

Renderer создаёт `$INSTALL_STATE_DIR/channel-wrapper.sh`, отдельный MCP config,
`install.json` и `~/Library/LaunchAgents/com.dashi-plugin.channel-myagent.plist`.
`ProgramArguments` содержит абсолютный путь к wrapper, без токена. Wrapper
открывает Claude Code в workspace через `tmux new-session -c`; команда внутри
pane читает приватный env заново, даже если tmux server существовал раньше.
Supervisor CWD остаётся `plugin/`, MCP использует абсолютные пути.

По умолчанию используется `--permission-mode bypassPermissions`. Для подтверждений
уберите этот флаг из `CLAUDE_CMD` в сгенерированном wrapper; permission gate
подключается отдельно через `install-hooks.sh --permission-gate` и
`permission_gate.enabled=true`.

Проверьте plist и wrapper перед загрузкой:

```bash
plutil -lint "$HOME/Library/LaunchAgents/com.dashi-plugin.channel-myagent.plist"
bash -n "$INSTALL_STATE_DIR/channel-wrapper.sh"
```

| Сценарий | Exit wrapper | Действие launchd |
|---|---|---|
| SIGTERM от оператора | 0 | Не перезапускать |
| Неожиданное завершение tmux/Claude | 1 | Перезапуск через 15 секунд |
| Отсутствует приватный env | 78 | Повторный запуск; исправьте env |

`RunAtLoad=true` запускает агента после загрузки plist и при входе пользователя.
`KeepAlive.SuccessfulExit=false` покрывает non-zero exit wrapper, включая потерю
сессии; `ExitTimeOut=30` даёт время на остановку. При обновлении старого plist
с `Crashed=true` замените его сгенерированным вариантом, затем из отдельного
терминала выполните `launchctl bootout` и `launchctl bootstrap` с вашим полным
service target и путём plist. Crash recovery не подтверждает готовность Telegram:
после запуска нужен реальный DM.

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

Wrapper отправит два Enter автоматически. Если промт появился позже или не был принят:

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
tail -50 ~/.claude-lab/shared/state/myagent/telegram/channel.err.log
tail -50 ~/.claude-lab/shared/state/myagent/telegram/channel.out.log

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
| Логи stdout | `tail -f ~/.claude-lab/shared/state/myagent/telegram/channel.out.log` |
| Логи stderr | `tail -f ~/.claude-lab/shared/state/myagent/telegram/channel.err.log` |
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

## Логи и state канонические пути

launchd, плагин и Claude Code пишут в три разных места — supervisor stdout/stderr, plugin state dir, tmux pane history. Когда что-то ломается, открывайте в этом порядке:

| Что | Где (macOS launchd) | Команда просмотра |
|---|---|---|
| Supervisor stdout (wrapper + Claude Code) | `<state-dir>/channel.out.log` (через `StandardOutPath` в plist) | `tail -200 ~/.claude-lab/shared/state/myagent/telegram/channel.out.log` |
| Supervisor stderr | `<state-dir>/channel.err.log` (через `StandardErrorPath`) | `tail -200 ~/.claude-lab/shared/state/myagent/telegram/channel.err.log` |
| Live tail (оба) | то же | `tail -f ~/.claude-lab/shared/state/myagent/telegram/channel.{out,err}.log` |
| launchd state агента (PID, последний exit, ThrottleInterval) | launchd in-memory | `launchctl print gui/$(id -u)/com.dashi-plugin.channel-myagent` |
| **`bot.pid`** (PID Bun процесса) | `${TELEGRAM_STATE_DIR}/bot.pid` | `cat ~/.claude-lab/shared/state/myagent/telegram/bot.pid` |
| **`access.json`** (multichat allowlist runtime state) | `${TELEGRAM_STATE_DIR}/access.json` | `jq . ~/.claude-lab/shared/state/myagent/telegram/access.json` |
| **`update-offset`** (Telegram getUpdates offset) | `${TELEGRAM_STATE_DIR}/update-offset` | `cat ~/.claude-lab/shared/state/myagent/telegram/update-offset` |
| **`dead-letter/`** (сообщения, которые не удалось доставить) | `${TELEGRAM_STATE_DIR}/dead-letter/` | `ls -la ~/.claude-lab/shared/state/myagent/telegram/dead-letter/` |
| **`permissions.jsonl`** (журнал allowlist-решений) | `${TELEGRAM_STATE_DIR}/logs/permissions.jsonl` | `tail -50 ~/.claude-lab/shared/state/myagent/telegram/logs/permissions.jsonl` |
| Tmux pane history (живой terminal Claude Code) | tmux session `channel-<agent>` | `tmux capture-pane -p -t channel-myagent -S -200` |
| Tmux attach (интерактивно) | tmux session | `tmux attach -t channel-myagent` (detach Ctrl-B D) |
| Workspace memory (если memory hooks включены) | `<workspace>/core/hot/recent.md` + `<workspace>/../logs/verbose-YYYY-MM-DD.jsonl` | `tail -100 ~/.claude-lab/myagent/.claude/core/hot/recent.md` |

`TELEGRAM_STATE_DIR` определяется в `channel.env` (Шаг 5). Если не задан — плагин падает на дефолт `/tmp/dashi-channel-state/<agent>/`, который **зачищается при reboot** — в production задавайте явно (рекомендуется `~/.claude-lab/shared/state/<agent>/telegram/`).

> **Не путайте supervisor stdout и tmux pane:** `.out.log` хранит то, что Bun / Claude Code напечатали в stderr/stdout процесса (логи плагина + сообщения wrapper-скрипта `log()`). Tmux pane — это **сам интерактивный terminal Claude Code** с его UI (welcome-промты, спиннеры, ответы модели). Bug в плагине ищите в `.out.log` / `.err.log`, identity / welcome / context drift — в tmux pane.

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
