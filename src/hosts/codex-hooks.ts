/**
 * Active-layer install for CLI agents that read user-level hooks.json with
 * PostToolUse semantics. Writes the shared hook shim and one PostToolUse
 * entry that runs post-edit + background sync after every file edit.
 */
import { writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hooksShim } from '../claude/shim-template.js';
import { failOpen } from '../claude/settings-merge.js';
import type { PlannedWrite } from './plan.js';
import { writeOwned, isGraftEntry, readJsonObject, type ConfigWrite } from './config-write.js';

function dirExists(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * The files installing the Codex hook would touch — pure, no writes. Both live
 * under `~/.codex`, so both are scoped 'global': the hook entries fire in every
 * repo opened with Codex, not just this one. Empty when the CLI isn't installed,
 * mirroring `installCodexHooks`' early return.
 */
export function hookTargets(home: string): PlannedWrite[] {
  const base = join(home, '.codex');
  if (!dirExists(base)) return [];
  return [
    {
      hostId: 'agents', id: 'codex-hook-shim',
      path: join(base, 'hooks', 'graft', 'graft-hooks.cjs'),
      scope: 'global', kind: 'hook', what: 'post-edit hook shim',
    },
    {
      hostId: 'agents', id: 'codex-hooks',
      path: join(base, 'hooks.json'),
      scope: 'global', kind: 'hook', what: 'SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop',
    },
  ];
}

/**
 * The Trail hook entries Codex should carry, mirroring the Claude Code set:
 *   - SessionStart → orientation from `graft/INDEX.md`, and the skills part (startup, resume, clear, compact)
 *   - UserPromptSubmit → the coupling-seed retrieval pack (the accuracy hook)
 *   - PostToolUse (an edit) → blast radius + mark the graph dirty
 *   - PostToolUse (Bash) → `codex-post-bash`: the skills mark for a shell call; Codex fires PostToolUse on every
 *     exit (it has no PostToolUseFailure), so the exit comes from the output's header (design 3.4)
 *   - PreToolUse (Bash) → pre-bash, before every shell command
 *   - Stop → one background graph sync at turn end, and the skills part
 * `matcher` is omitted where Codex ignores it (UserPromptSubmit, Stop). The edit
 * matcher includes `apply_patch` — Codex's native edit tool — alongside the
 * Claude Code edit-tool names, and `hooks.ts`'s `editedFilePath` reads the touched
 * file out of either shape.
 *
 * P33: Codex trusts a hook by a key made of the file, the event, the group's index and the handler's index, and a
 * hash of the entry (HC8), so these bytes and their places are kept from 0.26.0 on: a changed or moved entry goes
 * back to untrusted and silently stops running. 0.26.0 changed them once (D125). A test pins every byte.
 */
interface DesiredEntry { event: string; matcher?: string; sub: string; timeout: number; }
const DESIRED: readonly DesiredEntry[] = Object.freeze([
  // `timeout` is in seconds, as Codex (like Claude Code) reads it.
  { event: 'SessionStart', matcher: 'startup|resume|clear|compact', sub: 'session-start', timeout: 10 },
  { event: 'UserPromptSubmit', sub: 'prompt', timeout: 15 },
  { event: 'PostToolUse', matcher: 'apply_patch|Write|Edit|MultiEdit', sub: 'post-edit', timeout: 10 },
  { event: 'PostToolUse', matcher: 'Bash', sub: 'codex-post-bash', timeout: 5 },
  // Before every shell command, failing open; 5 (seconds) caps what a wedged hook can add.
  { event: 'PreToolUse', matcher: 'Bash', sub: 'pre-bash', timeout: 5 },
  { event: 'Stop', sub: 'stop', timeout: 10 },
]);

/** Each entry Trail writes into `~/.codex/hooks.json`, in order, with the exact bytes it writes (P33). */
export function desiredCodexEntries(shimPath: string): Array<{ event: string; sub: string; entry: Record<string, unknown> }> {
  return DESIRED.map((d) => {
    // D116 item 6: every event fails open, like PreToolUse, so a missing shim never shows a hook error.
    const handler = { type: 'command', command: failOpen(`node "${shimPath}" ${d.sub}`), timeout: d.timeout };
    const entry = d.matcher ? { matcher: d.matcher, hooks: [handler] } : { hooks: [handler] };
    return { event: d.event, sub: d.sub, entry };
  });
}

const SUB = /(?:graft|trail)-hooks\.cjs"?\s+([a-z][\w-]{0,40})/;
const handlersOf = (entry: unknown): unknown[] => {
  const hooks = entry && typeof entry === 'object' ? (entry as { hooks?: unknown }).hooks : undefined;
  return Array.isArray(hooks) ? hooks : [];
};
/** The sub-command one handler runs (`… graft-hooks.cjs" post-edit || exit 0` gives `post-edit`), or null. */
function handlerSub(h: unknown): string | null {
  const c = h && typeof h === 'object' ? (h as { command?: unknown }).command : undefined;
  const m = typeof c === 'string' ? SUB.exec(c) : null;
  return m ? m[1]! : null;
}
/** The sub-command a Trail entry runs, or null. */
const subOf = (entry: unknown): string | null => handlersOf(entry).map(handlerSub).find((x) => x !== null) ?? null;
/** A group that also holds a handler of the person's own: only Trail's handler in it is Trail's to write. */
const mixed = (entry: unknown): boolean => handlersOf(entry).some((h) => handlerSub(h) === null);

/**
 * One event's entries with Trail's written in place (4.17): each wanted entry replaces the Trail entry running the
 * same sub-command, where it is; a wanted entry with none takes the place of a Trail entry whose sub-command Trail no
 * longer writes, else goes at the end. A doubled Trail entry goes, unless a foreign entry comes after it (removing it
 * would move that one, and Codex keys trust by index, P33). A group mixing a handler of the person's own with Trail's
 * keeps its shape: only Trail's handler in it is written, so the person's keeps its place.
 */
function mergeEvent(prior: unknown[], wanted: Array<{ sub: string; entry: Record<string, unknown> }>): unknown[] {
  const out: unknown[] = [...prior];
  const trail = prior.map((e, i) => (isGraftEntry(e) ? i : -1)).filter((i) => i >= 0);
  const used = new Set<number>();
  const missing: typeof wanted = [];
  const put = (at: number, w: { sub: string; entry: Record<string, unknown> }) => {
    const p = prior[at];
    if (mixed(p)) {
      const handler = handlersOf(w.entry)[0];
      out[at] = { ...(p as Record<string, unknown>), hooks: handlersOf(p).map((h) => (handlerSub(h) !== null ? handler : h)) };
    } else out[at] = w.entry;
    used.add(at);
  };
  for (const w of wanted) {
    const at = trail.find((i) => !used.has(i) && subOf(prior[i]) === w.sub);
    if (at === undefined) { missing.push(w); continue; }
    put(at, w);
  }
  const subs = new Set(wanted.map((w) => w.sub));
  const tail: unknown[] = [];
  for (const w of missing) {
    const at = trail.find((i) => !used.has(i) && !mixed(prior[i]) && !subs.has(subOf(prior[i]) ?? ''));
    if (at === undefined) { tail.push(w.entry); continue; }
    put(at, w);
  }
  const foreignAfter = (i: number) => prior.some((e, j) => j > i && (!isGraftEntry(e) || mixed(e)));
  const keep = (i: number) => !trail.includes(i) || used.has(i) || mixed(prior[i]) || foreignAfter(i);
  return [...out.filter((_, i) => keep(i)), ...tail];
}

export function installCodexHooks(home: string): ConfigWrite[] {
  const targets = hookTargets(home);
  if (targets.length === 0) return [];

  const shimPath = targets[0].path;
  const shimWrite = writeOwned('codex-hook-shim', shimPath, hooksShim(), 0o755);
  const cfgPath = targets[1].path;
  const skipped: ConfigWrite = { id: 'codex-hooks', path: cfgPath, action: 'skipped-unparseable' };

  const loaded = readJsonObject(cfgPath);
  if (loaded === 'unparseable') return [shimWrite, skipped];
  const { root, existed } = loaded;
  const before = JSON.stringify(root);
  const hooks = (root.hooks ??= {});
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return [shimWrite, skipped];

  const byEvent = new Map<string, Array<{ sub: string; entry: Record<string, unknown> }>>();
  for (const d of desiredCodexEntries(shimPath)) {
    const list = byEvent.get(d.event) ?? [];
    list.push({ sub: d.sub, entry: d.entry });
    byEvent.set(d.event, list);
  }
  for (const [event, wanted] of byEvent) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) return [shimWrite, skipped];
    // Foreign entries in this event are kept where they are; Trail's are replaced in place (P33).
    hooks[event] = mergeEvent(Array.isArray(hooks[event]) ? hooks[event] : [], wanted);
  }

  if (JSON.stringify(root) === before) return [shimWrite, { id: 'codex-hooks', path: cfgPath, action: 'unchanged' }];
  writeFileSync(cfgPath, `${JSON.stringify(root, null, 2)}\n`);
  return [shimWrite, { id: 'codex-hooks', path: cfgPath, action: existed ? 'updated' : 'created' }];
}
