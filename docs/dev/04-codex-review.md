# Codex GPT-5.5 Review

## Вердикт

> «Вы **не chasing a phantom**, но нужен один hard pre-flight proof: запустить не-`-p` `claude --channels` сессию так, как launchd будет её запускать, отправить событие, и подтвердить через Anthropic dashboard / support, что трафик попал в subscription, а не в SDK credit. Публичные доки поддерживают архитектуру, но **не обещают** билинг-классификацию для headless launchd channel events.»

Архитектура валидна, но реальная оценка трудозатрат — **2–4 дня вместо 11 часов**.

## Что подтвердилось

- Channel-pattern действительно проходит как interactive (subscription pool), а не SDK
  - Источник: Anthropic support article + Channels reference
- Tyrande / MiniMax — валидный coordinator для summary/monitoring задач

## Критические правки до старта

### 1. CLI-синтаксис

**Было** (неправильно):
```
claude --channels plugin:jarvis-channel@local --dangerously-load-development-channels
```

**Стало**:
```
claude --dangerously-load-development-channels plugin:jarvis-channel@local --channels jarvis-channel
```

`--dangerously-load-development-channels` — per-entry bypass, должен идти **перед** `--channels` и принимать сам плагин как аргумент.

### 2. Билинг-тезис не публично подтверждён

Док Anthropic обещает «interactive Claude Code in terminal or IDE» — про launchd без TTY молчит. **Нужна канарейка** (Phase 0).

### 3. Оценки трудозатрат были занижены

| Фаза | Было | Стало |
|------|------|-------|
| Phase 1 (MVP) | 2 ч | 4 ч |
| Phase 2 (parity) | 3 ч | 1.5–3 дня |
| Phase 5 (decommission) | — | ~1 неделя observation |

Обоснование: `gateway.py` = 3 748 строк (streaming, markdown→HTML, media, voice, albums, per-chat workers, OOB commands, /reset, /stop, compact).

### 4. Race condition: getUpdates

Если старый gateway и новый channel параллельно `getUpdates` на один токен — один консьюмер съест update, другой не увидит.

**Решение**: per-token cutover. Один токен — один консьюмер. Или отдельный test bot token для пилота.

### 5. Permission deadlock в headless

Permission relay покрывает Bash/Write/Edit approval, но **НЕ** покрывает:
- Project trust dialog (первое открытие проекта)
- MCP server consent dialog

В headless launchd эти диалоги deadlock'ат сессию.

**Решение**: pre-trust всех проектов локально (`claude trust add`), pre-approve MCP servers до запуска под launchd.

### 6. Bot-to-bot loop guards отсутствовали

Telegram официально предупреждает о bot loops. Без guards — риск infinite loop, блок API на токен.

**Решение**:
- Depth-limit 3 hops (`X-Orgrimmar-Depth` header)
- Dedupe по message hash + TTL 60s
- Per-bot rate-limit 10 msg/min
- Owner-only permission codes
- Kill-switch `/halt`

## Расширения pre-flight

Codex добавил 5 проверок к исходным 5:

1. `claude --help | rg "channels|dangerously-load"` + dry-run launch
2. Canary billing test (или письменное Anthropic support confirm)
3. Verify no dual `getUpdates` consumer per bot token
4. Reboot test: launchd → OAuth keychain → channel event
5. Permission relay test для Bash/Write/Edit + project-trust/MCP проверка
6. Hosts scan на `claude -p`, `claude --print`, `@anthropic-ai/sdk`, `ANTHROPIC_API_KEY`
7. Resource test: 6 сессий RSS / log growth / restart / crash loop
8. Telegram bot-to-bot smoke с loop guards
