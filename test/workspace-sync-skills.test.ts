/**
 * The repo's committed skills go up to the workspace with its learnings, so
 * the team page can show them. Only the working tree's `.claude/skills/`:
 * never a skill kept on this machine, never one that points outside the repo,
 * and only one git tracks: not an untracked or gitignored one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND_ENV } from "../src/brand.js";
import { learningsPayload } from "../src/cloud/workspace-sync.js";
import { writeNote } from "../src/notes/notes.js";
import { skillDirs } from "../src/skills/skills.js";

process.env.DO_NOT_TRACK = "1";
process.env[BRAND_ENV] = "trail";
process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "skills-sync-home-"));

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

const HOTFIX = `---
name: release-hotfix
description: Cut a hotfix release from a tagged commit
author: Anirudh
---

# Release a hotfix

1. Branch from the tag.
2. Cherry-pick the fix.
`;

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });

/** A git checkout with a commit, so HEAD reads. Skills go up only once git tracks them: call `track` after writing the ones expected to. */
function checkout(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "skills-sync-repo-")));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "start");
  return dir;
}

function track(dir: string): void {
  git(dir, "add", "-A", "-f");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "track");
}

function writeSkill(root: string, name: string, text: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), text);
}

const skillItems = (dir: string) => (learningsPayload(dir) ?? []).filter((l) => l.kind === "skill");

test("the repo's skill goes up as a skill learning, and a skill kept on this machine does not", () => {
  const dir = checkout();
  const dirs = skillDirs(dir);
  writeSkill(dirs.repo, "release-hotfix", HOTFIX);
  writeSkill(dirs.home, "my-private-habit", "---\ndescription: Only mine\n---\n\nSecret steps.\n");
  track(dir);

  const items = skillItems(dir);
  assert.equal(items.length, 1);
  const s = items[0]!;
  assert.equal(s.path, ".claude/skills/release-hotfix/SKILL.md");
  assert.equal(s.kind, "skill");
  // SKILL.md's name titles it; its description is what it does and when.
  assert.equal(s.title, "Release hotfix");
  assert.equal(s.why, "Cut a hotfix release from a tagged commit");
  assert.equal(s.body, "# Release a hotfix\n\n1. Branch from the tag.\n2. Cherry-pick the fix.");
  assert.deepEqual(s.files, []);
  assert.equal(s.hash, sha(JSON.stringify(["folder", HOTFIX, []])));
  assert.equal(s.author, "Anirudh");
  assert.equal(s.ref, "");
  assert.deepEqual(s.touches, []);
  assert.ok(!(learningsPayload(dir) ?? []).some((l) => l.path.includes("my-private-habit")));
});

test("a skill without a description is titled by its folder, and plain learnings carry no kind", () => {
  const dir = checkout();
  writeSkill(skillDirs(dir).repo, "pdf-coords", "---\nname: pdf-coords\n---\n\nUse points, not pixels.\n");
  writeNote(dir, { title: "Keep payment retries at 4", body: "## Decided\nFour retries.", author: "Sam", date: "2026-10-07", touches: [] });
  track(dir);
  const [s] = skillItems(dir);
  assert.equal(s!.title, "Pdf coords");
  assert.equal(s!.why, "");
  assert.equal(s!.author, "");
  const learning = (learningsPayload(dir) ?? []).filter((l) => l.path.startsWith(".trail/learnings/"));
  assert.equal(learning.length, 1, "the fixture's learning is in the payload");
  assert.equal(learning[0]!.kind, undefined);
});

test("editing a skill changes its hash in the payload", () => {
  const dir = checkout();
  const repo = skillDirs(dir).repo;
  writeSkill(repo, "release-hotfix", HOTFIX);
  track(dir);
  const before = skillItems(dir)[0]!;
  writeSkill(repo, "release-hotfix", HOTFIX + "3. Tag the release.\n");
  const after = skillItems(dir)[0]!;
  assert.notEqual(before.hash, after.hash);
  assert.match(after.body, /Tag the release/);
});

test("a SKILL.md that can't be parsed is skipped, and the others still go up", () => {
  const dir = checkout();
  const repo = skillDirs(dir).repo;
  writeSkill(repo, "broken", "---\ndescription: [unclosed\n  - : :\n---\n\nbody\n");
  writeSkill(repo, "release-hotfix", HOTFIX);
  track(dir);
  const items = skillItems(dir);
  assert.deepEqual(items.map((i) => i.path), [".claude/skills/release-hotfix/SKILL.md"]);
});

test("a skill folder that points outside the repo is skipped, one that points inside is kept", () => {
  const dir = checkout();
  const outside = mkdtempSync(join(tmpdir(), "skills-sync-outside-"));
  writeSkill(outside, "stolen", "---\ndescription: Not in this repo\n---\n\nOutside text.\n");
  const repo = skillDirs(dir).repo;
  mkdirSync(repo, { recursive: true });
  symlinkSync(join(outside, "stolen"), join(repo, "stolen"), "dir");
  mkdirSync(join(repo, "viafile"), { recursive: true });
  symlinkSync(join(outside, "stolen", "SKILL.md"), join(repo, "viafile", "SKILL.md"));
  writeSkill(join(dir, ".agents", "skills"), "shared", "---\ndescription: Shared across agents\n---\n\nSteps.\n");
  symlinkSync(join(dir, ".agents", "skills", "shared"), join(repo, "shared"), "dir");
  track(dir);

  assert.deepEqual(skillItems(dir).map((i) => i.path), [".claude/skills/shared/SKILL.md"]);
});

test("an untracked skill is not uploaded, and a tracked one is", () => {
  const dir = checkout();
  const repo = skillDirs(dir).repo;
  writeSkill(repo, "release-hotfix", HOTFIX);
  track(dir);
  writeSkill(repo, "scratch-idea", "---\ndescription: Not committed\n---\n\nHalf-baked.\n");
  assert.deepEqual(skillItems(dir).map((i) => i.path), [".claude/skills/release-hotfix/SKILL.md"]);
  track(dir);
  assert.deepEqual(skillItems(dir).map((i) => i.path), [".claude/skills/release-hotfix/SKILL.md", ".claude/skills/scratch-idea/SKILL.md"]);
});

test("a gitignored skill is not uploaded, unless it was force-added", () => {
  const dir = checkout();
  const repo = skillDirs(dir).repo;
  writeFileSync(join(dir, ".gitignore"), ".claude/skills/ignored/\n.claude/skills/forced/\n");
  writeSkill(repo, "release-hotfix", HOTFIX);
  writeSkill(repo, "ignored", "---\ndescription: Ignored\n---\n\nKept out of git.\n");
  writeSkill(repo, "forced", "---\ndescription: Forced in\n---\n\nTracked anyway.\n");
  git(dir, "add", ".gitignore", ".claude/skills/release-hotfix");
  git(dir, "add", "-f", ".claude/skills/forced");
  assert.deepEqual(skillItems(dir).map((i) => i.path), [".claude/skills/forced/SKILL.md", ".claude/skills/release-hotfix/SKILL.md"]);
});

test("a checkout that isn't a git repo uploads no skills, and doesn't throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "skills-sync-nogit-"));
  writeSkill(skillDirs(dir).repo, "release-hotfix", HOTFIX);
  assert.deepEqual(skillItems(dir), []);
});

test("a SKILL.md over 256 KB is skipped", () => {
  const dir = checkout();
  const repo = skillDirs(dir).repo;
  writeSkill(repo, "release-hotfix", HOTFIX);
  writeSkill(repo, "huge", `---\ndescription: Too big\n---\n\n${"x".repeat(256 * 1024 + 1)}\n`);
  track(dir);
  assert.deepEqual(skillItems(dir).map((i) => i.path), [".claude/skills/release-hotfix/SKILL.md"]);
});

test("a skill goes up with its folder: what git tracks, text as text, the rest as base64", () => {
  const dir = checkout();
  const root = join(skillDirs(dir).repo, "fill-forms");
  writeSkill(skillDirs(dir).repo, "fill-forms", "---\nname: fill-forms\ndescription: Fill PDF forms\n---\n\n1. Read references/forms.md\n2. Run scripts/fill.py\n");
  mkdirSync(join(root, "references"), { recursive: true });
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "assets"));
  mkdirSync(join(root, "node_modules", "x"), { recursive: true });
  writeFileSync(join(root, "references", "forms.md"), "# Forms\nUse field names.\n");
  writeFileSync(join(root, "scripts", "fill.py"), "print('ok')\n", { mode: 0o755 });
  writeFileSync(join(root, "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  writeFileSync(join(root, "node_modules", "x", "index.js"), "junk");
  track(dir);
  // Written after the commit: untracked, so it stays here.
  writeFileSync(join(root, "references", "draft.md"), "not yet");
  // A link out of the repo is never followed.
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "skills-outside-")));
  writeFileSync(join(outside, "secret.md"), "elsewhere");
  symlinkSync(join(outside, "secret.md"), join(root, "references", "linked.md"));
  git(dir, "add", "-f", ".");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", "link");
  writeFileSync(join(root, "references", "draft.md"), "not yet");
  git(dir, "rm", "-q", "--cached", ".claude/skills/fill-forms/references/draft.md");

  const s = skillItems(dir)[0]!;
  const files = Object.fromEntries((s.files ?? []).map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(files).sort(), ["assets/logo.png", "references/forms.md", "scripts/fill.py"]);
  assert.equal(files["references/forms.md"]!.content, "# Forms\nUse field names.\n");
  assert.equal(files["references/forms.md"]!.encoding, undefined);
  // Windows has no executable bit to keep.
  if (process.platform !== "win32") assert.equal(files["scripts/fill.py"]!.executable, true);
  assert.equal(files["assets/logo.png"]!.encoding, "base64");
  assert.deepEqual([...Buffer.from(files["assets/logo.png"]!.content, "base64")], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);

  // Any file changing sends the skill again.
  const before = s.hash;
  writeFileSync(join(root, "references", "forms.md"), "# Forms\nUse field ids.\n");
  assert.notEqual(skillItems(dir)[0]!.hash, before);
});

test("a secret in one of a skill's files keeps the whole skill on this machine", () => {
  const dir = checkout();
  const root = join(skillDirs(dir).repo, "deploy");
  writeSkill(skillDirs(dir).repo, "deploy", "---\nname: deploy\ndescription: Deploy\n---\n\n1. Run scripts/go.sh\n");
  mkdirSync(join(root, "scripts"));
  // Built in pieces so the test file itself holds no token.
  writeFileSync(join(root, "scripts", "go.sh"), 'TOKEN="' + "EA" + "Ab1C2d3E4f5G6h7I8j9K0l1M2n3O4p5Q6rS7t8U9v0" + '"\n');
  track(dir);
  assert.equal(skillItems(dir).length, 0);
});
