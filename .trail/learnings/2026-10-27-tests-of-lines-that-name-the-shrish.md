---
title: Tests of lines that name the trail command must pass with and without trail installed
author: Shrish
date: 2026-10-27
branch: feat/browser-sign-in
cost: { minutes: 4, tokens: 112003 }
id: l-49f806e9
scope: repo
status: active
src: agent
touches:
  - test/mcp-connector.test.ts
  - CHANGELOG.md
  - package-lock.json
  - package.json
  - src/claude/hooks.ts
  - src/cli.ts
  - src/cloud/nudge.ts
  - src/cloud/team-file.ts
  - src/cloud/workspace-sync.ts
  - src/cloud/workspace.ts
---

## Decided
`teamLine` (src/cloud/team-file.ts) says `trail login …` when `trailOnPath()` finds trail, else `npx -y @trailhq/trail-code@latest login …`. Tests of it (test/mcp-connector.test.ts) accept both forms.

## Watch out
A dev laptop has trail installed and CI doesn't, so a test that expects `trail login` passes locally and fails on CI. To check locally, run the test with a PATH holding only a symlink to node: Homebrew puts node and trail in the same folder, so dropping /opt/homebrew/bin from PATH removes node too.
