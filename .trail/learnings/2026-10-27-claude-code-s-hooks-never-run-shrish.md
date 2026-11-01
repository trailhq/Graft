---
title: "Claude Code's hooks never run as the trail command, so a hook asks the repo whether it's Trail's"
author: Shrish
date: 2026-10-27
branch: fix/npx-agent-entries
cost: { minutes: 1, tokens: 1905 }
id: l-ac3b781f
scope: repo
status: active
src: agent
touches:
  - src/claude/pre-bash-check.ts
  - src/claude/pre-bash.ts
  - test/trail-scenario-hooks.test.ts
---

## Decided
A hook that should act only for Trail checks the repo, not the environment: `brand(env) === 'trail' || repoWiredForTrail(dir)`. TRAIL_INVOKED_AS is set only when the `trail` command starts the process (bin/trail.ts). Claude Code starts hooks through the user-level hooks shim, so inside a hook `brand()` says graft. hooks.ts calls `adoptRepoBrand` for this reason; the PreToolUse fast path (pre-bash.ts) didn't.

The commit check warns for now (SHIP_CHECK_STOPS = false in pre-bash-check.ts): it adds `additionalContext` with no permission decision, and Claude Code shows that next to the command's result while the command runs normally.

## Tried and ruled out
Testing hooks with `process.env[BRAND_ENV] = 'trail'` set at the top of the test file: it hid that #708's commit check never ran in a real session. Keep one test that passes an env with no brand.

## Watch out
- The commit pattern must allow git's own options before the subcommand (`git -C app push`, `git -c user.name="A B" commit`); agents write both.
- In a sandbox clone, `trail check` takes its base from `origin/HEAD`. A clone made from a feature branch points there, so a learning on main shows as "not on the base branch yet".

In the code: src/claude/pre-bash-check.ts, src/claude/pre-bash.ts (SHIP_COMMAND, preBashContext), test/trail-scenario-hooks.test.ts.
