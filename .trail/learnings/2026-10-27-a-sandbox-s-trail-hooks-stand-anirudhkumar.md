---
title: "A sandbox's trail hooks stand down when Claude runs with the real HOME; move the shim out of .claude/helpers"
author: Anirudhkumar-nanonets
date: 2026-10-27
branch: feat/link-repo-to-workspace
id: l-e9301767
scope: repo
status: active
src: agent
touches:
  - TELEMETRY.md
  - src/claude/format.ts
  - src/claude/hooks.ts
  - src/claude/note-signals.ts
  - src/claude/pre-bash.ts
  - src/claude/prompt-hook.ts
  - src/claude/settings-merge.ts
  - src/claude/skill-template.ts
  - src/claude/skill-use.ts
  - src/cli.ts
---

## Decided
- Trail now acts at a session's moments through hooks rather than waiting for the agent to run a trail command:
  - Before an edit, the PreToolUse `pre-edit` hook hands the agent the learnings on that file (`handlePreEdit`, src/claude/hooks.ts).
  - Before `git commit`, `git push` or `gh pr create`, pre-bash runs `trail check` and stops the command once per set of conflicts (src/claude/pre-bash-check.ts). It loads only builtins, brand.ts and trace/gate-file.ts, and the check runs in a child capped at 3.5 s.
  - When one of these hooks used trail, the person gets the workspace link as a notice (`hookNotice`, src/cloud/nudge.ts).
- A check run with a folder flag counts for the fixed sign: `go -C backend test`, `npm --prefix web test`. Claude often runs it that way, and without the flag the Stop hook missed a real fail-then-pass.

## Tried and ruled out
- Blaming `claude -p` when the prompt, Stop and PostToolUse hooks went quiet in a sandbox. It runs them all. The cause was `globalCopyCovers` (src/claude/hook-layers.ts): a shim under `<sandbox>/home/.claude/helpers` looks like a repo's copy. Claude ran with the real HOME, whose `~/.claude/settings.json` has trail's hooks, so the shim stood down for a copy that `--setting-sources project,local` never loads.

## Watch out
- In a sandbox that keeps the real HOME for Claude's login, copy the shim out of any `.claude/helpers` folder and point the sandbox settings at the copy (trail-cloud's dev/local-flow/demo-env.sh does this). Also clear the CLAUDE_* variables a parent Claude session exports. `CLAUDE_CODE_CHILD_SESSION` alone turns off transcript saving.
- The first upload after connecting waits for a `git fetch` of the repo's real remote: about 30 s on assign.
