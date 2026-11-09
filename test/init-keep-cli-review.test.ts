/**
 * b6 review of `trail keep`'s CLI half: a receipt claimed by two keeps at
 * once, stale and future receipts, and a deferred item that a typed "all"
 * doesn't keep (it waits, it is not closed). Synthetic sessions only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keepCommand, KEEP_AT_TTY, KEEP_HELD, KEEP_NOTHING_WAITS } from "../src/init/keep.js";
import { keepDecision, keepReceiptPath } from "../src/init/keep-gate.js";
import { readInitRecord, updateInitRecord } from "../src/init/init-record.js";
import { beginLookBack, finishLookBack } from "../src/init/run.js";
import { repoPlace } from "../src/notes/home.js";
import { sessionPath } from "../src/trace/gate-file.js";
import { day, done, folderOf, releaseJob, Tx, world, type World } from "./init-mine-fixtures.js";
import { jsonl, said, toolResult, toolUse, typed } from "./trace-fixtures.js";

const SESSION = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const PS = () => [{ pid: 1, ppid: 0, comm: "/sbin/launchd", args: "" }, { pid: 9, ppid: 1, comm: "/bin/zsh", args: "-zsh" }, { pid: 77, ppid: 9, comm: "node", args: "node" }];

function history(w: World): void {
  const a = new Tx(w.repo);
  releaseJob(a, 1, "1.0.1", { failedFirst: true });
  a.typed(day(1, 12), "never use em dashes in the copy");
  a.typed(day(1, 13), "time box the build").bash(day(1, 13, 1), "timeout 60 npm run build", "zsh:1: command not found: timeout", { isError: true });
  const b = new Tx(w.wt);
  releaseJob(b, 3, "1.0.3", { failedFirst: true });
  b.typed(day(3, 12), "never use em dashes in the copy please");
  b.typed(day(3, 13), "time box the tests").bash(day(3, 13, 1), "timeout 60 npm test", "zsh:1: command not found: timeout", { isError: true });
  const c = new Tx(w.repo);
  releaseJob(c, 5, "1.0.5");
  a.write(w.home, "s-a");
  b.write(w.home, "s-b");
  c.write(w.home, "s-c");
}

interface Ctx { w: World; env: NodeJS.ProcessEnv; repoKey: string; listText: string; reply: string }

/** An agent ran trail init in acme/shop: the relay printed, pending written. */
async function relayed(w: World): Promise<Ctx> {
  const env = { HOME: w.home, TRAIL_HOME: w.trail, PATH: "/nonexistent", TRAIL_NO_FETCH: "1", DO_NOT_TRACK: "1" };
  writeFileSync(join(w.trail, "settings.json"), JSON.stringify({ v: 1, skills: "on" }));
  const said: string[] = [];
  const { reads } = beginLookBack(w.repo, { env: { ...env, CLAUDECODE: "1" }, deps: { stdinTTY: false, stdoutTTY: false, ps: PS, pid: 77 } });
  await finishLookBack(w.repo, reads, { yes: false, say: (l) => said.push(l) });
  const listText = said.filter((l) => !l.startsWith("· still")).join("\n");
  const reply = "From Trail's look-back:\n1. release-npm (skill)\n2. no-timeout (guardrail)\n3. \"never use em dashes in the copy\" (your own words)\nWhich numbers should I keep?";
  return { w, env, repoKey: repoPlace(w.repo, env).key, listText, reply };
}

/** The keep session's transcript where Claude Code keeps it, and the hooks' cursor on it (receiptTranscriptRead). */
function keepSession(c: Ctx, answer: string, extra: object[] = []): string {
  const dir = join(c.w.home, ".claude", "projects", folderOf(c.w.repo));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${SESSION}.jsonl`);
  const at = { cwd: c.w.repo, sessionId: SESSION };
  writeFileSync(path, jsonl([
    typed("set up trail here", at), toolUse("tu1", "Bash", { command: "trail init --agents claude" }, at), toolResult("tu1", c.listText, undefined, at),
    said(c.reply, at), ...extra, typed(answer, at),
  ]));
  const st = statSync(path);
  const state = sessionPath(SESSION, ".json", c.env);
  mkdirSync(join(state, ".."), { recursive: true });
  writeFileSync(state, JSON.stringify({ trace: { dev: st.dev, ino: st.ino } }));
  return path;
}

const gate = (c: Ctx, path: string, command: string) =>
  keepDecision({ session_id: SESSION, transcript_path: path, cwd: c.w.repo, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_k1", tool_input: { command } }, c.w.repo, c.env);

async function inWorld(tag: string, fn: (c: Ctx) => Promise<void> | void): Promise<void> {
  const w = world(`b6-${tag}`);
  history(w);
  const saved = process.env.TRAIL_HOME;
  process.env.TRAIL_HOME = w.trail;
  try {
    await fn(await relayed(w));
  } finally {
    if (saved === undefined) delete process.env.TRAIL_HOME;
    else process.env.TRAIL_HOME = saved;
    done(w);
  }
}


test("a receipt used by another keep between finding it and keeping keeps nothing: the claim comes first", async () => {
  await inWorld("keep-race", (c) => {
    const path = keepSession(c, "2");
    assert.equal(gate(c, path, "trail keep 2"), null);
    const rp = keepReceiptPath(SESSION, c.env);
    // The other `trail keep 2` marks the receipt used after this one found it.
    const r = keepCommand(["2"], c.env, new Date(), { dir: c.w.repo, tty: false, onFound: () => {
      writeFileSync(rp, JSON.stringify({ ...JSON.parse(readFileSync(rp, "utf8")), usedAt: new Date().toISOString() }));
    } });
    assert.deepEqual(r, { code: 1, lines: [KEEP_HELD] });
    assert.ok(!existsSync(join(c.w.trail, "learnings")), "nothing written");
    assert.equal(readInitRecord(c.repoKey, c.env).pending.length, 3, "the list still waits");
  });
});

test("a stale receipt and one from the future keep nothing", async () => {
  await inWorld("keep-stale", (c) => {
    const path = keepSession(c, "2");
    assert.equal(gate(c, path, "trail keep 2"), null);
    const later = new Date(Date.now() + 2 * 60 * 60_000 + 60_000);
    assert.deepEqual(keepCommand(["2"], c.env, later, { dir: c.w.repo, tty: false }).lines, [KEEP_HELD], "older than 2 hours");
    const earlier = new Date(Date.now() - 60_000);
    assert.deepEqual(keepCommand(["2"], c.env, earlier, { dir: c.w.repo, tty: false }).lines, [KEEP_HELD], "from the future");
    assert.ok(!existsSync(join(c.w.trail, "learnings")));
  });
});

test("a deferred item a typed 'all' doesn't keep still waits: not closed, not said to be gone (B5, spec 14)", async () => {
  await inWorld("keep-deferred-waits", (c) => {
    const pending = readInitRecord(c.repoKey, c.env).pending;
    const deferredId = pending[1]!.id;
    updateInitRecord(c.repoKey, (x) => {
      x.deferred = [deferredId];
    }, c.env);
    const path = keepSession(c, "all");
    assert.equal(gate(c, path, "trail keep all"), null);
    const r = keepCommand(["all"], c.env, new Date(), { dir: c.w.repo, tty: false });
    assert.equal(r.code, 0);
    const rec = readInitRecord(c.repoKey, c.env);
    assert.ok(!rec.closed.includes(deferredId), "a deferred item the answer didn't name is not closed");
    assert.ok(rec.deferred.includes(deferredId), "it still waits for the person's own init");
    assert.ok(!r.lines.some((l) => l.startsWith("Not kept:") && l.includes("no-timeout")), r.lines.join("\n"));
  });
});

/** Every file under `dir`. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: import("node:fs").Dirent[] = [];
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) (e.isDirectory() ? walk(join(d, e.name)) : out.push(join(d, e.name)));
  };
  walk(dir);
  return out;
}

test("no typed word and no command on disk outside what was kept: relay, gate, receipt, keep, offer log", async () => {
  await inWorld("keep-disk", (c) => {
    const path = keepSession(c, "just 2");
    assert.equal(gate(c, path, "trail keep 2"), null);
    assert.equal(keepCommand(["2"], c.env, new Date(), { dir: c.w.repo, tty: false }).code, 0);
    const words = ["never use em dashes", "time box", "publish 1.0", "npm publish", "npm view", "npm run build", "just 2", "set up trail here"];
    // Kept learnings and skills hold what the person kept; everything else Trail wrote holds pointers and counts only.
    const files = filesUnder(c.w.trail).filter((f) => !f.includes(`${join(c.w.trail, "learnings")}`) && !f.includes(join(c.w.trail, "skills")));
    assert.ok(files.some((f) => f.includes(join("init", ""))), "the init record is among them");
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const w of words) assert.ok(!text.includes(w), `${w} in ${f}`);
    }
  });
});

test("the person's scripted --yes never keeps a preference they put off with esc (B5)", async () => {
  await inWorld("yes-deferred", async (c) => {
    const ids = readInitRecord(c.repoKey, c.env).pending.map((p) => p.id);
    updateInitRecord(c.repoKey, (x) => {
      x.deferred = ids;
    }, c.env);
    const said: string[] = [];
    const { reads } = beginLookBack(c.w.repo, { env: { ...c.env }, again: true, deps: { stdinTTY: false, stdoutTTY: false, ps: PS, pid: 77 } });
    const r = await finishLookBack(c.w.repo, reads, { yes: true, say: (l) => said.push(l) });
    assert.equal(r.kept, 0, said.join("\n"));
    assert.ok(!existsSync(join(c.w.trail, "learnings")), "no preference written");
  });
});
