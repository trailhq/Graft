/**
 * Atlas Cloud transport. The Atlas Cloud gateway speaks the OpenAI-compatible
 * wire format, so this reuses the OpenAI adapter's request/response translation
 * and simply points it at the gateway. The value over a bare `openai` provider +
 * `baseUrl` is a first-class, self-describing provider: a sensible default
 * gateway address and `/v1/models` auto-discovery (see {@link listAtlasCloudModels}),
 * so callers can enumerate whatever upstream models the gateway routes to —
 * reaching Qwen, DeepSeek, Kimi, GLM, MiniMax and more through one endpoint
 * without a per-vendor code path.
 */
import OpenAI from "openai";
import { OpenAIChatModel, type OpenAIChatModelOptions } from "./openai.js";
import { transportRetries } from "./types.js";

/** Public endpoint of the Atlas Cloud gateway. */
export const DEFAULT_ATLASCLOUD_BASE_URL = "https://api.atlascloud.ai/v1";

export type AtlasCloudChatModelOptions = OpenAIChatModelOptions;

/**
 * ChatModel backed by the Atlas Cloud gateway. Inherits every translation detail
 * from {@link OpenAIChatModel} (the gateway is OpenAI-compatible) and only
 * changes the defaults: the gateway base URL and an `atlascloud:<model>` label.
 */
export class AtlasCloudChatModel extends OpenAIChatModel {
  constructor(opts: AtlasCloudChatModelOptions) {
    super({
      ...opts,
      baseUrl: opts.baseUrl ?? DEFAULT_ATLASCLOUD_BASE_URL,
      label: opts.label ?? `atlascloud:${opts.model}`,
    });
  }
}

/**
 * Auto-discover the models the Atlas Cloud gateway can route to via `GET
 * /v1/models`. Returns the model ids so a caller can present/validate them
 * instead of hardcoding a model string. A stub `client` may be injected for tests.
 */
export async function listAtlasCloudModels(opts: {
  apiKey: string;
  baseUrl?: string;
  client?: OpenAI;
}): Promise<string[]> {
  const client =
    opts.client ??
    new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl ?? DEFAULT_ATLASCLOUD_BASE_URL,
      maxRetries: transportRetries(),
    });
  const res = await client.models.list();
  return res.data.map((m) => m.id);
}
