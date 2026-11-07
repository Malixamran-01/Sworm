import { NodeCallError, type GenerateRequest } from "@conclave/contract";
import { defineModule } from "@conclave/module-sdk";

/**
 * A deterministic model for tests and for trying Conclave without keys.
 *
 * Control markers in the prompt, for tests:
 *   [[fail:N]]   the first N attempts of a step fail with a retryable error
 *   [[refuse]]   the call is refused
 *   [[slow:MS]]  the call takes MS milliseconds (honours cancellation)
 */

const PRICING = {
  "mock-small": { inputPerMTok: 1, outputPerMTok: 2 },
  "mock-large": { inputPerMTok: 10, outputPerMTok: 30 },
} as const;

export const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

export default defineModule({
  manifest: {
    id: "conclave/mock-model",
    version: "0.1.0",
    name: "Mock model",
    description: "Deterministic model that echoes a summary of its prompt. Free, offline, for tests and demos.",
    ports: ["model@1"],
    docks: ["built-in"],
    config: [
      { key: "latencyMs", label: "Simulated latency (ms)", type: "number", default: 0 },
    ],
    reference: true,
  },
  create(ctx) {
    const latency = Number(ctx.config.latencyMs ?? 0);
    return {
      ports: {
        model: {
          async listModels() {
            return Object.entries(PRICING).map(([id, pricing]) => ({ id, displayName: id, pricing }));
          },
          async generate(req: GenerateRequest, call) {
            if (call.signal.aborted) throw new NodeCallError("cancelled", "The call was cancelled.", false);
            if (!req.model || req.messages.length === 0) {
              throw new NodeCallError("invalid_request", "A model and at least one message are required.", false);
            }
            if (!(req.model in PRICING)) throw new NodeCallError("not_found", `Unknown mock model "${req.model}".`, false);

            const prompt = req.messages.map((m) => m.content).join("\n");
            const attempt = Number(call.call.idempotencyKey.split(":").at(-1) ?? 1);
            const fail = /\[\[fail:(\d+)\]\]/.exec(prompt);
            if (fail && attempt <= Number(fail[1])) {
              throw new NodeCallError("unavailable", `Simulated outage on attempt ${attempt}.`, true);
            }
            if (prompt.includes("[[refuse]]")) throw new NodeCallError("refused", "Simulated refusal.", false);
            const slow = /\[\[slow:(\d+)\]\]/.exec(prompt);
            await sleep(Number(slow?.[1] ?? latency), call.signal);

            const last = req.messages.at(-1)?.content ?? "";
            const firstLine = last.split("\n").find((l) => l.trim()) ?? "";
            const text =
              req.responseFormat === "json"
                ? JSON.stringify({ model: req.model, summary: firstLine.slice(0, 120) })
                : `[${req.model}] ${firstLine.slice(0, 200)}`.trim();

            for (const chunk of text.match(/.{1,24}/gs) ?? []) call.emit({ type: "text_delta", data: chunk });

            const input = estimateTokens((req.system ?? "") + prompt);
            const output = Math.min(req.maxTokens, estimateTokens(text));
            return { text, model: req.model, usage: { inputTokens: input, outputTokens: output }, usageSource: "reported", stopReason: "end_turn" };
          },
        },
      },
      async health() {
        return { status: "working", detail: "Mock model is always available." };
      },
      async discover() {
        return { models: Object.keys(PRICING).map((id) => ({ id })) };
      },
    };
  },
});

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new NodeCallError("cancelled", "The call was cancelled.", false));
      },
      { once: true },
    );
  });
}
