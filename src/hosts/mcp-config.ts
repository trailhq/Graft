/**
 * Register the graft MCP server in each host's config.
 * JSON hosts get a keyed merge (other servers preserved; unparseable files
 * are never rewritten). The TOML host gets an append-if-absent section.
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
  /** JSON only: the server entry to merge in under `graft`. */
  entry?: object;
}

/**
 * How to launch the MCP server, decided once at init time.
 *
 * `npx -y` resolves the package before it can serve: measured at a 211 ms
 * spawn→`initialize` handshake against 80 ms for the installed binary, five runs
 * each. The harness registers a server's tools only once that handshake lands, and
 * a slow one can miss the first request entirely — in a traced session graft's
 * tools arrived 13.9 s in, four model turns too late to shape the approach. (That
 * 13.9 s is NOT explained by 130 ms; the gap's cause is still unknown. This is the
 * cheap half of the fix, not the whole of it.)
 *
 * Deliberately a bare command name, never an absolute path: these files get
 * committed and shared, and this repo already carries the scar of the alternative —
 * a checked-in hook shim with another machine's home directory baked into it. A
 * bare `graft` works on any machine that has it installed; `npx` remains the
 * fallback for machines that don't.
 */
const NPX_LAUNCH = { command: 'npx', args: ['-y', '@nanonets/graft', 'mcp'] };
const BIN_LAUNCH = { command: 'graft', args: ['mcp'] };

function graftOnPath(): boolean {
  const r = spawnSync('graft', ['--version'], { stdio: 'ignore', timeout: 5000 });
  return r.status === 0;
}

/**
 * JSON hosts: `{ command, args }`.
 *
 * `GRAFT_MCP_NPX=1` forces the `npx` form — the escape hatch for a machine whose
 * global install is stale or shadowed, and what the tests set so their expectations
 * don't depend on whether the machine running them happens to have graft installed.
 * `opts.onPath` is the same override for direct unit tests of both branches.
 */
export function serverEntry(opts: { onPath?: boolean } = {}): { command: string; args: string[] } {
  const forced = process.env.GRAFT_MCP_NPX;
  if (forced !== undefined && forced !== '' && forced !== '0' && forced !== 'false') return NPX_LAUNCH;
  return (opts.onPath ?? graftOnPath()) ? BIN_LAUNCH : NPX_LAUNCH;
}


function opencodeEntry(): object {
  const { command, args } = serverEntry();
  return { type: 'local', command: [command, ...args], enabled: true };
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

function upsertCodexToml(id: string, path: string): McpWrite {
  const existed = existsSync(path);
  const text = existed ? readFileSync(path, 'utf8') : '';
  if (/^\[mcp_servers\.graft\]$/m.test(text)) return { id, path, action: 'unchanged' };
  const { command, args } = serverEntry();
  const argList = args.map((a) => JSON.stringify(a)).join(", ");
  const section = `[mcp_servers.graft]\ncommand = \"${command}\"\nargs = [${argList}]\n`;
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
  opts: { home?: string } = {},
): McpTarget[] {
  const home = opts.home ?? homedir();
  const entry = serverEntry();
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
        });
        break;
      case 'agents':
        // Guarded on the CLI actually being installed, so a plan only ever
        // lists files a real run would touch.
        if (dirExists(join(home, '.codex'))) {
          out.push({
            hostId: id, id: 'codex', path: join(home, '.codex', 'config.toml'),
            scope: 'global', kind: 'mcp', what: '[mcp_servers.graft]', format: 'toml',
          });
        }
        if (dirExists(join(home, '.config', 'opencode'))) {
          out.push(jsonTarget(id, 'opencode', join(repo, 'opencode.json'), 'mcp', opencodeEntry()));
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
  opts: { home?: string; global?: boolean } = {},
): McpWrite[] {
  return mcpTargets(repo, ids, opts)
    .filter((t) => opts.global !== false || t.scope !== 'global')
    .map((t) =>
      t.format === 'toml'
        ? upsertCodexToml(t.id, t.path)
        : mergeJsonKey(t.id, t.path, t.topKey!, t.entry!),
    );
}
