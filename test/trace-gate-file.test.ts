/**
 * The small file the PreToolUse fast path reads before every shell command
 * while a skill's run block is live: which steps ask the person first, and
 * which asks were approved. It also keeps the outcomes PostToolUse saw before
 * the transcript had them. It loads nothing heavier than node:path, node:os
 * and the shell lexer, and finds the session's file exactly where phase 0's
 * session state lives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendPostMark, gateFilePath, markApproved, markAsked, readGateFile, skillsOnFast, takePostMarks, trailHomeFast, writeGateFile,
} from "../src/trace/gate-file.js";
import { sessionStatePath } from "../src/trace/state.js";
import { trailHome } from "../src/notes/trail-home.js";
import { readSettings } from "../src/skills/settings.js";
import { emptyState, injection } from "./trace-run-fixtures.js";

const NOW = new Date("2026-10-01T10:05:00.000Z");
const SID = "5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

function home(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "trace-gate-"));
  return { ...process.env, TRAIL_HOME: join(dir, ".trail"), HOME: dir };
}

test("the gate file sits beside phase 0's session state, with the same id sanitising and the same home", () => {
  const env = home();
  const before = process.env.TRAIL_HOME;
  process.env.TRAIL_HOME = env.TRAIL_HOME;
  try {
    for (const id of [SID, "abc_DEF-1.2", "../../etc/passwd", "a/b", ".hidden", "x".repeat(200), "C:\\x", "é"]) {
      assert.equal(gateFilePath(id, env), sessionStatePath(id).replace(/\.json$/, ".gate.json"), id);
    }
  } finally {
    if (before === undefined) delete process.env.TRAIL_HOME;
    else process.env.TRAIL_HOME = before;
  }
  for (const e of [env, { HOME: "/home/dev" }, { TRAIL_HOME: "rel/dir" }, { TRAIL_HOME: "/x/y/../z" }]) {
    assert.equal(trailHomeFast(e), trailHome(e), JSON.stringify(e));
  }
});

test("written from the live injections only: groups of consecutive gated steps, each step's program", () => {
  const env = home();
  const st = emptyState({ epoch: 2, injected: [injection({ injId: "i-000001", live: false }), injection({ injId: "i-000002", epoch: 2 })] });
  writeGateFile(SID, st, env);
  const g = readGateFile(SID, env)!;
  assert.equal(g.v, 1);
  assert.equal(g.epoch, 2);
  assert.deepEqual(g.live.map((l) => l.injId), ["i-000002"]);
  const live = g.live[0]!;
  assert.equal(live.name, "release-npm");
  assert.deepEqual(live.params, { version: "1.4.3" });
  assert.equal(live.groups.length, 1);
  assert.deepEqual(live.groups[0], {
    kind: "publish",
    steps: [
      { n: 4, text: "npm publish acme-cli-1.4.3.tgz --access public", program: "npm publish" },
      { n: 5, text: "npm publish acme-core-1.4.3.tgz --access public", program: "npm publish" },
    ],
    askedAt: null, askedToolUseId: null, approvedAt: null,
  });
  if (process.platform !== "win32") assert.equal(statSync(gateFilePath(SID, env)).mode & 0o777, 0o600);
  if (process.platform !== "win32") assert.equal(statSync(join(env.TRAIL_HOME!, "sessions")).mode & 0o777, 0o700);
});

test("steps apart, or of different kinds, are separate groups", () => {
  const env = home();
  const inj = injection({
    steps: ["git push origin {sha}:refs/heads/beta", "sleep 1", "git push origin {sha}:refs/heads/prod", "vercel deploy --prod", "npm publish"],
    gated: [{ step: 3, kind: "push-prod" }, { step: 4, kind: "deploy" }, { step: 5, kind: "deploy" }, { step: 1, kind: "merge" }],
  });
  writeGateFile(SID, emptyState({ injected: [inj] }), env);
  const groups = readGateFile(SID, env)!.live[0]!.groups;
  assert.deepEqual(groups.map((x) => [x.kind, x.steps.map((s) => s.n)]), [["merge", [1]], ["push-prod", [3]], ["deploy", [4, 5]]]);
  const apart = injection({ steps: ["npm run build", "npm publish a.tgz", "git tag v1", "npm publish b.tgz"], gated: [{ step: 2, kind: "publish" }, { step: 4, kind: "publish" }] });
  writeGateFile(SID, emptyState({ injected: [apart] }), env);
  assert.deepEqual(readGateFile(SID, env)!.live[0]!.groups.map((x) => x.steps.map((s) => s.n)), [[2], [4]], "a step between: two asks");
});

test("asked and approved marks: a yes is the asked call's own PostToolUse; marks outlive a rewrite while the injection stays", () => {
  const env = home();
  const st = emptyState({ injected: [injection({ injId: "i-000002" })] });
  writeGateFile(SID, st, env);
  markAsked(SID, "i-000002", 0, "toolu_ask", NOW, env);
  let g = readGateFile(SID, env)!;
  assert.equal(g.live[0]!.groups[0]!.askedAt, NOW.toISOString());
  assert.equal(g.live[0]!.groups[0]!.askedToolUseId, "toolu_ask");
  assert.equal(markApproved(SID, "toolu_other", NOW, env), false);
  assert.equal(readGateFile(SID, env)!.live[0]!.groups[0]!.approvedAt, null);
  assert.equal(markApproved(SID, "toolu_ask", NOW, env), true);
  // A rewrite (another prompt, same injection) keeps the marks.
  writeGateFile(SID, st, env);
  g = readGateFile(SID, env)!;
  assert.equal(g.live[0]!.groups[0]!.approvedAt, NOW.toISOString());
  // New values (a new version) are a new run block: its asks start over.
  const bumped = injection({ injId: "i-000002", params: { version: "1.4.4" }, steps: injection().steps.map((s) => s.replace("1.4.3", "1.4.4")) });
  writeGateFile(SID, emptyState({ injected: [bumped] }), env);
  assert.equal(readGateFile(SID, env)!.live[0]!.groups[0]!.askedAt, null);
});

test("nothing live: the file goes away; no file, a bad file or one over 16 KB reads as nothing", () => {
  const env = home();
  writeGateFile(SID, emptyState({ injected: [injection()] }), env);
  assert.ok(existsSync(gateFilePath(SID, env)));
  writeGateFile(SID, emptyState({ injected: [injection({ live: false })] }), env);
  assert.equal(existsSync(gateFilePath(SID, env)), false);
  assert.equal(readGateFile(SID, env), null);
  mkdirSync(join(env.TRAIL_HOME!, "sessions"), { recursive: true });
  writeFileSync(gateFilePath(SID, env), "{not json");
  assert.equal(readGateFile(SID, env), null);
  writeFileSync(gateFilePath(SID, env), JSON.stringify({ v: 1, epoch: 0, live: [], pad: "x".repeat(17 * 1024) }));
  assert.equal(readGateFile(SID, env), null);
  writeFileSync(gateFilePath(SID, env), JSON.stringify({ v: 1, epoch: 0, live: "no" }));
  assert.equal(readGateFile(SID, env), null);
  assert.equal(markApproved(SID, "toolu_x", NOW, env), false, "no file: nothing to approve");
});

test("too many live injections for 16 KB: the newest are kept, so the file always reads", () => {
  const env = home();
  const long = (i: number) => injection({
    injId: `i-${String(i).padStart(6, "0")}`,
    steps: Array.from({ length: 12 }, (_, k) => `npm publish pkg-${k}-${"a".repeat(260)}.tgz`),
    gated: Array.from({ length: 12 }, (_, k) => ({ step: k + 1, kind: "publish" as const })),
  });
  writeGateFile(SID, emptyState({ injected: [long(1), long(2), long(3)] }), env);
  const g = readGateFile(SID, env);
  assert.ok(g, "still readable");
  assert.ok(readFileSync(gateFilePath(SID, env)).length <= 16 * 1024);
  assert.equal(g!.live.at(-1)!.injId, "i-000003");
});

test("post marks: appended one per line (0600), taken in order, and gone once taken", () => {
  const env = home();
  assert.deepEqual(takePostMarks(SID, env), []);
  appendPostMark(SID, { id: "toolu_1", at: "2026-10-01T10:00:01.000Z", failed: false, tail: "1.4.3" }, env);
  appendPostMark(SID, { id: "toolu_2", at: "2026-10-01T10:00:02.000Z", failed: true }, env);
  appendPostMark(SID, { id: "toolu_3", at: "2026-10-01T10:00:03.000Z", failed: false, tail: "y".repeat(9000) }, env);
  const path = gateFilePath(SID, env).replace(/\.gate\.json$/, ".post.jsonl");
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(readFileSync(path, "utf8").split("\n").every((l) => Buffer.byteLength(l) < 1024), "each append is one small write");
  writeFileSync(path, readFileSync(path, "utf8") + "not json\n{\"id\":5}\n");
  const marks = takePostMarks(SID, env);
  assert.deepEqual(marks.map((m) => [m.id, m.failed]), [["toolu_1", false], ["toolu_2", true], ["toolu_3", false]]);
  assert.equal(marks[0]!.tail, "1.4.3");
  assert.ok((marks[2]!.tail ?? "").length <= 200, "a long tail is cut so one append stays one write");
  assert.deepEqual(takePostMarks(SID, env), []);
});

test("skillsOnFast reads settings.json with fs only, and agrees with readSettings", () => {
  const env = home();
  const settings = join(env.TRAIL_HOME!, "settings.json");
  assert.equal(skillsOnFast(env), true, "on by default, with no settings file");
  mkdirSync(env.TRAIL_HOME!, { recursive: true });
  for (const body of ['{"v":1,"skills":"on"}', '{"v":1,"skills":"off"}', "{bad", '{"skills":true}', "[]"]) {
    writeFileSync(settings, body);
    assert.equal(skillsOnFast(env), readSettings(env).skills === "on", body);
  }
});

test("fast-path safe: static imports are node:path, node:os and the shell lexer only", () => {
  const src = readFileSync(new URL("../src/trace/gate-file.ts", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^import\s+(?!type\b)[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["./shell.js", "node:os", "node:path"]);
  assert.doesNotMatch(src, /^import\s+(?!type\b)[^;]*from ['"]node:(fs|crypto)['"]/m, "type-only imports are erased; a value import is not");
  assert.doesNotMatch(src, /\bimport\(/, "no dynamic import either");
});

test("a linked sessions folder is left alone: writing the gate file or a mark doesn't tighten the link's target (D85)", (t) => {
  if (process.platform === "win32") return t.skip("Windows has no posix modes");
  const env = home();
  const target = mkdtempSync(join(tmpdir(), "trace-gate-target-"));
  t.after(() => {
    rmSync(join(env.HOME!), { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });
  chmodSync(target, 0o755);
  mkdirSync(env.TRAIL_HOME!, { recursive: true });
  const link = join(env.TRAIL_HOME!, "sessions");
  symlinkSync(target, link);
  writeGateFile(SID, emptyState({ injected: [injection()] }), env);
  appendPostMark(SID, { id: "toolu_1", at: NOW.toISOString(), failed: false }, env);
  assert.equal(statSync(target).mode & 0o777, 0o755, "the folder the link points to is not tightened");
  assert.ok(lstatSync(link).isSymbolicLink(), "the link is still a link");
});

test("a real sessions folder at 0755 is tightened to 0700 when the gate file is written", (t) => {
  if (process.platform === "win32") return t.skip("Windows has no posix modes");
  const env = home();
  t.after(() => rmSync(env.HOME!, { recursive: true, force: true }));
  const dir = join(env.TRAIL_HOME!, "sessions");
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  writeGateFile(SID, emptyState({ injected: [injection()] }), env);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});
