import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import {
  DEFAULT_PROTOCOL_VERSION,
  handleMcpLine,
  negotiateProtocolVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
  type McpSession,
} from '../src/mcp/server.js';

function session(): { s: McpSession; out: any[] } {
  const out: any[] = [];
  const s: McpSession = {
    root: '/tmp/graft-mcp-handshake',
    version: '0.13.0',
    upkeepLines: [],
    write: (msg) => out.push(msg),
  };
  return { s, out };
}

function send(s: McpSession, msg: object): void {
  handleMcpLine(JSON.stringify(msg), s);
}

test('negotiateProtocolVersion: missing → default; known → echo; unknown → refuse', () => {
  assert.deepEqual(negotiateProtocolVersion(undefined), { ok: true, version: DEFAULT_PROTOCOL_VERSION });
  assert.deepEqual(negotiateProtocolVersion(null), { ok: true, version: DEFAULT_PROTOCOL_VERSION });
  assert.deepEqual(negotiateProtocolVersion(''), { ok: true, version: DEFAULT_PROTOCOL_VERSION });
  assert.deepEqual(negotiateProtocolVersion('2025-11-25'), { ok: true, version: '2025-11-25' });
  assert.deepEqual(negotiateProtocolVersion('2025-03-26'), { ok: true, version: '2025-03-26' });
  assert.deepEqual(negotiateProtocolVersion('2026-07-28'), { ok: true, version: '2026-07-28' });
  assert.deepEqual(negotiateProtocolVersion('1999-01-01'), { ok: false, requested: '1999-01-01' });
});

test('fake stdin: initialize returns a JSON-RPC result with protocolVersion', () => {
  const { s, out } = session();
  send(s, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].jsonrpc, '2.0');
  assert.equal(out[0].id, 1);
  assert.equal(out[0].result.protocolVersion, '2025-11-25');
  assert.ok(out[0].result.capabilities.tools);
  assert.equal(out[0].result.serverInfo.name, 'graft');
  assert.equal(out[0].result.serverInfo.version, '0.13.0');
});

test('fake stdin: version-less initialize is served on the default', () => {
  const { s, out } = session();
  send(s, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  assert.equal(out[0].result.protocolVersion, DEFAULT_PROTOCOL_VERSION);
});

test('fake stdin: initialize with no params at all still replies', () => {
  const { s, out } = session();
  send(s, { jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(out[0].id, 1);
  assert.equal(out[0].result.protocolVersion, DEFAULT_PROTOCOL_VERSION);
});

test('fake stdin: unsupported version is refused with the supported list, not echoed', () => {
  const { s, out } = session();
  send(s, {
    jsonrpc: '2.0',
    id: 'mcp-spec-test-initialize',
    method: 'initialize',
    params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'mcp-spec-test-initialize');
  assert.equal(out[0].error.code, -32022);
  assert.equal(out[0].error.message, 'Unsupported protocol version');
  assert.equal(out[0].error.data.requested, '1999-01-01');
  assert.deepEqual(out[0].error.data.supported, [...SUPPORTED_PROTOCOL_VERSIONS]);
  assert.ok(!out[0].result, 'must not echo the unsupported version as a result');
});

test('fake stdin: initialize then tools/list', () => {
  const { s, out } = session();
  send(s, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } });
  send(s, { jsonrpc: '2.0', method: 'notifications/initialized' });
  send(s, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(out.length, 2);
  assert.deepEqual(
    out[1].result.tools.map((t: { name: string }) => t.name),
    ['graft_find_code', 'graft_file_api', 'graft_check_freshness', 'graft_trace_calls', 'graft_find_all', 'graft_repo_map'],
  );
});

test('fake stdin: server/discover answers without a handshake', () => {
  const { s, out } = session();
  send(s, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
  assert.equal(out.length, 1);
  const result = out[0].result;
  assert.ok(result.supportedVersions.includes('2025-11-25'));
  assert.ok(result.supportedVersions.includes('2026-07-28'));
  assert.equal(result.resultType, 'complete');
  assert.equal(result.cacheScope, 'public');
  assert.equal(typeof result.ttlMs, 'number');
  assert.ok(result.capabilities.tools);
  assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'graft');
});

async function rpc(messages: object[], dir: string, expected: number, delayMs = 0): Promise<{ responses: any[]; exitCode: number | null; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'mcp', dir], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DO_NOT_TRACK: '1' },
  });
  const responses: any[] = [];
  let buf = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        try { responses.push(JSON.parse(line)); } catch { /* ignore non-JSON stdout */ }
      }
    }
  });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  const deadline = Date.now() + 45000;
  while (responses.length < expected && Date.now() < deadline && child.exitCode === null) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const stillRunning = child.exitCode === null && !child.killed;
  child.kill();
  await once(child, 'exit').catch(() => {});
  return { responses, exitCode: stillRunning ? null : child.exitCode, stderr };
}

test('initialize → tools/list → tools/call round-trip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-mcpsrv-'));
  const { responses: rs, stderr } = await rpc(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'graft_trace_calls', arguments: { symbol: 'x.ts', depth: 2 } } },
    ],
    dir,
    3,
  );
  assert.equal(rs.length, 3, `expected 3 JSON-RPC replies, got ${rs.length}. stderr:\n${stderr.slice(0, 1500)}`);
  const init = rs.find((r) => r.id === 1);
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.ok(init.result.capabilities.tools);
  assert.equal(init.result.serverInfo.name, 'graft');
  const list = rs.find((r) => r.id === 2);
  assert.deepEqual(list.result.tools.map((t: any) => t.name), [
    'graft_find_code',
    'graft_file_api',
    'graft_check_freshness',
    'graft_trace_calls',
    'graft_find_all',
    'graft_repo_map',
  ]);
  const call = rs.find((r) => r.id === 3);
  assert.equal(call.result.isError, true); // unbuilt repo → soft error content
  assert.match(call.result.content[0].text, /graft build/);
});

test('initialize carries instructions — the layer that survives tool deferral', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-mcpsrv-instr-'));
  const { responses: rs } = await rpc(
    [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }],
    dir,
    1,
  );
  const { instructions, serverInfo } = rs[0].result;
  assert.equal(typeof instructions, 'string');
  // A host that defers graft's schemas shows the model six bare names and nothing
  // else, so this string has to carry both the pitch and the recovery instruction.
  assert.match(instructions, /ONE lookup/, 'tells the agent to batch the schema fetch');
  assert.match(instructions, /select:mcp__graft__graft_find_code,/, 'gives a copy-pasteable query');
  for (const t of ['graft_find_code', 'graft_find_all', 'graft_trace_calls', 'graft_file_api', 'graft_repo_map']) {
    assert.ok(instructions.includes(t), `names ${t}`);
  }
  // Observed sibling servers sit at 660–984 chars; nothing proves a longer one
  // survives un-truncated, so hold the line here rather than discover it later.
  assert.ok(instructions.length < 1000, `instructions must stay under 1000 chars, got ${instructions.length}`);
  assert.match(serverInfo.version, /^\d+\.\d+\.\d+$/, 'real version, not the old hardcoded 0');
});

test('unknown method returns -32601', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-mcpsrv2-'));
  const { responses: rs } = await rpc([{ jsonrpc: '2.0', id: 9, method: 'resources/list' }], dir, 1);
  assert.equal(rs[0].error.code, -32601);
});

test('stdio process answers initialize and is still running (does not exit on a quiet pipe)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-mcpsrv-wait-'));
  const { responses: rs, exitCode } = await rpc(
    [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } }],
    dir,
    1,
    300,
  );
  assert.equal(exitCode, null, 'process must still be running when initialize is sent');
  assert.equal(rs[0].result.protocolVersion, '2025-11-25');
});
