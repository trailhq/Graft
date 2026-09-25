/**
 * One place that turns resolved config into a {@link ChatModel}. `provider` names
 * the WIRE FORMAT, not a vendor: `openai` speaks the OpenAI-compatible API (point
 * `baseUrl` at OpenRouter, Fireworks, a LiteLLM proxy, Groq, a local server, …),
 * `anthropic` speaks the native Messages API. Adding a vendor is a base URL, not
 * a code change; adding a wire format is one new adapter here.
 *
 * `litellm` is a convenience over `openai`: same wire format, but pointed at a
 * LiteLLM proxy by default and paired with `/v1/models` auto-discovery
 * (see litellm.ts), so one endpoint reaches 100+ providers.
 *
 * `orcarouter` is the same kind of convenience over `openai`, pointed at the
 * OrcaRouter AI gateway by default (see orcarouter.ts) so its users get the
 * gateway's routing, failover, and guardrails behind a named provider instead
 * of a bare custom base URL.
 *
 * `claude-code` is the one provider that is not a wire format: it runs the local
 * `claude` binary headless (see claude-code.ts), so it takes no key and no base
 * URL — Claude Code's own sign-in pays for the call.
 */
import type { ChatModel } from "./types.js";
import { OpenAIChatModel } from "./openai.js";
import { AnthropicChatModel } from "./anthropic.js";
import { LiteLLMChatModel } from "./litellm.js";
import { OrcaRouterChatModel } from "./orcarouter.js";
import { ClaudeCodeChatModel } from "./claude-code.js";

export type ProviderKind = "openai" | "anthropic" | "litellm" | "orcarouter" | "claude-code";

/** Whether the provider needs an API key. Only `claude-code` does not. */
export function providerNeedsKey(provider: ProviderKind): boolean {
  return provider !== "claude-code";
}

export interface ChatModelConfig {
  provider: ProviderKind;
  /** Required by every provider except `claude-code`. */
  apiKey?: string;
  model: string;
  baseUrl?: string;
  /** Extra default headers for OpenAI-compatible endpoints (e.g. OpenRouter `X-Title`). */
  headers?: Record<string, string>;
}

export function createChatModel(cfg: ChatModelConfig): ChatModel {
  const apiKey = (): string => {
    if (!cfg.apiKey) throw new Error(`the ${cfg.provider} provider needs an API key (GRAFT_API_KEY)`);
    return cfg.apiKey;
  };
  switch (cfg.provider) {
    case "anthropic":
      return new AnthropicChatModel({ apiKey: apiKey(), model: cfg.model, baseUrl: cfg.baseUrl });
    case "openai":
      return new OpenAIChatModel({
        apiKey: apiKey(),
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        headers: cfg.headers,
      });
    case "litellm":
      return new LiteLLMChatModel({
        apiKey: apiKey(),
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        headers: cfg.headers,
      });
    case "orcarouter":
      return new OrcaRouterChatModel({
        apiKey: apiKey(),
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        headers: cfg.headers,
      });
    case "claude-code":
      return new ClaudeCodeChatModel({ model: cfg.model });
    default: {
      const _exhaustive: never = cfg.provider;
      throw new Error(`unknown provider: ${String(_exhaustive)}`);
    }
  }
}
