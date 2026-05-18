# Canary supervisor execution log

Recorded during the 2026-05-14 PDT `/goal` continuation.

## Scope

This slice adds a repo-local, canary-only `dashi-channel-supervisor` scaffold from `docs/08-dashi-channel-supervisor-spec.md`.

Changed runtime-facing behavior is intentionally limited:

- `status canary` creates only non-secret canary metadata, queue, and log paths.
- `logs canary` prints log file paths by default and does not dump log contents.
- `attach canary` attaches only when the tmux session already exists; it never creates a session.
- `start canary` refuses before any tmux start or Telegram consumer when Claude channel CLI syntax is not confirmed.
- every production agent id is rejected by the scaffold.

## Files

- `scripts/dashi-channel-supervisor`
- `tests/test_dashi_channel_supervisor.py`

## Safety notes

- The scaffold never reads or prints the Telegram token value.
- Verification uses temporary runtime roots under `/private/tmp`, not the real canary runtime path.
- The real canary token file remains untouched.
- No production token files, launchd jobs, live gateway config, or production tmux sessions are touched.
- No live Telegram `getUpdates` consumer is started.

## Verification commands

```bash
python3 -m unittest tests.test_dashi_channel_supervisor -v
DASHI_CHANNEL_RUNTIME_ROOT=/private/tmp/dashi-channel-supervisor-check scripts/dashi-channel-supervisor status canary --json
DASHI_CHANNEL_RUNTIME_ROOT=/private/tmp/dashi-channel-supervisor-check scripts/dashi-channel-supervisor logs canary
DASHI_CHANNEL_RUNTIME_ROOT=/private/tmp/dashi-channel-supervisor-check scripts/dashi-channel-supervisor attach canary
DASHI_CHANNEL_RUNTIME_ROOT=/private/tmp/dashi-channel-supervisor-check scripts/dashi-channel-supervisor start canary --json
```

Expected safe outcomes:

- unit tests pass;
- `status` reports the canary session as `missing` unless an operator has started it separately;
- `logs` reports paths only;
- `attach` refuses when the session is missing;
- `start` returns `channel_cli_unconfirmed` until local Claude Code channel syntax is confirmed.

## Remaining blockers

- Confirm the exact Claude Code channel CLI invocation locally.
- Keep live canary execution separate from this scaffold slice.
- Keep production cutover blocked until parity, rollback, billing, permission relay, and operator approval evidence are recorded.
