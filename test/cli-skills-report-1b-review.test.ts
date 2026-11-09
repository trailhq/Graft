/**
 * b7 review of 2.12's guardrail line: it says the guardrail stops a command
 * only when it does (skills on, and the file still says check no-timeout and
 * enforce sure-fail, as the fast path reads it). Made-up homes only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeEveryRepo } from "../src/notes/every-repo.js";
import { guardrailLearning } from "../src/notes/guardrails.js";
import { reportLines, skillsReport } from "../src/skills/cli-skills-report.js";
import { tmpRepo } from "./helpers.js";

const NOW = new Date("2026-10-17T10:00:00Z");

test("trail skills: the guardrail line says it stops `timeout N` only with skills on and the file still enforcing it", () => {
  const root = tmpRepo("b7r-report-guard");
  try {
    const env: NodeJS.ProcessEnv = { HOME: join(root, "home"), TRAIL_HOME: join(root, "trail-home") };
    mkdirSync(env.TRAIL_HOME!, { recursive: true });
    const path = writeEveryRepo(guardrailLearning("timeout-missing", "every repo", "on 6 days", NOW), "no-timeout.md", env);
    const line = () => reportLines(skillsReport(env, NOW, root)).find((l) => l.trimStart().startsWith("no-timeout")) ?? "";
    writeFileSync(join(env.TRAIL_HOME!, "settings.json"), JSON.stringify({ v: 1, skills: "on", onSince: "2026-08-01T00:00:00.000Z" }));
    assert.match(line(), /stops `timeout N`/);
    writeFileSync(join(env.TRAIL_HOME!, "settings.json"), JSON.stringify({ v: 1, skills: "off" }));
    assert.doesNotMatch(line(), /stops/, `skills off: nothing is denied (0 rule 1): ${line()}`);
    writeFileSync(join(env.TRAIL_HOME!, "settings.json"), JSON.stringify({ v: 1, skills: "on", onSince: "2026-08-01T00:00:00.000Z" }));
    writeFileSync(path, readFileSync(path, "utf8").replace(/^enforce:.*\n/m, ""));
    assert.doesNotMatch(line(), /stops/, `no enforce line: the fast path denies nothing: ${line()}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
