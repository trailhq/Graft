/**
 * Kept versions (phase 2 design 2.1, 4.5, 4.6, 4.12): a new version is
 * written only over Trail's own bytes, after the old file is kept; links,
 * odd files and a state that can't be written change nothing; a hand-edited
 * file gets a proposal beside it, taken as Trail's own only on an exact copy;
 * an older version comes back as a new one. Synthetic skills (acme/shop).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, renameSync, cpSync } from "node:fs";
import { join } from "node:path";
import { listAllPersonal, listSkills, savePersonal } from "../src/skills/store.js";
import { renderSkillMd, skillHash } from "../src/skills/skillmd.js";
import { getSkillState, updateSkillState } from "../src/skills/state.js";
import { readLedger } from "../src/skills/ledger.js";
import { readLessons } from "../src/skills/lessons.js";
import { candidatesHere } from "../src/skills/recall.js";
import {
  adoptIfCopied, listVersions, nextVersion, restoreVersion, VERSION_SEAMS, VERSIONS_KEPT, versionsDir, writeNewVersion, writeProposal,
} from "../src/skills/versions.js";
import type { CompiledSkill, SkillRef } from "../src/skills/types.js";
import { box, compiled, SHOP, type Box } from "./skills-store-fixtures.js";

const POSIX = process.platform !== "win32";
const NOW = new Date("2026-11-12T09:00:00.000Z");
const boxes: Box[] = [];
after(() => { for (const b of boxes.splice(0)) rmSync(b.home, { recursive: true, force: true }); });

function saved(c: CompiledSkill = compiled()): { b: Box; ref: SkillRef } {
  const b = box("versions");
  boxes.push(b);
  savePersonal(c, { from: "repeated", runId: c.source.runId, consent: "offer-yes", stepsVerified: 2, env: b.env, now: NOW });
  writeFileSync(join(b.trail, "skills", c.name, "scripts", "stamp.sh"), "#!/bin/sh\necho stamped\n", { mode: 0o700 });
  return { b, ref: listAllPersonal(b.env).find((r) => r.name === c.name)! };
}
/** The skill with step 2 changed, at version `v`. */
const changed = (v: number, cmd = "npm publish --access public --tag next"): CompiledSkill => {
  const c = compiled();
  return { ...c, meta: { ...c.meta, version: String(v), "confirm-before": cmd }, steps: [c.steps[0]!, { ...c.steps[1]!, cmd }] };
};
const hashOf = (ref: SkillRef) => skillHash(readFileSync(ref.file, "utf8"));
const write = (b: Box, ref: SkillRef, next: CompiledSkill, op: "update" | "extend" | "replace" = "update", lessonIds?: string[]) =>
  writeNewVersion(ref, next, { op, offerId: "o-1a2b3c", baseHash: hashOf(ref), lessonIds, env: b.env, now: NOW });

test("write v2 keeps v1 byte for byte with its scripts/, then state per 2.2 and a changed line", () => {
  const { b, ref } = saved();
  const v1 = readFileSync(ref.file, "utf8");
  updateSkillState(ref.id, (s) => (s ? { ...s, status: "active", firings: [{ at: NOW.toISOString(), followed: false }], lastFails: [{ step: 2, at: NOW.toISOString() }], statusWhy: "x", prevStatus: "candidate", fixHash: "sha256:00" } : s), b.env);
  const r = write(b, ref, changed(2));
  assert.deepEqual(r, { ok: true, version: 2 });
  assert.equal(readFileSync(join(versionsDir(ref), "v1", "SKILL.md"), "utf8"), v1);
  assert.equal(readFileSync(join(versionsDir(ref), "v1", "scripts", "stamp.sh"), "utf8"), "#!/bin/sh\necho stamped\n");
  assert.equal(readFileSync(ref.file, "utf8"), renderSkillMd(changed(2)));
  assert.ok(existsSync(join(ref.dir, "scripts", "stamp.sh")), "a fold leaves scripts/ as it is");
  const st = getSkillState(ref.id, b.env)!;
  assert.equal(st.hash, hashOf(ref));
  assert.equal(st.status, "candidate");
  assert.equal(st.changedAt, NOW.toISOString());
  assert.deepEqual([st.firings, st.lastFails, st.statusWhy, st.prevStatus, st.fixHash, st.pendingWrite], [[], [], undefined, undefined, undefined, null]);
  const line = readLedger(ref.id, b.env).find((l) => l.event === "changed");
  assert.deepEqual(line, { at: NOW.toISOString(), event: "changed", skill: ref.id, op: "update", from: 1, to: 2, offerId: "o-1a2b3c" });
  assert.deepEqual(listVersions(ref), [1]);
});

test("the new version's number is past every kept one, and a next that says another number writes nothing", () => {
  const { b, ref } = saved();
  mkdirSync(join(versionsDir(ref), "v4"), { recursive: true });
  writeFileSync(join(versionsDir(ref), "v4", "SKILL.md"), "kept\n");
  assert.equal(nextVersion(ref, 1), 5);
  assert.deepEqual(write(b, ref, changed(2)), { ok: false, why: "changed" });
  assert.deepEqual(write(b, ref, changed(5)), { ok: true, version: 5 });
  assert.match(readFileSync(ref.file, "utf8"), /version: "5"/);
});

test(`${VERSIONS_KEPT + 1} writes keep ${VERSIONS_KEPT}, the oldest gone`, () => {
  const { b, ref } = saved();
  for (let v = 2; v <= 12; v++) assert.equal(write(b, ref, changed(v, `npm publish --access public --tag t${v}`)).ok, true);
  assert.deepEqual(listVersions(ref), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("a v1 already there with other bytes refuses, and nothing is written", () => {
  const { b, ref } = saved();
  const before = readFileSync(ref.file, "utf8");
  mkdirSync(join(versionsDir(ref), "v1"), { recursive: true });
  writeFileSync(join(versionsDir(ref), "v1", "SKILL.md"), "something else wrote this\n");
  assert.deepEqual(write(b, ref, changed(2)), { ok: false, why: "changed" });
  assert.equal(readFileSync(ref.file, "utf8"), before);
  assert.equal(getSkillState(ref.id, b.env)!.pendingWrite, null);
});

test("a v1 already there with the same bytes is reused", () => {
  const { b, ref } = saved();
  mkdirSync(join(versionsDir(ref), "v1"), { recursive: true });
  writeFileSync(join(versionsDir(ref), "v1", "SKILL.md"), readFileSync(ref.file, "utf8"));
  assert.equal(write(b, ref, changed(2)).ok, true);
});

test("a file Trail didn't write (a hand edit) or a base that isn't the file refuses", () => {
  const { b, ref } = saved();
  const base = hashOf(ref);
  writeFileSync(ref.file, `${readFileSync(ref.file, "utf8")}\nMy own note.\n`);
  assert.deepEqual(writeNewVersion(ref, changed(2), { op: "update", offerId: null, baseHash: base, env: b.env, now: NOW }), { ok: false, why: "changed" });
  const t = saved();
  assert.deepEqual(writeNewVersion(t.ref, changed(2), { op: "update", offerId: null, baseHash: "sha256:00", env: t.b.env, now: NOW }), { ok: false, why: "changed" });
});

test("a linked skill folder, a linked SKILL.md, a FIFO at SKILL.md and a 65 KB file each refuse", { skip: !POSIX }, () => {
  {
    const { b, ref } = saved();
    const away = join(b.home, "elsewhere");
    renameSync(ref.dir, away);
    symlinkSync(away, ref.dir);
    assert.deepEqual(write(b, ref, changed(2)), { ok: false, why: "link" });
    assert.ok(!existsSync(join(away, ".versions")), "nothing written through the link");
  }
  {
    const { b, ref } = saved();
    const text = readFileSync(ref.file, "utf8");
    const away = join(b.home, "SKILL.md");
    writeFileSync(away, text);
    rmSync(ref.file);
    symlinkSync(away, ref.file);
    assert.deepEqual(write(b, ref, changed(2)), { ok: false, why: "link" });
    assert.equal(readFileSync(away, "utf8"), text);
  }
  {
    const { b, ref } = saved();
    const base = hashOf(ref);
    rmSync(ref.file);
    execFileSync("mkfifo", [ref.file]);
    const r = writeNewVersion(ref, changed(2), { op: "update", offerId: null, baseHash: base, env: b.env, now: NOW });
    assert.deepEqual(r, { ok: false, why: "changed" }, "never opened, never blocks");
  }
  {
    const { b, ref } = saved();
    const base = hashOf(ref);
    writeFileSync(ref.file, `${readFileSync(ref.file, "utf8")}${"x".repeat(65 * 1024)}\n`);
    assert.deepEqual(writeNewVersion(ref, changed(2), { op: "update", offerId: null, baseHash: base, env: b.env, now: NOW }), { ok: false, why: "changed" });
  }
});

test("a state lock that gives up after the new file puts v1 back (D68)", () => {
  const { b, ref } = saved();
  const v1 = readFileSync(ref.file, "utf8");
  const lock = join(b.trail, "state", "skills.json.lock");
  VERSION_SEAMS.beforeState = () => writeFileSync(lock, "4242");
  try {
    assert.deepEqual(write(b, ref, changed(2)), { ok: false, why: "busy" });
  } finally {
    VERSION_SEAMS.beforeState = undefined;
    rmSync(lock, { force: true });
  }
  assert.equal(readFileSync(ref.file, "utf8"), v1);
  assert.equal(getSkillState(ref.id, b.env)!.hash, skillHash(v1));
  assert.ok(!readLedger(ref.id, b.env).some((l) => l.event === "changed"));
});

test("R8 under a race: a reader in the write's window never finishes it, so a write the state lock then undoes leaves Trail's own file", () => {
  const { b, ref } = saved();
  const v1 = readFileSync(ref.file, "utf8");
  const lock = join(b.trail, "state", "skills.json.lock");
  // Another session's read (candidatesHere) lands between the new file and the state, then the state lock is busy.
  VERSION_SEAMS.beforeState = () => {
    adoptIfCopied(ref, getSkillState(ref.id, b.env)!, hashOf(ref), b.env, NOW);
    writeFileSync(lock, "4242");
  };
  try {
    assert.deepEqual(write(b, ref, changed(2)), { ok: false, why: "busy" });
  } finally {
    VERSION_SEAMS.beforeState = undefined;
    rmSync(lock, { force: true });
  }
  assert.equal(readFileSync(ref.file, "utf8"), v1, "the old file is back");
  assert.equal(getSkillState(ref.id, b.env)!.hash, skillHash(v1), "and the state still says it is Trail's own, not a hand edit");
});

test("a busy store lock writes nothing", () => {
  const { b, ref } = saved();
  writeFileSync(join(b.trail, "skills", ".store.lock"), "4242");
  try {
    assert.deepEqual(write(b, ref, changed(2)), { ok: false, why: "busy" });
  } finally {
    rmSync(join(b.trail, "skills", ".store.lock"), { force: true });
  }
  assert.ok(!existsSync(versionsDir(ref)));
});

test("R8: a write killed after the file is finished on the next read; a marker with the old file is cleared", () => {
  const { b, ref } = saved();
  const next = renderSkillMd(changed(2));
  updateSkillState(ref.id, (s) => (s ? { ...s, pendingWrite: { hash: skillHash(next), from: 1, at: NOW.toISOString() } } : s), b.env);
  writeFileSync(ref.file, next);
  assert.equal(adoptIfCopied(ref, getSkillState(ref.id, b.env), skillHash(next), b.env, NOW), false);
  let st = getSkillState(ref.id, b.env)!;
  assert.deepEqual([st.hash, st.pendingWrite, st.status], [skillHash(next), null, "candidate"]);
  const t = saved();
  const old = hashOf(t.ref);
  updateSkillState(t.ref.id, (s) => (s ? { ...s, pendingWrite: { hash: "sha256:ffff", from: 1, at: NOW.toISOString() } } : s), t.b.env);
  adoptIfCopied(t.ref, getSkillState(t.ref.id, t.b.env), old, t.b.env, NOW);
  st = getSkillState(t.ref.id, t.b.env)!;
  assert.deepEqual([st.hash, st.pendingWrite], [old, null]);
});

test("extend from a lesson moves it to lessons/.folded; a replace takes the old lessons into the kept version, guardrails stay", () => {
  const { b, ref } = saved();
  const lessons = join(ref.dir, "lessons");
  writeFileSync(join(lessons, "2026-11-01.md"), '---\nid: "ls-1a2b3c"\nkind: "lesson"\nskill: "release-npm"\nsrc: "correction"\nat: "2026-11-01"\n---\nstamp it too: node scripts/stamp.mjs {version}\n');
  writeFileSync(join(lessons, "2026-11-02.md"), '---\nid: "ls-4d5e6f"\nkind: "guardrail"\nskill: "release-npm"\nsrc: "correction"\nat: "2026-11-02"\n---\nnever publish from a dirty tree\n');
  writeFileSync(join(lessons, "2026-11-03.md"), '---\nid: "ls-777777"\nkind: "lesson"\nskill: "release-npm"\nsrc: "correction"\nat: "2026-11-03"\n---\nwait for the mirror\n');
  assert.equal(write(b, ref, changed(2), "extend", ["ls-1a2b3c"]).ok, true);
  assert.deepEqual(readdirSync(join(lessons, ".folded")), ["2026-11-01.md"]);
  assert.deepEqual(readLessons(ref.dir).map((l) => l.id).sort(), ["ls-4d5e6f", "ls-777777"], "a folded lesson stops riding the block");
  const fresh = { ...changed(3, "npm publish --access public --tag latest"), helpers: [{ file: "pack.sh", from: "/tmp/x/pack.sh", content: "#!/bin/sh\nnpm pack\n" }] };
  assert.equal(write(b, ref, fresh, "replace").ok, true);
  assert.deepEqual(readdirSync(join(versionsDir(ref), "v2", "lessons")), ["2026-11-03.md"]);
  assert.deepEqual(readLessons(ref.dir).map((l) => l.id), ["ls-4d5e6f"]);
  assert.deepEqual(readdirSync(join(ref.dir, "scripts")), ["pack.sh"], "R22: a replace writes the fresh compile's helpers");
  assert.deepEqual(readdirSync(join(versionsDir(ref), "v2", "scripts")), ["stamp.sh"]);
});

test("`.versions` and `lessons/.folded` are never listed, recalled or read as lessons", () => {
  const { b, ref } = saved();
  assert.equal(write(b, ref, changed(2)).ok, true);
  const other = compiled("ghost-skill", { trail: "s-0f0f0f" });
  mkdirSync(join(versionsDir(ref), "v1", "nested"), { recursive: true });
  writeFileSync(join(versionsDir(ref), "proposed-v3"), "");
  mkdirSync(join(ref.dir, "lessons", ".folded"), { recursive: true });
  writeFileSync(join(ref.dir, "lessons", ".folded", "2026-11-01.md"), '---\nid: "ls-1a2b3c"\nat: "2026-11-01"\n---\nfolded already\n');
  writeFileSync(join(versionsDir(ref), "v1", "nested", "SKILL.md"), renderSkillMd(other));
  assert.deepEqual(listAllPersonal(b.env).map((r) => r.name), ["release-npm"]);
  const ctx = { repoKeys: [SHOP], checkout: b.checkout, env: b.env };
  assert.deepEqual(listSkills(ctx).map((r) => r.name), ["release-npm"]);
  assert.deepEqual(candidatesHere(ctx).cands.map((c) => c.ref.name), ["release-npm"]);
  assert.deepEqual(readLessons(ref.dir), []);
});

/* ----------------------------------------------------------- hand edits */

function handEdited(): { b: Box; ref: SkillRef; mine: string } {
  const s = saved();
  const mine = `${readFileSync(s.ref.file, "utf8")}\nMy own note about the mirror.\n`;
  writeFileSync(s.ref.file, mine);
  return { ...s, mine };
}

test("a hand-edited file gets only proposed-v<n> and a diff; the person's file stays and is kept as hand-<date>", () => {
  const { b, ref, mine } = handEdited();
  const p = writeProposal(ref, changed(2), "update", b.env, NOW)!;
  assert.equal(readFileSync(ref.file, "utf8"), mine, "SKILL.md untouched");
  assert.equal(p.path, join(versionsDir(ref), "proposed-v2", "SKILL.md"));
  assert.equal(readFileSync(p.path, "utf8"), renderSkillMd(changed(2)));
  assert.equal(p.hand, "hand-2026-11-12");
  assert.equal(readFileSync(join(versionsDir(ref), p.hand, "SKILL.md"), "utf8"), mine);
  assert.match(p.diff, /^--- release-npm\/SKILL\.md \(yours\)$/m);
  assert.match(p.diff, /^\+.*--tag next/m);
  assert.deepEqual(getSkillState(ref.id, b.env)!.proposed, { hash: skillHash(renderSkillMd(changed(2))), version: 2, op: "update", at: NOW.toISOString() });
  assert.deepEqual(listVersions(ref), [], "no version is written for a proposal");
});

test("a second proposal replaces the first", () => {
  const { b, ref } = handEdited();
  writeProposal(ref, changed(2), "update", b.env, NOW);
  writeProposal(ref, changed(3, "npm publish --tag beta"), "replace", b.env, NOW);
  assert.deepEqual(readdirSync(versionsDir(ref)).filter((n) => n.startsWith("proposed-")), ["proposed-v3"]);
  assert.equal(getSkillState(ref.id, b.env)!.proposed!.version, 3);
});

test("adopt after the person's cp: Trail takes the file as its own; a near copy never adopts", () => {
  const { b, ref } = handEdited();
  const p = writeProposal(ref, changed(2), "update", b.env, NOW)!;
  const near = `${readFileSync(p.path, "utf8")} `;
  writeFileSync(ref.file, near);
  assert.equal(adoptIfCopied(ref, getSkillState(ref.id, b.env), skillHash(near), b.env, NOW), false);
  assert.ok(getSkillState(ref.id, b.env)!.proposed);
  cpSync(p.path, ref.file);
  assert.equal(adoptIfCopied(ref, getSkillState(ref.id, b.env), hashOf(ref), b.env, NOW), true);
  const st = getSkillState(ref.id, b.env)!;
  assert.deepEqual([st.hash, st.status, st.proposed], [hashOf(ref), "candidate", null]);
  assert.deepEqual(readLedger(ref.id, b.env).filter((l) => l.event === "changed").map((l) => l.event === "changed" && [l.op, l.from, l.to]), [["adopted", 1, 2]]);
  assert.equal(adoptIfCopied(ref, getSkillState(ref.id, b.env), hashOf(ref), b.env, NOW), false, "once");
});

test("recall adopts a copied proposal when it reads the skill (candidatesHere)", () => {
  const { b, ref } = handEdited();
  const p = writeProposal(ref, changed(2), "update", b.env, NOW)!;
  cpSync(p.path, ref.file);
  const r = candidatesHere({ repoKeys: [SHOP], checkout: b.checkout, env: b.env });
  assert.deepEqual(r.adopted, ["release-npm"]);
  assert.equal(getSkillState(ref.id, b.env)!.hash, hashOf(ref));
});

/* -------------------------------------------------------------- restore */

test("restore v1 as v3 with v2 kept; its version line says 3", () => {
  const { b, ref } = saved();
  const v1 = readFileSync(ref.file, "utf8");
  assert.equal(write(b, ref, changed(2)).ok, true);
  const v2 = readFileSync(ref.file, "utf8");
  assert.deepEqual(restoreVersion(ref, 1, b.env, NOW), { ok: true, version: 3 });
  assert.equal(readFileSync(join(versionsDir(ref), "v2", "SKILL.md"), "utf8"), v2);
  assert.equal(readFileSync(ref.file, "utf8"), v1.replace('version: "1"', 'version: "3"'));
  assert.deepEqual(listVersions(ref), [1, 2]);
  const last = readLedger(ref.id, b.env).filter((l) => l.event === "changed").pop();
  assert.deepEqual(last && last.event === "changed" && [last.op, last.from, last.to], ["restore-version", 2, 3]);
  assert.equal(getSkillState(ref.id, b.env)!.hash, hashOf(ref));
});

test("a restore keeps the person's edited file as hand-<date> first (R6); an unknown version is unknown", () => {
  const { b, ref } = saved();
  assert.equal(write(b, ref, changed(2)).ok, true);
  const mine = `${readFileSync(ref.file, "utf8")}\nMine.\n`;
  writeFileSync(ref.file, mine);
  assert.deepEqual(restoreVersion(ref, 7, b.env, NOW), { ok: false, why: "unknown" });
  assert.equal(restoreVersion(ref, 1, b.env, NOW).ok, true);
  assert.equal(readFileSync(join(versionsDir(ref), "hand-2026-11-12", "SKILL.md"), "utf8"), mine);
});
