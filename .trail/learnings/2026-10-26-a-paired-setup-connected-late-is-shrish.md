---
title: A paired setup connected late is finished by the next trail command
author: Shrish
date: 2026-10-26
branch: feat/late-pair-connect
cost: { minutes: 1, tokens: 11424 }
id: l-364915e8
scope: repo
status: active
src: agent
touches:
  - src/cli.ts
  - src/cloud/pair.ts
  - test/init-pair-stops.test.ts
  - src/cloud/nudge.ts
---

## Decided
- `PairRun.handOff` records the pending connect (state, repo, server, the wait's pid) as `pair` in `~/.trail/cloud-nudge.json`, which is owner-only because the state claims the token. See `rememberPair`, `resumePair` and `pairSettled` in `src/cloud/nudge.ts`.
- `cloudLines` (every `trail ask` / `note` / `check`) calls `resumePair` first: when the wait ran out, or its process is gone (laptop restarted), it starts `_trail-pair … --resumed` for 20 more minutes, while Trail still takes the link (24 h, `LINK_TTL_MS`).
- A resumed wait that connects leaves `linked` news, so the next command says once that the machine is connected. A connect the page showed live leaves no news.

## Watch out
- `resumePair` drops the pending pair when `cloud.json` exists: a connected machine has nothing to wait for. So a run that claimed the connect and then ran out waiting for the review is not resumed.
