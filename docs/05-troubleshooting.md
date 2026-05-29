# Troubleshooting

12 типовых проблем — все взяты из реальных инцидентов. Каждая: **симптом** → **корень** → **фикс** → **как не повторить**.

> **Прочтите перед использованием.** Документ разделён на две секции:
> - **Section A — Current (Bun plugin) — problems** — актуальные проблемы текущей версии плагина на Bun + TypeScript. Применимо ко всем установкам.
> - **Section B — Pre-cutover migration only (Python gateway.py) — applicable until 2026-06-15** — проблемы, специфичные для миграции с legacy Python `gateway.py` на текущий плагин. **Skip if installing fresh after 2026-06-15** — после этой даты старый gateway уходит в отдельный billing pool, новые установки не пользуются им.
>
> Если ставите плагин с нуля и legacy gateway у вас никогда не было — читайте только Section A.

**TOC:**

### Section A — Current (Bun plugin)
- [Проблема 1. Сервис «active», но Telegram не отвечает](#проблема-1-сервис-active-но-telegram-не-отвечает) [current]
- [Проблема 2. Identity drift — агент отвечает как «default Claude»](#проблема-2-identity-drift--агент-отвечает-как-default-claude) [current]
- [Проблема 4. Polling vs Webhook — где смотреть проблему](#проблема-4-polling-vs-webhook--где-смотреть-проблему) [current]
- [Проблема 5. Allowlist отбивает ваше сообщение](#проблема-5-allowlist-отбивает-ваше-сообщение) [current]
- [Проблема 7. Бот ставит реакции, но не отвечает (OAuth expired)](#проблема-7-бот-ставит-реакции-но-не-отвечает-oauth-expired) [current]
- [Проблема 8. Agent self-destruction (rm -rf своего OAuth state)](#проблема-8-agent-self-destruction-rm--rf-своего-oauth-state) [current]
- [Проблема 9. Tmux death loop](#проблема-9-tmux-death-loop-claude-exits--service-в-crash-loop) [current]
- [Проблема 10. Sudo deny rules: что должно блокироваться ВСЕГДА](#проблема-10-sudo-deny-rules-что-должно-блокироваться-всегда) [current]
- [Проблема 11. Agent silently stuck in interactive prompt](#проблема-11-agent-silently-stuck-in-interactive-prompt-askuserquestion-vim-less-etc) [current]
- [Проблема 12. Хук работал, потом «пропал» — зарегистрирован не в том settings.json](#проблема-12-хук-работал-потом-пропал--зарегистрирован-не-в-том-settingsjson) [current]

### Section B — Pre-cutover migration only (Python gateway.py) — applicable until 2026-06-15
- [Проблема 3. `getUpdates conflict` — две сессии слушают одного бота](#проблема-3-getupdates-conflict--две-сессии-слушают-одного-бота) [pre-cutover]
- [Проблема 6. Потеря состояния при миграции](#проблема-6-потеря-состояния-при-миграции) [pre-cutover]

---

## OS-specific команды (Linux vs macOS)

Проблемы ниже описаны примерами **для Linux/systemd**. Если вы на macOS — везде где встретите `systemctl` / `journalctl` / `sudo -u <user>`, используйте эквиваленты:

| Действие | Linux (systemd) | macOS (launchd) |
|---|---|---|
| Статус сервиса | `systemctl status channel-<agent>` | `launchctl print gui/$(id -u)/com.dashi-plugin.channel-<agent>` |
| Рестарт | `systemctl restart channel-<agent>` | `launchctl kickstart -k gui/$(id -u)/com.dashi-plugin.channel-<agent>` |
| Стоп | `systemctl stop channel-<agent>` | `launchctl kill SIGTERM gui/$(id -u)/com.dashi-plugin.channel-<agent>` |
| Логи stdout/stderr | `journalctl -u channel-<agent> -n 50` | `tail -n 50 ~/Library/Logs/dashi-plugin/channel-<agent>.out.log` и `.err.log` |
| Tail логов в реалтайме | `journalctl -u channel-<agent> -f` | `tail -f ~/Library/Logs/dashi-plugin/channel-<agent>.err.log` |
| Tmux attach | `sudo -u <service-user> tmux attach -t channel-<agent>` | `tmux attach -t channel-<agent>` (без sudo, под вашим user) |
| Список процессов | `ps -ef \| grep -E "bun\|claude\|tmux"` | `ps -ef \| grep -E "bun\|claude\|tmux"` (одинаково) |
| Открытые порты | `sudo ss -tlnp \| grep <port>` | `sudo lsof -nP -i :<port>` |
| Конфиг сервиса | `cat /etc/systemd/system/channel-<agent>.service` | `cat ~/Library/LaunchAgents/com.dashi-plugin.channel-<agent>.plist` |
| Перезагрузить конфиг | `systemctl daemon-reload` | `launchctl bootout ... && launchctl bootstrap ...` |
| Env-файл | `cat /etc/dashi-plugin/<agent>/channel.env` | `cat ~/.claude-lab/<agent>/secrets/channel.env` |

---

# Section A — Current (Bun plugin) — problems

_Применимо ко всем установкам current Bun + TypeScript плагина. Читайте эту секцию даже если ставите плагин с нуля._

## Проблема 1. Сервис «active», но Telegram не отвечает

### Симптом

```
$ systemctl status channel-myagent
● channel-myagent.service - Dashi Plugin Channel for myagent
   Active: active (running) since ...
```

Сервис «зелёный», но боту в Telegram пишешь — тишина. Никаких реакций, никаких ответов, ничего.

### Корень

Claude Code при первом запуске показывает **2 интерактивных welcome-промта**:

1. «Allow external CLAUDE.md file imports?» (если ваш CLAUDE.md использует `@-include`)
2. «--dangerously-load-development-channels is for local development only»

Пока эти промты не пройдены — **плагин внутри Claude НЕ активируется**, polling не запускается, сообщения из Telegram теряются.

`systemctl status` показывает active потому что **главный процесс `tmux`** жив. Tmux форкнул `claude` процесс — он тоже жив. Но Claude Code висит на промте и ничего не делает.

### Фикс

1. Откройте tmux:
   ```bash
   sudo -u <service-user> tmux attach -t channel-<agent>
   ```
2. Увидите welcome-промт с подсвеченной опцией `1`. Нажмите `Enter`.
3. Если есть второй промт — снова `Enter`.
4. Detach: `Ctrl-B`, затем `D`.
5. Проверьте что появилась строка `Listening for channel messages from: server:dashi-channel`.
6. Напишите боту повторно — должен ответить.

### Как не повторить

В systemd unit `ExecStartPost`:

```ini
ExecStartPost=/bin/sh -c 'sleep 6 && /usr/bin/tmux send-keys -t channel-<agent> Enter && sleep 2 && /usr/bin/tmux send-keys -t channel-<agent> Enter'
```

(два Enter с паузой — на оба промта)

Persistent fix — записать accepts в `~/.claude/settings.json` (см. [03-installation.md → Шаг 7](03-installation.md#persistent-welcome-approvals-чтобы-не-нажимать-enter-после-каждого-рестарта)).

**Урок:** «systemctl active» = «процесс жив», не = «работает корректно». После каждого рестарта проверяйте `tmux capture-pane | tail -30` на наличие welcome-окон.

---

## Проблема 2. Identity drift — агент отвечает как «default Claude»

### Симптом

Боту в Telegram: «Кто ты?»
Бот: «I'm Claude, an AI assistant made by Anthropic.»

Должно быть: «Я <Agent Name>, описание из CLAUDE.md…»

### Корень

`WorkingDirectory=` в systemd unit указывает не на каталог внутри workspace. Claude Code при запуске не нашёл project `CLAUDE.md` через CWD upward search и подхватил только глобальный `~/.claude/CLAUDE.md` (который generic).

Возможные конкретные причины:
- Опечатка в пути в `WorkingDirectory=`
- Плагин лежит в `/opt/...` или `~/projects/...` — не внутри workspace
- Workspace путь правильный, но `CLAUDE.md` файл случайно удалён/переименован

### Фикс

1. Откройте `/etc/systemd/system/channel-<agent>.service`, проверьте строку `WorkingDirectory=`.
2. Этот путь должен быть **внутри** каталога, в котором лежит `CLAUDE.md` (поднимаясь вверх).
3. Проверьте файл существует: `ls -la <workspace>/CLAUDE.md`
4. Через tmux в Claude Code: команда `/memory` — должна показать **оба** CLAUDE.md (глобальный + project).
5. Если показывает только глобальный — `WorkingDirectory=` неправильный. Поправьте, `daemon-reload`, `restart`.

### Как не повторить

После любой правки `WorkingDirectory=` — обязательный smoke: ping бота «кто ты». См. [02-where-to-place-plugin.md](02-where-to-place-plugin.md).

**Урок:** identity-баг тихий. Бот работает, отвечает осмысленно, выполняет команды — просто без вашего CLAUDE.md. Можно неделями не замечать пока не сравнить ответы.

---

> **Проблема 3** перенесена в [Section B → Проблема 3. `getUpdates conflict`](#проблема-3-getupdates-conflict--две-сессии-слушают-одного-бота). Применима только при миграции с legacy Python gateway.py до 2026-06-15.

---

## Проблема 4. Polling vs Webhook — где смотреть проблему

### Симптом

Боту пишете — не отвечает. Хотите проверить «дошло ли до Telegram», начинаете дебажить webhook:

```bash
curl ".../getWebhookInfo"
# url_set: false
```

И делаете вывод «webhook сломан». А на самом деле плагин использует **polling** (`getUpdates`), webhook ему не нужен. 30 минут уходит на ложный след.

### Корень

`dashi-plugin-claude-code` по умолчанию работает в **polling-режиме** — плагин внутри Claude Code опрашивает Telegram через `getUpdates`. Webhook (порт 8093 локально) используется только для приёма Claude hooks (PreToolUse/PostToolUse/Stop) — это **внутренний** webhook, не Telegram-webhook.

`getWebhookInfo` возвращает `url_set: false` — это **нормально и ожидаемо** для polling-mode.

### Фикс (правильный путь диагностики)

Когда бот не отвечает:

1. **Сначала** проверьте сервис: `systemctl status channel-<agent>`
2. **Сначала** проверьте tmux: `tmux capture-pane` — не висит ли на welcome-промте
3. **Сначала** проверьте идентичность: `/memory` или ping бота
4. **Только потом** — Telegram очередь:
   ```bash
   TOKEN=$(grep TELEGRAM_BOT_TOKEN /etc/dashi-plugin/<agent>/channel.env | cut -d= -f2-)
   curl -s "https://api.telegram.org/bot${TOKEN}/getUpdates?limit=5&timeout=0" | jq .
   ```
   - `pending=0` + сообщения от бота вы только что отправили = плагин их **съел** через polling, но не обработал. Ищите allowlist (см. Проблема 5) или ошибку в handlers (логи).
   - `pending>0` = плагин **не делает** getUpdates. Что-то с polling loop — снова к шагу 1.

### Как не повторить

Записать в команду диагностики последовательность: «status → tmux → identity → Telegram queue». Никогда не начинать с webhook диагностики если не уверены что плагин в webhook mode.

**Урок:** диагностируйте по архитектуре, не по симптому. «Сообщение не доходит» имеет 4-5 возможных причин на разных уровнях — проверяйте в порядке наиболее частых сначала.

---

## Проблема 5. Allowlist отбивает ваше сообщение

### Симптом

Telegram pending updates = 0 (плагин их забирает), tmux показывает что плагин активен, но в чате нет ни реакций, ни ответа. Других ошибок в логе нет.

### Корень

`TELEGRAM_ALLOWED_USER_IDS` и/или `TELEGRAM_ALLOWED_CHAT_IDS` в `channel.env` не содержит ваш Telegram user ID. Плагин получает update, проверяет gate — и тихо дропает (это by-design, защита от спама / попадания в чужие чаты).

Default allowlist в коде = `[<your-telegram-user-id>]` (зашитый user ID разработчика плагина — должен быть переопределён через env под ваш ID), он применяется только если в env ничего не указано.

### Фикс

1. Узнайте свой Telegram user ID — напишите [@userinfobot](https://t.me/userinfobot).
2. Откройте `/etc/dashi-plugin/<agent>/channel.env`:
   ```bash
   TELEGRAM_ALLOWED_USER_IDS=<your_id>,<another_id>
   TELEGRAM_ALLOWED_CHAT_IDS=<your_id>
   ```
3. Для group chat — `TELEGRAM_ALLOWED_CHAT_IDS=-100123456789` (group chat IDs начинаются с `-100`).
4. `systemctl restart channel-<agent>`.

### Как не повторить

Сразу после первого запуска плагина — `/help` или `/status` от вашего бота. Если бот молчит на OOB-команды — это allowlist.

**Урок:** silent drop — by-design для безопасности. Но если вы новый владелец бота и не знаете про allowlist — diagnostic experience неприятный. На скриншоты diff'а bot'а из тренинговых материалов добавляйте: «не забудьте allowlist».

---

> **Проблема 6** перенесена в [Section B → Проблема 6. Потеря состояния при миграции](#проблема-6-потеря-состояния-при-миграции). Применима только при миграции с legacy Python gateway.py до 2026-06-15.

---

## Проблема 7. Бот ставит реакции, но не отвечает (OAuth expired)

### Симптом

Telegram-бот получает сообщения (видны emoji-реакции — 👀 или похожие), но текстовых ответов нет. В Telegram пользователь пишет, бот молча реагирует и тишина.

`systemctl status channel-<agent>` — `active (running)`. `pm2 list` (если есть) — всё зелёное. Tmux session жива.

### Корень

Claude Code OAuth-токен протух / не валиден. Webhook доходит до плагина (поэтому reactions работают — это слой плагина), плагин дёргает claude CLI, claude пытается вызвать Anthropic API, получает **401 Invalid authentication credentials** / **«Please run /login»**, ничего не отвечает.

Проверка через `tmux capture-pane`:

```
← dashi-channel: что с тобой?
  ⎿  Please run /login · API Error: 401 The socket connection was closed
     unexpectedly. For more information, pass `verbose: true` in the second
     argument to fetch()
✻ Crunched for 2m 21s
```

### Фикс

OAuth flow интерактивный — нужен TTY. Удалённый агент сам себя не починит.

```bash
# 1. Подключиться под service-user
sudo -u <service-user> tmux attach -t channel-<agent>

# 2. В claude prompt
/login

# 3. Открыть выданный URL в браузере, авторизоваться под Anthropic Max аккаунтом

# 4. Detach: Ctrl-B, D
```

После /login claude подхватит новые токены, сохранит в `~/.openclaw/` (или `~/.claude/` — зависит от версии CLI), при следующем prompt уже ответит.

### Как не повторить

OAuth токены протухают (refresh failure, account changes, скомпрометированные кэши). Полностью не предотвратить, но можно мониторить:

```bash
# Cron / health-check: проверять что в tmux pane нет «Please run /login»
tmux capture-pane -t channel-<agent> -p -S -50 | grep -i 'login\|401\|unauthorized' && alert
```

Также — резервный agent-бот / Telegram-канал чтобы получить сигнал когда основной бот залип.

**Урок:** «бот active» = «сервис жив», не = «авторизация валидна». Reactions работают на уровне плагина, ответы — на уровне API. Когда видишь reactions без ответов = в первую очередь проверь auth, потом всё остальное.

---

## Проблема 8. Agent self-destruction (rm -rf своего OAuth state) ⚠️

### Симптом

Бот работал, потом внезапно перестал отвечать. `systemctl status` показывает **сервис в auto-restart loop**: `Active: activating (auto-restart) (Result: exit-code)`, exit code 0/SUCCESS, рестартится каждые 15 секунд, главный процесс exit'ит сразу после старта.

`ssh ... "tmux capture-pane -t channel-<agent> -p"` возвращает:

```
no server running on /tmp/tmux-1000/default
```

Журнал:
```
May 20 00:30:32 thrall sh[1608429]: no server running on /tmp/tmux-1000/default
May 20 00:30:55 thrall sh[1608832]: no server running on /tmp/tmux-1000/default
May 20 00:31:19 thrall sh[1612639]: no server running on /tmp/tmux-1000/default
...
```

### Корень

**Агент через `sudo` удалил каталог со своим Claude OAuth state** (типично: `~/.openclaw/` или `~/.claude/`).

Реальный инцидент Orgrimmar/Thrall, 2026-05-20 00:24:44 UTC. Хронология из journalctl:

```
00:24:33  sudo du -sh /home/openclaw/.openclaw/
00:24:33  sudo find /home/openclaw/.openclaw/ -not -user openclaw -type d
00:24:44  sudo rm -rf /home/openclaw/.openclaw    ← АГЕНТ САМ
```

Контекст: агент выполнял `audit batrak before removal` (чистка legacy user). Нашёл в `~/.openclaw/` директории не-openclaw-owned (нормально — некоторые subdirs root-owned после init процессов). Решил, что это «orphan», снёс всю папку — вместе со своим OAuth.

Что было в `.openclaw/`:
- Claude CLI OAuth credentials (access + refresh tokens)
- `.openclaw/.secrets/` (restic env, DO Spaces credentials)
- Прочие toolings configs

После удаления при следующем рестарте claude процесс не находит auth state → выходит → tmux single-window закрывается → tmux server останавливается (последняя session) → systemd видит «exited 0» → рестартует через 15s → loop.

### Фикс

OAuth восстановить только через интерактивный /login. Файлы из `.openclaw/.secrets/` восстанавливать из бэкапа (DO Spaces restic snapshot, 1Password, итд).

```bash
# 1. Stop crash loop
sudo systemctl stop channel-<agent>

# 2. Manual claude session с TTY
sudo -u <service-user> -i
tmux new-session -s channel-<agent>
claude --dangerously-load-development-channels server:dashi-channel
# в prompt: /login → открыть URL → авторизоваться → Enter
# detach: Ctrl-B, D

# 3. Возможно нужно восстановить .secrets/
restic restore <latest-snapshot> --target /home/<service-user>/.openclaw/.secrets \
  --include /home/<service-user>/.openclaw/.secrets

# 4. Restart systemd
sudo systemctl start channel-<agent>

# 5. Smoke: написать боту, должен ответить
```

### Как не повторить (КРИТИЧНО)

Это **самый опасный класс ошибок для AI-агентов с sudo**. Защита — на уровне permission rules в `~/.claude/settings.json` агента:

```json
{
  "permissions": {
    "allow": ["Bash(sudo:*)"],
    "deny": [
      "Bash(sudo rm:*)",
      "Bash(sudo rm -rf:*)",
      "Bash(rm -rf /)",
      "Bash(rm -rf ~)",
      "Bash(rm -rf /home/*/.openclaw*)",
      "Bash(rm -rf /home/*/.claude*)",
      "Bash(sudo userdel:*)",
      "Bash(sudo chown -R:*)",
      "Bash(sudo chmod -R:*)"
    ],
    "ask": [
      "Bash(rm:*)",
      "Bash(sudo mv:*)",
      "Bash(sudo cp:*)"
    ]
  }
}
```

**Принципы:**
1. `sudo` сам по себе — OK для read-only (du, ls, grep, find, systemctl status, journalctl)
2. **Destructive sudo (rm, userdel, chown -R, chmod -R) — ВСЕГДА в deny**, даже если sudo в allow
3. Любой `rm -rf` на хоум-директориях агента — explicit deny с конкретным паттерном
4. `Bash(rm:*)` (без sudo) — в ask, чтобы при необходимости user мог разрешить per-command

**Системный урок:** агенту нельзя давать blanket sudo. Лучший подход — узкий whitelist read-only sudo команд:

```json
{
  "permissions": {
    "allow": [
      "Bash(sudo du:*)", "Bash(sudo ls:*)", "Bash(sudo grep:*)",
      "Bash(sudo cat:*)", "Bash(sudo find:*)",
      "Bash(sudo systemctl status:*)", "Bash(sudo systemctl list-units:*)",
      "Bash(sudo journalctl:*)", "Bash(sudo ss:*)",
      "Bash(sudo crontab -l:*)", "Bash(sudo getent:*)"
    ]
  }
}
```

Destructive операции (`sudo rm`, `sudo systemctl stop|start|disable`, `sudo apt remove`) — продолжают спрашивать confirmation.

**Урок:** AI-агенты галлюцинируют. Sudo + галлюцинация = катастрофа. Никогда не давай blanket `Bash(sudo:*)` на production хосте где у агента есть OAuth state, secrets, или живые сервисы рядом.

---

## Проблема 9. Tmux death loop (claude exits → service в crash loop)

### Симптом

```
$ systemctl status channel-<agent>
● channel-<agent>.service - Dashi Plugin Channel
   Active: activating (auto-restart) (Result: exit-code) since ...
   Main PID: <pid> (code=exited, status=0/SUCCESS)
```

Сервис рестартится каждые ~15 секунд, exit code = 0/SUCCESS (не error!), но и не работает. `tmux capture-pane` → `no server running`.

### Корень

Type=forking systemd unit ожидает, что `tmux new-session -d` форкнётся и tmux server останется в памяти. Это работает пока есть **живая сессия с живой window**. Если claude процесс внутри tmux pane умирает (например, OAuth fail, неправильный CWD, отсутствует CLAUDE.md import, ENOENT на plugin path) — single-window закрывается, session закрывается, **tmux server останавливается** (если эта сессия была последней).

Systemd видит «exited 0» (потому что `tmux new-session -d` сам по себе отработал успешно, форк прошёл) → срабатывает `Restart=on-failure` → новая попытка. Но root cause (умирающий claude) не починен → loop.

### Фикс

1. Сначала остановить loop, чтобы видеть что происходит:
   ```bash
   sudo systemctl stop channel-<agent>
   ```

2. Запустить claude вручную с TTY и смотреть error:
   ```bash
   sudo -u <service-user> -i
   cd <WorkingDirectory из unit>
   source <EnvironmentFile>
   claude --dangerously-load-development-channels server:dashi-channel
   ```

3. Скорее всего одно из:
   - **OAuth error** (см. Проблема 7 + 8 — `.openclaw` удалён или token expired)
   - **plugin path ENOENT** (`--dangerously-load-development-channels` ссылка битая)
   - **CLAUDE.md import error** (если используется @-include, файл не найден)

4. После починки root cause → `systemctl start channel-<agent>`

### Как не повторить

Watchdog хелсчек: cron, который раз в минуту проверяет что tmux session живёт.

```bash
*/1 * * * * tmux has-session -t channel-<agent> 2>/dev/null || \
  (echo "DEAD $(date)" >> /var/log/channel-watchdog.log; \
   systemctl restart channel-<agent>)
```

Лучше — alert в Telegram канал когда `restart counter` за 5 минут > 3 (явный crash loop).

**Урок:** «exit 0 status SUCCESS» обманчиво. Type=forking считает успехом сам факт fork'а, не долгоживущесть. Всегда смотрите `tmux has-session` отдельно от `systemctl is-active`.

---

## Проблема 10. Sudo deny rules: что должно блокироваться ВСЕГДА

### Симптом / контекст

Прецедент проблемы 8 показал: blanket `Bash(sudo:*)` в allow — самоубийство. Но узкий whitelist (только read-only sudo) — это idealный кейс. Иногда агенту реально нужен `sudo systemctl restart` или `sudo cp /tmp/file /etc/...`. Как обеспечить безопасность даже когда sudo allowed широко?

### Минимальный baseline `deny` (вне зависимости от allow):

```json
{
  "permissions": {
    "deny": [
      "Bash(rm -rf /)",
      "Bash(rm -rf ~)",
      "Bash(rm -rf /home/*/.openclaw*)",
      "Bash(rm -rf /home/*/.claude*)",
      "Bash(rm -rf /home/*/.secrets*)",
      "Bash(rm -rf /opt:*)",
      "Bash(rm -rf /var:*)",
      "Bash(rm -rf /etc:*)",
      "Bash(sudo rm -rf:*)",
      "Bash(sudo userdel:*)",
      "Bash(sudo chown -R:*)",
      "Bash(sudo chmod -R 777:*)",
      "Bash(sudo dd:*)",
      "Bash(sudo mkfs:*)",
      "Bash(sudo fdisk:*)",
      "Bash(sudo iptables -F:*)",
      "Bash(sudo ufw disable:*)",
      "Bash(curl * | bash)",
      "Bash(wget * | sh)",
      "Bash(chmod 777 *)",
      "Bash(git push --force:*)",
      "Bash(git reset --hard:*)"
    ]
  }
}
```

**Логика:** deny имеет приоритет над allow. Эти команды — катастрофические, и не должны быть разрешены даже под надзором. Если действительно нужно — пользователь делает руками с явным OK, не агент.

### Защита Claude OAuth state специально

Минимум для каждого агента:

```json
{
  "permissions": {
    "deny": [
      "Bash(rm * .openclaw*)",
      "Bash(rm * .claude*)",
      "Bash(mv .openclaw*)",
      "Bash(mv .claude*)",
      "Bash(sudo rm * .openclaw*)",
      "Bash(sudo rm * .claude*)"
    ]
  }
}
```

И параллельно — file watcher / inotify alert на `~/.openclaw/` который пишет в Telegram канал если что-то удаляется.

### Как не повторить

После установки нового агента — обязательный smoke на permissions:

```bash
# Что должно блокироваться (агент должен ОТКАЗАТЬСЯ выполнить):
"rm -rf ~/.openclaw"        # → blocked
"sudo rm -rf /home/me"      # → blocked
"chmod 777 /etc"            # → blocked
"git push --force"          # → blocked

# Что должно требовать confirmation:
"rm /tmp/test-file"         # → ask
"sudo systemctl restart X"  # → ask или allow
```

**Урок:** permissions — это не just convenience setting, это **security boundary**. Каждое расширение `allow` должно быть подкреплено комплементарным `deny` для destructive вариантов той же команды. allow без deny = open shotgun.

---

## Проблема 11. Agent silently stuck in interactive prompt (AskUserQuestion, vim, less, etc.)

### Симптом

Агент перестал отвечать в Telegram, но:
- `systemctl status` → `active (running)`
- claude-процесс жив, CPU/RAM в норме
- В Telegram — тишина, реакции не ставятся
- `tmux capture-pane` показывает choice-меню с `❯ 1. ... ❯ 2. ...` и строку `Enter to select · ↑/↓ to navigate · Esc to cancel`

### Корень

`AskUserQuestion` и подобные интерактивные tools (`ExitPlanMode`, `vim`, `nano`, `less` без `-F`, `more`, `top`, `htop`, `git rebase -i`, `git add -i`, `npm init` без `--yes`, etc.) **рисуют интерактивный UI напрямую в терминале и блокируются на stdin**, ожидая ↑/↓ Enter.

Это **не** PostToolUse событие — Claude Code harness рисует UI напрямую через ANSI escape-коды и читает stdin до получения выбора. Плагин в текущей версии **не пробрасывает** эти prompts в Telegram через inline keyboard / sendMessage. Результат — агент жив, но висит на чтении ввода, которого никто не введёт.

### Фикс (быстрый — deny-list)

Запретить interactive tools через `permissions.deny` в `settings.json` агента. Тогда tool никогда не вызовется → агент либо примет решение сам, либо сформулирует вопрос обычным текстом, который дойдёт до Telegram как нормальное сообщение.

В вашем `~/.claude-lab/<agent>/.claude/settings.json` (или `settings.local.json`) добавьте/расширьте `permissions.deny`:

```jsonc
{
  "permissions": {
    "deny": [
      "AskUserQuestion",
      "ExitPlanMode",
      "Bash(vim:*)",
      "Bash(vi:*)",
      "Bash(nano:*)",
      "Bash(emacs:*)",
      "Bash(less:*)",
      "Bash(more:*)",
      "Bash(top)",
      "Bash(htop:*)",
      "Bash(watch:*)",
      "Bash(git rebase -i:*)",
      "Bash(git add -i:*)",
      "Bash(git commit -i:*)",
      "Bash(npm init)",
      "Bash(yarn init)"
    ]
  }
}
```

Готовый template: [`examples/settings.local.json.example`](../examples/settings.local.json.example).

После правки — **рестарт сервиса**, `settings.json` читается на старте новой Claude-сессии (на лету не подхватится).

```bash
systemctl restart channel-<agent>     # Linux
launchctl kickstart -k gui/$(id -u)/com.dashi-plugin.channel-<agent>  # macOS
```

### Фикс (правильный — inline keyboard в плагине, TODO)

Полная поддержка `AskUserQuestion` через Telegram inline keyboard:

1. `PreToolUse` hook на `AskUserQuestion` → парсит вопрос + варианты ответов
2. Отправляет в Telegram `sendMessage` с `reply_markup.inline_keyboard` (по кнопке на вариант)
3. Слушает `callback_query` от Bot API
4. Когда юзер нажал — `tmux send-keys` навигация (↑/↓) + Enter в сессию

Аналогично для текстовой версии (без callback_query): отправлять пронумерованный список текстом, парсить ответ юзера на цифру, send-keys → Enter.

Issue: https://github.com/qwwiwi/dashi-plugin-claude-code/issues (создайте issue с label `enhancement`).

### Как не повторить

1. При установке плагина для **любого autonomous-агента** — сразу копируйте [`examples/settings.local.json.example`](../examples/settings.local.json.example) в `~/.claude-lab/<agent>/.claude/settings.local.json`
2. Не давайте агенту `--allowedTools '*'` без явного `--disallowedTools 'AskUserQuestion,ExitPlanMode'`
3. В CLAUDE.md агента включите правило: «Для autonomous-режима всегда формулируй вопросы как обычный текст принцу через Telegram. Не используй `AskUserQuestion` — этот tool заблокирован»

### Manual-unstuck (если уже залип)

Если агент уже завис в choice-меню и ты видишь его через tmux capture-pane:

```bash
# Посмотри какой вариант выбран (стрелка ❯)
sudo -u <service-user> tmux capture-pane -t channel-<agent> -p -S -30 | tail -20

# Нажми Enter если стрелка на нужном варианте
sudo -u <service-user> tmux send-keys -t channel-<agent> Enter

# Или подвигай стрелку перед Enter
sudo -u <service-user> tmux send-keys -t channel-<agent> Down Down Enter
```

Это спасает текущую сессию (контекст не теряется), но фикс через deny-list обязателен на следующий рестарт.

---

# Section B — Pre-cutover migration only (Python gateway.py) — applicable until 2026-06-15

> **Когда читать эту секцию.** Только если у вас уже работает legacy Python `gateway.py` (репо `qwwiwi/jarvis-telegram-gateway` или приватный fork `qwwiwi/gateway-dashis-agents`) и вы мигрируете на текущий Bun-плагин до cutover 2026-06-15. Все остальные читатели — пропустите.
>
> После 2026-06-15 Anthropic разделяет billing: `claude -p` (Agent SDK) уходит в отдельный $200/мес pool. Любой `claude -p` spawn = расход из SDK pool. Старая gateway-архитектура перестаёт быть экономичной, и эти проблемы теряют актуальность. См. [04-migration-from-gateway.md](04-migration-from-gateway.md) для пошагового перехода.

## Проблема 3. `getUpdates conflict` — две сессии слушают одного бота

### Симптом

В логах плагина (`tmux capture-pane` или `journalctl`):

```
Error: 409 Conflict: terminated by other getUpdates request;
make sure that only one bot instance is running
```

Telegram перестаёт отдавать обновления плагину.

### Корень

Telegram Bot API разрешает **только одного** активного `getUpdates` клиента на токен. Если запущено 2 процесса с одним и тем же `TELEGRAM_BOT_TOKEN` — они отбирают сообщения друг у друга, оба ломаются.

Типичные сценарии (все pre-cutover):
- Старый `gateway.py` процесс остался жив после миграции (вы запустили новый плагин но не выключили старый)
- На двух хостах (staging + prod) одновременно запущены сервисы с одним токеном
- Кто-то локально запустил `bun run start` для отладки, забыл выключить

### Фикс

```bash
# 1. Найдите все процессы использующие этот токен
sudo ss -tnp | grep <bot-id>
ps -ef | grep -E "gateway|channel|claude" | grep -v grep

# 2. Убедитесь что только один процесс должен слушать
#    Остановите лишние:
sudo systemctl stop channel-<old>
# или
sudo kill <pid-старого-gateway>

# 3. Подождите 30 секунд — Telegram сбросит сторону "другого" клиента
sleep 30

# 4. Перезапустите ваш единственный процесс
sudo systemctl restart channel-<agent>
```

### Как не повторить

В процессе миграции — **сначала** stop старого gateway, **потом** start нового. См. [04-migration-from-gateway.md](04-migration-from-gateway.md) — там пошагово с правильным порядком.

**Урок:** на одного бота — один процесс. Точка. Используйте отдельные тестовые боты (`@BotFather` создаёт их бесплатно) для отладки, не дёргайте production токен.

---

## Проблема 6. Потеря состояния при миграции

### Симптом

После переноса плагина на новое место (или обновления через `git pull` после большого диффа) — бот стартует с нуля: не помнит предыдущие разговоры, `recent.md` пустой, история чата потеряна.

### Корень

`TELEGRAM_STATE_DIR` указывает на путь, который пересоздался / переместился / не примонтировался. Этот каталог хранит:
- `bot.pid` — PID-файл активного poller
- `config.json` — runtime config (webhook/memory/status)
- `inbox/` — голосовые/медиа от пользователя (downloaded files)
- `logs/permissions.jsonl` — лог permission запросов

Плюс — `<workspace>/core/hot/recent.md` (если memory hooks включены) — там хвост разговора.

При переезде эти файлы должны переехать вместе с плагином, иначе агент стартует с пустой памятью.

### Фикс / как не повторить

**Перед переездом:**

```bash
# 1. Snapshot всего что нужно сохранить (archive — НЕ rm)
sudo systemctl stop channel-<agent>
sudo tar czf /var/backups/<agent>-pre-migration-$(date +%Y%m%d).tgz \
  /home/<service-user>/.claude-lab/<agent> \
  /home/<service-user>/.claude-lab/shared/state/<agent> \
  /etc/dashi-plugin/<agent> \
  /etc/systemd/system/channel-<agent>.service
```

**После переезда:**

```bash
# 2. Перед стартом — verify state есть на месте
ls -la $TELEGRAM_STATE_DIR/{bot.pid,config.json,inbox,logs}
ls -la <workspace>/core/hot/recent.md

# Только если оба есть — start
sudo systemctl start channel-<agent>

# 3. Smoke: ping бота, проверьте что помнит контекст
```

**Урок:** state-каталог — отдельная сущность от плагин-кода. При планировании переноса учитывайте оба пути. Архивируйте старый workspace (`tar czf` + `mv .old`) перед любыми деструктивными операциями — см. [04-migration-from-gateway.md → Шаг 7](04-migration-from-gateway.md#шаг-7-архивация-gateway-через-7-14-дней) для безопасного workflow.

---

## Проблема 12. Хук работал, потом «пропал» — зарегистрирован не в том settings.json

`[current]`

### Симптом

Хук, который раньше работал (например, детерминированная 👀-реакция «агент прочитал сообщение» через Stop-хук), внезапно перестаёт срабатывать после коммита, который перенёс логику из кода плагина в Claude Code hook. Бот живой, отвечает, но побочный эффект хука (реакция, запись памяти, heartbeat) молча исчезает. В логах ошибок нет.

### Корень

Claude Code читает **project settings** (`<project>/.claude/settings.json`) относительно **cwd сессии**, а не относительно workspace-каталога агента. Сервис плагина обычно стартует с `WorkingDirectory=<...>/jarvis-channel/plugin` — значит «project» для живой сессии это **репозиторий плагина**, а не `~/.claude-lab/<agent>/`.

Если хук зарегистрировать в `~/.claude-lab/<agent>/.claude/settings.json`, ошибочно считая это «project settings» сессии, — живая сессия этот файл **не читает**, и хук не выполняется. Диагностический признак: **ни один** Stop-хук из этого settings не отрабатывает — `core/hot/handoff.md` и `recent.md` не обновляются, heartbeat-файл пустой/старый.

Реальный инцидент (2026-05-29): read-receipt хук положили в workspace-settings; сессия стартует из `jarvis-channel/plugin` → читает только глобальный `~/.claude/settings.json` → 👀 пропали полностью.

### Фикс

```bash
# 1. Проверить, какой settings реально читает сессия:
#    cwd сервиса → его git-root → там ищется .claude/settings.json
systemctl show channel-<agent> -p WorkingDirectory
cd <WorkingDirectory> && git rev-parse --show-toplevel   # это и есть "project" для сессии

# 2. Убедиться что workspace-хуки НЕ срабатывают (косвенный признак):
stat -c '%y' ~/.claude-lab/<agent>/.claude/core/hot/handoff.md   # не обновляется = settings не читается

# 3. Перенести хук в ГЛОБАЛЬНЫЙ ~/.claude/settings.json (бэкап обязателен)
cp ~/.claude/settings.json ~/.claude/settings.json.bak.$(date +%Y%m%d-%H%M%S)
#    добавить группу в hooks.Stop (или нужное событие), валидировать JSON:
python3 -c "import json; json.load(open('$HOME/.claude/settings.json')); print('OK')"

# 4. Рестарт сервиса — settings читается только на старте новой сессии
sudo systemctl restart channel-<agent>
```

### Как не повторить

**Все хуки плагина** (`PreToolUse`/`PostToolUse`/`Stop`/`UserPromptSubmit`) регистрируются **только** в глобальном `~/.claude/settings.json` — именно его читает любая сессия пользователя независимо от cwd. Workspace-level `settings.json` годится лишь для `permissions`/`env` (они мёрджатся независимо от cwd). Подробнее — [06-how-claude-loads-session.md → Settings.json hierarchy](06-how-claude-loads-session.md#settingsjson-hierarchy).

---

## Когда ничего не помогает

1. Логи systemd: `journalctl -u channel-<agent> --since "1 hour ago" --no-pager -l`
2. Tmux со скроллом: `sudo -u <service-user> tmux capture-pane -t channel-<agent> -p -S -200`
3. Bun процессы: `ps -ef | grep bun | grep -v grep` — должен быть **один** `bun ./src/server.ts`
4. Permission лог: `cat $TELEGRAM_STATE_DIR/logs/permissions.jsonl`
5. Tests: `cd plugin && bun test` — если тесты упали, у вас core bug, не env-проблема
6. Открыть issue с описанием: версия Claude Code, версия Bun, `systemctl status` output, tmux capture последних 100 строк, `getWebhookInfo` response.

GitHub Issues: https://github.com/qwwiwi/dashi-plugin-claude-code/issues
