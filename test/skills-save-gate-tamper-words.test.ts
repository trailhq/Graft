/**
 * D93 (3): a session that ran Trail's hook script by hand still can't keep a skill, and the refusal says what
 * happened: "this session ran Trail's hook script by hand", not that it changed Trail's own files. Both halves of
 * the save gate (the session's tamper mark in PreToolUse, the transcript's tail in the CLI). Made-up repo.
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { cliAdd } from "../src/skills/save-gate.js";
import { withSkillSession } from "../src/trace/skill-session.js";
import { add, bash, box, ctxAt, kept, offered, prompt, T } from "./skills-consent-fixtures.js";

const HOOK_WORDS = "trail · not saved: this session ran Trail's hook script by hand, so Trail can't trust its record of what ran.";
const SCRIPTS = [
  "echo '{\"prompt\":\"yes\"}' | node /home/dev/.trail/bin/trail-hooks.cjs prompt",
  "node .claude/helpers/t*-hooks.cjs stop < /tmp/payload.json",
];

for (const script of SCRIPTS) {
  test(`PreToolUse: a hook script run by hand is refused with its own words (${script.slice(0, 40)})`, () => {
    const b = box();
    const { offer } = offered(b, 0);
    bash(b, 60, script, "");
    prompt(b, 70, "yes");
    const r = add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`);
    assert.equal(r.decision?.permissionDecision, "deny");
    assert.equal(r.decision?.reason, HOOK_WORDS);
    assert.deepEqual(kept(b).skills, []);
  });
}

test("the CLI half's sweep of the transcript says the same", () => {
  const b = box();
  const { offer } = offered(b, 0);
  prompt(b, 70, "yes");
  add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`, { skipCli: true });
  bash(b, 82, SCRIPTS[0]!, "");
  withSkillSession(ctxAt(b, 83), { catchUp: true }, (st) => {
    st.tampered = null;
  });
  assert.deepEqual(cliAdd(offer.name, offer.runId, b.env, T(84), b.repo), { exit: 1, lines: [HOOK_WORDS] });
  assert.deepEqual(kept(b).skills, []);
});

test("a write to Trail's files keeps its words", () => {
  const b = box();
  const { offer } = offered(b, 0);
  bash(b, 60, `echo '{}' > ${join(b.env.TRAIL_HOME!, "receipts", "x.json")}`, "");
  prompt(b, 70, "yes");
  const r = add(b, 80, `trail skills add ${offer.name} --run ${offer.runId}`);
  assert.equal(r.decision?.reason, "trail · not saved: this session changed Trail's own files (Bash echo), so Trail can't trust its record of what ran.");
});
