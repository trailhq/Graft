/**
 * c5 review (design 4.14, 2.6, P19 to P21, D117): the weekly value line said
 * twice by sessions that start together, a use counted twice, a stop that
 * wasn't the timeout guardrail's, and a week that never comes back after the
 * clock was wrong. Made-up homes, repos (acme/shop) and skills only.
 */
process.env.TZ = "UTC";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpRepo } from "./helpers.js";
import { compiled } from "./skills-store-fixtures.js";
import { savePersonal } from "../src/skills/store.js";
import { appendLedger } from "../src/skills/ledger.js";
import { updateSkillState } from "../src/skills/state.js";
import type { LedgerUse } from "../src/skills/types.js";
import { guardrailStopsIn, markValueSaid, startValue, valueDue, valueLine, valuePath } from "../src/skills/value-line.js";

const SHOP = "github.com/acme/shop";
const ON_SINCE = "2026-10-01T09:00:00.000Z";
const NOW = new Date("2026-10-22T09:00:00.000Z");
const day = (d: number, h = 10) => new Date(Date.UTC(2026, 9, d, h, 0, 0)).toISOString();
const run = promisify(execFile);

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

interface Box { env: NodeJS.ProcessEnv; trail: string; home: string }
function box(tag: string): Box {
  const home = tmpRepo(`c5-review-${tag}`);
  made.push(home);
  const trail = join(home, "trail-home");
  mkdirSync(trail, { recursive: true });
  writeFileSync(join(trail, "settings.json"), JSON.stringify({ v: 1, skills: "on", onSince: ON_SINCE }));
  return { env: { HOME: home, TRAIL_HOME: trail }, trail, home };
}
function skill(b: Box, name: string, id: string): string {
  const c = compiled(name, { trail: id, applies: SHOP }, { source: { runId: `r-${name}`, commands: 20, failed: 3, at: day(1) } });
  savePersonal(c, { from: "repeated", runId: `r-${name}`, consent: "offer-yes", stepsVerified: 2, env: b.env, now: new Date(day(1)) });
  updateSkillState(id, (s) => (s ? { ...s, uses: 4 } : s), b.env);
  return id;
}
let n = 0;
function use(b: Box, id: string, at: string, o: Partial<LedgerUse> = {}): void {
  appendLedger(id, {
    at, event: "use", useId: `u-${(++n).toString(16).padStart(6, "0")}`, skill: id, v: "1", host: "claude", cue: "job", repo: SHOP,
    stepsRan: [1, 2], failedStep: null, readyFailed: [], check: "passed", calls: 5, failed: 0, ...o,
  }, b.env);
}
const start = (o: Record<string, unknown> = {}) => ({ source: "startup", learn: true, subagent: false, host: "claude" as const, repoKey: SHOP, ...o });

test("once a week means once: a mark the week already has loses, so a session that read 'due' before it says nothing", () => {
  const b = box("mark-twice");
  const id = skill(b, "release-npm", "s-c50001");
  use(b, id, day(20));
  assert.equal(valueDue(SHOP, b.env, NOW), true);
  assert.equal(markValueSaid(SHOP, b.env, NOW), true, "the first session marks it");
  assert.equal(markValueSaid(SHOP, b.env, NOW), false, "a second session that also read 'due' loses the mark");
  assert.equal(markValueSaid(SHOP, b.env, new Date(day(28))), false, "6 days on, still this week's");
  assert.equal(markValueSaid(SHOP, b.env, new Date(day(29))), true, "7 days on, the next week");
});

test("sessions that start together say the line once between them (6 processes, one value.json)", async () => {
  const b = box("together");
  const id = skill(b, "release-npm", "s-c50002");
  use(b, id, new Date(Date.now() - 3600_000).toISOString());
  const mod = new URL("../src/skills/value-line.ts", import.meta.url).href;
  const at = Date.now() + 4000;
  const code = `const { startValue } = await import(${JSON.stringify(mod)});
    while (Date.now() < ${at}) {}
    const r = startValue({ source: 'startup', learn: true, subagent: false, host: 'claude', repoKey: ${JSON.stringify(SHOP)} }, ${JSON.stringify(b.env)});
    process.stdout.write(r ? 'said' : 'quiet');`;
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const outs = await Promise.all(Array.from({ length: 6 }, () => run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd, timeout: 30_000 })));
  const said = outs.filter((o) => o.stdout === "said").length;
  assert.equal(said, 1, outs.map((o) => o.stdout).join(","));
});

test("a use line written twice (same use id) counts once", () => {
  const b = box("dup");
  const id = skill(b, "release-npm", "s-c50003");
  use(b, id, day(20), { useId: "u-aaaaaa", failed: 2 });
  use(b, id, day(20), { useId: "u-aaaaaa", failed: 2 });
  use(b, id, day(21), { failed: 1 });
  assert.equal(valueLine([SHOP], b.env, NOW),
    "Last week in this repo, on this machine: release-npm ran 2 times, 3 failed commands in all.");
});

test("'the timeout guardrail stopped' counts the timeout guardrail's stops only", () => {
  assert.equal(guardrailStopsIn([
    ["guardrail", { class: "no-timeout", outcome: "sure-fail" }],
    ["guardrail", { class: "prod-after-beta", outcome: "sure-fail" }],
  ]), 1);
});

test("a clock moved back: a saidAt more than a week ahead of today doesn't silence the line for good; one a day ahead does for its week", () => {
  const b = box("clock");
  const id = skill(b, "release-npm", "s-c50004");
  use(b, id, day(20));
  mkdirSync(join(b.trail, "state"), { recursive: true });
  const said = (d: string) => writeFileSync(valuePath(b.env), JSON.stringify({ v: 1, repos: { [SHOP]: { saidAt: d, days: {} } } }));
  said("2027-06-01");
  assert.equal(valueDue(SHOP, b.env, NOW), true, "said 'next June': the clock was wrong then");
  assert.ok(startValue(start(), b.env, NOW), "so it is said, and marked today");
  assert.equal(valueDue(SHOP, b.env, NOW), false);
  said("2026-10-23");
  assert.equal(valueDue(SHOP, b.env, NOW), false, "a day ahead (another time zone): not twice in a week");
});
