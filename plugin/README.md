# dashi-channel (canary)

Fork of Anthropic's Telegram channel plugin, extended for Jarvis Gateway parity. Canary use against `@testmyfirsttmuxbot` only.

## Why this exists

We are migrating Silvana / Kaelthas / Garrosh / Arthas / Claude off the Python `claude -p` gateway onto the Claude Code Channels architecture before the `2026-06-15` billing cutover. This plugin is the runnable foundation that T2-T14 will extend with full Jarvis parity (media, albums, OOB commands, status ticker, webhook scaffold, permission relay, etc.).

## Quick start

```bash
cd /Users/jasonqwwen/qwwiwi-channel-telegram-Claude-code/plugin
bun install

# Direct mode (token from env):
TELEGRAM_BOT_TOKEN=... bun run start

# Via Claude Code with isolated state dir:
TELEGRAM_STATE_DIR=/tmp/dashi-channel-test \
  claude --dangerously-load-development-channels server:dashi-channel
```

## WARNING

- Do **NOT** use production bot tokens here. Production bots:
  - Silvana (`@fridayhumanbot`)
  - Kaelthas (`@kaelthasproducerbot`)
  - Garrosh (`@garroshsalebot`)
  - Arthas (own bot)
  - Claude (own bot)
- Test bot only: `@testmyfirsttmuxbot` (id `8507713167`).
- Production cutover is a separate plan with explicit prince approval. Do not flip tokens unilaterally.

## Smoke test

Local pre-flight (deterministic, no network):

```bash
./scripts/smoke-local
```

Runs `bun install`, `bun run typecheck`, `bun test tests/`. Exits non-zero on first failure. Prints the launch hint for the live canary step.

Live smoke against `@testmyfirsttmuxbot` (15-row matrix, operator-driven): see [`docs/canary-smoke.md`](docs/canary-smoke.md). Covers text, HTML chunking, reply anti-spoof, photo/document/voice/album, OOB commands (`/status`, `/help`, `/stop`, `/reset`), permission relay (allow/deny), and the optional webhook path. Includes the rollback procedure to the Python canary.

## Status

WIP — T1 of 15 (fork base only). Extensions T2-T14 follow in the loop-coding run `2026-05-15-canary-gateway-full-parity`.

## Attribution

Forked from `anthropics/claude-plugins-official/external_plugins/telegram` (MIT). See header comment in `server.ts`.
