/**
 * Multi-host init: write each selected host's instruction file.
 * Selection = explicit ids > all > detected. Claude Code is handled
 * separately by src/claude/init.ts (hooks + statusline + skill).
 */
import { statSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { HOSTS, detectHosts, type DetectProbe, type HostTarget } from './registry.js';
import { upsertSection } from './sections.js';
import { registerMcpConfigs, type McpWrite } from './mcp-config.js';
import { installCodexHooks } from './codex-hooks.js';
import { installCursorHooks } from './cursor-hooks.js';
import type { ConfigWrite } from './config-write.js';
import { installAntigravitySkill } from './antigravity.js';
import { installPiOmp, installPiOmpGlobal } from './pi-omp.js';

export interface HostsInitResult {
  written: { id: string; path: string; action: string }[];
  skipped: string[];
  unknown: string[];
  mcp: McpWrite[];
  hooks: ConfigWrite[];
}

function probeFor(home: string, repo: string): DetectProbe {
  return {
    home, repo,
    dirExists: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
  };
}

function writeOwned(path: string, content: string): string {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return 'unchanged';
  mkdirSync(dirname(path), { recursive: true });
  const existed = existsSync(path);
  writeFileSync(path, content);
  return existed ? 'replaced' : 'created';
}

export function runHostsInit(
  repo: string,
  opts: {
    agents?: string[];
    all?: boolean;
    home?: string;
    mcp?: boolean;
    hooks?: boolean;
    /** false → skip every write outside the repo (the ~/.codex/ targets). */
    global?: boolean;
  } = {},
): HostsInitResult {
  const home = opts.home ?? homedir();
  const probe = probeFor(home, repo);

  let selected: HostTarget[];
  let unknown: string[] = [];
  if (opts.agents !== undefined) {
    const byId = new Map(HOSTS.map((h) => [h.id, h]));
    selected = opts.agents.flatMap((id) => byId.get(id) ?? []);
    unknown = opts.agents.filter((id) => !byId.has(id));
  } else if (opts.all) {
    selected = HOSTS;
  } else {
    selected = detectHosts(probe);
  }

  const written: HostsInitResult['written'] = [];
  for (const host of selected) {
    const path = join(repo, host.relPath);
    const action =
      host.kind === 'owned'
        ? writeOwned(path, host.content())
        : upsertSection(path, host.content()).action;
    written.push({ id: host.id, path, action });
  }
  const skipped = HOSTS.filter((h) => !selected.includes(h)).map((h) => h.id);
  const mcp =
    opts.mcp === false
      ? []
      : registerMcpConfigs(repo, selected.map((h) => h.id), { home, global: opts.global });
  // The Codex hook targets are user-level (~/.codex), so --no-global suppresses them.
  const hooks =
    opts.hooks === false || opts.global === false || !selected.some((h) => h.id === 'agents')
      ? []
      : installCodexHooks(home);
  // Cursor's hooks are repo-local (.cursor/hooks.json), matching the Cursor-only,
  // no-global posture — so --no-global does NOT suppress them; only --no-hooks does.
  const cursorHooks =
    opts.hooks === false || !selected.some((h) => h.id === 'cursor')
      ? []
      : installCursorHooks(repo);
  // Antigravity's skill is a global write too, so --no-global suppresses it as well.
  const antigravitySkill =
    opts.global === false || !selected.some((h) => h.id === 'antigravity')
      ? []
      : installAntigravitySkill(home);
  // pi/omp get the extension both ways: repo-local (Cursor posture — --no-global
  // does NOT suppress it, only --no-hooks) and user-level in the agent dir
  // (Codex/Claude posture — --no-global suppresses it). The global copy governs
  // every project; the extension itself no-ops without a graft graph in cwd.
  const piOmpRepo =
    opts.hooks === false || !selected.some((h) => h.id === 'pi' || h.id === 'omp')
      ? []
      : installPiOmp(repo, selected.map((h) => h.id));
  const piOmpGlobal =
    opts.global === false || opts.hooks === false || !selected.some((h) => h.id === 'pi' || h.id === 'omp')
      ? []
      : installPiOmpGlobal(home, selected.map((h) => h.id));
  return { written, skipped, unknown, mcp, hooks: [...hooks, ...cursorHooks, ...antigravitySkill, ...piOmpRepo, ...piOmpGlobal] };
}
