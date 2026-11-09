/**
 * The update gate's CLI half never trusts its receipt (phase 2 design 4.11): a receipt the agent wrote or changed
 * itself (another tool call's id, another plan's sha, another typed line) changes nothing, because the CLI finds the
 * update in the transcript under the receipt's tool_use id and re-decides from the transcript, and every pin must be
 * the receipt's too. Synthetic sessions only (acme/shop, acme-cli).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { T, prompt } from "./skills-consent-fixtures.js";
import { blockRun, cleanup, keptSkill, mk, offerAtStop, runUpdate, sayLines, updateCmd } from "./skills-update-fixtures.js";
import { cliUpdate, changedDeny, UPDATE_DENY } from "../src/skills/update-gate.js";
import { listVersions } from "../src/skills/versions.js";

after(cleanup);

/** A yes, then the hook's receipt for the real command (the CLI half not run yet): the receipt's path and body. */
function receipted() {
  const b = mk();
  const { ref, skill } = keptSkill(b);
  blockRun(b, skill, 100);
  const { offer } = offerAtStop(b, 150);
  sayLines(b, 152, offer);
  prompt(b, 160, "yes");
  runUpdate(b, 170, updateCmd(offer), { name: "not-this-one" });
  const dir = join(b.env.TRAIL_HOME!, "receipts");
  const path = join(dir, readdirSync(dir).find((n) => n.endsWith(".update.json"))!);
  return { b, ref, offer, path, r: JSON.parse(readFileSync(path, "utf8")) };
}
const cli = (x: ReturnType<typeof receipted>) => cliUpdate(x.offer.name, x.offer.offerId, x.b.env, T(175));

test("the receipt as the hook wrote it: the CLI writes v2", () => {
  const x = receipted();
  assert.equal(cli(x).code, 0);
  assert.deepEqual(listVersions(x.ref), [1]);
});

test("a receipt naming a tool call that isn't this update changes nothing", () => {
  const x = receipted();
  writeFileSync(x.path, JSON.stringify({ ...x.r, toolUseId: "toolu_forged000001" }));
  assert.deepEqual(cli(x).lines, [UPDATE_DENY.noYes]);
  assert.deepEqual(listVersions(x.ref), []);
});

test("a receipt whose plan sha, base hash or typed line isn't the one the hook found changes nothing", () => {
  for (const forged of [{ proposalSha: "0000000000000000" }, { baseHash: "sha256:00" }, { typed: { offset: 0, lineSha: "00" } }]) {
    const x = receipted();
    writeFileSync(x.path, JSON.stringify({ ...x.r, ...forged }));
    assert.deepEqual(cli(x).lines, [changedDeny(x.offer.name)], JSON.stringify(forged));
    assert.deepEqual(listVersions(x.ref), [], JSON.stringify(forged));
  }
});
