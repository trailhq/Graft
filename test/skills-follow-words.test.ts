/**
 * The words rule for part 7 (learnings and skills said once): every line the
 * person or the agent reads about a learning and a skill says learnings,
 * skills, lessons, guardrails, preferences or decisions, never notes, rules,
 * memory, remember or workflows, and has no em dash. Checked by value (the
 * copy constants) and on the lines as they come out. A directive opens with
 * who it is from; a block's lines never open a `[trail]` line of their own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOLLOW_COPY, followAtSave, markLines, recallMarks, stepLearningOf, stepNote, whose, withFollowLine } from "../src/skills/follow-learnings.js";
import { INIT_COPY } from "../src/init/review-screen.js";
import { UPDATE_COPY, updateLines } from "../src/skills/offer-words-2.js";
import { stopBlockReason } from "../src/skills/offer-words.js";
import type { PendingOffer } from "../src/trace/types.js";

const BANNED = /\b(?:notes?|rules?|memory|memories|remember\w*|workflows?)\b/i;
const EM_DASH = /—/;
const clean = (t: string, what: string) => {
  assert.doesNotMatch(t, BANNED, `${what}: ${t}`);
  assert.doesNotMatch(t, EM_DASH, `${what}: ${t}`);
};

const L = (title: string, kind: "preference" | "decision" | "guardrail" | null = "preference", scope: "personal" | "repo" | "team" = "personal") =>
  stepLearningOf({ id: "l-1a2b3c4d", kind: kind ?? undefined, scope, title, body: title })!;

test("the copy, by value", () => {
  for (const [k, v] of Object.entries(FOLLOW_COPY)) clean(v, `FOLLOW_COPY.${k}`);
  for (const k of ["foldHint", "folded"]) clean(INIT_COPY[k]!, `INIT_COPY.${k}`);
  for (const k of ["line1Preference", "line2Preference"] as const) clean(UPDATE_COPY[k], `UPDATE_COPY.${k}`);
});

test("the lines as they come out, for each kind and owner", () => {
  const kinds = [L("use pnpm, not npm"), L("never run npx prisma db push", "decision", "repo"), L("don't use npx", "guardrail", "team"), L("always run make lint before git push", null, "repo"),
    L("don't edit _schema.py by hand, run scripts/gen_schema.py")];
  assert.deepEqual(kinds.map(whose), ["your learning", "this repo's learning", "your team's always-follow learning", "this repo's learning", "your learning"]);
  const steps = ["npm ci", "npx prisma db push", "python scripts/gen_schema.py", "git push origin main", "npm test"].map((cmd, k) => ({ n: k + 1, cmd, gated: null }));
  for (const l of kinds) {
    const marks = recallMarks(steps, [l]);
    for (const line of markLines(marks)) {
      clean(line, l.quote);
      assert.ok(!line.startsWith("[trail]"));
    }
    for (const s of steps) clean(stepNote(marks, s.n, s.cmd), l.quote);
    const f = followAtSave(steps.map((s) => ({ cmd: s.cmd, gated: false, isCheck: false })), [l]);
    clean(f.line, l.quote);
    clean(withFollowLine(["Tests pass.", "Keep the 3 that worked as a skill, just for you in this repo? (yes / show me / no)"], f.line || undefined)[0], l.quote);
  }
  const [a, b] = updateLines({ op: "update", why: "preference", follows: "your learning", steps: [1, 2, 3], check: "Tests pass (12 passed).", name: "run-tests", job: "tests", at: 1,
    cmds: ["pnpm install --frozen-lockfile", "pnpm run build", "pnpm test"], changes: 3, handEdited: false });
  assert.equal(a, "Tests pass (12 passed). This time steps 1, 2 and 3 of run-tests ran as 'pnpm install --frozen-lockfile', 'pnpm run build' and 1 more, the way your learning says.");
  assert.equal(b, "Change steps 1, 2 and 3 of run-tests to match? 3 line changes. (yes / show me / no)");
  clean(a, "update line 1");
  clean(b, "update line 2");
  assert.equal(updateLines({ op: "update", why: "preference", follows: "this repo's learning", check: "Tests pass.", name: "run-tests", job: "tests", at: 2, cmds: ["pnpm test"], changes: 1, handEdited: false })[0],
    "Tests pass. This time step 2 of run-tests ran as 'pnpm test', the way this repo's learning says.");
  // The update offer's reason, which the agent reads, opens with who it is from.
  const offer = {
    offerId: "o-1a2b3c", moment: "update", runId: "r-1022-b6c1", name: "run-tests", key: "s-21ce56|update|v1", lines: [a, b], channel: "stop",
    shownAt: "2026-10-22T12:00:41.000Z", showMe: false, yes: null, typedAfter: [], repo: "github.com/acme/shop",
    fold: { op: "update", skillId: "s-21ce56", baseHash: "sha256:x", proposalSha: "0123456789abcdef", handEdited: false, version: 1 },
  } as unknown as PendingOffer;
  const reason = stopBlockReason(offer);
  assert.match(reason, /^\[trail\] From Trail, the tool this person installed to keep commands that worked as skills\. /);
  assert.ok(reason.includes(a) && reason.includes(b));
  clean(reason, "the update offer's reason");
});
