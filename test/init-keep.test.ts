/**
 * `trail keep`'s answer rules (design 4.9 steps 3 to 5): the person's typed
 * numbers in whole-message forms only, the agent's reply naming every item
 * of the list as `{n}.` and its name words, and the command's numbers within
 * what was typed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { answerWords, keepArgs, leadWords, parseKeepAnswer, replyNamesList, withinAnswer } from "../src/init/keep-answer.js";
import { buildCandidates } from "../src/init/candidates.js";
import { readWalls } from "../src/trace/wall-state.js";

test("the person's answer: numbers, all or none, as a whole message; anything else is no answer", () => {
  const nums = (s: string) => {
    const a = parseKeepAnswer(s);
    return a && "numbers" in a ? a.numbers : a;
  };
  assert.deepEqual(nums("keep 1 and 3"), [1, 3]);
  assert.deepEqual(nums("1, 3"), [1, 3]);
  assert.deepEqual(nums("just 2"), [2]);
  assert.deepEqual(nums("only 2 please"), [2]);
  assert.deepEqual(nums("1 & 2"), [1, 2]);
  assert.deepEqual(nums("3 1 3"), [1, 3]);
  assert.deepEqual(nums("Keep 2."), [2]);
  for (const s of ["all", "keep all", "all of them", "All of them!"]) assert.deepEqual(parseKeepAnswer(s), { all: true }, s);
  for (const s of ["none", "nothing", "no", "keep none", "None."]) assert.deepEqual(parseKeepAnswer(s), { none: true }, s);
  for (const s of ["sure do whats recommended here", "the release one", "yes", "keep the first one", "1 and maybe 3", "keep 1 but not 2", "", "0", "keep whatever looks useful", "100"]) {
    assert.equal(parseKeepAnswer(s), null, s);
  }
});

test("the reply names every item as {n}. and its name words; reworded counts are fine, a renumbered or short list is not", () => {
  const items = [
    { n: 1, nameWords: ["release-npm"] },
    { n: 2, nameWords: ["no-timeout"] },
    { n: 3, nameWords: ["explain", "simply", "one", "example"] },
  ];
  const shown = "Trail found three things from your past sessions:\n1. **release-npm** (skill): you published to npm on 21 days\n2. `no-timeout` (guardrail), this Mac has no timeout\n3. “explain it simply, one example first” (your own words, 12 days)\nWhich should I keep?";
  assert.equal(replyNamesList(shown, items), true);
  const oneLine = "1. release-npm 2. no-timeout 3. explain it simply, one example first";
  assert.equal(replyNamesList(oneLine, items), true);
  const renumbered = "1. no-timeout\n2. release-npm\n3. explain it simply, one example first";
  assert.equal(replyNamesList(renumbered, items), false, "the person's 1 would point at another item");
  const short = "1. release-npm\n3. explain it simply, one example first";
  assert.equal(replyNamesList(short, items), false, "an item left out");
  assert.equal(replyNamesList("I'd keep release-npm and no-timeout.", items), false, "no numbers");
  assert.equal(replyNamesList("1.2 release-npm 2. no-timeout 3. explain simply one example", items), false, "1.2 is no marker for 1");
  assert.equal(replyNamesList(shown, []), false);
});

test("the command's numbers stay within what the person typed", () => {
  const typed = { numbers: [1, 3] };
  assert.equal(withinAnswer({ numbers: [1, 3] }, typed, [1, 2, 3]), true);
  assert.equal(withinAnswer({ numbers: [1] }, typed, [1, 2, 3]), true);
  assert.equal(withinAnswer({ numbers: [1, 2, 3] }, typed, [1, 2, 3]), false);
  assert.equal(withinAnswer({ all: true }, typed, [1, 2, 3]), false);
  assert.equal(withinAnswer({ all: true }, { all: true }, [1, 2, 3]), true);
  assert.equal(withinAnswer({ numbers: [2] }, { all: true }, [1, 2, 3]), true);
  assert.equal(withinAnswer({ none: true }, { none: true }, [1]), true);
  assert.equal(withinAnswer({ none: true }, typed, [1]), false);
  assert.equal(withinAnswer({ numbers: [1] }, { none: true }, [1]), false);
  assert.deepEqual(keepArgs(["1", "3"]), { numbers: [1, 3] });
  assert.deepEqual(keepArgs(["1,3"]), { numbers: [1, 3] });
  assert.deepEqual(keepArgs(["none"]), { none: true });
  assert.deepEqual(keepArgs(["all"]), { all: true });
  assert.equal(keepArgs(["1", "x"]), null);
  assert.equal(keepArgs([]), null);
  assert.equal(answerWords({ numbers: [1, 2, 3] }), "1, 2 and 3");
});

test("a preference's lead words are the candidates' own (one rule for the screen, the relay and the gate)", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-b6-lead-"));
  try {
    const env = { TRAIL_HOME: join(dir, ".trail"), HOME: dir };
    for (const shortest of ["explain it simply, one example first", "never push to main without asking", "don't use em dashes in the copy"]) {
      const [c] = buildCandidates({
        jobs: [], walls: readWalls(env), prefs: [{ sha: "0123456789abcdef", refs: [{ t: "/x.jsonl", o: 0, s: "a".repeat(64) }], days: ["2026-10-01", "2026-10-03"], shortest, lines: [shortest] }],
        howtos: [], reviews: [], repoKey: "github.com/acme/shop", repoWords: new Set(), skills: false, closed: new Set(), closedV1: new Set(), kept: new Set(), deferred: new Set(), env,
      });
      assert.deepEqual(leadWords(shortest), c!.nameWords, shortest);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an init keep saves a personal skill from init with consent init, in the state and the ledger (R15)", async () => {
  const { savePersonal } = await import("../src/skills/store.js");
  const { readLedger } = await import("../src/skills/ledger.js");
  const { getSkillState } = await import("../src/skills/state.js");
  const { compiled, withHome } = await import("./init-screen-fixtures.js");
  await withHome("consent", ({ env }) => {
    const ref = savePersonal(compiled(), { from: "init", runId: "r-1003-aa11", consent: "init", stepsVerified: 4, env });
    const saved = readLedger(ref.id, env).find((l) => l.event === "saved") as { receipt?: { consent?: string }; from?: string } | undefined;
    assert.equal(saved?.from, "init");
    assert.equal(saved?.receipt?.consent, "init");
    assert.equal(getSkillState(ref.id, env)?.status, "candidate");
  });
});

/* ---- keepItems: what a keep writes ---- */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { keepItems } from "../src/init/keep.js";
import { readInitRecord, updateInitRecord } from "../src/init/init-record.js";
import { repoPlace } from "../src/notes/home.js";
import { guardrailCandidate, prefCandidate, projectTranscript, skillCandidate, withHome } from "./init-screen-fixtures.js";
import { typed as typedLine } from "./trace-fixtures.js";
import type { InitItem } from "../src/init/types.js";

const PREF = "explain it simply, one example first";

function repoIn(home: string, env: NodeJS.ProcessEnv): { dir: string; repoKey: string } {
  const dir = join(home, "acme-cli");
  spawnSync("mkdir", ["-p", dir]);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  return { dir, repoKey: repoPlace(dir, env).key };
}

function items(home: string, repoKey: string): InitItem[] {
  const { refs } = projectTranscript(home, [typedLine("set up the release"), typedLine(PREF)]);
  return [
    { ...skillCandidate(), applies: repoKey, key: `${repoKey}|job:release`, n: 1, title: "release-npm", description: "" },
    { ...guardrailCandidate(), n: 2, title: "no-timeout", description: "" },
    { ...prefCandidate(refs[1]!), n: 3, title: PREF, description: "" },
  ];
}

const allFiles = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(join(d, e.name)) : out.push(join(d, e.name)));
  };
  if (existsSync(dir)) walk(dir);
  return out;
};

test("the screen's keep writes a skill, the guardrail and the person's line, clears pending, and records what to name at next start (D87)", async () => {
  await withHome("keep-tty", ({ home, env }) => {
    const place = repoIn(home, env);
    const all = items(home, place.repoKey);
    updateInitRecord(place.repoKey, (r) => {
      r.pending = [{ ...all[2]!, nameWords: [] }];
      r.pendingFrom = "ir-0001";
    }, env);
    const r = keepItems(all, all, "tty", env, new Date("2026-10-17T10:00:00Z"), { ...place, runId: "ir-0002" });
    assert.deepEqual(r.kept.map((i) => i.n), [1, 2, 3]);
    assert.deepEqual(r.refused, []);
    const trail = env.TRAIL_HOME!;
    assert.ok(existsSync(join(trail, "skills", "release-npm", "SKILL.md")));
    const guard = readFileSync(join(trail, "learnings", "no-timeout.md"), "utf8");
    assert.match(guard, /check: "?no-timeout"?/);
    assert.match(guard, /enforce: "?sure-fail"?/);
    assert.match(guard, /evidence: "\\"timeout: command not found\\" on 6 days, Jul 9 to Oct 2"/);
    const prefFile = readdirSync(join(trail, "learnings")).find((f) => f.startsWith("pref-"))!;
    const pref = readFileSync(join(trail, "learnings", prefFile), "utf8");
    assert.match(pref, /kind: "?preference"?/);
    assert.match(pref, /src: "?init-typed"?/);
    assert.ok(pref.trimEnd().endsWith(PREF), "the person's line is the body");
    // Mined from past sessions: dated the day first said or hit, never the keep day (Oct 17).
    assert.match(pref, /^date: 2026-07-03$/m);
    assert.match(guard, /^date: 2026-07-09$/m);
    const rec = readInitRecord(place.repoKey, env);
    assert.deepEqual(rec.pending, []);
    assert.equal(rec.pendingFrom, null);
    assert.deepEqual(rec.notice?.items.map((x) => [x.kind, x.forget.startsWith("l-") || x.forget === "release-npm" || x.forget === "no-timeout"]), [["skill", true], ["guardrail", true], ["preference", true]]);
    assert.equal(rec.notice?.items[2]!.name, "", "a preference is named by its learning, never its words in the record");
    const text = readFileSync(join(trail, "init", ...place.repoKey.split("/")) + ".json", "utf8");
    assert.ok(!text.includes(PREF) && !text.includes("explain"), "no typed words in the record");
  });
});

test("unticked items close for good, and a closed skill is said no to in the offer log (R53); on --yes they stay pending", async () => {
  await withHome("keep-close", ({ home, env }) => {
    const place = repoIn(home, env);
    const all = items(home, place.repoKey);
    const r = keepItems([all[2]!], all, "tty", env, new Date(), place);
    assert.deepEqual(r.notKept.map((i) => i.n), [1, 2]);
    const rec = readInitRecord(place.repoKey, env);
    assert.deepEqual(rec.closed.sort(), [all[0]!.id, all[1]!.id].sort());
    const offers = readFileSync(join(env.TRAIL_HOME!, "offers.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(offers.map((o) => [o.event, o.moment, o.key, o.answer]), [["closed", "init", `${place.repoKey}|job:release`, "no"]]);

    const y = keepItems([], all, "yes", env, new Date(), place);
    assert.deepEqual(y.kept, []);
    assert.deepEqual(readInitRecord(place.repoKey, env).closed.length, 2, "--yes closes nothing");
  });
});

test("a relayed skill is kept only when its source compiles again to the same sha; else it is refused with its words, and not closed", async () => {
  await withHome("keep-relay", ({ home, env }) => {
    const place = repoIn(home, env);
    const [skill] = items(home, place.repoKey);
    const r = keepItems([skill!], [skill!], "keep", env, new Date(), place);
    assert.deepEqual(r.kept, []);
    assert.equal(r.refused[0]!.why, "gone", "no such source transcript");
    assert.ok(!existsSync(join(env.TRAIL_HOME!, "skills", "release-npm")));
    assert.deepEqual(readInitRecord(place.repoKey, env).closed, []);
  });
});

test("a preference whose line changed since the list is not kept: Trail never writes words it can't read back", async () => {
  await withHome("keep-pref-gone", ({ home, env }) => {
    const place = repoIn(home, env);
    const all = items(home, place.repoKey);
    writeFileSync(all[2]!.pref!.refs[0]!.t, `${JSON.stringify(typedLine("something else"))}\n`);
    const r = keepItems([all[2]!], [all[2]!], "keep", env, new Date(), place);
    assert.equal(r.refused[0]!.why, "gone");
    assert.ok(!allFiles(join(env.TRAIL_HOME!, "learnings")).length);
  });
});

test("r keeps a preference in the repo's .trail/learnings; w to this repo keeps it in the repo's personal folder", async () => {
  await withHome("keep-scope", ({ home, env }) => {
    const place = repoIn(home, env);
    const all = items(home, place.repoKey);
    keepItems([{ ...all[2]!, scope: "repo", applies: place.repoKey }], [all[2]!], "tty", env, new Date(), place);
    const committed = allFiles(join(place.dir, ".trail", "learnings")).filter((f) => f.endsWith(".md"));
    assert.equal(committed.length, 1);
    assert.match(readFileSync(committed[0]!, "utf8"), /explain it simply/);
    keepItems([{ ...all[2]!, id: "i-c3d9e0b872", applies: place.repoKey }], [], "tty", env, new Date(), place);
    const personal = allFiles(join(env.TRAIL_HOME!, "repos")).filter((f) => f.endsWith(".md") && f.includes("notes"));
    assert.equal(personal.length, 1);
    for (const f of [committed[0]!, personal[0]!]) {
      assert.match(readFileSync(f, "utf8"), /^date: 2026-07-03$/m, "the day it was first said");
      assert.match(basename(f), /^2026-07-03-/);
    }
    assert.ok(!existsSync(join(env.TRAIL_HOME!, "learnings")), "nothing every-repo");
  });
});

test("a long preference is kept whole in the body; only its title is cut, at a word", async () => {
  // pluggy's line: cut at 120 characters it ended "PYTHONPATH=sr", a wrong command the agent was told to follow.
  const long = "don't use uv run here, it isn't installed. run it with the system python: PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 PYTHONPATH=src python3 -m pytest";
  await withHome("keep-pref-long", async ({ home, env }) => {
    const place = repoIn(home, env);
    const { refs } = projectTranscript(home, [typedLine("set up the release"), typedLine(long)]);
    const item: InitItem = { ...prefCandidate(refs[1]!), n: 1, title: long, description: "", scope: "repo", applies: place.repoKey };
    const r = keepItems([item], [item], "tty", env, new Date(), place);
    assert.deepEqual(r.refused, []);
    const [file] = allFiles(join(place.dir, ".trail", "learnings")).filter((f) => f.endsWith(".md"));
    const text = readFileSync(file!, "utf8");
    assert.ok(text.includes(long), "the whole line is in the body");
    const title = /^title: "?(.*?)"?$/m.exec(text)![1]!;
    assert.ok(title.length <= 120, title);
    assert.ok(long.startsWith(title.replace(/…$/, "")), title);
    assert.match(title, /(?:^|\s)\S+…$/, "cut after a whole word");
    assert.doesNotMatch(title, /PYTHONPATH=sr…$/);
    // What the agent is told at session start is the whole line, never the cut title.
    const { standingLearnings } = await import("../src/notes/notes.js");
    const { standingDirective } = await import("../src/claude/format.js");
    const said = standingDirective(standingLearnings(place.dir));
    assert.ok(said.includes(`  · ${long} (added to this repo)`), said);
  });
});
