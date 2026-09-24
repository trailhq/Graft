/**
 * Requesty transport. The Requesty router speaks the OpenAI-compatible wire
 * format, so this reuses the OpenAI adapter's request/response translation and
 * simply points it at the router. The value over a bare `openai` provider +
 * `baseUrl` is a first-class, self-describing provider: a sensible default
 * router address and model auto-discovery (see {@link listRequestyModels}), so
 * callers can enumerate whatever upstream models the router reaches (700+ from
 * OpenAI, Anthropic, Google, DeepSeek, xAI, and more) through one endpoint
 * without a per-vendor code path.
 *
 * Model ids are `<vendor>/<model>` (e.g. `openai/gpt-4o-mini`) or the short id
 * of a Requesty managed policy (e.g. `claude-sonnet-4-5`), a Requesty-maintained
 * routing chain across providers for one model. Regional routers exist at
 * `https://router.eu.requesty.ai/v1` (EU), `https://router.us.requesty.ai/v1`
 * (US) and `https://router.ap.requesty.ai/v1` (AP); pass one as `baseUrl` or
 * set REQUESTY_BASE_URL to pin a region. The same key works on all of them.
 */
import OpenAI from "openai";
import { OpenAIChatModel, type OpenAIChatModelOptions } from "./openai.js";
import { transportRetries } from "./types.js";

/** Public endpoint of the Requesty router. */
export const DEFAULT_REQUESTY_BASE_URL = "https://router.requesty.ai/v1";

export type RequestyChatModelOptions = OpenAIChatModelOptions;

/**
 * ChatModel backed by the Requesty router. Inherits every translation detail
 * from {@link OpenAIChatModel} (the router is OpenAI-compatible) and only
 * changes the defaults: the router base URL and a `requesty:<model>` label.
 */
export class RequestyChatModel extends OpenAIChatModel {
  constructor(opts: RequestyChatModelOptions) {
    super({
      ...opts,
      baseUrl: opts.baseUrl ?? DEFAULT_REQUESTY_BASE_URL,
      label: opts.label ?? `requesty:${opts.model}`,
    });
  }
}

/** One entry of a Requesty `/v1/models` or `/v1/models/managed` listing. */
interface RequestyModelEntry {
  id: string;
  /** "chat", "embedding", ...; only chat models are useful to graft. */
  api?: string;
}

/**
 * Auto-discover the models the Requesty router can route to. Reads the curated
 * managed policies first (`GET /v1/models/managed`, short stable ids users
 * should see first), then the full `<vendor>/<model>` catalog (`GET
 * /v1/models`), and returns the merged, de-duplicated chat model ids in that
 * order. If one endpoint fails the other's ids are still returned; only when
 * both fail does the error propagate. A stub `client` may be injected for tests.
 */
export async function listRequestyModels(opts: {
  apiKey: string;
  baseUrl?: string;
  client?: OpenAI;
}): Promise<string[]> {
  const client =
    opts.client ??
    new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl ?? DEFAULT_REQUESTY_BASE_URL,
      maxRetries: transportRetries(),
    });

  const [managed, catalog] = await Promise.allSettled([
    client.get("/models/managed") as Promise<{ data?: RequestyModelEntry[] }>,
    client.models.list(),
  ]);
  if (managed.status === "rejected" && catalog.status === "rejected") throw managed.reason;

  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (entries: RequestyModelEntry[] | undefined) => {
    for (const m of entries ?? []) {
      if (m.api !== undefined && m.api !== "chat") continue;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      ids.push(m.id);
    }
  };
  if (managed.status === "fulfilled") add(managed.value.data);
  if (catalog.status === "fulfilled") add(catalog.value.data as RequestyModelEntry[]);
  return ids;
}
