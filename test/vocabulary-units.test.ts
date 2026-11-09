/**
 * Three units in everything a person or an agent reads: learnings, always
 * follow (a mark on a learning), and skills. The old kind words (decision,
 * preference, guardrail, lesson) stay on disk as `kind` values and never
 * reach the copy. `trail note --always-follow` is the one question that
 * replaces picking a kind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAlwaysFollow, learningWord } from "../src/notes/units.js";
import { INIT_COPY, yesLine } from "../src/init/review-screen.js";
import { REPAIR_COPY } from "../src/skills/offer-repair.js";
import { LESSON_COPY } from "../src/skills/lessons.js";
import { SURE_FAIL_REASON } from "../src/trace/guard-fast.js";
import { FOLLOW_COPY, whose } from "../src/skills/follow-learnings.js";
import { UPDATE_COPY } from "../src/skills/offer-words-2.js";
import { VALUE_COPY } from "../src/skills/value-line.js";
import { LESSON_DENY } from "../src/skills/lesson-gate.js";
import { standingDirective } from "../src/claude/format.js";
import { formatNoteHits, parseNote, type Note } from "../src/notes/notes.js";
import { noteAsk } from "../src/claude/note-signals.js";
import { gateNote } from "../src/notes/note-gate.js";
import { homeEnv, tmpRepo } from "./helpers.js";

process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "units-trail-home-"));

const OLD = /\b(?:guardrails?|preferences?|decisions?|lessons?)\b/i;
/** Copy as read: placeholders and the `trail skills lesson` command left out, since neither is a word said. */
const said = (t: string) => t.replace(/\{\w+\}/g, "").replace(/trail skills lesson/g, "");

test("the copy constants say learning, always follow or skill, never an old kind word", () => {
  const groups: Record<string, Record<string, string>> = {
    INIT_COPY,
    REPAIR_COPY,
    LESSON_COPY,
    FOLLOW_COPY,
    UPDATE_COPY,
    VALUE_COPY,
    LESSON_DENY,
    SURE_FAIL: { reason: SURE_FAIL_REASON },
  };
  for (const [group, copy] of Object.entries(groups))
    for (const [key, text] of Object.entries(copy)) assert.doesNotMatch(said(text), OLD, `${group}.${key}: ${text}`);
  assert.equal(INIT_COPY.guardrails, "Always follow");
  assert.equal(INIT_COPY.preferences, "Learnings");
});

test("always follow is a mark: kind guardrail, or anything a hook enforces", () => {
  assert.equal(isAlwaysFollow({ kind: "guardrail" }), true);
  assert.equal(isAlwaysFollow({ kind: "decision", check: "no-timeout" }), true);
  assert.equal(isAlwaysFollow({ kind: "preference", enforce: "sure-fail" }), true);
  for (const kind of ["decision", "preference", "lesson", undefined, null]) assert.equal(isAlwaysFollow({ kind }), false, String(kind));
  assert.equal(learningWord({ kind: "guardrail" }), "always-follow learning");
  assert.equal(learningWord({ kind: "lesson" }), "learning");
  assert.deepEqual(
    [whose({ kind: "preference", scope: "personal" }), whose({ kind: "decision", scope: "repo" }), whose({ kind: "guardrail", scope: "team" })],
    ["your learning", "this repo's learning", "your team's always-follow learning"],
  );
  assert.equal(yesLine([{ kind: "skill" }, { kind: "guardrail" }, { kind: "preference" }, { kind: "preference" }], false).startsWith("found 1 skill, 1 always-follow learning and 2 learnings."), true);
});

const note = (over: Partial<Note> = {}): Note => ({
  path: "/r/.trail/learnings/2026-10-26-cents.md",
  id: "l-0a0a0a0a",
  title: "Store money in integer cents",
  author: "Priya",
  date: "2026-10-26",
  touches: [],
  body: "## Decided\n- Store money in integer cents, because floats drift on sums.",
  scope: "repo",
  standing: true,
  ...over,
});

test("session start marks an always-follow learning, names who added it, and says Claude won't go against it", () => {
  const text = standingDirective([note({ kind: "guardrail" }), note({ id: "l-0b0b0b0b", title: "Use pnpm, not npm", body: "Use pnpm, not npm.", author: "Sam" })]);
  assert.match(text, /· Store money in integer cents: Store money in integer cents, because floats drift on sums\. \(always follow, added to this repo, added by Priya\)/);
  assert.match(text, /· Use pnpm, not npm \(added to this repo\)$/m);
  assert.match(text, /One marked always follow holds even if the user asks otherwise: don't go against it; stop and say which learning it is and who added it\./);
  assert.doesNotMatch(text, OLD);
  assert.doesNotMatch(standingDirective([note()]), /always follow/, "said only when one is marked");
});

test("ask's learnings block marks an always-follow one", () => {
  const [line] = formatNoteHits([{ note: note({ kind: "guardrail" }), score: 1 } as never]);
  assert.match(line!, /^from Priya's learning · always follow · Oct 26 · Store money in integer cents$/);
  const [plain] = formatNoteHits([{ note: note(), score: 1 } as never]);
  assert.match(plain!, /^from Priya's learning · Oct 26 · /);
});

function run(args: string[], home: string, stdin: string) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), ...args], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, ...homeEnv(home), DO_NOT_TRACK: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined, TRAIL_HOME: undefined },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function repo(): string {
  const d = tmpRepo("units-e2e");
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "money.ts"), "export function addCents(a: number, b: number): number {\n  return a + b;\n}\n");
  spawnSync("git", ["init", "-q"], { cwd: d });
  spawnSync("git", ["config", "user.name", "Priya Raman"], { cwd: d });
  spawnSync("git", ["config", "user.email", "p@example.com"], { cwd: d });
  spawnSync("git", ["add", "src"], { cwd: d });
  spawnSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "init"], { cwd: d });
  return d;
}

const CENTS = "## Decided\n- Store money in integer cents in `addCents`, because floats drift on sums.\n";

/** A Claude Code transcript for `repo` in `home`, with these lines typed by the person. */
function transcript(home: string, repo: string, typed: string[]): void {
  const dir = join(home, ".claude", "projects", repo.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const lines = typed.map((t, i) => JSON.stringify({ type: "user", uuid: `u${i}`, timestamp: at, message: { role: "user", content: t } }));
  writeFileSync(join(dir, "s1.jsonl"), `${lines.join("\n")}\n`);
}

test("trail note --always-follow from an agent is marked only when the person's own words this session back it", () => {
  const home = mkdtempSync(join(tmpdir(), "units-home-"));
  const d = repo();
  const dir = join(d, ".trail", "learnings");

  // Nothing the person typed says so: saved as a plain learning, and the agent is told why.
  const unbacked = run(["note", d, "--title", "Store money in integer cents", "--touches", "src/money.ts", "--always-follow"], home, CENTS);
  assert.equal(unbacked.status, 0, unbacked.err);
  assert.match(unbacked.out, /^✓ added to this repo · /m);
  assert.match(unbacked.out, /^· not marked always follow: nothing the person typed this session says it must always hold/m);
  const [first] = readdirSync(dir);
  const plainText = readFileSync(join(dir, first!), "utf8");
  assert.doesNotMatch(plainText, /^kind:/m);
  assert.doesNotMatch(plainText, /^standing:/m);

  // The person said it, in this session: marked.
  transcript(home, d, ["fix the totals", "always store money in integer cents, even if someone asks for floats later"]);
  const marked = run(["note", d, "--title", "Money is integer cents in addCents", "--touches", "src/money.ts", "--always-follow", "--anyway"], home, CENTS);
  assert.equal(marked.status, 0, marked.err);
  assert.match(marked.out, /^✓ added to this repo, always follow · \.trail\/learnings\/.+\.md$/m);
  const second = readdirSync(dir).find((f) => f !== first)!;
  const text = readFileSync(join(dir, second), "utf8");
  assert.match(text, /^kind: "?guardrail"?$/m, text);
  assert.match(text, /^standing: true$/m, text);
  assert.equal(isAlwaysFollow(parseNote(text, join(dir, second))!), true);
});

test("the agent's save asks say learnings, never rules", () => {
  for (const kind of ["fixed", "corrected", "undone", "chose", "explored", "other"] as const)
    assert.doesNotMatch(noteAsk({ kind, key: "k", what: "x." } as never), /\brules?\b/i, kind);
  const status = gateNote({ title: "t", body: "## Decided\n- PR #3 is open and not merged yet.", personal: false, files: ["a.ts"], namesSymbol: false, touches: ["a.ts"] }, []);
  assert.ok(status.problems.length > 0);
  for (const p of status.problems) assert.doesNotMatch(p, /\brules?\b/i, p);
});

test("trail note without --always-follow writes no kind, as before", () => {
  const home = mkdtempSync(join(tmpdir(), "units-home-"));
  const d = repo();
  const dir = join(d, ".trail", "learnings");
  const plain = run(["note", d, "--title", "Sum cents with addCents only", "--touches", "src/money.ts"], home, "## Decided\n- Sum money with `addCents` only, because it keeps cents whole.\n");
  assert.equal(plain.status, 0, plain.err);
  assert.match(plain.out, /^✓ added to this repo · /m);
  const [file] = readdirSync(dir);
  const text = readFileSync(join(dir, file!), "utf8");
  assert.doesNotMatch(text, /^kind:/m, "a plain learning is written as before");
  assert.doesNotMatch(text, /^standing:/m);
});
