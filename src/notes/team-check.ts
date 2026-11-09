/**
 * Whether something `trail init` found is fit to offer as a team learning:
 * it is tied to code that exists now, and the repo doesn't already say it.
 *
 * A learning a teammate's Claude acts on names the file or function it is
 * about; that is also what lets trail hand it to Claude when Claude opens
 * that file. One that names no code is a habit or a status line, and stays
 * the person's own. One that CLAUDE.md, AGENTS.md or an existing learning
 * already says adds nothing but noise.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { loadGraphCached } from "../graph/load.js";
import { listNotes, mentionedFiles } from "./notes.js";

const TOUCH_LIMIT = 10;

/** `foo_test.go`, `foo.test.ts`, `test/…`, `__tests__/…`, `spec/…`. */
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec)\/|[._-](?:test|spec)\.[A-Za-z]+$|_test\.go$/;

/** `Foo`, `Foo.bar`, `foo_bar()` in backticks: names a note can give a symbol by. */
const TICKED = /`([A-Za-z_$][\w$]*(?:(?:\.|::|#)[A-Za-z_$][\w$]*)*)(?:\(\))?`/g;

/**
 * The code `text` is about, as `touches:` entries: files it names that exist
 * in the checkout, `paths` that exist (an inline review comment's file), and
 * `file#Symbol` for a backticked name the graph knows in one to three places.
 * Empty when it names no code that exists now.
 */
export function codeAnchors(repo: string, text: string, paths: string[] = []): string[] {
  const out: string[] = [];
  const add = (t: string) => {
    if (out.length < TOUCH_LIMIT && !out.includes(t)) out.push(t);
  };
  for (const f of mentionedFiles(repo, text)) add(f);
  for (const p of paths) if (p && !p.startsWith("..") && existsSync(join(repo, p))) add(p);
  const graph = loadGraphCached(contextDirFor(repo));
  if (!graph) return out;
  const names = new Set<string>();
  for (const m of text.matchAll(TICKED)) {
    const last = m[1]!.split(/\.|::|#/).pop()!;
    // Short or generic words (`id`, `run`) match too much to mean anything.
    if (last.length >= 4) names.add(last);
  }
  if (!names.size) return out;
  const byName = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (n.kind === "file" || !names.has(n.name)) continue;
    const list = byName.get(n.name) ?? [];
    list.push(n.id);
    byName.set(n.name, list);
  }
  for (const ids of byName.values()) {
    // A test's fake of a function isn't what the note is about, when the real one is there.
    const real = ids.filter((id) => !TEST_PATH.test(id.split("#")[0]!));
    const pick = real.length ? real : ids;
    if (pick.length <= 3) for (const id of pick) add(id);
  }
  return out;
}

const STOP = new Set(
  "the and for with from that this what when where which into does have has had been being they them their there then than also only just more most some such very will would should could must about after before over under using used make makes made keep keeps kept your yours ours here every each other".split(" "),
);

/** The words that carry meaning: four letters or more, not filler. */
export function contentWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );
}

/** Paragraphs and list items of a markdown text, each as its content words. */
function chunks(text: string): Set<string>[] {
  return text
    .split(/\n\s*\n|\n(?=\s*(?:[-*+]|\d+\.)\s)/)
    .map(contentWords)
    .filter((w) => w.size >= 3);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** What the repo already tells Claude: CLAUDE.md, AGENTS.md, and the learnings here, team and personal. */
export interface KnownText {
  chunks: Set<string>[];
  titles: Set<string>[];
}

export function knownText(repo: string): KnownText {
  const docs = ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md"].map((f) => readText(join(repo, f)));
  let notes: { title: string; body: string }[] = [];
  try {
    notes = listNotes(repo, { branches: false });
  } catch {
    /* no learnings yet */
  }
  return {
    chunks: [...docs.flatMap(chunks), ...notes.flatMap((n) => chunks(n.body))],
    titles: notes.map((n) => contentWords(n.title)).filter((w) => w.size > 0),
  };
}

/**
 * Whether the repo already says what a candidate says: most of its title's
 * and lead's words in one paragraph of CLAUDE.md, AGENTS.md or a learning, or
 * a learning with nearly the same title.
 */
export function alreadySaid(known: KnownText, title: string, body: string): boolean {
  const t = contentWords(title);
  if (t.size && known.titles.some((k) => overlap(t, k) >= 0.8 && overlap(k, t) >= 0.8)) return true;
  const lead = body.replace(/^#+ .*$/gm, "").trim().slice(0, 400);
  const words = contentWords(`${title} ${lead}`);
  if (words.size < 5) return false;
  return known.chunks.some((c) => overlap(words, c) >= 0.6);
}

/** The share of `a`'s words that are in `b`. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / a.size;
}
