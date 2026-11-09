/**
 * Claude Code's how-to files (design 4.5, P34): the `memory/*.md` files
 * Claude Code keeps beside a project's transcripts. Init reads them, never
 * writes them, and never sends or copies their text: a how-to that already
 * describes a job is evidence on the skill's line (its file name only), and
 * a preference a how-to already says is not offered again.
 */
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { JobClass } from '../trace/types.js';
import { readPlain } from './plain-file.js';
import { contentWords, jaccard, SAME_WORDS } from './prefs.js';

const MAX_FILES = 50;
const MAX_BYTES = 64 * 1024;
const KEY = /^[A-Za-z0-9._ -]{1,255}$/;
/** A how-to's file name is shown as evidence ("your Claude Code how-to {file} describes it"): a plain name only. */
const FILE = /^[A-Za-z0-9][\w. -]{0,80}\.md$/;

/** A real folder, not a link to one. */
const realDir = (p: string) => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Words that say a how-to is about a job (beside one of the job's programs). */
const JOB_WORDS: Readonly<Record<JobClass, readonly string[]>> = {
  release: ['release', 'releasing', 'publish', 'publishing', 'version', 'bump'],
  ship: ['ship', 'deploy', 'deploying', 'prod', 'production', 'beta', 'staging', 'promote'],
  tests: ['test', 'tests', 'suite', 'e2e', 'integration'],
  report: ['report', 'users', 'signups', 'query'],
  'pr-green': ['ci', 'checks'],
  sweep: ['sweep', 'prs', 'issues'],
  'run-local': ['locally', 'localhost', 'dev'],
};

/** Reads ~/.claude/projects/<key>/memory/*.md for each discovered project key. Never writes. */
export function readHowtos(projectKeys: string[], claudeHome: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const key of new Set(projectKeys)) {
    if (!KEY.test(key) || key === '.' || key === '..' || key.includes('..')) continue;
    // Never through a link: a linked project or memory folder can bring in any file (b5 review).
    if (!realDir(join(claudeHome, 'projects', key)) || !realDir(join(claudeHome, 'projects', key, 'memory'))) continue;
    const dir = join(claudeHome, 'projects', key, 'memory');
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => FILE.test(f)).sort().slice(0, MAX_FILES);
    } catch {
      continue;
    }
    for (const file of names) {
      const text = readPlain(join(dir, file), MAX_BYTES);
      if (text !== null) out.push({ file, text });
    }
  }
  return out;
}

const wordsOf = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9+_-]+/).filter(Boolean));

/**
 * Evidence for a skill candidate: the first how-to with a paragraph that names one of the job's programs and one of
 * its words (`npm publish` with release). The file name, or null.
 */
export function howtoDescribes(h: Array<{ file: string; text: string }>, job: JobClass, programs: string[]): string | null {
  const jobWords = JOB_WORDS[job] ?? [];
  const progs = programs.map((p) => p.toLowerCase()).filter(Boolean);
  if (!progs.length) return null;
  for (const { file, text } of h) {
    for (const para of text.split(/\n\s*\n/)) {
      const w = wordsOf(para);
      if (progs.some((p) => w.has(p)) && jobWords.some((j) => w.has(j))) return file;
    }
  }
  return null;
}

/** True when a how-to line already says the preference (content-word Jaccard 0.5, 4.4 step 5). */
export function howtoKnows(h: Array<{ file: string; text: string }>, prefText: string): boolean {
  const mine = contentWords(prefText);
  if (!mine.length) return false;
  return h.some(({ text }) => text.split('\n').some((line) => {
    const theirs = contentWords(line.replace(/^\s*(?:[-*+]|\d+[.)]|#+)\s*/, ''));
    return theirs.length > 0 && jaccard(mine, theirs) >= SAME_WORDS;
  }));
}
