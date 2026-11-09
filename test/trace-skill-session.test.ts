/**
 * The skills session (design 3.0, 1.3, 2.8): the gate every skills hook
 * starts with, and the one locked read-modify-write of the `skills` key of
 * `~/.trail/sessions/<id>.json`, with the transcript catch-up (whose cursor
 * is the `trace` key of the same file) inside the same lock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentRun, housekeeping, injectedThisEpoch, liveInjections, loadSkillSession, skillsGate, withSkillSession, type GateCtx,
} from "../src/trace/skill-session.js";
import { appendPostMark, sessionPath } from "../src/trace/gate-file.js";
import { readRunSheet, runSheetPath, writeRunSheet } from "../src/trace/runs.js";
import { withLock } from "../src/util/private-fs.js";
import { compactBoundary, jsonl, toolUse } from "./trace-fixtures.js";
import { ask, at, bash, emptyState, injection, reply, runState } from "./trace-run-fixtures.js";
import { timeBar } from "./machine-speed.js";

const SID = "5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const PASS = "Test Files  3 passed (3)\n     Tests  42 passed (42)";

function box(opts: { skills?: boolean; lab?: boolean } = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), "trace-sess-"));
  // TRAIL_HOME apart from $HOME/.trail: a test home, where the test clock is honoured.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: homeDir, TRAIL_HOME: join(homeDir, "trail-home"), CLAUDE_CODE_ENTRYPOINT: "cli" };
  mkdirSync(env.TRAIL_HOME!, { recursive: true });
  writeFileSync(join(env.TRAIL_HOME!, "settings.json"), JSON.stringify({ v: 1, skills: opts.skills === false ? "off" : "on" }));
  if (opts.lab) writeFileSync(join(homeDir, ".trail-lab"), "");
  const transcript = join(homeDir, ".claude", "projects", "-home-dev-shop", `${SID}.jsonl`);
  mkdirSync(join(transcript, ".."), { recursive: true });
  writeFileSync(transcript, "");
  return { env, homeDir, transcript };
}

const payload = (transcript: string, extra: Record<string, unknown> = {}) => ({
  session_id: SID, transcript_path: transcript, cwd: "/home/dev/shop", permission_mode: "default", hook_event_name: "Stop", ...extra,
});

test("the gate: no hooks, skills off and no session end it; otherwise one context", () => {
  const b = box();
  assert.deepEqual(skillsGate(payload(b.transcript), "/home/dev/shop", { ...b.env, TRAIL_NO_HOOKS: "1" }), { ok: false, why: "no-hooks" });
  assert.deepEqual(skillsGate(payload(b.transcript), "/home/dev/shop", box({ skills: false }).env), { ok: false, why: "off" });
  assert.deepEqual(skillsGate({ transcript_path: b.transcript, cwd: "/home/dev/shop" }, "/home/dev/shop", b.env), { ok: false, why: "no-session" });
  const g = skillsGate(payload(b.transcript), "/home/dev/shop", { ...b.env, TRAIL_TEST_NOW: "2026-10-27T10:00:00Z" });
  assert.ok(g.ok);
  const ctx = g.ctx;
  assert.deepEqual(
    { id: ctx.sessionId, hash: ctx.sessionHash, host: ctx.host, tier: ctx.tier, entry: ctx.entry, mode: ctx.permissionMode, sub: ctx.subagent,
      fold: ctx.fold, learn: ctx.learn, off: ctx.learnOff, dir: ctx.dir, checkout: ctx.checkout, tp: ctx.transcriptPath, now: ctx.now.toISOString() },
    { id: SID, hash: createHash("sha256").update(SID).digest("hex").slice(0, 12), host: "claude", tier: "A", entry: "interactive", mode: "default", sub: false,
      fold: true, learn: true, off: null, dir: "/home/dev/shop", checkout: "", tp: b.transcript, now: "2026-10-27T10:00:00.000Z" },
  );
  assert.match(ctx.repoKey, /^local\//);
});

test("headless is decided by CLAUDE_CODE_ENTRYPOINT only, never by promptSource (D16, D34)", () => {
  const b = box();
  const entry = (ep: string | undefined, extra: Record<string, unknown> = {}) => {
    const env = { ...b.env };
    if (ep === undefined) delete env.CLAUDE_CODE_ENTRYPOINT;
    else env.CLAUDE_CODE_ENTRYPOINT = ep;
    const g = skillsGate(payload(b.transcript, extra), "/home/dev/shop", env);
    return g.ok ? [g.ctx.entry, g.ctx.fold, g.ctx.learn] : g.why;
  };
  for (const ep of ["cli", "claude-desktop", "claude-vscode"]) assert.deepEqual(entry(ep), ["interactive", true, true], ep);
  for (const ep of ["sdk-cli", "sdk-ts", "sdk-py", undefined]) assert.deepEqual(entry(ep), ["headless", false, false], String(ep));
  assert.deepEqual(entry(undefined, { promptSource: "typed" }), ["headless", false, false], "a typed promptSource never makes a run interactive");
  assert.deepEqual(entry("cli", { promptSource: "sdk" }), ["interactive", true, true], "the desktop app writes sdk; the entrypoint decides");
  const src = readFileSync(new URL("../src/trace/skill-session.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /promptSource/);
  assert.doesNotMatch(src, /HEADLESS/);
});

test("TRAIL_LAB_INTERACTIVE=1 makes an sdk run interactive only in a lab box (D26)", () => {
  const plain = box();
  const lab = box({ lab: true });
  const run = (b: ReturnType<typeof box>, flag: string | undefined) => {
    const env = { ...b.env, CLAUDE_CODE_ENTRYPOINT: "sdk-cli", ...(flag ? { TRAIL_LAB_INTERACTIVE: flag } : {}) };
    const g = skillsGate(payload(b.transcript), "/home/dev/shop", env);
    return g.ok ? g.ctx.entry : g.why;
  };
  assert.equal(run(plain, "1"), "headless");
  assert.equal(run(lab, "1"), "interactive");
  assert.equal(run(lab, undefined), "headless");
  assert.equal(run(lab, "true"), "headless");
});

test("learning stays off for subagents, CI and scratch folders; another host folds but never learns", () => {
  const b = box();
  const off = (extra: Record<string, unknown>, env: NodeJS.ProcessEnv = b.env) => {
    const g = skillsGate(payload(b.transcript, extra), "/home/dev/shop", env);
    return g.ok ? [g.ctx.learnOff, g.ctx.fold, g.ctx.learn] : g.why;
  };
  assert.deepEqual(off({ agent_id: "a1", agent_type: "Explore" }), ["subagent", false, false]);
  assert.deepEqual(off({ agent_id: "a1" }, { ...b.env, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }), ["subagent", false, false], "subagent first");
  assert.deepEqual(off({}, { ...b.env, CI: "true" }), ["ci", false, false]);
  assert.deepEqual(off({}, { ...b.env, GITHUB_ACTIONS: "true" }), ["ci", false, false]);
  assert.deepEqual(off({}, { ...b.env, CI: "false" }), [null, true, true]);
  assert.deepEqual(off({}, { ...b.env, CI: "0" }), [null, true, true]);
  for (const cwd of ["/tmp/x", "/private/tmp/x", "/var/folders/ab/T/x", join(tmpdir(), "y"), "/home/dev/work/scratchpad/z"]) {
    assert.deepEqual(off({ cwd }), ["scratch", false, false], cwd);
  }
  const cursor = { conversation_id: "c1", generation_id: "g1", cursor_version: "1.7", session_id: SID, transcript_path: "/home/dev/.cursor/x.jsonl" };
  const env = { ...b.env };
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const g = skillsGate({ ...cursor, cwd: "/home/dev/shop" }, "/home/dev/shop", env);
  assert.ok(g.ok);
  assert.deepEqual([g.ctx.host, g.ctx.tier, g.ctx.entry, g.ctx.learnOff, g.ctx.fold, g.ctx.learn], ["cursor", "D", "interactive", "host", true, false]);
});

function ctxOf(b: ReturnType<typeof box>, extra: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = b.env): GateCtx {
  const g = skillsGate(payload(b.transcript, extra), "/home/dev/shop", env);
  assert.ok(g.ok);
  return g.ctx;
}
const stateFile = (b: ReturnType<typeof box>) => sessionPath(SID, ".json", b.env);

test("a session with no state starts a new one; the state lives under `skills`, the cursor under `trace`, other keys kept", () => {
  const b = box();
  const ctx = ctxOf(b);
  const fresh = loadSkillSession(ctx);
  assert.deepEqual([fresh.v, fresh.sessionHash, fresh.host, fresh.tier, fresh.learn, fresh.epoch, fresh.runs, fresh.tampered], [1, ctx.sessionHash, "claude", "A", true, 0, [], null]);
  mkdirSync(join(b.env.TRAIL_HOME!, "sessions"), { recursive: true });
  writeFileSync(stateFile(b), JSON.stringify({ other: { keep: true } }));
  appendFileSync(b.transcript, jsonl([ask("run the integration tests", 0), ...bash("npm test", PASS, { sec: 2 })]));
  const out = withSkillSession(ctx, { catchUp: true }, (st, fold) => {
    assert.equal(fold!.events.length, 3);
    assert.equal(st.runs.length, 1);
    return "ran";
  });
  assert.equal(out, "ran");
  const disk = JSON.parse(readFileSync(stateFile(b), "utf8"));
  assert.deepEqual(Object.keys(disk).sort(), ["other", "skills", "trace"]);
  assert.equal(disk.skills.runs[0].job, "tests");
  assert.ok(disk.trace.offset > 0);
  if (process.platform !== "win32") assert.equal(statSync(stateFile(b)).mode & 0o777, 0o600);
  assert.ok(!readFileSync(stateFile(b), "utf8").includes("integration tests"), "no typed text on disk");
  // Nothing new: the next catch-up folds nothing.
  withSkillSession(ctx, { catchUp: true }, (_st, fold) => assert.equal(fold!.events.length, 0));
  assert.equal(loadSkillSession(ctx).runs.length, 1);
});

test("a lock it can't get in time: fn never runs and nothing is read or written", () => {
  const b = box();
  const ctx = ctxOf(b);
  appendFileSync(b.transcript, jsonl([ask("run the integration tests", 0)]));
  let ran = false;
  const held = withLock(stateFile(b), () => withSkillSession(ctx, { catchUp: true, waitMs: 30 }, () => { ran = true; }), 50);
  assert.ok(held.ok);
  assert.equal(held.value, undefined);
  assert.equal(ran, false);
  assert.equal(existsSync(stateFile(b)), false, "the cursor did not move");
});

test("no catch-up when asked not to, or when the session doesn't fold", () => {
  const b = box();
  appendFileSync(b.transcript, jsonl([ask("run the integration tests", 0)]));
  withSkillSession(ctxOf(b), { catchUp: false }, (st, fold) => { assert.equal(fold, null); assert.equal(st.runs.length, 0); });
  const headless = ctxOf(b, {}, { ...b.env, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
  withSkillSession(headless, { catchUp: true }, (_st, fold) => assert.equal(fold, null));
  assert.ok(!JSON.parse(readFileSync(stateFile(b), "utf8")).trace, "the transcript was never read");
});

test("closed runs with steps get their sheets (draft or checked) and lose their calls; the open run keeps them", () => {
  const b = box();
  const ctx = ctxOf(b);
  appendFileSync(b.transcript, jsonl([
    ask("run the integration tests", 0), ...bash("npm test", PASS, { sec: 2 }), reply("All 42 pass.", 3),
    ask("push to beta", 100), ...bash("git push origin main:beta", "fatal: could not read Username", { sec: 102, isError: true }),
  ]));
  const first = withSkillSession(ctx, { catchUp: true }, (st, fold) => {
    assert.equal(fold!.closed[0]!.calls.length, 1, "the hook still sees a closed run's calls (credit reads them)");
    return st.runs.map((r) => [r.closed, r.sheet]);
  });
  assert.deepEqual(first, [[true, "draft"], [false, "none"]], "never judged by a Stop: a draft");
  const st = loadSkillSession(ctx);
  assert.deepEqual(st.runs.map((r) => r.calls.length), [0, 1], "then emptied before the state is written");
  assert.ok(readRunSheet(st.runs[0]!.id, b.env));
  appendFileSync(b.transcript, jsonl([ask("publish 1.4.3", 300)]));
  withSkillSession(ctx, { catchUp: true }, () => undefined);
  const after = loadSkillSession(ctx);
  assert.deepEqual(after.runs.map((r) => [r.closed, r.sheet, r.calls.length]), [[true, "draft", 0], [true, "draft", 0], [false, "none", 0]]);
});

test("a closed run with no step calls gets no sheet, and keeps no calls", () => {
  const b = box();
  const ctx = ctxOf(b);
  appendFileSync(b.transcript, jsonl([ask("look around the logs folder", 0), ...bash("ls logs && tail -5 logs/app.log", "a.log", { sec: 2 }), ask("run the integration tests", 100)]));
  withSkillSession(ctx, { catchUp: true }, () => undefined);
  const run = loadSkillSession(ctx).runs[0]!;
  assert.deepEqual([run.closed, run.stepCalls, run.sheet, run.calls.length], [true, 0, "none", 0]);
  assert.equal(readRunSheet(run.id, b.env), null);
});

test("a run Stop judged done becomes a checked sheet when it closes", () => {
  const b = box();
  const ctx = ctxOf(b);
  appendFileSync(b.transcript, jsonl([ask("run the integration tests", 0), ...bash("npm test", PASS, { sec: 2 }), reply("All 42 pass.", 3)]));
  withSkillSession(ctx, { catchUp: true }, (st) => { st.runs[0]!.end = "done"; });
  appendFileSync(b.transcript, jsonl([ask("push to beta", 100)]));
  withSkillSession(ctx, { catchUp: true }, () => undefined);
  const run = loadSkillSession(ctx).runs[0]!;
  assert.deepEqual([run.sheet, run.checkIndex], ["checked", 0]);
  assert.equal(readRunSheet(run.id, b.env)!.checked, true);
});

test("marks are taken inside the lock and fill a call the transcript has no result for yet", () => {
  const b = box();
  const ctx = ctxOf(b);
  appendFileSync(b.transcript, jsonl([ask("publish 1.4.3", 0), ...bash("npm publish acme-cli-1.4.3.tgz", "+ acme-cli@1.4.3", { sec: 1 }),
    toolUse("toolu_view", "Bash", { command: "npm view acme-cli version" }, { timestamp: at(5) })]));
  appendPostMark(SID, { id: "toolu_view", at: at(6), failed: false, tail: "1.4.3" }, b.env);
  withSkillSession(ctx, { catchUp: true }, (st) => {
    const view = st.runs[0]!.calls[1]!;
    assert.equal(view.fromMark, true);
    assert.equal(view.check?.passed, true);
  });
  assert.equal(existsSync(sessionPath(SID, ".post.jsonl", b.env)), false, "taken");
});

test("a throw inside still keeps what was folded, so the cursor and the state never disagree", () => {
  const b = box();
  const ctx = ctxOf(b);
  appendFileSync(b.transcript, jsonl([ask("run the integration tests", 0), ...bash("npm test", PASS, { sec: 2 })]));
  assert.throws(() => withSkillSession(ctx, { catchUp: true }, (st) => { st.epoch = 99; throw new Error("boom"); }), /boom/);
  const st = loadSkillSession(ctx);
  assert.equal(st.runs.length, 1, "the fold was kept");
  assert.equal(st.epoch, 0, "the half-done change was not");
});

test("a compaction in the catch-up bumps the epoch; current run and injection helpers", () => {
  const b = box();
  const ctx = ctxOf(b);
  appendFileSync(b.transcript, jsonl([ask("run the integration tests", 0), compactBoundary({ timestamp: at(50) }), ask("push to beta", 60)]));
  withSkillSession(ctx, { catchUp: true }, (st, fold) => {
    assert.equal(fold!.compactions, 1);
    assert.equal(st.epoch, 1);
    assert.equal(currentRun(st)!.job, "ship");
  });
  const st = emptyState({ epoch: 2, injected: [injection({ epoch: 1, live: false }), injection({ injId: "i-2", epoch: 2 }), injection({ injId: "i-3", epoch: 2, live: false })] });
  assert.deepEqual(injectedThisEpoch(st).map((i) => i.injId), ["i-2", "i-3"]);
  assert.deepEqual(liveInjections(st).map((i) => i.injId), ["i-2"]);
  assert.equal(currentRun(emptyState({ runs: [runState({ closed: true })] })), null);
});

test("an unreadable state file reads as a new state", () => {
  const b = box();
  mkdirSync(join(b.env.TRAIL_HOME!, "sessions"), { recursive: true });
  writeFileSync(stateFile(b), "{broken");
  assert.equal(loadSkillSession(ctxOf(b)).runs.length, 0);
  writeFileSync(stateFile(b), JSON.stringify({ skills: { v: 2, runs: "x" } }));
  assert.equal(loadSkillSession(ctxOf(b)).runs.length, 0);
});

test("housekeeping, at most once an hour: old sheets, sessions, receipts, shown held items and probes go", () => {
  const b = box();
  const env = b.env;
  const home = env.TRAIL_HOME!;
  const now = new Date("2026-11-20T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const DAY = 86400_000;
  const old = runState({ id: "r-1101-0001" });
  writeRunSheet(old, { checked: false, checkIndex: null, end: "done" }, { host: "claude", tier: "A", sessionHash: "x", helpers: [] }, env);
  utimesSync(runSheetPath(old.id, env), ago(8 * DAY), ago(8 * DAY));
  mkdirSync(join(home, "sessions"), { recursive: true });
  // A crash leaves a lock, a steal guard, a moved-aside lock or a temp write beside a session file.
  const leftovers = ["old.json.lock", "old.json.lock.steal", "old.json.lock.41.a1b2c3.stale", "old.json.41.d4e5f6.tmp"];
  for (const f of ["old.json", "old.gate.json", "old.post.jsonl", "new.json", "new.json.lock", ...leftovers]) writeFileSync(join(home, "sessions", f), "{}");
  for (const f of ["old.json", "old.gate.json", "old.post.jsonl", ...leftovers]) utimesSync(join(home, "sessions", f), ago(31 * DAY), ago(31 * DAY));
  for (const f of ["new.json", "new.json.lock"]) utimesSync(join(home, "sessions", f), ago(29 * DAY), ago(29 * DAY));
  mkdirSync(join(home, "receipts"), { recursive: true });
  writeFileSync(join(home, "receipts", "a.json"), "{}");
  writeFileSync(join(home, "receipts", "b.json"), "{}");
  utimesSync(join(home, "receipts", "a.json"), ago(2 * DAY), ago(2 * DAY));
  utimesSync(join(home, "receipts", "b.json"), ago(3600_000), ago(3600_000));
  for (const [name, shownAt] of [["shown-old", ago(25 * 3600_000).toISOString()], ["shown-new", ago(3600_000).toISOString()], ["unshown", null]] as const) {
    mkdirSync(join(home, "held", name), { recursive: true });
    writeFileSync(join(home, "held", name, "held.json"), JSON.stringify({ name, shownAt }));
  }
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "state", "probes.json"), JSON.stringify({ v: 1, entries: { "a|git status": { at: ago(11 * 60_000).toISOString(), ok: true }, "a|test -S x": { at: ago(60_000).toISOString(), ok: true } } }));

  housekeeping(now, env);
  assert.equal(existsSync(runSheetPath(old.id, env)), false);
  assert.deepEqual(["old.json", "old.gate.json", "old.post.jsonl", "new.json"].map((f) => existsSync(join(home, "sessions", f))), [false, false, false, true]);
  assert.deepEqual(leftovers.map((f) => existsSync(join(home, "sessions", f))), [false, false, false, false]);
  assert.ok(existsSync(join(home, "sessions", "new.json.lock")));
  assert.deepEqual(["a.json", "b.json"].map((f) => existsSync(join(home, "receipts", f))), [false, true]);
  assert.deepEqual(["shown-old", "shown-new", "unshown"].map((n) => existsSync(join(home, "held", n))), [false, true, true]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, "state", "probes.json"), "utf8")).entries), ["a|test -S x"]);
  assert.ok(JSON.parse(readFileSync(join(home, "state", "housekeeping.json"), "utf8")).at);

  // Within the hour it does nothing.
  writeFileSync(join(home, "receipts", "c.json"), "{}");
  utimesSync(join(home, "receipts", "c.json"), ago(2 * DAY), ago(2 * DAY));
  housekeeping(new Date(now.getTime() + 30 * 60_000), env);
  assert.ok(existsSync(join(home, "receipts", "c.json")));
  housekeeping(new Date(now.getTime() + 61 * 60_000), env);
  assert.equal(existsSync(join(home, "receipts", "c.json")), false);
});

test("a first catch-up on a long transcript reads only its last 8 MB", () => {
  const b = box();
  const ctx = ctxOf(b);
  const early = jsonl([ask("publish 9.9.9 from the early part", 0), ...bash("npm publish", "+ acme-cli@9.9.9", { sec: 1 })]);
  appendFileSync(b.transcript, early);
  const filler = jsonl(Array.from({ length: 200 }, (_, i) => reply(`${"filler ".repeat(1200)} ${i}`, 10)));
  for (let written = 0; written < 12 * 1024 * 1024; written += Buffer.byteLength(filler)) appendFileSync(b.transcript, filler);
  appendFileSync(b.transcript, jsonl([ask("run the integration tests", 5000), ...bash("npm test", PASS, { sec: 5002 })]));
  const t0 = performance.now();
  try {
    withSkillSession(ctx, { catchUp: true }, (st) => {
      assert.deepEqual(st.runs.map((r) => r.job), ["tests"], "the early publish was never read");
    });
    assert.ok(performance.now() - t0 < timeBar(2000, 6000));
  } finally {
    rmSync(b.homeDir, { recursive: true, force: true });
  }
});

test("TRAIL_PERF: a first catch-up on a 200 MB transcript stays bounded", { skip: process.env.TRAIL_PERF !== "1" }, () => {
  const b = box();
  const ctx = ctxOf(b);
  const block = jsonl(Array.from({ length: 200 }, (_, i) => [ask(`run module ${i} tests`, i), ...bash(`npm test -- m${i}`, `ok\n${"line of output\n".repeat(100)}`, { sec: i })]).flat());
  for (let written = 0; written < 200 * 1024 * 1024; written += Buffer.byteLength(block)) appendFileSync(b.transcript, block);
  const t0 = performance.now();
  try {
    withSkillSession(ctx, { catchUp: true }, () => undefined);
  } finally {
    rmSync(b.homeDir, { recursive: true, force: true });
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `first catch-up took ${ms.toFixed(0)} ms`);
});
