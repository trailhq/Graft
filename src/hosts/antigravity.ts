/**
 * Antigravity-specific global writes that don't fit the per-repo host model.
 *
 * Antigravity loads "shared" skills — available to every workspace — from
 * `~/.gemini/skills/`. graft's skill card is the same one Claude Code and AdaL get;
 * placing it here is the skill half of first-class Antigravity support (#62). The
 * instruction file (AGENTS.md) and MCP registration are handled by the `antigravity`
 * host in the registry and `mcp-config.ts` respectively.
 *
 * `antigravitySkillTargets()` is the pure "which files would this touch" half (for
 * `graft init --dry-run` / the picker); `installAntigravitySkill()` does the write.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { skillTemplate } from '../claude/skill-template.js';
import type { PlannedWrite } from './plan.js';
import type { HookWrite } from './codex-hooks.js';

/** The skill file path, under the user's global Antigravity skills dir. */
function skillPath(home: string): string {
  return join(home, '.gemini', 'skills', 'graft', 'SKILL.md');
}

/** The files installing Antigravity's global skill would touch — pure, no writes. */
export function antigravitySkillTargets(home: string): PlannedWrite[] {
  return [
    {
      hostId: 'antigravity', id: 'antigravity-skill',
      path: skillPath(home),
      scope: 'global', kind: 'skill', what: 'graft skill (shared)',
    },
  ];
}

/** Write graft's skill into `~/.gemini/skills/graft/SKILL.md`, idempotently. */
export function installAntigravitySkill(home: string): HookWrite[] {
  const path = skillPath(home);
  const content = skillTemplate();
  const existed = existsSync(path);
  if (existed && readFileSync(path, 'utf8') === content) {
    return [{ id: 'antigravity-skill', path, action: 'unchanged' }];
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return [{ id: 'antigravity-skill', path, action: existed ? 'updated' : 'created' }];
}
