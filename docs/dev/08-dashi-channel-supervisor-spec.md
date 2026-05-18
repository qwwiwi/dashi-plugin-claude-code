# dashi-channel-supervisor spec

Purpose: define the command contract and safety envelope for the tmux-backed Claude Code Channels supervisor before any live implementation touches production gateway files, launchd jobs, or Telegram tokens.

This is a design/spec artifact, not an installed service.

## Runtime shape

Target process chain:

```text
launchd
  -> dashi-channel-supervisor start <agent>
      -> tmux has-session -t <session>
      -> tmux new-session -d -s <session> ...
          -> claude <channel flags> --channels <channel-name>
              -> Dashi Telegram channel plugin
```

The supervisor owns process lifecycle and local metadata. The channel plugin owns Telegram event handling. Claude Code remains an interactive tmux session; the plugin must not call Claude programmatically.

## Non-goals

- No production token movement in the supervisor spec.
- No automatic launchd load/unload in the first implementation.
- No default `--dangerously-skip-permissions`.
- No broad edits to the deployed Python gateway.
- No second `getUpdates` consumer on any production token.
- No billing classification claim without Anthropic dashboard/support evidence.

## Command contract

All commands must accept an agent id. Valid ids for production are expected to be:

```text
silvana
kaelthas
garrosh
arthas
claude
```

The canary id is:

```text
canary
```

### `start`

```bash
dashi-channel-supervisor start <agent>
```

Required behavior:

- validate agent id
- resolve an agent profile
- verify the token source is test-only for `canary`
- refuse production agents unless operator approval is recorded outside the command line
- verify channel CLI syntax is available
- verify project trust and MCP consent pre-flight are complete
- create or reuse the tmux session
- start Claude Code inside tmux only if the session is missing or unhealthy
- write metadata atomically
- write logs to an agent-specific path
- return non-zero on any failed pre-flight

Refuse to start if:

- a production token would have two `getUpdates` consumers
- token contents would need to be printed
- the current gateway is still primary for the same production token and no approved cutover window is recorded
- `claude --help` or an equivalent local check cannot confirm channel support
- the plugin path is missing
- required workspace trust is missing

### `stop`

```bash
dashi-channel-supervisor stop <agent>
```

Required behavior:

- stop only the named tmux/channel session
- preserve logs and metadata
- for production agents, require an explicit approval marker or an interactive operator confirmation
- never unload the old gateway launchd job
- return success if the named canary session is already stopped

Production `stop` is a cutover/rollback action and must not be part of unattended pre-flight.

### `restart`

```bash
dashi-channel-supervisor restart <agent>
```

Required behavior:

- run `stop <agent>`
- run `start <agent>`
- preserve previous metadata with a restart reason
- refuse production restart without an approved maintenance window

### `status`

```bash
dashi-channel-supervisor status <agent>
```

Required behavior:

- read tmux session status
- read metadata
- report channel plugin health if available
- report last Telegram update id only as an opaque integer
- report queue depth if available
- report log paths
- report whether the session is `missing`, `starting`, `ready`, `busy`, `stuck`, `stopped`, or `error`
- never print token values or environment secrets

Recommended machine-readable output:

```json
{
  "agent": "canary",
  "session": "orgrimmar-canary",
  "state": "ready",
  "tmux": {"exists": true},
  "channel": {"name": "dashi-telegram", "healthy": true},
  "queue": {"pending": 0},
  "logs": {
    "stdout": "~/.claude-lab/shared/channel-runtime/canary/logs/stdout.log",
    "stderr": "~/.claude-lab/shared/channel-runtime/canary/logs/stderr.log"
  }
}
```

### `attach`

```bash
dashi-channel-supervisor attach <agent>
```

Required behavior:

- attach to the tmux session for manual inspection
- print the detach instruction before attaching: `Ctrl-b d`
- refuse if the session does not exist
- never create a new session as a side effect

### `logs`

```bash
dashi-channel-supervisor logs <agent>
```

Required behavior:

- print paths to logs
- optionally tail canary logs
- redact secret-like environment values if log rendering is added
- default to metadata/log file paths instead of dumping full logs

## Naming

Session names:

| Agent | tmux session |
|---|---|
| canary | `orgrimmar-canary` |
| silvana | `orgrimmar-silvana` |
| kaelthas | `orgrimmar-kaelthas` |
| garrosh | `orgrimmar-garrosh` |
| arthas | `orgrimmar-arthas` |
| claude | `orgrimmar-claude` |

Channel name:

```text
dashi-telegram
```

Canary channel/plugin name may be separate until production parity:

```text
dashi-telegram-canary
```

## State layout

Recommended state root:

```text
~/.claude-lab/shared/channel-runtime/
  canary/
    metadata.json
    supervisor.lock
    queue/
    logs/
      stdout.log
      stderr.log
      supervisor.log
  silvana/
  kaelthas/
  garrosh/
  arthas/
  claude/
```

Metadata fields:

```json
{
  "agent": "canary",
  "session": "orgrimmar-canary",
  "channel": "dashi-telegram-canary",
  "workspace": "<path>",
  "plugin": "<path>",
  "started_at": "2026-05-15T00:00:00Z",
  "last_restart_reason": "manual canary",
  "token_source": "test-token-file",
  "production_token": false
}
```

Do not store token values in metadata.

## Agent profile fields

Each profile should resolve to:

- agent id
- tmux session name
- workspace path
- channel/plugin path
- channel name
- token file path
- production vs canary flag
- log directory
- queue directory
- allowed chat/test target, when applicable

Production profiles must not be enabled until the canary gates pass.

## One token, one consumer

The supervisor must enforce this rule before starting any Telegram consumer:

```text
One token, one consumer.
```

For canary:

- require a dedicated test token file
- refuse known production token file paths

For production:

- require an approved cutover window
- require current gateway token disablement or per-agent cutover proof
- record rollback command before start
- start only one agent at a time

## Safety gates

### Gate A: local CLI

Required:

```bash
claude --version
claude --help | rg "channels|dangerously-load"
```

Stop if channel invocation syntax is not confirmed.

### Gate B: trust and consent

Required before launchd/tmux unattended sessions:

- `claude trust add <workspace>` completed for the target workspace
- required MCP servers approved locally
- OAuth/keychain access verified after reboot or scheduled before production

### Gate C: canary token

Required:

- token file exists
- token value is never printed
- token is not one of the production agent token files
- test chat is known to the operator

### Gate D: rollback

Required before production:

- old gateway remains available
- rollback action documented per agent
- old gateway smoke command/test documented
- production cutover can be reverted in under 5 minutes

## Verification expectations

First implementation should include a dry-run/status mode that can be verified without starting production services:

```bash
dashi-channel-supervisor status canary
dashi-channel-supervisor logs canary
dashi-channel-supervisor attach canary
```

Canary live verification, once approved:

```text
1. start canary
2. attach and confirm interactive Claude Code in tmux
3. send 20 test-token messages
4. run /status
5. run /stop against a safe long task
6. restart canary
7. send another message
8. confirm no duplicate replies
9. confirm queue/log behavior for one forced failure
```

Production verification, later:

```text
1. stop old consumer for exactly one token
2. start dashi-channel-supervisor for exactly one agent
3. run text, command, media, voice, and permission smoke
4. watch logs for 30 minutes
5. mark agent channel-primary only after smoke passes
```

## Rollback expectations

Per-agent rollback:

```text
1. dashi-channel-supervisor stop <agent>
2. re-enable old gateway consumer for that token
3. send smoke test through old gateway
4. preserve failed channel logs
5. record root-cause task before retry
```

Do not unload the global gateway until all success criteria in `docs/05-success-criteria.md` are met and the operator approves decommission.

## First implementation recommendation

After CLI channel syntax is confirmed, implement the supervisor in a canary-only path first. Recommended future allowed files:

```text
scripts/dashi-channel-supervisor
docs/09-canary-execution-log.md
```

The first code version should support `status`, `logs`, and `attach` safely before `start` or `stop` are enabled for production agents.

## Current scaffold status

The repo now contains a canary-only scaffold at `scripts/dashi-channel-supervisor` with stdlib tests in `tests/test_dashi_channel_supervisor.py`.

Implemented safe commands:

- `status canary`
- `logs canary`
- `attach canary`
- `start canary`

Production agent ids remain disabled. `start canary` still refuses before starting tmux, Claude channels, or Telegram polling unless local Claude Code channel CLI syntax is confirmed. Even after syntax is visible, live start remains disabled in this scaffold slice until a later explicit live-canary task enables it.
