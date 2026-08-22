/**
 * Active-layer install for CLI agents that read user-level hooks.json with
 * PostToolUse semantics. Writes the shared hook shim and one PostToolUse
 * entry that runs post-edit + background sync after every file edit.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hooksShim } from '../claude/shim-template.js';
import { claudeDistDir } from '../claude/paths.js';
import type { PlannedWrite } from './plan.js';

export interface HookWrite {
  id: string;
  path: string;
  action: 'created' | 'updated' | 'unchanged' | 'skipped-unparseable';
}

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
      scope: 'global', kind: 'hook', what: 'SessionStart / UserPromptSubmit / PostToolUse / Stop',
    },
  ];
}

function writeOwned(id: string, path: string, content: string, mode?: number): HookWrite {
  const existed = existsSync(path);
  if (existed && readFileSync(path, 'utf8') === content) {
    if (mode !== undefined && (statSync(path).mode & 0o777) !== mode) chmodSync(path, mode);
    return { id, path, action: 'unchanged' };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
  return { id, path, action: existed ? 'updated' : 'created' };
}

function isGraftEntry(entry: unknown): boolean {
  return JSON.stringify(entry).includes('graft-hooks.cjs');
}

/**
 * The graft hook entries Codex should carry, mirroring the Claude Code set:
 *   - SessionStart → orientation from `graft/INDEX.md`
 *   - UserPromptSubmit → the coupling-seed retrieval pack (the accuracy hook)
 *   - PostToolUse (an edit) → blast radius + mark the graph dirty
 *   - Stop → one background graph sync at turn end (not after every edit)
 * `matcher` is omitted where Codex ignores it (UserPromptSubmit, Stop). The edit
 * matcher includes `apply_patch` — Codex's native edit tool — alongside the
 * Claude Code edit-tool names, and `hooks.ts`'s `editedFilePath` reads the touched
 * file out of either shape.
 */
interface DesiredEntry { event: string; matcher?: string; sub: string; timeout: number; }
function desiredEntries(): DesiredEntry[] {
  return [
    { event: 'SessionStart', matcher: 'startup|resume|compact', sub: 'session-start', timeout: 10000 },
    { event: 'UserPromptSubmit', sub: 'prompt', timeout: 15000 },
    { event: 'PostToolUse', matcher: 'apply_patch|Write|Edit|MultiEdit', sub: 'post-edit', timeout: 10000 },
    { event: 'Stop', sub: 'stop', timeout: 10000 },
  ];
}

export function installCodexHooks(home: string): HookWrite[] {
  const targets = hookTargets(home);
  if (targets.length === 0) return [];

  const shimPath = targets[0].path;
  const shimWrite = writeOwned('codex-hook-shim', shimPath, hooksShim(claudeDistDir()), 0o755);
  const skipped: HookWrite = { id: 'codex-hooks', path: targets[1].path, action: 'skipped-unparseable' };

  const cfgPath = targets[1].path;
  let root: Record<string, any> = {};
  const existed = existsSync(cfgPath);
  if (existed) {
    try { root = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { return [shimWrite, skipped]; }
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return [shimWrite, skipped];
  const before = JSON.stringify(root);
  const hooks = (root.hooks ??= {});
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return [shimWrite, skipped];

  for (const d of desiredEntries()) {
    if (hooks[d.event] !== undefined && !Array.isArray(hooks[d.event])) return [shimWrite, skipped];
    const prior: unknown[] = Array.isArray(hooks[d.event]) ? hooks[d.event] : [];
    const handler = { type: 'command', command: `node "${shimPath}" ${d.sub}`, timeout: d.timeout };
    const entry = d.matcher ? { matcher: d.matcher, hooks: [handler] } : { hooks: [handler] };
    // Preserve foreign entries in this event; replace any prior graft entry so an
    // upgrade re-points to the current shim/sub-command instead of stacking.
    hooks[d.event] = [...prior.filter((e) => !isGraftEntry(e)), entry];
  }

  if (JSON.stringify(root) === before) return [shimWrite, { id: 'codex-hooks', path: cfgPath, action: 'unchanged' }];
  writeFileSync(cfgPath, `${JSON.stringify(root, null, 2)}\n`);
  return [shimWrite, { id: 'codex-hooks', path: cfgPath, action: existed ? 'updated' : 'created' }];
}
