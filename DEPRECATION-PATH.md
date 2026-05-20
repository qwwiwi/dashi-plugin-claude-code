# Deprecation path

Если вы пришли из:

- [qwwiwi/jarvis-telegram-gateway](https://github.com/qwwiwi/jarvis-telegram-gateway) (Python, public)
- [qwwiwi/gateway-dashis-agents](https://github.com/qwwiwi/gateway-dashis-agents) (Python, private fork)

— оба репо **deprecated с 2026-06-15**.

## Почему

Anthropic 15 июня 2026 разделяет billing:
- `claude -p` (Agent SDK) → отдельный $200/мес pool
- Interactive Claude Code сессия → остаётся в Max subscription

Старая gateway-архитектура (Python-демон спавнит `claude -p` на каждое сообщение в Telegram) после cutover расходует деньги из SDK pool на каждый turn. Этот плагин держит **одну** живую interactive сессию — расход остаётся в Max.

## Сроки

- **до 2026-06-15** — обе архитектуры работают параллельно. Мигрируйте спокойно.
- **2026-06-15** — Anthropic разделяет billing. Старая архитектура продолжает работать технически, но дорого.
- **2026-09-15** — `qwwiwi/jarvis-telegram-gateway` будет переведён в archived состояние (read-only). PR/issues закроются.
- **2026-12-15** — последний day когда мы держим compatibility patches для старого gateway. После этой даты — нет fix'ов, нет support.

## Как мигрировать

Полная пошаговая инструкция — [docs/04-migration-from-gateway.md](docs/04-migration-from-gateway.md).

Короткая версия:

1. Backup всего (gateway, workspace, секреты, systemd unit)
2. Установите плагин **рядом** с gateway, на тестовом боте (не трогая production)
3. Smoke test плагина в полной изоляции
4. Cutover: stop gateway → 30s wait → start plugin → smoke production
5. Через 7-14 дней — удаление gateway

## Что забрать со старой архитектуры

| Артефакт | Куда мигрировать в плагин |
|---|---|
| `TELEGRAM_BOT_TOKEN` | `channel.env: TELEGRAM_BOT_TOKEN=` (без изменений) |
| `ALLOWED_USER_IDS` | `channel.env: TELEGRAM_ALLOWED_USER_IDS=` |
| `WORKSPACE_DIR` или `--add-dir` | `~/.claude-lab/<agent>/.claude/` + `WorkingDirectory=` в systemd |
| `CLAUDE.md` (если был) | `~/.claude-lab/<agent>/.claude/CLAUDE.md` |
| Логи / историю чата | `<workspace>/core/hot/recent.md` через memory hooks плагина |
| Permission policy | `~/.claude/settings.json` через `install-hooks.sh` |
| MCP servers | `<workspace>/.mcp.json` |

## Что НЕ переносится автоматически

- **Custom Python скрипты** которые висели на pre/post hooks gateway — нужно переписать на TypeScript plugin hooks или вынести в отдельный MCP-сервер.
- **Webhook integrations** на старый gateway — endpoint URL меняется, ваши внешние системы (Hermes, CI, и т.д.) должны быть переключены на `http://127.0.0.1:8089/hooks/agent` (или ваш `TELEGRAM_WEBHOOK_PORT`).
- **Telethon/Pyrogram MTProto клиенты** — плагин использует только Bot API (`api.telegram.org/bot...`). Если у вас был MTProto user-account доступ через gateway — это отдельная архитектурная задача, плагин её не решает.

## Поддержка миграции

- **Issues по миграции** — [github.com/qwwiwi/dashi-plugin-claude-code/issues](https://github.com/qwwiwi/dashi-plugin-claude-code/issues) с тегом `migration`. Опишите ваш текущий setup максимально подробно.
- **Telegram чат поддержки** — открывается ближе к 2026-06-01 (ссылка появится здесь и в [README.md](README.md))

## Не успеваете до 2026-06-15?

- Технически — gateway продолжит работать (Anthropic ничего не блокирует), просто билинг разделится. Если у вас низкий объём (несколько десятков сообщений в день) — расход может остаться в рамках бюджета.
- Если объём большой — переезжайте **в мае** 2026, не ждите последней недели.
- Если переезд невозможен по техническим причинам — открывайте issue с тегом `cant-migrate`, обсудим архитектурную альтернативу.
