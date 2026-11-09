/**
 * D118 c: the saved line names the steps and the check apart. The lab's
 * release skill was 1 step plus its check (`npm view ...`), and the line
 * said "2 steps". A check that is itself a step (a push, tests) is counted
 * once, as a step. Made-up skills only.
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { savedLines } from "../src/skills/save-gate.js";
import { stepsTotal } from "../src/skills/store-fs.js";
import type { CompiledSkill } from "../src/skills/types.js";

const step = (n: number, cmd: string) => ({ n, cmd, gated: null, bg: false, wait: false });
const skill = (steps: string[], check: string, checkIsStep: boolean) =>
  ({ name: "release-npm", meta: { asks: "publish", applies: "github.com/acme/widget" }, steps: steps.map((c, i) => step(i + 1, c)), check, checkIsStep } as unknown as CompiledSkill);
const lines = (c: CompiledSkill) => savedLines(c, stepsTotal(c as never), "2026-10-20T10:07:00.000Z", null, new Date("2026-10-20T11:00:00.000Z"));

test("the lab case: 1 step and its check, never '2 steps'", () => {
  const [mark, tell] = lines(skill(["npm publish --access public"], "npm view acme-widget version", false));
  assert.match(mark, /· 1 step and its check, each one ran here at 10:07 today$/);
  assert.match(tell, /: 1 step and its check, each one ran here at 10:07 today\./);
  assert.ok(!tell.includes("2 steps"), tell);
  assert.match(lines(skill(["npm run build", "npm publish --access public"], "npm view acme-widget version", false))[1], /: 2 steps and its check, each one/);
});

test("a check that is its own step counts once, as a step; no check, no check named", () => {
  assert.match(lines(skill(["git fetch origin", "git push origin beta:prod"], "git push origin beta:prod", true))[1], /: 2 steps, each one ran here/);
  assert.match(lines(skill(["npm run build", "npm pack", "npm publish"], "", false))[1], /: 3 steps, each one ran here/);
});
