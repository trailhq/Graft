/**
 * The workspace connector, passed through the local trail MCP server.
 *
 * Once this machine is signed in to a Trail workspace (`trail login`, or
 * `trail init --connect`), the `trail` MCP entry Claude Code already has also
 * serves everything the workspace's own MCP server serves to the Claude.ai
 * connector: its tools (get_context, save_learning, use_skill, ...), one
 * prompt per team skill, and the `instructions` that say what the team's
 * memory holds. They are the workspace's, so they're asked for, never
 * hard-coded: a new tool or skill on the cloud shows up here with no release.
 *
 * The server is `<trail>/mcp` (TRAIL_MCP_URL overrides it), MCP over
 * Streamable HTTP, with this machine's `trl_` token as a bearer. trail-cloud
 * runs it stateless with JSON answers; a server that hands out a session id
 * or answers in SSE works too.
 *
 * Why not the MCP TypeScript SDK client: trail doesn't depend on it, it
 * would add a dependency tree to a CLI that starts through `npx` in every
 * session, and the four calls passed through here are plain JSON-RPC posts.
 * The local server (./server.ts) is hand-rolled for the same reason.
 *
 * Nothing here throws. A listing that can't be had is null; a call that
 * can't be made is an MCP error result the agent can read.
 */
import { cloudIn, isLocalServer, readClouds, serverUrl, type Cloud } from '../cloud/workspace.js';
import { repoPlace } from '../notes/home.js';

/**
 * The workspace's MCP server: `<trail>/mcp`, or null when the pairing has no
 * address. TRAIL_MCP_URL moves it only to the paired Trail's own origin or to
 * a host on this machine (as TRAIL_TEST_SERVER does): the token goes with
 * every request, and no variable left in a shell sends it anywhere else.
 */
export function connectorUrl(cloud: Pick<Cloud, 'url'>, env: NodeJS.ProcessEnv = process.env): string | null {
  const base = typeof cloud.url === 'string' ? serverUrl(cloud.url) : null;
  if (!base) return null;
  const over = serverUrl(env.TRAIL_MCP_URL);
  if (over && (new URL(over).origin === new URL(base).origin || isLocalServer(over))) return over;
  return `${base}/mcp`;
}

/** A tool as the workspace defines it, passed on whole (schema, annotations, title). */
export interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [k: string]: unknown;
}

/** A prompt as the workspace defines it (one per team skill). */
export interface RemotePrompt {
  name: string;
  [k: string]: unknown;
}

export interface CallResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  structuredContent?: unknown;
  [k: string]: unknown;
}

type Fetch = typeof fetch;

/** The protocol trail asks for; the server's answer is what's used after. */
const PROTOCOL = '2025-06-18';

/** At most this many pages of a listing, against a server that never stops paging. */
const MAX_PAGES = 20;

const NOT_CONNECTED = "this laptop isn't signed in to Trail · run `trail login` and give the user the link it prints";
const TOKEN_REFUSED = "your Trail workspace refused this laptop's sign-in; run `trail logout`, then `trail login`, and give the user the link it prints";
const NO_CONNECTOR = "your Trail doesn't serve this connector (an older version); its learnings and skills will show here once it does";

/** How long calls fail at once after a start that failed, before one tries again. */
const BACKOFF_MS = 30_000;

/** An answer from the workspace that wasn't a result. */
class ConnectorError extends Error {
  constructor(
    message: string,
    /** The session the server knew is gone: start one again. */
    readonly sessionLost = false,
    /** A JSON-RPC error from the server, worth passing on as it is. */
    readonly rpc?: { code: number; message: string },
    /** The workspace said no to the token, or has no connector: not a network fault. */
    readonly refused = false,
  ) {
    super(message);
  }
}

/** A JSON-RPC answer to `id`: it carries a result or an error. */
function isReply(m: any, id: number): boolean {
  return !!m && typeof m === 'object' && m.id === id && ('result' in m || 'error' in m);
}

/** The JSON-RPC message answering `id`, from a JSON body or an SSE stream. */
function pickReply(contentType: string, text: string, id: number): any {
  if (contentType.includes('text/event-stream')) {
    // Events are separated by a blank line; an event's data may span lines.
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (isReply(msg, id)) return msg;
      } catch {
        /* a partial event */
      }
    }
    return null;
  }
  try {
    const msg = JSON.parse(text);
    if (Array.isArray(msg)) return msg.find((m) => isReply(m, id)) ?? null;
    return isReply(msg, id) ? msg : null;
  } catch {
    return null;
  }
}

/** What the agent reads when a call couldn't be made. */
function why(err: unknown): string {
  if (err instanceof ConnectorError) return err.message;
  return "couldn't reach your Trail workspace";
}

interface Session {
  token: string;
  url: string;
  id?: string;
  protocol: string;
  instructions: string;
}

/**
 * A small MCP client for the workspace's server. One per local server
 * process: it initializes once and keeps the server's instructions; it reads
 * the pairing from `~/.trail/cloud.json` on every call, so `trail logout` or
 * a new `--connect` takes effect without restarting the agent.
 */
export class WorkspaceConnector {
  private nextId = 1;
  private session: Session | null = null;
  private starting: Promise<Session> | null = null;
  /** The last start that failed: when, and why, so calls fail at once for a while. */
  private failed: { at: number; err: unknown } | null = null;

  constructor(
    private readonly opts: { env?: NodeJS.ProcessEnv; fetchImpl?: Fetch; timeoutMs?: number; callTimeoutMs?: number; version?: string; cwd?: string } = {},
  ) {}

  /** The repo this server runs in, by key: its workspace answers. Read once; the agent doesn't move repos. */
  private repoKey: string | null | undefined;

  /** The workspace of the repo the agent is in, or else the newest connection (a session outside any linked repo). */
  private cloud(): Cloud | null {
    const all = readClouds(this.opts.env);
    if (this.repoKey === undefined) {
      try {
        this.repoKey = repoPlace(this.opts.cwd ?? process.cwd(), this.opts.env).key;
      } catch {
        this.repoKey = null;
      }
    }
    return (this.repoKey ? cloudIn(all, this.repoKey) : null) ?? all[0] ?? null;
  }

  /** Whether this machine is paired with a workspace, so its tools are asked for. */
  connected(): boolean {
    return this.cloud() !== null;
  }

  private async post(s: { token: string; url: string; id?: string; protocol?: string }, body: object, timeoutMs: number): Promise<Response> {
    const f = this.opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${s.token}`,
    };
    if (s.id) headers['mcp-session-id'] = s.id;
    if (s.protocol) headers['mcp-protocol-version'] = s.protocol;
    // Never follow a redirect: it would carry the token to wherever it points.
    return f(s.url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  }

  /** One request, its result or a ConnectorError. */
  private async request(s: Session | { token: string; url: string }, method: string, params: object | undefined, timeoutMs: number): Promise<{ result: any; res: Response }> {
    const id = this.nextId++;
    const res = await this.post(s, { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, timeoutMs);
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new ConnectorError(TOKEN_REFUSED, false, undefined, true);
    if (res.status === 404 && method === 'initialize') throw new ConnectorError(NO_CONNECTOR, false, undefined, true);
    // A session the server no longer knows: 404 by the spec, 400 from some servers.
    if ((res.status === 404 || res.status === 400) && 'id' in s && s.id) throw new ConnectorError('the Trail workspace dropped the session', true);
    if (!res.ok) throw new ConnectorError(`the Trail workspace answered ${res.status}`);
    const msg = pickReply(res.headers.get('content-type') ?? '', text, id);
    if (!msg) throw new ConnectorError('the Trail workspace sent an answer trail could not read');
    if (msg.error) {
      const e = { code: typeof msg.error.code === 'number' ? msg.error.code : -32603, message: String(msg.error.message ?? 'the Trail workspace returned an error') };
      throw new ConnectorError(e.message, false, e);
    }
    return { result: msg.result, res };
  }

  /**
   * Initialize once per pairing (token and address); a new pairing starts
   * again. Async, so a pairing file that can't be used is a rejection, never
   * a throw. After a failed start, calls fail at once for BACKOFF_MS.
   */
  private async ready(): Promise<Session> {
    const cloud = this.cloud();
    if (!cloud) throw new ConnectorError(NOT_CONNECTED);
    const url = connectorUrl(cloud, this.opts.env);
    if (!url) throw new ConnectorError(NOT_CONNECTED);
    if (this.session && this.session.token === cloud.token && this.session.url === url) return this.session;
    if (this.starting) return this.starting;
    if (this.failed && Date.now() - this.failed.at < BACKOFF_MS) throw this.failed.err;
    this.session = null;
    const start = (async () => {
      const base = { token: cloud.token, url };
      const { result, res } = await this.request(
        base,
        'initialize',
        { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'trail', version: this.opts.version ?? '0' } },
        this.opts.timeoutMs ?? 15_000,
      );
      const s: Session = {
        ...base,
        id: res.headers.get('mcp-session-id') ?? undefined,
        protocol: typeof result?.protocolVersion === 'string' ? result.protocolVersion : PROTOCOL,
        instructions: typeof result?.instructions === 'string' ? result.instructions : '',
      };
      // A notification: the answer is 202 and nothing else.
      await this.post(s, { jsonrpc: '2.0', method: 'notifications/initialized' }, this.opts.timeoutMs ?? 15_000)
        .then((r) => r.text())
        .catch(() => {});
      this.session = s;
      return s;
    })();
    this.starting = start;
    start.then(
      () => {
        this.starting = null;
        this.failed = null;
      },
      (err) => {
        this.starting = null;
        this.failed = { at: Date.now(), err };
      },
    );
    return start;
  }

  /** A request in the current session, started again once if the server dropped it. */
  private async ask(method: string, params: object | undefined, timeoutMs: number): Promise<any> {
    const s = await this.ready();
    try {
      return (await this.request(s, method, params, timeoutMs)).result;
    } catch (err) {
      if (!(err instanceof ConnectorError && err.sessionLost)) throw err;
      if (this.session === s) this.session = null;
      return (await this.request(await this.ready(), method, params, timeoutMs)).result;
    }
  }

  /** Start talking to the workspace now, so its answers are in hand when the client asks. */
  warm(): void {
    if (this.connected()) this.ready().catch(() => {});
  }

  /** Whether a session with the workspace is open (its instructions, even empty ones, are in hand). */
  started(): boolean {
    return this.session !== null;
  }

  /** Why the last start failed, when the workspace said no (a refused token, no connector); null otherwise. */
  refusal(): string | null {
    const e = this.failed?.err;
    return e instanceof ConnectorError && e.refused ? e.message : null;
  }

  /** The workspace's own instructions, '' when not paired or not reachable. */
  async instructions(): Promise<string> {
    try {
      return (await this.ready()).instructions;
    } catch {
      return '';
    }
  }

  private async listAll<T>(method: string, key: string): Promise<T[] | null> {
    if (!this.connected()) return null;
    try {
      const out: T[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await this.ask(method, cursor ? { cursor } : {}, this.opts.timeoutMs ?? 15_000);
        const items = Array.isArray(result?.[key]) ? result[key] : [];
        out.push(...items.filter((x: any) => x && typeof x.name === 'string'));
        cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
        if (!cursor) break;
      }
      return out;
    } catch {
      return null;
    }
  }

  /** The workspace's tools, as it defines them; null when not paired or not reachable. */
  listTools(): Promise<RemoteTool[] | null> {
    return this.listAll<RemoteTool>('tools/list', 'tools');
  }

  /** The workspace's prompts (its skills); null when not paired or not reachable. */
  listPrompts(): Promise<RemotePrompt[] | null> {
    return this.listAll<RemotePrompt>('prompts/list', 'prompts');
  }

  /** Pass one tool call to the workspace. Never throws: a failure is a soft error the agent can read. */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallResult> {
    if (!this.connected()) return { content: [{ type: 'text', text: NOT_CONNECTED }], isError: true };
    try {
      const result = await this.ask('tools/call', { name, arguments: args }, this.opts.callTimeoutMs ?? 60_000);
      if (result && typeof result === 'object' && Array.isArray(result.content)) return result as CallResult;
      return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
    } catch (err) {
      // A JSON-RPC error (an unknown tool, bad arguments) is the workspace's answer.
      const text = err instanceof ConnectorError && err.rpc ? `the Trail workspace said: ${err.rpc.message}` : `${why(err)} · the repo tools still work`;
      return { content: [{ type: 'text', text }], isError: true };
    }
  }

  /** One of the workspace's prompts, or what went wrong. Never throws. */
  async getPrompt(name: string, args: Record<string, unknown>): Promise<{ result: unknown } | { error: { code: number; message: string } }> {
    if (!this.connected()) return { error: { code: -32603, message: NOT_CONNECTED } };
    try {
      return { result: await this.ask('prompts/get', { name, arguments: args }, this.opts.timeoutMs ?? 15_000) };
    } catch (err) {
      if (err instanceof ConnectorError && err.rpc) return { error: err.rpc };
      return { error: { code: -32603, message: why(err) } };
    }
  }
}
