/**
 * Which learnings can fail `trail check`. Only a repo learning committed on
 * the base branch, about the exact file the change is in, can say the change
 * is wrong. Everything else that would have been a conflict (a teammate's
 * unmerged branch, a learning just for you, one added on this branch, one
 * about a neighbouring file or matched on words) is a lead: worth a look,
 * never a failure. Replaced and retired learnings aren't read at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLocally } from "../src/check/local-check.js";
import { learningId } from "../src/notes/learning-fields.js";
import type { Note } from "../src/notes/notes.js";
import { homeEnv, tmpRepo } from "./helpers.js";

const NOW = new Date("2026-10-15T12:00:00Z");

const DIFF = [
  "diff --git a/internal/retry/client.go b/internal/retry/client.go",
  "--- a/internal/retry/client.go",
  "+++ b/internal/retry/client.go",
  "@@ -1,3 +1,3 @@",
  " package retry",
  " ",
  "-const defaultRetryMax = 4",
  "+const defaultRetryMax = 6",
  "",
].join("\n");

function keep4(over: Partial<Note> = {}): Note {
  const path = over.path ?? "/r/.trail/learnings/2026-10-08-keep-the-default-retry-count-at-maya.md";
  return {
    id: learningId(path.slice(path.lastIndexOf("/") + 1)),
    path,
    title: "Keep the default retry count at 4",
    author: "Maya",
    date: "2026-10-08",
    touches: ["internal/retry/client.go"],
    body: "## Decided\n- Keep defaultRetryMax = 4: ten retries can hold one call for an hour.",
    scope: "repo",
    status: "active",
    ...over,
  };
}

const check = (notes: Note[], committed?: (n: Note) => boolean) =>
  checkLocally({ diff: DIFF, files: ["internal/retry/client.go"], notes, skills: [], now: NOW, ...(committed ? { committed } : {}) }).findings;

test("a committed repo learning about the changed file is still a conflict", () => {
  const [f] = check([keep4()]);
  assert.equal(f?.verdict, "conflict");
  assert.equal(f?.line, 3);
  assert.equal(f?.summary, "changes defaultRetryMax from 4 to 6");
});

test("a learning about a neighbouring file is a lead, with its line and why it can't fail", () => {
  const [f] = check([keep4({ touches: ["internal/retry/backoff.go"] })]);
  assert.equal(f?.verdict, "lead");
  assert.equal(f?.line, 3);
  assert.equal(f?.summary, "changes defaultRetryMax from 4 to 6");
  assert.equal(f?.why, "not about this file");
  assert.equal(f?.source.quote, "Keep defaultRetryMax = 4: ten retries can hold one call for an hour.");
});

test("a teammate's unmerged branch, a learning just for you, and one not on the base yet are leads", () => {
  const onBranch = keep4({ ref: "origin/kumar/wip", path: "origin/kumar/wip:.trail/learnings/2026-10-08-keep-the-default-retry-count-at-maya.md" });
  assert.deepEqual(check([onBranch]).map((f) => [f.verdict, f.why]), [["lead", "on kumar/wip, not merged yet"]]);
  const mine = keep4({ scope: "personal", path: "/h/.trail/repos/x/notes/2026-10-08-keep.md" });
  assert.deepEqual(check([mine]).map((f) => [f.verdict, f.why]), [["lead", "a learning just for you"]]);
  assert.deepEqual(check([keep4()], () => false).map((f) => [f.verdict, f.why]), [["lead", "not on the base branch yet"]]);
  assert.deepEqual(check([keep4()], () => true).map((f) => f.verdict), ["conflict"]);
});

test("replaced and retired learnings are never cited; the newer one is", () => {
  const raised = keep4({
    path: "/r/.trail/learnings/2026-10-12-retry-count-raised-to-6-kumar.md",
    id: learningId("2026-10-12-retry-count-raised-to-6-kumar.md"),
    title: "Retry count raised to 6",
    author: "Kumar",
    date: "2026-10-12",
    body: "## Decided\n- Raise defaultRetryMax to 6: bulk imports time out at 4.",
    replaces: keep4().id,
  });
  const res = checkLocally({ diff: DIFF, files: ["internal/retry/client.go"], notes: [keep4(), raised], skills: [], now: NOW });
  assert.deepEqual(res.findings.map((f) => [f.verdict, f.source.title]), [["follows", "Retry count raised to 6"]]);
  assert.equal(res.notes, 1, "the replaced one isn't counted as checked");
  assert.deepEqual(check([keep4({ status: "retired" })]), []);
});

test("a replacement not on the base branch can't hide a committed learning: the conflict stays and names it", () => {
  const raised = keep4({
    path: "/r/.trail/learnings/2026-10-12-retry-count-raised-to-6-kumar.md",
    id: learningId("2026-10-12-retry-count-raised-to-6-kumar.md"),
    title: "Retry count raised\nto 6",
    author: "Kumar",
    date: "2026-10-12",
    body: "## Decided\n- Raise defaultRetryMax to 6: bulk imports time out at 4.",
    replaces: keep4().id,
  });
  // Only Maya's is on the base branch: Kumar's was saved on this branch, so nobody has agreed to it yet.
  const onlyKeep4 = (n: Note) => n.path === keep4().path;
  const got = check([keep4(), raised], onlyKeep4);
  assert.deepEqual(
    got.map((f) => [f.verdict, f.source.title]),
    [
      ["conflict", "Keep the default retry count at 4"],
      ["follows", "Retry count raised\nto 6"],
    ],
  );
  assert.deepEqual(got[0]!.replacedBy, { id: raised.id, title: "Retry count raised to 6" });
  assert.equal(got[1]!.replacedBy, undefined);
  // A replacement that isn't committed still hides one that isn't either: neither could fail the check.
  assert.deepEqual(check([keep4(), raised], () => false).map((f) => [f.verdict, f.source.title]), [["follows", "Retry count raised\nto 6"]]);
});

test("conflicts come first, then leads, then follows", () => {
  const lead = keep4({ path: "/r/.trail/learnings/2026-10-09-lead.md", touches: ["internal/retry/backoff.go"] });
  const follows = keep4({ path: "/r/.trail/learnings/2026-10-10-six.md", body: "## Decided\n- Raise defaultRetryMax to 6." });
  assert.deepEqual(check([follows, lead, keep4()]).map((f) => f.verdict), ["conflict", "lead", "follows"]);
});

/* -------------------------------------------------------------------------- */
/* end to end, through the CLI                                                */
/* -------------------------------------------------------------------------- */

const KEEP4_NAME = "2026-10-08-keep-the-default-retry-count-at-maya.md";
const KEEP4 = `---\ntitle: "Keep the default retry count at 4"\nauthor: Maya\ndate: 2026-10-08\ntouches:\n  - client.go\n---\n\n## Decided\n- Keep defaultRetryMax = 4: ten retries can hold one call for an hour.\n`;
const client = (n: number) => `package retry\n\nconst defaultRetryMax = ${n}\n`;

function git(repo: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

function trail(args: string[], home: string, input?: string) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...homeEnv(home), DO_NOT_TRACK: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined, TRAIL_HOME: undefined },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

/** The code on main (with Maya's "keep 4" learning, unless `learning` is false); Kumar on a branch that sets 6. */
function raiseBranch(learning = true): { repo: string; home: string } {
  const repo = tmpRepo("check-gate");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Kumar S");
  git(repo, "config", "user.email", "kumar@example.com");
  mkdirSync(join(repo, ".trail", "learnings"), { recursive: true });
  if (learning) writeFileSync(join(repo, ".trail", "learnings", KEEP4_NAME), KEEP4);
  writeFileSync(join(repo, "client.go"), client(4));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "keep 4");
  git(repo, "checkout", "-q", "-b", "raise");
  writeFileSync(join(repo, "client.go"), client(6));
  return { repo, home: mkdtempSync(join(tmpdir(), "check-gate-home-")) };
}

function findings(out: string): Array<{ verdict: string; source: { path?: string; title?: string } }> {
  return JSON.parse(out).findings;
}

const RAISE6 = "## Decided\n- Raise defaultRetryMax to 6: bulk imports time out at 4.\n";

test("the verified example: 4 replaced by 6 on main, a diff that sets 6 passes and never cites the 4", () => {
  const { repo, home } = raiseBranch();
  // Without the newer learning, the change goes against Maya's.
  const before = trail(["check", repo, "--base", "main", "--json"], home);
  assert.equal(before.status, 1, before.err);
  assert.deepEqual(findings(before.out).map((f) => [f.verdict, f.source.title]), [["conflict", "Keep the default retry count at 4"]]);

  // The team agreed to 6 on main: the newer learning, replacing Maya's, is merged there.
  git(repo, "stash", "-q");
  git(repo, "checkout", "-q", "main");
  const saved = trail(["note", repo, "--title", "Retry count raised to 6", "--touches", "client.go", "--replaces", learningId(KEEP4_NAME)], home, RAISE6);
  assert.equal(saved.status, 0, saved.err);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "raise to 6, as agreed");
  git(repo, "checkout", "-q", "raise");
  git(repo, "merge", "-q", "main");
  git(repo, "stash", "pop", "-q");

  const after = trail(["check", repo, "--base", "main", "--json"], home);
  assert.equal(after.status, 0, after.out + after.err);
  const got = findings(after.out);
  assert.ok(got.every((f) => f.verdict !== "conflict"), after.out);
  assert.ok(!after.out.includes(KEEP4_NAME) && !after.out.includes("Keep the default retry count at 4"), "the old learning is never cited");
  assert.deepEqual(got.map((f) => [f.verdict, f.source.title]), [["follows", "Retry count raised to 6"]]);
  const text = trail(["check", repo, "--base", "main"], home);
  assert.equal(text.status, 0);
  assert.doesNotMatch(text.out, /Keep the default retry count at 4|Maya/);
});

test("a replacement saved on the branch doesn't silence the learning on main: the conflict stays and says so", () => {
  const { repo, home } = raiseBranch();
  // The agent, told to fix the conflict, saves a learning that replaces Maya's, on this branch only.
  const saved = trail(["note", repo, "--title", "Retry count raised to 6", "--touches", "client.go", "--replaces", learningId(KEEP4_NAME)], home, RAISE6);
  assert.equal(saved.status, 0, saved.err);
  const newId = /^· id (l-[0-9a-f]+)$/m.exec(saved.out)?.[1];
  assert.ok(newId, saved.out);

  const r = trail(["check", repo, "--base", "main", "--json"], home);
  assert.equal(r.status, 1, r.out + r.err);
  const [first] = findings(r.out) as Array<{ verdict: string; source: { title?: string }; replacedBy?: { id: string } }>;
  assert.deepEqual([first?.verdict, first?.source.title, first?.replacedBy?.id], ["conflict", "Keep the default retry count at 4", newId]);

  const text = trail(["check", repo, "--base", "main"], home);
  assert.equal(text.status, 1);
  assert.match(text.out, new RegExp(`this branch replaces it with ${newId} \\("Retry count raised to 6"\\), which counts once it's on the base branch`));
});

test("run from a folder inside the repo, the check still holds the change to the learning on that file", () => {
  const repo = tmpRepo("check-gate-sub");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Kumar S");
  git(repo, "config", "user.email", "kumar@example.com");
  mkdirSync(join(repo, ".trail", "learnings"), { recursive: true });
  mkdirSync(join(repo, "pkg", "retry"), { recursive: true });
  writeFileSync(join(repo, ".trail", "learnings", KEEP4_NAME), KEEP4.replace("  - client.go", "  - pkg/retry/client.go"));
  writeFileSync(join(repo, "pkg", "retry", "client.go"), client(4));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "keep 4");
  git(repo, "checkout", "-q", "-b", "raise");
  writeFileSync(join(repo, "pkg", "retry", "client.go"), client(6));
  const home = mkdtempSync(join(tmpdir(), "check-gate-home-"));
  for (const dir of [repo, join(repo, "pkg"), join(repo, "pkg", "retry")]) {
    const r = trail(["check", dir, "--base", "main", "--json"], home);
    assert.equal(r.status, 1, `${dir}\n${r.out}${r.err}`);
    assert.deepEqual(findings(r.out).map((f) => [f.verdict, f.source.title]), [["conflict", "Keep the default retry count at 4"]], dir);
  }
});

test("a learning added on the branch can't fail it: it's a lead, and the check passes", () => {
  const { repo, home } = raiseBranch(false);
  // Saved here, on the branch, never on main: nobody has reviewed it yet.
  writeFileSync(join(repo, ".trail", "learnings", "2026-10-14-keep-four-kumar.md"), KEEP4.replace("author: Maya", "author: Kumar"));
  const r = trail(["check", repo, "--base", "main", "--json"], home);
  assert.equal(r.status, 0, r.out + r.err);
  assert.deepEqual(
    findings(r.out)
      .filter((f) => f.source.title)
      .map((f) => [f.verdict, f.source.title, (f as { why?: string }).why]),
    [["lead", "Keep the default retry count at 4", "not on the base branch yet"]],
  );
  const text = trail(["check", repo, "--base", "main"], home);
  assert.equal(text.status, 0);
  assert.match(text.out, /^● client\.go:3$/m);
  assert.match(text.out, /worth a look, can't fail the check: not on the base branch yet/);
  assert.match(text.out, /^· no conflicts · 1 worth a look$/m);
});

test("a learning just for you about the same file is a lead too", () => {
  const { repo, home } = raiseBranch(false);
  const saved = trail(["note", repo, "--personal", "--title", "Keep the default retry count at 4", "--touches", "client.go"], home, "## Decided\n- Keep defaultRetryMax = 4.\n");
  assert.equal(saved.status, 0, saved.err);
  assert.equal(readdirSync(join(repo, ".trail", "learnings")).filter((f) => f.endsWith(".md")).length, 0);
  const r = trail(["check", repo, "--base", "main", "--json"], home);
  assert.equal(r.status, 0, r.out + r.err);
  assert.deepEqual(findings(r.out).map((f) => [f.verdict, (f as { why?: string }).why]), [["lead", "a learning just for you"]]);
});

test("a change no learning bears on passes, and says so without calling repo learnings the team's", () => {
  const { repo, home } = raiseBranch(false);
  const r = trail(["check", repo, "--base", "main"], home);
  assert.equal(r.status, 0, r.out + r.err);
  assert.match(r.out, /^✓ no learning bears on this change$/m);
  assert.doesNotMatch(r.out + trail(["check", "--help"], home).out, /team has learned/);
});
