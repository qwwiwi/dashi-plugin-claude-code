# План переезда

> Update 2026-05-14: этот план фиксирует исходный launchd/channel rollout. После ревью tmux-подходов primary operational path перенесен в [06-tmux-migration-goal-plan.md](06-tmux-migration-goal-plan.md): `launchd -> supervisor -> tmux -> claude --channels`. Прямой launchd/no-TTY запуск больше не является preferred path.

## Pre-flight (20 минут, 10 проверок)

1. **Claude Code 2.1.80+** — `claude --version`. Минимум для channels.
2. **CLI synthax verify** — `claude --help | rg "channels|dangerously-load"`, подтвердить актуальные флаги.
3. **Hosts scan** — grep на Mac mini, Thrall, Timeweb, gbrain: `claude -p`, `claude --print`, `@anthropic-ai/sdk`, `import anthropic`, `ANTHROPIC_API_KEY`.
4. **5 bot tokens доступны** — `~/.claude-lab/{silvana,kaelthas,garrosh,arthas,claude}/secrets/telegram-bot-token`.
5. **Bun runtime 1.1+** — `bun --version`.
6. **Tyrande доступна** — `ssh root@165.245.219.131` + curl health check.
7. **Baseline Max consumption** — 5-дневный snapshot пиков по часам (для канарейки и пост-15.06 сравнения).
8. **Project trust + MCP consent pre-approved** — `claude trust list`, все проекты trusted локально (иначе deadlock в launchd).
9. **Reboot test plan** — сценарий: Mac mini рестарт → launchd поднимает сессию → OAuth keychain работает → channel принимает событие.
10. **Backup gateway.py + config.json** — `cp` с timestamp ДО любого изменения.

## Phase 0 — Канарейка (КРИТИЧЕСКАЯ, 3 ч + 48 ч observation)

**Цель**: доказать, что Channel под launchd классифицируется как interactive subscription, а не SDK credit.

| Шаг | Описание |
|-----|----------|
| 1 | Минимальный echo-channel: Bun MCP-сервер, capability `claude/channel`, event "ping" → timestamp в живую сессию |
| 2 | `~/Library/LaunchAgents/ai.orgrimmar.canary.plist` — запускает `claude --dangerously-load-development-channels plugin:canary@local --channels canary` под user session, без TTY |
| 3 | Внешний триггер каждые 5 мин (cron / отдельный launchd), 48 часов прогона |
| 4 | Проверка `console.anthropic.com → usage` — раздельные счётчики subscription vs SDK credit |
| 5 | Письмо в Anthropic support — описать launchd, no TTY, --channels плагин, OAuth Max, прямой вопрос про классификацию |
| 6 | **Gate PASS / FAIL** — PASS = subscription pool → Phase 1. FAIL = пересматриваем стратегию |

**Fallback при FAIL**: гибрид — Channel запускается из `tmux` / `screen` внутри активной user-сессии (true TTY), Tyrande берёт 100% крон-логики, latency хуже но Max pool сохраняется.

## Линия A — Channel rollout (2–4 дня)

### Phase 1: MVP single-agent (~4 ч)

Один бот (Silvana), один канал, минимум фич — доказать roundtrip Telegram event → живая Claude Code сессия.

- Bun + TypeScript MCP server (`jarvis-channel/src/index.ts`)
- Capability `claude/channel`
- Telegram Bot API long-poll внутри плагина
- Allowlist `user_id 123456789`
- Plain text reply через `sendMessage` (без HTML, без media)

### Phase 2: Parity port (1.5–3 дня)

Перенести логику `gateway.py` (3 748 строк):

- Streaming status (печатает / думает / 🔧 tool) — `editMessageText` каждые ~700ms
- Markdown → Telegram HTML конвертер (порт `md2tg.py`)
- Media: photo / document / voice download + attach
- Voice → Whisper (Groq) → text
- Album buffer (media-group, 2-секундное окно агрегации)
- Webhook injection (reply-to-message untrusted metadata)
- OOB commands: `/reset`, `/stop`, `/status`, `/compact`

### Phase 3: Permission relay + pre-trust (~2 ч)

Закрыть deadlock в headless launchd:

- Capability `claude/channel/permission` — MCP слушает запросы Bash/Write/Edit approval
- 5-letter codes в Telegram (`yes abcde / no abcde`), owner-only, TTL 5 мин, replay-protection
- **Pre-trust ВСЕХ проектов**: `claude trust add` для каждого workspace ДО запуска под launchd
- **Pre-approve MCP servers**: `.mcp.json` серверы в "approved" state локально

### Phase 4: Per-token cutover (~3 ч)

Каждый bot token — ровно один консьюмер `getUpdates`. Никакой параллельной работы.

Порядок: `silvana → kaelthas → garrosh → arthas → claude`. Для каждого:

1. `config.json`: disable агент в gateway.py
2. `launchctl load channel-{agent}.plist`
3. Telegram smoke test (ping → ответ ≤ 30s)
4. Ack принцу

Resource ceiling test: 6 channel-сессий, мониторим RSS / log growth / crash loop 4 часа.

Durable event queue + ack: буфер на диске на случай busy сессии (channel events не подтверждаются Claude Code).

### Phase 5: Decommission (~1 неделя observation)

- `launchctl unload ai.orgrimmar.gateway`
- 7 дней мониторинга (что упало / лагает / пропустилось)
- `git tag jarvis-pre-channel-final`
- `gateway.py → archive/`

## Линия B — Tyrande / MiniMax для крон'ов (~5 ч)

### Phase A: Inventory + setup (~1 ч)

- Mac mini: `launchctl list` + `crontab -l`, grep claude
- Thrall: `systemctl list-timers` + `crontab -u openclaw -l` + `scripts/*.sh`
- Timeweb + gbrain: аналогично
- Создать `@tyrandebot` через BotFather, Bot-to-Bot Communication ON
- Создать группу «Orgrimmar Ops»: prince + все 6 ботов

### Phase B: Pilot reflection summary (~1 ч)

- Tyrande endpoint: `POST /summarize`
- Quality A/B vs Claude Sonnet на 10 примерах
- Mac mini cron вызывает Tyrande, постит в `@fridayhumanbot`

### Phase C: Migrate remaining (~2–3 ч)

- Cognee post-cognify summary
- Weekly digest
- Learnings audit

**НЕ переносим**: code review, architecture, security — Opus / Codex остаются.

## Таймлайн до 15.06.2026

| Дата | Активность |
|------|-----------|
| 14.05 (сегодня) | Pre-flight + Phase 0 canary запуск |
| 17.05 — 18.05 | Канарейка крутится, оцениваем дашборд |
| 18.05 | **Canary GATE — PASS / FAIL** |
| 19.05 — 24.05 | Phase 1 + Phase 2 (5 дней с буфером) |
| 25.05 | Phase 3 (permission relay + pre-trust) |
| 26.05 — 27.05 | Phase 4 (per-token cutover, 5 агентов) |
| параллельно (19–20.05) | Phase A/B Тиранды |
| 28.05 — 04.06 | Phase 5 observation + Phase C Тиранды |
| 05.06 — 14.06 | Finetune, мониторинг, edge cases, support письмо |
| **15.06.2026** | **D-day** — Anthropic billing split, мы готовы |
