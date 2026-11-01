---
title: "An agent seeing no Trail tools on a busy machine isn't proof the sign-in broke"
author: Shrish
date: 2026-10-27
branch: fix/npx-agent-entries
cost: { minutes: 3, tokens: 21386 }
id: l-b62311ca
scope: repo
status: active
src: agent
touches:
  - CHANGELOG.md
  - package-lock.json
  - package.json
  - src/cli.ts
  - src/mcp/connector.ts
  - src/hosts/mcp-config.ts
---

## Decided
Before treating "no Trail tools" in an end-to-end test as a bug, ask the server directly. Run the agent's own `mcp --brains` command, send initialize, wait a few seconds, then send tools/list. If it lists the tools, the agent just stopped waiting for a slow listing, which happens when the CPU is pegged (for example, the full test suite running alongside).

## Tried and ruled out
Concluding from one `claude -p` run with no tools that a change (here #708's several-workspaces sign-in) broke the agent setup. Called directly, the server listed all 6 tools, and the same session run with the CPU idle got them.

## Watch out
Don't run the end-to-end agent check while `npm test` is running. A real empty listing does happen: an agent entry whose command isn't on the person's own PATH gets none (the npx case fixed in 0.28.0).

In the code: src/mcp/connector.ts (workspace listing wait), src/hosts/mcp-config.ts serverEntry.
