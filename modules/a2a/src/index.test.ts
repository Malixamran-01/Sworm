import type { AgentEvent } from "@conclave/contract";
import { runConformance, testCallContext } from "@conclave/module-sdk/conformance";
import { describe, expect, it } from "vitest";
import a2a, { taskState } from "./index";

/** A small A2A agent. `wire` picks the protocol version it speaks. */
function fakeAgent(wire: "1.0" | "0.3", opts: { asks?: boolean; direct?: boolean } = {}) {
  const requests: { url: string; method: string; params: Record<string, unknown>; headers: Headers }[] = [];
  const tasks = new Map<string, { polls: number; answered: boolean; cancelled: boolean; text: string }>();
  const v1 = wire === "1.0";
  const state = (s: string) => (v1 ? `TASK_STATE_${s.toUpperCase().replace(/-/g, "_")}` : s);
  const text = (t: string) => (v1 ? { text: t } : { kind: "text", text: t });
  const card = v1
    ? {
        name: "Fake agent",
        version: "2.1.0",
        supportedInterfaces: [{ url: "https://agent.test/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
        skills: [{ id: "summarise", name: "Summarise", description: "Short summaries.", tags: [] }],
      }
    : { name: "Fake agent", version: "2.1.0", url: "https://agent.test/rpc", preferredTransport: "JSONRPC", protocolVersion: "0.3.0", skills: [{ id: "summarise", name: "Summarise" }] };

  const view = (id: string) => {
    const t = tasks.get(id)!;
    if (t.cancelled) return { id, contextId: "ctx-1", status: { state: state("canceled") } };
    if (opts.asks && !t.answered) return { id, contextId: "ctx-1", status: { state: state("input-required"), message: { parts: [text("Which language?")] } } };
    if (t.polls < 2) return { id, contextId: "ctx-1", status: { state: state("working"), message: { parts: [text(`Step ${t.polls}`)] } } };
    return {
      id,
      contextId: "ctx-1",
      status: { state: state("completed") },
      artifacts: [{ artifactId: "a1", parts: [text(`Summary of: ${t.text}`), v1 ? { data: { words: 3 } } : { kind: "data", data: { words: 3 } }] }],
      metadata: { usage: { inputTokens: 12, outputTokens: 5, costUsd: 0.002 } },
    };
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    if (url.pathname === "/.well-known/agent-card.json") return Response.json(card);
    if (url.pathname !== "/rpc") return new Response("not found", { status: 404 });
    const body = JSON.parse(String(init?.body)) as { id: string; method: string; params: Record<string, unknown> };
    requests.push({ url: url.href, method: body.method, params: body.params, headers });
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    const names = v1 ? { send: "SendMessage", get: "GetTask", cancel: "CancelTask" } : { send: "message/send", get: "tasks/get", cancel: "tasks/cancel" };
    if (body.method === names.send) {
      const message = body.params.message as { taskId?: string; parts: { text?: string }[] };
      if (message.taskId) {
        tasks.get(message.taskId)!.answered = true;
        return ok(v1 ? { task: view(message.taskId) } : { kind: "task", ...view(message.taskId) });
      }
      if (opts.direct) return ok(v1 ? { message: { role: "ROLE_AGENT", parts: [text("Straight answer.")] } } : { kind: "message", role: "agent", parts: [text("Straight answer.")] });
      const id = `task-${tasks.size + 1}`;
      tasks.set(id, { polls: 0, answered: false, cancelled: false, text: message.parts[0]?.text ?? "" });
      return ok(v1 ? { task: view(id) } : { kind: "task", ...view(id) });
    }
    const id = String(body.params.id);
    if (!tasks.has(id)) return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32001, message: "Task not found" } });
    if (body.method === names.get) {
      const result = view(id);
      tasks.get(id)!.polls += 1;
      return ok(result);
    }
    if (body.method === names.cancel) {
      tasks.get(id)!.cancelled = true;
      return ok(view(id));
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
  }) as typeof fetch;
  return { fetchImpl, requests, tasks };
}

const config = { url: "https://agent.test", pollSeconds: 0 };
const instance = (fetchImpl: typeof fetch, secrets: Record<string, string> = {}) => a2a.create({ config, secrets, fetch: fetchImpl, log: { info() {}, warn() {} } });

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = [];
  for await (const e of events) seen.push(e);
  return seen;
}

describe("A2A protocol dock", () => {
  it.each(["1.0", "0.3"] as const)("passes the conformance kit against an A2A %s agent", async (wire) => {
    const { fetchImpl } = fakeAgent(wire);
    const report = await runConformance(a2a, { config, fetch: fetchImpl });
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
  });

  it("passes conformance when the agent asks a question", async () => {
    const { fetchImpl } = fakeAgent("1.0", { asks: true });
    const report = await runConformance(a2a, { config, fetch: fetchImpl, agentAnswer: "English" });
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
  });

  it("speaks 1.0: version header, method names, wrapped results and reported usage", async () => {
    const { fetchImpl, requests } = fakeAgent("1.0");
    const agent = instance(fetchImpl, { token: "secret-token" }).ports.agent!;
    const ctx = testCallContext();
    const handle = await agent.startRun({ skill: "summarise", text: "the sea", data: { tone: "dry" } }, ctx);
    expect(handle).toEqual({ externalRunId: "task-1", state: { contextId: "ctx-1" } });

    const sent = requests.find((r) => r.method === "SendMessage")!;
    expect(sent.headers.get("a2a-version")).toBe("1.0");
    expect(sent.headers.get("authorization")).toBe("Bearer secret-token");
    const message = sent.params.message as { role: string; parts: unknown[]; metadata: Record<string, unknown> };
    expect(message.role).toBe("ROLE_USER");
    expect(message.parts).toEqual([{ text: "the sea" }, { data: { tone: "dry" }, mediaType: "application/json" }]);
    expect(message.metadata).toEqual({ skill: "summarise", traceparent: ctx.call.trace.traceparent });
    expect(sent.params.configuration).toEqual({ returnImmediately: true });

    const events = await collect(agent.streamEvents(handle, testCallContext()));
    expect(events.map((e) => e.type)).toEqual(["progress", "progress", "completed"]);
    expect(events.at(-1)).toEqual({ type: "completed", text: "Summary of: the sea", data: { words: 3 }, usage: { inputTokens: 12, outputTokens: 5, costUsd: 0.002 } });
  });

  it("speaks 0.3 to an agent whose card has one url", async () => {
    const { fetchImpl, requests } = fakeAgent("0.3");
    const agent = instance(fetchImpl).ports.agent!;
    const handle = await agent.startRun({ text: "the sea" }, testCallContext());
    const sent = requests.find((r) => r.method === "message/send")!;
    expect(sent.headers.get("a2a-version")).toBeNull();
    expect((sent.params.message as { role: string; parts: unknown[] }).parts).toEqual([{ kind: "text", text: "the sea" }]);
    expect(sent.params.configuration).toEqual({ blocking: false });
    const events = await collect(agent.streamEvents(handle, testCallContext()));
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("asks once, sends the answer to the same task, and carries on", async () => {
    const { fetchImpl, requests } = fakeAgent("1.0", { asks: true });
    const agent = instance(fetchImpl).ports.agent!;
    const handle = await agent.startRun({ text: "the sea" }, testCallContext());
    const seen: string[] = [];
    for await (const event of agent.streamEvents(handle, testCallContext())) {
      seen.push(event.type);
      if (event.type === "needs_input") {
        expect(event.prompt).toBe("Which language?");
        await agent.provideInput(handle, "English", testCallContext());
      }
    }
    expect(seen.filter((t) => t === "needs_input")).toHaveLength(1);
    expect(seen.at(-1)).toBe("completed");
    const answer = requests.filter((r) => r.method === "SendMessage").at(-1)!.params.message as { taskId: string; contextId: string };
    expect(answer).toMatchObject({ taskId: "task-1", contextId: "ctx-1" });
  });

  it("finishes at once when the agent answers with a message and no task", async () => {
    const { fetchImpl } = fakeAgent("1.0", { direct: true });
    const agent = instance(fetchImpl).ports.agent!;
    const handle = await agent.startRun({ text: "hello" }, testCallContext());
    expect(await collect(agent.streamEvents(handle, testCallContext()))).toEqual([{ type: "completed", text: "Straight answer." }]);
    await expect(agent.cancel(handle)).resolves.toBeUndefined();
  });

  it("cancels the outside task and reports it as cancelled", async () => {
    const { fetchImpl, tasks } = fakeAgent("1.0");
    const agent = instance(fetchImpl).ports.agent!;
    const handle = await agent.startRun({ text: "the sea" }, testCallContext());
    await agent.cancel(handle);
    expect(tasks.get("task-1")!.cancelled).toBe(true);
    expect(await collect(agent.streamEvents(handle, testCallContext()))).toMatchObject([{ type: "failed", code: "cancelled" }]);
  });

  it("reports health and skills from the Agent Card", async () => {
    const { fetchImpl } = fakeAgent("1.0");
    const inst = instance(fetchImpl);
    expect(await inst.health()).toEqual({ status: "working", detail: "Fake agent answers, A2A 1.0, 1 skill." });
    expect(await inst.outsideVersion!()).toBe("2.1.0");
    expect(await inst.ports.agent!.listSkills()).toEqual([{ id: "summarise", name: "Summarise", description: "Short summaries." }]);
    const down = instance((async () => new Response("no", { status: 503 })) as typeof fetch);
    expect((await down.health()).status).toBe("unreachable");
  });

  it("reads both spellings of a task state", () => {
    expect(taskState("TASK_STATE_INPUT_REQUIRED")).toBe("input-required");
    expect(taskState("input-required")).toBe("input-required");
    expect(taskState("TASK_STATE_COMPLETED")).toBe("completed");
  });
});
