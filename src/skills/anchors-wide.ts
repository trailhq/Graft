/**
 * Wider anchors (phase 2 design 1.4, 4.13, P22 to P25, P42): what a skill's
 * steps lean on beyond 1b's five kinds. A CI file (`gh workflow run x`), a
 * compose service (`docker compose up x`) and a subcommand of the repo's own
 * CLI (`acme connect`, where `acme` is a `bin` in package.json).
 *
 * Recall half: they change nothing and only warn, through 1b's
 * `outOfDateLine`. Each is gone only when Trail is sure, from local file
 * reads only (no process, no network): a param or variable, another repo,
 * a folder that can't be known, a file over its size cap, a FIFO, a compose
 * file that merges or includes others, more than 64 CI files, or a CLI whose
 * registrations aren't all plain literals is never judged. The subcommand
 * scan runs only with `scan: true` (a job cue's injection, `trail skills`),
 * within its own 150 ms; SessionStart reads only the cache (P24).
 */
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ParsedSkill } from './types.js';
import { gitOf, readSmall, refOid } from './anchors-git.js';
import { binTarget, binsNear, cliNames, subcommandGone, type Cli } from './anchors-cli.js';
import { leadingCds, simpleCommands } from '../trace/shell.js';
import { programWords } from '../trace/shell-words.js';
import { unquote } from '../trace/shell-scan.js';
import { actionsFolder } from '../util/actions-folder.js';

export type WideKind = 'ci-file' | 'service' | 'subcommand';
/** where: the compose file (relative to the checkout) for a service, the program for a subcommand, 'GitHub Actions' for a CI file. */
export interface WideAnchor { kind: WideKind; name: string; step: number; where: string }

/** The subcommand scan's own deadline (4.13), inside the prompt hook's 400 ms. */
export const WIDE_SCAN_MS = 150;
const MAX_CI_FILES = 64;
const MAX_CI_BYTES = 64 * 1024;
const MAX_COMPOSE_BYTES = 256 * 1024;
const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const OVERRIDES = ['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml'];
const CI_WHERE = 'GitHub Actions';

const opaque = (w: string) => /[{}$`*?]|^\s*$/.test(w);
const inside = (top: string, p: string) => p === top || p.startsWith(top + sep);
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const lexists = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
const posix = (p: string) => p.split(sep).join('/');

interface Found extends WideAnchor { at: string; compose?: { file: string; literal: boolean }; cli?: Cli; ref?: string | null }

/* ------------------------------------------------------------- finding */

/** A folder joined to the step's folder, or null when it can't be known ($VAR, ~, absolute, outside the checkout). */
function joinDir(top: string, base: string | null, d: string | undefined): string | null {
  if (base === null || d === undefined) return null;
  const x = unquote(d);
  if (opaque(x) || isAbsolute(x) || x.startsWith('~') || x === '-') return null;
  const j = resolve(base, x);
  return inside(top, j) ? j : null;
}

/** The step's folder is in this checkout's repo: no nested `.git` between it and the checkout. */
function sameRepo(top: string, at: string): boolean {
  for (let d = at; d !== top && inside(top, d); d = resolve(d, '..')) if (lexists(join(d, '.git'))) return false;
  return true;
}

/** `gh workflow run|view|enable <x>`, `gh run list|watch --workflow[=] <x>`: x, or null (another repo, a param, an id). */
function ciTarget(w: string[]): string | null {
  if (w[0] !== 'gh') return null;
  const rest = w.slice(3);
  if (rest.some((a) => /^(?:-R|--repo)(?:=|$)/.test(a))) return null;
  let x: string | undefined;
  if (/^workflow$/.test(w[1] ?? '') && /^(?:run|view|enable)$/.test(w[2] ?? '')) {
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (/^(?:-f|-F|--raw-field|--field|--ref|-r|--json|-q|--jq|-t|--template)$/.test(a)) { i++; continue; }
      if (a === '--') { x = rest[i + 1]; break; }
      if (a.startsWith('-')) continue;
      x = a;
      break;
    }
  } else if (w[1] === 'run' && /^(?:list|watch)$/.test(w[2] ?? '')) {
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      const m = /^--workflow=(.*)$/.exec(a);
      if (m) { x = m[1]; break; }
      if (/^--workflow$/.test(a) || (w[2] === 'list' && a === '-w')) { x = rest[i + 1]; break; }
    }
  }
  if (!x || opaque(x) || /^\d+$/.test(x) || x.includes('/')) return null;
  return x;
}

/** The `--ref` a `gh workflow` call names: the value, '' for one that can't be read, null for none. */
function ciRef(w: string[]): string | null {
  for (let i = 3; i < w.length; i++) {
    const m = /^--ref=(.*)$/.exec(w[i]!);
    if (m) return opaque(m[1]!) ? '' : m[1]!;
    if (w[i] === '--ref' || w[i] === '-r') return w[i + 1] && !opaque(w[i + 1]!) ? w[i + 1]! : '';
  }
  return null;
}

/** The branch the checkout is on (its own HEAD, a worktree's included), or null (detached, unreadable). */
function headBranch(top: string): string | null {
  const dot = join(top, '.git');
  let dir = dot;
  try {
    if (statSync(dot).isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readSmall(dot, 4096) ?? '');
      if (!m) return null;
      dir = resolve(top, m[1]!);
    }
  } catch { return null; }
  const m = /^ref:\s*refs\/heads\/(\S+)\s*$/.exec(readSmall(join(dir, 'HEAD'), 4096) ?? '');
  return m ? m[1]! : null;
}

/**
 * gh acts on the repo on GitHub, and runs its default branch's CI file unless `--ref` names another: this folder
 * speaks for that only when the checkout has one remote (gh picks among several, upstream first), is on that
 * remote's default branch at the commit last fetched for it, and isn't sparse; `--ref` may name only that branch.
 * Anything else is not sure: an older branch, a fork, a branch behind (review).
 */
function ciSpeaks(top: string, ref: string | null): boolean {
  const git = gitOf(top);
  if (!git || git.reftable || git.sparse || git.remotes.size !== 1) return false;
  const remote = [...git.remotes.keys()][0]!;
  const branch = headBranch(top);
  if (!branch || (ref !== null && ref !== branch && ref !== `refs/heads/${branch}`)) return false;
  const def = /^ref:\s*refs\/remotes\/[^/]+\/(\S+)\s*$/.exec(readSmall(join(git.common, 'refs', 'remotes', remote, 'HEAD'), 4096) ?? '');
  if (!def || def[1] !== branch) return false;
  const here = refOid(git, `refs/heads/${branch}`);
  return here !== null && here === refOid(git, `refs/remotes/${remote}/${branch}`);
}

const SUB_VALUE = new Set(['-e', '--env', '-u', '--user', '-w', '--workdir', '--name', '--entrypoint', '-l', '--label', '--tail', '-n', '--index',
  '--since', '--until', '--timeout', '--scale', '--pull', '--wait-timeout', '--exit-code-from', '--attach', '--no-attach', '--cap-add', '--cap-drop',
  '--env-from-file', '--platform', '-p', '--publish', '-v', '--volume']);
const SUB_BOOL = new Set(['-d', '--detach', '--rm', '--build', '--no-build', '--no-deps', '--force-recreate', '--no-recreate', '--remove-orphans',
  '--wait', '--abort-on-container-exit', '--always-recreate-deps', '-V', '--renew-anon-volumes', '--quiet-pull', '--no-start', '--no-color',
  '--no-log-prefix', '--timestamps', '-f', '--follow', '-T', '--no-TTY', '-i', '--interactive', '--service-ports', '--use-aliases',
  '--privileged', '-y', '--yes', '--dry-run', '-q', '--quiet']);

/** `docker compose` / `docker-compose` with up|run|exec|start|restart|logs|stop: the `-f` values and the service words. */
function composeCall(w: string[]): { files: string[]; services: string[] } | null {
  let i: number;
  if (w[0] === 'docker-compose') i = 1;
  else if (w[0] === 'docker' && w[1] === 'compose') i = 2;
  else return null;
  const files: string[] = [];
  for (; i < w.length; i++) {
    const a = w[i]!;
    if (a === '-f' || a === '--file') { files.push(w[++i] ?? ''); continue; }
    if (/^--file=/.test(a)) { files.push(a.slice(7)); continue; }
    if (/^-f./.test(a)) { files.push(a.slice(2)); continue; }
    // Another env file or project folder can name other compose files.
    if (/^(?:--env-file|--project-directory)(?:=|$)/.test(a)) return null;
    if (/^(?:-p|--project-name|--profile|--ansi|--progress|--parallel)$/.test(a)) { i++; continue; }
    if (a.startsWith('-')) {
      if (a.includes('=') || /^--(?:dry-run|compatibility|all-resources|verbose)$/.test(a)) continue;
      return null;
    }
    break;
  }
  const sub = w[i];
  if (!sub || !/^(?:up|run|exec|start|restart|logs|stop)$/.test(sub)) return null;
  const many = !/^(?:run|exec)$/.test(sub);
  const services: string[] = [];
  for (let j = i + 1; j < w.length; j++) {
    const a = w[j]!;
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (a.includes('=')) continue;
      if (a === '-t') { if (sub !== 'logs') j++; continue; }
      if (SUB_VALUE.has(a)) { j++; continue; }
      if (SUB_BOOL.has(a)) continue;
      return null; // a flag not known: the next word may be its value
    }
    services.push(a);
    if (!many) break;
  }
  return { files, services: services.filter((s) => !opaque(s) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(s)) };
}

/** `<bin> x`, `npx <bin> x`, `npm exec <bin> x`, `node <bin target> x`: the program and x (P23). A flag before x: none. */
function cliCall(w: string[], bins: Map<string, string>): { prog: string; x: string } | null {
  let i = 1;
  let prog: string | undefined = w[0];
  if (w[0] === 'npx' || (w[0] === 'npm' && w[1] === 'exec')) {
    i = w[0] === 'npx' ? 1 : 2;
    while (w[i] && /^(?:-y|--yes|--no|-q|--quiet)$/.test(w[i]!)) i++;
    prog = w[i++];
    if (!prog || prog.startsWith('-')) return null;
  } else if (w[0] === 'node') {
    const t = w[1];
    if (!t || t.startsWith('-')) return null;
    const n = binTarget(t);
    prog = [...bins].find(([, target]) => target === n)?.[0];
    i = 2;
  }
  if (!prog || !bins.has(prog)) return null;
  const x = w[i];
  if (!x || !/^[a-z][a-z0-9-]{1,30}$/.test(x)) return null;
  return { prog, x };
}

function found(skill: ParsedSkill, checkout: string): Found[] {
  if (!checkout) return [];
  const top = resolve(checkout);
  const out: Found[] = [];
  const all = skill.steps.map((s) => String(s.cmd ?? '')).join('\n');
  const ciNever = /\bGH_REPO=/.test(all);
  const composeNever = /\bCOMPOSE_FILE=/.test(all);
  let moved = false; // a `cd` partway through a step or in an earlier one: later folders aren't known
  for (const st of skill.steps) {
    const { cds, rest } = leadingCds(String(st.cmd ?? ''));
    let at: string | null = moved ? null : top;
    for (const c of cds) at = joinDir(top, at, c);
    if (cds.length) moved = true;
    for (const simple of simpleCommands(rest || '')) {
      const w = programWords(simple).map(unquote);
      if (/^(?:cd|pushd|popd)$/.test(w[0] ?? '')) { at = null; moved = true; continue; }
      if (at === null || !sameRepo(top, at)) continue;
      const push = (f: Found) => { if (!out.some((o) => o.kind === f.kind && o.name === f.name && o.where === f.where)) out.push(f); };
      const ci = ciNever ? null : ciTarget(w);
      if (ci) push({ kind: 'ci-file', name: ci, step: st.n, where: CI_WHERE, at, ref: ciRef(w) });
      const dc = composeNever ? null : composeCall(w);
      if (dc && dc.files.length <= 1) {
        const f = dc.files[0];
        let file: string | undefined;
        if (f !== undefined) {
          const x = unquote(f);
          file = opaque(x) || isAbsolute(x) || x.startsWith('~') || x === '-' ? undefined : resolve(at, x);
          if (file && (!inside(top, file) || inside(actionsFolder(top), file))) file = undefined; // P22: that path is never printed
        } else {
          const name = COMPOSE_NAMES.find((n) => lexists(join(at!, n)));
          file = name ? join(at, name) : undefined;
        }
        if (file) for (const s of dc.services) push({ kind: 'service', name: s, step: st.n, where: posix(relative(top, file)), at, compose: { file, literal: f !== undefined } });
      }
      const near = /^(?:gh|docker|docker-compose)$/.test(w[0] ?? '') ? null : binsNear(top, relative(top, at));
      const call = near ? cliCall(w, near.bins) : null;
      if (near && call) push({ kind: 'subcommand', name: call.x, step: st.n, where: call.prog, at, cli: { prog: call.prog, pkgDir: near.pkgDir, target: near.bins.get(call.prog)! } });
    }
  }
  return out;
}

const plain = (f: Found): WideAnchor => ({ kind: f.kind, name: f.name, step: f.step, where: f.where });

/** The wider anchors in the skill's steps that can be checked here, each once (the first step that leans on it). */
export function wideAnchorsOf(skill: ParsedSkill, checkout: string, _env: NodeJS.ProcessEnv = process.env): WideAnchor[] {
  return found(skill, checkout).map(plain);
}

/* ------------------------------------------------------------ checking */

/**
 * A CI file's top-level `name:`: the name, null when the file has none, undefined when it can't be read plainly. A
 * byte-order mark is dropped and a quoted key (`"name":`) counts; a file with no top-level key at all (a document
 * indented as a whole, a flow mapping) is not sure (review).
 */
function topName(text: string): string | null | undefined {
  let keys = 0;
  for (const line of text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n')) {
    if (/^(?:[A-Za-z_][\w-]*|"[^"]*"|'[^']*')\s*:/.test(line)) keys++;
    const m = /^(?:name|"name"|'name')\s*:(.*)$/.exec(line);
    if (!m) continue;
    const v = m[1]!.trim();
    const q = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(v);
    if (q) return q[1] === '"' && q[2]!.includes('\\') ? undefined : q[2]!;
    const bare = v.replace(/\s+#.*$/, '').trim();
    if (!bare || /^[|>&*!%@`"'[{]/.test(bare)) return undefined;
    return bare;
  }
  return keys ? null : undefined;
}

/** The Actions folder, read once per check: its CI file names and top-level names (lower case), or why it can't judge. */
type CiFolder = { files: Set<string>; names: Set<string> } | 'absent' | 'unsure';

function ciFolder(top: string, deadline: number): CiFolder {
  const folder = actionsFolder(top);
  if (!isDir(folder)) return 'absent';
  const list = readdirSync(folder).filter((n) => /\.ya?ml$/i.test(n));
  if (list.length > MAX_CI_FILES) return 'unsure';
  const files = new Set<string>();
  const names = new Set<string>();
  for (const n of list) {
    if (Date.now() > deadline) return 'unsure';
    files.add(n.replace(/\.ya?ml$/i, '').toLowerCase());
    const text = readSmall(join(folder, n), MAX_CI_BYTES);
    if (text === null) return 'unsure';
    const name = topName(text);
    if (name === undefined) return 'unsure';
    if (name !== null) names.add(name.toLowerCase());
  }
  return { files, names };
}

function ciGone(top: string, x: string, folder: () => CiFolder): boolean {
  if (/\.ya?ml$/i.test(x)) return isDir(actionsFolder(top)) && !lexists(join(actionsFolder(top), x));
  const f = folder();
  if (f === 'absent' || f === 'unsure') return false;
  const want = x.toLowerCase();
  return !f.files.has(want) && !f.names.has(want);
}

/** The service keys one indent under a column-0 `services:`; null when not sure (4.13, P25). */
export function composeServices(text: string): Set<string> | null {
  if (/^\s*(?:include|extends)\s*:/m.test(text) || /<<\s*:/.test(text)) return null;
  const lines = text.replace(/\r/g, '').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/^services\s*:/.test(lines[i]!)) continue;
    if (start >= 0 || !/^services\s*:\s*(?:#.*)?$/.test(lines[i]!)) return null;
    start = i;
  }
  if (start < 0) return null;
  let indent: string | null = null;
  const names = new Set<string>();
  for (let j = start + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (/^\s*(?:#.*)?$/.test(l)) continue;
    if (!/^\s/.test(l)) break;
    const m = /^(\s+)(\S.*)$/.exec(l)!;
    if (m[1]!.includes('\t')) return null;
    indent ??= m[1]!;
    if (m[1] === indent) {
      const k = /^(?:"([^"\\]+)"|'([^']+)'|([A-Za-z0-9._-]+))\s*:(?:\s|$)/.exec(m[2]!);
      if (!k) return null;
      names.add((k[1] ?? k[2] ?? k[3])!);
    } else if (m[1]!.length < indent.length) return null;
  }
  return names;
}

function serviceGone(top: string, f: Found, env: NodeJS.ProcessEnv): boolean {
  const c = f.compose!;
  if (env.COMPOSE_FILE) return false;
  const folder = resolve(c.file, '..');
  if (!c.literal && OVERRIDES.some((o) => lexists(join(folder, o)))) return false;
  for (const e of new Set([join(f.at, '.env'), join(folder, '.env'), join(top, '.env')])) {
    if (!lexists(e)) continue;
    const text = readSmall(e, MAX_CI_BYTES);
    if (text === null || /^\s*(?:export\s+)?COMPOSE_FILE\s*=/m.test(text)) return false;
  }
  const text = readSmall(c.file, MAX_COMPOSE_BYTES);
  const names = text === null ? null : composeServices(text);
  return names !== null && !names.has(f.name);
}

/**
 * Gone only when sure (4.13). `scan: false` reads only the cache for subcommands (SessionStart); `scan: true` may
 * scan the CLI's source until `deadline` (default: WIDE_SCAN_MS from now). A check that throws or runs out of time is
 * not gone, and a scan past its deadline caches nothing.
 */
export function wideGone(skill: ParsedSkill, checkout: string, env: NodeJS.ProcessEnv = process.env, opts: { scan: boolean; deadline?: number } = { scan: false }): WideAnchor[] {
  const out: WideAnchor[] = [];
  if (!checkout) return out;
  const top = resolve(checkout);
  const deadline = opts.deadline ?? Date.now() + WIDE_SCAN_MS;
  const names = new Map<string, string[] | null>();
  let ci: CiFolder | undefined;
  const folder = () => (ci ??= ciFolder(top, deadline));
  const speaks = new Map<string | null, boolean>();
  const ciHere = (ref: string | null) => { if (!speaks.has(ref)) speaks.set(ref, ciSpeaks(top, ref)); return speaks.get(ref)!; };
  // A sparse checkout leaves files out on purpose (D109): a CI file or a registration missing there is not sure.
  let sparse: boolean | undefined;
  const isSparse = () => (sparse ??= gitOf(top)?.sparse === true);
  let all: Found[];
  try { all = found(skill, checkout); } catch { return out; }
  for (const f of all) {
    try {
      if (f.kind === 'ci-file' && !env.GH_REPO && ciHere(f.ref ?? null) && ciGone(top, f.name, folder)) out.push(plain(f));
      else if (f.kind === 'service' && serviceGone(top, f, env)) out.push(plain(f));
      else if (f.kind === 'subcommand' && f.cli && !isSparse()) {
        const key = `${f.cli.pkgDir}\0${f.cli.prog}`;
        if (!names.has(key)) names.set(key, cliNames(f.cli, top, env, { scan: opts.scan, deadline }));
        if (subcommandGone(names.get(key)!, f.name)) out.push(plain(f));
      }
    } catch { /* not sure */ }
  }
  return out;
}
