---
title: "Quieting npm install: audit warnings and install noise"
author: Anirudhkumar-nanonets
date: 2026-10-22
branch: chore/quiet-npm-install
touches:
  - package-lock.json
  - package.json
  - scripts/stamp-telemetry-key.mjs
  - ".npmrc"
  - src/util/front-matter.ts
---

## Decided
- undici (high, via openai and node-gyp): lockfile bump to 6.29.1 with `npm audit fix`; no range change.
- sprintf-js (moderate, gray-matter → js-yaml 3 → argparse 1 → sprintf-js): no patched sprintf-js exists (every version ≤1.1.3 is flagged). argparse is only used by js-yaml's own CLI (bin/js-yaml.js), never by its parser, so package.json `overrides` gives js-yaml argparse ^2.0.1, which has no dependencies. js-yaml's CLI breaks; nothing here runs it.
- scripts/stamp-telemetry-key.mjs runs from `prepare`, so it ran on every `npm install` in a clone and printed "publishing a build that sends no telemetry". It now warns only when `npm_command` is `publish` or `pack`.
- `.npmrc` sets `fund=false` (not in package.json `files`, so it doesn't ship).

## Tried and ruled out
- Overriding js-yaml to 4 under gray-matter: gray-matter's default YAML engine calls `safeLoad`, removed in js-yaml 4, and src/util/front-matter.ts guards anchors through js-yaml 3's `listener` and `anchorMap` internals.
- `audit=false` in .npmrc: hides every future advisory too.

## Watch out
- `overrides` apply only to this repo's own install, not to users who `npm i -g` the package; global installs don't run audit, so they never saw the warning.
- The real fix for the sprintf-js chain is dropping gray-matter for js-yaml 4 or `yaml` directly, and porting the anchor guard in src/util/front-matter.ts with it. Remove the argparse override when that lands.
