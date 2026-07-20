# Установка (production)

Этот документ — точка входа. Выберите свою операционную систему — каждая имеет свой supervisor (systemd vs launchd), свои пути (`/home/<user>/` vs `/Users/<user>/`), свои conventions.

| OS | Supervisor | Документ |
|---|---|---|
| Linux (Ubuntu / Debian / RHEL) | **systemd** | [03-installation-linux.md](03-installation-linux.md) |
| macOS (Mac mini, MacBook, iMac) | **launchd** | [03-installation-macos.md](03-installation-macos.md) |

## В чём принципиальная разница

Архитектура плагина одинакова на обоих OS — Bun runtime + Claude Code session + Telegram polling работают идентично. Разница только в **обвязке вокруг**:

| Аспект | Linux | macOS |
|---|---|---|
| **Process supervisor** | systemd (`.service` unit) | launchd (`.plist` agent/daemon) |
| **Команда управления** | `systemctl start/stop/restart` | `launchctl bootstrap/bootout/kickstart` |
| **Файл сервиса лежит** | `/etc/systemd/system/channel-<agent>.service` | `~/Library/LaunchAgents/com.<you>.channel-<agent>.plist` |
| **Service user** | Отдельный непривилегированный (`useradd agentctl`) | Запускается под вашим основным GUI user (single-user конвенция macOS) |
| **Workspace path** | `/home/<user>/.claude-lab/<agent>/.claude/` | `/Users/<user>/.claude-lab/<agent>/.claude/` |
| **Файл с секретами** | `/etc/dashi-plugin/<agent>/channel.env` (root:agentctl, 640) | `~/.claude-lab/<agent>/secrets/channel.env` (user, 600) |
| **Передача env в процесс** | `EnvironmentFile=` директива systemd | `EnvironmentVariables` dict в plist **или** wrapper-скрипт `source channel.env && exec ...` |
| **Логи** | `journalctl -u channel-<agent>` | `~/Library/Logs/dashi-plugin/<agent>.log` (через `StandardOutPath` в plist) |
| **Auto-start при boot** | `systemctl enable channel-<agent>` | `RunAtLoad=true` в plist + `launchctl bootstrap` |
| **Установка Bun** | `curl -fsSL https://bun.sh/install | bash` | `brew install oven-sh/bun/bun` **или** тот же curl |
| **Установка tmux** | `sudo apt install tmux` | `brew install tmux` |
| **Auto-start при boot после релогина** | Работает без login | Запускается при login GUI user (если plist в `~/Library/LaunchAgents/`). Для запуска до login — `/Library/LaunchDaemons/` (root) |

## Что общее для обоих OS

- Bun 1.3+ и Claude Code v2.1+ — обязательны
- Workspace структура — `~/.claude-lab/<agent>/.claude/dashi-plugin-claude-code/plugin/`
- CWD при старте — внутрь `plugin/` (см. [02-where-to-place-plugin.md](02-where-to-place-plugin.md))
- Welcome-промты Claude Code при первом запуске — те же 2 интерактивных окна, тот же фикс через `~/.claude/settings.json` (см. ниже [Persistent welcome approvals](#persistent-welcome-approvals))
- Telegram bot setup (`@BotFather`) — идентичен
- Hooks integration (`install-hooks.sh`) — работает на обоих
- Telegram output formatting — единый pipeline (см. ниже [Telegram output formatting](#telegram-output-formatting))
- Smoke test через ping бота — одинаков
- Troubleshooting ([05-troubleshooting.md](05-troubleshooting.md)) — большинство сценариев OS-agnostic

---

## Persistent welcome approvals

Welcome-промты Claude Code (external imports + `--dangerously-load-development-channels`) показываются **при каждом** запуске Claude Code, включая `systemctl restart` / `launchctl kickstart`. Без persistent approvals после рестарта сервиса нужен человек с tmux, чтобы пройти 2 промта вручную.

**Решение** (требует Claude Code v2.1.140+): добавить в `~/.claude/settings.json` пользователя (под которым стартует сервис) ключи, которые Claude Code пишет туда после первого ручного «Yes». Точные имена ключей зависят от версии — пройдите промты один раз вручную, потом скопируйте появившиеся ключи в `settings.json`:

```json
{
  "hasTrustDialogAccepted": true,
  "dangerouslyLoadDevelopmentChannelsAccepted": true,
  "externalImportsAccepted": true
}
```

Полные пошаговые инструкции — в OS-specific документах:

- Linux / systemd → [03-installation-linux.md#persistent-welcome-approvals](03-installation-linux.md#persistent-welcome-approvals-чтобы-не-нажимать-enter-после-каждого-рестарта)
- macOS / launchd → [03-installation-macos.md#persistent-welcome-approvals](03-installation-macos.md#persistent-welcome-approvals)

> **Известный gap (Claude Code v2.1.143):** часть промтов не сохраняется persistent. Workaround: держите `ExecStartPost` / wrapper-скрипт, который шлёт несколько `Enter` подряд через `sleep`, и тестируйте рестарт сервиса, чтобы убедиться.

---

## Telegram output formatting

Когда агент отвечает в Telegram через MCP-tool `reply` (или legacy `chat` reply), плагин прогоняет текст через единый pipeline вне зависимости от OS:

1. **`format='html'` по умолчанию** (PR #22). Markdown в ответе агента (`**bold**`, `*italic*`, `` `code` ``, ` ```fenced``` `, `[text](url)`, таблицы, `# heading`) автоматически конвертируется в Telegram-совместимый HTML-подмножество и режется на чанки по 4000 символов. Голые `<`, `>`, `&` в обычном тексте безопасны — escape-ятся перед отправкой. На parse-error чанк пересылается plain text — ответ всё равно доедет
2. **Redactor pipeline (safe-telegram-api → `redactSecrets`)** — перед отправкой текст прогоняется через паттерн-редактор: Telegram bot tokens (`<digits>:<base64>`), provider API keys (`sk-…`, `gsk_…`, `sk-proj-…`, `ghp_…`, `re_…`, `xoxb-…`), Firebase JSON-поля (`private_key`, `private_key_id`, `client_email`), `Authorization: Bearer …`, IP-адреса, секретные пути и generic ≥24-char токены заменяются на `[REDACTED]`. Pipeline **идемпотентный** — повторный прогон не разрушает уже редактированные строки
3. **Override:** установите `format: 'text'` в reply-tool — markdown-конверсия и парсинг HTML обходятся; текст уходит как есть (но через тот же redactor). `format: 'markdownv2'` оставляет markdown raw — caller отвечает за escape по правилам Telegram MarkdownV2

Это значит: если агент случайно сматерится bot-token в ответ — он не доедет до Telegram «как есть». Это **не** оправдание печатать секреты в ответы (всегда возможны false-negative на нестандартных шейпах), но даёт нижнюю границу безопасности.

Конфигурация поведения — стандартными ENV-переменными `TELEGRAM_*` (см. [examples/channel.env.example](../examples/channel.env.example)). Сам redactor — в `plugin/src/safety/redact.ts`, тесты — `plugin/src/safety/__tests__/redact.test.ts`.

## Какой выбрать для production

**Linux (VPS / dedicated server):**
- Если у вас агент должен работать 24/7 без вашего присутствия
- Если несколько агентов на одной машине под разными service-users
- Если нужна полная изоляция (cgroups, ProtectSystem, NoNewPrivileges)
- Hetzner / Timeweb / DigitalOcean / etc.

**macOS (Mac mini / iMac):**
- Если агенты живут рядом с вашим dev-окружением
- Если используете Anthropic Max через GUI Claude.app login (этот auth scope доступен под вашим user)
- Если бюджет на отдельный VPS не оправдан
- Mac mini как «домашний сервер» — типичный сценарий

Оба варианта prod-ready. У одного автора могут спокойно сосуществовать несколько агентов на Mac mini + несколько на Linux VPS — пилот Orgrimmar именно так и устроен (Тралл/Артас на Ubuntu VPS, Сильвана/Кельтас/Гаррош/Клод на Mac mini).

---

## Где лежат логи и state

Плагин разнесён по трём слоям — supervisor (systemd/launchd), plugin state и tmux pane. Каждый слой имеет свои файлы.

| Слой | Linux (systemd) | macOS (launchd) |
|---|---|---|
| **Supervisor stderr/stdout** | `journalctl -u channel-<agent>` (или `journalctl -u agent47-channel-<agent>` если такой alias) | `~/Library/Logs/dashi-plugin/channel-<agent>.out.log` + `.err.log` |
| **Plugin state dir** (`TELEGRAM_STATE_DIR`, default `/tmp/agent47-channel-state/<agent>/`) | `bot.pid`, `access.json`, `update-offset`, `dead-letter/`, `permissions.jsonl` | то же |
| **Tmux pane history** | `tmux capture-pane -p -t channel-<agent>` (под service-user) | `tmux capture-pane -p -t channel-<agent>` |
| **Workspace memory** (если включены memory hooks) | `<workspace>/core/hot/recent.md` + `<workspace>/../logs/verbose-YYYY-MM-DD.jsonl` | то же |

`TELEGRAM_STATE_DIR` определяется в `channel.env` (рекомендуется `<shared>/state/<agent>/telegram/`). Если не задан — плагин падает на дефолт `/tmp/agent47-channel-state/`, который зачищается при reboot — **в production задавайте явно**.

Канонические таблицы и команды просмотра — в OS-specific документах:

- Linux → [03-installation-linux.md#логи-и-state-канонические-пути](03-installation-linux.md#логи-и-state-канонические-пути)
- macOS → [03-installation-macos.md#логи-и-state-канонические-пути](03-installation-macos.md#логи-и-state-канонические-пути)

---

После выбора OS → возвращайтесь сюда → переходите к specifics:

- [03-installation-linux.md](03-installation-linux.md) — Linux / systemd
- [03-installation-macos.md](03-installation-macos.md) — macOS / launchd
