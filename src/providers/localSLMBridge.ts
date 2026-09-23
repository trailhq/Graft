/**
 * PR 3: Local SLM Provider Bridge (`localSLMBridge.ts`)
 *
 * Implements an OpenAI-compatible wrapper with local loopback baseURL support
 * (Ollama, vLLM, LM Studio, LiteLLM) and automatic API key bypass for local endpoints.
 */
import { OpenAI } from "openai";

export interface LocalSLMConfig {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
}

export class LocalSLMBridge {
  private client: OpenAI;
  private model: string;

  constructor(config: LocalSLMConfig) {
    this.model = config.model || "llama3";
    const baseURL = config.baseUrl || "http://localhost:11434/v1";
    
    // Auto-bypass API key for local loopback URLs if not provided
    let apiKey = config.apiKey;
    if (!apiKey && (baseURL.includes("localhost") || baseURL.includes("127.0.0.1"))) {
      apiKey = "ollama-local-bypass";
    }

    this.client = new OpenAI({
      baseURL,
      apiKey: apiKey || "not-needed",
    });
  }

  public async complete(prompt: string, options?: { systemPrompt?: string; temperature?: number }): Promise<string> {
    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature: options?.temperature ?? 0.2,
    });

    return response.choices[0]?.message?.content ?? "";
  }

  public async *streamComplete(prompt: string, options?: { systemPrompt?: string }): AsyncGenerator<string, void, unknown> {
    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }
}
