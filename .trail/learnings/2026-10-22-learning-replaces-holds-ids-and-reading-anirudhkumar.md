---
title: "Learning replaces: holds ids, and a reading-only turn is a save signal"
author: Anirudhkumar-nanonets
date: 2026-10-22
branch: feat/note-signals-gate
touches:
  - src/notes/learning-fields.ts
  - src/notes/notes.ts
  - src/notes/note-gate.ts
  - src/claude/shim-template.ts
  - src/claude/note-signals.ts
  - src/claude/hooks.ts
  - src/cli.ts
---

## Decided
- `replaces:` holds the old learning's id (`l-…`, `asLearningId` in src/notes/learning-fields.ts), never its file name. `trail note --replaces <file>` looks the file up with `findLearning` and writes its id. The note gate's `repeatOf` and the shared hook (src/claude/shim-template.ts) compare ids too. The hook works out an id-less file's id as `l-` plus the first 6 hex digits of the sha1 of its name, like `learningId`.
- `listNotes` returns every learning. Readers that should skip replaced, held or retired ones wrap it in `liveLearnings`: findNotes, standingLearnings, the file-open delivery in hooks.ts and the gate's existing list in cli.ts.
- The Stop hook keeps an `explored` signal next to fixed/corrected/undone/chose/shipped. One turn with at least `NOTE_WORTHY_READING` (30k) tokens of reading counts: trail's `tokens saved ≈ N` lines, plus Read/Grep/Glob results at 4 characters a token. Finding where a feature lives or why a bug happens needs no edit to be worth saving.

## Tried and ruled out
- Taking either side of the src/notes/notes.ts merge conflict between #663 and #654. Both added `replaces`, one as a file name and one as an id, so the clash was in meaning, not text.
- Filtering replaced learnings inside `listNotes`. `trail check` passes its own rule to `liveLearnings` (only a replacement on the base branch hides one), and a filter in `listNotes` would hide learnings before that rule runs.

## Watch out
- `readLearningFields` silently drops a `replaces:` value that isn't an id, so a file name there leaves the old learning showing.
- Changing src/claude/shim-template.ts changes every repo's committed `.trail/hook.cjs`. Those repos (assign) need one more hook commit after the release.
- In a fresh worktree here, `npm ci` fails at tree-sitter-cli's install script, which downloads a binary. `npm ci --ignore-scripts` is enough for `tsc` and the tests.
