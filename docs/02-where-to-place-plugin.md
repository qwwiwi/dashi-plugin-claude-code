# Где разместить плагин

**Это самый важный документ в репо.** 90% проблем при первом запуске — из-за неправильного расположения каталога плагина. Прочитайте до того, как `git clone`.

## TL;DR

```
✓ ПРАВИЛЬНО (Linux):  /home/<user>/.claude-lab/<agent>/.claude/dashi-plugin-claude-code/plugin/
✓ ПРАВИЛЬНО (macOS):  /Users/<user>/.claude-lab/<agent>/.claude/dashi-plugin-claude-code/plugin/
✓ ПРАВИЛЬНО (оба):    ~/.claude-lab/<agent>/.claude/dashi-plugin-claude-code/plugin/

✗ НЕПРАВИЛЬНО: ~/dashi-plugin-claude-code/plugin/
✗ НЕПРАВИЛЬНО: /opt/dashi-plugin/plugin/                 (Linux — выше workspace)
✗ НЕПРАВИЛЬНО: /Applications/dashi-plugin/plugin/        (macOS — outside workspace)
✗ НЕПРАВИЛЬНО: /home/<user>/projects/dashi-plugin-claude-code/plugin/
```

Каталог плагина должен лежать **внутри workspace вашего агента** (`~/.claude-lab/<agent>/.claude/`). Если положить рядом или в `/opt` / `/Applications/` — плагин запустится, но Claude Code не подхватит ваш агентский `CLAUDE.md` с идентичностью и настройками. Агент будет вести себя как «default Claude», без памяти, без инструкций, без identity.

Tilde `~` корректно раскрывается и на Linux (`/home/<user>/`), и на macOS (`/Users/<user>/`) — поэтому везде ниже используем универсальную форму с `~`.

Дальше — почему так и что именно ломается.

---

## Что такое workspace агента

Workspace агента — это каталог на диске, в котором лежат:
- `CLAUDE.md` — system-инструкции для агента (роль, стиль, ограничения, доступы)
- `core/` — память агента (decisions, learnings, hot/recent, handoff)
- `.mcp.json` — MCP-серверы которые подключены к этому агенту
- `settings.json` — settings Claude Code для этого workspace (permissions, hooks)
- (опционально) каталог с вашим плагином

Каноническая структура для одного агента:

```
~/.claude-lab/<agent>/.claude/
├── CLAUDE.md
├── settings.json
├── .mcp.json
├── core/
│   ├── USER.md
│   ├── rules.md
│   ├── hot/
│   │   ├── recent.md
│   │   └── handoff.md
│   ├── warm/
│   │   └── decisions.md
│   └── ...
└── dashi-plugin-claude-code/   ← плагин лежит здесь
    └── plugin/
        ├── src/
        ├── scripts/
        └── package.json
```

Для нескольких агентов — отдельный `<agent>` каталог под каждого:

```
~/.claude-lab/
├── alice/.claude/{CLAUDE.md, core/, dashi-plugin-claude-code/}
├── bob/.claude/{CLAUDE.md, core/, dashi-plugin-claude-code/}
└── charlie/.claude/{CLAUDE.md, core/, dashi-plugin-claude-code/}
```

Каждый агент — отдельный bot token, отдельный workspace, отдельный процесс плагина.

---

## Как Claude Code находит `CLAUDE.md`

При запуске Claude Code выполняет такой алгоритм поиска инструкций:

1. **Глобальный `CLAUDE.md`** — `~/.claude/CLAUDE.md` (один на пользователя)
2. **Project `CLAUDE.md`** — начиная с CWD (текущая рабочая директория процесса), Claude Code поднимается вверх по дереву файлов и подхватывает **первый** найденный `CLAUDE.md` до корня файловой системы

Оба файла мёрджатся в systemprompt сессии. Project `CLAUDE.md` имеет приоритет (загружается позже, перекрывает).

Это значит: **CWD процесса определяет, какой `CLAUDE.md` подхватится**.

### Пример: плагин внутри workspace (правильно)

```
CWD: /home/operator/.claude-lab/alice/.claude/dashi-plugin-claude-code/plugin

Upward search:
  /home/operator/.claude-lab/alice/.claude/dashi-plugin-claude-code/plugin/CLAUDE.md → нет
  /home/operator/.claude-lab/alice/.claude/dashi-plugin-claude-code/CLAUDE.md → нет
  /home/operator/.claude-lab/alice/.claude/CLAUDE.md → НАЙДЕН ✓
  ↑ стоп, поднимаемся не выше

Result: подхвачен Alice's CLAUDE.md → агент знает что он Alice, какие у него правила, какая память.
```

### Пример: плагин снаружи workspace (неправильно)

```
CWD: /opt/dashi-plugin/plugin

Upward search:
  /opt/dashi-plugin/plugin/CLAUDE.md → нет
  /opt/dashi-plugin/CLAUDE.md → нет
  /opt/CLAUDE.md → нет
  /CLAUDE.md → нет (корень)

Result: project CLAUDE.md НЕ найден.
  Подхвачен только глобальный ~/.claude/CLAUDE.md.
  Агент ведёт себя как «default Claude» — без identity Alice.
```

Это и есть основной симптом неправильного расположения: бот отвечает «I'm Claude, an AI assistant by Anthropic» вместо «Я Alice, ваш AI-маркетолог».

---

## Почему именно `~/.claude-lab/<agent>/.claude/`

Это конвенция, которая решает несколько практических задач:

1. **CWD upward search работает.** `.claude` — общепринятое имя каталога Claude Code, ваш CWD при запуске плагина наследует это положение.
2. **Изоляция между агентами.** Каждый `<agent>` в своём поддереве, нельзя случайно загрузить чужой `CLAUDE.md`.
3. **Backup-friendly.** `tar czf alice-backup.tgz ~/.claude-lab/alice/` забирает всё нужное для агента: код, конфиг, память, секреты.
4. **MCP servers per-agent.** `~/.claude-lab/<agent>/.claude/.mcp.json` подхватится автоматически, не пересекаясь с другими агентами.
5. **systemd `WorkingDirectory=`** этот путь прямо указывает в unit-файле — никаких догадок, сервис всегда запускается с правильным CWD.

### Альтернативы (если не нравится `~/.claude-lab/`)

Корневое имя `~/.claude-lab/` — это просто конвенция. Можно своё:
- `~/agents/<agent>/.claude/`
- `/srv/claude-agents/<agent>/.claude/`
- `/home/<service-user>/agents/<agent>/.claude/`

Главное требование: **внутри каталога с CLAUDE.md должен лежать каталог с плагином, и плагин должен быть запущен с CWD внутри плагина**.

```
<любой-путь>/<agent>/.claude/         ← здесь CLAUDE.md, core/, .mcp.json
  └── dashi-plugin-claude-code/       ← внутрь кладём плагин
      └── plugin/                     ← CWD = этот каталог при запуске
```

---

## Process supervisor с правильным CWD

### Linux — systemd

Полный пример unit-файла — [examples/systemd-unit.service.example](../examples/systemd-unit.service.example). Критичная часть:

```ini
[Service]
User=<service-user>
WorkingDirectory=/home/<service-user>/.claude-lab/<agent>/.claude/dashi-plugin-claude-code/plugin
EnvironmentFile=/etc/dashi-plugin/<agent>/channel.env
ExecStart=/usr/bin/tmux new-session -d -s channel-<agent> \
  claude --dangerously-load-development-channels server:dashi-channel
```

### macOS — launchd

Полный пример plist — [examples/launchd-plist.example.plist](../examples/launchd-plist.example.plist), wrapper-скрипт — [examples/launchd-wrapper.sh.example](../examples/launchd-wrapper.sh.example). Критичная часть:

```xml
<key>WorkingDirectory</key>
<string>/Users/&lt;you&gt;/.claude-lab/&lt;agent&gt;/.claude/dashi-plugin-claude-code/plugin</string>

<key>ProgramArguments</key>
<array>
    <string>/Users/&lt;you&gt;/.claude-lab/&lt;agent&gt;/scripts/launchd-wrapper.sh</string>
</array>
```

Wrapper-скрипт source-ит env и держит foreground supervisor pid для launchd. Inline-вариант `sh -c "exec tmux new-session -d ...; sleep; send-keys"` НЕ работает — `exec` подменяет shell, далее sleep/send-keys не запускаются. См. [03-installation-macos.md → Шаг 6](03-installation-macos.md#шаг-6-wrapper-скрипт-и-launchd-plist).

`WorkingDirectory=` (или `WorkingDirectory` в plist) — это и есть CWD процесса. Если опечатаетесь в этом пути — Claude Code не найдёт workspace `CLAUDE.md`, и агент потеряет identity.

Подробнее: [03-installation-linux.md](03-installation-linux.md) для systemd, [03-installation-macos.md](03-installation-macos.md) для launchd.

---

## Проверка после запуска

Запустили сервис — обязательно проверьте, что project CLAUDE.md действительно загрузился. Два способа:

### 1. Через tmux + интерактивная команда `/memory`

```bash
sudo -u <service-user> tmux attach -t channel-<agent>
# в Claude Code:
/memory
```

Должны увидеть оба пути: глобальный и project. Если project отсутствует — CWD не тот.

### 2. Через ping в Telegram

Напишите боту в Telegram: «Кто ты? Откуда твои инструкции?»

Правильный ответ:
> Я <Agent Name>, описание из CLAUDE.md... Инструкции из ~/.claude-lab/<agent>/.claude/CLAUDE.md.

Неправильный ответ:
> I'm Claude, an AI assistant made by Anthropic.

Если получили неправильный — переоткрывайте unit-файл, проверяйте `WorkingDirectory=`. См. [05-troubleshooting.md](05-troubleshooting.md) → «Identity drift».

---

## Подводный камень: external imports

Project `CLAUDE.md` часто использует `@-include` для подгрузки разделённой памяти:

```markdown
@core/USER.md
@core/rules.md
@core/warm/decisions.md
@core/hot/handoff.md
```

Если эти пути выходят за пределы CWD (что бывает всегда, когда CWD = `plugin/` внутри workspace), Claude Code при первом запуске спросит:

> Allow external CLAUDE.md file imports?
> ❯ 1. Yes, allow external imports
>   2. No, disable external imports

**Это нормально.** Файлы свои, в вашем же workspace, просто выше по дереву. Нажмите `1` → Enter.

Но: **этот промт показывается при каждом перезапуске Claude Code** (включая `systemctl restart`). Это значит, после рестарта сервиса нужен человек с tmux чтобы нажать Enter, иначе плагин не стартанёт. Фикс — в [03-installation.md](03-installation.md) → «Persistent external imports approval».

---

## Резюме

| Правило | Почему |
|---|---|
| Плагин кладите в `~/.claude-lab/<agent>/.claude/dashi-plugin-claude-code/` | CWD upward search найдёт project CLAUDE.md |
| systemd unit: `WorkingDirectory=` указывает внутрь плагина | Гарантирует правильный CWD при каждом старте |
| Один агент = один workspace = один процесс плагина = один Telegram бот | Изоляция и предсказуемость |
| После запуска проверяйте загрузку CLAUDE.md через `/memory` или ping бота | Identity drift — самый тихий баг этой архитектуры |
| External imports разрешите — нажмите `1` на промте | Память агента живёт через `@-include` |

Готово. Дальше — [03-installation.md](03-installation.md).
