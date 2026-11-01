---
title: "Testing the cloud nudge locally: rebuild dist first, and a nudge sign-in lands before the first sync"
author: Anirudhkumar-nanonets
date: 2026-10-27
branch: feat/build-map-on-first-use
cost: { minutes: 36, tokens: 418798 }
id: l-e903e143
scope: repo
status: active
src: agent
touches:
  - src/cloud/nudge.ts
---

## Decided
- To walk the CLI → trail-cloud connect flow locally: run trail-cloud from a worktree of `origin/main` with its own Postgres (initdb on a spare port) and `TRAIL_DEV_SIMULATE=1`. Point a sandboxed trail at it with `TRAIL_TEST_SERVER=http://localhost:8787`, `TRAIL_HOME=<sandbox>/.trail`, `TRAIL_CLOUD=1` and `DO_NOT_TRACK=1`, running `node <checkout>/dist/bin/trail.js` through a wrapper named `trail`.
- The clone's origin must stay the real GitHub URL. A `local/` repo key never gets the nudge (`cloudLines`, src/cloud/nudge.ts).

## Tried and ruled out
- Running against the existing `dist/`. It was older than src: it pointed at app.trailhq.com and ignored `TRAIL_TEST_SERVER`, so the `_trail-claim` child registered the repo key and its learning count with that real host. Run `npm run build` first, then grep `dist/cloud/workspace.js` for `DEFAULT_TRAIL_URL`.

## Watch out
- A nudge (unpaired) sign-in lands on `/app/?w=<slug>` before the CLI has claimed the token and uploaded anything. On the local run: browser at 24.1 s, claim at 24.25 s, `PUT /api/cli/learnings` at 28.98 s. The first look shows 0 learnings and "Add a repo".
- trail-cloud only sends paired setups to `/start/live`, because nothing reports progress for an unpaired link (`landing` in internal/web/connect.go).
- localhost cookies are shared across ports. To see a signed-out page while another server on localhost has a session, use 127.0.0.1.
