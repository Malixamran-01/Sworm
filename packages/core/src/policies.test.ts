import { NodeCallError, type WorkflowDefinition } from "@conclave/contract";
import { defineModule } from "@conclave/module-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { decide, type PolicyQuestion, type PolicyRule } from "./policies";
import { harness, type Harness } from "./test-helpers";

const C = "00000000-0000-7000-8000-00000000000c";
const ask = (over: Partial<PolicyQuestion> = {}): PolicyQuestion => ({ connectionId: C, connectionName: "Poster", tool: null, sensitive: false, approvedBefore: false, ...over });
const rule = (effect: PolicyRule["effect"], tool: string | null = null, source = "The workspace Ops"): PolicyRule => ({ effect, connectionId: C, tool, source });

describe("decide", () => {
  it("allows when no rule applies", () => {
    expect(decide([[], []], ask())).toMatchObject({ allowed: true, effect: "allow", source: null });
  });

  it("lets the strictest source win, whatever the order", () => {
    const org = [rule("deny", null, "Your organisation")];
    const ws = [rule("allow")];
    expect(decide([org, ws], ask())).toMatchObject({ allowed: false, effect: "deny", source: "Your organisation" });
    expect(decide([ws, org], ask())).toMatchObject({ allowed: false, effect: "deny" });
    expect(decide([[rule("ask")], [rule("deny", null, "The workspace Above")]], ask()).reason).toBe("The workspace Above never lets tasks use Poster.");
  });

  it("prefers a rule for the tool over one for its connection, within one source", () => {
    const rules = [rule("deny"), rule("allow", "search")];
    expect(decide([rules], ask({ tool: "search" }))).toMatchObject({ allowed: true });
    expect(decide([rules], ask({ tool: "post" }))).toMatchObject({ allowed: false, effect: "deny" });
  });

  it("asks before a sensitive tool unless a rule names that tool", () => {
    const sensitive = ask({ tool: "post", sensitive: true });
    expect(decide([[]], sensitive)).toMatchObject({ allowed: false, effect: "ask", source: null });
    // Allowing the connection does not review the tools that write through it.
    expect(decide([[rule("allow")]], sensitive)).toMatchObject({ allowed: false, effect: "ask" });
    expect(decide([[rule("allow", "post")]], sensitive)).toMatchObject({ allowed: true, effect: "allow" });
    // A person's approval earlier in the task is what "ask" waits for.
    expect(decide([[]], { ...sensitive, approvedBefore: true })).toMatchObject({ allowed: true, effect: "ask" });
    // And an approval never lifts "never".
    expect(decide([[rule("deny", "post")]], { ...sensitive, approvedBefore: true })).toMatchObject({ allowed: false, effect: "deny" });
  });
});

/** One read-only tool and one that changes things outside. */
const posted: Record<string, unknown>[] = [];
const outbox = defineModule({
  manifest: { id: "test/outbox", version: "0.1.0", name: "Outbox", ports: ["tool@1"], docks: ["built-in"] },
  create: () => ({
    ports: {
      tool: {
        listTools: async () => [
          { name: "search", inputSchema: { type: "object", properties: { query: { type: "string" } } }, sensitive: false },
          { name: "post", inputSchema: { type: "object", properties: { query: { type: "string" } } }, sensitive: true },
        ],
        async call(name, args) {
          if (name !== "search" && name !== "post") throw new NodeCallError("invalid_request", `No tool ${name}.`, false);
          posted.push({ name, ...args });
          return { data: { text: `${name} done` } };
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
  posted.length = 0;
});

const start = async (workspaceId: string, taskTypeId: string, brief: Record<string, string>) => {
  const { id } = await h!.conclave.orchestrator.start(h!.actor, { workspaceId, taskTypeId, brief });
  await h!.settle();
  return h!.conclave.orchestrator.get(h!.actor, id);
};

describe("policies on a running task (SRS 4.12)", () => {
  it("refuses a connection a workspace never uses, before any money is held, and says so in the trace", async () => {
    h = await harness();
    await h.conclave.policies.set(h.actor, { workspaceId: h.workspaceId, connectionId: h.connectionId, effect: "deny" });
    const run = await start(h.workspaceId, h.taskTypeId, { topic: "Tide pools" });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/never lets tasks use Mock/);
    const [step] = await h.conclave.db.query<{ error_code: string }>(`select error_code from run_steps where status = 'failed'`);
    expect(step!.error_code).toBe("forbidden");
    expect(await h.conclave.db.query(`select 1 from budget_reservations`)).toHaveLength(0);
    expect(await h.conclave.db.query(`select 1 from usage_ledger`)).toHaveLength(0);

    const trace = await h.conclave.insights.trace(h.actor, run.id);
    const refused = trace.spans.find((s) => s.status === "failed" && s.type === "step")!;
    expect(refused.policy).toMatchObject({ allowed: false, effect: "deny" });
    expect(refused.errorCode).toBe("forbidden");

    // Clearing the rule lets the next task through, and records why it was allowed.
    await h.conclave.policies.set(h.actor, { workspaceId: h.workspaceId, connectionId: h.connectionId, effect: "default" });
    const next = await start(h.workspaceId, h.taskTypeId, { topic: "Tide pools" });
    expect(next.status).toBe("waiting");
    const ok = (await h.conclave.insights.trace(h.actor, next.id)).spans.find((s) => s.system === "model")!;
    expect(ok.policy).toMatchObject({ allowed: true, effect: "allow" });
  });

  it("an organisation rule holds in every workspace, and a workspace cannot loosen it", async () => {
    h = await harness();
    await h.conclave.policies.set(h.actor, { workspaceId: null, connectionId: h.connectionId, effect: "deny" });
    await h.conclave.policies.set(h.actor, { workspaceId: h.workspaceId, connectionId: h.connectionId, effect: "allow" });
    const run = await start(h.workspaceId, h.taskTypeId, { topic: "Tide pools" });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/Your organisation never lets tasks use Mock/);
    const view = await h.conclave.policies.forWorkspace(h.actor, h.workspaceId);
    expect(view.rules.map((r) => [r.scope, r.effect]).sort()).toEqual([
      ["org", "deny"],
      ["workspace", "allow"],
    ]);
    expect(view.connections.find((c) => c.id === h!.connectionId)!.roles.length).toBeGreaterThan(0);
  });

  it("hands a workspace's limits down to the sub-tasks it starts: a nest only gets stricter", async () => {
    h = await harness();
    const caller = await h.conclave.workspaces.create(h.actor, { blank: true, name: "Caller", defaultNode: { connectionId: h.connectionId, model: "mock-small" } });
    const workflow = {
      version: 1,
      steps: [{ kind: "workspace", key: "delegate", workspace: h.workspaceId, taskType: "research-brief", inputs: { topic: "{{input.request}}" }, until: "draft", optional: false, timeoutMs: 3_600_000 }],
    } as unknown as WorkflowDefinition;
    const saved = await h.conclave.workspaces.saveTaskType(h.actor, caller.id, "custom", {
      key: "custom",
      name: "Custom",
      inputFields: [{ key: "request", label: "Request", type: "text", required: true }],
      workflow,
    });
    const taskTypeId = saved.taskTypes.find((t) => t.key === "custom")!.id;

    // The workspace being called is happy to use the connection. The one calling it is not.
    await h.conclave.policies.set(h.actor, { workspaceId: caller.id, connectionId: h.connectionId, effect: "deny" });
    const run = await start(caller.id, taskTypeId, { request: "Tide pools" });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/The workspace Caller never lets tasks use Mock/);
    const [child] = await h.conclave.db.query<{ id: string; inherited: { rules: { effect: string; source: string }[] } }>(`select id, inherited from runs where parent_run_id = $1`, [run.id]);
    expect(child!.inherited.rules).toEqual([expect.objectContaining({ effect: "deny", source: "The workspace Caller" })]);
    expect(await h.conclave.db.query(`select 1 from usage_ledger`)).toHaveLength(0);

    // Run on its own, the called workspace is not limited by its caller.
    const alone = await start(h.workspaceId, h.taskTypeId, { topic: "Tide pools" });
    expect(alone.status).toBe("waiting");
  });

  it("asks for a person before a tool that changes things outside, unless the tool was reviewed", async () => {
    h = await harness({ modules: [outbox] });
    const conn = await h.conclave.connections.create(h.actor, { moduleId: "test/outbox", name: "Outbox", values: {} });
    await h.conclave.workspaces.assignRole(h.actor, h.workspaceId, "searcher", { connectionId: conn.id, model: "post" });

    const refused = await start(h.workspaceId, h.taskTypeId, { topic: "Heat pumps" });
    expect(refused.status).toBe("failed");
    expect(refused.error).toMatch(/can change things outside Conclave, so a person approves first/);
    expect(posted).toEqual([]);

    // The same connection's read-only tool needs nothing.
    await h.conclave.workspaces.assignRole(h.actor, h.workspaceId, "searcher", { connectionId: conn.id, model: "search" });
    expect((await start(h.workspaceId, h.taskTypeId, { topic: "Heat pumps" })).status).toBe("waiting");
    expect(posted.map((p) => p.name)).toEqual(["search"]);

    // Reviewing the tool in this workspace lets it run.
    await h.conclave.workspaces.assignRole(h.actor, h.workspaceId, "searcher", { connectionId: conn.id, model: "post" });
    await h.conclave.policies.set(h.actor, { workspaceId: h.workspaceId, connectionId: conn.id, tool: "post", effect: "allow" });
    expect((await start(h.workspaceId, h.taskTypeId, { topic: "Heat pumps" })).status).toBe("waiting");
    expect(posted.map((p) => p.name)).toEqual(["search", "post"]);
    expect((await h.conclave.insights.audit(h.actor, { area: "policy" })).entries).toHaveLength(1);
  });

  it("lets a sensitive tool run after a person approved an earlier step of the task", async () => {
    h = await harness({ modules: [outbox] });
    const conn = await h.conclave.connections.create(h.actor, { moduleId: "test/outbox", name: "Outbox", values: {} });
    const ws = await h.conclave.workspaces.create(h.actor, { blank: true, name: "Publisher", defaultNode: { connectionId: h.connectionId, model: "mock-small" } });
    await h.conclave.workspaces.createRole(h.actor, ws.id, { key: "poster", name: "Poster", port: "tool@1" });
    await h.conclave.workspaces.assignRole(h.actor, ws.id, "poster", { connectionId: conn.id, model: "post" });
    const workflow = {
      version: 1,
      steps: [
        { kind: "approval", key: "check", title: "Post this?", show: "{{input.request}}" },
        { kind: "tool", key: "publish", role: "poster", args: { query: "{{input.request}}" }, needs: ["check"] },
      ],
    } as unknown as WorkflowDefinition;
    const saved = await h.conclave.workspaces.saveTaskType(h.actor, ws.id, "custom", {
      key: "custom",
      name: "Custom",
      inputFields: [{ key: "request", label: "Request", type: "text", required: true }],
      workflow,
    });
    const waiting = await start(ws.id, saved.taskTypes.find((t) => t.key === "custom")!.id, { request: "Launch note" });
    expect(waiting.status).toBe("waiting");
    expect(posted).toEqual([]);

    const [approval] = await h.conclave.db.query<{ id: string }>(`select id from approvals where run_id = $1`, [waiting.id]);
    await h.conclave.orchestrator.decide(h.actor, approval!.id, { decision: "approve" });
    await h.settle();
    const done = await h.conclave.orchestrator.get(h.actor, waiting.id);
    expect(done.status).toBe("succeeded");
    expect(posted).toEqual([{ name: "post", query: "Launch note" }]);
    const publish = (await h.conclave.insights.trace(h.actor, done.id)).spans.find((s) => s.kind === "tool")!;
    expect(publish.policy).toMatchObject({ allowed: true, effect: "ask" });
    expect(publish.policy!.reason).toMatch(/A person approved an earlier step/);
  });
});

describe("loop guards (MESH-012)", () => {
  it("stops a node that is asked exactly the same thing again and again", async () => {
    h = await harness({ orchestrator: { maxIdenticalCalls: 2 } });
    const ws = await h.conclave.workspaces.create(h.actor, { blank: true, name: "Echoes", defaultNode: { connectionId: h.connectionId, model: "mock-small" } });
    const say = (key: string, needs: string[]) => ({ kind: "role", key, role: "assistant", prompt: "Say hello.", maxTokens: 200, output: "text", timeoutMs: 60_000, optional: false, needs });
    const workflow = { version: 1, steps: [say("one", []), say("two", ["one"]), say("three", ["two"])] } as unknown as WorkflowDefinition;
    const saved = await h.conclave.workspaces.saveTaskType(h.actor, ws.id, "custom", {
      key: "custom",
      name: "Custom",
      inputFields: [{ key: "request", label: "Request", type: "text", required: true }],
      workflow,
    });
    const run = await start(ws.id, saved.taskTypes.find((t) => t.key === "custom")!.id, { request: "x" });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/already answered exactly this input 2 times/);
    const codes = await h.conclave.db.query<{ step_key: string; status: string; error_code: string | null }>(`select step_key, status, error_code from run_steps order by created_at`);
    expect(codes.map((c) => [c.step_key, c.status, c.error_code])).toEqual([
      ["one", "succeeded", null],
      ["two", "succeeded", null],
      ["three", "failed", "loop_detected"],
    ]);
  });
});
