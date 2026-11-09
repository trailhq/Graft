/**
 * Every-repo personal learnings in `<trail home>/learnings/` (design 1.0,
 * P21, R6): written 0600 with an id from the file name, listed for session
 * start without lessons, retired or replaced ones. Each test has its own
 * TRAIL_HOME.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo } from "./helpers.js";
import { everyRepoDir, everyRepoLearnings, writeEveryRepo, type LearningInput } from "../src/notes/every-repo.js";
import { guardrailLearning } from "../src/notes/guardrails.js";
import { newLearningId } from "../src/notes/learning-fields.js";

function home(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tmpRepo("every");
  return { dir, env: { HOME: join(dir, "home"), TRAIL_HOME: join(dir, "trail") } };
}
const PREF: LearningInput = { title: "Use pnpm, not npm", body: "Use pnpm, not npm.", author: "", date: "2026-10-17", kind: "preference", src: "init-typed", evidence: "said on 12 days, Jul 3 to Oct 14" };

test("everyRepoDir follows TRAIL_HOME", () => {
  const h = home();
  assert.equal(everyRepoDir(h.env), join(h.dir, "trail", "learnings"));
});

test("writeEveryRepo: the guardrail at its fixed name, id from the name, every repo, 0600 in 0700", () => {
  const h = home();
  const path = writeEveryRepo(guardrailLearning("timeout-missing", "every repo", "on 6 days", new Date(2026, 9, 17)), "no-timeout.md", h.env);
  assert.equal(path, join(h.dir, "trail", "learnings", "no-timeout.md"));
  const text = readFileSync(path, "utf8");
  assert.match(text, new RegExp(`^id: ${newLearningId("no-timeout.md")}$`, "m"));
  assert.match(text, /^scope: personal$/m);
  assert.match(text, /^applies: "?every repo"?$/m);
  assert.match(text, /^check: no-timeout$/m);
  assert.match(text, /^enforce: sure-fail$/m);
  assert.match(text, /^status: active$/m);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  if (process.platform !== "win32") assert.equal(statSync(everyRepoDir(h.env)).mode & 0o777, 0o700);
  assert.ok(!existsSync(join(h.dir, "home")), "nothing under HOME");
});

test("writeEveryRepo: applies is always every repo; a file name with a path is refused", () => {
  const h = home();
  const p = writeEveryRepo({ ...PREF, applies: "github.com/acme/shop" }, "use-pnpm.md", h.env);
  assert.match(readFileSync(p, "utf8"), /^applies: "?every repo"?$/m);
  for (const bad of ["../x.md", "a/b.md", ".hidden.md", "x.txt", "", "x\n.md"]) {
    assert.throws(() => writeEveryRepo(PREF, bad, h.env), /file name/, bad);
  }
});

test("everyRepoLearnings: active ones only, never a lesson, retired, held or replaced", () => {
  const h = home();
  writeEveryRepo(PREF, "use-pnpm.md", h.env);
  writeEveryRepo(guardrailLearning("timeout-missing", "every repo", "on 6 days", new Date(2026, 9, 17)), "no-timeout.md", h.env);
  writeEveryRepo({ ...PREF, title: "Colima first", body: "colima start, then DOCKER_HOST set", kind: "lesson", src: "repair", wall: "docker-rootless" }, "colima-first.md", h.env);
  const dir = everyRepoDir(h.env);
  writeFileSync(join(dir, "old.md"), "---\ntitle: Old one\nauthor: \"\"\ndate: 2026-07-01\nstatus: retired\n---\nold\n");
  writeFileSync(join(dir, "held.md"), "---\ntitle: Held one\nauthor: \"\"\ndate: 2026-07-01\nstatus: held\n---\nheld\n");
  const replaced = newLearningId("use-pnpm.md");
  writeFileSync(join(dir, "use-bun.md"), `---\ntitle: Use bun\nauthor: ""\ndate: 2026-10-18\nreplaces: ${replaced}\n---\nUse bun.\n`);
  writeFileSync(join(dir, "broken.md"), "---\ntitle: [unclosed\n---\n");
  writeFileSync(join(dir, "readme.txt"), "not a learning");
  const names = everyRepoLearnings(h.env).map((n) => n.title).sort();
  assert.deepEqual(names, ["No timeout on this Mac", "Use bun"]);
  for (const n of everyRepoLearnings(h.env)) {
    assert.equal(n.scope, "personal");
    assert.equal(n.applies, "every repo");
  }
});

test("everyRepoLearnings: a file that says it is for one repo, or a link, is left out", () => {
  const h = home();
  writeEveryRepo(PREF, "use-pnpm.md", h.env);
  const dir = everyRepoDir(h.env);
  writeFileSync(join(dir, "one-repo.md"), "---\ntitle: Only shop\nauthor: \"\"\ndate: 2026-10-01\napplies: github.com/acme/shop\n---\nx\n");
  const outside = join(h.dir, "outside.md");
  writeFileSync(outside, "---\ntitle: Linked in\nauthor: \"\"\ndate: 2026-10-01\n---\nx\n");
  symlinkSync(outside, join(dir, "linked.md"));
  assert.deepEqual(everyRepoLearnings(h.env).map((n) => n.title), ["Use pnpm, not npm"]);
});

test("no folder: nothing, and nothing made", () => {
  const h = home();
  assert.deepEqual(everyRepoLearnings(h.env), []);
  assert.ok(!existsSync(everyRepoDir(h.env)));
  mkdirSync(join(h.dir, "trail"), { recursive: true });
  assert.deepEqual(readdirSync(join(h.dir, "trail")), []);
});
