/**
 * Phase 2 c5 (design 4.14, 1.5, P19 to P21): the weekly value line. It counts
 * only what this machine kept: ledger use lines for the skills that apply in
 * this repo, and value.json's guardrail stops and wall fixes per local day.
 * Said once in 7 days per repo, never in the first week after skills turned
 * on, never after a clear or a compaction, never headless or in a subagent.
 * Made-up homes, repos (acme/shop) and skills only; no typed words anywhere.
 */
process.env.TZ = "UTC";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { compiled } from "./skills-store-fixtures.js";
import { savePersonal } from "../src/skills/store.js";
import { appendLedger } from "../src/skills/ledger.js";
import { updateSkillState } from "../src/skills/state.js";
import type { LedgerUse } from "../src/skills/types.js";
import {
  VALUE_COPY, guardrailStopsIn, markValueSaid, noteValue, startValue, valueContext, valueCounts, valueDue, valueLine, valuePath,
  valueWeek, valueWords,
} from "../src/skills/value-line.js";
import { timeBar } from "./machine-speed.js";

const SHOP = "github.com/acme/shop";
const OTHER = "github.com/acme/storefront";
/** Skills on since Oct 1; "now" is Thursday Oct 22, so the week is Oct 16 to 22 (local days, UTC here). */
const ON_SINCE = "2026-10-01T09:00:00.000Z";
const NOW = new Date("2026-10-22T09:00:00.000Z");
const day = (d: number, h = 10) => new Date(Date.UTC(2026, 9, d, h, 0, 0)).toISOString();

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

interface Box { env: NodeJS.ProcessEnv; trail: string; home: string }
function box(tag: string, settings: Record<string, unknown> = { v: 1, skills: "on", onSince: ON_SINCE }): Box {
  const home = tmpRepo(`c5-value-${tag}`);
  made.push(home);
  const trail = join(home, "trail-home");
  mkdirSync(trail, { recursive: true });
  writeFileSync(join(trail, "settings.json"), JSON.stringify(settings));
  return { env: { HOME: home, TRAIL_HOME: trail }, trail, home };
}

let n = 0;
/** A personal skill with an id of its own, the run it came from (`failed` of `commands`), and `uses` in its state. */
function skill(b: Box, name: string, o: { id?: string; applies?: string; uses?: number; source?: { commands: number; failed: number } | null } = {}): string {
  const id = o.id ?? `s-${(0xa00000 + ++n).toString(16)}`;
  const source = o.source === null ? undefined : { runId: `r-${name}`, commands: o.source?.commands ?? 23, failed: o.source?.failed ?? 4, at: day(1) };
  const c = compiled(name, { trail: id, applies: o.applies ?? SHOP }, source ? { source } : {});
  const saved = savePersonal(c, { from: "repeated", runId: `r-${name}`, consent: "offer-yes", stepsVerified: 2, env: b.env, now: new Date(day(1)) });
  assert.equal(saved.id, id, JSON.stringify(saved));
  if (o.source === null) updateSkillState(id, (s) => (s ? { ...s, source: null } : s), b.env);
  if (o.uses !== undefined) updateSkillState(id, (s) => (s ? { ...s, uses: o.uses! } : s), b.env);
  return id;
}

function use(b: Box, id: string, at: string, o: Partial<LedgerUse> = {}): void {
  appendLedger(id, {
    at, event: "use", useId: `u-${(++n).toString(16).padStart(6, "0")}`, skill: id, v: "1", host: "claude", cue: "job", repo: SHOP,
    stepsRan: [1, 2], failedStep: null, readyFailed: [], check: "passed", calls: 5, failed: 0, ...o,
  }, b.env);
}

function valueFile(b: Box): any {
  return JSON.parse(readFileSync(valuePath(b.env), "utf8"));
}

test("VALUE_COPY says where the count comes from: this repo, on this machine", () => {
  const all = JSON.stringify(VALUE_COPY);
  assert.match(VALUE_COPY.head, /on this machine/);
  assert.doesNotMatch(all, /—|\b(?:notes?|rules?|memory|remember\w*|workflows?)\b/i);
});

test("the counts equal the ledger sums for a seeded week: uses in this repo, inside the 7 local days, and value.json's days", () => {
  const b = box("counts");
  const rel = skill(b, "release-npm", { uses: 9, source: { commands: 23, failed: 4 } });
  const dep = skill(b, "deploy-beta", { uses: 3, source: { commands: 12, failed: 0 } });
  // In the week: Oct 16 (the first day of it) to Oct 22.
  use(b, rel, day(16), { failed: 1 });
  use(b, rel, day(18), { failed: 0, check: "none" });
  use(b, rel, day(22, 8), { failed: 2 });
  use(b, dep, day(20), { failed: 0 });
  // Outside it: Oct 15 (8 days back), another repo, a time after now.
  use(b, rel, day(15, 23), { failed: 7 });
  use(b, rel, day(19), { failed: 5, repo: OTHER });
  use(b, dep, day(22, 23), { failed: 3 });
  noteValue(SHOP, { guardrailStops: 2, wallFixes: 1 }, b.env, new Date(day(17)));
  noteValue(SHOP, { guardrailStops: 3 }, b.env, new Date(day(21)));
  noteValue(SHOP, { guardrailStops: 50, wallFixes: 50 }, b.env, new Date(day(14))); // the week before
  noteValue(OTHER, { guardrailStops: 40 }, b.env, new Date(day(21)));
  const c = valueCounts([SHOP], b.env, NOW);
  assert.deepEqual(c.skills.map((s) => [s.name, s.uses, s.checked, s.failed, s.before]), [
    ["release-npm", 3, 2, 3, { commands: 23, failed: 4 }],
    ["deploy-beta", 1, 1, 0, { commands: 12, failed: 0 }],
  ]);
  assert.equal(c.guardrailStops, 5);
  assert.equal(c.wallFixes, 1);
  assert.equal(valueLine([SHOP], b.env, NOW),
    "Last week in this repo, on this machine: release-npm ran 3 times, 3 failed commands in all; "
    + "deploy-beta ran 1 time with 0 failed commands; the timeout learning stopped 5 commands; "
    + "1 known error came with its fix.");
});

test("parts at 0 are left out: no uses this week, no stops, no fixes, a source with 0 failed or none", () => {
  const b = box("zeros");
  const rel = skill(b, "release-npm", { uses: 4, source: { commands: 9, failed: 0 } });
  const idle = skill(b, "deploy-beta", { uses: 8 });
  const plain = skill(b, "tag-version", { uses: 1, source: null });
  use(b, rel, day(20), { failed: 0 });
  use(b, plain, day(21), { failed: 1 });
  use(b, idle, day(2)); // weeks ago
  assert.equal(valueLine([SHOP], b.env, NOW),
    "Last week in this repo, on this machine: release-npm ran 1 time with 0 failed commands; tag-version ran 1 time with 1 failed command.");
  noteValue(SHOP, { wallFixes: 2 }, b.env, new Date(day(21)));
  assert.match(valueLine([SHOP], b.env, NOW)!, /; 2 known errors came with their fix\.$/);
  assert.doesNotMatch(valueLine([SHOP], b.env, NOW)!, /guardrail/);
});

test("nothing to say gives null: no skills, no uses this week, and no stops or fixes", () => {
  const b = box("empty");
  assert.equal(valueLine([SHOP], b.env, NOW), null);
  const id = skill(b, "release-npm", { uses: 2 });
  use(b, id, day(3));
  noteValue(SHOP, { guardrailStops: 0, wallFixes: 0 }, b.env, NOW);
  assert.equal(valueLine([SHOP], b.env, NOW), null);
  assert.equal(existsSync(valuePath(b.env)), false, "a count of 0 writes nothing");
  assert.equal(valueWords({ skills: [], guardrailStops: 0, wallFixes: 0 }), null);
});

test("at most 5 skills are read, most used first, and only the last 64 KB of each ledger", () => {
  const b = box("five");
  const ids = [1, 2, 3, 4, 5, 6].map((i) => skill(b, `job-${i}`, { uses: 10 * i }));
  for (const id of ids) use(b, id, day(20));
  const names = valueCounts([SHOP], b.env, NOW).skills.map((s) => s.name);
  assert.deepEqual(names, ["job-6", "job-5", "job-4", "job-3", "job-2"]);
  // A use pushed out of the last 64 KB by later lines (outside the week) is not read.
  const big = skill(b, "big-one", { uses: 100 });
  use(b, big, day(21), { failed: 9 });
  for (let i = 0; i < 400; i++) use(b, big, day(2), { failed: 0 });
  const got = valueCounts([SHOP], b.env, NOW).skills.find((s) => s.name === "big-one");
  assert.equal(got, undefined, `the tail holds no use this week: ${JSON.stringify(got)}`);
});

test("the line is at most 240 characters, cut at whole parts so no number is cut", () => {
  const b = box("cut");
  const long = (i: number) => `release-acme-cli-${i}-from-the-main-branch-to-npm`;
  for (let i = 1; i <= 5; i++) use(b, skill(b, long(i), { uses: 10 - i, source: { commands: 99, failed: 11 } }), day(20), { failed: 12 });
  noteValue(SHOP, { guardrailStops: 9, wallFixes: 3 }, b.env, new Date(day(21)));
  const line = valueLine([SHOP], b.env, NOW)!;
  assert.ok(line.length <= 240, `${line.length}: ${line}`);
  assert.ok(line.endsWith("."), line);
  // The first skill, the guardrail and the fixes come before later skills, and each part is whole.
  assert.match(line, new RegExp(`${long(1)} ran 1 time with 12 failed commands \\(the run it came from had 11\\)`));
  assert.match(line, /the timeout learning stopped 9 commands/);
  assert.match(line, /3 known errors came with their fix\.$/);
  for (const part of line.replace(/^[^:]+: /, "").replace(/\.$/, "").split("; ")) {
    assert.match(part, /^(?:\S+ ran 1 time with \d+ failed commands?(?: \(the run it came from had \d+\))?|\S+ ran \d+ times, \d+ failed commands? in all|the timeout learning stopped \d+ commands?|\d+ known errors? came with (?:its|their) fix)$/, part);
  }
});

test("once in 7 days per repo: due, said, not due for 6 days, due on the 7th; another repo keeps its own week", () => {
  const b = box("weekly");
  assert.equal(valueDue(SHOP, b.env, NOW), true);
  assert.equal(markValueSaid(SHOP, b.env, NOW), true);
  assert.equal(valueFile(b).repos[SHOP].saidAt, "2026-10-22");
  for (const d of [22, 23, 25, 28]) assert.equal(valueDue(SHOP, b.env, new Date(day(d))), false, `Oct ${d}`);
  assert.equal(valueDue(SHOP, b.env, new Date(day(29))), true, "Oct 29, 7 days on");
  assert.equal(valueDue(OTHER, b.env, NOW), true);
});

test("never in the first 7 days after skills turned on, and never with skills off; offers off doesn't silence it", () => {
  assert.equal(valueDue(SHOP, box("week1", { v: 1, skills: "on", onSince: "2026-10-16T09:00:01.000Z" }).env, NOW), false);
  assert.equal(valueWeek(box("week1b", { v: 1, skills: "on", onSince: "2026-10-16T09:00:01.000Z" }).env, NOW), false);
  assert.equal(valueDue(SHOP, box("week1c", { v: 1, skills: "on", onSince: "2026-10-15T09:00:00.000Z" }).env, NOW), true);
  assert.equal(valueDue(SHOP, box("on-null", { v: 1, skills: "on", onSince: null }).env, NOW), false);
  assert.equal(valueDue(SHOP, box("off", { v: 1, skills: "off", onSince: ON_SINCE }).env, NOW), false);
  assert.equal(valueDue(SHOP, box("offers-off", { v: 1, skills: "on", onSince: ON_SINCE, offers: "off", offersOffAt: ON_SINCE }).env, NOW), true);
});

const start = (o: Partial<Parameters<typeof startValue>[0]> = {}) =>
  ({ source: "startup", learn: true, subagent: false, host: "claude" as const, repoKey: SHOP, ...o });

test("at session start: startup and resume only, interactive and top level only, said once, D107-shaped context", () => {
  const b = box("start");
  const id = skill(b, "release-npm", { uses: 3 });
  use(b, id, day(20), { failed: 0 });
  use(b, id, day(27), { failed: 0 });
  for (const source of ["clear", "compact"]) assert.equal(startValue(start({ source }), b.env, NOW), null, source);
  assert.equal(startValue(start({ learn: false }), b.env, NOW), null, "headless (learn off)");
  assert.equal(startValue(start({ subagent: true }), b.env, NOW), null, "a subagent");
  assert.equal(startValue(start({ repoKey: "" }), b.env, NOW), null, "not in a repo");
  assert.equal(existsSync(valuePath(b.env)), false, "none of those spent the week");
  const r = startValue(start(), b.env, NOW);
  assert.equal(r?.channel, "context");
  assert.equal(r?.notice, undefined);
  assert.equal(r?.context, valueContext(valueLine([SHOP], b.env, NOW)!));
  assert.equal(startValue(start({ source: "resume" }), b.env, NOW), null, "said this week already");
  assert.ok(startValue(start({ source: "resume" }), b.env, new Date(day(29))), "a resume a week later says it");
});

test("nothing to say spends nothing: the week stays due for the next session that has a count", () => {
  const b = box("nothing");
  assert.equal(startValue(start(), b.env, NOW), null);
  assert.equal(valueDue(SHOP, b.env, NOW), true);
});

test("where the host shows a SessionStart notice, the line is a notice for the person, not context", () => {
  const b = box("notice");
  use(b, skill(b, "release-npm", { uses: 3 }), day(20));
  const env = { ...b.env, TRAIL_HOST_FACTS: JSON.stringify({ claude: { startNotice: true } }) };
  const r = startValue(start(), env, NOW);
  assert.equal(r?.channel, "notice");
  assert.equal(r?.context, undefined);
  assert.equal(r?.notice, `trail: ${valueLine([SHOP], b.env, NOW)}`);
});

test("the context has the D107 shape: Trail's opening, why, for the person, one line, no recital order or em dash", () => {
  const line = "Last week in this repo, on this machine: release-npm ran 3 times, 0 failed commands in all.";
  const c = valueContext(line);
  assert.ok(c.startsWith("[trail] From Trail, the tool this person installed to keep commands that worked as skills. "), c);
  assert.ok(c.includes(`Its weekly count for this repo, for the person: "${line}"`), c);
  assert.match(c, /Tell them once at the start of your first reply, in one line, then go on with what they asked\.$/);
  assert.equal(c.split("\n").length, 1);
  assert.equal((c.match(/\[trail\]/g) ?? []).length, 1);
  assert.doesNotMatch(c, /don'?t ask|do not ask|covers both|covers all|word for word|verbatim|exactly|before anything else|run this now|—/i);
  const odd = valueContext('x "quoted" [trail] y\nsecond line');
  assert.equal(odd.split("\n").length, 1);
  assert.equal((odd.match(/\[trail\]/g) ?? []).length, 1, odd);
  assert.doesNotMatch(odd.slice(odd.indexOf(": \"") + 3, odd.lastIndexOf("\" Tell")), /"/, odd);
});

test("a busy value.json lock drops the count and never waits over 50 ms", () => {
  // The same call with the lock free, for what the work itself takes on this machine.
  const free = box("busy-free");
  noteValue(SHOP, { guardrailStops: 1 }, free.env, NOW);
  const f0 = Date.now();
  noteValue(SHOP, { guardrailStops: 1 }, free.env, NOW);
  const work = Date.now() - f0;
  const b = box("busy");
  noteValue(SHOP, { guardrailStops: 1 }, b.env, NOW);
  writeFileSync(`${valuePath(b.env)}.lock`, "4242");
  const t0 = Date.now();
  noteValue(SHOP, { guardrailStops: 5, wallFixes: 5 }, b.env, NOW);
  const waited = Date.now() - t0;
  // Over the work itself, so a slow machine's work doesn't count as waiting; a 200 ms wait still shows.
  assert.ok(waited - work < 190, `waited ${waited} ms (the work alone ${work} ms): the hook lock wait is 50 ms, not 1a's 200`);
  assert.deepEqual(valueFile(b).repos[SHOP].days, { "2026-10-22": { g: 1, w: 0 } }, "the busy count is dropped");
  assert.equal(markValueSaid(SHOP, b.env, NOW), false, "a busy lock says so");
  assert.equal(startValue(start(), b.env, NOW), null, "and SessionStart says nothing then");
});

test("no typed text in value.json: counts, local days and repo keys only; a key that isn't one is refused", () => {
  const b = box("no-text");
  noteValue(SHOP, { guardrailStops: 2, wallFixes: 1 }, b.env, new Date(day(20)));
  noteValue("please ship it to prod now", { guardrailStops: 4 }, b.env, NOW);
  noteValue("../../etc", { guardrailStops: 4 }, b.env, NOW);
  noteValue(SHOP, { guardrailStops: "ship it" as never, wallFixes: -3 }, b.env, NOW);
  noteValue(SHOP, { guardrailStops: 1.5 as never, wallFixes: 1 }, b.env, NOW);
  markValueSaid(SHOP, b.env, NOW);
  markValueSaid("deploy to prod please", b.env, NOW);
  const f = valueFile(b);
  assert.deepEqual(f, { v: 1, repos: { [SHOP]: { saidAt: "2026-10-22", days: { "2026-10-20": { g: 2, w: 1 }, "2026-10-22": { g: 0, w: 1 } } } } });
  // Hand-planted text in the file is not read back or written again.
  writeFileSync(valuePath(b.env), JSON.stringify({ v: 1, repos: { [SHOP]: { saidAt: "ship it", typed: "push to prod", days: { "2026-10-21": { g: 1, w: 0, said: "yes" }, monday: { g: 1 } } }, "a prompt here": { days: {} } } }));
  noteValue(SHOP, { wallFixes: 1 }, b.env, NOW);
  assert.deepEqual(valueFile(b), { v: 1, repos: { [SHOP]: { saidAt: null, days: { "2026-10-21": { g: 1, w: 0 }, "2026-10-22": { g: 0, w: 1 } } } } });
});

test("value.json keeps 14 local days per repo", () => {
  const b = box("prune");
  for (let d = 1; d <= 22; d++) noteValue(SHOP, { guardrailStops: 1 }, b.env, new Date(day(d)));
  const days = Object.keys(valueFile(b).repos[SHOP].days).sort();
  assert.equal(days.length, 14);
  assert.equal(days[0], "2026-10-09");
  assert.equal(days.at(-1), "2026-10-22");
});

test("never through a link: a linked state folder is not written; a FIFO at value.json doesn't hold the read (D100)", () => {
  const b = box("links");
  const elsewhere = join(b.home, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(b.trail, "state"));
  noteValue(SHOP, { guardrailStops: 3 }, b.env, NOW);
  assert.equal(markValueSaid(SHOP, b.env, NOW), false);
  assert.equal(existsSync(join(elsewhere, "value.json")), false);
  if (process.platform === "win32") return; // Windows has no FIFO
  const c = box("fifo");
  mkdirSync(join(c.trail, "state"), { recursive: true });
  execFileSync("mkfifo", [valuePath(c.env)]);
  const t0 = Date.now();
  assert.equal(valueDue(SHOP, c.env, NOW), true);
  assert.equal(valueLine([SHOP], c.env, NOW), null);
  assert.ok(Date.now() - t0 < timeBar(2000, 6000), "the read did not wait on the FIFO");
});

test("guardrailStopsIn counts the guardrail's sure-fail denies a Stop collected, nothing else", () => {
  assert.equal(guardrailStopsIn([
    ["guardrail", { class: "no-timeout", outcome: "sure-fail" }],
    ["guardrail", { class: "no-timeout", outcome: "avoided" }],
    ["guardrail", { class: "no-timeout", outcome: "sure-fail" }],
    ["skill_used", { outcome: "worked" }],
  ]), 2);
  assert.equal(guardrailStopsIn([]), 0);
});

test("J10's value leg: a week of seeded uses after a week of skills on, then a startup says it once", () => {
  const b = box("j10", { v: 1, skills: "on", onSince: "2026-10-09T08:00:00.000Z" });
  const rel = skill(b, "release-npm", { uses: 5, source: { commands: 23, failed: 4 } });
  for (const d of [16, 19, 21]) use(b, rel, day(d), { failed: 0 });
  noteValue(SHOP, { guardrailStops: 9 }, b.env, new Date(day(19)));
  assert.equal(startValue(start(), b.env, new Date(day(15))), null, "Oct 15: no week of uses counted yet");
  const r = startValue(start(), b.env, NOW);
  assert.equal(r?.channel, "context");
  assert.ok(r?.context?.includes("release-npm ran 3 times, 0 failed commands in all; the timeout learning stopped 9 commands."), r?.context);
  assert.equal(startValue(start(), b.env, NOW), null, "once");
});
