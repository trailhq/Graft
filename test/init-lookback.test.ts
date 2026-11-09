/**
 * Init's look-back discovery (design 4.1, b5): each session found carries
 * its transcript path and the byte range of its repo work, and what was left
 * out says why. Synthetic projects tree only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync as readdir, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lookBackOffThread } from "../src/init/discover-worker.js";
import { lookBack } from "../src/init/look-back-mine.js";
import { discoverSessions } from "../src/init/sessions.js";
import { eachLine } from "../src/init/transcript.js";
import { readWalls } from "../src/trace/wall-state.js";
import { checkout, day, done, folderOf, releaseJob, Tx, world } from "./init-mine-fixtures.js";

process.env.TZ = "UTC";

test("an own session is read whole: its path and a stretch from 0 to its size", () => {
  const w = world("own");
  try {
    const path = new Tx(w.repo).typed(day(1), "run the test suite").bash(day(1, 10, 5), "npm test", "ok").write(w.home, "own-1");
    const d = discoverSessions(w.repo, w.home, new Date(day(20)), w.env);
    assert.equal(d.sessions.length, 1);
    assert.equal(d.sessions[0]!.path, path);
    assert.deepEqual(d.sessions[0]!.stretch, { from: 0, to: statSync(path).size });
    assert.deepEqual(d.skipped, []);
  } finally {
    done(w);
  }
});

test("an ancestor session at 31% is read for its stretch only; one at 29% is skipped with its reason", () => {
  const w = world("anc");
  try {
    const p = w.parent;
    // 4 of 13 calls in the repo: 31%.
    const anc = new Tx(p).typed(day(2), "list what is here");
    for (let i = 0; i < 6; i++) anc.bash(day(2, 10, i), `ls ${join(w.other, String(i))}`, "x");
    anc.typed(day(2, 11), "go into shop and run the linter");
    anc.bash(day(2, 11, 1), `cd "${w.repo}" && npm run lint`, "clean");
    anc.bash(day(2, 11, 2), "npm test", "ok", { cwd: w.repo });
    anc.bash(day(2, 11, 3), "git status", "clean", { cwd: w.repo });
    anc.bash(day(2, 11, 4), "git log -1", "one", { cwd: w.repo });
    anc.said(day(2, 11, 5), "Done in shop.");
    anc.typed(day(2, 12), "now the web repo");
    for (let i = 0; i < 3; i++) anc.bash(day(2, 12, i), `ls ${join(w.other, `w${i}`)}`, "x");
    const ancPath = anc.write(w.home, "anc-31", folderOf(p));
    // 2 of 7 calls in the repo: 29%.
    const low = new Tx(p).typed(day(3), "tidy web");
    for (let i = 0; i < 5; i++) low.bash(day(3, 10, i), `ls ${join(w.other, String(i))}`, "x");
    low.typed(day(3, 11), "peek at shop");
    low.bash(day(3, 11, 1), "git status", "clean", { cwd: w.repo });
    low.bash(day(3, 11, 2), "git log -1", "one", { cwd: w.repo });
    const lowPath = low.write(w.home, "anc-29", folderOf(p));

    const d = discoverSessions(w.repo, w.home, new Date(day(20)), w.env);
    assert.deepEqual(d.sessions.map((s) => s.id), ["anc-31"]);
    assert.deepEqual(d.skipped, [{ path: lowPath, why: "ancestor-under-30" }]);
    const s = d.sessions[0]!;
    assert.equal(s.source, "ancestor");
    // The stretch starts at the ask that led into the repo and ends where the next ask begins.
    const lines: Array<{ o: number; line: string }> = [];
    eachLine(ancPath, (line, o) => lines.push({ o, line }), s.stretch);
    assert.match(lines[0]!.line, /go into shop and run the linter/);
    assert.ok(lines.some((l) => l.line.includes("Done in shop.")), "the reply after the last call is in the stretch");
    assert.ok(!lines.some((l) => l.line.includes("now the web repo")), "the next ask is not");
    assert.ok(!lines.some((l) => l.line.includes("list what is here")), "the ask before is not");
    assert.equal(readFileSync(ancPath, "utf8").slice(s.stretch!.from).startsWith("{"), true, "from is a line start");
  } finally {
    done(w);
  }
});

test("headless, scratch and too-old sessions are skipped with their reasons", () => {
  const w = world("skip");
  try {
    const headless = new Tx(w.repo).typed(day(4), "summarise the repo").write(w.home, "sdk-1", undefined, { entrypoint: "sdk-cli" });
    // A clone of the same remote in a scratch folder: not the person's work in the repo.
    const scratchClone = join(w.root, "agent", "scratchpad", "shop");
    mkdirSync(scratchClone, { recursive: true });
    checkout(scratchClone, "git@github.com:acme/shop.git");
    const scratch = new Tx(scratchClone).typed(day(5), "try a build").write(w.home, "scratch-1");
    const old = new Tx(w.repo).typed(day(6), "an old ask").write(w.home, "old-1");
    const longAgo = new Date(day(6)).getTime() / 1000 - 401 * 86_400;
    utimesSync(old, longAgo, longAgo);
    new Tx(w.repo).typed(day(7), "a fresh ask").write(w.home, "fresh-1");

    const d = discoverSessions(w.repo, w.home, new Date(day(7)), w.env);
    assert.deepEqual(d.sessions.map((s) => s.id), ["fresh-1"]);
    const why = Object.fromEntries((d.skipped ?? []).map((s) => [s.path, s.why]));
    assert.deepEqual(why, { [headless]: "headless", [scratch]: "scratch", [old]: "too-old" });
  } finally {
    done(w);
  }
});

test("eachLine gives each line's offset, reads only a range, and finishes a line that runs past its end", () => {
  const w = world("lines");
  try {
    const path = new Tx(w.repo).typed(day(1), "one").typed(day(1), "two").typed(day(1), "three").write(w.home, "l-1");
    const all: Array<[number, string]> = [];
    eachLine(path, (line, o) => all.push([o, line]));
    assert.equal(all.length, 3);
    const text = readFileSync(path, "utf8");
    for (const [o, line] of all) assert.equal(text.slice(o, o + line.length), line);
    const mid: string[] = [];
    // A range that ends inside the second line still gives the whole second line.
    eachLine(path, (line) => mid.push(line), { from: all[1]![0], to: all[1]![0] + 5 });
    assert.deepEqual(mid, [all[1]![1]]);
  } finally {
    done(w);
  }
});

/* ---- the whole look-back: discovery, replay, miners, how-tos and candidates (lookBack / lookBackOffThread) ---- */


const sh = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 12);

/** Releases on 3 days (2 costly) across own and worktree sessions, typed preferences on 2 days, a wall on 2 days. */
function history(w: ReturnType<typeof world>): string[] {
  const a = new Tx(w.repo);
  releaseJob(a, 1, "1.0.1", { failedFirst: true });
  a.typed(day(1, 12), "always run the lint script before you push");
  a.typed(day(1, 13), "time box the build").bash(day(1, 13, 1), "timeout 60 npm run build", "zsh:1: command not found: timeout", { isError: true });
  const b = new Tx(w.wt);
  releaseJob(b, 3, "1.0.3", { failedFirst: true });
  b.typed(day(3, 12), "always run the lint script before pushing");
  b.typed(day(3, 13), "time box the tests").bash(day(3, 13, 1), "timeout 60 npm test", "zsh:1: command not found: timeout", { isError: true });
  const c = new Tx(w.repo);
  releaseJob(c, 5, "1.0.5");
  return [a.write(w.home, "s-a"), b.write(w.home, "s-b"), c.write(w.home, "s-c")];
}

const LINES = ["always run the lint script before you push", "always run the lint script before pushing", "time box the build", "time box the tests"];

test("the look-back finds a skill, a guardrail and a preference, writes only facts, and no typed word or command anywhere", () => {
  const w = world("whole");
  try {
    history(w);
    // No timeout anywhere on PATH (the test machine may have one).
    const env = { ...w.env, PATH: "/nonexistent" };
    const lb = lookBack(w.repo, { env, capMs: 60_000, skills: true, now: new Date(day(20)) });
    assert.deepEqual(lb.errors, []);
    assert.deepEqual(lb.sessions.map((s) => s.sh).sort(), [sh("s-a"), sh("s-b"), sh("s-c")].sort());
    assert.deepEqual([lb.days, lb.from, lb.to, lb.parent], [3, "2026-09-01", "2026-09-05", 0]);
    const kinds = lb.candidates.map((c) => [c.kind, c.plainName || c.nameWords.join(" "), c.applies]);
    assert.deepEqual(kinds.map((k) => k[0]), ["skill", "guardrail", "preference"]);
    assert.equal(lb.candidates[1]!.applies, "every repo");
    assert.equal(lb.candidates[2]!.applies, "github.com/acme/shop", "it names the lint script");
    // walls.json has the hits, once per session, and nothing else of the transcripts.
    const walls = readWalls(w.env);
    assert.equal(walls.classes["timeout-missing"]!.seen.length, 2);
    assert.deepEqual(Object.keys(walls.read).sort(), [sh("s-a"), sh("s-b"), sh("s-c")].sort());
    // Nothing typed and no command in any file under the Trail home.
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdir(d, { withFileTypes: true })) f.isDirectory() ? walk(join(d, f.name)) : files.push(join(d, f.name)); };
    walk(w.trail);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const l of [...LINES, "npm publish", "npm run build", "command not found"]) assert.ok(!text.includes(l), `${f} holds "${l}"`);
    }
    // A second look-back counts the same sessions once.
    lookBack(w.repo, { env, capMs: 60_000, skills: true, now: new Date(day(20)) });
    assert.equal(readWalls(w.env).classes["timeout-missing"]!.seen.length, 2);
  } finally {
    done(w);
  }
});

test("with skills off the look-back offers no skill, and still the guardrail and the preference", () => {
  const w = world("off");
  try {
    history(w);
    const lb = lookBack(w.repo, { env: { ...w.env, PATH: "/nonexistent" }, capMs: 60_000, skills: false, now: new Date(day(20)) });
    assert.deepEqual(lb.candidates.map((c) => c.kind), ["guardrail", "preference"]);
  } finally {
    done(w);
  }
});

test("the look-back stops reading at its time cap and says how many it read", () => {
  const w = world("cap");
  try {
    history(w);
    const lb = lookBack(w.repo, { env: w.env, capMs: 0, skills: true, now: new Date(day(20)) });
    assert.equal(lb.sessions.length, 0);
    assert.deepEqual(lb.errors, ["couldn't read 3 of 3 sessions this time (out of time)"]);
    assert.equal(existsSync(join(w.trail, "walls.json")), false);
  } finally {
    done(w);
  }
});

test("off the main thread: the same look-back, with progress", async () => {
  const w = world("worker");
  try {
    history(w);
    const env = { ...w.env, PATH: "/nonexistent", TZ: "UTC" };
    const seen: string[] = [];
    const lb = await lookBackOffThread(w.repo, { env, capMs: 60_000, skills: true, onProgress: (p) => seen.push(p.phase) });
    assert.deepEqual(lb.candidates.map((c) => c.kind), ["skill", "guardrail", "preference"]);
    assert.equal(lb.candidates[0]!.skill!.compiled.steps.length >= 2, true);
    assert.ok(seen.includes("discover"), seen.join(","));
  } finally {
    done(w);
  }
});

test("a preference a learning of this repo already says is not offered again", () => {
  const w = world("learned");
  try {
    history(w);
    mkdirSync(join(w.repo, ".trail", "learnings"), { recursive: true });
    writeFileSync(join(w.repo, ".trail", "learnings", "lint-first.md"), "---\ntitle: Always run the lint script before you push\nauthor: dev\ndate: 2026-09-01\n---\n\n## Decided\nRun the lint script first.\n");
    const lb = lookBack(w.repo, { env: { ...w.env, PATH: "/nonexistent" }, capMs: 60_000, skills: false, now: new Date(day(20)) });
    assert.deepEqual(lb.candidates.map((c) => c.kind), ["guardrail"]);
  } finally {
    done(w);
  }
});

test("session-days are local dates: two asks either side of UTC midnight are one day in California", () => {
  const w = world("tz");
  const tz = process.env.TZ;
  try {
    process.env.TZ = "America/Los_Angeles";
    const tx = new Tx(w.repo);
    releaseJob(tx, 2, "1.0.1", { h: 1 }); // 2026-09-02T01:00Z is Sep 1, 6 pm there
    releaseJob(tx, 1, "1.0.0", { h: 20 }); // 2026-09-01T20:00Z is Sep 1, 1 pm
    tx.write(w.home, "s-tz");
    const lb = lookBack(w.repo, { env: { ...w.env, PATH: "/nonexistent" }, capMs: 60_000, skills: true, now: new Date(day(20)) });
    assert.deepEqual([lb.days, lb.from, lb.to], [1, "2026-09-01", "2026-09-01"]);
    process.env.TZ = "UTC";
    const utc = lookBack(w.repo, { env: { ...w.env, PATH: "/nonexistent" }, capMs: 60_000, skills: true, now: new Date(day(20)) });
    assert.deepEqual([utc.days, utc.from, utc.to], [2, "2026-09-01", "2026-09-02"]);
  } finally {
    process.env.TZ = tz;
    done(w);
  }
});
