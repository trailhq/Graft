/**
 * g6 review: the cue matcher's longer-ask rule (D71 a) and what recall does
 * with a skill file or a prompt that tries to get more than it should.
 * Synthetic skills (acme/webshop ship, acme-cli release) and made-up prompts
 * shaped like the real misses and near misses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchCue, normalizePrompt, type Candidate } from "../src/skills/recall.js";
import { cand, releaseSkill, shipSkill } from "./skills-recall-fixtures.js";

const NOW = new Date("2026-10-20T10:00:00.000Z");
const ship = cand(shipSkill());
const shipProd = cand(shipSkill({ trail: "s-0a0b0c", asks: "push to prod, deploy to prod, update prod, ship it", "status-asks": "is it live, is prod updated" }, { name: "ship-prod" }));
const release = cand(releaseSkill());
const kindOf = (prompt: string, cands: Candidate[]) => {
  const r = matchCue(normalizePrompt(prompt), cands, null, NOW);
  return r ? `${r.kind}:${r.cand.ref.name}` : null;
};
const words = (t: string) => t.trim().split(/\s+/).length;

test("D71 a: a 26 to 60 word ask fires when it names the skill's place and its job verb", () => {
  const live = "okay now what do I need to do to make this go live on the web app, list every step for me, and push to prod if you need to";
  assert.ok(words(live) > 25 && words(live) <= 60, String(words(live)));
  assert.equal(kindOf(live, [ship]), "job:ship-beta-then-prod");
  assert.equal(kindOf(live, [shipProd]), "job:ship-prod");
  const more = "okay can you ff this to prod, also one more change: the call to action on the main landing page should open a chat with our sales line straight away when on a phone, so a visitor can start their journey there, can you help do this?";
  assert.ok(words(more) > 25 && words(more) <= 60, String(words(more)));
  assert.equal(kindOf(more, [ship]), "job:ship-beta-then-prod");
  const merged = "the keys and the numbers were all set already in the hosting settings, so can you merge the changes so that it can go live, I mean push it to the prod branch";
  assert.ok(words(merged) > 25, String(words(merged)));
  assert.equal(kindOf(merged, [ship]), "job:ship-beta-then-prod");
});

test("D71 a: a longer ask with no place of the skill's, or no job verb, or over 60 words, matches nothing", () => {
  // The place but no job verb.
  const noVerb = "after the copy review we agreed the pricing page on prod needs the new annual plan card, the comparison table and the questions section, so please write those on a new branch first";
  assert.ok(words(noVerb) > 25);
  assert.equal(kindOf(noVerb, [ship]), null);
  // The verb but another place: a skill for prod is not the one for staging.
  const staging = "the onboarding emails look right to me now and the copy is approved by the team, the screenshots are updated too, so please go ahead and push this to staging so we can try it";
  assert.ok(words(staging) > 25);
  assert.equal(kindOf(staging, [shipProd]), null);
  // A skill that names no place keeps the 25-word cap.
  const publish = "the changelog is written and the version numbers in both packages are bumped by hand already, the tests passed on my machine twice today, so can you publish it to npm now please";
  assert.ok(words(publish) > 25 && words(publish) <= 60);
  assert.equal(kindOf(publish, [release]), null);
  assert.equal(kindOf("can you publish it to npm now please", [release]), "job:release-npm");
  // Over 60 words never.
  const long = `${"we went through the whole checkout flow together and wrote down every rough edge we found along the way, ".repeat(3)}so push to prod now`;
  assert.ok(words(long) > 60);
  assert.equal(kindOf(long, [ship]), null);
  // A long status question is still a status question.
  const asked = "did you already push the fix for the login redirect to prod earlier today, or was that only on beta, because the person on the support call says they still see the old page";
  assert.ok(words(asked) > 25);
  assert.equal(kindOf(asked, [ship]), null);
});

test("real-phrasing fixes: the speaker's own 'I'll ...' is a statement, 'ask me questions first' is not a go, and two ship idioms", () => {
  // A pasted agent reply ("I'll ... ship it to beta first, then prod") before the person's own ask to build.
  const pasted = "The new pricing card is still waiting on your go-ahead. Say the word and I'll build it into the page, test it, and ship it to beta first, then prod. yes could you please build it properly";
  assert.equal(kindOf(pasted, [ship]), null);
  assert.equal(kindOf("I'll push to prod myself after lunch", [ship]), null);
  assert.equal(kindOf("I am going to deploy to prod later today", [ship]), null);
  // The ask stays an ask around a sentence of the speaker's own.
  assert.equal(kindOf("push to beta now. I'll check the preview after", [ship]), "job:ship-beta-then-prod");
  // Asked to talk it through first: not a go.
  assert.equal(kindOf("okay ask me questions first but lets get them to prod", [ship]), null);
  assert.equal(kindOf("okay lets get them to prod", [ship]), "job:ship-beta-then-prod");
  // "make it to prod", "make sure ... are on prod": the place a job goes to, said another way.
  assert.equal(kindOf("can you look at the new onboarding work, see what needs to be on prod and make it to prod?", [ship]), "job:ship-beta-then-prod");
  assert.equal(kindOf("please make sure all of the latest changes are both on prod and beta", [ship]), "job:ship-beta-then-prod");
  assert.equal(kindOf("please make sure all of the latest changes are both on prod and beta", [shipProd]), "job:ship-prod");
  const long = "okay can you look at the onboarding work from this week and the fixes from yesterday and see what all needs to be on prod and make it to prod? also tell me what is left";
  assert.ok(words(long) > 25);
  assert.equal(kindOf(long, [ship]), "job:ship-beta-then-prod");
  // Not the idiom: something shown on prod, a check, a place the skill isn't for.
  assert.equal(kindOf("make sure the banner is visible on prod", [ship]), null);
  assert.equal(kindOf("make sure the tests pass on beta", [ship]), null);
  assert.equal(kindOf("make it to staging", [shipProd]), null);
  assert.equal(kindOf("make it to prod", [release]), null);
});

test("status and history questions fire nothing but the check cue, and that only for the skill used last, within 24 hours", () => {
  const recent = (c: Candidate) => ({ id: c.ref.id, at: "2026-10-20T08:00:00.000Z" });
  const stale = (c: Candidate) => ({ id: c.ref.id, at: "2026-10-18T08:00:00.000Z" });
  const all = [ship, release];
  const ask = (p: string, last: { id: string; at: string } | null) => {
    const r = matchCue(normalizePrompt(p), all, last, NOW);
    return r ? `${r.kind}:${r.cand.ref.name}` : null;
  };
  assert.equal(ask("is it published?", recent(release)), "check:release-npm");
  assert.equal(ask("is it published?", stale(release)), null);
  assert.equal(ask("is it published?", null), null);
  assert.equal(ask("is it live now?", recent(ship)), "check:ship-beta-then-prod");
  assert.equal(ask("is it live now?", recent(release)), "check:release-npm", "the skill used last answers, its check words allowing");
  for (const p of [
    "how did we ship the new search page", "how did we publish 1.4.1 last week?", "did the deploy pass?", "did you push to the beta branch and also promote for prod",
    "what did we do to release it last time", "was the publish yesterday the one with the fix?", "can you ship that... right?",
  ]) {
    assert.equal(ask(p, recent(ship)), null, p);
    assert.equal(ask(p, null), null, p);
  }
});
