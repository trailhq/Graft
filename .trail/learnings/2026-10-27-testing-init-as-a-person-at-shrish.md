---
title: "Testing init as a person at a terminal needs screen, not script"
author: Shrish
date: 2026-10-27
branch: feat/fast-valuable-learnings
cost: { minutes: 1, tokens: 1661 }
id: l-137d5079
scope: repo
status: active
src: agent
---

## Watch out
- Init only runs its model reads (past sessions, PRs) when a person is at the terminal. The check refuses `script`, `expect` and `unbuffer` on purpose, since agents use them to fake a terminal, and it also refuses any Claude Code process above it and the CLAUDECODE variable.
- In the code: `personAtTerminal` and `isAgentProcess` (PTY_WRAPPERS) in person.ts. For a real-terminal run from an agent shell, start the CLI in a detached `screen -dmS` session under `env -i` (HOME, PATH, TERM only). screen has no agent above it, and the CLI sees a TTY. Log with a screenrc that sets `logfile flush 0`.

## Tried and ruled out
- `script -q /dev/null trail init`: counted as an agent, so no reads run.
- A double fork to reparent to launchd: `script` is still the parent.
