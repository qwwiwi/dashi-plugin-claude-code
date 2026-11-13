# Стартовый экран dev-channels: подтверждение по содержимому и проверка зависания

## Что это за экран

Плагин запускает Claude Code с флагом `--dangerously-load-development-channels server:dashi-channel`.
После перезапуска (перезагрузка, обновление Claude Code, сбой) Claude Code может остановиться на экране:

```
WARNING: Loading development channels
…
❯ 1. I am using this for local development
  2. Exit

Enter to confirm · Esc to cancel
```

Пока никто не нажал Enter, агент «глухой»: процесс жив, сервис «зелёный», а сообщения из Telegram копятся в очереди.

## Правило: никакого слепого ввода

Нельзя отправлять клавиши «по таймеру» (`sleep 6; send-keys Enter`): экран может появиться позже, а Enter попадёт в другой диалог или в рабочую сессию. Единственная автоматическая клавиша – Enter от `scripts/confirm-startup-screen.sh`, и только когда на экране именно это предупреждение.

## Как работает подтверждение

`scripts/confirm-startup-screen.sh` после старта до 90 секунд смотрит на экран (`tmux capture-pane -p`) и нажимает Enter, только если одновременно:

- виден текст предупреждения dev-channels;
- курсор (`❯`) стоит на пункте 1 «I am using this for local development»;
- нет курсора на другом пункте и нет третьего пункта;
- под пунктами есть подсказка «Enter to confirm», и ниже неё ничего постороннего.

После нажатия скрипт проверяет, что экран исчез. Нажатий не больше двух. Если сессия уже работает, скрипт выходит с кодом 0 и ничего не нажимает. Любой другой экран (доверие к папке, вход, обновление, внешние импорты `CLAUDE.md`, обычная строка ввода) он только называет в логе.

Коды выхода:

| Код | Что значит |
|---|---|
| 0 | сессия работает, либо экран исчез после нашего Enter |
| 2 | ошибка в аргументах |
| 3 | экран остался после двух нажатий |
| 4 | предупреждение dev-channels в незнакомом виде – ничего не нажато |
| 5 | показан другой стартовый диалог – ничего не нажато |
| 6 | за отведённое время ничего не распознано – ничего не нажато |
| 7 | tmux-сессия недоступна |
| 10 | только для `--classify`: экран dev-channels, который был бы подтверждён |

В лог попадает одна строка на действие: время, цель, действие, вид экрана и имя сработавшего шаблона. Текст экрана в лог не пишется – на экране бывает личная переписка.

Фразы, по которым узнаётся экран, собраны в одном месте – в начале `scripts/confirm-startup-screen.sh` – и переопределяются переменными окружения с теми же именами (`STARTUP_PAT_DEVCH_WARNING`, `STARTUP_PAT_DEVCH_OPTION`, `STARTUP_PAT_CONFIRM_HINT` и другие). Если в новой версии Claude Code текст изменился, скрипт перестанет нажимать (код 4), а не нажмёт наугад.

Посмотреть, как скрипт видит экран сейчас, ничего не нажимая:

```bash
bash scripts/confirm-startup-screen.sh --classify -L channel-myagent channel-myagent
# печатает одно слово: ready, dev-channels, dev-channels-unrecognized, trust-folder, external-imports,
# bypass-permissions, login, update, other-dialog, unknown или no-session
```

## Установка

**Новая установка.** `./install.sh` уже создаёт wrapper из `examples/launchd-wrapper.sh.example`: он запускает в tmux обычный shell, вводит в него команду запуска Claude Code и в фоне вызывает `confirm-startup-screen.sh`. Этот wrapper общий для launchd (macOS) и systemd (Linux).

**Существующий агент** (wrapper правился руками):

1. Обновите репозиторий плагина (`./update.sh`) – появятся `scripts/confirm-startup-screen.sh` и `scripts/check-startup-screen.sh`. Если плагин лежит отдельно, скопируйте эти два файла рядом друг с другом.
2. В wrapper агента, сразу после строк, которые запускают Claude Code в tmux, добавьте одну строку (сокет и имя сессии – как в самом wrapper):

   ```bash
   /bin/bash /path/to/dashi-plugin-claude-code/scripts/confirm-startup-screen.sh -L channel-myagent channel-myagent &
   ```

3. Удалите из wrapper блок со слепыми нажатиями (`sleep 6` … `send-keys … Enter`), если он есть.
4. Подключите периодическую проверку (следующий раздел).

Новый wrapper начнёт работать со следующего перезапуска агента; перезапускать агента специально не нужно.

## Проверка зависшего экрана

`scripts/check-startup-screen.sh` – разовая проверка для запуска раз в минуту. Она ничего не нажимает. Для каждого агента из списка она смотрит на экран и, если стартовый диалог виден дольше порога (по умолчанию 120 секунд), один раз на инцидент запускает команду оповещения. Когда экран исчез, состояние сбрасывается, и следующий инцидент даст новое событие.

Список агентов – файл, по строке на агента (образец: `examples/startup-screen-check.agents.example`):

```
myagent -L channel-myagent channel-myagent
```

Оповещение – команда в переменной `STARTUP_ALERT_CMD`. Она получает имя агента, вид экрана и число секунд как `$1 $2 $3` (и как `STARTUP_ALERT_AGENT`, `STARTUP_ALERT_KIND`, `STARTUP_ALERT_SECONDS`). Если команда завершилась с ошибкой, следующая проверка попробует ещё раз. Без `STARTUP_ALERT_CMD` событие только пишется в лог.

Готовый образец команды – `examples/startup-alert.sh.example`: он сообщает агенту-наблюдателю (в образце – `arthas`) через его `webhook-listener` из этого репозитория (адрес и файл с токеном задаются переменными окружения) либо, если адрес не задан, дописывает строку в файл. Свой транспорт подключается заменой тела этого скрипта.

Запуск по расписанию:

- macOS: `examples/startup-screen-check.plist.example` (launchd, `StartInterval` 60 секунд);
- Linux: `examples/startup-screen-check.service.example` и `examples/startup-screen-check.timer.example` (systemd timer).

## Как проверить, не трогая живого агента

На отдельном tmux-сокете с выдуманной сессией:

```bash
tmux -L startup-test new-session -d -s startup-test /bin/bash
tmux -L startup-test send-keys -t startup-test -l "clear; printf 'WARNING: Loading development channels\n\n❯ 1. I am using this for local development\n  2. Exit\n\nEnter to confirm · Esc to cancel'; read -r _; clear; echo 'Listening for channel messages'; sleep 600"
tmux -L startup-test send-keys -t startup-test C-m

bash scripts/confirm-startup-screen.sh --classify -L startup-test startup-test   # dev-channels
bash scripts/confirm-startup-screen.sh --timeout 20 -L startup-test startup-test # нажмёт Enter один раз, код 0
bash scripts/confirm-startup-screen.sh --classify -L startup-test startup-test   # ready

tmux -L startup-test kill-server
```

Автоматические тесты (поддельный `tmux`, настоящий не нужен): `python3 -m pytest tests/test_startup_screen_scripts.py`.

## Как выключить

- Подтверждение: `STARTUP_CONFIRM_DISABLE=1` в окружении сервиса агента либо удалите строку вызова из wrapper. Диалог тогда подтверждает человек, посмотрев на экран.
- Проверку зависания: выгрузите периодическое задание (`launchctl bootout …` / `systemctl disable --now startup-screen-check.timer`).
