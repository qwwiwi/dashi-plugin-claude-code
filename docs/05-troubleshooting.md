# Troubleshooting

6 типовых проблем при установке/миграции — все взяты из реальных инцидентов. Каждая: **симптом** → **корень** → **фикс** → **как не повторить**.

---

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

Типичные сценарии:
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

Default allowlist в коде = `[164795011]` (это user ID разработчика плагина), он применяется только если в env ничего не указано.

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
# 1. Snapshot всего что нужно сохранить
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

**Урок:** state-каталог — отдельная сущность от плагин-кода. При планировании переноса учитывайте оба пути. Никогда не делайте `rm -rf` старого workspace без snapshot.

---

## Когда ничего не помогает

1. Логи systemd: `journalctl -u channel-<agent> --since "1 hour ago" --no-pager -l`
2. Tmux со скроллом: `sudo -u <service-user> tmux capture-pane -t channel-<agent> -p -S -200`
3. Bun процессы: `ps -ef | grep bun | grep -v grep` — должен быть **один** `bun ./src/server.ts`
4. Permission лог: `cat $TELEGRAM_STATE_DIR/logs/permissions.jsonl`
5. Tests: `cd plugin && bun test` — если тесты упали, у вас core bug, не env-проблема
6. Открыть issue с описанием: версия Claude Code, версия Bun, `systemctl status` output, tmux capture последних 100 строк, `getWebhookInfo` response.

GitHub Issues: https://github.com/qwwiwi/dashi-plugin-claude-code/issues
