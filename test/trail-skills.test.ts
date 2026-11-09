/**
 * Skills: corrections become takeaways, kept on this machine in ~/.trail, and
 * takeaways fold into a SKILL.md: the repo's own skill in `.claude/skills/`,
 * or one kept in ~/.trail until someone publishes it into the repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  confirm,
  fold,
  getSkill,
  isConfirmed,
  learn,
  listSkills,
  parseTakeaway,
  publish,
  renderTakeaway,
  skillDirs,
  skillForAgent,
  skillsDirective,
  skillStatus,
} from "../src/skills/skills.js";
import { homeEnv, tmpRepo } from "./helpers.js";

process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), "skills-trail-home-"));

const DAY = "2026-10-07";
const ROTATION = "Read rotation with page.Rotation() from internal/pdf/page.go.\nNever pdfcpu: it drops /Rotate on linearized files.";

/** A repo with a hand-written team skill, extra frontmatter and all. */
function repoWithTeamSkill(tag: string): string {
  const repo = tmpRepo(tag);
  mkdirSync(join(repo, ".claude", "skills", "deploys"), { recursive: true });
  writeFileSync(
    join(repo, ".claude", "skills", "deploys", "SKILL.md"),
    "---\nname: deploys\ndescription: How this repo ships\nallowed-tools: Bash(make:*)\n---\n\n# deploys\n\nShip with make ship.\n",
  );
  return repo;
}

test("learn starts a skill in ~/.trail on first use, every takeaway its own file, and the repo untouched", () => {
  const repo = tmpRepo("skills-learn");
  const a = learn(repo, { skill: "PDF coords", text: ROTATION, author: "Sam", date: DAY, description: "Coordinates, boxes and rotation for PDF pages", section: "Rotation" });
  assert.equal(a.created, true);
  assert.equal(a.skill.name, "pdf-coords");
  assert.equal(a.skill.where, "home");
  const home = skillDirs(repo).home;
  assert.ok(home.startsWith(process.env.TRAIL_HOME!), home);
  assert.equal(a.takeaway.path, join(home, "pdf-coords", "takeaways", "2026-10-07-sam-1.md"));
  const b = learn(repo, { skill: "pdf-coords", text: "Boxes are in points, not pixels.", author: "Sam", date: DAY });
  assert.equal(b.created, false);
  assert.equal(b.takeaway.path, join(home, "pdf-coords", "takeaways", "2026-10-07-sam-2.md"));
  const s = getSkill(repo, "pdf-coords")!;
  assert.equal(s.version, 1);
  assert.equal(s.description, "Coordinates, boxes and rotation for PDF pages");
  assert.equal(s.takeaways.length, 2);
  assert.deepEqual(readdirSync(repo), [], "nothing in the repo");
});

test("a takeaway on a skill the repo already has stays on this machine; it folds only into one Trail versioned, keeping its frontmatter", () => {
  const repo = repoWithTeamSkill("skills-team");
  const r = learn(repo, { skill: "deploys", text: "Run the migration check before make ship.", author: "Priya", date: DAY });
  assert.equal(r.created, false);
  assert.equal(r.skill.where, "repo");
  assert.ok(r.takeaway.path.startsWith(skillDirs(repo).home));
  assert.deepEqual(readdirSync(join(repo, ".claude", "skills", "deploys")), ["SKILL.md"], "the takeaway isn't in the repo");
  assert.equal(fold(repo, "deploys")!.left, "hand-written", "written by hand: never rewritten");

  // The same skill after an older Trail folded into it: a top-level version line.
  const file = join(repo, ".claude", "skills", "deploys", "SKILL.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("allowed-tools: Bash(make:*)\n", "allowed-tools: Bash(make:*)\nversion: 1\n"));
  const f = fold(repo, "deploys")!;
  assert.equal(f.where, "repo");
  assert.equal(f.file, join(repo, ".claude", "skills", "deploys", "SKILL.md"));
  const md = readFileSync(f.file, "utf8");
  assert.match(md, /^allowed-tools: Bash\(make:\*\)$/m, "the team's own keys survive");
  assert.match(md, /^metadata:\n  trail: "s-[0-9a-f]{6}"\n  version: "2"$/m);
  assert.match(md, /Ship with make ship\.\n\n## Takeaways\n- Run the migration check before make ship\. \(Priya, Oct 7\)/);
});

test("trail's and graft's own skills never take takeaways", () => {
  const repo = tmpRepo("skills-own");
  mkdirSync(join(repo, ".claude", "skills", "trail"), { recursive: true });
  writeFileSync(join(repo, ".claude", "skills", "trail", "SKILL.md"), "---\nname: trail\n---\nx\n");
  assert.throws(() => learn(repo, { skill: "trail", text: "x", author: "Sam", date: DAY }), /code map's own skill/);
  assert.deepEqual(listSkills(repo), []);
});

test("a takeaway round-trips through its file", () => {
  const t = { skill: "pdf-coords", taughtBy: "Sam", date: DAY, from: "correction", confirmedBy: ["Lena"], section: "Rotation", foldedIn: 4, text: ROTATION };
  assert.deepEqual(parseTakeaway(renderTakeaway(t), "p.md", "pdf-coords"), { ...t, path: "p.md" });
});

test("only someone other than the teacher can confirm", () => {
  const repo = tmpRepo("skills-confirm");
  learn(repo, { skill: "pdf-coords", text: ROTATION, author: "Sam", date: DAY });
  assert.deepEqual(confirm(repo, "pdf-coords", "Sam"), [], "the teacher can't confirm their own");
  assert.equal(confirm(repo, "pdf-coords", "Lena").length, 1);
  assert.equal(confirm(repo, "pdf-coords", "Lena").length, 0, "confirming twice changes nothing");
  assert.ok(isConfirmed(getSkill(repo, "pdf-coords")!.takeaways[0]!));
});

test("fold writes waiting takeaways under their heading, bumps the version, and keeps the files; --confirmed takes only confirmed ones", () => {
  const repo = tmpRepo("skills-fold");
  learn(repo, { skill: "pdf-coords", text: ROTATION, author: "Sam", date: DAY, section: "Rotation" });
  learn(repo, { skill: "pdf-coords", text: "Boxes are in points.", author: "Priya", date: DAY });
  confirm(repo, "pdf-coords", "Lena", "2026-10-07-sam-1");

  const r = fold(repo, "pdf-coords", { confirmed: true })!;
  assert.equal(r.from, 1);
  assert.equal(r.to, 2);
  assert.equal(r.folded.length, 1);
  assert.equal(r.stillWaiting, 1);
  assert.deepEqual(r.sections, ["Rotation"]);
  const file = join(skillDirs(repo).home, "pdf-coords", "SKILL.md");
  assert.equal(r.file, file);
  const md = readFileSync(file, "utf8");
  assert.match(md, /^metadata:\n  trail: "s-[0-9a-f]{6}"\n  version: "2"$/m);
  assert.match(md, /## Rotation\n- Read rotation with page\.Rotation\(\) from internal\/pdf\/page\.go\. Never pdfcpu: it drops \/Rotate on linearized files\. \(Sam, Oct 7\)/);
  assert.ok(existsSync(join(skillDirs(repo).home, "pdf-coords", "takeaways", "2026-10-07-sam-1.md")), "history stays");
  assert.equal(getSkill(repo, "pdf-coords")!.takeaways.find((t) => t.taughtBy === "Sam")?.foldedIn, 2);

  // A plain fold takes the rest, under Takeaways since it named no heading.
  const rest = fold(repo, "pdf-coords")!;
  assert.equal(rest.to, 3);
  assert.deepEqual(rest.sections, ["Takeaways"]);
  assert.match(readFileSync(file, "utf8"), /## Takeaways\n- Boxes are in points\. \(Priya, Oct 7\)/);
  assert.equal(fold(repo, "pdf-coords")!.folded.length, 0, "nothing left");
  assert.equal(fold(repo, "nope"), null);
});

test("publish moves a skill from ~/.trail into the repo's .claude/skills/; its takeaways stay and fold into the repo's copy", () => {
  const repo = tmpRepo("skills-publish");
  learn(repo, { skill: "pdf-coords", text: ROTATION, author: "Sam", date: DAY, description: "PDF coordinates" });
  fold(repo, "pdf-coords");
  const p = publish(repo, "pdf-coords");
  assert.deepEqual(p, { ok: true, file: join(repo, ".claude", "skills", "pdf-coords", "SKILL.md") });
  assert.match(readFileSync(join(repo, ".claude", "skills", "pdf-coords", "SKILL.md"), "utf8"), /^metadata:\n  trail: "s-[0-9a-f]{6}"\n  version: "2"$/m);
  assert.equal(existsSync(join(skillDirs(repo).home, "pdf-coords", "SKILL.md")), false, "one copy, the repo's");
  assert.equal(getSkill(repo, "pdf-coords")!.where, "repo");
  assert.equal(getSkill(repo, "pdf-coords")!.takeaways.length, 1, "the folded takeaway's history stays here");
  assert.deepEqual(publish(repo, "pdf-coords"), { ok: false, reason: "in-repo" });
  assert.deepEqual(publish(repo, "nope"), { ok: false, reason: "unknown" });

  learn(repo, { skill: "pdf-coords", text: "Boxes are in points.", author: "Sam", date: DAY });
  assert.equal(fold(repo, "pdf-coords")!.file, join(repo, ".claude", "skills", "pdf-coords", "SKILL.md"));
});

test("skills says what each one is waiting on, and where it lives", () => {
  const repo = tmpRepo("skills-status");
  learn(repo, { skill: "pdf-coords", text: ROTATION, author: "Sam", date: DAY });
  const s = () => getSkill(repo, "pdf-coords")!;
  assert.equal(skillStatus(s()), "v1 · 1 takeaway waiting to fold · last taught by Sam, Oct 7 · on this machine");
  confirm(repo, "pdf-coords", "Lena");
  assert.equal(skillStatus(s()), "v1 · 1 takeaway waiting to fold (1 confirmed) · last taught by Sam, Oct 7 · on this machine");
  fold(repo, "pdf-coords");
  assert.equal(skillStatus(s()), "v2 · up to date · on this machine");
});

test("what an agent reads: the skill, then the corrections not yet in it, newest first", () => {
  const repo = repoWithTeamSkill("skills-show");
  learn(repo, { skill: "deploys", text: "Older rule.", author: "Sam", date: "2026-10-05" });
  learn(repo, { skill: "deploys", text: "Newer rule.", author: "Priya", date: DAY });
  const text = skillForAgent(getSkill(repo, "deploys")!);
  assert.match(text, /^# deploys \(v1, in this repo\)\n\n# deploys\n\nShip with make ship\.\n\n## Corrections since v1/);
  assert.ok(text.indexOf("Newer rule. (Priya, Oct 7)") < text.indexOf("Older rule. (Sam, Oct 5)"));
});

test("a session hears about skills Claude Code can't load by itself, and nothing when there are none", () => {
  const repo = repoWithTeamSkill("skills-directive");
  assert.equal(skillsDirective(repo), "", "the team's skill with nothing waiting: Claude Code has it");
  learn(repo, { skill: "pdf-coords", text: ROTATION, author: "Sam", date: DAY });
  learn(repo, { skill: "deploys", text: "Run the migration check first.", author: "Sam", date: DAY });
  const line = skillsDirective(repo);
  // The paths are this machine's own, for the agent to read: `\` between folders on Windows.
  assert.match(line, /deploys \(1 correction newer than its SKILL\.md, in \S+[\\/]deploys[\\/]takeaways\)/);
  assert.match(line, /pdf-coords \(on this machine: \S+[\\/]pdf-coords[\\/]SKILL\.md, then 1 correction in \S+[\\/]pdf-coords[\\/]takeaways\)/);
  // `trail skills show` is the learned skills' command now: it can't print these (g7 review).
  assert.doesNotMatch(line, /skills show|run `/);
  assert.match(line, /Read them before working in one's area, the corrections newest first; they win where they disagree/);
});

/** A folder link at `link` to `target` (relative to the link's folder), as `trail skills promote` will write them; a junction on Windows. */
function linkDir(target: string, link: string): void {
  if (process.platform === "win32") symlinkSync(resolve(dirname(link), target), link, "junction");
  else symlinkSync(target, link, "dir");
}

test("skills reached through a .claude/skills link to .agents/skills are listed, read and folded through the link", () => {
  const repo = tmpRepo("skills-linked");
  mkdirSync(join(repo, ".agents", "skills", "ship-docs"), { recursive: true });
  writeFileSync(join(repo, ".agents", "skills", "ship-docs", "SKILL.md"), '---\nname: ship-docs\ndescription: How the docs ship\nmetadata:\n  trail: "s-0a1b2c"\n  version: "1"\n---\n\n# ship-docs\n\nRun make docs.\n');
  mkdirSync(join(repo, ".claude", "skills"), { recursive: true });
  linkDir("../../.agents/skills/ship-docs", join(repo, ".claude", "skills", "ship-docs"));
  // A second name for the same folder is one skill, not two.
  linkDir("../../.agents/skills/ship-docs", join(repo, ".claude", "skills", "ship-docs-again"));
  assert.deepEqual(listSkills(repo).map((s) => [s.name, s.where]), [["ship-docs", "repo"]]);
  learn(repo, { skill: "ship-docs", text: "Check links first.", author: "Priya", date: DAY });
  fold(repo, "ship-docs");
  assert.match(readFileSync(join(repo, ".agents", "skills", "ship-docs", "SKILL.md"), "utf8"), /- Check links first\. \(Priya, Oct 7\)/, "the fold lands in the real file");
});

test("a link loop, a dangling link or a link to a file under .claude/skills is skipped, never followed forever", { skip: process.platform === "win32" && "folder symlinks need privileges on Windows" }, () => {
  const repo = repoWithTeamSkill("skills-loops");
  const skills = join(repo, ".claude", "skills");
  symlinkSync("loop-a", join(skills, "loop-b"));
  symlinkSync("loop-b", join(skills, "loop-a"));
  symlinkSync("self", join(skills, "self"));
  symlinkSync("../nowhere", join(skills, "dangling"));
  writeFileSync(join(repo, "notes.txt"), "x");
  symlinkSync("../../notes.txt", join(skills, "a-file"));
  symlinkSync(".", join(skills, "up"));
  assert.deepEqual(listSkills(repo).map((s) => s.name), ["deploys"]);
});

test("a link out of the repo, or out of ~/.trail, is never followed: nothing is read or written through it", () => {
  const repo = tmpRepo("skills-out");
  const outside = tmpRepo("skills-outside");
  const theirs = join(outside, "deploys");
  mkdirSync(theirs, { recursive: true });
  const text = "---\nname: deploys\ndescription: Someone else's skill\nversion: 1\n---\n\n# deploys\n";
  writeFileSync(join(theirs, "SKILL.md"), text);
  writeFileSync(join(outside, "secret.md"), "---\nname: x\ndescription: y\nversion: 1\n---\n\nnot for the agent\n");
  const skills = join(repo, ".claude", "skills");
  mkdirSync(join(skills, "a-file"), { recursive: true });
  linkDir(theirs, join(skills, "deploys"));
  if (process.platform !== "win32") symlinkSync(join(outside, "secret.md"), join(skills, "a-file", "SKILL.md"));
  assert.deepEqual(listSkills(repo).map((s) => s.name), [], "neither is listed");
  assert.equal(getSkill(repo, "deploys"), null);
  assert.equal(getSkill(repo, "a-file"), null);

  learn(repo, { skill: "deploys", text: "A takeaway.", author: "Sam", date: DAY });
  learn(repo, { skill: "a-file", text: "A takeaway.", author: "Sam", date: DAY });
  fold(repo, "deploys");
  fold(repo, "a-file");
  assert.equal(readFileSync(join(theirs, "SKILL.md"), "utf8"), text, "never written through the link");
  assert.match(readFileSync(join(outside, "secret.md"), "utf8"), /^not for the agent$/m);
  assert.deepEqual(publish(repo, "deploys"), { ok: false, reason: "link" }, "and never published through it");
  assert.equal(readFileSync(join(theirs, "SKILL.md"), "utf8"), text);

  // ~/.trail's own skills folder: a link out of it is skipped the same way.
  const home = skillDirs(repo).home;
  mkdirSync(home, { recursive: true });
  linkDir(theirs, join(home, "elsewhere"));
  assert.deepEqual(listSkills(repo).map((s) => s.name).filter((n) => n === "elsewhere"), []);
});

// --- end to end ---

function run(args: string[], home: string, input?: string) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...homeEnv(home), DO_NOT_TRACK: "1", CLAUDECODE: undefined, TRAIL_INVOKED_AS: undefined, TRAIL_HOME: undefined },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

test("trail learn is gone: it's not a command, and nothing points at it", () => {
  const home = mkdtempSync(join(tmpdir(), "skills-home-"));
  const d = tmpRepo("skills-no-learn");
  spawnSync("git", ["init", "-q"], { cwd: d });
  const learnt = run(["learn", "pdf-coords", d, "--author", "Sam"], home, ROTATION);
  assert.notEqual(learnt.status, 0);
  assert.match(learnt.err, /unknown command 'learn'/);
  assert.equal(existsSync(join(home, ".trail", "repos")), false, "nothing saved");
  const none = run(["skills"], home);
  assert.equal(none.status, 0, none.err);
  assert.doesNotMatch(none.out, /learn/);
  assert.doesNotMatch(run(["--help"], home).out, /\blearn\b/);
});
