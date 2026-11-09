/**
 * c4 review (phase 2 design 4.13, P22 to P25, D100, D109): wider anchors that
 * read as gone when they aren't, a cache that can hang a hook or be read
 * through a link, and checks that ran past their caps. Synthetic checkouts
 * (acme/shop, acme-cli) in sandbox folders, each with its own Trail home.
 */
import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpRepo } from "./helpers.js";
import { cloneShape } from "./anchors-clone-fixture.js";
import { wideGone, type WideAnchor } from "../src/skills/anchors-wide.js";
import { goneAnchors, outOfDateLine } from "../src/skills/anchors.js";
import type { ParsedSkill } from "../src/skills/types.js";
import { promptSkills, type PromptDeps } from "../src/claude/prompt-skills.js";
import { releaseSkill, WEBSHOP } from "./skills-recall-fixtures.js";
import { box as promptBox, CWD, gateFor, payload, save } from "./skills-prompt-fixtures.js";
import { timeBar } from "./machine-speed.js";

const require = createRequire(import.meta.url);

function skill(cmds: string[]): ParsedSkill {
  return {
    name: "x", description: "", meta: { trail: "s-000001", scope: "personal", asks: "", version: "1" },
    steps: cmds.map((cmd, i) => ({ n: i + 1, cmd, gated: null, bg: false, wait: false })),
    check: null, checkShows: null, ifFails: [], dontUse: "", params: [], hash: "sha256:x",
  };
}

interface Box { dir: string; checkout: string; env: NodeJS.ProcessEnv; trail: string }
const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
function box(tag: string): Box {
  const dir = tmpRepo(`wide-rv-${tag}`);
  made.push(dir);
  const checkout = join(dir, "src", "shop");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  cloneShape(checkout);
  const trail = join(dir, "trail");
  return { dir, checkout, trail, env: { HOME: join(dir, "home"), PATH: join(dir, "bin"), TRAIL_HOME: trail } };
}
const put = (b: Box, rel: string, text: string) => {
  mkdirSync(join(b.checkout, rel, ".."), { recursive: true });
  writeFileSync(join(b.checkout, rel), text);
};
const kinds = (a: WideAnchor[]) => a.map((x) => `${x.kind}:${x.name}#${x.step}`);
const gone = (b: Box, cmds: string[], scan = true) => kinds(wideGone(skill(cmds), b.checkout, b.env, { scan, deadline: Date.now() + 10_000 }));
const CI = ".github/workflows";
const PKG = JSON.stringify({ name: "@acme/cli", bin: { acme: "dist/cli.js" } });
const THREE = "program.command('init');\nprogram.command('status');\nprogram.command('build');\n";
function cliBox(tag: string, src = THREE): Box {
  const b = box(tag);
  put(b, "package.json", PKG);
  put(b, "src/cli.ts", src);
  return b;
}
const cachePath = (b: Box) => join(b.trail, "state", "anchors-cache.json");

/* ---------------------------------------------------------------- cache */

test("cache: a FIFO at the cache path doesn't hold SessionStart (D100)", { skip: process.platform === "win32" }, () => {
  // Windows has no FIFO.
  const b = cliBox("fifo");
  mkdirSync(join(b.trail, "state"), { recursive: true });
  execFileSync("mkfifo", [cachePath(b)]);
  const mod = new URL("../src/skills/anchors-wide.ts", import.meta.url).href;
  const code = `const { wideGone } = await import(${JSON.stringify(mod)});
    const s = { name: 'x', description: '', meta: { trail: 's-000001', scope: 'personal', asks: '', version: '1' }, steps: [{ n: 1, cmd: 'acme deploy', gated: null, bg: false, wait: false }], check: null, checkShows: null, ifFails: [], dontUse: '', params: [], hash: 'sha256:x' };
    process.stdout.write(JSON.stringify(wideGone(s, ${JSON.stringify(b.checkout)}, ${JSON.stringify(b.env)}, { scan: false })));`;
  const t = Date.now();
  const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 8000, encoding: "utf8" });
  assert.equal(out, "[]");
  assert.ok(Date.now() - t < 8000);
});

test("cache: a link at the cache path, and a cache over its size cap, are not read", () => {
  const b = cliBox("link");
  assert.deepEqual(gone(b, ["acme deploy"]), ["subcommand:deploy#1"], "a scan fills the cache");
  assert.deepEqual(gone(b, ["acme deploy"], false), ["subcommand:deploy#1"], "SessionStart reads it");
  const elsewhere = join(b.dir, "planted.json");
  renameSync(cachePath(b), elsewhere);
  symlinkSync(elsewhere, cachePath(b));
  assert.deepEqual(gone(b, ["acme deploy"], false), [], "a link at the cache path is not followed");
  rmSync(cachePath(b));
  writeFileSync(cachePath(b), readFileSync(elsewhere, "utf8") + " ".repeat(2 * 1024 * 1024));
  assert.deepEqual(gone(b, ["acme deploy"], false), [], "a 2 MB cache is not read");
});

test("cache: a program of the same name in two packages of one checkout is cached per package", () => {
  const b = box("two-pkgs");
  put(b, "packages/a/package.json", JSON.stringify({ name: "acme", bin: { acme: "cli.js" } }));
  put(b, "packages/a/src/cli.ts", THREE);
  put(b, "packages/b/package.json", JSON.stringify({ name: "acme", bin: { acme: "cli.js" } }));
  put(b, "packages/b/src/cli.ts", `${THREE}program.command('deploy');\n`);
  assert.deepEqual(gone(b, ["cd packages/a && acme deploy"]), ["subcommand:deploy#1"], "a has no deploy");
  assert.deepEqual(gone(b, ["cd packages/b && acme deploy"], false), [], "b's deploy is not judged from a's names");
  assert.deepEqual(gone(b, ["cd packages/b && acme deploy"]), [], "b has deploy");
  assert.deepEqual(gone(b, ["cd packages/a && acme deploy"], false), ["subcommand:deploy#1"], "a's entry is still there");
  assert.deepEqual(gone(b, ["cd packages/b && acme deploy"], false), [], "and b's");
});

/* --------------------------------------------------------------- sparse */

test("a sparse checkout leaves files out on purpose: CI files and subcommands are not judged there (D109)", () => {
  const b = cliBox("sparse");
  put(b, `${CI}/ci.yml`, "name: CI\n");
  put(b, "compose.yaml", "services:\n  web:\n    image: x\n");
  assert.deepEqual(gone(b, ["gh workflow run deploy.yml", "gh workflow run Deploy", "docker compose up db", "acme deploy"]),
    ["ci-file:deploy.yml#1", "ci-file:Deploy#2", "service:db#3", "subcommand:deploy#4"]);
  put(b, ".git/info/sparse-checkout", "/.github/workflows/ci.yml\n/compose.yaml\n/package.json\n/src/cli.ts\n");
  assert.deepEqual(gone(b, ["gh workflow run deploy.yml", "gh workflow run Deploy", "docker compose up db", "acme deploy"]),
    ["service:db#3"], "a compose file that is there is whole: its services are still known");
});

/* -------------------------------------------------------------- ci-file */

test("ci-file: a byte-order mark, a quoted name key, or an indented document is not read as 'no name'", () => {
  const b = box("ci-bom");
  put(b, `${CI}/r.yml`, "﻿name: Release\non: push\n");
  put(b, `${CI}/s.yml`, "\"name\": Ship\n\"on\": push\n");
  put(b, `${CI}/t.yml`, "'name': Tag\n");
  assert.deepEqual(gone(b, ["gh workflow run Release", "gh workflow run Ship", "gh workflow run Tag"]), []);
  const c = box("ci-indent");
  put(c, `${CI}/r.yml`, "  name: Release\n  on: push\n");
  assert.deepEqual(gone(c, ["gh workflow run Release"]), [], "a document indented as a whole: not sure");
  put(c, `${CI}/r.yml`, "name: CI\non: push\n");
  assert.deepEqual(gone(c, ["gh workflow run Release"]), ["ci-file:Release#1"], "plain files still judge");
});

test("ci-file: many CI anchors read the folder once, inside the scan's deadline (the 400 ms prompt cap)", () => {
  const b = box("ci-cost");
  for (let i = 0; i < 64; i++) put(b, `${CI}/w${i}.yml`, `name: W${i}\non: push\n`);
  const cmds = Array.from({ length: 12 }, (_, i) => `gh workflow run Nope${i}`);
  const fs = require("node:fs") as Record<string, (...a: unknown[]) => unknown>;
  const orig = fs.readFileSync!;
  let reads = 0;
  // A slow disk: each file read takes 4 ms.
  mock.method(fs, "readFileSync" as never, ((...a: unknown[]) => {
    if (String(a[0]).includes(".github")) { reads++; const end = Date.now() + 4; while (Date.now() < end) { /* slow disk */ } }
    return orig(...a);
  }) as never);
  syncBuiltinESMExports();
  let out: WideAnchor[];
  const t = Date.now();
  try {
    out = wideGone(skill(cmds), b.checkout, b.env, { scan: true, deadline: Date.now() + 150 });
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  const took = Date.now() - t;
  assert.ok(reads <= 64, `each CI file read at most once (${reads} reads)`);
  // The 150 ms deadline, and what a slow machine adds around it.
  assert.ok(took < 150 + timeBar(250, 750), `inside the cap (${took} ms)`);
  assert.ok(out.length === 0 || out.length === 12, "past the deadline nothing is judged; inside it, all are");
});

test("ci-file: gh runs the default branch's CI file on GitHub, so this folder judges only on that branch, at the commit fetched, with one remote", () => {
  const cmds = ["gh workflow run deploy.yml", "gh workflow run Deploy"];
  const ok = box("ci-main");
  put(ok, `${CI}/ci.yml`, "name: CI\n");
  assert.deepEqual(gone(ok, cmds), ["ci-file:deploy.yml#1", "ci-file:Deploy#2"], "on main at origin/main");
  assert.deepEqual(gone(ok, ["gh workflow run deploy.yml --ref main"]), ["ci-file:deploy.yml#1"], "--ref names this branch");
  assert.deepEqual(gone(ok, ["gh workflow run deploy.yml --ref v1.x", "gh workflow run Deploy -r v1.x"]), [], "--ref names another branch");
  const old = box("ci-old-branch");
  put(old, `${CI}/ci.yml`, "name: CI\n");
  cloneShape(old.checkout, { head: "v1.x" });
  assert.deepEqual(gone(old, cmds), [], "an older branch: the default branch may have it");
  const behind = box("ci-behind");
  put(behind, `${CI}/ci.yml`, "name: CI\n");
  cloneShape(behind.checkout, { fetched: "b".repeat(40) });
  assert.deepEqual(gone(behind, cmds), [], "main is behind (or ahead of) what was fetched");
  const fork = box("ci-fork");
  put(fork, `${CI}/ci.yml`, "name: CI\n");
  cloneShape(fork.checkout, { remotes: ["origin", "upstream"] });
  assert.deepEqual(gone(fork, cmds), [], "two remotes: gh may act on upstream");
  const detached = box("ci-detached");
  put(detached, `${CI}/ci.yml`, "name: CI\n");
  writeFileSync(join(detached.checkout, ".git", "HEAD"), `${"a".repeat(40)}\n`);
  assert.deepEqual(gone(detached, cmds), [], "a detached HEAD");
  const packed = box("ci-packed");
  put(packed, `${CI}/ci.yml`, "name: CI\n");
  rmSync(join(packed.checkout, ".git", "refs", "heads", "main"));
  rmSync(join(packed.checkout, ".git", "refs", "remotes", "origin", "main"));
  writeFileSync(join(packed.checkout, ".git", "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${"a".repeat(40)} refs/heads/main\n${"a".repeat(40)} refs/remotes/origin/main\n`);
  assert.deepEqual(gone(packed, cmds), ["ci-file:deploy.yml#1", "ci-file:Deploy#2"], "packed refs are read");
});

test("ci-file: a git worktree reads its own HEAD", () => {
  const b = box("ci-worktree");
  put(b, `${CI}/ci.yml`, "name: CI\n");
  const wt = join(b.dir, "wt");
  mkdirSync(join(wt, CI), { recursive: true });
  writeFileSync(join(wt, CI, "ci.yml"), "name: CI\n");
  const gd = join(b.checkout, ".git", "worktrees", "wt");
  mkdirSync(gd, { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${gd}\n`);
  writeFileSync(join(gd, "commondir"), "../..\n");
  writeFileSync(join(gd, "HEAD"), "ref: refs/heads/feature\n");
  writeFileSync(join(b.checkout, ".git", "refs", "heads", "feature"), `${"a".repeat(40)}\n`);
  const s = skill(["gh workflow run deploy.yml"]);
  assert.deepEqual(kinds(wideGone(s, wt, b.env, { scan: true, deadline: Date.now() + 10_000 })), [], "the worktree is on feature");
  writeFileSync(join(gd, "HEAD"), "ref: refs/heads/main\n");
  assert.deepEqual(kinds(wideGone(s, wt, b.env, { scan: true, deadline: Date.now() + 10_000 })), ["ci-file:deploy.yml#1"], "on main");
});

/* ----------------------------------------------------------- subcommand */

test("subcommand: a linked folder under src/ can hold registrations: not judged", () => {
  const b = cliBox("sub-link");
  put(b, "shared/cmds/deploy.ts", "program.command('deploy');\n");
  symlinkSync(join(b.checkout, "shared", "cmds"), join(b.checkout, "src", "cmds"));
  assert.deepEqual(gone(b, ["acme deploy"]), []);
  assert.deepEqual(gone(b, ["acme connect"]), [], "the whole CLI is not sure");
});

test("subcommand: .mts, .cts, .tsx and .jsx files are read", () => {
  for (const ext of ["mts", "cts", "tsx", "jsx"]) {
    const b = cliBox(`sub-${ext}`);
    put(b, `src/deploy.${ext}`, "program.command('deploy');\n");
    assert.deepEqual(gone(b, ["acme deploy"]), [], ext);
    assert.deepEqual(gone(b, ["acme connect"]), ["subcommand:connect#1"], ext);
  }
});

test("subcommand: createCommand, a yargs commandDir and a completion command are not seen as names: not judged", () => {
  const cc = cliBox("sub-create", `${THREE}program.addCommand(createCommand('deploy'));\n`);
  assert.deepEqual(gone(cc, ["acme deploy"]), [], "createCommand('deploy') registers deploy");
  assert.deepEqual(gone(cc, ["acme connect"]), ["subcommand:connect#1"], "a literal createCommand is a plain registration");
  const dir = cliBox("sub-dir", `${THREE}yargs.commandDir('cmds');\n`);
  put(dir, "src/cmds/deploy.js", "exports.command = 'deploy';\n");
  assert.deepEqual(gone(dir, ["acme deploy"]), [], "commands from a folder can't be listed: not sure");
  const comp = cliBox("sub-comp", `${THREE}yargs.completion();\n`);
  assert.deepEqual(gone(comp, ["acme completion"]), [], "yargs adds a completion command");
});

test("subcommand: the bin target is read too when it is outside src/", () => {
  const b = box("sub-bin");
  put(b, "package.json", JSON.stringify({ name: "acme", bin: { acme: "bin/acme.js" } }));
  put(b, "bin/acme.js", "program.command('deploy');\nrequire('../src/sub');\n");
  put(b, "src/sub.ts", "sub.command('add');\nsub.command('list');\nsub.command('remove');\n");
  assert.deepEqual(gone(b, ["acme deploy"]), []);
  assert.deepEqual(gone(b, ["acme connect"]), ["subcommand:connect#1"]);
});

/* ---------------------------------------------------------------- words */

test("P22: a compose file inside the Actions folder is not judged, so its path is never printed", () => {
  const b = box("p22");
  put(b, `${CI}/compose.yml`, "services:\n  web:\n    image: x\n");
  const s = skill(["docker compose -f .github/workflows/compose.yml up db"]);
  assert.deepEqual(kinds(wideGone(s, b.checkout, b.env, { scan: true, deadline: Date.now() + 10_000 })), []);
  const line = outOfDateLine("ship", goneAnchors(s, b.checkout, b.env, { scan: true, deadline: Date.now() + 10_000 }));
  assert.doesNotMatch(line, /\.github|workflows/);
});

/* ---------------------------------------------------------- prompt cap */

test("the prompt hook's 400 ms: a job cue's block gives the subcommand scan only what the hook's deadline leaves", () => {
  const goneCount = (out: string) => {
    const m = /may be out of date: [^.]*?(?:, and (\d+) more)?\. Check it/.exec(out);
    return m ? 1 + Number(m[1] ?? 0) : 0;
  };
  const counts: number[] = [];
  for (const late of [false, true]) {
    const b = promptBox(`wide-rv-cap-${late}`);
    made.push(b.home);
    save(b, releaseSkill({ applies: WEBSHOP, trail: "s-7f3a2c" }));
    const f = join(b.env.TRAIL_HOME!, "skills", "release-npm", "SKILL.md");
    writeFileSync(f, readFileSync(f, "utf8").replace("1. `git pull --ff-only origin main`", "1. `acme connect`"));
    writeFileSync(join(b.repo, "package.json"), PKG);
    mkdirSync(join(b.repo, "src"), { recursive: true });
    writeFileSync(join(b.repo, "src", "cli.ts"), THREE);
    // The hook reads its clock at its start, before the cue, after it, and before the probes: there, the 400 ms are used.
    let calls = 0;
    const start = Date.now();
    const clock = () => (!late || ++calls <= 3 ? start : start + 400);
    const d: Partial<PromptDeps> = { track: () => {}, gate: gateFor(b), clock };
    const out = promptSkills(payload(b, "can you pull and publish 1.4.2"), CWD, b.env, d).context ?? "";
    assert.match(out, /Skill release-npm fits/, `the block comes (late: ${late})`);
    counts.push(goneCount(out));
  }
  assert.ok(counts[0]! >= 1, "with time: the CLI is scanned and connect is gone");
  assert.equal(counts[1], counts[0]! - 1, "no time left: the CLI isn't scanned, so the subcommand isn't judged");
});
