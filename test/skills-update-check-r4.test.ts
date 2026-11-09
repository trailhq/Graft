/**
 * R4 for the check (phase 2 review): drift's replace takes the fresh compile's check along with its steps, so a check
 * the old skill didn't have must have run here and worked, read again in the transcript, as 1a's add gate (step 7)
 * reads a skill's check. A check whose result was rewritten after the run sheet recorded it as passing is refused.
 * Synthetic sessions only (acme/shop, acme-cli).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { said } from "./trace-fixtures.js";
import { append, bash, prompt, say, where } from "./skills-consent-fixtures.js";
import { OTHER, cleanup, keptSkill, mk, needsFix, offerAtStop, runUpdate, sayLines, updateCmd } from "./skills-update-fixtures.js";
import { readRunSheet } from "../src/trace/runs.js";

after(cleanup);

/** A needs-fix release-npm, then a release that went another way and was checked with `npm info` (a new check). */
function driftWithNewCheck() {
  const b = mk();
  keptSkill(b);
  needsFix(b);
  say(b, 100, "publish 1.4.4");
  bash(b, 105, "npm ci", "added 212 packages in 3s");
  bash(b, 110, "npm run build", "built in 2.0s");
  bash(b, 125, OTHER("1.4.4"), "+ acme-cli@1.4.4");
  bash(b, 130, "npm info acme-cli version", "1.4.4");
  append(b, [said("Published 1.4.4; npm shows it.", where(b, 140))]);
  const o = offerAtStop(b, 150, "replace");
  assert.notEqual(o.plan.next.check, o.plan.base.check, "the replace brings a check the old skill didn't have");
  return { b, ...o };
}

test("drift's replace with a new check that reads back as it worked: v2 is written", () => {
  const { b, offer } = driftWithNewCheck();
  sayLines(b, 152, offer);
  prompt(b, 160, "replace");
  const r = runUpdate(b, 170, updateCmd(offer));
  assert.equal(r.cli?.code, 0, r.decision?.reason ?? r.cli?.lines.join("\n"));
});

test("drift's replace whose new check doesn't read back in the transcript as it worked is refused (R4, the check too)", () => {
  const { b, offer, runId } = driftWithNewCheck();
  const call = readRunSheet(runId, b.env)!.calls.find((c) => c.cmd === "npm info acme-cli version")!;
  const text = readFileSync(b.tx, "utf8");
  const at = text.indexOf(`"tool_use_id":"${call.id}"`);
  const line = text.slice(text.lastIndexOf("\n", at) + 1, text.indexOf("\n", at));
  const bad = line.replace('"content":"1.4.4"}', '"content":"npm error code E404","is_error":true}');
  assert.notEqual(bad, line);
  writeFileSync(b.tx, text.replace(line, bad));
  sayLines(b, 152, offer);
  prompt(b, 160, "replace");
  const r = runUpdate(b, 170, updateCmd(offer));
  assert.match(r.decision?.reason ?? "", /^trail · not changed: these steps never ran here and worked: npm info acme-cli version\.$/);
  assert.equal(r.cli, null);
});
