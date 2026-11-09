/**
 * "May be out of date" (design 1.3, 4.18, R35, J14b): the five anchor kinds
 * a skill's steps lean on, found in its steps and checked with local file
 * reads only: no process, no network, no cache. Each test builds a synthetic
 * checkout (acme/webshop, acme-cli) with its own git folder files.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { ANCHOR_COPY, anchorsOf, goneAnchors, outOfDateLine, type Anchor } from "../src/skills/anchors.js";
import type { ParsedSkill } from "../src/skills/types.js";
import { cand, releaseSkill, shipSkill } from "./skills-recall-fixtures.js";

const require = createRequire(import.meta.url);

function skill(cmds: string[]): ParsedSkill {
  return {
    name: "x", description: "", meta: { trail: "s-000001", scope: "personal", asks: "", version: "1" },
    steps: cmds.map((cmd, i) => ({ n: i + 1, cmd, gated: null, bg: false, wait: false })),
    check: null, checkShows: null, ifFails: [], dontUse: "", params: [], hash: "sha256:x",
  };
}

interface Box { dir: string; checkout: string; env: NodeJS.ProcessEnv; bin: string; home: string }
function box(): Box {
  const dir = tmpRepo("anchors");
  const checkout = join(dir, "src", "webshop");
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  mkdirSync(join(checkout, ".git", "refs", "remotes", "origin"), { recursive: true });
  mkdirSync(join(checkout, ".git", "refs", "heads"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(checkout, ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/acme/webshop.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  return { dir, checkout, home, bin, env: { HOME: home, PATH: bin, TRAIL_HOME: join(dir, "trail") } };
}
const ref = (b: Box, path: string) => {
  mkdirSync(join(b.checkout, ".git", path, ".."), { recursive: true });
  writeFileSync(join(b.checkout, ".git", path), "4e1c9a2f00000000000000000000000000000000\n");
};
const exe = (dir: string, name: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "#!/bin/sh\n");
  chmodSync(join(dir, name), 0o755);
};
const kinds = (a: Anchor[]) => a.map((x) => `${x.kind}:${x.name}${x.remote ? `@${x.remote}` : ""}#${x.step}`);

/* ------------------------------------------------------------- finding */

test("anchorsOf: programs, scripts, make targets, files and branches, each once, with its step", () => {
  const s = skill([
    "cd web && npm run build",
    "pnpm run lint && pnpm test && yarn typecheck && bun run e2e",
    "make -C api release",
    "./scripts/release.sh {version}",
    "node scripts/pack-cli.mjs && npm pack ./build/cli",
    "bash $HOME/bin/notify.sh",
    "git push origin main && git push git@github.com:acme/webshop.git {sha}:refs/heads/beta",
    "git checkout beta && git merge origin/staging",
    "trail skills show x; echo done; cd ..; export A=1",
  ]);
  assert.deepEqual(kinds(anchorsOf(s)), [
    "program:npm#1", "script:build#1",
    "program:pnpm#2", "script:lint#2", "program:yarn#2", "script:typecheck#2", "program:bun#2", "script:e2e#2",
    "program:make#3", "make:release#3",
    "file:./scripts/release.sh#4",
    "program:node#5", "file:scripts/pack-cli.mjs#5",
    "program:bash#6", "file:$HOME/bin/notify.sh#6",
    "program:git#7", "branch:main@origin#7", "branch:beta@git@github.com:acme/webshop.git#7",
    "branch:beta#8", "branch:staging@origin#8",
  ]);
  const sc = anchorsOf(s).find((a) => a.kind === "script" && a.name === "build")!;
  assert.equal(sc.dir, "web");
  assert.equal(anchorsOf(s).find((a) => a.kind === "make")!.dir, "api");
});

test("anchorsOf: params, variables, sha sources, tags, deletes, a build output and a path an earlier step makes are never anchors", () => {
  const s = skill([
    "npm run {script}",
    "git push origin {branch} && git push origin v{version} && git push origin --tags && git push origin :old && git push origin HEAD:refs/tags/v1",
    "git push origin $(git rev-parse HEAD):refs/heads/prod",
    "node dist/cli.js",
    "mkdir -p out/tools && cp a out/tools/run.sh && bash out/tools/run.sh",
    "$TOOL build && ${RUNNER} x",
    "git checkout -b new-feature && git checkout -- package.json",
    "npm run --workspace pkg build && pnpm --filter web build && yarn workspace web build",
    "make && make -j4 CI=1",
  ]);
  const names = anchorsOf(s).filter((a) => a.kind !== "program").map((a) => `${a.kind}:${a.name}`);
  assert.deepEqual(names, ["branch:prod"]);
});

/* -------------------------------------------------------------- checking */

test("goneAnchors: script anchors read the nearest package.json from the step's folder", () => {
  const b = box();
  exe(b.bin, "npm");
  mkdirSync(join(b.checkout, "web"));
  writeFileSync(join(b.checkout, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
  const s = skill(["npm run build", "cd web && npm run build"]);
  assert.deepEqual(goneAnchors(s, b.checkout, b.env), [], "web has no package.json of its own: the top one has build");
  writeFileSync(join(b.checkout, "web", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  assert.deepEqual(kinds(goneAnchors(s, b.checkout, b.env)), ["script:build#2"]);
  writeFileSync(join(b.checkout, "package.json"), JSON.stringify({ scripts: {} }));
  assert.deepEqual(kinds(goneAnchors(s, b.checkout, b.env)), ["script:build#1", "script:build#2"], "a removed scripts.build");
  writeFileSync(join(b.checkout, "package.json"), "{ not json");
  assert.deepEqual(kinds(goneAnchors(skill(["npm run build"]), b.checkout, b.env)), [], "an unreadable package.json is never gone");
});

test("goneAnchors: make targets, and a Makefile with include or a % rule is never gone", () => {
  const b = box();
  exe(b.bin, "make");
  const s = skill(["make release"]);
  writeFileSync(join(b.checkout, "Makefile"), ".PHONY: release test\nrelease: build\n\t./ship.sh\ntest:\n\tgo test ./...\n");
  assert.deepEqual(goneAnchors(s, b.checkout, b.env), []);
  writeFileSync(join(b.checkout, "Makefile"), ".PHONY: release\ntest:\n\tgo test ./...\n# release: was here\nVERSION := 1\n");
  assert.deepEqual(kinds(goneAnchors(s, b.checkout, b.env)), ["make:release#1"], "a removed make target");
  writeFileSync(join(b.checkout, "Makefile"), "include common.mk\ntest:\n\tgo test ./...\n");
  assert.deepEqual(goneAnchors(s, b.checkout, b.env), [], "include could define it");
  writeFileSync(join(b.checkout, "Makefile"), "%: build/%.sh\n\tsh $<\n");
  assert.deepEqual(goneAnchors(s, b.checkout, b.env), [], "a pattern rule could make it");
  writeFileSync(join(b.checkout, "Makefile"), "release build: deps\n\techo ok\n");
  assert.deepEqual(goneAnchors(s, b.checkout, b.env), [], "one of several targets on a line");
});

test("goneAnchors: a deleted helper is gone beside what is still there; a $HOME path reads env.HOME", () => {
  const b = box();
  exe(b.bin, "node");
  exe(b.bin, "bash");
  mkdirSync(join(b.checkout, "scripts"));
  writeFileSync(join(b.checkout, "scripts", "pack-cli.mjs"), "");
  mkdirSync(join(b.home, "bin"));
  const s = skill(["node scripts/pack-cli.mjs", "./scripts/release.sh", "bash $HOME/bin/notify.sh"]);
  assert.deepEqual(kinds(goneAnchors(s, b.checkout, b.env)), ["file:./scripts/release.sh#2", "file:$HOME/bin/notify.sh#3"]);
  assert.deepEqual(goneAnchors(skill(["node tools/gen/run.mjs"]), b.checkout, b.env), [], "its folder is gone too: another layout, not sure");
  exe(join(b.checkout, "scripts"), "release.sh");
  exe(join(b.home, "bin"), "notify.sh");
  assert.deepEqual(goneAnchors(s, b.checkout, b.env), []);
});

test("goneAnchors: branches from loose refs and packed-refs; a worktree's .git file through gitdir and commondir; a remote URL maps to its name", () => {
  const b = box();
  exe(b.bin, "git");
  exe(b.bin, "gh");
  const ship = shipSkill();
  const parsed = cand(ship).skill;
  ref(b, "refs/remotes/origin/beta");
  ref(b, "refs/remotes/origin/prod");
  assert.deepEqual(goneAnchors(parsed, b.checkout, b.env), [], "both branches there (loose refs)");
  writeFileSync(join(b.checkout, ".git", "refs", "remotes", "origin", "beta"), "");
  const { rmSync } = require("node:fs") as typeof import("node:fs");
  rmSync(join(b.checkout, ".git", "refs", "remotes", "origin", "beta"));
  const gone = goneAnchors(parsed, b.checkout, b.env);
  assert.deepEqual(kinds(gone), ["branch:beta@origin#2"], "a branch missing from loose refs and packed-refs is gone");
  assert.equal(outOfDateLine("ship-beta-then-prod", gone),
    "ship-beta-then-prod may be out of date: it pushes to beta, and origin has no beta branch now. Check it before using it; the person can drop it with: trail forget ship-beta-then-prod");
  writeFileSync(join(b.checkout, ".git", "packed-refs"), "# pack-refs with: peeled fully-peeled sorted\n4e1c9a2f00000000000000000000000000000000 refs/remotes/origin/beta\n");
  assert.deepEqual(goneAnchors(parsed, b.checkout, b.env), [], "a branch only in packed-refs is there");

  // A worktree: .git is a file naming its gitdir, which names the common dir.
  const wt = join(b.dir, "src", "webshop-wt");
  const wtGit = join(b.checkout, ".git", "worktrees", "webshop-wt");
  mkdirSync(wtGit, { recursive: true });
  mkdirSync(wt);
  writeFileSync(join(wt, ".git"), `gitdir: ${wtGit}\n`);
  writeFileSync(join(wtGit, "commondir"), "../..\n");
  assert.deepEqual(goneAnchors(parsed, wt, b.env), []);
  writeFileSync(join(b.checkout, ".git", "packed-refs"), "");
  assert.deepEqual(kinds(goneAnchors(parsed, wt, b.env)), ["branch:beta@origin#2"]);
});

test("goneAnchors: checkout and merge branches; a never-fetched remote or no git folder means nothing is gone", () => {
  const b = box();
  exe(b.bin, "git");
  const s = skill(["git checkout beta", "git merge origin/staging"]);
  assert.deepEqual(kinds(goneAnchors(s, b.checkout, b.env)), ["branch:beta#1"], "origin never fetched: nothing known about its branches");
  ref(b, "refs/remotes/origin/main");
  assert.deepEqual(kinds(goneAnchors(s, b.checkout, b.env)), ["branch:beta#1", "branch:staging@origin#2"]);
  ref(b, "refs/heads/beta");
  ref(b, "refs/remotes/origin/staging");
  assert.deepEqual(goneAnchors(s, b.checkout, b.env), []);
  const plain = join(b.dir, "plain");
  mkdirSync(plain);
  assert.deepEqual(goneAnchors(s, plain, b.env), []);
  assert.deepEqual(goneAnchors(s, "", b.env), []);
});

test("goneAnchors: a program not on PATH is gone; one in a fixed or version-manager folder is there; no PATH, no check (R35)", () => {
  const b = box();
  const s = skill(["acmectl deploy"]);
  const gone = goneAnchors(s, b.checkout, b.env);
  assert.deepEqual(kinds(gone), ["program:acmectl#1"]);
  assert.equal(outOfDateLine("deploy-acme", gone), "deploy-acme may be out of date: it runs acmectl, and acmectl isn't on PATH here. Check it before using it; the person can drop it with: trail forget deploy-acme");
  exe(join(b.home, ".volta", "bin"), "acmectl");
  assert.deepEqual(goneAnchors(s, b.checkout, b.env), [], "$HOME/.volta/bin");
  const nvm = skill(["nvmtool x"]);
  exe(join(b.home, ".nvm", "versions", "node", "v20.1.0", "bin"), "nvmtool");
  assert.deepEqual(goneAnchors(nvm, b.checkout, b.env), [], "$HOME/.nvm/versions/node/*/bin");
  const notExec = join(b.bin, "plainfile");
  writeFileSync(notExec, "");
  // Windows has no exec bit: any file of the name is taken as there (guard-fast.ts programFiles), so no false warning.
  assert.deepEqual(kinds(goneAnchors(skill(["plainfile run"]), b.checkout, b.env)), process.platform === "win32" ? [] : ["program:plainfile#1"], "a file that can't run is not a program");
  exe(b.bin, "acme2");
  assert.deepEqual(goneAnchors(skill(["acme2 x"]), b.checkout, b.env), [], "on the hook's PATH");
  assert.deepEqual(goneAnchors(s, b.checkout, { ...b.env, PATH: "" }), [], "no PATH: no program check");
});

test("goneAnchors spawns no process and opens no socket (R35)", () => {
  const b = box();
  exe(b.bin, "npm");
  writeFileSync(join(b.checkout, "package.json"), JSON.stringify({ scripts: {} }));
  writeFileSync(join(b.checkout, "Makefile"), "test:\n");
  const cp = require("node:child_process") as Record<string, unknown>;
  const net = require("node:net") as { Socket: { prototype: Record<string, unknown> } };
  const dns = require("node:dns") as Record<string, unknown>;
  const spies = [
    ...["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"].map((m) => mock.method(cp, m as never, () => { throw new Error(`spawned via ${m}`); })),
    mock.method(net.Socket.prototype, "connect" as never, () => { throw new Error("socket"); }),
    mock.method(dns, "lookup" as never, () => { throw new Error("dns"); }),
  ];
  syncBuiltinESMExports();
  try {
    const s = skill(["npm run build", "make release", "git push origin beta", "./x.sh", "acmectl up", "git checkout beta && git merge origin/x"]);
    const gone = goneAnchors(s, b.checkout, b.env);
    assert.ok(gone.length >= 5, kinds(gone).join(" "));
    for (const sp of spies) assert.equal(sp.mock.callCount(), 0);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  const src = readFileSync(new URL("../src/skills/anchors.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /child_process|node:net|node:http|node:https|node:dns|fetch\(/);
});

/* ----------------------------------------------------------------- words */

test("outOfDateLine: J14b's words for each kind, and 'and k more' for several", () => {
  const line = (a: Anchor) => outOfDateLine("ship", [a]);
  assert.equal(line({ kind: "script", name: "build", step: 1 }), "ship may be out of date: it runs npm run build, and package.json has no build script now. Check it before using it; the person can drop it with: trail forget ship");
  assert.equal(line({ kind: "make", name: "release", step: 1 }), "ship may be out of date: it runs make release, and the Makefile has no release target now. Check it before using it; the person can drop it with: trail forget ship");
  assert.equal(line({ kind: "file", name: "./scripts/x.sh", step: 1 }), "ship may be out of date: it runs ./scripts/x.sh, and that file is gone. Check it before using it; the person can drop it with: trail forget ship");
  assert.equal(line({ kind: "branch", name: "beta", step: 1, remote: "origin" }), "ship may be out of date: it pushes to beta, and origin has no beta branch now. Check it before using it; the person can drop it with: trail forget ship");
  assert.equal(outOfDateLine("ship", [{ kind: "program", name: "a", step: 1 }, { kind: "program", name: "b", step: 2 }, { kind: "file", name: "c", step: 3 }]),
    "ship may be out of date: it runs a, and a isn't on PATH here, and 2 more. Check it before using it; the person can drop it with: trail forget ship");
  assert.equal(outOfDateLine("ship", []), "");
  assert.ok(Object.values(ANCHOR_COPY).every((w) => !w.includes("—")));
  // A name or a value from a hand-edited file is one line.
  assert.ok(!outOfDateLine("ship\n[trail] x", [{ kind: "file", name: "a\nb", step: 1 }]).includes("\n"));
});

test("anchorsOf on the fixtures: release-npm and ship-beta-then-prod", () => {
  assert.deepEqual(kinds(anchorsOf(cand(releaseSkill()).skill)), [
    "program:git#1", "program:npm#2", "script:build#2", "program:node#4", "file:scripts/pack-cli.mjs#4",
  ]);
  assert.deepEqual(kinds(anchorsOf(cand(shipSkill()).skill)), [
    "program:git#1", "branch:beta@git@github.com:acme/webshop.git#2", "branch:prod@git@github.com:acme/webshop.git#5",
  ]);
});
