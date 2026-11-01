---
title: "Under npx, trail is on PATH only for that one process, so it doesn't count as installed"
author: Shrish
date: 2026-10-27
branch: fix/npx-agent-entries
cost: { minutes: 10, tokens: 75759 }
id: l-1f9be02d
scope: repo
status: active
src: agent
touches:
  - CHANGELOG.md
  - package-lock.json
  - package.json
  - src/claude/hooks.ts
  - src/cli.ts
  - src/cloud/nudge.ts
  - src/cloud/team-file.ts
  - src/cloud/workspace-sync.ts
  - src/cloud/workspace.ts
  - src/hosts/claude-global.ts
---

## Decided
`commandOnPath` (src/brand.ts) skips `node_modules/.bin` folders. npx puts its temporary copy (`~/.npm/_npx/<hash>/node_modules/.bin`) first on PATH for the command it runs, and npm does the same for a project's dependencies. Agents start with the person's own PATH, so an entry written as `"command": "trail"` from inside npx points at nothing. `serverEntry` now falls back to `npx -y @trailhq/trail-code mcp` there.

## Tried and ruled out
Testing `npx … login --code` on a laptop that already had trail installed: it passes and hides the bug. Test on a sandbox HOME whose PATH holds only node, npm, npx, claude and git.

## Watch out
Laptops signed in with 0.27.0 through npx keep the broken `trail` entries until they sign in again or run a trail command that rewrites them.
