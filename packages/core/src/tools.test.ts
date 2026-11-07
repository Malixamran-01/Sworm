import { NodeCallError } from "@conclave/contract";
import { defineModule } from "@conclave/module-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { harness, type Harness } from "./test-helpers";

/** A Tool-port module for tests: one search tool whose parameter is "q", not "query". */
const calls: Record<string, unknown>[] = [];
const testTools = defineModule({
  manifest: {
    id: "test/tools",
    version: "0.1.0",
    name: "Test tools",
    ports: ["tool@1"],
    docks: ["built-in"],
    config: [{ key: "pricePerCallUsd", label: "Price", type: "number", default: 0.002 }],
  },
  create: () => ({
    ports: {
      tool: {
        async listTools() {
          return [{ name: "search", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, sensitive: false }];
        },
        async call(name, args, ctx) {
          if (ctx.signal.aborted) throw new NodeCallError("cancelled", "Cancelled.", false);
          if (name !== "search") throw new NodeCallError("invalid_request", `No tool ${name}.`, false);
          calls.push(args);
          return { data: { text: `Result A and Result B for "${String(args.q)}"` } };
        },
      },
    },
    health: async () => ({ status: "working", detail: "ok" }),
  }),
});

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  calls.length = 0;
});

describe("Tool steps (WF-001, MOD-004)", () => {
  it("calls the tool filling the role, maps the argument, and feeds its output to the next step", async () => {
    h = await harness({ modules: [testTools] });
    const conn = await h.conclave.connections.create(h.actor, { moduleId: "test/tools", name: "Search", values: {} });
    await h.conclave.workspaces.assignRole(h.actor, h.workspaceId, "searcher", { connectionId: conn.id, model: "search" });

    const { id } = await h.conclave.orchestrator.start(h.actor, { workspaceId: h.workspaceId, taskTypeId: h.taskTypeId, brief: { topic: "Heat pumps" } });
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, id);
    const search = run.steps.find((s) => s.key === "search")!;
    expect(search).toMatchObject({ status: "succeeded", costSource: "estimated", nodeLabel: "Searcher · Search · search" });
    expect(search.costUsd).toBeCloseTo(0.002, 9);
    // The template sends "query"; the tool only takes "q", so the value is mapped onto it.
    expect(calls).toEqual([{ q: "Heat pumps" }]);

    const [research] = await h.conclave.db.query<{ input: { prompt: string } }>(`select input from run_steps where step_key = 'research'`);
    expect(research!.input.prompt).toContain('Result A and Result B for "Heat pumps"');

    const ledger = await h.conclave.db.query<{ model: string; cost_source: string }>(`select model, cost_source from usage_ledger order by at`);
    expect(ledger.map((l) => [l.model, l.cost_source])).toEqual([
      ["search", "estimated"],
      ["mock-small", "metered"],
      ["mock-small", "metered"],
    ]);
  });

  it("fails a required tool step whose role has no node, before anything runs", async () => {
    h = await harness({ modules: [testTools] });
    const conn = await h.conclave.connections.create(h.actor, { moduleId: "test/tools", name: "Search", values: {} });
    // A model connection on a tool role is a setup mistake the run reports clearly.
    await h.conclave.workspaces.assignRole(h.actor, h.workspaceId, "searcher", { connectionId: h.connectionId, model: "mock-small" });
    const { id } = await h.conclave.orchestrator.start(h.actor, { workspaceId: h.workspaceId, taskTypeId: h.taskTypeId, brief: { topic: "x" } });
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/does not provide tools/);
    void conn;
  });
});
