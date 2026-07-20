# Releasing — version discipline for agent47-channel

How plugin versions work in this repo and the exact steps to cut a release.

## Where the version lives (official Claude Code semantics)

Claude Code resolves a plugin's version in this order (first match wins):

1. `version` in `.claude-plugin/plugin.json` — **our source of truth**
2. `version` in a marketplace entry (we don't set one)
3. Git commit SHA (only when neither declares a version)

Consequences:

- `/plugin update` is a no-op until the `plugin.json` version is bumped —
  pushing commits alone does NOT update marketplace installs.
- Git tags are **not** read by Claude Code; we tag purely for humans and
  `gh release`.
- Our fleet runs the plugin as a development channel
  (`claude --dangerously-load-development-channels server:agent47-channel`
  with the launchd working dir at `plugin/`), so live agents pick up code on
  session restart regardless of the version field. The version is still
  meaningful: MCP identity, diagnostics, changelog anchoring, and any future
  marketplace distribution.

## The three declaration sites (must never drift)

| Site | Role | Sync mechanism |
|---|---|---|
| `.claude-plugin/plugin.json` | Claude Code plugin version (source of truth) | bumped by hand |
| `plugin/package.json` | Bun package version | bumped by hand, equality enforced by `plugin/tests/version-sync.test.ts` |
| `Server(...)` identity in `plugin/src/server.ts` | MCP protocol identity | imports `pkg.version` from package.json — never hardcode |

## Semver rules for this plugin

- **MAJOR** — breaking changes for operators or agents: renamed/removed env
  vars or config keys, changed MCP tool names/schemas, changed state-file
  formats without migration, changed launchd/tmux contract.
- **MINOR** — new features, new MCP tools/commands, new config options with
  safe defaults (rich messages, guest mode, HUD are all MINOR-class).
- **PATCH** — bug fixes, false-positive gate fixes, docs, dependency bumps
  with no behavior change.

One release may bundle several merged PRs; the highest-class change decides
the bump.

## Release steps

1. Branch `chore/release-vX.Y.Z` (or bump as part of the feature PR when the
   release is a single PR).
2. Bump `version` in **both** `.claude-plugin/plugin.json` and
   `plugin/package.json`.
3. Add a `## [X.Y.Z] — YYYY-MM-DD` section at the top of `CHANGELOG.md`
   (Keep a Changelog: Added / Changed / Fixed / Removed; reference PR
   numbers).
4. Verify from `plugin/`:
   ```bash
   bun test            # includes tests/version-sync.test.ts
   bun run typecheck
   ```
   and from the repo root:
   ```bash
   claude plugin validate .
   ```
5. Double review (Codex + second-family model) — required before any commit
   in this repo.
6. PR to `main`, merge.
7. Tag and publish the release from the merge commit:
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   gh release create vX.Y.Z --title "vX.Y.Z" --notes "<changelog section>"
   ```
8. Fleet rollout (when the change should go live): restart the affected
   channel sessions — the dev-channel path loads code from the working tree,
   not from the version field.

## History note

Versions before 1.0.0 were not tracked (2026-05-14 → 2026-06-14, ~60 merged
PRs). 1.0.0 is a retroactive baseline pinned to the 2026-06-14 state of
`main`; 1.1.0 is the first release cut under this process.
