import { NodeCallError } from "@conclave/contract";
import { runConformance, testCallContext } from "@conclave/module-sdk/conformance";
import { describe, expect, it } from "vitest";
import n8n, { outputOf, statusOf } from "./index";

/** A small n8n: two published workflows with webhooks, one without, and one unpublished. */
function fakeN8n(opts: { fail?: boolean; hideExecutionFor?: number } = {}) {
  const requests: { method: string; path: string; headers: Headers; body: unknown }[] = [];
  const executions: { id: number; workflowId: string; startedAt: string; polls: number; stopped: boolean; input: unknown }[] = [];
  const hook = (path: string, responseMode?: string) => ({ type: "n8n-nodes-base.webhook", name: "Webhook", parameters: { path, httpMethod: "POST", ...(responseMode ? { responseMode } : {}) } });
  const workflows = [
    { id: "w1", name: "Lead intake", active: true, activeVersionId: "v1", isArchived: false, nodes: [hook("lead-intake"), { type: "n8n-nodes-base.set", name: "Set" }] },
    { id: "w2", name: "Quick lookup", active: true, activeVersionId: "v2", isArchived: false, nodes: [hook("lookup", "lastNode")] },
    { id: "w3", name: "Nightly sync", active: true, activeVersionId: "v3", isArchived: false, nodes: [{ type: "n8n-nodes-base.scheduleTrigger", name: "Cron" }] },
    { id: "w4", name: "Draft", active: false, activeVersionId: null, isArchived: false, nodes: [hook("draft")] },
  ];
  let lookups = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path: url.pathname + url.search, headers, body });
    if (url.pathname.startsWith("/api/v1/") && headers.get("x-n8n-api-key") !== "key-1") return new Response("unauthorized", { status: 401 });

    if (url.pathname === "/api/v1/workflows") {
      // Two pages, to check paging.
      const page = url.searchParams.get("cursor") ? workflows.slice(2) : workflows.slice(0, 2);
      return Response.json({ data: page, nextCursor: url.searchParams.get("cursor") ? null : "next" });
    }
    if (url.pathname === "/webhook/lead-intake") {
      executions.push({ id: executions.length + 1, workflowId: "w1", startedAt: new Date().toISOString(), polls: 0, stopped: false, input: body });
      return Response.json({ message: "Workflow was started" });
    }
    if (url.pathname === "/webhook/lookup") {
      executions.push({ id: executions.length + 1, workflowId: "w2", startedAt: new Date().toISOString(), polls: 99, stopped: false, input: body });
      return Response.json({ text: `Found ${String((body as { q?: string }).q)}`, hits: 2 });
    }
    if (url.pathname === "/api/v1/executions") {
      lookups += 1;
      if (opts.hideExecutionFor && lookups <= opts.hideExecutionFor) return Response.json({ data: [], nextCursor: null });
      const mine = executions.filter((e) => e.workflowId === url.searchParams.get("workflowId"));
      return Response.json({ data: mine.map((e) => ({ id: e.id, workflowId: e.workflowId, startedAt: e.startedAt, mode: "webhook", status: "running" })).reverse(), nextCursor: null });
    }
    const one = /^\/api\/v1\/executions\/(\d+)(\/stop)?$/.exec(url.pathname);
    if (one) {
      const e = executions.find((x) => x.id === Number(one[1]));
      if (!e) return new Response("not found", { status: 404 });
      if (one[2]) {
        e.stopped = true;
        return Response.json({ status: "canceled" });
      }
      e.polls += 1;
      if (e.stopped) return Response.json({ id: e.id, status: "canceled" });
      if (e.polls < 2) return Response.json({ id: e.id, status: "running" });
      if (opts.fail) return Response.json({ id: e.id, status: "error", data: { resultData: { lastNodeExecuted: "HTTP Request", error: { message: "connect ECONNREFUSED" } } } });
      return Response.json({
        id: e.id,
        status: "success",
        data: { resultData: { lastNodeExecuted: "Set", runData: { Set: [{ data: { main: [[{ json: { text: "Lead saved", leadId: 7 } }]] } }] } } },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, requests, executions };
}

const config = { baseUrl: "https://n8n.test" };
const make = (fetchImpl: typeof fetch, apiKey = "key-1") => n8n.create({ config, secrets: { apiKey }, fetch: fetchImpl, log: { info() {}, warn() {} } });

describe("n8n module", () => {
  it("passes the conformance kit against a recorded n8n", async () => {
    const { fetchImpl } = fakeN8n();
    const report = await runConformance(n8n, { config, secrets: { apiKey: "key-1" }, fetch: fetchImpl, workflow: "w1", workflowInputs: { name: "Ada" } });
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
  });

  it("lists only published workflows that start from a webhook, across pages", async () => {
    const { fetchImpl, requests } = fakeN8n();
    const instance = make(fetchImpl);
    expect(await instance.ports.workflow!.listWorkflows()).toEqual([
      { id: "w1", name: "Lead intake", description: 'Starts at its webhook "lead-intake".' },
      { id: "w2", name: "Quick lookup", description: 'Starts at its webhook "lookup".' },
    ]);
    expect(requests.filter((r) => r.path.startsWith("/api/v1/workflows")).map((r) => r.path)).toEqual(["/api/v1/workflows?limit=250&active=true", "/api/v1/workflows?limit=250&active=true&cursor=next"]);
    expect(await instance.health()).toEqual({ status: "working", detail: "3 published workflows, 2 can be started (they have a Webhook node)." });
  });

  it("starts through the webhook, finds the execution, follows it and returns the last node's output", async () => {
    const { fetchImpl, requests, executions } = fakeN8n();
    const flow = make(fetchImpl).ports.workflow!;
    const ctx = testCallContext();
    const started = await flow.trigger("w1", { data: { name: "Ada" }, text: "New lead" }, ctx);
    expect(started.status).toEqual({ state: "running", progress: "Started in n8n" });
    expect(started.execution).toMatchObject({ executionId: "1", state: { workflowId: "w1", found: true } });
    const hook = requests.find((r) => r.path === "/webhook/lead-intake")!;
    expect(hook.body).toEqual({ name: "Ada", text: "New lead" });
    expect(hook.headers.get("traceparent")).toBe(ctx.call.trace.traceparent);
    // The API key goes to the API only, never to the webhook.
    expect(hook.headers.get("x-n8n-api-key")).toBeNull();

    expect(await flow.poll!(started.execution, testCallContext())).toEqual({ state: "running", progress: "Running in n8n" });
    expect(await flow.poll!(started.execution, testCallContext())).toEqual({ state: "succeeded", output: { text: "Lead saved", data: { text: "Lead saved", leadId: 7 } } });
    expect(executions).toHaveLength(1);
  });

  it("takes the webhook's response as the result when the workflow answers when it is done", async () => {
    const { fetchImpl } = fakeN8n();
    const done = await make(fetchImpl).ports.workflow!.trigger("w2", { data: { q: "tides" } }, testCallContext());
    expect(done.status).toEqual({ state: "succeeded", output: { text: "Found tides", data: { text: "Found tides", hits: 2 } } });
  });

  it("keeps looking when the execution shows up late", async () => {
    const { fetchImpl } = fakeN8n({ hideExecutionFor: 2 });
    const flow = make(fetchImpl).ports.workflow!;
    const started = await flow.trigger("w1", { data: {} }, testCallContext());
    expect(started.execution.state).toMatchObject({ found: false });
    expect(await flow.poll!(started.execution, testCallContext())).toEqual({ state: "running", progress: "Started; looking for its execution" });
    expect((await flow.poll!(started.execution, testCallContext())).state).toBe("running");
    expect((await flow.poll!(started.execution, testCallContext())).state).toBe("succeeded");
  });

  it("reports a failed execution with the node it failed at, and stops one that is cancelled", async () => {
    const failing = fakeN8n({ fail: true });
    const flow = make(failing.fetchImpl).ports.workflow!;
    const started = await flow.trigger("w1", { data: {} }, testCallContext());
    await flow.poll!(started.execution, testCallContext());
    expect(await flow.poll!(started.execution, testCallContext())).toMatchObject({ state: "failed", message: 'connect ECONNREFUSED (at the node "HTTP Request")' });

    const live = fakeN8n();
    const flow2 = make(live.fetchImpl).ports.workflow!;
    const run = await flow2.trigger("w1", { data: {} }, testCallContext());
    await flow2.cancel!(run.execution);
    expect(live.executions[0]!.stopped).toBe(true);
    expect(await flow2.poll!(run.execution, testCallContext())).toEqual({ state: "cancelled" });
  });

  it("uses contract errors for a wrong key and an unknown or unstartable workflow", async () => {
    const { fetchImpl } = fakeN8n();
    expect((await make(fetchImpl, "wrong").health()).status).toBe("signed_out");
    const flow = make(fetchImpl).ports.workflow!;
    await expect(flow.trigger("nope", {}, testCallContext())).rejects.toMatchObject({ code: "not_found" });
    await expect(flow.trigger("w3", {}, testCallContext())).rejects.toBeInstanceOf(NodeCallError);
  });

  it("reads outputs and statuses", () => {
    expect(outputOf({ id: 1 })).toEqual({ data: {} });
    const many = { id: 1, data: { resultData: { lastNodeExecuted: "A", runData: { A: [{ data: { main: [[{ json: { n: 1 } }, { json: { n: 2 } }]] } }] } } } };
    expect(outputOf(many)).toEqual({ data: [{ n: 1 }, { n: 2 }] });
    expect(statusOf({ id: 1, status: "waiting" })).toEqual({ state: "running", progress: "Waiting inside n8n" });
    expect(statusOf({ id: 1, status: "crashed" })).toMatchObject({ state: "failed" });
  });
});
