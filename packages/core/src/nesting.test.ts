import type { InputField, TaskTypeInput, WorkflowDefinition } from "@conclave/contract";
import { newId } from "@conclave/contract";
import { num } from "@conclave/db";
import { afterEach, describe, expect, it } from "vitest";
import { ConclaveError } from "./errors";
import { harness, type Harness } from "./test-helpers";

/** Workspace steps (WF-008): sub-tasks in other workspaces, recursion, repeats, and their guards. */

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

const request: InputField[] = [{ key: "request", label: "Request", type: "text", required: true }];

async function blank(h: Harness, name: string) {
  return h.conclave.workspaces.create(h.actor, { blank: true, name, defaultNode: { connectionId: h.connectionId, model: "mock-small" } });
}

function tt(key: string, steps: WorkflowDefinition["steps"], extra: Partial<TaskTypeInput> = {}): TaskTypeInput {
  return { key, name: key.replace(/^./, (c) => c.toUpperCase()), inputFields: request, workflow: { version: 1, steps }, ...extra };
}

const echo = (prompt = "Echo {{input.request}}") => ({ kind: "role" as const, key: "respond", role: "assistant", prompt, maxTokens: 400, output: "text" as const, timeoutMs: 60_000, optional: false });

async function runToEnd(h: Harness, workspaceId: string, key: string, brief: Record<string, string>) {
  const ws = await h.conclave.workspaces.get(h.actor, workspaceId);
  const taskType = ws.taskTypes.find((t) => t.key === key)!;
  const started = await h.conclave.orchestrator.start(h.actor, { workspaceId, taskTypeId: taskType.id, brief });
  await h.settle();
  return h.conclave.orchestrator.get(h.actor, started.id);
}

describe("workspace steps", () => {
  it("runs another workspace's task type up to a step and passes its output on", async () => {
    h = await harness();
    const caller = await blank(h, "Caller");
    await h.conclave.workspaces.saveTaskType(
      h.actor,
      caller.id,
      "custom",
      tt("custom", [
        { kind: "workspace", key: "brief", workspace: h.workspaceId, taskType: "research-brief", inputs: { topic: "{{input.request}}" }, until: "draft", optional: false, timeoutMs: 3_600_000 },
        { ...echo("Summarise: {{steps.brief.output}}"), needs: ["brief"] },
      ]),
    );

    const run = await runToEnd(h, caller.id, "custom", { request: "Heat pumps" });
    expect(run.status).toBe("succeeded");
    const call = run.steps.find((s) => s.key === "brief")!;
    expect(call).toMatchObject({ status: "succeeded", nodeLabel: "Research Brief › Research brief (up to draft)" });
    expect(call.children).toHaveLength(1);
    expect(call.children![0]).toMatchObject({ status: "succeeded", workspaceId: h.workspaceId, iteration: 1 });

    // The sub-task ran only up to the draft: no approval, and it knows its parent.
    const child = await h.conclave.orchestrator.get(h.actor, call.children![0]!.id);
    expect(child.steps.map((s) => s.key)).toEqual(["search", "research", "draft"]);
    expect(child).toMatchObject({ depth: 1, parent: { id: run.id, stepKey: "brief" }, brief: { topic: "Heat pumps" } });
    expect(call.output).toBe(child.output);
    expect(run.output).toContain("Summarise: [mock-small]");

    // The parent's cost includes the sub-task's; spend is booked to the workspace that did the work.
    const ledger = await h.conclave.db.query<{ workspace_id: string; cost_usd: string }>(`select workspace_id, cost_usd from usage_ledger`);
    const total = ledger.reduce((n, l) => n + num(l.cost_usd), 0);
    expect(run.costUsd).toBeCloseTo(total, 9);
    expect(call.costUsd).toBeCloseTo(child.costUsd, 9);
    expect(ledger.filter((l) => l.workspace_id === h.workspaceId)).toHaveLength(2);

    // Sub-tasks stay out of task lists and tell nobody; the parent reports once.
    expect((await h.conclave.orchestrator.list(h.actor, h.workspaceId)).map((r) => r.id)).not.toContain(child.id);
    const results = (await h.conclave.orchestrator.inbox(h.actor)).filter((i) => i.kind === "result");
    expect(results.map((i) => i.runId)).toEqual([run.id]);
  });

  it("lets a workflow call itself up to an earlier step, and refuses a call that never ends", async () => {
    h = await harness();
    const ws = await blank(h, "Loop");
    await h.conclave.workspaces.saveTaskType(
      h.actor,
      ws.id,
      "custom",
      tt("custom", [
        { ...echo("Draft {{input.request}}"), key: "draft" },
        { kind: "workspace", key: "again", workspace: "self", taskType: "custom", inputs: { request: "better {{steps.draft.output}}" }, until: "draft", needs: ["draft"], optional: false, timeoutMs: 3_600_000 },
        { ...echo("Final {{steps.again.output}}"), key: "final", needs: ["again"] },
      ]),
    );
    const run = await runToEnd(h, ws.id, "custom", { request: "a plan" });
    expect(run.status).toBe("succeeded");
    const child = await h.conclave.orchestrator.get(h.actor, run.steps.find((s) => s.key === "again")!.children![0]!.id);
    expect(child.steps.map((s) => s.key)).toEqual(["draft"]);
    expect(child.output).toBe("[mock-small] Draft better [mock-small] Draft a plan");
    expect(run.output).toBe("[mock-small] Final [mock-small] Draft better [mock-small] Draft a plan");

    const forever = tt("custom", [
      { ...echo(), key: "draft" },
      { kind: "workspace", key: "again", workspace: "self", taskType: "custom", inputs: { request: "{{steps.draft.output}}" }, needs: ["draft"], optional: false, timeoutMs: 3_600_000 },
    ]);
    await expect(h.conclave.workspaces.saveTaskType(h.actor, ws.id, "custom", forever)).rejects.toThrow(/would reach itself again, with no end/);
  });

  it("repeats for each item of a list, a few at a time, and returns the outputs as a JSON list", async () => {
    h = await harness();
    const ws = await blank(h, "Fan out");
    await h.conclave.workspaces.saveTaskType(h.actor, ws.id, null, tt("one", [echo()]));
    await h.conclave.workspaces.saveTaskType(
      h.actor,
      ws.id,
      "custom",
      tt("custom", [
        {
          kind: "workspace",
          key: "each",
          workspace: "self",
          taskType: "one",
          inputs: { request: "item {{loop.index}}: {{loop.item}}" },
          repeat: { mode: "each", items: "{{input.request}}", max: 10, parallel: 2 },
          optional: false,
          timeoutMs: 3_600_000,
        },
      ]),
    );

    // Two at a time: after the first advance, only two sub-tasks exist.
    const types = (await h.conclave.workspaces.get(h.actor, ws.id)).taskTypes;
    const started = await h.conclave.orchestrator.start(h.actor, { workspaceId: ws.id, taskTypeId: types.find((t) => t.key === "custom")!.id, brief: { request: "- alpha\n- beta\n- gamma" } });
    await h.worker.tick();
    const early = await h.conclave.db.query(`select id from runs where parent_run_id = $1`, [started.id]);
    expect(early).toHaveLength(2);

    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, started.id);
    expect(run.status).toBe("succeeded");
    expect(JSON.parse(run.output!)).toEqual(["[mock-small] Echo item 1: alpha", "[mock-small] Echo item 2: beta", "[mock-small] Echo item 3: gamma"]);
    expect(run.steps[0]!.children!.map((c) => [c.iteration, c.title])).toEqual([
      [1, "#1 · item 1: alpha"],
      [2, "#2 · item 2: beta"],
      [3, "#3 · item 3: gamma"],
    ]);
  });

  it("repeats until an output contains the stop text, and fails when it never does", async () => {
    h = await harness();
    const ws = await blank(h, "Until");
    await h.conclave.workspaces.saveTaskType(h.actor, ws.id, null, tt("one", [echo()]));
    const until = (stopWhen: string, max: number) =>
      tt("custom", [
        {
          kind: "workspace",
          key: "loop",
          workspace: "self",
          taskType: "one",
          inputs: { request: "round {{loop.index}} after [{{loop.previous}}]" },
          repeat: { mode: "until", stopWhen, max },
          optional: false,
          timeoutMs: 3_600_000,
        },
      ]);
    await h.conclave.workspaces.saveTaskType(h.actor, ws.id, "custom", until("ROUND 3", 5));
    let run = await runToEnd(h, ws.id, "custom", { request: "go" });
    expect(run.status).toBe("succeeded");
    expect(run.steps[0]!.children).toHaveLength(3);
    // Each run saw the one before it.
    expect(run.output).toBe("[mock-small] Echo round 3 after [[mock-small] Echo round 2 after [[mock-small] Echo round 1 after []]]");

    await h.conclave.workspaces.saveTaskType(h.actor, ws.id, "custom", until("never", 2));
    run = await runToEnd(h, ws.id, "custom", { request: "go" });
    expect(run.status).toBe("failed");
    expect(run.error).toContain('Ran 2 times and no output contained "never"');
  });

  it("stops recursion between workspaces at the depth limit", async () => {
    h = await harness({ orchestrator: { maxDepth: 3 } });
    const a = await blank(h, "A");
    const b = await blank(h, "B");
    const call = (workspace: string) =>
      // Each level changes the brief, so only the depth limit can stop it.
      tt("custom", [{ kind: "workspace", key: "call", workspace, taskType: "custom", inputs: { request: "{{input.request}}!" }, optional: false, timeoutMs: 3_600_000 }]);
    await h.conclave.workspaces.saveTaskType(h.actor, b.id, "custom", call(a.id));
    await h.conclave.workspaces.saveTaskType(h.actor, a.id, "custom", call(b.id));

    const run = await runToEnd(h, a.id, "custom", { request: "ping" });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/^Call failed: Sub-task 1 failed: Call failed: Sub-task 1 failed: .*may nest 3 deep/);
    const depths = await h.conclave.db.query<{ depth: number; status: string }>(`select depth, status from runs order by depth`);
    expect(depths.map((d) => [d.depth, d.status])).toEqual([
      [0, "failed"],
      [1, "failed"],
      [2, "failed"],
      [3, "failed"],
    ]);
  });

  it("stops two workspaces handing the same brief back and forth, long before the depth limit", async () => {
    h = await harness();
    const a = await blank(h, "A");
    const b = await blank(h, "B");
    const call = (workspace: string) =>
      tt("custom", [{ kind: "workspace", key: "call", workspace, taskType: "custom", inputs: { request: "{{input.request}}" }, optional: false, timeoutMs: 3_600_000 }]);
    await h.conclave.workspaces.saveTaskType(h.actor, b.id, "custom", call(a.id));
    await h.conclave.workspaces.saveTaskType(h.actor, a.id, "custom", call(b.id));

    const run = await runToEnd(h, a.id, "custom", { request: "ping" });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/would start "Custom" again with the same brief as a task above it/);
    // A started B; B was refused when it tried to start A again.
    const runs = await h.conclave.db.query<{ depth: number }>(`select depth from runs order by depth`);
    expect(runs.map((r) => r.depth)).toEqual([0, 1]);
    const [refused] = await h.conclave.db.query<{ error_code: string }>(`select s.error_code from run_steps s join runs r on r.id = s.run_id where r.depth = 1`);
    expect(refused!.error_code).toBe("loop_detected");
  });

  it("puts a sub-task's approval in the inbox with its full path, and carries on after it", async () => {
    h = await harness();
    const caller = await blank(h, "Caller");
    await h.conclave.workspaces.saveTaskType(
      h.actor,
      caller.id,
      "custom",
      tt("custom", [{ kind: "workspace", key: "brief", workspace: h.workspaceId, taskType: "research-brief", inputs: { topic: "{{input.request}}" }, optional: false, timeoutMs: 3_600_000 }]),
    );
    const types = (await h.conclave.workspaces.get(h.actor, caller.id)).taskTypes;
    const started = await h.conclave.orchestrator.start(h.actor, { workspaceId: caller.id, taskTypeId: types[0]!.id, brief: { request: "Solar" } });
    await h.settle();

    // The parent shows as waiting on people while its sub-task does.
    expect((await h.conclave.orchestrator.get(h.actor, started.id)).status).toBe("waiting");
    const item = (await h.conclave.orchestrator.inbox(h.actor, { kind: "approval" }))[0]!;
    expect(item.path).toMatch(/^Caller > Solar > Solar > /);

    await h.conclave.orchestrator.decide(h.actor, item.approvalId!, { decision: "approve" });
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, started.id);
    expect(run.status).toBe("succeeded");
    expect(run.output).toContain("[mock-small]");
  });

  it("cancels the whole tree when the task is cancelled, and fails the parent when a sub-task is cancelled", async () => {
    h = await harness();
    const caller = await blank(h, "Caller");
    await h.conclave.workspaces.saveTaskType(
      h.actor,
      caller.id,
      "custom",
      tt("custom", [{ kind: "workspace", key: "brief", workspace: h.workspaceId, taskType: "research-brief", inputs: { topic: "{{input.request}}" }, optional: false, timeoutMs: 3_600_000 }]),
    );
    const types = (await h.conclave.workspaces.get(h.actor, caller.id)).taskTypes;
    const start = () => h.conclave.orchestrator.start(h.actor, { workspaceId: caller.id, taskTypeId: types[0]!.id, brief: { request: "Wind" } });

    const first = await start();
    await h.settle();
    await h.conclave.orchestrator.cancel(h.actor, first.id);
    const [child] = await h.conclave.db.query<{ status: string; id: string }>(`select id, status from runs where parent_run_id = $1`, [first.id]);
    expect(child!.status).toBe("cancelled");
    const open = (await h.conclave.orchestrator.inbox(h.actor, { kind: "approval" })).filter((i) => !i.resolved);
    expect(open).toHaveLength(0);

    const second = await start();
    await h.settle();
    const [sub] = await h.conclave.db.query<{ id: string }>(`select id from runs where parent_run_id = $1`, [second.id]);
    await h.conclave.orchestrator.cancel(h.actor, sub!.id);
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, second.id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Sub-task 1 was cancelled");
  });

  it("gives a sub-task a share of the parent's budget, and refuses when none is left", async () => {
    h = await harness();
    const caller = await blank(h, "Caller");
    await h.conclave.workspaces.saveTaskType(
      h.actor,
      caller.id,
      "custom",
      tt("custom", [{ kind: "workspace", key: "brief", workspace: h.workspaceId, taskType: "research-brief", inputs: { topic: "{{input.request}}" }, until: "research", optional: false, timeoutMs: 3_600_000 }]),
    );
    await h.conclave.workspaces.updateBudget(h.actor, caller.id, { taskUsd: 0.25 });
    let run = await runToEnd(h, caller.id, "custom", { request: "Tides" });
    expect(run.status).toBe("succeeded");
    const [child] = await h.conclave.db.query<{ budget_usd: string }>(`select budget_usd from runs where parent_run_id = $1`, [run.id]);
    expect(num(child!.budget_usd)).toBeCloseTo(0.25, 9);

    await h.conclave.workspaces.updateBudget(h.actor, caller.id, { taskUsd: 0.0000005 });
    run = await runToEnd(h, caller.id, "custom", { request: "Tides" });
    expect(run.status).toBe("failed");
    expect(run.error).toContain("No task budget is left");
  });
});

describe("editing workflows", () => {
  it("checks roles, ports, step references, inputs and call targets before saving", async () => {
    h = await harness();
    const ws = await blank(h, "Edit");
    const save = (steps: WorkflowDefinition["steps"]) => h.conclave.workspaces.saveTaskType(h.actor, ws.id, "custom", tt("custom", steps));
    const problems = async (steps: WorkflowDefinition["steps"]) => {
      try {
        await save(steps);
        return [];
      } catch (err) {
        return (err as ConclaveError).errors ?? [(err as Error).message];
      }
    };

    expect(await problems([{ ...echo(), role: "ghost" }])).toEqual(['respond calls role "ghost", which this workspace does not have.']);
    expect(await problems([{ kind: "tool", key: "look", role: "assistant", args: {}, optional: false, timeoutMs: 60_000 }])).toEqual([
      "look is a tool step, but Assistant is filled by a model.",
    ]);
    expect(await problems([{ ...echo("{{steps.later.output}} {{input.nope}}"), key: "first", needs: [] }, { ...echo(), key: "later", needs: [] }])).toEqual([
      'first uses the output of "later", which does not run before it. Connect later to first.',
      'first uses input "nope", which the brief does not have.',
    ]);
    expect(
      await problems([{ kind: "workspace", key: "call", workspace: h.workspaceId, taskType: "research-brief", inputs: { audience: "x", colour: "y" }, until: "nope", optional: false, timeoutMs: 3_600_000 }]),
    ).toEqual([
      'call: fill in "Topic" for Research brief.',
      "call: Research brief has no input \"colour\".",
      'call runs Research brief up to "nope", which is not one of its steps.',
    ]);

    // Someone else's personal workspace cannot be called.
    const other = newId();
    await h.conclave.db.query(`insert into users (id, email, name) values ($1, 'other@localhost', 'Other')`, [other]);
    await h.conclave.db.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'editor')`, [h.actor.orgId, other]);
    const hidden = await h.conclave.workspaces.create({ orgId: h.actor.orgId, userId: other }, { blank: true, private: true });
    expect(await problems([{ kind: "workspace", key: "call", workspace: hidden.id, taskType: "custom", inputs: { request: "x" }, optional: false, timeoutMs: 3_600_000 }])).toEqual([
      "call runs a task in a workspace you cannot see, or one that no longer exists.",
    ]);
    expect((await h.conclave.workspaces.callTargets(h.actor)).map((t) => t.workspaceName)).not.toContain(hidden.name);

    // A good save keeps the layout for steps that exist and bumps the version.
    const before = (await h.conclave.workspaces.get(h.actor, ws.id)).version;
    const saved = await h.conclave.workspaces.saveTaskType(
      h.actor,
      ws.id,
      "custom",
      tt("custom", [echo()], { workflow: { version: 1, steps: [echo()], layout: { _brief: { x: 0, y: 0 }, respond: { x: 300, y: 0 }, gone: { x: 1, y: 1 } } } }),
    );
    expect(saved.version).toBe(before + 1);
    expect(saved.taskTypes[0]!.workflow.layout).toEqual({ _brief: { x: 0, y: 0 }, respond: { x: 300, y: 0 } });
  });

  it("adds and removes roles and task types, archiving ones that have run and refusing ones still called", async () => {
    h = await harness();
    const ws = await blank(h, "Edit");
    let detail = await h.conclave.workspaces.createRole(h.actor, ws.id, { name: "Web search", port: "tool@1" });
    expect(detail.roles.map((r) => [r.key, r.port])).toContainEqual(["web_search", "tool@1"]);
    await expect(h.conclave.workspaces.createRole(h.actor, ws.id, { name: "Web search", port: "tool@1" })).rejects.toThrow(/already has a role/);
    await expect(h.conclave.workspaces.deleteRole(h.actor, ws.id, "assistant")).rejects.toThrow(/still uses this role/);
    detail = await h.conclave.workspaces.deleteRole(h.actor, ws.id, "web_search");
    expect(detail.roles.map((r) => r.key)).toEqual(["assistant"]);

    await expect(h.conclave.workspaces.deleteTaskType(h.actor, ws.id, "custom")).rejects.toThrow(/at least one task type/);
    await h.conclave.workspaces.saveTaskType(h.actor, ws.id, null, tt("one", [echo()]));
    await h.conclave.workspaces.saveTaskType(
      h.actor,
      ws.id,
      "custom",
      tt("custom", [{ kind: "workspace", key: "call", workspace: "self", taskType: "one", inputs: { request: "{{input.request}}" }, optional: false, timeoutMs: 3_600_000 }]),
    );
    await expect(h.conclave.workspaces.deleteTaskType(h.actor, ws.id, "one")).rejects.toThrow(/Edit › Custom › call runs this task type/);

    // Once it has run, deleting archives it: gone from the workspace, still readable in history.
    const run = await runToEnd(h, ws.id, "custom", { request: "hi" });
    expect(run.status).toBe("succeeded");
    await h.conclave.workspaces.saveTaskType(h.actor, ws.id, "custom", tt("custom", [echo()]));
    detail = await h.conclave.workspaces.deleteTaskType(h.actor, ws.id, "one");
    expect(detail.taskTypes.map((t) => t.key)).toEqual(["custom"]);
    const [archived] = await h.conclave.db.query<{ key: string; archived_at: Date | null }>(`select key, archived_at from task_types where workspace_id = $1 and key like 'one~%'`, [ws.id]);
    expect(archived!.archived_at).not.toBeNull();
    const child = run.steps[0]!.children![0]!;
    expect((await h.conclave.orchestrator.get(h.actor, child.id)).taskTypeName).toBe("One");
  });
});
