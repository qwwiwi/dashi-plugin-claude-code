# qwwiwi-channel-telegram-Claude-code

Custom Claude Code **channel plugin** для Telegram — миграция Orgrimmar agents с `claude -p` gateway на channel-pattern до **15 июня 2026**.

## TL;DR

С 15.06.2026 Anthropic разделяет биллинг: `claude -p` и Agent SDK уходят в отдельный $200/мес pool. Наш текущий Jarvis Gateway спавнит `claude -p` на каждый Telegram-turn → весь трафик 5 агентов утечёт в SDK pool.

Решение: MCP-плагин с capability `claude/channel`, который пушит Telegram events в живую interactive-сессию Claude Code. Сессия классифицируется как interactive → остаётся в Max subscription.

Параллельно: Anthropic-зависимые кроны (reflection summary, weekly digest и т.д.) переезжают на Tyrande / Hermes / MiniMax M2.7 — zero Anthropic dependency.

## Документация

| Док | Содержание |
|-----|-----------|
| [docs/01-context.md](docs/01-context.md) | Зачем переезд, что меняется у Anthropic, цель |
| [docs/02-architecture.md](docs/02-architecture.md) | Текущая vs целевая архитектура, capabilities, loop guards |
| [docs/03-plan.md](docs/03-plan.md) | Pre-flight + Phase 0–5 + Phase A–C + таймлайн до 15.06 |
| [docs/04-codex-review.md](docs/04-codex-review.md) | Codex GPT-5.5 ревью: 6 правок до старта |
| [docs/05-success-criteria.md](docs/05-success-criteria.md) | 8 чеков перед D-day + rollback strategy |

## Презентации (HTML)

| Файл | Назначение |
|------|------------|
| [artifacts/jarvis-channel-migration.html](artifacts/jarvis-channel-migration.html) | Первая версия — концепция, что меняется и почему остаёмся на Max |
| [artifacts/jarvis-channel-action-plan.html](artifacts/jarvis-channel-action-plan.html) | Промежуточный план — Phase 1–5 + Phase A–C |
| [artifacts/jarvis-channel-action-plan-v2.html](artifacts/jarvis-channel-action-plan-v2.html) | **Финальный план** после Codex review — с Phase 0 канарейкой |

## Roadmap (high-level)

| Phase | Описание | ETA |
|-------|----------|-----|
| Pre-flight | 10 проверок, baseline Max consumption | 20 мин |
| **Phase 0** | **Canary билинга под launchd (КРИТИЧЕСКАЯ)** | 3 ч + 48 ч observation |
| Phase 1 | MVP single-agent (Silvana) | 4 ч |
| Phase 2 | Parity port: streams, media, voice, albums | 1.5–3 дня |
| Phase 3 | Permission relay + pre-trust | 2 ч |
| Phase 4 | Per-token cutover 5 агентов | 3 ч |
| Phase 5 | Decommission gateway.py | ~1 неделя observation |
| Phase A | Inventory крон'ов + @tyrandebot | 1 ч |
| Phase B | Pilot: reflection summary через MiniMax | 1 ч |
| Phase C | Migrate остальные Anthropic-зависимые крон'ы | 2–3 ч |

**D-day: 2026-06-15** — Anthropic billing split.

## Stack

- Bun 1.1+ / TypeScript
- `@modelcontextprotocol/sdk`
- Telegram Bot API (long-poll)
- launchd (Mac mini)
- Tyrande / Hermes на 165.245.219.131 (MiniMax M2.7) для крон'ов

## Status

**WIP** — Pre-flight + Phase 0 canary запланированы. Старт по сигналу принца. Месяц до D-day.

## Related repos

- [qwwiwi/gateway-dashis-agents](https://github.com/qwwiwi/gateway-dashis-agents) (private) — текущий gateway, который заменяем
- [qwwiwi/jarvis-telegram-gateway](https://github.com/qwwiwi/jarvis-telegram-gateway) (public) — generic база
- [qwwiwi/agents-edgelab](https://github.com/qwwiwi/agents-edgelab) (private) — Tyrande / Hermes (берёт крон-нагрузку без Anthropic)

## External references

- [Anthropic billing support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Claude Code Channels reference](https://code.claude.com/docs/en/channels-reference)
- [Telegram Bot Features (bot-to-bot)](https://core.telegram.org/bots/features)

## Owner

@qwwiwi (Dashi) · Orgrimmar Silvana coordination
