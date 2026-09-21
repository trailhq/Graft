import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import graftPiExtension from '../src/pi/extension.js';

interface RegisteredTool {
  name: string;
  parameters: object;
  execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: { cwd: string; ui: { notify(message: string, level?: string): void } }): Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}

function builtRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'graft-pi-extension-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'math.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', d], { stdio: 'pipe' });
  return d;
}

function loadExtension() {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, { description: string; handler(args: string, ctx: any): Promise<void> | void }>();
  const handlers = new Map<string, (event: unknown, ctx: any) => Promise<unknown> | unknown>();
  graftPiExtension({
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: { description: string; handler(args: string, ctx: any): Promise<void> | void }) {
      commands.set(name, command);
    },
    on(event: 'before_agent_start', handler: (event: unknown, ctx: any) => Promise<unknown> | unknown) {
      handlers.set(event, handler);
    },
  });
  return { tools, commands, handlers };
}

test('Pi extension registers Graft tools and commands', () => {
  const { tools, commands, handlers } = loadExtension();
  assert.deepEqual([...tools.keys()], [
    'graft_find_code',
    'graft_file_api',
    'graft_check_freshness',
    'graft_trace_calls',
    'graft_find_all',
    'graft_repo_map',
  ]);
  assert.ok(commands.has('graft'));
  assert.ok(commands.has('graft-init-dry-run'));
  assert.ok(handlers.has('before_agent_start'));
});

test('Pi extension tools dispatch through the Graft engine', async () => {
  const repo = builtRepo();
  const { tools } = loadExtension();
  const result = await tools.get('graft_repo_map')!.execute('tool-call', { max_dirs: 2 }, undefined, undefined, {
    cwd: repo,
    ui: { notify() {} },
  });
  assert.match(result.content[0].text, /repo map/);
  assert.match(result.content[0].text, /src\//);
});

test('Pi extension injects guidance only when a graph is available', async () => {
  const repo = builtRepo();
  const empty = mkdtempSync(join(tmpdir(), 'graft-pi-extension-empty-'));
  const { handlers } = loadExtension();
  const handler = handlers.get('before_agent_start')!;

  assert.equal(await handler({}, { cwd: empty }), undefined);
  const injected = await handler({}, { cwd: repo });
  assert.match(JSON.stringify(injected), /GRAFT CONTEXT/);
});
