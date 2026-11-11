import { NodeCallError, type AgentEvent, type InputField, type TaskTypeInput, type WorkflowDefinition, type WorkflowStatus } from "@conclave/contract";
import { num } from "@conclave/db";
import { defineModule } from "@conclave/module-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { Orchestrator } from "./orchestrator";
import { harness, type Harness } from "./test-helpers";

/** Agent and automation steps (SRS 4.11, 5.2): outside runs that take a while, ask questions, and survive restarts. */

// ------------------------------------------------------------- a fake agent

interface FakeRun {
  skill: string | undefined;
  text: string;
  events: AgentEvent[];
  wake: (() => void)[];
  answers: string[];
  cancelled: boolean;
}
const agentRuns = new Map<string, FakeRun>();
let streams = 0;

function push(id: string, event: AgentEvent) {
  const run = agentRuns.get(id)!;
  run.events.push(event);
  for (const w of run.wake.splice(0)) w();
}

const fakeAgent = defineModule({
  manifest: {
    id: "test/agent",
    version: "0.1.0",
    name: "Test agent",
    ports: ["agent@1"],
    docks: ["built-in"],
    config: [{ key: "pricePerMinuteUsd", label: "Per minute", type: "number", default: 0 }],
  },
  create: () => ({
    ports: {
      agent: {
        listSkills: async () => [{ id: "ask" }, { id: "quiet" }, { id: "fail" }],
        async startRun(input) {
          const id = `ext-${agentRuns.size + 1}`;
          agentRuns.set(id, { skill: input.skill, text: input.text, events: [], wake: [], answers: [], cancelled: false });
          if (input.skill === "ask") {
            push(id, { type: "progress", text: "Reading the brief" });
            push(id, { type: "needs_input", prompt: "Which region?" });
          }
          if (input.skill === "fail") push(id, { type: "failed", message: "The agent gave up.", code: "refused" });
          return { externalRunId: id };
        },
        // Yields every event from the start, then waits for more: a resumed watch sees the history again.
        async *streamEvents(handle, ctx) {
          streams++;
          const run = agentRuns.get(handle.externalRunId)!;
          let i = 0;
          while (!ctx.signal.aborted) {
            while (i < run.events.length) {
              const event = run.events[i++]!;
              yield event;
              if (event.type === "completed" || event.type === "failed") return;
            }
            await new Promise<void>((resolve) => {
              run.wake.push(resolve);
              ctx.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        },
        async provideInput(handle, answer) {
          const run = agentRuns.get(handle.externalRunId)!;
          run.answers.push(answer);
          push(handle.externalRunId, { type: "completed", text: `Report for ${answer}`, usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.05 } });
        },
        async cancel(handle) {
          agentRuns.get(handle.externalRunId)!.cancelled = true;
        },
      },
    },
    health: async () => ({ status: "working", detail: "ok" }),
  }),
});

// --------------------------------------------------------- a fake workflow engine

const executions = new Map<string, { workflow: string; data: unknown; status: WorkflowStatus; callbackUrl?: string; cancelled: boolean }>();

const fakeEngine = defineModule({
  manifest: {
    id: "test/engine",
    version: "0.1.0",
    name: "Test engine",
    ports: ["workflow@1"],
    docks: ["built-in"],
    config: [{ key: "pricePerCallUsd", label: "Per call", type: "number", default: 0.01 }],
  },
  create: () => ({
    ports: {
      workflow: {
        listWorkflows: async () => [{ id: "now" }, { id: "later" }, { id: "callback" }],
        async trigger(workflowId, input, ctx) {
          const id = `exec-${executions.size + 1}`;
          const status: WorkflowStatus =
            workflowId === "now" ? { state: "succeeded", output: { data: { total: 3, echo: input.data } } } : { state: "running", progress: "Queued" };
          executions.set(id, { workflow: workflowId, data: input.data, status, ...(ctx.callbackUrl ? { callbackUrl: ctx.callbackUrl } : {}), cancelled: false });
          return { execution: { executionId: id }, status };
        },
        async poll(execution) {
          return executions.get(execution.executionId)!.status;
        },
        async callback(_execution, body) {
          const b = body as { result?: string; error?: string };
          if (b.error) return { state: "failed", message: b.error };
          return { state: "succeeded", output: { text: String(b.result ?? "") } };
        },
        async cancel(execution) {
          executions.get(execution.executionId)!.cancelled = true;
        },
      },
    },
    health: async () => ({ status: "working", detail: "ok" }),
  }),
});

// ------------------------------------------------------------------ helpers

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  agentRuns.clear();
  executions.clear();
  streams = 0;
});

const request: InputField[] = [{ key: "request", label: "Request", type: "text", required: true }];
const tt = (key: string, steps: WorkflowDefinition["steps"]): TaskTypeInput => ({ key, name: key, inputFields: request, workflow: { version: 1, steps } });
const tick = () => new Promise((r) => setTimeout(r, 20));

/** A workspace with an agent role and an automation role filled by the fakes. */
async function setup(h: Harness, steps: WorkflowDefinition["steps"], fill: { agentSkill?: string; workflow?: string } = {}) {
  const agentConn = await h.conclave.connections.create(h.actor, { moduleId: "test/agent", name: "Field agent", values: {} });
  const engineConn = await h.conclave.connections.create(h.actor, { moduleId: "test/engine", name: "Flows", values: {} });
  const ws = await h.conclave.workspaces.create(h.actor, { blank: true, name: "Outside", defaultNode: { connectionId: h.connectionId, model: "mock-small" } });
  await h.conclave.workspaces.createRole(h.actor, ws.id, { key: "agent", name: "Researcher", port: "agent@1" });
  await h.conclave.workspaces.createRole(h.actor, ws.id, { key: "flows", name: "Automations", port: "workflow@1" });
  await h.conclave.workspaces.assignRole(h.actor, ws.id, "agent", { connectionId: agentConn.id, model: fill.agentSkill ?? "ask" });
  await h.conclave.workspaces.assignRole(h.actor, ws.id, "flows", { connectionId: engineConn.id, model: fill.workflow ?? "now" });
  const saved = await h.conclave.workspaces.saveTaskType(h.actor, ws.id, null, tt("job", steps));
  return { ws, taskTypeId: saved.taskTypes.find((t) => t.key === "job")!.id };
}

const agentStep = (extra: Record<string, unknown> = {}) =>
  ({ kind: "agent", key: "investigate", role: "agent", prompt: "Look into {{input.request}}", data: { topic: "{{input.request}}" }, onQuestion: "ask", timeoutMs: 3_600_000, optional: false, ...extra }) as WorkflowDefinition["steps"][number];
const automationStep = (extra: Record<string, unknown> = {}) =>
  ({ kind: "automation", key: "crm", role: "flows", inputs: { lead: "{{input.request}}" }, timeoutMs: 3_600_000, optional: false, ...extra }) as WorkflowDefinition["steps"][number];

// -------------------------------------------------------------------- tests

describe("agent steps", () => {
  it("starts the agent, shows its progress, routes its question to the inbox, and sends the answer back", async () => {
    h = await harness({ modules: [fakeAgent, fakeEngine] });
    const { ws, taskTypeId } = await setup(h, [agentStep(), { kind: "text", key: "report", template: "Final: {{steps.investigate.output}}", needs: ["investigate"], optional: false }]);
    const started = await h.conclave.orchestrator.start(h.actor, { workspaceId: ws.id, taskTypeId, brief: { request: "heat pumps" } });
    await h.settle();
    await tick();
    await h.settle();

    // The agent got the rendered prompt and the skill chosen for the role.
    const ext = agentRuns.get("ext-1")!;
    expect(ext).toMatchObject({ skill: "ask", text: "Look into heat pumps" });

    let run = await h.conclave.orchestrator.get(h.actor, started.id);
    expect(run.status).toBe("waiting");
    const step = run.steps.find((s) => s.key === "investigate")!;
    expect(step).toMatchObject({ status: "waiting", externalId: "ext-1", nodeLabel: "Researcher · Field agent · ask", question: { prompt: "Which region?" } });
    expect(step.progress).toEqual(["Reading the brief"]);

    // One inbox item, with the path to the question.
    const inbox = await h.conclave.orchestrator.inbox(h.actor, { kind: "question" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ title: "Researcher asks: heat pumps", body: "Which region?", action: "answer", path: "Outside > heat pumps > Investigate asks" });

    // Answering needs words.
    await expect(h.conclave.orchestrator.decide(h.actor, step.question!.approvalId, { decision: "approve" })).rejects.toThrow(/Write an answer/);
    await h.conclave.orchestrator.decide(h.actor, step.question!.approvalId, { decision: "approve", note: "Northern Europe" });
    await h.settle();
    await tick();
    await h.settle();

    expect(ext.answers).toEqual(["Northern Europe"]);
    run = await h.conclave.orchestrator.get(h.actor, started.id);
    expect(run.status).toBe("succeeded");
    expect(run.output).toBe("Final: Report for Northern Europe");
    const done = run.steps.find((s) => s.key === "investigate")!;
    // The agent reported its cost, so that is what is charged.
    expect(done).toMatchObject({ status: "succeeded", costSource: "reported", inputTokens: 1200, outputTokens: 300 });
    expect(done.costUsd).toBeCloseTo(0.05, 9);
    expect(done.question).toBeUndefined();
    expect(run.costUsd).toBeCloseTo(0.05, 9);
    const [held] = await h.conclave.db.query<{ n: string }>(`select count(*) as n from budget_reservations where status = 'held'`);
    expect(num(held!.n)).toBe(0);
    expect((await h.conclave.orchestrator.inbox(h.actor, { kind: "question" }))[0]!.resolved).toBe(true);
  });

  it("stops the agent when the person stops it instead of answering", async () => {
    h = await harness({ modules: [fakeAgent, fakeEngine] });
    const { ws, taskTypeId } = await setup(h, [agentStep()]);
    const started = await h.conclave.orchestrator.start(h.actor, { workspaceId: ws.id, taskTypeId, brief: { request: "x" } });
    await h.settle();
    await tick();
    await h.settle();
    const step = (await h.conclave.orchestrator.get(h.actor, started.id)).steps[0]!;
    await h.conclave.orchestrator.decide(h.actor, step.question!.approvalId, { decision: "reject", note: "Wrong task" });
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, started.id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/Stopped by a person: Wrong task/);
    expect(agentRuns.get("ext-1")!.cancelled).toBe(true);
  });

  it("fails on a question when the step says so", async () => {
    h = await harness({ modules: [fakeAgent, fakeEngine] });
    const { ws, taskTypeId } = await setup(h, [agentStep({ onQuestion: "fail" })]);
    const started = await h.conclave.orchestrator.start(h.actor, { workspaceId: ws.id, taskTypeId, brief: { request: "x" } });
    await h.settle();
    await tick();
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, started.id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/fails on questions: Which region\?/);
    expect(agentRuns.get("ext-1")!.cancelled).toBe(true);
  });

  it("carries a failure to an On failure connector", async () => {
    h = await harness({ modules: [fakeAgent, fakeEngine] });
    const { ws, taskTypeId } = await setup(
      h,
      [agentStep(), { kind: "text", key: "fallback", template: "Agent failed: {{steps.investigate.output}}", needs: [{ step: "investigate", type: "error" }], optional: false }],
      { agentSkill: "fail" },
    );
    const started = await h.conclave.orchestrator.start(h.actor, { workspaceId: ws.id, taskTypeId, brief: { request: "x" } });
    await h.settle();
    await tick();
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, started.id);
    expect(run.status).toBe("succeeded");
    expect(run.output).toBe("Agent failed: The agent gave up.");
  });

  it("cancelling the task cancels the agent", async () => {
    h = await harness({ modules: [fakeAgent, fakeEngine] });
    const { ws, taskTypeId } = await setup(h, [agentStep()], { agentSkill: "quiet" });
    const started = await h.conclave.orchestrator.start(h.actor, { workspaceId: ws.id, taskTypeId, brief: { request: "x" } });
    await h.settle();
    await h.conclave.orchestrator.cancel(h.actor, started.id);
    await tick();
    expect(agentRuns.get("ext-1")!.cancelled).toBe(true);
  });

  it("times out, stops the agent, and frees the money it held", async () => {
    h = await harness({ modules: [fakeAgent, fakeEngine] });
    const { ws, taskTypeId } = await setup(h, [agentStep({ timeoutMs: 10_000, maxCostUsd: 0.5 })], { agentSkill: "quiet" });
    const started = await h.conclave.orchestrator.start(h.actor, { workspaceId: ws.id, taskTypeId, brief: { request: "x" } });
    await h.settle();
    const [held] = await h.conclave.db.query<{ reserved_usd: string }>(`select reserved_usd from budget_reservations where status = 'held'`);
    expect(num(held!.reserved_usd)).toBeCloseTo(0.5, 9);
    // Pretend the step started long ago.
    await h.conclave.db.query(`update run_steps set started_at = now() - interval '1 minute' where step_key = 'investigate'`);
    await h.conclave.db.tx((q) => h!.conclave.engine.wake(q, started.id));
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, started.id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/took longer than 10 s/);
    expect(agentRuns.get("ext-1")!.cancelled).toBe(true);
    const [left] = await h.conclave.db.query<{ n: string }>(`select count(*) as n from budget_reservations where status = 'held'`);
    expect(num(left!.n)).toBe(0);
  });

  it("a new worker picks the watch up again after a restart", async () => {
    h = await harness({ modules: [fakeAgent, fakeEngine] });
    const { ws, taskTypeId } = await setup(h, [agentStep()], { agentSkill: "quiet" });
    const started = await h.conclave.orchestrator.start(h.actor, { workspaceId: ws.id, taskTypeId, brief: { request: "x" } });
    await h.settle();
    expect(streams).toBe(1);

    // A second orchestrator, as after a redeploy: it knows nothing of the first one's watch.
    const fresh = new Orchestrator(h.conclave.db, h.conclave.engine, h.conclave.connections, h.conclave.bus, { externalCheckMs: 1_000 });
    const worker = h.conclave.engine.startWorker(fresh.advance, { autoStart: false });
    await h.conclave.db.tx((q) => h!.conclave.engine.wake(q, started.id));
    await worker.drain();
    expect(streams).toBe(2);

    push("ext-1", { type: "completed", text: "Late but done" });
    await tick();
    await worker.drain();
    const run = await h.conclave.orchestrator.get(h.actor, started.id);
    expect(run.status).toBe("succeeded");
    expect(run.output).toBe("Late but done");
    await worker.stop();
  });

  it("checks the role's port when the workflow is saved", async () => {
    h = await harness({ modules: [fakeAgent, fakeEngine] });
    await expect(setup(h, [agentStep({ role: "flows" })])).rejects.toThrow(/an agent step, but Automations is filled by an outside workflow/);
  });
});

describe("automation steps", () => {
  it("passes a synchronous result on and charges the connection's price", async () => {
    h = await harness({ modules: [fakeAgent, fakeEngine] });
    const { ws, taskTypeId } = await setup(h, [automationStep()]);
    const started = await h.conclave.orchestrator.start(h.actor, { workspaceId: ws.id, taskTypeId, brief: { request: "Ada" } });
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, started.id);
    expect(run.status).toBe("succeeded");
    expect(JSON.parse(run.output!)).toEqual({ total: 3, echo: { lead: "Ada" } });
    const step = run.steps[0]!;
    expect(step).toMatchObject({ status: "succeeded", costSource: "estimated", externalId: "exec-1" });
    expect(step.costUsd).toBeCloseTo(0.01, 9);
  });

  it("polls a long execution until it finishes", async () => {
    h = await harness({ modules: [fakeAgent, fakeEngine] });
    const { ws, taskTypeId } = await setup(h, [automationStep()], { workflow: "later" });
    const started = await h.conclave.orchestrator.start(h.actor, { workspaceId: ws.id, taskTypeId, brief: { request: "x" } });
    await h.settle();
    let run = await h.conclave.orchestrator.get(h.actor, started.id);
    expect(run.status).toBe("running");
    expect(run.steps[0]).toMatchObject({ status: "waiting", progress: ["Queued"] });

    executions.get("exec-1")!.status = { state: "succeeded", output: { text: "Imported 12 rows" } };
    await h.conclave.db.query(`update run_steps set input = input || '{"nextCheckAt": "2000-01-01T00:00:00Z"}'::jsonb where step_key = 'crm'`);
    await h.conclave.db.tx((q) => h!.conclave.engine.wake(q, started.id));
    await h.settle();
    run = await h.conclave.orchestrator.get(h.actor, started.id);
    expect(run.status).toBe("succeeded");
    expect(run.output).toBe("Imported 12 rows");
  });

  it("takes the result from a one-time callback URL", async () => {
    h = await harness({ modules: [fakeAgent, fakeEngine], orchestrator: { publicUrl: "https://conclave.example" } });
    const { ws, taskTypeId } = await setup(h, [automationStep()], { workflow: "callback" });
    const started = await h.conclave.orchestrator.start(h.actor, { workspaceId: ws.id, taskTypeId, brief: { request: "x" } });
    await h.settle();
    const url = executions.get("exec-1")!.callbackUrl!;
    expect(url).toMatch(/^https:\/\/conclave\.example\/v1\/hooks\/runs\/[A-Za-z0-9_-]{40,}$/);
    const token = url.split("/").pop()!;

    expect(await h.conclave.orchestrator.deliverCallback("not-a-real-token-at-all-000", {}, {})).toBe(false);
    expect(await h.conclave.orchestrator.deliverCallback(token, { result: "CRM updated" }, {})).toBe(true);
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, started.id);
    expect(run.status).toBe("succeeded");
    expect(run.output).toBe("CRM updated");
    // Spent once the step is done.
    expect(await h.conclave.orchestrator.deliverCallback(token, { result: "again" }, {})).toBe(false);
  });

  it("reports a failure from the engine", async () => {
    h = await harness({ modules: [fakeAgent, fakeEngine] });
    const { ws, taskTypeId } = await setup(h, [automationStep()], { workflow: "callback" });
    const started = await h.conclave.orchestrator.start(h.actor, { workspaceId: ws.id, taskTypeId, brief: { request: "x" } });
    await h.settle();
    const token = executions.get("exec-1")!.callbackUrl!.split("/").pop()!;
    await h.conclave.orchestrator.deliverCallback(token, { error: "CRM is down" }, {});
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, started.id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/CRM is down/);
  });

  it("a module that cannot start the run fails the step with its reason", async () => {
    const broken = defineModule({
      manifest: { id: "test/broken", version: "0.1.0", name: "Broken", ports: ["workflow@1"], docks: ["built-in"] },
      create: () => ({
        ports: {
          workflow: {
            listWorkflows: async () => [{ id: "x" }],
            trigger: async () => {
              throw new NodeCallError("auth", "Bad key.", false);
            },
          },
        },
        health: async () => ({ status: "working", detail: "ok" }),
      }),
    });
    h = await harness({ modules: [fakeAgent, fakeEngine, broken] });
    const { ws, taskTypeId } = await setup(h, [automationStep()]);
    const conn = await h.conclave.connections.create(h.actor, { moduleId: "test/broken", name: "Broken", values: {} });
    await h.conclave.workspaces.assignRole(h.actor, ws.id, "flows", { connectionId: conn.id, model: "x" });
    const started = await h.conclave.orchestrator.start(h.actor, { workspaceId: ws.id, taskTypeId, brief: { request: "x" } });
    await h.settle();
    const run = await h.conclave.orchestrator.get(h.actor, started.id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/Bad key/);
  });
});
