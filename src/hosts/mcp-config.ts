/**
 * Register the graft MCP server in each host's config.
 * JSON hosts get a keyed merge (other servers preserved; unparseable files
 * are never rewritten). TOML hosts get the same graft-entry merge: a missing
 * `[mcp_servers.graft]` is appended, an existing one has its command/args
 * updated when the runner changes.
 *
 * `mcpTargets()` is the pure "which files would this touch" half, so `graft
 * init --dry-run` and the picker can report paths without writing;
 * `registerMcpConfigs()` walks that same list to do the writing.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { PlannedWrite } from './plan.js';

export interface McpWrite {
  id: string;
  path: string;
  action: 'created' | 'updated' | 'unchanged' | 'skipped-unparseable';
}

/** A planned MCP write, plus the detail needed to actually perform it. */
export interface McpTarget extends PlannedWrite {
  format: 'json' | 'toml';
  /** JSON only: the top-level key holding the server map. */
  topKey?: string;
  /** The server entry to merge in under `graft` (JSON object, or `{command,args}` for TOML). */
  entry?: object;
}

/**
 * How to launch the MCP server, decided once at init time.
 *
 * These files get committed and shared, so the command is a bare name, never an
 * absolute path — this repo already carries the scar of a checked-in hook shim
 * with another machine's home directory baked into it.
 *
 * Priority:
 *   1. `--runner` (explicit, always wins)
 *   2. `GRAFT_MCP_NPX=1` (escape hatch / test pin → npx)
 *   3. lockfile in the repo: bun.lock(b) → bunx, pnpm-lock.yaml → pnpm dlx,
 *      yarn.lock → yarn dlx. A bun/pnpm/yarn repo's committed config should
 *      spawn that runner, even if the person who ran `graft init` has `graft`
 *      on PATH — otherwise teammates without a global install (or without npm)
 *      inherit a command that cannot run.
 *   4. `graft` on PATH (the installed binary is ~80 ms to handshake vs ~211 ms
 *      for `npx -y`; the cheap half of a slow-handshake fix, not the whole of it)
 *   5. `npx -y`
 *
 * bunx auto-installs (no `-y`). `pnpm dlx` / `yarn dlx` likewise fetch without
 * a prompt. npx still needs `-y` so the MCP host isn't blocked on "Ok to proceed?".
 * bunx is *not* passed `--bun`: graft's shebang is node and the tree-sitter
 * addons expect it; bunx still fetches the package without npm.
 */
export type PackageRunner = 'npx' | 'bunx' | 'pnpm' | 'yarn';
export const PACKAGE_RUNNERS: readonly PackageRunner[] = ['npx', 'bunx', 'pnpm', 'yarn'];

export interface McpLaunch {
  command: string;
  args: string[];
}

const GRAFT_PKG = '@nanonets/graft';
const NPX_LAUNCH: McpLaunch = { command: 'npx', args: ['-y', GRAFT_PKG, 'mcp'] };
const BIN_LAUNCH: McpLaunch = { command: 'graft', args: ['mcp'] };

const LOCKFILE_RUNNERS: { files: string[]; runner: PackageRunner }[] = [
  { files: ['bun.lock', 'bun.lockb'], runner: 'bunx' },
  { files: ['pnpm-lock.yaml'], runner: 'pnpm' },
  { files: ['yarn.lock'], runner: 'yarn' },
];

export function isPackageRunner(value: string): value is PackageRunner {
  return (PACKAGE_RUNNERS as readonly string[]).includes(value);
}

/** bun.lock(b) > pnpm-lock.yaml > yarn.lock > npx. package-lock.json is npx. */
export function detectPackageRunner(dir: string): PackageRunner {
  for (const { files, runner } of LOCKFILE_RUNNERS) {
    if (files.some((f) => existsSync(join(dir, f)))) return runner;
  }
  return 'npx';
}

export function launchForRunner(runner: PackageRunner): McpLaunch {
  switch (runner) {
    case 'bunx': return { command: 'bunx', args: [GRAFT_PKG, 'mcp'] };
    case 'pnpm': return { command: 'pnpm', args: ['dlx', GRAFT_PKG, 'mcp'] };
    case 'yarn': return { command: 'yarn', args: ['dlx', GRAFT_PKG, 'mcp'] };
    default: return NPX_LAUNCH;
  }
}

function graftOnPath(): boolean {
  const r = spawnSync('graft', ['--version'], { stdio: 'ignore', timeout: 5000 });
  return r.status === 0;
}

function npxForced(): boolean {
  const forced = process.env.GRAFT_MCP_NPX;
  return forced !== undefined && forced !== '' && forced !== '0' && forced !== 'false';
}

/**
 * JSON hosts: `{ command, args }`.
 *
 * `opts.runner` is `--runner` — explicit, always wins. `GRAFT_MCP_NPX=1` forces
 * the `npx` form when no runner was given: the escape hatch for a machine whose
 * global install is stale or shadowed, and what the tests set so their
 * expectations don't depend on whether the machine running them happens to have
 * graft installed. `opts.onPath` is the same override for direct unit tests of
 * the PATH vs fallback branches. `opts.cwd` is the repo whose lockfile is read.
 */
export function serverEntry(opts: { onPath?: boolean; runner?: PackageRunner; cwd?: string } = {}): McpLaunch {
  if (opts.runner) return launchForRunner(opts.runner);
  if (npxForced()) return NPX_LAUNCH;
  const detected = detectPackageRunner(opts.cwd ?? process.cwd());
  if (detected !== 'npx') return launchForRunner(detected);
  return (opts.onPath ?? graftOnPath()) ? BIN_LAUNCH : NPX_LAUNCH;
}

function opencodeEntry(launch: McpLaunch): object {
  return { type: 'local', command: [launch.command, ...launch.args], enabled: true };
}

function dirExists(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export function mergeJsonKey(id: string, path: string, topKey: string, entry: object): McpWrite {
  let root: Record<string, any> = {};
  const existed = existsSync(path);
  if (existed) {
    try {
      root = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return { id, path, action: 'skipped-unparseable' };
    }
  }
  const bucket = (root[topKey] ??= {});
  if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket)) {
    return { id, path, action: 'skipped-unparseable' };
  }
  if (JSON.stringify(bucket.graft) === JSON.stringify(entry)) return { id, path, action: 'unchanged' };
  const action = existed ? 'updated' : 'created';
  bucket.graft = entry;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  return { id, path, action };
}

function graftTomlBlock(launch: McpLaunch): string {
  const argList = launch.args.map((a) => JSON.stringify(a)).join(', ');
  return `[mcp_servers.graft]\ncommand = "${launch.command}"\nargs = [${argList}]\n`;
}

/** The `[name]` table, up to (not including) the next table header. */
function tomlTable(text: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\[${escaped}\\](?:\\n(?!\\[).*)*`, 'm');
  const m = text.match(re);
  return m ? m[0] : null;
}

function tomlTableHasLaunch(table: string, launch: McpLaunch): boolean {
  const argList = launch.args.map((a) => JSON.stringify(a)).join(', ');
  return table.includes(`command = "${launch.command}"`) && table.includes(`args = [${argList}]`);
}

function upsertCodexToml(id: string, path: string, launch: McpLaunch): McpWrite {
  const section = graftTomlBlock(launch);
  const existed = existsSync(path);
  const text = existed ? readFileSync(path, 'utf8') : '';
  const current = tomlTable(text, 'mcp_servers.graft');
  if (current !== null) {
    if (tomlTableHasLaunch(current, launch)) return { id, path, action: 'unchanged' };
    const next = text.replace(current, section.trimEnd());
    writeFileSync(path, next);
    return { id, path, action: 'updated' };
  }
  const sep = text.length === 0 ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${text}${sep}${section}`);
  return { id, path, action: existed ? 'updated' : 'created' };
}

function jsonTarget(
  hostId: string,
  id: string,
  path: string,
  topKey: string,
  entry: object,
  scope: PlannedWrite['scope'] = 'repo',
): McpTarget {
  return { hostId, id, path, scope, kind: 'mcp', what: `${topKey}.graft`, format: 'json', topKey, entry };
}

/**
 * The MCP config files selecting these hosts would touch — pure, no writes.
 * Codex's target is the user-level `~/.codex/config.toml`, so it is scoped
 * 'global': registering there affects every project on the machine.
 */
export function mcpTargets(
  repo: string,
  ids: string[],
  opts: { home?: string; runner?: PackageRunner } = {},
): McpTarget[] {
  const home = opts.home ?? homedir();
  const entry = serverEntry({ runner: opts.runner, cwd: repo });
  const out: McpTarget[] = [];
  for (const id of ids) {
    switch (id) {
      case 'cursor':
        out.push(jsonTarget(id, id, join(repo, '.cursor', 'mcp.json'), 'mcpServers', entry));
        break;
      case 'gemini':
        out.push(jsonTarget(id, id, join(repo, '.gemini', 'settings.json'), 'mcpServers', entry));
        break;
      case 'antigravity':
        // Antigravity reads MCP from its OWN registry, separate from Gemini CLI's
        // `.gemini/settings.json` — a global `~/.gemini/config/mcp_config.json` (the
        // gap #62 reported). Standard `{command,args}` under `mcpServers`. Global
        // scope: it applies to every workspace opened in Antigravity.
        out.push(
          jsonTarget(id, 'antigravity', join(home, '.gemini', 'config', 'mcp_config.json'), 'mcpServers', entry, 'global'),
        );
        break;
      case 'kiro':
        out.push(jsonTarget(id, id, join(repo, '.kiro', 'settings', 'mcp.json'), 'mcpServers', entry));
        break;
      case 'grok':
        // Grok reads MCP from repo-level `.grok/config.toml` (`[mcp_servers.<name>]`),
        // the same TOML shape Codex uses at ~/.codex/config.toml.
        out.push({
          hostId: id, id: 'grok', path: join(repo, '.grok', 'config.toml'),
          scope: 'repo', kind: 'mcp', what: '[mcp_servers.graft]', format: 'toml',
          entry,
        });
        break;
      case 'agents':
        // Guarded on the CLI actually being installed, so a plan only ever
        // lists files a real run would touch.
        if (dirExists(join(home, '.codex'))) {
          out.push({
            hostId: id, id: 'codex', path: join(home, '.codex', 'config.toml'),
            scope: 'global', kind: 'mcp', what: '[mcp_servers.graft]', format: 'toml',
            entry,
          });
        }
        if (dirExists(join(home, '.config', 'opencode'))) {
          out.push(jsonTarget(id, 'opencode', join(repo, 'opencode.json'), 'mcp', opencodeEntry(entry)));
        }
        break;
      default:
        break; // copilot / windsurf / adal: no MCP target in this phase
    }
  }
  return out;
}

export function registerMcpConfigs(
  repo: string,
  ids: string[],
  opts: { home?: string; global?: boolean; runner?: PackageRunner } = {},
): McpWrite[] {
  return mcpTargets(repo, ids, opts)
    .filter((t) => opts.global !== false || t.scope !== 'global')
    .map((t) =>
      t.format === 'toml'
        ? upsertCodexToml(t.id, t.path, (t.entry as McpLaunch | undefined) ?? serverEntry({ runner: opts.runner, cwd: repo }))
        : mergeJsonKey(t.id, t.path, t.topKey!, t.entry!),
    );
}
