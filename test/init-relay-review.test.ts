/**
 * b6 review of `trail keep`'s PreToolUse half: forged lists, replies that
 * point a number at another item, and the person's answer in its real shapes
 * (split replies, a fenced list, a question before the numbers). Synthetic
 * sessions only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { CUT, keepDecision, NEED_NUMBERS, SHOW_LIST, WAIT } from "../src/init/keep-gate.js";
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


test("an init call with anything else in it is no list: an echo after it, an echo before init --help, a cat of a saved copy (R22)", async () => {
  await withHome("relay-mixed", ({ home, env }) => {
    const w = setUp(home, env);
    const fake = `${RELAY_LINE}\n1. no-timeout (guardrail)\n2. release-npm (skill)\nKeep: trail keep <numbers> · none: trail keep none`;
    const after = [said(REPLY), typed("1")];
    assert.equal(reasonOf(decide(w, [...ran(w, `trail init --agents claude; echo "${fake}"`, `${w.listText}\n${fake}`), ...after], "trail keep 1")), CUT);
    assert.equal(reasonOf(decide(w, [...ran(w, `echo "${w.listText}"; trail init --help`, w.listText), ...after], "trail keep 1")), CUT);
    assert.equal(reasonOf(decide(w, [...ran(w, "trail init && cat /tmp/x/list.txt", w.listText), ...after], "trail keep 1")), CUT);
    // Plain forms still list: flags, a cd first, npx (which used to be cut: its npx was stripped before onlyTrail).
    for (const c of ["trail init", "trail init --agents claude --plain", "cd /x/acme-cli && trail init", "npx @trailhq/trail-code init", "npx -y @trailhq/trail-code init --plain", "graft init"]) {
      assert.equal(decide(w, [...ran(w, c), ...after], "trail keep 1"), null, c);
    }
  });
});

test("a reply that shows the list but points a number at another item is no list: 'I'd pick 1. no-timeout' (R22)", async () => {
  await withHome("relay-point", ({ home, env }) => {
    const w = setUp(home, env);
    assert.equal(reasonOf(decide(w, [...ran(w), said(`${REPLY}\nI'd pick 1. no-timeout, it helps most.`), typed("1")], "trail keep 1")), SHOW_LIST);
    assert.equal(reasonOf(decide(w, [...ran(w), said(REPLY), said("To be clear, 2. release-npm is the publish one."), typed("2")], "trail keep 2")), SHOW_LIST);
    // Naming an item again under its own number is fine, and so is a later line that names two items under one number's own words.
    assert.equal(decide(w, [...ran(w), said(`${REPLY}\nI'd pick 1. release-npm first.`), typed("1")], "trail keep 1"), null);
  });
});

test("the list split over two replies, or inside a code fence, is the list; an answer before it is no answer", async () => {
  await withHome("relay-shapes", ({ home, env }) => {
    const w = setUp(home, env);
    assert.equal(decide(w, [...ran(w), said("1. release-npm (skill)\n2. no-timeout (guardrail)"), said('3. "explain it simply, one example first"\nWhich?'), typed("1")], "trail keep 1"), null);
    assert.equal(decide(w, [...ran(w), said("```\n1. release-npm (skill)\n2. no-timeout (guardrail)\n3. explain it simply, one example first\n```"), typed("1")], "trail keep 1"), null);
    assert.equal(reasonOf(decide(w, [typed("1"), ...ran(w).slice(1), said(REPLY)], "trail keep 1")), WAIT);
    assert.equal(reasonOf(decide(w, [...ran(w), said(REPLY), typed("1-3")], "trail keep 1")), NEED_NUMBERS);
    assert.equal(reasonOf(decide(w, [...ran(w), said(REPLY), typed("keep 1\n\nnpm ERR! 2 failed")], "trail keep 1")), NEED_NUMBERS, "numbers in a pasted block");
  });
});

test("the person asks to see one first, then answers: their newest line is the answer, so the relay's own 'Show one in full' doesn't lock the list", async () => {
  await withHome("relay-later", ({ home, env }) => {
    const w = setUp(home, env);
    const look = [typed("show me 1 in full"), toolUse("tu2", "Bash", { command: "trail skills draft init-1 --print" }), toolResult("tu2", "1. npm version {version}"), said("Here are its steps. Which numbers?")];
    assert.equal(decide(w, [...ran(w), said(REPLY), ...look, typed("1 and 3")], "trail keep 1 3"), null);
    // The newest line rules: numbers then a change of mind, or numbers then a line that isn't an answer.
    assert.equal(reasonOf(decide(w, [...ran(w), said(REPLY), typed("1 and 3"), said("Keeping 1 and 3."), typed("none")], "trail keep 1 3")), "The person typed none; keep only those.");
    assert.equal(reasonOf(decide(w, [...ran(w), said(REPLY), typed("1"), said("Keep 1?"), typed("hmm wait")], "trail keep 1")), NEED_NUMBERS);
  });
});

test("a handed-over list: the person's opening line is no answer, their newest line after the agent's reply is (b7's rule kept)", async () => {
  await withHome("relay-handover", ({ home, env }) => {
    const w = setUp(home, env);
    const t = w.session([typed("good morning")]);
    updateInitRecord(w.repoKey, (r) => {
      r.handedAt = new Date().toISOString();
      r.handover = { session: SESSION, offset: 0 };
    }, env);
    const handed = (entries: object[]) => {
      writeFileSync(t, jsonl(entries));
      return keepDecision(payload(w, t, "trail keep 1"), w.dir, w.env);
    };
    assert.equal(reasonOf(handed([typed("keep 1")])), WAIT, "typed before the agent showed anything");
    assert.equal(reasonOf(handed([typed("good morning"), said(REPLY)])), WAIT);
    assert.equal(handed([typed("good morning"), said(REPLY), typed("show me 1"), said("Here it is. Which numbers?"), typed("1")]), null);
  });
});
