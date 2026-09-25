// The pi / oh-my-pi (omp) host wiring for graft. pi (pi.dev) and omp share the
// same extension API — omp's hook runner loads `.omp/hooks/pre/*.ts` factories,
// pi loads `.pi/extensions/*.ts` — so one extension file serves both hosts.
//
// What graft gets on pi/omp, by channel:
//   1. orientation   -> the `agents` host already writes the AGENTS.md section;
//                       both hosts load AGENTS.md natively, nothing to add.
//   2. MCP tools     -> pi reads project `.mcp.json` via pi-mcp-adapter (and omp
//                       reads it natively), so the Claude host's `.mcp.json`
//                       write already covers them. No separate target needed.
//   3. per-prompt retrieval + edit staleness + statusline -> THIS file: graft's
//                       Claude UserPromptSubmit/PostToolUse hook work and the
//                       statusline's bar, mapped onto the extension API
//                       (before_agent_start / tool_result / turn_end setStatus).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlannedWrite } from './plan.js';
import { writeOwned, type ConfigWrite } from './config-write.js';

/** Repo-local path pi auto-discovers (after the project is trusted). */
export const PI_EXTENSION_REL = join('.pi', 'extensions', 'graft.ts');
/** Repo-local path omp's hook scanner loads (hooks/pre — hooks/ itself loads nothing). */
export const OMP_HOOK_REL = join('.omp', 'hooks', 'pre', 'graft.ts');

/**
 * The agent dir each host reads user-level extensions from: `$PI_CODING_AGENT_DIR`
 * when set, else `~/.pi/agent` (pi) / `~/.omp/agent` (omp — its config dir is the
 * only difference). Both hosts watch these dirs in every project, so an extension
 * there governs everywhere; the extension itself gates on `graft/INDEX.md` in the
 * project cwd, which is what makes a global install safe.
 */
export function piAgentDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  return override ? override : join(home, '.pi', 'agent');
}
export function ompAgentDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  return override ? override : join(home, '.omp', 'agent');
}

/** User-level extension paths, by host id. */
export function piOmpGlobalPaths(home: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    pi: join(piAgentDir(home, env), 'extensions', 'graft.ts'),
    omp: join(ompAgentDir(home, env), 'hooks', 'pre', 'graft.ts'),
  };
}

const HOSTS_DIR = dirname(fileURLToPath(import.meta.url));

/** The bundled extension source: `<pkgRoot>/dist/pi/graft-extension.ts` ships
 * beside this module the way dist/claude/*.js does. */
export function piExtensionSourcePath(): string {
  return join(HOSTS_DIR, '..', 'pi', 'graft-extension.ts');
}

/** The planned writes pi/omp need. Repo paths are scope 'repo'; the agent-dir
 * extension is scope 'global' — it governs every project, gated by the
 * extension's own graft/INDEX.md check, and --no-global suppresses it. */
export function piOmpTargets(repo: string, home: string, env: NodeJS.ProcessEnv = process.env): PlannedWrite[] {
  const globalPaths = piOmpGlobalPaths(home, env);
  return [
    { hostId: 'pi', id: 'pi', path: join(repo, PI_EXTENSION_REL), scope: 'repo', kind: 'hook', what: 'graft extension (per-prompt retrieval + stale note)' },
    { hostId: 'omp', id: 'omp', path: join(repo, OMP_HOOK_REL), scope: 'repo', kind: 'hook', what: 'graft hook (same extension, omp hook scanner)' },
    { hostId: 'pi', id: 'pi-global', path: globalPaths.pi, scope: 'global', kind: 'hook', what: 'graft extension (user level — every project; no-ops without a graft graph)' },
    { hostId: 'omp', id: 'omp-global', path: globalPaths.omp, scope: 'global', kind: 'hook', what: 'graft hook (user level — every project; no-ops without a graft graph)' },
  ];
}

/**
 * Write the extension for the hosts that were selected. Copying the same bytes
 * to both paths is deliberate: omp's scanner only reads .omp/hooks/pre, pi only
 * reads .pi/extensions, and a symlink confuses repo packaging.
 */
export function installPiOmp(repo: string, ids: string[]): ConfigWrite[] {
  const written: ConfigWrite[] = [];
  const source = piExtensionSourcePath();
  const content = readFileSync(source, 'utf8');
  const wants = (id: string) => ids.includes(id);
  if (wants('pi') || wants('omp')) {
    written.push(writeOwned('pi', join(repo, PI_EXTENSION_REL), content));
  }
  if (wants('omp')) {
    written.push(writeOwned('omp', join(repo, OMP_HOOK_REL), content));
  }
  return written;
}

/**
 * The user-level install, mirroring installClaudeGlobal: the extension into each
 * host's agent dir, where it governs every project. Safe globally precisely
 * because the extension no-ops in a project without graft/INDEX.md. Best-effort
 * by contract: a failure is reported as an action, never raised.
 */
export function installPiOmpGlobal(home: string, ids: string[], env: NodeJS.ProcessEnv = process.env): ConfigWrite[] {
  const written: ConfigWrite[] = [];
  const content = readFileSync(piExtensionSourcePath(), 'utf8');
  const paths = piOmpGlobalPaths(home, env);
  if (ids.includes('pi')) written.push(writeOwned('pi-global', paths.pi, content));
  if (ids.includes('omp')) written.push(writeOwned('omp-global', paths.omp, content));
  return written;
}

/** pi/omp detection mirrors the other CLIs: machine config dir presence. */
export function detectPiOmp(probe: { home: string; repo: string; dirExists(p: string): boolean }): { pi: boolean; omp: boolean } {
  return {
    pi: probe.dirExists(join(probe.home, '.pi')) || probe.dirExists(join(probe.repo, '.pi')),
    omp: probe.dirExists(join(probe.home, '.omp')) || probe.dirExists(join(probe.repo, '.omp')),
  };
}
