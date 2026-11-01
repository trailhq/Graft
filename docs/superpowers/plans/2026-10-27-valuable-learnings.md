# Valuable Learnings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `trail init` finds 5 to 8 learnings people value on day one, from past sessions (both sides) and the repo's PRs, each with a plain headline, in about 25 s.

**Architecture:** A shared bar (`src/learn/bar.ts`) holds the prompt, schema, quote check and the learning's file shape. The PR read in `src/notes/pr-reviews.ts` widens to descriptions, all discussion, closed PRs, reverts and docs and uses the bar. A new session read (`src/learn/sessions.ts`) digests past sessions with the existing chunked transcript reader and uses the bar. `src/init/run.ts` starts both reads with the code map and prints each as it lands.

**Tech Stack:** TypeScript (ESM), node:test via `npm test` (scripts/run-tests.mjs), `claude -p --json-schema` through `callClaude`, `gh api graphql`.

**Spec:** `docs/superpowers/specs/2026-10-27-valuable-learnings-design.md`

## Global Constraints

- Model `claude-sonnet-5-5` (`COLD_START_MODEL`), called only through `callClaude` on the person's own `claude`. No session text goes to Trail's servers.
- Session digest ≤ 100,000 chars; PR digest ≤ 120,000 chars; Claude's reply lines clipped to 400 chars, typed lines to 1,000.
- Headline: 6 to 14 plain words, no file or function names, no em dashes. Body: why, then `In the code:` line. Sections `## Decided` / `## Tried and ruled out` / `## Watch out` by kind `decided` / `ruled_out` / `watch_out`.
- At most 8 learnings per read; tool output never read; secrets scrubbed (`scrub`) before sending; a learning is kept only when a quote is found in the scrubbed digest it cites.
- Agent runs cap each read at 100 s (`AGENT_CAP_MS`); reads run only when `mayCallClaude` or `--pair`; `--plain`, `TRAIL_LOOK_BACK=off`, `TRAIL_NO_FETCH=1` turn them off.
- Tests run with a scratch HOME: `H=$(mktemp -d); HOME=$H USERPROFILE=$H npm test`. Known machine-only failures: `graft-to-trail`, `hosts-trail`.
- Copy rules: "learnings" never "rules"/"notes"; no em dashes in printed copy.

## Review Focus

1. A 233 MB transcript: the session digest must read in chunks (never a whole-file buffer) and stay under the char cap.
2. No `gh`, `gh` signed out, no `claude`, or `claude` not signed in: init finishes quietly with the reason line, no crash.
3. A session started in a parent folder: only its in-repo `stretch` is digested.
4. Running init again: neither read runs twice for a repo (marks), unless `--look-back`.
5. A secret typed in a session or pasted in a PR never reaches the prompt, and a quote that only matched the unscrubbed text fails the check.

---

### Task 1: The shared bar

**Files:**
- Create: `src/learn/bar.ts`
- Test: `test/learn-bar.test.ts`

**Interfaces:**
- Consumes: `placeQuotes`, `norm`, `scrub`, `QuoteSource` from `src/init/look-back.ts`.
- Produces:
  - `BAR: string` (system prompt, the spike's `rubric.mjs` text with the headline self-check), `LEARNING_SCHEMA` (top key `findings`, items `headline, why, for_agent, kind, evidence[{source, quote}]`).
  - `type LearningKind = "decided" | "ruled_out" | "watch_out"`.
  - `interface Learning { headline: string; why: string; forAgent: string; kind: LearningKind; sources: string[]; quotes: string[]; last: string }`.
  - `verifyLearnings(raw: unknown[], sources: QuoteSource[]): Learning[]` (keeps only items with a placed quote; newest first; max 8).
  - `plainHeadline(s: string): string` (flattened, em/en dashes → ", ", ≤ 100 chars).
  - `learningBody(l: Learning, from: string): string`.
  - `sameLearning(a: string, b: string): boolean` — true when the headlines' content words (lowercased, stop words and words ≤ 2 chars dropped) overlap ≥ 60% of the shorter one.

- [ ] **Step 1: Write the failing tests** in `test/learn-bar.test.ts`:
  - `learningBody puts a ruled_out learning under Tried and ruled out`: `learningBody({kind:"ruled_out", why:"Prod logs showed the proxy refused it.", forAgent:"internal/llm/llm.go sends user and tags.", ...}, "_From past Claude sessions here._")` equals `"## Tried and ruled out\n- Prod logs showed the proxy refused it.\n- In the code: internal/llm/llm.go sends user and tags.\n\n_From past Claude sessions here._"`; `decided` → `## Decided`, `watch_out` → `## Watch out`.
  - `verifyLearnings drops a learning whose quote isn't in its source`: sources `[{id:"s1", at:"2026-10-20T00:00:00Z", said:[norm("signup should be done as the first thing")]}]`; raw with one quote from s1 and one invented → result length 1, `sources` `["s1"]`.
  - `plainHeadline removes em dashes`: `plainHeadline("Sign-up first — always")` → `"Sign-up first, always"`.
  - `sameLearning matches a reworded headline`: `sameLearning("Sign-up comes first, before any onboarding screen", "Sign-up always comes first before onboarding")` → true; vs `"Every AI call must name a user and tags"` → false.
- [ ] **Step 2:** `H=$(mktemp -d); HOME=$H USERPROFILE=$H npm test -- test/learn-bar.test.ts` → FAIL (module missing). (If the runner takes no file arg, run `node --import tsx --test test/learn-bar.test.ts`.)
- [ ] **Step 3:** Implement `src/learn/bar.ts`.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** `git add src/learn/bar.ts test/learn-bar.test.ts && git commit -m "learn: one bar for every learning read"`

### Task 2: The PR read reads the whole conversation

**Files:**
- Modify: `src/notes/pr-reviews.ts` (QUERY, `GqlPR`, `reviewedPRs`, `reviewDigest`, `SYSTEM`/`SCHEMA` → bar, `verifyReviews`, `findReviewLearnings`, `anchoredReviews`, `saveReviewFindings`)
- Modify: `test/pr-reviews-fixtures.ts`, `test/trail-pr-reviews.test.ts`, `test/init-pair-reviews.test.ts` (fake claude now keys on the new prompt prefix `This repository's recent pull requests`)

**Interfaces:**
- Consumes: Task 1's `BAR`, `LEARNING_SCHEMA`, `verifyLearnings`, `learningBody`, `plainHeadline`.
- Produces: `ReviewedPR` gains `kind: "merged" | "closed"`, `description?: string`; comments gain `actedOn?: boolean`. `ReviewFinding.title` is the headline, `body` is `learningBody(...)`. `beginReviewRead` / `finishReviewRead` / `anchoredReviews` keep their signatures.

- [ ] **Step 1: Failing tests** (in `test/trail-pr-reviews.test.ts`):
  - `reviewedPRs keeps descriptions, comments and closed PRs`: fixture with a merged PR (description + issue comment + unresolved inline thread) and a closed PR with a comment → 2 PRs, kinds `merged`/`closed`, the unresolved thread kept with `actedOn: false`, bot comments dropped.
  - `reviewDigest heads each PR with its kind`: block starts `=== PR #12 (closed without merging, 2026-10-01): `.
  - `a team-level finding with no file is kept`: `anchoredReviews` on a finding whose body names no file and `paths: []` returns it with `touches: []`.
  - `saved learning: headline title, why and In the code in the body`: after `finishReviewRead` with the fake claude, the note's title equals the fake's headline and its body contains `In the code:` and `_From PRs #41, #38 here`.
  - Update the existing tests that asserted acted-on-only or code-first titles.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: QUERY fetches `merged: pullRequests(states: MERGED, first: 40 …)` and `closed: pullRequests(states: CLOSED, first: 25 …)` with `body`, `comments(first: 30)`, `reviews(first: 20){body state}`, `reviewThreads(first: 30)`; drop the acted-on filter (mark it); add `Revert` commits from `git log -n 400 --grep=^Revert` and `CONTRIBUTING.md`, `docs/adr/*.md`, `docs/decisions/*.md` (≤ 6,000 chars each) as `=== doc <path>` / `=== reverts` sources; digest cap 120,000; the prompt starts `This repository's recent pull requests`; `anchoredReviews` requires `codeWords` only when touches exist; footer `_From PRs #… here, merged <date>._` (keep `FLAGGED` matching old footers and the new one).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `pr read: whole PR conversations, closed PRs, reverts and docs, on the shared bar`.

### Task 3: The session read

**Files:**
- Create: `src/learn/sessions.ts`
- Test: `test/learn-sessions.test.ts`

**Interfaces:**
- Consumes: `discoverSessions`, `PastSession` (`src/init/sessions.ts`); `openPlain`/chunked read as in `src/init/transcript.ts`; Task 1's bar; `callClaude`, `claudeBin`, `COLD_START_MODEL`; `writeNote`, `noteAuthor`, `codeAnchors`, `knownText`, `alreadySaid`.
- Produces:
  - `sessionLines(path: string, stretch?: {from: number; to: number}): string[]` — lines `[person] …`, `[claude] …`, `[answered] <question> -> <answer>`, `[plan] …`, `[ran] <git commit | gh pr create command>`; reads in 1 MB chunks, skips lines > 2 MB, tool results, sidechains, meta rows, system reminders and continuation summaries.
  - `sessionsDigest(sessions: PastSession[], maxChars = 100_000): { text: string; sources: QuoteSource[]; read: string[] }` — newest first, header `=== session <id8> (<YYYY-MM-DD>[, branch <b>])`, scrubbed.
  - `findSessionLearnings(repo: string, opts?: { capMs?: number; env?: NodeJS.ProcessEnv }): Promise<SessionResult>` where `SessionResult = { sessions: number; read: number; findings: Learning[]; durationMs: number; costUsd?: number; reason?: "no_sessions" | "no_claude" | "failed" | "none_found"; why?: ClaudeFailure }`.
  - `beginSessionRead(repo, env, capMs?): SessionRead | null` (null when marked read in `session-learnings.json` under the repo home, or `TRAIL_NO_FETCH=1`), `finishSessionRead(repo, read, keep?) → { result, saved: Note[], cancelled }`, mirroring the review pair; saved with `src: "init-sessions"`, footer `_From past Claude sessions here, <date>._`.

- [ ] **Step 1: Failing tests:**
  - `sessionLines reads both sides and skips tool output`: fixture jsonl with a typed message, an assistant text, an `AskUserQuestion` tool_use + its tool_result, a Bash `git commit -m "x"` tool_use, a tool_result of 10 KB, a `<system-reminder>` user row → lines exactly `[person] …`, `[claude] …`, `[answered] Which one? -> Second`, `[ran] git commit -m "x"`; no tool output text.
  - `sessionLines reads only the stretch`: same file, stretch covering only the second half → first-half lines absent.
  - `sessionsDigest stops at maxChars and scrubs`: a typed line holding `ghp_` + 36 chars → absent from `text`; `text.length ≤ maxChars`.
  - `a big transcript is read in chunks`: a 30 MB fixture written in a temp dir; `sessionLines` returns and process RSS grows < 100 MB.
  - `finishSessionRead saves the fake claude's learning with a plain title`: fake `claude` keyed on prompt prefix `Past Claude Code sessions in this repository` → one note, title the headline, `src` `init-sessions`; second `beginSessionRead` → null.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `learn: read past sessions, both sides, for decisions`.

### Task 4: Init runs both reads and shows each as it lands

**Files:**
- Modify: `src/init/run.ts` (`LookBackReads` gains `sessions: SessionRead | null`; `beginLookBack`, `finishLookBack`, `keepTeam`, `reviewItems` + new `sessionItems`)
- Modify: `src/init/types.ts` (InitItem kind adds `"session"`), `src/init/review-screen.ts` (row label "from your past sessions"), `src/cli.ts` (pair phase `decisions` done with `${n} learnings`)
- Test: `test/init-learning-reads.test.ts`

**Interfaces:**
- Consumes: Task 2 (`beginReviewRead`, `finishReviewRead`, `anchoredReviews`), Task 3 (`beginSessionRead`, `finishSessionRead`).
- Produces: init output lines, as each read resolves: `· from your past sessions: <n> learnings, e.g. "<headline>"` and `· from <repo>'s PRs: <n> learnings, e.g. "<headline>"`.

- [ ] **Step 1: Failing tests** (init spawned like `initRun` in `test/trail-pr-reviews.test.ts`, fake `claude` + `gh`, a fixture session under the scratch HOME's `.claude/projects`):
  - `init saves learnings from both reads, headline titles`: two notes in `.trail/learnings/`, one `init-sessions`, one `init-review`.
  - `each read's line prints when it lands`: stdout has both `· from your past sessions: 1 learning` and `· from` … `PRs: 1 learning` before the closing `✓ learnings` line.
  - `an agent's init without --pair starts no claude`: `CLAUDECODE=1`, no `--pair` → fake claude log empty.
  - `init again reads nothing new`: second run → fake claude not called.
  - `the same learning from both reads is shown once`: fake answers with near-identical headlines from sessions and PRs → one note saved (the PR one, which has the PR footer).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: start `beginSessionRead` next to `beginReviewRead` under the same condition (`model || pair`, cap `AGENT_CAP_MS` for an agent); in `finishLookBack`, attach `.then` on both promises that `say` the line immediately; team rows = review rows + session rows; `keepTeam` finishes both.
- [ ] **Step 4:** Run → PASS, then the whole suite with a scratch HOME → only the two known machine-only failures.
- [ ] **Step 5:** Commit `init: read sessions and PRs together, each shown as it lands`.

### Task 5: In-session saves use the same headline rule

**Files:**
- Modify: the copy that tells the agent to `trail note --title "<the fact, not the task>"` (find with `grep -rn "the fact, not the task" src`), and its tests.

- [ ] **Step 1:** Update the test asserting that copy to expect: `trail note --title "<the decision in plain words a teammate understands, no file names>"` plus the sentence `Put files, commands and values in the body under "In the code:".`
- [ ] **Step 2:** Run → FAIL. **Step 3:** Change the copy. **Step 4:** Run → PASS. **Step 5:** Commit `save guidance: plain headline, files in the body`.

### Task 6: Real-run check

- [ ] **Step 1:** `npm run build`; in the sandbox (`scratchpad/realrun/speed-home`, fresh `hono-speed` clone) run the built CLI's `trail init` inside `script -q /dev/null` with `-y --look-back`; time it.
- [ ] **Step 2:** Same on a copy of trail-cloud with the real `~/.claude/projects` sessions readable (HOME's projects symlinked read-only).
- [ ] **Step 3:** Record in the PR: wall time, time to first learning line, cost per read, learnings found (old vs new), all titles.
- [ ] **Step 4:** `trail check`, open the PR against `main`.

*Install size is a separate PR after this one (spec, "Install size").*
