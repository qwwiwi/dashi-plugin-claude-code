# dashi-plugin-claude-code

**Telegram → Claude Code channel plugin.** Превращает обычную Claude Code сессию в Telegram-агента, который слушает один или несколько чатов, отвечает в той же сессии, и оставляет всю работу внутри Anthropic Max подписки.

Замена устаревшему `claude -p` gateway pattern. Cutover deadline — **2026-06-15** (Anthropic billing split, см. ниже).

```
[ Telegram ]
     │
     ▼  getUpdates / webhook
[ plugin (Bun + TS) ]──── pushes channel message ───▶ [ Claude Code session ]
     ▲                                                       │
     │  reply / status / reactions                           │  thinking + tools + final answer
     └───────────────────────────────────────────────────────┘
```

Один процесс плагина = один Telegram бот. По умолчанию обслуживается ОДИН DM-чат (legacy single-DM режим). При включённом `multichat.enabled` тот же бот раскладывает входящие сообщения по нескольким per-chat tmux-сессиям `claude` через MultichatRouter — см. секцию «Multichat (опционально)» ниже.

---

## Статус

- **Дата:** 2026-05-27
- **Ветка активной разработки:** `feature/codex-review-fixes` (поверх `feature/multichat-thrall` + `origin/main`)
- **Последний смерженный PR:** [#25](https://github.com/qwwiwi/dashi-plugin-claude-code/pull/25) — `fix(status)`: подавление пустой «Печатает…» bubble; lazy creation первого status message
- **Предыдущие крупные merges:** PR #22 (default `format='html'` в reply), PR #21 (`latest_inbound_only` + `max_lines` для TmuxMirror), PR #17 (`/mirror on|off|status` OOB), PR #15 (TmuxMirror), PR #14 (token-bucket + 429 retry), PR #13 (TaskMirror + noise-filter), PR #11 (TaskMirror + InboundWatcher), PR #8 (safe-telegram-api + redactor + HTML-validator)
- **CI:** `bun test` + `bun run typecheck` — должны проходить чисто перед merge. Точные цифры покрытия растут по мере PR, поэтому в этом README не фиксируются — смотрите вывод CI на конкретном коммите.

---

## Почему вы тут

Вы один из двух типов читателей:

1. **Ученик EdgeLab / новичок** — хотите свой Telegram-агент на Claude Code, без зоопарка инфраструктуры. Идите в [docs/01-what-is-this.md](docs/01-what-is-this.md) → [docs/03-installation.md](docs/03-installation.md).

2. **Мигрируете с `jarvis-telegram-gateway` или `gateway-dashis-agents`** — старый Python `claude -p` gateway отключается 2026-06-15. Идите в [docs/04-migration-from-gateway.md](docs/04-migration-from-gateway.md).

В обоих случаях **обязательно прочитать** [docs/02-where-to-place-plugin.md](docs/02-where-to-place-plugin.md) — там объясняется почему расположение каталога с плагином критично для правильной загрузки сессии. 90% проблем при первом запуске — оттуда.

---

## Быстрый старт

```bash
# 1. Pre-requirements — Bun runtime
curl -fsSL https://bun.sh/install | bash   # macOS / Linux

# 2. Создайте workspace для агента (если ещё нет)
mkdir -p ~/.claude-lab/myagent/.claude
mkdir -p ~/.claude-lab/myagent/secrets        # для channel.env (macOS-friendly)
cd ~/.claude-lab/myagent/.claude

# 3. Склонируйте плагин ВНУТРЬ workspace
git clone https://github.com/qwwiwi/dashi-plugin-claude-code.git
cd dashi-plugin-claude-code/plugin
bun install

# 4. Скопируйте example config + впишите свой Telegram bot token
#    (универсально для Linux + macOS — кладём в свой workspace)
cp ../examples/channel.env.example ~/.claude-lab/myagent/secrets/channel.env
chmod 600 ~/.claude-lab/myagent/secrets/channel.env
$EDITOR ~/.claude-lab/myagent/secrets/channel.env

# 5. Запустите плагин (один из двух вариантов)
#    a) Standalone Bun-процесс (быстрая проверка токена):
set -a; . ~/.claude-lab/myagent/secrets/channel.env; set +a
bun start

#    b) Через Claude Code (production-вариант — Claude Code держит plugin runtime):
cd ~/.claude-lab/myagent/.claude/dashi-plugin-claude-code/plugin
set -a; . ~/.claude-lab/myagent/secrets/channel.env; set +a
claude --dangerously-load-development-channels server:dashi-channel

# 6. ОБЯЗАТЕЛЬНО — установите Claude Code hooks
#    Без них ProgressReporter / TaskMirror / ActivityRenderer не получат
#    PreToolUse / PostToolUse / Stop / UserPromptSubmit события, и
#    Telegram-канал не будет показывать прогресс по инструментам.
bash scripts/install-hooks.sh \
  --settings ~/.claude/settings.json \
  --chat-id <ваш-Telegram-chat-id> \
  --webhook-url http://127.0.0.1:8089/hooks/agent \
  --agent-id dashi-channel
```

При первом запуске через `claude --dangerously-load-development-channels` Claude Code задаст 2 интерактивных вопроса (allow external imports + dev channels) — это **разово**. После ответа `1` на оба плагин стартует и начнёт слушать вашего бота.

**Production setup** (чтобы агент работал автономно после reboot):
- **Linux** → [docs/03-installation-linux.md](docs/03-installation-linux.md) (systemd)
- **macOS / Mac mini** → [docs/03-installation-macos.md](docs/03-installation-macos.md) (launchd)
- **Сравнение OS** → [docs/03-installation.md](docs/03-installation.md)

---

## Multichat (опционально)

По умолчанию плагин обслуживает один DM-чат — legacy single-session режим, ничего настраивать не нужно. Когда нужно вести параллельно несколько чатов (DM вождя + рабочая группа + sandbox) одной и той же Claude Code identity, включается MultichatRouter:

1. Включите флаг в `config.json` (или через env):

   ```json
   {
     "multichat": {
       "enabled": true,
       "workspace_dir": "/home/you/.claude-lab/myagent/.claude",
       "policy_path": "/home/you/.claude-lab/myagent/.claude/chats/policy.yaml",
       "state_dir": "/home/you/.claude-lab/myagent/.claude/state/multichat"
     }
   }
   ```

   Эквивалент в env: `TELEGRAM_MULTICHAT_ENABLED=1`, `TELEGRAM_MULTICHAT_POLICY_PATH=...`, `TELEGRAM_MULTICHAT_STATE_DIR=...`, `TELEGRAM_MULTICHAT_WORKSPACE_DIR=...`. Все четыре опциональны: enabled=false (по умолчанию) выключает фичу целиком; остальные пути имеют разумные defaults относительно `workspace_dir`.

2. Опишите чаты в `chats/policy.yaml` (см. [`plugin/src/chats/policy-loader.ts`](plugin/src/chats/policy-loader.ts) — там Zod-схема в strict-режиме, опечатка в ключе уронит загрузку с понятной ошибкой):

   ```yaml
   version: 1
   allowlist:
     chats: ["164795011", "-1003784643974"]
     users: ["164795011"]
   mention_allowlist: ["164795011"]
   chats:
     "164795011":
       mode: private
       streaming: progress
       tmux_mirror: true
       edit_message_progress: true
       delivery: streamed
       persona_file: chats/personas/warchief.md
       handoff_file: core/hot/handoff.md
       system_reminder: "Это личный DM вождя. Полный доступ."
     "-1003784643974":
       mode: public
       streaming: off
       tmux_mirror: false
       edit_message_progress: false
       delivery: final_only
       persona_file: chats/personas/intensive-agent-os.md
       handoff_file: chats/handoffs/intensive-agent-os.md
       system_reminder: "Публичная группа. Никаких внутренних логов / mirror'ов."
   ```

3. Перезапустите плагин — при `enabled=true` server.ts загружает policy.yaml, поднимает `TmuxSessionPool` и `MultichatRouter`. При ошибке загрузки политики плагин деградирует обратно в legacy single-DM режим (multichat-OFF) и пишет ошибку в лог.

Безопасность: allowlist — единственный gate. Сообщения от не-разрешённых chat_id / user_id отбиваются ДО любой обработки. Private/public режимы разделяют поверхности: TmuxMirror и progress-edit разрешены только в DM вождя (`mode: private`); в публичных группах (`mode: public`) разрешён только финальный ответ через `delivery: final_only`.

---

## Что вы получаете (текущий feature set)

| Подсистема | Что делает |
|---|---|
| `TelegramPoller` | getUpdates с экспоненциальным retry на 429/5xx (PR #14), per-instance lock на state_dir чтобы не подняли два процесса на одном боте |
| `MultichatRouter` (default OFF) | Per-chat tmux-сессии `claude`, inbox-bridge JSON-pipe, outbox с two-phase claim/confirm/reject (dead-letter при transient sendMessage error) |
| `TmuxSessionPool` | Spawn / supervise / idle-TTL для per-chat tmux-сессий, max_queue_depth gate |
| `PersonaManager` | Per-chat persona-overlay поверх единой Thrall-identity (persona_file + system_reminder из policy) |
| `PolicyLoader` | `chats/policy.yaml` через Zod strict — опечатка в YAML-ключе ломает старт громко, не молча |
| `SecurityPaths` | Канонические пути под workspace, проверки на directory traversal перед записью в state/inbox/outbox |
| `StatusManager` | Transient status bubble: typing → thinking → tool name. `suppress_typing_bubble: true` (default с PR #25) убирает пустую «Печатает…» bubble |
| `TmuxMirror` | Rolling Telegram-mirror агентского tmux pane через `editMessageText`. Режимы `full_pane` / `latest_inbound_only` (default), `max_lines` cap, segment filter, secrets-redactor (PR #15 / #19 / #21) |
| `ProgressReporter` | Persistent activity thread: PreToolUse / PostToolUse / Stop / UserPromptSubmit / SessionStart hooks → строки в отдельном Telegram-сообщении через `editMessageText` (PR #5) |
| `TaskMirror` | Третье rolling сообщение per chat — milestones из `TodoWrite` / `TaskCreate` / `TaskUpdate` (PR #11 / #13) |
| `ActivityRenderer` | Humanization + secret masking + rolling render для ProgressReporter / TaskMirror |
| `InboundWatcher` | Auto-reply «занят» когда вождь пишет text mid-tool (debounced per chat, PR #11) |
| `safe-telegram-api` | Token-bucket outbound queue + 429 retry + unified redactor + pre-send HTML validator (PR #8 / #14). Default `format='html'` в reply (PR #22) |
| OOB commands | `/help`, `/status`, `/stop`, `/reset`, `/new`, `/mirror on|off|status`. `/mirror` тогглит TmuxMirror (PR #17), регистрируется через `setMyCommands` и локализован на русский (PR #18) |
| Permission relay | Telegram-prompt на чувствительный tool → ответ возвращается в сессию |
| Memory hooks (опционально) | После каждого turn — `<workspace>/core/hot/recent.md` + `<workspace_parent>/logs/verbose-YYYY-MM-DD.jsonl` для long-term memory pipeline |
| Anti-spoof | Reply-to message валидируется как принадлежащий вашему боту, отбивает prompt injection через подставные reply-метаданные |

---

## Stack и требования

- **Runtime:** Bun 1.3+ / TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitAny`)
- **Claude Code:** **v2.1.80+** (требование официальной документации для custom channels — см. [Claude Code Channels reference](https://code.claude.com/docs/en/channels-reference))
- **Telegram SDK:** [grammY](https://grammy.dev/) 1.21+
- **Schema validation:** Zod 3.23+
- **MCP:** `@modelcontextprotocol/sdk` 1.0+
- **Process supervisor:** systemd (Linux) / launchd (macOS) — пример unit-файла в `examples/`

`bun run typecheck` (`tsc --noEmit`) и `bun test` обязаны проходить чисто перед merge.

---

## Зачем переезд (D-day 2026-06-15)

С 15 июня 2026 Anthropic разделяет billing: `claude -p` (Agent SDK) уходит в отдельный SDK-кредит, который **зависит от плана подписки**:

- Pro — $20/мес SDK credit
- Max 5× — $100/мес SDK credit
- Max 20× — $200/мес SDK credit

Любой `claude -p` spawn = расход из SDK pool, отдельно от обычной Claude Code Max-квоты. Подробности: [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

Старая архитектура (`claude -p` gateway, Python-демон спавнит новую `-p` сессию на каждый Telegram-turn) после cutover перестанет работать в рамках обычной Max-квоты — каждое сообщение в Telegram станет API-расходом из SDK pool.

Новая архитектура (этот плагин) держит **одну живую interactive Claude Code сессию** на агента (либо пул per-chat tmux-сессий при multichat.enabled), в которую плагин просто пушит channel-сообщения. Сессии классифицируются как interactive → остаются в Max subscription. Расход не растёт от количества Telegram-сообщений.

Дополнительно: [Claude Code Channels reference](https://code.claude.com/docs/en/channels-reference).

---

## Документация

| Док | Что внутри | Кому |
|---|---|---|
| [01-what-is-this.md](docs/01-what-is-this.md) | Plugin vs Gateway — архитектурные различия, преимущества | Все |
| [02-where-to-place-plugin.md](docs/02-where-to-place-plugin.md) | **Главный документ.** Где разместить каталог плагина, чтобы Claude Code правильно загрузил сессию | Все |
| [03-installation.md](docs/03-installation.md) | Сравнение systemd / launchd, EnvironmentFile, фикс welcome-промтов, smoke test | Production setup |
| [03-installation-linux.md](docs/03-installation-linux.md) | Linux-specific systemd unit | Linux operators |
| [03-installation-macos.md](docs/03-installation-macos.md) | macOS launchd plist + wrapper script | macOS operators |
| [04-migration-from-gateway.md](docs/04-migration-from-gateway.md) | Пошаговая миграция с `jarvis-telegram-gateway` или fork. Откат на каждом шаге | Мигрирующим |
| [05-troubleshooting.md](docs/05-troubleshooting.md) | Типовые ошибки с симптомами, корнями и фиксами | Когда сломалось |
| [06-how-claude-loads-session.md](docs/06-how-claude-loads-session.md) | Как Claude Code находит `CLAUDE.md`, CWD upward search, `@-include`, глобальный vs project | Для понимания |

Внутренние dev-доки (история разработки, PR review, supervisor specs) переехали в [docs/dev/](docs/dev/) — оставлены для архива, читать необязательно.

---

## Trade-offs которые нужно знать

| Плюс | Минус |
|---|---|
| Расход API не растёт от количества Telegram-сообщений | Один процесс = один Telegram бот. Хотите 5 ботов → 5 процессов |
| Сессия помнит контекст между сообщениями | Перезапуск сессии = потеря текущего контекста (но `core/hot/recent.md` сохраняет хвост) |
| Multichat MVP — несколько чатов в одной identity | Per-chat tmux-сессии = больше памяти + аккуратная настройка `policy.yaml` обязательна |
| Все tools/MCP сервера доступны агенту | Claude Code при старте показывает 2 интерактивных welcome-промта (разово per session, см. docs/03 фикс) |
| Telegram features (реакции, статус, media, draft) работают из коробки | Нужен Bun runtime + Claude Code v2.1.80+, не запустится на Python-only хостах |

---

## Связанные репо

- [qwwiwi/dashi-plugin-claude-code](https://github.com/qwwiwi/dashi-plugin-claude-code) — этот репо (canonical)
- [qwwiwi/jarvis-telegram-gateway](https://github.com/qwwiwi/jarvis-telegram-gateway) — старый Python gateway (deprecated 2026-06-15)
- [qwwiwi/gateway-dashis-agents](https://github.com/qwwiwi/gateway-dashis-agents) — приватный fork старого gateway с инфра-патчами (deprecated 2026-06-15)
- [qwwiwi/public-gbrain-agentos](https://github.com/qwwiwi/public-gbrain-agentos) — gbrain backend (опциональный — agent memory + coordination)

---

## Лицензия

Apache 2.0. См. [LICENSE](LICENSE).

Fork оригинальной идеи Anthropic Telegram plugin с полной Jarvis Gateway parity. Custom код доступен на условиях Apache 2.0.

---

## Автор / поддержка

[@qwwiwi](https://github.com/qwwiwi) (Dashi Eshiev) · EdgeLab AI

Issues / PRs приветствуются. Для миграции с deprecated gateway — открывайте issue с тегом `migration` и опишите свой setup.
