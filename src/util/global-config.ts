/**
 * User-level (machine-wide) trail configuration: ~/.trail/config.json
 *
 * Separate from the per-repo `.trail/config.json` (build flags, git-ignored)
 * and the per-workspace `.trail/knowledge-repos.json` (committable, team-shared).
 *
 * This file holds preferences that belong to the developer, not to any specific
 * project: e.g. the knowledge repo URL used across all workspaces.
 *
 * Resolution order for knowledge repo:
 *   1. Per-workspace `.trail/knowledge-repos.json` (explicit, team-committed)
 *   2. Global `~/.trail/config.json`  (user default, applies everywhere)
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { trailHome } from '../notes/trail-home.js';
import { readJson, writeJsonAtomic } from './state.js';

export interface GlobalConfig {
  /** Primary knowledge repo Git URL. Used by `trail note --team` and cloned
   *  by `trail init` when no per-workspace knowledge repo is configured. */
  knowledgeRepo?: string;
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(trailHome(env), 'config.json');
}

export function readGlobalConfig(env: NodeJS.ProcessEnv = process.env): GlobalConfig {
  return readJson<GlobalConfig>(globalConfigPath(env)) ?? {};
}

export function writeGlobalConfig(cfg: GlobalConfig, env: NodeJS.ProcessEnv = process.env): void {
  const dir = trailHome(env);
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(globalConfigPath(env), cfg);
}

export function patchGlobalConfig(patch: Partial<GlobalConfig>, env: NodeJS.ProcessEnv = process.env): void {
  writeGlobalConfig({ ...readGlobalConfig(env), ...patch }, env);
}
