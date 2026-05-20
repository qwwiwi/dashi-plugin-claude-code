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
- Welcome-промты Claude Code при первом запуске — те же 2 интерактивных окна, тот же фикс через `~/.claude/settings.json`
- Telegram bot setup (`@BotFather`) — идентичен
- Hooks integration (`install-hooks.sh`) — работает на обоих
- Smoke test через ping бота — одинаков
- Troubleshooting ([05-troubleshooting.md](05-troubleshooting.md)) — большинство сценариев OS-agnostic

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

После выбора OS → возвращайтесь сюда → переходите к specifics:

- [03-installation-linux.md](03-installation-linux.md) — Linux / systemd
- [03-installation-macos.md](03-installation-macos.md) — macOS / launchd
