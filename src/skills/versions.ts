/**
 * Kept versions of a personal skill (phase 2 design 2.1, 4.5, 4.6, 4.12):
 * `skills/<name>/.versions/`. Trail writes a new SKILL.md only over the file
 * it wrote itself, byte for byte (0 rule 2), and only after the file it is
 * about to replace is kept as `v<n>/` (0 rule 3). A file the person changed
 * is never written: the change goes beside it as `proposed-v<n>/`, with the
 * person's file kept as `hand-<date>/`, and Trail takes the file as its own
 * again only when the person copied the proposal over it, byte for byte.
 *
 * A write marks itself in the state first (`pendingWrite`, R8), so a process
 * killed between the new file and the state is finished on the next read
 * instead of looking hand-edited forever. A state that can't be written
 * puts the old file back (D68). Every path refuses a link, a file that isn't
 * regular, or one over 64 KB, and fails closed: nothing changes.
 *
 * This module never imports the fold (fold.ts imports recall.ts, which
 * calls `adoptIfCopied`): it writes text it is given.
 */
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangeOp, CompiledSkill, FoldOp, SkillRef, SkillState } from './types.js';
import { parseSkillMd, renderSkillMd, skillHash } from './skillmd.js';
import { getSkillState, updateSkillState } from './state.js';
import { appendLedger } from './ledger.js';
import { underStoreLock } from './store-fs.js';
import { phraseSha } from './staleness.js';
import { rebuildCompiled } from './skill-rebuild.js';
import { printDiff } from './skill-diff.js';
import { writePrivate } from '../util/private-fs.js';
import {
  copyFlat, keepFolder, keepHand, lessonFiles, LinkError, lst, moveLessons, ownDir, prune, regularText, swapScripts, V_DIR, versionsDir, type Swap,
} from './versions-fs.js';

export { versionsDir } from './versions-fs.js';

export const VERSIONS_KEPT = 10;

export type VersionWhy = 'busy' | 'changed' | 'link' | 'io';

/** Test seam: runs right before the write's state update (step 4), so a test can hold the state lock. */
export const VERSION_SEAMS: { beforeState?: () => void } = {};

/** Kept version numbers, ascending: `v<n>` folders only (links and files skipped). */
export function listVersions(ref: SkillRef): number[] {
  let names: string[];
  try {
    if (!lst(versionsDir(ref))?.isDirectory()) return [];
    names = readdirSync(versionsDir(ref));
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const m = V_DIR.exec(n);
    return m && lst(join(versionsDir(ref), n))?.isDirectory() ? [Number(m[1])] : [];
  }).sort((a, b) => a - b);
}

/** The number the next written version gets: one past both the file's own and every kept one. */
export function nextVersion(ref: SkillRef, current: number): number {
  return Math.max(current, 0, ...listVersions(ref)) + 1;
}

const intOf = (v: unknown): number => (typeof v === 'string' && /^[1-9]\d{0,5}$/.test(v) ? Number(v) : 1);

/** 2.2: what a new version resets. Uses, checked uses, where it came from and when it was added stay. */
function versionReset(s: SkillState, hash: string, asks: string, at: string): void {
  s.hash = hash;
  s.status = 'candidate';
  s.changedAt = at;
  s.firings = [];
  s.lastFails = [];
  delete s.statusWhy;
  delete s.prevStatus;
  delete s.fixHash;
  s.proposed = null;
  s.pendingWrite = null;
  const keep = new Set(asks.split(',').map((p) => p.trim()).filter(Boolean).map(phraseSha));
  if (s.cueMisses && typeof s.cueMisses === 'object') s.cueMisses = Object.fromEntries(Object.entries(s.cueMisses).filter(([k]) => keep.has(k)));
}


/* --------------------------------------------------------------- the write */

interface Commit {
  /** The new file's text, given the number it gets. */
  render: (version: number) => string;
  op: ChangeOp;
  offerId: string | null;
  /** The hash the change was computed from; null: any (a restore, the person choosing). */
  baseHash: string | null;
  lessonIds?: string[];
  /** A replace's fresh helpers: a new scripts/. */
  helpers?: CompiledSkill['helpers'] | null;
  /** A replace: the non-guardrail lessons go with the old version (P14). */
  replace?: boolean;
  /** A restore: the kept folder whose scripts/ and lessons/ come back. */
  restoreFrom?: string;
  /** The version the change was shown as: the write refuses any other number, so the bytes written are the bytes shown. */
  expect?: number;
}

type Done = { ok: true; version: number } | { ok: false; why: VersionWhy };

const clearPending = (id: string, env?: NodeJS.ProcessEnv) => {
  try { updateSkillState(id, (s) => (s ? { ...s, pendingWrite: null } : s), env); } catch { /* the marker is harmless: its hash isn't the file's */ }
};

/** 4.5 steps 1 to 6 under the store lock, then the state lock. */
function commit(ref: SkillRef, c: Commit, env: NodeJS.ProcessEnv | undefined, now: Date): Done {
  if (ref.scope !== 'personal') return { ok: false, why: 'changed' };
  try {
    return underStoreLock(env, () => commitLocked(ref, c, env, now));
  } catch (e) {
    if (e instanceof LinkError) return { ok: false, why: 'link' };
    return { ok: false, why: /busy/.test(e instanceof Error ? e.message : '') ? 'busy' : 'io' };
  }
}

function commitLocked(ref: SkillRef, c: Commit, env: NodeJS.ProcessEnv | undefined, now: Date): Done {
  // 1. The folder and the file are Trail's: no link, a regular file of at most 64 KB, Trail's own bytes.
  const dirSt = lst(ref.dir);
  if (!dirSt || dirSt.isSymbolicLink()) return { ok: false, why: dirSt ? 'link' : 'io' };
  if (!dirSt.isDirectory()) return { ok: false, why: 'io' };
  const vs = lst(versionsDir(ref));
  if (vs && !vs.isDirectory()) return { ok: false, why: 'link' };
  const fileSt = lst(ref.file);
  if (fileSt?.isSymbolicLink()) return { ok: false, why: 'link' };
  const text = regularText(ref.file);
  if (text === null) return { ok: false, why: 'changed' };
  const parsed = parseSkillMd(text, ref.name);
  const st = getSkillState(ref.id, env);
  if (!parsed || parsed.meta.trail !== ref.id || !st || st.scope !== 'personal') return { ok: false, why: 'changed' };
  const hash = skillHash(text);
  const handEdited = hash !== st.hash;
  if (c.baseHash !== null && (handEdited || hash !== c.baseHash)) return { ok: false, why: 'changed' };
  const from = intOf(parsed.meta.version);
  const to = nextVersion(ref, from);
  if (c.expect !== undefined && c.expect !== to) return { ok: false, why: 'changed' };
  const next = c.render(to);
  const nextHash = skillHash(next);
  const at = now.toISOString();
  if (!updateSkillState(ref.id, (s) => (s ? { ...s, pendingWrite: { hash: nextHash, from, at } } : s), env)) return { ok: false, why: 'busy' };

  let swap: Swap | null = null;
  try {
    // 2. The file it replaces is kept first: Trail's own as v<from>, a hand-edited one (a restore only) as hand-<date>.
    let keptAs: string | null = null;
    if (handEdited) keepHand(ref, text, now);
    else {
      keptAs = `v${from}`;
      if (keepFolder(ref, keptAs, text, join(ref.dir, 'scripts')) === 'changed') {
        clearPending(ref.id, env);
        return { ok: false, why: 'changed' };
      }
    }
    // 3. The new file (temp file and rename), and for a replace or restore its scripts.
    if (c.helpers) swap = swapScripts(ref, { helpers: c.helpers });
    else if (c.restoreFrom && lst(join(c.restoreFrom, 'scripts'))?.isDirectory()) swap = swapScripts(ref, { from: join(c.restoreFrom, 'scripts') });
    writePrivate(ref.file, next);
    if (regularText(ref.file) !== next) throw new Error('trail: the new SKILL.md did not read back');
    // 4. The state, then the ledger line. A state that can't be written puts the old file back (D68).
    VERSION_SEAMS.beforeState?.();
    const asks = String(parseSkillMd(next, ref.name)?.meta.asks ?? '');
    const done = updateSkillState(ref.id, (s) => {
      if (!s) return s;
      versionReset(s, nextHash, asks, at);
      return s;
    }, env);
    if (!done) {
      putBack(ref, text, swap);
      swap = null;
      clearPending(ref.id, env);
      return { ok: false, why: 'busy' };
    }
    try { swap?.done(); } catch { /* the old scripts stay in a dot folder nobody reads */ }
    swap = null;
    try {
      appendLedger(ref.id, { at, event: 'changed', skill: ref.id, op: c.op, from, to, offerId: c.offerId, ...(c.lessonIds?.length ? { lessonIds: c.lessonIds } : {}) }, env);
    } catch { /* the state is the truth; the ledger is its record */ }
    // 5. Lessons: folded ones move to lessons/.folded; a replace's go with the old version; a restore brings its own back.
    try {
      const files = lessonFiles(ref.dir);
      if (c.lessonIds?.length) moveLessons(ref.dir, files.filter((f) => c.lessonIds!.includes(f.id)), join(ref.dir, 'lessons', '.folded'));
      if (c.replace && keptAs) moveLessons(ref.dir, files.filter((f) => !f.guardrail), join(versionsDir(ref), keptAs, 'lessons'));
      if (c.restoreFrom && lst(join(c.restoreFrom, 'lessons'))?.isDirectory()) {
        const have = new Set(files.map((f) => f.name));
        copyFlat(join(c.restoreFrom, 'lessons'), join(ref.dir, 'lessons'), 0o600, (n) => n.endsWith('.md') && !have.has(n));
      }
    } catch { /* a lesson left riding the block is harmless */ }
    // 6. Ten kept versions.
    prune(ref, V_DIR, VERSIONS_KEPT);
    return { ok: true, version: to };
  } catch (e) {
    putBack(ref, text, swap);
    clearPending(ref.id, env);
    if (e instanceof LinkError) return { ok: false, why: 'link' };
    return { ok: false, why: 'io' };
  }
}

/** The old file (and scripts) back, when it isn't already. */
function putBack(ref: SkillRef, text: string, swap: Swap | null): void {
  try {
    if (regularText(ref.file) !== text) writePrivate(ref.file, text);
  } catch { /* the marker lets the next read tell the new file from a hand edit */ }
  try { swap?.undo(); } catch { /* scripts/ as the new version left it */ }
}

/**
 * 4.5: keeps the current file, writes `next` as the next version, updates state and the ledger. `next.meta.version`
 * must be that next number (`nextVersion`), or nothing is written: the bytes written are the bytes shown.
 */
export function writeNewVersion(ref: SkillRef, next: CompiledSkill, o: { op: ChangeOp; offerId: string | null; baseHash: string;
  lessonIds?: string[]; env?: NodeJS.ProcessEnv; now?: Date }): { ok: true; version: number } | { ok: false; why: 'busy' | 'changed' | 'link' | 'io' } {
  if (typeof o.baseHash !== 'string' || !o.baseHash) return { ok: false, why: 'changed' };
  const replace = o.op === 'replace';
  return commit(ref, {
    render: (v) => renderSkillMd({ ...next, meta: { ...next.meta, version: String(v) } }),
    op: o.op, offerId: o.offerId, baseHash: o.baseHash, lessonIds: o.op === 'extend' ? o.lessonIds : undefined,
    // A fold keeps scripts/ as it is (a rebuilt skill's helpers are names only); a replace writes the fresh compile's (R22).
    helpers: replace ? next.helpers : null, replace, expect: Number(next.meta.version),
  }, o.env, o.now ?? new Date());
}

/* ---------------------------------------------------------- hand edits (4.6) */

/** 4.6: the proposal beside a hand-edited file, the person's file kept as hand-<date>. Never touches SKILL.md. */
export function writeProposal(ref: SkillRef, next: CompiledSkill, op: FoldOp | 'replace', env?: NodeJS.ProcessEnv, now: Date = new Date()):
  { path: string; diff: string; hand: string; version: number } | null {
  if (ref.scope !== 'personal') return null;
  try {
    return underStoreLock(env, () => {
      const dirSt = lst(ref.dir);
      if (!dirSt?.isDirectory() || lst(ref.file)?.isSymbolicLink()) return null;
      const current = regularText(ref.file);
      if (current === null) return null;
      const version = intOf(next.meta.version);
      const text = renderSkillMd(next);
      const name = `proposed-v${version}`;
      // One proposal at a time: an older one goes first.
      ownDir(versionsDir(ref));
      for (const n of readdirSync(versionsDir(ref))) if (/^proposed-/.test(n) && n !== name) rmSync(join(versionsDir(ref), n), { recursive: true, force: true });
      if (lst(join(versionsDir(ref), name))) rmSync(join(versionsDir(ref), name), { recursive: true, force: true });
      keepFolder(ref, name, text, null);
      const hand = keepHand(ref, current, now);
      const done = updateSkillState(ref.id, (s) => (s ? { ...s, proposed: { hash: skillHash(text), version, op, at: now.toISOString() } } : s), env);
      if (!done) return null;
      const path = join(versionsDir(ref), name, 'SKILL.md');
      return { path, hand, version, diff: printDiff(current, text, [`${ref.name}/SKILL.md (yours)`, `${ref.name}/.versions/${name}/SKILL.md`]) };
    });
  } catch {
    return null;
  }
}

/**
 * 4.6 and R8, from a read of the file (`candidatesHere`): a file equal to an unfinished write's hash finishes it; one
 * equal to the state's hash clears a stale marker; one equal to the proposal is taken as Trail's own (adopted). True
 * when the file was adopted. One compare when nothing is pending; the locks only on a match.
 */
export function adoptIfCopied(ref: SkillRef, st: SkillState | null, fileHash: string, env?: NodeJS.ProcessEnv, now: Date = new Date()): boolean {
  if (!st || ref.scope !== 'personal' || typeof fileHash !== 'string') return false;
  const pending = st.pendingWrite && typeof st.pendingWrite === 'object' ? st.pendingWrite : null;
  const proposed = st.proposed && typeof st.proposed === 'object' ? st.proposed : null;
  if (pending && (fileHash === pending.hash || fileHash === st.hash)) {
    // Under the store lock (a try): a write still running holds it, so its own new file is never "finished" here and
    // then put back by that write (D68), which would leave Trail's file looking hand-edited. The file is read again inside.
    try {
      underStoreLock(env, () => {
        const text = regularText(ref.file);
        const now = text === null ? null : skillHash(text);
        if (now !== fileHash) return;
        const asks = fileHash === pending.hash ? String(parseSkillMd(text!, ref.name)?.meta.asks ?? '') : null;
        updateSkillState(ref.id, (s) => {
          if (!s?.pendingWrite) return s;
          if (fileHash === s.pendingWrite.hash) versionReset(s, fileHash, asks ?? '', s.pendingWrite.at);
          else if (fileHash === s.hash) s.pendingWrite = null;
          return s;
        }, env);
      }, 200);
    } catch { /* busy: the next read finishes it */ }
    return false;
  }
  if (!proposed || fileHash !== proposed.hash) return false;
  let adopted = false;
  try {
    underStoreLock(env, () => {
      const text = regularText(ref.file);
      if (text === null || skillHash(text) !== fileHash || lst(ref.dir)?.isSymbolicLink()) return;
      const asks = String(parseSkillMd(text, ref.name)?.meta.asks ?? '');
      const at = now.toISOString();
      const done = updateSkillState(ref.id, (s) => {
        if (!s?.proposed || s.proposed.hash !== fileHash) return s;
        versionReset(s, fileHash, asks, at);
        adopted = true;
        return s;
      }, env);
      if (!done || !adopted) return;
      try {
        appendLedger(ref.id, { at, event: 'changed', skill: ref.id, op: 'adopted', from: Math.max(0, proposed.version - 1), to: proposed.version, offerId: null }, env);
      } catch { /* the state is the truth */ }
      try { rmSync(join(versionsDir(ref), `proposed-v${proposed.version}`), { recursive: true, force: true }); } catch { /* left beside it */ }
    }, 200);
  } catch {
    return false;
  }
  return adopted;
}

/* ------------------------------------------------------- restore (4.12, P28) */

/**
 * 4.12, person only (the CLI checks the terminal; the agent guard denies `restore-version`): `.versions/v<n>/` back
 * as a new version. The current file is kept first (a hand-edited one as hand-<date>, R6). The restored file's
 * `version` is rewritten to the new number through the round trip; one that doesn't round-trip goes back as it is.
 */
export function restoreVersion(ref: SkillRef, version: number, env?: NodeJS.ProcessEnv, now: Date = new Date()): { ok: true; version: number } | { ok: false; why: 'unknown' | 'busy' | 'link' | 'io' } {
  if (!Number.isSafeInteger(version) || version < 1) return { ok: false, why: 'unknown' };
  const from = join(versionsDir(ref), `v${version}`);
  const fs = lst(from);
  if (fs?.isSymbolicLink() || lst(versionsDir(ref))?.isSymbolicLink()) return { ok: false, why: 'link' };
  const old = fs?.isDirectory() ? regularText(join(from, 'SKILL.md')) : null;
  const parsed = old === null ? null : parseSkillMd(old, ref.name);
  if (old === null || !parsed || parsed.meta.trail !== ref.id) return { ok: false, why: 'unknown' };
  const st = getSkillState(ref.id, env);
  const rebuilt = rebuildCompiled(old, parsed, { source: st?.source ?? null, helpers: [], runId: st?.runId ?? null });
  const r = commit(ref, {
    render: (v) => (rebuilt ? renderSkillMd({ ...rebuilt, meta: { ...rebuilt.meta, version: String(v) } }) : old),
    op: 'restore-version', offerId: null, baseHash: null, restoreFrom: from,
  }, env, now);
  if (r.ok) return r;
  return { ok: false, why: r.why === 'changed' ? 'io' : r.why };
}
