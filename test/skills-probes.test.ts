/**
 * Ready probes (design 4.15, 4.5 step 11, spec 11): local, read-only,
 * allowlisted forms only, run without a shell, 300 ms in all, cached 10
 * minutes. Real temp repos and files; a stubbed git for the time cap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { probePassWords, readyProbes, runProbes } from "../src/skills/probes.js";
import { cand, shipSkill } from "./skills-recall-fixtures.js";

const NOW = new Date("2026-10-20T10:00:00.000Z");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });

function box(tag: string) {
  const home = tmpRepo(`probes-${tag}`);
  const repo = join(home, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.email=dev@example.com", "-c", "user.name=dev", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "one");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TRAIL_HOME: join(home, "trail-home") };
  return { home, repo, env };
}
const skillWith = (ready: string) => cand(shipSkill({ ready })).skill;
const byProbe = (rs: ReturnType<typeof runProbes>) => Object.fromEntries(rs.map((r) => [r.probe, r]));
/**
 * Every probe's result. A probe not done in the 300 ms is left out (by design), and on Windows five git spawns don't
 * fit in one call; the next call takes the done ones from the cache and runs the rest.
 */
function allProbes(...args: Parameters<typeof runProbes>): ReturnType<typeof byProbe> {
  const want = readyProbes(args[0]).length;
  let r = byProbe(runProbes(...args));
  for (let i = 0; i < 5 && Object.keys(r).length < want; i++) r = byProbe(runProbes(...args));
  return r;
}

test("git probes: clean tree, the on-branch probe, a ref that exists or not", () => {
  const b = box("git");
  const ready = "git status --porcelain ; git rev-parse --abbrev-ref HEAD = main ; git rev-parse --abbrev-ref HEAD = beta ; git rev-parse --verify main ; git rev-parse --verify nope";
  let r = allProbes(skillWith(ready), b.repo, NOW, b.env);
  assert.equal(r["git status --porcelain"]?.ok, true);
  assert.equal(r["git rev-parse --abbrev-ref HEAD = main"]?.ok, true);
  assert.deepEqual(r["git rev-parse --abbrev-ref HEAD = beta"], {
    probe: "git rev-parse --abbrev-ref HEAD = beta", ok: false, why: "This checkout is on main, not beta", fix: "Ask the person before switching.",
  });
  assert.equal(r["git rev-parse --verify main"]?.ok, true);
  assert.equal(r["git rev-parse --verify nope"]?.ok, false);
  writeFileSync(join(b.repo, "x.txt"), "x");
  r = byProbe(runProbes(skillWith("git status --porcelain"), b.repo, new Date(NOW.getTime() + 11 * 60_000), b.env));
  assert.deepEqual(r["git status --porcelain"], {
    probe: "git status --porcelain", ok: false, why: "Uncommitted changes here", fix: "Tell the person; don't commit or stash for them.",
  });
  assert.equal(probePassWords("git status --porcelain"), "no uncommitted changes");
  assert.equal(probePassWords("git rev-parse --abbrev-ref HEAD = main"), "on main");
});

test("git status never writes the index (optional locks off)", () => {
  const b = box("locks");
  const index = join(b.repo, ".git", "index");
  writeFileSync(join(b.repo, "y.txt"), "y");
  const before = existsSync(index) ? statSync(index).mtimeMs : 0;
  runProbes(skillWith("git status --porcelain"), b.repo, NOW, b.env);
  assert.equal(existsSync(index) ? statSync(index).mtimeMs : 0, before);
});

test("command -v looks the program up on PATH; test and [ ] stat the path, $HOME and ~ expanded", { skip: process.platform === "win32" }, async () => {
  // A unix socket, a /tmp folder and a PATH joined with ":" are POSIX only.
  const b = box("stat");
  // A socket path must stay under 104 bytes on macOS: this test's HOME is a short folder of its own.
  const home = mkdtempSync("/tmp/gp-");
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "acmetool"), "#!/bin/sh\n");
  chmodSync(join(bin, "acmetool"), 0o755);
  writeFileSync(join(bin, "notexec"), "x");
  writeFileSync(join(home, "conf.json"), "{}");
  const sock = join(home, "s.sock");
  const server = createServer();
  await new Promise<void>((done) => server.listen(sock, done));
  try {
    const env = { ...b.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` };
    const r = {
      ...byProbe(runProbes(skillWith("command -v acmetool ; command -v notexec ; command -v nosuchtool ; test -f $HOME/conf.json"), b.repo, NOW, env)),
      ...byProbe(runProbes(skillWith("test -f ~/gone.json ; [ -S $HOME/s.sock ] ; test -S $HOME/conf.json ; test -d $HOME/bin"), b.repo, NOW, env)),
    };
    assert.equal(r["command -v acmetool"]?.ok, true);
    assert.equal(r["command -v notexec"]?.ok, false);
    assert.equal(r["command -v nosuchtool"]?.ok, false);
    assert.equal(r["command -v nosuchtool"]?.why, "nosuchtool isn't installed here");
    assert.equal(r["test -f $HOME/conf.json"]?.ok, true);
    assert.equal(r["test -f ~/gone.json"]?.ok, false);
    assert.equal(r["[ -S $HOME/s.sock ]"]?.ok, true);
    assert.equal(r["test -S $HOME/conf.json"]?.ok, false, "a file is not a socket");
    assert.equal(r["test -d $HOME/bin"]?.ok, true);
    const colima = byProbe(runProbes(skillWith("test -S $HOME/.colima/default/docker.sock"), b.repo, NOW, env));
    assert.deepEqual(colima["test -S $HOME/.colima/default/docker.sock"], {
      probe: "test -S $HOME/.colima/default/docker.sock", ok: false, why: "Colima's socket isn't there", fix: "Start it first: colima start",
    });
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("at most 6 probes from one ready line", () => {
  const b = box("six");
  const ready = Array.from({ length: 9 }, (_, i) => `test -d $HOME/d${i}`).join(" ; ");
  assert.equal(runProbes(skillWith(ready), b.repo, NOW, b.env).length, 6);
});

test("anything not on the allowlist is never run, however it is dressed", () => {
  const b = box("allow");
  const marker = join(b.home, "ran");
  const ready = [
    `touch ${marker}`, `git status --porcelain; touch ${marker}`, `command -v sh && touch ${marker}`, `test -f ${marker} -o -n x`,
    `git rev-parse --verify $(touch ${marker})`, `git rev-parse --verify --output=${marker}`, `git -C /tmp status --porcelain`,
    "curl https://example.com", "git fetch origin", "npm whoami", `test -f $(touch ${marker})`, `command -v ${marker}`,
    "git rev-parse --verify {branch}", "test -f $SECRET_DIR/x",
  ].join(" ; ");
  const s = skillWith(ready);
  const r = [0, 6, 12].flatMap((i) => runProbes({ meta: { ...s.meta, ready: ready.split(" ; ").slice(i, i + 6).join(" ; ") } } as typeof s, b.repo, NOW, b.env));
  assert.equal(existsSync(marker), false);
  assert.deepEqual(r, []);
});

test("300 ms in all: a slow probe is left out, never reported failed", () => {
  const b = box("slow");
  const calls: number[] = [];
  const slow = (_args: string[], _cwd: string, timeoutMs: number) => {
    calls.push(timeoutMs);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timeoutMs);
    return { code: null, out: "", timedOut: true };
  };
  const ready = "git status --porcelain ; git rev-parse --abbrev-ref HEAD = main ; git rev-parse --verify main";
  const t0 = Date.now();
  const r = runProbes(skillWith(ready), b.repo, NOW, b.env, { git: slow });
  const took = Date.now() - t0;
  assert.deepEqual(r, []);
  assert.ok(took < 380, `took ${took} ms`);
  assert.ok(calls.every((t) => t <= 150), `each git gets at most 150 ms: ${calls}`);
  assert.deepEqual(runProbes(skillWith(ready), b.repo, NOW, b.env, { git: slow, budgetMs: 0 }), []);
  assert.ok(!existsSync(join(b.env.TRAIL_HOME!, "state", "probes.json")) || !readFileSync(join(b.env.TRAIL_HOME!, "state", "probes.json"), "utf8").includes("timedOut"));
});

test("cached 10 minutes by checkout and probe, in state/probes.json (0600), no path in the clear", () => {
  const b = box("cache");
  writeFileSync(join(b.repo, "dirty.txt"), "x");
  let runs = 0;
  const counting = (args: string[], cwd: string, timeoutMs: number) => {
    runs += 1;
    try {
      const out = execFileSync("git", args, { cwd, timeout: timeoutMs, encoding: "utf8" });
      return { code: 0, out, timedOut: false };
    } catch (e: any) {
      return { code: e.status ?? 1, out: String(e.stdout ?? ""), timedOut: false };
    }
  };
  const s = skillWith("git status --porcelain");
  assert.equal(runProbes(s, b.repo, NOW, b.env, { git: counting })[0]?.ok, false);
  assert.equal(runs, 1);
  execFileSync("rm", [join(b.repo, "dirty.txt")]);
  assert.equal(runProbes(s, b.repo, new Date(NOW.getTime() + 9 * 60_000), b.env, { git: counting })[0]?.ok, false, "still cached");
  assert.equal(runs, 1);
  assert.equal(runProbes(s, b.repo, new Date(NOW.getTime() + 11 * 60_000), b.env, { git: counting })[0]?.ok, true, "expired, run again");
  assert.equal(runs, 2);
  const file = join(b.env.TRAIL_HOME!, "state", "probes.json");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes(b.repo), "the checkout path is hashed");
  assert.ok(JSON.parse(text).entries, "the shape housekeeping prunes");
  // Another checkout is another key.
  const other = box("cache2");
  runProbes(s, other.repo, new Date(NOW.getTime() + 11 * 60_000), b.env, { git: counting });
  assert.equal(runs, 3);
});
