---
title: A laptop links each repo to one Trail workspace; cloud.json keeps the newest connection at the top level
author: Anirudhkumar-nanonets
date: 2026-10-27
branch: feat/link-repo-to-workspace
id: l-36c8d257
scope: repo
status: active
src: agent
touches:
  - src/claude/skill-use.ts
  - src/cli.ts
  - src/cloud/lookup-activity.ts
  - src/cloud/nudge.ts
  - src/cloud/pair.ts
  - src/cloud/workspace-sync.ts
  - src/cloud/workspace.ts
  - src/mcp/connector.ts
  - src/mcp/server.ts
  - test/trail-nudge.test.ts
---

## Decided
- A machine can be in several workspaces, one `trl_` token each. trail-cloud already mints one token per handoff for the workspace picked, so this needed no server change.
- Each repo goes to exactly one workspace from a machine: the newest connection whose `repos` lists it (`cloudForRepo` / `cloudIn`, src/cloud/workspace.ts). Sync, the activity outbox, `recordLookup`, `recordSkillUse`, the MCP connector (by the server's cwd), `team` and `status` all resolve the repo first. `readCloud()` now means only "the newest connection", for things that aren't about one repo.
- `cloud.json` keeps the newest connection at the top level and the rest under `others`. An older trail still reads it as the machine's one connection, and keeps `others` when it writes that connection back, because it spreads the object it read.
- Two connections are the same workspace when their `workspace.id`s match. Re-pointing a workspace at a new address replaces it.
- Signed in, a repo with learnings that no workspace here has gets the link every session ("Pick a Trail workspace for <repo>"), in place of the old "add it?" question asked once ever. Trail's connect page then offers the person's workspaces or "create a new workspace".
- `trail workspace add` needs `--to <slug>` when there are several, and refuses a repo that already goes to another workspace. `trail logout --workspace <slug>` drops one.

## Tried and ruled out
- `sameWorkspace` by URL and id: a test (and a real `--server` move) that re-points the same workspace at a new address ended up with two connections.
- Reusing one pending link across repos: the link registers only the repo it was made in, so a link from repo A connects A even when shown in B. Each repo now gets its own. `waitForConnect` switches to the newest pending link, and the old one is left to expire.

## Watch out
- `flushActivity` drops a use whose repo no connection has, so it always reads every connection from disk and merges in what the caller passes. Passing one cloud never loses another workspace's uses.
- Only the first connection drops the outbox (`dropActivity`). A later link keeps what the other workspaces have waiting.
- graft-to-trail.test.ts, hosts-trail.test.ts and upkeep-hooks.test.ts each had one failure on this machine, on main as well as on this branch (checked 2026-10-27).
