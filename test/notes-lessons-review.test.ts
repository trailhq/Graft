/**
 * Review: a learning of kind `lesson` never loads as text (R47) wherever
 * learnings load (session start's count, recall, standing, `trail check`),
 * because the one rule they all share leaves it out; and the every-repo
 * folder skips a file too big to be a learning. Synthetic repos and homes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { liveLearnings, liveLessons } from "../src/notes/learning-fields.js";
import { noteCount } from "../src/notes/home.js";
import { everyRepoDir, everyRepoLearnings, writeEveryRepo } from "../src/notes/every-repo.js";

const n = (id: string, extra: Record<string, unknown> = {}) => ({ id, date: "2026-10-10", path: `${id}.md`, scope: "personal" as const, ...extra });

test("liveLearnings leaves out lessons; liveLessons gives the live ones only (not retired, not replaced)", () => {
  const notes = [
    n("l-00000001", { kind: "preference" }),
    n("l-00000002", { kind: "lesson", wall: "docker-rootless" }),
    n("l-00000003", { kind: "lesson", status: "retired" }),
    n("l-00000004", { kind: "lesson" }),
    n("l-00000005", { kind: "lesson", replaces: "l-00000004", date: "2026-10-11" }),
    n("l-00000006"),
  ];
  assert.deepEqual(liveLearnings(notes).map((x) => x.id), ["l-00000001", "l-00000006"]);
  assert.deepEqual(liveLessons(notes).map((x) => x.id), ["l-00000002", "l-00000005"]);
});

test("a lesson in a repo's learnings is not counted at session start", () => {
  const d = tmpRepo("lesson-count");
  const r = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: d, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const env = { ...process.env, TRAIL_HOME: join(d, ".home-trail"), HOME: join(d, ".home") };
  const dir = join(d, ".trail", "learnings");
  mkdirSync(dir, { recursive: true });
  const file = (name: string, extra = "") => writeFileSync(join(dir, name), `---\ntitle: "${name}"\nauthor: Priya\ndate: 2026-10-08\n${extra}---\n\nRun it with DOCKER_HOST set.\n`);
  file("2026-10-08-pref.md", "kind: preference\n");
  file("2026-10-08-lesson.md", 'kind: lesson\nwall: "docker-rootless"\n');
  assert.equal(noteCount(d, env), 1);
});

test("everyRepoLearnings skips a file over 64 KB rather than read it at every session start", () => {
  const dir = tmpRepo("every-rv");
  const env = { HOME: join(dir, "home"), TRAIL_HOME: join(dir, "trail") };
  writeEveryRepo({ title: "Small", body: "Small.", author: "", date: "2026-10-08" }, "small.md", env);
  writeFileSync(join(everyRepoDir(env), "big.md"), `---\ntitle: "Big"\nauthor: ""\ndate: 2026-10-08\n---\n\n${"x".repeat(70 * 1024)}\n`);
  assert.deepEqual(everyRepoLearnings(env).map((x) => x.title), ["Small"]);
});
