/**
 * The repo's own CLI subcommands (phase 2 design 4.13, P23, P24): the `bin`
 * names in the nearest package.json, the commander-style registrations in
 * the package's source folder, and the cache that keeps SessionStart from
 * scanning (`state/anchors-cache.json`, 2.7).
 *
 * A scan reads at most 400 files and 8 MB of `.ts .js .mjs .cjs` under `src/`
 * (else the bin target's folder), within a deadline; past any limit, a
 * dynamic registration, or a default command, nothing is judged. The cache
 * holds command names and a 16-hex signature of the files' paths, sizes and
 * mtimes, never file text. Local file reads only: no process, no network.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { exists, readSmall } from './anchors-git.js';
import { readPlain } from '../init/plain-file.js';
import { trailPath, writePrivate } from '../util/private-fs.js';

export const MAX_SRC_FILES = 400;
export const MAX_SRC_BYTES = 8 * 1024 * 1024;
const MAX_CHECKOUTS = 20;
/** At SessionStart a cache this old is not sure: the CLI may have changed since (P24). */
const START_CACHE_MS = 24 * 3600_000;
const EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** The cache file is read only as a plain file this size or under (no link, no FIFO, D100). */
const MAX_CACHE_BYTES = 1024 * 1024;
/** Commands the libraries add on their own. */
const BUILT_IN = new Set(['help']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,39}$/;

/** One CLI program of the checkout: its bin name, its package folder and its bin target (the source folder is found only when scanning). */
export interface Cli { prog: string; pkgDir: string; target: string }

const inside = (top: string, p: string) => p === top || p.startsWith(top + sep);
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/**
 * A bin target or a `node <file>` word as one form: forward slashes, normalized, no `./`. `dist/cli.js` on every
 * platform, as package.json and the shell write it; `path.normalize` would make it `dist\cli.js` on Windows.
 */
export const binTarget = (p: string): string => posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, '');

/** The bins of the nearest package.json from the step's folder up to the checkout: name to target. null when none or unreadable. */
export function binsNear(checkout: string, dir: string): { pkgDir: string; bins: Map<string, string> } | null {
  const top = resolve(checkout);
  for (let d = resolve(top, dir); inside(top, d); d = dirname(d)) {
    const file = join(d, 'package.json');
    if (exists(file)) {
      const text = readSmall(file, 256 * 1024);
      if (text === null) return null;
      let pkg: { name?: unknown; bin?: unknown };
      try { pkg = JSON.parse(text) as typeof pkg; } catch { return null; }
      const bins = new Map<string, string>();
      if (typeof pkg?.bin === 'string' && typeof pkg.name === 'string') bins.set(pkg.name.replace(/^@[^/]+\//, ''), pkg.bin);
      else if (pkg?.bin && typeof pkg.bin === 'object') {
        for (const [k, v] of Object.entries(pkg.bin as Record<string, unknown>)) if (typeof v === 'string') bins.set(k, v);
      }
      for (const [k, v] of bins) bins.set(k, binTarget(v));
      return bins.size ? { pkgDir: d, bins } : null;
    }
    if (d === top) return null;
  }
  return null;
}

/** The folder a program's commands are registered in: `src/`, else its bin target's folder, inside the package. */
export function srcOf(pkgDir: string, target: string): string | null {
  if (isDir(join(pkgDir, 'src'))) return join(pkgDir, 'src');
  const d = dirname(resolve(pkgDir, target));
  return inside(pkgDir, d) && isDir(d) ? d : null;
}

/**
 * The names registered with `.command('x'`, `new Command('x'`, `createCommand('x'`, `.alias('x')` and an `.aliases` array in `text` (each
 * literal's first word), into `out`. false when one isn't a plain string literal, or a default command exists: then
 * any word may be the CLI's, and nothing is judged.
 */
export function registrations(text: string, out: Set<string>): boolean {
  if (/\bisDefault\s*:\s*true/.test(text)) return false;
  // yargs' commandDir loads commands from files, and its completion() adds one: the names can't be listed (review).
  if (/\.(?:commandDir|completion)\s*\(/.test(text)) return false;
  const re = /\.(command|alias|aliases)\s*\(\s*|\b(?:new\s+Command|createCommand)\s*\(\s*/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let at = re.lastIndex;
    const many = m[1] === 'aliases';
    if (many) {
      if (text[at] !== '[') return false;
      at = skipSpace(text, at + 1);
    }
    for (;;) {
      const q = text[at];
      if ((q === ')' && !many) || (q === ']' && many)) break; // `new Command()`, `.alias()` read back, `[]`
      if (q !== "'" && q !== '"' && q !== '`') return false;
      const end = text.indexOf(q, at + 1);
      const lit = end < 0 ? '' : text.slice(at + 1, end);
      if (end < 0 || /[\\\n]/.test(lit) || (q === '`' && lit.includes('${'))) return false;
      const name = lit.trim().split(/\s+/)[0] ?? '';
      if (name === '$0' || name === '*') return false;
      if (name) out.add(name);
      if (!many) break;
      at = skipSpace(text, end + 1);
      if (text[at] === ',') at = skipSpace(text, at + 1);
      else if (text[at] !== ']') return false;
    }
  }
  return true;
}
const skipSpace = (t: string, i: number) => { while (i < t.length && /\s/.test(t[i]!)) i++; return i; };

interface Walked { files: string[]; sig: string; over: boolean }

/** The source files (stat only), their signature, and whether a limit was passed. null past the deadline. */
function walk(cli: Cli, src: string, deadline: number): Walked | null {
  const files: string[] = [];
  const parts: string[] = [];
  let bytes = 0;
  try {
    const p = statSync(join(cli.pkgDir, 'package.json'));
    parts.push(`package.json\0${p.size}\0${Math.trunc(p.mtimeMs)}`);
  } catch { /* the bins were read from it a moment ago */ }
  const stack = [src];
  while (stack.length) {
    if (Date.now() > deadline) return null;
    const d = stack.pop()!;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(d, e.name);
      // A linked folder or source file can hold registrations the walk doesn't follow: not sure (review).
      if (e.isSymbolicLink()) {
        if (EXT.test(e.name) || isDir(p)) return { files, sig: sigOf(cli, parts), over: true };
        continue;
      }
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile() || !EXT.test(e.name)) continue;
      const st = lstatSync(p);
      files.push(p);
      bytes += st.size;
      parts.push(`${relative(cli.pkgDir, p)}\0${st.size}\0${Math.trunc(st.mtimeMs)}`);
      if (files.length > MAX_SRC_FILES || bytes > MAX_SRC_BYTES) return { files, sig: sigOf(cli, parts), over: true };
    }
  }
  // The bin target outside the source folder can register commands too (a hand-written bin/acme.js; review).
  const target = resolve(cli.pkgDir, cli.target);
  if (inside(cli.pkgDir, target) && !inside(src, target)) {
    try {
      const st = lstatSync(target);
      if (st.isFile()) {
        files.push(target);
        bytes += st.size;
        parts.push(`${relative(cli.pkgDir, target)}\0${st.size}\0${Math.trunc(st.mtimeMs)}`);
        if (bytes > MAX_SRC_BYTES) return { files, sig: sigOf(cli, parts), over: true };
      }
    } catch { /* not built yet: the source folder is all there is */ }
  }
  return { files, sig: sigOf(cli, parts), over: false };
}
const sigOf = (cli: Cli, parts: string[]) => createHash('sha256').update(`${cli.pkgDir}\n${parts.join('\n')}`).digest('hex').slice(0, 16);

/** Every name registered in the files, or [] when not sure (a dynamic one, a default command). null past the deadline. */
function scanNames(files: string[], deadline: number): string[] | null {
  const names = new Set<string>();
  for (const f of files) {
    if (Date.now() > deadline) return null;
    const text = readSmall(f, MAX_SRC_BYTES);
    if (text === null || !registrations(text, names)) return [];
  }
  const list = [...names].filter((n) => NAME.test(n)).sort();
  return list.length === names.size && list.length <= 200 ? list : [];
}

/* ---------------------------------------------------------------- cache */

interface Entry { sig: string; cli: Record<string, string[]>; at: string }
interface CacheFile { v: 1; checkouts: Record<string, Entry> }
const cachePath = (env: NodeJS.ProcessEnv) => trailPath(env, 'state', 'anchors-cache.json');
/** Per checkout, and per package below its top: two packages' programs of one name never share names (review). */
const keyOf = (checkout: string, pkgDir: string) => {
  const rel = relative(resolve(checkout), resolve(pkgDir));
  return createHash('sha256').update(rel ? `${resolve(checkout)}\0${rel}` : resolve(checkout)).digest('hex').slice(0, 12);
};

function readCache(env: NodeJS.ProcessEnv): CacheFile {
  let raw: CacheFile | null = null;
  try {
    const text = readPlain(cachePath(env), MAX_CACHE_BYTES);
    raw = text === null ? null : (JSON.parse(text) as CacheFile);
  } catch { /* read as empty */ }
  const ok = raw && typeof raw === 'object' && raw.checkouts && typeof raw.checkouts === 'object' && !Array.isArray(raw.checkouts);
  const checkouts: Record<string, Entry> = {};
  if (raw && ok) {
    for (const [k, e] of Object.entries(raw.checkouts)) {
      if (!/^[0-9a-f]{12}$/.test(k) || !e || typeof e.sig !== 'string' || typeof e.at !== 'string' || !e.cli || typeof e.cli !== 'object') continue;
      const cli: Record<string, string[]> = {};
      for (const [p, names] of Object.entries(e.cli)) if (Array.isArray(names)) cli[p] = names.filter((n) => typeof n === 'string' && NAME.test(n));
      checkouts[k] = { sig: e.sig, cli, at: e.at };
    }
  }
  return { v: 1, checkouts };
}

function writeCache(env: NodeJS.ProcessEnv, file: CacheFile): void {
  const keep = Object.entries(file.checkouts).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)).slice(0, MAX_CHECKOUTS);
  try { writePrivate(cachePath(env), JSON.stringify({ v: 1, checkouts: Object.fromEntries(keep) })); } catch { /* scanned again next time */ }
}

/**
 * The names the program registers, or null when not known. `scan: false` (SessionStart) reads only the cache, and
 * only an entry under a day old; `scan: true` walks the files (stat only) and reads them only when the signature
 * moved, then writes the cache. Past the deadline: null, nothing written.
 */
export function cliNames(cli: Cli, checkout: string, env: NodeJS.ProcessEnv, opts: { scan: boolean; deadline: number }): string[] | null {
  const file = readCache(env);
  const key = keyOf(checkout, cli.pkgDir);
  const entry = file.checkouts[key];
  if (!opts.scan) {
    const age = entry ? Date.now() - Date.parse(entry.at) : NaN;
    return entry && age >= 0 && age < START_CACHE_MS ? entry.cli[cli.prog] ?? null : null;
  }
  const src = srcOf(cli.pkgDir, cli.target);
  const w = src ? walk(cli, src, opts.deadline) : null;
  if (!w) return null;
  let names: string[] | null = w.over ? [] : null;
  if (!names && entry?.sig === w.sig && entry.cli[cli.prog]) return entry.cli[cli.prog]!;
  names ??= scanNames(w.files, opts.deadline);
  if (!names) return null;
  const cliMap = entry?.sig === w.sig ? { ...entry.cli } : {};
  cliMap[cli.prog] = names;
  file.checkouts[key] = { sig: w.sig, cli: cliMap, at: new Date().toISOString() };
  writeCache(env, file);
  return names;
}

/** Gone only when at least 3 other registrations were found, none dynamic, and `x` isn't among them (P23). */
export function subcommandGone(names: string[] | null, x: string): boolean {
  if (!names || BUILT_IN.has(x)) return false;
  const others = names.filter((n) => n !== x && !BUILT_IN.has(n));
  return others.length >= 3 && !names.includes(x);
}
