/**
 * Phase 2 P28 (design 1.2, 4.12): bringing back an older version of a skill
 * is the person's, in their own terminal. The agent guard denies
 * `skills restore <name> --version <n>` in its plain, quoted, variable and
 * `$(...)` forms, before the command runs, whatever the settings say; 1a's
 * plain `trail skills restore <name>` (a forgotten skill back) stays open.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentGuard } from "../src/skills/risk.js";
import { skillsPrefilter } from "../src/claude/pre-bash.js";
import { preBashSkills } from "../src/claude/pre-bash-skills.js";
import { timeBar } from "./machine-speed.js";

const ENV = { HOME: "/tmp/c2-guard-home", TRAIL_HOME: "/tmp/c2-guard-home/.trail" };
const input = (command: string) => ({ session_id: "sess-c2-guard", tool_name: "Bash", tool_input: { command } });

const DENIED = [
  "trail skills restore release-npm --version 1",
  "trail skills restore --version 1 release-npm",
  "trail skills restore release-npm --version=2",
  "npx @trailhq/trail-code skills restore release-npm --version 1",
  'trail "skills" \'restore\' release-npm --version 1',
  "tr\\\nail skills restore release-npm --vers\\\nion 1",
  "T=trail; $T skills restore release-npm --version 1",
  "node /tmp/t.js skills restore release-npm --version 1",
  "trail skills $(echo restore) release-npm --version 1",
  "trail $(echo skills) restore release-npm --version 1",
  "s=skills; trail $s restore release-npm --version 1",
  "trail skills restore release-npm $(echo --version) 1",
  "v=--version; trail skills restore release-npm $v 1",
  "cd /tmp && trail skills restore release-npm --version 1",
  // The flag any distance after the verb: a bounded window would let padding through.
  `trail skills restore release-npm${" ".repeat(5000)}--version 1`,
];

const OPEN = [
  "trail skills restore release-npm",
  "trail skills show release-npm",
  "trail --version",
  'grep "skills restore release-npm --version 1" notes.txt',
  "git commit -m 'docs: trail skills restore x --version 1'",
];

test("the agent guard denies restore by version in every form, with the person's own command in its words", async () => {
  for (const cmd of DENIED) {
    const g = agentGuard(cmd);
    assert.equal(g?.hit, "restore-version", cmd);
    assert.equal(skillsPrefilter(input(cmd), cmd, ENV), true, `prefilter: ${cmd}`);
    const d = await preBashSkills(input(cmd), "/tmp", ENV, cmd);
    assert.equal(d?.permissionDecision, "deny", cmd);
  }
  assert.equal(agentGuard("trail skills restore release-npm --version 1")!.reason,
    "Only the person brings back an older version of a skill, in their own terminal: trail skills restore release-npm --version 1. Tell the person; don't run it for them.");
  assert.equal(agentGuard("trail skills restore $x --version $n")!.reason,
    "Only the person brings back an older version of a skill, in their own terminal: trail skills restore <name> --version <n>. Tell the person; don't run it for them.");
});

test("1a's plain restore, show, and commands that only mention the words stay open", () => {
  for (const cmd of OPEN) assert.equal(agentGuard(cmd), null, cmd);
});

test("a 2 MB command of restore words is read in well under the hook's 5 s", () => {
  const big = 1_900_000;
  const bar = timeBar(1500, 4500);
  for (const c of ["x; " + "trail skills restore a ".repeat(big / 23), "trail x; " + "skills restore $".repeat(big / 16), "s=1; trail $s " + "restore a --version ".repeat(big / 20)]) {
    const t = Date.now();
    agentGuard(c);
    assert.ok(Date.now() - t < bar, `${Date.now() - t} ms, over ${bar} ms`);
  }
});
