# Что это и зачем

## Простыми словами

`dashi-plugin-claude-code` — это плагин для Claude Code, который превращает обычный Claude в Telegram-бота:

- Вы пишете в чат боту «составь план постов на неделю»
- Claude Code обрабатывает запрос в **живой interactive сессии** (как будто вы пишете в терминале)
- Использует все доступные tools (Bash, Read, Write, MCP servers, etc.)
- Возвращает ответ обратно в Telegram

Один процесс плагина = один Telegram бот = один агент.

## Архитектура

```
        ┌──────────────────┐
        │     Telegram     │
        └─────────┬────────┘
                  │ getUpdates (polling)
                  ▼
        ┌──────────────────────────────┐
        │  Claude Code session         │
        │  ┌────────────────────────┐  │
        │  │ dashi-channel plugin   │  │   ← Bun + TypeScript
        │  │   - poller             │  │
        │  │   - handlers           │  │
        │  │   - status manager     │  │
        │  │   - permission relay   │  │
        │  └──────────┬─────────────┘  │
        │             │ channel push   │
        │             ▼                │
        │  Live Claude (Opus / Sonnet) │
        │   ↳ reads CLAUDE.md          │
        │   ↳ uses tools / MCP         │
        │   ↳ generates response       │
        └──────────────────────────────┘
```

## Plugin vs Gateway — критическая разница

До этого плагина существовала «gateway pattern»: Python-демон, который слушал Telegram и **спавнил новую `claude -p` сессию** на каждое сообщение.

| Аспект | Gateway pattern (`claude -p`) | Plugin pattern (этот репо) |
|---|---|---|
| **Процесс Claude** | Новый процесс на каждое сообщение | Один длинный процесс на агента |
| **Контекст между сообщениями** | Нужно вручную передавать через файлы | Live сессия — Claude помнит предыдущий разговор |
| **Billing после 2026-06-15** | Каждое сообщение — расход из Agent SDK pool ($200/мес отдельно) | Interactive сессия — остаётся в Max subscription |
| **Latency** | ~3-5 сек стартап + cold context | Мгновенный — сессия уже горячая |
| **Tools** | `--allowedTools` нужно указывать каждый раз | Полный набор Claude Code сразу |
| **MCP servers** | Подключаются заново на каждый spawn | Подключены постоянно к живой сессии |
| **Permission prompts** | Не работают — `--dangerously-skip-permissions` обязателен | Работают через permission relay |
| **Memory pipeline** | Нужен отдельный writer после каждого spawn | Hooks встроены, пишут автоматически |
| **Stack** | Python 3 + telethon/grammy + subprocess | Bun + TypeScript + grammy + Claude Code Channels API |
| **Failure mode** | Сообщение → spawn → crash → потеря | Сессия живая, плагин рестартится отдельно |

## Зачем это нужно вам

### Вы делаете AI-агента для бизнеса

Бот в Telegram — самый дешёвый и быстрый способ дать клиенту/команде доступ к AI. Не нужно строить web UI. Не нужен мобильный апп. Не нужен auth — Telegram сам аутентифицирует пользователя.

Если использовать `claude -p` (или Agent SDK напрямую), вы платите за каждый turn по API-pricing. С Max subscription + этим плагином — flat $20-200/мес, сколько бы тысяч сообщений ни прошло.

### Вы строите Orgrimmar-стиля multi-agent систему

Плагин рассчитан на per-agent setup: каждый агент в своём workspace, со своими инструкциями (`CLAUDE.md`), своими MCP-серверами, своей памятью. Они не пересекаются.

5 ботов = 5 процессов плагина, 5 systemd units, 5 workspace'ов. Все живут параллельно, не мешают друг другу.

### Вы переезжаете со старого `claude -p` gateway

Anthropic 2026-06-15 разделяет billing: `claude -p` уходит в отдельный pool. Если ваш текущий gateway спавнит `-p` на каждое сообщение — после cutover это станет дорого. Этот плагин — путь миграции.

См. [04-migration-from-gateway.md](04-migration-from-gateway.md).

## Что плагин НЕ делает

- **Не делает AI-агента сам по себе.** Агент — это связка `CLAUDE.md` + memory + MCP-серверы + ваши tools. Плагин — только канал доставки Telegram ↔ Claude session.
- **Не управляет несколькими ботами в одном процессе.** Один процесс = один бот. Хотите 5 ботов — запустите 5 экземпляров плагина (на одной машине или разных).
- **Не заменяет вам подписку Anthropic.** Вы по-прежнему платите за Claude. Плагин просто оптимизирует так, чтобы оставаться в Max pool вместо SDK pool.
- **Не делает прокси для других LLM.** Только Anthropic Claude через Claude Code.

## Что дальше

- Технические детали как Claude Code находит сессию — [06-how-claude-loads-session.md](06-how-claude-loads-session.md)
- Где разместить плагин — [02-where-to-place-plugin.md](02-where-to-place-plugin.md)
- Установка production — [03-installation.md](03-installation.md)
- Миграция со старого gateway — [04-migration-from-gateway.md](04-migration-from-gateway.md)
