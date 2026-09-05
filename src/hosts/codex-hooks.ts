/**
 * Codex has one canonical hook representation: `~/.codex/config.toml`.
 * Older Graft releases wrote `hooks.json`; this installer migrates Graft-only
 * legacy files once, then never recreates them.
 */
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hooksShim } from '../claude/shim-template.js';
import { claudeDistDir } from '../claude/paths.js';
import type { PlannedWrite } from './plan.js';
import { writeOwned, isGraftEntry, readJsonObject, type ConfigWrite } from './config-write.js';

function dirExists(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

interface DesiredEntry { event: string; matcher?: string; sub: string; timeout: number; }

function desiredEntries(): DesiredEntry[] {
  return [
    { event: 'SessionStart', matcher: 'startup|resume|compact', sub: 'session-start', timeout: 10 },
    { event: 'UserPromptSubmit', sub: 'prompt', timeout: 15 },
    { event: 'PostToolUse', matcher: 'apply_patch|Write|Edit|MultiEdit', sub: 'post-edit', timeout: 10 },
    { event: 'Stop', sub: 'stop', timeout: 10 },
  ];
}

/** The files installing the Codex hook would touch — pure, no writes. */
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
      path: join(base, 'config.toml'),
      scope: 'global', kind: 'hook', what: 'SessionStart / UserPromptSubmit / PostToolUse / Stop',
    },
    {
      hostId: 'agents', id: 'codex-hooks-legacy',
      path: join(base, 'hooks.json'),
      scope: 'global', kind: 'hook', what: 'legacy Graft hooks retired only when Graft is their sole owner',
    },
  ];
}

function renderTomlEntries(shimPath: string): string {
  return desiredEntries().map((entry) => {
    const matcher = entry.matcher === undefined ? '' : `matcher = ${JSON.stringify(entry.matcher)}\n`;
    const command = `node ${JSON.stringify(shimPath)} ${entry.sub}`;
    return `[[hooks.${entry.event}]]\n${matcher}\n[[hooks.${entry.event}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\ntimeout = ${entry.timeout}\n`;
  }).join('\n');
}

/**
 * A Codex hook group starts at `[[hooks.<event>]]` and owns its nested handler
 * tables until the next group. Reject a mixed group rather than deleting a
 * foreign handler while replacing Graft's stale command.
 */
function stripGraftTomlGroups(content: string): string | null {
  const starts = [...content.matchAll(/^\s*\[\[hooks\.[A-Za-z]+\]\]\s*$/gm)];
  if (starts.length === 0) return content;
  let result = '';
  let offset = 0;
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index].index!;
    const end = starts[index + 1]?.index ?? content.length;
    const group = content.slice(start, end);
    if (!group.includes('graft-hooks.cjs')) continue;
    const handlerBlocks = group.split(/^\s*\[\[hooks\.[A-Za-z]+\.hooks\]\]\s*$/m).slice(1);
    if (handlerBlocks.some((block) => !block.includes('graft-hooks.cjs'))) return null;
    result += content.slice(offset, start);
    offset = end;
  }
  return result + content.slice(offset);
}

function removeGraftOnlyLegacyHooks(path: string): ConfigWrite {
  if (!existsSync(path)) return { id: 'codex-hooks-legacy', path, action: 'unchanged' };
  const loaded = readJsonObject(path);
  if (loaded === 'unparseable') return { id: 'codex-hooks-legacy', path, action: 'skipped-unparseable' };
  const hooks = loaded.root.hooks;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    return { id: 'codex-hooks-legacy', path, action: 'skipped-unparseable' };
  }
  const entries = Object.values(hooks).flatMap((value) => Array.isArray(value) ? value : [value]);
  if (!entries.every(isGraftEntry)) return { id: 'codex-hooks-legacy', path, action: 'unchanged' };
  unlinkSync(path);
  return { id: 'codex-hooks-legacy', path, action: 'deleted' };
}

/** Install Graft's Codex hooks in config.toml and retire its JSON-only legacy. */
export function installCodexHooks(home: string): ConfigWrite[] {
  const targets = hookTargets(home);
  if (targets.length === 0) return [];

  const shimPath = targets[0].path;
  const shimWrite = writeOwned('codex-hook-shim', shimPath, hooksShim(claudeDistDir()), 0o755);
  const configPath = targets[1].path;
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const withoutGraft = stripGraftTomlGroups(existing);
  if (withoutGraft === null) {
    return [shimWrite, { id: 'codex-hooks', path: configPath, action: 'skipped-unparseable' }];
  }
  const next = `${withoutGraft.trimEnd()}${withoutGraft.trimEnd() ? '\n\n' : ''}${renderTomlEntries(shimPath)}`;
  const configAction: ConfigWrite['action'] =
    next === existing ? 'unchanged' : existsSync(configPath) ? 'updated' : 'created';
  if (next !== existing) writeFileSync(configPath, next);

  const legacyWrite = removeGraftOnlyLegacyHooks(targets[2].path);
  return [shimWrite, { id: 'codex-hooks', path: configPath, action: configAction }, legacyWrite];
}
