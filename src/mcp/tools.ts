/**
 * The MCP tools, as pure functions over the existing engine.
 * `callTool` never throws — hosts get soft errors as isError content.
 */
import { Graft } from '../engine.js';
import { formatAsk, skeleton, formatSkeleton } from '../ask/ask.js';
import { formatCheckReport } from '../context/check.js';
import { formatGraphCheckReport } from '../graph/check.js';
import { loadGraphCached } from '../graph/load.js';
import { ensureFreshChildren, ensureFreshGraph, refreshNote } from '../graph/refresh.js';
import { contextDirFor } from '../context/node-file.js';
import { resolveSymbol, edgeWalk, type Direction, type EdgeHit } from '../graph/traverse.js';
import { callersSavings, headerOf, hitLine, looseNoteFor } from '../graph/traverse-cli.js';
import { withSavings } from '../context/savings.js';
import { grepGraph } from '../search/grep.js';
import { formatGrepResult, zeroHitNote } from '../search/grep-cli.js';
import { buildRepoMap, formatRepoMap } from '../graph/map.js';
import {
  federateAsk,
  federateCallers,
  federateCheck,
  federateGrep,
  federateMap,
  readWorkspace,
} from '../graph/workspace.js';
import type { NodeV1 } from '../graph/types.js';

export type { ToolDef } from './tool-defs.js';
export { TOOLS } from './tool-defs.js';

const NO_GRAPH = 'no graph found — run `graft build` first';

function unknownSymbolText(query: string): string {
  return `no symbol "${query}" in the graph — check spelling or run \`graft build\``;
}

/** Render every resolved match's header + edge report (or the loud zero-edge
 * note), one block per match, joined with a blank line — the same grouping
 * `graft callers` uses for multi-match symbols. `showDepth` tags each hit with
 * its BFS depth (for transitive `depth>1` walks). */
function renderMatches(
  direction: Direction,
  showDepth: boolean,
  matches: NodeV1[],
  hitsFor: (n: NodeV1) => EdgeHit[],
): string {
  return matches
    .map((m) => {
      const hits = hitsFor(m);
      const lines = [headerOf(m)];
      if (hits.length === 0) lines.push(looseNoteFor(direction, m.name, matches.length));
      else for (const h of hits) lines.push(hitLine(direction, h, showDepth));
      return lines.join('\n');
    })
    .join('\n\n');
}

/** When the MCP server is rooted at a workspace parent, the ask/callers/grep/
 * map/check tools federate across the children — identical to the CLI. Returns
 * null for tools that don't federate (skeleton is per-file), so the caller
 * falls through to the normal single-graph path. */
async function callWorkspaceTool(
  root: string,
  dirOverride: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean } | null> {
  switch (name) {
    case 'graft_find_code': {
      const query = String(args.query ?? '');
      if (!query) return { text: 'graft_find_code requires a query', isError: true };
      const limit = typeof args.limit === 'number' ? args.limit : 5;
      const inArg = typeof args.in === 'string' && args.in ? args.in : undefined;
      const r = federateAsk(root, dirOverride, query, { limit, source: true, full: args.full === true, in: inArg });
      return { text: formatAsk(r), isError: false };
    }
    case 'graft_trace_calls': {
      const symbol = String(args.symbol ?? args.file ?? '');
      if (!symbol) return { text: 'graft_trace_calls requires a symbol', isError: true };
      const { text, found } = federateCallers(root, dirOverride, symbol, {
        direction: args.direction === 'out' ? 'out' : 'in',
        depth: typeof args.depth === 'number' && Number.isFinite(args.depth) ? args.depth : undefined,
        in: typeof args.in === 'string' && args.in ? args.in : undefined,
      });
      return { text, isError: !found };
    }
    case 'graft_find_all': {
      const pattern = String(args.pattern ?? '');
      if (!pattern) return { text: 'graft_find_all requires a pattern', isError: true };
      const { result, coverage } = federateGrep(root, dirOverride, pattern, {
        ignoreCase: typeof args.ignore_case === 'boolean' ? args.ignore_case : undefined,
        fixed: typeof args.fixed === 'boolean' ? args.fixed : undefined,
      });
      const text = result.totalHits === 0 ? zeroHitNote(result) : formatGrepResult(result);
      return { text: coverage ? `${text}\n${coverage}` : text, isError: false };
    }
    case 'graft_repo_map': {
      const maxDirs = typeof args.max_dirs === 'number' && Number.isFinite(args.max_dirs) && args.max_dirs > 0 ? args.max_dirs : undefined;
      return { text: federateMap(root, dirOverride, { maxDirs }), isError: false };
    }
    case 'graft_check_freshness': {
      const { text } = await federateCheck(root, dirOverride);
      return { text, isError: false };
    }
    default:
      return null;
  }
}

/** Tools whose whole job is to REPORT drift. Rebuilding first would make
 * `graft_check_freshness` answer about a graph it just fixed, i.e. always "OK". */
const NO_REFRESH_TOOLS = new Set(['graft_check_freshness']);

/**
 * The pre-0.8.1 tool names, still accepted.
 *
 * The names were the reason for renaming: when a host defers graft's schemas it
 * shows the model the *names alone* — no descriptions — so `graft_ask` had to
 * compete with `Grep` on 9 characters of self-description. The new names say what
 * they do. But a name is an API: skills, saved prompts, scripts and other people's
 * notes reference the old ones, and silently 404-ing on them would be a worse
 * outcome than an ugly name. Not advertised in {@link TOOLS} — the roster stays six
 * — so this costs nothing in the payload and only ever rescues an old caller.
 */
const TOOL_ALIASES: Record<string, string> = {
  graft_ask: 'graft_find_code',
  graft_grep: 'graft_find_all',
  graft_callers: 'graft_trace_calls',
  graft_skeleton: 'graft_file_api',
  graft_map: 'graft_repo_map',
  graft_check: 'graft_check_freshness',
};

/** Canonical name for a requested tool: itself, or what it was renamed to. */
export function canonicalToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}

export async function callTool(
  root: string,
  requestedName: string,
  args: Record<string, unknown>,
  dirOverride?: string,
): Promise<{ text: string; isError: boolean }> {
  try {
    const name = canonicalToolName(requestedName);
    const ws = readWorkspace(root, dirOverride);
    // Freshness first: an answer that cites file:line has to be about the code as
    // it is right now, including edits nobody has committed (or even saved through
    // this agent). ~3ms when nothing moved; a structural, $0 rebuild when it did.
    let note: string | null = null;
    if (!NO_REFRESH_TOOLS.has(name)) {
      const r = ws
        ? await ensureFreshChildren(root, ws.children, { contextDir: dirOverride })
        : await ensureFreshGraph(root, { contextDir: dirOverride });
      note = refreshNote(r);
    }
    const fed = ws ? await callWorkspaceTool(root, dirOverride, name, args) : null;
    const res = fed ?? (await callSingleTool(root, name, args, dirOverride));
    return note ? { ...res, text: `${note}\n${res.text}` } : res;
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
}

/** The single-graph path: every tool, answered from one repo's graph. */
async function callSingleTool(
  root: string,
  name: string,
  args: Record<string, unknown>,
  dirOverride?: string,
): Promise<{ text: string; isError: boolean }> {
  switch (name) {
      case 'graft_find_code': {
        const query = String(args.query ?? '');
        if (!query) return { text: 'graft_find_code requires a query', isError: true };
        const limit = typeof args.limit === 'number' ? args.limit : 5;
        const engine = new Graft({ contextDir: dirOverride });
        const inArg = typeof args.in === 'string' && args.in ? args.in : undefined;
        const r = engine.ask(root, query, { limit, source: true, full: args.full === true, in: inArg });
        return { text: formatAsk(r), isError: false };
      }
      case 'graft_file_api': {
        const file = String(args.file ?? '');
        if (!file) return { text: 'graft_file_api requires a file', isError: true };
        const r = skeleton(root, file, { contextDir: dirOverride });
        return { text: formatSkeleton(r), isError: !r.entries.length && !!r.note };
      }
      case 'graft_check_freshness': {
        const engine = new Graft({ contextDir: dirOverride });
        const r = engine.check(root);
        const g = await engine.checkGraph(root);
        const parts = [formatCheckReport(r)];
        if (!g.missing) parts.push(formatGraphCheckReport(g));
        return { text: parts.join('\n\n'), isError: false };
      }
      case 'graft_trace_calls': {
        // One tool covers callers (direction:in, the default), callees
        // (direction:out), and blast radius (depth>1). edgeWalk handles the
        // file-seed aggregation that the old graft_blast_radius did: for a
        // file at depth>1 it walks the file node AND every symbol defined in
        // it, so dependents that call into a symbol (targeting the SYMBOL id,
        // never the FILE id) aren't silently dropped.
        const symbol = String(args.symbol ?? args.file ?? '');
        if (!symbol) return { text: 'graft_trace_calls requires a symbol', isError: true };
        const w = loadGraphCached(contextDirFor(root, dirOverride));
        if (!w) return { text: NO_GRAPH, isError: true };
        const inOpt = typeof args.in === 'string' && args.in ? { in: args.in } : {};
        const matches = resolveSymbol(w, symbol, inOpt);
        if (matches.length === 0) return { text: unknownSymbolText(symbol), isError: true };
        const direction: Direction = args.direction === 'out' ? 'out' : 'in';
        // `depth: "all"` (or a huge number) walks the full transitive closure —
        // every connected source — terminating when no new node is reached.
        const depth =
          args.depth === 'all' || args.depth === 'full'
            ? Number.POSITIVE_INFINITY
            : typeof args.depth === 'number' && Number.isFinite(args.depth) && args.depth >= 1
              ? Math.floor(args.depth)
              : 1;
        const results = matches.map((m) => ({ symbol: m, hits: edgeWalk(w, m, direction, depth) }));
        const byId = new Map(results.map((r) => [r.symbol.id, r.hits]));
        const body = renderMatches(direction, depth > 1, matches, (m) => byId.get(m.id) ?? []);
        const text = withSavings(body, callersSavings(w, results));
        return { text, isError: false };
      }
      case 'graft_find_all': {
        const pattern = String(args.pattern ?? '');
        if (!pattern) return { text: 'graft_find_all requires a pattern', isError: true };
        const w = loadGraphCached(contextDirFor(root, dirOverride));
        if (!w) return { text: NO_GRAPH, isError: true };
        const result = grepGraph(w, root, pattern, {
          ignoreCase: typeof args.ignore_case === 'boolean' ? args.ignore_case : undefined,
          fixed: typeof args.fixed === 'boolean' ? args.fixed : undefined,
          in: typeof args.in === 'string' && args.in ? args.in : undefined,
        });
        if (result.totalHits === 0) return { text: zeroHitNote(result), isError: false };
        return { text: formatGrepResult(result), isError: false };
      }
      case 'graft_repo_map': {
        const w = loadGraphCached(contextDirFor(root, dirOverride));
        if (!w) return { text: NO_GRAPH, isError: true };
        const maxDirs = typeof args.max_dirs === 'number' && Number.isFinite(args.max_dirs) && args.max_dirs > 0 ? args.max_dirs : undefined;
        const map = buildRepoMap(w, { maxDirs });
        return { text: formatRepoMap(map), isError: false };
      }
    default:
      return { text: `unknown tool: ${name}`, isError: true };
  }
}
