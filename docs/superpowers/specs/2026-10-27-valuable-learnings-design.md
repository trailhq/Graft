# Learnings people value, on day one

Date: 2026-10-27. Asked by Shrish: make setup faster, and make learnings feel valuable: written so a person understands them, about what the team decided, not about one function.

## What we measured (before)

A fresh laptop setting up honojs/hono with `@trailhq/trail-code` 0.26.0:

| Step | Time | Result |
|---|---|---|
| `npm install -g` (cold cache) | 13 s | 334 MB on disk; `tree-sitter-wasm` alone is 117 MB |
| `trail init` | 8 s | code map built, **0 learnings** (no past sessions on this laptop) |
| PR-review read | 11 s | 50 merged PRs, only 2 with an "acted-on inline thread", **1 learning**: "hono-base.ts: extend notFound() for routable handlers, no onNotFound()" |

Why so little:
1. Setup reads past sessions **with no model** (D87/R60 removed the model read). It only finds jobs repeated on 2+ days and typed preferences, so decisions never come out of sessions.
2. The PR read accepts only inline review threads the author acted on, and its prompt asks for findings that "start with the code it's about". Most repos rarely have those threads, and what it finds reads like a code comment.
3. One title serves two readers. The agent wants files; the person wants the decision. The title went to the agent.

## The trial (after)

Same model, new bar and wider sources, scratch scripts (not product code):

| Source | Read | Time | Cost | Learnings |
|---|---|---|---|---|
| 6 past sessions in trail-cloud, both sides of the conversation | 82k chars | 21 s | $0.23 | 8, e.g. "Sign-up comes first in onboarding, before any other screen", "Failed prod decks were not a load balancer timeout; the proxy refused every call" (ruled out) |
| hono: 40 merged PRs + 25 closed PRs + reverts, whole discussion | 106k chars | 21 s | $0.29 | 8, e.g. "Breaking behavior changes wait for v5 rather than shipping in patch releases", "New adapters go in separate v5 packages, not the core hono package" |

Every learning cited quotes that exist in the source. A few hono headlines were still too technical ("RegExpRouter wildcard needs dotAll"), so the headline rule gets one more check (below).

## Decided

### 1. Two layers in every learning
- **Title = the headline**: 6 to 14 plain words a teammate understands with no context, a decision and its reason when it fits. No file or function names, no em dashes. This is what people see everywhere (setup screen, onboarding page, dashboard, `trail ask`) and what the agent reads first.
- **Body**, under the existing `## Decided` / `## Tried and ruled out` / `## Watch out`: the why in one or two plain sentences, then a line starting `In the code:` with the exact files, commands, APIs or values, for the agent. Files also go in `touches`, so the file-open hook still fires.
- Existing learnings are not rewritten.

My call (the person was asked, didn't pick): the headline is the title for the agent too; the precision lives in the body.

### 2. One bar, in one place
`src/learn/bar.ts` holds the bar and is used by every reader and by the in-session save guidance:
> Something this team decided, ruled out, or got burned by, that changes what the next person or agent does here, and that they couldn't tell from reading the code. At the level of a decision a teammate would nod at.

with the too-small and too-generic examples from the trial. The Stop-hook text that asks the agent to `trail note` gets the same headline rule (plain words, files in the body).

### 3. Read what every repo has, in parallel
Three reads start together with the code map:
- **Past sessions, both sides.** What the person said, Claude's replies, questions the person answered, plans, commit and PR messages. Tool output is never read. Newest first, up to ~150k chars. This brings back a model read of sessions (reverses R60/D87), with its safeguards: the person's own Claude Code, headless, secrets scrubbed before sending, quotes checked against the digest, nothing kept that can't be found.
- **PRs.** Last 40 merged and 25 closed-without-merging PRs: description, comments, reviews, inline threads, plus `Revert` commits. One `gh` GraphQL call (3.8 s on hono). Replaces the acted-on-threads-only read.
- **Docs.** CONTRIBUTING, docs/adr or docs/decisions, AGENTS.md / CLAUDE.md that aren't Trail's own: appended to the PR read, as their own `=== doc` sources.

A merge step with no model drops near-duplicates across sources (same kind, high word overlap in headline) and keeps the best 8: ruled_out and watch_out with two or more quotes first.

### Privacy and cost (Shrish, 2026-10-27)
"As long as things get processed on the person's local plan at a cheap cost and session chats stay local, I'm fine by it. Learnings are what we want eventually, and that's what the user shares with the team, not the sessions."
- Every model call goes through the person's own `claude` (their plan), from their machine. No session text is sent to Trail's servers, ever; only kept learnings sync.
- Model: `claude-sonnet-5-5`. Tried `claude-haiku-5-5` on the same inputs: slightly plainer headlines but slower (30 to 41 s vs 21 to 25 s) and more expensive as reported by Claude Code ($0.46 to $0.62 vs $0.23 to $0.29).
- Cheap comes from sending less: Claude's replies clipped to 400 chars, typed messages to 1,000, sessions capped at 100k chars and PRs at 120k. Target under $0.30 per setup, measured.

### 4. Show each read as it lands
Each read's learnings print (and go to the onboarding page on `--pair`) the moment that read finishes, not after all of them. Target: first learnings in about 20 s, all in about 25 s, measured on the same repos.

### 5. Who runs the reads
Both reads run for the person at their terminal and for `--pair` (the onboarding page's prompt, run by an agent), capped at 100 s for an agent so the tool call ends in time. `--plain` and `TRAIL_LOOK_BACK=off` still turn them off.

## Install size (separate PR)
Find why `openai` (33 MB) and the 117 MB `tree-sitter-wasm` ship, and fetch rarely used grammars on first use instead of at install. Measured on a throttled connection before and after.

## Not now
- Rewriting the skills look-back (repeated jobs) or how skills are offered.
- Rewriting existing learnings into the new shape.
- A model call for the merge step.

## Watch out
- Cost runs on the person's own Claude plan; say it once on the screen ("reads with your Claude Code, on this laptop").
- Sessions started in a parent folder count only for their in-repo stretch (discovery already does this).
- Quote checks must run on the scrubbed digest the model saw, or valid quotes fail.

## How we'll know it worked
Run old and new on hono, trail-cloud, Trail-Code and one more public repo. For each learning, Shrish marks: valuable / too small / too generic / wrong. New must beat old on "valuable" count and on time to first learning.
