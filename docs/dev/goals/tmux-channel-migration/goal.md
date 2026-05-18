# Goal: Execute the tmux-first Telegram channel migration

## Original Request

Поставить GoalBuddy/native `/goal` для Codex и выполнить задачу из `qwwiwi-channel-telegram-Claude-code` через `/goal`.

## Interpreted Outcome

Turn the existing tmux migration plan into an executable GoalBuddy run that can safely advance the Orgrimmar Telegram migration from the current `jarvis-telegram-gateway -> claude -p` path toward a tmux-backed Claude Code Channels runtime.

## Source Plan

- `README.md`
- `docs/03-plan.md`
- `docs/05-success-criteria.md`
- `docs/06-tmux-migration-goal-plan.md`
- Local related repositories and runtime paths discovered by Scout, including:
  - `/Users/jasonqwwen/projects/jarvis-telegram-gateway`
  - `/Users/jasonqwwen/projects/agents-edgelab`
  - `/Users/jasonqwwen/.claude-lab/shared/gateway`
  - `/Users/jasonqwwen/Library/LaunchAgents`

## Non-Negotiable Constraints

- Do not expose, commit, or print secrets, bot tokens, OAuth material, private keys, or full production configs.
- Do not run old and new Telegram `getUpdates` consumers on the same production token.
- Do not unload, load, or alter production `launchd` jobs without explicit operator approval.
- Do not change production gateway files until a bounded Worker task names exact allowed files and rollback checks.
- Keep the old gateway as rollback until parity and billing/classification evidence are recorded.
- No default `--dangerously-skip-permissions`; use permission relay or documented manual approval paths.

## Completion Proof

For the current tranche, completion means GoalBuddy has produced verified, actionable migration progress from the existing plan: a repo/runtime map, a selected safe first work package, implemented local artifacts or code changes where safe, verification receipts, and a Judge/PM audit that either proves the tranche complete or names the next safe `/goal` continuation.

Full production completion remains gated by the success criteria in `docs/05-success-criteria.md` and `docs/06-tmux-migration-goal-plan.md`, including parity tests, per-agent rollback, no dual-consumer incident, reboot recovery, permission relay, and Anthropic classification evidence.
