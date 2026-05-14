# Контекст: зачем переезд

## Что меняется у Anthropic — 2026-06-15

Anthropic анонсировал разделение биллинга для Claude Code и Agent SDK с **15 июня 2026**:

| Использование | Куда уходит после 15.06 |
|---------------|-------------------------|
| Interactive Claude Code (terminal / IDE) | Subscription pool (Max) — без изменений |
| `claude -p` headless | Agent SDK $200/мес credit |
| Agent SDK (Python/TS) | Agent SDK $200/мес credit |
| GitHub Actions с SDK auth | Agent SDK $200/мес credit |
| Third-party app с SDK auth | Agent SDK $200/мес credit |

Источник: <https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan>

## Почему это проблема для Orgrimmar

Текущий стек коммуникации принца с агентами:

```
Telegram → Jarvis Gateway (gateway.py) → claude -p (headless) → ответ
```

`gateway.py` спавнит новый `claude -p` процесс на каждый turn. После 15.06 **весь** трафик Telegram-разговоров с принцем + 5 агентов улетит в Agent SDK pool ($200), а не в Max subscription.

Объём — десятки тысяч токенов в день только на Telegram-роутинг. $200/мес не хватит.

Дополнительно — Anthropic-зависимые кроны (reflection summary, cognee-cognify post-processing, weekly digest, learnings audit) также используют `claude --print` → тоже уйдут в SDK pool.

## Что мы хотим обойти

Не «обойти» биллинг, а **корректно остаться** на Max subscription, используя задокументированный механизм:

1. **Channel-pattern** (research preview) — MCP-сервер пушит события в **живую interactive-сессию** Claude Code. Сессия классифицируется как interactive → subscription pool.
2. **Внешние LLM для крон-логики** — Tyrande / Hermes / MiniMax M2.7 на нашем сервере, без вызова Anthropic вообще.

## Цель

К 15.06.2026 иметь:
- Zero usage Agent SDK credit pool для Telegram-коммуникации
- Zero `claude -p` / `claude --print` в кронах (всё на Tyrande)
- Доказательство (Anthropic dashboard + письмо support), что классификация корректная
- Rollback path на случай, если что-то пойдёт не так

## Ссылки

- [Anthropic billing support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Claude Code Channels reference](https://code.claude.com/docs/en/channels-reference)
- [Telegram Bot Features (bot-to-bot)](https://core.telegram.org/bots/features)
