/**
 * The answer words per moment (phase 2 design 4.10, D53): drift's replace,
 * retire and leave it; the retire proposal's retire and keep it; every other
 * moment is 1a's classifyAnswer. The whole message is read, so a pasted
 * block or a second request after the answer is no answer.
 */
import { after, test } from "node:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import assert from "node:assert/strict";
import { classifyFor } from "../src/skills/offer-answers.js";
import { classifyAnswer } from "../src/trace/typed.js";

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("drift: replace and plain yes words are yes; retire is retire; leave it and no words are no; show me is show", () => {
  for (const t of ["replace", "Replace it", "replace it please", "yes, replace it", "yes", "ok", "sure."]) assert.equal(classifyFor("drift", t, false), "yes", t);
  for (const t of ["retire", "retire it", "Retire it.", "yes, retire it"]) assert.equal(classifyFor("drift", t, false), "retire", t);
  for (const t of ["leave it", "Leave it alone", "leave it as is", "no", "nope", "not now"]) assert.equal(classifyFor("drift", t, false), "no", t);
  assert.equal(classifyFor("drift", "show me", false), "show");
  assert.equal(classifyFor("drift", "show me", true), "other");
});

test("drift: 1a's keep and save words are no answer to replace, retire or leave it", () => {
  for (const t of ["keep it", "save it", "keep them", "looks good, keep it"]) assert.equal(classifyFor("drift", t, false), "other", t);
});

test("retire: retire and plain yes words are retire; keep it and no words are no; show me is no answer", () => {
  for (const t of ["retire", "retire it", "yes", "yes, retire it", "Yes retire it!"]) assert.equal(classifyFor("retire", t, false), "retire", t);
  for (const t of ["keep it", "Keep it.", "no, keep it", "keep", "no", "nah"]) assert.equal(classifyFor("retire", t, false), "no", t);
  assert.equal(classifyFor("retire", "show me", false), "other");
  assert.equal(classifyFor("retire", "save it", false), "other");
});

test("the whole message (D53): a second request, a question or a pasted block after the answer is other", () => {
  assert.equal(classifyFor("retire", "retire it and also push", false), "other");
  assert.equal(classifyFor("drift", "retire it and push", false), "other");
  assert.equal(classifyFor("drift", "replace it and push", false), "other");
  assert.equal(classifyFor("retire", "retire?", false), "other");
  assert.equal(classifyFor("drift", "replace?", false), "other");
  assert.equal(classifyFor("drift", "yes\n```\nnpm publish --access public\n```", false), "other");
  assert.equal(classifyFor("retire", "yes\n```\nrm -rf build\n```", false), "other");
});

test("a no whose rest is about the offer is a no; a correction stays a correction (it withdraws the offer)", () => {
  assert.equal(classifyFor("retire", "no, retire it later", false), "no");
  assert.equal(classifyFor("drift", "no, leave it for now", false), "no");
  assert.equal(classifyFor("drift", "no, it didn't push the tag", false), "correction");
  assert.equal(classifyFor("retire", "no, it didn't push the tag", false), "correction");
});

test("every other moment is 1a's classifyAnswer, word for word", () => {
  for (const moment of ["repeated", "repaired", "correction", "update"] as const) {
    for (const t of ["yes", "keep it", "show me", "no", "retire", "replace", "leave it", "no, it didn't push the tag", "yes\n```x```"]) {
      for (const afterShow of [false, true]) assert.equal(classifyFor(moment, t, afterShow), classifyAnswer(t, afterShow), `${moment} ${t}`);
    }
  }
});

test("the fold's consent window classifies a typed line by the pending offer's moment: replace is drift's yes, retire is retire", async () => {
  const { ask, bash, session } = await import("./trace-run-fixtures.js");
  const { at } = await import("./trace-run-fixtures.js");
  const offer = (moment: "drift" | "retire" | "update", s: ReturnType<typeof session>) => ({
    offerId: "o-81c2aa", moment, runId: s.st.runs[0]!.id, name: "release-npm", key: `s-7f3a2c|${moment === "retire" ? "retire" : `${moment}|v1`}`,
    lines: ["a", "b"] as [string, string], channel: "stop" as const, shownAt: at(50), showMe: false, yes: null, typedAfter: [],
  });
  const answers = (moment: "drift" | "retire" | "update", lines: string[]) => {
    const s = session(`c3-${moment}`);
    dirs.push(dirname(s.path));
    s.fold([ask("release 1.4.3", 0), ...bash("npm publish --access public", "ok", { sec: 5 })]);
    s.st.pendingOffer = offer(moment, s);
    lines.forEach((t, i) => s.fold([ask(t, 60 + i * 10)]));
    return s.st.pendingOffer!.typedAfter.map((x) => x.answer);
  };
  assert.deepEqual(answers("drift", ["replace"]), ["yes"]);
  assert.deepEqual(answers("drift", ["show me", "replace"]), ["show", "yes"]);
  assert.deepEqual(answers("drift", ["retire"]), ["retire"]);
  assert.deepEqual(answers("retire", ["keep it"]), ["no"]);
  assert.deepEqual(answers("retire", ["retire it"]), ["retire"]);
  assert.deepEqual(answers("update", ["yes"]), ["yes"]);
});
