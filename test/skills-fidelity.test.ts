/**
 * Next-run fidelity (phase 2 design 4.1): what a run a skill's block drove
 * did against the skill's steps. Counts and 8-hex shas only; never changes a
 * use's outcome. Pure. Synthetic runs of a made-up acme-cli release.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extraKey, fidelityCounts, fidelityOf } from "../src/skills/fidelity.js";
import { creditRun } from "../src/skills/ledger.js";
import { parseSkillMd, renderSkillMd } from "../src/skills/skillmd.js";
import type { CompiledSkill } from "../src/skills/types.js";
import type { RunCall } from "../src/trace/types.js";
import { call, failed, injectionFor } from "./skills-fold-fixtures.js";
import { releaseSkill } from "./skills-recall-fixtures.js";

const V = { version: "0.22.4" };
// The fixture's step 4 runs `npm pack` after `&&`, which credit (first match) gives to step 3: a plain step 4 here.
const base = releaseSkill();
const release: CompiledSkill = { ...base, steps: base.steps.map((s) => (s.n === 4 ? { ...s, cmd: "node scripts/pack-cli.mjs" } : s)) };
const parsed = parseSkillMd(renderSkillMd(release), "release-npm")!;
const inj = injectionFor(release, V);
const late = (raw: string, o: Partial<RunCall> = {}) => call(raw, o);
const allSteps = () => inj.steps.map((s) => late(s));

/** A skill with a push in it, for "failed, then done another way". */
const PUSHY: CompiledSkill = {
  ...release,
  steps: [
    { n: 1, cmd: "npm run build", gated: null, bg: false, wait: false },
    { n: 2, cmd: "npm version {version} --no-git-tag-version", gated: null, bg: false, wait: false },
    { n: 3, cmd: "git push origin main", gated: null, bg: false, wait: false },
    { n: 4, cmd: "npm publish --access public", gated: "publish", bg: false, wait: false },
  ],
};
const pushyInj = injectionFor(PUSHY, V);

test("fidelity: a release that ran every step: ran 6, nothing else", () => {
  const f = fidelityOf(parsed, inj, allSteps());
  assert.deepEqual(f, { ran: [1, 2, 3, 4, 5, 6], missing: [], extra: [], changed: [] });
  assert.deepEqual(fidelityCounts(f), { ran: 6, missing: 0, extra: 0, changed: 0 });
});

test("fidelity: a run that skipped step 4: missing 1", () => {
  const calls = allSteps().filter((_, i) => i !== 3);
  const f = fidelityOf(parsed, inj, calls);
  assert.deepEqual(f.missing, [4]);
  assert.deepEqual(fidelityCounts(f), { ran: 5, missing: 1, extra: 0, changed: 0 });
});

test("fidelity: step 3 failed and a different git push passed: changed [3], and that push is not an extra", () => {
  const calls = [late("npm run build"), late("npm version 0.22.4 --no-git-tag-version"), failed("git push origin main"),
    late("git push git@github.com:acme/cli.git HEAD:main"), late("npm publish --access public")];
  const f = fidelityOf(PUSHY, pushyInj, calls);
  assert.deepEqual(f.changed, [{ step: 3, callIx: 3, id: calls[3]!.id }]);
  assert.deepEqual(f.extra, []);
  assert.deepEqual(f.ran, [1, 2, 4]);
  assert.deepEqual(f.missing, []);
});

test("fidelity: a failed step then another program is not a changed step", () => {
  const calls = [late("npm run build"), late("npm version 0.22.4 --no-git-tag-version"), failed("git push origin main"), late("gh repo sync acme/cli")];
  const f = fidelityOf(PUSHY, pushyInj, calls);
  assert.deepEqual(f.changed, []);
});

test("fidelity: an extra step after step 4: extra 1 with the right after and an 8-hex sha", () => {
  const calls = allSteps();
  const stamp = late("node scripts/stamp-cli.mjs 0.22.4");
  calls.splice(4, 0, stamp);
  const f = fidelityOf(parsed, inj, calls);
  assert.equal(f.extra.length, 1);
  assert.equal(f.extra[0]!.after, 4);
  assert.equal(f.extra[0]!.callIx, 4);
  assert.equal(f.extra[0]!.id, stamp.id);
  assert.match(f.extra[0]!.sha, /^[0-9a-f]{8}$/);
  assert.equal(f.extra[0]!.sha, extraKey(stamp, V));
  assert.deepEqual(fidelityCounts(f), { ran: 6, missing: 0, extra: 1, changed: 0 });
});

test("fidelity: an extra before step 1 has after 0", () => {
  const calls = [late("node scripts/stamp-cli.mjs 0.22.4"), ...allSteps()];
  assert.equal(fidelityOf(parsed, inj, calls).extra[0]!.after, 0);
});

test("extraKey: the same extra in two runs with two versions gives one sha; another command another", () => {
  const a = extraKey(call("node scripts/stamp-cli.mjs 0.22.4"), { version: "0.22.4" });
  const b = extraKey(call("node scripts/stamp-cli.mjs 0.22.5"), { version: "0.22.5" });
  assert.equal(a, b);
  assert.notEqual(a, extraKey(call("node scripts/stamp-cli.mjs --dry 0.22.5"), { version: "0.22.5" }));
  // Output filters and spacing don't change the key; repo and home paths are put back the same way.
  assert.equal(extraKey(call("node  scripts/stamp-cli.mjs 0.22.4 2>&1 | tail -3"), { version: "0.22.4" }), a);
  const where = { repoRoot: "/home/dev/src/cli", home: "/home/dev" };
  assert.equal(extraKey(call("node /home/dev/src/cli/scripts/stamp-cli.mjs 0.22.4"), { version: "0.22.4" }, where),
    extraKey(call("node /home/dev/work/cli/scripts/stamp-cli.mjs 0.22.5"), { version: "0.22.5" }, { repoRoot: "/home/dev/work/cli", home: "/home/dev" }));
});

test("fidelity: a look-only call, plumbing, a failed call and a call outside the checkout are never extra", () => {
  const calls = [...allSteps(), late("git log -1 --oneline", { kind: "look" }), late("cat package.json", { kind: "look" }),
    late("node scripts/stamp-cli.mjs 0.22.4", { cwd: null, key: null }), late("node scripts/stamp-cli.mjs 0.22.4", { key: "github.com/acme/other" }),
    failed("node scripts/stamp-cli.mjs 0.22.4")];
  const f = fidelityOf(parsed, inj, calls);
  assert.deepEqual(f.extra, []);
});

test("fidelity: the check is never an extra, and a step equal to the check is never missing", () => {
  const checked: CompiledSkill = { ...release, check: "node scripts/verify-cli.mjs {version}" };
  const calls = [...allSteps(), late("node scripts/verify-cli.mjs 0.22.4")];
  assert.equal(calls.at(-1)!.kind, "step");
  assert.deepEqual(fidelityOf(checked, injectionFor(checked, V), calls).extra, []);
  const tests: CompiledSkill = { ...release, steps: [{ n: 1, cmd: "npm ci", gated: null, bg: false, wait: false }, { n: 2, cmd: "npm test", gated: null, bg: false, wait: false }], check: "npm test", checkIsStep: true };
  const f = fidelityOf(tests, injectionFor(tests, {}), [late("npm ci")]);
  assert.deepEqual(f.missing, []);
});

test("fidelity: calls from before the block came in (less 5 s) don't count, as for credit", () => {
  const early = call("node scripts/stamp-cli.mjs 0.22.4");
  const at = new Date(Date.parse(early.at) + 60_000).toISOString();
  const after = allSteps().map((c) => ({ ...c, at: new Date(Date.parse(at) + 1000).toISOString() }));
  const f = fidelityOf(parsed, { ...inj, at }, [early, ...after]);
  assert.deepEqual(f.extra, []);
  assert.deepEqual(f.ran, [1, 2, 3, 4, 5, 6]);
});

test("fidelity: ran is creditRun's stepsRan, a failed try then a pass included and a pass then a failure not", () => {
  const cases: RunCall[][] = [
    allSteps(),
    [failed("npm run build"), late("npm run build"), late("npm pack")],
    [late("npm run build"), failed("npm run build"), late("npm pack")],
    [late("git pull --ff-only origin main"), late("node scripts/stamp-cli.mjs 0.22.4")],
  ];
  for (const calls of cases) assert.deepEqual(fidelityOf(parsed, inj, calls).ran, creditRun(inj, calls).stepsRan);
  const f = fidelityOf(parsed, inj, cases[2]!);
  assert.ok(!f.missing.includes(2), "a step that failed is not missing");
});

test("fidelity: never throws; a bad input gives every step missing", () => {
  const bad = fidelityOf(parsed, { params: V, steps: inj.steps }, [null as unknown as RunCall]);
  assert.deepEqual(bad, { ran: [], missing: [1, 2, 3, 4, 5, 6], extra: [], changed: [] });
  assert.deepEqual(fidelityOf(parsed, null as never, []).missing, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(fidelityOf(null as never, inj, []), { ran: [], missing: [], extra: [], changed: [] });
});

test("fidelity: steps come from the block's filled steps, or the skill's filled with its params when they disagree", () => {
  const f = fidelityOf(parsed, { params: V, steps: [] }, allSteps());
  assert.deepEqual(f.ran, [1, 2, 3, 4, 5, 6]);
});

test("review: a call whose result never came (no result line, no PostToolUse mark) never passed: never extra, never the change", () => {
  const open = (raw: string) => late(raw, { src: { use: 99_000, result: null } });
  const f = fidelityOf(parsed, inj, [...allSteps(), open("node scripts/stamp-cli.mjs 0.22.4")]);
  assert.deepEqual(f.extra, []);
  const g = fidelityOf(parseSkillMd(renderSkillMd(PUSHY), "release-npm")!, pushyInj,
    [late("npm run build"), late("npm version 0.22.4 --no-git-tag-version"), failed("git push origin main"), open("git push origin HEAD:main")]);
  assert.deepEqual(g.changed, []);
  // A PostToolUse mark that saw it pass counts, as for credit.
  const marked = late("node scripts/stamp-cli.mjs 0.22.4", { src: { use: 99_000, result: null }, fromMark: true } as Partial<RunCall>);
  assert.equal(fidelityOf(parsed, inj, [...allSteps(), marked]).extra.length, 1);
});
