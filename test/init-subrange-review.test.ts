/**
 * b6 review, D112: an init skill kept from the relay compiles again from its
 * source only when the pending range is one whole run of that session. The
 * record is the agent's to edit, so a range cut short (just before a step
 * that failed after the check, or a question) or two runs glued together
 * must not compile to a skill the session never checked. Synthetic files only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { compileInitSkill, recompileInitSkill, replaySession } from "../src/init/replay-runs.js";
import { day, done, releaseJob, SHOP, Tx, world } from "./init-mine-fixtures.js";

process.env.TZ = "UTC";

/** Two releases that checked out, then a third whose tag push failed after its check: not a good run. */
function session(w: ReturnType<typeof world>) {
  const tx = new Tx(w.repo);
  releaseJob(tx, 1, "1.0.1");
  releaseJob(tx, 2, "1.0.2");
  tx.typed(day(3), "publish 1.0.3");
  tx.bash(day(3, 10, 10), "npm run build", "built in 2.1s");
  tx.bash(day(3, 10, 20), "npm publish acme-cli-1.0.3.tgz --access public", "+ acme-cli@1.0.3");
  tx.bash(day(3, 10, 30), "npm view acme-cli version", "1.0.3");
  tx.said(day(3, 10, 40), "Published 1.0.3.");
  tx.bash(day(3, 10, 50), "git push origin v1.0.3", "Exit code 1\nerror: failed to push some refs", { isError: true });
  tx.said(day(3, 10, 55), "The tag push failed. Should I retry?");
  const path = tx.write(w.home, "s-cut");
  const text = readFileSync(path, "utf8");
  const lineAt = (needle: string) => Buffer.byteLength(text.slice(0, text.indexOf(needle)).replace(/[^\n]*$/, ""));
  return { path, st: statSync(path), lineAt };
}

test("a pending range cut short of its run's end is not kept: the whole session is replayed and the range must be one whole run (D112)", () => {
  const w = world("subrange-end");
  try {
    const { path, st, lineAt } = session(w);
    const now = new Date(day(9));
    const full = replaySession(path, { from: 0, to: st.size }, SHOP, now, { env: w.env });
    assert.deepEqual(full.sheets.map((s) => s.sheet.promptParams.version), ["1.0.1", "1.0.2"], "day 3 is no good run");
    // The agent cuts day 3 just before the push that failed, replays that range and writes its sha into the record.
    const part = replaySession(path, { from: lineAt('"publish 1.0.3"'), to: lineAt("git push origin v1.0.3") }, SHOP, now, { env: w.env });
    const cut = part.sheets[part.sheets.length - 1];
    assert.ok(cut, "the cut range replays to a checked run on its own");
    const prior = full.sheets[1]!;
    const c = compileInitSkill(cut!, prior, SHOP, w.env, now);
    if (!c.ok) assert.fail("the cut range compiles on its own");
    const forged = { t: path, size: st.size, mtimeMs: st.mtimeMs, run: cut!.src, prior: { t: path, ...prior.src }, skillSha: c.skillSha };
    assert.equal(recompileInitSkill(forged, SHOP, w.env, now).ok, false, "a run cut before its failed step");
    // The honest newest run still compiles again.
    const c2 = compileInitSkill(full.sheets[1]!, full.sheets[0]!, SHOP, w.env, now);
    if (!c2.ok) assert.fail("the honest run compiles");
    const honest = { t: path, size: st.size, mtimeMs: st.mtimeMs, run: full.sheets[1]!.src, prior: { t: path, ...full.sheets[0]!.src }, skillSha: c2.skillSha };
    assert.equal(recompileInitSkill(honest, SHOP, w.env, now).ok, true);
  } finally {
    done(w);
  }
});

test("a pending range that glues two runs together, or a prior cut short of its end, is not kept either (D112)", () => {
  const w = world("subrange-glue");
  try {
    const { path, st, lineAt } = session(w);
    const now = new Date(day(9));
    const full = replaySession(path, { from: 0, to: st.size }, SHOP, now, { env: w.env });
    const [p1, n2] = full.sheets;
    const c = compileInitSkill(n2!, p1!, SHOP, w.env, now);
    if (!c.ok) assert.fail("the honest run compiles");
    const base = { t: path, size: st.size, mtimeMs: st.mtimeMs, run: n2!.src, prior: { t: path, ...p1!.src }, skillSha: c.skillSha };
    // Days 1 and 2 as one range: its last run is day 2, whose sha this is.
    assert.equal(recompileInitSkill({ ...base, run: { from: p1!.src.from, to: n2!.src.to } }, SHOP, w.env, now).ok, false, "two runs as one");
    // The prior cut short: day 3 just before the push that failed after its check.
    const priorCut = { t: path, from: lineAt('"publish 1.0.3"'), to: lineAt("git push origin v1.0.3") };
    const cutSheet = replaySession(path, priorCut, SHOP, now, { env: w.env }).sheets[0];
    assert.ok(cutSheet, "the cut prior replays to a checked run on its own");
    const cp = compileInitSkill(n2!, cutSheet!, SHOP, w.env, now);
    if (!cp.ok) assert.fail("compiles with the cut prior");
    assert.equal(recompileInitSkill({ ...base, prior: priorCut, skillSha: cp.skillSha }, SHOP, w.env, now).ok, false, "a prior cut short");
  } finally {
    done(w);
  }
});
