/**
 * Moment 5's split (phase 2 design 4.7, P9, R3): a yes to "keep steps a to
 * b as their own skill" saves through 1a's add gate, which takes a pending
 * `update` offer with `op: 'split'` only for exactly the split's name and
 * pinned by the offer's skillSha. Any other phase 2 offer's yes is no yes to
 * an add. Synthetic sessions (acme/shop).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { said } from "./trace-fixtures.js";
import { add, append, box, ctxAt, kept, offered, prompt, state, where, type Box } from "./skills-consent-fixtures.js";
import { withSkillSession } from "../src/trace/skill-session.js";
import type { PendingOffer } from "../src/trace/types.js";

const made: Box[] = [];
after(() => { for (const b of made.splice(0)) rmSync(b.root, { recursive: true, force: true }); });

/** A moment 2 offer turned into c3's split offer for the same run (same compile, same skillSha, R3). */
function splitOffer(op: "split" | "update" = "split", show: "none" | "line2" | "keep" = "none"): { b: Box; o: PendingOffer } {
  const b = box();
  made.push(b);
  const { offer } = offered(b, 0, { say: false });
  const o = withSkillSession(ctxAt(b, 60), { catchUp: false }, (st) => {
    const po = st.pendingOffer!;
    po.moment = "update";
    po.key = "s-7f3a2c|update|v3";
    po.lines = ["Released 1.4.3: npm shows it, and this release ran only steps 1 to 2 of ship-all, as the one before did.", `Keep steps 1 to 2 as their own skill, ${po.name}, beside ship-all? (yes / show me / no)`];
    po.fold = { op, skillId: "s-7f3a2c", baseHash: "sha256:00", proposalSha: (po.skillSha ?? "").slice(0, 16), handEdited: false, version: 3, ...(op === "split" ? { splitName: po.name } : {}) };
    return structuredClone(po);
  })!;
  append(b, [said(`Done.\n\n${o.lines![0]}\n${o.lines![1]}`, where(b, 62))]);
  if (show !== "none") {
    // "show me": the agent prints the draft, then asks again as c3's show directive says (the offer's line 2).
    prompt(b, 64, "show me");
    const again = show === "line2" ? o.lines![1] : "Keep it? (yes / no)";
    append(b, [said(`---\nname: ${o.name}\n---\n1. npm run build\n2. npm publish\n\n${again}`, where(b, 66))]);
  }
  prompt(b, 70, "yes");
  return { b, o };
}

test("a yes to a split saves the shown skill under its name, from 'repeated', and says it was a split", () => {
  const { b, o } = splitOffer();
  const r = add(b, 80, `trail skills add ${o.name} --run ${o.runId}`);
  assert.equal(r.decision, null);
  assert.equal(r.cli?.exit, 0, r.cli?.lines.join("\n"));
  assert.deepEqual(r.cli!.saved, { from: "repeated", scope: "personal" });
  assert.equal(r.cli!.changed, "split");
  assert.deepEqual(kept(b).skills, [o.name]);
  assert.equal(state(b).pendingOffer, null);
});

test("any other name is refused, with the split's own name in the words", () => {
  const { b, o } = splitOffer();
  const r = add(b, 80, `trail skills add ${o.name}-2 --run ${o.runId}`);
  assert.equal(r.decision?.reason, `trail · not saved: the offer was for the name ${o.name}. Run: trail skills add ${o.name} --run ${o.runId}`);
  assert.deepEqual(kept(b).skills, []);
});

test("a split's name taken since the offer: no numbered stand-in, the split's name is still the only one", () => {
  const { b, o } = splitOffer();
  mkdirSync(join(b.env.TRAIL_HOME!, "skills", o.name), { recursive: true });
  const r = add(b, 80, `trail skills add ${o.name}-2 --run ${o.runId}`);
  assert.equal(r.decision?.reason, `trail · not saved: the offer was for the name ${o.name}. Run: trail skills add ${o.name} --run ${o.runId}`);
  assert.deepEqual(kept(b).skills, [o.name], "only the folder that was there");
});

test("an update offer's yes is no yes to an add of its run: held for the person, never saved", () => {
  const { b, o } = splitOffer("update");
  const r = add(b, 80, `trail skills add ${o.name} --run ${o.runId}`);
  assert.equal(r.cli?.held, "no-yes");
  assert.deepEqual(kept(b).skills, []);
});

test("after show me, a yes to the split's own line 2, asked again as the show directive says, saves it", () => {
  const { b, o } = splitOffer("split", "line2");
  const r = add(b, 80, `trail skills add ${o.name} --run ${o.runId}`);
  assert.equal(r.decision, null, r.decision?.reason);
  assert.equal(r.cli?.exit, 0, r.cli?.lines.join("\n"));
  assert.deepEqual(kept(b).skills, [o.name]);
});

test("after show me, a yes to 1a's Keep it? is no yes to a split (its question is its own line 2)", () => {
  const { b, o } = splitOffer("split", "keep");
  add(b, 80, `trail skills add ${o.name} --run ${o.runId}`);
  assert.deepEqual(kept(b).skills, []);
});
