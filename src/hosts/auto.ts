/**
 * `init --agents auto`: what the website's one setup prompt runs, by a coding
 * agent, with no one to ask.
 *
 * Two lists. The repo gets the main agents' files (Claude Code, Cursor, and
 * AGENTS.md for Codex and OpenCode): they are committed, so a teammate on one
 * of them is covered once they pull. Another agent's files go in only when
 * this laptop sets it up, so a repo isn't filled with folders for agents
 * nobody uses. The laptop (the home dir: `~/.claude`, `~/.codex`, global MCP
 * configs) gets settings only for the agents installed on it, plus the agent
 * running init, which may live somewhere detection doesn't look.
 *
 * Ids here are the agents a person uses (claude, codex, opencode, ...), the
 * ones Trail's page names. The registry's `agents` host is a file (AGENTS.md)
 * read by several of them, so it is never one of these ids.
 */
import { statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { HOSTS } from './registry.js';

export type AgentId =
  | 'claude' | 'codex' | 'cursor' | 'opencode' | 'gemini' | 'copilot'
  | 'windsurf' | 'antigravity' | 'kiro' | 'grok' | 'hermes' | 'adal';

/** What Trail's page and the terminal call each agent. */
export const AGENT_NAMES: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  gemini: 'Gemini CLI',
  copilot: 'GitHub Copilot',
  windsurf: 'Windsurf',
  antigravity: 'Antigravity',
  kiro: 'Kiro',
  grok: 'Grok',
  hermes: 'Hermes',
  adal: 'AdaL',
};

/** The init host that wires each agent: Codex and OpenCode read AGENTS.md. */
export function hostFor(agent: AgentId): string {
  return agent === 'codex' || agent === 'opencode' ? 'agents' : agent;
}

const set = (v: string | undefined): boolean => v !== undefined && v !== '' && v !== '0' && v !== 'false';

/**
 * Variables an agent sets in the shell it runs commands in, most specific
 * first. A nested agent inherits its parent's, so the first match wins.
 */
const SIGNALS: Array<[AgentId, (env: NodeJS.ProcessEnv) => boolean]> = [
  ['claude', (e) => set(e.CLAUDECODE) || set(e.CLAUDE_CODE_ENTRYPOINT)],
  ['codex', (e) => set(e.CODEX_THREAD_ID) || set(e.CODEX_SESSION_ID) || set(e.CODEX_SANDBOX) || set(e.CODEX_SANDBOX_NETWORK_DISABLED)],
  ['opencode', (e) => set(e.OPENCODE) || set(e.OPENCODE_SESSION_ID)],
  ['gemini', (e) => set(e.GEMINI_CLI)],
  ['cursor', (e) => set(e.CURSOR_AGENT) || e.CURSOR_EXTENSION_HOST_ROLE === 'agent-exec'],
  ['antigravity', (e) => set(e.ANTIGRAVITY_AGENT)],
  ['copilot', (e) => set(e.COPILOT_AGENT_SESSION_ID)],
];

/** `AI_AGENT` / `AGENT` values agents set, as their own names. */
const NAMED: Record<string, AgentId> = {
  'claude-code': 'claude', claude: 'claude',
  codex: 'codex',
  cursor: 'cursor', 'cursor-cli': 'cursor',
  opencode: 'opencode',
  'gemini-cli': 'gemini', gemini: 'gemini',
  'github-copilot': 'copilot', copilot: 'copilot',
  antigravity: 'antigravity',
  windsurf: 'windsurf',
  kiro: 'kiro',
};

/** The agent running this process, from its environment; null when nothing says. */
export function callingAgent(env: NodeJS.ProcessEnv = process.env): AgentId | null {
  for (const [id, hit] of SIGNALS) if (hit(env)) return id;
  for (const key of ['AI_AGENT', 'AGENT'] as const) {
    const named = NAMED[(env[key] ?? '').toLowerCase().replace(/@.*$/, '')];
    if (named) return named;
  }
  // The editor's own terminal: a person typing there has the editor too.
  const term = (env.TERM_PROGRAM ?? '').toLowerCase();
  if (term === 'windsurf') return 'windsurf';
  if (term === 'kiro') return 'kiro';
  return null;
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * The agents installed on this laptop, read from the home dir only: a folder
 * in the repo (`.cursor/`, `.github/`) is a committed file, maybe this run's,
 * not an install. Claude Code first, then the registry's order.
 */
export function installedAgents(home: string, repo: string): AgentId[] {
  const inRepo = (p: string) => p === repo || p.startsWith(repo.endsWith(sep) ? repo : repo + sep);
  const probe = { home, repo, dirExists: (p: string) => !inRepo(p) && isDir(p) };
  const out: AgentId[] = [];
  if (isDir(join(home, '.claude'))) out.push('claude');
  for (const host of HOSTS) {
    if (!host.detect(probe)) continue;
    if (host.id === 'agents') {
      // AGENTS.md is read by several agents: name the ones that are here.
      if (isDir(join(home, '.codex'))) out.push('codex');
      if (isDir(join(home, '.config', 'opencode'))) out.push('opencode');
      continue;
    }
    if (host.id in AGENT_NAMES) out.push(host.id as AgentId);
  }
  return out;
}

export interface AutoSelection {
  /** The agent running init, when its environment says. */
  caller: AgentId | null;
  /** The agents set up on this laptop, caller first: what Trail's page shows. */
  agents: AgentId[];
  /** The agent to tell Trail ran init: the caller, else the first set up, else Claude Code. */
  agent: AgentId;
  /** Init hosts allowed to write outside the repo. */
  laptop: string[];
  /** Init hosts whose repo files are written: the main agents', then the laptop's. */
  repo: string[];
}

/** The init hosts every repo gets: Claude Code, Cursor, and AGENTS.md (Codex, OpenCode). */
export const MAIN_HOSTS = ['claude', 'cursor', 'agents'];

export function autoSelection(opts: { home: string; repo: string; env?: NodeJS.ProcessEnv }): AutoSelection {
  const caller = callingAgent(opts.env ?? process.env);
  const agents = [...new Set([...(caller ? [caller] : []), ...installedAgents(opts.home, opts.repo)])];
  const laptop = [...new Set(agents.map(hostFor))];
  return { caller, agents, agent: agents[0] ?? 'claude', laptop, repo: [...new Set([...MAIN_HOSTS, ...laptop])] };
}

/** The agents by name, as "Claude Code, Cursor and Codex". */
export function agentList(agents: AgentId[]): string {
  return listed(agents.map((a) => AGENT_NAMES[a]));
}

/** "A, B and C". */
function listed(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The line init ends its wiring with, in plain words. */
export function autoSummary(agents: AgentId[]): string {
  const repo = 'Teammates on Claude Code, Cursor, Codex or OpenCode are covered once you commit.';
  if (agents.length === 0) return `No coding agent found on this laptop, so nothing outside this repo changed. ${repo}`;
  return `Set up for ${agentList(agents)} on this laptop. ${repo}`;
}
