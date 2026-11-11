import { createHmac } from "node:crypto";
import { NodeCallError, type WorkflowStatus } from "@conclave/contract";
import { defineModule, httpError, requireString, statusForError } from "@conclave/module-sdk";

/** Read a workflow's answer: {text}, {data}, {error}, any other JSON, or plain text. */
function toStatus(body: unknown): WorkflowStatus {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const b = body as { text?: unknown; data?: unknown; error?: unknown; usage?: { costUsd?: unknown } };
    if (typeof b.error === "string" && b.error) return { state: "failed", message: b.error };
    const usage = typeof b.usage?.costUsd === "number" ? { usage: { costUsd: b.usage.costUsd } } : {};
    if (typeof b.text === "string") return { state: "succeeded", output: { text: b.text, ...(b.data !== undefined ? { data: b.data } : {}) }, ...usage };
    if (b.data !== undefined) return { state: "succeeded", output: { data: b.data }, ...usage };
    return { state: "succeeded", output: { data: body } };
  }
  if (typeof body === "string") return { state: "succeeded", output: { text: body } };
  return { state: "succeeded", output: { data: body } };
}

/**
 * Protocol dock (MOD-004): any workflow that starts from a webhook becomes a
 * Workflow-port node, with no module code. Conclave POSTs the step's inputs as
 * JSON. In "wait" mode the webhook's response is the result. In "callback"
 * mode the workflow answers 2xx at once and later POSTs its result to the
 * one-time `callbackUrl` in the request. When a secret is set, requests carry
 * X-Conclave-Signature: sha256=<HMAC of "timestamp.body">.
 */
export default defineModule({
  manifest: {
    id: "conclave/webhook-workflow",
    version: "0.1.0",
    name: "Webhook workflow",
    description: "A workflow in any engine that starts from a webhook. It answers at once, or posts its result back when done.",
    ports: ["workflow@1"],
    docks: ["protocol"],
    config: [
      { key: "url", label: "Webhook URL", type: "url", required: true, placeholder: "https://flows.example.com/webhook/lead-intake" },
      { key: "mode", label: "How it answers", type: "string", default: "wait", help: "wait: the response is the result. callback: it posts the result to the callbackUrl it is sent." },
      { key: "secret", label: "Signing secret", type: "secret", help: "Optional. Requests are signed so the workflow can check they came from here." },
      { key: "name", label: "Workflow name", type: "string", help: "Shown when choosing it for a role." },
      { key: "pricePerCallUsd", label: "Price per run (USD)", type: "number", default: 0 },
    ],
    permissions: { egress: ["{config.url}"], secrets: ["secret"] },
    reference: true,
  },
  create(ctx) {
    const mode = String(ctx.config.mode ?? "wait").trim().toLowerCase() === "callback" ? "callback" : "wait";
    const post = async (body: Record<string, unknown>, signal: AbortSignal) => {
      const url = requireString(ctx.config.url, "Webhook URL");
      const text = JSON.stringify(body);
      const ts = String(Math.floor(Date.now() / 1000));
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/plain", "x-conclave-timestamp": ts };
      if (ctx.secrets.secret) headers["x-conclave-signature"] = `sha256=${createHmac("sha256", ctx.secrets.secret).update(`${ts}.${text}`).digest("hex")}`;
      let res: Response;
      try {
        res = await ctx.fetch(url, { method: "POST", headers, body: text, signal });
      } catch (err) {
        if (signal.aborted) throw err;
        throw new NodeCallError("unavailable", `Could not reach the webhook: ${err instanceof Error ? err.message : String(err)}`, true);
      }
      const raw = await res.text();
      if (!res.ok) throw httpError(res.status, `The webhook answered HTTP ${res.status}${raw ? `: ${raw.slice(0, 300)}` : ""}`);
      try {
        return raw ? (JSON.parse(raw) as unknown) : "";
      } catch {
        return raw;
      }
    };

    return {
      ports: {
        workflow: {
          listWorkflows: async () => [{ id: "webhook", name: String(ctx.config.name || "This webhook") }],
          async trigger(_workflowId, input, call) {
            const deadline = call.call.budget.deadline ? new Date(call.call.budget.deadline).getTime() - Date.now() : 300_000;
            // In wait mode the whole run happens inside this request.
            const signal = AbortSignal.any([call.signal, AbortSignal.timeout(Math.max(5_000, Math.min(mode === "wait" ? deadline : 30_000, 15 * 60_000)))]);
            const body = await post(
              { input: input.data ?? {}, ...(input.text ? { text: input.text } : {}), runId: call.call.runId, stepId: call.call.callId, ...(mode === "callback" && call.callbackUrl ? { callbackUrl: call.callbackUrl } : {}) },
              signal,
            );
            const execution = { executionId: call.call.callId || `webhook-${Date.now()}` };
            if (mode === "callback") return { execution, status: { state: "running", progress: "Started; waiting for its callback" } };
            return { execution, status: toStatus(body) };
          },
          callback: async (_execution, body) => toStatus(body),
        },
      },
      async health() {
        try {
          requireString(ctx.config.url, "Webhook URL");
          // Calling the webhook would start the workflow, so a test only checks the settings.
          return { status: "working", detail: `Ready to call the webhook (${mode === "callback" ? "it answers by callback" : "its response is the result"}).` };
        } catch (err) {
          return statusForError(err);
        }
      },
    };
  },
});
