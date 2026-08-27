/**
 * Minimal MCP stdio server: newline-delimited JSON-RPC 2.0.
 * stdout carries protocol messages ONLY; diagnostics go to stderr.
 *
 * Dual-era: answers legacy `initialize` (2025-11-25 and earlier) and modern
 * `server/discover` (2026-07-28). The graph engine is loaded only on
 * `tools/call` so the handshake cannot die behind a missing native grammar.
 */
import { createInterface } from 'node:readline';
import { TOOLS } from './tool-defs.js';
import { mcpInstructions } from './instructions.js';
import { maybeFlushInBackground, track } from '../telemetry/index.js';

/**
 * Newest first. Handshake-era clients speak the 2025/2024 dates; 2026 is the
 * per-request-metadata revision. A missing version lands on the newest
 * handshake-era date the official SDK still speaks.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-03-26', '2024-11-05'] as const;
export const DEFAULT_PROTOCOL_VERSION = '2025-11-25';
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/**
 * MCP tool name → the command enum the telemetry contract knows. A tool absent
 * here is simply not counted: `track` would drop an unlisted command anyway, and
 * mapping by hand keeps the wire vocabulary identical across the CLI and MCP so
 * `ask` means the same thing in both.
 */
const TOOL_COMMAND: Record<string, string> = {
  graft_find_code: 'ask',
  graft_find_all: 'grep',
  graft_trace_calls: 'callers',
  graft_file_api: 'skeleton',
  graft_repo_map: 'map',
  graft_check_freshness: 'check',
};

export function negotiateProtocolVersion(requested: unknown): { ok: true; version: string } | { ok: false; requested: string } {
  if (requested === undefined || requested === null || requested === '') {
    return { ok: true, version: DEFAULT_PROTOCOL_VERSION };
  }
  const version = String(requested);
  if ((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return { ok: true, version };
  }
  return { ok: false, requested: version };
}

type JsonRpc = { id?: unknown; method?: string; params?: Record<string, unknown> };

export interface McpSession {
  root: string;
  dirOverride?: string;
  version: string;
  upkeepLines: string[];
  write: (msg: object) => void;
}

function send(write: (msg: object) => void, msg: object): void {
  write(msg);
}

function reply(session: McpSession, id: unknown, result: object): void {
  send(session.write, { jsonrpc: '2.0', id, result });
}

function replyError(session: McpSession, id: unknown, code: number, message: string, data?: unknown): void {
  const error: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) error.data = data;
  send(session.write, { jsonrpc: '2.0', id, error });
}

function initializeResult(session: McpSession, protocolVersion: string): object {
  const extra = session.upkeepLines.length ? `${session.upkeepLines.join('\n')}\n\n` : '';
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: 'graft', version: session.version },
    instructions: `${extra}${mcpInstructions()}`,
  };
}

function discoverResult(session: McpSession): object {
  const extra = session.upkeepLines.length ? `${session.upkeepLines.join('\n')}\n\n` : '';
  return {
    resultType: 'complete',
    ttlMs: 60_000,
    cacheScope: 'public',
    supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    capabilities: { tools: {} },
    instructions: `${extra}${mcpInstructions()}`,
    _meta: { [META_SERVER_INFO]: { name: 'graft', version: session.version } },
  };
}

function metaProtocolVersion(params?: Record<string, unknown>): string | undefined {
  const meta = params?._meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const v = (meta as Record<string, unknown>)[META_PROTOCOL_VERSION];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Handle one newline-delimited JSON-RPC line. Notifications produce no write. */
export function handleMcpLine(line: string, session: McpSession): void {
  const text = line.trim();
  if (!text) return;
  let msg: JsonRpc;
  try {
    msg = JSON.parse(text) as JsonRpc;
  } catch {
    replyError(session, null, -32700, 'parse error');
    return;
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined;

  if (method !== 'initialize' && method !== 'server/discover' && !isNotification) {
    const offered = metaProtocolVersion(params);
    if (offered !== undefined && negotiateProtocolVersion(offered).ok === false) {
      replyError(session, id, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
        supported: [...SUPPORTED_PROTOCOL_VERSIONS],
        requested: offered,
      });
      return;
    }
  }

  switch (method) {
    case 'initialize': {
      const negotiated = negotiateProtocolVersion(params?.protocolVersion);
      if (!negotiated.ok) {
        replyError(session, id ?? null, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
          supported: [...SUPPORTED_PROTOCOL_VERSIONS],
          requested: negotiated.requested,
        });
        return;
      }
      reply(session, id ?? null, initializeResult(session, negotiated.version));
      return;
    }
    case 'server/discover':
      if (!isNotification) reply(session, id, discoverResult(session));
      return;
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      if (!isNotification) reply(session, id, {});
      return;
    case 'tools/list':
      if (!isNotification) {
        reply(session, id, {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        });
      }
      return;
    case 'tools/call': {
      if (isNotification) return;
      const name = String(params?.name ?? '');
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      // Loaded here, not at boot: callTool pulls the graph engine and, on first
      // parse, native grammars. The handshake must not wait on that.
      import('./tools.js').then(({ callTool }) =>
        callTool(session.root, name, args, session.dirOverride).then(
          (r) => {
            const command = Object.hasOwn(TOOL_COMMAND, name) ? TOOL_COMMAND[name] : undefined;
            track('query', { command, surface: 'mcp' }, { repo: session.root, host: 'mcp' });
            reply(session, id, { content: [{ type: 'text', text: r.text }], isError: r.isError });
          },
          (err) => replyError(session, id, -32603, err instanceof Error ? err.message : String(err)),
        ),
      ).catch((err) => replyError(session, id, -32603, err instanceof Error ? err.message : String(err)));
      return;
    }
    default:
      if (!isNotification) replyError(session, id, -32601, `method not found: ${method}`);
  }
}

function stdoutWrite(msg: object): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

/**
 * `version` is threaded in from the CLI rather than read here: `readCurrentVersion`
 * resolves package.json relative to the calling module, and from `dist/mcp/` that
 * lookup misses. The caller already knows it.
 *
 * Readline is attached synchronously so a client that writes `initialize` the
 * moment the process starts is not racing a wiring refresh — and so a missing
 * repo or a non-TTY stdin cannot exit(0) before the first request is read.
 *
 * Resolves when stdin ends, so the CLI action does not return and let the
 * process drain while a client still expects a handshake.
 */
export function startMcpServer(root: string, dirOverride?: string, version = '0'): Promise<void> {
  const session: McpSession = {
    root,
    dirOverride,
    version,
    upkeepLines: [],
    write: stdoutWrite,
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => handleMcpLine(line, session));

  // Fail-soft, and never on the handshake path. Cursor's stderr log is unread,
  // so the first-run telemetry notice stays pending for the next CLI command.
  setImmediate(() => {
    import('../upkeep-run.js').then(async ({ runUpkeep }) => {
      const { runningVersion } = await import('../upkeep.js');
      try {
        const upkeep = runUpkeep(root, runningVersion()).lines;
        session.upkeepLines = upkeep;
        for (const line of upkeep) console.error(line);
      } catch { /* upkeep must not take down the server */ }
      try {
        maybeFlushInBackground();
      } catch { /* same */ }
    }).catch(() => { /* same */ });
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // 'close' fires after any pending `line` events, so an `echo '{}' | graft mcp`
    // still answers initialize before the action resolves.
    rl.on('close', finish);
    process.stdin.on('end', () => rl.close());
    process.stdin.on('close', () => rl.close());
  });
}
