/**
 * An asked save is bound to the steps the person asked about (D73, D74): the
 * prompt hook records `saveRequest.skillSha` of the skill it compiled when
 * they typed "save this as a skill", and both halves of the save gate refuse
 * a skill whose steps differ at add time, or a request with no sha at all
 * (state written before this rule). Real fold, real session lock, a made-up
 * repo and transcript; "out of sight" writes name no file in a tool call.
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliAdd } from "../src/skills/save-gate.js";
import { DENY } from "../src/skills/save-verify.js";
import { skillSha } from "../src/skills/offer-moment.js";
import { compileRun } from "../src/skills/compile.js";
import { promptSkills } from "../src/claude/prompt-skills.js";
import { findPriorSheet, readRunSheet, runSheetPath } from "../src/trace/runs.js";
import { sessionPath } from "../src/trace/gate-file.js";
import type { SkillSessionState } from "../src/trace/types.js";
import { SHOP, T, add, append, bash, box, iso, kept, prompt, release, say, state, stop, where, type AddResult, type Box } from "./skills-consent-fixtures.js";
import { said } from "./trace-fixtures.js";
import { skillsGate } from "../src/trace/skill-session.js";
import { box as promptBox, CWD, gateFor, grow, payload, ranIn, replyAt, stateOf, typedIn, withNow } from "./skills-prompt-fixtures.js";

const ASKED_CHANGED = "trail · not saved: the steps changed after you asked. Ask again once the job is done.";
const addCmd = (name: string, runId: string) => `trail skills add ${name} --run ${runId}`;

/** An out-of-sight write of the session state. */
function forge(b: Box, fn: (s: SkillSessionState) => void): void {
  const path = sessionPath(b.sid, ".json", b.env);
  const f = JSON.parse(readFileSync(path, "utf8"));
  fn(f.skills);
  writeFileSync(path, JSON.stringify(f));
}

/** A release that checked out, then "save this as a skill": the run id the request names. */
function asked(b: Box): string {
  release(b, 0);
  stop(b, 50);
  const p = prompt(b, 70, "save this as a skill");
  assert.ok(p.save && p.save.startsWith("r-"), String(p.save));
  return p.save;
}

const denyReason = (r: AddResult) => (r.decision?.permissionDecision === "deny" ? r.decision.reason : null);

test("the deny words: plain, no em dash", () => {
  assert.equal(DENY.askedChanged, ASKED_CHANGED);
  assert.doesNotMatch(DENY.askedChanged, /—/);
});

test("the request records the sha of the skill compiled when the person asked", () => {
  const b = box();
  const runId = asked(b);
  const sr = state(b).saveRequest!;
  const sheet = readRunSheet(runId, b.env)!;
  const c = compileRun(sheet, {
    repoRoot: b.repo, home: b.env.HOME!, platform: process.platform, prior: findPriorSheet(sheet, b.env), moment: "asked",
    applies: sheet.repoKey, now: T(70), readSheet: (id) => readRunSheet(id, b.env), taken: () => false,
  });
  assert.ok(c.ok);
  assert.equal(sr.skillSha, skillSha(c.skill));
});

test("unchanged steps still save (J05)", () => {
  const b = box();
  const runId = asked(b);
  const r = add(b, 80, addCmd("release-npm", runId));
  assert.equal(r.decision, null);
  assert.deepEqual(r.cli?.saved, { from: "asked", scope: "personal" });
  assert.deepEqual(kept(b).skills, ["release-npm"]);
});

test("ways around: extra steps after the ask, spliced into the run sheet out of sight, are refused by both halves", () => {
  const b = box();
  const runId = asked(b);
  // The agent runs another command after the ask: it ran and worked, so the transcript backs it.
  const extra = bash(b, 72, "npm run bump-major", "bumped");
  const path = runSheetPath(runId, b.env);
  const s = JSON.parse(readFileSync(path, "utf8"));
  const offs: number[] = [];
  let off = 0;
  for (const l of readFileSync(b.tx, "utf8").split("\n")) {
    if (l.includes(extra)) offs.push(off);
    off += Buffer.byteLength(l) + 1;
  }
  s.calls.splice(1, 0, { ...s.calls[0], id: extra, cmd: "npm run bump-major", src: { ...s.calls[0].src, use: offs[0], result: offs[1] } });
  s.checkIndex += 1;
  writeFileSync(path, JSON.stringify(s));
  const r = add(b, 80, addCmd("release-npm", runId));
  assert.equal(denyReason(r), ASKED_CHANGED, "PreToolUse half");
  // The CLI half re-decides the same way (the hook let nothing through, so run it as if it had been skipped with a receipt).
  const cli = cliAdd("release-npm", runId, b.env, T(81), b.repo);
  assert.notDeepEqual(cli.saved, { from: "asked", scope: "personal" });
  assert.deepEqual(kept(b).skills, []);
});

test("ways around: a forged skillSha in the session state is refused", () => {
  const b = box();
  const runId = asked(b);
  forge(b, (s) => { s.saveRequest = { ...s.saveRequest!, skillSha: "f".repeat(64) }; });
  const r = add(b, 80, addCmd("release-npm", runId));
  assert.equal(denyReason(r), ASKED_CHANGED);
  assert.deepEqual(kept(b).skills, []);
});

test("ways around: a save request with no sha (state written before this rule) is refused the same way", () => {
  const b = box();
  const runId = asked(b);
  forge(b, (s) => { delete (s.saveRequest as { skillSha?: string }).skillSha; });
  const r = add(b, 80, addCmd("release-npm", runId));
  assert.equal(denyReason(r), ASKED_CHANGED);
  assert.deepEqual(kept(b).skills, []);
});

test("the CLI half's re-decision refuses a sha changed between the hook and the CLI", () => {
  const b = box();
  const runId = asked(b);
  const r = add(b, 80, addCmd("release-npm", runId), { skipCli: true });
  assert.equal(r.decision, null, "the hook let it through, with a receipt");
  forge(b, (s) => { s.saveRequest = { ...s.saveRequest!, skillSha: "0".repeat(64) }; });
  const cli = cliAdd("release-npm", runId, b.env, T(81), b.repo);
  assert.equal(cli.exit, 1);
  assert.deepEqual(cli.lines, [ASKED_CHANGED]);
  assert.deepEqual(kept(b).skills, []);
});

test("g6's prompt hook passes the compiled skill's sha to noteSaveRequest", () => {
  const b = promptBox("asked-sha");
  grow(b, [
    typedIn(b, "can you pull and publish 1.4.3", 0), ...ranIn(b, "git pull --ff-only origin beta", "Already up to date.", 5),
    ...ranIn(b, "npm run build", "built", 10), ...ranIn(b, "npm publish acme-cli-1.4.3.tgz --access public", "+ acme-cli@1.4.3", 15),
    ...ranIn(b, "npm view acme-cli version", "1.4.3", 20), replyAt("Published 1.4.3: npm shows it.", 25),
    typedIn(b, "save this as a skill", 70),
  ]);
  const out = promptSkills(payload(b, "save this as a skill"), CWD, withNow(b, "2026-10-20T10:01:11.000Z"), { track: () => {}, gate: gateFor(b) });
  assert.match(out.context ?? "", /trail skills add [a-z0-9-]+ --run r-/);
  const st = stateOf(b);
  const sr = st.saveRequest!;
  const sheet = readRunSheet(sr.runId, b.env)!;
  const c = compileRun(sheet, {
    repoRoot: b.repo, home: b.env.HOME!, platform: process.platform, prior: findPriorSheet(sheet, b.env), moment: "asked",
    applies: sheet.repoKey, now: new Date("2026-10-20T10:01:11.000Z"), readSheet: (id) => readRunSheet(id, b.env), taken: () => false,
  });
  assert.ok(c.ok);
  assert.equal(sr.skillSha, skillSha(c.skill));
});

/** The real prompt hook (g6's promptSkills) on the consent box: the sha it records is the hook's own. */
function realAsk(b: Box, sec: number, words: string): string {
  say(b, sec, words);
  const gate = (input: unknown, dir: string, env?: NodeJS.ProcessEnv) => {
    const g = skillsGate(input, dir, env);
    return g.ok ? { ok: true as const, ctx: { ...g.ctx, checkout: b.repo, repoKey: SHOP } } : g;
  };
  const out = promptSkills({ ...b.payload, hook_event_name: "UserPromptSubmit", prompt: words }, "/home/dev/shop", { ...b.env, TRAIL_TEST_NOW: iso(sec) }, { track: () => {}, gate });
  const m = /trail skills add ([a-z0-9-]+) --run (r-[\w-]+)/.exec(out.context ?? "");
  assert.ok(m, out.context);
  assert.ok(state(b).saveRequest?.skillSha, "the hook recorded the sha");
  assert.equal(state(b).saveRequest?.name, m[1], "and the name it told the agent to use");
  return m[2]!;
}

/** The name the prompt hook told the agent to use. */
const askedName = (b: Box) => state(b).saveRequest!.name!;

test("an honest asked save still saves through the real prompt hook: a run with a job class", () => {
  const b = box();
  release(b, 0);
  stop(b, 50);
  const runId = realAsk(b, 70, "save this as a skill");
  const r = add(b, 80, addCmd("release-npm", runId));
  assert.equal(r.decision, null);
  assert.deepEqual(r.cli?.saved, { from: "asked", scope: "personal" });
  assert.deepEqual(kept(b).skills, ["release-npm"]);
});

test("an honest asked save still saves through the real prompt hook: a job-less run, its asks from the typed request", () => {
  const b = box();
  say(b, 0, "regenerate the api client from the openapi spec");
  bash(b, 10, "npm run gen:client -- --spec openapi.yaml", "wrote src/client.ts");
  bash(b, 20, "npx tsc --noEmit", "");
  append(b, [said("Regenerated the client; it type-checks.", where(b, 30))]);
  stop(b, 40);
  const runId = realAsk(b, 70, "save this as a skill for regenerating the api client");
  const name = askedName(b);
  const r = add(b, 80, addCmd(name, runId));
  assert.equal(r.decision, null, JSON.stringify(r.decision));
  assert.deepEqual(r.cli?.saved, { from: "asked", scope: "personal" });
  assert.deepEqual(kept(b).skills, [name]);
  assert.match(readFileSync(join(b.env.TRAIL_HOME!, "skills", name, "SKILL.md"), "utf8"), /asks: "regenerating api client"/);
});
