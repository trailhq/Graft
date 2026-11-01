/**
 * The one bar every learning read uses: what a learning's file looks like,
 * which quotes count, and how a headline is kept plain.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { learningBody, plainHeadline, sameLearning, verifyLearnings, type Learning } from "../src/learn/bar.js";
import { norm } from "../src/init/look-back.js";

const base: Learning = {
  headline: "Failed decks were not timeouts: the AI proxy refused every call",
  why: "Prod logs showed the proxy refused it.",
  forAgent: "internal/llm/llm.go sends user and tags.",
  kind: "ruled_out",
  sources: ["s1"],
  quotes: [],
  last: "2026-10-26",
};

test("learningBody puts a ruled_out learning under Tried and ruled out", () => {
  assert.equal(
    learningBody(base, "_From past Claude sessions here._"),
    "## Tried and ruled out\n- Prod logs showed the proxy refused it.\n- In the code: internal/llm/llm.go sends user and tags.\n\n_From past Claude sessions here._",
  );
  assert.match(learningBody({ ...base, kind: "decided" }, "x"), /^## Decided\n/);
  assert.match(learningBody({ ...base, kind: "watch_out" }, "x"), /^## Watch out\n/);
});

test("learningBody leaves out an empty In the code line", () => {
  assert.equal(learningBody({ ...base, kind: "decided", forAgent: "  " }, "x"), "## Decided\n- Prod logs showed the proxy refused it.\n\nx");
});

test("verifyLearnings drops a learning whose quote isn't in its source", () => {
  const sources = [{ id: "s1", at: "2026-10-20T00:00:00Z", said: [norm("also remember signup should be done as the first thing not after any screen")] }];
  const raw = [
    { headline: "Sign-up comes first", why: "w", for_agent: "a", kind: "decided", evidence: [{ source: "session s1", quote: "signup should be done as the first thing" }] },
    { headline: "Invented", why: "w", for_agent: "a", kind: "decided", evidence: [{ source: "s1", quote: "nobody ever typed these words at all" }] },
  ];
  const out = verifyLearnings(raw, sources);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.headline, "Sign-up comes first");
  assert.deepEqual(out[0]!.sources, ["s1"]);
  assert.equal(out[0]!.last, "2026-10-20");
});

test("verifyLearnings keeps eight at most and drops an unknown kind", () => {
  const sources = [{ id: "p1", at: "2026-10-20T00:00:00Z", said: [norm("we must not add platform specific code here")] }];
  const one = (i: number, kind = "decided") => ({ headline: `h${i}`, why: "w", for_agent: "", kind, evidence: [{ source: "p1", quote: "must not add platform specific code" }] });
  assert.equal(verifyLearnings([...Array(12).keys()].map((i) => one(i)), sources).length, 8);
  assert.equal(verifyLearnings([one(1, "praise")], sources).length, 0);
});

test("plainHeadline removes em dashes and keeps one line", () => {
  assert.equal(plainHeadline("Sign-up first — always"), "Sign-up first, always");
  assert.equal(plainHeadline("Two\nlines – here"), "Two lines, here");
  assert.ok(plainHeadline("x".repeat(300)).length <= 100);
});

test("sameLearning matches a reworded headline", () => {
  assert.equal(sameLearning("Sign-up comes first, before any onboarding screen", "Sign-up always comes first before onboarding"), true);
  assert.equal(sameLearning("Sign-up comes first, before any onboarding screen", "Every AI call must name a user and tags"), false);
});

test("a long headline ends at its last clause break, or at a whole word, never mid-word", () => {
  assert.equal(
    plainHeadline("Custom path function is not allowed with non-strict trailing-slash mode; blocked in types, not fixed at runtime"),
    "Custom path function is not allowed with non-strict trailing-slash mode",
  );
  assert.equal(
    plainHeadline("Error and not-found handling now uses normal middleware routing in v5, replacing the old two-argument form entirely"),
    "Error and not-found handling now uses normal middleware routing in v5",
  );
  const words = plainHeadline("word ".repeat(40));
  assert.ok(words.length <= 100 && /^(word )+word…$/.test(words), words);
  assert.equal(plainHeadline("Adapters move out of core into separate packages in v5, so new runtime adapters ship standalone"), "Adapters move out of core into separate packages in v5, so new runtime adapters ship standalone");
});

test("sameLearning also matches two learnings whose bodies name the same code, in other words", () => {
  const pr = { title: "Don't reuse one CSS class name across unrelated pages; it caused overlap and cut-off bugs", body: "## Watch out\n- In the code: Renamed: sign-in picture cards `note` → `bnote`; chat bubble `me` → `.dc-msg.you` (the account button styles `me` as a 32px row)." };
  const past = { title: "Reuse of a short global style name cut off chat messages", body: "## Watch out\n- In the code: `.me` in web/src/styles/app.css is the account button. The chat bubble is `.dc-msg.you` in journey.css." };
  assert.equal(sameLearning(pr.title, past.title), false, "the headlines alone don't say it");
  assert.equal(sameLearning(pr.title, past.title, pr.body, past.body), true);
  assert.equal(
    sameLearning("Keep one home page for every team", "The first page offers only two jobs", "- In the code: `web/src/app/home/page.tsx` and `me`.", "- In the code: `web/src/app/start/page.tsx` and `me`."),
    false,
    "one short shared name is not enough",
  );
});

test("sameLearning keeps apart learnings that mean the opposite, are about other things, or are another kind", () => {
  assert.equal(sameLearning("Use pnpm, never npm, in this repo", "Never use yarn in this repo"), false);
  assert.equal(sameLearning("Sign-up must be the first onboarding screen", "Onboarding screen must not ask for sign-up"), false, "one says not");
  assert.equal(sameLearning("Deploys go through staging before production", "Database migrations go through staging before production"), false);
  const code = "- In the code: `src/net/client.ts` wraps calls in `withRetry`.";
  assert.equal(sameLearning("Network calls retry four times", "Retries were dropped for payments", `## Decided\n${code}`, `## Tried and ruled out\n${code}`), false, "another kind");
  assert.equal(sameLearning("Network calls retry four times", "Payments never call the client twice", `## Decided\n${code}`, `## Decided\n${code}`), false, "nothing in common but the code");
  assert.equal(sameLearning("Sign-up comes first, before any onboarding screen", "Sign-up always comes first before onboarding"), true);
});
