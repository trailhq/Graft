---
title: "trail init --pair reads PR reviews even when an agent runs it, and always runs as trail"
author: Shrish
date: 2026-10-26
branch: fix/pair-reads-reviews
cost: { minutes: 164, tokens: 1910253 }
id: l-66456aea
scope: repo
status: active
src: agent
touches:
  - src/cli.ts
  - src/cloud/pair.ts
  - src/hosts/auto.ts
  - src/hosts/init.ts
  - src/hosts/mcp-config.ts
  - src/upkeep-run.ts
  - src/upkeep.ts
  - test/hosts-auto.test.ts
  - test/init-agents-auto.test.ts
  - README.md
---

## Decided
- `init --pair` reads merged PR reviews even when an agent runs it (`beginLookBack` `pair`, src/init/run.ts). Pasting Trail's setup prompt is the person asking for it. Before this, `model = !agent` skipped reviews on every agent run, so almost every first run showed 0 learnings on Trail's page.
- An agent's review read is capped at AGENT_CAP_MS (100 s, gh plus the model call) so it ends inside Claude Code's 120 s tool limit (`capMs` in src/notes/pr-reviews.ts).
- A `--pair` run always runs as trail (`asksForTrail` in src/brand.ts, applied at the top of src/cli.ts), even when started as `graft` or by an old shim that loads dist/cli.js. Agents swap in `graft` when the npm install of @trailhq/trail-code fails, and under graft the look-back and `.trail/` were skipped while the page waited. If `trail` isn't on PATH, init says to install it.

## Tried and ruled out
- Reading reviews in the detached `_trail-pair` child after init returns: the server keeps everything found once "done" and the workspace both exist (internal/store/keepall.go), so findings sent later would never be kept.

## Watch out
- `claude -p` started from inside a Claude Code session works (checked 2026-10-26), so a nested model call is not why agent runs skipped it.
- test/graft-to-trail.test.ts and test/hosts-trail.test.ts fail on a machine that has a real `trail` on PATH. They pass on CI and with PATH stripped to node and git. This is not a product bug.
