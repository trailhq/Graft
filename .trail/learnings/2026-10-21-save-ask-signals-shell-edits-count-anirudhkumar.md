---
title: "Save-ask signals: shell edits count, and noteName on Windows"
author: Anirudhkumar-nanonets
date: 2026-10-21
branch: feat/note-signals-gate
touches:
  - src/claude/note-signals.ts
  - src/notes/notes.ts
---

## Decided
- The Stop hook's fail-then-pass sign (src/claude/note-signals.ts) counts an edit made through the shell (python heredoc, sed -i, tee, redirect) as well as Edit/Write. In the assign rehearsal Claude fixed the code with `python3 - <<EOF` and no ask fired until this was added. Shell writes to trail's own files (.claude/, .trail/) still don't count.
- Paths in a shell edit resolve against the transcript's per-call `cwd` plus a leading `cd X &&`.

## Tried and ruled out
- Matching the failing and passing check by full command string: Claude reruns with different flags or packages. The check's name (`go test`, `npm test`) is the key.

## Watch out
- noteName (src/notes/notes.ts) cut Windows paths at the drive colon, so the `--replaces` hint printed `\Users\...\.trail\learnings\x.md`. It now also splits on `\`. Only Windows CI caught it.
