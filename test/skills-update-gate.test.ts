/**
 * The update gate (phase 2 design 4.11, P29, R4, R11, R14): `trail skills
 * update <name> --offer <id>` changes a skill only after the person typed
 * yes to the offer that showed that exact change, from the file it was
 * computed from, with every new step read again in the transcript. Both
 * halves, through the real fold, session lock and receipts.
 * Synthetic sessions only (acme/shop, acme-cli).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { said } from "./trace-fixtures.js";
import { T, append, ctxAt, prompt, state, where } from "./skills-consent-fixtures.js";
import { OTHER, blockRun, cleanup, keptSkill, mk, needsFix, offerAtStop, runUpdate, sayLines, updateCmd } from "./skills-update-fixtures.js";
import { getSkillState } from "../src/skills/state.js";
import { readLedger } from "../src/skills/ledger.js";
import { listVersions, versionsDir } from "../src/skills/versions.js";
import { skillHash } from "../src/skills/skillmd.js";
import { readRunSheet } from "../src/trace/runs.js";
import { withSkillSession } from "../src/trace/skill-session.js";
import { UPDATE_DENY, foldInputFor } from "../src/skills/update-gate.js";

after(cleanup);

/** Kept, used, offered at Stop, the offer said, and the person's yes typed. */
function yesToUpdate(opts: { say?: boolean; answer?: string } = {}) {
  const b = mk();
  const { ref, skill } = keptSkill(b);
  blockRun(b, skill, 100);
  const o = offerAtStop(b, 150);
  if (opts.say !== false) sayLines(b, 152, o.offer);
  prompt(b, 160, opts.answer ?? "yes");
  return { b, ref, skill, ...o };
}

test("the plan behind the offer: step 4 becomes the publish that worked", () => {
  const { plan } = yesToUpdate();
  assert.equal(plan.plan?.op, "update");
  assert.equal(plan.next.steps[3]!.cmd, OTHER("{version}"));
  assert.equal(plan.next.meta.version, "2");
  assert.equal(plan.handEdited, false);
});

test("a yes to the offer: the receipt, then v2 written, v1 kept, the ledger's changed line, candidate again, the receipt used once", () => {
  const { b, ref, offer } = yesToUpdate();
  const v1 = readFileSync(ref.file, "utf8");
  const r = runUpdate(b, 170, updateCmd(offer));
  assert.equal(r.decision, null);
  assert.equal(r.cli?.code, 0, r.cli?.lines.join("\n"));
  assert.deepEqual(r.cli!.lines, [
    `✓ changed release-npm to v2 · step 4 is now '${OTHER("{version}")}'`,
    `Tell the person what Trail changed: release-npm is now v2: step 4 is now '${OTHER("{version}")}'. It's a candidate again until its next checked use. The old version is kept; to go back: trail skills restore release-npm --version 1`,
  ]);
  assert.equal(r.cli!.op, "update");
  assert.equal(readFileSync(join(versionsDir(ref), "v1", "SKILL.md"), "utf8"), v1);
  assert.match(readFileSync(ref.file, "utf8"), /npm publish \.\/dist\/acme-cli-\{version\}\.tgz/);
  const st = getSkillState(ref.id, b.env)!;
  assert.equal(st.status, "candidate");
  assert.equal(st.hash, skillHash(readFileSync(ref.file, "utf8")));
  const changed = readLedger(ref.id, b.env).filter((l) => l.event === "changed");
  assert.deepEqual(changed.map((l) => l.event === "changed" && [l.op, l.from, l.to, l.offerId]), [["update", 1, 2, offer.offerId]]);
  assert.equal(state(b).pendingOffer, null, "the consent is spent with the write");
  const again = runUpdate(b, 180, updateCmd(offer), { skipHook: true });
  assert.deepEqual(again.cli?.lines, [UPDATE_DENY.noYes]);
  assert.deepEqual(listVersions(ref), [1]);
});

/* ---------------------------------------------------------- PreToolUse half */

test("no pending offer, another offer's id, or a moment 2 offer's id: denied, no receipt", () => {
  const { b, offer } = yesToUpdate();
  const other = runUpdate(b, 170, `trail skills update release-npm --offer o-ffffff`);
  assert.equal(other.decision?.reason, UPDATE_DENY.noOffer);
  const c = mk();
  keptSkill(c);
  assert.equal(runUpdate(c, 50, updateCmd(offer)).decision?.reason, UPDATE_DENY.noOffer);
  // A moment 2 offer pending under that id.
  withMoment(b, "repeated");
  assert.equal(runUpdate(b, 175, updateCmd(offer)).decision?.reason, UPDATE_DENY.noOffer);
  const dir = join(b.env.TRAIL_HOME!, "receipts");
  assert.ok(!existsSync(dir) || !readdirSync(dir).some((n) => n.endsWith(".update.json")));
});

function withMoment(b: ReturnType<typeof mk>, moment: "repeated") {
  withSkillSession(ctxAt(b, 0), { catchUp: false }, (st) => { st.pendingOffer!.moment = moment; });
}

test("another skill's name names the right command", () => {
  const { b, offer } = yesToUpdate();
  assert.equal(runUpdate(b, 170, updateCmd(offer, "ship-web")).decision?.reason,
    `trail · not changed: the offer was for the skill release-npm. Run: trail skills update release-npm --offer ${offer.offerId}`);
});

test("no typed yes, a no, or a yes whose reply before it doesn't end with line 2 (D72): denied", () => {
  {
    const b = mk();
    const { skill } = keptSkill(b);
    blockRun(b, skill, 100);
    const { offer } = offerAtStop(b, 150);
    sayLines(b, 152, offer);
    assert.equal(runUpdate(b, 170, updateCmd(offer)).decision?.reason, UPDATE_DENY.noYes);
  }
  {
    const { b, offer } = yesToUpdate({ say: false });
    assert.equal(runUpdate(b, 170, updateCmd(offer)).decision?.reason, UPDATE_DENY.noYes);
  }
  {
    const b = mk();
    const { skill } = keptSkill(b);
    blockRun(b, skill, 100);
    const { offer } = offerAtStop(b, 150);
    sayLines(b, 152, offer, { after: "\n\nAlso, should I bump the docs too?" });
    prompt(b, 160, "yes");
    assert.equal(runUpdate(b, 170, updateCmd(offer)).decision?.reason, UPDATE_DENY.noYes);
  }
});

test("a yes typed before the offer was shown is no yes to it", () => {
  const b = mk();
  const { skill } = keptSkill(b);
  blockRun(b, skill, 100);
  const { offer } = offerAtStop(b, 150);
  sayLines(b, 152, offer);
  prompt(b, 160, "yes");
  // The offer re-stamped as shown later than the typed line.
  withSkillSession(ctxAt(b, 0), { catchUp: false }, (st) => { st.pendingOffer!.shownAt = T(300).toISOString(); });
  assert.equal(runUpdate(b, 310, updateCmd(offer)).decision?.reason, UPDATE_DENY.noYes);
});

test("the file changed after the offer (baseHash), or the run sheet edited after it (proposalSha): not changed", () => {
  {
    const { b, ref, offer } = yesToUpdate();
    writeFileSync(ref.file, readFileSync(ref.file, "utf8").replace("npm run build", "npm run build:prod"));
    assert.equal(runUpdate(b, 170, updateCmd(offer)).decision?.reason,
      "trail · not changed: release-npm changed since Trail showed this, so nothing changed. The person can see it with: trail skills show release-npm");
  }
  {
    const { b, offer, runId } = yesToUpdate();
    const sheet = readRunSheet(runId, b.env)!;
    const i = sheet.calls.findIndex((c) => c.cmd === OTHER("1.4.4"));
    sheet.calls[i] = { ...sheet.calls[i]!, cmd: "npm publish ./dist/acme-cli-1.4.4.tgz --access public --tag next" };
    writeFileSync(join(b.env.TRAIL_HOME!, "runs", `${runId}.json`), JSON.stringify(sheet));
    assert.match(runUpdate(b, 170, updateCmd(offer)).decision?.reason ?? "", /changed since Trail showed this/);
  }
});

test("each pin on its own: an offer whose baseHash, or whose proposalSha, isn't the replan's is not changed", () => {
  for (const pin of ["baseHash", "proposalSha"] as const) {
    const { b, offer } = yesToUpdate();
    withSkillSession(ctxAt(b, 165), { catchUp: false }, (st) => {
      st.pendingOffer!.fold![pin] = pin === "baseHash" ? `sha256:${"0".repeat(64)}` : "0".repeat(16);
    });
    assert.match(runUpdate(b, 170, updateCmd(offer)).decision?.reason ?? "", /changed since Trail showed this/, pin);
  }
});

test("R4: a new step whose call doesn't read back in the transcript as it worked is refused", () => {
  const { b, offer, runId } = yesToUpdate();
  // The publish that worked, its result rewritten in place (same length, so every offset holds): the sheet still says it passed.
  const call = readRunSheet(runId, b.env)!.calls.find((c) => c.cmd === OTHER("1.4.4"))!;
  const text = readFileSync(b.tx, "utf8");
  const at = text.indexOf(`"tool_use_id":"${call.id}"`);
  const line = text.slice(text.lastIndexOf("\n", at) + 1, text.indexOf("\n", at));
  const bad = line.replace('"content":"+ acme-cli@1.4.4"', '"content":"npm error code 1"');
  assert.notEqual(bad, line);
  writeFileSync(b.tx, text.replace(line, bad));
  assert.equal(runUpdate(b, 170, updateCmd(offer)).decision?.reason, `trail · not changed: these steps never ran here and worked: ${OTHER("{version}")}.`);
});

test("a subagent, a headless session and tier B are each denied", () => {
  const { b, offer } = yesToUpdate();
  assert.equal(runUpdate(b, 170, updateCmd(offer), { ctx: { ...ctxAt(b, 170), subagent: true } }).decision?.reason, UPDATE_DENY.subagent);
  assert.equal(runUpdate(b, 171, updateCmd(offer), { ctx: { ...ctxAt(b, 171), entry: "headless", learn: false, learnOff: "headless" } }).decision?.reason, UPDATE_DENY.noPerson);
  assert.equal(runUpdate(b, 172, updateCmd(offer), { ctx: { ...ctxAt(b, 172), tier: "B", learn: false, learnOff: "host" } }).decision?.reason, UPDATE_DENY.noPerson);
});

test("a chained update, root options and a `$x` name are denied as not one plain update", () => {
  const { b, offer } = yesToUpdate();
  for (const cmd of [`true && ${updateCmd(offer)}`, `trail --json skills update release-npm --offer ${offer.offerId}`, `trail skills update $x --offer ${offer.offerId}`]) {
    assert.equal(runUpdate(b, 170, cmd).decision?.reason, UPDATE_DENY.flags, cmd);
  }
});

test("the receipt is written once, for this offer, with the two hashes and no step text", () => {
  const { b, offer } = yesToUpdate();
  runUpdate(b, 170, updateCmd(offer), { name: "never-run" });
  const files = readdirSync(join(b.env.TRAIL_HOME!, "receipts")).filter((n) => n.endsWith(".update.json"));
  assert.equal(files.length, 1);
  const r = JSON.parse(readFileSync(join(b.env.TRAIL_HOME!, "receipts", files[0]!), "utf8"));
  assert.deepEqual(Object.keys(r).sort(), ["at", "baseHash", "host", "kind", "name", "offerId", "op", "proposalSha", "runId", "session", "skillId", "toolUseId", "transcriptPath", "typed", "usedAt", "v"]);
  assert.equal(r.proposalSha, offer.fold!.proposalSha);
  assert.ok(!JSON.stringify(r).includes("npm publish"));
});

/* ------------------------------------------------------------------ CLI half */

test("CLI: no receipt, or one naming another transcript (D82), changes nothing", () => {
  const { b, ref, offer } = yesToUpdate();
  assert.deepEqual(runUpdate(b, 170, updateCmd(offer), { skipHook: true }).cli?.lines, [UPDATE_DENY.noYes]);
  runUpdate(b, 175, updateCmd(offer), { name: "nobody" });
  const path = join(b.env.TRAIL_HOME!, "receipts", readdirSync(join(b.env.TRAIL_HOME!, "receipts")).find((n) => n.endsWith(".update.json"))!);
  const r = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(join(b.root, "copy.jsonl"), readFileSync(b.tx));
  writeFileSync(path, JSON.stringify({ ...r, name: "release-npm", transcriptPath: join(b.root, "copy.jsonl") }));
  assert.deepEqual(runUpdate(b, 180, updateCmd(offer), { skipHook: true }).cli?.lines, [UPDATE_DENY.transcript]);
  assert.deepEqual(listVersions(ref), []);
});

test("CLI: a receipt older than 30 minutes, the typed line gone, or the run sheet gone changes nothing", () => {
  {
    const { b, ref, offer } = yesToUpdate();
    const r = runUpdate(b, 170, updateCmd(offer), { cliAt: 170 + 31 * 60 });
    assert.deepEqual(r.cli?.lines, [UPDATE_DENY.noYes]);
    assert.deepEqual(listVersions(ref), []);
  }
  {
    const { b, ref, offer } = yesToUpdate();
    const lines = readFileSync(b.tx, "utf8").split("\n");
    const at = lines.findIndex((l) => l.includes('"yes"') && l.includes('"type":"user"'));
    lines[at] = lines[at]!.replace('"yes"', '"no!"');
    writeFileSync(b.tx, lines.join("\n"));
    const r = runUpdate(b, 170, updateCmd(offer), { skipHook: true });
    assert.equal(r.cli?.code, 1);
    assert.deepEqual(listVersions(ref), []);
  }
  {
    const { b, ref, offer, runId } = yesToUpdate();
    // PreToolUse passes, then the sheet is pruned before the CLI runs.
    const r = runUpdate(b, 170, updateCmd(offer), { name: "nobody" });
    assert.equal(r.decision, null);
    rmSync(join(b.env.TRAIL_HOME!, "runs", `${runId}.json`));
    const path = join(b.env.TRAIL_HOME!, "receipts", readdirSync(join(b.env.TRAIL_HOME!, "receipts")).find((n) => n.endsWith(".update.json"))!);
    const rec = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...rec, name: "release-npm", usedAt: null }));
    const cli = runUpdate(b, 180, updateCmd(offer), { skipHook: true });
    assert.equal(cli.cli?.code, 1);
    assert.deepEqual(listVersions(ref), []);
  }
});

test("CLI: the file changed between the halves changes nothing, and the receipt is spent", () => {
  const { b, ref, offer } = yesToUpdate();
  const r1 = runUpdate(b, 170, updateCmd(offer), { name: "nobody" });
  assert.equal(r1.decision, null);
  writeFileSync(ref.file, `${readFileSync(ref.file, "utf8")}\nMine.\n`);
  const path = join(b.env.TRAIL_HOME!, "receipts", readdirSync(join(b.env.TRAIL_HOME!, "receipts")).find((n) => n.endsWith(".update.json"))!);
  const rec = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...rec, usedAt: null }));
  const r2 = runUpdate(b, 180, updateCmd(offer), { skipHook: true });
  assert.match(r2.cli?.lines[0] ?? "", /changed since Trail showed this/);
  assert.deepEqual(listVersions(ref), []);
  assert.notEqual(JSON.parse(readFileSync(path, "utf8")).usedAt, null);
});

/* -------------------------------------------------------- drift and hand edits */

test("drift's replace on a needs-fix skill: v2 is the fresh compile, failures cleared, candidate", () => {
  const b = mk();
  const { ref, skill } = keptSkill(b);
  needsFix(b);
  blockRun(b, skill, 100);
  const { offer, plan } = offerAtStop(b, 150, "replace");
  sayLines(b, 152, offer);
  prompt(b, 160, "yes");
  const r = runUpdate(b, 170, updateCmd(offer));
  assert.equal(r.cli?.code, 0, r.decision?.reason ?? r.cli?.lines.join("\n"));
  assert.equal(r.cli!.op, "replace");
  assert.match(r.cli!.lines[0]!, /^✓ changed release-npm to v2 · the \d steps that just worked replace the old ones$/);
  assert.equal(readFileSync(ref.file, "utf8"), plan.text);
  const st = getSkillState(ref.id, b.env)!;
  assert.deepEqual([st.status, st.statusWhy, st.prevStatus], ["candidate", undefined, undefined]);
});

test("J15 D's shape: a hand-edited skill gets only a proposal, the diff and the person's cp line", () => {
  const b = mk();
  const { ref, skill } = keptSkill(b);
  const mine = `${readFileSync(ref.file, "utf8")}\nMy own note: the mirror is slow.\n`;
  writeFileSync(ref.file, mine);
  needsFix(b);
  blockRun(b, skill, 100);
  const { offer } = offerAtStop(b, 150, "replace");
  assert.equal(offer.fold!.handEdited, true);
  sayLines(b, 152, offer);
  prompt(b, 160, "yes");
  const r = runUpdate(b, 170, updateCmd(offer));
  assert.equal(r.cli?.code, 0, r.decision?.reason ?? r.cli?.lines.join("\n"));
  assert.equal(r.cli!.proposal, true);
  assert.equal(readFileSync(ref.file, "utf8"), mine, "the person's file is never written");
  const last = r.cli!.lines.at(-1)!;
  assert.equal(last, "Tell the person: you changed release-npm by hand, so Trail left it alone and wrote the change beside it. To use it, they run this in their own terminal: cp ~/trail-home/skills/release-npm/.versions/proposed-v2/SKILL.md ~/trail-home/skills/release-npm/SKILL.md (their edited file is kept in .versions/hand-2026-10-27)");
  assert.match(r.cli!.lines[0]!, /^--- release-npm\/SKILL\.md \(yours\)$/);
  assert.ok(r.cli!.lines.length <= 41);
  assert.ok(existsSync(join(versionsDir(ref), "proposed-v2", "SKILL.md")));
  assert.equal(getSkillState(ref.id, b.env)!.status, "needs-fix", "J15 D: it stays needs-fix until the person copies it");
});

void said;
void append;
void where;

test("after show me, the yes answers line 2 asked again (c3's show directive), never 1a's Keep it?", () => {
  for (const [ask, code] of [["line2", 0], ["keep", 1]] as const) {
    const b = mk();
    const { skill } = keptSkill(b);
    blockRun(b, skill, 100);
    const { offer } = offerAtStop(b, 150);
    sayLines(b, 152, offer);
    prompt(b, 160, "show me");
    append(b, [said(`Here is the change.\n\n${ask === "line2" ? offer.lines![1] : "Keep it? (yes / no)"}`, where(b, 165))]);
    prompt(b, 170, "yes");
    const r = runUpdate(b, 180, updateCmd(offer));
    assert.equal(r.cli?.code ?? 1, code, `${ask}: ${r.decision?.reason ?? r.cli?.lines.join("\n")}`);
  }
});

test("drift: 'keep it' is no yes to replace (it means leave it)", () => {
  const b = mk();
  const { skill } = keptSkill(b);
  needsFix(b);
  blockRun(b, skill, 100);
  const { offer } = offerAtStop(b, 150, "replace");
  sayLines(b, 152, offer);
  prompt(b, 160, "keep it");
  const r = runUpdate(b, 170, updateCmd(offer));
  assert.notEqual(r.decision, null);
});

test("c8: the fold input names the store's taken names, so a split's fallback name is free (FoldInput.taken)", () => {
  const b = mk();
  const { skill } = keptSkill(b);
  blockRun(b, skill, 100);
  const { runId } = offerAtStop(b, 150);
  const fi = foldInputFor("s-7f3a2c", runId, b.env, { st: null as never });
  assert.ok(fi, "the input builds from disk");
  assert.equal(typeof fi!.taken, "function");
  assert.equal(fi!.taken!("release-npm"), true, "the kept skill's own name is taken");
  assert.equal(fi!.taken!("release-npm-2"), false);
});
