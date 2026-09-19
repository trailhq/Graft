/**
 * MCP tool roster, kept out of `tools.ts` so the stdio server can advertise
 * `tools/list` (and finish `initialize`) without importing the graph engine.
 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'graft_find_code',
    description:
      'Query the repo context graph in plain words. Returns ranked nodes with exact file:line spans and the relevant source inlined — usually the full answer, no file reads needed.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'what you want to understand, in plain words' },
        limit: { type: 'number', description: 'max results (default 5)' },
        full: {
          type: 'boolean',
          description: 'inline whole definition spans instead of the default ≤8-line crux excerpts',
        },
        in: {
          type: 'string',
          description: 'narrow to nodes under this path prefix, filtered before scoring (segment-aware, like scopeOf)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'graft_file_api',
    description:
      "Signatures-only view of one file — every definition's signature + line span, ~10× cheaper than reading the file ($0, no LLM).",
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'repo-relative path (or unique basename) of the file' },
      },
      required: ['file'],
    },
  },
  {
    name: 'graft_check_freshness',
    description: 'Report whether the committed graph is in sync with the code (drift check).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'graft_trace_calls',
    description:
      'Structural edges for a symbol, over call/reference/import/implements/extends ($0, no LLM). Defaults to direct callers (who depends on it). Set direction:"out" for callees (what it calls); set depth>1 (or depth:"all" for the full closure) to walk transitively for the full blast radius — every source that breaks if it changes. Run before a multi-file refactor to find ALL affected files.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'bare name, qualified (Class.method), or package-qualified (pkg.Fn); a file path also works' },
        direction: {
          type: 'string',
          enum: ['in', 'out'],
          description: '"in" (default) = callers/dependents; "out" = callees/dependencies',
        },
        depth: { description: 'transitive walk depth for blast radius (default 1 = direct edges only); pass "all" for the full connected closure — every source that would be affected' },
        in: { type: 'string', description: 'narrow matches to nodes at or under this repo-relative path prefix, e.g. server/src' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'graft_find_all',
    description:
      'Regex search over the graph\'s indexed files, hits grouped by innermost enclosing symbol and ranked by incoming-edge count (coupling) — which hit matters, not just where it is.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'regex pattern (or literal string with fixed: true)' },
        in: { type: 'string', description: 'narrow to files at or under this repo-relative path prefix, e.g. server/src' },
        ignore_case: { type: 'boolean', description: 'case-insensitive match' },
        fixed: { type: 'boolean', description: 'treat pattern as a literal string, not a regex' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'graft_repo_map',
    description:
      'Token-budgeted repo orientation — directory clusters, per-directory hubs, and global hotspots computed purely from the wiring graph ($0, no LLM). Use this to get oriented in an unfamiliar repo before diving into files.',
    inputSchema: {
      type: 'object',
      properties: {
        max_dirs: { type: 'number', description: 'max directory entries shown, rest counted into dropped (default 16)' },
      },
    },
  },
];
