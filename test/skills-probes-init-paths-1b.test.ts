/**
 * D120 (2): the clean-tree ready probe ignores exactly the paths `trail init`
 * recorded writing in this checkout (its install record), and only while each
 * still holds what init wrote. Any later edit makes the path block again; so
 * does a file init never wrote, a file that was already dirty before init, and
 * a record made for another checkout. Real temp repos, made-up names, and one
 * real `trail init` run with its HOME and Trail home passed in.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { runProbes } from "../src/skills/probes.js";
import { installRecordPath, readInstallRecord, recordInstall, snapInstall } from "../src/init/install-record.js";
import { cand, shipSkill } from "./skills-recall-fixtures.js";

const NOW = new Date("2026-10-20T10:00:00.000Z");
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore", env: GIT_ENV });
const commit = (repo: string) => {
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=dev@example.com", "-c", "user.name=dev", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
};
const INIT_PATHS = [".mcp.json", ".claude/settings.json", ".claude/helpers/trail-hooks.cjs", ".trail/README.md"];

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function box(tag: string, tracked: Record<string, string> = {}) {
  const home = tmpRepo(`init-paths-${tag}`);
  made.push(home);
  const repo = join(home, "acme-shop");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "shop\n");
  for (const [rel, text] of Object.entries(tracked)) put(repo, rel, text);
  commit(repo);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TRAIL_HOME: join(home, "trail-home") };
  return { home, repo, env };
}

function put(repo: string, rel: string, text: string) {
  mkdirSync(join(repo, rel, ".."), { recursive: true });
  writeFileSync(join(repo, rel), text);
}

/** What `trail init` does around its writes: a look at the paths before, its writes, then the record. */
function initWrites(b: { repo: string; env: NodeJS.ProcessEnv }, writes: Record<string, string | null>) {
  const snap = snapInstall(b.repo, Object.keys(writes), b.env);
  for (const [rel, text] of Object.entries(writes)) {
    if (text === null) rmSync(join(b.repo, rel), { force: true });
    else put(b.repo, rel, text);
  }
  return recordInstall(snap, b.env);
}

const WIRING: Record<string, string> = {
  ".mcp.json": '{"mcpServers":{"trail":{"command":"trail"}}}\n',
  ".claude/settings.json": '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node .claude/helpers/trail-hooks.cjs stop"}]}]}}\n',
  ".claude/helpers/trail-hooks.cjs": "// shim\n",
  ".trail/README.md": "learnings live here\n",
};

let tick = 0;
/** One clean probe, past the 10-minute cache each time. */
function clean(b: { repo: string; env: NodeJS.ProcessEnv }) {
  const at = new Date(NOW.getTime() + ++tick * 11 * 60_000);
  // A slow git (a shared Windows runner) can run past the probes' 300 ms and return nothing; nothing is cached
  // then, so the same probe at the same instant is simply asked again.
  for (let k = 0; k < 5; k++) {
    const r = runProbes(cand(shipSkill({ ready: "git status --porcelain" })).skill, b.repo, at, b.env)[0];
    if (r) return r;
  }
  return undefined;
}

test("right after init, the paths it recorded read clean: a first init's untracked folders and a changed tracked file", () => {
  const b = box("fresh", { ".mcp.json": "{}\n" });
  const recorded = initWrites(b, WIRING);
  assert.deepEqual(recorded.sort(), [...INIT_PATHS].sort());
  assert.equal(clean(b)?.ok, true);
});

test("any later edit to a recorded path makes it block again; putting init's bytes back reads clean", () => {
  const b = box("edit");
  initWrites(b, WIRING);
  put(b.repo, ".claude/settings.json", '{"model":"opus"}\n');
  assert.deepEqual(clean(b), { probe: "git status --porcelain", ok: false, why: "Uncommitted changes here", fix: "Tell the person; don't commit or stash for them." });
  put(b.repo, ".claude/settings.json", WIRING[".claude/settings.json"]!);
  assert.equal(clean(b)?.ok, true);
});

test("a file init never wrote blocks, in Trail's own folders too: a new learning, a file next to the shim", () => {
  const b = box("unrecorded");
  initWrites(b, WIRING);
  put(b.repo, ".trail/learnings/build.md", "run the build first\n");
  assert.equal(clean(b)?.ok, false, "a learning saved since init is not init's");
  rmSync(join(b.repo, ".trail", "learnings"), { recursive: true });
  assert.equal(clean(b)?.ok, true);
  put(b.repo, ".claude/helpers/trail-statusline.cjs", "// not init's this time\n");
  assert.equal(clean(b)?.ok, false);
});

test("a path that was already dirty before init stays the person's, even after init wrote over it", () => {
  const b = box("dirty-before", { ".mcp.json": "{}\n" });
  put(b.repo, ".mcp.json", '{"mcpServers":{"mine":{"command":"mine"}}}\n');
  const recorded = initWrites(b, { ".mcp.json": '{"mcpServers":{"mine":{"command":"mine"},"trail":{"command":"trail"}}}\n' });
  assert.deepEqual(recorded, []);
  assert.equal(clean(b)?.ok, false);
});

test("a second init over its own uncommitted files keeps them recorded", () => {
  const b = box("again");
  initWrites(b, WIRING);
  const again = initWrites(b, WIRING);
  assert.deepEqual(again.sort(), [...INIT_PATHS].sort(), "unchanged by the second init, still init's");
  assert.equal(clean(b)?.ok, true);
});

test("a tracked file init deleted reads clean while it stays gone; brought back different, it blocks", () => {
  const b = box("deleted", { ".claude/helpers/graft-hooks.cjs": "// old\n" });
  initWrites(b, { ...WIRING, ".claude/helpers/graft-hooks.cjs": null });
  assert.equal(clean(b)?.ok, true);
  put(b.repo, ".claude/helpers/graft-hooks.cjs", "// mine now\n");
  assert.equal(clean(b)?.ok, false);
});

test("no record, or a record for another checkout, ignores nothing", () => {
  const b = box("none");
  for (const [rel, text] of Object.entries(WIRING)) put(b.repo, rel, text);
  assert.equal(clean(b)?.ok, false, "init's shape without its record");

  const other = box("other");
  initWrites(other, WIRING);
  const c = { ...b, env: other.env };
  assert.equal(clean(c)?.ok, false, "another checkout's record");
  const rec = JSON.parse(readFileSync(installRecordPath(other.repo, other.env), "utf8"));
  writeFileSync(installRecordPath(b.repo, other.env), JSON.stringify(rec));
  assert.equal(readInstallRecord(b.repo, other.env), null, "a copied record names its own checkout");
  assert.equal(clean(c)?.ok, false);
});

test("a recorded path turned into a link blocks, whatever it points at", () => {
  const b = box("link");
  initWrites(b, WIRING);
  const copy = join(b.home, "shim-copy.cjs");
  writeFileSync(copy, WIRING[".claude/helpers/trail-hooks.cjs"]!);
  rmSync(join(b.repo, ".claude", "helpers", "trail-hooks.cjs"));
  symlinkSync(copy, join(b.repo, ".claude", "helpers", "trail-hooks.cjs"));
  assert.equal(clean(b)?.ok, false);
});

test("a real trail init: its files read clean until the person edits one", () => {
  // graft/ ignored as a teammate's earlier build committed it (the graph build is skipped here).
  const b = box("cli", { ".gitignore": "/graft/\n" });
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), "init", b.repo, "--agents", "claude", "--yes", "--no-global", "--no-build"], {
    encoding: "utf8",
    env: { ...GIT_ENV, ...b.env, USERPROFILE: b.home, DO_NOT_TRACK: "1", TRAIL_NO_LOOK_BACK: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined },
  });
  assert.equal(r.status, 0, r.stderr);
  const rec = readInstallRecord(b.repo, b.env);
  // #619's layout: the shared hook and its settings, the personal file and status line (both kept out of git), and .trail/'s own files.
  assert.deepEqual(Object.keys(rec ?? {}).sort(), [".claude/settings.json", ".claude/settings.local.json", ".trail/.gitignore", ".trail/README.md", ".trail/hook.cjs", ".trail/statusline.cjs"]);
  assert.equal(clean(b)?.ok, true);
  const settings = join(b.repo, ".claude", "settings.json");
  writeFileSync(settings, readFileSync(settings, "utf8").replace(/^\{/, '{\n  "model": "opus",'));
  assert.equal(clean(b)?.ok, false);
});

test("a repo moving from graft: init's deletion of the old graft skill (its whole folder) and shims is recorded, so it reads clean while they stay gone (fix-lab5)", () => {
  const b = box("from-graft", {
    ".gitignore": "/graft/\n",
    ".claude/skills/graft/SKILL.md": "---\nname: graft\n---\nold skill\n",
    ".claude/skills/graft/reference.md": "old reference\n",
    ".claude/helpers/graft-hooks.cjs": "// old shim\n",
  });
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), "init", b.repo, "--agents", "claude", "--yes", "--no-global", "--no-build"], {
    encoding: "utf8",
    env: { ...GIT_ENV, ...b.env, USERPROFILE: b.home, DO_NOT_TRACK: "1", TRAIL_NO_LOOK_BACK: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined },
  });
  assert.equal(r.status, 0, r.stderr);
  const rec = readInstallRecord(b.repo, b.env) ?? {};
  for (const rel of [".claude/skills/graft/SKILL.md", ".claude/skills/graft/reference.md", ".claude/helpers/graft-hooks.cjs"]) assert.equal(rec[rel], null, `${rel} recorded as deleted`);
  assert.equal(clean(b)?.ok, true, "init's own deletions don't read as uncommitted changes");
  put(b.repo, ".claude/skills/graft/SKILL.md", "brought back by hand\n");
  assert.equal(clean(b)?.ok, false, "brought back, it blocks again");
});

test("a repo trail set up before 0.23 moves to the shared hook (#619), and what init cleared away reads clean while it stays gone", () => {
  const old = "# .trail\n\nold readme\n";
  const b = box("old-trail", {
    ".gitignore": "/graft/\n",
    ".claude/settings.json": '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node \\"${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/trail-hooks.cjs\\" stop"}]}]}}\n',
    ".claude/helpers/trail-hooks.cjs": "// old shim\n",
    ".claude/helpers/trail-statusline.cjs": "// old status line\n",
    ".claude/skills/trail/SKILL.md": "---\nname: trail\n---\nold skill\n",
    ".mcp.json": '{"mcpServers":{"trail":{"command":"trail","args":["mcp"]}}}\n',
    ".trail/README.md": old,
  });
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), "init", b.repo, "--agents", "claude", "--yes", "--no-global", "--no-build"], {
    encoding: "utf8",
    env: { ...GIT_ENV, ...b.env, USERPROFILE: b.home, DO_NOT_TRACK: "1", TRAIL_NO_LOOK_BACK: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined },
  });
  assert.equal(r.status, 0, r.stderr);
  const rec = readInstallRecord(b.repo, b.env) ?? {};
  for (const rel of [".claude/helpers/trail-hooks.cjs", ".claude/helpers/trail-statusline.cjs", ".claude/skills/trail/SKILL.md", ".mcp.json"]) assert.equal(rec[rel], null, `${rel} recorded as deleted`);
  assert.ok(rec[".trail/hook.cjs"] && rec[".trail/.gitignore"] && rec[".claude/settings.json"], "and the new shared files as written");
  assert.equal(clean(b)?.ok, true, "init's own moves don't read as uncommitted changes");
  put(b.repo, ".mcp.json", '{"mcpServers":{"mine":{"command":"mine"}}}\n');
  assert.equal(clean(b)?.ok, false, "a file put back by hand blocks again");
});
