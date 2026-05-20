# Gateway Parity Migration

## Objective

Enable jarvis-telegram-gateway parity in the running qwwiwi canary Telegram Claude bot through successive safe, verified local slices, starting with a locally testable command-parity slice.

## Original Request

Migrate gateway parity for the running canary Telegram Claude bot. Treat `/goat` as `/goal`. Compare this repo with `/Users/jasonqwwen/projects/jarvis-telegram-gateway`, especially `gateway.py` and README feature surface. Produce a feature parity matrix, choose a safe first canary implementation slice, use TDD, commit and push verified docs/code progress, and leave GoalBuddy active on the next smoke-test/migration task.

## Intake Summary

- Input shape: `existing_plan`
- Audience: qwwiwi canary Telegram Claude bot operator and future migration agents
- Authority: `requested`
- Proof type: `test`
- Completion proof: local tests and canary-safe smoke evidence show the selected gateway capabilities work without exposing secrets, touching production token/config/launchd/tmux state, or violating one-token-one-consumer canary operation.
- Likely misfire: copying the full gateway or restarting live canary without evidence instead of delivering small, tested, reversible parity slices.
- Blind spots considered: token secrecy, live canary one-consumer safety, gateway feature breadth, Telegram formatting edge cases, produced-file delivery, transcription dependencies, webhook injection risk, and session persistence compatibility.
- Existing plan facts: compare against jarvis `gateway.py` and README; include command, media, context, reactions, callbacks, routing, Markdown HTML, produced files, webhook injection, memory hooks, streaming/progress, and `claude --resume`; start with a safe locally testable slice; do not touch production token files, launchd jobs, gateway config, or production tmux sessions.

## Goal Kind

`existing_plan`

## Current Tranche

Build the migration board, map current parity, implement and verify one safe canary slice, then leave the board active on the next smoke-test/migration task rather than claiming full gateway parity is complete.

## Non-Negotiable Constraints

- Do not expose or print Telegram, Groq, OpenViking, or other secret tokens.
- Do not touch production token files, launchd jobs, gateway config, or production tmux sessions.
- Preserve one-token-one-consumer for canary.
- Current live tmux `orgrimmar-canary` is presumed to run `scripts/dashi-telegram-canary-bot --reply-mode claude --claude-max-budget-usd 0.20`; do not replace it without host evidence and tests.
- Prefer small focused modules and tests over copying the whole reference gateway.
- Use TDD for implementation.
- Treat `/goat` as `/goal`.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection if a safe Worker task can be activated.

Do not stop after a single verified Worker package while broader gateway parity still has safe local follow-up work. Advance the board to the next smoke-test or migration task and keep the goal active.

## Slice Sizing

Safe means bounded, explicit, verified, and reversible. It does not mean tiny.

A Worker should finish the whole assigned slice and verify it with local tests. Risky runtime operations, credentials, production process changes, and webhook or live token consumption must be deferred until the board records evidence and a smoke plan.

## Canonical Board

Machine truth lives at:

`docs/goals/gateway-parity-migration/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins.

## Run Command

```text
/goal Follow docs/goals/gateway-parity-migration/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter.
2. Read `state.yaml`.
3. Run the GoalBuddy update checker when available.
4. Work only on the active board task.
5. Record compact receipts with paths, commands, and decisions.
6. Use Scout/Judge/Worker task roles according to the task.
7. Continue to the next safe local task unless a phase, risk, ambiguity, rejected verification, or final audit boundary applies.
