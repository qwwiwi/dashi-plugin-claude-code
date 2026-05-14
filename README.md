# qwwiwi-channel-telegram-Claude-code

Custom Claude Code **channel plugin** для Telegram — миграция Orgrimmar agents с `claude -p` gateway на channel-pattern.

## Зачем

С **2026-06-15** Anthropic разделяет биллинг:
- Interactive Claude Code (terminal / IDE) → subscription pool (Max)
- `claude -p`, Agent SDK, GitHub Actions → отдельный $200/мес SDK credit

Текущий `jarvis-telegram-gateway` спавнит `claude -p` на каждый turn → весь Telegram-трафик принца уходит в ограниченный SDK pool.

Решение: MCP-сервер с capability `claude/channel`, который пушит Telegram events в живую interactive-сессию Claude Code. Сессия остаётся в Max pool.

## Архитектура

```
Telegram Bot API
      ↓ getUpdates
Channel MCP server (Bun / TypeScript)
      ↓ stdio + claude/channel capability
Claude Code (interactive session under launchd)
      ↓ reply
sendMessage / sendDocument
```

## Status

WIP — Pre-flight + Phase 0 canary запланированы. Action plan: см. `core/artifacts/jarvis-channel-action-plan-v2.html` в silvana-agent workspace.

## Stack

- Bun 1.1+ / TypeScript
- `@modelcontextprotocol/sdk`
- Telegram Bot API (long-poll)
- launchd (Mac mini)

## Roadmap

| Phase | Описание | ETA |
|-------|----------|-----|
| Pre-flight | 10 проверок, baseline | 20 мин |
| Phase 0 | Canary билинга под launchd | 3 ч + 48 ч observation |
| Phase 1 | MVP single-agent (Silvana) | 4 ч |
| Phase 2 | Parity port: streams, media, voice, albums | 1.5–3 дня |
| Phase 3 | Permission relay + pre-trust | 2 ч |
| Phase 4 | Per-token cutover 5 агентов | 3 ч |
| Phase 5 | Decommission gateway.py | ~1 неделя observation |

D-day: **2026-06-15**.

## Related repos

- `qwwiwi/gateway-dashis-agents` (private) — текущий gateway, который заменяем
- `qwwiwi/jarvis-telegram-gateway` (public) — generic база
- `qwwiwi/agents-edgelab` — Тиранда / Hermes (берёт крон-нагрузку без Anthropic)

## Owner

@qwwiwi (Dashi) · Orgrimmar Silvana coordination
