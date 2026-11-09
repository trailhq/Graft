/**
 * The g4 review's attacks on the skill store, kept as tests: a link planted in
 * place of one of Trail's own folders (state, ledger, skills, held, retired)
 * is never written or chmodded through; a skill folder that is a link (to a
 * repo, say) is listed and moved whole, never written into; a SKILL.md whose
 * `metadata.trail` was removed by hand is left alone; names that could leave
 * a folder are refused everywhere; real processes writing skills.json and the
 * ledger at once never double a use or tear a line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  findSkill, forgetSkill, keepHeld, listAllPersonal, listHeld, listSkills, markHeldShown, nameTaken, readSkill, restoreSkill, saveHeld, savePersonal,
  type PersonCheck, type ScopeCtx,
} from "../src/skills/store.js";
import { getSkillState, recordUse, skillsStatePath, updateSkillState } from "../src/skills/state.js";
import { withLock } from "../src/util/private-fs.js";
import { appendLedger, readLedger } from "../src/skills/ledger.js";
import type { LedgerUse } from "../src/skills/types.js";
import { box, compiled, SHOP, writeSkillFile, type Box } from "./skills-store-fixtures.js";

const POSIX = process.platform !== "win32";
const NOW = new Date("2026-10-28T09:00:00.000Z");
const PERSON: PersonCheck = { ok: true, tty: true, claudeCodeEnv: false, claudeAncestor: false };
const ctxOf = (b: Box): ScopeCtx => ({ repoKeys: [SHOP], checkout: b.checkout, env: b.env });
const save = (b: Box, c = compiled()) => savePersonal(c, { from: "repeated", runId: c.source.runId, consent: "offer-yes", stepsVerified: 2, env: b.env, now: NOW });
const use = (id: string, extra: Partial<LedgerUse> = {}): LedgerUse => ({
  at: NOW.toISOString(), event: "use", useId: "u-000001", skill: id, v: "1", host: "claude", cue: "job", repo: SHOP, stepsRan: [1], failedStep: null,
  readyFailed: [], check: "passed", calls: 1, failed: 0, ...extra,
});
const mode = (p: string) => statSync(p).mode & 0o777;
const hold = (b: Box) => saveHeld(compiled("deploy-shop", { trail: "s-0000a1", job: "ship" }), "no-yes", { host: "claude", job: "ship", repoKey: SHOP }, b.env, NOW);

/** A folder outside the Trail home that a link points at: a repo, say. */
function victim(b: Box): string {
  const dir = join(b.home, "victim-repo");
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  writeFileSync(join(dir, "README.md"), "a repo file\n");
  return dir;
}

test("a link planted as the state or ledger folder is never written or chmodded through", { skip: !POSIX }, () => {
  for (const sub of ["state", "ledger"]) {
    const b = box("links");
    const ref = save(b);
    const v = victim(b);
    const real = join(b.trail, sub);
    const aside = `${real}-real`;
    // Move Trail's folder aside and plant the link, with a copy of the files there so Trail would carry on.
    renameSync(real, aside);
    for (const f of readdirSync(aside)) writeFileSync(join(v, f), readFileSync(join(aside, f)));
    const planted = Object.fromEntries(readdirSync(v).map((f) => [f, readFileSync(join(v, f), "utf8")]));
    symlinkSync(v, real);
    // A hook's write changes nothing; the ledger refuses (the settle catches it).
    if (sub === "state") assert.equal(recordUse(ref.id, use(ref.id), b.env), undefined);
    else assert.throws(() => appendLedger(ref.id, use(ref.id), b.env), /link/);
    // A person's command fails before it writes anything.
    assert.throws(() => save(b, compiled("ship-shop", { trail: "s-0000b1" })), /link/);
    assert.deepEqual(Object.fromEntries(readdirSync(v).map((f) => [f, readFileSync(join(v, f), "utf8")])), planted, sub);
    assert.equal(mode(v), 0o755, sub);
    assert.equal(existsSync(join(b.trail, "skills", "ship-shop")), false, sub);
  }
});

test("a link planted as the skills, held or retired folder is never written through", { skip: !POSIX }, () => {
  {
    const b = box("links");
    const v = victim(b);
    mkdirSync(b.trail, { recursive: true });
    symlinkSync(v, join(b.trail, "skills"));
    assert.throws(() => save(b), /link/);
    assert.throws(() => saveHeld(compiled("deploy-shop"), "no-yes", { host: "claude", job: "ship", repoKey: SHOP }, b.env, NOW), /link/);
    assert.deepEqual(readdirSync(v), ["README.md"]);
    assert.equal(mode(v), 0o755);
  }
  {
    const b = box("links");
    const v = victim(b);
    mkdirSync(b.trail, { recursive: true });
    symlinkSync(v, join(b.trail, "held"));
    assert.throws(() => saveHeld(compiled("deploy-shop"), "no-yes", { host: "claude", job: "ship", repoKey: SHOP }, b.env, NOW), /link/);
    markHeldShown("deploy-shop", b.env, NOW);
    assert.deepEqual(readdirSync(v), ["README.md"]);
  }
  {
    const b = box("links");
    save(b);
    const v = victim(b);
    symlinkSync(v, join(b.trail, "skills", ".retired"));
    assert.throws(() => forgetSkill("release-npm", b.env, NOW), /link/);
    assert.deepEqual(readdirSync(v), ["README.md"]);
    assert.ok(existsSync(join(b.trail, "skills", "release-npm", "SKILL.md")), "the skill stays where it was");
  }
});

test("a skill folder that is a link (into a repo) is listed and read, moved whole by forget and restore, never written into", { skip: !POSIX }, () => {
  const b = box("links");
  const target = join(b.checkout, ".agents", "skills", "release-npm");
  writeSkillFile(target);
  const before = readFileSync(join(target, "SKILL.md"), "utf8");
  mkdirSync(join(b.trail, "skills"), { recursive: true });
  symlinkSync(target, join(b.trail, "skills", "release-npm"));
  updateSkillState("s-7f3a2c", () => ({
    name: "release-npm", scope: "personal", status: "needs-fix", prevStatus: "active", statusWhy: "step 2 failed on Nov 2 and Nov 4", from: "asked",
    runId: null, addedAt: NOW.toISOString(), lastWorked: null, lastUsedAt: null, lastUsedRepo: null, uses: 2, checkedUses: 1, hash: "sha256:00", fixHash: "sha256:00",
    source: null, lastFails: [], promoteOffers: {},
  }), b.env);
  assert.deepEqual(listSkills(ctxOf(b)).map((r) => r.name), ["release-npm"]);
  assert.ok(readSkill(findSkill("release-npm", ctxOf(b))!));
  // Saving or keeping onto that name is refused; nothing is written into the repo.
  assert.throws(() => save(b), /already there/);
  saveHeld(compiled(), "no-yes", { host: "claude", job: "release", repoKey: SHOP }, b.env, NOW);
  assert.deepEqual(keepHeld("release-npm", PERSON, b.env, NOW), { ok: false, reason: "name-taken" });
  const f = forgetSkill("release-npm", b.env, NOW);
  assert.equal(f.ok, true);
  assert.ok(lstatSync((f as { to: string }).to).isSymbolicLink(), "the link itself moved");
  assert.equal(restoreSkill("release-npm", b.env, NOW).ok, true);
  assert.ok(lstatSync(join(b.trail, "skills", "release-npm")).isSymbolicLink());
  assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), before);
  assert.deepEqual(readdirSync(target), ["SKILL.md"]);
});

test("a SKILL.md whose metadata.trail was removed by hand is no longer Trail's: not listed, read, covered or restored", () => {
  const b = box("unmarked");
  const ref = save(b);
  updateSkillState(ref.id, (s) => ({ ...s!, status: "needs-fix", prevStatus: "active", statusWhy: "x" }), b.env);
  const text = readFileSync(ref.file, "utf8").replace(/^\s+trail: .*\n/m, "");
  writeFileSync(ref.file, text);
  assert.deepEqual(listSkills(ctxOf(b)), []);
  assert.deepEqual(listAllPersonal(b.env), []);
  assert.equal(readSkill(ref), null);
  assert.equal(getSkillState(ref.id, b.env)?.status, "needs-fix", "a read of a file that is not Trail's changes nothing");
  assert.equal(readFileSync(ref.file, "utf8"), text);
  // The name is still taken: Trail won't save over it.
  assert.equal(nameTaken("release-npm", ctxOf(b)), "personal");
});

test("names that could leave a folder are refused by every command that takes one", () => {
  const b = box("names");
  save(b);
  const bad = ["..", "../release-npm", "a/b", "a\\b", ".hidden", "release-npm/..", "réléase", "release\u0000npm", "", " release-npm", "x".repeat(70)];
  for (const n of bad) {
    assert.equal(nameTaken(n, ctxOf(b)), "invalid", JSON.stringify(n));
    assert.deepEqual(forgetSkill(n, b.env, NOW), { ok: false, reason: "unknown" }, JSON.stringify(n));
    assert.deepEqual(restoreSkill(n, b.env, NOW), { ok: false, reason: "unknown" }, JSON.stringify(n));
    assert.deepEqual(keepHeld(n, PERSON, b.env, NOW), { ok: false, reason: "unknown" }, JSON.stringify(n));
    assert.throws(() => save(b, compiled(n)), JSON.stringify(n));
  }
  // A name with dots is one folder name: its retired copies are found by the name, dots taken literally.
  assert.equal(nameTaken("release.npm", ctxOf(b)), null);
  assert.ok(existsSync(join(b.trail, "skills", "release-npm")));
});

test("forget, then restore after the name was taken again (a new save, or a host's skill): refused, nothing moved", () => {
  const b = box("names");
  save(b);
  forgetSkill("release-npm", b.env, NOW);
  save(b, compiled("release-npm", { trail: "s-0000c1" }));
  assert.deepEqual(restoreSkill("release-npm", b.env, NOW), { ok: false, reason: "name-taken" });
  assert.equal(readdirSync(join(b.trail, "skills", ".retired")).length, 1);
  // A host's own skill of that name in the home takes it too.
  const b2 = box("names");
  save(b2);
  forgetSkill("release-npm", b2.env, NOW);
  mkdirSync(join(b2.home, ".agents", "skills", "release-npm"), { recursive: true });
  assert.deepEqual(restoreSkill("release-npm", b2.env, NOW), { ok: false, reason: "name-taken" });
});

test("a retired skill's id is never handed to a new save: restoring it later can't share one state", () => {
  const b = box("ids");
  save(b);
  updateSkillState("s-7f3a2c", (s) => ({ ...s!, status: "active", uses: 5 }), b.env);
  forgetSkill("release-npm", b.env, NOW);
  // Another skill compiled to the same id (a 24-bit hash can collide).
  const other = save(b, compiled("ship-shop", { trail: "s-7f3a2c" }));
  assert.notEqual(other.id, "s-7f3a2c");
  assert.equal(restoreSkill("release-npm", b.env, NOW).ok, true);
  assert.deepEqual([getSkillState("s-7f3a2c", b.env)?.name, getSkillState("s-7f3a2c", b.env)?.status, getSkillState("s-7f3a2c", b.env)?.uses], ["release-npm", "active", 5]);
});

test("a save or keep while the state is busy fails whole: no folder, no ledger line, the held item still there", () => {
  const b = box("busy");
  hold(b);
  const lock = skillsStatePath(b.env);
  mkdirSync(join(b.trail, "state"), { recursive: true });
  const r = withLock(lock, () => {
    assert.throws(() => save(b), /busy/);
    assert.throws(() => keepHeld("deploy-shop", PERSON, b.env, NOW), /busy/);
    return true;
  });
  assert.equal(r.ok, true);
  assert.equal(existsSync(join(b.trail, "skills", "release-npm")), false);
  assert.equal(existsSync(join(b.trail, "skills", "deploy-shop")), false);
  assert.deepEqual(readLedger("s-7f3a2c", b.env), []);
  assert.equal(nameTaken("release-npm", ctxOf(b)), null);
  assert.deepEqual(listHeld(b.env, NOW).map((h) => h.name), ["deploy-shop"]);
  // Once the state is free, both go through, with a state entry each.
  const ref = save(b);
  assert.equal(getSkillState(ref.id, b.env)?.status, "candidate");
  const kept = keepHeld("deploy-shop", PERSON, b.env, NOW);
  assert.equal(kept.ok, true);
  assert.equal(getSkillState((kept as { ref: { id: string } }).ref.id, b.env)?.status, "candidate");
});

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** One process recording `n` uses of a skill, as concurrent Stop hooks would. */
function writer(env: NodeJS.ProcessEnv, id: string, n: number): Promise<number> {
  const script = `
    const { recordUse } = await import(${JSON.stringify(pathToFileURL(join(REPO, "src/skills/state.ts")).href)});
    const { appendLedger } = await import(${JSON.stringify(pathToFileURL(join(REPO, "src/skills/ledger.ts")).href)});
    let ok = 0;
    for (let k = 0; k < ${n}; k++) {
      const u = { at: new Date().toISOString(), event: "use", useId: "u-" + process.pid.toString(16).slice(-3) + k.toString(16).padStart(3, "0"), skill: ${JSON.stringify(id)}, v: "1", host: "claude", cue: "job", repo: "github.com/acme/shop", stepsRan: [1], failedStep: k % 2 ? 2 : null, readyFailed: [], check: "none", calls: 2, failed: k % 2 };
      appendLedger(${JSON.stringify(id)}, u, ${JSON.stringify(env)});
      if (recordUse(${JSON.stringify(id)}, u, ${JSON.stringify(env)})) ok++;
    }
    console.log(ok);`;
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: REPO, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", fail);
    p.on("close", (code) => (code === 0 ? done(Number(out.trim())) : fail(new Error(`writer exited ${code}`))));
  });
}

test("real processes writing skills.json and the ledger at once: no use counted twice, no torn line, no broken file", async () => {
  const b = box("procs");
  const ref = save(b);
  const n = 25;
  const counted = await Promise.all([writer(b.env, ref.id, n), writer(b.env, ref.id, n), writer(b.env, ref.id, n)]);
  const s = getSkillState(ref.id, b.env)!;
  JSON.parse(readFileSync(join(b.trail, "state", "skills.json"), "utf8"));
  // Every recordUse that said it counted is counted once; one that gave up on a busy lock changed nothing.
  assert.equal(s.uses, counted.reduce((a, c) => a + c, 0));
  assert.ok(s.uses > 0);
  const lines = readFileSync(join(b.trail, "ledger", `${ref.id}.jsonl`), "utf8").trim().split("\n");
  for (const l of lines) JSON.parse(l);
  assert.equal(readLedger(ref.id, b.env).filter((l) => l.event === "use").length, 3 * n);
  assert.deepEqual(readdirSync(join(b.trail, "state")).filter((f) => f !== "skills.json"), [], "no lock or temp file left");
});

/**
 * One process marking one use corrected, as a prompt hook in another session would. It loads and warms up first
 * (a loaded runner can take seconds to start a process, so a start time fixed before the spawn can pass before
 * one is up), says "ready", and starts at the instant the test then sends. It says whether it got the lock:
 * "busy" when the other held it past the 200 ms the lock waits, and then it changes nothing, by design.
 */
function corrector(env: NodeJS.ProcessEnv, id: string, useId: string): { ready: Promise<void>; go: (atMs: number) => void; got: Promise<boolean> } {
  const script = `
    const { recordCorrected } = await import(${JSON.stringify(pathToFileURL(join(REPO, "src/skills/state.ts")).href)});
    recordCorrected(${JSON.stringify(id)}, "u-none", ${JSON.stringify(env)}); // warm up: no such use, nothing marked
    process.stdout.write("ready\\n");
    let line = "";
    process.stdin.on("data", (d) => {
      line += d;
      if (!line.includes("\\n")) return;
      process.stdin.pause();
      const at = Number(line.trim());
      while (Date.now() < at) { /* both start at the same instant */ }
      const got = recordCorrected(${JSON.stringify(id)}, ${JSON.stringify(useId)}, ${JSON.stringify(env)}) !== undefined;
      process.stdout.write(got ? "got\\n" : "busy\\n");
    });`;
  const p = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: REPO, stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  let isReady = (): void => undefined;
  let notReady = (_: Error): void => undefined;
  const ready = new Promise<void>((ok, fail) => { isReady = ok; notReady = fail; });
  p.stdout!.on("data", (d) => { out += d; if (out.includes("ready\n")) isReady(); });
  const got = new Promise<boolean>((ok, fail) => {
    p.on("error", (e) => { notReady(e); fail(e); });
    p.on("close", (code) => {
      const e = new Error(`corrector exited ${code}: ${out}`);
      notReady(e);
      if (code === 0 && /^(got|busy)$/m.test(out)) ok(/^got$/m.test(out));
      else fail(e);
    });
  });
  got.catch(() => undefined); // awaited below; a child that dies before ready fails `ready` first
  return { ready, go: (atMs) => p.stdin!.end(`${atMs}\n`), got };
}

test("two hooks correcting neighbouring uses at the same instant still make two in a row (the ledger is read under the lock)", async () => {
  // A use is marked once per hook that got the lock; the one that got it second reads the first one's line under
  // it and sees two in a row. Read outside the lock, both read before either wrote, and neither would. On a
  // loaded runner the first can hold the lock past the second's 200 ms: that round proves nothing, so it runs again.
  let both = 0;
  for (let round = 0; round < 5 && both === 0; round++) {
    const b = box("procs");
    const ref = save(b);
    for (const [u, d] of [["u-00000a", "02"], ["u-00000b", "04"]] as const) appendLedger(ref.id, use(ref.id, { useId: u, at: `2026-11-${d}T10:00:00.000Z` }), b.env);
    const hooks = [corrector(b.env, ref.id, "u-00000a"), corrector(b.env, ref.id, "u-00000b")];
    await Promise.all(hooks.map((h) => h.ready));
    const at = Date.now() + 100;
    for (const h of hooks) h.go(at);
    const got = await Promise.all(hooks.map((h) => h.got));
    assert.equal(readLedger(ref.id, b.env).filter((l) => l.event === "corrected").length, got.filter(Boolean).length, "one that found the lock busy wrote nothing");
    if (!got.every(Boolean)) continue;
    both++;
    assert.equal(getSkillState(ref.id, b.env)?.status, "needs-fix");
  }
  assert.equal(both, 1, "in 5 rounds the two hooks never both got the lock");
});
