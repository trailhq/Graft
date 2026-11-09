/**
 * Wider anchors (phase 2 design 1.4, 4.13, P22 to P25, P42): CI files, compose
 * services and the repo's own CLI subcommands, each gone only when Trail is
 * sure, checked with local file reads only. The subcommand scan runs only when
 * asked (`scan: true`) and is cached by its files' paths, sizes and mtimes;
 * SessionStart reads the cache and scans nothing. Synthetic checkouts
 * (acme/shop, acme-cli) in sandbox folders with their own Trail home.
 */
import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { cloneShape } from "./anchors-clone-fixture.js";
import { WIDE_SCAN_MS, wideAnchorsOf, wideGone, type WideAnchor } from "../src/skills/anchors-wide.js";
import { binTarget } from "../src/skills/anchors-cli.js";
import { goneAnchors } from "../src/skills/anchors.js";
import type { ParsedSkill } from "../src/skills/types.js";
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
  const dir = tmpRepo(`wide-${tag}`);
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
/** A scan here gets 10 s, so a loaded machine is no deadline; the 150 ms default has its own test. */
const gone = (b: Box, cmds: string[], scan = true, env = b.env) => kinds(wideGone(skill(cmds), b.checkout, env, { scan, deadline: Date.now() + 10_000 }));
const CI = ".github/workflows";

/* -------------------------------------------------------------- ci-file */

test("ci-file: a CI file named by its file name is gone when the folder is there and the file isn't", () => {
  const b = box("ci-file");
  put(b, `${CI}/ci.yml`, "name: CI\non: push\n");
  const cmds = ["gh workflow run deploy.yml --ref main", "gh run watch --workflow=deploy.yml", "gh run list --workflow release.yaml"];
  assert.deepEqual(kinds(wideAnchorsOf(skill(cmds), b.checkout, b.env)), ["ci-file:deploy.yml#1", "ci-file:release.yaml#3"]);
  assert.deepEqual(gone(b, cmds), ["ci-file:deploy.yml#1", "ci-file:release.yaml#3"]);
  put(b, `${CI}/deploy.yml`, "name: Deploy\n");
  put(b, `${CI}/release.yaml`, "name: Release\n");
  assert.deepEqual(gone(b, cmds), []);
  assert.deepEqual(gone(b, ["gh workflow run ci.yml -R acme/other"]), [], "another repo is never judged");
  assert.deepEqual(gone(b, ["gh workflow run 4417"]), [], "a workflow id is never judged");
});

test("ci-file: a CI name is gone when every file in the folder was read (3 here) and none has it", () => {
  const b = box("ci-name");
  put(b, `${CI}/ci.yml`, "name: CI\non: push\njobs:\n  test:\n    name: Deploy\n");
  put(b, `${CI}/lint.yaml`, "# lint\nname: \"Lint checks\" # quoted\n");
  put(b, `${CI}/release.yml`, "name: 'Release'\n");
  assert.deepEqual(gone(b, ["gh workflow run Deploy"]), ["ci-file:Deploy#1"], "a job's name is not the file's top-level name");
  assert.deepEqual(gone(b, ["gh workflow view \"Lint checks\""]), [], "a quoted top-level name");
  assert.deepEqual(gone(b, ["gh workflow enable release"]), [], "names match without case");
  assert.deepEqual(gone(b, ["gh workflow run lint"]), [], "a file named lint.yaml");
  put(b, `${CI}/odd.yml`, "name: >\n  Deploy\n");
  assert.deepEqual(gone(b, ["gh workflow run Deploy"]), [], "a folded name can't be read: not sure");
});

test("ci-file: the folder missing judges nothing; {param} and $x are never judged; 65 files judges nothing", () => {
  const b = box("ci-unsure");
  assert.deepEqual(gone(b, ["gh workflow run deploy.yml", "gh workflow run Deploy"]), [], "no Actions folder: another CI, not a deletion");
  put(b, `${CI}/ci.yml`, "name: CI\n");
  for (const c of ["gh workflow run {wf}", "gh workflow run $WF", "gh workflow run deploy-{env}.yml", "gh run list --workflow=$X"]) {
    assert.deepEqual(kinds(wideAnchorsOf(skill([c]), b.checkout, b.env)), [], c);
    assert.deepEqual(gone(b, [c]), [], c);
  }
  for (let i = 0; i < 63; i++) put(b, `${CI}/job-${i}.yml`, `name: Job ${i}\n`);
  assert.deepEqual(gone(b, ["gh workflow run Deploy"]), ["ci-file:Deploy#1"], "64 files are all read");
  put(b, `${CI}/job-63.yml`, "name: Job 63\n");
  assert.deepEqual(gone(b, ["gh workflow run Deploy"]), [], "65 files: not every one is read");
  assert.deepEqual(gone(b, ["gh workflow run deploy.yml"]), ["ci-file:deploy.yml#1"], "a file name needs no read");
});

test("ci-file: a file over 64 KB, GH_REPO on the line or in env, and a step folder in another repo judge nothing", () => {
  const b = box("ci-more");
  put(b, `${CI}/big.yml`, `name: Big\n${"#".repeat(65 * 1024)}\n`);
  assert.deepEqual(gone(b, ["gh workflow run Deploy"]), []);
  rmSync(join(b.checkout, CI, "big.yml"));
  put(b, `${CI}/ci.yml`, "name: CI\n");
  assert.deepEqual(gone(b, ["GH_REPO=acme/other gh workflow run Deploy"]), []);
  assert.deepEqual(gone(b, ["gh workflow run Deploy"], true, { ...b.env, GH_REPO: "acme/other" }), []);
  mkdirSync(join(b.checkout, "vendor", "tool", ".git"), { recursive: true });
  assert.deepEqual(gone(b, ["cd vendor/tool && gh workflow run Deploy"]), [], "a nested repo has its own CI");
  assert.deepEqual(gone(b, ["npm ci && cd web && gh workflow run Deploy"]), [], "a cd partway through: folder not known");
  assert.deepEqual(gone(b, ["gh workflow run Deploy"]), ["ci-file:Deploy#1"]);
});

/* -------------------------------------------------------------- service */

const COMPOSE = "services:\n  web:\n    image: acme/web\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_DB: shop\nvolumes:\n  data: {}\n";

test("service: a service word the compose file has no key for is gone; one it has is not", () => {
  const b = box("svc");
  put(b, "compose.yaml", COMPOSE);
  const a = wideAnchorsOf(skill(["docker compose up -d worker"]), b.checkout, b.env);
  assert.deepEqual(a, [{ kind: "service", name: "worker", step: 1, where: "compose.yaml" }]);
  assert.deepEqual(gone(b, ["docker compose up -d worker"]), ["service:worker#1"]);
  assert.deepEqual(gone(b, ["docker compose logs -f --tail 50 web", "docker-compose exec db psql -U shop", "docker compose run --rm -e A=1 web npm test"]), []);
  assert.deepEqual(gone(b, ["docker compose up -d web worker"]), ["service:worker#1"], "up takes several services");
  assert.deepEqual(gone(b, ["docker compose exec db worker"]), [], "after exec's service comes its command");
  assert.deepEqual(gone(b, ["docker compose up --weird x worker"]), [], "a flag not known: its value may be the next word");
  assert.deepEqual(gone(b, ["docker compose volumes data"]), [], "only up, run, exec, start, restart, logs and stop");
  put(b, "deploy/compose.prod.yml", "services:\n  api:\n    image: acme/api\n");
  assert.deepEqual(kinds(wideGone(skill(["docker compose -f deploy/compose.prod.yml run --rm worker"]), b.checkout, b.env, { scan: false })), ["service:worker#1"]);
  assert.deepEqual(wideAnchorsOf(skill(["docker compose -f deploy/compose.prod.yml up api"]), b.checkout, b.env)[0]?.where, "deploy/compose.prod.yml");
  assert.deepEqual(gone(b, ["docker compose -f deploy/compose.prod.yml up api"]), []);
  put(b, "infra/docker-compose.yml", "services:\n  queue:\n    image: redis\n");
  assert.deepEqual(gone(b, ["cd infra && docker compose up queue"]), []);
  assert.deepEqual(gone(b, ["cd infra && docker compose up web"]), ["service:web#1"], "the step's own folder's file");
  assert.deepEqual(gone(b, ["cd nowhere && docker compose up web"]), [], "no compose file in the step's folder: not judged");
});

test("service: two -f, COMPOSE_FILE on the line, in the repo's .env or in env, and an override file are not judged", () => {
  const b = box("svc-files");
  put(b, "compose.yaml", COMPOSE);
  put(b, "compose.dev.yaml", "services:\n  web:\n    image: x\n");
  assert.deepEqual(gone(b, ["docker compose -f compose.yaml -f compose.dev.yaml up worker"]), []);
  assert.deepEqual(gone(b, ["COMPOSE_FILE=compose.dev.yaml docker compose up worker"]), []);
  assert.deepEqual(gone(b, ["export COMPOSE_FILE=compose.dev.yaml", "docker compose up worker"]), []);
  assert.deepEqual(gone(b, ["docker compose up worker"], true, { ...b.env, COMPOSE_FILE: "compose.dev.yaml" }), []);
  assert.deepEqual(gone(b, ["docker compose --env-file prod.env up worker"]), []);
  assert.deepEqual(gone(b, ["docker compose up worker"]), ["service:worker#1"]);
  put(b, ".env", "TAG=1\nCOMPOSE_FILE=compose.yaml:compose.dev.yaml\n");
  assert.deepEqual(gone(b, ["docker compose up worker"]), []);
  rmSync(join(b.checkout, ".env"));
  put(b, "compose.override.yaml", "services:\n  worker:\n    image: x\n");
  assert.deepEqual(gone(b, ["docker compose up worker"]), [], "compose merges an override file on its own");
});

test("service: include, extends, a merge key and flow style are not judged; a 300 KB file is not read", () => {
  const b = box("svc-shapes");
  const shapes = [
    "include:\n  - other.yaml\nservices:\n  web:\n    image: x\n",
    "services:\n  web:\n    extends:\n      file: base.yaml\n      service: web\n",
    "x-base: &base\n  image: x\nservices:\n  web:\n    <<: *base\n",
    "services: { web: { image: x } }\n",
    "services:\n  web:\n    image: x\nservices:\n  db:\n    image: y\n",
  ];
  for (const s of shapes) {
    put(b, "compose.yaml", s);
    assert.deepEqual(gone(b, ["docker compose up worker"]), [], s);
  }
  put(b, "compose.yaml", `${COMPOSE}${"# pad\n".repeat(300 * 1024 / 6)}`);
  assert.ok(statSync(join(b.checkout, "compose.yaml")).size > 256 * 1024);
  assert.deepEqual(gone(b, ["docker compose up worker"]), []);
  put(b, "compose.yaml", `${COMPOSE}${"# pad\n".repeat(200 * 1024 / 6)}`);
  assert.deepEqual(gone(b, ["docker compose up worker"]), ["service:worker#1"], "under 256 KB it is read");
});

test("service: a FIFO at the compose path doesn't block (D100)", { skip: process.platform === "win32" }, () => {
  // Windows has no FIFO.
  const b = box("svc-fifo");
  execFileSync("mkfifo", [join(b.checkout, "compose.yaml")]);
  const t0 = Date.now();
  assert.deepEqual(gone(b, ["docker compose up worker"]), []);
  assert.ok(Date.now() - t0 < timeBar(1000, 3000));
  execFileSync("mkfifo", [join(b.checkout, ".env")]);
  put(b, "docker-compose.yml", COMPOSE);
  rmSync(join(b.checkout, "compose.yaml"));
  assert.deepEqual(gone(b, ["docker compose up worker"]), [], "a FIFO .env can't be read: not sure");
});

/* ----------------------------------------------------------- subcommand */

const PKG = JSON.stringify({ name: "@acme/cli", bin: { acme: "dist/cli.js" } });
const CLI_SRC = [
  "import { Command } from 'commander';",
  "const program = new Command();",
  "program.command('init').action(() => {});",
  "program.command(\"build <dir>\").action(() => {});",
  "program.command('deploy').alias('d');",
  "program.command('status');",
  "program.command('connxct');",
].join("\n");
function cliBox(tag: string, src = CLI_SRC): Box {
  const b = box(tag);
  put(b, "package.json", PKG);
  put(b, "src/cli.ts", src);
  put(b, "src/util/log.ts", "export const log = (s: string) => s; // a file with no registrations\n");
  return b;
}

test("a bin target and a node <file> word are one form on every platform: dist/cli.js, never dist\\cli.js", () => {
  for (const t of ["dist/cli.js", "./dist/cli.js", "dist\\cli.js", ".\\dist\\cli.js", "dist//cli.js"]) assert.equal(binTarget(t), "dist/cli.js", t);
});

test("subcommand: the fixture CLI with connect removed (the b92c22e shape) is gone; with it, not", () => {
  const b = cliBox("sub");
  const forms = ["acme connect", "npx acme connect --token-file x", "npm exec acme connect", "node dist/cli.js connect", "node ./dist/cli.js connect"];
  for (const f of forms) {
    assert.deepEqual(kinds(wideAnchorsOf(skill([f]), b.checkout, b.env)), ["subcommand:connect#1"], f);
    assert.deepEqual(gone(b, [f]), ["subcommand:connect#1"], f);
  }
  assert.equal(wideAnchorsOf(skill(["acme connect"]), b.checkout, b.env)[0]!.where, "acme");
  assert.deepEqual(gone(b, ["acme deploy --prod", "acme d", "acme build web", "acme help"]), [], "registered, an alias, a name with args, the built-in help");
  for (const f of ["acme --verbose connect", "acme Connect", "acme {cmd}", "other connect", "npx -p acme acme connect"]) {
    assert.deepEqual(kinds(wideAnchorsOf(skill([f]), b.checkout, b.env)), [], f);
  }
  put(b, "src/cli.ts", `${CLI_SRC}\nprogram.command('connect');`);
  assert.deepEqual(gone(b, ["acme connect"]), [], "rescanned: the file changed");
});

test("subcommand: 2 other registrations, a dynamic .command(name), a default command and 401 files are not judged", () => {
  const two = cliBox("sub-two", "program.command('init');\nprogram.command('status');\n");
  assert.deepEqual(gone(two, ["acme connect"]), []);
  const three = cliBox("sub-three", "program.command('init');\nprogram.command('status');\nprogram.command('deploy');\n");
  assert.deepEqual(gone(three, ["acme connect"]), ["subcommand:connect#1"]);
  const dyn = cliBox("sub-dyn", `${CLI_SRC}\nfor (const name of extra) program.command(name);\n`);
  assert.deepEqual(gone(dyn, ["acme connect"]), []);
  const tpl = cliBox("sub-tpl", `${CLI_SRC}\nprogram.command(\`\${prefix}-sync\`);\n`);
  assert.deepEqual(gone(tpl, ["acme connect"]), []);
  const factory = cliBox("sub-factory", `${CLI_SRC}\nconst make = (name: string) => new Command(name);\nprogram.addCommand(make('connect'));\n`);
  assert.deepEqual(gone(factory, ["acme connect"]), [], "a command built by name in a factory: not seen, so not sure");
  const aliases = cliBox("sub-aliases", `${CLI_SRC}\nprogram.command('link').aliases(['connect', "attach"]);\n`);
  assert.deepEqual(gone(aliases, ["acme connect"]), [], "an alias in an aliases array");
  assert.deepEqual(gone(aliases, ["acme detach"]), ["subcommand:detach#1"]);
  const def = cliBox("sub-def", `${CLI_SRC}\nprogram.command('serve', { isDefault: true });\n`);
  assert.deepEqual(gone(def, ["acme connect"]), []);
  const many = cliBox("sub-many");
  for (let i = 0; i < 398; i++) put(many, `src/gen/f${i}.ts`, `export const f${i} = ${i};\n`);
  assert.deepEqual(gone(many, ["acme connect"]), ["subcommand:connect#1"], "400 files are scanned");
  put(many, "src/gen/f398.ts", "export const f398 = 398;\n");
  assert.deepEqual(gone(many, ["acme connect"]), [], "401 files: not judged");
});

test("subcommand: the deadline judges nothing and caches nothing; the scan has its own 150 ms deadline", () => {
  const b = cliBox("sub-deadline");
  assert.equal(WIDE_SCAN_MS, 150);
  const t0 = Date.now();
  const slow = cliBox("sub-default");
  for (let i = 0; i < 300; i++) put(slow, `src/gen/f${i}.ts`, `export const f${i} = ${i};\n`);
  const fs = require("node:fs") as Record<string, (...a: unknown[]) => unknown>;
  const orig = fs.readdirSync!;
  // Each folder listed takes 200 ms: the default deadline (150 ms from the call) passes during the walk.
  mock.method(fs, "readdirSync" as never, ((...a: unknown[]) => { const end = Date.now() + 200; while (Date.now() < end) { /* slow disk */ } return orig(...a); }) as never);
  syncBuiltinESMExports();
  try {
    assert.deepEqual(kinds(wideGone(skill(["acme connect"]), slow.checkout, slow.env, { scan: true })), []);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(!existsSync(join(slow.trail, "state", "anchors-cache.json")));
  assert.deepEqual(kinds(wideGone(skill(["acme connect"]), b.checkout, b.env, { scan: true, deadline: Date.now() - 1 })), []);
  assert.ok(!existsSync(join(b.trail, "state", "anchors-cache.json")), "nothing cached past the deadline");
  assert.deepEqual(gone(b, ["acme connect"]), ["subcommand:connect#1"]);
});

test("subcommand: the cache is used when nothing changed and rescanned when one file's mtime moves; it holds no file text", () => {
  const b = cliBox("sub-cache");
  const file = join(b.checkout, "src", "cli.ts");
  const t = new Date(Date.UTC(2026, 9, 1, 9, 0, 0));
  utimesSync(file, t, t);
  assert.deepEqual(gone(b, ["acme connect"]), ["subcommand:connect#1"]);
  const path = join(b.trail, "state", "anchors-cache.json");
  const cache = JSON.parse(readFileSync(path, "utf8")) as { v: number; checkouts: Record<string, { sig: string; cli: Record<string, string[]>; at: string }> };
  assert.equal(cache.v, 1);
  const [key, entry] = Object.entries(cache.checkouts)[0]!;
  assert.match(key, /^[0-9a-f]{12}$/);
  assert.match(entry.sig, /^[0-9a-f]{16}$/);
  assert.deepEqual(entry.cli, { acme: ["build", "connxct", "d", "deploy", "init", "status"] });
  assert.ok(!readFileSync(path, "utf8").includes("registrations"), "no file text");
  if (process.platform !== "win32") assert.equal((statSync(path).mode & 0o777).toString(8), "600");
  // Same size, same mtime, new text: the cache answers (it can't see the change).
  writeFileSync(file, CLI_SRC.replace("connxct", "connect"));
  utimesSync(file, t, t);
  assert.deepEqual(gone(b, ["acme connect"]), ["subcommand:connect#1"], "the cache was used");
  utimesSync(file, t, new Date(t.getTime() + 5000));
  assert.deepEqual(gone(b, ["acme connect"]), [], "the mtime moved: rescanned");
});

test("subcommand: SessionStart (scan: false) never scans; it reads the cache, and a day-old cache says nothing", () => {
  const b = cliBox("sub-start");
  const fs = require("node:fs") as Record<string, (...a: unknown[]) => unknown>;
  const src = join(b.checkout, "src");
  const touched: string[] = [];
  const spies = ["readdirSync", "readFileSync", "statSync", "lstatSync", "openSync"].map((m) => {
    const orig = fs[m]!;
    return mock.method(fs, m as never, ((...a: unknown[]) => { touched.push(String(a[0])); return orig(...a); }) as never);
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(gone(b, ["acme connect"], false), [], "no cache yet: nothing judged");
    assert.deepEqual(kinds(goneAnchors(skill(["acme connect"]), b.checkout, b.env).filter((a) => a.kind === "subcommand") as WideAnchor[]), [], "goneAnchors reads only the cache by default");
    assert.deepEqual(touched.filter((p) => p.startsWith(src)), [], "nothing under src/ was read or listed");
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(gone(b, ["acme connect"], true), ["subcommand:connect#1"]);
  assert.deepEqual(gone(b, ["acme connect"], false), ["subcommand:connect#1"], "the cache a scan wrote");
  assert.deepEqual(kinds(goneAnchors(skill(["acme connect"]), b.checkout, b.env).filter((a) => a.kind === "subcommand") as WideAnchor[]), ["subcommand:connect#1"]);
  const path = join(b.trail, "state", "anchors-cache.json");
  const cache = JSON.parse(readFileSync(path, "utf8")) as { checkouts: Record<string, { at: string }> };
  for (const e of Object.values(cache.checkouts)) e.at = new Date(Date.now() - 25 * 3600_000).toISOString();
  writeFileSync(path, JSON.stringify(cache));
  assert.deepEqual(gone(b, ["acme connect"], false), [], "a cache over a day old is not sure at SessionStart");
  assert.deepEqual(gone(b, ["acme connect"], true), ["subcommand:connect#1"], "a scan refreshes it");
});

test("subcommand: the cache keeps at most 20 checkouts, oldest out; a broken cache file is read as empty", () => {
  const b = cliBox("sub-twenty");
  const path = join(b.trail, "state", "anchors-cache.json");
  mkdirSync(join(b.trail, "state"), { recursive: true });
  writeFileSync(path, "{not json");
  assert.deepEqual(gone(b, ["acme connect"]), ["subcommand:connect#1"]);
  const old = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`${i.toString(16).padStart(12, "0")}`, { sig: "0".repeat(16), cli: {}, at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() }]));
  writeFileSync(path, JSON.stringify({ v: 1, checkouts: old }));
  utimesSync(join(b.checkout, "src", "cli.ts"), new Date(), new Date(Date.now() + 9000));
  assert.deepEqual(gone(b, ["acme connect"]), ["subcommand:connect#1"]);
  const after = JSON.parse(readFileSync(path, "utf8")) as { checkouts: Record<string, unknown> };
  const keys = Object.keys(after.checkouts);
  assert.equal(keys.length, 20);
  assert.ok(!keys.includes("000000000000") && keys.includes("000000000018"), "the oldest went");
});

/* ---------------------------------------------------------------- safety */

test("wideGone spawns no process and opens no socket; anchors-wide and anchors-cli import neither", () => {
  const b = cliBox("wide-noproc");
  put(b, `${CI}/ci.yml`, "name: CI\n");
  put(b, "compose.yaml", COMPOSE);
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
    const g = gone(b, ["gh workflow run Deploy", "docker compose up worker", "acme connect"]);
    assert.deepEqual(g, ["ci-file:Deploy#1", "service:worker#2", "subcommand:connect#3"]);
    for (const sp of spies) assert.equal(sp.mock.callCount(), 0);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  for (const f of ["anchors-wide.ts", "anchors-cli.ts"]) {
    const text = readFileSync(new URL(`../src/skills/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /child_process|node:net|node:http|node:https|node:dns|fetch\(/, f);
  }
});

test("no checkout, an unreadable package.json and a bin that isn't the step's program judge nothing", () => {
  const b = cliBox("sub-misc");
  assert.deepEqual(kinds(wideGone(skill(["acme connect", "gh workflow run x.yml"]), "", b.env, { scan: true })), []);
  put(b, "package.json", "{bad json");
  assert.deepEqual(gone(b, ["acme connect"]), []);
  put(b, "package.json", JSON.stringify({ name: "acme", bin: "dist/cli.js" }));
  assert.deepEqual(gone(b, ["acme connect"]), ["subcommand:connect#1"], "a string bin is named after the package");
  assert.deepEqual(gone(b, ["acme-other connect"]), []);
});
