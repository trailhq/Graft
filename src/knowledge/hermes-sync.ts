/**
 * Sync Hermes skills from a knowledge repo's `knowledge/agents/hermes/` directory
 * to the local Hermes skills folder (`~/.hermes/skills/team/`).
 *
 * Each `.md` file in that directory is a SKILL.md (Hermes frontmatter + body).
 * The skill name is derived from the filename (without extension).
 *
 * Called by:
 *   - `trail init` after cloning/detecting a knowledge repo
 *   - Manually via `trail knowledge sync` (future)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

/** Where Hermes stores skills on this platform. */
export function hermesSkillsRoot(home: string = homedir()): string | null {
  const local = process.env.LOCALAPPDATA;
  if (process.platform === 'win32' && local) {
    const p = join(local, 'hermes', 'skills');
    return existsSync(p) ? p : null;
  }
  const p = join(home, '.hermes', 'skills');
  return existsSync(p) ? p : null;
}

/**
 * Sync all `.md` files from `<knowledgeRepo>/knowledge/agents/hermes/`
 * to `<hermesSkillsRoot>/team/<name>/SKILL.md`.
 *
 * Returns the number of skills written (0 if Hermes not installed or no files).
 */
export function syncHermesKnowledgeSkills(knowledgeRepoDir: string, home: string = homedir()): number {
  const srcDir = join(knowledgeRepoDir, 'knowledge', 'agents', 'hermes');
  if (!existsSync(srcDir)) return 0;

  const skillsRoot = hermesSkillsRoot(home);
  if (!skillsRoot) return 0;   // Hermes not installed on this machine

  const teamDir = join(skillsRoot, 'team');
  mkdirSync(teamDir, { recursive: true });

  const files = readdirSync(srcDir).filter((f) => f.endsWith('.md'));
  let written = 0;
  for (const file of files) {
    const name = basename(file, '.md');
    const destDir = join(teamDir, name);
    mkdirSync(destDir, { recursive: true });
    const content = readFileSync(join(srcDir, file), 'utf8');
    writeFileSync(join(destDir, 'SKILL.md'), content, 'utf8');
    written++;
  }
  return written;
}
