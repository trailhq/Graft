/**
 * D120 (1): a typed line that names the same job class as the open, not-yet-checked run continues that run,
 * whatever its length (the 25-word cap is for matching skills, not for continuation). A different job, a run that
 * already checked out, or a compaction still starts a new run. Pinned with the synthetic shape of the lab's H1
 * turn 4: a prior interrupted turn, then a 26-word line ending "publish X now and check it went out". Made-up
 * repos and prompts only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkedSuccess } from "../src/trace/runs.js";
import { askText, MAX_ASK_WORDS, wordCount } from "../src/trace/jobs.js";
import { compactBoundary, compactSummary, interrupted, toolResult, toolUse } from "./trace-fixtures.js";
import { ask, at, bash, reply, session } from "./trace-run-fixtures.js";

const TURN4 = "the registry here is a stand-in that writes to a file so nothing ships from this box, so publish 1.4.3 now and check it went out";
const DEPLOY = "the registry here is a stand-in that writes to a file so nothing ships from this box, so deploy the docs site to vercel prod now please";
const shape = (s: ReturnType<typeof session>) => s.st.runs.map((r) => ({ job: r.job, typed: r.typedCount, cmds: r.calls.map((c) => c.cmd) }));

/** Turns 1 to 3 of the release: the ask, the build, then a publish the person interrupted. */
function upToTheInterrupt(s: ReturnType<typeof session>): void {
  s.fold([ask("publish 1.4.3 to npm", 0), ...bash("git pull --ff-only origin main", "Already up to date.", { sec: 5 }), ...bash("npm run build", "built", { sec: 10 }),
    reply("Built. Publishing next.", 20)]);
  s.fold([toolUse("toolu_int1", "Bash", { command: "npm publish --access public" }, { timestamp: at(30) }),
    toolResult("toolu_int1", "The user doesn't want to proceed with this tool use. The tool use was rejected.", true, { timestamp: at(31) }),
    { ...interrupted(), timestamp: at(31) }, reply("No response requested.", 32)]);
}

test("the shape is H1's: a 26-word line, over the matching cap", () => {
  assert.equal(wordCount(askText(TURN4)), 26);
  assert.ok(wordCount(askText(TURN4)) > MAX_ASK_WORDS && wordCount(askText(DEPLOY)) > MAX_ASK_WORDS);
});

test("D120 (1): after an interrupted turn, a long line naming the same job continues the release: one run, saved whole and checked", () => {
  const s = session("same-job");
  upToTheInterrupt(s);
  s.fold([ask(TURN4, 60), ...bash("npm publish --access public", "+ acme-cli@1.4.3", { sec: 65 }), ...bash("npm view acme-cli version", "1.4.3\n", { sec: 70 }),
    reply("Published acme-cli 1.4.3; npm shows 1.4.3.", 80)]);
  assert.equal(s.st.runs.length, 1, JSON.stringify(shape(s)));
  const run = s.st.runs[0]!;
  assert.equal(run.job, "release");
  assert.equal(run.typedCount, 2);
  assert.deepEqual(run.calls.map((c) => c.cmd), ["git pull --ff-only origin main", "npm run build", "npm publish --access public", "npm view acme-cli version"], "the rejected publish never ran");
  assert.equal(run.promptParams.version, "1.4.3");
  assert.equal(checkedSuccess(run, "Published acme-cli 1.4.3; npm shows 1.4.3.").checked, true);
});

test("D120 (1): a long line naming another job still starts a new run", () => {
  const s = session("other-job");
  upToTheInterrupt(s);
  s.fold([ask(DEPLOY, 60), ...bash("vercel deploy --prod", "Production: https://docs.acme.dev", { sec: 65 })]);
  assert.equal(s.st.runs.length, 2, JSON.stringify(shape(s)));
  assert.equal(s.st.runs[1]!.typedCount, 1);
});

test("D120 (1): a run that already checked out is not continued by a long line of the same job", () => {
  const s = session("checked");
  s.fold([ask("publish 1.4.2", 0), ...bash("npm publish --access public", "+ acme-cli@1.4.2", { sec: 5 }), ...bash("npm view acme-cli version", "1.4.2\n", { sec: 8 }),
    reply("Published 1.4.2; npm shows it.", 10)]);
  s.fold([ask(TURN4, 60), ...bash("npm publish --access public", "+ acme-cli@1.4.3", { sec: 65 })]);
  assert.equal(s.st.runs.length, 2, JSON.stringify(shape(s)));
  assert.deepEqual(s.st.runs[0]!.calls.map((c) => c.cmd), ["npm publish --access public", "npm view acme-cli version"]);
});

test("D120 (1): after a compaction a long line of the same job starts a new run (D59a)", () => {
  const s = session("compact");
  upToTheInterrupt(s);
  s.fold([compactBoundary({ timestamp: at(40) }), compactSummary({ timestamp: at(40) })]);
  s.fold([ask(TURN4, 60), ...bash("npm publish --access public", "+ acme-cli@1.4.3", { sec: 65 })]);
  assert.equal(s.st.runs.length, 2, JSON.stringify(shape(s)));
  assert.equal(s.st.runs[1]!.epoch, 1);
});
