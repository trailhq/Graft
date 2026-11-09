/**
 * D118 a: after Claude Code's ask for a gated step was denied, the lab's
 * agent retried the push three times ("now that you've confirmed"). The run
 * block's gated notes and the gate's deny say a denied gated step is not run
 * again in that turn, and that the agent asks the person to run it
 * themselves. D101/D107 shape: Trail's words, no line for the agent to
 * recite, never telling it not to ask. Made-up repos only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runBlock } from "../src/skills/runblock.js";
import { preBashSkills } from "../src/claude/pre-bash-skills.js";
import { promptSkills } from "../src/claude/prompt-skills.js";
import { cand, releaseSkill, shipSkill, WEBSHOP } from "./skills-recall-fixtures.js";
import { box, CWD, gateFor, payload, save, SID } from "./skills-prompt-fixtures.js";

const ctx = (canAsk: boolean) => ({ values: { sha: "4e1c9a2", version: "1.4.2" }, notes: [], probes: [], canAsk, header: "job" as const, lastFail: null });
const RECITE = /\b(say|tell them|reply with|let them know)\b[^.]*"/i;

test("the block's gated note says a denied step is not run again this turn, and the person runs it themselves", () => {
  const ship = runBlock(cand(shipSkill()), ctx(true));
  assert.ok(ship.includes("    Claude Code will ask the person before step 5 (it can't be undone); wait for that. If they say no, don't retry this turn; ask them to run it.\n"), ship);
  const rel = runBlock(cand(releaseSkill({ applies: WEBSHOP })), ctx(true));
  assert.ok(rel.includes("(steps 5 and 6 can't be undone); wait for that. If they say no, don't retry this turn; ask them to run them.\n"), rel);
  const headless = runBlock(cand(shipSkill()), ctx(false));
  assert.ok(headless.includes("    This session can't ask the person, so don't run step 5 (it can't be undone), not even after a yes in chat; show them the command to run themselves.\n"), headless);
  for (const b of [ship, rel, headless]) {
    assert.ok(b.length <= 1200 && b.startsWith("[trail] Skill "), b);
    assert.ok(!RECITE.test(b) && !/don't ask/i.test(b), b);
  }
});

test("the gate's deny where the session can't ask says the same: not again this turn, even after a yes in chat", async () => {
  const b = box("retry", { entry: "sdk-cli" });
  save(b, shipSkill());
  promptSkills(payload(b, "now ff to prod please"), CWD, b.env, { track: () => {}, gate: gateFor(b) });
  const cmd = "git push git@github.com:acme/webshop.git $(git rev-parse HEAD):refs/heads/prod";
  const d = await preBashSkills({ session_id: SID, tool_name: "Bash", tool_input: { command: cmd }, permission_mode: "default" }, CWD, b.env, cmd);
  assert.equal(d?.permissionDecision, "deny");
  assert.match(d!.reason, /don't run it, and don't try it again this turn, even after a yes in chat; ask the person to run this command in their own terminal: git push/);
  assert.ok(!RECITE.test(d!.reason), d!.reason);
});
