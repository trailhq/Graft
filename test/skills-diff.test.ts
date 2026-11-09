/**
 * The line diff, the size gate and the printed diff (phase 2 design 1.1,
 * 4.3): pure, bounded, and the one printer phase 3 prints a new file through
 * (`printDiff` with an empty first text). Synthetic skills only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOLD_MAX_CHARS, FOLD_MAX_SHARE, lineDiff, printDiff, runLinesChanged, sizeGate } from "../src/skills/skill-diff.js";
import { renderSkillMd } from "../src/skills/skillmd.js";
import { releaseSkill } from "./skills-recall-fixtures.js";
import type { CompiledSkill } from "../src/skills/types.js";

const lines = (...l: string[]) => `${l.join("\n")}\n`;

test("lineDiff: an equal text has no hunks", () => {
  const d = lineDiff(lines("a", "b"), lines("a", "b"));
  assert.deepEqual(d, { removed: [], added: [], hunks: [] });
});

test("lineDiff: one changed line is one hunk with its place in the first text", () => {
  const d = lineDiff(lines("a", "b", "c"), lines("a", "B", "c"));
  assert.deepEqual(d.removed, ["b"]);
  assert.deepEqual(d.added, ["B"]);
  assert.deepEqual(d.hunks, [{ at: 1, del: ["b"], add: ["B"] }]);
});

test("lineDiff: an insertion and a removal apart are two hunks, in order", () => {
  const d = lineDiff(lines("a", "b", "c", "d", "e"), lines("a", "x", "b", "c", "e"));
  assert.deepEqual(d.hunks, [{ at: 1, del: [], add: ["x"] }, { at: 3, del: ["d"], add: [] }]);
});

test("lineDiff: an empty first text adds every line", () => {
  const d = lineDiff("", lines("a", "b"));
  assert.deepEqual(d.hunks, [{ at: 0, del: [], add: ["a", "b"] }]);
});

test("lineDiff: a text over 64 KB is not read line by line: it is all removed and all added", () => {
  const big = lines(...Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(20)}`));
  assert.ok(big.length > 64 * 1024);
  const d = lineDiff(big, big.replace("line 1500 ", "line 1500! "));
  assert.equal(d.removed.length, 3000);
  assert.equal(d.added.length, 3000);
  assert.equal(d.hunks.length, 1);
});

test("lineDiff: two 60 KB texts with one change apart diff fast", () => {
  const body = Array.from({ length: 2000 }, (_, i) => `step ${i} ${"y".repeat(20)}`);
  const a = lines(...body);
  const b = lines(...body.slice(0, 1000), "changed", ...body.slice(1001));
  const t = Date.now();
  const d = lineDiff(a, b);
  assert.ok(Date.now() - t < 1000);
  assert.deepEqual(d.hunks, [{ at: 1000, del: [body[1000]], add: ["changed"] }]);
});

test("sizeGate: the limits are the spec's", () => {
  assert.equal(FOLD_MAX_CHARS, 800);
  assert.equal(FOLD_MAX_SHARE, 0.4);
});

test("sizeGate: removed and added lines count, line breaks counted", () => {
  const before = lines("a".repeat(40), "bb", "cc");
  const g = sizeGate(before, lines("a".repeat(40), "bbb", "cc"));
  // "bb\n" removed (3) and "bbb\n" added (4).
  assert.equal(g.chars, 7);
  assert.equal(g.share, 7 / before.length);
  assert.equal(g.ok, true);
});

test("sizeGate: 800 changed characters pass, 801 are refused", () => {
  const pad = "z".repeat(4000);
  const before = lines(pad, "x".repeat(399));
  // 400 removed ("x"*399 + break) and 400 added: exactly 800.
  assert.deepEqual(sizeGate(before, lines(pad, "y".repeat(399))), { chars: 800, share: 800 / before.length, ok: true });
  const g = sizeGate(before, lines(pad, "y".repeat(400)));
  assert.equal(g.chars, 801);
  assert.equal(g.ok, false);
});

test("sizeGate: a 40% share passes, 40.1% is refused", () => {
  const before = "a".repeat(999) + "\n"; // 1,000 characters
  assert.equal(sizeGate(before, lines("a".repeat(999), "b".repeat(399))).ok, true); // 400 added: 40%
  const g = sizeGate(before, lines("a".repeat(999), "b".repeat(400))); // 401 added: 40.1%
  assert.equal(g.share, 0.401);
  assert.equal(g.ok, false);
});

/** The 1b release fixture with one step put in after step `at`, its later steps renumbered (D131). */
function inserted(at: number): { a: string; b: string; step: string } {
  const base = releaseSkill();
  const step = "node scripts/stamp-cli.mjs {version}";
  const next: CompiledSkill = {
    ...base,
    meta: { ...base.meta, version: "2" },
    steps: [...base.steps.slice(0, at), { n: at + 1, cmd: step, gated: null, bg: false, wait: false }, ...base.steps.slice(at).map((s) => ({ ...s, n: s.n + 1 }))],
    ifFails: base.ifFails.map((l) => l.replace(/what worked was step (\d+)\./, (_m, n: string) => `what worked was step ${Number(n) > at ? Number(n) + 1 : n}.`)),
  };
  return { a: renderSkillMd(base), b: renderSkillMd(next), step: `${at + 1}. \`${step}\`` };
}

test("sizeGate (D131): one inserted step anywhere costs its own line and the version lines, never the renumbered steps", () => {
  for (let at = 0; at <= 6; at++) {
    const { a, b, step } = inserted(at);
    assert.equal(a.length, 1340);
    const g = sizeGate(a, b);
    const want = ['  version: "1"', '  version: "2"', step].reduce((n, l) => n + l.length + 1, 0);
    assert.equal(g.chars, want, `after step ${at}`);
    assert.equal(g.ok, true, `after step ${at}`);
  }
});

test("sizeGate (D131): the check line's Step N and an If it fails line's step N are numbers too", () => {
  const a = lines("## Run", "1. `npm ci`", "2. `npm test`", "", "## Check it worked", "Step 2, `npm test`, is the check.", "", "## If it fails", "- `npm` said \"x\": what worked was step 2.", "x".repeat(200));
  const b = lines("## Run", "1. `npm ci`", "2. `npm run lint`", "3. `npm test`", "", "## Check it worked", "Step 3, `npm test`, is the check.", "", "## If it fails", "- `npm` said \"x\": what worked was step 3.", "x".repeat(200));
  assert.equal(sizeGate(a, b).chars, "#. `npm run lint`".length + 1);
});

test("sizeGate (D131): a real content change of 41% is still refused, and a changed step still counts in full", () => {
  const keep = "k".repeat(1520);
  const before = lines("## Run", "1. `" + "a".repeat(390) + "`", keep);
  const after = lines("## Run", "1. `" + "b".repeat(390) + "`", keep);
  const g = sizeGate(before, after);
  assert.equal(g.chars, 2 * ("#. `".length + 390 + 2));
  assert.ok(g.chars <= 800, "under the character limit: the share alone refuses it");
  assert.ok(g.share > 0.41 && g.share < 0.42, String(g.share));
  assert.equal(g.ok, false);
});

test("printDiff: equal texts print nothing", () => {
  assert.equal(printDiff(lines("a"), lines("a"), ["old", "new"]), "");
});

test("printDiff: a unified diff with its labels, a hunk header and context lines", () => {
  const out = printDiff(lines("a", "b", "c", "d", "e", "f", "g", "h"), lines("a", "b", "c", "d", "E", "f", "g", "h"), ["release-npm v1", "release-npm v2"]);
  assert.equal(out, [
    "--- release-npm v1",
    "+++ release-npm v2",
    "@@ -2,7 +2,7 @@",
    " b", " c", " d", "-e", "+E", " f", " g", " h",
  ].join("\n"));
});

test("printDiff: an empty first text prints a new file (phase 3 prints through it)", () => {
  const out = printDiff("", lines("---", "name: x", "---"), ["/dev/null", ".agents/skills/x/SKILL.md"]);
  assert.equal(out, ["--- /dev/null", "+++ .agents/skills/x/SKILL.md", "@@ -0,0 +1,3 @@", "+---", "+name: x", "+---"].join("\n"));
});

test("printDiff: at most 40 lines by default, the rest counted on the last line", () => {
  const out = printDiff("", lines(...Array.from({ length: 100 }, (_, i) => `l${i}`)), ["a", "b"]);
  const got = out.split("\n");
  assert.equal(got.length, 40);
  assert.equal(got[39], "… 64 more lines");
  assert.equal(printDiff("", lines("a", "b", "c", "d"), ["a", "b"], 4).split("\n").at(-1), "… 4 more lines");
});

test("printDiff: step text is printed as it is, backticks and all", () => {
  const out = printDiff(lines("1. `npm pack`"), lines("1. `` npm pack --json | jq '.[0]' ``"), ["a", "b"]);
  assert.ok(out.includes("+1. `` npm pack --json | jq '.[0]' ``"));
});

test("runLinesChanged: a changed step is 1 line; an added step is 1 even though the steps after it renumber", () => {
  const base = releaseSkill();
  const changed = { ...base, steps: base.steps.map((s) => (s.n === 4 ? { ...s, cmd: "node scripts/pack-cli.mjs --all" } : s)) };
  assert.equal(runLinesChanged(base, changed), 1);
  const added = { ...base, steps: [...base.steps.slice(0, 4), { n: 5, cmd: "git push origin v{version}", gated: null, bg: false, wait: false }, ...base.steps.slice(4).map((s) => ({ ...s, n: s.n + 1 }))] };
  assert.equal(runLinesChanged(base, added), 1);
  const two = { ...base, steps: [...base.steps, { n: 7, cmd: "git push origin main", gated: null, bg: false, wait: false }, { n: 8, cmd: "git push origin v{version}", gated: null, bg: false, wait: false }] };
  assert.equal(runLinesChanged(base, two), 2);
  assert.equal(runLinesChanged(base, base), 0);
});

test("runLinesChanged: a step that only gains its can't-be-undone mark is a changed line", () => {
  const base = releaseSkill();
  const marked = { ...base, steps: base.steps.map((s) => (s.n === 1 ? { ...s, gated: "deploy" as const } : s)) };
  assert.equal(runLinesChanged(base, marked), 1);
});

test("review: printDiff never passes a control character through: ESC, NUL, CR, DEL and bidi marks are printed as escapes", () => {
  const out = printDiff(lines("a"), lines("a", "x\u001b]52;c;Zm9v\u0007y", "n\u0000ul\r", "r‮gnp.exe", "d\u007f"), ["a", "b"]);
  assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/.test(out), false, JSON.stringify(out));
  assert.ok(out.includes("+x\\u001b]52;c;Zm9v\\u0007y"), out);
  assert.ok(out.includes("+n\\u0000ul\\r"), out);
  assert.ok(out.includes("+r\\u202egnp.exe"), out);
});

test("review: printDiff is bounded in bytes too: a 2 MB line (a binary file, a minified blob) is cut, not printed whole", () => {
  const out = printDiff("", "x".repeat(2_000_000), ["/dev/null", "b"]);
  assert.ok(out.length < 64 * 1024, String(out.length));
  assert.ok(out.split("\n")[3]!.endsWith("…"));
});
