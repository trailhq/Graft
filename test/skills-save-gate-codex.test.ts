/**
 * The save and lesson gates on Codex rollouts (design 4.16, c6): the same
 * journeys as the Claude Code tests, written as Codex lines and read through
 * the Codex dialect. `tierA` stands in for TRAIL_TIER_CODEX=A (4.18); without
 * it a Codex save is held for its host, with the consent still checked.
 * Parity: one job as a Claude transcript and as a Codex rollout folds to the
 * same run, verdict and skill. Synthetic data only.
 */
process.env.TZ = "UTC";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { heldLines } from "../src/skills/save-gate.js";
import { receiptPath } from "../src/skills/receipts.js";
import { readRunSheet } from "../src/trace/runs.js";
import { compileRun } from "../src/skills/compile.js";
import { renderSkillMd } from "../src/skills/skillmd.js";
import type { Receipt } from "../src/skills/types.js";
import { T, add, append, bash, box, hookSaw, kept, offered, prompt, release, say, sayOffer, state, stop, type Box } from "./skills-consent-fixtures.js";
import { cleanup, keep, lessonCmd, repairedOffer, sayLines } from "./skills-lesson-fixtures.js";
import * as CX from "./codex-fixtures.js";

const made: Box[] = [];
after(() => {
  cleanup();
  for (const b of made.splice(0)) rmSync(b.root, { recursive: true, force: true });
});
const codex = (tierA = true) => {
  const b = box({ host: "codex", tierA });
  made.push(b);
  return b;
};
const receipt = (b: Box): Receipt => JSON.parse(readFileSync(receiptPath(b.sid, b.env), "utf8"));

test("J05 on Codex: 'save this as a skill' after a release, then the add: saved live from the rollout", () => {
  const b = codex();
  release(b, 0);
  stop(b, 50);
  const p = prompt(b, 70, "save this as a skill");
  assert.ok(p.save, JSON.stringify(p.out));
  const r = add(b, 80, `trail skills add release-npm --run ${p.save}`);
  assert.equal(r.decision, null, JSON.stringify(r.decision));
  assert.equal(r.cli?.exit, 0, JSON.stringify(r.cli));
  assert.deepEqual(r.cli?.saved, { from: "asked", scope: "personal" });
  const rc = receipt(b);
  assert.deepEqual([rc.host, rc.consent, rc.stepsTotal, rc.stepsVerified, rc.verdict, rc.toolUseId], ["codex", "asked", 3, 3, "live", r.id]);
  assert.deepEqual(kept(b), { skills: ["release-npm"], held: [] });
});

test("J04 on Codex: offered at Stop, 'yes': saved live as a repeated job, the offer spent", () => {
  const b = codex();
  const { offer } = offered(b, 0);
  assert.equal(prompt(b, 70, "yes").answer, "yes");
  const r = add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`);
  assert.equal(r.decision, null, JSON.stringify(r.decision));
  assert.deepEqual(r.cli?.saved, { from: "repeated", scope: "personal" }, JSON.stringify(r.cli));
  assert.deepEqual([receipt(b).consent, receipt(b).offerId], ["offer-yes", offer.offerId]);
  assert.equal(state(b).pendingOffer, null);
});

test("tier B Codex (before the flip): the consent is still checked from the rollout, and the save is held for its host", () => {
  const b = codex(false);
  release(b, 0);
  stop(b, 50);
  const p = prompt(b, 70, "save this as a skill");
  const r = add(b, 80, `trail skills add release-npm --run ${p.save}`);
  assert.equal(r.decision, null);
  assert.deepEqual([receipt(b).consent, receipt(b).verdict, receipt(b).tier], ["asked", "held", "B"]);
  assert.deepEqual([r.cli?.held, r.cli?.lines], ["host", heldLines("release-npm", "host", "codex")]);
  assert.deepEqual(kept(b), { skills: [], held: ["release-npm"] });
});

test("consent needs both halves on Codex: a line the prompt hook never saw, or a hook with no line, is no yes (P30)", () => {
  // The person's line is there, but the prompt hook never recorded it.
  const lineOnly = codex();
  const o = offered(lineOnly, 0).offer;
  say(lineOnly, 70, "yes");
  const r1 = add(lineOnly, 80, `trail skills add ${o.name} --run ${o.runId}`);
  assert.deepEqual([r1.cli?.held, receipt(lineOnly).consent], ["no-yes", "none"]);
  // The hook saw "yes", but the rollout's only copy is the model-facing message (no user_message line).
  const hookOnly = codex();
  const a = offered(hookOnly, 0).offer;
  const before = readFileSync(hookOnly.tx, "utf8");
  prompt(hookOnly, 70, "yes", "hook-first");
  writeFileSync(hookOnly.tx, before + CX.jsonl([CX.userItem("yes", 70)]));
  const r2 = add(hookOnly, 80, `trail skills add ${a.name} --run ${a.runId}`);
  assert.equal(r2.cli?.saved, undefined, JSON.stringify(r2.cli));
  assert.deepEqual(kept(hookOnly).skills, []);
});

test("a yes to the agent's own question is no yes on Codex either (D72): the reply before it must end with the offer's line 2", () => {
  const b = codex();
  const { offer } = offered(b, 0, { say: false });
  sayOffer(b, 52, offer, { after: "\n\nShall I also bump the changelog?" });
  prompt(b, 70, "yes");
  const r = add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`);
  assert.equal(r.cli?.saved, undefined);
  assert.equal(receipt(b).consent, "none");
});

test("a tool call between the offer's reply and the yes makes it no yes (the reply before the yes is not the offer's)", () => {
  const b = codex();
  const { offer } = offered(b, 0);
  bash(b, 60, "git status --short", "");
  prompt(b, 70, "yes");
  const r = add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`);
  assert.equal(r.cli?.saved, undefined);
  assert.equal(receipt(b).consent, "none");
});

test("a step's result changed in the rollout after the fold is read again by the CLI: its exit decides, not the run sheet", () => {
  const b = codex();
  const { offer } = offered(b, 0);
  prompt(b, 70, "yes");
  assert.equal(add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`, { skipCli: true }).decision, null);
  const text = readFileSync(b.tx, "utf8");
  const i = text.indexOf("Process exited with code 0\\nOriginal token count: 12\\nOutput:\\nbuilt in 2.1s");
  assert.ok(i > 0);
  writeFileSync(b.tx, `${text.slice(0, i)}Process exited with code 1${text.slice(i + "Process exited with code 0".length)}`);
  const r = add(b, 90, `trail skills add ${offer.name} --run ${offer.runId}`, { skipHook: true });
  assert.equal(r.cli?.saved, undefined, JSON.stringify(r.cli));
  assert.match(r.cli!.lines.join("\n"), /never ran here and worked: npm run build/);
});

test("a step whose exit never showed is no step that worked; a write to Trail's files in the rollout is tamper", () => {
  const b = codex();
  hookSaw(b, 0, "publish 1.4.3");
  say(b, 0, "publish 1.4.3");
  bash(b, 10, "npm run build", "built in 2.1s");
  append(b, [CX.exec("call_x1", "npm publish acme-cli-1.4.3.tgz --access public", b.repo, 20), CX.output("call_x1", "+ acme-cli@1.4.3")]);
  bash(b, 30, "npm view acme-cli version", "1.4.3");
  append(b, CX.reply("Published 1.4.3; npm shows it.", 40));
  // The publish has no exit header: not passed, so the run is no checked success and there is nothing good to keep.
  assert.equal(stop(b, 50).why, "not-checked");
  assert.equal(prompt(b, 70, "save this as a skill").out?.context, "none:failed");
  const t = codex();
  release(t, 0);
  stop(t, 50);
  const q = prompt(t, 70, "save this as a skill");
  bash(t, 75, `echo '{}' > ${t.env.TRAIL_HOME}/state/skills.json`, "");
  const r = add(t, 80, `trail skills add release-npm --run ${q.save}`);
  assert.equal(r.decision?.permissionDecision, "deny");
  assert.match(r.decision!.reason, /changed Trail's own files/);
});

test("the CLI holds a Codex receipt that names another session's rollout, or a copy elsewhere", () => {
  for (const where of ["other", "copy"] as const) {
    const b = codex();
    const { offer } = offered(b, 0);
    prompt(b, 70, "yes");
    add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`, { skipCli: true });
    const other = where === "other"
      ? join(b.tx, "..", "rollout-2026-10-27T11-00-00-019fa295-20a9-7943-90ae-00000000ffff.jsonl")
      : join(b.root, `rollout-2026-10-27T10-00-00-${b.sid}.jsonl`);
    copyFileSync(b.tx, other);
    const p = receiptPath(b.sid, b.env);
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), transcriptPath: other }));
    const r = add(b, 90, `trail skills add ${offer.name} --run ${offer.runId}`, { skipHook: true });
    assert.equal(r.cli?.saved, undefined, where);
    assert.deepEqual(kept(b).skills, [], where);
  }
});

test("parity: one release as a Claude transcript and as a Codex rollout folds to the same run, verdict and skill", () => {
  const claude = box();
  made.push(claude);
  const cx = codex();
  const out = [claude, cx].map((b) => {
    const { offer } = offered(b, 0);
    const sheet = readRunSheet(offer.runId, b.env)!;
    const c = compileRun(sheet, { repoRoot: b.repo, home: b.env.HOME!, platform: "linux", now: T(60), readSheet: (id) => readRunSheet(id, b.env), moment: "repeated", applies: sheet.repoKey, taken: () => false, name: offer.name, id: "s-0a0b0c" });
    assert.ok(c.ok, JSON.stringify(c));
    return {
      name: offer.name, lines: offer.lines, job: sheet.job, checkIndex: sheet.checkIndex, end: sheet.end,
      calls: sheet.calls.map((x) => [x.cmd, x.kind, x.failed, x.check?.passed ?? null]),
      // The skill: its rendered file, and its sha with the call ids (toolu_… vs call_…) left out.
      skill: c.ok ? renderSkillMd(c.skill) : null, steps: c.ok ? c.skill.steps.map((st) => st.cmd) : [], check: c.ok ? c.skill.check : null,
    };
  });
  assert.deepEqual(out[1], out[0]);
  assert.equal(out[0]!.steps.length, 2);
});

test("the lesson gate on Codex: moment 3's yes keeps the wall lesson, read from the rollout", async () => {
  const { b, o } = repairedOffer("codex");
  sayLines(b, 60, o);
  assert.equal(prompt(b, 70, "yes").answer, "yes");
  const r = await keep(b, 80, lessonCmd(o));
  assert.equal(r.decision, null, JSON.stringify(r.decision));
  assert.equal(r.cli!.code, 0, r.cli!.line);
  assert.match(r.cli!.line, /^✓ learning kept, just for you in every repo/);
});

test("the lesson gate on Codex: a yes the prompt hook never saw keeps nothing", async () => {
  const { b, o } = repairedOffer("codex");
  sayLines(b, 60, o);
  say(b, 70, "yes");
  const r = await keep(b, 80, lessonCmd(o));
  assert.equal(r.decision?.permissionDecision, "deny");
});

test("review: apply_patch run through the shell to Trail's files is tamper, at the add as in the fold", () => {
  const t = codex();
  release(t, 0);
  stop(t, 50);
  const q = prompt(t, 70, "save this as a skill");
  const patch = `*** Begin Patch\n*** Update File: ${t.env.TRAIL_HOME}/state/skills.json\n@@\n-{}\n+{}\n*** End Patch`;
  bash(t, 75, `apply_patch <<'EOF'\n${patch}\nEOF`, "Success. Updated the following files:\nM state/skills.json");
  const r = add(t, 80, `trail skills add release-npm --run ${q.save}`);
  assert.equal(r.decision?.permissionDecision, "deny", JSON.stringify(r));
  assert.match(r.decision!.reason, /changed Trail's own files/);
});

test("review: keys fed to a running shell that write Trail's files are tamper (Codex's write_stdin; Claude Code has no such door)", () => {
  const t = codex();
  release(t, 0);
  stop(t, 50);
  const q = prompt(t, 70, "save this as a skill");
  append(t, [CX.exec("call_sh1", "bash -i", t.repo, 72), CX.output("call_sh1", CX.runningText(3, "")),
    CX.writeStdin("call_sh2", 3, `cp /tmp/x ${t.env.TRAIL_HOME}/state/skills.json\n`, 74), CX.output("call_sh2", CX.runningText(3, ""))]);
  const r = add(t, 80, `trail skills add release-npm --run ${q.save}`);
  assert.equal(r.decision?.permissionDecision, "deny", JSON.stringify(r));
  assert.match(r.decision!.reason, /changed Trail's own files/);
});
