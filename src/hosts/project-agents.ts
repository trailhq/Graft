/**
 * The vendor-neutral, project-scoped Agent-Skills-standard wiring.
 *
 * `.agents/skills/<name>/SKILL.md` is the one location multiple agents read
 * natively (pi documents it; droid's skills doc lists it as its compatibility
 * scope) — so one write covers every standard-reading tool in the repo, and
 * any future one, without a registry row per vendor. The always-on half
 * (AGENTS.md) comes from the `project-agents` host's own registry entry; this
 * module is the skill half.
 *
 * `projectAgentSkillTargets()` is the pure "which files would this touch" half
 * (for `graft init --dry-run` / the picker); `installProjectAgentSkill()` does
 * the write.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { skillTemplate } from '../claude/skill-template.js';
import type { PlannedWrite } from './plan.js';
import type { ConfigWrite } from './config-write.js';

/** The skill file path, under the repo's shared Agent-Skills dir. */
function skillPath(repo: string): string {
  return join(repo, '.agents', 'skills', 'graft', 'SKILL.md');
}

/** The files installing the project-standard skill would touch — pure, no writes. */
export function projectAgentSkillTargets(repo: string): PlannedWrite[] {
  return [
    {
      hostId: 'project-agents', id: 'project-agents-skill',
      path: skillPath(repo),
      scope: 'repo', kind: 'skill', what: 'graft skill (.agents/skills standard)',
    },
  ];
}

/** Write graft's skill into `<repo>/.agents/skills/graft/SKILL.md`, idempotently. */
export function installProjectAgentSkill(repo: string): ConfigWrite[] {
  const path = skillPath(repo);
  const content = skillTemplate();
  const existed = existsSync(path);
  if (existed && readFileSync(path, 'utf8') === content) {
    return [{ id: 'project-agents-skill', path, action: 'unchanged' }];
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return [{ id: 'project-agents-skill', path, action: existed ? 'updated' : 'created' }];
}
