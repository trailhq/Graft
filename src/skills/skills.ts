/**
 * Skills: how-tos an agent follows, and the corrections that improve them.
 *
 * A correction is a takeaway, one file each, kept on this machine in
 * `~/.trail/repos/<repo>/skills/<name>/takeaways/`. It's live the moment it's
 * saved: the agent reads a skill's waiting takeaways along with its SKILL.md.
 * `trail skills fold` writes them into SKILL.md and bumps its version, so the
 * skill stays one readable page instead of a pile of corrections.
 *
 * The SKILL.md lives in one of two places. A skill the repo already has, in
 * `.claude/skills/<name>/`, is the repo's: takeaways attach to it, and fold
 * into it only when it is Trail's (skill-file.ts), never into one someone
 * wrote by hand; the diff goes through review like any change. A skill started
 * by `learn()` lives next to its takeaways in `~/.trail` until someone
 * chooses to share it: `trail skills publish` moves it into the repo's
 * `.claude/skills/`, where Claude Code loads it for everyone who pulls.
 * (No command calls `learn()` any more: the hidden `trail learn` is gone.)
 *
 * Takeaways are never deleted: a folded one keeps its file, with `folded_in`
 * saying which version took it, so why a rule exists stays findable.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { matter, type FrontMatterFile } from "../util/front-matter.js";
import { shortDate, slug } from "../notes/notes.js";
import { ensureRepoHome, repoPlace, trailHome } from "../notes/home.js";
import { versionOf } from "./front-version.js";
import { nearestThere, rewriteSkill, skillMark, trailOwned, within } from "./skill-file.js";

/** Trail's and graft's own skills, rewritten by every `init`: never a place for takeaways. */
export const OWN_SKILLS = new Set(["trail", "graft"]);

/**
 * Where a repo's skills are: the repo's in its `.claude/skills/`, and this
 * machine's in ~/.trail. A link in either is followed only while it stays
 * inside its root (`repoRoot`, the checkout; `homeRoot`, ~/.trail), so no
 * skill file outside the repo or ~/.trail is ever read or written.
 */
export function skillDirs(dir: string): SkillDirs {
  const place = repoPlace(dir);
  return { repo: join(place.checkout, ".claude", "skills"), home: join(place.dir, "skills"), repoRoot: place.checkout, homeRoot: trailHome() };
}

export interface SkillDirs {
  repo: string;
  home: string;
  repoRoot: string;
  homeRoot: string;
}

export interface Takeaway {
  /** Absolute path of its file. */
  path: string;
  skill: string;
  taughtBy: string;
  date: string;
  /** Where it came from: `correction` when a person corrected an agent. */
  from: string;
  confirmedBy: string[];
  /** The SKILL.md version it was folded into, when it has been. */
  foldedIn?: number;
  /** The SKILL.md heading it belongs under, when the teacher named one. */
  section?: string;
  text: string;
}

export interface Skill {
  name: string;
  description: string;
  version: number;
  /** SKILL.md without its frontmatter. */
  body: string;
  /** `repo`: the team's, in `.claude/skills/`. `home`: only on this machine, in ~/.trail. */
  where: "repo" | "home";
  /** Absolute path of its SKILL.md. */
  file: string;
  /** Trail may rewrite its SKILL.md (skill-file.ts): never when someone wrote it by hand. */
  trailOwned: boolean;
  takeaways: Takeaway[];
}

/** The longest skill name the Agent Skills spec allows (validate.ts). */
const NAME_MAX = 64;

/** A skill name as a folder: `PDF coords` → `pdf-coords`. At most 64 characters, cut at a word. */
export function skillName(raw: string): string {
  const name = slug(raw, 8);
  if (name.length <= NAME_MAX) return name;
  const cut = name.slice(0, NAME_MAX + 1);
  const at = cut.lastIndexOf("-");
  return at > 0 ? cut.slice(0, at) : name.slice(0, NAME_MAX);
}

function yamlScalar(s: string): string {
  return /^[A-Za-z0-9][^:#\n"'{}[\],&*!|>%@`]*$/.test(s) && s.trim() === s ? s : JSON.stringify(s);
}

function asDate(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "");
}

/* -------------------------------------------------------------------------- */
/* reading                                                                    */
/* -------------------------------------------------------------------------- */

export function parseTakeaway(text: string, path: string, skill: string): Takeaway | null {
  let parsed: FrontMatterFile;
  try {
    parsed = matter(text);
  } catch {
    return null;
  }
  const d = parsed.data as Record<string, unknown>;
  const body = parsed.content.trim();
  if (!body) return null;
  return {
    path,
    skill: typeof d.skill === "string" ? d.skill : skill,
    taughtBy: typeof d.taught_by === "string" ? d.taught_by : "",
    date: asDate(d.date),
    from: typeof d.from === "string" ? d.from : "correction",
    confirmedBy: Array.isArray(d.confirmed_by) ? d.confirmed_by.map(String) : [],
    foldedIn: typeof d.folded_in === "number" ? d.folded_in : undefined,
    section: typeof d.section === "string" ? d.section : undefined,
    text: body,
  };
}

export function renderTakeaway(t: Omit<Takeaway, "path">): string {
  const fm = ["---", `skill: ${t.skill}`, `taught_by: ${yamlScalar(t.taughtBy)}`, `date: ${t.date}`, `from: ${t.from}`];
  fm.push(`confirmed_by: [${t.confirmedBy.map(yamlScalar).join(", ")}]`);
  if (t.section) fm.push(`section: ${yamlScalar(t.section)}`);
  if (t.foldedIn !== undefined) fm.push(`folded_in: ${t.foldedIn}`);
  fm.push("---");
  return `${fm.join("\n")}\n${t.text.trim()}\n`;
}

function readTakeaways(dirs: SkillDirs, name: string): Takeaway[] {
  const tdir = join(dirs.home, name, "takeaways");
  let files: string[] = [];
  try {
    if (!within(tdir, dirs.homeRoot)) return [];
    files = readdirSync(tdir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const out: Takeaway[] = [];
  for (const f of files) {
    if (!within(join(tdir, f), dirs.homeRoot)) continue;
    try {
      const t = parseTakeaway(readFileSync(join(tdir, f), "utf8"), join(tdir, f), name);
      if (t) out.push(t);
    } catch {
      /* unreadable */
    }
  }
  return out;
}

/** The skill's SKILL.md: the repo's when it has one, else this machine's. Never one a link leads to outside the repo or ~/.trail. */
function skillFile(dirs: SkillDirs, name: string): { file: string; where: Skill["where"] } | null {
  const repo = join(dirs.repo, name, "SKILL.md");
  if (existsSync(repo) && within(repo, dirs.repoRoot)) return { file: repo, where: "repo" };
  const home = join(dirs.home, name, "SKILL.md");
  if (existsSync(home) && within(home, dirs.homeRoot)) return { file: home, where: "home" };
  return null;
}

function readSkill(dirs: SkillDirs, name: string): Skill | null {
  if (!name || OWN_SKILLS.has(name)) return null;
  const at = skillFile(dirs, name);
  if (!at) return null;
  let text: string;
  let parsed: FrontMatterFile;
  try {
    text = readFileSync(at.file, "utf8");
    parsed = matter(text);
  } catch {
    return null;
  }
  const d = parsed.data as Record<string, unknown>;
  return {
    name,
    description: typeof d.description === "string" ? d.description.trim() : "",
    version: versionOf(d),
    body: parsed.content.trim(),
    where: at.where,
    file: at.file,
    trailOwned: trailOwned(text, d, at.where),
    takeaways: readTakeaways(dirs, name),
  };
}

/**
 * The folders in `dir`, by name, following links: a repo's skill can sit in
 * `.agents/skills/<name>/` with `.claude/skills/<name>` linking to it. A link
 * that loops, dangles, reaches a file or leads out of `root` is skipped, and
 * two names for one folder count once, the first by name.
 */
function subdirs(dir: string, root: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const path = join(dir, e.name);
    let real: string;
    try {
      if (e.isSymbolicLink() && !statSync(path).isDirectory()) continue;
      if (!e.isSymbolicLink() && !e.isDirectory()) continue;
      if (!within(path, root)) continue;
      real = realpathSync(path);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(e.name);
  }
  return out;
}

/** Every skill for the repo `dir` is in: the team's in the repo, then this machine's, by name. */
export function listSkills(dir: string): Skill[] {
  const dirs = skillDirs(dir);
  const names = [...new Set([...subdirs(dirs.repo, dirs.repoRoot), ...subdirs(dirs.home, dirs.homeRoot)])].sort();
  return names.map((n) => readSkill(dirs, n)).filter((s): s is Skill => s !== null);
}

export function getSkill(dir: string, name: string): Skill | null {
  return readSkill(skillDirs(dir), skillName(name));
}

/** Takeaways not yet in SKILL.md. */
export function waiting(s: Skill): Takeaway[] {
  return s.takeaways.filter((t) => t.foldedIn === undefined);
}

/** Confirmed means someone other than the teacher said it's right. */
export function isConfirmed(t: Takeaway): boolean {
  return t.confirmedBy.some((c) => c.toLowerCase() !== t.taughtBy.toLowerCase());
}

/* -------------------------------------------------------------------------- */
/* writing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A new SKILL.md as the Agent Skills spec has it: name and description on
 * top; Trail's mark and the version under metadata. The description never
 * holds `---`, which ends the front matter early for the reference validator.
 */
function renderNewSkill(name: string, description: string): string {
  const said = description.replace(/-{3,}/g, "--");
  const fm = ["---", `name: ${name}`, `description: ${JSON.stringify(said)}`, "metadata:", `  trail: ${JSON.stringify(skillMark(name))}`, '  version: "1"', "---"];
  return `${fm.join("\n")}\n\n# ${name}\n\n${description}.\n`;
}

export interface LearnInput {
  skill: string;
  text: string;
  author: string;
  date: string;
  /** For a new skill: what it covers. Ignored for an existing one. */
  description?: string;
  section?: string;
}

export interface LearnResult {
  skill: Skill;
  takeaway: Takeaway;
  created: boolean;
}

/**
 * Save one takeaway, on this machine. A skill the repo has gets it as is; a
 * name nobody has used starts a skill in ~/.trail, whose SKILL.md is empty
 * but for its description: the takeaways are its content until the first fold.
 */
export function learn(dir: string, input: LearnInput): LearnResult {
  const name = skillName(input.skill);
  if (!name) throw new Error("a skill needs a name, like pdf-coords");
  if (OWN_SKILLS.has(name)) throw new Error(`${name} is the code map's own skill, rewritten by every init: pick a name for what you're teaching, like pdf-coords`);
  ensureRepoHome(dir);
  const dirs = skillDirs(dir);
  let created = false;
  if (!skillFile(dirs, name)) {
    created = true;
    mkdirSync(join(dirs.home, name), { recursive: true });
    const description = input.description?.trim() || `What has been learned about ${name.replace(/-/g, " ")} in this repo`;
    writeFileSync(join(dirs.home, name, "SKILL.md"), renderNewSkill(name, description));
  }
  const tdir = join(dirs.home, name, "takeaways");
  mkdirSync(tdir, { recursive: true });
  const base = `${input.date}-${slug(input.author, 1) || "someone"}`;
  let n = 1;
  while (existsSync(join(tdir, `${base}-${n}.md`))) n++;
  const file = join(tdir, `${base}-${n}.md`);
  const t: Omit<Takeaway, "path"> = {
    skill: name,
    taughtBy: input.author,
    date: input.date,
    from: "correction",
    confirmedBy: [],
    section: input.section?.trim() || undefined,
    text: input.text,
  };
  writeFileSync(file, renderTakeaway(t));
  return { skill: readSkill(dirs, name)!, takeaway: { ...t, path: file }, created };
}

/**
 * Record that `who` checked these takeaways and they're right. The teacher
 * confirming their own takeaway doesn't count: confirmation is a second pair
 * of eyes. Returns the takeaways that became confirmed.
 */
export function confirm(dir: string, name: string, who: string, only?: string): Takeaway[] {
  const s = getSkill(dir, name);
  if (!s) return [];
  const out: Takeaway[] = [];
  for (const t of waiting(s)) {
    if (only && !t.path.endsWith(only) && !t.path.endsWith(`${only}.md`)) continue;
    if (t.taughtBy.toLowerCase() === who.toLowerCase()) continue;
    if (t.confirmedBy.some((c) => c.toLowerCase() === who.toLowerCase())) continue;
    t.confirmedBy.push(who);
    writeFileSync(t.path, renderTakeaway(t));
    out.push(t);
  }
  return out;
}

/** A takeaway as one line in SKILL.md: its text, then who taught it and when. */
function foldedLine(t: Takeaway): string {
  const text = t.text.replace(/\s*\n\s*/g, " ").trim();
  const who = [t.taughtBy, shortDate(t.date)].filter(Boolean).join(", ");
  return `- ${text}${who ? ` (${who})` : ""}`;
}

export interface FoldResult {
  skill: string;
  where: Skill["where"];
  file: string;
  from: number;
  to: number;
  folded: Takeaway[];
  stillWaiting: number;
  /** The SKILL.md headings that gained lines. */
  sections: string[];
  /**
   * Why SKILL.md was left as it is, with takeaways ready: `hand-written`, not
   * Trail's to rewrite (skill-file.ts); `unreadable`, its front matter isn't
   * between two `---` lines. The takeaways stay waiting, and still reach the agent.
   */
  left?: "hand-written" | "unreadable";
}

/**
 * Write a skill's waiting takeaways into its SKILL.md, under the heading each
 * names (made when missing) or under "Takeaways", and bump the version.
 * `confirmed` folds only the ones a second person confirmed. Returns null for
 * an unknown skill; `folded` is empty when nothing was ready.
 */
export function fold(dir: string, name: string, opts: { confirmed?: boolean } = {}): FoldResult | null {
  const s = getSkill(dir, name);
  if (!s) return null;
  const ready = waiting(s).filter((t) => !opts.confirmed || isConfirmed(t));
  const still = waiting(s).length - ready.length;
  const base = { skill: s.name, where: s.where, file: s.file, from: s.version, stillWaiting: still };
  if (ready.length === 0) return { ...base, to: s.version, folded: [], sections: [] };
  const leave = (left: FoldResult["left"]): FoldResult => ({ ...base, stillWaiting: waiting(s).length, to: s.version, folded: [], sections: [], left });
  if (!s.trailOwned) return leave("hand-written");

  const lines = s.body.split(/\r?\n/);
  const sections: string[] = [];
  for (const t of ready) {
    const heading = t.section?.trim() || "Takeaways";
    let at = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
    if (at === -1) {
      while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
      lines.push("", `## ${heading}`);
      at = lines.length - 1;
    }
    // After the section's last non-blank line, before the next heading.
    let end = at + 1;
    while (end < lines.length && !lines[end]!.startsWith("## ")) end++;
    let insert = end;
    while (insert > at + 1 && !lines[insert - 1]!.trim()) insert--;
    lines.splice(insert, 0, foldedLine(t));
    if (!sections.includes(heading)) sections.push(heading);
  }
  const to = s.version + 1;
  if (!rewriteSkill(s.file, to, lines.join("\n"), skillMark(s.name))) return leave("unreadable");
  for (const t of ready) {
    t.foldedIn = to;
    writeFileSync(t.path, renderTakeaway(t));
  }
  return { ...base, to, folded: ready, sections };
}

/** `link`: the repo's `.claude/skills/<name>` leads out of the repo, so nothing is written through it. */
export type PublishResult = { ok: true; file: string } | { ok: false; reason: "unknown" | "in-repo" | "link" };

/**
 * Move a skill kept on this machine into the repo's `.claude/skills/`, where
 * it can be committed and Claude Code loads it for everyone who pulls. Its
 * takeaways stay on this machine, and fold into the repo's copy from now on.
 */
export function publish(dir: string, name: string): PublishResult {
  const s = getSkill(dir, name);
  if (!s) return { ok: false, reason: "unknown" };
  if (s.where === "repo") return { ok: false, reason: "in-repo" };
  const dirs = skillDirs(dir);
  const target = join(dirs.repo, s.name, "SKILL.md");
  // The nearest folder already there must be the repo's own, or the new ones would be made through a link.
  if (!within(nearestThere(dirname(target)), dirs.repoRoot)) return { ok: false, reason: "link" };
  mkdirSync(dirname(target), { recursive: true });
  try {
    renameSync(s.file, target);
  } catch {
    // Across filesystems: copy, then remove.
    writeFileSync(target, readFileSync(s.file));
    rmSync(s.file, { force: true });
  }
  return { ok: true, file: target };
}

/** `v3 · 2 takeaways waiting to fold (1 confirmed) · last taught by Sam, Oct 7`. */
export function skillStatus(s: Skill): string {
  const open = waiting(s);
  const confirmed = open.filter(isConfirmed).length;
  const parts = [`v${s.version}`];
  if (open.length === 0) parts.push("up to date");
  else parts.push(`${open.length} takeaway${open.length === 1 ? "" : "s"} waiting to fold${confirmed ? ` (${confirmed} confirmed)` : ""}`);
  const last = [...s.takeaways].sort((a, b) => b.date.localeCompare(a.date) || b.path.localeCompare(a.path))[0];
  if (last && open.length) parts.push(`last taught by ${last.taughtBy || "someone"}, ${shortDate(last.date)}`);
  parts.push(s.where === "repo" ? "in the repo" : "on this machine");
  return parts.join(" · ");
}

/**
 * What an agent reads before working in a skill's area: its SKILL.md, then
 * every takeaway not yet folded in, newest first, which win where the two
 * disagree. `trail skills show` prints it.
 */
export function skillForAgent(s: Skill): string {
  const open = waiting(s).sort((a, b) => b.date.localeCompare(a.date) || b.path.localeCompare(a.path));
  const out = [`# ${s.name} (v${s.version}, ${s.where === "repo" ? "in this repo" : "kept on this machine"})`, "", s.body.trim()];
  if (open.length) {
    out.push("", `## Corrections since v${s.version} (newest first; these win where they disagree with the above)`);
    for (const t of open) out.push(`- ${t.text.replace(/\s*\n\s*/g, " ").trim()} (${[t.taughtBy, shortDate(t.date)].filter(Boolean).join(", ")})`);
  }
  return `${out.join("\n")}\n`;
}

/**
 * The line a session starts with about skills an agent can't see by itself:
 * ones kept only on this machine (Claude Code loads `.claude/skills/`, not
 * ~/.trail), and the team's ones with corrections waiting. It names the files
 * to read: `trail skills show` is the learned skills' command now and can't
 * print these. Empty when there are none.
 */
export function skillsDirective(dir: string): string {
  const parts: string[] = [];
  const dirs = skillDirs(dir);
  for (const s of listSkills(dir)) {
    const open = waiting(s).length;
    const fixes = `${open} correction${open === 1 ? "" : "s"}`;
    const tdir = join(dirs.home, s.name, "takeaways");
    if (s.where === "home") parts.push(`${s.name} (on this machine: ${s.file}${open ? `, then ${fixes} in ${tdir}` : ""})`);
    else if (open) parts.push(`${s.name} (${fixes} newer than its SKILL.md, in ${tdir})`);
  }
  if (parts.length === 0) return "";
  return `Skills with more than Claude Code loads by itself: ${parts.join(", ")}. Read them before working in one's area, the corrections newest first; they win where they disagree.\n`;
}
