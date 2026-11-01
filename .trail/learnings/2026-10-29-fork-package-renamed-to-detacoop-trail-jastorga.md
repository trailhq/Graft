---
title: "Fork package renamed to @detacoop/trail-code — bin.trail must point to trail.js"
author: jastorga
date: 2026-10-29
branch: feat/semantic-search
id: l-0436845f
scope: repo
status: active
src: agent
touches:
  - package.json
---

## Decided
- package.json name: @detacoop/trail-code (not @nanonets/graft or @trailhq/trail-code). Needed to avoid npm collision with upstream when installing both.
- package.json bin.trail must point to dist/bin/trail.js, NOT dist/bin/graft.js. If it points to graft.js, the binary runs with brand=graft, MCP tools register as graft_* instead of trail_*, and the error 'Cannot find package @trailhq/trail-code' appears in Hermes mid-session.

## Watch out
- After any npm run build + npm install -g . --ignore-scripts, verify: cat trail.cmd | grep dist/bin — must say trail.js.
- The prepare script is skipped by --ignore-scripts. Always run npm run build explicitly before npm install -g .
