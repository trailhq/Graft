/**
 * Compile after the trace merge: a run a compaction cut is compiled whole
 * (its sheet joined with the parts before it, D59a), and a deploy status
 * read over MCP (D59b, `RunCall.tool`) is check evidence only: never a step,
 * never refused as a secret, and when it is the run's check the skill says
 * to check the deployment the same way.
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileRun, draftText, type CompileOpts, type CompileResult } from "../src/skills/compile.js";
import { parseSkillMd, renderSkillMd } from "../src/skills/skillmd.js";
import { skillProblems } from "../src/skills/validate.js";
import { callKind } from "../src/trace/checks.js";
import { joinCarriedSheet } from "../src/trace/runs.js";
import type { CheckHit, JobClass, RunCall, RunSheet } from "../src/trace/types.js";
import type { CompiledSkill } from "../src/skills/types.js";

const HOME = "/home/dev";
const ROOT = "/home/dev/src/storefront";
const KEY = "github.com/acme/storefront";
const GET = "mcp__vercel__get_deployment";
const LIST = "mcp__vercel__list_deployments";
const SHA = "4e1c9a2b7d3f5e6a8c0b1d2e3f4a5b6c7d8e9f01";

let seq = 0;
const stamp = () => new Date(Date.UTC(2026, 9, 27, 10, 31, 40) + ++seq * 20_000).toISOString();
function call(raw: string, o: Partial<RunCall> & { job?: JobClass | null } = {}): RunCall {
  const { job = null, ...rest } = o;
  const at = stamp();
  return { id: `toolu_c${String(seq).padStart(3, "0")}`, at, cmd: raw, key: KEY, cwd: "", bg: false, failed: false, isError: false, kind: callKind(raw, job), src: { use: seq * 1000, result: seq * 1000 + 400 }, ...rest };
}
/** A deploy status read over MCP, as the fold stores it (D59b): a look with no command and no folder. */
function tool(state: string, facts: CheckHit["facts"] = {}, name = GET, o: Partial<RunCall> = {}): RunCall {
  const at = stamp();
  return {
    id: `toolu_t${String(seq).padStart(3, "0")}`, at, cmd: null, tool: name, key: null, cwd: null, bg: false, failed: false, isError: false, kind: "look",
    src: { use: seq * 1000, result: seq * 1000 + 400 }, check: { family: "deploy", passed: state === "READY", facts: { state, ...facts } }, ...o,
  };
}
const passed = (family: CheckHit["family"], facts: CheckHit["facts"] = {}): CheckHit => ({ family, passed: true, facts });

function sheet(calls: RunCall[], o: Partial<RunSheet> = {}): RunSheet {
  return {
    v: 1, id: "r-1027-3f9a", session: "e76b4ca7f1a0", repoKey: KEY, branch: "main", host: "claude", tier: "A", epoch: 1,
    startedAt: "2026-10-27T10:31:40Z", endedAt: "2026-10-27T10:44:05Z", job: "ship", jobWords: ["push", "beta"], sharedWords: [], promptParams: {},
    calls, checkIndex: null, checked: false, end: "done",
    counts: { commands: calls.filter((c) => !c.tool).length, failed: calls.filter((c) => c.failed).length, toolCalls: calls.length, edits: 0 },
    helpers: [], skillId: null, ...o,
  };
}
const OPTS: CompileOpts = { repoRoot: ROOT, home: HOME, platform: "darwin", moment: "asked", applies: KEY, taken: () => false, readSheet: () => null };
const compile = (s: RunSheet, o: Partial<CompileOpts> = {}) => compileRun(s, { ...OPTS, ...o });
function ok(r: CompileResult): CompiledSkill {
  if (!r.ok) assert.fail(`refused ${r.reason}: ${r.detail}`);
  return r.skill;
}
const cmds = (c: CompiledSkill) => c.steps.map((s) => s.cmd);

// ---------------------------------------------------------------- a run a compaction cut

function cutJob() {
  const before = sheet([call("npm ci"), call("npm run build"), call("npm test", { check: passed("tests") })], {
    id: "r-1027-0001", epoch: 1, startedAt: "2026-10-27T10:31:40Z", endedAt: "2026-10-27T10:40:00Z", end: "open",
  });
  const after = sheet([call("npm run build"), call("git push origin HEAD:beta", { check: passed("push", { branch: "beta" }) })], {
    id: "r-1027-0002", epoch: 2, carriedFrom: "r-1027-0001", startedAt: "2026-10-27T10:41:00Z", endedAt: "2026-10-27T10:44:05Z",
    checkIndex: 1, checked: true, branch: "beta",
  });
  return { before, after, read: (id: string) => (id === before.id ? before : null) };
}

test("a carried sheet compiles with the steps from before the compaction, a step run again kept once", () => {
  const { after, read } = cutJob();
  const c = ok(compile(after, { readSheet: read }));
  assert.deepEqual(cmds(c), ["npm ci", "npm test", "npm run build", "git push origin HEAD:beta"]);
  assert.equal(c.checkIsStep, true, "the push is still the check");
  assert.equal(c.check, "git push origin HEAD:beta");
  assert.deepEqual(c.carried, { compactions: 1, startedAt: "2026-10-27T10:31:40Z", steps: [1, 2] });
  assert.equal(c.source.commands, 5, "commands of both parts");
  assert.deepEqual(skillProblems(renderSkillMd(c), c.name), []);
  // Compiling the sheet "save this" already joined (lastGoodRun) gives the same skill.
  assert.deepEqual(ok(compile(joinCarriedSheet(after, read), { readSheet: () => assert.fail("joined twice") })), c);
});

test("the draft says the job ran across a compaction and which steps ran before it, over the whole span", () => {
  const { after, read } = cutJob();
  const c = ok(compile(after, { readSheet: read }));
  const draft = draftText(c, after);
  assert.match(draft.split("\n")[0]!, /\(Oct 27, 10:31 to 10:44\)$/, draft);
  assert.ok(draft.split("\n").includes("  compaction  the job ran across a compaction: steps 1 and 2 ran before it, the rest after"), draft);
  const three = ok(compile(after, { readSheet: (id) => (id === "r-1027-0001" ? { ...read(id)!, carriedFrom: "r-1027-0000" } : id === "r-1027-0000"
    ? sheet([call("git fetch origin")], { id: "r-1027-0000", epoch: 0, startedAt: "2026-10-27T10:20:00Z", endedAt: "2026-10-27T10:30:00Z", end: "open" }) : null) }));
  assert.equal(three.carried?.compactions, 2);
  assert.ok(draftText(three, after).includes("  compaction  the job ran across 2 compactions: steps 1, 2 and 3 ran before the last one, the rest after"), draftText(three, after));
});

test("a part that is gone leaves the newest part to compile on its own, with nothing said about a compaction", () => {
  const { after } = cutJob();
  const c = ok(compile(after, { readSheet: () => null }));
  assert.deepEqual(cmds(c), ["npm run build", "git push origin HEAD:beta"]);
  assert.equal(c.carried, undefined);
  assert.ok(!draftText(c, after).includes("compaction"));
});

test("a carried prior run is joined too, so a step from before its compaction can still vary", () => {
  const now = sheet([call("node scripts/gen.mjs --pkg alpha"), call("git push origin HEAD:beta", { check: passed("push", { branch: "beta" }) })], { checkIndex: 1, checked: true });
  const priorBefore = sheet([call("node scripts/gen.mjs --pkg gamma")], { id: "r-1020-0001", epoch: 0, startedAt: "2026-10-20T09:00:00Z", endedAt: "2026-10-20T09:05:00Z", end: "open" });
  const prior = sheet([call("git push origin HEAD:beta", { check: passed("push", { branch: "beta" }) })], {
    id: "r-1020-0002", epoch: 1, carriedFrom: "r-1020-0001", startedAt: "2026-10-20T09:06:00Z", endedAt: "2026-10-20T09:07:00Z", checkIndex: 0, checked: true,
  });
  const c = ok(compile(now, { prior, readSheet: (id) => (id === priorBefore.id ? priorBefore : null) }));
  assert.deepEqual(cmds(c), ["node scripts/gen.mjs --pkg {pkg}", "git push origin HEAD:beta"]);
  assert.equal(ok(compile(now, { prior })).steps[0]!.cmd, "node scripts/gen.mjs --pkg alpha", "without the part before, nothing varied");
});

// ---------------------------------------------------------------- deploy status over MCP (D59b)

test("a READY deployment read over MCP is the check: never a step, never a secret, and the skill says to check it the same way", () => {
  const s = sheet([call("npm run build"), call("git push origin 4e1c9a2:refs/heads/beta"), tool("BUILDING", { sha: SHA, branch: "beta" }), tool("READY", { sha: SHA, branch: "beta" })], { checkIndex: 3, checked: true });
  for (const moment of ["asked", "repeated"] as const) {
    const c = ok(compile(s, { moment }));
    assert.deepEqual(cmds(c), ["npm run build", "git push origin {sha}:refs/heads/beta"], moment);
    assert.equal(c.check, "read the Vercel deployment for {sha} with get_deployment");
    assert.equal(c.checkShows, "READY");
    assert.equal(c.checkIsStep, false);
    assert.equal(c.meta["check-tool"], "get_deployment");
    assert.equal(c.leftOut.lookOnly, 0, "a tool read is not a command left out");
    const text = renderSkillMd(c);
    assert.deepEqual(skillProblems(text, c.name), []);
    assert.ok(text.includes("## Check it worked\nCheck the deployment the same way the run did: read the Vercel deployment for {sha} with get_deployment; it shows READY.\n"), text);
    const back = parseSkillMd(text, c.name)!;
    assert.equal(back.check, c.check);
    assert.equal(back.checkShows, "READY");
    assert.equal(back.meta["check-tool"], "get_deployment");
    assert.ok(draftText(c, s).split("\n").includes("  check  read the Vercel deployment for {sha} with get_deployment: it should show READY"), draftText(c, s));
  }
});

test("the deployment is named by the commit param, else by its branch, else as the new commit", () => {
  const branchOnly = sheet([call("git push origin HEAD:beta"), tool("READY", { sha: SHA, branch: "beta" }, LIST)], { checkIndex: 1, checked: true });
  assert.equal(ok(compile(branchOnly)).check, "read the Vercel deployment for the newest commit on beta with list_deployments");
  assert.equal(ok(compile(branchOnly)).meta["check-tool"], "list_deployments");
  const bare = sheet([call("git push origin HEAD:beta"), tool("READY")], { checkIndex: 1, checked: true });
  assert.equal(ok(compile(bare)).check, "read the Vercel deployment for the new commit with get_deployment");
});

test("a deploy read that is not the check is left alone: no step, no refusal, the command check still decides", () => {
  const s = sheet([call("npm run build"), tool("ERROR", { sha: SHA }, GET, { failed: true }), call("git push origin HEAD:beta", { check: passed("push", { branch: "beta" }) })], { checkIndex: 2, checked: true });
  const c = ok(compile(s));
  assert.deepEqual(cmds(c), ["npm run build", "git push origin HEAD:beta"]);
  assert.equal(c.meta["check-tool"], undefined);
  assert.equal(c.leftOut.failed, 0, "a tool read is not a failed command left out");
});

test("the overflow refusal counts only commands: deploy reads share the 200-call cap but are not commands", () => {
  const calls = [call("npm run build"), tool("BUILDING"), call("git push origin HEAD:beta"), tool("READY")];
  const fits = sheet(calls, { checkIndex: 3, checked: true, counts: { commands: 2, failed: 0, toolCalls: 4, edits: 0 } });
  assert.equal(compile(fits).ok, true);
  const over = sheet(calls, { checkIndex: 3, checked: true, counts: { commands: 3, failed: 0, toolCalls: 5, edits: 0 } });
  const r = compile(over);
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual([r.reason, r.detail], ["too-long", "overflow"]);
});
