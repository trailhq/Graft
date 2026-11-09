/**
 * b5 review: no typed word, command or output on disk (0 rule 6), on every
 * path the look-back writes: walls.json, the pool, the hook-error log when
 * walls.json is locked, and the reads after it (`typedAt`,
 * `recompileInitSkill`). Every file under the whole test root is read, not
 * just the Trail home; only Claude Code's own transcripts may hold them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seedNeverShown } from "../src/init/candidates.js";
import { lookBack } from "../src/init/look-back-mine.js";
import { mineJobs } from "../src/init/miners.js";
import { recompileInitSkill, replaySession, typedAt } from "../src/init/replay-runs.js";
import { wallsPath } from "../src/trace/wall-state.js";
import { day, done, releaseJob, testsJob, Tx, world } from "./init-mine-fixtures.js";

process.env.TZ = "UTC";

const TYPED = [
  "always run the lint script before you push",
  "keep it short",
  "no jargon please",
  "time box the build",
  "publish 1.0.1",
  "run the test suite",
];
const COMMANDS = ["npm publish", "npm run build", "npm view", "npm ci", "npm test", "timeout 60", "acme-cli-1.0", "--access public"];
const OUTPUT = ["command not found", "E403", "403 Forbidden", "built in 2.1s", "added 212 packages", "12 passed"];

function files(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.isFile()) out.push(p);
    }
  };
  walk(root);
  return out;
}

test("nothing typed, no command and no output in any file the look-back writes, its error paths and later reads included", () => {
  const w = world("disk");
  try {
    const a = new Tx(w.repo);
    releaseJob(a, 1, "1.0.1", { failedFirst: true });
    testsJob(a, 1, { failedFirst: true, h: 11 });
    a.typed(day(1, 12), "always run the lint script before you push").typed(day(1, 12, 30), "keep it short").typed(day(1, 12, 40), "no jargon please");
    a.typed(day(1, 13), "time box the build").bash(day(1, 13, 1), "timeout 60 npm run build", "zsh:1: command not found: timeout", { isError: true });
    const b = new Tx(w.wt);
    releaseJob(b, 3, "1.0.3", { failedFirst: true });
    testsJob(b, 3, { failedFirst: true, h: 11 });
    b.typed(day(3, 12), "always run the lint script before you push").typed(day(3, 12, 30), "keep it short").typed(day(3, 12, 40), "no jargon please");
    b.typed(day(3, 13), "time box the build").bash(day(3, 13, 1), "timeout 60 npm run build", "zsh:1: command not found: timeout", { isError: true });
    const c = new Tx(w.repo);
    releaseJob(c, 5, "1.0.5");
    testsJob(c, 5, { h: 11 });
    const paths = [a.write(w.home, "s-a"), b.write(w.home, "s-b"), c.write(w.home, "s-c")];
    const env = { ...w.env, PATH: "/nonexistent" };

    // 1. walls.json locked: noteWalls gives up and logs.
    writeFileSync(`${wallsPath(env)}.lock`, String(process.pid));
    const locked = lookBack(w.repo, { env, capMs: 60_000, skills: true, now: new Date(day(20)) });
    assert.ok(locked.candidates.length > 0);
    // 2. Unlocked, again; 3. the pool seeded for every skill (none shown); 4. the reads keep and the relay do later.
    rmSync(`${wallsPath(env)}.lock`);
    const lb = lookBack(w.repo, { env, capMs: 60_000, skills: true, now: new Date(day(20)) });
    const skills = lb.candidates.filter((x) => x.kind === "skill");
    assert.ok(skills.length >= 2, JSON.stringify(lb.candidates.map((x) => x.key)));
    const jobs = mineJobs(paths.map((p) => replaySession(p, { from: 0, to: statSync(p).size }, "github.com/acme/shop", new Date(day(20)), { env })));
    seedNeverShown(jobs, lb.candidates, [], "github.com/acme/shop", env, new Date(day(20)));
    for (const s of skills) assert.equal(recompileInitSkill(s.skill!.src, "github.com/acme/shop", env, new Date(day(20))).ok, true);
    for (const p of lb.candidates.filter((x) => x.kind === "preference")) for (const r of p.pref!.refs) assert.ok(typedAt(r, env));

    const transcripts = new Set(paths);
    const all = files(w.root).filter((f) => !transcripts.has(f) && !f.includes(`${join(".git", "objects")}`));
    assert.ok(all.some((f) => f.endsWith("walls.json")), "walls.json written");
    assert.ok(all.some((f) => f.endsWith("hook-errors.log")), "the locked write logged");
    assert.ok(all.some((f) => /pool/.test(f)), `the pool written: ${all.filter((f) => f.includes(w.trail)).join(", ")}`);
    for (const f of all) {
      if (statSync(f).size > 5_000_000) continue;
      const text = readFileSync(f, "utf8");
      for (const s of [...TYPED, ...COMMANDS, ...OUTPUT]) assert.ok(!text.includes(s), `${f} holds "${s}"`);
    }
  } finally {
    done(w);
  }
});
