/**
 * Session notes: one short note per coding session, kept on this machine in
 * `~/.trail/repos/<repo>/notes/` (see home.ts for how a repo gets its key).
 *
 * A note is what a session worked out that the code itself doesn't say: what
 * was decided, what was tried and ruled out, and what to watch out for, plus
 * what it cost to figure out. The next session on the same code reads it
 * before exploring, so nobody pays for it twice.
 *
 * One file per session and never edited after it's written. A summary only,
 * never a transcript: the agent writes the body, and nothing here reads
 * source files or prompts into it.
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import matter from "gray-matter";
import { changedFiles, ownPath } from "./git-facts.js";
import { checkoutRoot, childCheckouts, ensureRepoHome, notePlaces, repoPlace, shownPath } from "./home.js";

export interface NoteCost {
  minutes?: number;
  tokens?: number;
}

export interface Note {
  /** Where the note is: an absolute path on this machine. */
  path: string;
  title: string;
  author: string;
  /** YYYY-MM-DD. */
  date: string;
  branch?: string;
  cost?: NoteCost;
  /** `file` or `file#Symbol`, relative to the top of the checkout (or to the folder `listNotes` was asked about). */
  touches: string[];
  body: string;
}

/** The three sections a note is written under. Notes may have others; these are the ones `ask` quotes. */
export const SECTIONS = [
  { key: "decided", heading: "Decided", label: "decided" },
  { key: "ruledOut", heading: "Tried and ruled out", label: "ruled out" },
  { key: "watchOut", heading: "Watch out", label: "watch out" },
] as const;

/* -------------------------------------------------------------------------- */
/* reading and writing one note                                               */
/* -------------------------------------------------------------------------- */

/** A YAML scalar that round-trips: plain when it can be, double-quoted otherwise. */
function scalar(s: string): string {
  return /^[A-Za-z0-9][^:#\n"'{}[\],&*!|>%@`]*$/.test(s) && s.trim() === s ? s : JSON.stringify(s);
}

export function renderNote(n: Omit<Note, "path">): string {
  const fm = ["---", `title: ${scalar(n.title)}`, `author: ${scalar(n.author)}`, `date: ${n.date}`];
  if (n.branch) fm.push(`branch: ${scalar(n.branch)}`);
  const cost: string[] = [];
  if (n.cost?.minutes !== undefined) cost.push(`minutes: ${n.cost.minutes}`);
  if (n.cost?.tokens !== undefined) cost.push(`tokens: ${n.cost.tokens}`);
  if (cost.length) fm.push(`cost: { ${cost.join(", ")} }`);
  if (n.touches.length) fm.push("touches:", ...n.touches.map((t) => `  - ${scalar(t)}`));
  fm.push("---", "");
  return `${fm.join("\n")}\n${n.body.trim()}\n`;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A note file, or null when it isn't one (no title in its frontmatter). */
export function parseNote(text: string, path: string): Note | null {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(text);
  } catch {
    return null;
  }
  const d = parsed.data as Record<string, unknown>;
  if (typeof d.title !== "string" || !d.title.trim()) return null;
  const date = d.date instanceof Date ? d.date.toISOString().slice(0, 10) : String(d.date ?? "");
  const cost = (d.cost ?? {}) as Record<string, unknown>;
  const minutes = num(cost.minutes);
  const tokens = num(cost.tokens);
  return {
    path,
    title: d.title.trim(),
    author: typeof d.author === "string" ? d.author : "",
    date,
    branch: typeof d.branch === "string" ? d.branch : undefined,
    cost: minutes !== undefined || tokens !== undefined ? { minutes, tokens } : undefined,
    touches: Array.isArray(d.touches) ? d.touches.map(String) : [],
    body: parsed.content.trim(),
  };
}

/** A touch saved relative to `checkout`, as a path relative to `here`. */
function rebaseTouch(t: string, checkout: string, here: string): string {
  if (checkout === here) return t;
  const [file, ...sym] = t.split("#");
  const rel = relative(here, join(checkout, file!)).split(sep).join("/");
  return [rel, ...sym].join("#");
}

/**
 * Every note that bears on the folder `dir`, newest first: its repo's, or, for
 * a folder that holds several repos, its own and each repo's. Touches come
 * back relative to `dir`, so they line up with a query run there.
 * `children: false` leaves a folder's repos out: only the folder's own notes.
 * Unreadable files are skipped.
 */
export function listNotes(dir: string, opts: { children?: boolean } = {}): Note[] {
  const here = resolve(dir);
  const out: Note[] = [];
  const places = notePlaces(here);
  for (const place of opts.children === false ? places.slice(0, 1) : places) {
    const notes = join(place.dir, "notes");
    let files: string[];
    try {
      files = readdirSync(notes).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const n = parseNote(readFileSync(join(notes, f), "utf8"), join(notes, f));
        if (n) out.push({ ...n, touches: n.touches.map((t) => rebaseTouch(t, place.checkout, here)) });
      } catch {
        /* unreadable: skip */
      }
    }
  }
  return out.sort((a, b) => (a.date === b.date ? b.path.localeCompare(a.path) : b.date.localeCompare(a.date)));
}

/** The first line of a section's text, or null when the note has no such section. */
export function sectionLead(body: string, heading: string): string | null {
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (at === -1) return null;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (l.startsWith("## ")) break;
    if (l) return l.replace(/^[-*]\s+/, "");
  }
  return null;
}

/** `Bbox coordinates are off on rotated PDFs` → `bbox-coordinates-are-off-on-rotated`. */
export function slug(s: string, words = 6): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, words)
    .join("-");
}

export interface WriteNoteInput {
  title: string;
  body: string;
  author: string;
  date: string;
  branch?: string;
  cost?: NoteCost;
  touches?: string[];
}

/**
 * Write a new note into the repo `dir` is in, and return it. Never
 * overwrites: a second note with the same name on the same day gets `-2`,
 * `-3`.
 */
export function writeNote(dir: string, input: WriteNoteInput): Note {
  const notes = join(ensureRepoHome(dir).place.dir, "notes");
  const base = [input.date, slug(input.title) || "note", slug(input.author, 1)].filter(Boolean).join("-");
  let name = `${base}.md`;
  for (let i = 2; existsSync(join(notes, name)); i++) name = `${base}-${i}.md`;
  const note: Omit<Note, "path"> = {
    title: input.title.trim(),
    author: input.author,
    date: input.date,
    branch: input.branch,
    cost: input.cost,
    touches: input.touches ?? [],
    body: input.body,
  };
  writeFileSync(join(notes, name), renderNote(note));
  return { ...note, path: join(notes, name) };
}

export interface NoteTarget {
  /** A folder in the repo the note goes to. */
  dir: string;
  /** What the session touched there, relative to the top of that checkout. */
  touches: string[];
}

/** Most files one note lists per repo. */
const TOUCH_LIMIT = 10;

/**
 * Which repos a session's note belongs in, and what it touched in each.
 *
 * The repo the note was saved from gets the files it has uncommitted or
 * committed since `since`. Every other repo the session edited (`edited`:
 * absolute paths, from the agent's transcript) gets the note too, with its
 * own files, so a session that changed a backend and the library it calls
 * leaves a note in both. Saved from a folder that holds several repos, the
 * note goes to each repo the session changed, or stays with the folder when
 * it changed none. Two worktrees of one repo are one repo.
 */
export function noteTargets(dir: string, edited: string[] = [], since?: number): NoteTarget[] {
  const here = repoPlace(dir);
  const byKey = new Map<string, { dir: string; files: string[] }>();
  const add = (checkout: string, files: string[]) => {
    const key = repoPlace(checkout).key;
    const entry = byKey.get(key) ?? { dir: checkout, files: [] };
    for (const f of files) if (f && !ownPath(f) && !entry.files.includes(f)) entry.files.push(f);
    byKey.set(key, entry);
  };
  if (here.git) add(here.checkout, changedFiles(here.checkout, since));
  else if (edited.length === 0) for (const c of childCheckouts(here.checkout)) add(c, changedFiles(c, since));
  // The agent's own files (memory, plans, scratch under ~/.claude) aren't what a note is about.
  const agentFiles = join(homedir(), ".claude") + sep;
  for (const f of edited) {
    if (f.startsWith(agentFiles)) continue;
    const top = checkoutRoot(dirname(f));
    if (top) add(top, [relative(top, f).split(sep).join("/")]);
    else if (!here.git && !relative(here.checkout, f).startsWith("..")) add(here.checkout, [relative(here.checkout, f).split(sep).join("/")]);
  }
  const out = [...byKey.entries()]
    .filter(([key, e]) => e.files.length > 0 || key === here.key)
    .map(([, e]) => ({ dir: e.dir, touches: e.files.slice(0, TOUCH_LIMIT) }));
  // The repo it was saved from first; a folder of repos only when nothing else was touched.
  out.sort((a, b) => Number(repoPlace(b.dir).key === here.key) - Number(repoPlace(a.dir).key === here.key));
  const touched = out.filter((t) => t.touches.length > 0);
  if (!here.git && touched.length > 0) return touched;
  return out.length ? out : [{ dir: here.checkout, touches: [] }];
}

/* -------------------------------------------------------------------------- */
/* finding the notes that matter for a query                                  */
/* -------------------------------------------------------------------------- */

const STOP = new Set(
  "the and for with from that this what when where which into does how why are was were not but you your our out its it's can should would could about after before over under use using used fix find make".split(
    " ",
  ),
);

function terms(s: string): string[] {
  return [...new Set(s.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 3 && !STOP.has(t)))];
}

/** The file part of a `file#Symbol` touch. */
function touchFile(t: string): string {
  return t.split("#")[0]!;
}

export interface NoteHit {
  note: Note;
  score: number;
  /** Files the note touches that this query's results also point into. */
  shared: string[];
}

/**
 * The notes worth showing next to a query's results: ones whose title or body
 * share the query's words, or that touch a file the results point into. At
 * most `limit`, best first. A note has to clear a bar — two of the query's
 * words, or one in its title, or a shared file — so an unrelated note never
 * rides along just because it exists.
 */
export function findNotes(notes: Note[], query: string, files: string[] = [], limit = 2): NoteHit[] {
  const q = terms(query);
  const hitFiles = new Set(files);
  const out: NoteHit[] = [];
  for (const note of notes) {
    const title = new Set(terms(note.title));
    const text = new Set(terms(`${note.body} ${note.touches.join(" ")}`));
    let score = 0;
    let matched = 0;
    for (const t of q) {
      if (title.has(t)) {
        score += 3;
        matched++;
      } else if (text.has(t)) {
        score += 1;
        matched++;
      }
    }
    const shared = [...new Set(note.touches.map(touchFile))].filter((f) => hitFiles.has(f));
    score += shared.length * 4;
    const clears = shared.length > 0 || matched >= 2 || [...title].some((t) => q.includes(t));
    if (clears && score >= 3) out.push({ note, score, shared });
  }
  return out.sort((a, b) => b.score - a.score || b.note.date.localeCompare(a.note.date)).slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* how a note reads inside a query's output                                   */
/* -------------------------------------------------------------------------- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-10-07` → `Oct 7`; anything else as it came. */
export function shortDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

/** `~9.6k tokens`, `~600 tokens`. */
export function tokensLabel(n: number): string {
  if (n >= 1000) return `~${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k tokens`;
  return `~${n} tokens`;
}

/** `took 12 min and ~9.6k tokens to work out`, or null when the note has no cost. */
export function costLabel(cost?: NoteCost): string | null {
  if (!cost) return null;
  const parts: string[] = [];
  if (cost.minutes !== undefined) parts.push(`${cost.minutes} min`);
  if (cost.tokens !== undefined) parts.push(tokensLabel(cost.tokens));
  return parts.length ? `took ${parts.join(" and ")} to work out` : null;
}

function clip(s: string, n = 88): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/**
 * The block `ask` prints above its results: who wrote each note, when, what it
 * was about and what it cost, then the first line of each section, and the
 * path to read the rest. An agent relays the cost when it says what the turn
 * saved, which is how the saving becomes countable.
 */
export function formatNoteHits(hits: NoteHit[]): string[] {
  const lines: string[] = [];
  for (const { note } of hits) {
    const who = note.author ? `${note.author}'s note` : "a note";
    lines.push(`from ${who} · ${shortDate(note.date)} · ${note.title}`);
    for (const s of SECTIONS) {
      const lead = sectionLead(note.body, s.heading);
      if (lead) lines.push(`  ${s.label.padEnd(11)} ${clip(lead)}`);
    }
    const cost = costLabel(note.cost);
    lines.push(`  ${shownPath(note.path)}${cost ? ` · ${cost}` : ""}`);
    lines.push("");
  }
  return lines;
}
