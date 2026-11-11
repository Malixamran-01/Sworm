import { NodeCallError, type WorkflowExecution, type WorkflowInfo, type WorkflowStatus } from "@conclave/contract";
import { defineModule, httpError, requireString, statusForError } from "@conclave/module-sdk";

/**
 * n8n as a Workflow-port node. The public API (/api/v1, X-N8N-API-KEY) lists
 * workflows, reads executions and stops them, but has no call that starts a
 * workflow. So a workflow is started the way n8n means it to be: through its
 * Webhook node. This module finds that node's path from the API, posts the
 * step's inputs to it, then finds the execution it started and follows it.
 *
 * What it adds over the plain webhook dock: the workflows are listed for you,
 * a run that answers later is followed without a callback, its real output
 * and error come back, and cancelling the task stops the execution.
 */

const WEBHOOK_NODE = "n8n-nodes-base.webhook";

interface N8nNode {
  type?: string;
  name?: string;
  disabled?: boolean;
  parameters?: { path?: unknown; httpMethod?: unknown; responseMode?: unknown };
}
interface N8nWorkflow {
  id: string;
  name?: string;
  active?: boolean;
  activeVersionId?: string | null;
  isArchived?: boolean;
  nodes?: N8nNode[];
}
interface N8nExecution {
  id: string | number;
  status?: string;
  finished?: boolean;
  mode?: string;
  startedAt?: string | null;
  stoppedAt?: string | null;
  workflowId?: string | number;
  data?: {
    resultData?: {
      lastNodeExecuted?: string;
      error?: { message?: string; description?: string };
      runData?: Record<string, { data?: { main?: ({ json?: unknown }[] | null)[] } }[]>;
    };
  };
}

const webhookOf = (w: N8nWorkflow): N8nNode | undefined => w.nodes?.find((n) => n.type === WEBHOOK_NODE && !n.disabled && typeof n.parameters?.path === "string" && n.parameters.path);
/** n8n calls a published workflow "active" in older versions; newer ones set activeVersionId. */
const isLive = (w: N8nWorkflow): boolean => !w.isArchived && (w.activeVersionId !== undefined ? w.activeVersionId !== null : w.active === true);

/** What the last node of a finished execution produced. */
export function outputOf(execution: N8nExecution): { text?: string; data?: unknown } {
  const result = execution.data?.resultData;
  const runs = result?.lastNodeExecuted ? result.runData?.[result.lastNodeExecuted] : undefined;
  const items = (runs?.at(-1)?.data?.main?.[0] ?? []).map((i) => i.json);
  if (items.length === 0) return { data: {} };
  const data = items.length === 1 ? items[0] : items;
  const text = items.length === 1 && items[0] && typeof items[0] === "object" ? (items[0] as { text?: unknown }).text : undefined;
  return { ...(typeof text === "string" ? { text } : {}), data };
}

/** An n8n execution as a contract status. */
export function statusOf(execution: N8nExecution): WorkflowStatus {
  const status = execution.status ?? (execution.finished ? "success" : "running");
  if (status === "success") return { state: "succeeded", output: outputOf(execution) };
  if (status === "canceled") return { state: "cancelled" };
  if (status === "error" || status === "crashed") {
    const err = execution.data?.resultData?.error;
    const where = execution.data?.resultData?.lastNodeExecuted;
    return { state: "failed", message: `${err?.message ?? "The n8n workflow failed."}${where ? ` (at the node "${where}")` : ""}`, code: "internal", retryable: false };
  }
  return { state: "running", progress: status === "waiting" ? "Waiting inside n8n" : "Running in n8n" };
}

export default defineModule({
  manifest: {
    id: "conclave/n8n",
    version: "1.0.0",
    name: "n8n",
    description: "Workflows in your n8n. Lists the published ones that start from a webhook, runs them, follows the execution and stops it when the task is cancelled.",
    ports: ["workflow@1"],
    docks: ["protocol"],
    config: [
      { key: "baseUrl", label: "n8n address", type: "url", required: true, placeholder: "https://n8n.example.com" },
      { key: "apiKey", label: "API key", type: "secret", required: true, help: "From n8n: Settings, then n8n API. It needs to read workflows and executions." },
      { key: "webhookUrl", label: "Webhook address", type: "url", help: "Only if your n8n serves webhooks from another address (its WEBHOOK_URL)." },
      { key: "pricePerCallUsd", label: "Price per run (USD)", type: "number", default: 0 },
      { key: "pricePerMinuteUsd", label: "Price per minute (USD)", type: "number", default: 0 },
    ],
    permissions: { egress: ["{config.baseUrl}", "{config.webhookUrl}"], secrets: ["apiKey"] },
    outsideVersions: { "n8n-api": "v1" },
    reference: true,
  },
  create(ctx) {
    const base = () => requireString(ctx.config.baseUrl, "n8n address").replace(/\/+$/, "");
    const hooks = () => (typeof ctx.config.webhookUrl === "string" && ctx.config.webhookUrl.trim() ? ctx.config.webhookUrl.trim() : base()).replace(/\/+$/, "");

    const api = async <T>(method: string, path: string, signal?: AbortSignal): Promise<T> => {
      let res: Response;
      try {
        res = await ctx.fetch(`${base()}/api/v1${path}`, {
          method,
          headers: { accept: "application/json", "x-n8n-api-key": requireString(ctx.secrets.apiKey, "API key") },
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        if (signal?.aborted || err instanceof NodeCallError) throw err;
        throw new NodeCallError("unavailable", `Could not reach n8n: ${err instanceof Error ? err.message : String(err)}`, true);
      }
      if (!res.ok) throw httpError(res.status, `n8n answered ${res.status} for ${method} ${path.split("?")[0]}.`);
      return (await res.json().catch(() => ({}))) as T;
    };

    /** Published workflows, every page. */
    const workflows = async (signal?: AbortSignal): Promise<N8nWorkflow[]> => {
      const all: N8nWorkflow[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const query: string = `?limit=250&active=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const body = await api<{ data?: N8nWorkflow[]; nextCursor?: string | null }>("GET", `/workflows${query}`, signal);
        all.push(...(body.data ?? []));
        cursor = body.nextCursor ?? null;
        if (!cursor) break;
      }
      return all.filter(isLive);
    };

    /** The execution a webhook call started: the newest one of the workflow that began after the call. */
    const findExecution = async (workflowId: string, sinceMs: number, signal?: AbortSignal): Promise<N8nExecution | undefined> => {
      const body = await api<{ data?: N8nExecution[] }>("GET", `/executions?workflowId=${encodeURIComponent(workflowId)}&limit=10`, signal);
      return (body.data ?? [])
        .filter((e) => e.startedAt && new Date(e.startedAt).getTime() >= sinceMs && (!e.mode || e.mode === "webhook"))
        .sort((a, b) => new Date(b.startedAt!).getTime() - new Date(a.startedAt!).getTime())
        .at(0);
    };

    return {
      ports: {
        workflow: {
          async listWorkflows(): Promise<WorkflowInfo[]> {
            return (await workflows())
              .filter(webhookOf)
              .map((w) => ({ id: String(w.id), name: w.name ?? String(w.id), description: `Starts at its webhook "${String(webhookOf(w)!.parameters!.path)}".` }));
          },

          async trigger(workflowId, input, call) {
            const workflow = (await workflows(call.signal)).find((w) => String(w.id) === workflowId);
            if (!workflow) throw new NodeCallError("not_found", `n8n has no published workflow "${workflowId}". Publish it in n8n, then test this connection.`, false);
            const hook = webhookOf(workflow);
            if (!hook) throw new NodeCallError("invalid_request", `"${workflow.name ?? workflowId}" has no Webhook node, so it cannot be started from outside n8n.`, false);
            const method = String(hook.parameters?.httpMethod ?? "POST").toUpperCase();
            const answersLater = String(hook.parameters?.responseMode ?? "onReceived") === "onReceived";
            const payload = { ...(input.data ?? {}), ...(input.text ? { text: input.text } : {}) };
            const path = String(hook.parameters!.path).replace(/^\/+/, "");
            const url = new URL(`${hooks()}/webhook/${path}`);
            if (method === "GET") for (const [k, v] of Object.entries(payload)) url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));

            // n8n's clock may differ a little from ours; look a few seconds back.
            const since = Date.now() - 5_000;
            let res: Response;
            try {
              res = await ctx.fetch(url.href, {
                method,
                headers: { accept: "application/json, text/plain", traceparent: call.call.trace.traceparent, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
                ...(method === "GET" ? {} : { body: JSON.stringify(payload) }),
                signal: call.signal,
              });
            } catch (err) {
              if (call.signal.aborted || err instanceof NodeCallError) throw err;
              throw new NodeCallError("unavailable", `Could not reach the n8n webhook: ${err instanceof Error ? err.message : String(err)}`, true);
            }
            const raw = await res.text();
            if (!res.ok) throw httpError(res.status, `The n8n webhook answered ${res.status}${raw ? `: ${raw.slice(0, 300)}` : ""}`);

            const found = await findExecution(workflowId, since, call.signal).catch(() => undefined);
            const execution: WorkflowExecution = { executionId: found ? String(found.id) : `pending-${call.call.callId}`, state: { workflowId, since, found: !!found } };
            if (answersLater) return { execution, status: { state: "running", progress: found ? "Started in n8n" : "Started; looking for its execution" } };
            // The webhook waited for the workflow, so its response is the result.
            let body: unknown = raw;
            try {
              body = raw ? JSON.parse(raw) : {};
            } catch {
              /* plain text */
            }
            const text = typeof body === "string" ? body : body && typeof body === "object" && typeof (body as { text?: unknown }).text === "string" ? (body as { text: string }).text : undefined;
            return { execution, status: { state: "succeeded", output: { ...(text !== undefined ? { text } : {}), ...(typeof body === "string" ? {} : { data: body }) } } };
          },

          async poll(execution, call): Promise<WorkflowStatus> {
            let id = execution.executionId;
            if (execution.state?.found !== true) {
              // The execution had not shown up when the webhook answered; look again.
              const found = await findExecution(String(execution.state?.workflowId ?? ""), Number(execution.state?.since ?? 0), call.signal);
              if (!found) {
                const waited = Date.now() - Number(execution.state?.since ?? Date.now());
                if (waited > 120_000) return { state: "failed", message: "n8n accepted the webhook, but no execution of the workflow appeared. Check that executions are saved in n8n.", code: "not_found" };
                return { state: "running", progress: "Started; looking for its execution" };
              }
              id = String(found.id);
            }
            return statusOf(await api<N8nExecution>("GET", `/executions/${encodeURIComponent(id)}?includeData=true`, call.signal));
          },

          async cancel(execution) {
            let id = execution.executionId;
            if (execution.state?.found !== true) {
              const found = await findExecution(String(execution.state?.workflowId ?? ""), Number(execution.state?.since ?? 0)).catch(() => undefined);
              if (!found) return;
              id = String(found.id);
            }
            try {
              await api("POST", `/executions/${encodeURIComponent(id)}/stop`);
            } catch (err) {
              // One that already ended cannot be stopped, which is what was wanted.
              if (!(err instanceof NodeCallError) || (err.code !== "not_found" && err.code !== "invalid_request")) throw err;
            }
          },
        },
      },

      async health(signal) {
        try {
          const all = await workflows(signal);
          const startable = all.filter(webhookOf).length;
          return { status: "working", detail: `${all.length} published workflow${all.length === 1 ? "" : "s"}, ${startable} can be started (they have a Webhook node).` };
        } catch (err) {
          return statusForError(err);
        }
      },
      async discover(signal) {
        return { workflows: (await workflows(signal)).filter(webhookOf).map((w) => ({ id: String(w.id), name: w.name ?? String(w.id) })) };
      },
    };
  },
});
