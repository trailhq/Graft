/**
 * D71 b: compile never writes the run's raw single words as asks for a run
 * with no job class. Such a skill's asks come only from the person's own
 * typed save request, as phrases of two or more words; a request with no
 * such words gives a skill with no asks (it comes back by its name only).
 * Synthetic: the made-up acme/shop.
 */
process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { askPhrases, compileRun, type CompileOpts } from "../src/skills/compile.js";
import { parseSkillMd, renderSkillMd } from "../src/skills/skillmd.js";
import { callKind } from "../src/trace/checks.js";
import type { RunCall, RunSheet } from "../src/trace/types.js";
import { add, append, bash, box, kept, prompt, say, state, stop, where } from "./skills-consent-fixtures.js";
import { said } from "./trace-fixtures.js";

const KEY = "github.com/acme/shop";
let seq = 0;
const call = (cmd: string): RunCall => {
  seq++;
  return { id: `toolu_a${seq}`, at: new Date(Date.UTC(2026, 9, 27, 10, 31, 40) + seq * 20_000).toISOString(), cmd, key: KEY, cwd: "", bg: false, failed: false, isError: false, kind: callKind(cmd, null), src: { use: seq * 1000, result: seq * 1000 + 400 } };
};
const sheet = (calls: RunCall[], o: Partial<RunSheet> = {}): RunSheet => ({
  v: 1, id: "r-1027-3f9a", session: "e76b4ca7f1a0", repoKey: KEY, branch: "main", host: "claude", tier: "A", epoch: 0,
  startedAt: "2026-10-27T10:31:40Z", endedAt: "2026-10-27T10:44:05Z", job: null, jobWords: [], sharedWords: ["client", "openapi", "regenerate"], promptParams: {},
  calls, checkIndex: null, checked: false, end: "done", counts: { commands: calls.length, failed: 0, toolCalls: calls.length, edits: 0 }, helpers: [], skillId: null, ...o,
});
const OPTS: CompileOpts = { repoRoot: "/home/dev/shop", home: "/home/dev", platform: "linux", moment: "asked", applies: KEY, taken: () => false };
const compiled = (s: RunSheet, o: Partial<CompileOpts> = {}) => {
  const r = compileRun(s, { ...OPTS, ...o });
  if (!r.ok) assert.fail(`refused ${r.reason}: ${r.detail}`);
  return r.skill;
};
const GEN = [call("npm run gen:client -- --spec openapi.yaml"), call("npx tsc --noEmit")];

test("askPhrases: the save request's own words, minus how to keep it, as phrases of 2 to 5 words", () => {
  assert.deepEqual(askPhrases("save this as a skill for regenerating the api client"), ["regenerating api client"]);
  assert.deepEqual(askPhrases("nice, the nightly export works now. keep this as a skill"), ["nightly export"]);
  assert.deepEqual(askPhrases("save this as a skill: rebuild search index, for every repo"), ["rebuild search index"]);
  // Nothing but how to keep it, thanks and praise: no phrase.
  for (const t of ["save this as a skill", "great, save this as a skill please", "ok keep this for next time thanks", "make a skill out of this", "save this as a skill for exports", ""]) {
    assert.deepEqual(askPhrases(t), [], t);
  }
  // A version, a sha, a URL or a path is a value, not an ask word; at most 2 phrases, none over 5 words.
  assert.deepEqual(askPhrases("save it as a skill for publishing 1.4.3 to https://registry.example.com"), []);
  assert.deepEqual(askPhrases("save this as a skill. regenerate the api client, then rebuild the docs site, then warm the cache"), ["regenerate api client", "rebuild docs site"]);
  assert.deepEqual(askPhrases("save this as a skill for when we need to regenerate every single generated api client file again"), []);
});

test("a job-less run never gets the run's single words as asks: none without the person's words", () => {
  const s = compiled(sheet(GEN));
  assert.equal(s.meta.asks, "");
  assert.equal(s.description, "Runs npm run in shop, from the steps that worked on Oct 27.");
  const back = parseSkillMd(renderSkillMd(s), s.name)!;
  assert.equal(back.meta.asks, "");
  // From the person's save request: the multi-word phrase, never its single words.
  const asked = compiled(sheet(GEN), { askedWith: "save this as a skill for regenerating the api client" });
  assert.equal(asked.meta.asks, "regenerating api client");
  assert.equal(asked.description, "Runs npm run in shop, from the steps that worked on Oct 27. Use when asked about regenerating api client.");
  assert.equal(compiled(sheet(GEN), { askedWith: "save this as a skill" }).meta.asks, "");
  // A repeated-job compile never reads typed words; a job's asks stay the template's.
  const checked = sheet([...GEN, { ...call("npm test"), check: { family: "tests", passed: true, facts: {} } }], { checkIndex: 2, checked: true });
  assert.equal(compiled(checked, { moment: "repeated", askedWith: "save this as a skill for regenerating the api client" }).meta.asks, "");
  const rel = compiled(sheet([call("npm run build"), call("npm publish acme-cli-1.4.3.tgz --access public")], { job: "release", jobWords: ["publish"] }), { askedWith: "save this as a skill for the cli release" });
  assert.equal(rel.meta.asks, "publish, release, bump, redo the publish, ship to npm");
});

test("end to end: 'save this as a skill for regenerating the api client' after a job-less run keeps that phrase as its ask", () => {
  const b = box();
  say(b, 0, "regenerate the api client from the openapi spec");
  bash(b, 10, "npm run gen:client -- --spec openapi.yaml", "wrote src/client.ts");
  bash(b, 20, "npx tsc --noEmit", "");
  append(b, [said("Regenerated the client; it type-checks.", where(b, 30))]);
  stop(b, 40);
  const p = prompt(b, 70, "save this as a skill for regenerating the api client");
  assert.ok(p.save && p.save.startsWith("r-"), JSON.stringify(p));
  // The agent runs the add the prompt hook named (an asked save keeps that name, g7 review).
  const name = state(b).saveRequest!.name!;
  const r = add(b, 80, `trail skills add ${name} --run ${p.save}`);
  assert.equal(r.cli?.exit, 0, JSON.stringify(r.cli));
  assert.deepEqual(kept(b).skills, [name]);
  const s = parseSkillMd(readFileSync(join(b.env.TRAIL_HOME!, "skills", name, "SKILL.md"), "utf8"), name)!;
  assert.equal(s.meta.asks, "regenerating api client");
});
