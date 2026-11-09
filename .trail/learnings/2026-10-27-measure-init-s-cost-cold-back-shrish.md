---
title: "Measure init's cost cold: back-to-back runs undercount it"
author: Shrish
date: 2026-10-27
branch: feat/fast-valuable-learnings
cost: { minutes: 1, tokens: 2017 }
id: l-36e6fa0a
scope: repo
status: active
src: agent
touches:
  - src/cli.ts
  - src/init/look-back.ts
  - src/init/review-screen.ts
  - src/init/review-tty.ts
  - src/init/run.ts
  - src/init/types.ts
  - src/learn/bar.ts
  - src/learn/sessions.ts
  - src/notes/pr-reviews.ts
  - test/init-pair-reviews.test.ts
---

## Watch out
- Back-to-back init runs reuse Claude's prompt cache, so they report about a third of the real cost. On trail-cloud, warm runs showed $0.10 per init, and a cold first init cost $0.36 ($0.16 PR read, $0.21 session read).
- In the code: each read writes `costUsd` and `ms` to its mark under the repo's Trail home (`pr-reviews.json`, `session-learnings.json`). Quote cost from a run made 20+ minutes after the last one, on a fresh clone with the marks cleared.
