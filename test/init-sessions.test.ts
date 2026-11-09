/**
 * Which past Claude Code sessions are a repo's: its own folders, its git
 * worktrees, other clones of the same remote, and sessions started in a
 * folder above it that spent 30% or more of their tool calls in it (only that
 * stretch counts). Counted in session-days, not files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverSessions, readSession, within } from "../src/init/sessions.js";
import { tmpRepo } from "./helpers.js";

// Days are local dates (init-days.test.ts); these fixtures are written in UTC.
process.env.TZ = "UTC";
/** A Trail home of the world's own: discovery reads repo keys and aliases there, never the real ~/.trail. */
const envOf = (w: { root: string; home: string }) => ({ HOME: w.home, TRAIL_HOME: join(w.root, "trail-home") });

const git = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

/** A git checkout at `dir` whose origin is `remote`. */
function checkout(dir: string, remote?: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  if (remote) git(dir, "remote", "add", "origin", remote);
  return dir;
}

let n = 0;
const day = (d: number, h = 10) => `2026-09-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00Z`;
const typed = (cwd: string, at: string, content: string) => ({ type: "user", cwd, timestamp: at, message: { role: "user", content } });
const said = (cwd: string, at: string, text: string) => ({ type: "assistant", cwd, timestamp: at, message: { content: [{ type: "text", text }] } });
function call(cwd: string, at: string, name: string, input: object) {
  const id = `tu_${++n}`;
  return [
    { type: "assistant", cwd, timestamp: at, message: { content: [{ type: "tool_use", id, name, input }] } },
    { type: "user", cwd, timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } },
  ];
}

/** A session file in `~/.claude/projects/<folder>/<id>.jsonl`; the folder name is whatever Claude Code chose. */
function session(home: string, folder: string, id: string, entries: object[]): void {
  const dir = join(home, ".claude", "projects", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), entries.flat().map((e) => JSON.stringify(e)).join("\n") + "\n");
}
const folderOf = (p: string) => p.replace(/[^A-Za-z0-9]/g, "-");

function world() {
  const root = tmpRepo("discover");
  const home = join(root, "home");
  const parent = join(root, "work");
  const repo = checkout(join(parent, "api"), "git@github.com:acme/api.git");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "-c", "user.name=T", "-c", "user.email=t@x.test", "commit", "-qm", "one");
  const wt = join(parent, "api-wt");
  git(repo, "worktree", "add", "-q", wt);
  const clone = checkout(join(root, "elsewhere", "api-copy"), "https://github.com/Acme/api");
  const other = checkout(join(parent, "web"), "git@github.com:acme/web.git");
  const sibling = join(parent, "api-old");
  mkdirSync(sibling, { recursive: true });
  return { root, home, parent, repo, wt, clone, other, sibling };
}

test("a repo's sessions: its own, its worktrees', other clones of its remote; not a sibling's or another repo's", () => {
  const w = world();
  session(w.home, folderOf(w.repo), "own-1", [typed(w.repo, day(1), "run the tests before you push")]);
  const inner = join(w.repo, ".claude", "worktrees", "x");
  session(w.home, folderOf(inner), "own-2", [typed(inner, day(2), "use pnpm here")]);
  session(w.home, folderOf(w.wt), "wt-1", [typed(w.wt, day(3), "keep the PR small")]);
  session(w.home, folderOf(w.clone), "clone-1", [typed(join(w.clone, "src"), day(4), "open the PR against dev")]);
  session(w.home, folderOf(w.sibling), "sib-1", [typed(w.sibling, day(5), "not this repo")]);
  session(w.home, folderOf(w.other), "web-1", [typed(w.other, day(6), "another repo")]);
  // Claude Code has kept a space in folder names too: the file's own cwd decides, not the folder's name.
  session(w.home, `${w.repo.replace(/[\\/:]/g, "-")} copy`, "own-3", [typed(w.repo, day(7), "explain it simply")]);

  const d = discoverSessions(w.repo, w.home, undefined, envOf(w));
  const ids = d.sessions.map((s) => s.id).sort();
  assert.deepEqual(ids, ["clone-1", "own-1", "own-2", "own-3", "wt-1"]);
  assert.deepEqual(d.bySource, { own: 3, worktree: 1, clone: 1, ancestor: 0 });
  assert.equal(d.sessions.find((s) => s.id === "clone-1")!.source, "clone");
});

test("a session started in a folder above the repo counts when 30% of its tool calls touch the repo, and only that stretch", () => {
  const w = world();
  const p = w.parent;
  session(w.home, folderOf(p), "anc-1", [
    typed(p, day(8, 9), "what is in this folder"),
    call(p, day(8, 9), "Bash", { command: "ls" }),
    typed(p, day(8, 10), "go into api and always run the linter first"),
    said(p, day(8, 10), "I'll look at the api repo."),
    call(p, day(8, 10), "Bash", { command: `cd "${w.repo}" && npm run lint` }),
    call(w.repo, day(8, 10), "Read", { file_path: join(w.repo, "src", "a.ts") }),
    typed(w.repo, day(9, 10), "always run the linter first, again"),
    call(w.repo, day(9, 10), "Edit", { file_path: join(w.repo, "src", "a.ts") }),
    // A worktree of the repo is the repo too.
    call(p, day(9, 11), "Read", { file_path: join(w.wt, "a.txt") }),
    typed(p, day(9, 12), "now look at web"),
    call(p, day(9, 12), "Read", { file_path: join(w.other, "index.ts") }),
  ]);
  // Mostly elsewhere: 1 of 5 tool calls in the repo.
  session(w.home, folderOf(p), "anc-2", [
    typed(p, day(10), "tidy the web repo"),
    call(p, day(10), "Bash", { command: `ls "${w.other}"` }),
    call(p, day(10), "Read", { file_path: join(w.other, "a.ts") }),
    call(p, day(10), "Read", { file_path: join(w.other, "b.ts") }),
    call(p, day(10), "Read", { file_path: join(w.other, "c.ts") }),
    call(p, day(10), "Read", { file_path: join(w.repo, "a.txt") }),
  ]);
  const d = discoverSessions(w.repo, w.home, undefined, envOf(w));
  assert.deepEqual(d.sessions.map((s) => s.id), ["anc-1"]);
  assert.equal(d.bySource.ancestor, 1);
  assert.equal(d.skippedAncestor, 1, "the session mostly about another repo is left out, and counted");
  const s = d.sessions[0]!;
  assert.equal(s.source, "ancestor");
  // The ask that led into the repo, and what was typed while there; not before, not after.
  assert.deepEqual(s.prompts.map((x) => x.text), ["go into api and always run the linter first", "always run the linter first, again"]);
  assert.equal(s.at, day(8, 10));
});

test("counts are session-days: a session typed into on two days is two, two restarts on one day are two sessions on one day", () => {
  const w = world();
  session(w.home, folderOf(w.repo), "long", [typed(w.repo, day(1), "first"), typed(w.repo, day(1, 15), "same day"), typed(w.repo, day(3), "two days later")]);
  session(w.home, folderOf(w.repo), "r1", [typed(w.repo, day(5, 9), "restart")]);
  session(w.home, folderOf(w.repo), "r2", [typed(w.repo, day(5, 9), "restart")]);
  const d = discoverSessions(w.repo, w.home, undefined, envOf(w));
  assert.equal(d.sessions.length, 3);
  assert.equal(d.sessionDays, 4);
  assert.equal(d.days, 3);
  assert.equal(d.from, "2026-09-01");
  assert.equal(d.to, "2026-09-05");
});

test("a headless run, a session with nothing typed, and a missing projects folder are no sessions", () => {
  const w = world();
  session(w.home, folderOf(w.repo), "sdk", [{ ...typed(w.repo, day(1), "summarise"), entrypoint: "sdk-cli" }]);
  session(w.home, folderOf(w.repo), "empty", [said(w.repo, day(1), "hello")]);
  assert.deepEqual(discoverSessions(w.repo, w.home, undefined, envOf(w)).sessions, []);
  assert.deepEqual(discoverSessions(w.repo, join(w.root, "no-home"), undefined, envOf(w)).sessions, []);
});

test("each typed message keeps its own time, so a quote can be placed on its day", () => {
  const w = world();
  session(w.home, folderOf(w.repo), "t", [typed(w.repo, day(1), "one"), typed(w.repo, day(2), "two")]);
  const s = readSession(join(w.home, ".claude", "projects", folderOf(w.repo), "t.jsonl"))!;
  assert.deepEqual(s.prompts.map((p) => p.at), [day(1), day(2)]);
});

test("discovery off the main thread finds exactly what it finds on it", async () => {
  const { discoverOffThread } = await import("../src/init/discover-worker.js");
  const w = world();
  session(w.home, folderOf(w.repo), "own-1", [typed(w.repo, day(1), "run the tests before you push")]);
  session(w.home, folderOf(w.parent), "anc-1", [typed(w.parent, day(2), "go into api"), call(w.parent, day(2), "Read", { file_path: join(w.repo, "a.txt") })]);
  const off = await discoverOffThread(w.repo, w.home, envOf(w));
  assert.deepEqual(off, discoverSessions(w.repo, w.home, undefined, envOf(w)));
  assert.equal(off.sessions.length, 2);
});

test("on Windows a worktree git lists as C:/a/wt holds a session whose cwd says C:\\A\\wt\\src", () => {
  const was = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    assert.ok(within("C:\\A\\wt\\src", ["C:/a/wt"]));
    assert.ok(within("C:\\a\\wt", ["C:/a/wt"]));
    assert.ok(!within("C:\\a\\wt-old", ["C:/a/wt"]), "a sibling with a longer name is not inside");
  } finally {
    Object.defineProperty(process, "platform", was);
  }
});
