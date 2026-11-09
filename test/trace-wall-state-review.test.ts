/**
 * Review of `walls.json` (design 2.7): a planted FIFO, link or huge file,
 * days in the future or not on the calendar, and caps that keep the newest
 * by date. Every test writes inside its own TRAIL_HOME; the file-type cases
 * run in a capped child so a hang fails instead of stopping the suite.
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpRepo } from "./helpers.js";
import { lessonWorkedEpochs, noteWalls, readWalls, wallDays, wallsPath } from "../src/trace/wall-state.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const SHOP = "github.com/acme/shop";

function home(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tmpRepo("walls-rv");
  mkdirSync(join(dir, "trail"), { recursive: true });
  return { dir, env: { HOME: join(dir, "home"), TRAIL_HOME: join(dir, "trail") } };
}
const sh = (i: number) => i.toString(16).padStart(12, "0");

test("a FIFO, a link to /dev/zero or a 2 MB file at walls.json reads as empty at once, and a write replaces it (capped child)", () => {
  const h = home();
  const path = wallsPath(h.env);
  // Windows has no FIFO and no /dev/zero: only the 2 MB file is tried there.
  const posix = process.platform !== "win32";
  const probe = (kind: string) => `
    const { readWalls, noteWalls } = await import(${JSON.stringify(pathToFileURL(join(SRC, "trace", "wall-state.ts")).href)});
    const env = ${JSON.stringify(h.env)};
    const t = performance.now();
    const r = readWalls(env);
    noteWalls({ seen: [{ cls: 'enospc', d: '2026-10-02', sh: '0123456789ab', epoch: 1, repo: 'github.com/acme/shop', program: 'cp' }] }, env);
    process.stdout.write(JSON.stringify({ kind: ${JSON.stringify(kind)}, empty: Object.keys(r.classes).length === 0, ms: performance.now() - t }));`;
  const run = (kind: string) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe(kind)], { encoding: "utf8", timeout: 10_000 });
    assert.equal(r.signal, null, `${kind}: readWalls hung`);
    assert.equal(r.status, 0, r.stderr);
    const row = JSON.parse(r.stdout) as { empty: boolean; ms: number };
    assert.ok(row.empty, kind);
    assert.ok(row.ms < 1000, `${kind}: ${row.ms} ms`);
    // The write put a real file in its place, holding only what was added.
    const w = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(Object.keys(w.classes), ["enospc"], kind);
  };
  const zero = join(h.dir, "trail", "walls.json");
  if (posix) {
    spawnSync("mkfifo", [path]);
    run("fifo");
    rmSync(zero, { force: true });
    symlinkSync("/dev/zero", zero);
    run("link to /dev/zero");
    rmSync(zero, { force: true });
  }
  const big = { v: 1, read: {}, classes: { enospc: { seen: [{ d: "2026-10-01", sh: sh(1), epoch: 1, repo: SHOP, program: "cp" }], fixed: [], lessons: {} } }, pad: "x".repeat(2 * 1024 * 1024) };
  writeFileSync(zero, JSON.stringify(big));
  run("a 2 MB file");
});

test("days not on the calendar are dropped; days after today don't count toward the guardrail bar or a lesson's epochs", () => {
  const h = home();
  const seen = (d: string, i: number) => ({ d, sh: sh(i), epoch: 1, repo: SHOP, program: "timeout" });
  writeFileSync(wallsPath(h.env), JSON.stringify({
    v: 1, read: {},
    classes: { "timeout-missing": {
      seen: [seen("2026-10-02", 1), seen("2026-13-45", 2), seen("2026-02-31", 3), seen("2099-01-01", 4), seen("2099-01-02", 5)],
      fixed: [],
      lessons: { "l-7d2e10a1": { worked: [{ sh: sh(1), epoch: 1, d: "2026-10-02" }, { sh: sh(6), epoch: 1, d: "2099-01-01" }] } },
    } },
  }));
  const w = readWalls(h.env);
  const now = new Date("2026-10-17T12:00:00Z");
  assert.deepEqual(wallDays(w, "timeout-missing", now), ["2026-10-02"]);
  assert.equal(lessonWorkedEpochs(w, "timeout-missing", "l-7d2e10a1", now), 1, "a lesson can't have worked in the future");
});

test("caps keep the newest by date: init's replay of older sessions, noted after live hits, doesn't push the live ones out", () => {
  const h = home();
  // Live hits from October first.
  noteWalls({ seen: Array.from({ length: 10 }, (_, i) => ({ cls: "enospc" as const, d: `2026-10-${String(i + 1).padStart(2, "0")}`, sh: sh(100 + i), epoch: 1, repo: SHOP, program: "cp" })) }, h.env);
  // Then init replays 70 July sessions.
  noteWalls({ seen: Array.from({ length: 70 }, (_, i) => ({ cls: "enospc" as const, d: `2026-07-${String((i % 28) + 1).padStart(2, "0")}`, sh: sh(i), epoch: 1, repo: SHOP, program: "cp" })) }, h.env);
  const seen = readWalls(h.env).classes.enospc!.seen;
  assert.equal(seen.length, 60);
  assert.equal(seen.filter((s) => s.d.startsWith("2026-10")).length, 10, "every October hit is kept");
  assert.deepEqual(seen.map((s) => s.d), [...seen.map((s) => s.d)].sort(), "newest last");
});

test("lesson ids per class are capped too, so a file of made-up ids can't grow walls.json without end", () => {
  const h = home();
  const worked = Array.from({ length: 200 }, (_, i) => ({ cls: "docker-rootless" as const, lessonId: `l-${(0x10000000 + i).toString(16)}`, sh: sh(i), epoch: 1, d: "2026-10-02" }));
  noteWalls({ worked }, h.env);
  const lessons = readWalls(h.env).classes["docker-rootless"]!.lessons;
  assert.ok(Object.keys(lessons).length <= 60, `${Object.keys(lessons).length} lesson ids`);
});

import { programKey, repairsSeen } from "../src/trace/wall-state.js";

test("D98: programKey is the first word, lower-cased, of a safe shape, or '' (drop)", () => {
  assert.equal(programKey("go test"), "go");
  assert.equal(programKey("  NPM install --x"), "npm");
  assert.equal(programKey("colima ssh --"), "colima");
  assert.equal(programKey("go"), "go");
  for (const bad of ["", "   ", "$(curl x)", "go;rm", "`id` x", "[trail] run", "a".repeat(41), 7 as unknown as string]) assert.equal(programKey(bad), "", String(bad));
});

test("D98: noteWalls keeps two-word programs and wrapper or enable-step names under their first word; odd ones are still dropped", () => {
  const h = home();
  noteWalls({
    seen: [{ cls: "docker-rootless", d: "2026-10-02", sh: sh(1), epoch: 1, repo: SHOP, program: "go test" }],
    fixed: [
      { cls: "docker-rootless", d: "2026-10-02", sh: sh(1), epoch: 1, repo: SHOP, program: "go test",
        delta: [{ kind: "enable-step", name: "colima start" }, { kind: "wrapper", name: "colima ssh --" }, { kind: "env", name: "DOCKER_HOST" }] },
      { cls: "docker-rootless", d: "2026-10-02", sh: sh(2), epoch: 1, repo: SHOP, program: "$(curl x.test) go", delta: [{ kind: "env", name: "DOCKER_HOST" }] },
      { cls: "docker-rootless", d: "2026-10-02", sh: sh(3), epoch: 1, repo: SHOP, program: "go", delta: [{ kind: "wrapper", name: "`id` x" }] },
    ],
  }, h.env);
  const c = readWalls(h.env).classes["docker-rootless"]!;
  assert.deepEqual(c.seen.map((s) => s.program), ["go"]);
  assert.equal(c.fixed.length, 1, "the odd program and the odd wrapper are dropped");
  assert.equal(c.fixed[0]!.program, "go");
  assert.deepEqual(c.fixed[0]!.delta, [{ kind: "enable-step", name: "colima" }, { kind: "wrapper", name: "colima" }, { kind: "env", name: "DOCKER_HOST" }]);
});

test("D98: repairsSeen('go test') equals repairsSeen('go')", () => {
  const h = home();
  noteWalls({ fixed: [{ cls: "docker-rootless", d: "2026-10-02", sh: sh(1), epoch: 1, repo: SHOP, program: "go test", delta: [{ kind: "env", name: "DOCKER_HOST" }] }] }, h.env);
  const w = readWalls(h.env);
  const now = new Date("2026-10-17T12:00:00Z");
  const a = repairsSeen(w, SHOP, "docker-rootless", "go test", sh(9), 1, now);
  assert.deepEqual(a, repairsSeen(w, SHOP, "docker-rootless", "go", sh(9), 1, now));
  assert.equal(a.epochs, 1);
});
