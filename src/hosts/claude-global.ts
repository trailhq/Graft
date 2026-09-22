/**
 * User-level install for Claude Code: the copy of graft's wiring that lives
 * outside every repo.
 *
 * Why this exists. Everything `graft init` writes for Claude Code lands *in* the
 * repo — `.mcp.json` and `.claude/settings.json`. A `.gitignore` is free to ignore
 * both, and `git worktree add` checks out tracked files only, so a worktree of such
 * a repo starts with graft's shims present and neither of the two files that *point
 * at* them. No settings.json means no SessionStart hook; no `.mcp.json` means no
 * tool server. graft is absent, silently, in a tree that looks correctly wired.
 *
 * graft already carries the repair for exactly that — `reconcileWiring` rewrites
 * both files — and it is unreachable here: `runUpkeep` is called only from the hook
 * and from the MCP server, which are the two things that are missing. Seeding can't
 * help either, since it runs on the query path, which needs the server.
 *
 * So the fix cannot live in the repo. `~/.claude/` is not in anyone's working tree,
 * no `.gitignore` reaches it, and Claude Code reads it for every project — worktrees
 * included. Codex has been installed this way from the start (see ./codex-hooks.ts,
 * whose own note says the entries "fire in every repo opened with Codex, not just
 * this one"); Claude Code was the one host graft wired repo-only. This module closes
 * that gap, and is a deliberate mirror of that file.
 *
 * The repo-level writes stay exactly as they were. A project that has its own
 * `.mcp.json` and settings keeps using them; this is the floor underneath, not a
 * replacement.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hooksShim } from '../claude/shim-template.js';
import { claudeDistDir } from '../claude/paths.js';
import { mergeGraftHooks } from '../claude/settings-merge.js';
import { toPosixPath } from '../util/paths.js';
import { readJsonObject, writeOwned, type ConfigWrite } from './config-write.js';
import { mergeJsonKey, serverEntry } from './mcp-config.js';
import type { PlannedWrite } from './plan.js';

/** Same `{ id, path, action }` contract every other writer in this layer reports. */
export type GlobalWrite = ConfigWrite;

/** The directory the user-level shim lives in — the base every hook command names. */
export function globalHelpersDir(home: string): string {
  return join(home, '.claude', 'helpers');
}

/**
 * The files a user-level install would touch — pure, no writes, so `--dry-run` and
 * the picker can report them up front. All three are scoped 'global': they apply to
 * every project opened with Claude Code, not just this one.
 *
 * `~/.claude.json` holds the *user* MCP scope — the top-level `mcpServers` map, the
 * one `claude mcp add --scope user` writes. Not to be confused with the same file's
 * `projects["<abs path>"].mcpServers`, which is `--scope local` and per-directory:
 * a worktree is its own project entry there, so a local registration would miss it
 * for precisely the same reason the repo file does.
 */
export function claudeGlobalTargets(home: string): PlannedWrite[] {
  const g = (id: string, path: string, kind: PlannedWrite['kind'], what: string): PlannedWrite =>
    ({ hostId: 'claude', id, path, scope: 'global', kind, what });
  return [
    g('claude-global-shim', join(globalHelpersDir(home), 'graft-hooks.cjs'), 'hook', 'hooks shim (user level)'),
    g('claude-global-hooks', join(home, '.claude', 'settings.json'), 'hook', 'SessionStart / UserPromptSubmit / PostToolUse / Stop'),
    g('claude-global-mcp', join(home, '.claude.json'), 'mcp', 'mcpServers.graft'),
  ];
}

/** Merge graft's hook blocks into a settings file, preserving everything else. */
function upsertGlobalHooks(id: string, path: string, helpers: string): GlobalWrite {
  const loaded = readJsonObject(path);
  if (loaded === 'unparseable') return { id, path, action: 'skipped-unparseable' };
  const { root: existing, existed } = loaded;
  const before = JSON.stringify(existing);
  const { merged } = mergeGraftHooks(existing, helpers);
  if (JSON.stringify(merged) === before) return { id, path, action: 'unchanged' };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  return { id, path, action: existed ? 'updated' : 'created' };
}

/**
 * Install the user-level copy: the shim, the hook entries that call it, and the
 * user-scope MCP registration.
 *
 * The shim is written to `home` and the hook commands name it by absolute path, for
 * the reason the repo form can't be reused: `${CLAUDE_PROJECT_DIR}/.claude/helpers/`
 * resolves inside whatever project is open, and the whole point is to work in one
 * that has no such file. `hooksShim(claudeDistDir())` bakes in the installed
 * package's `dist/`, exactly as the Codex install does.
 *
 * Best-effort by contract, like every other writer here: a failure is reported as an
 * action, never raised, so a bad `~/.claude.json` can't fail a `graft init`.
 */
export function installClaudeGlobal(home: string): GlobalWrite[] {
  const [shim, settings, mcp] = claudeGlobalTargets(home);
  const out: GlobalWrite[] = [];

  try {
    out.push(writeOwned(shim.id, shim.path, hooksShim(claudeDistDir()), 0o755));
  } catch {
    out.push({ id: shim.id, path: shim.path, action: 'skipped-unparseable' });
  }

  // Only wire the hooks once the shim they call is actually on disk — a hook
  // entry pointing at a missing file is an error in every session, which is a
  // worse failure than not installing.
  if (out[0].action !== 'skipped-unparseable') {
    try {
      // Posix form in the command string: `join` gives backslashes on Windows and
      // the template appends `/graft-hooks.cjs`, so the raw path produces a mixed
      // `C:\Users\…\helpers/graft-hooks.cjs`. Node accepts forward slashes on
      // Windows, so one separator throughout is both correct and readable.
      out.push(upsertGlobalHooks(settings.id, settings.path, toPosixPath(globalHelpersDir(home))));
    } catch {
      out.push({ id: settings.id, path: settings.path, action: 'skipped-unparseable' });
    }
  }

  try {
    out.push(mergeJsonKey(mcp.id, mcp.path, 'mcpServers', serverEntry()));
  } catch {
    out.push({ id: mcp.id, path: mcp.path, action: 'skipped-unparseable' });
  }

  return out;
}
