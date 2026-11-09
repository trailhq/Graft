/**
 * A stand-in for trail-cloud's workspace MCP server at `/mcp`: Streamable
 * HTTP as the Go MCP SDK serves it. Two modes:
 *
 *   - `stateless` (default, what trail-cloud runs): JSON answers, no session.
 *   - `session`: SSE answers and an `Mcp-Session-Id` the client must send
 *     back; an unknown id is a 404, as the SDK answers a session it dropped.
 *
 * Its tools, prompts and instructions are the workspace's: get_context,
 * get_brand, search_learnings, save_learning (with `always_follow`),
 * use_skill and finish_skill, one prompt per team skill. Every request is
 * kept in `log`, in order. `delayMs` holds every answer back, to play a
 * slow cloud.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const WORKSPACE_TOKEN = "trl_test_token";

export const WORKSPACE_INSTRUCTIONS =
  "Trail is Acme's memory: 12 learnings across 2 repos.\n\nSkills, best first:\n- Release to npm (worked 3 times)\n\nBefore you draft or decide anything else about the team's code, product or way of working, call get_context.";

const reads = { readOnlyHint: true };

export const WORKSPACE_TOOLS = [
  {
    name: "get_context",
    description: "Your team's learnings that bear on a task, best match first.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    annotations: reads,
  },
  { name: "get_brand", description: "The team's brand profile.", inputSchema: { type: "object", properties: {} }, annotations: reads },
  {
    name: "search_learnings",
    description: "Search the team's learnings by words.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, repo: { type: "string" } }, required: ["query"] },
    annotations: reads,
  },
  {
    name: "save_learning",
    description: "Save a new learning for the team.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" }, always_follow: { type: "boolean" } },
      required: ["title", "body"],
    },
  },
  { name: "use_skill", description: "The team's steps for a job.", inputSchema: { type: "object", properties: { name: { type: "string" } } }, annotations: reads },
  {
    name: "finish_skill",
    description: "Say how a job done with use_skill went.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, outcome: { type: "string" } }, required: ["name", "outcome"] },
  },
];

export const WORKSPACE_PROMPTS = [
  {
    name: "release-to-npm",
    title: "Release to npm",
    description: "How we publish a version.",
    arguments: [{ name: "task", title: "The job", description: "What you want, in a sentence." }],
  },
];

export interface Logged {
  method: string;
  path: string;
  auth?: string;
  session?: string;
  protocol?: string;
  body: any;
}

export interface FakeWorkspace {
  url: string;
  log: Logged[];
  /** Forget every session, as a restarted server would. */
  dropSessions(): void;
  close(): Promise<void>;
}

export interface FakeWorkspaceOpts {
  mode?: "stateless" | "session";
  delayMs?: number;
  port?: number;
  /** Answer every request with a 307 to this origin, as a server moved elsewhere (or a hostile one) would. */
  redirectTo?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (d) => (s += d));
    req.on("end", () => resolve(s));
  });
}

/** What the workspace answers to one JSON-RPC request: a result, or an error. */
export function answerWorkspace(body: any): { result?: unknown; error?: { code: number; message: string } } {
  switch (body?.method) {
    case "initialize":
      return {
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: true }, prompts: { listChanged: true }, logging: {} },
          serverInfo: { name: "trail", title: "Trail · Acme", version: "0.1.0" },
          instructions: WORKSPACE_INSTRUCTIONS,
        },
      };
    case "ping":
      return { result: {} };
    case "tools/list":
      return { result: { tools: WORKSPACE_TOOLS } };
    case "prompts/list":
      return { result: { prompts: WORKSPACE_PROMPTS } };
    case "prompts/get": {
      const { name, arguments: args } = body.params ?? {};
      // A server that answers with no result at all.
      if (name === "empty") return { result: null };
      const p = WORKSPACE_PROMPTS.find((x) => x.name === name);
      if (!p) return { error: { code: -32602, message: `unknown prompt "${name}"` } };
      const task = args?.task ? `\n\nThe job: ${args.task}` : "";
      return {
        result: {
          description: p.title,
          messages: [{ role: "user", content: { type: "text", text: `Use the team's "${p.title}" skill from Trail: call use_skill with that name.${task}` } }],
        },
      };
    }
    case "tools/call": {
      const { name, arguments: args } = body.params ?? {};
      if (name === "get_context")
        return {
          result: {
            content: [{ type: "text", text: `Store money in integer cents. (asked: ${args?.query})` }],
            structuredContent: { learnings: [{ title: "Store money in integer cents", always_follow: true }] },
          },
        };
      if (name === "save_learning")
        return { result: { content: [{ type: "text", text: `saved "${args?.title}"${args?.always_follow ? " as always follow" : ""}` }] } };
      if (WORKSPACE_TOOLS.some((t) => t.name === name)) return { result: { content: [{ type: "text", text: `${name} ok` }] } };
      return { result: { content: [{ type: "text", text: `unknown tool "${name}"` }], isError: true } };
    }
    default:
      return { error: { code: -32601, message: `method not found: ${body?.method}` } };
  }
}

export async function startFakeWorkspace(opts: FakeWorkspaceOpts = {}): Promise<FakeWorkspace> {
  const mode = opts.mode ?? "stateless";
  const log: Logged[] = [];
  const sessions = new Set<string>();
  let nextSession = 1;
  const server: Server = createServer(async (req, res: ServerResponse) => {
    const text = await readBody(req);
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* kept as null */
    }
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const session = req.headers["mcp-session-id"] as string | undefined;
    log.push({ method: req.method ?? "", path, auth: req.headers.authorization, session, protocol: req.headers["mcp-protocol-version"] as string | undefined, body });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));

    if (opts.redirectTo) {
      res.writeHead(307, { location: `${opts.redirectTo}${req.url ?? "/"}` }).end();
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${WORKSPACE_TOKEN}`) {
      res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="http://x/.well-known/oauth-protected-resource"', "content-type": "text/plain" });
      res.end("Unauthorized\n");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const accept = String(req.headers.accept ?? "");
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      res.writeHead(400).end("Accept must contain both 'application/json' and 'text/event-stream'\n");
      return;
    }

    const headers: Record<string, string> = {};
    if (mode === "session") {
      if (body?.method === "initialize") {
        const id = `s${nextSession++}`;
        sessions.add(id);
        headers["mcp-session-id"] = id;
      } else if (!session || !sessions.has(session)) {
        res.writeHead(404, { "content-type": "text/plain" }).end("session not found\n");
        return;
      } else headers["mcp-session-id"] = session;
    }
    if (body?.id === undefined) {
      res.writeHead(202, headers).end();
      return;
    }
    const a = answerWorkspace(body);
    const msg = a.error ? { jsonrpc: "2.0", id: body.id, error: a.error } : { jsonrpc: "2.0", id: body.id, result: a.result };
    if (mode === "session") {
      res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
      res.end(`event: message\nid: 1\ndata: ${JSON.stringify(msg)}\n\n`);
      return;
    }
    res.writeHead(200, { ...headers, "content-type": "application/json" });
    res.end(JSON.stringify(msg));
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    log,
    dropSessions: () => sessions.clear(),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
