/**
 * The words of moments 5 and 6 and the retire proposal (phase 2 design 4.7
 * to 4.9, R11, R19, R24, D101, D107): their two lines, the Stop reason and
 * post-tool text around them, and the directives on each answer. Made-up
 * skills and repos only (release-npm, acme-cli).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answer2, blockReason2, driftLines, postTool2, retireLines, updateLines, DRIFT_COPY, RETIRE_COPY, UPDATE_COPY, type UpdateFacts,
} from "../src/skills/offer-words-2.js";
import { FROM_TRAIL } from "../src/skills/directive-words.js";
import type { PendingOffer } from "../src/trace/types.js";

const BANNED = /\b(?:notes?|rules?|memory|memories|remember\w*|workflows?)\b/i;
const CHECK = "Published 0.22.4: npm shows it.";
const ENV = { HOME: "/home/dev", TRAIL_HOME: "/home/dev/.trail-test" };

const lessonFold: UpdateFacts = {
  op: "extend", why: "lesson", check: CHECK, name: "release-npm", job: "release", at: 4, cmds: ["git push origin v0.22.4"], changes: 1,
  lessonDate: "2026-10-30", handEdited: false,
};

function offer(moment: "update" | "drift" | "retire", lines: [string, string], extra: Partial<PendingOffer> = {}): PendingOffer {
  return {
    offerId: "o-3c9e1d", moment, runId: "r-1112-7a2b", name: "release-npm", key: `s-7f3a2c|${moment === "retire" ? "retire" : `${moment}|v1`}`,
    lines, channel: "stop", shownAt: "2026-11-12T10:00:00.000Z", showMe: false, yes: null, typedAfter: [], repo: "github.com/acme/cli",
    ...(moment === "retire" ? { retire: { skillId: "s-7f3a2c", name: "release-npm" } } : {
      fold: { op: moment === "drift" ? "replace" : "extend", skillId: "s-7f3a2c", baseHash: "a".repeat(64), proposalSha: "b".repeat(16), handEdited: false, version: 1 },
      ...(moment === "drift" ? { retire: { skillId: "s-7f3a2c", name: "release-npm" } } : {}),
    }),
    ...extra,
  };
}

test("lesson extend: line 2 is the design's copy word for word, the date and step filled (Nov 12 story)", () => {
  const [a, b] = updateLines(lessonFold);
  assert.equal(b, "Fold your Oct 30 learning into release-npm as step 5? 1 line changes. (yes / show me / no)");
  assert.equal(a, "Published 0.22.4: npm shows it. This time release-npm also needed 'git push origin v0.22.4' after step 4.");
});

test("two-uses extend, update and split lines, and the hand-edited line 2", () => {
  assert.deepEqual(updateLines({ ...lessonFold, why: "two-uses", lessonDate: undefined, changes: 2, cmds: ["node scripts/pack-cli.mjs", "npm pack ./build/cli"], at: 2 }), [
    "Published 0.22.4: npm shows it. This time release-npm also needed 'node scripts/pack-cli.mjs' and 'npm pack ./build/cli' after step 2.",
    "Add them to release-npm as steps 3 and 4? They ran in your last 2 releases. 2 line changes. (yes / show me / no)",
  ]);
  assert.deepEqual(updateLines({ op: "update", why: "failed-then-worked", check: CHECK, name: "release-npm", job: "release", at: 3, cmds: ["git push --follow-tags origin main"], changes: 1, handEdited: false }), [
    "Published 0.22.4: npm shows it. This time step 3 of release-npm failed and 'git push --follow-tags origin main' worked instead.",
    "Change step 3 of release-npm to the command that worked? 1 line changes. (yes / show me / no)",
  ]);
  assert.deepEqual(updateLines({ op: "split", check: CHECK, name: "release-npm", job: "release", at: 0, cmds: [], changes: 0, split: { from: 1, to: 3, name: "build-cli" }, handEdited: false }), [
    "Published 0.22.4: npm shows it. This time release-npm ran only steps 1 to 3, as it did last time.",
    "Keep steps 1 to 3 as their own skill, build-cli, beside release-npm? (yes / show me / no)",
  ]);
  assert.equal(updateLines({ ...lessonFold, handEdited: true })[1],
    "Fold your Oct 30 learning into release-npm as step 5? You changed release-npm by hand, so Trail writes it beside your file for you to compare. (yes / show me / no)");
});

test("drift: J15's line 2 is the design's copy word for word; line 1 names what it skipped and what it ran, at most 2 each (P16, R24)", () => {
  const [a, b] = driftLines({ check: CHECK, name: "release-npm", job: "release", steps: 3, skipped: [{ n: 4, cmd: "npm publish --access public" }], ran: ["git push origin v0.22.4", "gh run watch"], handEdited: false });
  assert.equal(b, "Replace release-npm with the 3 steps that just worked, retire it, or leave it? (replace / retire / leave it)");
  assert.equal(a, "Published 0.22.4: npm shows it. release-npm needs a fix, and this release went another way: it skipped 'npm publish --access public' (step 4) and ran 'git push origin v0.22.4' and 'gh run watch'.");
  const many = driftLines({ check: CHECK, name: "release-npm", job: "release", steps: 4, skipped: [], ran: ["a one", "b two", "c three"], handEdited: true });
  assert.equal(many[0], "Published 0.22.4: npm shows it. release-npm needs a fix, and this release went another way: it ran 'a one' and 'b two'.");
  assert.equal(many[1], "Write the 4 steps that just worked beside your edited release-npm, retire it, or leave it? (replace / retire / leave it)");
  assert.match(driftLines({ check: CHECK, name: "release-npm", job: "release", steps: 2, skipped: [{ n: 2, cmd: "npm publish" }], ran: [], handEdited: false })[0], /went another way: it skipped 'npm publish' \(step 2\)\.$/);
});

test("retire lines", () => {
  assert.deepEqual(retireLines({ name: "release-npm", fired: 5, followed: 2 }), [
    "Trail brought in skill release-npm 5 times lately, and its steps ran in 2 of them.",
    "Retire it? trail skills restore release-npm brings it back. (retire / keep it)",
  ]);
});

test("a command in a line is one line, cut at 60 characters, in single quotes, with its own quotes made double (R24)", () => {
  const [a] = updateLines({ ...lessonFold, cmds: [`echo 'x'\nnpm publish ${"y".repeat(80)}`] });
  assert.ok(!a.includes("\n"));
  const quoted = /also needed '([^']*)' after/.exec(a)![1]!;
  assert.ok(quoted.length <= 60, quoted);
  assert.ok(quoted.startsWith('echo "x" npm publish'));
});

test("the Stop reason (R11): from Trail, Trail's own reason, the 2 lines, then each answer's command; never trail skills add or lesson for an update", () => {
  const l = updateLines(lessonFold);
  const r = blockReason2(offer("update", l), l);
  assert.ok(r.startsWith(`[trail] ${FROM_TRAIL} `));
  assert.ok(r.includes(`\n${l[0]}\n${l[1]}\n`));
  assert.ok(r.includes("trail skills update release-npm --offer o-3c9e1d"));
  assert.ok(r.includes("trail skills draft r-1112-7a2b --print"));
  assert.ok(!/skills (add|lesson)/.test(r));
  assert.ok(!/recite|word for word|don't ask|covers/i.test(r));
  const d = driftLines({ check: CHECK, name: "release-npm", job: "release", steps: 3, skipped: [], ran: ["gh run watch"], handEdited: false });
  const rd = blockReason2(offer("drift", d), d);
  assert.ok(rd.includes("If they answer replace, run: trail skills update release-npm --offer o-3c9e1d"));
  assert.ok(/retire/.test(rd) && /leave it/.test(rd));
  const t = retireLines({ name: "release-npm", fired: 5, followed: 1 });
  const rr = blockReason2(offer("retire", t), t);
  assert.ok(rr.includes(`\n${t[0]}\n${t[1]}\n`));
  assert.ok(!/trail skills (update|add|forget)/.test(rr), "the retire is Trail's own, on the person's answer");
  const split = offer("update", l, { name: "build-cli", fold: { op: "split", skillId: "s-7f3a2c", baseHash: "a".repeat(64), proposalSha: "c".repeat(16), handEdited: false, version: 1, splitName: "build-cli" } });
  assert.ok(blockReason2(split, l).includes("trail skills add build-cli --run r-1112-7a2b"));
  assert.ok(postTool2(offer("update", l), l).includes(`\n${l[0]}\n${l[1]}\n`));
});

test("answers (D107, R19): yes names the one command and says who checks; quotes the typed words; never what a yes covers", () => {
  const o = offer("update", updateLines(lessonFold));
  const yes = answer2("yes", o, { paused: false, firstNo: false }, ENV, "yes").context!;
  assert.equal(yes, `[trail] ${FROM_TRAIL} They typed "yes" to the change Trail showed for release-npm. Run: trail skills update release-npm --offer o-3c9e1d. Trail checks their answer in this session before it changes anything.`);
  const replace = answer2("yes", offer("drift", ["a", "b"]), { paused: false, firstNo: false }, ENV, "replace").context!;
  assert.ok(replace.includes('They typed "replace"') && replace.includes("Run: trail skills update release-npm --offer o-3c9e1d."));
  const show = answer2("show", o, { paused: false, firstNo: false }, ENV, "show me").context!;
  assert.ok(show.includes("trail skills draft r-1112-7a2b --print") && show.includes(o.lines![1]));
  const no = answer2("no", o, { paused: true, firstNo: false }, ENV, "no").context!;
  assert.ok(no.includes("2 weeks"));
  const retired = answer2("retire", offer("retire", ["a", "b"]), { paused: false, firstNo: false, retired: "release-npm" }, ENV, "retire it").context!;
  assert.ok(retired.includes('They typed "retire it". Trail retired release-npm. Tell them in one line, with how to bring it back: trail skills restore release-npm.'));
  const busy = answer2("retire", offer("retire", ["a", "b"]), { paused: false, firstNo: false, retired: null }, ENV, "retire").context!;
  assert.ok(busy.includes("Trail couldn't retire it just now: the person can run trail forget release-npm"));
  const other = answer2("other", o, { paused: false, firstNo: false }, ENV, "what?").context!;
  assert.ok(other.includes("dropped the offer"));
  for (const t of [yes, replace, show, no, retired, busy, other]) assert.ok(!/recite|covers|don't ask|skip/i.test(t), t);
});

test("words: every copy string passes the words rule, has no em dash, and every line 2 ends with its keys", () => {
  for (const [name, copy] of Object.entries({ UPDATE_COPY, DRIFT_COPY, RETIRE_COPY })) {
    for (const [k, v] of Object.entries(copy)) {
      assert.ok(!BANNED.test(v) && !v.includes("—"), `${name}.${k}: ${v}`);
      if (/^line2/.test(k)) assert.match(v, /\((yes \/ show me \/ no|replace \/ retire \/ leave it|retire \/ keep it)\)$/, `${name}.${k}`);
    }
  }
  const all = [updateLines(lessonFold), driftLines({ check: CHECK, name: "x", job: "release", steps: 2, skipped: [], ran: ["y"], handEdited: false }), retireLines({ name: "x", fired: 6, followed: 3 })];
  for (const pair of all) {
    assert.equal(pair.length, 2);
    for (const line of pair) assert.ok(!line.includes("\n") && !BANNED.test(line) && !line.includes("—"), line);
  }
});
