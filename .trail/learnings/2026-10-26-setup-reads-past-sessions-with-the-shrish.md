---
title: "Setup reads past sessions with the person's own Claude again; only learnings leave the laptop"
author: Shrish
date: 2026-10-26
branch: feat/fast-valuable-learnings
cost: { minutes: 5, tokens: 50680 }
id: l-3d07f7d4
scope: repo
status: active
src: agent
touches:
  - docs/superpowers/plans/2026-10-27-valuable-learnings.md
  - docs/superpowers/specs/2026-10-27-valuable-learnings-design.md
  - src/init/claude-call.ts
---

## Decided
- Shrish (2026-10-27) reversed D87/R60: `trail init` may send past-session text to the person's own `claude` (their plan, from their machine) to find decisions, as long as it's cheap and session text never reaches Trail's servers. Only kept learnings are shared with the team.
- The session read covers both sides of the conversation (typed messages, Claude's replies, answered questions, plans, commit/PR commands), never tool output. Design: docs/superpowers/specs/2026-10-27-valuable-learnings-design.md.
- Model stays `claude-sonnet-5-5`; cost is cut by sending less (session digest ≤ 100k chars, PR digest ≤ 120k).

## Tried and ruled out
- `claude-haiku-5-5` on the same inputs: slightly plainer headlines, but slower (30 to 41 s vs 21 to 25 s) and more expensive as Claude Code reported it ($0.46 to $0.62 vs $0.23 to $0.29 per read).

## Watch out
- `callClaude` (src/init/claude-call.ts) only reads `structured_output.findings`; a schema with any other top-level key comes back as an empty list with ok: true.
