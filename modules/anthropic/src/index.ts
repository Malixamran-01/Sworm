import Anthropic from "@anthropic-ai/sdk";
import {
  NodeCallError,
  type CallContext,
  type Effort,
  type GenerateRequest,
  type GenerateResult,
  type ModelInfo,
  type Pricing,
} from "@conclave/contract";
import { defineModule, requireString, statusForError, type ModuleContext } from "@conclave/module-sdk";

/**
 * First-party per-token prices, USD per 1M tokens (cached 2026-10-06).
 * Haiku 5.5 prices apply to prompts up to 100K tokens.
 */
export const CLAUDE_PRICING: Record<string, Pricing & { displayName: string }> = {
  "claude-opus-5-5": { displayName: "Claude Opus 5.5", inputPerMTok: 4, outputPerMTok: 20 },
  "claude-sonnet-5-5": { displayName: "Claude Sonnet 5.5", inputPerMTok: 2, outputPerMTok: 10 },
  "claude-haiku-5-5": { displayName: "Claude Haiku 5.5", inputPerMTok: 0.1, outputPerMTok: 0.5 },
  "claude-fable-5-1": { displayName: "Claude Fable 5.1", inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-5": { displayName: "Claude Opus 5", inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { displayName: "Claude Sonnet 5", inputPerMTok: 2, outputPerMTok: 10 },
};

/** Models that accept server-side refusal fallbacks in the "default" form. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
/** Models that accept output_config.effort. */
const EFFORT_MODELS = new Set(Object.keys(CLAUDE_PRICING));

export const DEFAULT_MODEL = "claude-opus-5-5";

export default defineModule({
  manifest: {
    id: "conclave/anthropic",
    version: "0.1.0",
    name: "Anthropic (Claude)",
    description: "Claude models through the official Anthropic SDK, with streaming, effort control and server-side refusal fallback.",
    ports: ["model@1"],
    docks: ["built-in", "sidecar"],
    config: [
      { key: "apiKey", label: "API key", type: "secret", required: true, placeholder: "sk-ant-…" },
      { key: "baseUrl", label: "Base URL", type: "url", required: false, help: "Only for a proxy. Leave empty for api.anthropic.com." },
    ],
    permissions: { egress: ["api.anthropic.com", "{config.baseUrl}"], secrets: ["apiKey"] },
    outsideVersions: { "anthropic-sdk": "^1.6.0" },
    nodeUi: { icon: "sparkle" },
    reference: true,
  },
  create(ctx) {
    const claude = new ClaudeModel(ctx);
    return {
      ports: {
        model: {
          listModels: () => claude.listModels(),
          generate: (req, call) => claude.generate(req, call),
        },
      },
      async health(signal) {
        try {
          await claude.client().models.list({ limit: 1 }, signal ? { signal } : undefined);
          return { status: "working", detail: "Signed in to the Anthropic API." };
        } catch (err) {
          return statusForError(mapError(err));
        }
      },
      async discover(signal) {
        const models = await claude.listModels(signal);
        return { models: models.map((m) => ({ id: m.id, ...(m.displayName ? { displayName: m.displayName } : {}) })) };
      },
    };
  },
});

class ClaudeModel {
  private readonly ctx: ModuleContext;
  private cached: Anthropic | undefined;

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
  }

  client(): Anthropic {
    if (!this.cached) {
      const baseURL = typeof this.ctx.config.baseUrl === "string" && this.ctx.config.baseUrl ? this.ctx.config.baseUrl : undefined;
      this.cached = new Anthropic({
        apiKey: requireString(this.ctx.secrets.apiKey, "API key"),
        ...(baseURL ? { baseURL } : {}),
        fetch: this.ctx.fetch,
        // The orchestrator owns retries so budgets and attempts stay accurate.
        maxRetries: 0,
      });
    }
    return this.cached;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const known = Object.entries(CLAUDE_PRICING).map(([id, p]) => ({
      id,
      displayName: p.displayName,
      pricing: { inputPerMTok: p.inputPerMTok, outputPerMTok: p.outputPerMTok },
    }));
    try {
      const page = await this.client().models.list({ limit: 100 }, signal ? { signal } : undefined);
      const live = page.data.map((m) => {
        const p = CLAUDE_PRICING[m.id];
        return {
          id: m.id,
          displayName: m.display_name,
          ...(p ? { pricing: { inputPerMTok: p.inputPerMTok, outputPerMTok: p.outputPerMTok } } : {}),
        };
      });
      return live.length > 0 ? live : known;
    } catch {
      return known;
    }
  }

  async generate(req: GenerateRequest, call: CallContext): Promise<GenerateResult> {
    if (call.signal.aborted) throw new NodeCallError("cancelled", "The call was cancelled.", false);
    if (!req.model || req.messages.length === 0) {
      throw new NodeCallError("invalid_request", "A model and at least one message are required.", false);
    }

    const system =
      req.responseFormat === "json"
        ? `${req.system ?? ""}\n\nRespond with a single JSON object and nothing else.`.trim()
        : req.system;
    const effort: Effort | undefined = EFFORT_MODELS.has(req.model) ? (req.effort ?? "high") : undefined;
    const useFallback = FALLBACK_MODELS.has(req.model);

    try {
      const stream = this.client().beta.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          ...(system ? { system } : {}),
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          ...(effort ? { output_config: { effort } } : {}),
          ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal: call.signal },
      );
      stream.on("text", (delta) => call.emit({ type: "text_delta", data: delta }));
      const message = await stream.finalMessage();

      if (message.stop_reason === "refusal") {
        const category = message.stop_details?.category;
        throw new NodeCallError("refused", `Claude declined this request${category ? ` (${category})` : ""}.`, false);
      }

      const text = message.content
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("");

      return {
        text,
        model: message.model,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        },
        usageSource: "reported",
        stopReason: message.stop_reason ?? "unknown",
      };
    } catch (err) {
      throw mapError(err);
    }
  }
}

/** Most-specific first, so retryable and non-retryable failures stay distinct. */
function mapError(err: unknown): NodeCallError {
  if (err instanceof NodeCallError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new NodeCallError("cancelled", "The call was cancelled.", false);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new NodeCallError("auth", `Anthropic rejected the credentials: ${err.message}`, false);
  }
  if (err instanceof Anthropic.NotFoundError) return new NodeCallError("not_found", err.message, false);
  if (err instanceof Anthropic.RateLimitError) return new NodeCallError("rate_limited", err.message, true);
  if (err instanceof Anthropic.BadRequestError) return new NodeCallError("invalid_request", err.message, false);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new NodeCallError("timeout", err.message, true);
  if (err instanceof Anthropic.APIConnectionError) return new NodeCallError("unavailable", err.message, true);
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    return new NodeCallError(status >= 500 || status === 529 ? "unavailable" : "invalid_request", err.message, status >= 500);
  }
  if (err instanceof Error && err.name === "AbortError") return new NodeCallError("cancelled", "The call was cancelled.", false);
  return new NodeCallError("internal", err instanceof Error ? err.message : String(err), false);
}
