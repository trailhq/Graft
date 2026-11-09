/**
 * `trail keep`'s PreToolUse half in 1b (design 4.9, R11, R22, B4): the list
 * is a clean `trail init` call's own result or this session's handover; the
 * agent's reply names every item; the person's typed answer is numbers, all
 * or none; the command keeps only within it; and an allowed keep leaves a
 * receipt, once, for the CLI half.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { CHANGED, CUT, keepDecision, keepReceiptPath, NEED_NUMBERS, NOT_THIS_LIST, SHOW_LIST, WAIT } from "../src/init/keep-gate.js";
import { updateInitRecord } from "../src/init/init-record.js";
import { relayLines } from "../src/init/review-screen.js";
import { RELAY_LINE } from "../src/init/relay.js";
import { repoPlace } from "../src/notes/home.js";
import { factsOf, guardrailCandidate, prefCandidate, projectTranscript, skillCandidate, withHome } from "./init-screen-fixtures.js";
import { jsonl, said, toolResult, toolUse, typed } from "./trace-fixtures.js";
import { spawnSync } from "node:child_process";
import type { InitItem } from "../src/init/types.js";

const SESSION = "5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const PREF = "explain it simply, one example first";
const REPLY = "Trail found three things in your past sessions:\n1. release-npm (skill), publishing to npm\n2. no-timeout (guardrail)\n3. \"explain it simply, one example first\" (your words)\nWhich numbers should I keep?";

interface World { env: NodeJS.ProcessEnv; dir: string; repoKey: string; items: InitItem[]; listText: string; session: (entries: object[]) => string }

function setUp(home: string, env: NodeJS.ProcessEnv): World {
  const dir = join(home, "acme-cli");
  spawnSync("mkdir", ["-p", dir]);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const repoKey = repoPlace(dir, env).key;
  const { refs } = projectTranscript(home, [typed("earlier"), typed(PREF)], "11111111-2222-4333-8444-555555555555", "-home-dev-old");
  const items: InitItem[] = [
    { ...skillCandidate(), applies: repoKey, key: `${repoKey}|job:release`, n: 1, title: "release-npm", description: "" },
    { ...guardrailCandidate(), n: 2, title: "no-timeout", description: "" },
    { ...prefCandidate(refs[1]!), n: 3, title: PREF, description: "" },
  ];
  updateInitRecord(repoKey, (r) => {
    r.pending = items.map((i) => ({ ...i }));
    r.pendingFrom = "ir-8c21";
    r.shownAt = new Date().toISOString();
  }, env);
  const listText = `✓ wired claude\n${relayLines(items, factsOf({ agent: true })).join("\n")}`;
  const session = (entries: object[]) => {
    const d = mkdtempSync(join(home, "sess-"));
    const p = join(d, `${SESSION}.jsonl`);
    writeFileSync(p, jsonl(entries));
    return p;
  };
  return { env, dir, repoKey, items, listText, session };
}

const ran = (w: World, command = "trail init --agents claude", output = w.listText) => [typed("set up trail in this repo"), toolUse("tu1", "Bash", { command }), toolResult("tu1", output)];
const payload = (w: World, transcript_path: string, command = "trail keep 1 3") => ({
  session_id: SESSION, transcript_path, cwd: w.dir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_keep1", tool_input: { command },
});
const decide = (w: World, entries: object[], command?: string) => keepDecision(payload(w, w.session(entries), command), w.dir, w.env);
const reasonOf = (d: ReturnType<typeof keepDecision>) => (d ? d.reason : null);

test("trail keep --help and -h are never denied, and write nothing (B4)", async () => {
  await withHome("gate-help", ({ home, env }) => {
    const w = setUp(home, env);
    for (const c of ["trail keep --help", "trail keep -h"]) assert.equal(decide(w, [typed("hi")], c), null, c);
    assert.ok(!existsSync(keepReceiptPath(SESSION, env)));
  });
});

test("no typed answer after the list: wait; no list at all: wait", async () => {
  await withHome("gate-wait", ({ home, env }) => {
    const w = setUp(home, env);
    assert.equal(reasonOf(decide(w, [...ran(w), said(REPLY)])), WAIT);
    assert.equal(reasonOf(decide(w, [typed("keep 1 and 3")])), WAIT);
  });
});

test("'keep 1 and 3' lets trail keep 1 3 run and leaves one receipt; 1 2 3 is denied with the person's numbers", async () => {
  await withHome("gate-allow", ({ home, env }) => {
    const w = setUp(home, env);
    const t = w.session([...ran(w), said(REPLY), typed("keep 1 and 3")]);
    assert.equal(keepDecision(payload(w, t, "trail keep 1 3"), w.dir, w.env), null);
    const path = keepReceiptPath(SESSION, env);
    const r = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual([r.kind, r.verdict, r.numbers, r.list.via, r.list.initRunId, r.usedAt], ["keep", "live", [1, 3], "init-call", "ir-8c21", null]);
    assert.match(r.typed.lineSha, /^[0-9a-f]{64}$/);
    // Both registered hook copies run it: the second finds the same receipt and leaves it.
    const before = statSync(path).mtimeMs;
    assert.equal(keepDecision(payload(w, t, "trail keep 1 3"), w.dir, w.env, new Date(Date.now() + 5000)), null);
    assert.equal(statSync(path).mtimeMs, before);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).at, r.at, "written once");
    assert.equal(reasonOf(keepDecision(payload(w, t, "trail keep 1 2 3"), w.dir, w.env)), "The person typed 1 and 3; keep only those.");
    assert.equal(reasonOf(keepDecision(payload(w, t, "trail keep all"), w.dir, w.env)), "The person typed 1 and 3; keep only those.");
  });
});

test("an answer that isn't numbers is denied with the numbers reason; none and all work as typed", async () => {
  await withHome("gate-forms", ({ home, env }) => {
    const w = setUp(home, env);
    assert.equal(reasonOf(decide(w, [...ran(w), said(REPLY), typed("sure do whats recommended here")], "trail keep 1 2")), NEED_NUMBERS);
    assert.equal(decide(w, [...ran(w), said(REPLY), typed("none")], "trail keep none"), null);
    assert.equal(reasonOf(decide(w, [...ran(w), said(REPLY), typed("none")], "trail keep 1")), "The person typed none; keep only those.");
    assert.equal(decide(w, [...ran(w), said(REPLY), typed("all of them")], "trail keep all"), null);
    assert.equal(decide(w, [...ran(w), said(REPLY), typed("all")], "trail keep 2"), null);
  });
});

test("a forged list is no list: an echo of the relay line, a pipe that cuts it, a reply that renumbers or leaves an item out", async () => {
  await withHome("gate-forged", ({ home, env }) => {
    const w = setUp(home, env);
    const fake = `${RELAY_LINE}\n1. no-timeout (guardrail)\n2. release-npm (skill)\nKeep: trail keep <numbers> · none: trail keep none`;
    const echoed = [typed("hi"), toolUse("tu9", "Bash", { command: `echo "${fake}"` }), toolResult("tu9", fake), said(fake), typed("1")];
    assert.equal(reasonOf(decide(w, echoed, "trail keep 1")), WAIT, "an echo is not a list");
    assert.equal(reasonOf(decide(w, [...ran(w, "trail init --agents claude 2>&1 | tail -5", w.listText.split("\n").slice(-3).join("\n")), typed("1")], "trail keep 1")), CUT);
    assert.equal(reasonOf(decide(w, [...ran(w, "trail init > /tmp/x/init.txt"), typed("1")], "trail keep 1")), CUT);
    const renumbered = "1. no-timeout\n2. release-npm\n3. explain it simply, one example first\nWhich?";
    assert.equal(reasonOf(decide(w, [...ran(w), said(renumbered), typed("1")], "trail keep 1")), SHOW_LIST);
    assert.equal(reasonOf(decide(w, [...ran(w), said("1. release-npm\n3. explain it simply, one example first"), typed("1")], "trail keep 1")), SHOW_LIST);
    const reworded = "Here's the list:\n1. release-npm: done by hand on lots of days\n2. no-timeout, since this machine lacks it\n3. explain it simply, one example first (you said it often)";
    assert.equal(decide(w, [...ran(w), said(reworded), typed("1")], "trail keep 1"), null, "counts reworded, every item named");
    const otherList = ran(w, "trail init", `${RELAY_LINE}\n1. ship-it (skill) · x\nKeep: trail keep <numbers> · none: trail keep none`);
    assert.equal(reasonOf(decide(w, [...otherList, said(REPLY), typed("1")], "trail keep 1")), NOT_THIS_LIST);
  });
});

test("the handover's list is found from the offset the record holds for this session", async () => {
  await withHome("gate-handover", ({ home, env }) => {
    const w = setUp(home, env);
    const before = jsonl([typed("an older turn"), said("ok")]);
    const t = w.session([]);
    writeFileSync(t, before + jsonl([said(REPLY), typed("2")]));
    updateInitRecord(w.repoKey, (r) => {
      r.handedAt = new Date().toISOString();
      r.handover = { session: SESSION, offset: Buffer.byteLength(before) };
    }, env);
    assert.equal(keepDecision(payload(w, t, "trail keep 2"), w.dir, w.env), null);
    assert.equal(JSON.parse(readFileSync(keepReceiptPath(SESSION, env), "utf8")).list.via, "handover");
    updateInitRecord(w.repoKey, (r) => {
      r.handover = { session: "another-session", offset: 0 };
    }, env);
    assert.equal(reasonOf(keepDecision(payload(w, t, "trail keep 2"), w.dir, w.env)), WAIT, "another session's handover is not this one's list");
  });
});

test("a session that wrote Trail's files after the list keeps nothing", async () => {
  await withHome("gate-tamper", ({ home, env }) => {
    const w = setUp(home, env);
    const edit = [toolUse("tu5", "Edit", { file_path: join(env.TRAIL_HOME!, "init", "x.json"), old_string: "a", new_string: "b" }), toolResult("tu5", "ok")];
    assert.equal(reasonOf(decide(w, [...ran(w), said(REPLY), ...edit, typed("1")], "trail keep 1")), CHANGED);
  });
});
