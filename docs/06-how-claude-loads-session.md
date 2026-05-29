# Как Claude Code загружает сессию

Этот документ — справочник по механике загрузки. Полезен если уже прочитали [02-where-to-place-plugin.md](02-where-to-place-plugin.md) и хотите понять детали (или у вас edge-case, который нужно разобрать).

## Загрузка `CLAUDE.md` — порядок

При запуске Claude Code собирает system prompt из нескольких источников, в порядке (сверху — раньше, ниже — позже):

1. **Built-in Anthropic system prompt** (всегда, недоступен для редактирования)
2. **Global `~/.claude/CLAUDE.md`** (если есть)
3. **Project `CLAUDE.md`** — найденный через CWD upward search (если есть)
4. **`@-include` директивы внутри project `CLAUDE.md`** (resolved relative к project CLAUDE.md)

Каждый последующий источник **дополняет** предыдущие (concat), но в случае конфликтов более поздний имеет приоритет в восприятии модели.

## CWD upward search — детально

«CWD» = current working directory процесса Claude Code. Для systemd-сервиса это значение `WorkingDirectory=` в unit-файле. Для ручного запуска — каталог откуда вы вызвали `claude`.

Алгоритм:

```python
# pseudo-code
def find_project_claude_md(cwd):
    path = absolute(cwd)
    while path != "/":
        candidate = path + "/CLAUDE.md"
        if exists(candidate):
            return candidate
        path = dirname(path)
    return None
```

То есть **первый** найденный `CLAUDE.md` побеждает. Если у вас есть несколько `CLAUDE.md` на разных уровнях — подхватится ближайший к CWD.

### Пример с конфликтом

```
/home/alice/.claude-lab/agent1/.claude/CLAUDE.md      ← "Я Agent1"
/home/alice/.claude-lab/agent1/.claude/plugin/CLAUDE.md  ← "Я Plugin Identity"

CWD = /home/alice/.claude-lab/agent1/.claude/plugin/
→ найден plugin/CLAUDE.md первым ("Я Plugin Identity")
→ агент потеряет identity "Agent1"
```

Решение: не создавайте `CLAUDE.md` внутри каталога плагина. Один `CLAUDE.md` на workspace.

## `@-include` директивы

Project `CLAUDE.md` может включать другие файлы:

```markdown
# MyAgent

## Identity
Я — MyAgent.

@core/USER.md
@core/rules.md
@core/warm/decisions.md
@core/hot/handoff.md
```

Пути относительны **директории, где лежит project CLAUDE.md**, не относительно CWD.

То есть если `CLAUDE.md` лежит в `~/.claude-lab/myagent/.claude/`, то `@core/USER.md` → `~/.claude-lab/myagent/.claude/core/USER.md`.

### External imports

Если `@-include` указывает на файл **вне** CWD дерева, Claude Code считает это «external import» и при первом запуске показывает интерактивный промт:

```
Allow external CLAUDE.md file imports?

External imports:
  /home/alice/.claude-lab/myagent/.claude/core/USER.md
  /home/alice/.claude-lab/myagent/.claude/core/rules.md
  ...

❯ 1. Yes, allow external imports
  2. No, disable external imports
```

Это **по дизайну** — защита от того, что вы случайно склонировали стороннее репо и его `CLAUDE.md` пытается подгрузить файлы из вашего home.

В нашем случае CWD = `<workspace>/dashi-plugin-claude-code/plugin/`, а `@-include` целит в `<workspace>/core/*` — это «выше по дереву», формально external. Поэтому промт всегда показывается.

Ответ — `1` (разрешить). Persistent fix — см. [03-installation.md → Persistent welcome approvals](03-installation.md#persistent-welcome-approvals) (точные OS-варианты — [Linux](03-installation-linux.md#persistent-welcome-approvals-чтобы-не-нажимать-enter-после-каждого-рестарта) / [macOS](03-installation-macos.md#persistent-welcome-approvals)).

## Settings.json hierarchy

Помимо `CLAUDE.md`, Claude Code читает `settings.json` файлы:

1. **Global** — `~/.claude/settings.json`
2. **Project local** — `<workspace>/.claude/settings.local.json`
3. **Project shared** — `<workspace>/.claude/settings.json`

Они мёрджатся (последний перекрывает) и содержат: permissions, hooks, env, MCP server list, theme, model выбор.

Для плагина критичны:
- `hooks.PreToolUse/PostToolUse/Stop/etc` — обработчики событий Claude Code, через которые плагин получает status updates и пишет memory
- `permissions.allow/deny` — какие tools/команды разрешены автоматически

`install-hooks.sh` плагина модифицирует `~/.claude/settings.json` (а не project) — это делает hooks доступными для **любой** Claude Code сессии этого пользователя, не только для плагина. Если у вас несколько агентов под одним service-user — будьте в курсе, что hooks shared.

> **Ловушка (важно): хуки плагина ОБЯЗАНЫ жить в глобальном `~/.claude/settings.json`, а не в project settings.**
>
> Project settings (`<project>/.claude/settings.json`) определяются от **cwd сессии** (точнее — от git-root этого cwd), а не от вашего workspace-каталога агента. Сервис плагина обычно стартует с `WorkingDirectory=<...>/jarvis-channel/plugin`, поэтому «project» для сессии — это репозиторий плагина, а **не** `~/.claude-lab/<agent>/`. Если вы зарегистрируете хук в `~/.claude-lab/<agent>/.claude/settings.json`, рассчитывая что это «project settings», — живая сессия его **не прочитает**, и хук молча не сработает.
>
> Реальный инцидент (2026-05-29): read-receipt хук (детерминированная 👀-реакция «агент прочитал сообщение») положили в `~/.claude-lab/<agent>/.claude/settings.json`. Сессия канала стартует из `jarvis-channel/plugin` → читает глобальный `~/.claude/settings.json` → хук не подхватился → реакции 👀 пропали полностью. Диагностический признак: **ни один** Stop-хук из workspace-settings не отрабатывал (heartbeat пустой, `handoff.md`/`recent.md` не обновлялись). Лечение — перенести хук в глобальный `~/.claude/settings.json` + рестарт сервиса.
>
> Правило: **все** хуки плагина (`PreToolUse`/`PostToolUse`/`Stop`/`UserPromptSubmit`) регистрируются только в глобальном `~/.claude/settings.json`. Workspace-level settings подходят лишь для `permissions`/`env`, которые мёрджатся независимо от cwd.

## MCP servers

`<workspace>/.mcp.json` (и `~/.claude/mcp.json`) — список MCP-серверов которые Claude Code подключит при старте.

```json
{
  "mcpServers": {
    "my-server": {
      "type": "http",
      "url": "https://mcp.example.com/...",
      "headers": {
        "Authorization": "Bearer ${MY_API_KEY}"
      }
    }
  }
}
```

Если MCP-сервер недоступен — Claude Code залогирует, но **не упадёт**. Плагин стартанёт без этого MCP. После старта вы можете запустить `/mcp` в Claude Code и увидеть статус каждого сервера.

## State и persistence

Сессия Claude Code persistent в течение жизни процесса. Контекст:
- Чтение `CLAUDE.md` / `@-include` — один раз на старте
- Все user messages из channel-плагина — добавляются к контексту
- Все tool calls и их результаты — в контексте
- Когда контекст приближается к лимиту — auto-compact (Claude Code сжимает старые сообщения в summary)

После рестарта сервиса — **новая** сессия с нуля. Контекст потерян. Поэтому:
- Используйте memory hooks плагина (`<workspace>/core/hot/recent.md` + `verbose.jsonl`)
- Принимайте что после рестарта агент «забывает» текущий разговор — но может прочитать `recent.md` если ему это сказать в CLAUDE.md
- Для production: минимизируйте рестарты, используйте `Restart=on-failure` (не `always`), мониторьте uptime

## Каноническая структура (резюме)

```
~/.claude-lab/<agent>/.claude/             ← workspace root
├── CLAUDE.md                              ← project system prompt
├── settings.json                          ← project settings (опционально)
├── settings.local.json                    ← local secrets/permissions (опционально)
├── .mcp.json                              ← MCP servers для этого agent
├── core/                                  ← разделённая память (@-include)
│   ├── USER.md
│   ├── rules.md
│   ├── hot/{recent.md, handoff.md}
│   ├── warm/{decisions.md}
│   └── ...
└── dashi-plugin-claude-code/              ← плагин (внутри workspace!)
    ├── plugin/                            ← CWD при systemd запуске
    │   ├── src/
    │   ├── package.json
    │   └── ...
    ├── docs/
    └── examples/

~/.claude/                                 ← user-level
├── CLAUDE.md                              ← глобальные инструкции (опционально)
├── settings.json                          ← глобальные settings + hooks
└── ...
```

`WorkingDirectory=` в systemd → `~/.claude-lab/<agent>/.claude/dashi-plugin-claude-code/plugin/`.

Claude Code upward search:
1. `.../plugin/CLAUDE.md` — нет
2. `.../dashi-plugin-claude-code/CLAUDE.md` — нет
3. `.../.claude/CLAUDE.md` — **найден** ✓

Плюс глобальный `~/.claude/CLAUDE.md` — оба мёрджатся.

Понимая эту механику, любая проблема с identity / памятью / MCP отлаживается за 5 минут.
