import { NodeCallError, type CallContext, type GenerateRequest, type GenerateResult, type ModelInfo } from "@conclave/contract";
import { defineModule, httpError, requireString, statusForError, type ModuleContext } from "@conclave/module-sdk";

/**
 * Protocol dock (MOD-004): any endpoint that speaks the OpenAI chat
 * completions API becomes a Model-port node with no module code.
 */
export default defineModule({
  manifest: {
    id: "conclave/openai-compatible",
    version: "0.1.0",
    name: "OpenAI-compatible endpoint",
    description:
      "Any server that speaks the OpenAI chat completions API: OpenAI, Ollama, vLLM, LM Studio, OpenRouter, Groq, Together and others.",
    ports: ["model@1"],
    docks: ["protocol"],
    config: [
      { key: "baseUrl", label: "Base URL", type: "url", required: true, placeholder: "https://api.openai.com/v1", help: "The URL that /chat/completions hangs off." },
      { key: "apiKey", label: "API key", type: "secret", required: false, help: "Leave empty for local servers that need no key." },
      { key: "models", label: "Models", type: "string", required: false, placeholder: "gpt-5.1, llama3.3", help: "Comma-separated. Leave empty to list them from the server." },
      { key: "inputPricePerMTok", label: "Input price (USD per 1M tokens)", type: "number", required: false, default: 0 },
      { key: "outputPricePerMTok", label: "Output price (USD per 1M tokens)", type: "number", required: false, default: 0 },
    ],
    permissions: { egress: ["{config.baseUrl}"], secrets: ["apiKey"] },
    reference: true,
  },
  create(ctx) {
    const client = new OpenAICompatibleClient(ctx);
    return {
      ports: {
        model: {
          listModels: () => client.listModels(),
          generate: (req, call) => client.generate(req, call),
        },
      },
      async health(signal) {
        try {
          const models = await client.listModels(signal);
          return { status: "working", detail: `${models.length} model(s) available.` };
        } catch (err) {
          return statusForError(err);
        }
      },
      async discover(signal) {
        const models = await client.listModels(signal);
        return { models: models.map((m) => ({ id: m.id })) };
      },
    };
  },
});

class OpenAICompatibleClient {
  private readonly ctx: ModuleContext;

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
  }

  private get baseUrl(): string {
    return requireString(this.ctx.config.baseUrl, "Base URL").replace(/\/+$/, "");
  }

  private get pricing() {
    return {
      inputPerMTok: Number(this.ctx.config.inputPricePerMTok ?? 0) || 0,
      outputPerMTok: Number(this.ctx.config.outputPricePerMTok ?? 0) || 0,
    };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.ctx.secrets.apiKey) headers.authorization = `Bearer ${this.ctx.secrets.apiKey}`;
    return headers;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const configured = String(this.ctx.config.models ?? "")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    if (configured.length > 0) return configured.map((id) => ({ id, pricing: this.pricing }));

    const res = await this.request(`${this.baseUrl}/models`, { method: "GET", headers: this.headers(), ...(signal ? { signal } : {}) });
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => ({ id: m.id, pricing: this.pricing }));
  }

  async generate(req: GenerateRequest, call: CallContext): Promise<GenerateResult> {
    if (call.signal.aborted) throw new NodeCallError("cancelled", "The call was cancelled.", false);
    if (!req.model || req.messages.length === 0) {
      throw new NodeCallError("invalid_request", "A model and at least one message are required.", false);
    }

    const messages = [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      ...req.messages.map((m) => ({ role: m.role, content: m.content })),
    ];
    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      max_tokens: req.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.responseFormat === "json") body.response_format = { type: "json_object" };

    const res = await this.request(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: call.signal,
    });

    let text = "";
    let stopReason = "unknown";
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    for await (const data of readSse(res, call.signal)) {
      if (data === "[DONE]") break;
      let chunk: {
        choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) {
        text += delta;
        call.emit({ type: "text_delta", data: delta });
      }
      if (choice?.finish_reason) stopReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }

    if (stopReason === "content_filter") throw new NodeCallError("refused", "The provider's content filter declined this request.", false);

    if (usage && Number.isInteger(usage.prompt_tokens) && Number.isInteger(usage.completion_tokens)) {
      return {
        text,
        model: req.model,
        usage: { inputTokens: usage.prompt_tokens!, outputTokens: usage.completion_tokens! },
        usageSource: "reported",
        stopReason,
      };
    }
    // Some servers send no usage. Count characters and say so (COST-006).
    const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
    return {
      text,
      model: req.model,
      usage: { inputTokens: Math.ceil(promptChars / 4), outputTokens: Math.ceil(text.length / 4) },
      usageSource: "estimated",
      stopReason,
    };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.ctx.fetch(url, init);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw new NodeCallError("cancelled", "The call was cancelled.", false);
      throw new NodeCallError("unavailable", `Could not reach ${new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw httpError(res.status, `${new URL(url).host} answered ${res.status}: ${detail.slice(0, 300)}`);
    }
    return res;
  }
}

/** Yields the data field of each server-sent event. */
async function* readSse(res: Response, signal: AbortSignal): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw new NodeCallError("cancelled", "The call was cancelled.", false);
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
