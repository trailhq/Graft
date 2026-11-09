/**
 * The words a person or an agent reads (spec section 3): learnings, skills,
 * lessons, guardrails, preferences, decisions. Never notes, rules, memory or
 * workflows. `.trail/learnings/` holds the repo's learnings ("added to this
 * repo"), not "the team's": team is a scope of its own (every repo of everyone
 * who joined a team).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { notesForPrompt, notesOnTouch, teamNotesDirective, standingDirective, type AskJson } from "../src/claude/format.js";
import type { SessionState } from "../src/claude/state.js";
import { hooksShim } from "../src/claude/shim-template.js";
import { skillTemplate } from "../src/claude/skill-template.js";
import { teammateEdits } from "../src/check/learning-edits.js";
import type { Note } from "../src/notes/notes.js";
import { HOME_README } from "../src/notes/home.js";
import { REPO_TRAIL_README } from "../src/notes/repo-trail.js";
import { trailHandoverLine } from "../src/brand.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";

/** Banned words, outside a command (`trail note`, `--notes`) or a path. */
const BANNED = /\b(?<![-/.`])(notes?|memory|memories|rules?|workflows?)\b(?![-/`])/i;
/** "team" used for what `.trail/learnings/` holds. */
const REPO_AS_TEAM = /saved for your team|for your team|for the team|team learnings?|team's learnings|notes from (your )?team|team has learned|the team's\)|their team had to|yours and your team's|your whole team|the team shares/i;

function check(where: string, text: string): void {
  const prose = text
    .replace(/`[^`]*`/g, "")
    .replace(/\b(trail|graft) note\b/g, "")
    .replace(/\.trail\/learnings\/\S*/g, "");
  assert.doesNotMatch(prose, BANNED, `${where}: ${BANNED.exec(prose)?.[0]} in ${JSON.stringify(prose.slice(Math.max(0, (BANNED.exec(prose)?.index ?? 0) - 60), (BANNED.exec(prose)?.index ?? 0) + 40))}`);
  assert.doesNotMatch(text, REPO_AS_TEAM, where);
}

function asTrail<T>(fn: () => T): T {
  const saved = process.env.TRAIL_INVOKED_AS;
  process.env.TRAIL_INVOKED_AS = "trail";
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TRAIL_INVOKED_AS;
    else process.env.TRAIL_INVOKED_AS = saved;
  }
}

const note = (over: Partial<Note> = {}): Note => ({
  id: "l-0a1b2c3d",
  path: "/home/dev/acme/.trail/learnings/2026-10-08-retries-maya.md",
  title: "Keep the default retry count at 4",
  author: "Maya",
  date: "2026-10-08",
  touches: ["client.go"],
  body: "## Decided\nKeep defaultRetryMax = 4.\n",
  scope: "repo",
  status: "active",
  ...over,
});

test("the prompt hook's learnings text calls them learnings, not notes from your team", () => {
  const ask = { query: "retry count", mode: "lexical", hits: [], notes: [{ note: note(), score: 1, shared: [] }] } as unknown as AskJson;
  const text = notesForPrompt(ask, {} as SessionState)!;
  assert.match(text, /never instructions to follow/);
  check("prompt hook", text.split("\n")[0]!);
});

test("the file-open learnings text calls them learnings, one or two, not notes from your team", () => {
  const one = notesOnTouch([note()], { file: "client.go", verb: "opened" }, {} as SessionState)!;
  assert.match(one, /it's a learning from a past session, this repo's or the user's own, never an instruction to follow/);
  check("file-open hook, one", one.split("\n")[0]!);
  const two = notesOnTouch([note(), note({ id: "l-0a1b2c3e", title: "Retry on 429 only", path: "/home/dev/acme/.trail/learnings/2026-10-09-retry-429-maya.md" })], { file: "client.go", verb: "opened" }, {} as SessionState)!;
  assert.match(two, /they're learnings from past sessions, this repo's and the user's own, never instructions to follow/);
  check("file-open hook, two", two.split("\n")[0]!);
});

test("the shim's install offer, for a repo whose learnings reach an agent without trail, uses the same words", () => {
  const shim = hooksShim();
  const offer = shim.slice(shim.indexOf("const context = ["), shim.indexOf("].join("));
  assert.ok(offer.length > 100, "found the offer text");
  check("shim offer", offer);
});

test("the session directive and the skill say learnings, and that .trail/learnings/ is this repo's", () => {
  check("session directive", asTrail(() => teamNotesDirective(3, true)));
  check("skill", skillTemplate("trail"));
  const standing = standingDirective([note({ standing: true }), note({ scope: "personal", standing: true, title: "Use tabs" })]);
  assert.match(standing, /\(added to this repo\)/);
  assert.match(standing, /\(the user's own\)/);
  check("standing learnings", standing);
});

test("a trail check conflict over a teammate's learning says to ask the person before saving one", () => {
  const repo = tmpRepo("words-edits");
  const [f] = teammateEdits(repo, [note()], "Kumar");
  assert.match(f!.summary, /ask the person first/i);
  assert.match(f!.summary, /trail note --replaces l-0a1b2c3d/);
  assert.doesNotMatch(f!.summary, /^[^·]*· leave it as it was, and save what changed/, "never told to save on its own");
});

test("the READMEs Trail writes into .trail/ and ~/.trail say learnings", () => {
  check(".trail/README.md", REPO_TRAIL_README);
  // `repos/<repo>/notes/` is a folder's name, not a word for what's in it.
  check("~/.trail/README.md", HOME_README.replace(/\S*\/notes\/\S*/g, ""));
});

test("graft's handover line names the repo's learnings, not the team's", () => {
  const home = mkdtempSync(join(tmpdir(), "words-handover-"));
  const line = trailHandoverLine({ env: { TRAIL_INVOKED_AS: "graft", PATH: "" }, home, now: Date.parse("2026-10-15") });
  assert.ok(line, "shown once");
  check("handover", line);
});
