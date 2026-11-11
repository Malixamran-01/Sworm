import { traceIdOf, type WorkflowDefinition } from "@conclave/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harness, type Harness } from "./test-helpers";

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

const brief = { topic: "Tide pools", audience: "Students" };

/** Run the Research Brief to its approval, approve it, and let it finish. */
async function finishedRun() {
  const run = await h.conclave.orchestrator.start(h.actor, { workspaceId: h.workspaceId, taskTypeId: h.taskTypeId, brief });
  await h.settle();
  const [approval] = await h.conclave.db.query<{ id: string }>(`select id from approvals where run_id = $1 and decision is null`, [run.id]);
  if (approval) {
    await h.conclave.orchestrator.decide(h.actor, approval.id, { decision: "approve" });
    await h.settle();
  }
  return h.conclave.orchestrator.get(h.actor, run.id);
}

describe("trace", () => {
  it("shows a task as one trace: steps, the node that did each, cost and the decision", async () => {
    const run = await finishedRun();
    expect(run.status).toBe("succeeded");
    const trace = await h.conclave.insights.trace(h.actor, run.id);

    expect(trace.traceId).toBe(traceIdOf(run.id));
    expect(trace.rootRunId).toBe(run.id);
    expect(trace.status).toBe("succeeded");
    expect(trace.costUsd).toBeCloseTo(run.costUsd, 6);

    const root = trace.spans.find((s) => s.type === "run")!;
    expect(root.parentId).toBeNull();
    const steps = trace.spans.filter((s) => s.type === "step");
    expect(steps.length).toBe(run.steps.length);
    expect(steps.every((s) => s.parentId === run.id)).toBe(true);

    const calls = steps.filter((s) => s.system === "model");
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.node).toMatchObject({ connectionId: h.connectionId, connectionName: "Mock", moduleId: "conclave/mock-model" });
      // Every outside call carries the same trace id, and its own span id.
      expect(c.traceparent).toMatch(new RegExp(`^00-${trace.traceId}-[0-9a-f]{16}-01$`));
      expect(c.reservedUsd).toBeGreaterThan(0);
      expect(c.heldUsd).toBe(0);
    }
    expect(new Set(calls.map((c) => c.traceparent)).size).toBe(calls.length);

    const review = steps.find((s) => s.kind === "approval")!;
    expect(review.system).toBe("person");
    expect(review.decision).toMatchObject({ decision: "approve", by: "Owner" });

    expect(trace.systems).toHaveLength(1);
    expect(trace.systems[0]).toMatchObject({ connectionId: h.connectionId, calls: calls.length, failures: 0 });
    expect(trace.systems[0]!.costUsd).toBeCloseTo(run.costUsd, 6);
    expect(trace.counts).toMatchObject({ tasks: 1, calls: calls.length, decisions: 1, workspaces: 1, failures: 0 });
  });

  it("joins sub-tasks in other workspaces into the parent's trace, from either end", async () => {
    // A second workspace whose only step runs the Research Brief of the first, up to its draft.
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

    const parent = await h.conclave.orchestrator.start(h.actor, { workspaceId: caller.id, taskTypeId, brief: { request: "Tide pools" } });
    await h.settle();
    expect((await h.conclave.orchestrator.get(h.actor, parent.id)).status).toBe("succeeded");

    const trace = await h.conclave.insights.trace(h.actor, parent.id);
    const runs = trace.spans.filter((s) => s.type === "run");
    expect(runs).toHaveLength(2);
    const child = runs.find((r) => r.id !== parent.id)!;
    const delegate = trace.spans.find((s) => s.kind === "workspace")!;
    // The sub-task hangs under the step that started it, in its own workspace.
    expect(child.parentId).toBe(delegate.id);
    expect(child.depth).toBe(1);
    expect(child.workspaceId).toBe(h.workspaceId);
    expect(trace.counts).toMatchObject({ tasks: 2, workspaces: 2 });
    // The step's cost is its sub-task's; none of it is the step's own, so nothing counts twice.
    expect(delegate.selfCostUsd).toBe(0);
    expect(delegate.costUsd).toBeCloseTo(child.costUsd, 6);
    expect(trace.systems.reduce((n, s) => n + s.costUsd, 0)).toBeCloseTo(trace.costUsd, 6);
    // Calls made inside the sub-task carry the top task's trace id.
    const inner = trace.spans.find((s) => s.runId === child.id && s.system === "model")!;
    expect(inner.traceparent).toContain(traceIdOf(parent.id));

    // Asking from the sub-task gives the same trace, focused on it.
    const fromChild = await h.conclave.insights.trace(h.actor, child.id);
    expect(fromChild.rootRunId).toBe(parent.id);
    expect(fromChild.focusRunId).toBe(child.id);
    expect(fromChild.spans.map((s) => s.id)).toEqual(trace.spans.map((s) => s.id));
  });

  it("refuses a task of another organisation", async () => {
    const run = await finishedRun();
    await expect(h.conclave.insights.trace({ orgId: "00000000-0000-7000-8000-000000000000", userId: h.actor.userId }, run.id)).rejects.toThrow("Task not found");
  });
});

describe("usage insights", () => {
  it("adds up spend by workspace, connection, model and source, with every day present", async () => {
    const run = await finishedRun();
    const usage = await h.conclave.insights.usage(h.actor, 7);
    expect(usage.daily).toHaveLength(7);
    expect(usage.totals.costUsd).toBeCloseTo(run.costUsd, 6);
    expect(usage.totals.calls).toBeGreaterThan(0);
    expect(usage.totals).toMatchObject({ tasks: 1, tasksDone: 1, tasksFailed: 0 });
    expect(usage.daily.at(-1)!.costUsd).toBeCloseTo(run.costUsd, 6);
    expect(usage.daily.at(-1)!.day).toBe(new Date().toISOString().slice(0, 10));
    expect(usage.byWorkspace).toMatchObject([{ id: h.workspaceId, calls: usage.totals.calls }]);
    expect(usage.byConnection).toMatchObject([{ id: h.connectionId, name: "Mock", detail: "conclave/mock-model" }]);
    expect(usage.byModel[0]).toMatchObject({ name: "mock-small" });
    expect(usage.bySource.reduce((n, s) => n + s.costUsd, 0)).toBeCloseTo(run.costUsd, 6);
    expect(usage.health).toMatchObject([{ connectionId: h.connectionId, failures: 0 }]);
    expect(usage.previous).toEqual({ costUsd: 0, calls: 0 });
    await expect(h.conclave.insights.usage(h.actor, 5)).rejects.toThrow();
  });

  it("leaves out other people's personal workspaces", async () => {
    await finishedRun();
    await h.conclave.db.query(`update workspaces set private = true, created_by = $2 where id = $1`, [h.workspaceId, h.actor.userId]);
    const stranger = { orgId: h.actor.orgId, userId: "00000000-0000-7000-8000-000000000001" };
    const theirs = await h.conclave.insights.usage(stranger, 7);
    expect(theirs.totals).toMatchObject({ costUsd: 0, calls: 0, tasks: 0 });
    expect(theirs.byWorkspace).toEqual([]);
    const mine = await h.conclave.insights.usage(h.actor, 7);
    expect(mine.totals.calls).toBeGreaterThan(0);
  });
});

describe("audit trail", () => {
  it("lists who did what, newest first, with names, areas and pages", async () => {
    const run = await finishedRun();
    const all = await h.conclave.insights.audit(h.actor);
    const actions = all.entries.map((e) => e.action);
    expect(actions[0]).toBe("approval.approve");
    expect(actions).toEqual(expect.arrayContaining(["task.started", "workspace.created", "connection.created"]));
    const started = all.entries.find((e) => e.action === "task.started")!;
    expect(started).toMatchObject({ target: run.id, targetName: run.title, actor: { id: h.actor.userId, name: "Owner" } });
    expect(all.entries.find((e) => e.action === "connection.created")!.targetName).toBe("Mock");
    expect(all.entries.find((e) => e.action === "approval.approve")!.targetName).toBe(run.title);

    const tasks = await h.conclave.insights.audit(h.actor, { area: "task" });
    expect(tasks.entries.map((e) => e.action)).toEqual(["task.started"]);

    const first = await h.conclave.insights.audit(h.actor, { limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.next).toBe(first.entries[1]!.id);
    const second = await h.conclave.insights.audit(h.actor, { limit: 2, before: first.next! });
    expect(second.entries.map((e) => e.id)).toEqual(all.entries.slice(2, 4).map((e) => e.id));
    await expect(h.conclave.insights.audit(h.actor, { area: "x'; drop" })).rejects.toThrow();
  });
});
