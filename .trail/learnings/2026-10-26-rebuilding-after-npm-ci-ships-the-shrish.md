---
title: Rebuilding after npm ci ships the release tarballs without the telemetry key
author: Shrish
date: 2026-10-26
branch: release/0.26.0
cost: { minutes: 11, tokens: 42040 }
id: l-3c659188
scope: repo
status: active
src: agent
touches:
  - CHANGELOG.md
  - package-lock.json
  - package.json
  - src/cli.ts
  - src/cloud/nudge.ts
  - src/cloud/pair.ts
  - test/pair-late-connect.test.ts
  - test/init-pair-stops.test.ts
  - scripts/stamp-telemetry-key.mjs
---

## Watch out
- `npm ci` runs `prepare`, which builds and then stamps the telemetry key into `dist/telemetry/key.js` (`scripts/stamp-telemetry-key.mjs`, from `GRAFT_POSTHOG_KEY`). Running `npm run build` again afterwards writes an unstamped `key.js` over it, and `npm pack --ignore-scripts` then packs a build that sends no telemetry. Nothing fails or warns at pack time.

## Decided
- Release order: build, then `node scripts/stamp-telemetry-key.mjs` with the key in the environment, then `node scripts/pack-trail.mjs`, then `npm pack --ignore-scripts` for the root and `build/trail`.
- Check each tarball before publishing: import its `dist/telemetry/key.js` with `GRAFT_POSTHOG_*` unset and print only the length of `posthogKey()`, never the key.
