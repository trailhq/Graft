/**
 * `<trail home>/walls.json` (design 2.7): the machine's wall hits, repairs,
 * the sessions already counted and the lessons that worked. Classes,
 * programs, repo keys, delta kinds and names and local dates only: never a
 * command or its output. Every test writes inside its own TRAIL_HOME.
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { lessonWorkedEpochs, noteWalls, readWalls, repairsSeen, wallDays, wallsPath } from "../src/trace/wall-state.js";
import { withLock } from "../src/util/private-fs.js";

function home(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tmpRepo("walls");
  return { dir, env: { HOME: join(dir, "home"), TRAIL_HOME: join(dir, "trail") } };
}
const SH = ["9f2c1a0b77e1", "a82f2c86d1e0", "de19c163aa07", "0123456789ab"];
const SHOP = "github.com/acme/shop";
const CLI = "github.com/acme-cli";
const seen = (sh: string, epoch: number, d: string, repo = SHOP, program = "go") => ({ cls: "docker-rootless" as const, d, sh, epoch, repo, program });
const fixed = (sh: string, epoch: number, d: string, repo = SHOP, program = "go", delta = [{ kind: "env" as const, name: "DOCKER_HOST" }]) =>
  ({ ...seen(sh, epoch, d, repo, program), delta });

test("readWalls: missing, bad JSON or the wrong shape reads as empty", () => {
  const h = home();
  assert.deepEqual(readWalls(h.env), { v: 1, read: {}, classes: {} });
  mkdirSync(join(h.dir, "trail"), { recursive: true });
  for (const bad of ["{", "[]", '{"v":2,"read":{},"classes":{}}', '{"v":1,"read":[],"classes":{}}', '{"v":1,"read":{},"classes":[]}']) {
    writeFileSync(wallsPath(h.env), bad);
    assert.deepEqual(readWalls(h.env), { v: 1, read: {}, classes: {} }, bad);
  }
});

test("noteWalls: one entry per (sh, epoch, cls, program), newest last, written 0600 under TRAIL_HOME", () => {
  const h = home();
  noteWalls({ seen: [seen(SH[0]!, 1, "2026-10-02"), seen(SH[0]!, 1, "2026-10-02"), seen(SH[0]!, 1, "2026-10-02", SHOP, "npm")] }, h.env);
  noteWalls({ seen: [seen(SH[0]!, 1, "2026-10-02")], fixed: [fixed(SH[0]!, 1, "2026-10-02"), fixed(SH[0]!, 1, "2026-10-02")] }, h.env);
  const w = readWalls(h.env);
  assert.deepEqual(w.classes["docker-rootless"]!.seen.map((s) => s.program), ["go", "npm"]);
  assert.equal(w.classes["docker-rootless"]!.fixed.length, 1);
  assert.ok(wallsPath(h.env).startsWith(join(h.dir, "trail")));
  if (process.platform !== "win32") assert.equal(statSync(wallsPath(h.env)).mode & 0o777, 0o600);
  assert.ok(!existsSync(join(h.dir, "home", ".trail")), "nothing under HOME");
});

test("noteWalls: the read map counts a session once across two repos", () => {
  const h = home();
  noteWalls({ read: { [SH[1]!]: "41022317:1728901212000" }, seen: [{ ...seen(SH[1]!, 0, "2026-09-10", SHOP, "timeout"), cls: "timeout-missing" }] }, h.env);
  // A second repo's init reads the same session: it is already in `read`, so its hit is not added again.
  noteWalls({ read: { [SH[1]!]: "41022317:1728901212000" }, seen: [{ ...seen(SH[1]!, 0, "2026-09-10", CLI, "timeout"), cls: "timeout-missing" }] }, h.env);
  const w = readWalls(h.env);
  assert.equal(w.classes["timeout-missing"]!.seen.length, 1);
  assert.deepEqual(Object.keys(w.read), [SH[1]]);
  assert.deepEqual(wallDays(w, "timeout-missing"), ["2026-09-10"]);
});

test("caps: seen and fixed keep the newest 60 per class", () => {
  const h = home();
  // Days rise with i (July to September), so the newest by date are the last ones noted.
  const many = Array.from({ length: 75 }, (_, i) => seen(`${String(i).padStart(12, "0")}`, i, `2026-0${7 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, "0")}`));
  noteWalls({ seen: many, fixed: many.map((s) => ({ ...s, delta: [{ kind: "flag" as const, name: "--no-cache" }] })) }, h.env);
  const c = readWalls(h.env).classes["docker-rootless"]!;
  assert.equal(c.seen.length, 60);
  assert.equal(c.fixed.length, 60);
  assert.equal(c.seen[0]!.epoch, 15, "the oldest went");
  assert.equal(c.seen.at(-1)!.epoch, 74);
});

test("noteWalls drops what isn't a class, a hash, a date, a repo key, a program or a delta name", () => {
  const h = home();
  noteWalls({
    seen: [
      { ...seen(SH[0]!, 1, "2026-10-02"), cls: "made-up" as never },
      { ...seen(SH[0]!, 1, "Oct 2") },
      { ...seen("not-a-hash", 1, "2026-10-02") },
      { ...seen(SH[0]!, 1, "2026-10-02", "github.com/acme/shop\nx") },
      // D98: a program is kept under its first word, so the odd one is the first word itself.
      { ...seen(SH[0]!, 1, "2026-10-02", SHOP, "$(curl x) go test ./...") },
      { ...seen(SH[0]!, -1, "2026-10-02") },
    ],
    fixed: [fixed(SH[0]!, 1, "2026-10-02", SHOP, "go", [{ kind: "env", name: "DOCKER_HOST=unix:///x" }])],
  }, h.env);
  assert.deepEqual(readWalls(h.env).classes, {});
});

test("walls.json holds no command or output text", () => {
  const h = home();
  const cmd = "DOCKER_HOST=unix:///home/dev/.colima/default/docker.sock go test ./internal/store/...";
  noteWalls({
    seen: [seen(SH[0]!, 1, "2026-10-02")],
    fixed: [fixed(SH[0]!, 1, "2026-10-02", SHOP, "go", [{ kind: "env", name: "DOCKER_HOST" }, { kind: "enable-step", name: "colima" }])],
    worked: [{ cls: "docker-rootless", lessonId: "l-7d2e10a1", sh: SH[0]!, epoch: 1, d: "2026-10-02" }],
  }, h.env);
  const text = readFileSync(wallsPath(h.env), "utf8");
  for (const bit of [cmd, "unix://", "internal/store", "rootless Docker not found", "go test"]) assert.ok(!text.includes(bit), bit);
  assert.ok(Buffer.byteLength(text) < 40 * 1024);
});

test("noteWalls: a lock it can't take in 200 ms skips the write and logs one line", () => {
  const h = home();
  noteWalls({ seen: [seen(SH[0]!, 1, "2026-10-02")] }, h.env);
  const before = readFileSync(wallsPath(h.env), "utf8");
  let ran = false;
  withLock(wallsPath(h.env), () => {
    const t0 = Date.now();
    noteWalls({ seen: [seen(SH[1]!, 2, "2026-10-03")] }, h.env);
    ran = true;
    assert.ok(Date.now() - t0 < 2000);
  });
  assert.ok(ran);
  assert.equal(readFileSync(wallsPath(h.env), "utf8"), before, "skipped");
  const log = readFileSync(join(h.dir, "trail", "state", "hook-errors.log"), "utf8");
  assert.match(log, /walls/);
  assert.equal(log.trim().split("\n").length, 1);
});

test("repairsSeen: earlier epochs in 45 days, not this one, not older, only this repo and program", () => {
  const h = home();
  const now = new Date("2026-10-20T12:00:00Z");
  noteWalls({ fixed: [
    fixed(SH[0]!, 1, "2026-10-02"),                          // earlier, same delta
    fixed(SH[0]!, 2, "2026-10-09", SHOP, "go", [{ kind: "enable-step", name: "colima" }]),   // earlier, other delta
    fixed(SH[1]!, 0, "2026-08-01"),                          // older than 45 days
    fixed(SH[2]!, 0, "2026-10-10", CLI),                     // another repo
    fixed(SH[2]!, 1, "2026-10-10", SHOP, "npm"),             // another program
    fixed(SH[3]!, 4, "2026-10-20"),                          // this epoch
  ] }, h.env);
  const w = readWalls(h.env);
  const r = repairsSeen(w, SHOP, "docker-rootless", "go", SH[3]!, 4, now);
  assert.equal(r.epochs, 2);
  assert.equal(r.firstAt, "2026-10-02");
  assert.equal(r.sameDelta, 1, "only the Oct 2 repair had this one's delta");
  assert.deepEqual(r.from, [{ sh: SH[0], epoch: 1, d: "2026-10-02" }, { sh: SH[3], epoch: 4, d: "2026-10-20" }], "the earlier same-delta epoch, then this one");
  const none = repairsSeen(w, SHOP, "docker-rootless", "go", SH[0]!, 1, new Date("2026-10-03T12:00:00Z"));
  assert.deepEqual([none.epochs, none.firstAt], [0, null], "nothing earlier");
  const out = repairsSeen(w, SHOP, "zsh-no-match", "go", SH[3]!, 4, now);
  assert.deepEqual(out, { epochs: 0, firstAt: null, sameDelta: 0, from: [] });
});

test("lessonWorkedEpochs counts distinct epochs a lesson worked in", () => {
  const h = home();
  const wk = (sh: string, epoch: number, d: string) => ({ cls: "docker-rootless" as const, lessonId: "l-7d2e10a1", sh, epoch, d });
  noteWalls({ worked: [wk(SH[0]!, 1, "2026-10-02"), wk(SH[0]!, 1, "2026-10-02")] }, h.env);
  assert.equal(lessonWorkedEpochs(readWalls(h.env), "docker-rootless", "l-7d2e10a1"), 1);
  noteWalls({ worked: [wk(SH[1]!, 0, "2026-10-09")] }, h.env);
  assert.equal(lessonWorkedEpochs(readWalls(h.env), "docker-rootless", "l-7d2e10a1"), 2);
  assert.equal(lessonWorkedEpochs(readWalls(h.env), "docker-rootless", "l-00000000"), 0);
  assert.equal(lessonWorkedEpochs(readWalls(h.env), "enospc", "l-7d2e10a1"), 0);
});

test("wallDays: distinct local days a class was seen, sorted", () => {
  const h = home();
  noteWalls({ seen: [seen(SH[0]!, 1, "2026-10-02"), seen(SH[0]!, 2, "2026-10-02", SHOP, "npm"), seen(SH[1]!, 0, "2026-07-09")] }, h.env);
  assert.deepEqual(wallDays(readWalls(h.env), "docker-rootless"), ["2026-07-09", "2026-10-02"]);
  assert.deepEqual(wallDays(readWalls(h.env), "enospc"), []);
});

test("no test here wrote outside its TRAIL_HOME", () => {
  const h = home();
  noteWalls({ seen: [seen(SH[0]!, 1, "2026-10-02")] }, h.env);
  assert.deepEqual(readdirSync(h.dir).sort(), ["trail"]);
});
