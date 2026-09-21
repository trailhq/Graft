import { mainWorktreeRoot } from '../graph/seed.js';
import { hasGraftIndex } from '../graph/root.js';
import { callTool, TOOLS } from '../mcp/tools.js';

interface PiToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details?: unknown;
}

interface MinimalPiContext {
  cwd: string;
  signal?: AbortSignal;
  ui: { notify(message: string, level?: 'info' | 'warning' | 'error'): void };
}

interface MinimalPi {
  registerTool(tool: {
    name: string;
    label?: string;
    description: string;
    parameters: object;
    execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: MinimalPiContext): Promise<PiToolResult>;
  }): void;
  registerCommand(name: string, command: { description: string; handler(args: string, ctx: MinimalPiContext): Promise<void> | void }): void;
  on(event: 'before_agent_start', handler: (event: unknown, ctx: MinimalPiContext) => Promise<unknown> | unknown): void;
  exec?(command: string, args: string[], options?: { signal?: AbortSignal; timeout?: number }): Promise<{ stdout?: string; stderr?: string; code?: number }>;
}

function labelFor(name: string): string {
  return name
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function graphAvailable(cwd: string): boolean {
  if (hasGraftIndex(cwd)) return true;
  const main = mainWorktreeRoot(cwd);
  return !!main && hasGraftIndex(main);
}

function graftGuidance(): string {
  return [
    '[GRAFT CONTEXT]',
    'This repo has a Graft graph. For code orientation, locating behavior, tracing callers, finding usages, or scoping refactors, use graft_find_code, graft_find_all, graft_file_api, graft_trace_calls, or graft_repo_map before raw grep/read exploration.',
    'Use graft_check_freshness when the user asks whether the graph is stale.',
  ].join('\n');
}

function textOf(result: { stdout?: string; stderr?: string; code?: number }): string {
  const stdout = result.stdout?.trimEnd() ?? '';
  const stderr = result.stderr?.trimEnd() ?? '';
  if (stdout && stderr) return `${stdout}\n\n[stderr]\n${stderr}`;
  return stdout || stderr || `graft exited with code ${result.code ?? 'unknown'}`;
}

export default function graftPiExtension(pi: MinimalPi): void {
  for (const tool of TOOLS) {
    pi.registerTool({
      name: tool.name,
      label: labelFor(tool.name),
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const cwd = ctx?.cwd ?? process.cwd();
        const result = await callTool(cwd, tool.name, params ?? {});
        if (result.isError) throw new Error(result.text);
        return {
          content: [{ type: 'text', text: result.text }],
          details: { tool: tool.name },
        };
      },
    });
  }

  pi.registerCommand('graft', {
    description: 'Show Graft graph status for the current repo',
    handler: async (_args, ctx) => {
      const result = await callTool(ctx.cwd, 'graft_check_freshness', {});
      ctx.ui.notify(result.text, result.isError ? 'error' : 'info');
    },
  });

  pi.registerCommand('graft-init-dry-run', {
    description: 'Preview what `graft init` would write in this repo',
    handler: async (_args, ctx) => {
      if (!pi.exec) {
        ctx.ui.notify('This Pi host does not expose command execution to extensions. Run `graft init --dry-run` in a terminal.', 'warning');
        return;
      }
      const result = await pi.exec('graft', ['init', '--dry-run'], { signal: ctx.signal, timeout: 120000 });
      ctx.ui.notify(textOf(result), result.code === 0 ? 'info' : 'warning');
    },
  });

  pi.on('before_agent_start', async (_event, ctx) => {
    if (!graphAvailable(ctx.cwd)) return undefined;
    return {
      message: {
        customType: 'graft-context',
        content: graftGuidance(),
        display: false,
      },
    };
  });
}
