---
name: doctor-dashi-plugin
description: Use when diagnosing a Dashi Channel Telegram installation, plugin versions, updates, gateway migration, a silent bot, missing terminal mirror or pinned tasks, broken hooks, identity drift, or Telegram 409 conflicts on Linux or macOS.
---

# Doctor: diagnose the channel installation

## Version — read this block first

The first doctor check reports **INSTALLED**, `plugin/package.json`, **LATEST**,
source, check time, and `up to date | outdated | unknown`.

- Point `--plugin-dir` at the **actual installed root's `plugin/`**, not an
  unrelated diagnostic checkout. The two installed manifests must agree.
  Without an explicit or discovered installation, INSTALLED is UNKNOWN.
- LATEST is UNKNOWN unless `--check-latest` is supplied and succeeds. That
  optional read fetches the public upstream **main-branch manifest**, not the
  latest published release. It never uploads local data.
- On UNKNOWN, check the linked upstream manifest manually and report what
  remains unverified. Never infer LATEST from installed files or a README badge.
- A newer local version or mismatched manifests gives `unknown`, not a downgrade
  instruction. Follow [Update](#update) after reviewing the actual installation.
- Installed files do not prove what the running session loaded. Record RUNNING
  as UNKNOWN unless existing runtime evidence identifies it; do not start
  another server to obtain its version.

Explain the result in plain language: what is installed, what is newer or
unknown, and the next operator action. Exit `0` means no FAIL; WARN and missing
coverage can remain. It does not prove that Telegram delivery works.

## Run from any directory

Locate **this SKILL.md** first. Set `doctor_skill_dir` to its absolute parent
folder. The doctor lives at `scripts/doctor.ts` relative to that folder. The
skill may belong to a diagnostic checkout different from the installed copy.
Do not assume a marketplace cache location or move a managed installation to
satisfy a workspace warning.

### Linux — systemd

```bash
doctor_skill_dir="/absolute/path/to/skills/doctor-dashi-plugin"
bun "$doctor_skill_dir/scripts/doctor.ts" \
  --plugin-dir "/absolute/installed-root/plugin" \
  --user "<numeric-owner-user-id>"
```

The doctor scans physical `/etc/systemd/system/channel-*.service` files and
matches WorkingDirectory/workspace to infer env and tmux session. `--fleet-dir`
changes that directory. Effective drop-ins, user units and wrappers are not
fully resolved: inspect the actual service and use explicit inputs below for
such layouts. Run as the channel service user so its home/default state path
is inspected. `--fleet` adds cross-agent checks; it is not launchd discovery.

### macOS — launchd (also unusual Linux layouts)

On macOS the doctor scans `~/Library/LaunchAgents/*.plist` using the system
`plutil` and requires one exact `WorkingDirectory` match to `--plugin-dir`.
It reads that agent's wrapper without executing it. Only a single literal
absolute `ENV_FILE` source and literal tmux session are inferred; expansions,
conditional/repeated assignments, shell `-c` launches and multiple matches
produce **incomplete coverage**. Env values and wrapper contents are never
printed. Literal `CLAUDE_CMD` launch mode and a literal tmux socket can also be
recognized. The example wrapper uses variable expansion, so supply explicit
inputs unless you have replaced those fields with literals. Discovery describes
files on disk, not proof of the loaded launchd job. Verify the actual plist,
wrapper, launch arguments and live process CWD separately.

Explicit `--env` and `--session` always win; `--no-autodetect` disables discovery.
For unusual layouts, use the same `doctor_skill_dir` assignment above:

```bash
bun "$doctor_skill_dir/scripts/doctor.ts" \
  --plugin-dir "/absolute/installed-root/plugin" \
  --settings "/absolute/session/.claude/settings.json" \
  --env "/absolute/channel.env" \
  --user "<numeric-owner-user-id>" \
  --session "<actual-tmux-session>" \
  --no-autodetect
```

Include only known deployment files. Optional `--mcp` and `--settings-local`
select the actual session's MCP files. Defaults are the copies inside
`plugin/`; settings default to `plugin/.claude/settings.json` when present,
otherwise `~/.claude/settings.json`. This is file selection, not a merge of all
Claude settings layers: pass the effective settings and inspect other layers
if hooks or permission mode are configured there.

For a DM, `--user` also checks chat membership with the same ID. For a group,
provide its explicit `--chat`. Custom tmux sockets may require separate
read-only inspection: no dedicated socket flag exists. The script tries the
default socket, the detected systemd/launchd socket, then the session-name socket.
On macOS it retries `/usr/sbin/lsof` if `lsof` is missing from PATH, for both
runtime CWD and listener probes.

Add `--check-latest` for the optional upstream version lookup, `--json` for
structured version/check output, or `--help` for all flags. `--queue-json` reads
an already saved response; never create another getUpdates consumer on a live
bot. Exit codes: `0` no FAIL, `1` FAIL present, `2` usage error.

## Effective config and coverage

The doctor follows `plugin/src/config.ts` for fields used by its checks:
`TELEGRAM_CONFIG_FILE` wins; otherwise use `TELEGRAM_STATE_DIR/config.json`,
otherwise `~/.claude/channels/dashi-telegram-canary/config.json`. File values
merge over runtime defaults; applicable env overrides win. The report names
the selected path/source and override **keys**, never their credential values.
An absent config file uses defaults, as runtime does. An unreadable/invalid
file, unknown env source or duplicate env assignments produces incomplete
coverage, not PASS. Shell/systemd and the server .env loader resolve duplicates
differently; verify the actual effective environment before trusting a value.

This standalone diagnostic projects only fields it checks; it does not run
full runtime schema validation or inspect the live process environment. Pass
`--env` for the service's actual env file; compare wrapper/service overrides
separately without printing credentials. Do not source an unknown env file as
shell code. Relative config/state paths use the inspected runtime directory (`--plugin-dir`
or the matched unit WorkingDirectory); default state paths use the diagnostic
user's home.

## Mirror

The Mirror section reports hooks installed yes/no/unknown and whether
`tmux_mirror.enabled` is configured for the intended private chat. The runtime
uses **`allowed_chat_ids[0]`** as the terminal mirror target. Another allowed
DM is not automatically mirrored. With multichat, separately verify that the
actual policy permits private mode and `tmux_mirror: true`; the diagnostic
cannot certify that policy route in its readiness result.

Expected when working: one rolling terminal message shows recent work and
progress; the pinned HUD shows context and current tasks. `hud.enabled` and
`task_mirror.enabled` default to true. Status/progress reporters default off;
enabling several progress surfaces can create duplicate messages. The current
hooks send task events, not every individual tool call.

The current installer contract is required even with terminal mirroring:
`SessionStart`, `UserPromptSubmit`, `SessionEnd`, `Stop`, and `PostToolUse` with
matcher `TaskCreate|TaskUpdate|TodoWrite`; plus the separate
`dashi-channel-reminder-hook` pointing to `channel-reminder.ts` on
`UserPromptSubmit`. The removed notification `PreToolUse` feeder is not
required. Permission gate and AskUserQuestion hooks remain separate checks.
A registered command does not prove its helper file exists or executes.

**What to do:** in the bot's private chat use the documented command
`/mirror on`; inspect with `/mirror status` (off: `/mirror off`). If
`tmux_mirror.enabled=false` at startup, that command cannot create a mirror:
an external operator must first set `tmux_mirror.enabled=true` in the selected
config, verify `pane_target`/`socket_name`, then restart outside this channel.
Config readiness does not prove the runtime toggle or Telegram display. Ask
the operator to send a real request and inspect both the rolling message and
tasks in the pin. Never restart your own communication channel mid-session.

## Autonomous profile and optional confirmations

The supported default launch is `--permission-mode bypassPermissions` with no
permission-gate hook. The `permission-gate` check is **OK** with detail
`autonomous profile: confirmations off by design`; do not install a gate to
"fix" this profile. This applies to CLI launch flags and a settings-only
`permissions.defaultMode=bypassPermissions`, including fleet checks. An unused
permission endpoint is not required for this profile.

For an explicitly configured gate, `permission_gate.enabled=true` without its
hook is FAIL (the configured gate never fires); a registered gate with the
server-side flag disabled is FAIL (requests fail closed). Unreadable settings
or config mean unverified coverage, not evidence of either mismatch. Secret
leak checks and the separate optional relay checks still apply.

## What to do for FAIL / WARN

Read the first causal failure, give the student one concrete next step, and
re-run after the operator applies it. Preserve original check IDs/statuses.
Every warning/failure class has an action below; SKIP means unverified or
unused, not healthy.

| Check / class | What to do |
|---|---|
| `plugin-version` | Confirm the installed root and both versions; check upstream if UNKNOWN; follow Update if outdated. |
| `claude-version`, `bun-version`, `tmux` | Ask the operator to install/upgrade the missing tool. The script floors are Claude 2.1.0 and Bun 1.3.9; README asks Claude 2.1.80+. Passing the lower floor does not settle that support-policy difference. |
| `workspace-placement`, `dev-vs-runtime` | Confirm which copy and session CWD actually run and which CLAUDE.md is loaded. For a clone, use the workspace layout in installation docs; for a managed install, inspect metadata instead of moving its cache. |
| `autodetect`, `env-unknown`, `settings-source`, `settings-readable`, `config-source` | Supply the actual service env/settings paths; fix readability or JSON syntax. Recheck defaults and service overrides as the service user. Report missing coverage explicitly. |
| `hook-*`, `channel-reminder-hook`, `fallback-reply-hook`, `mirror-hooks` | Ask the operator to install current hooks for this session's settings, chat and webhook URL using `plugin/scripts/install-hooks.sh`. Check helper paths; use the script's fix and README for required arguments. |
| `settings-no-token`, `permission-gate-token` | Have the operator remove credentials from settings and keep them in private runtime env. Never repeat their values in output. |
| `shared-settings-clean`, `fleet-shared-settings` | Have the operator scope channel hooks to the intended agent's session so other agents do not inherit them. |
| `permission-gate`, `permission-gate-config-match` | Autonomous bypass without a gate is OK by design. For a real config/hook mismatch, have the operator align the optional gate: remove its hook and disable it for autonomy, or register the hook and enable `permission_gate.enabled` for requested confirmations. Unreadable settings/config require explicit verification. |
| `permission-gate-mode`, `unit-permission-mode` | Verify actual launch mode and settings together; the headless gate expects bypass mode. Ask the operator to reconcile them outside this session. |
| `permission-gate-ask-hook`, `permission-gate-ask-config-match` | Have the operator register the AskUserQuestion relay and align `ask_user_question.enabled` with it so questions reach Telegram. |
| `gate-policy-path`, `permission-policy*` | Have the operator check the policy path, syntax and default tier. Review risky `confirm_overrides` deliberately: ordinary sudo/rm rules can be lifted; catastrophic forms retain separate hard denies. |
| `webhook-bind`, `permission-endpoint` | Ask the operator to restore the loopback listener and verify GET `/health`; never POST a permission request as a probe. |
| `env-file-mode` | Have the operator restrict env-file permissions to the service account (normally mode 600). |
| `allowlist-*` | Have the operator allow the intended user AND chat in effective config/env. For DM both IDs are equal; re-run with `--user`. Group policy needs separate inspection. |
| `mirror-terminal`, `progress-surfaces` | Follow Mirror above; verify the private target and keep one intended progress surface to avoid duplicate messages. |
| `multichat-dm-mirror`, `multichat-dirs`, `spawn-chat-shell-tmux-pane` | Have the operator reconcile actual policy/chat folders, keep terminal output private, and use the current spawn helper with TMUX_PANE forwarding. |
| `comms-consistency` | Have the operator fix MCP JSON and enable the same intended servers in actual session settings; Gbrain is optional for students. |
| `fleet-env-readable`, `fleet-env-keys`, `fleet-webhook-enabled`, `fleet-hook-ports`, `fleet-gate` | Resolve each named agent's env/config/hooks independently; confirm its own enabled webhook and any opt-in gate wiring, not another agent's files. |
| `fleet-ports-unique`, `fleet-tokens-unique`, `fleet-sockets`, `fleet-size`, `fleet-state-dirs-unique`, `fleet-workspaces-unique` | Have the operator verify discovery and give each agent its own port, bot token, tmux socket, state directory and workspace. Do not print token values. |
| `telegram-queue` | With existing 409 evidence, identify the competing consumer and let the operator coordinate stop/start. Do not issue getUpdates yourself. An empty saved queue does not prove delivery. |
| `live-session`, `auth`, `welcome-hang` | Have the operator inspect the real tmux pane, authenticate or clear first-run prompts; repair launch errors from an external terminal. A visible marker or reaction alone does not prove replies. |

## Update

There is no dedicated student updater script. Clone/development-channel manual
updates are documented in [Linux Update](../../docs/03-installation-linux.md#update-плагина)
and [macOS Update](../../docs/03-installation-macos.md#update-плагина).
Use the actual installation, not the diagnostic checkout. The external operator:

1. Records the installed commit, running revision if known, and local changes;
   backs up config and persistent state using the OS guide's backup procedure.
2. Checks the target version and [CHANGELOG](../../CHANGELOG.md), and preserves
   local changes before updating. Do not apply a blind pull or overwrite them.
3. Stops the channel from an external terminal as documented for its OS,
   follows the guide's checkout update (`git pull`), installs dependencies with
   `bun install` from `plugin/`, then runs `bun test`
   and `bun run typecheck`; only then starts the channel again. This diagnostic
   never performs those operations.
4. Re-runs this doctor and verifies a real DM reply, mirror and pinned tasks.
   Updated files are not proof that a still-running session loaded them.

The OS guides contain `git reset --hard HEAD~1`; do not use that as generic
rollback. Restore the recorded known revision and backups with the operator's
approval, preserving state and local changes.

For marketplace installs, [RELEASING](../../docs/RELEASING.md) explains
`/plugin update` and the manifest version requirement: source commits alone
do not trigger an update. The repository does not provide a complete student
marketplace runbook; use its supported management mechanism, not clone commands
inside an assumed cache. Do not invent an updater command.

## Boundaries and further references

Read-only: no config edits, updates, restarts, hook execution, Telegram sends,
permission POSTs, competing pollers or credential output. Do not conclude
"healthy" without observed end-to-end delivery. Rich Messages diagnostics,
secret-path exceptions, Guest Mode, removed private ElevenLabs broker tooling,
and dynamic launchd wrappers are outside this script's coverage.

For migration use [migration guide](../../docs/04-migration-from-gateway.md);
for symptoms use [troubleshooting](../../docs/05-troubleshooting.md). The
[macOS installation guide](../../docs/03-installation-macos.md) is authoritative
for the current wrapper/plist (`KeepAlive.SuccessfulExit=false`); the older
[skill migration reference](references/01-migration-steps.md) contains historical
launchd guidance. [Failure modes](references/02-failure-modes.md) and
[lessons](references/03-lessons-learned.md) are historical context, not a promise
that every learning or optional external integration is checked automatically.

Doctor implementation/tests: `scripts/doctor.ts`, `scripts/doctor.test.ts`
relative to this skill. Run `bun test "$doctor_skill_dir/scripts/doctor.test.ts"`.
