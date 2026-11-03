/**
 * Read team knowledge files for injection into the Claude session-start context.
 *
 * Reads:
 *   - `knowledge/global/*.md` — always injected (team-wide policies)
 *   - `knowledge/agents/claude/WORKFLOW.md` — Claude-specific instructions
 *   - `knowledge/apps/<appName>/*.md` — app-specific docs (when repo name matches)
 *
 * Called from `hooks.ts` session-start, after auto-pull of the knowledge repo.
 * Returns null when no knowledge repo is configured/found.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

/**
 * Collect knowledge files from a directory, sorted alphabetically.
 * Returns an array of { name, content } pairs.
 */
function readMdFiles(dir: string): Array<{ name: string; content: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .map((f) => ({ name: basename(f, '.md'), content: readFileSync(join(dir, f), 'utf8').trim() }))
    .filter((f) => f.content.length > 0);
}

/**
 * Build the "Team Knowledge" section to inject at session start.
 *
 * @param knowledgeRepoDir  Absolute path to the cloned knowledge repo.
 * @param sessionDir        The repo directory this session opened in.
 */
export function buildKnowledgeContext(knowledgeRepoDir: string, sessionDir: string): string | null {
  const sections: string[] = [];

  // 1. Global policies (always injected)
  const globalFiles = readMdFiles(join(knowledgeRepoDir, 'knowledge', 'global'));
  for (const f of globalFiles) sections.push(f.content);

  // 2. Claude-specific instructions
  const claudeWorkflow = join(knowledgeRepoDir, 'knowledge', 'agents', 'claude', 'WORKFLOW.md');
  if (existsSync(claudeWorkflow)) {
    const content = readFileSync(claudeWorkflow, 'utf8').trim();
    if (content) sections.push(content);
  }

  // 3. App-specific docs: match repo basename to knowledge/apps/<name>/
  const appName = basename(sessionDir);
  const appFiles = readMdFiles(join(knowledgeRepoDir, 'knowledge', 'apps', appName));
  for (const f of appFiles) sections.push(f.content);

  if (sections.length === 0) return null;

  return [
    '## 📚 Team Knowledge',
    '',
    sections.join('\n\n---\n\n'),
  ].join('\n');
}
