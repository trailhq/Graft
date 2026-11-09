/**
 * The file reads under "may be out of date" (design 4.18, R35): small files, and a checkout's git folder (its
 * remotes, loose refs and packed-refs, through a worktree's or submodule's `gitdir` and `commondir`). No process, no
 * network, nothing written. Split from anchors.ts (500-line rule).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Anchor } from './anchors.js';

export const MAX_READ = 1024 * 1024;

export function readSmall(path: string, max = MAX_READ): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
export const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
export const exists = (p: string) => { try { statSync(p); return true; } catch { return false; } };

export interface Git { common: string; remotes: Map<string, string>; packed: string | null | undefined; reftable: boolean; sparse: boolean }

/** The common git folder (through a worktree's gitdir and commondir), its remotes and packed refs. Null outside git. */
export function gitOf(checkout: string): Git | null {
  if (!checkout) return null;
  let dir = resolve(checkout);
  let gitDir: string | null = null;
  for (let n = 0; n < 40; n++, dir = dirname(dir)) {
    const dot = join(dir, '.git');
    try {
      const st = statSync(dot);
      if (st.isDirectory()) gitDir = dot;
      else if (st.isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readSmall(dot, 4096) ?? '');
        if (m) gitDir = resolve(dir, m[1]!);
      }
    } catch { /* keep looking up */ }
    if (gitDir || dirname(dir) === dir) break;
  }
  if (!gitDir) return null;
  const cd = readSmall(join(gitDir, 'commondir'), 4096);
  const common = cd ? resolve(gitDir, cd.trim()) : gitDir;
  const remotes = new Map<string, string>();
  let current: string | null = null;
  for (const line of (readSmall(join(common, 'config')) ?? '').split('\n')) {
    const sec = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/.exec(line);
    if (sec) { current = sec[1]!; continue; }
    if (/^\s*\[/.test(line)) { current = null; continue; }
    const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (current && url) remotes.set(current, url[1]!);
  }
  const reftable = exists(join(common, 'reftable'));
  // A sparse checkout leaves files out on purpose (the file can stay after `sparse-checkout disable`: not sure either way).
  const sparse = exists(join(gitDir, 'info', 'sparse-checkout')) || exists(join(common, 'info', 'sparse-checkout'));
  return { common, remotes, packed: undefined, reftable, sparse };
}

/** `host/owner/repo` for an https, ssh or scp-style URL; null otherwise (a remote's name). */
function urlKey(url: string): string | null {
  const u = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u);
  if (m) return `${m[1]!.toLowerCase()}/${m[2]}`;
  const scp = /^(?:[^@/:]+@)?([^/:]+):([^/].*)$/.exec(u);
  return scp ? `${scp[1]!.toLowerCase()}/${scp[2]}` : null;
}

/** The remote's name: itself when the config has it, else the remote whose URL is the same repo; null when none. */
function remoteName(git: Git, remote: string): string | null {
  if (git.remotes.has(remote) || exists(join(git.common, 'refs', 'remotes', remote))) return remote;
  const want = urlKey(remote);
  if (!want) return null;
  for (const [name, url] of git.remotes) if (urlKey(url) === want) return name;
  return null;
}

/** packed-refs past this is not read: one search of a 15 MB file took 12 ms, five skills 400 ms (review). Not sure, never gone. */
const MAX_PACKED = 4 * MAX_READ;
/**
 * The packed refs' text, `\n` first and last, searched with indexOf; '' when there is none, null when it is too big
 * or can't be read (not sure). Held in memory for the process while its size and mtime stay: a hook checks up to 5
 * skills against one file. Nothing is written (R35).
 */
let packedMemo: { path: string; size: number; mtimeMs: number; text: string | null } | null = null;
function packed(git: Git): string | null {
  if (git.packed === undefined) {
    const path = join(git.common, 'packed-refs');
    let text: string | null = '';
    try {
      const st = statSync(path);
      if (packedMemo && packedMemo.path === path && packedMemo.size === st.size && packedMemo.mtimeMs === st.mtimeMs) text = packedMemo.text;
      else {
        const raw = readSmall(path, MAX_PACKED);
        text = raw === null ? null : `\n${raw}\n`.replace(/\r/g, '');
        packedMemo = { path, size: st.size, mtimeMs: st.mtimeMs, text };
      }
    } catch { /* no packed-refs: nothing packed */ }
    git.packed = text;
  }
  return git.packed;
}

/** Is the ref there: true, false, or null when packed-refs couldn't be read and it isn't loose. */
function hasRef(git: Git, ref: string): boolean | null {
  if (isFile(join(git.common, ...ref.split('/')))) return true;
  const text = packed(git);
  return text === null ? null : text.includes(` ${ref}\n`);
}

/** A ref's object id (loose, then packed), or null when it isn't there or can't be read (phase 2 c4: the CI check). */
export function refOid(git: Git, ref: string): string | null {
  if (git.reftable) return null;
  const loose = readSmall(join(git.common, ...ref.split('/')), 4096);
  if (loose !== null) return /^[0-9a-f]{40,64}\s*$/.test(loose) ? loose.trim() : null;
  const text = packed(git);
  const m = text === null ? null : new RegExp(`\\n([0-9a-f]{40,64}) ${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`).exec(text);
  return m ? m[1]! : null;
}

/** Does the checkout know any of this remote's branches (a loose ref under refs/remotes/<remote>, or a packed one)? */
function remoteKnown(git: Git, remote: string): boolean {
  try {
    if (readdirSync(join(git.common, 'refs', 'remotes', remote)).some((n) => n !== 'HEAD')) return true;
  } catch { /* none loose */ }
  const text = packed(git);
  if (text === null) return false;
  const key = ` refs/remotes/${remote}/`;
  for (let i = text.indexOf(key); i >= 0; i = text.indexOf(key, i + 1)) {
    if (!text.startsWith('HEAD\n', i + key.length)) return true;
  }
  return false;
}

/** Branch anchor gone? null when it can't be known (the remote isn't one this checkout has). */
export function branchGone(git: Git, a: Anchor): { gone: boolean; remote?: string } | null {
  // reftable keeps refs in neither loose files nor packed-refs: nothing here can say a branch is gone.
  if (git.reftable) return null;
  if (a.via === 'checkout') {
    const local = hasRef(git, `refs/heads/${a.name}`);
    if (local !== false) return local ? { gone: false } : null;
    let remotes: string[] = [...git.remotes.keys()];
    try { remotes = [...new Set([...remotes, ...readdirSync(join(git.common, 'refs', 'remotes'))])]; } catch { /* none */ }
    return remotes.some((r) => hasRef(git, `refs/remotes/${r}/${a.name}`) === true) ? { gone: false } : { gone: true };
  }
  const remote = a.remote ? remoteName(git, a.remote) : null;
  // A remote this checkout never fetched says nothing about its branches.
  if (!remote || !remoteKnown(git, remote)) return null;
  const has = hasRef(git, `refs/remotes/${remote}/${a.name}`);
  return has === null ? null : { gone: !has, remote };
}


/** At most this many branch names are read from one checkout. */
const MAX_BRANCHES = 2000;

/**
 * D136 (3): the branch names a checkout knows, local and remote (`refs/heads/<b>`, `refs/remotes/<r>/<b>`), loose and
 * packed, so "deploy it to dev" can be the ship job for any branch the repo has. Empty outside git, or under reftable.
 */
export function repoBranches(checkout: string): Set<string> {
  const out = new Set<string>();
  const git = gitOf(checkout);
  if (!git || git.reftable) return out;
  const add = (name: string) => { if (name && name !== 'HEAD' && out.size < MAX_BRANCHES) out.add(name); };
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > 6 || out.size >= MAX_BRANCHES) return;
    let names: import('node:fs').Dirent[];
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`, depth + 1);
      else if (e.isFile()) add(`${prefix}${e.name}`);
    }
  };
  walk(join(git.common, 'refs', 'heads'), '', 0);
  try {
    for (const r of readdirSync(join(git.common, 'refs', 'remotes'))) walk(join(git.common, 'refs', 'remotes', r), '', 0);
  } catch { /* no remotes */ }
  for (const m of (packed(git) ?? '').matchAll(/ refs\/(?:heads|remotes\/[^/\s]+)\/(\S+)\n/g)) add(m[1]!);
  return out;
}

const branchMemo = new Map<string, Set<string>>();
/** A lazy `hasBranch` for matchJob (D136 (3)): the checkout's branches are read at the first ask that needs them, once a process. */
export function branchTest(checkout: string): (name: string) => boolean {
  return (name) => {
    if (!checkout) return false;
    let b = branchMemo.get(checkout);
    if (!b) {
      if (branchMemo.size >= 20) branchMemo.clear();
      branchMemo.set(checkout, (b = repoBranches(checkout)));
    }
    return b.has(name);
  };
}
