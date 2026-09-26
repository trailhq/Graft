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
 * The same directory as a hook *command* names it: through the shell's home
 * variable, not the expanded absolute path.
 *
 * `~/.claude/settings.json` is a file people keep in version control, so it comes
 * back on the next machine from a clone. An expanded `/Users/<someone>/.claude/helpers`
 * is right only for the account that ran `graft init`; on any other one the five
 * hook commands point at a directory that does not exist. Nothing reports that —
 * a hook whose command fails is a hook that does not run — so session-start,
 * prompt, stop, post-edit and tool-savings all go silently inert while graft still
 * looks wired. `graft init` rewrites those entries on every run, so editing the
 * file by hand does not stick either.
 *
 * `$HOME` is available here where `${CLAUDE_PROJECT_DIR}` is not: Claude Code runs
 * hook commands through a shell, so the variable expands when the hook fires, and
 * it is not project-relative — a user-level shim has to work in a project that has
 * no repo-level copy (see {@link installClaudeGlobal}).
 *
 * Windows takes `%USERPROFILE%` because cmd.exe has no `$HOME`. An unexpanded
 * `$HOME` would point the five hooks at a literal `$HOME` directory, trading the
 * portability gain for a real regression on the one platform where the expanded
 * path still works.
 *
 * This is only about the string that lands in the generated config. `homedir()` is
 * still the right thing for where the shim itself is written, which is why
 * {@link globalHelpersDir} is unchanged and still takes the expanded path.
 */
export function globalHelpersCmdDir(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? '%USERPROFILE%/.claude/helpers' : '$HOME/.claude/helpers';
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
 * The shim is written to the expanded `home`, but the hook *commands* name it
 * through the shell's home variable ({@link globalHelpersCmdDir}) rather than by
 * absolute path. `${CLAUDE_PROJECT_DIR}/.claude/helpers/` cannot be reused here:
 * it resolves inside whatever project is open, and the whole point is to work in
 * one that has no such file — while a literal `/Users/<someone>/…` is correct only
 * on the machine that ran this, and silently inert on the next one.
 * `hooksShim(claudeDistDir())` bakes in the installed package's `dist/`, exactly
 * as the Codex install does.
 *
 * `platform` is a parameter for the same reason `home` is: the command form is
 * the one platform-dependent string in this file, and a test has to be able to
 * assert the Windows form from a POSIX runner.
 *
 * Best-effort by contract, like every other writer here: a failure is reported as an
 * action, never raised, so a bad `~/.claude.json` can't fail a `graft init`.
 */
export function installClaudeGlobal(home: string, platform: NodeJS.Platform = process.platform): GlobalWrite[] {
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
      // Posix separators throughout: the template appends `/graft-hooks.cjs`, and
      // `globalHelpersCmdDir` is already posix on every platform, so a Windows
      // `C:\Users\…` never mixes with a `/`. Node accepts forward slashes there.
      out.push(upsertGlobalHooks(settings.id, settings.path, globalHelpersCmdDir(platform)));
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
