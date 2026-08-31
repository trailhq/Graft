/**
 * The graft MCP tool names, kept in a zero-import module so both the MCP server
 * (which also pulls in the whole engine) and the session-scoring hooks (which must
 * stay cheap and engine-free) can share one list. Adding a dependency here would
 * drag it into every hook invocation, so this file imports nothing.
 */

/** The tools graft advertises today, as their canonical names. */
export const GRAFT_MCP_TOOL_CANONICAL = [
  'graft_find_code',
  'graft_find_all',
  'graft_trace_calls',
  'graft_file_api',
  'graft_repo_map',
  'graft_check_freshness',
] as const;

/**
 * The pre-0.8.1 tool names, still accepted. A name is an API: skills, saved
 * prompts and other people's notes reference the old ones, so they map to the
 * canonical name rather than 404.
 */
export const GRAFT_MCP_TOOL_ALIASES: Record<string, string> = {
  graft_ask: 'graft_find_code',
  graft_grep: 'graft_find_all',
  graft_callers: 'graft_trace_calls',
  graft_skeleton: 'graft_file_api',
  graft_map: 'graft_repo_map',
  graft_check: 'graft_check_freshness',
};

/** Every name graft answers to (canonical + legacy), lower-cased, for a membership
 *  test that anchors on the real vocabulary instead of a loose `includes('graft')`. */
export const GRAFT_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(
  [...GRAFT_MCP_TOOL_CANONICAL, ...Object.keys(GRAFT_MCP_TOOL_ALIASES)].map((n) => n.toLowerCase()),
);

/** Canonical name for a requested tool: itself, or what it was renamed to. */
export function canonicalToolName(name: string): string {
  return GRAFT_MCP_TOOL_ALIASES[name] ?? name;
}
