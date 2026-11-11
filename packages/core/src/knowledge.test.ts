import { NodeCallError, type KnowledgeSearchRequest, type WorkflowDefinition } from "@conclave/contract";
import { cmpInstance, defineModule, httpClient, serveHttp } from "@conclave/module-sdk";
import { testCallContext } from "@conclave/module-sdk/conformance";
import { afterEach, describe, expect, it } from "vitest";
import { formatPassages } from "./orchestrator";
import { harness, type Harness } from "./test-helpers";

/** A Knowledge-port module for tests: two sources, and it remembers what it was asked. */
const asked: KnowledgeSearchRequest[] = [];
const handbook = (opts: { costUsd?: number } = {}) =>
  defineModule({
    manifest: { id: "test/handbook", version: "0.1.0", name: "Handbook", ports: ["knowledge@1"], docks: ["built-in"], config: [{ key: "pricePerCallUsd", label: "Price", type: "number", default: 0.001 }] },
    create: () => ({
      ports: {
        knowledge: {
          listSources: async () => [{ id: "policies", name: "Policies" }, { id: "faq", name: "FAQ" }],
          async search(req, ctx) {
            if (ctx.signal.aborted) throw new NodeCallError("cancelled", "Cancelled.", false);
            if (!req.query) throw new NodeCallError("invalid_request", "No query.", false);
            asked.push(req);
            if (req.query.includes("nothing")) return { passages: [] };
            return {
              passages: [
                { text: "Refunds are paid within 14 days.", source: { id: "refunds.md", title: "Refund policy", uri: "policies/refunds.md" }, score: 0.9 },
                { text: "Duplicate charges are refunded in full.", source: { id: "billing.md", title: "Billing FAQ" }, score: 0.7 },
                { text: "A third passage.", source: { id: "other.md" }, score: 0.2 },
              ].slice(0, req.limit),
              ...(opts.costUsd !== undefined ? { usage: { costUsd: opts.costUsd, inputTokens: 12 } } : {}),
            };
          },
        },
      },
      health: async () => ({ status: "working", detail: "ok" }),
      discover: async () => ({ sources: [{ id: "policies", name: "Policies" }, { id: "faq" }] }),
    }),
  });

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  asked.length = 0;
});

/** A workspace whose workflow looks something up, then answers with what it found. */
async function setup(mod = handbook(), node: string | null = "policies", limit = 2) {
  h = await harness({ modules: [mod] });
  const conn = await h.conclave.connections.create(h.actor, { moduleId: "test/handbook", name: "Handbook", values: {} });
  const ws = await h.conclave.workspaces.create(h.actor, { blank: true, name: "Help desk", defaultNode: { connectionId: h.connectionId, model: "mock-small" } });
  await h.conclave.workspaces.createRole(h.actor, ws.id, { key: "library", name: "Library", port: "knowledge@1" });
  if (node) await h.conclave.workspaces.assignRole(h.actor, ws.id, "library", { connectionId: conn.id, model: node });
  const workflow = {
    version: 1,
    steps: [
      { kind: "lookup", key: "find", role: "library", query: "{{input.request}}", limit, optional: node === null },
      { kind: "role", key: "answer", role: "assistant", prompt: "Answer from these passages and cite them by number:\n{{steps.find.output}}\n\nQuestion: {{input.request}}", needs: ["find"] },
    ],
  } as unknown as WorkflowDefinition;
  const saved = await h.conclave.workspaces.saveTaskType(h.actor, ws.id, "custom", {
    key: "custom",
    name: "Custom",
    inputFields: [{ key: "request", label: "Request", type: "text", required: true }],
    workflow,
  });
  const taskTypeId = saved.taskTypes.find((t) => t.key === "custom")!.id;
  const run = async (request: string) => {
    const { id } = await h!.conclave.orchestrator.start(h!.actor, { workspaceId: ws.id, taskTypeId, brief: { request } });
    await h!.settle();
    return h!.conclave.orchestrator.get(h!.actor, id);
  };
  return { conn, ws, run };
}

describe("Look up steps (Knowledge port)", () => {
  it("searches the source filling the role and hands numbered passages, with where they came from, to the next step", async () => {
    const { conn, run } = await setup();
    const done = await run("Was I charged twice?");
    expect(done.status).toBe("succeeded");
    expect(asked).toEqual([{ query: "Was I charged twice?", limit: 2, sources: ["policies"] }]);

    const find = done.steps.find((s) => s.key === "find")!;
    expect(find).toMatchObject({ status: "succeeded", nodeLabel: "Library · Handbook · policies", costSource: "estimated" });
    expect(find.costUsd).toBeCloseTo(0.001, 9);
    expect(find.output).toBe("[1] Refund policy (policies/refunds.md)\nRefunds are paid within 14 days.\n\n[2] Billing FAQ\nDuplicate charges are refunded in full.");
    const [answer] = await h!.conclave.db.query<{ input: { prompt: string } }>(`select input from run_steps where step_key = 'answer'`);
    expect(answer!.input.prompt).toContain("[2] Billing FAQ\nDuplicate charges are refunded in full.");

    // It is a call like any other: in the ledger, the trace and the connection's sources.
    const ledger = await h!.conclave.db.query<{ model: string; cost_source: string }>(`select model, cost_source from usage_ledger order by at`);
    expect(ledger.map((l) => [l.model, l.cost_source])).toEqual([
      ["policies", "estimated"],
      ["mock-small", "metered"],
    ]);
    const trace = await h!.conclave.insights.trace(h!.actor, done.id);
    const span = trace.spans.find((s) => s.kind === "lookup")!;
    expect(span).toMatchObject({ system: "knowledge", policy: { allowed: true } });
    expect(span.traceparent).toContain(trace.traceId);
    expect(trace.systems.map((s) => s.system).sort()).toEqual(["knowledge", "model"]);
    expect(await h!.conclave.connections.sources(h!.actor, conn.id)).toEqual([{ id: "policies", name: "Policies" }, { id: "faq", name: "FAQ" }]);
    expect((await h!.conclave.connections.test(h!.actor, conn.id)).capabilities.sources).toEqual([{ id: "policies", name: "Policies" }, { id: "faq" }]);
  });

  it("searches every source when the role is filled with all of them, and believes a reported cost", async () => {
    const { run } = await setup(handbook({ costUsd: 0.0005 }), "*", 5);
    const done = await run("refunds");
    expect(asked).toEqual([{ query: "refunds", limit: 5 }]);
    const find = done.steps.find((s) => s.key === "find")!;
    expect(find).toMatchObject({ nodeLabel: "Library · Handbook · all sources", costSource: "reported", inputTokens: 12 });
    expect(find.costUsd).toBeCloseTo(0.0005, 9);
  });

  it("passes on nothing when nothing is found, and is skipped when optional and unfilled", async () => {
    const found = await setup();
    const empty = await found.run("nothing here");
    expect(empty.status).toBe("succeeded");
    expect(empty.steps.find((s) => s.key === "find")).toMatchObject({ status: "succeeded", output: "" });
    await h!.close();

    const unfilled = await setup(handbook(), null);
    const skipped = await unfilled.run("anything");
    expect(skipped.status).toBe("succeeded");
    expect(skipped.steps.find((s) => s.key === "find")!.status).toBe("skipped");
    expect(asked.filter((a) => a.query === "anything")).toEqual([]);
  });

  it("obeys the rules: a workspace that never uses the connection is refused before any call", async () => {
    const { conn, ws, run } = await setup();
    await h!.conclave.policies.set(h!.actor, { workspaceId: ws.id, connectionId: conn.id, effect: "deny" });
    const refused = await run("refunds");
    expect(refused.status).toBe("failed");
    expect(refused.error).toMatch(/never lets tasks use Handbook/);
    expect(asked).toEqual([]);
  });

  it("refuses a workflow whose Look up step points at a role on another port", async () => {
    const { ws } = await setup();
    const wrong = { version: 1, steps: [{ kind: "lookup", key: "find", role: "assistant", query: "{{input.request}}" }] } as unknown as WorkflowDefinition;
    await expect(
      h!.conclave.workspaces.saveTaskType(h!.actor, ws.id, "custom", { key: "custom", name: "Custom", inputFields: [{ key: "request", label: "Request", type: "text", required: true }], workflow: wrong }),
    ).rejects.toThrow(/a knowledge source step, but Assistant is filled by a model/);
  });

  it("formats passages for citing", () => {
    expect(formatPassages([])).toBe("");
    expect(formatPassages([{ text: " One. ", source: { id: "a.md" } }])).toBe("[1] a.md\nOne.");
  });
});

describe("knowledge over the module protocol", () => {
  it("serves the port to a remote host unchanged", async () => {
    const served = await serveHttp(handbook(), { secret: "knowledge-test-secret-0123456789-abcdef" });
    try {
      const remote = cmpInstance(httpClient(served.url, "knowledge-test-secret-0123456789-abcdef"));
      expect(await remote.ports.knowledge!.listSources()).toEqual([{ id: "policies", name: "Policies" }, { id: "faq", name: "FAQ" }]);
      const found = await remote.ports.knowledge!.search({ query: "refunds", limit: 1 }, testCallContext());
      expect(found.passages).toEqual([{ text: "Refunds are paid within 14 days.", source: { id: "refunds.md", title: "Refund policy", uri: "policies/refunds.md" }, score: 0.9 }]);
      await expect(remote.ports.knowledge!.search({ query: "", limit: 1 }, testCallContext())).rejects.toMatchObject({ code: "invalid_request" });
      // A module without the port says so, instead of failing oddly.
      expect((await remote.dockedModule!()).ports).toEqual(["knowledge@1"]);
      await expect(remote.ports.tool?.listTools() ?? Promise.reject(new Error("no tool port"))).rejects.toThrow();
    } finally {
      await served.close();
    }
  });
});
