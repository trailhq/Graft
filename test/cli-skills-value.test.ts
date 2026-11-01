/**
 * Phase 2 c5 (design 3.6, 4.14, P27): `trail skills` has the weekly value
 * line on top, any day once the first week is over, and sends
 * `skill_value{list}` when it says it; `--json` carries it as `value`.
 * Made-up homes, a made-up acme/shop checkout and made-up skills only.
 */
process.env.TZ = "UTC";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { registerSkillCommands } from "../src/skills/cli-skills.js";
import { savePersonal } from "../src/skills/store.js";
import { appendLedger } from "../src/skills/ledger.js";
import { markValueSaid, noteValue } from "../src/skills/value-line.js";
import { tmpRepo } from "./helpers.js";
import { compiled } from "./skills-store-fixtures.js";

const SHOP = "github.com/acme/shop";
const NOW = "2026-10-22T09:00:00.000Z";
const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

interface Box { env: NodeJS.ProcessEnv; checkout: string }
function box(tag: string, onSince: string | null = "2026-10-01T09:00:00.000Z", skills = "on"): Box {
  const home = tmpRepo(`c5-cli-${tag}`);
  made.push(home);
  const env: NodeJS.ProcessEnv = { HOME: home, TRAIL_HOME: join(home, "trail-home"), TRAIL_TEST_NOW: NOW, PATH: process.env.PATH };
  mkdirSync(env.TRAIL_HOME!, { recursive: true });
  writeFileSync(join(env.TRAIL_HOME!, "settings.json"), JSON.stringify({ v: 1, skills, onSince }));
  const checkout = join(home, "src", "shop");
  mkdirSync(checkout, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: checkout });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/shop.git"], { cwd: checkout });
  return { env, checkout };
}

function seed(b: Box): void {
  const c = compiled("release-npm", { trail: "s-7f3a2c", applies: SHOP });
  savePersonal(c, { from: "repeated", runId: "r-1027-3f9a", consent: "offer-yes", stepsVerified: 2, env: b.env, now: new Date("2026-10-02T11:00:00.000Z") });
  for (const [i, at] of ["2026-10-19T10:00:00.000Z", "2026-10-21T10:00:00.000Z"].entries()) {
    appendLedger("s-7f3a2c", {
      at, event: "use", useId: `u-00000${i}`, skill: "s-7f3a2c", v: "1", host: "claude", cue: "job", repo: SHOP,
      stepsRan: [1, 2], failedStep: null, readyFailed: [], check: "passed", calls: 4, failed: 0,
    }, b.env);
  }
  noteValue(SHOP, { guardrailStops: 2 }, b.env, new Date("2026-10-20T10:00:00.000Z"));
}

async function trail(b: Box, args: string[]): Promise<{ code: number; out: string[]; sent: Array<[string, Record<string, string>]> }> {
  const program = new Command();
  const out: string[] = [];
  const sent: Array<[string, Record<string, string>]> = [];
  let code = 0;
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerSkillCommands(program, { env: b.env, cwd: () => b.checkout, track: (e, p) => sent.push([e, p]), out: (l) => out.push(l), err: () => undefined, exit: (c) => { code = c; } });
  try {
    await program.parseAsync(["node", "trail", ...args]);
  } catch (e) {
    if (!(e instanceof CommanderError)) throw e;
    code = e.exitCode;
  }
  return { code, out, sent };
}

const LINE = "Last week in this repo, on this machine: release-npm ran 2 times, 0 failed commands in all; the timeout learning stopped 2 commands.";

test("trail skills: the value line is on top, and skill_value{list} says it went out", async () => {
  const b = box("top");
  seed(b);
  const r = await trail(b, ["skills"]);
  assert.equal(r.code, 0);
  assert.equal(r.out[0], LINE);
  assert.match(r.out[1] ?? "", /^release-npm/);
  assert.deepEqual(r.sent.filter(([e]) => e === "skill_value"), [["skill_value", { channel: "list" }]]);
});

test("trail skills: any day, even the week SessionStart already said it", async () => {
  const b = box("any-day");
  seed(b);
  assert.equal(markValueSaid(SHOP, b.env, new Date(NOW)), true);
  assert.equal((await trail(b, ["skills"])).out[0], LINE);
});

test("trail skills --json carries the line as value", async () => {
  const b = box("json");
  seed(b);
  const r = await trail(b, ["skills", "--json"]);
  assert.equal(JSON.parse(r.out.join("\n")).value, LINE);
  assert.deepEqual(r.sent.filter(([e]) => e === "skill_value"), [["skill_value", { channel: "list" }]]);
});

test("trail skills: no value line in the first week, with skills off, outside a repo, or with nothing to say; no skill_value then", async () => {
  for (const [tag, b] of [
    ["first-week", box("first-week", "2026-10-17T09:00:00.000Z")],
    ["off", box("off", "2026-10-01T09:00:00.000Z", "off")],
  ] as const) {
    seed(b);
    const r = await trail(b, ["skills"]);
    assert.ok(!r.out.some((l) => l.startsWith("Last week")), `${tag}: ${r.out.join("\n")}`);
    assert.deepEqual(r.sent.filter(([e]) => e === "skill_value"), [], tag);
  }
  const outside = box("outside");
  seed(outside);
  const r = await trail({ ...outside, checkout: join(outside.env.HOME!, "src") }, ["skills"]);
  assert.ok(!r.out.some((l) => l.startsWith("Last week")), r.out.join("\n"));
  const quiet = box("quiet");
  const q = await trail(quiet, ["skills"]);
  assert.equal(q.out[0], "no skills yet");
  assert.deepEqual(q.sent.filter(([e]) => e === "skill_value"), []);
});

test("trail skills --json keeps one shape: value is null, never missing, when skills are off, in the first week or outside a repo (c5 review)", async () => {
  const on = box("json-on");
  seed(on);
  const keys = Object.keys(JSON.parse((await trail(on, ["skills", "--json"])).out.join("\n"))).sort();
  assert.ok(keys.includes("value"));
  for (const [tag, b] of [["off", box("json-off", "2026-10-01T09:00:00.000Z", "off")], ["first-week", box("json-week", "2026-10-17T09:00:00.000Z")]] as const) {
    seed(b);
    const j = JSON.parse((await trail(b, ["skills", "--json"])).out.join("\n"));
    assert.deepEqual(Object.keys(j).sort(), keys, tag);
    assert.equal(j.value, null, tag);
  }
  const outside = box("json-outside");
  seed(outside);
  const j = JSON.parse((await trail({ ...outside, checkout: join(outside.env.HOME!, "src") }, ["skills", "--json"])).out.join("\n"));
  assert.equal(j.value, null);
});

/** A use line with phase 2's fidelity facts (c0's shape; c3 writes them at the credit flush). */
function useWith(b: Box, i: number, fid: { ran: number; missing: number; extra: number; changed: number } | null): void {
  appendLedger("s-7f3a2c", {
    at: `2026-10-2${i % 10}T10:00:00.000Z`, event: "use", useId: `u-1000${i}`, skill: "s-7f3a2c", v: "1", host: "claude", cue: "job", repo: SHOP,
    stepsRan: [1, 2], failedStep: null, readyFailed: [], check: "passed", calls: 4, failed: 0, ...(fid ? { fid } : {}),
  }, b.env);
}

test("trail skills show: a fidelity line from the uses whose counts the ledger kept, and none before there are any", async () => {
  const b = box("show-fid");
  seed(b);
  const none = await trail(b, ["skills", "show", "release-npm"]);
  assert.equal(none.code, 0);
  assert.ok(!none.out.some((l) => l.includes("how its last")), none.out.join("\n"));
  useWith(b, 1, { ran: 2, missing: 0, extra: 0, changed: 0 });
  useWith(b, 2, { ran: 1, missing: 1, extra: 1, changed: 0 });
  useWith(b, 3, null);
  useWith(b, 4, { ran: 2, missing: 0, extra: 0, changed: 1 });
  const r = await trail(b, ["skills", "show", "release-npm"]);
  assert.ok(r.out.includes("· how its last 3 uses with counts on this machine went: every step ran as kept in 1 · a step was left out in 1 · a step ran another way in 1 · an extra command ran in 1"), r.out.join("\n"));
});

test("trail skills show: the fidelity line reads the last 10 uses with counts", async () => {
  const b = box("show-fid-10");
  seed(b);
  for (let i = 0; i < 12; i++) useWith(b, i, { ran: 2, missing: i < 2 ? 1 : 0, extra: 0, changed: 0 });
  const r = await trail(b, ["skills", "show", "release-npm"]);
  assert.ok(r.out.includes("· how its last 10 uses with counts on this machine went: every step ran as kept in 10"), r.out.join("\n"));
});
