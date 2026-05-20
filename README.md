# dashi-plugin-claude-code

**Telegram → Claude Code channel plugin.** Превращает обычную Claude Code сессию в Telegram-агента, который слушает чат, отвечает в той же сессии, и оставляет всю работу внутри Anthropic Max подписки.

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

Один процесс плагина = один агент = один Telegram бот = один workspace.

---

## Почему вы тут

Вы один из двух типов читателей:

1. **Ученик EdgeLab / новичок** — хотите свой Telegram-агент на Claude Code, без зоопарка инфраструктуры. Идите в [docs/01-what-is-this.md](docs/01-what-is-this.md) → [docs/03-installation.md](docs/03-installation.md).

2. **Мигрируете с `jarvis-telegram-gateway` или `gateway-dashis-agents`** — старый Python `claude -p` gateway отключается 2026-06-15. Идите в [docs/04-migration-from-gateway.md](docs/04-migration-from-gateway.md).

В обоих случаях **обязательно прочитать** [docs/02-where-to-place-plugin.md](docs/02-where-to-place-plugin.md) — там объясняется почему расположение каталога с плагином критично для правильной загрузки сессии. 90% проблем при первом запуске — оттуда.

---

## Быстрый старт (если торопитесь и читать лень)

```bash
# 1. Создайте workspace для агента (если ещё нет)
mkdir -p ~/.claude-lab/myagent/.claude
mkdir -p ~/.claude-lab/myagent/secrets        # для channel.env (macOS-friendly)
cd ~/.claude-lab/myagent/.claude

# 2. Склонируйте плагин ВНУТРЬ workspace
git clone https://github.com/qwwiwi/dashi-plugin-claude-code.git
cd dashi-plugin-claude-code/plugin
bun install

# 3. Скопируйте example config + впишите свой Telegram bot token
#    (универсально для Linux + macOS — кладём в свой workspace)
cp ../examples/channel.env.example ~/.claude-lab/myagent/secrets/channel.env
chmod 600 ~/.claude-lab/myagent/secrets/channel.env
$EDITOR ~/.claude-lab/myagent/secrets/channel.env

# 4. Запустите Claude Code из каталога плагина (CWD-критично, см. docs/02)
cd ~/.claude-lab/myagent/.claude/dashi-plugin-claude-code/plugin
set -a; . ~/.claude-lab/myagent/secrets/channel.env; set +a
claude --dangerously-load-development-channels server:dashi-channel
```

При первом запуске Claude Code задаст 2 интерактивных вопроса (allow external imports + dev channels) — это **разово**. После ответа `1` на оба плагин стартует и начнёт слушать вашего бота.

**Production setup** (чтобы агент работал автономно после reboot):
- **Linux** → [docs/03-installation-linux.md](docs/03-installation-linux.md) (systemd)
- **macOS / Mac mini** → [docs/03-installation-macos.md](docs/03-installation-macos.md) (launchd)
- **Сравнение OS** → [docs/03-installation.md](docs/03-installation.md)

---

## Что вы получаете

| Возможность | Что значит на практике |
|---|---|
| Telegram → live Claude session | Сообщение из чата приходит как user prompt в живую interactive сессию (не `-p` spawn). Сессия видит весь предыдущий разговор |
| Голосовые сообщения | Скачиваются как `.oga` в inbox, плагин кладёт путь в prompt — агент сам решает что делать (например, транскрибировать через Whisper) |
| Фото / документы / альбомы | Telegram media group buffered и доставляется единым сообщением (до 10 файлов в одном prompt) |
| Status ticker | Live статус-сообщение в Telegram показывает что агент делает прямо сейчас (typing / thinking / tool name) |
| Phased reactions | На ваше сообщение появляется реакция: 👀 (получил) → ⚙️ (использует инструмент) → ✅/❌ (завершил) |
| OOB commands | `/help`, `/status`, `/stop`, `/reset`, `/new` работают без участия агента (out-of-band) |
| Permission relay | Когда Claude просит permission на чувствительный tool — приходит запрос в Telegram, ответ возвращается в сессию |
| Memory hooks (опционально) | После каждого turn запись в `<workspace>/core/hot/recent.md` + `verbose-YYYY-MM-DD.jsonl` для long-term memory pipeline |
| Anti-spoof | Plugin валидирует что reply-to message принадлежит вашему боту, отбивает попытки prompt injection через подставные reply-метаданные |

---

## Stack

- **Runtime:** Bun 1.3+ / TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitAny`)
- **Claude Code:** v2.1+ (channel API `claude/channel` capability)
- **Telegram SDK:** [grammY](https://grammy.dev/) 1.21+
- **Schema validation:** Zod 3.23+
- **MCP:** `@modelcontextprotocol/sdk` 1.0+
- **Process supervisor:** systemd (Linux) / launchd (macOS) — пример unit-файла в `examples/`

**Тестов в репо:** 425 pass / 0 fail / 2150 expect() через 27 файлов. `bun run typecheck` clean.

---

## Зачем переезд (D-day 2026-06-15)

С 15 июня 2026 Anthropic разделяет billing: `claude -p` (Agent SDK) уходит в отдельный $200/мес pool, отдельный от Max subscription. Любой `claude -p` spawn = расход из SDK pool, не из Max.

Старая архитектура (`claude -p` gateway, Python-демон спавнит новую `-p` сессию на каждый Telegram-turn) после cutover перестанет работать в рамках Max — каждое сообщение в Telegram станет API-расходом.

Новая архитектура (этот плагин) держит **одну живую interactive Claude Code сессию** на агента, в которую плагин просто пушит channel-сообщения. Сессия классифицируется как interactive → остаётся в Max subscription. Расход не растёт от количества Telegram-сообщений.

См. подробности: [Anthropic billing support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [Claude Code Channels reference](https://code.claude.com/docs/en/channels-reference).

---

## Документация

| Док | Что внутри | Кому |
|---|---|---|
| [01-what-is-this.md](docs/01-what-is-this.md) | Plugin vs Gateway — архитектурные различия, преимущества | Все |
| [02-where-to-place-plugin.md](docs/02-where-to-place-plugin.md) | **Главный документ.** Где разместить каталог плагина, чтобы Claude Code правильно загрузил сессию | Все |
| [03-installation.md](docs/03-installation.md) | systemd unit, EnvironmentFile, фикс welcome-промтов, smoke test | Production setup |
| [04-migration-from-gateway.md](docs/04-migration-from-gateway.md) | Пошаговая миграция с `jarvis-telegram-gateway` или fork. Откат на каждом шаге | Мигрирующим |
| [05-troubleshooting.md](docs/05-troubleshooting.md) | 6 типовых ошибок с симптомами, корнями и фиксами | Когда сломалось |
| [06-how-claude-loads-session.md](docs/06-how-claude-loads-session.md) | Как Claude Code находит `CLAUDE.md`, CWD upward search, `@-include`, глобальный vs project | Для понимания |

Внутренние dev-доки (история разработки, PR review, supervisor specs) переехали в [docs/dev/](docs/dev/) — оставлены для архива, читать необязательно.

---

## Trade-offs которые нужно знать

| Плюс | Минус |
|---|---|
| Расход API не растёт от количества Telegram-сообщений | Один процесс = один Telegram бот. Хотите 5 агентов → 5 процессов |
| Сессия помнит контекст между сообщениями | Перезапуск сессии = потеря текущего контекста (но `core/hot/recent.md` сохраняет хвост) |
| Все tools/MCP сервера доступны агенту | Claude Code при старте показывает 2 интерактивных welcome-промта (разово per session, см. docs/03 фикс) |
| Telegram features (реакции, статус, media, draft) работают из коробки | Нужен Bun runtime + Claude Code v2.1+, не запустится на Python-only хостах |

---

## Связанные репо

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
