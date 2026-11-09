/**
 * D118 b: a value bound from the ask ("publish 1.4.2") holds for the life of
 * that run, across turns and re-sent blocks. In the lab a later turn of the
 * same release ("leave those files, continue with the pull and publish")
 * brought the block again with the version gone: "{version} is 0.22.1, from
 * the ask" was dropped and the check fell back to a package.json read.
 * A new run starts from its own ask again. Made-up repos only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptSkills, type PromptDeps } from "../src/claude/prompt-skills.js";
import { releaseSkill, WEBSHOP } from "./skills-recall-fixtures.js";
import { box, CWD, gateFor, grow, payload, ranIn, replyAt, save, stateOf, typedIn, withNow, type Box } from "./skills-prompt-fixtures.js";

const PKG = `$(node -p "require('./package.json').version")`;
/** The release skill with the lab's default: the version package.json holds. */
const release = () => releaseSkill({ applies: WEBSHOP, params: `version=${PKG}` }, { params: [{ name: "version", shape: "version", default: PKG, seen: ["1.4.1"] }] });
const deps = (b: Box): Partial<PromptDeps> => ({ track: () => {}, gate: gateFor(b) });
const ask = (b: Box, prompt: string, iso: string) => promptSkills(payload(b, prompt), CWD, withNow(b, iso), deps(b));
const LATER = "leave the two config files as they are and carry on with the pull and the publish";

test("the lab case: a later turn of the same release keeps the version its ask named, in the block and its check", () => {
  const b = box("bound");
  save(b, release());
  const first = ask(b, "can you pull and publish 1.4.2", "2026-10-20T10:00:00.000Z").context ?? "";
  assert.ok(first.includes("{version} is 1.4.2, from the ask.") && first.includes("(it should show 1.4.2)"), first);
  grow(b, [
    typedIn(b, "can you pull and publish 1.4.2", 0),
    replyAt("There are uncommitted changes here. Should I stash them or will you?", 10),
    typedIn(b, LATER, 60),
  ]);
  const later = ask(b, LATER, "2026-10-20T10:01:00.000Z").context ?? "";
  assert.ok(!later.includes("package.json"), later);
  assert.ok(later === "[trail] Same job as before: start from the steps of skill release-npm above." || later.includes("{version} is 1.4.2, from the ask."), later);
  const st = stateOf(b);
  assert.equal(st.injected.filter((i) => i.cue === "job").length, 1);
  assert.equal(st.injected[0]!.params.version, "1.4.2");
  assert.equal(st.injected[0]!.checkVersion, "1.4.2", "credit still expects 1.4.2");
});

test("a version the later turn names wins; a new run starts from its own ask", () => {
  const b = box("rebound");
  save(b, release());
  ask(b, "can you pull and publish 1.4.2", "2026-10-20T10:00:00.000Z");
  grow(b, [typedIn(b, "can you pull and publish 1.4.2", 0), ...ranIn(b, "git pull --ff-only origin main", "Already up to date.", 5),
    replyAt("Pulled. Should I publish 1.4.2 now?", 10), typedIn(b, "no, publish 1.4.3 instead", 60)]);
  const named = ask(b, "no, publish 1.4.3 instead", "2026-10-20T10:01:00.000Z").context ?? "";
  assert.ok(named.includes("{version} is 1.4.3, from the ask."), named);
  // Hours later the old run is over: a bare "publish it" starts a run of its own, with no version bound.
  grow(b, [replyAt("Published 1.4.3.", 70), typedIn(b, "publish it", 3 * 3600)]);
  const fresh = ask(b, "publish it", "2026-10-20T13:00:00.000Z").context ?? "";
  assert.ok(!fresh.includes("from the ask") && fresh.includes("package.json"), fresh);
});
