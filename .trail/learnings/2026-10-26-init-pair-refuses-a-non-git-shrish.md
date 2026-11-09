---
title: "init --pair refuses a non-git folder, plain init still allows it, and a stopped pair run tells Trail why"
author: Shrish
date: 2026-10-26
branch: feat/report-setup-stops
cost: { minutes: 16, tokens: 155707 }
id: l-a427b083
scope: repo
status: active
src: agent
touches:
  - src/brand.ts
  - src/cli.ts
  - src/init/run.ts
  - src/notes/pr-reviews.ts
  - test/init-pair-reviews.test.ts
  - test/pr-reviews-fixtures.ts
  - test/trail-pr-reviews.test.ts
  - test/init-pair-stops.test.ts
  - src/init-guard.ts
---

## Decided
- `init --pair` refuses a folder that isn't a git repo (NOT_GIT_PAIR_REFUSAL in src/init-guard.ts). Trail's page shares a repo with the team, and a pair run with no repo left a workspace with no repo and a review that 404'd ("Couldn't save your learnings"). Plain `trail init` still sets up non-git folders on purpose, as Anirudh's Oct 19 learning says.
- A paired run that stops tells Trail why, so the page never waits forever:
  - Before it registered a run (home folder, not a git repo, agent ids it doesn't know): `failPair`, which posts to /api/cli/pairs/fail.
  - After it registered (an uncaught error at the end of src/cli.ts, or SIGTERM from an agent's tool timeout): `PairRun.fail("crashed")`.
- Reasons are a fixed set the server checks: home_folder, not_git, bad_agents, crashed.

## Watch out
- `livePair` must go back to null once `pair.finish` ran. Otherwise a later error would mark a finished run as crashed.
- The SIGTERM handler waits at most 3 s to send, then exits 143. The agent may SIGKILL soon after.
