/**
 * Opper transport. Opper (https://opper.ai) is an EU-hosted AI gateway that
 * speaks the OpenAI-compatible wire format, so this reuses the OpenAI adapter's
 * request/response translation and simply points it at the gateway. The value
 * over a bare `openai` provider + `baseUrl` is a first-class, self-describing
 * provider: the gateway address by default, an `opper:<model>` label, and
 * `/models` auto-discovery (see {@link listOpperModels}), so callers can
 * enumerate the 700+ models from 30+ providers the gateway routes to through
 * one endpoint and one key, without a per-vendor code path.
 *
 * Model ids are Opper *pool* names such as `claude-sonnet-4-6` or `gpt-5.5`:
 * a pool is every provider serving that model, and the gateway picks the route
 * per request. A `vendor/model` id (`anthropic/claude-sonnet-4-6`,
 * `azure/gpt-5.5`) pins one provider instead.
 */
import OpenAI from "openai";
import { OpenAIChatModel, type OpenAIChatModelOptions } from "./openai.js";
import { transportRetries } from "./types.js";

/** Public OpenAI-compatible endpoint of the Opper gateway. */
export const DEFAULT_OPPER_BASE_URL = "https://api.opper.ai/v3/compat";

export type OpperChatModelOptions = OpenAIChatModelOptions;

/**
 * ChatModel backed by the Opper gateway. Inherits every translation detail
 * from {@link OpenAIChatModel} (the gateway is OpenAI-compatible) and only
 * changes the defaults: the gateway base URL and an `opper:<model>` label.
 */
export class OpperChatModel extends OpenAIChatModel {
  constructor(opts: OpperChatModelOptions) {
    super({
      ...opts,
      baseUrl: opts.baseUrl ?? DEFAULT_OPPER_BASE_URL,
      label: opts.label ?? `opper:${opts.model}`,
    });
  }
}

/**
 * Auto-discover the models the Opper gateway can route to via `GET /models`
 * (authenticated with the same key). Returns the model ids — pool names and
 * vendor-pinned routes alike — so a caller can present/validate them instead
 * of hardcoding a model string. A stub `client` may be injected for tests.
 */
export async function listOpperModels(opts: {
  apiKey: string;
  baseUrl?: string;
  client?: OpenAI;
}): Promise<string[]> {
  const client =
    opts.client ??
    new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl ?? DEFAULT_OPPER_BASE_URL,
      maxRetries: transportRetries(),
    });
  const res = await client.models.list();
  return res.data.map((m) => m.id);
}
