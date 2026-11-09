/**
 * Init's miners (design 4.3, b5): repeated jobs with the newest good runs
 * as sources, and the wall hits and repairs past sessions hold, shaped for
 * walls.json with no command text. Synthetic transcripts and runs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { JobMiner, mineJobs, mineWalls, wallProgram } from "../src/init/miners.js";
import { replaySession, type Replay } from "../src/init/replay-runs.js";
import { noteWalls, readWalls, wallsPath } from "../src/trace/wall-state.js";
import { runCall, runState } from "./trace-run-fixtures.js";
import { day, done, releaseJob, SHOP, testsJob, Tx, world } from "./init-mine-fixtures.js";

process.env.TZ = "UTC";

const whole = (path: string) => ({ from: 0, to: statSync(path).size });

test("a job's session-days, costly days and newest good runs, across sessions", () => {
  const w = world("jobs");
  try {
    const a = new Tx(w.repo);
    releaseJob(a, 1, "1.0.1", { failedFirst: true });
    releaseJob(a, 2, "1.0.2", { failedFirst: true });
    const pa = a.write(w.home, "sess-a");
    const b = new Tx(w.repo);
    releaseJob(b, 4, "1.0.4");
    releaseJob(b, 5, "1.0.5", { failedFirst: true });
    testsJob(b, 5);
    const pb = b.write(w.home, "sess-b");
    const ra = replaySession(pa, whole(pa), SHOP, new Date(day(9)), { env: w.env });
    const rb = replaySession(pb, whole(pb), SHOP, new Date(day(9)), { env: w.env });
    const jobs = mineJobs([ra, rb]);
    const rel = jobs.find((j) => j.job === "release")!;
    assert.deepEqual(rel.days, [`2026-09-01|${ra.sh}`, `2026-09-02|${ra.sh}`, `2026-09-04|${rb.sh}`, `2026-09-05|${rb.sh}`]);
    assert.equal(rel.costly, 3, "the three releases with a failed publish; 1.0.4 ran 3 calls and none failed");
    assert.deepEqual(rel.good.map((g) => g.sheet.promptParams.version), ["1.0.5", "1.0.4", "1.0.2"], "newest first, at most 3");
    assert.deepEqual(rel.good.map((g) => g.prior?.sheet.promptParams.version ?? null), ["1.0.4", "1.0.2", "1.0.1"], "each with the checked run before it");
    for (const g of rel.good) {
      assert.equal(g.src.t, g.sheet.session === ra.sh ? pa : pb);
      const text = readFileSync(g.src.t, "utf8").slice(g.src.run.from, g.src.run.to);
      assert.ok(text.includes(`publish ${g.sheet.promptParams.version}`), "the range holds the run's ask");
      assert.equal(g.src.size, statSync(g.src.t).size);
    }
    const tests = jobs.find((j) => j.job === "tests")!;
    assert.equal(tests.days.length, 1);
  } finally {
    done(w);
  }
});

test("the miner holds at most 4 sheets per job however many sessions it reads", () => {
  const w = world("bounded");
  try {
    const miner = new JobMiner();
    for (let s = 0; s < 6; s++) {
      const tx = new Tx(w.repo);
      releaseJob(tx, s + 1, `1.0.${s}`);
      releaseJob(tx, s + 1, `1.1.${s}`, { h: 14 });
      const p = tx.write(w.home, `sess-${s}`);
      miner.add(replaySession(p, whole(p), SHOP, new Date(day(9)), { env: w.env }));
      assert.ok(miner.held() <= 4, `held ${miner.held()}`);
    }
    assert.deepEqual(miner.result().find((j) => j.job === "release")!.good.map((g) => g.sheet.promptParams.version), ["1.1.5", "1.0.5", "1.1.4"]);
  } finally {
    done(w);
  }
});

test("runs of another repo in the stretch don't count for this one", () => {
  const w = world("other");
  try {
    const tx = new Tx(w.other);
    releaseJob(tx, 1, "2.0.0", { failedFirst: true });
    const p = tx.write(w.home, "sess-web");
    const r = replaySession(p, whole(p), SHOP, new Date(day(9)), { env: w.env });
    assert.deepEqual(mineJobs([r]), []);
  } finally {
    done(w);
  }
});

/** A replay made by hand: one run whose calls hit walls, and a repair. No command text may reach the result. */
function wallReplay(sh: string, repoKey = SHOP): Replay {
  const hit = runCall({ id: "toolu_w1", at: "2026-09-02T10:00:00.000Z", cmd: "timeout 60 npm test -- --secret-flag=abc", failed: true, wall: "timeout-missing" });
  const dock = runCall({ id: "toolu_w2", at: "2026-09-02T10:01:00.000Z", cmd: "DOCKER_HOST=x go test ./...", failed: true, wall: "docker-rootless" });
  const run = runState({
    id: "r-0902-aaaa", epoch: 2, repoKey, calls: [hit, dock],
    repairs: [{ cls: "docker-rootless", program: "go", failCallId: "toolu_w2", fixCallId: "toolu_w3", epoch: 2, runId: "r-0902-aaaa", at: "2026-09-02T10:02:00.000Z",
      delta: [{ kind: "env", name: "DOCKER_HOST", text: "DOCKER_HOST=unix://$HOME/.colima/default/docker.sock", callId: "toolu_w3" }] }],
  });
  return { runs: [run], sheets: [], typed: [], headless: false, sh, path: "/home/dev/.claude/projects/x/s.jsonl", size: 4096, mtimeMs: 1727870400000, repoKey, programs: [] };
}

test("walls: hits and repairs by class, program, day, session and epoch; no command or output text", () => {
  const sh = "9f2c1a0b77e1";
  const m = mineWalls([wallReplay(sh)]);
  assert.deepEqual(m.seen, [
    { cls: "timeout-missing", d: "2026-09-02", sh, epoch: 2, repo: SHOP, program: "timeout" },
    { cls: "docker-rootless", d: "2026-09-02", sh, epoch: 2, repo: SHOP, program: "go" },
  ]);
  assert.deepEqual(m.fixed, [{ cls: "docker-rootless", d: "2026-09-02", sh, epoch: 2, repo: SHOP, program: "go", delta: [{ kind: "env", name: "DOCKER_HOST" }] }]);
  assert.deepEqual(m.read, { [sh]: "4096:1727870400000" });
  const text = JSON.stringify(m);
  for (const bad of ["npm test", "secret-flag", "colima", "unix://"]) assert.ok(!text.includes(bad), bad);
});

test("walls: a session already in walls.json's read is not counted again, from this repo or another", () => {
  const w = world("walls");
  try {
    const sh = "9f2c1a0b77e1";
    noteWalls(mineWalls([wallReplay(sh)]), w.env);
    const once = readFileSync(wallsPath(w.env), "utf8");
    // A second init, in another repo, replays the same session (an ancestor stretch both repos share).
    const again = mineWalls([wallReplay(sh, "github.com/acme/web")], readWalls(w.env).read);
    assert.deepEqual([again.seen, again.fixed], [[], []]);
    noteWalls(again, w.env);
    assert.equal(readFileSync(wallsPath(w.env), "utf8"), once);
    assert.equal(readWalls(w.env).classes["timeout-missing"]!.seen.length, 1);
  } finally {
    done(w);
  }
});

test("a wall's program is the catalog's program the command runs, else the command's own", () => {
  assert.equal(wallProgram("timeout-missing", "env CI=1 timeout 30 make test"), "timeout");
  assert.equal(wallProgram("git-https-auth", "cd api && git push origin main"), "git");
  assert.equal(wallProgram("docker-rootless", "go test ./..."), "go");
  assert.equal(wallProgram("enospc", "npm ci"), "npm");
  assert.equal(wallProgram("enospc", null), "shell");
});

test("walls and repairs from a real-shaped transcript: the fold's hits and b2's repairs reach the miner, the last open run too", () => {
  const w = world("repairs");
  try {
    const tx = new Tx(w.repo);
    tx.typed(day(2), "run the integration tests");
    tx.bash(day(2, 10, 1), "go test ./...", "--- FAIL: TestStore\n    store_test.go:12: rootless Docker not found\nFAIL", { isError: true });
    tx.bash(day(2, 10, 2), "colima start", "INFO[0001] done");
    tx.bash(day(2, 10, 3), "DOCKER_HOST=unix://$HOME/.colima/default/docker.sock go test ./...", "ok  \tacme/shop/store\t1.2s");
    tx.said(day(2, 10, 4), "Tests pass.");
    tx.typed(day(3), "time box the build");
    tx.bash(day(3, 10, 1), "timeout 60 npm run build", "zsh:1: command not found: timeout", { isError: true });
    tx.said(day(3, 10, 2), "This Mac has no timeout.");
    const p = tx.write(w.home, "sess-walls");
    const r = replaySession(p, whole(p), SHOP, new Date(day(9)), { env: w.env });
    const m = mineWalls([r]);
    assert.deepEqual(m.seen!.map((s) => [s.cls, s.program, s.d]), [["docker-rootless", "go", "2026-09-02"], ["timeout-missing", "timeout", "2026-09-03"]]);
    assert.deepEqual(m.fixed!.map((f) => [f.cls, f.program, f.delta]), [["docker-rootless", "go", [{ kind: "enable-step", name: "colima" }, { kind: "env", name: "DOCKER_HOST" }]]]);
    for (const bad of ["unix://", "store_test", "npm run build"]) assert.ok(!JSON.stringify(m).includes(bad), bad);
    // The repair in the run the stretch's end closes (not the fold) is found too.
    const cut = new Tx(w.repo);
    cut.typed(day(4), "run the integration tests");
    cut.bash(day(4, 10, 1), "go test ./...", "rootless Docker not found", { isError: true });
    cut.bash(day(4, 10, 2), "colima start", "done");
    cut.bash(day(4, 10, 3), "DOCKER_HOST=unix://$HOME/.colima/default/docker.sock go test ./...", "ok  \tacme/shop/store\t1.2s");
    const p2 = cut.write(w.home, "sess-open");
    const m2 = mineWalls([replaySession(p2, whole(p2), SHOP, new Date(day(9)), { env: w.env })]);
    assert.equal(m2.fixed!.length, 1);
  } finally {
    done(w);
  }
});

test("walls.json gets one word per program and delta name, so noteWalls keeps the repair", () => {
  const w = world("oneword");
  try {
    const r = wallReplay("9f2c1a0b77e1");
    r.runs[0]!.repairs = [{ cls: "docker-rootless", program: "go test", failCallId: "a", fixCallId: "b", epoch: 2, runId: null, at: "2026-09-02T10:02:00.000Z",
      delta: [{ kind: "enable-step", name: "npm install", text: "npm install", callId: "c" }, { kind: "wrapper", name: "colima ssh --", text: "colima ssh --", callId: "b" }] }];
    noteWalls(mineWalls([r]), w.env);
    assert.deepEqual(readWalls(w.env).classes["docker-rootless"]!.fixed.map((f) => [f.program, f.delta]),
      [["go", [{ kind: "enable-step", name: "npm" }, { kind: "wrapper", name: "colima" }]]]);
  } finally {
    done(w);
  }
});
