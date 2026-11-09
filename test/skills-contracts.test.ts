/**
 * The phase 1a contracts every group codes against: the shared types (their
 * fields pinned by name, so a rename breaks here and not in a sibling group),
 * the one way Trail writes its private files, the lock that gives up rather
 * than run twice, and the static rules about who may import what.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, lutimesSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpRepo } from "./helpers.js";
import {
  appendPrivateLine, ensurePrivateDir, readJsonSafe, trailPath, withLock, writePrivate, writePrivateJson,
} from "../src/util/private-fs.js";
import { hookError } from "../src/claude/skills-hook-util.js";
import { timeBar } from "./machine-speed.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const POSIX = process.platform !== "win32";
const mode = (p: string) => statSync(p).mode & 0o777;

/* -------------------------------------------------------------------------- */
/* Type pins                                                                  */
/* -------------------------------------------------------------------------- */

/** The text of `export interface Name {…}` or `export type Name = {…}` / `= 'a' | 'b'`. */
function declaration(text: string, name: string): string {
  const start = text.search(new RegExp(`^export (?:interface ${name}\\b|type ${name}\\b)`, "m"));
  assert.ok(start >= 0, `${name} is exported`);
  const rest = text.slice(start);
  const open = rest.indexOf("{");
  const semi = rest.indexOf(";");
  if (rest.startsWith("export type") && (open < 0 || (semi >= 0 && semi < open))) return rest.slice(0, semi);
  let depth = 0;
  for (let i = open; i < rest.length; i++) {
    if (rest[i] === "{") depth++;
    else if (rest[i] === "}" && --depth === 0) return rest.slice(open + 1, i);
  }
  throw new Error(`unclosed ${name}`);
}

/** Field names at the top level of a declaration body. */
function fields(body: string): string[] {
  const noComments = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  let depth = 0;
  let top = "";
  for (const ch of noComments) {
    if (ch === "{" || ch === "(") depth++;
    if (depth === 0) top += ch;
    else top += ch === "\n" ? "\n" : " ";
    if (ch === "}" || ch === ")") depth--;
  }
  return [...top.matchAll(/(?:^|[;\n])\s*(['"]?)([\w-]+)\1\??\s*:/g)].map((m) => m[2]!);
}

/** String literals of a union alias. */
function literals(decl: string): string[] {
  return [...decl.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

const TRACE_TYPES: Record<string, string[]> = {
  JobMatch: ["job", "words"],
  RunCall: ["id", "at", "cmd", "secret", "key", "cwd", "bg", "failed", "isError", "errorLine", "tail", "check", "truncated", "multiLine", "kind", "src", "fromMark", "parts", "tool", "loginFeed"],
  RunCallPart: ["cmd", "sep", "kind", "secret", "long"],
  CheckHit: ["family", "passed", "facts"],
  RunState: ["id", "epoch", "startedAt", "lastAt", "repoKey", "checkout", "branch", "job", "jobWords", "promptParams", "sharedWords", "typedCount", "toolCalls", "edits", "commands", "failedCount", "stepCalls", "calls", "closed", "end", "skillId", "carriedFrom", "failedTurn", "sheet", "checkIndex", "poolNoted"],
  RunSheet: ["v", "id", "session", "repoKey", "checkout", "branch", "host", "tier", "epoch", "startedAt", "endedAt", "job", "jobWords", "sharedWords", "promptParams", "calls", "checkIndex", "checked", "end", "counts", "helpers", "skillId", "carriedFrom", "joined"],
  SkillInjection: ["injId", "skillId", "name", "epoch", "at", "cue", "params", "steps", "gated", "check", "checkTool", "checkVersion", "readyFailed", "runId", "live"],
  PendingOffer: ["offerId", "moment", "runId", "name", "key", "lines", "channel", "shownAt", "showMe", "yes", "typedAfter", "skillSha", "seen"],
  CreditState: ["useId", "injId", "skillId", "epoch", "runId", "stepsRan", "failedStep", "check", "calls", "failed", "flushed", "promptsAfter"],
  SkillSessionState: ["v", "sessionHash", "host", "tier", "learn", "scopeKeys", "epoch", "pendingBoundary", "runs", "pendingOffer", "offerUsed", "offerUsedBy", "saveRequest", "injected", "credit", "tampered", "cut", "replyEnd", "updatedAt", "seen"],
};
const TRACE_UNIONS: Record<string, string[]> = {
  JobClass: ["release", "ship", "pr-green", "sweep", "run-local", "report", "tests"],
  PromptParams: ["version", "sha", "pr", "port", "branch", "date"],
  CallKind: ["step", "look", "plumbing", "work"],
  CheckFamily: ["tests", "npm-view", "deploy", "gh-checks", "ls-remote", "query", "push"],
  RunEnd: ["done", "failure", "question", "open"],
  TypedAnswer: ["yes", "no", "show", "correction", "retire", "other"], // 'retire': phase 2 (4.10)
  GatedKind: ["publish", "push-prod", "deploy", "merge", "migrate", "prune", "login"],
  OfferChannel: ["stop", "notice", "post-tool"],
};
const SKILL_TYPES: Record<string, string[]> = {
  SkillMeta: ["trail", "scope", "applies", "job", "asks", "status-asks", "params", "needs", "ready", "check-first", "before-you-start", "confirm-before", "check", "check-shows", "check-tool", "version"],
  ParamDef: ["name", "shape", "default", "seen"],
  SkillStep: ["n", "cmd", "gated", "bg", "wait", "from"],
  CompiledSkill: ["name", "title", "description", "meta", "steps", "check", "checkShows", "checkIsStep", "ifFails", "dontUse", "params", "helpers", "leftOut", "elsewhere", "carried", "source"],
  ParsedSkill: ["name", "description", "meta", "steps", "check", "checkShows", "ifFails", "dontUse", "params", "hash"],
  SkillRef: ["id", "name", "scope", "applies", "dir", "file"],
  SkillState: ["name", "scope", "status", "from", "runId", "addedAt", "lastWorked", "lastUsedAt", "lastUsedRepo", "uses", "checkedUses", "hash", "source", "lastFails", "statusWhy", "prevStatus", "fixHash", "promoteOffers"],
  SkillsStateFile: ["v", "skills"],
  OfferLine: ["id", "at", "event", "repo", "key", "moment", "runId", "name", "channel", "answer"],
  LedgerUse: ["at", "event", "useId", "skill", "v", "host", "cue", "repo", "stepsRan", "failedStep", "readyFailed", "check", "calls", "failed"],
  TrailSkillSettings: ["v", "skills", "onSince", "offers", "offersOffAt", "offRepos", "pausedUntil", "skillsOff", "lastNine", "governorSaidAt"],
  Receipt: ["v", "session", "transcriptPath", "toolUseId", "runId", "name", "at", "host", "tier", "consent", "offerId", "typed", "typedYes", "typedSave", "asked", "stepsTotal", "stepsVerified", "verdict", "heldWhy", "checkout", "usedAt"],
  HookOut: ["context", "notice", "block"],
};
const SKILL_UNIONS: Record<string, string[]> = {
  Scope: ["personal", "repo", "team"],
  SkillStatus: ["candidate", "active", "needs-fix", "retired"],
  SkillFrom: ["init", "repeated", "repaired", "asked"],
  Answer: ["yes", "no", "show", "none", "withdrawn"],
};

test("trace/types.ts declares every 1a type with exactly the design's fields", () => {
  const text = readFileSync(join(SRC, "trace/types.ts"), "utf8");
  for (const [name, want] of Object.entries(TRACE_TYPES)) assert.deepEqual(fields(declaration(text, name)), want, name);
  for (const [name, want] of Object.entries(TRACE_UNIONS)) assert.deepEqual(literals(declaration(text, name)), want, name);
  // The nested shapes other groups read field by field.
  assert.deepEqual(fields(declaration(text, "CheckHit").replace(/^[\s\S]*?facts:\s*\{/, "").replace(/\}[\s\S]*$/, "")),
    ["version", "sha", "state", "pr", "branch", "remote", "pkg", "passedCount"]);
});

test("skills/types.ts declares every 1a type with exactly the design's fields", () => {
  const text = readFileSync(join(SRC, "skills/types.ts"), "utf8");
  for (const [name, want] of Object.entries(SKILL_TYPES)) assert.deepEqual(fields(declaration(text, name)), want, name);
  for (const [name, want] of Object.entries(SKILL_UNIONS)) assert.deepEqual(literals(declaration(text, name)), want, name);
  // The ledger's line kinds.
  const ledger = text.slice(text.indexOf("export type LedgerLine"), text.indexOf("export interface TrailSkillSettings"));
  assert.deepEqual([...ledger.matchAll(/event: '([a-z]+)'/g)].map((m) => m[1]), ["saved", "corrected", "status"]);
  // Types only: nothing in these files runs.
  for (const file of ["trace/types.ts", "skills/types.ts"]) {
    const src = readFileSync(join(SRC, file), "utf8");
    assert.doesNotMatch(src, /^export (?:const|function|class|let|var)\b/m, file);
    assert.doesNotMatch(src, /^import (?!type\b)/m, file);
  }
});

/* -------------------------------------------------------------------------- */
/* private-fs                                                                 */
/* -------------------------------------------------------------------------- */

test("writePrivate writes whole files 0600 (0700 when asked) in a 0700 folder", { skip: !POSIX && "no posix modes" }, () => {
  const root = tmpRepo("pfs");
  const file = join(root, "a", "b", "x.json");
  writePrivate(file, "{}");
  assert.equal(readFileSync(file, "utf8"), "{}");
  assert.equal(mode(file), 0o600);
  assert.equal(mode(join(root, "a", "b")), 0o700);
  const script = join(root, "a", "run.sh");
  writePrivate(script, "#!/bin/sh\necho ok\n", 0o700);
  assert.equal(mode(script), 0o700);
  // A file another tool left world-readable is replaced by a private one.
  const loose = join(root, "loose.json");
  writeFileSync(loose, "old", { mode: 0o644 });
  writePrivate(loose, "new");
  assert.equal(readFileSync(loose, "utf8"), "new");
  assert.equal(mode(loose), 0o600);
  // No temp file is left beside it.
  assert.deepEqual(readdirSync(join(root, "a", "b")), ["x.json"]);
  // The re-exports are phase 0's own.
  writePrivateJson(join(root, "j", "s.json"), { a: 1 });
  assert.equal(mode(join(root, "j", "s.json")), 0o600);
  ensurePrivateDir(join(root, "d"));
  assert.equal(mode(join(root, "d")), 0o700);
});

test("appendPrivateLine adds one line per call, 0600, and refuses a line of 4 KB or more", { skip: !POSIX && "no posix modes" }, () => {
  const root = tmpRepo("pfs-append");
  const file = join(root, "log", "offers.jsonl");
  appendPrivateLine(file, '{"a":1}');
  appendPrivateLine(file, '{"a":2}');
  assert.equal(readFileSync(file, "utf8"), '{"a":1}\n{"a":2}\n');
  assert.equal(mode(file), 0o600);
  assert.equal(mode(join(root, "log")), 0o700);
  appendPrivateLine(file, "x".repeat(4095));
  assert.throws(() => appendPrivateLine(file, "x".repeat(4096)), /4 KB/);
  // Bytes, not characters: 1,366 three-byte characters are 4,098 bytes.
  assert.throws(() => appendPrivateLine(file, "\u20ac".repeat(1366)), /4 KB/);
  // A line break inside would make two lines.
  assert.throws(() => appendPrivateLine(file, "a\nb"), /one line/);
  const loose = join(root, "loose.jsonl");
  writeFileSync(loose, "", { mode: 0o644 });
  appendPrivateLine(loose, "x");
  assert.equal(mode(loose), 0o600);
});

test("readJsonSafe gives null on a missing file or bad JSON", () => {
  const root = tmpRepo("pfs-read");
  assert.equal(readJsonSafe(join(root, "none.json")), null);
  writeFileSync(join(root, "bad.json"), "{nope");
  assert.equal(readJsonSafe(join(root, "bad.json")), null);
  writeFileSync(join(root, "ok.json"), '{"a":[1]}');
  assert.deepEqual(readJsonSafe(join(root, "ok.json")), { a: [1] });
});

test("withLock runs fn once under the lock and removes the lock after, even when fn throws", () => {
  const root = tmpRepo("pfs-lock");
  const file = join(root, "s", "x.json");
  let ran = 0;
  const got = withLock(file, () => {
    ran++;
    assert.equal(existsSync(`${file}.lock`), true, "held while fn runs");
    return 7;
  });
  assert.deepEqual(got, { ok: true, value: 7 });
  assert.equal(ran, 1);
  assert.equal(existsSync(`${file}.lock`), false);
  assert.throws(() => withLock(file, () => { throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(`${file}.lock`), false);
});

test("withLock gives up on a timeout and never runs fn", () => {
  const root = tmpRepo("pfs-busy");
  const file = join(root, "x.json");
  writeFileSync(`${file}.lock`, "123");
  let ran = false;
  const t0 = Date.now();
  const got = withLock(file, () => { ran = true; return 1; }, 60);
  const took = Date.now() - t0;
  assert.deepEqual(got, { ok: false });
  assert.equal(ran, false, "a fold that ran twice would count every call twice");
  assert.ok(took >= 50, `waited ${took} ms`);
  assert.ok(took < timeBar(1000, 3000), `gave up promptly (${took} ms)`);
  assert.equal(existsSync(`${file}.lock`), true, "someone else's lock is left alone");
});

test("withLock steals a lock older than 10 s", () => {
  const root = tmpRepo("pfs-stale");
  const file = join(root, "x.json");
  writeFileSync(`${file}.lock`, "999999");
  const old = (Date.now() - 11_000) / 1000;
  utimesSync(`${file}.lock`, old, old);
  assert.deepEqual(withLock(file, () => "mine", 50), { ok: true, value: "mine" });
  assert.equal(existsSync(`${file}.lock`), false);
  // 9 s old is still someone's.
  writeFileSync(`${file}.lock`, "1");
  const recent = (Date.now() - 9_000) / 1000;
  utimesSync(`${file}.lock`, recent, recent);
  assert.deepEqual(withLock(file, () => "mine", 30), { ok: false });
});

const ROOT = join(SRC, "..");
const PRIVATE_FS = join(SRC, "util", "private-fs.ts");

/** A child process that takes the lock once (after a common start time), holds it, and logs whether anyone else was inside. */
function lockChild(dir: string): string {
  const file = join(dir, "child.mts");
  writeFileSync(file, `
import { closeSync, openSync, unlinkSync, appendFileSync } from "node:fs";
const { withLock } = await import(${JSON.stringify(PRIVATE_FS)});
const [target, holdMs, startAt] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];
while (Date.now() < startAt) {}
let overlap = 0;
const got = withLock(target, () => {
  try { closeSync(openSync(target + ".inside", "wx")); } catch { overlap++; }
  const until = Date.now() + holdMs; while (Date.now() < until) {}
  try { unlinkSync(target + ".inside"); } catch {}
  return 1;
}, 8000);
appendFileSync(target + ".log", JSON.stringify({ ok: got.ok, overlap }) + "\\n");
`);
  return file;
}

test("withLock: processes racing to take over a stale lock never run fn at the same time", { skip: !POSIX && "posix only", timeout: 60_000 }, async () => {
  const root = tmpRepo("pfs-race");
  const child = lockChild(root);
  for (let trial = 0; trial < 3; trial++) {
    const target = join(root, `t${trial}.json`);
    writeFileSync(`${target}.lock`, "999999");
    const old = (Date.now() - 11_000) / 1000;
    utimesSync(`${target}.lock`, old, old);
    const startAt = Date.now() + 2500;
    await Promise.all(Array.from({ length: 6 }, () => new Promise<void>((done) => {
      spawn(process.execPath, ["--import", "tsx", child, target, "150", String(startAt)], { cwd: ROOT, stdio: "ignore" }).on("exit", () => done());
    })));
    const logs = readFileSync(`${target}.log`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { ok: boolean; overlap: number });
    assert.equal(logs.length, 6);
    assert.deepEqual(logs.filter((l) => !l.ok || l.overlap), [], `trial ${trial}: two holders at once, or one gave up`);
    assert.equal(existsSync(`${target}.lock`), false);
  }
});

test("withLock: a lock path that is a dangling symlink still gives up on time; an old one is taken over", { skip: !POSIX && "posix only" }, () => {
  const root = tmpRepo("pfs-link");
  const run = (code: string) => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: ROOT, timeout: 10_000, encoding: "utf8" });
  const target = join(root, "x.json");
  symlinkSync(join(root, "nowhere"), `${target}.lock`);
  const r = run(`const { withLock } = await import(${JSON.stringify(PRIVATE_FS)}); console.log(JSON.stringify(withLock(${JSON.stringify(target)}, () => 1, 60)));`);
  assert.equal(r.signal, null, "it hung");
  assert.equal(r.stdout.trim(), JSON.stringify({ ok: false }));
  assert.ok(lstatSync(`${target}.lock`).isSymbolicLink(), "someone else's lock is left alone");
  // 11 s old: a dead process's, taken over, and the link's target is never touched.
  const old = (Date.now() - 11_000) / 1000;
  lutimesSync(`${target}.lock`, old, old);
  assert.deepEqual(withLock(target, () => "mine", 60), { ok: true, value: "mine" });
  assert.equal(existsSync(`${target}.lock`), false);
});

test("withLock: a holder whose lock was taken over leaves the new holder's lock alone", () => {
  const root = tmpRepo("pfs-release");
  const target = join(root, "x.json");
  const got = withLock(target, () => {
    // Someone took it over while fn ran (fn ran past 10 s): theirs is at the path now.
    unlinkSync(`${target}.lock`);
    writeFileSync(`${target}.lock`, "4242");
    return 1;
  });
  assert.deepEqual(got, { ok: true, value: 1 });
  assert.equal(readFileSync(`${target}.lock`, "utf8"), "4242");
});

test("appendPrivateLine never writes through a symlink; writePrivate replaces the link, not its target", { skip: !POSIX && "posix only" }, () => {
  const root = tmpRepo("pfs-symlink");
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "keep\n", { mode: 0o644 });
  const log = join(root, "trail", "offers.jsonl");
  appendPrivateLine(join(root, "trail", "first.jsonl"), "{}");
  symlinkSync(outside, log);
  assert.throws(() => appendPrivateLine(log, '{"a":1}'));
  assert.equal(readFileSync(outside, "utf8"), "keep\n");
  assert.equal(mode(outside), 0o644);
  const state = join(root, "trail", "skills.json");
  symlinkSync(outside, state);
  writePrivate(state, "{}");
  assert.equal(readFileSync(outside, "utf8"), "keep\n");
  assert.equal(lstatSync(state).isSymbolicLink(), false);
  assert.equal(readFileSync(state, "utf8"), "{}");
});

test("trailPath joins under TRAIL_HOME or ~/.trail", () => {
  assert.equal(trailPath({ TRAIL_HOME: "/tmp/x/home" }, "runs", "r-1.json"), resolve("/tmp/x/home", "runs", "r-1.json"));
  assert.match(trailPath({}, "settings.json"), /[\\/]\.trail[\\/]settings\.json$/);
});

test("hookError logs the file's own name, never its folders, from a Windows frame too", () => {
  const root = tmpRepo("hook-error");
  const env = { TRAIL_HOME: join(root, "trail") };
  for (const frame of ["C:\\Users\\Priya Shah\\shop\\dist\\stop.js:12:5", "/home/priya/shop/dist/stop.js:12:5", "file:///C:/Users/priya/shop/dist/stop.js:12:5"]) {
    const e = new TypeError("the prompt's words");
    e.stack = `TypeError: the prompt's words\n    at fold (${frame})`;
    hookError("stop", e, env);
  }
  const lines = readFileSync(join(root, "trail", "state", "hook-errors.log"), "utf8").trim().split("\n");
  assert.deepEqual(lines.map((l) => l.split(" ").slice(1).join(" ")), Array(3).fill("stop TypeError stop.js:12"));
});

/* -------------------------------------------------------------------------- */
/* Static rules                                                               */
/* -------------------------------------------------------------------------- */

function srcFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(SRC, p).split("\\").join("/");

test("no environment switch with HEADLESS in its name exists anywhere in src (D26)", () => {
  const hits = srcFiles().filter((f) => /\b[A-Z0-9_]*HEADLESS[A-Z0-9_]*\b/.test(readFileSync(f, "utf8"))).map(rel);
  assert.deepEqual(hits, []);
});

test("only cli-skills.ts uses the person-only setters, only offers.ts the bookkeeping writers", () => {
  const rules: Array<{ names: RegExp; allowed: string[] }> = [
    { names: /\b(?:setSkills|setOffers|setSkillOff)\b/, allowed: ["skills/settings.ts", "skills/cli-skills.ts"] },
    { names: /\b(?:pauseRepo|noteGovernor)\b/, allowed: ["skills/settings.ts", "skills/offers.ts"] },
    { names: /\bnoteSkillsStarted\b/, allowed: ["skills/settings.ts", "claude/skills-wiring.ts"] },
  ];
  const settings = join(SRC, "skills", "settings.ts");
  const bad: string[] = [];
  for (const file of srcFiles()) {
    const name = rel(file);
    const text = readFileSync(file, "utf8");
    for (const rule of rules) if (!rule.allowed.includes(name) && rule.names.test(text)) bad.push(`${name}: ${rule.names.source}`);
    // A namespace import, a dynamic import, a require or a re-export of everything reaches the setters
    // under another name: anywhere else, settings may only be named in a static `import { … } from`.
    if (name === "skills/cli-skills.ts" || name === "skills/offers.ts" || name === "skills/settings.ts") continue;
    for (const m of text.matchAll(/(['"`])(\.{1,2}\/[^'"`\n]*)\1/g)) {
      if (join(dirname(file), m[2]!.replace(/\.js$/, ".ts")) !== settings) continue;
      if (!/(?:^|[;\n])\s*(?:import|export)\s+(?:type\s+)?\{[^}]*\}\s*from\s*$/.test(text.slice(0, m.index))) bad.push(`${name}: settings reached other than by a named import`);
    }
  }
  assert.deepEqual(bad, []);
});

test("host-facts.ts is fast-path safe: no static node:fs, only node:path and node:os at load", () => {
  const text = readFileSync(join(SRC, "skills/host-facts.ts"), "utf8");
  const statics = [...text.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
  for (const spec of statics) assert.ok(["node:path", "node:os"].includes(spec), `static import ${spec}`);
  assert.doesNotMatch(text, /\bimport\(\s*['"](?:node:)?fs/);
  assert.match(text, /getBuiltinModule/);
});
