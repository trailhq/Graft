/**
 * `trail note --replaces`: a newer learning that supersedes an older one, by
 * #663's design (D184): the old one named by its file name or its id, the old
 * file left as it was written, and from then on only the newer one comes up in
 * `ask` and the prompt hook. Every saved learning also says its id.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learningId, newLearningId } from "../src/notes/learning-fields.js";
import { parseNote } from "../src/notes/notes.js";
import { homeEnv, tmpRepo } from "./helpers.js";
import { escapeRe } from "./escape.js";

const OLD_NAME = "2026-10-08-keep-the-default-retry-count-at-maya.md";
const OLD = `---\ntitle: "Keep the default retry count at 4"\nauthor: Maya\ndate: 2026-10-08\ntouches:\n  - client.go\n---\n\n## Decided\n- Keep defaultRetryMax = 4: ten retries can hold one call for an hour.\n`;
const NEW_BODY = "## Decided\n- Raise defaultRetryMax to 6: bulk imports time out at 4.\n";

function run(args: string[], home: string, input?: string) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...homeEnv(home), DO_NOT_TRACK: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined, TRAIL_HOME: undefined },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

/** A repo with Maya's "keep 4" learning, written before learnings had ids. */
function repoWithOldLearning(): { repo: string; home: string } {
  const repo = tmpRepo("note-replaces");
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "Kumar S"], { cwd: repo });
  writeFileSync(join(repo, "client.go"), "package retry\n\nconst defaultRetryMax = 4\n");
  // #663's gate: a learning names a file git tracks.
  spawnSync("git", ["add", "client.go"], { cwd: repo });
  spawnSync("git", ["-c", "user.email=k@example.com", "commit", "-qm", "client"], { cwd: repo });
  mkdirSync(join(repo, ".trail", "learnings"), { recursive: true });
  writeFileSync(join(repo, ".trail", "learnings", OLD_NAME), OLD);
  return { repo, home: mkdtempSync(join(tmpdir(), "note-replaces-home-")) };
}

const learningFiles = (repo: string) => readdirSync(join(repo, ".trail", "learnings")).filter((f) => f.endsWith(".md"));

test("a learning saved with --replaces names the old one, says its own id and what it takes over from, and is the only one ask brings back", () => {
  const { repo, home } = repoWithOldLearning();
  const oldId = learningId(OLD_NAME);
  const saved = run(["note", repo, "--title", "Retry count raised to 6", "--touches", "client.go", "--replaces", oldId], home, NEW_BODY);
  assert.equal(saved.status, 0, saved.err);
  const [file] = learningFiles(repo).filter((f) => f !== OLD_NAME);
  const written = parseNote(readFileSync(join(repo, ".trail", "learnings", file!), "utf8"), file!)!;
  assert.equal(written.replaces, oldId);
  assert.equal(written.src, "agent", "trail note is how an agent saves");
  assert.match(saved.out, new RegExp(`^· id ${written.id}$`, "m"));
  assert.match(saved.out, new RegExp(`^· takes over from ${escapeRe(OLD_NAME)}, which stays as the record$`, "m"));
  assert.equal(readFileSync(join(repo, ".trail", "learnings", OLD_NAME), "utf8"), OLD, "the old learning is left as written");

  const ask = run(["ask", "default retry count", repo, "--json"], home);
  assert.equal(ask.status, 0, ask.err);
  assert.deepEqual(
    (JSON.parse(ask.out).notes ?? []).map((h: { note: { title: string } }) => h.note.title),
    ["Retry count raised to 6"],
  );
});

test("every saved learning says its id, so a later one can replace it", () => {
  const { repo, home } = repoWithOldLearning();
  const saved = run(["note", repo, "--title", "Jitter on every retry", "--touches", "client.go"], home, NEW_BODY);
  assert.equal(saved.status, 0, saved.err);
  const [file] = learningFiles(repo).filter((f) => f !== OLD_NAME);
  assert.match(saved.out, new RegExp(`^· id ${newLearningId(file!)}$`, "m"));
  assert.match(newLearningId(file!), /^l-[0-9a-f]{8}$/);
  assert.match(readFileSync(join(repo, ".trail", "learnings", file!), "utf8"), new RegExp(`^id: ${newLearningId(file!)}$`, "m"));
});

test("--replaces takes the old learning's file name too", () => {
  const { repo, home } = repoWithOldLearning();
  const saved = run(["note", repo, "--title", "Retry count raised to 6", "--touches", "client.go", "--replaces", `.trail/learnings/${OLD_NAME}`], home, NEW_BODY);
  assert.equal(saved.status, 0, saved.err);
  const [file] = learningFiles(repo).filter((f) => f !== OLD_NAME);
  assert.match(readFileSync(join(repo, ".trail", "learnings", file!), "utf8"), new RegExp(`^replaces: ${learningId(OLD_NAME)}$`, "m"));
});

test("an id no learning here has is refused, and nothing is saved", () => {
  const { repo, home } = repoWithOldLearning();
  const r = run(["note", repo, "--title", "Retry count raised to 6", "--touches", "client.go", "--replaces", "l-ffffff"], home, NEW_BODY);
  assert.equal(r.status, 1);
  assert.match(r.err, /--replaces: no learning named l-ffffff here/);
  assert.deepEqual(learningFiles(repo), [OLD_NAME]);
});
