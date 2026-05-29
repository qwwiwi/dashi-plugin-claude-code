# Архитектура: Channel-pattern

## Сейчас (до 15.06.2026)

```
┌──────────────┐
│   Telegram   │
└──────┬───────┘
       │ Bot API long-poll (getUpdates)
       ▼
┌──────────────────────────────┐
│ jarvis-telegram-gateway      │
│ Python daemon, launchd       │
│ ~/.claude-lab/shared/gateway │
└──────┬───────────────────────┘
       │ spawn per turn
       ▼
┌──────────────────────────────┐
│   claude -p (headless)       │
│   ← после 15.06 = SDK pool   │
└──────────────────────────────┘
```

Проблема: `claude -p` после 15.06 = $200 Agent SDK credit, не Max subscription.

## Целевая архитектура

```
┌──────────────┐
│   Telegram   │
└──────┬───────┘
       │ getUpdates
       ▼
┌──────────────────────────────┐
│ jarvis-channel MCP server    │
│ Bun + TypeScript             │
│ capability: claude/channel   │
└──────┬───────────────────────┘
       │ stdio MCP transport
       │ (push events)
       ▼
┌──────────────────────────────┐
│ Claude Code interactive      │
│ session under launchd        │
│ → Max subscription pool      │
└──────────────────────────────┘
```

Ключевое отличие: Claude Code запускается один раз и держит **живую сессию**. MCP-сервер не вызывает Claude — он **пушит события** в уже работающую сессию через `claude/channel` capability.

## Per-agent изоляция

Каждый агент Orgrimmar — отдельная channel-сессия:

```
~/Library/LaunchAgents/
├── ai.orgrimmar.channel.silvana.plist
├── ai.orgrimmar.channel.kaelthas.plist
├── ai.orgrimmar.channel.garrosh.plist
├── ai.orgrimmar.channel.arthas.plist
└── ai.orgrimmar.channel.claude.plist
```

Каждый plist:
- Запускает `claude --dangerously-load-development-channels plugin:jarvis-channel@local --channels jarvis-channel` под user-сессией
- Получает свой bot token через env var
- Имеет per-token getUpdates consumer (никаких race condition)

## Capabilities

| MCP capability | Что делает |
|----------------|------------|
| `claude/channel` | Пушит Telegram events (text, photo, voice, document) в сессию |
| `claude/channel/permission` | Передаёт tool approval requests обратно в Telegram через 5-letter codes |

## Параллельная архитектура для крон'ов: Tyrande / MiniMax

Anthropic-зависимые крон'ы переезжают на отдельный путь:

```
Mac mini cron / launchd timer
       │
       ▼ POST /summarize, /audit, /digest
┌──────────────────────────────┐
│ Tyrande / Hermes server      │
│ 165.245.219.131              │
│ MiniMax M2.7                 │
│ Zero Anthropic dependency    │
└──────┬───────────────────────┘
       │ result
       ▼ Telegram sendMessage
   @fridayhumanbot
```

Применимо для: reflection summary, cognee post-cognify digest, weekly digest, learnings audit.

**Не применимо для**: code review, architecture decisions, security audits — там остаётся Opus / Codex.

## Loop guards (bot-to-bot orchestration)

Telegram официально предупреждает о bot loops. Обязательные защиты:

- **Depth-limit**: max 3 hops, заголовок `X-Orgrimmar-Depth` инкрементится в каждом сообщении
- **Dedupe**: bloom-фильтр / sqlite по message hash, TTL 60s
- **Per-bot rate-limit**: 10 msg/min, token bucket с экспоненциальным backoff
- **Permission codes**: принимаются **только** от `user_id 123456789` (принц), никогда от peer-ботов
- **Kill-switch**: `/halt` от принца → все channel-сессии паузятся
