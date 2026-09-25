/**
 * The `instructions` string returned in graft's MCP `initialize` response.
 *
 * This is the one piece of graft prose that survives **tool deferral**. When a
 * host has more tools than its schema budget allows, it sends tool *names* only
 * and withholds the JSONSchemas until a `ToolSearch`-style lookup fetches them —
 * measured in a real session: 111 tools deferred, of which graft's tools arrived as
 * bare strings with no descriptions at all. The MCP spec's `instructions`
 * field is delivered on a separate track (Claude Code records it as its own
 * `mcp_instructions_delta` context layer), so it lands whole even then. Other
 * servers already rely on this — `claude-in-chrome` uses it for exactly the
 * batch-your-ToolSearch instruction below; graft used to send nothing.
 *
 * Two jobs, in this order:
 *   1. Defuse the deferral tax. One lookup loads every query tool for the whole
 *      session, so the cost is a single round trip, not two calls per use. An
 *      agent that doesn't know this can only assume the worse reading.
 *   2. Say what each tool is FOR as a decision rule, not a feature summary —
 *      because in a host with no hooks and no skill listing (a plain chat client
 *      with an MCP config), this string plus the tool descriptions are the entire
 *      steering budget graft gets.
 *
 * Budget: keep this under ~1,000 characters. Observed sibling servers sit at
 * 660–984, and nothing proves a longer one survives un-truncated.
 */

/** Tool names in the order an agent should reach for them, most-used first. */
const TOOL_ORDER = [
  'graft_find_code',
  'graft_find_all',
  'graft_trace_calls',
  'graft_find_import_cycles',
  'graft_file_api',
  'graft_repo_map',
] as const;

/** The `select:` argument that loads every graft tool in one lookup. */
export function toolSearchQuery(prefix = 'mcp__graft__'): string {
  return `select:${TOOL_ORDER.map((t) => `${prefix}${t}`).join(',')}`;
}

export function mcpInstructions(): string {
  return [
    'graft indexes every symbol, file:line span, and dependency.',
    'Prefer it over grep/read; one call usually replaces several file reads.',
    '',
    `**If schemas are deferred, load them in ONE lookup:** ToolSearch "${toolSearchQuery()}". Never load them one at a time.`,
    '',
    '- graft_find_code — "how does X work" / "where is Y": ranked hits, code inlined.',
    '- graft_find_all — when you need EVERY occurrence; find_code is top-N and misses some.',
    '- graft_trace_calls — who calls it, what it calls, blast radius before a rename.',
    '- graft_find_import_cycles — untangle circular imports: every file-to-file cycle, lazy edges flagged.',
    '- graft_file_api — a file\'s whole API in ~200 tokens.',
    '- graft_repo_map — orientation in an unfamiliar repo.',
    '',
    'Results already reflect uncommitted edits — the graph refreshes before each query.',
  ].join('\n');
}
