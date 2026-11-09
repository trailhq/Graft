---
title: "A paired init that can't reach Trail stops instead of setting up locally"
author: Shrish
date: 2026-10-26
branch: feat/pair-needs-network
cost: { minutes: 6, tokens: 38743 }
id: l-c4706bd1
scope: repo
status: active
src: agent
touches:
  - src/cli.ts
---

## Decided
- `trail init --pair` that gets no answer from Trail when it registers the run (`PairRun.start` returns an error with no HTTP status: unreachable or timed out) exits 1 before writing anything, and tells the agent to run the same command again with network access (or check VPN/proxy). In `src/cli.ts` next to the `PairRun.start` call.
- If Trail answers with an error status, init still sets up here anyway, as before.

## Why
- Codex runs commands with the network off unless asked. Setting up locally finished "fine", printed no link, and Trail's page waited on a run it never heard of. Stopping with a clear line is something the agent acts on: it asks for network access and re-runs.

## Watch out
- Only the start can stop init. Every later progress call stays best effort (`PairRun` doc).
