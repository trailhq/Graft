/**
 * Init's replay (design 4.2, b5): a past transcript's stretch goes through
 * 1a's own parser and fold, in memory, so init's verdicts are the live
 * hooks' verdicts. Synthetic transcripts only; nothing is written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { compileInitSkill, recompileInitSkill, replaySession, typedAt } from "../src/init/replay-runs.js";
import { agentRuns, at as liveAt, box, done as boxDone, finish, grow, promptHook, release, session as liveSession, testsJob as liveTests } from "./claude-skills-journey-fixtures.js";
import { compactBoundary } from "./trace-fixtures.js";
import { day, done, releaseJob, SHOP, testsJob, Tx, world } from "./init-mine-fixtures.js";
import type { RunSheet } from "../src/trace/types.js";

process.env.TZ = "UTC";

const whole = (path: string) => ({ from: 0, to: statSync(path).size });

/** What both sides agree on for one run: its job, its verdict and what ran. */
const shape = (r: { job: unknown; checked: boolean; checkIndex: number | null; end: string; cmds: Array<string | null> }) =>
  JSON.stringify([r.job, r.checked, r.checkIndex, r.end, r.cmds]);

test("parity: replay gives the same runs and check verdicts as the live hooks on the same lines", async () => {
  const b = box("parity");
  try {
    const s = liveSession(b);
    await release(s, 2, "1.4.1", { failedFirst: true });
    await finish(s, 2, "Published 1.4.1.");
    await liveTests(s, 3, { failedFirst: true });
    await finish(s, 3, "All 12 tests pass.");
    // A release that ends in a question: not a checked success, live or replayed.
    await release(s, 4, "1.4.2");
    await finish(s, 4, "Published 1.4.2. Should I also tag it?");
    // A release a compaction cuts between the build and the publish (D59a): the carried run.
    await promptHook(s, liveAt(5, 0), "publish 1.4.3");
    await agentRuns(s, liveAt(5, 10), "npm run build", () => ({ out: "built in 2.1s" }));
    grow(s, [compactBoundary({ timestamp: liveAt(5, 12), sessionId: s.sid, cwd: b.repo })]);
    await agentRuns(s, liveAt(5, 20), "npm publish acme-cli-1.4.3.tgz --access public", () => ({ out: "+ acme-cli@1.4.3" }));
    await agentRuns(s, liveAt(5, 30), "npm view acme-cli version", () => ({ out: "1.4.3" }));
    await finish(s, 5, "Published 1.4.3.");
    await release(s, 6, "1.4.4");
    await finish(s, 6, "Published 1.4.4.");

    const runsDir = join(b.trail, "runs");
    const live: RunSheet[] = readdirSync(runsDir).filter((f) => f.startsWith("r-")).map((f) => JSON.parse(readFileSync(join(runsDir, f), "utf8")));
    assert.ok(live.length >= 5, `live wrote ${live.length} sheets`);
    const liveShapes = live.sort((a, c) => a.startedAt.localeCompare(c.startedAt))
      .map((x) => shape({ job: x.job, checked: x.checked, checkIndex: x.checkIndex, end: x.end, cmds: x.calls.map((c) => c.cmd) }));

    const r = replaySession(s.tx, whole(s.tx), SHOP, new Date(liveAt(7)), { env: { HOME: b.home, TRAIL_HOME: b.trail }, keepCalls: true });
    assert.equal(r.headless, false);
    const replayed = r.runs.filter((x) => x.sheet !== "none").sort((a, c) => a.startedAt.localeCompare(c.startedAt));
    const replayShapes = replayed.map((x) => shape({ job: x.job, checked: x.sheet === "checked", checkIndex: x.checkIndex, end: x.end, cmds: x.calls.map((c) => c.cmd) }));
    assert.deepEqual(replayShapes, liveShapes);
    // The verdicts themselves, so a parity of two wrong answers can't pass.
    assert.deepEqual(replayed.map((x) => [x.job, x.sheet]), [
      ["release", "checked"], ["tests", "checked"], ["release", "draft"], ["release", "draft"], ["release", "checked"], ["release", "checked"],
    ]);
    // The carried release's sheet is the whole job, build first.
    const carried = r.sheets.find((x) => x.sheet.joined);
    assert.ok(carried, "the carried run's sheet is joined");
    assert.deepEqual(carried!.sheet.calls.map((c) => c.cmd), ["npm run build", "npm publish acme-cli-1.4.3.tgz --access public", "npm view acme-cli version"]);
    assert.deepEqual(readdirSync(runsDir).filter((f) => f.startsWith("r-")).length, live.length, "replay wrote no sheet");
  } finally {
    boxDone(b);
  }
});

test("sheets are kept only for checked runs of an offer job, the newest 3 per job", () => {
  const w = world("three");
  try {
    const tx = new Tx(w.repo);
    for (let d = 1; d <= 5; d++) releaseJob(tx, d, `1.0.${d}`);
    tx.typed(day(6), "open it locally").bash(day(6, 10, 5), "npm run dev", "ready on localhost:3000").said(day(6, 10, 9), "Running.");
    testsJob(tx, 7, { failedFirst: true });
    const path = tx.write(w.home, "s-three");
    const r = replaySession(path, whole(path), SHOP, new Date(day(9)), { env: w.env });
    const rel = r.sheets.filter((x) => x.sheet.job === "release");
    assert.deepEqual(rel.map((x) => x.sheet.promptParams.version), ["1.0.3", "1.0.4", "1.0.5"]);
    assert.equal(r.sheets.filter((x) => x.sheet.job === "tests").length, 1);
    assert.equal(r.sheets.some((x) => x.sheet.job === "run-local"), false);
    for (const x of r.sheets) {
      assert.ok(x.sheet.checked);
      const text = readFileSync(path, "utf8").slice(x.src.from, x.src.to);
      assert.ok(text.startsWith("{"), "a source range starts at a line");
      assert.ok(text.includes(`"version"`) || text.includes("npm test") || text.includes("publish"), "and holds the run");
    }
    assert.equal(r.runs.every((x) => x.calls.every((c) => c.wall !== undefined)), true, "closed runs keep no calls but wall hits");
  } finally {
    done(w);
  }
});

test("typed lines come back as pointers that find the same line again, and nothing when it changed", () => {
  const w = world("typed");
  try {
    const tx = new Tx(w.repo).typed(day(1), "always use pnpm here").typed(day(2), "explain it simply, one example first");
    const path = tx.write(w.home, "s-typed");
    const r = replaySession(path, whole(path), SHOP, new Date(day(3)), { env: w.env });
    assert.deepEqual(r.typed.map((t) => t.text), ["always use pnpm here", "explain it simply, one example first"]);
    assert.deepEqual(r.typed.map((t) => t.day), ["2026-09-01", "2026-09-02"]);
    for (const t of r.typed) {
      assert.equal(t.ref.t, path);
      assert.match(t.ref.s, /^[0-9a-f]{64}$/);
      assert.equal(typedAt(t.ref, w.env), t.text);
    }
    const ref = r.typed[0]!.ref;
    assert.equal(typedAt({ ...ref, s: "0".repeat(64) }, w.env), null, "another sha finds nothing");
    assert.equal(typedAt({ ...ref, o: ref.o + 1 }, w.env), null, "another offset finds nothing");
  } finally {
    done(w);
  }
});

test("a headless session replays to nothing", () => {
  const w = world("sdk");
  try {
    const path = releaseJob(new Tx(w.repo), 1, "1.0.0").write(w.home, "s-sdk", undefined, { entrypoint: "sdk-cli" });
    const r = replaySession(path, whole(path), SHOP, new Date(day(3)), { env: w.env });
    assert.equal(r.headless, true);
    assert.deepEqual([r.runs.length, r.sheets.length, r.typed.length], [0, 0, 0]);
  } finally {
    done(w);
  }
});

test("a run after the session wrote Trail's own files gives no sheet", () => {
  const w = world("tamper");
  try {
    const tx = new Tx(w.repo);
    releaseJob(tx, 1, "1.0.1");
    tx.typed(day(2), "tweak the settings").tool(day(2, 10, 1), "Edit", { file_path: join(w.trail, "settings.json"), old_string: "a", new_string: "b" });
    releaseJob(tx, 3, "1.0.3");
    const path = tx.write(w.home, "s-tamper");
    const r = replaySession(path, whole(path), SHOP, new Date(day(4)), { env: w.env });
    assert.deepEqual(r.sheets.map((x) => x.sheet.promptParams.version), ["1.0.1"]);
  } finally {
    done(w);
  }
});

test("a session's replay stops at its run cap and says so", () => {
  const w = world("cap");
  try {
    const tx = new Tx(w.repo);
    for (let d = 1; d <= 6; d++) releaseJob(tx, d, `1.0.${d}`);
    const path = tx.write(w.home, "s-cap");
    const r = replaySession(path, whole(path), SHOP, new Date(day(9)), { env: w.env, maxRuns: 3 });
    assert.equal(r.stopped, "runs");
    assert.ok(r.runs.length <= 3);
  } finally {
    done(w);
  }
});

test("an init skill compiles again from its stored range to the same skillSha, and is refused when its file changed", () => {
  const w = world("again");
  try {
    const tx = new Tx(w.repo);
    releaseJob(tx, 1, "1.0.1", { failedFirst: true });
    releaseJob(tx, 2, "1.0.2");
    const path = tx.write(w.home, "s-again");
    const r = replaySession(path, whole(path), SHOP, new Date(day(4)), { env: w.env });
    const [prior, newest] = [r.sheets[0]!, r.sheets[1]!];
    const c = compileInitSkill(newest, prior, SHOP, w.env, new Date(day(4)));
    assert.equal(c.ok, true, JSON.stringify(c));
    if (!c.ok) return;
    const st = statSync(path);
    const src = { t: path, size: st.size, mtimeMs: st.mtimeMs, run: newest.src, prior: { t: path, ...prior.src }, skillSha: c.skillSha };
    const again = recompileInitSkill(src, SHOP, w.env, new Date(day(5)));
    assert.equal(again.ok, true, JSON.stringify(again));
    if (again.ok) assert.deepEqual(again.compiled.steps.map((x) => x.cmd), c.compiled.steps.map((x) => x.cmd));
    assert.deepEqual(recompileInitSkill({ ...src, skillSha: "f".repeat(64) }, SHOP, w.env), { ok: false, why: "changed" });
    appendFileSync(path, "\n");
    assert.deepEqual(recompileInitSkill(src, SHOP, w.env), { ok: false, why: "changed" }, "a size that moved");
    const st2 = statSync(path);
    utimesSync(path, st2.atime, new Date(st2.mtimeMs + 5000));
    assert.deepEqual(recompileInitSkill({ ...src, size: st2.size }, SHOP, w.env), { ok: false, why: "changed" }, "an mtime that moved");
    rmSync(path);
    assert.deepEqual(recompileInitSkill(src, SHOP, w.env), { ok: false, why: "gone" });
    assert.equal(existsSync(join(w.trail, "runs")), false, "nothing written under the Trail home");
  } finally {
    done(w);
  }
});

test("a 200 MB transcript replays with bounded memory: heap under 300 MB, at most 3 sheets per job held", { timeout: 300_000 }, async () => {
  const w = world("big");
  try {
    const { appendFileSync, writeFileSync } = await import("node:fs");
    const { jsonl, toolResult, toolUse, typed, said } = await import("./trace-fixtures.js");
    const { spawnSync } = await import("node:child_process");
    const path = join(w.home, ".claude", "projects", "-big", "big-session.jsonl");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "");
    const out = "x".repeat(120_000);
    const where = (d: number, s: number) => ({ cwd: w.repo, gitBranch: "main", timestamp: new Date(Date.UTC(2026, 8, 1, 0, 0, s) + d * 3_600_000).toISOString() });
    let n = 0;
    for (let t = 0; statSync(path).size < 200 * 1024 * 1024; t++) {
      const v = `1.${t}.0`;
      const lines: object[] = [typed(`publish ${v}`, where(t, 0))];
      for (let k = 0; k < 12; k++) {
        const id = `toolu_big${++n}`;
        lines.push(toolUse(id, "Bash", { command: `npm run build:${k}` }, where(t, k + 1)), toolResult(id, `${out}\nbuilt`, false, where(t, k + 1)));
      }
      for (const [cmd, res] of [[`npm publish acme-cli-${v}.tgz --access public`, `+ acme-cli@${v}`], ["npm view acme-cli version", v]] as const) {
        const id = `toolu_big${++n}`;
        lines.push(toolUse(id, "Bash", { command: cmd }, where(t, 10)), toolResult(id, res, false, where(t, 11)));
      }
      lines.push(said(`Published ${v}.`, where(t, 12)));
      appendFileSync(path, jsonl(lines));
    }
    const child = (await import("node:url")).fileURLToPath(new URL("./init-big-child.ts", import.meta.url));
    const r = spawnSync(process.execPath, ["--max-old-space-size=300", "--import", "tsx", child, path, SHOP, w.trail], { encoding: "utf8", timeout: 280_000 });
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    const got = JSON.parse(r.stdout);
    assert.ok(got.heapMb < 300, JSON.stringify(got));
    assert.deepEqual(got.perJob, { release: 3 }, JSON.stringify(got));
    assert.ok(got.held <= 4, JSON.stringify(got));
    assert.ok(got.runs > 50 && got.runs < 200, JSON.stringify(got));
    assert.equal(got.stopped, undefined, "the whole file was read");
    console.log(`# 200 MB replay: ${JSON.stringify(got)}`);
  } finally {
    done(w);
  }
});
