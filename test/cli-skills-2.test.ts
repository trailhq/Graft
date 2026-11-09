/**
 * Phase 2's CLI (design 1.2, 3.6): `trail skills update` prints the gate's
 * two lines and sends `skill_changed{op}`; `trail skills restore <name>
 * --version <n>` is the person's only and reaches the restore past the CLI's
 * own `--version`; `trail skills draft <run> --print` prints an offered
 * change as a diff; `trail skills show` lists the versions kept. In process
 * through commander, sandbox Trail homes, made-up skills and runs only.
 */
process.env.TZ = "UTC";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Command, CommanderError } from "commander";
import { registerSkillCommands } from "../src/skills/cli-skills.js";
import { liftRestoreVersion } from "../src/skills/cli-skills-2.js";
import type { PersonDeps, PsRow } from "../src/skills/person.js";
import { listAllPersonal } from "../src/skills/store.js";
import { listVersions, writeNewVersion } from "../src/skills/versions.js";
import { skillHash } from "../src/skills/skillmd.js";
import { T, prompt } from "./skills-consent-fixtures.js";
import { blockRun, cleanup, keptSkill, mk, offerAtStop, runUpdate, sayLines, updateCmd } from "./skills-update-fixtures.js";
import type { Box } from "./skills-consent-fixtures.js";

after(cleanup);
const rows = (...chain: Array<[string, string]>): PsRow[] => chain.map(([comm, args], i) => ({ pid: 4242 - i, ppid: i === chain.length - 1 ? 1 : 4241 - i, comm, args }));
const PERSON: PersonDeps = { stdinTTY: true, stdoutTTY: true, pid: 4242, ps: () => rows(["/usr/local/bin/node", "node /usr/local/bin/trail skills"], ["/bin/zsh", "-zsh"]) };
const AGENT: PersonDeps = { ...PERSON, stdinTTY: false };

interface Ran { code: number; out: string[]; err: string; tracked: Array<[string, Record<string, string>]> }
/** The CLI as cli.ts builds it: the root program has its own `-v, --version`. */
async function trail(b: Box, args: string[], person: PersonDeps = PERSON, now = T(400)): Promise<Ran> {
  const program = new Command();
  const out: string[] = [];
  const tracked: Ran["tracked"] = [];
  let err = "";
  let code = 0;
  program.exitOverride();
  program.version("0.26.0", "-v, --version");
  program.configureOutput({ writeOut: (s) => out.push(s.replace(/\n$/, "")), writeErr: (s) => { err += s; } });
  registerSkillCommands(program, {
    env: b.env, cwd: () => b.repo, personDeps: person, now: () => now,
    track: (e, p) => { tracked.push([e, p]); }, out: (l) => out.push(l), err: (l) => { err += `${l}\n`; }, exit: (c) => { code = c; },
  });
  try {
    await program.parseAsync(["node", "trail", ...args]);
  } catch (e) {
    if (!(e instanceof CommanderError)) throw e;
    code = e.exitCode;
  }
  return { code, out, err, tracked };
}

/** release-npm with v2 written, so v1 is kept. */
function twoVersions(): { b: Box; v1: string } {
  const b = mk();
  const { ref, skill } = keptSkill(b);
  const v1 = readFileSync(ref.file, "utf8");
  const next = { ...skill, meta: { ...skill.meta, version: "2" }, steps: skill.steps.map((s, i) => (i === 0 ? { ...s, cmd: "npm ci --prefer-offline" } : s)) };
  const w = writeNewVersion(ref, next, { op: "update", offerId: null, baseHash: skillHash(v1), env: b.env, now: T(60) });
  assert.equal(w.ok, true);
  return { b, v1 };
}

test("liftRestoreVersion takes --version out of a restore only", () => {
  assert.deepEqual(liftRestoreVersion(["node", "trail", "skills", "restore", "x", "--version", "2"]), { argv: ["node", "trail", "skills", "restore", "x"], version: "2" });
  assert.deepEqual(liftRestoreVersion(["node", "trail", "skills", "restore", "--version=3", "x"]), { argv: ["node", "trail", "skills", "restore", "x"], version: "3" });
  assert.deepEqual(liftRestoreVersion(["node", "trail", "skills", "restore", "x", "--version"]), { argv: ["node", "trail", "skills", "restore", "x"], version: "" });
  assert.deepEqual(liftRestoreVersion(["node", "trail", "--version"]), { argv: ["node", "trail", "--version"] });
  assert.deepEqual(liftRestoreVersion(["node", "trail", "skills", "show", "x", "--version"]), { argv: ["node", "trail", "skills", "show", "x", "--version"] });
});

test("restore --version as the person: v1 back as v3, v2 kept, skill_changed{restore-version}; not Trail's own version", async () => {
  const { b, v1 } = twoVersions();
  const r = await trail(b, ["skills", "restore", "release-npm", "--version", "1"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out, ["✓ release-npm has v1's steps again, as v3 · go back: trail skills restore release-npm --version 2"]);
  assert.deepEqual(r.tracked, [["skill_changed", { op: "restore-version" }]]);
  const ref = listAllPersonal(b.env)[0]!;
  assert.equal(readFileSync(ref.file, "utf8"), v1.replace('version: "1"', 'version: "3"'));
  assert.deepEqual(listVersions(ref), [1, 2]);
});

test("restore --version run by an agent is refused with who may run it, and nothing changes", async () => {
  const { b } = twoVersions();
  const ref = listAllPersonal(b.env)[0]!;
  const before = readFileSync(ref.file, "utf8");
  const r = await trail(b, ["skills", "restore", "release-npm", "--version", "1"], AGENT);
  assert.equal(r.code, 1);
  assert.equal(r.err, "Only the person can run this, in their own terminal: trail skills restore release-npm --version 1\n");
  assert.equal(readFileSync(ref.file, "utf8"), before);
  assert.deepEqual(r.tracked, []);
});

test("restore --version of a version not kept, or with no number, says so", async () => {
  const { b } = twoVersions();
  assert.match((await trail(b, ["skills", "restore", "release-npm", "--version", "7"])).err, /keeps no v7/);
  assert.match((await trail(b, ["skills", "restore", "release-npm", "--version"])).err, /--version takes a version number/);
});

test("show lists the versions kept", async () => {
  const { b } = twoVersions();
  const r = await trail(b, ["skills", "show", "release-npm"]);
  assert.ok(r.out.includes("· older versions kept: v1; bring one back in your own terminal: trail skills restore release-npm --version <n>"), r.out.join("\n"));
});

test("update with no yes: exit 1, the gate's words, no telemetry", async () => {
  const b = mk();
  keptSkill(b);
  const r = await trail(b, ["skills", "update", "release-npm", "--offer", "o-1a2b3c"], AGENT);
  assert.equal(r.code, 1);
  assert.equal(r.err, "trail · not changed: the person didn't say yes to this change.\n");
  assert.deepEqual(r.tracked, []);
  assert.notEqual((await trail(b, ["skills", "update", "release-npm"], AGENT)).code, 0, "--offer is required");
  assert.notEqual((await trail(b, ["skills", "update", "release-npm", "--offer", "o-1", "--offer", "o-2"], AGENT)).code, 0, "once");
});

test("draft --print on an offered run prints the change; update after the yes writes it and sends skill_changed{update}", async () => {
  const b = mk();
  const { skill } = keptSkill(b);
  blockRun(b, skill, 100);
  const { offer, runId } = offerAtStop(b, 150);
  const d = await trail(b, ["skills", "draft", runId, "--print"], AGENT);
  assert.equal(d.code, 0, d.err);
  assert.match(d.out.join("\n"), /^--- release-npm\/SKILL\.md now$/m);
  assert.match(d.out.join("\n"), /^\+4\. .*npm publish \.\/dist\/acme-cli-\{version\}\.tgz/m);
  sayLines(b, 152, offer);
  prompt(b, 160, "yes");
  // PreToolUse writes the receipt (the CLI half the fixture would run is skipped: commander runs it here).
  const pre = runUpdate(b, 170, updateCmd(offer), { name: "not-this-one" });
  assert.equal(pre.decision, null);
  const r = await trail(b, ["skills", "update", "release-npm", "--offer", offer.offerId], AGENT, T(171));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out[0]!, /^✓ changed release-npm to v2 · step 4 is now /);
  assert.deepEqual(r.tracked, [["skill_changed", { op: "update" }]]);
});
