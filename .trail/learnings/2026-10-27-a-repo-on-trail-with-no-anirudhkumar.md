---
title: A repo on trail with no code map builds one on its first query
author: Anirudhkumar-nanonets
date: 2026-10-27
branch: feat/build-map-on-first-use
cost: { minutes: 42, tokens: 271571 }
id: l-def0a5f2
scope: repo
status: active
src: agent
touches:
  - src/util/state.ts
  - src/claude/sync-run.ts
  - src/graph/refresh.ts
  - src/claude/hooks.ts
  - src/claude/hook-io.ts
  - test/graph-refresh.test.ts
  - test/claude-hooks.test.ts
---

## Decided
- `ensureFreshGraph` (src/graph/refresh.ts, `buildMissingMap`) builds a missing map only when the map dir is `.trail/cache` (`isTrailMapDir`), there's no `--dir`/`GRAFT_DIR`, and the dir isn't the home folder (`homeFolderRefusal`). Graft repos still build nothing behind the user's back.
- The first query takes the sync lock and spawns `claude/sync-run.js <dir> <timeoutMs>` detached; the child runs a full `build` and releases the lock. Queries wait on `lockHeldIn` (src/util/state.ts) up to 90s, which fits the agent shell's 2-minute limit. assign (8.5k files) builds in about 75s.
- Hook children run with `GRAFT_FIRST_BUILD_WAIT_MS=0` (src/claude/hooks.ts, hook-io.ts): the prompt hook starts the build and answers within its ~8s budget.

## Tried and ruled out
- Building synchronously inside the query: the prompt hook's `execFileSync` timeout kills it, the signal handler drops the lock, and every prompt would restart a 75s parse.
- Reusing sync-run's 120s limit for a first build: slower Windows and Linux laptops would never finish one.

## Watch out
- A first build longer than `LOCK_STALE_MS` (5 min) can have its lock taken, starting a second build alongside it.
- With trail installed globally, 3 tests fail on main as well: two expect a machine without trail on PATH, one still expects "graft is now Trail-code".
