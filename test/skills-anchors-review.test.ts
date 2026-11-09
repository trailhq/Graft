/**
 * Review attacks on b3's anchors (design 4.18, R35, R55, J14b): "may be out of
 * date" must be said only when Trail is sure. Each test is a false "gone" a
 * real checkout can give (a submodule, a shell function, a step that sets up
 * its own PATH, a package bin run through yarn, a Makefile's variable
 * targets, a sparse checkout, an unreadable nearest file, reftable), or the
 * time and the env the check runs with. Synthetic checkouts only.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { goneAnchors, type Anchor } from "../src/skills/anchors.js";
import type { ParsedSkill } from "../src/skills/types.js";

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
  const dir = tmpRepo("b3rev-anchors");
  const checkout = join(dir, "src", "webshop");
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  mkdirSync(join(checkout, ".git", "refs", "remotes", "origin"), { recursive: true });
  mkdirSync(join(checkout, ".git", "refs", "heads"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(checkout, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/acme/webshop.git\n');
  writeFileSync(join(checkout, ".git", "refs", "remotes", "origin", "main"), `${"4e1c9a2f".padEnd(40, "0")}\n`);
  for (const p of ["git", "npm", "yarn", "pnpm", "bun", "make", "node", "python3", "sh", "bash"]) exe(bin, p);
  return { dir, checkout, home, bin, env: { HOME: home, PATH: bin, TRAIL_HOME: join(dir, "trail") } };
}
function exe(dir: string, name: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "#!/bin/sh\n");
  chmodSync(join(dir, name), 0o755);
}
const kinds = (a: Anchor[]) => a.map((x) => `${x.kind}:${x.name}${x.remote ? `@${x.remote}` : ""}#${x.step}`);
const gone = (b: Box, cmds: string[], env = b.env) => kinds(goneAnchors(skill(cmds), b.checkout, env));

/* ---------------------------------------------------------------- branches */

test("a branch a step pushes from a submodule (cd sub, git -C sub) is read from the submodule's git folder, not the superproject's", () => {
  const b = box();
  const mod = join(b.checkout, ".git", "modules", "sub");
  mkdirSync(join(mod, "refs", "remotes", "origin"), { recursive: true });
  writeFileSync(join(mod, "config"), '[remote "origin"]\n\turl = https://github.com/acme/webshop-sub.git\n');
  writeFileSync(join(mod, "refs", "remotes", "origin", "feat"), `${"1".repeat(40)}\n`);
  mkdirSync(join(b.checkout, "sub"));
  writeFileSync(join(b.checkout, "sub", ".git"), "gitdir: ../.git/modules/sub\n");
  assert.deepEqual(gone(b, ["cd sub && git push origin feat"]), []);
  assert.deepEqual(gone(b, ["git -C sub push origin feat"]), []);
  assert.deepEqual(gone(b, ["git --git-dir=../other/.git push origin feat"]), [], "a git folder named some other way: not sure");
  assert.deepEqual(gone(b, ["cd sub && git push origin gone-branch"]), ["branch:gone-branch@origin#1"], "the submodule's own refs still say gone");
  assert.deepEqual(gone(b, ["git push origin feat"]), ["branch:feat@origin#1"], "the superproject has no feat");
});

test("reftable: no loose refs and no packed-refs to read, so no branch is ever gone", () => {
  const b = box();
  mkdirSync(join(b.checkout, ".git", "reftable"));
  assert.deepEqual(gone(b, ["git checkout beta", "git push origin beta"]), []);
});

/* ---------------------------------------------------------------- programs */

test("shell builtins and shell functions are never 'not on PATH' (nvm, pushd, popd, zsh's print)", () => {
  const b = box();
  for (const step of ["pushd web && npm ci && popd", "print -r -- done", "nvm use 20", "rvm use 3.2", "sdk use java 21"]) assert.deepEqual(gone(b, [step]), [], step);
});

test("after a step sets up its own PATH (source, ., nvm use, export PATH, PATH=..., eval), later programs are not judged", () => {
  const b = box();
  mkdirSync(join(b.checkout, ".venv", "bin"), { recursive: true });
  writeFileSync(join(b.checkout, ".venv", "bin", "activate"), "");
  writeFileSync(join(b.checkout, "env.sh"), "");
  assert.deepEqual(gone(b, ["source .venv/bin/activate && pytest -q"]), []);
  assert.deepEqual(gone(b, [". ./env.sh", "acmectl deploy"]), []);
  assert.deepEqual(gone(b, ['export PATH="$PWD/tools:$PATH" && acmectl up']), []);
  assert.deepEqual(gone(b, ["PATH=./tools:$PATH acmectl up"]), []);
  assert.deepEqual(gone(b, ['eval "$(direnv export bash)"', "acmectl up"]), []);
  assert.deepEqual(gone(b, ["acmectl up", "source .venv/bin/activate"]), ["program:acmectl#1"], "before the PATH change it is still judged");
});

/* ----------------------------------------------------------------- scripts */

test("yarn X, pnpm X and bun run X can run a package's bin, not only a script: gone only when node_modules/.bin is there without it", () => {
  const b = box();
  writeFileSync(join(b.checkout, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
  const steps = ["yarn eslint .", "pnpm vitest run", "bun run vite build", "yarn run tsc -p ."];
  assert.deepEqual(gone(b, steps), [], "no node_modules/.bin yet: not sure");
  mkdirSync(join(b.checkout, "node_modules", ".bin"), { recursive: true });
  for (const p of ["eslint", "vitest", "vite", "tsc"]) writeFileSync(join(b.checkout, "node_modules", ".bin", p), "");
  assert.deepEqual(gone(b, steps), [], "each is a bin there");
  assert.deepEqual(gone(b, ["yarn lint-all"]), ["script:lint-all#1"], "neither a script nor a bin");
  assert.deepEqual(gone(b, ["npm run eslint"]), ["script:eslint#1"], "npm run runs scripts only");
});

test("the nearest package.json that can't be read means not sure; it never falls through to a parent's", () => {
  const b = box();
  writeFileSync(join(b.checkout, "package.json"), JSON.stringify({ scripts: {} }));
  mkdirSync(join(b.checkout, "web"));
  writeFileSync(join(b.checkout, "web", "package.json"), `{"scripts":{"build":"vite build"},"x":"${"y".repeat(1_100_000)}"}`);
  assert.deepEqual(gone(b, ["cd web && npm run build"]), []);
});

/* -------------------------------------------------------------------- make */

test("make: targets named by a variable, define or eval could be X, so X is never gone; a GNUmakefile too big to read is not skipped for Makefile", () => {
  const b = box();
  const s = ["make release"];
  writeFileSync(join(b.checkout, "Makefile"), "BINS := release test\n$(BINS):\n\tgo build ./cmd/$@\n");
  assert.deepEqual(gone(b, s), []);
  writeFileSync(join(b.checkout, "Makefile"), "define RULE\n$(1):\n\techo $(1)\nendef\n$(eval $(call RULE,release))\n");
  assert.deepEqual(gone(b, s), []);
  writeFileSync(join(b.checkout, "Makefile"), "test:\n\tgo test ./...\n");
  assert.deepEqual(gone(b, s), ["make:release#1"], "a plain Makefile without it: gone");
  writeFileSync(join(b.checkout, "GNUmakefile"), `release:\n\t./ship.sh\n# ${"x".repeat(1_100_000)}\n`);
  assert.deepEqual(gone(b, s), [], "make reads GNUmakefile first; too big to read here is not sure");
});

/* ------------------------------------------------------------------- files */

test("a sparse checkout leaves files out on purpose: no file is ever gone there", () => {
  const b = box();
  mkdirSync(join(b.checkout, "scripts"));
  mkdirSync(join(b.checkout, ".git", "info"), { recursive: true });
  assert.deepEqual(gone(b, ["./scripts/release.sh"]), ["file:./scripts/release.sh#1"]);
  writeFileSync(join(b.checkout, ".git", "info", "sparse-checkout"), "/*\n!/scripts/release.sh\n");
  assert.deepEqual(gone(b, ["./scripts/release.sh"]), []);
});

/* -------------------------------------------------------------- env, time */

test("a hostile $USER never names a folder outside the fixed one ('..', '.', a slash)", () => {
  const b = box();
  const fs = require("node:fs") as typeof import("node:fs");
  const seen: string[] = [];
  const real = fs.statSync;
  const spy = mock.method(fs, "statSync", ((p: string, o?: object) => { seen.push(String(p)); return real(p, o as never); }) as never);
  syncBuiltinESMExports();
  try {
    for (const user of ["..", ".", "a/../../b"]) goneAnchors(skill(["acmectl up"]), b.checkout, { ...b.env, USER: user });
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
  assert.ok(seen.length > 0);
  assert.deepEqual(seen.filter((p) => p.includes("/etc/profiles/") && !p.includes("/per-user/")), []);
  assert.deepEqual(seen.filter((p) => /per-user\/\.{1,2}\//.test(p)), []);
});

test("session start: 5 skills against a 15 MB packed-refs stay inside the hook's budget (too big to read: not sure); a 2 MB one is read", () => {
  const b = box();
  const packedRefs = (mb: number) => {
    const lines: string[] = [];
    let size = 0;
    for (let i = 0; size < mb * 1024 * 1024; i++) {
      const l = `${"a".repeat(40)} refs/remotes/origin/feature/branch-number-${i}`;
      lines.push(l);
      size += l.length + 1;
    }
    lines.push(`${"b".repeat(40)} refs/remotes/origin/beta3`);
    writeFileSync(join(b.checkout, ".git", "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${lines.join("\n")}\n`);
  };
  packedRefs(15);
  const t0 = performance.now();
  const big = [0, 1, 2, 3, 4].map((s) => gone(b, [`git push origin beta${s}`]));
  const ms = performance.now() - t0;
  assert.deepEqual(big, [[], [], [], [], []]);
  assert.ok(ms < 60, `${ms.toFixed(0)} ms`);
  packedRefs(2);
  assert.deepEqual([0, 3].map((s) => gone(b, [`git push origin beta${s}`, `git checkout beta${s}`])),
    [["branch:beta0@origin#1", "branch:beta0#2"], []]);
});

test("the new checks spawn no process and open no socket either; neither anchors file can", () => {
  const b = box();
  mkdirSync(join(b.checkout, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(b.checkout, "package.json"), JSON.stringify({ scripts: {} }));
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
    const out = gone(b, ["cd sub && git push origin feat", "git -C web checkout beta", "yarn eslint .", "make -C api release", "./scripts/x.sh", "acmectl up"]);
    assert.ok(out.length >= 2, out.join(" "));
    for (const sp of spies) assert.equal(sp.mock.callCount(), 0);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  for (const f of ["anchors.ts", "anchors-git.ts"]) {
    const src = require("node:fs").readFileSync(new URL(`../src/skills/${f}`, import.meta.url), "utf8") as string;
    assert.doesNotMatch(src, /child_process|node:net|node:http|node:https|node:dns|fetch\(/, f);
  }
});
