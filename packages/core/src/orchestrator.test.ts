import type { EventEnvelope } from "@conclave/contract";
import { num } from "@conclave/db";
import { afterEach, describe, expect, it } from "vitest";
import { ConclaveError } from "./errors";
import { harness, type Harness } from "./test-helpers";

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

const brief = (extra: Record<string, string> = {}) => ({ topic: "Heat pumps for small offices", audience: "Office managers", ...extra });

async function pendingApproval(h: Harness, runId: string): Promise<string> {
  const items = await h.conclave.orchestrator.inbox(h.actor, { kind: "approval" });
  const item = items.find((i) => i.runId === runId && !i.resolved);
  if (!item?.approvalId) throw new Error("No open approval for this run.");
  return item.approvalId;
}

describe("Research Brief, end to end", () => {
  it("runs research and draft, waits at the gate, and finishes after approval", async () => {
    h = await harness();
    const events: EventEnvelope[] = [];
    h.conclave.bus.subscribe("*", (e) => events.push(e));

    const started = await h.conclave.orchestrator.start(h.actor, { workspaceId: h.workspaceId, taskTypeId: h.taskTypeId, brief: brief() });
    expect(started.status).toBe("queued");

    await h.settle();
    let run = await h.conclave.orchestrator.get(h.actor, started.id);
    expect(run.status).toBe("waiting");
    // The optional search step has no tool connected, so it is skipped.
    expect(run.steps.map((s) => [s.key, s.status])).toEqual([
      ["search", "skipped"],
      ["research", "succeeded"],
      ["draft", "succeeded"],
      ["review", "waiting"],
    ]);

    // Progress and status counts the UI shows.
    expect(run).toMatchObject({ stepsTotal: 4, stepsDone: 3, currentStep: "review", workspaceName: "Research Brief" });
    expect((await h.conclave.workspaces.list(h.actor))[0]).toMatchObject({ waitingTasks: 1, runningTasks: 0 });
    expect((await h.conclave.orchestrator.listActive(h.actor)).map((r) => r.id)).toEqual([run.id]);

    const approvalId = await pendingApproval(h, run.id);
    await h.conclave.orchestrator.decide(h.actor, approvalId, { decision: "approve" });
    await h.settle();

    run = await h.conclave.orchestrator.get(h.actor, started.id);
    expect(run.status).toBe("succeeded");
    expect(run.output).toBe(run.steps.find((s) => s.key === "draft")!.output);
    expect(run.output).toContain("[mock-small]");

    // Every model call is in the ledger, labelled with its source (COST-006, COST-008).
    const ledger = await h.conclave.db.query<{ cost_usd: string; cost_source: string }>(`select cost_usd, cost_source from usage_ledger`);
    expect(ledger).toHaveLength(2);
    expect(ledger.every((l) => l.cost_source === "metered")).toBe(true);
    const total = ledger.reduce((n, l) => n + num(l.cost_usd), 0);
    expect(run.costUsd).toBeCloseTo(total, 9);
    expect(run.costUsd).toBeGreaterThan(0);

    const [conn] = await h.conclave.connections.list(h.actor);
    expect(conn!.monthSpendUsd).toBeCloseTo(total, 9);
    expect(conn!.usedBy).toEqual([{ workspaceId: h.workspaceId, workspaceName: "Research Brief" }]);
    expect(run.stepsDone).toBe(4);

    const reservations = await h.conclave.db.query<{ status: string }>(`select status from budget_reservations`);
    expect(reservations.map((r) => r.status)).toEqual(["settled", "settled"]);

    const inbox = await h.conclave.orchestrator.inbox(h.actor);
    expect(inbox.some((i) => i.kind === "result" && i.runId === run.id)).toBe(true);
    expect(inbox.find((i) => i.kind === "approval")!.resolved).toBe(true);

    // Live events reached the bus with increasing sequence numbers.
    expect(events.some((e) => e.event.type === "run.updated" && e.event.run.status === "succeeded")).toBe(true);
    expect(events.some((e) => e.event.type === "step.delta")).toBe(true);
    const seqs = events.filter((e) => e.seq > 0).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("re-runs only the revised step when changes are requested", async () => {
    h = await harness();
    const { id } = await h.conclave.orchestrator.start(h.actor, { workspaceId: h.workspaceId, taskTypeId: h.taskTypeId, brief: brief() });
    await h.settle();

    await h.conclave.orchestrator.decide(h.actor, await pendingApproval(h, id), { decision: "changes", note: "Add a section on costs." });
    await h.settle();

    let run = await h.conclave.orchestrator.get(h.actor, id);
    expect(run.status).toBe("waiting");
    const research = run.steps.filter((s) => s.key === "research");
    const drafts = run.steps.filter((s) => s.key === "draft");
    expect(research).toHaveLength(1);
    expect(drafts.map((d) => [d.attempt, d.status])).toEqual([
      [1, "superseded"],
      [2, "succeeded"],
    ]);
    const [prompt] = await h.conclave.db.query<{ input: { prompt: string } }>(`select input from run_steps where step_key = 'draft' and attempt = 2`);
    expect(prompt!.input.prompt).toContain("Add a section on costs.");

    await h.conclave.orchestrator.decide(h.actor, await pendingApproval(h, id), { decision: "approve" });
    await h.settle();
    run = await h.conclave.orchestrator.get(h.actor, id);
    expect(run.status).toBe("succeeded");
  });

  it("fails the task when the approver rejects it", async () => {
    h = await harness();
    const { id } = await h.conclave.orchestrator.start(h.actor, { workspaceId: h.workspaceId, taskTypeId: h.taskTypeId, brief: brief() });
    await h.settle();
    await h.conclave.orchestrator.decide(h.actor, await pendingApproval(h, id), { decision: "reject", note: "Wrong topic." });
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Wrong topic.");
    await expect(h.conclave.orchestrator.decide(h.actor, (await h.conclave.orchestrator.inbox(h.actor, { kind: "approval" }))[0]!.approvalId!, { decision: "approve" })).rejects.toThrow(
      /Already decided/,
    );
  });
});

describe("Reliability", () => {
  it("retries a step after a transient failure", async () => {
    h = await harness();
    const { id } = await h.conclave.orchestrator.start(h.actor, {
      workspaceId: h.workspaceId,
      taskTypeId: h.taskTypeId,
      brief: brief({ notes: "[[fail:1]]" }),
    });
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, id);
    const research = run.steps.filter((s) => s.key === "research");
    expect(research.map((s) => [s.attempt, s.status])).toEqual([
      [1, "failed"],
      [2, "succeeded"],
    ]);
    expect(run.status).toBe("waiting");
  });

  it("fails after the last attempt", async () => {
    h = await harness();
    const { id } = await h.conclave.orchestrator.start(h.actor, {
      workspaceId: h.workspaceId,
      taskTypeId: h.taskTypeId,
      brief: brief({ notes: "[[fail:9]]" }),
    });
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, id);
    expect(run.status).toBe("failed");
    expect(run.steps.filter((s) => s.key === "research")).toHaveLength(3);
    const inbox = await h.conclave.orchestrator.inbox(h.actor, { kind: "problem" });
    expect(inbox[0]?.runId).toBe(id);
  });

  it("resumes after a worker died mid-step", async () => {
    h = await harness();
    const { id } = await h.conclave.orchestrator.start(h.actor, { workspaceId: h.workspaceId, taskTypeId: h.taskTypeId, brief: brief() });
    // A row left "running" by a worker that crashed.
    await h.conclave.db.query(
      `insert into run_steps (id, run_id, step_key, kind, attempt, status, started_at) values (gen_random_uuid(), $1, 'research', 'role', 1, 'running', now())`,
      [id],
    );
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, id);
    expect(run.status).toBe("waiting");
    const research = run.steps.filter((s) => s.key === "research");
    expect(research.map((s) => s.status)).toEqual(["failed", "succeeded"]);
    expect(research[0]!.error).toMatch(/worker stopped/);
  });

  it("cancels a running task and aborts the in-flight call", async () => {
    h = await harness();
    const { id } = await h.conclave.orchestrator.start(h.actor, {
      workspaceId: h.workspaceId,
      taskTypeId: h.taskTypeId,
      brief: brief({ notes: "[[slow:10000]]" }),
    });
    const ticking = h.worker.tick();
    for (let i = 0; i < 100; i++) {
      const run = await h.conclave.orchestrator.get(h.actor, id);
      if (run.steps.some((s) => s.status === "running")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const startedAt = Date.now();
    await h.conclave.orchestrator.cancel(h.actor, id);
    await ticking;
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    const run = await h.conclave.orchestrator.get(h.actor, id);
    expect(run.status).toBe("cancelled");
    expect(run.steps.find((s) => s.key === "research")!.status).toBe("cancelled");
    const held = await h.conclave.db.query(`select id from budget_reservations where status = 'held'`);
    expect(held).toHaveLength(0);
  });
});

describe("Budgets and guards", () => {
  it("refuses a step whose reservation does not fit the task budget", async () => {
    h = await harness({ model: "mock-large" });
    await h.conclave.workspaces.updateBudget(h.actor, h.workspaceId, { taskUsd: 0.0001 });
    const { id } = await h.conclave.orchestrator.start(h.actor, { workspaceId: h.workspaceId, taskTypeId: h.taskTypeId, brief: brief() });
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, id);
    expect(run.status).toBe("failed");
    expect(run.steps.find((s) => s.key === "research")!.error).toMatch(/task budget/);
    expect(await h.conclave.db.query(`select id from usage_ledger`)).toHaveLength(0);
    const budgetItems = await h.conclave.orchestrator.inbox(h.actor, { kind: "budget" });
    expect(budgetItems).toHaveLength(1);
  });

  it("stops a task that calls one node more than its cap", async () => {
    h = await harness({ orchestrator: { maxCallsPerNode: 1 } });
    const { id } = await h.conclave.orchestrator.start(h.actor, { workspaceId: h.workspaceId, taskTypeId: h.taskTypeId, brief: brief() });
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/per-node cap/);
  });

  it("shows an upper-bound estimate before any history, then one from past runs", async () => {
    h = await harness();
    const before = await h.conclave.orchestrator.estimate(h.actor, h.workspaceId, h.taskTypeId, brief());
    expect(before.confidence).toBe("none");
    expect(before.p90Usd).toBeGreaterThan(0);

    const { id } = await h.conclave.orchestrator.start(h.actor, { workspaceId: h.workspaceId, taskTypeId: h.taskTypeId, brief: brief() });
    await h.settle();
    await h.conclave.orchestrator.decide(h.actor, await pendingApproval(h, id), { decision: "approve" });
    await h.settle();

    const after = await h.conclave.orchestrator.estimate(h.actor, h.workspaceId, h.taskTypeId);
    expect(after.confidence).toBe("low");
    const run = await h.conclave.orchestrator.get(h.actor, id);
    expect(after.medianUsd).toBeCloseTo(run.costUsd, 9);
    expect(after.p90Usd).toBeLessThanOrEqual(before.p90Usd);
  });
});

describe("Validation", () => {
  it("rejects an incomplete brief", async () => {
    h = await harness();
    await expect(
      h.conclave.orchestrator.start(h.actor, { workspaceId: h.workspaceId, taskTypeId: h.taskTypeId, brief: { audience: "x" } }),
    ).rejects.toThrow(ConclaveError);
  });

  it("refuses to start when a role has no node", async () => {
    h = await harness();
    await h.conclave.workspaces.assignRole(h.actor, h.workspaceId, "editor", { connectionId: null, model: null });
    await expect(
      h.conclave.orchestrator.start(h.actor, { workspaceId: h.workspaceId, taskTypeId: h.taskTypeId, brief: brief() }),
    ).rejects.toThrow(/Editor has no node/);
  });

  it("keeps workflows untouched when a role's node changes, and records a new version", async () => {
    h = await harness();
    const before = await h.conclave.workspaces.get(h.actor, h.workspaceId);
    const after = await h.conclave.workspaces.assignRole(h.actor, h.workspaceId, "editor", { connectionId: h.connectionId, model: "mock-large" });
    expect(after.version).toBe(before.version + 1);
    expect(after.taskTypes[0]!.steps).toEqual(before.taskTypes[0]!.steps);
  });
});
